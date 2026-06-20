// SBOS-A1-ERP RBAC Approval Routes — Integration Test Suite
//
// Phase 0.4 dual-control wiring. Tests the 4 new approval endpoints
// (`server/rbac/routes.js`):
//   GET    /api/rbac/approvals
//   POST   /api/rbac/approvals
//   POST   /api/rbac/approvals/:id/approve
//   POST   /api/rbac/approvals/:id/reject
//
// Pattern: wave-8 mock-app — captures the route table from
// registerRbacRoutes() and dispatches handlers in-process. No real
// HTTP server, no Fastify dep. The preHandler is not invoked by the
// mock; tests pass a request.user with the right shape directly,
// matching the wave-8 contract.
//
// Run with:
//   node --test --test-concurrency=4 --test-timeout=60000 \
//     server/rbac/routes.test.js
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { registerRbacRoutes } from './routes.js';

function makeMockApp() {
  // Same mock-app pattern as wave-8 in rbac.test.js: capture
  // (url, opts, handler) tuples and dispatch by (method, url, params).
  const routes = [];
  function patternToRegex(pattern) {
    const paramNames = [];
    const re = pattern.replace(/:([A-Za-z_][A-Za-z0-9_]*)|\(\*\)/g, (_, name) => {
      if (name === undefined) {
        paramNames.push('_splat');
        return '(.*)';
      }
      paramNames.push(name);
      return '([^/]+)';
    });
    return { regex: new RegExp('^' + re + '$'), paramNames };
  }
  const methods = ['get', 'post', 'patch', 'put', 'delete'];
  const app = {};
  for (const method of methods) {
    app[method] = (url, opts, handler) => {
      if (typeof opts === 'function') {
        handler = opts;
        opts = {};
      }
      const compiled = patternToRegex(url);
      routes.push({ method, url, opts, handler, compiled });
    };
  }
  return { app, routes };
}

function makeReply() {
  const r = { status: 200, body: undefined, sent: false };
  r.reply = {
    code(c) {
      r.status = c;
      return r.reply;
    },
    status(c) {
      r.status = c;
      return r.reply;
    },
    send(b) {
      r.body = b;
      r.sent = true;
      return r.reply;
    },
    get sent() {
      return r.sent;
    },
  };
  return r;
}

function dispatch(routes, method, url, request, reply) {
  for (const r of routes) {
    if (r.method.toUpperCase() !== method.toUpperCase()) continue;
    const m = r.compiled.regex.exec(url);
    if (!m) continue;
    for (let i = 0; i < r.compiled.paramNames.length; i++) {
      request.params[r.compiled.paramNames[i]] = decodeURIComponent(m[i + 1]);
    }
    const ret = r.handler(request, reply);
    if (ret && typeof ret.then === 'function') {
      return ret.then((v) => {
        if (v !== undefined && !reply.sent) reply.send(v);
        return v;
      });
    }
    if (ret !== undefined && !reply.sent) reply.send(ret);
    return ret;
  }
  throw new Error(`No route matched ${method} ${url}`);
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  const rbacDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(rbacDir, 'schema.sql');
  // node:sqlite refuses two primary keys on the same table, so the
  // sbos_rbac_approvals `PRIMARY KEY (id, tenant_id)` table-level
  // constraint is stripped. id remains the sole PK via its column
  // declaration.
  const schema = readFileSync(schemaPath, 'utf8').replace(
    /,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m,
    '\n  );',
  );
  db.exec(schema);
  return db;
}

describe('RBAC approval routes', () => {
  let db;
  let routes;

  before(() => {
    db = makeDb();
    const mock = makeMockApp();
    routes = mock.routes;
    registerRbacRoutes(mock.app, { db });
  });

  test('POST /api/rbac/approvals creates a pending row and returns 201 + id', async () => {
    const req = {
      user: { id: 42, role: 'Admin', tenant_id: 7 },
      body: {
        resource: 'finance.journal.post',
        action: 'finance.journal.post',
        payloadJson: '{"amount":1000}',
      },
    };
    const r = makeReply();
    await dispatch(routes, 'POST', '/api/rbac/approvals', req, r.reply);
    assert.equal(r.status, 201);
    assert.ok(r.body.id, 'returns an id');
    assert.equal(r.body.status, 'pending');

    // The row should be in the DB with the right tenant + requester.
    const row = db
      .prepare(
        `SELECT id, tenant_id, resource, action, payload_json, requested_by, status
           FROM sbos_rbac_approvals WHERE id = ?`,
      )
      .get(r.body.id);
    assert.equal(row.tenant_id, 7);
    assert.equal(row.requested_by, 42);
    assert.equal(row.resource, 'finance.journal.post');
    assert.equal(row.action, 'finance.journal.post');
    assert.equal(row.payload_json, '{"amount":1000}');
    assert.equal(row.status, 'pending');
  });

  test('GET /api/rbac/approvals returns pending rows for the user tenant only', async () => {
    // Use a fresh DB so the test isn't polluted by the prior row.
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    // Insert via the route so we exercise the request handler too.
    const r1 = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 1, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r1', action: 'a1', payloadJson: '{}' },
      },
      r1.reply,
    );
    assert.equal(r1.status, 201);
    const id1 = r1.body.id;

    const r2 = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 2, role: 'Admin', tenant_id: 9 },
        body: { resource: 'r2', action: 'a2', payloadJson: '{}' },
      },
      r2.reply,
    );
    const id2 = r2.body.id;

    // Tenant 0 user listing → only their own row.
    const list1 = makeReply();
    await dispatch(
      localRoutes,
      'GET',
      '/api/rbac/approvals',
      { user: { id: 1, role: 'Admin', tenant_id: 0 }, query: {} },
      list1.reply,
    );
    assert.equal(list1.status, 200);
    const ids1 = list1.body.items.map((i) => i.id);
    assert.deepEqual(ids1, [id1], 'tenant 0 sees only their own row');

    // Tenant 9 user listing → only their own row.
    const list2 = makeReply();
    await dispatch(
      localRoutes,
      'GET',
      '/api/rbac/approvals',
      { user: { id: 2, role: 'Admin', tenant_id: 9 }, query: {} },
      list2.reply,
    );
    const ids2 = list2.body.items.map((i) => i.id);
    assert.deepEqual(ids2, [id2], 'tenant 9 sees only their own row');
  });

  test('POST /api/rbac/approvals/:id/approve happy path flips status to approved', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    // User 1 requests, user 2 (different) approves.
    const create = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 1, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', action: 'a', payloadJson: '{}' },
      },
      create.reply,
    );
    const id = create.body.id;

    const approve = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/approve`,
      { user: { id: 2, role: 'Admin', tenant_id: 0 }, params: {} },
      approve.reply,
    );
    assert.equal(approve.status, 200);
    assert.equal(approve.body.status, 'approved');
    assert.equal(approve.body.approvedBy, 2);

    const row = localDb
      .prepare(`SELECT status, approved_by FROM sbos_rbac_approvals WHERE id = ?`)
      .get(id);
    assert.equal(row.status, 'approved');
    assert.equal(row.approved_by, 2);
  });

  test('POST /api/rbac/approvals/:id/approve dual-control → 409 when same user', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const create = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 5, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', action: 'a', payloadJson: '{}' },
      },
      create.reply,
    );
    const id = create.body.id;

    const approve = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/approve`,
      { user: { id: 5, role: 'Admin', tenant_id: 0 }, params: {} },
      approve.reply,
    );
    assert.equal(approve.status, 409, 'same approver as requester → 409 conflict');
    assert.equal(approve.body.error, 'conflict');
    // The row must remain pending.
    const row = localDb.prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`).get(id);
    assert.equal(row.status, 'pending');
  });

  test('POST /api/rbac/approvals/:id/reject happy path flips status to rejected with reason', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const create = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 10, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', action: 'a', payloadJson: '{}' },
      },
      create.reply,
    );
    const id = create.body.id;

    const reject = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/reject`,
      {
        user: { id: 11, role: 'Admin', tenant_id: 0 },
        body: { reason: 'insufficient backup documentation' },
        params: {},
      },
      reject.reply,
    );
    assert.equal(reject.status, 200);
    assert.equal(reject.body.status, 'rejected');
    assert.equal(reject.body.rejectedBy, 11);
    assert.equal(reject.body.reason, 'insufficient backup documentation');

    const row = localDb
      .prepare(`SELECT status, rejected_by, rejection_reason FROM sbos_rbac_approvals WHERE id = ?`)
      .get(id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.rejected_by, 11);
    assert.equal(row.rejection_reason, 'insufficient backup documentation');
  });

  test('POST /api/rbac/approvals/:id/reject without reason → 400 invalid_request', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const create = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 20, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', action: 'a', payloadJson: '{}' },
      },
      create.reply,
    );
    const id = create.body.id;

    const reject = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/reject`,
      {
        user: { id: 21, role: 'Admin', tenant_id: 0 },
        body: {}, // missing reason
        params: {},
      },
      reject.reply,
    );
    assert.equal(reject.status, 400);
    assert.equal(reject.body.error, 'invalid_request');
  });

  test('POST /api/rbac/approvals/:id/approve on unknown id → 404', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const approve = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals/does-not-exist/approve',
      { user: { id: 30, role: 'Admin', tenant_id: 0 }, params: {} },
      approve.reply,
    );
    assert.equal(approve.status, 404);
    assert.equal(approve.body.error, 'not_found');
  });

  // ───── Additional edge-case tests (attempt 2) ─────
  //
  // These five cases close gaps the attempt-1 reviewer flagged. The
  // first attempt only asserted the happy path and the most obvious
  // denial paths. These tests exercise input validation, the reject
  // dual-control path, idempotency on already-decided rows, the GET
  // limit parameter, and the reject unknown-id 404.

  test('POST /api/rbac/approvals with missing resource/action → 400 invalid_request', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    // Missing resource — requestApproval throws ValueError → 400.
    const r1 = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 100, role: 'Admin', tenant_id: 0 },
        body: { action: 'a', payloadJson: '{}' }, // resource missing
      },
      r1.reply,
    );
    assert.equal(r1.status, 400);
    assert.equal(r1.body.error, 'invalid_request');

    // Missing action.
    const r2 = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 100, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', payloadJson: '{}' }, // action missing
      },
      r2.reply,
    );
    assert.equal(r2.status, 400);
    assert.equal(r2.body.error, 'invalid_request');
  });

  test('POST /api/rbac/approvals/:id/reject dual-control → 409 when same user', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const create = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 200, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', action: 'a', payloadJson: '{}' },
      },
      create.reply,
    );
    const id = create.body.id;

    // Same user (200) attempts to reject their own request.
    const reject = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/reject`,
      {
        user: { id: 200, role: 'Admin', tenant_id: 0 },
        body: { reason: 'self-reject attempt' },
        params: {},
      },
      reject.reply,
    );
    assert.equal(reject.status, 409, 'same rejecter as requester → 409 conflict');
    assert.equal(reject.body.error, 'conflict');
    // The row must remain pending.
    const row = localDb.prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`).get(id);
    assert.equal(row.status, 'pending');
  });

  test('POST /api/rbac/approvals/:id/approve on already-rejected → 409 conflict', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const create = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals',
      {
        user: { id: 300, role: 'Admin', tenant_id: 0 },
        body: { resource: 'r', action: 'a', payloadJson: '{}' },
      },
      create.reply,
    );
    const id = create.body.id;

    // User 301 rejects first.
    const reject = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/reject`,
      {
        user: { id: 301, role: 'Admin', tenant_id: 0 },
        body: { reason: 'changed my mind' },
        params: {},
      },
      reject.reply,
    );
    assert.equal(reject.status, 200);

    // User 302 then tries to approve — the row is no longer pending.
    const approve = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      `/api/rbac/approvals/${id}/approve`,
      { user: { id: 302, role: 'Admin', tenant_id: 0 }, params: {} },
      approve.reply,
    );
    assert.equal(approve.status, 409, 'cannot approve an already-rejected row');
    assert.equal(approve.body.error, 'conflict');
  });

  test('GET /api/rbac/approvals honors the ?limit query parameter', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    // Insert 4 pending rows for tenant 0.
    for (let i = 0; i < 4; i++) {
      await dispatch(
        localRoutes,
        'POST',
        '/api/rbac/approvals',
        {
          user: { id: 400 + i, role: 'Admin', tenant_id: 0 },
          body: { resource: `r${i}`, action: 'a', payloadJson: '{}' },
        },
        makeReply().reply,
      );
    }

    // Default (no limit param) returns all 4.
    const all = makeReply();
    await dispatch(
      localRoutes,
      'GET',
      '/api/rbac/approvals',
      { user: { id: 1, role: 'Admin', tenant_id: 0 }, query: {} },
      all.reply,
    );
    assert.equal(all.status, 200);
    assert.equal(all.body.items.length, 4);

    // limit=2 returns 2. The mock-app's URL regex doesn't include the
    // query string, so we strip it before dispatch — the route reads
    // `request.query.limit` exactly the way Express/Fastify would
    // have parsed it for us in a real request.
    const limited = makeReply();
    await dispatch(
      localRoutes,
      'GET',
      '/api/rbac/approvals',
      { user: { id: 1, role: 'Admin', tenant_id: 0 }, query: { limit: '2' } },
      limited.reply,
    );
    assert.equal(limited.status, 200);
    assert.equal(limited.body.items.length, 2, 'limit=2 returns 2 items');
  });

  test('POST /api/rbac/approvals/:id/reject on unknown id → 404', async () => {
    const localDb = makeDb();
    const localMock = makeMockApp();
    registerRbacRoutes(localMock.app, { db: localDb });
    const localRoutes = localMock.routes;

    const reject = makeReply();
    await dispatch(
      localRoutes,
      'POST',
      '/api/rbac/approvals/no-such-id/reject',
      {
        user: { id: 500, role: 'Admin', tenant_id: 0 },
        body: { reason: 'irrelevant' },
        params: {},
      },
      reject.reply,
    );
    assert.equal(reject.status, 404);
    assert.equal(reject.body.error, 'not_found');
  });
});
