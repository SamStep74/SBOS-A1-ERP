// server/finance/lots.js
//
// Phase 2 ERP — lot + serial tracking for inventory.
//
// Wave 37. Scope (this file):
//   - Lot CRUD: createLot, getLot, listLotsForItem
//   - Serial CRUD: createSerial, getSerial, listSerialsForItem
//
// Out of scope (Wave 38):
//   - Stock-move integration: receiveStock(deliverStock, transfer)
//     that accepts lot_id + serial_ids
//   - FEFO (first-expiry-first-out) picking logic on deliver
//   - Recall support (find all serials in a lot → flag them)
//
// All SQL stays in here — no string-concat, no eval, every query
// uses parameterized placeholders. The pure functions work against
// the production pg adapter (or sqlite through the test harness).

import { runQuery } from './_pgStyle.js';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Lots
// ────────────────────────────────────────────────────────────────────────

/**
 * Create a lot received from a supplier. The lot is the unit of
 * traceability for batch-tracked goods (food expiry, pharma batch
 * certification, etc.).
 *
 * Required input:
 *   - code           string, 1-64 chars, unique per tenant
 *   - catalog_item_id positive integer; the lot is for this item
 *   - received_at    YYYY-MM-DD or full ISO timestamp
 *
 * Optional input:
 *   - supplier_lot_number  upstream label (the supplier's own batch ID)
 *   - expiry_date   YYYY-MM-DD; NULL for non-perishable items
 *   - notes         free-form text
 *
 * Returns the new lot row (id + denormalized fields).
 */
export async function createLot(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  if (typeof input.code !== 'string' || input.code.length === 0 || input.code.length > 64) {
    throw new ValueError('code must be a string of 1-64 characters');
  }
  if (!Number.isInteger(input.catalog_item_id) || input.catalog_item_id <= 0) {
    throw new ValueError('catalog_item_id must be a positive integer');
  }
  if (typeof input.received_at !== 'string' || input.received_at.length === 0) {
    throw new ValueError('received_at must be a non-empty string (YYYY-MM-DD or full ISO)');
  }
  if (input.expiry_date != null && (typeof input.expiry_date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input.expiry_date))) {
    throw new ValueError('expiry_date must be in YYYY-MM-DD format');
  }
  if (input.supplier_lot_number != null && typeof input.supplier_lot_number !== 'string') {
    throw new ValueError('supplier_lot_number must be a string or undefined');
  }
  if (input.notes != null && typeof input.notes !== 'string') {
    throw new ValueError('notes must be a string or undefined');
  }
  // Verify the catalog item exists in this tenant. (Failing the
  // request here is better than letting an orphan lot into the table.)
  const itemCheck = await runQuery(
    db,
    `SELECT id FROM finance.catalog_items WHERE tenant_id = $1 AND id = $2`,
    [tenantId, input.catalog_item_id],
  );
  if (!itemCheck.rows || itemCheck.rows.length === 0) {
    throw new ValueError(`catalog item ${input.catalog_item_id} not found in tenant ${tenantId}`);
  }
  const insertResult = await runQuery(
    db,
    `INSERT INTO finance.lots
       (tenant_id, code, supplier_lot_number, catalog_item_id, expiry_date, received_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, tenant_id, code, supplier_lot_number, catalog_item_id,
               expiry_date, received_at, notes, created_at, updated_at`,
    [
      tenantId,
      input.code,
      input.supplier_lot_number || null,
      input.catalog_item_id,
      input.expiry_date || null,
      input.received_at,
      input.notes || null,
    ],
  );
  if (!insertResult.rows || insertResult.rows.length === 0) {
    throw new ValueError('failed to insert lot (no row returned)');
  }
  return normalizeLot(insertResult.rows[0]);
}

/**
 * Fetch a single lot by id. Returns null if missing or cross-tenant.
 * Caller can map null → 404.
 */
export async function getLot(db, id, tenantId = 0) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, code, supplier_lot_number, catalog_item_id,
            expiry_date, received_at, notes, created_at, updated_at
       FROM finance.lots
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!result.rows || result.rows.length === 0) return null;
  return normalizeLot(result.rows[0]);
}

/**
 * List lots for a specific catalog item, sorted by expiry_date
 * ASC NULLS LAST (FEFO — first-expiry-first-out picks lots with
 * the earliest expiry first; NULL expiry means "non-perishable,
 * pick last"). Within the same expiry, sorted by id ASC for
 * stable ordering.
 */
export async function listLotsForItem(db, catalogItemId, tenantId = 0) {
  if (!Number.isInteger(catalogItemId) || catalogItemId <= 0) {
    throw new ValueError('catalogItemId must be a positive integer');
  }
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, code, supplier_lot_number, catalog_item_id,
            expiry_date, received_at, notes, created_at, updated_at
       FROM finance.lots
      WHERE tenant_id = $1 AND catalog_item_id = $2
      ORDER BY
        CASE WHEN expiry_date IS NULL THEN 1 ELSE 0 END,
        expiry_date ASC,
        id ASC`,
    [tenantId, catalogItemId],
  );
  return (result.rows || []).map(normalizeLot);
}

// ────────────────────────────────────────────────────────────────────────
// Serials
// ────────────────────────────────────────────────────────────────────────

const VALID_SERIAL_STATUSES = new Set(['in_stock', 'sold', 'returned', 'lost', 'scrap']);

/**
 * Create a serial-numbered unit. Each unit has its own row in the
 * serials table with a unique serial_number (per tenant). A serial
 * may optionally link to a lot (for batch traceability).
 *
 * Required input:
 *   - serial_number   string, 1-64 chars, unique per tenant
 *   - catalog_item_id positive integer
 *   - received_at     YYYY-MM-DD or full ISO timestamp
 *
 * Optional input:
 *   - lot_id           positive integer (nullable; some serials have no lot)
 *   - status           defaults to 'in_stock'
 *   - current_location_id  positive integer (nullable; NULL = not in stock)
 *   - notes            free-form text
 *
 * Returns the new serial row.
 */
export async function createSerial(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  if (typeof input.serial_number !== 'string' || input.serial_number.length === 0 || input.serial_number.length > 64) {
    throw new ValueError('serial_number must be a string of 1-64 characters');
  }
  if (!Number.isInteger(input.catalog_item_id) || input.catalog_item_id <= 0) {
    throw new ValueError('catalog_item_id must be a positive integer');
  }
  if (typeof input.received_at !== 'string' || input.received_at.length === 0) {
    throw new ValueError('received_at must be a non-empty string (YYYY-MM-DD or full ISO)');
  }
  if (input.lot_id != null && (!Number.isInteger(input.lot_id) || input.lot_id <= 0)) {
    throw new ValueError('lot_id must be a positive integer or undefined');
  }
  if (input.status != null && !VALID_SERIAL_STATUSES.has(input.status)) {
    throw new ValueError(`status must be one of ${[...VALID_SERIAL_STATUSES].join(', ')}`);
  }
  if (input.current_location_id != null && (!Number.isInteger(input.current_location_id) || input.current_location_id <= 0)) {
    throw new ValueError('current_location_id must be a positive integer or undefined');
  }
  if (input.notes != null && typeof input.notes !== 'string') {
    throw new ValueError('notes must be a string or undefined');
  }
  // Verify the catalog item exists in this tenant.
  const itemCheck = await runQuery(
    db,
    `SELECT id FROM finance.catalog_items WHERE tenant_id = $1 AND id = $2`,
    [tenantId, input.catalog_item_id],
  );
  if (!itemCheck.rows || itemCheck.rows.length === 0) {
    throw new ValueError(`catalog item ${input.catalog_item_id} not found in tenant ${tenantId}`);
  }
  // If a lot_id is provided, verify the lot exists in this tenant
  // AND is for the same catalog_item (mismatch would be a data error).
  if (input.lot_id != null) {
    const lotCheck = await runQuery(
      db,
      `SELECT catalog_item_id FROM finance.lots WHERE tenant_id = $1 AND id = $2`,
      [tenantId, input.lot_id],
    );
    if (!lotCheck.rows || lotCheck.rows.length === 0) {
      throw new ValueError(`lot ${input.lot_id} not found in tenant ${tenantId}`);
    }
    if (Number(lotCheck.rows[0].catalog_item_id) !== input.catalog_item_id) {
      throw new ValueError(`lot ${input.lot_id} is for catalog item ${lotCheck.rows[0].catalog_item_id}, not ${input.catalog_item_id}`);
    }
  }
  const insertResult = await runQuery(
    db,
    `INSERT INTO finance.serials
       (tenant_id, serial_number, catalog_item_id, lot_id, status,
        current_location_id, received_at, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, tenant_id, serial_number, catalog_item_id, lot_id, status,
               current_location_id, received_at, sold_at, notes,
               created_at, updated_at`,
    [
      tenantId,
      input.serial_number,
      input.catalog_item_id,
      input.lot_id || null,
      input.status || 'in_stock',
      input.current_location_id || null,
      input.received_at,
      input.notes || null,
    ],
  );
  if (!insertResult.rows || insertResult.rows.length === 0) {
    throw new ValueError('failed to insert serial (no row returned)');
  }
  return normalizeSerial(insertResult.rows[0]);
}

/**
 * Fetch a single serial by id. Returns null if missing or cross-tenant.
 */
export async function getSerial(db, id, tenantId = 0) {
  if (!Number.isInteger(id) || id <= 0) return null;
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, serial_number, catalog_item_id, lot_id, status,
            current_location_id, received_at, sold_at, notes,
            created_at, updated_at
       FROM finance.serials
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, id],
  );
  if (!result.rows || result.rows.length === 0) return null;
  return normalizeSerial(result.rows[0]);
}

/**
 * List serials for a specific catalog item, sorted by id ASC.
 * Optional filters: lot_id (only serials in that lot), status
 * (only serials in that status, e.g. 'in_stock').
 */
export async function listSerialsForItem(db, catalogItemId, tenantId = 0, opts = {}) {
  if (!Number.isInteger(catalogItemId) || catalogItemId <= 0) {
    throw new ValueError('catalogItemId must be a positive integer');
  }
  const where = ['tenant_id = $1', 'catalog_item_id = $2'];
  const params = [tenantId, catalogItemId];
  let i = 3;
  if (opts.lot_id != null) {
    if (!Number.isInteger(opts.lot_id) || opts.lot_id <= 0) {
      throw new ValueError('opts.lot_id must be a positive integer or undefined');
    }
    where.push(`lot_id = $${i++}`);
    params.push(opts.lot_id);
  }
  if (opts.status != null) {
    if (!VALID_SERIAL_STATUSES.has(opts.status)) {
      throw new ValueError(`opts.status must be one of ${[...VALID_SERIAL_STATUSES].join(', ')}`);
    }
    where.push(`status = $${i++}`);
    params.push(opts.status);
  }
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, serial_number, catalog_item_id, lot_id, status,
            current_location_id, received_at, sold_at, notes,
            created_at, updated_at
       FROM finance.serials
      WHERE ${where.join(' AND ')}
      ORDER BY id ASC`,
    params,
  );
  return (result.rows || []).map(normalizeSerial);
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function normalizeLot(r) {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    code: r.code,
    supplier_lot_number: r.supplier_lot_number || null,
    catalog_item_id: Number(r.catalog_item_id),
    expiry_date: r.expiry_date || null,
    received_at: r.received_at,
    notes: r.notes || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

function normalizeSerial(r) {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    serial_number: r.serial_number,
    catalog_item_id: Number(r.catalog_item_id),
    lot_id: r.lot_id == null ? null : Number(r.lot_id),
    status: r.status,
    current_location_id: r.current_location_id == null ? null : Number(r.current_location_id),
    received_at: r.received_at,
    sold_at: r.sold_at || null,
    notes: r.notes || null,
    created_at: r.created_at,
    updated_at: r.updated_at,
  };
}

// Re-export for tests + callers that want the valid statuses set.
export const __internals = Object.freeze({
  VALID_SERIAL_STATUSES,
  normalizeLot,
  normalizeSerial,
});