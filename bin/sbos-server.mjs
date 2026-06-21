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
      mfa_verified INTEGER NOT NULL DEFAULT 0
    );
  `);
  // Seed the stub admin user when missing.
  const existing = sqliteDb.prepare('SELECT id FROM users WHERE id = 1').get();
  if (!existing) {
    sqliteDb
      .prepare(
        'INSERT INTO users (id, username, email, role, tenant_id, org_id) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run(1, 'admin', 'admin@example.com', 'Admin', 0, null);
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
