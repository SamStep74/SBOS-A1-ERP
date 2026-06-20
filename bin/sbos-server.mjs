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
// The CLI intentionally applies only the schema required for the
// boot path (finance tables + RBAC schema + users stub). Task 2 will
// add tenant + migration management.
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from '../server/server.js';
import { makePgAdapter } from '../server/db/realDb.js';

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

function applySchemas(sqliteDb) {
  // finance schema (mirror what dashboard.test.js' makeRealDb does).
  sqliteDb.exec('ATTACH DATABASE ":memory:" AS finance');
  sqliteDb.exec('PRAGMA foreign_keys = OFF');
  sqliteDb.exec(`
    CREATE TABLE IF NOT EXISTS finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL, hvhh TEXT, address TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finance.invoices (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL,
      invoice_number TEXT NOT NULL UNIQUE,
      issue_date TEXT NOT NULL,
      due_date TEXT NOT NULL,
      subtotal_amd INTEGER NOT NULL,
      vat_amd INTEGER NOT NULL DEFAULT 0,
      total_amd INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft','sent','paid','overdue','void')),
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      sent_at TEXT, voided_at TEXT, void_reason TEXT
    );
    CREATE TABLE IF NOT EXISTS finance.invoice_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      description TEXT NOT NULL,
      quantity REAL NOT NULL, unit_price_amd INTEGER NOT NULL,
      line_total_amd INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS finance.payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id INTEGER NOT NULL,
      paid_at TEXT NOT NULL DEFAULT (datetime('now')),
      amount_amd INTEGER NOT NULL, method TEXT NOT NULL DEFAULT 'bank_transfer',
      reference TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS finance.vat_carry_forward (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      balance_amd INTEGER NOT NULL DEFAULT 0,
      as_of_period TEXT
    );
  `);

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
  // sbos_rbac_approvals that node:sqlite rejects; strip it the same
  // way rbac.test.js does.
  const here = dirname(fileURLToPath(import.meta.url));
  const rbacSchemaPath = join(here, '..', 'server', 'rbac', 'schema.sql');
  const rbacSchema = readFileSync(rbacSchemaPath, 'utf8').replace(
    /,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m,
    '\n  );',
  );
  sqliteDb.exec(rbacSchema);
}

// ────────────────────────────────────────────────────────────────────────
// Boot
// ────────────────────────────────────────────────────────────────────────

async function main() {
  const port = Number(process.env.PORT || 3000);
  const host = process.env.HOST || '127.0.0.1';
  const dbPath = resolveDbPath();
  ensureDir(dbPath);

  console.log(`[sbos-server] opening DB at ${dbPath}`);
  const sqliteDb = new DatabaseSync(dbPath);
  applySchemas(sqliteDb);

  const pgAdapter = makePgAdapter(sqliteDb);
  console.log(`[sbos-server] listening on http://${host}:${port}`);
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
      console.log(`[sbos-server] ${sig} received, shutting down`);
      server.close(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error('[sbos-server] fatal:', err && err.stack ? err.stack : err);
  process.exit(1);
});
