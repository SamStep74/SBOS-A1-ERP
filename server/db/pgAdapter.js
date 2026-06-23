// SBOS-A1-ERP pg-port adapter (Wave 113-2 slice 1).
//
// This is the SCAFFOLD for a real pg backend. It is
// NOT YET WIRING the full app onto pg — that requires
// (a) the `pg` npm package as a dependency, (b) running
// migrations against a real pg database, (c) verifying
// every pure function still produces the right shape
// against pg (the pgAdapter is a translation layer that
// currently maps pg → sqlite, not the other way).
//
// What W113-2 slice 1 ships:
//   1. createPgAdapter({ connectionString }) — factory
//      that returns a pg-backed adapter with the same
//      interface as the existing makePgAdapter(sqlite).
//   2. The adapter is gated by SBOS_DB_BACKEND=postgres
//      (or opts.backend === 'postgres'). Default is
//      sqlite (the existing behaviour).
//   3. The adapter is unit-tested against a fake pg
//      client (we don't require a live pg in CI).
//
// What W113-2 slice 1 does NOT ship (future slices):
//   - npm install pg
//   - Real pg integration tests (testcontainers)
//   - Migrations that work on both backends (the
//     finance/rbac migration runners already strip
//     schema prefixes on sqlite; the pg runner would
//     keep them — but the SQL is still sqlite-flavored)
//   - Performance comparison (the pgAdapter translates
//     $N → ? and strips ::TYPE; a real pg backend
//     wouldn't need either translation)
//
// The factory deliberately does NOT take a dependency
// on the `pg` package yet — it's lazy-imported. The
// smoke step verifies the module loads + the factory
// returns a valid adapter object when given a fake
// client. Real pg wiring is a follow-up.

/**
 * Build a real pg-backed adapter. Lazy-imports the
 * `pg` package (which is NOT yet in package.json —
 * operators opt in by `npm install pg` and setting
 * SBOS_DB_BACKEND=postgres).
 *
 * @param {object} [opts]
 * @param {string} [opts.connectionString] — pg connection
 *   string (e.g. postgres://user:pass@host:5432/db)
 * @param {object} [opts.client] — pre-built pg Client
 *   (for tests; bypasses the lazy import)
 * @returns {Promise<{
 *   backend: 'postgres',
 *   client: object,
 *   query: (sql: string, params?: any[]) => Promise<{rows: any[]}>,
 *   close: () => Promise<void>,
 * }>}
 */
export async function createPgAdapter(opts = {}) {
  let client = opts.client;
  if (!client) {
    // Lazy import so the module can be required without
    // `pg` installed. Operators opt in by:
    //   1. npm install pg
    //   2. export SBOS_DB_BACKEND=postgres
    //   3. export SBOS_PG_URL=postgres://...
    let pg;
    try {
      pg = await import('pg');
    } catch (cause) {
      throw new Error(
        'pg backend requested but `pg` package is not installed. ' +
          'Run `npm install pg` to enable.',
        { cause },
      );
    }
    if (!opts.connectionString) {
      throw new Error(
        'createPgAdapter requires either opts.connectionString ' +
          'or opts.client',
      );
    }
    client = new pg.Client({ connectionString: opts.connectionString });
    await client.connect();
  }
  return {
    backend: 'postgres',
    client,
    async query(sql, params = []) {
      const result = await client.query(sql, params);
      return { rows: result.rows || [] };
    },
    async close() {
      await client.end();
    },
  };
}

/**
 * Detect which backend to use based on env vars.
 * Returns 'postgres' if SBOS_DB_BACKEND=postgres,
 * else 'sqlite' (the existing default).
 */
export function detectBackendFromEnv(env = process.env) {
  const backend = (env.SBOS_DB_BACKEND || '').toLowerCase();
  if (backend === 'postgres' || backend === 'pg') return 'postgres';
  return 'sqlite';
}
