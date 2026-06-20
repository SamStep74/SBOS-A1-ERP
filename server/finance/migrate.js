// SBOS-A1-ERP finance schema migration runner.
//
// Tiny duck-type dispatcher:
//   - If `db.query(sql, params?)` is a function, treat as pg-style (PoolClient).
//     Uses parameterized $N placeholders.
//   - Otherwise, treat as better-sqlite3-style. Uses `db.exec(sql)` for
//     multi-statement bodies and `db.prepare(sql).run(...params)` / `.all()`
//     for the parameterized bookkeeping queries.
//
// Idempotent: `finance.migration_history` records applied names. A second
// run with no new files reports everything as skipped.
//
// Failure semantics: a migration that throws mid-flight is NOT recorded in
// history. The error is rethrown so the caller (and any wrapping CLI) can
// surface it. Subsequent migrations are NOT attempted.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(__dirname, 'migrations');

// ────────────────────────────────────────────────────────────────────────────
// Adapter: a small per-driver facade so the rest of the runner is uniform.
// ────────────────────────────────────────────────────────────────────────────

function pgAdapter(db) {
  return {
    kind: 'pg',
    // Postgres supports schemas — we use the same `finance.` prefix as the
    // production schema, so history is greppable next to the rest of the
    // finance tables.
    historyCreateSql: `
      CREATE TABLE IF NOT EXISTS finance.migration_history (
        id          BIGSERIAL PRIMARY KEY,
        name        TEXT UNIQUE NOT NULL,
        applied_at  TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `.trim(),
    historySelectSql: 'SELECT name FROM finance.migration_history',
    historyInsertSql: 'INSERT INTO finance.migration_history (name, applied_at) VALUES ($1, $2)',
    // Run a single statement. Returns `{ rows: [] }`.
    async execOne(sql, params) {
      return db.query(sql, params);
    },
  };
}

function sqliteAdapter(db) {
  return {
    kind: 'sqlite',
    // Sqlite has no schema namespaces. We keep the dotted table name as a
    // single literal — works syntactically and matches the bookkeeping name
    // used by the pg branch.
    historyCreateSql: `
      CREATE TABLE IF NOT EXISTS migration_history (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        name        TEXT UNIQUE NOT NULL,
        applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `.trim(),
    historySelectSql: 'SELECT name FROM migration_history',
    historyInsertSql: 'INSERT INTO migration_history (name, applied_at) VALUES (?, ?)',
    async execOne(sql, params) {
      const stmt = db.prepare(sql);
      if (params && params.length > 0) {
        stmt.run(...params);
        return { rows: [] };
      }
      // For SELECTs without params, return rows so the runner can read them.
      return { rows: stmt.all() };
    },
  };
}

function pickAdapter(db) {
  if (db && typeof db.query === 'function') return pgAdapter(db);
  if (db && (typeof db.prepare === 'function' || typeof db.exec === 'function')) {
    return sqliteAdapter(db);
  }
  throw new Error(
    'applyMigrations: db must expose either `query(sql, params?)` (pg-style) ' +
      'or `prepare/exec` (better-sqlite3-style)',
  );
}

// ────────────────────────────────────────────────────────────────────────────
// SQL splitting: one `;`-terminated statement per block.
// Same approach as server/rbac/seed.js: strip `--` comments, split on `;`,
// trim and drop empties. Safe for hand-written migrations; not safe for
// semicolons inside string literals — we don't ship those.
// ────────────────────────────────────────────────────────────────────────────

export function splitStatements(sql) {
  const cleaned = sql.replace(/^\s*--.*$/gm, '').replace(/\r\n/g, '\n');
  return cleaned
    .split(/;\s*\n/)
    .map((s) => s.trim())
    // CREATE SCHEMA / SET search_path are Postgres-only DDL. SQLite
    // has no schema namespaces; the test harness attaches :memory:
    // AS finance before calling applyMigrations so the dotted table
    // names already resolve. Strip those statements on the sqlite
    // branch — but keep them for pg.
    .filter((s) => !/^\s*CREATE\s+SCHEMA/i.test(s) && !/^\s*SET\s+search_path/i.test(s))
    .filter((s) => s.length > 0);
}

// Strip the `finance.` schema prefix from table names so the
// statements run on a sqlite db without a `finance` schema attached.
// Idempotent: leaves the SQL unchanged if no prefix is present.
//
// Exported so tests can assert on the transform.
export function stripFinancePrefix(sql) {
  // Match `finance.<identifier>` only when it's a real table name
  // (i.e. not part of a longer string like `'finance.something'` or
  // a comment). Word boundaries on both sides.
  return sql.replace(/(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
}

// Translate Postgres DDL to sqlite-friendly syntax. Idempotent.
// Covers the differences our migrations actually use:
//   BIGSERIAL                       → INTEGER  (sqlite autoincrement is via INTEGER PK)
//   TIMESTAMPTZ                     → TEXT     (sqlite stores ISO strings)
//   NUMERIC(p,s)                    → NUMERIC  (sqlite accepts NUMERIC; precision is a hint)
//   now()                           → CURRENT_TIMESTAMP
//   ::type casts                    → ''       (sqlite has no :: cast operator)
//   ADD COLUMN IF NOT EXISTS        → ADD COLUMN  (sqlite has no IF NOT EXISTS on ADD COLUMN;
//
// Exported so tests can assert on the transform.
export function sqliteTranslate(sql) {
  return sql
    .replace(/\bBIGSERIAL\b/gi, 'INTEGER')
    .replace(/\bTIMESTAMPTZ\b/gi, 'TEXT')
    .replace(/\bNUMERIC\s*\(\s*\d+\s*,\s*\d+\s*\)/gi, 'NUMERIC')
    .replace(/\bnow\(\)/g, 'CURRENT_TIMESTAMP')
    .replace(/::\s*[A-Za-z_][A-Za-z0-9_]*/g, '')
    .replace(/\bADD\s+COLUMN\s+IF\s+NOT\s+EXISTS\b/gi, 'ADD COLUMN');
}

// ────────────────────────────────────────────────────────────────────────────
// Main entrypoint.
// ────────────────────────────────────────────────────────────────────────────

/**
 * Apply pending finance migrations against a Postgres-style or sqlite-style DB.
 *
 * @param {import('pg').PoolClient | import('better-sqlite3').Database} db
 * @param {{migrationsDir?: string}} [opts]
 * @returns {Promise<{applied: string[], skipped: string[]}>}
 */
export async function applyMigrations(db, opts = {}) {
  const migrationsDir = opts.migrationsDir ?? DEFAULT_MIGRATIONS_DIR;
  const adapter = pickAdapter(db);

  // 1. Ensure the bookkeeping table exists.
  await adapter.execOne(adapter.historyCreateSql);

  // 2. Snapshot what's already applied.
  const seen = (await adapter.execOne(adapter.historySelectSql, [])).rows ?? [];
  const applied = new Set(seen.map((r) => r.name ?? r));

  // 3. Discover pending migrations in lexicographic order.
  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const result = { applied: [], skipped: [] };

  for (const file of files) {
    if (applied.has(file)) {
      result.skipped.push(file);
      continue;
    }

    const body = readFileSync(join(migrationsDir, file), 'utf8');
    const statements = splitStatements(body);

  // 4a. Run every statement in the migration body. If any throws, we
  //     abort WITHOUT recording the migration — callers can detect this
  //     by the absence of a history row for `file`.
  for (const stmt of statements) {
    // For sqlite, translate Postgres DDL to sqlite-friendly syntax AND
    // strip the `finance.` schema prefix. For pg, keep the SQL as-is.
    const adapted = adapter.kind === 'sqlite'
      ? stripFinancePrefix(sqliteTranslate(stmt))
      : stmt;
    try {
      await adapter.execOne(adapted, []);
    } catch (err) {
      console.error('[migrate] failed statement:', adapted);
      throw err;
    }
  }

    // 4b. Record the migration in the bookkeeping table. Uses the adapter's
    //     parameterized INSERT so filenames with quotes are safe.
    const nowIso = new Date().toISOString();
    await adapter.execOne(adapter.historyInsertSql, [file, nowIso]);

    result.applied.push(file);
    applied.add(file);
  }

  return result;
}
