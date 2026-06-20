// SBOS-A1-ERP RBAC Admin Routes
//
// Fastify routes for managing roles, permission sets, profiles, FLS rules,
// RLS rules, sessions, and audit. All routes require the caller to hold
// the corresponding admin permission.
//
// Endpoints:
//   GET    /api/rbac/permissions                      (security.permission_set.read)
//   GET    /api/rbac/permissions/:key                 (security.permission_set.read)
//   GET    /api/rbac/permission-sets                  (security.permission_set.read)
//   POST   /api/rbac/permission-sets                  (security.permission_set.update)
//   PATCH  /api/rbac/permission-sets/:id              (security.permission_set.update)
//   GET    /api/rbac/roles                            (security.role.read)
//   POST   /api/rbac/roles                            (security.role.create)
//   PATCH  /api/rbac/roles/:id                        (security.role.update)
//   DELETE /api/rbac/roles/:id                        (security.role.delete)
//   GET    /api/rbac/users/:userId/effective          (security.user.read)
//   GET    /api/rbac/users/:userId/permission-sets    (security.user.read)
//   POST   /api/rbac/users/:userId/permission-sets    (security.role.assign)
//   DELETE /api/rbac/users/:userId/permission-sets/:ps (security.role.assign)
//   POST   /api/rbac/users/:userId/role               (security.role.assign)
//   GET    /api/rbac/field-policies                   (security.permission_set.read)
//   PUT    /api/rbac/field-policies/:path             (security.permission_set.update)
//   GET    /api/rbac/record-rules                     (security.permission_set.read)
//   PUT    /api/rbac/record-rules/:resource           (security.permission_set.update)
//   GET    /api/rbac/sessions                         (security.session.list)
//   DELETE /api/rbac/sessions/:id                     (security.session.revoke)
//   GET    /api/rbac/audit                            (security.audit.read)
//   GET    /api/rbac/me/permissions                   (auth required) — return effective set
//
// The router expects to be registered with a Fastify app that has:
//   - app.authenticate preHandler in place (sets request.user)
//   - this.db (sqlite) on the app instance OR injected via opts.db
import { PERMISSIONS, PERMISSIONS_VERSION, getDefinition, byCategory } from './permissions.js';
import { ROLES, validateCustomRole, listRoleIds } from './roles.js';
import { PERMISSION_SETS, PERMISSION_SETS_VERSION } from './matrix.js';
import {
  ROLE_MATRIX,
  listForRole,
  getDefaultPermissionSetIds,
  getParentChain,
} from './roleMatrix.js';
import { requirePermFastify, requireAnyPerm, resolveEffectivePermissions } from './guards.js';
function registerRbacRoutes(app, opts = {}) {
  const db = opts.db || app.db;
  if (!db) {
    throw new Error('rbac routes require db: pass opts.db or set app.db');
  }

  // ───── Role lookup helpers ─────
  //
  // Roles can live in two places:
  //   1. The in-code ROLES catalog (system roles shipped with the app).
  //   2. The sbos_rbac_roles table (custom roles created by tenants
  //      via POST /api/rbac/roles).
  //
  // The original handler only consulted the in-code catalog, which made
  // PATCH/DELETE silently 404 for any DB-only custom role. These two
  // helpers unify the lookup: in-code first (so system role fields like
  // isSystem are read from the source of truth), then the DB row.
  //
  // The returned object has the same shape regardless of source, so
  // callers can branch on r.isSystem without caring which side the row
  // came from.

  function loadRoleFromDb(id) {
    // Returns the DB row in the same shape as the in-code ROLES[id]
    // (camelCase), or null if the id is not in the table.
    const row = db
      .prepare(
        `SELECT id, label, description, parent, is_system, app_set_json,
                mfa_required, session_hard_limit_minutes, can_be_impersonated
           FROM sbos_rbac_roles WHERE id = ?`,
      )
      .get(id);
    if (!row) return null;
    return {
      id: row.id,
      label: row.label,
      description: row.description,
      parent: row.parent,
      isSystem: !!row.is_system,
      appSet: row.app_set_json ? JSON.parse(row.app_set_json) : [],
      mfaRequired: !!row.mfa_required,
      sessionHardLimitMinutes: row.session_hard_limit_minutes,
      canBeImpersonated: !!row.can_be_impersonated,
    };
  }

  function loadRole(id) {
    // In-code catalog wins for system roles (single source of truth).
    // DB fallback for custom roles.
    const fromCode = ROLES[id];
    if (fromCode) return fromCode;
    return loadRoleFromDb(id);
  }

  // ───── Catalog endpoints (read-only) ─────

  app.get(
    '/api/rbac/permissions',
    { preHandler: requirePermFastify('security.permission_set.read') },
    async () => {
      return {
        version: PERMISSIONS_VERSION || 1,
        categories: [...byCategory().entries()].map(([id, items]) => ({ id, items })),
      };
    },
  );

  app.get(
    '/api/rbac/permissions/:key',
    { preHandler: requirePermFastify('security.permission_set.read') },
    async (request, reply) => {
      const def = getDefinition(request.params.key);
      if (!def) return reply.code(404).send({ error: 'not_found' });
      return { key: request.params.key, ...def };
    },
  );

  app.get(
    '/api/rbac/permission-sets',
    { preHandler: requirePermFastify('security.permission_set.read') },
    async () => {
      return {
        version: PERMISSION_SETS_VERSION || 1,
        items: Object.values(PERMISSION_SETS).map((ps) => ({
          id: ps.id,
          label: ps.label,
          description: ps.description,
          isSystem: !!ps.isSystem,
          memberCount: ps.permissions.length,
        })),
      };
    },
  );

  app.get(
    '/api/rbac/permission-sets/:id',
    { preHandler: requirePermFastify('security.permission_set.read') },
    async (request, reply) => {
      const ps = PERMISSION_SETS[request.params.id];
      if (!ps) return reply.code(404).send({ error: 'not_found' });
      return { ...ps };
    },
  );

  // ───── Role management ─────

  app.get('/api/rbac/roles', { preHandler: requirePermFastify('security.role.read') }, async () => {
    // System roles (in-code catalog) first, then any custom roles in
    // the DB that aren't already in the catalog. Custom roles get an
    // empty defaultPermissionSets (their direct assignments come from
    // sbos_rbac_user_permission_sets, not the role matrix).
    const seen = new Set();
    const items = listRoleIds().map((id) => {
      seen.add(id);
      const r = ROLES[id];
      return {
        id,
        label: r.label,
        description: r.description,
        parent: r.parent,
        isSystem: !!r.isSystem,
        mfaRequired: !!r.mfaRequired,
        sessionHardLimitMinutes: r.sessionHardLimitMinutes,
        canBeImpersonated: !!r.canBeImpersonated,
        appSet: r.appSet,
        defaultPermissionSets: listForRole(id),
      };
    });
    // Append DB-only custom roles.
    const customRows = db
      .prepare(
        `SELECT id, label, description, parent, is_system,
                app_set_json, mfa_required, session_hard_limit_minutes, can_be_impersonated
           FROM sbos_rbac_roles
          WHERE id NOT IN (${listRoleIds()
            .map(() => '?')
            .join(',')})`,
      )
      .all(...listRoleIds());
    for (const row of customRows) {
      if (seen.has(row.id)) continue;
      items.push({
        id: row.id,
        label: row.label,
        description: row.description,
        parent: row.parent,
        isSystem: !!row.is_system,
        mfaRequired: !!row.mfa_required,
        sessionHardLimitMinutes: row.session_hard_limit_minutes,
        canBeImpersonated: !!row.can_be_impersonated,
        appSet: row.app_set_json ? JSON.parse(row.app_set_json) : [],
        defaultPermissionSets: [],
      });
    }
    return { items };
  });

  app.post(
    '/api/rbac/roles',
    { preHandler: requirePermFastify('security.role.create') },
    async (request, reply) => {
      const validated = validateCustomRole(request.body);
      const stmt = db.prepare(`
      INSERT INTO sbos_rbac_roles (
        id, tenant_id, label, description, parent, is_system,
        app_set_json, mfa_required, session_hard_limit_minutes, can_be_impersonated, created_by
      ) VALUES (?, 0, ?, ?, ?, 0, ?, ?, ?, ?, ?)
    `);
      stmt.run(
        validated.id,
        validated.label,
        validated.description,
        validated.parent,
        JSON.stringify(validated.appSet),
        validated.mfaRequired ? 1 : 0,
        validated.sessionHardLimitMinutes,
        validated.canBeImpersonated ? 1 : 0,
        request.user.id,
      );
      return reply.code(201).send(validated);
    },
  );

  app.patch(
    '/api/rbac/roles/:id',
    { preHandler: requirePermFastify('security.role.update') },
    async (request, reply) => {
      const id = request.params.id;
      const r = loadRole(id);
      if (!r) return reply.code(404).send({ error: 'not_found' });
      if (r.isSystem) {
        // System roles are mostly read-only; only appSet/description mutable.
        const allowed = [
          'label',
          'description',
          'appSet',
          'mfaRequired',
          'sessionHardLimitMinutes',
          'canBeImpersonated',
        ];
        const body = request.body || {};
        const next = { ...r };
        for (const k of allowed) if (k in body) next[k] = body[k];
        db.prepare(
          `
        UPDATE sbos_rbac_roles
           SET label = ?, description = ?, app_set_json = ?, mfa_required = ?,
               session_hard_limit_minutes = ?, can_be_impersonated = ?, updated_at = datetime('now')
         WHERE id = ? AND is_system = 1
      `,
        ).run(
          next.label,
          next.description,
          JSON.stringify(next.appSet),
          next.mfaRequired ? 1 : 0,
          next.sessionHardLimitMinutes,
          next.canBeImpersonated ? 1 : 0,
          id,
        );
        return { ...next };
      }
      // Custom roles: re-validate the merged result.
      const merged = validateCustomRole({ ...r, ...request.body });
      db.prepare(
        `
      UPDATE sbos_rbac_roles
         SET label = ?, description = ?, parent = ?, app_set_json = ?,
             mfa_required = ?, session_hard_limit_minutes = ?, can_be_impersonated = ?,
             updated_at = datetime('now')
       WHERE id = ?
    `,
      ).run(
        merged.label,
        merged.description,
        merged.parent,
        JSON.stringify(merged.appSet),
        merged.mfaRequired ? 1 : 0,
        merged.sessionHardLimitMinutes,
        merged.canBeImpersonated ? 1 : 0,
        id,
      );
      return merged;
    },
  );

  app.delete(
    '/api/rbac/roles/:id',
    { preHandler: requirePermFastify('security.role.delete') },
    async (request, reply) => {
      const id = request.params.id;
      const r = loadRole(id);
      if (!r) return reply.code(404).send({ error: 'not_found' });
      if (r.isSystem) return reply.code(409).send({ error: 'system_role_immutable' });
      // Refuse if anyone still holds this role.
      const used = db
        .prepare(`SELECT COUNT(*) AS c FROM sbos_rbac_user_roles WHERE role_id = ?`)
        .get(id);
      if (used && used.c > 0) return reply.code(409).send({ error: 'role_in_use', count: used.c });
      db.prepare(`DELETE FROM sbos_rbac_roles WHERE id = ? AND is_system = 0`).run(id);
      return reply.code(204).send();
    },
  );

  // ───── User effective permissions ─────

  app.get(
    '/api/rbac/users/:userId/effective',
    { preHandler: requirePermFastify('security.user.read') },
    async (request, reply) => {
      const userId = Number(request.params.userId);
      const u = db
        .prepare(
          `
      SELECT u.id, u.username, u.email, u.role AS primary_role, u.tenant_id, u.org_id, u.mfa_required, u.mfa_verified
        FROM users u WHERE u.id = ?
    `,
        )
        .get(userId);
      if (!u) return reply.code(404).send({ error: 'user_not_found' });

      const directPS = db
        .prepare(
          `
      SELECT permission_set_id FROM sbos_rbac_user_permission_sets
       WHERE user_id = ? AND tenant_id = ?
    `,
        )
        .all(userId, u.tenant_id || 0)
        .map((r) => r.permission_set_id);

      const user = {
        id: u.id,
        role: u.primary_role || 'SalesRep',
        permission_set_ids: directPS,
        tenant_id: u.tenant_id,
        org_id: u.org_id,
        mfa_required: !!u.mfa_required,
        mfa_verified: !!u.mfa_verified,
      };
      const effective = resolveEffectivePermissions(user);
      return {
        user: { id: u.id, username: u.username, email: u.email, role: user.role },
        roleChain: getParentChain(user.role),
        directPermissionSets: directPS,
        effectivePermissionSetIds: getDefaultPermissionSetIds(user),
        effectivePermissions: [...effective].sort(),
        count: effective.size,
      };
    },
  );

  app.post(
    '/api/rbac/users/:userId/permission-sets',
    { preHandler: requirePermFastify('security.role.assign') },
    async (request, reply) => {
      const userId = Number(request.params.userId);
      const body = request.body || {};
      const psId = String(body.permissionSetId || '');
      if (!PERMISSION_SETS[psId]) return reply.code(400).send({ error: 'invalid_permission_set' });
      const tenant = db.prepare(`SELECT tenant_id FROM users WHERE id = ?`).get(userId);
      if (!tenant) return reply.code(404).send({ error: 'user_not_found' });
      db.prepare(
        `
      INSERT INTO sbos_rbac_user_permission_sets (user_id, permission_set_id, tenant_id, granted_by, expires_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id, permission_set_id) DO UPDATE SET
        granted_by = excluded.granted_by,
        expires_at = excluded.expires_at
    `,
      ).run(userId, psId, tenant.tenant_id || 0, request.user.id, body.expiresAt || null);
      return reply.code(201).send({ userId, permissionSetId: psId });
    },
  );

  app.delete(
    '/api/rbac/users/:userId/permission-sets/:ps',
    { preHandler: requirePermFastify('security.role.assign') },
    async (request, reply) => {
      const userId = Number(request.params.userId);
      const psId = String(request.params.ps);
      const tenant = db.prepare(`SELECT tenant_id FROM users WHERE id = ?`).get(userId);
      if (!tenant) return reply.code(404).send({ error: 'user_not_found' });
      db.prepare(
        `DELETE FROM sbos_rbac_user_permission_sets WHERE user_id = ? AND permission_set_id = ? AND tenant_id = ?`,
      ).run(userId, psId, tenant.tenant_id || 0);
      return reply.code(204).send();
    },
  );

  app.post(
    '/api/rbac/users/:userId/role',
    { preHandler: requirePermFastify('security.role.assign') },
    async (request, reply) => {
      const userId = Number(request.params.userId);
      const body = request.body || {};
      const roleId = String(body.roleId || '');
      if (!ROLES[roleId]) return reply.code(400).send({ error: 'invalid_role' });
      const tenant = db.prepare(`SELECT tenant_id FROM users WHERE id = ?`).get(userId);
      if (!tenant) return reply.code(404).send({ error: 'user_not_found' });
      db.prepare(
        `
      INSERT INTO sbos_rbac_user_roles (user_id, role_id, tenant_id, assigned_by)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(tenant_id, user_id, role_id) DO UPDATE SET
        assigned_by = excluded.assigned_by,
        assigned_at = datetime('now')
    `,
      ).run(userId, roleId, tenant.tenant_id || 0, request.user.id);
      // Mirror to users.role column if it exists, for the fast-path middleware.
      try {
        db.prepare(`UPDATE users SET role = ? WHERE id = ?`).run(roleId, userId);
      } catch (_) {
        /* users.role may not exist in some deployments */
      }
      return reply.code(201).send({ userId, roleId });
    },
  );

  // ───── Field-level security ─────

  app.get(
    '/api/rbac/field-policies',
    { preHandler: requirePermFastify('security.permission_set.read') },
    async () => {
      return {
        items: db
          .prepare(
            `SELECT field_path, min_permission, is_visible, label, updated_at
                            FROM sbos_rbac_field_policies WHERE tenant_id = 0
                            ORDER BY field_path`,
          )
          .all(),
      };
    },
  );

  app.put(
    '/api/rbac/field-policies/:path(*)',
    { preHandler: requirePermFastify('security.permission_set.update') },
    async (request, reply) => {
      const path = String(request.params.path || '');
      const body = request.body || {};
      if (!body.minPermission || !PERMISSIONS[body.minPermission]) {
        return reply.code(400).send({ error: 'invalid_min_permission' });
      }
      db.prepare(
        `
      INSERT INTO sbos_rbac_field_policies (field_path, tenant_id, min_permission, is_visible, label, updated_by)
      VALUES (?, 0, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, field_path) DO UPDATE SET
        min_permission = excluded.min_permission,
        is_visible = excluded.is_visible,
        label = excluded.label,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `,
      ).run(
        path,
        body.minPermission,
        body.isVisible === false ? 0 : 1,
        body.label || '',
        request.user.id,
      );
      return reply.code(200).send({ fieldPath: path, ...body });
    },
  );

  // ───── Record-level security ─────

  app.get(
    '/api/rbac/record-rules',
    { preHandler: requirePermFastify('security.permission_set.read') },
    async () => {
      return {
        items: db
          .prepare(
            `SELECT resource, scope, predicate, description, updated_at
                            FROM sbos_rbac_record_rules WHERE tenant_id = 0
                            ORDER BY resource`,
          )
          .all(),
      };
    },
  );

  app.put(
    '/api/rbac/record-rules/:resource(*)',
    { preHandler: requirePermFastify('security.permission_set.update') },
    async (request, reply) => {
      const resource = String(request.params.resource || '');
      const body = request.body || {};
      const validScopes = ['own', 'team', 'org', 'custom'];
      if (!validScopes.includes(body.scope))
        return reply.code(400).send({ error: 'invalid_scope' });
      if (
        body.scope === 'custom' &&
        (typeof body.predicate !== 'string' || !body.predicate.trim())
      ) {
        return reply.code(400).send({ error: 'predicate_required_for_custom_scope' });
      }
      db.prepare(
        `
      INSERT INTO sbos_rbac_record_rules (resource, tenant_id, scope, predicate, description, updated_by)
      VALUES (?, 0, ?, ?, ?, ?)
      ON CONFLICT(tenant_id, resource) DO UPDATE SET
        scope = excluded.scope,
        predicate = excluded.predicate,
        description = excluded.description,
        updated_by = excluded.updated_by,
        updated_at = datetime('now')
    `,
      ).run(
        resource,
        body.scope,
        body.scope === 'custom' ? body.predicate : null,
        body.description || '',
        request.user.id,
      );
      return reply.code(200).send({ resource, ...body });
    },
  );

  // ───── Sessions ─────

  app.get(
    '/api/rbac/sessions',
    { preHandler: requirePermFastify('security.session.list') },
    async (request) => {
      const limit = Math.min(Number(request.query.limit) || 100, 500);
      return {
        items: db
          .prepare(
            `
        SELECT id, user_id, role_id, created_at, last_seen_at, expires_at, ip, mfa_factor, mfa_verified_at, impersonator_id
          FROM sbos_rbac_sessions
         WHERE tenant_id = ? AND revoked_at IS NULL
         ORDER BY last_seen_at DESC
         LIMIT ?
      `,
          )
          .all(request.user.tenant_id || 0, limit),
      };
    },
  );

  app.delete(
    '/api/rbac/sessions/:id',
    { preHandler: requirePermFastify('security.session.revoke') },
    async (request, reply) => {
      db.prepare(`UPDATE sbos_rbac_sessions SET revoked_at = datetime('now') WHERE id = ?`).run(
        request.params.id,
      );
      return reply.code(204).send();
    },
  );

  // ───── Audit ─────

  app.get(
    '/api/rbac/audit',
    { preHandler: requirePermFastify('security.audit.read') },
    async (request) => {
      const limit = Math.min(Number(request.query.limit) || 200, 1000);
      const decision = request.query.decision; // optional: allow | deny | mfa_required
      const params = [request.user.tenant_id || 0];
      let where = `tenant_id = ?`;
      if (decision) {
        where += ` AND decision = ?`;
        params.push(decision);
      }
      if (request.query.userId) {
        where += ` AND user_id = ?`;
        params.push(Number(request.query.userId));
      }
      return {
        items: db
          .prepare(
            `
        SELECT id, user_id, permission, decision, resource, reason, ip, session_id, created_at
          FROM sbos_rbac_permission_audit WHERE ${where}
         ORDER BY id DESC LIMIT ?
      `,
          )
          .all(...params, limit),
      };
    },
  );

  // ───── Self-service: effective permissions for the current user ─────

  app.get(
    '/api/rbac/me/permissions',
    { preHandler: (req, _rep, done) => done() },
    async (request) => {
      const perms = resolveEffectivePermissions(request.user);
      return {
        role: request.user.role,
        roleChain: getParentChain(request.user.role),
        effectivePermissions: [...perms].sort(),
        count: perms.size,
      };
    },
  );

  // ───── Catalog validation report (admin/audit use) ─────

  app.get(
    '/api/rbac/health',
    {
      preHandler: requireAnyPerm([
        'security.role.read',
        'security.permission_set.read',
        'security.audit.read',
      ]),
    },
    async () => {
      const issues = [];
      // Each role in the matrix should have a defined role object.
      for (const r of Object.keys(ROLE_MATRIX)) {
        if (!ROLES[r])
          issues.push({ level: 'error', msg: `role_matrix_references_unknown_role: ${r}` });
      }
      // Each permission set should reference valid permissions.
      for (const ps of Object.values(PERMISSION_SETS)) {
        for (const k of ps.permissions) {
          if (!PERMISSIONS[k])
            issues.push({
              level: 'error',
              msg: `permission_set_references_unknown_permission: ${ps.id} -> ${k}`,
            });
        }
      }
      return { ok: issues.length === 0, issues };
    },
  );
}

export { registerRbacRoutes };
