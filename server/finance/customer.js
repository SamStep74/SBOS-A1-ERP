// SBOS-A1-ERP finance — customer module.
//
// Pure functions for the customer table. Mirrors the pattern in
// server/finance/invoice.js: take a pg-style db adapter + tenantId,
// scope every query by tenant_id, return rows from the adapter.
//
// Endpoints that will use this:
//   POST   /api/finance/customers        → createCustomer
//   PATCH  /api/finance/customers/:id    → updateCustomer
//   GET    /api/finance/customers        → listCustomers (re-exported from
//                                          routes.js; kept here for symmetry)
//
// No `eval`, no string-concat SQL, no `new Function`. The SQL is fixed.

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// runQuery — matches invoice.js. Tolerates adapters that don't return
// rows on INSERT (sqlite path uses LAST_INSERT_ROWID()).
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
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

function assertOptionalHvhh(value) {
  if (value === null || value === undefined) return;
  // Armenian HVVH (tax ID) is 8 digits. Pad/strip whitespace.
  if (typeof value !== 'string') {
    throw new ValueError('hvhh must be a string of 8 digits or null');
  }
  const trimmed = value.replace(/\s+/g, '');
  if (!/^\d{8}$/.test(trimmed)) {
    throw new ValueError('hvhh must be exactly 8 digits');
  }
}

function validateCreateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('customer input is required');
  }
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalHvhh(input.hvhh);
  assertOptionalString(input.address, 'address', { max: 1024 });
  if (input.email !== undefined) {
    assertOptionalString(input.email, 'email', { max: 255 });
  }
}

function validateUpdateInput(input) {
  if (!input || typeof input !== 'object' || Object.keys(input).length === 0) {
    throw new ValueError('customer update input must include at least one field');
  }
  if (input.name !== undefined) assertString(input.name, 'name', { min: 1, max: 255 });
  if (input.hvhh !== undefined) assertOptionalHvhh(input.hvhh);
  if (input.address !== undefined) assertOptionalString(input.address, 'address', { max: 1024 });
  if (input.email !== undefined) assertOptionalString(input.email, 'email', { max: 255 });
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

export async function createCustomer(db, input, tenantId = 0) {
  validateCreateInput(input);
  const { name, hvhh = null, address = null, email = null } = input;

  // HVVH uniqueness within the tenant (so two tenants can both have a
  // customer named "Acme" with hvhh "00000001" without collision).
  if (hvhh) {
    const dupe = await runQuery(
      db,
      'SELECT id FROM finance.customers WHERE tenant_id = $1 AND hvhh = $2',
      [tenantId, hvhh],
    );
    if (dupe.rows && dupe.rows.length > 0) {
      throw new ValueError(`customer with hvhh "${hvhh}" already exists in tenant ${tenantId}`);
    }
  }

  const now = new Date().toISOString();
  const ins = await runQuery(
    db,
    `INSERT INTO finance.customers
       (name, hvhh, address, email, tenant_id, created_at, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [name, hvhh, address, email, tenantId, now, now],
  );

  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }

  return { id, name, hvhh, address, email, tenant_id: tenantId };
}

export async function updateCustomer(db, id, patch, tenantId = 0) {
  validateUpdateInput(patch);
  if (!Number.isInteger(id) || id <= 0) {
    throw new ValueError('customer id must be a positive integer');
  }

  // Build the SET clause from the patch fields. Fixed column whitelist
  // (no user-controlled SQL fragment).
  const allowed = new Set(['name', 'hvhh', 'address', 'email']);
  const sets = [];
  const params = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) {
      throw new ValueError(`update field "${k}" is not allowed`);
    }
    sets.push(`${k} = $${i++}`);
    params.push(v === undefined ? null : v);
  }
  sets.push(`updated_at = $${i++}`);
  params.push(new Date().toISOString());
  // WHERE: scope by both tenant and id so a cross-tenant id never matches.
  params.push(id);
  params.push(tenantId);

  const result = await runQuery(
    db,
    `UPDATE finance.customers
       SET ${sets.join(', ')}
     WHERE id = $${i++} AND tenant_id = $${i}
     RETURNING id, name, hvhh, address, email, tenant_id`,
    params,
  );

  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`customer ${id} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

export async function listCustomers(db, tenantId = 0) {
  const result = await runQuery(
    db,
    `SELECT id, name, hvhh, address, email, tenant_id
       FROM finance.customers
      WHERE tenant_id = $1
      ORDER BY id ASC`,
    [tenantId],
  );
  return (result.rows || []).map((r) => ({
    id: Number(r.id),
    name: r.name,
    hvhh: r.hvhh,
    address: r.address,
    email: r.email,
    tenant_id: Number(r.tenant_id),
  }));
}

export async function getCustomer(db, id, tenantId = 0) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const result = await runQuery(
    db,
    `SELECT id, name, hvhh, address, email, tenant_id
       FROM finance.customers
      WHERE id = $1 AND tenant_id = $2`,
    [id, tenantId],
  );
  if (!result.rows || result.rows.length === 0) return null;
  const r = result.rows[0];
  return {
    id: Number(r.id),
    name: r.name,
    hvhh: r.hvhh,
    address: r.address,
    email: r.email,
    tenant_id: Number(r.tenant_id),
  };
}
