// SBOS-A1-ERP RBAC Approval Workflow
//
// Dual-control workflow for "critical" actions. The sbos_rbac_approvals
// table has been in the schema since v0 but unused; this module wires it
// up. Five pure functions, no framework coupling (HTTP-layer glue lives
// in routes.js).
//
// Lifecycle:
//   1. User A invokes `requestApproval` → row inserted with status='pending'
//   2. User B (≠ A) invokes `approveRequest` OR `rejectRequest` → row
//      transitions to 'approved' or 'rejected'.
//   3. A background sweeper (or a route handler) calls `expireStale` to
//      flip stale rows to 'expired'.
//   4. `listPendingApprovals` powers the approval queue UI.
//
// IDs are crypto.randomUUID() (a real ULID is overkill for v0; the
// schema only requires TEXT, not lexicographic ordering).
//
// All write paths go through parameterized statements. No string-concat
// SQL, no eval, no new Function.
import { randomUUID } from 'node:crypto';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

const APPROVAL_WINDOW_DAYS = 7;

// ───── requestApproval ─────
//
// Inserts a new pending approval row. The caller is expected to supply
// a `tenantId` (typically from request.user.tenant_id). The schema
// requires tenant_id NOT NULL, so we default to 0 for system / global
// approvals if the caller doesn't supply one.
function requestApproval(db, opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('requestApproval: opts must be an object');
  }
  const tenantId = Number.isInteger(opts.tenantId) ? opts.tenantId : 0;
  const resource = String(opts.resource || '').trim();
  const action = String(opts.action || '').trim();
  const payloadJson = typeof opts.payloadJson === 'string' ? opts.payloadJson : '{}';
  const requestedBy = Number(opts.requestedBy);
  if (!Number.isInteger(requestedBy) || requestedBy <= 0) {
    throw new ValueError('requestedBy must be a positive integer');
  }
  if (!resource) {
    throw new ValueError('resource must be a non-empty string');
  }
  if (!action) {
    throw new ValueError('action must be a non-empty string');
  }
  const id = randomUUID();
  db.prepare(
    `INSERT INTO sbos_rbac_approvals
       (id, tenant_id, resource, action, payload_json, requested_by, status, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending',
             datetime('now', '+' || ? || ' days'))`,
  ).run(id, tenantId, resource, action, payloadJson, requestedBy, APPROVAL_WINDOW_DAYS);
  return id;
}

// ───── listPendingApprovals ─────
//
// Returns all rows with status='pending' for the given tenant, oldest
// first. The `limit` defaults to 100 and is hard-capped at 1000 to
// keep the query from accidentally pulling the world.
function listPendingApprovals(db, opts) {
  const tenantId = Number(opts && opts.tenantId) || 0;
  const requestedLimit = Number(opts && opts.limit);
  const limit =
    Number.isFinite(requestedLimit) && requestedLimit > 0
      ? Math.min(Math.floor(requestedLimit), 1000)
      : 100;
  return db
    .prepare(
      `SELECT id, tenant_id, resource, action, payload_json, requested_by,
              requested_at, expires_at, status
         FROM sbos_rbac_approvals
        WHERE tenant_id = ? AND status = 'pending'
        ORDER BY requested_at ASC
        LIMIT ?`,
    )
    .all(tenantId, limit);
}

// ───── approveRequest ─────
//
// Marks a pending row as approved. Dual-control: the approver MUST be
// a different user than the requester. Throws ValueError on:
//   - unknown approvalId
//   - already-decided approval
//   - approver == requester (dual-control)
function approveRequest(db, opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('approveRequest: opts must be an object');
  }
  const approvalId = String(opts.approvalId || '').trim();
  const approvedBy = Number(opts.approvedBy);
  if (!approvalId) throw new ValueError('approvalId must be a non-empty string');
  if (!Number.isInteger(approvedBy) || approvedBy <= 0) {
    throw new ValueError('approvedBy must be a positive integer');
  }
  const row = db
    .prepare(
      `SELECT id, tenant_id, requested_by, status
         FROM sbos_rbac_approvals WHERE id = ?`,
    )
    .get(approvalId);
  if (!row) {
    throw new ValueError(`approval not found: ${approvalId}`);
  }
  if (row.status !== 'pending') {
    throw new ValueError(`approval ${approvalId} is not pending (status=${row.status})`);
  }
  if (row.requested_by === approvedBy) {
    throw new ValueError(
      'dual-control violation: approver must be a different user than the requester',
    );
  }
  db.prepare(
    `UPDATE sbos_rbac_approvals
        SET status = 'approved',
            approved_by = ?,
            approved_at = datetime('now')
      WHERE id = ? AND status = 'pending'`,
  ).run(approvedBy, approvalId);
  return { id: approvalId, status: 'approved', approvedBy };
}

// ───── rejectRequest ─────
//
// Marks a pending row as rejected with a reason. Same dual-control
// guard as approveRequest. The reason is required (non-empty) so
// audit log entries are useful when the audit module later reads
// from this table.
function rejectRequest(db, opts) {
  if (!opts || typeof opts !== 'object') {
    throw new TypeError('rejectRequest: opts must be an object');
  }
  const approvalId = String(opts.approvalId || '').trim();
  const rejectedBy = Number(opts.rejectedBy);
  const reason = typeof opts.reason === 'string' ? opts.reason.trim() : '';
  if (!approvalId) throw new ValueError('approvalId must be a non-empty string');
  if (!Number.isInteger(rejectedBy) || rejectedBy <= 0) {
    throw new ValueError('rejectedBy must be a positive integer');
  }
  if (!reason) {
    throw new ValueError('reason must be a non-empty string');
  }
  const row = db
    .prepare(
      `SELECT id, tenant_id, requested_by, status
         FROM sbos_rbac_approvals WHERE id = ?`,
    )
    .get(approvalId);
  if (!row) {
    throw new ValueError(`approval not found: ${approvalId}`);
  }
  if (row.status !== 'pending') {
    throw new ValueError(`approval ${approvalId} is not pending (status=${row.status})`);
  }
  if (row.requested_by === rejectedBy) {
    throw new ValueError(
      'dual-control violation: rejecter must be a different user than the requester',
    );
  }
  db.prepare(
    `UPDATE sbos_rbac_approvals
        SET status = 'rejected',
            rejected_by = ?,
            rejected_at = datetime('now'),
            rejection_reason = ?
      WHERE id = ? AND status = 'pending'`,
  ).run(rejectedBy, reason, approvalId);
  return { id: approvalId, status: 'rejected', rejectedBy, reason };
}

// ───── expireStale ─────
//
// Flips any pending row whose expires_at < now to 'expired'. Already-
// decided rows (approved/rejected) are left alone. Returns the count
// of rows flipped.
function expireStale(db) {
  const result = db
    .prepare(
      `UPDATE sbos_rbac_approvals
          SET status = 'expired'
        WHERE status = 'pending'
          AND expires_at IS NOT NULL
          AND expires_at < datetime('now')`,
    )
    .run();
  return Number(result.changes || 0);
}

export { requestApproval, listPendingApprovals, approveRequest, rejectRequest, expireStale };
