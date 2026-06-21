// SBOS-A1-ERP bootable HTTP server CLI.
//
// Wires a real node:sqlite-backed database to the Express server.
// Honors `SBOS_DB` (path to an existing or new sqlite file) or
// defaults to `./.sbos.db` in the current working directory.
//
// Usage:
//   node bin/sbos-server.mjs                 # default port 3000, ./.sbos.db
//   SBOS_DB=./finance.db node bin/sbos-server.mjs
//   PORT=8080 node bin/sbos-server.mjs
//
// The CLI applies the full finance migration set (via applyMigrations)
// plus the RBAC schema, so any new migration the team ships is picked
// up on the next boot without a code change here.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/server.js';
import { makePgAdapter } from '../server/db/realDb.js';
import { applyMigrations } from '../server/finance/migrate.js';
import { seedRBAC } from '../server/rbac/seed.js';
import { seedSessionForAdmin } from '../server/auth.js';

// ────────────────────────────────────────────────────────────────────────
// Resolve DB path + apply schemas.
// ────────────────────────────────────────────────────────────────────────

function resolveDbPath() {
  const fromEnv = process.env.SBOS_DB;
  if (fromEnv && fromEnv.length > 0) return fromEnv;
  return './.sbos.db';
}

function ensureDir(filePath) {
  const dir = dirname(filePath);
  if (dir && dir !== '.' && dir !== '') {
    try {
      mkdirSync(dir, { recursive: true });
    } catch (_err) {
      // best-effort
    }
  }
}

async function applySchemas(sqliteDb) {
  // finance schema — use the real migration runner so all 5 migrations
  // (0001..0005) are applied. The runner is idempotent and records each
  // migration in finance.migration_history.
  await applyMigrations(sqliteDb, {
    migrationsDir: join(
      dirname(fileURLToPath(import.meta.url)),
      '..',
      'server',
      'finance',
      'migrations',
    ),
  });

  // users table (the auth middleware + rbac routes need it).
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      username TEXT NOT NULL,
      email TEXT,
      role TEXT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      org_id INTEGER,
      mfa_required INTEGER NOT NULL DEFAULT 0,
      mfa_verified INTEGER NOT NULL DEFAULT 0,
      password_hash TEXT,
      password_salt TEXT,
      failed_logins INTEGER NOT NULL DEFAULT 0,
      locked_until TEXT
    );
  `);
  // Seed the stub admin user when missing. Set a random initial
  // password so the operator must read it from the token file (or
  // the auth-token-file-derived log) and use POST /api/auth/login
  // to mint a session. The env var SBOS_ADMIN_PASSWORD overrides.
  const existing = sqliteDb.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!existing) {
    const { randomBytes, scryptSync } = await import('node:crypto');
    const adminPassword =
      process.env.SBOS_ADMIN_PASSWORD || randomBytes(18).toString('base64url');
    const salt = randomBytes(16).toString('base64url');
    const hash = scryptSync(adminPassword, salt, 64).toString('base64url');
    sqliteDb
      .prepare(
        `INSERT INTO users (id, username, email, role, tenant_id, org_id, password_hash, password_salt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(1, 'admin', 'admin@example.com', 'Admin', 0, null, hash, salt);
    if (!process.env.SBOS_ADMIN_PASSWORD) {
      const bootPort = process.env.PORT || 3000;
      const bootHost = process.env.HOST || '127.0.0.1';
      console.warn(`[sbos-server] admin password (random): ${adminPassword}`);
      console.warn(`[sbos-server] login at: curl -X POST http://${bootHost}:${bootPort}/api/auth/login -H 'content-type: application/json' -d '{"username":"admin","password":"<this>"}'`);
    }
  }

  // RBAC schema. The canonical schema has a redundant composite PK on
  // sbos_rbac_approvals that node:sqlite refuses; strip it the same
  // way rbac.test.js does.
  const here = dirname(fileURLToPath(import.meta.url));
  const rbacSchemaPath = join(here, '..', 'server', 'rbac', 'schema.sql');
  const rbacSchema = readFileSync(rbacSchemaPath, 'utf8').replace(
    /,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m,
    '\n  );',
  );
  sqliteDb.exec(rbacSchema);

  // Seed the RBAC catalog on a fresh boot. The rbac routes fall back to
  // the in-code catalog when the DB is empty, so /api/rbac/roles and
  // /api/rbac/permissions always work — but the permission-check guard
  // (e.g. requirePermFastify('security.approval.read')) needs the DB
  // role→set→perm chain to be populated. seedRBAC is idempotent.
  const rbacRowCount = sqliteDb
    .prepare('SELECT COUNT(*) AS n FROM sbos_rbac_permissions')
    .get();
  if (!rbacRowCount || rbacRowCount.n === 0) {
    const seedResult = await seedRBAC(sqliteDb);
    console.warn(
      `[sbos-server] seeded RBAC: ${seedResult.roles_seeded} roles, ${seedResult.permissions_seeded} permissions, ${seedResult.permission_sets_seeded} sets`,
    );
  }

  // Link the admin stub user (id=1) to the Admin rbac role. Without
  // this row, the admin user has `role: 'Admin'` text in the users
  // table but the rbac permission check (which reads from
  // sbos_rbac_user_roles) sees an empty role list — so every perm
  // check fails with 403. Idempotent via ON CONFLICT.
  sqliteDb
    .prepare(
      `INSERT INTO sbos_rbac_user_roles (user_id, role_id, tenant_id, assigned_at, assigned_by)
       VALUES (?, ?, ?, datetime('now'), ?)
       ON CONFLICT(user_id, role_id, tenant_id) DO NOTHING`,
    )
    .run(1, 'Admin', 0, 1);
}

// ────────────────────────────────────────────────────────────────────────
// Session token — for the real-auth path. The middleware in
// server/auth.js reads `sbos_rbac_sessions` and resolves a Bearer
// token to a user. On a fresh boot we seed one token for the admin
// user (id=1, role=Admin) and print it to stdout so the operator
// can copy-paste it into curl commands.
// ────────────────────────────────────────────────────────────────────────

function seedAdminSession(sqliteDb) {
  // Always seed (or return existing) — never silently skip, so the
  // operator always knows what token to use.
  const token = seedSessionForAdmin(sqliteDb);
  return token;
}

// ────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const dbPath = resolveDbPath();
  ensureDir(dbPath);

  console.warn(`[sbos-server] opening DB at ${dbPath}`);
  const sqliteDb = new DatabaseSync(dbPath);
  await applySchemas(sqliteDb);

  // Seed + persist the admin session token (real-auth path). The
  // legacy "Bearer dev" stub is gone — every request needs a real
  // token minted from the rbac seed. We persist the token to a
  // file (SBOS_ADMIN_TOKEN_FILE) so the operator can `cat` it
  // instead of grepping the boot log, and so a `docker exec` /
  // `journalctl` roundtrip isn't required for multi-host deploys.
  // The token is also printed to stdout for the operator who is
  // already watching the boot log.
  const adminToken = seedAdminSession(sqliteDb);
  if (process.env.SBOS_ADMIN_TOKEN_FILE) {
    const { writeFileSync, mkdirSync, chmodSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    const tokenFile = process.env.SBOS_ADMIN_TOKEN_FILE;
    mkdirSync(dirname(tokenFile), { recursive: true });
    writeFileSync(tokenFile, adminToken + '\n', { mode: 0o600 });
    try {
      chmodSync(tokenFile, 0o600);
    } catch (_e) {
      // best-effort: chmod might fail on some FSes (e.g. FAT32 in
      // a bind-mount); the file content is still set correctly
    }
    console.warn(`[sbos-server] admin session token written to ${tokenFile} (mode 0600)`);
  }
  console.warn(`[sbos-server] admin session token: ${adminToken}`);
  console.warn(`[sbos-server] use: curl -H "Authorization: Bearer ${adminToken}" http://${host}:${port}/api/health`);

  const pgAdapter = makePgAdapter(sqliteDb);
  console.warn(`[sbos-server] listening on http://${host}:${port}`);
  const server = await start({
    db: sqliteDb,
    pgAdapter,
    port,
    host,
    locale: process.env.SBOS_LOCALE || 'en',
  });

  // Graceful shutdown.
  for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
      console.warn(`[sbos-server] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[sbos-server] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
