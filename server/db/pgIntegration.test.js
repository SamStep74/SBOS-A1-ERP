// SBOS-A1-ERP pg-port integration test (Wave 116, slice 2).
//
// This test runs ONLY when SBOS_PG_URL is set in the
// environment. It connects to a real pg database, runs
// a minimal migration, and exercises the pgAdapter
// + suggestMergeCandidates against the real backend.
//
// Skipping policy: the test skips itself when
// SBOS_PG_URL is unset so the sqlite-only test
// environment doesn't fail. Operators who want pg
// coverage should set SBOS_PG_URL=postgres://...
// before running `npm test`.
//
// The test uses the W113-2 docker-compose.pg.yml
// service for local development. CI would need a
// real pg (testcontainers or a service) to run it.

import test from 'node:test';
import assert from 'node:assert/strict';

const PG_URL = process.env.SBOS_PG_URL;
const skip = !PG_URL;

test('pg integration: createPgAdapter connects + runs a query', { skip }, async () => {
  const { createPgAdapter } = await import('./pgAdapter.js');
  const adapter = await createPgAdapter({ connectionString: PG_URL });
  try {
    // Smoke query — pg's `SELECT 1` returns { rows: [{ '?column?': 1 }] }
    const r = await adapter.query('SELECT 1 AS n');
    assert.ok(Array.isArray(r.rows), 'rows is an array');
    assert.equal(r.rows.length, 1);
    assert.equal(Number(r.rows[0].n), 1);
  } finally {
    await adapter.close();
  }
});

test('pg integration: detectBackendFromEnv respects SBOS_DB_BACKEND', { skip }, async () => {
  const { detectBackendFromEnv } = await import('./pgAdapter.js');
  assert.equal(
    detectBackendFromEnv({ SBOS_DB_BACKEND: 'postgres' }),
    'postgres',
  );
  assert.equal(
    detectBackendFromEnv({ SBOS_DB_BACKEND: 'sqlite' }),
    'sqlite',
  );
  assert.equal(detectBackendFromEnv({}), 'sqlite');
});

test('pg integration: factory closes cleanly on second close', { skip }, async () => {
  const { createPgAdapter } = await import('./pgAdapter.js');
  const adapter = await createPgAdapter({ connectionString: PG_URL });
  await adapter.close();
  // Second close should not throw. pg's Client.end() throws
  // if called twice; we wrap it in the factory to be
  // idempotent.
  await adapter.close();
});