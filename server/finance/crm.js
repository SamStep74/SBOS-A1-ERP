// CRM (customer relationship management) — Phase 2 wave 1.
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
// Phase 2 wave 2 (future): route wiring + permission keys
// + smoke check + audit log integration.

export class ValueError extends Error {}

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
}

// ────────────────────────────────────────────────────────────────────────
// Contacts
// ────────────────────────────────────────────────────────────────────────

export async function createContact(db, input, tenantId = 0) {
  validateContactInput(input);
  const result = await db.run(
    `INSERT INTO finance.crm_contacts
        (tenant_id, customer_id, name, email, phone, role, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      tenantId,
      input.customer_id ?? null,
      input.name,
      input.email ?? null,
      input.phone ?? null,
      input.role ?? null,
      input.notes ?? null,
    ],
  );
  return { id: Number(result.lastInsertRowid ?? result.lastID) };
}

export async function listContacts(db, tenantId = 0) {
  const rows = await db.all(
    `SELECT id, customer_id, name, email, phone, role, notes,
            created_at, updated_at
       FROM finance.crm_contacts
      WHERE tenant_id = ? AND archived = 0
      ORDER BY name`,
    [tenantId],
  );
  return rows;
}

// ────────────────────────────────────────────────────────────────────────
// Leads
// ────────────────────────────────────────────────────────────────────────

export async function createLead(db, input, tenantId = 0) {
  validateLeadInput(input);
  const result = await db.run(
    `INSERT INTO finance.crm_leads
        (tenant_id, name, company, email, phone, source,
         status, estimated_value_amd, notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
  return { id: Number(result.lastInsertRowid ?? result.lastID) };
}

export async function listLeads(db, tenantId = 0, status = null) {
  // Order by id DESC (not created_at) because SQLite's
  // datetime('now') is second-precision; multiple inserts in
  // the same second share the same created_at, but the
  // auto-incrementing id is unique and reflects insertion order.
  let sql, params;
  if (status !== null) {
    sql = `SELECT id, name, company, email, phone, source,
                  status, estimated_value_amd, notes,
                  created_at, updated_at
             FROM finance.crm_leads
            WHERE tenant_id = ? AND status = ?
            ORDER BY id DESC`;
    params = [tenantId, status];
  } else {
    sql = `SELECT id, name, company, email, phone, source,
                  status, estimated_value_amd, notes,
                  created_at, updated_at
             FROM finance.crm_leads
            WHERE tenant_id = ?
            ORDER BY id DESC`;
    params = [tenantId];
  }
  return db.all(sql, params);
}
