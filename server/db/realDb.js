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
//   finance.X     → X     (sqlite has no schema namespaces; the
//                          migration runner strips the prefix on
//                          CREATE, so reads must match)
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

// Strip the `finance.` schema prefix from a SQL string. Word-bounded
// so `'finance.x'` and `comments finance.x` are NOT touched. Exported
// so tests can assert on the transform.
export function stripFinanceSchemaPrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

/**
 * Wrap an existing DatabaseSync in a pg-style adapter.
 *
 * @param {DatabaseSync | { current: DatabaseSync }} sqliteDbOrRef
 *   Either a `DatabaseSync` handle (legacy path — captured at
 *   construction time, breaks after a live db swap) or a
 *   `{ current: handle }` ref (live-swap-safe — the adapter
 *   dereferences `current` per query, so it follows the live
 *   handle that createApp owns).
 * @returns {{ query: (sql: string, params?: any[]) => Promise<{ rows: any[] }> }}
 */
export function makePgAdapter(sqliteDbOrRef) {
  if (!sqliteDbOrRef) {
    throw new TypeError('makePgAdapter requires a DatabaseSync handle or a { current: ... } ref');
  }
  // Resolve the live handle per call. The legacy path is a
  // captured `DatabaseSync` (sqliteDbOrRef.prepare is a function).
  // The live-swap path is a ref object (sqliteDbOrRef.current is
  // the handle). Detect which by duck-typing.
  const isRef = typeof sqliteDbOrRef.prepare !== 'function';
  const getDb = isRef
    ? () => {
        const cur = sqliteDbOrRef.current;
        if (!cur) {
          throw new Error('pgAdapter: db is not open (mid-swap or not initialized)');
        }
        return cur;
      }
    : () => sqliteDbOrRef;
  return {
    async query(sql, params = []) {
      const db = getDb();
      const translated = String(sql)
        .replace(/\$\d+/g, '?')
        .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '')
        .replace(/(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
      const stmt = db.prepare(translated);
      // node:sqlite's `Statement.all()` returns the result rows for
      // SELECTs, INSERT/UPDATE/DELETE-with-RETURNING, and WITH-CTE
      // queries. For a plain INSERT/UPDATE/DELETE (no RETURNING), it
      // returns []. This is the right behaviour for the production
      // finance surface — every write here uses RETURNING and the
      // pure functions read back the result via `ins.rows[0].id`.
      //
      // An earlier version branched on SELECT and called
      // `stmt.run()` for everything else, which silently dropped the
      // RETURNING data and forced callers to fall back to
      // LAST_INSERT_ROWID() (whose column name is literally
      // "LAST_INSERT_ROWID()" with parens — easy to misread as
      // `rows[0].id`). That mismatch is what the wave-14 deploy
      // test caught.
      const rows = stmt.all(...(params || []));
      return { rows };
    },
  };
}
