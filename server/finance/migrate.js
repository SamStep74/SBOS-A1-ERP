// SBOS-A1-ERP finance schema migration runner.
//
// Tiny duck-type dispatcher: if the input DB exposes `.query(sql, params?)`,
// we treat it as a pg-style PoolClient. Otherwise we fall through to
// better-sqlite3-style (db.exec). Idempotent: re-running on the same DB is
// a no-op the second time.
//
// TDD RED stub. Real implementation lands in the next commit.

export async function applyMigrations(/* db, opts */) {
  throw new Error('NotImplementedError: applyMigrations is not implemented yet (RED phase)');
}
