// SBOS-A1-ERP real-database adapter.
//
// Wraps a raw `node:sqlite` DatabaseSync handle in a pg-style
// adapter so the finance pure functions (which speak pg — `$N`
// placeholders, `::TYPE` casts, `.query(sql, params)` returning
// `{ rows }`) can drive a real sqlite file.
//
// The translation rules are the same ones the test harnesses use
// (see server/finance/dashboard.test.js `makePgAdapter`):
//
//   $N            → ?
//   ::TYPE        → (stripped)
//
// The adapter is intentionally tiny: it covers the SQL surface the
// pure functions emit (SELECT/INSERT/UPDATE/DELETE, parameterized).
// Prepared statements are cached per (sql) string inside the
// DatabaseSync itself, so we don't need to add another cache layer.
import { DatabaseSync } from 'node:sqlite';

/**
 * Build a real-DB adapter backed by a sqlite file.
 *
 * @param {string} dbPath  path to the sqlite file (created if missing)
 * @returns {{ sqlite: DatabaseSync, pgAdapter: { query(sql, params) } }}
 */
export function createRealDb(dbPath) {
  const sqlite = new DatabaseSync(dbPath);
  // PRAGMAs the production schema relies on.
  sqlite.exec('PRAGMA journal_mode = WAL');
  sqlite.exec('PRAGMA foreign_keys = OFF');
  return { sqlite, pgAdapter: makePgAdapter(sqlite) };
}

/**
 * Wrap an existing DatabaseSync in a pg-style adapter.
 *
 * @param {DatabaseSync} sqliteDb
 * @returns {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }}
 */
export function makePgAdapter(sqliteDb) {
  if (!sqliteDb || typeof sqliteDb.prepare !== 'function') {
    throw new TypeError('makePgAdapter requires a node:sqlite DatabaseSync handle');
  }
  return {
    async query(sql, params = []) {
      const translated = String(sql)
        .replace(/\$\d+/g, '?')
        .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '');
      const stmt = sqliteDb.prepare(translated);
      // SELECTs return rows; non-SELECTs return [] (the production
      // finance modules own the write-path branches — same rule as
      // server/finance/reports.js' runQuery).
      const trimmed = translated.trim().toUpperCase();
      if (trimmed.startsWith('SELECT') || trimmed.startsWith('WITH')) {
        const rows = stmt.all(...(params || []));
        return { rows };
      }
      const info = stmt.run(...(params || []));
      // Mirror pg's RETURNING-less result shape: include lastInsertRowid
      // so callers that use `RETURNING id` can fall back to it.
      return { rows: [], lastInsertRowid: info.lastInsertRowid, changes: info.changes };
    },
  };
}
