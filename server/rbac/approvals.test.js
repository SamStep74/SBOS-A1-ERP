// SBOS-A1-ERP RBAC Approval Workflow — Test Suite
//
// Dual-control workflow for "critical" actions. The sbos_rbac_approvals
// table has been a no-op in the schema so far; this file wires it up.
//
// Run with:
//   node --test --test-concurrency=4 --test-timeout=60000 \
//     server/rbac/approvals.test.js
//
// Coverage targets (per AGENTS.md):
//   - requestApproval: insert + return id + 7d expiry
//   - listPendingApprovals: ordered by requested_at ASC, pending only
//   - approveRequest: dual-control (refuses same approver as requester)
//   - rejectRequest: dual-control (refuses same rejecter as requester)
//   - expireStale: flips expired pending rows
import { test, describe, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  requestApproval,
  listPendingApprovals,
  approveRequest,
  rejectRequest,
  expireStale,
} from './approvals.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // The canonical schema declares BOTH `id TEXT PRIMARY KEY` and a
  // trailing `PRIMARY KEY (id, tenant_id)` table constraint. node:sqlite
  // refuses two primary keys, so we strip the redundant composite PK
  // before applying. The id column is still the primary key — the
  // composite constraint was for cross-DBMS portability, which the
  // approval workflow doesn't need.
  const rbacDir = dirname(fileURLToPath(import.meta.url));
  const schemaPath = join(rbacDir, 'schema.sql');
  const schema = readFileSync(schemaPath, 'utf8').replace(
    /,\s*--[^\n]*\n\s*PRIMARY KEY \(id, tenant_id\)\n\s*\);/m,
    '\n  );',
  );
  db.exec(schema);
  return db;
}

describe('requestApproval', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  test('inserts a pending row and returns its id', () => {
    const id = requestApproval(db, {
      tenantId: 7,
      resource: 'finance.journal.post',
      action: 'finance.journal.post',
      payloadJson: '{"lines":[]}',
      requestedBy: 42,
    });
    assert.ok(typeof id === 'string' && id.length > 0, 'id is a non-empty string');
    const row = db
      .prepare(
        `SELECT id, tenant_id, resource, action, payload_json, requested_by, status
           FROM sbos_rbac_approvals WHERE id = ?`,
      )
      .get(id);
    assert.ok(row, 'row exists');
    assert.equal(row.tenant_id, 7);
    assert.equal(row.resource, 'finance.journal.post');
    assert.equal(row.action, 'finance.journal.post');
    assert.equal(row.payload_json, '{"lines":[]}');
    assert.equal(row.requested_by, 42);
    assert.equal(row.status, 'pending');
  });

  test('sets expires_at ~7 days in the future', () => {
    const before = Date.now();
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 1,
    });
    const after = Date.now();
    // Read the expires_at as a Unix timestamp (seconds) via SQLite's
    // strftime — the column is stored as text in UTC, and
    // `new Date('YYYY-MM-DD HH:MM:SS')` interprets that as local time,
    // which would shift the assertion by the timezone offset.
    const row = db
      .prepare(`SELECT strftime('%s', expires_at) AS exp FROM sbos_rbac_approvals WHERE id = ?`)
      .get(id);
    const exp = Number(row.exp) * 1000;
    const sevenDays = 7 * 24 * 60 * 60 * 1000;
    // expires_at should be ~7d after the call, with a small tolerance
    // for the wall-clock skew between the test caller and the SQL datetime.
    assert.ok(exp >= before + sevenDays - 5000, 'expires_at >= now + 7d - 5s');
    assert.ok(exp <= after + sevenDays + 5000, 'expires_at <= now + 7d + 5s');
  });

  test('rejects bad input guards: requestedBy, resource, action', () => {
    // requestedBy must be a positive integer
    assert.throws(
      () =>
        requestApproval(db, {
          resource: 'r',
          action: 'a',
          payloadJson: '{}',
          requestedBy: 0,
        }),
      /requestedBy|positive/i,
    );
    assert.throws(
      () =>
        requestApproval(db, {
          resource: 'r',
          action: 'a',
          payloadJson: '{}',
          requestedBy: -3,
        }),
      /requestedBy|positive/i,
    );
    assert.throws(
      () =>
        requestApproval(db, {
          resource: 'r',
          action: 'a',
          payloadJson: '{}',
          requestedBy: 'abc',
        }),
      /requestedBy|positive/i,
    );
    // resource / action must be non-empty
    assert.throws(
      () =>
        requestApproval(db, {
          resource: '   ',
          action: 'a',
          payloadJson: '{}',
          requestedBy: 1,
        }),
      /resource/i,
    );
    assert.throws(
      () =>
        requestApproval(db, {
          resource: 'r',
          action: '',
          payloadJson: '{}',
          requestedBy: 1,
        }),
      /action/i,
    );
    // opts must be an object
    assert.throws(() => requestApproval(db, null), /TypeError|object/i);
    assert.throws(() => requestApproval(db, 'string'), /TypeError|object/i);
  });
});

describe('listPendingApprovals', () => {
  let db;
  before(() => {
    db = makeDb();
  });

  test('returns only pending rows for the tenant, oldest first', () => {
    // 3 pending for tenant=1, 1 pending for tenant=2, 1 already approved
    const id1 = requestApproval(db, {
      tenantId: 1,
      resource: 'r1',
      action: 'a1',
      payloadJson: '{}',
      requestedBy: 100,
    });
    const id2 = requestApproval(db, {
      tenantId: 1,
      resource: 'r2',
      action: 'a2',
      payloadJson: '{}',
      requestedBy: 100,
    });
    const id3 = requestApproval(db, {
      tenantId: 1,
      resource: 'r3',
      action: 'a3',
      payloadJson: '{}',
      requestedBy: 100,
    });
    requestApproval(db, {
      tenantId: 2,
      resource: 'r-other-tenant',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 200,
    });
    // Approve id2 so it's no longer pending (we still need a second user,
    // so use 101).
    approveRequest(db, { approvalId: id2, approvedBy: 101 });

    const pending = listPendingApprovals(db, { tenantId: 1 });
    const ids = pending.map((p) => p.id);
    assert.deepEqual(ids, [id1, id3], 'only id1 + id3, in insertion order');
    // All returned rows must be status='pending'
    for (const p of pending) assert.equal(p.status, 'pending');
  });

  test('honors the limit option', () => {
    // We've already inserted 3 in the prior test. Add 5 more for tenant=99.
    for (let i = 0; i < 5; i++) {
      requestApproval(db, {
        tenantId: 99,
        resource: `r${i}`,
        action: 'a',
        payloadJson: '{}',
        requestedBy: 1,
      });
    }
    const limited = listPendingApprovals(db, { tenantId: 99, limit: 2 });
    assert.equal(limited.length, 2);
  });
});

describe('approveRequest', () => {
  let db;
  before(() => {
    db = makeDb();
  });

  test('happy path: request → approve → status=approved', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 1,
    });
    approveRequest(db, { approvalId: id, approvedBy: 2 });
    const row = db
      .prepare(`SELECT status, approved_by, approved_at FROM sbos_rbac_approvals WHERE id = ?`)
      .get(id);
    assert.equal(row.status, 'approved');
    assert.equal(row.approved_by, 2);
    assert.ok(row.approved_at, 'approved_at is set');
  });

  test('dual-control: refuses if approver == requester (same user)', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 5,
    });
    assert.throws(
      () => approveRequest(db, { approvalId: id, approvedBy: 5 }),
      /dual.control|approver|same/i,
      'throws with a dual-control-flavored message',
    );
    // Status must still be pending after the throw.
    const row = db.prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`).get(id);
    assert.equal(row.status, 'pending');
  });

  test('throws ValueError on unknown approvalId', () => {
    assert.throws(
      () => approveRequest(db, { approvalId: 'does-not-exist', approvedBy: 9 }),
      /not.found|unknown|invalid|valueerror/i,
      'throws a not-found-flavored error',
    );
  });

  test('throws on already-decided approval (idempotency fail-closed)', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 11,
    });
    approveRequest(db, { approvalId: id, approvedBy: 12 });
    assert.throws(
      () => approveRequest(db, { approvalId: id, approvedBy: 13 }),
      /already|pending|status|not.pend/i,
      'cannot re-approve an already-approved row',
    );
  });

  test('rejects bad input guards: approvedBy, opts shape', () => {
    // approvedBy must be a positive integer
    assert.throws(
      () => approveRequest(db, { approvalId: 'x', approvedBy: 0 }),
      /approvedBy|positive/i,
    );
    assert.throws(
      () => approveRequest(db, { approvalId: 'x', approvedBy: -1 }),
      /approvedBy|positive/i,
    );
    assert.throws(
      () => approveRequest(db, { approvalId: 'x', approvedBy: 'abc' }),
      /approvedBy|positive/i,
    );
    // opts not an object
    assert.throws(() => approveRequest(db, null), /TypeError|object/i);
    assert.throws(() => approveRequest(db, 'string'), /TypeError|object/i);
  });
});

describe('rejectRequest', () => {
  let db;
  before(() => {
    db = makeDb();
  });

  test('happy path: request → reject → status=rejected with reason', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 20,
    });
    rejectRequest(db, {
      approvalId: id,
      rejectedBy: 21,
      reason: 'missing CFO signoff',
    });
    const row = db
      .prepare(
        `SELECT status, rejected_by, rejected_at, rejection_reason
           FROM sbos_rbac_approvals WHERE id = ?`,
      )
      .get(id);
    assert.equal(row.status, 'rejected');
    assert.equal(row.rejected_by, 21);
    assert.ok(row.rejected_at, 'rejected_at is set');
    assert.equal(row.rejection_reason, 'missing CFO signoff');
  });

  test('dual-control: refuses if rejecter == requester (same user)', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 30,
    });
    assert.throws(
      () => rejectRequest(db, { approvalId: id, rejectedBy: 30, reason: 'no' }),
      /dual.control|rejecter|same/i,
      'throws with a dual-control-flavored message',
    );
    const row = db.prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`).get(id);
    assert.equal(row.status, 'pending');
  });

  test('rejects unknown approvalId', () => {
    assert.throws(
      () =>
        rejectRequest(db, {
          approvalId: 'no-such-id',
          rejectedBy: 50,
          reason: 'irrelevant',
        }),
      /not.found|unknown|valueerror/i,
    );
  });

  test('rejects when reason is missing or empty', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 60,
    });
    assert.throws(
      () => rejectRequest(db, { approvalId: id, rejectedBy: 61 }),
      /reason/i,
      'reason must be a non-empty string',
    );
    assert.throws(
      () => rejectRequest(db, { approvalId: id, rejectedBy: 61, reason: '   ' }),
      /reason/i,
      'whitespace-only reason is also rejected',
    );
  });

  test('rejects when rejectedBy is not a positive integer', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 70,
    });
    assert.throws(
      () => rejectRequest(db, { approvalId: id, rejectedBy: -1, reason: 'no' }),
      /rejectedBy|positive/i,
    );
    assert.throws(
      () => rejectRequest(db, { approvalId: id, rejectedBy: 'abc', reason: 'no' }),
      /rejectedBy|positive/i,
    );
  });

  test('rejects when opts is not an object', () => {
    assert.throws(() => rejectRequest(db, null), /TypeError|object/i);
    assert.throws(() => rejectRequest(db, 'string'), /TypeError|object/i);
  });

  test('refuses to reject an already-decided approval', () => {
    const id = requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 80,
    });
    rejectRequest(db, { approvalId: id, rejectedBy: 81, reason: 'first' });
    assert.throws(
      () => rejectRequest(db, { approvalId: id, rejectedBy: 82, reason: 'second' }),
      /pending|status|not.pend|already/i,
    );
  });
});

describe('expireStale', () => {
  let db;
  beforeEach(() => {
    db = makeDb();
  });

  test('flips only pending rows whose expires_at < now', () => {
    // Insert two pending rows; force one of them to be already expired.
    const freshId = requestApproval(db, {
      tenantId: 0,
      resource: 'r-fresh',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 1,
    });
    const staleId = requestApproval(db, {
      tenantId: 0,
      resource: 'r-stale',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 1,
    });
    // Backdate the second one to a moment in the past.
    db.prepare(
      `UPDATE sbos_rbac_approvals SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`,
    ).run(staleId);
    // Also an already-approved row that should stay untouched.
    const approvedId = requestApproval(db, {
      tenantId: 0,
      resource: 'r-approved',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 1,
    });
    approveRequest(db, { approvalId: approvedId, approvedBy: 2 });
    db.prepare(
      `UPDATE sbos_rbac_approvals SET expires_at = '2000-01-01 00:00:00' WHERE id = ?`,
    ).run(approvedId);

    const flipped = expireStale(db);
    assert.equal(flipped, 1, 'exactly one row was flipped to expired');

    const fresh = db.prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`).get(freshId);
    assert.equal(fresh.status, 'pending', 'fresh row stays pending');

    const stale = db.prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`).get(staleId);
    assert.equal(stale.status, 'expired', 'stale row was expired');

    const approved = db
      .prepare(`SELECT status FROM sbos_rbac_approvals WHERE id = ?`)
      .get(approvedId);
    assert.equal(approved.status, 'approved', 'approved row stays approved (not flipped)');
  });

  test('returns 0 when nothing to expire', () => {
    requestApproval(db, {
      tenantId: 0,
      resource: 'r',
      action: 'a',
      payloadJson: '{}',
      requestedBy: 1,
    });
    const flipped = expireStale(db);
    assert.equal(flipped, 0);
  });
});
