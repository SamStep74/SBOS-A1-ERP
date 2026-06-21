// server/finance/lots.js
//
// Phase 2 ERP — lot + serial tracking for inventory.
//
// Wave 37. Scope:
//   - Lot CRUD: createLot, getLot, listLotsForItem
//   - Serial CRUD: createSerial, getSerial, listSerialsForItem
//
// Wave 39. Scope (this wave):
//   - listLotsForLocation — join lots + stock_lots to get per-location
//     quantities (and FEFO expiry ordering)
//   - listSerialsForLocation — list serials currently at a location,
//     optionally filtered by status
//   - receiveIntoLot — increment stock_lots.quantity at a (lot, location)
//     (called by receiveStock when lot_id is given)
//   - consumeFromLotsFEFO — first-expiry-first-out picking, used by
//     deliverStock when the item has stock_lots rows
//   - assignSerialLocation — set current_location_id + status on a
//     serial (used by receiveStock + deliverStock when serial_ids is
//     given)
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
            expiry_date, received_at, notes,
            recalled_at, recall_reason, recalled_by,
            created_at, updated_at
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

const VALID_SERIAL_STATUSES = new Set(['in_stock', 'sold', 'returned', 'lost', 'scrap', 'recalled']);

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
    where.push(`status = $${i}`);
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
// Stock-move integration helpers (Wave 39)
// ────────────────────────────────────────────────────────────────────────

/**
 * List lots that have quantity at a given location, joined with
 * stock_lots to get the per-location quantity. Returns a list of
 * objects: { id, code, supplier_lot_number, catalog_item_id,
 * expiry_date, quantity }.
 *
 * Ordered FEFO (expiry ASC NULLS LAST, then id ASC) so the picker
 * can iterate the result directly without re-sorting.
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} locationId
 * @param {object} [opts]
 * @param {boolean} [opts.include_zero=false]  include rows with quantity=0
 *                                              (default: hide them)
 */
export async function listLotsForLocation(db, tenantId, locationId, opts = {}) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new ValueError('locationId must be a positive integer');
  }
  const includeZero = opts.include_zero === true;
  const rows = await runQuery(
    db,
    `SELECT l.id, l.tenant_id, l.code, l.supplier_lot_number,
            l.catalog_item_id, l.expiry_date, l.received_at,
            sl.quantity
       FROM finance.lots l
       JOIN finance.stock_lots sl
         ON sl.tenant_id = l.tenant_id AND sl.lot_id = l.id
      WHERE l.tenant_id = $1 AND sl.location_id = $2
        ${includeZero ? '' : 'AND sl.quantity > 0'}
      ORDER BY CASE WHEN l.expiry_date IS NULL THEN 1 ELSE 0 END,
               l.expiry_date ASC,
               l.id ASC`,
    [tenantId, locationId],
  );
  return (rows.rows || []).map((r) => ({
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    code: r.code,
    supplier_lot_number: r.supplier_lot_number || null,
    catalog_item_id: Number(r.catalog_item_id),
    expiry_date: r.expiry_date || null,
    received_at: r.received_at,
    quantity: Number(r.quantity),
  }));
}

/**
 * List serials currently at a given location. A serial is "at" a
 * location when serials.current_location_id = location_id AND
 * serials.status = 'in_stock' (sold/returned/lost/scrap serials
 * are filtered out by default).
 *
 * Ordered by id ASC so the picker can iterate deterministically.
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} locationId
 * @param {object} [opts]
 * @param {string} [opts.status]  override the default 'in_stock' filter
 *                                (e.g. 'returned' to list serials that
 *                                came back)
 */
export async function listSerialsForLocation(db, tenantId, locationId, opts = {}) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new ValueError('locationId must be a positive integer');
  }
  const status = opts.status != null ? String(opts.status) : 'in_stock';
  if (!VALID_SERIAL_STATUSES.has(status)) {
    throw new ValueError(`status must be one of: ${[...VALID_SERIAL_STATUSES].join(', ')}`);
  }
  const rows = await runQuery(
    db,
    `SELECT id, tenant_id, serial_number, catalog_item_id, lot_id, status,
            current_location_id, received_at, sold_at, notes,
            created_at, updated_at
       FROM finance.serials
      WHERE tenant_id = $1
        AND current_location_id = $2
        AND status = $3
      ORDER BY id ASC`,
    [tenantId, locationId, status],
  );
  return (rows.rows || []).map(normalizeSerial);
}

/**
 * Receive quantity into a lot at a location. Upserts the stock_lots
 * row: if (lot, location) doesn't exist, inserts; otherwise
 * increments quantity. Returns the new quantity.
 *
 * Validates that the lot exists + belongs to the tenant +
 * matches the catalog_item_id.
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} lotId
 * @param {number} locationId
 * @param {number} catalogItemId
 * @param {number} quantity       positive integer
 * @returns {Promise<{lot_id: number, location_id: number, quantity: number}>}
 */
export async function receiveIntoLot(db, tenantId, lotId, locationId, catalogItemId, quantity) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(lotId) || lotId <= 0) {
    throw new ValueError('lotId must be a positive integer');
  }
  if (!Number.isInteger(locationId) || locationId <= 0) {
    throw new ValueError('locationId must be a positive integer');
  }
  if (!Number.isInteger(catalogItemId) || catalogItemId <= 0) {
    throw new ValueError('catalogItemId must be a positive integer');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new ValueError('quantity must be a positive integer');
  }
  // Validate the lot exists + belongs to tenant + matches catalog_item.
  const lot = await runQuery(
    db,
    'SELECT id, catalog_item_id FROM finance.lots WHERE tenant_id = $1 AND id = $2',
    [tenantId, lotId],
  );
  if (!lot.rows || lot.rows.length === 0) {
    throw new ValueError(`lot ${lotId} not found in tenant ${tenantId}`);
  }
  if (Number(lot.rows[0].catalog_item_id) !== catalogItemId) {
    throw new ValueError(
      `lot ${lotId} is for catalog_item ${lot.rows[0].catalog_item_id}, not ${catalogItemId}`,
    );
  }
  // Upsert stock_lots. If the row exists, increment; else insert.
  const existing = await runQuery(
    db,
    `SELECT id, quantity FROM finance.stock_lots
      WHERE tenant_id = $1 AND lot_id = $2 AND location_id = $3`,
    [tenantId, lotId, locationId],
  );
  let newQty;
  if (existing.rows && existing.rows.length > 0) {
    newQty = Number(existing.rows[0].quantity) + quantity;
    await runQuery(
      db,
      `UPDATE finance.stock_lots
          SET quantity = $1, updated_at = datetime('now')
        WHERE tenant_id = $2 AND lot_id = $3 AND location_id = $4`,
      [newQty, tenantId, lotId, locationId],
    );
  } else {
    newQty = quantity;
    await runQuery(
      db,
      `INSERT INTO finance.stock_lots
         (tenant_id, lot_id, location_id, catalog_item_id, quantity)
       VALUES ($1, $2, $3, $4, $5)`,
      [tenantId, lotId, locationId, catalogItemId, quantity],
    );
  }
  return { lot_id: lotId, location_id: locationId, quantity: newQty };
}

/**
 * Consume quantity from an item's lots at a source location, using
 * FEFO (first-expiry-first-out) order. Returns an array of
 * {lot_id, quantity_consumed} showing where the quantity came from.
 *
 * Stops once the requested quantity is satisfied (greedy). Throws
 * ValueError if the sum of stock_lots.quantity for the (item,
 * location) is less than the requested quantity.
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} itemId
 * @param {number} sourceLocationId
 * @param {number} quantity       positive integer
 * @returns {Promise<Array<{lot_id: number, quantity_consumed: number}>>}
 */
export async function consumeFromLotsFEFO(db, tenantId, itemId, sourceLocationId, quantity) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(itemId) || itemId <= 0) {
    throw new ValueError('itemId must be a positive integer');
  }
  if (!Number.isInteger(sourceLocationId) || sourceLocationId <= 0) {
    throw new ValueError('sourceLocationId must be a positive integer');
  }
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new ValueError('quantity must be a positive integer');
  }
  // Fetch stock_lots for (item, location) JOIN lots, ordered FEFO.
  const lots = await runQuery(
    db,
    `SELECT sl.lot_id, sl.quantity, l.expiry_date
       FROM finance.stock_lots sl
       JOIN finance.lots l
         ON l.tenant_id = sl.tenant_id AND l.id = sl.lot_id
      WHERE sl.tenant_id = $1 AND sl.catalog_item_id = $2 AND sl.location_id = $3
        AND sl.quantity > 0
      ORDER BY CASE WHEN l.expiry_date IS NULL THEN 1 ELSE 0 END,
               l.expiry_date ASC,
               l.id ASC`,
    [tenantId, itemId, sourceLocationId],
  );
  const available = (lots.rows || []).reduce((acc, r) => acc + Number(r.quantity), 0);
  if (available < quantity) {
    throw new ValueError(
      `insufficient lot-tracked stock at source: have ${available} across ${(lots.rows || []).length} lots, requested ${quantity}`,
    );
  }
  // Greedy consumption: take from the earliest-expiry lot first.
  const consumption = [];
  let remaining = quantity;
  for (const row of lots.rows || []) {
    if (remaining <= 0) break;
    const lotId = Number(row.lot_id);
    const lotQty = Number(row.quantity);
    const take = Math.min(remaining, lotQty);
    const newQty = lotQty - take;
    // Always UPDATE, never DELETE. Preserves the audit trail at the
    // row level (listLotsForLocation with include_zero=true can show
    // depleted lots that were once at this location). If the lot
    // ever gets re-received, receiveIntoLot will increment this row.
    await runQuery(
      db,
      `UPDATE finance.stock_lots
          SET quantity = $1, updated_at = datetime('now')
        WHERE tenant_id = $2 AND lot_id = $3 AND location_id = $4`,
      [newQty, tenantId, lotId, sourceLocationId],
    );
    consumption.push({ lot_id: lotId, quantity_consumed: take });
    remaining -= take;
  }
  return consumption;
}

/**
 * Assign a serial to a location + status. Used by receiveStock
 * (status='in_stock') and deliverStock (status='sold' for external,
 * or 'in_stock' at a different location for transfer).
 *
 * If `lotId` is provided, also sets serials.lot_id (must match the
 * serial's catalog_item_id — that's already guaranteed by the
 * lot itself). If `lotId` is null, leaves serials.lot_id alone
 * (callers that want to clear it should pass a sentinel — not
 * needed for Wave 39).
 *
 * Returns the normalized serial row.
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} serialId
 * @param {number|null} locationId  null if the serial is leaving stock
 * @param {string} status          must be in VALID_SERIAL_STATUSES
 * @param {number|null} [lotId]    optional: pin the serial to a lot
 */
export async function assignSerialLocation(db, tenantId, serialId, locationId, status, lotId = null) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(serialId) || serialId <= 0) {
    throw new ValueError('serialId must be a positive integer');
  }
  if (locationId != null && (!Number.isInteger(locationId) || locationId <= 0)) {
    throw new ValueError('locationId must be a positive integer or null');
  }
  if (typeof status !== 'string' || !VALID_SERIAL_STATUSES.has(status)) {
    throw new ValueError(`status must be one of: ${[...VALID_SERIAL_STATUSES].join(', ')}`);
  }
  if (lotId != null && (!Number.isInteger(lotId) || lotId <= 0)) {
    throw new ValueError('lotId must be a positive integer or null');
  }
  // Validate the serial exists + belongs to tenant.
  const existing = await runQuery(
    db,
    'SELECT id, catalog_item_id, status FROM finance.serials WHERE tenant_id = $1 AND id = $2',
    [tenantId, serialId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(`serial ${serialId} not found in tenant ${tenantId}`);
  }
  // If lotId is provided, validate the lot is for the same catalog_item.
  if (lotId != null) {
    const lot = await runQuery(
      db,
      'SELECT catalog_item_id FROM finance.lots WHERE tenant_id = $1 AND id = $2',
      [tenantId, lotId],
    );
    if (!lot.rows || lot.rows.length === 0) {
      throw new ValueError(`lot ${lotId} not found in tenant ${tenantId}`);
    }
    if (Number(lot.rows[0].catalog_item_id) !== Number(existing.rows[0].catalog_item_id)) {
      throw new ValueError(
        `lot ${lotId} is for catalog_item ${lot.rows[0].catalog_item_id}, not ${existing.rows[0].catalog_item_id}`,
      );
    }
  }
  const soldAt = status === 'sold' ? new Date().toISOString() : null;
  // Always pass the same 6 placeholders so the SQL is stable.
  // Use COALESCE for lot_id + sold_at so passing null preserves the
  // existing value (callers that don't want to touch lot_id pass
  // null and the column stays put).
  await runQuery(
    db,
    `UPDATE finance.serials
        SET current_location_id = $1,
            status = $2,
            lot_id = COALESCE($3, lot_id),
            sold_at = COALESCE($4, sold_at),
            updated_at = datetime('now')
      WHERE tenant_id = $5 AND id = $6`,
    [locationId, status, lotId, soldAt, tenantId, serialId],
  );
  // Return the updated row.
  return getSerial(db, serialId, tenantId);
}

// ────────────────────────────────────────────────────────────────────────
// Product recall (Wave 41)
// ────────────────────────────────────────────────────────────────────────

/**
 * Recall a lot and cascade the recall to every serial in that lot.
 *
 * This is the regulatory-compliance action for batch-tracked goods
 * (food, pharma, electronics with a defect): when the supplier or
 * the manufacturer flags a lot as unsafe, the operator recalls it.
 * Every unit-serial that was ever bound to that lot gets its
 * status flipped to 'recalled' (so it's no longer sellable) and its
 * current_location_id is cleared (so the picker can't accidentally
 * ship it out).
 *
 * The lot itself gets audit-trail columns stamped:
 *   - recalled_at   (datetime('now'))
 *   - recall_reason (the operator's note, 1-512 chars)
 *   - recalled_by   (the user_id who triggered the recall)
 *
 * Idempotent: recalling an already-recalled lot returns the
 * existing recall info without cascading again (the serials are
 * already status='recalled'). The caller can pass {force: true}
 * to re-cascade (e.g. if some serials were marked 'returned'
 * in the interim and need to be re-flagged).
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} lotId
 * @param {object} opts
 * @param {string} opts.reason       required, 1-512 chars
 * @param {number} opts.user_id      optional, recorded as recalled_by
 * @param {boolean} [opts.force]     re-cascade even if already recalled
 * @returns {Promise<{lot: object, recalled_serials: number, already_recalled: boolean}>}
 */
export async function recallLot(db, tenantId, lotId, opts = {}) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(lotId) || lotId <= 0) {
    throw new ValueError('lotId must be a positive integer');
  }
  const reason = opts.reason == null ? null : String(opts.reason).trim();
  if (!reason || reason.length === 0) {
    throw new ValueError('opts.reason is required (1-512 chars)');
  }
  if (reason.length > 512) {
    throw new ValueError('opts.reason must be 1-512 chars');
  }
  const userId = opts.user_id == null ? null : Number(opts.user_id);
  if (userId != null && (!Number.isInteger(userId) || userId < 0)) {
    throw new ValueError('opts.user_id must be a non-negative integer or null');
  }
  const force = opts.force === true;

  // Validate the lot exists + belongs to the tenant.
  const lot = await runQuery(
    db,
    `SELECT id, recalled_at FROM finance.lots WHERE tenant_id = $1 AND id = $2`,
    [tenantId, lotId],
  );
  if (!lot.rows || lot.rows.length === 0) {
    throw new ValueError(`lot ${lotId} not found in tenant ${tenantId}`);
  }
  const alreadyRecalled = lot.rows[0].recalled_at != null;
  if (alreadyRecalled && !force) {
    // Idempotent: don't re-cascade, just return the existing info.
    const updatedLot = await getLot(db, lotId, tenantId);
    const recalledSerials = await runQuery(
      db,
      `SELECT id FROM finance.serials
        WHERE tenant_id = $1 AND lot_id = $2 AND status = 'recalled'`,
      [tenantId, lotId],
    );
    return {
      lot: updatedLot,
      recalled_serials: (recalledSerials.rows || []).length,
      already_recalled: true,
    };
  }

  // Cascade: set status='recalled' + clear current_location_id on
  // every serial in this lot (tenant-scoped). The lot_id guard
  // ensures we don't touch serials that were reassigned to a
  // different lot (the schema allows lot_id changes via
  // assignSerialLocation).
  await runQuery(
    db,
    `UPDATE finance.serials
        SET status = 'recalled',
            current_location_id = NULL,
            updated_at = datetime('now')
      WHERE tenant_id = $1 AND lot_id = $2`,
    [tenantId, lotId],
  );

  // Stamp the lot itself with the audit trail.
  await runQuery(
    db,
    `UPDATE finance.lots
        SET recalled_at = datetime('now'),
            recall_reason = $1,
            recalled_by = $2,
            updated_at = datetime('now')
      WHERE tenant_id = $3 AND id = $4`,
    [reason, userId, tenantId, lotId],
  );

  // Return the post-recall view.
  const updatedLot = await getLot(db, lotId, tenantId);
  const recalledSerials = await runQuery(
    db,
    `SELECT id FROM finance.serials
      WHERE tenant_id = $1 AND lot_id = $2 AND status = 'recalled'`,
    [tenantId, lotId],
  );
  return {
    lot: updatedLot,
    recalled_serials: (recalledSerials.rows || []).length,
    already_recalled: false,
  };
}

/**
 * List the serials in a lot that are currently flagged 'recalled'.
 * Convenience helper for customer service to find units that
 * were shipped out to customers and need to be returned.
 *
 * @param {object} db
 * @param {number} tenantId
 * @param {number} lotId
 * @returns {Promise<Array<object>>}  the recalled serials
 */
export async function listRecalledSerials(db, tenantId, lotId) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
  if (!Number.isInteger(lotId) || lotId <= 0) {
    throw new ValueError('lotId must be a positive integer');
  }
  const rows = await runQuery(
    db,
    `SELECT id, tenant_id, serial_number, catalog_item_id, lot_id, status,
            current_location_id, received_at, sold_at, notes,
            created_at, updated_at
       FROM finance.serials
      WHERE tenant_id = $1 AND lot_id = $2 AND status = 'recalled'
      ORDER BY id ASC`,
    [tenantId, lotId],
  );
  return (rows.rows || []).map(normalizeSerial);
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
    recalled_at: r.recalled_at || null,
    recall_reason: r.recall_reason || null,
    recalled_by: r.recalled_by == null ? null : Number(r.recalled_by),
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