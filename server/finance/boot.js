// SBOS-A1-ERP finance module — boot wiring.
//
// The single entrypoint the rest of the app calls at startup. Right now the
// only responsibility is applying pending migrations via wave-4's
// `applyMigrations` and returning a tiny handle. Wave 6+ will grow this to
// also wire repositories, event emitters, and the like — but for now the
// contract is intentionally minimal so the boot surface is easy to test in
// isolation.
//
// The boot is async because applyMigrations is async (it talks to the DB).
// The handle is a plain object — no classes, no DI container — so callers
// in wave 6+ can destructure it without ceremony.

import { applyMigrations } from './migrate.js';

/**
 * Wire the finance module to the app.
 *
 *   1. Apply pending migrations via applyMigrations.
 *   2. Return a structured handle the rest of the app can use (a tiny
 *      object for now; expand in wave 6+).
 *
 * @param {import('pg').PoolClient | import('better-sqlite3').Database} db
 * @param {{
 *   logger?: { info: Function, warn: Function, error: Function },
 *   migrationsDir?: string,
 * }} [opts]
 * @returns {Promise<{ applied: string[], version: number }>}
 */
export async function bootFinance(db, opts = {}) {
  const { logger = null, migrationsDir } = opts;

  const { applied, skipped } = await applyMigrations(db, { migrationsDir });

  // Structured-log only when a logger is supplied; silent otherwise so unit
  // tests don't have to stub console.
  if (logger && typeof logger.info === 'function') {
    logger.info(`finance.boot: applied=${applied.length} skipped=${skipped.length}`);
  }

  // `version` here is just the count of migrations applied during THIS
  // boot. A real version table would track the highest applied ordinal;
  // wave 4 deliberately deferred that. If/when we add one, replace this
  // with a SELECT MAX(...) — the boot handle's contract is the same.
  return {
    applied,
    version: applied.length,
  };
}
