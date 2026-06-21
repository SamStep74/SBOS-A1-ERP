// CRM (customer relationship management) — Phase 2 wave 1 + wave 2.
//
// Ported from packages/erp/src/crm/*.ts in A1-Suite-Local
// (the user's private R&D monorepo). The pure-function
// layer threads tenant_id into every read and write.
//
// This module ships the minimum-viable CRM:
//   - crm_contacts: people at customer companies
//   - crm_leads: potential customers / sales pipeline
//
// Phase 2 wave 1 (W70-2): schema + pure functions + tests.
// Phase 2 wave 2 (W71-1): route wiring (4 endpoints).
// Future waves: update + archive endpoints, deal/pipeline
// tracking, activity log.

import { validateHvhh as _a1ValidateHvhh } from './hvhh-validator.js';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapter helper (matches the pattern in customer.js / inventory.js)
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  // The production adapter is a pg-style adapter (rows property,
  // $N placeholders). The test adapter uses $N too (the test
  // helper translates $N → ?). The CRM pure functions speak
  // the production shape.
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

function assertString(value, name, { min = 1, max = 255 } = {}) {
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

function assertOptionalEmail(value) {
  if (value === null || value === undefined) return;
  assertOptionalString(value, 'email', { max: 255 });
  // Permissive email regex; the production validator is RFC 5321
  // compliant, but for CRM contact data we accept the common
  // shape (local@domain.tld).
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    throw new ValueError('email must be a valid email address');
  }
}

function assertOptionalPhone(value) {
  if (value === null || value === undefined) return;
  assertOptionalString(value, 'phone', { max: 32 });
  // Phone: digits, spaces, +, -, (, ). At least 4 chars.
  if (!/^[\d\s+\-()]{4,32}$/.test(value)) {
    throw new ValueError('phone must be a valid phone number (digits, spaces, +, -, (, ))');
  }
}

function assertOptionalInt(value, name) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

const LEAD_STATUSES = ['new', 'qualified', 'proposal', 'won', 'lost'];

function assertLeadStatus(value) {
  if (value === null || value === undefined) return;
  if (!LEAD_STATUSES.includes(value)) {
    throw new ValueError(`lead status must be one of: ${LEAD_STATUSES.join(', ')}`);
  }
}

function validateContactInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('contact input is required');
  }
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalEmail(input.email);
  assertOptionalPhone(input.phone);
  assertOptionalString(input.role, 'role', { max: 128 });
  assertOptionalString(input.notes, 'notes', { max: 4096 });
  assertOptionalInt(input.customer_id, 'customer_id');
  // HVVH is optional (most contacts at customer companies don't have
  // their own TIN; only self-employed contacts do). The A1-Validator
  // pass below does the primary validation.
  if (input.hvhh !== undefined && input.hvhh !== null && input.hvhh !== '') {
    if (typeof input.hvhh !== 'string') {
      throw new ValueError('hvhh must be a string of 8 digits or null');
    }
  }
}

/**
 * Async HVVH validation for CRM contacts — uses the A1-Validator HTTP
 * service with local regex fallback. Mirrors the customer + vendor +
 * invoice patterns. Returns the normalized form on success, throws
 * ValueError on invalid input.
 */
export async function assertValidContactHvhhAsync(input) {
  const r = await _a1ValidateHvhh(input);
  if (r.ok) {
    return r.normalized ?? null;
  }
  throw new ValueError(r.error || 'contact hvhh is invalid');
}

function validateLeadInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('lead input is required');
  }
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalString(input.company, 'company', { max: 255 });
  assertOptionalEmail(input.email);
  assertOptionalPhone(input.phone);
  assertOptionalString(input.source, 'source', { max: 128 });
  assertLeadStatus(input.status);
  assertOptionalInt(input.estimated_value_amd, 'estimated_value_amd');
  assertOptionalString(input.notes, 'notes', { max: 4096 });
  // HVVH is optional (most leads don't have a TIN). The A1-Validator
  // pass below does the primary validation.
  if (input.hvhh !== undefined && input.hvhh !== null && input.hvhh !== '') {
    if (typeof input.hvhh !== 'string') {
      throw new ValueError('hvhh must be a string of 8 digits or null');
    }
  }
}

/**
 * Async HVVH validation for CRM leads — uses the A1-Validator HTTP
 * service with local regex fallback. Mirrors the customer + vendor +
 * invoice + contact patterns. Returns the normalized form on success,
 * throws ValueError on invalid input.
 */
export async function assertValidLeadHvhhAsync(input) {
  const r = await _a1ValidateHvhh(input);
  if (r.ok) {
    return r.normalized ?? null;
  }
  throw new ValueError(r.error || 'lead hvhh is invalid');
}

// ────────────────────────────────────────────────────────────────────────
// Contacts
// ────────────────────────────────────────────────────────────────────────

export async function createContact(db, input, tenantId = 0) {
  validateContactInput(input);
  // A1-Validator pass — validates contact.hvhh (optional). Same fail-soft
  // pattern as customer + vendor + invoice. Throws ValueError on invalid
  // input (caught by the route handler as 400).
  await assertValidContactHvhhAsync(input);
  const { hvhh = null } = input;
  const ins = await runQuery(
    db,
    `INSERT INTO finance.crm_contacts
       (tenant_id, customer_id, name, email, phone, role, notes, hvhh)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      input.customer_id ?? null,
      input.name,
      input.email ?? null,
      input.phone ?? null,
      input.role ?? null,
      input.notes ?? null,
      hvhh,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    // Fallback for adapters that don't support RETURNING
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id, name: input.name, email: input.email ?? null, hvhh, tenant_id: tenantId };
}

export async function listContacts(db, tenantId = 0) {
  const result = await runQuery(
    db,
    `SELECT id, customer_id, name, email, phone, role, notes,
            created_at, updated_at
       FROM finance.crm_contacts
      WHERE tenant_id = $1 AND archived = 0
      ORDER BY name`,
    [tenantId],
  );
  return result.rows;
}

// ────────────────────────────────────────────────────────────────────────
// Leads
// ────────────────────────────────────────────────────────────────────────

export async function createLead(db, input, tenantId = 0) {
  validateLeadInput(input);
  // A1-Validator pass — validates lead.hvhh (optional). Same fail-soft
  // pattern as customer + vendor + invoice + contact. Throws ValueError
  // on invalid input (caught by the route handler as 400).
  await assertValidLeadHvhhAsync(input);
  const { hvhh = null } = input;
  const ins = await runQuery(
    db,
    `INSERT INTO finance.crm_leads
       (tenant_id, name, company, email, phone, source,
        status, estimated_value_amd, notes, hvhh)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.company ?? null,
      input.email ?? null,
      input.phone ?? null,
      input.source ?? null,
      input.status ?? 'new',
      input.estimated_value_amd ?? null,
      input.notes ?? null,
      hvhh,
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
  return { id, name: input.name, company: input.company ?? null, hvhh, tenant_id: tenantId };
}

export async function listLeads(db, tenantId = 0, status = null) {
  // Order by id DESC (not created_at) because SQLite's
  // datetime('now') is second-precision; multiple inserts in
  // the same second share the same created_at, but the
  // auto-incrementing id is unique and reflects insertion order.
  let result;
  if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, name, company, email, phone, source,
              status, estimated_value_amd, notes, hvhh,
              created_at, updated_at
         FROM finance.crm_leads
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id DESC`,
      [tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, name, company, email, phone, source,
              status, estimated_value_amd, notes, hvhh,
              created_at, updated_at
         FROM finance.crm_leads
        WHERE tenant_id = $1
        ORDER BY id DESC`,
      [tenantId],
    );
  }
  return result.rows;
}
