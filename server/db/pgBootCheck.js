// SBOS-A1-ERP pg-port boot check (Wave 118).
//
// Wraps the pg connection check from bin/sbos-server.mjs
// in a testable function. The boot script calls this with
// the real env vars; tests call it with explicit args.

import { createPgAdapter } from './pgAdapter.js';

/**
 * Validate the pg connection configured via
 * SBOS_DB_BACKEND=postgres + SBOS_PG_URL.
 *
 * Returns:
 *   { ok: true,  probe: number }  — connection succeeded
 *   { ok: false, error: string } — connection failed (e.g.
 *                                   pg not running, bad URL)
 *
 * Closes the client regardless. Does NOT mutate the
 * process.env or any global state.
 *
 * @param {string} connectionString — pg connection URL
 * @returns {Promise<{ok: boolean, probe?: number, error?: string}>}
 */
export async function pgBootCheck(connectionString) {
  if (!connectionString || typeof connectionString !== 'string') {
    return { ok: false, error: 'SBOS_PG_URL is empty or not a string' };
  }
  let adapter;
  try {
    adapter = await createPgAdapter({ connectionString });
    const probe = await adapter.query('SELECT 1 AS n');
    const n = probe.rows && probe.rows[0] ? Number(probe.rows[0].n) : null;
    if (n !== 1) {
      return { ok: false, error: `probe returned unexpected value: ${n}` };
    }
    return { ok: true, probe: n };
  } catch (err) {
    return {
      ok: false,
      error: err && err.message ? err.message : String(err),
    };
  } finally {
    if (adapter) {
      try {
        await adapter.close();
      } catch (_e) {
        // Defensive: the connection may already be closed
        // by a previous error.
      }
    }
  }
}