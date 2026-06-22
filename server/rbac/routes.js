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
//   POST   /api/rbac/users/:userId/unlock             (security.user.update) — clear lockout
//   GET    /api/rbac/profiles                          (security.profile.read)
//   POST   /api/rbac/profiles                          (security.profile.create)
//   GET    /api/rbac/profiles/:id                      (security.profile.read)
//   POST   /api/rbac/profiles/:id/apply                (security.profile.assign)
//   DELETE /api/rbac/profiles/:id                      (security.profile.delete)
//   GET    /api/rbac/field-policies                   (security.permission_set.read)
//   PUT    /api/rbac/field-policies/:path             (security.permission_set.update)
//   GET    /api/rbac/record-rules                     (security.permission_set.read)
//   PUT    /api/rbac/record-rules/:resource           (security.permission_set.update)
//   GET    /api/rbac/sessions                         (security.session.list)
//   DELETE /api/rbac/sessions/:id                     (security.session.revoke)
//   GET    /api/rbac/audit                            (security.audit.read)
//   GET    /api/rbac/approvals                        (security.approval.read)
//   POST   /api/rbac/approvals                        (security.approval.request)
//   POST   /api/rbac/approvals/:id/approve            (security.approval.decide)
//   POST   /api/rbac/approvals/:id/reject             (security.approval.decide)
//   GET    /api/rbac/me/permissions                   (auth required) — return effective set
//   POST   /api/rbac/backup                          (system.backup.run) — DR snapshot
//   GET    /api/rbac/backup                          (system.backup.read) — list backups
//   POST   /api/rbac/backup/validate                 (system.backup.run) — validate an uploaded backup
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
import {
  unlinkSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
  mkdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import {
  createProfile,
  getProfile,
  listProfiles,
  applyProfile,
  deleteProfile,
  ValueError as ProfileValueError,
  NotFoundError as ProfileNotFoundError,
  ConflictError as ProfileConflictError,
} from './profiles.js';
import {
  requestApproval,
  listPendingApprovals,
  approveRequest,
  rejectRequest,
  expireStale,
  ValueError as ApprovalValueError,
} from './approvals.js';

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

  // POST /api/rbac/users/:userId/unlock — clear the failed-login
  // counter and the locked_until timestamp on a user. Used by ops
  // when a user is locked out and needs help getting back in (the
  // user has verified their identity out-of-band — phone call,
  // in-person, etc — and the operator is clearing the lock).
  //
  // Returns 200 with {userId, previous_failed_logins, previous_locked_until}
  // so the operator can see what they just cleared. Audited under
  // resource='user:<id>'.
  app.post(
    '/api/rbac/users/:userId/unlock',
    { preHandler: requirePermFastify('security.user.update') },
    async (request, reply) => {
      const userId = Number(request.params.userId);
      if (!Number.isInteger(userId) || userId <= 0) {
        return reply.code(404).send({ error: 'not_found' });
      }
      const user = db
        .prepare(
          `SELECT id, tenant_id, failed_logins, locked_until FROM users WHERE id = ?`,
        )
        .get(userId);
      if (!user) return reply.code(404).send({ error: 'user_not_found' });
      const previous = {
        failed_logins: Number(user.failed_logins || 0),
        locked_until: user.locked_until || null,
      };
      db.prepare(
        `UPDATE users
            SET failed_logins = 0,
                locked_until = NULL
          WHERE id = ?`,
      ).run(userId);
      return reply.code(200).send({
        userId,
        previous_failed_logins: previous.failed_logins,
        previous_locked_until: previous.locked_until,
      });
    },
  );

  // ───── Profiles (Phase 0.3) ─────
  //
  // Reusable role + permission-set bundles for new users. Catalog stays
  // in code; profiles are tenant data. The CRUD surface mirrors
  // /api/rbac/roles so admins have a consistent mental model.

  // Translate a profile-domain error into the right HTTP status. Kept
  // here (not in profiles.js) so the module stays HTTP-agnostic.
  function replyProfileError(reply, err) {
    if (err instanceof ProfileConflictError) {
      return reply
        .code(err.statusCode || 409)
        .send({ error: 'profile_in_use', message: err.message });
    }
    if (err instanceof ProfileNotFoundError) {
      return reply
        .code(err.statusCode || 404)
        .send({ error: 'profile_not_found', message: err.message });
    }
    if (err instanceof ProfileValueError) {
      return reply
        .code(err.statusCode || 400)
        .send({ error: 'invalid_profile', message: err.message });
    }
    // Unknown error type — let Fastify's default error handler turn it
    // into a 500. Re-throwing keeps the error class and stack trace intact.
    throw err;
  }

  app.get(
    '/api/rbac/profiles',
    { preHandler: requirePermFastify('security.profile.read') },
    async () => {
      return { items: listProfiles(db) };
    },
  );

  app.post(
    '/api/rbac/profiles',
    { preHandler: requirePermFastify('security.profile.create') },
    async (request, reply) => {
      try {
        const row = createProfile(db, {
          ...(request.body || {}),
          created_by: request.user ? String(request.user.id || '') : null,
        });
        return reply.code(201).send(row);
      } catch (err) {
        return replyProfileError(reply, err);
      }
    },
  );

  app.get(
    '/api/rbac/profiles/:id',
    { preHandler: requirePermFastify('security.profile.read') },
    async (request, reply) => {
      const row = getProfile(db, request.params.id);
      if (!row) return reply.code(404).send({ error: 'profile_not_found' });
      return row;
    },
  );

  app.post(
    '/api/rbac/profiles/:id/apply',
    { preHandler: requirePermFastify('security.profile.assign') },
    async (request, reply) => {
      try {
        const userId = Number((request.body || {}).userId);
        if (!Number.isInteger(userId) || userId <= 0) {
          return reply.code(400).send({ error: 'invalid_user_id' });
        }
        const result = applyProfile(db, request.params.id, userId);
        return reply.code(200).send(result);
      } catch (err) {
        return replyProfileError(reply, err);
      }
    },
  );

  app.delete(
    '/api/rbac/profiles/:id',
    { preHandler: requirePermFastify('security.profile.delete') },
    async (request, reply) => {
      try {
        deleteProfile(db, request.params.id);
        return reply.code(204).send();
      } catch (err) {
        return replyProfileError(reply, err);
      }
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
      // request.params.path is set by Express 5 / path-to-regexp v8+
      // (named wildcard `*path`). Express 4 / path-to-regexp 0.1.13
      // uses the unnamed splat `*` which lands in params[0]. Fall back
      // so the route works in BOTH environments.
      const path = String(request.params.path || request.params[0] || '');
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
      // See field-policies route for why this fallback exists
      // (Express 4 splat at params[0], Express 5 named at params.resource).
      const resource = String(request.params.resource || request.params[0] || '');
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

  // ───── Backup ─────

  // GET /api/rbac/backup — list available backup files in the
  // configured backup directory. Returns each file's name + size +
  // mtime. Useful for the DR "what backups do I have?" drill-down
  // before picking one to restore.
  //
  // Backup files live in $SBOS_BACKUP_DIR (default ./backups).
  // Filenames follow the pattern sbos-backup-YYYY-MM-DD.db (the
  // convention set by POST /api/rbac/backup). Files that don't
  // match the pattern are ignored (operator-uploaded scratch files).
  app.get(
    '/api/rbac/backup',
    { preHandler: requirePermFastify('system.backup.read') },
    async (_request) => {
      const backupDir = process.env.SBOS_BACKUP_DIR || './backups';
      let files;
      try {
        const names = readdirSync(backupDir);
        files = names
          // Two file types live in the backup dir:
          //  - sbos-backup-YYYY-MM-DD.db   (snapshot from POST /backup)
          //  - validate-{random}.db        (uploaded file from
          //    POST /backup/validate, kept for the operator to
          //    inspect before committing to a restore)
          // Both are visible to operators so they can audit what's
          // been uploaded. Anything else (e.g. operator-dropped
          // ad-hoc files) is hidden.
          .filter(
            (n) =>
              /^sbos-backup-\d{4}-\d{2}-\d{2}\.db$/.test(n) ||
              /^validate-[0-9a-f]{16}\.db$/.test(n),
          )
          .map((n) => {
            const stat = statSync(join(backupDir, n));
            return {
              filename: n,
              size_bytes: stat.size,
              mtime: stat.mtime.toISOString(),
            };
          })
          .sort((a, b) => b.mtime.localeCompare(a.mtime)); // newest first
      } catch (_e) {
        files = []; // dir doesn't exist yet (no backups taken)
      }
      return { items: files };
    },
  );

  // POST /api/rbac/backup — disaster-recovery snapshot. Uses
  // SQLite's VACUUM INTO to write a consistent point-in-time copy
  // of the entire database to a tmp file, then streams it to the
  // client with Content-Disposition: attachment. The tmp file is
  // unlinked after streaming completes (or errors out).
  //
  // Returns 501 if the database is in-memory (no file to read) —
  // production deploys always use a file-backed DB.
  //
  // Perm gate: system.backup.run (high sensitivity — the response
  // contains every row in every table, including hashed passwords,
  // sessions, and customer data). Audited under resource='database'.
  app.post(
    '/api/rbac/backup',
    { preHandler: requirePermFastify('system.backup.run') },
    async (request, reply) => {
      const row = db.prepare('PRAGMA database_list').get();
      const dbFile = row && row.file;
      if (!dbFile) {
        return reply
          .code(501)
          .send({ error: 'not_supported', message: 'in-memory database cannot be backed up' });
      }
      // Audit BEFORE the snapshot (so the audit log entry is in
      // the snapshot itself — important for forensics).
      try {
        db.prepare(
          `INSERT INTO audit (tenant_id, user_id, username, action, resource, method, path, status_code, payload_json, request_id)
           VALUES (?, ?, ?, 'backup.run', 'database', 'POST', '/api/rbac/backup', 200, '{}', ?)`,
        ).run(
          request.user.tenant_id || 0,
          request.user.id,
          request.user.username,
          request.headers['x-request-id'] || null,
        );
      } catch (_e) {
        // best-effort; don't fail the backup if the audit table
        // isn't writable
      }
      // Write a consistent snapshot via VACUUM INTO.
      const tmpPath = join(tmpdir(), `sbos-backup-${randomBytes(8).toString('hex')}.db`);
      try {
        db.exec(`VACUUM INTO '${tmpPath.replace(/'/g, "''")}'`);
      } catch (err) {
        return reply.code(500).send({
          error: 'backup_failed',
          message: err && err.message ? err.message : 'VACUUM INTO failed',
        });
      }
      try {
        const snapshot = readFileSync(tmpPath);
        const filename = `sbos-backup-${new Date().toISOString().slice(0, 10)}.db`;
        reply
          .header('Content-Type', 'application/octet-stream')
          .header('Content-Disposition', `attachment; filename="${filename}"`)
          .header('Content-Length', String(snapshot.length))
          .send(snapshot);
      } finally {
        try { unlinkSync(tmpPath); } catch (_e) { /* best-effort */ }
      }
    },
  );

  // POST /api/rbac/backup/validate — accept a backup file as raw
  // bytes (Content-Type: application/octet-stream) and verify it's
  // a valid sqlite database by opening it in a transient handle
  // and running integrity_check. The file is saved to
  // $SBOS_BACKUP_DIR/validate-{random}.db so the operator can
  // inspect it before committing to a restore.
  //
  // Returns 200 with {ok: true, filename, size_bytes, integrity}
  // (the integrity value is 'ok' on a healthy DB) or 400 on
  // validation failure with the specific error.
  //
  // The endpoint does NOT actually restore the DB — that's a
  // separate destructive operation. The validate endpoint is
  // the "let me check this backup before I commit to it" step.
  // Restoring requires a server restart (the live DB connection
  // can't be swapped mid-process), which the operator can
  // trigger manually after seeing the validate result.
  app.post(
    '/api/rbac/backup/validate',
    { preHandler: requirePermFastify('system.backup.run') },
    async (request, reply) => {
      // Read the raw body. The body-parser middleware (express.json
      // at /index.js) doesn't handle raw bytes; we need to read
      // from the underlying request stream.
      const chunks = [];
      const contentType = String(request.headers['content-type'] || '');
      if (!/^application\/octet-stream\b/.test(contentType)) {
        return reply.code(415).send({
          error: 'unsupported_media_type',
          message: 'Content-Type must be application/octet-stream',
        });
      }
      for await (const chunk of request.raw || []) {
        chunks.push(chunk);
      }
      const body = Buffer.concat(chunks);
      if (body.length === 0) {
        return reply.code(400).send({ error: 'empty_body' });
      }
      // Magic-string check: a valid sqlite file starts with
      // 'SQLite format 3\0' (16 bytes).
      if (body.length < 16 || body.slice(0, 16).toString('utf8') !== 'SQLite format 3\u0000') {
        return reply.code(400).send({
          error: 'invalid_backup',
          message: 'file does not start with the SQLite magic string',
        });
      }
      // Save to a tmp file inside the backup dir so the operator
      // can inspect it + it's available for the eventual restore.
      const backupDir = process.env.SBOS_BACKUP_DIR || './backups';
      // Ensure the dir exists — the GET /api/rbac/backup endpoint
      // is happy with a missing dir (returns empty list), but the
      // validate endpoint writes to it so we need to create it on
      // demand. recursive: true is a no-op if the dir already exists.
      mkdirSync(backupDir, { recursive: true });
      const tmpName = `validate-${randomBytes(8).toString('hex')}.db`;
      const tmpPath = join(backupDir, tmpName);
      writeFileSync(tmpPath, body);
      // Open it in a transient handle + run integrity_check.
      // We use the underlying better-sqlite3-compatible API via
      // the existing node:sqlite DatabaseSync. The handle is
      // scoped to this function so it closes when the route
      // returns (no leak).
      let integrity;
      let tableCount;
      try {
        const { DatabaseSync } = await import('node:sqlite');
        const handle = new DatabaseSync(tmpPath);
        try {
          const integrityRow = handle.prepare('PRAGMA integrity_check').get();
          integrity = (integrityRow && integrityRow.integrity_check) || 'unknown';
          const tables = handle.prepare(
            "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'",
          ).get();
          tableCount = Number(tables.n || 0);
        } finally {
          handle.close();
        }
      } catch (err) {
        return reply.code(400).send({
          error: 'integrity_check_failed',
          message: err && err.message ? err.message : 'unable to open as sqlite',
        });
      }
      if (integrity !== 'ok') {
        return reply.code(400).send({
          error: 'integrity_check_failed',
          integrity,
          message: `integrity_check returned: ${integrity}`,
        });
      }
      return reply.code(200).send({
        ok: true,
        filename: tmpName,
        size_bytes: body.length,
        table_count: tableCount,
        integrity,
      });
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

  // ───── Approval / Dual-control workflow ─────
  //
  // Phase 0.4 wiring for sbos_rbac_approvals. The four endpoints below
  // are the public surface; the business logic lives in
  // server/rbac/approvals.js (pure, framework-agnostic functions).
  //
  // All four endpoints read tenant_id from the authenticated user and
  // refuse to act across tenant boundaries — there is no path that
  // lets a caller specify an arbitrary tenant_id for read or write.

  app.get(
    '/api/rbac/approvals',
    { preHandler: requirePermFastify('security.approval.read') },
    async (request) => {
      // Opportunistically sweep stale rows so the queue UI never
      // shows rows that are past their expires_at. expireStale is
      // idempotent and cheap on the typical small N of pending rows.
      expireStale(db);
      const limit = Math.min(Number(request.query.limit) || 100, 500);
      const items = listPendingApprovals(db, {
        tenantId: request.user.tenant_id || 0,
        limit,
      });
      return { items };
    },
  );

  app.post(
    '/api/rbac/approvals',
    { preHandler: requirePermFastify('security.approval.request') },
    async (request, reply) => {
      const body = request.body || {};
      try {
        const id = requestApproval(db, {
          tenantId: request.user.tenant_id || 0,
          resource: body.resource,
          action: body.action,
          payloadJson: typeof body.payloadJson === 'string' ? body.payloadJson : '{}',
          requestedBy: request.user.id,
        });
        return reply.code(201).send({ id, status: 'pending' });
      } catch (err) {
        if (err instanceof ApprovalValueError) {
          return reply.code(400).send({ error: 'invalid_request', message: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/rbac/approvals/:id/approve',
    { preHandler: requirePermFastify('security.approval.decide') },
    async (request, reply) => {
      try {
        const result = approveRequest(db, {
          approvalId: request.params.id,
          approvedBy: request.user.id,
        });
        return result;
      } catch (err) {
        if (err instanceof ApprovalValueError) {
          // dual-control and not-pending both surface as 409 (conflict);
          // unknown id is 404. Distinguish by the message text — the
          // error string is stable enough to be a contract here.
          const status = /not found/i.test(err.message) ? 404 : 409;
          return reply
            .code(status)
            .send({ error: status === 404 ? 'not_found' : 'conflict', message: err.message });
        }
        throw err;
      }
    },
  );

  app.post(
    '/api/rbac/approvals/:id/reject',
    { preHandler: requirePermFastify('security.approval.decide') },
    async (request, reply) => {
      const body = request.body || {};
      try {
        const result = rejectRequest(db, {
          approvalId: request.params.id,
          rejectedBy: request.user.id,
          reason: body.reason,
        });
        return result;
      } catch (err) {
        if (err instanceof ApprovalValueError) {
          // Same shape as approve: 404 for unknown id, 409 for dual-
          // control / not-pending, 400 for missing reason.
          let status = 409;
          if (/not found/i.test(err.message)) status = 404;
          else if (/reason/i.test(err.message)) status = 400;
          return reply.code(status).send({
            error: status === 404 ? 'not_found' : status === 400 ? 'invalid_request' : 'conflict',
            message: err.message,
          });
        }
        throw err;
      }
    },
  );
}

export { registerRbacRoutes };
