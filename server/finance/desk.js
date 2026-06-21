// Desk (ticketing / support) — Phase 2 wave 1.
//
// Ported from packages/erp/src/desk/*.ts in A1-Suite-Local
// (the user's private R&D monorepo). The pure-function
// layer threads tenant_id into every read and write.
//
// This module ships the minimum-viable desk:
//   - desk_cases: support tickets (status: open /
//     pending / resolved / closed; priority: low /
//     normal / high / urgent)
//   - desk_replies: replies on a case (append-only log
//     of customer + agent replies)
//
// Phase 2 desk wave 1 (W72-1): schema + pure functions +
// tests. Wave 2 (future): route wiring + permission
// keys + smoke check.

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapter helper (matches the pattern in customer.js /
// inventory.js / crm.js)
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  // The production adapter is a pg-style adapter (rows property,
  // $N placeholders). The test adapter uses $N too (the test
  // helper translates $N → ?). The desk pure functions speak
  // the production shape.
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

const CASE_STATUSES = ['open', 'pending', 'resolved', 'closed'];
const CASE_PRIORITIES = ['low', 'normal', 'high', 'urgent'];
const REPLY_AUTHORS = ['customer', 'agent'];

function assertString(value, name, { min = 1, max = 8192 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ValueError(`${name} must be a string of ${min}-${max} characters`);
  }
}

function assertOptionalString(value, name, { max = 255 } = {}) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || value.length > max) {
    throw new ValueError(`${name} must be a string up to ${max} characters or null`);
  }
}

function assertOptionalInt(value, name) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

function assertCaseStatus(value) {
  if (value === null || value === undefined) return;
  if (!CASE_STATUSES.includes(value)) {
    throw new ValueError(`case status must be one of: ${CASE_STATUSES.join(', ')}`);
  }
}

function assertCasePriority(value) {
  if (value === null || value === undefined) return;
  if (!CASE_PRIORITIES.includes(value)) {
    throw new ValueError(`case priority must be one of: ${CASE_PRIORITIES.join(', ')}`);
  }
}

function assertReplyAuthor(value) {
  if (value === null || value === undefined) return;
  if (!REPLY_AUTHORS.includes(value)) {
    throw new ValueError(`reply author must be one of: ${REPLY_AUTHORS.join(', ')}`);
  }
}

function validateCreateCaseInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('case input is required');
  }
  assertString(input.subject, 'subject', { min: 1, max: 255 });
  assertString(input.body, 'body', { min: 1, max: 8192 });
  assertOptionalInt(input.customer_id, 'customer_id');
  assertOptionalInt(input.contact_id, 'contact_id');
  assertCaseStatus(input.status);
  assertCasePriority(input.priority);
  assertOptionalInt(input.assignee_id, 'assignee_id');
  assertOptionalString(input.tracking_number, 'tracking_number', { max: 64 });
}

function validateCreateReplyInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('reply input is required');
  }
  assertString(input.body, 'body', { min: 1, max: 8192 });
  assertReplyAuthor(input.author);
  assertOptionalInt(input.author_id, 'author_id');
}

// ────────────────────────────────────────────────────────────────────────
// Cases
// ────────────────────────────────────────────────────────────────────────

export async function createCase(db, input, tenantId = 0) {
  validateCreateCaseInput(input);
  const ins = await runQuery(
    db,
    `INSERT INTO finance.desk_cases
       (tenant_id, customer_id, contact_id, subject, body,
        status, priority, assignee_id, tracking_number)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      tenantId,
      input.customer_id ?? null,
      input.contact_id ?? null,
      input.subject,
      input.body,
      input.status ?? 'open',
      input.priority ?? 'normal',
      input.assignee_id ?? null,
      input.tracking_number ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listCases(db, tenantId = 0, status = null) {
  // Order by id DESC (most recent first; see CRM listLeads for
  // the rationale on id vs created_at).
  let result;
  if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, customer_id, contact_id, subject, status,
              priority, assignee_id, tracking_number,
              created_at, updated_at
         FROM finance.desk_cases
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id DESC`,
      [tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, customer_id, contact_id, subject, status,
              priority, assignee_id, tracking_number,
              created_at, updated_at
         FROM finance.desk_cases
        WHERE tenant_id = $1
        ORDER BY id DESC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getCase(db, caseId, tenantId = 0) {
  const result = await runQuery(
    db,
    `SELECT id, customer_id, contact_id, subject, body, status,
            priority, assignee_id, tracking_number,
            created_at, updated_at
       FROM finance.desk_cases
      WHERE id = $1 AND tenant_id = $2`,
    [caseId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`case ${caseId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

// ────────────────────────────────────────────────────────────────────────
// Replies
// ────────────────────────────────────────────────────────────────────────

export async function createReply(db, caseId, input, tenantId = 0) {
  if (!Number.isInteger(caseId) || caseId <= 0) {
    throw new ValueError('caseId must be a positive integer');
  }
  validateCreateReplyInput(input);
  // Verify the case exists in the
  // tenant (so the FK reference is
  // valid; we don't have a real FK
  // because the desk_replies table
  // is in a separate migration).
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.desk_cases
      WHERE id = $1 AND tenant_id = $2`,
    [caseId, tenantId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(`case ${caseId} not found in tenant ${tenantId}`);
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.desk_replies
       (tenant_id, case_id, body, author, author_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [
      tenantId,
      caseId,
      input.body,
      input.author,
      input.author_id ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listReplies(db, caseId, tenantId = 0) {
  const result = await runQuery(
    db,
    `SELECT id, case_id, body, author, author_id, created_at
       FROM finance.desk_replies
      WHERE case_id = $1 AND tenant_id = $2
      ORDER BY id ASC`,
    [caseId, tenantId],
  );
  return result.rows;
}
