// SBOS-A1-ERP pg-port adapter tests (Wave 113-2 slice 1).
//
// The tests verify the factory's shape and the env
// detection — they do NOT need a live pg database.
// Real pg integration tests are a follow-up slice
// (after the `pg` package is added to package.json).

import test from 'node:test';
import assert from 'node:assert/strict';
import { createPgAdapter, detectBackendFromEnv } from './pgAdapter.js';

test('113.1 detectBackendFromEnv returns sqlite by default', () => {
  assert.equal(detectBackendFromEnv({}), 'sqlite');
  assert.equal(detectBackendFromEnv({ SBOS_DB_BACKEND: 'sqlite' }), 'sqlite');
});

test('113.2 detectBackendFromEnv returns postgres when SBOS_DB_BACKEND=postgres', () => {
  assert.equal(detectBackendFromEnv({ SBOS_DB_BACKEND: 'postgres' }), 'postgres');
  assert.equal(detectBackendFromEnv({ SBOS_DB_BACKEND: 'pg' }), 'postgres');
  assert.equal(detectBackendFromEnv({ SBOS_DB_BACKEND: 'POSTGRES' }), 'postgres');
});

test('113.3 createPgAdapter accepts a pre-built client (no `pg` import)', async () => {
  // Fake pg Client with a connect() and query() that
  // return a rows-shaped result. This lets the test
  // run without a live pg server.
  const fakeClient = {
    async connect() {},
    async query(sql) {
      // Return a pg-shaped result.
      if (sql.includes('FROM test')) return { rows: [{ n: 42 }] };
      return { rows: [] };
    },
    async end() {},
  };
  const adapter = await createPgAdapter({ client: fakeClient });
  assert.equal(adapter.backend, 'postgres');
  assert.equal(adapter.client, fakeClient);
  const r = await adapter.query('SELECT * FROM test');
  assert.deepEqual(r, { rows: [{ n: 42 }] });
});

test('113.4 createPgAdapter without client + without connectionString throws', async () => {
  // The factory first tries to lazy-import `pg`. If
  // `pg` is not installed, the import fails and we get
  // the "pg backend requested but `pg` package is not
  // installed" error. If `pg` IS installed, the factory
  // then checks connectionString and throws the
  // "requires either connectionString or client" error.
  const hasPg = await import('pg').then(() => true, () => false);
  if (hasPg) {
    await assert.rejects(
      () => createPgAdapter({}),
      /requires either opts\.connectionString or opts\.client/,
    );
  } else {
    await assert.rejects(
      () => createPgAdapter({}),
      /pg backend requested but `pg` package is not installed/,
    );
  }
});

test('113.5 createPgAdapter closes the client on close()', async () => {
  let endCalled = false;
  const fakeClient = {
    async connect() {},
    async query() { return { rows: [] }; },
    async end() { endCalled = true; },
  };
  const adapter = await createPgAdapter({ client: fakeClient });
  await adapter.close();
  assert.equal(endCalled, true);
});

test('113.6 createPgAdapter without `pg` package throws a clear error', async () => {
  // Pass a connectionString but no client. The factory
  // tries to lazy-import `pg`. If `pg` is not installed
  // (which is the case in CI), the import fails and
  // the error message is the friendly one.
  //
  // If `pg` IS installed in the test env, this test
  // would try to actually connect — that's a no-go for
  // a unit test, so we guard the test with a check.
  const hasPg = await import('pg').then(() => true, () => false);
  if (hasPg) {
    // pg is installed; skip this test (real pg would
    // need a connectionString to a live server).
    return;
  }
  await assert.rejects(
    () =>
      createPgAdapter({
        connectionString: 'postgres://invalid:invalid@127.0.0.1:1/none',
      }),
    /pg backend requested but `pg` package is not installed/,
  );
});
