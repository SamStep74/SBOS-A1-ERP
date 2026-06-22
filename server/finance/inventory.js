// SBOS-A1-ERP finance — Inventory pure functions.
//
// Ported from packages/erp/src/{product-catalog,stock-moves}.ts in
// A1-Suite-Local (the user's private R&D monorepo). All orgId
// references renamed to tenantId for consistency with the rest of
// SBOS-A1-ERP. The TypeScript type annotations are stripped; the
// pg-style $N placeholders are kept (the realDb.js adapter
// translates to ? on the way down to sqlite).
//
// Scope (Phase 1 of the ERP plan):
//   - catalog items (products): create / list / get / archive
//   - warehouses: create / list
//   - stock locations: create / list
//   - stock moves: receive / deliver / transfer / adjust
//   - stock balances: list
//
// Out of scope (Phase 2+): lot/serial tracking. The stock-valuation
// handoff to Finance (Dr 216 / Cr 521 on receive, Dr 711 / Cr 216 on
// deliver) is NOW IN SCOPE (wave 19.2) and is wired via
// ./stockPosting.js — every move in this file posts its GL entry
// as a side-effect after the move is recorded.

// Strip the `finance.` schema prefix to match the production
// migration runner's behavior (the table is `catalog_items` on
// sqlite, `finance.catalog_items` on pg). The pure-function SQL
// is written with the prefix for readability; the strip happens
// at DML time so the same SQL works on both backends.
function stripFinancePrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Lot + serial helpers (Wave 39 commit 2).
// Optional: receiveStock + deliverStock accept lot_id + serial_ids
// to record lot-level + unit-level movements. Stock-move integration
// is best-effort: if the lots/serials tables don't exist (old deploys),
// the move still succeeds — the quantity is just tracked at the
// stock_quants level.
// ────────────────────────────────────────────────────────────────────────
let lotsModule = null;
async function lots() {
  if (lotsModule === null) {
    try {
      lotsModule = await import('./lots.js');
    } catch (_e) {
      lotsModule = false;
    }
  }
  return lotsModule || null;
}

// ────────────────────────────────────────────────────────────────────────
// runQuery — same shape as server/finance/invoice.js. Tolerates
// adapters that don't return rows on INSERT (sqlite path uses
// lastInsertRowid via the realDb.js adapter's stmt.all path).
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  const result = await db.query(stripFinancePrefix(sql), params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// postMoveGL — best-effort GL side-effect for a stock move. Failures
// are caught and swallowed: the move is the source of truth, the GL
// is a projection, and a failed GL post should never roll back the
// move. The UNIQUE (source, source_id) index on journal_entries is
// the idempotency guard, so a re-run (or the next reconciliation
// job) re-posts the entry safely.
async function postMoveGL(db, fn, move, tenantId) {
  try {
    const mod = await import('./stockPosting.js');
    await mod[fn](db, move, tenantId);
  } catch (_err) {
    // Swallowed by design — see comment above. The caller still
    // gets the move result.
  }
}

// ────────────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────────────

function assertNonEmpty(value, name) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new ValueError(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function assertSku(value) {
  if (typeof value !== 'string') {
    throw new ValueError('sku must be a string');
  }
  const trimmed = value.trim();
  if (trimmed.length < 1 || trimmed.length > 80) {
    throw new ValueError('sku must be 1-80 characters');
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(trimmed)) {
    throw new ValueError('sku must match /^[A-Za-z0-9][A-Za-z0-9_.-]*$/');
  }
  return trimmed;
}

function assertNonNegInt(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
  return value;
}

function assertPosInt(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
  return value;
}

// Parse the optional serial_ids array. Returns a positive-integer
// array (length 0 = no serials) or throws ValueError on malformed input.
function parseSerialIds(value) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw new ValueError('serial_ids must be an array of positive integers');
  }
  for (let i = 0; i < value.length; i++) {
    assertPosInt(value[i], `serial_ids[${i}]`);
  }
  return value;
}

const VALID_ITEM_TYPES = new Set(['STOCKABLE', 'CONSUMABLE', 'SERVICE', 'DIGITAL']);
const VALID_VAT_CLASSES = new Set(['VAT_STANDARD', 'VAT_REDUCED', 'VAT_EXEMPT', 'VAT_ZERO']);
const VALID_LOCATION_TYPES = new Set(['INTERNAL', 'CUSTOMER', 'SUPPLIER']);
// VALID_MOVE_TYPES is documented for the move_type enum but the
// stock-move functions below dispatch by their own logic (the
// move_type is set internally per-function, never accepted from
// the caller) — kept as a set here for future callers that need
// to validate user input.
const VALID_MOVE_TYPES = new Set(['RECEIPT', 'DELIVERY', 'ADJUSTMENT', 'TRANSFER', 'INTERNAL']);
void VALID_MOVE_TYPES;

// ────────────────────────────────────────────────────────────────────────
// Catalog items (products)
// ────────────────────────────────────────────────────────────────────────

export async function createCatalogItem(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const sku = assertSku(input.sku);
  const name = assertNonEmpty(input.name, 'name');
  if (input.type && !VALID_ITEM_TYPES.has(input.type)) {
    throw new ValueError(`type must be one of: ${Array.from(VALID_ITEM_TYPES).join(', ')}`);
  }
  if (input.vat_class && !VALID_VAT_CLASSES.has(input.vat_class)) {
    throw new ValueError(`vat_class must be one of: ${Array.from(VALID_VAT_CLASSES).join(', ')}`);
  }
  const type = input.type || 'STOCKABLE';
  const vatClass = input.vat_class || 'VAT_STANDARD';
  const uomCode = input.uom_code || 'pcs';
  const standardPrice = input.standard_price != null ? assertNonNegInt(input.standard_price, 'standard_price') : 0;
  const salePrice = input.sale_price != null ? assertNonNegInt(input.sale_price, 'sale_price') : 0;
  const standardCost = input.standard_cost != null ? assertNonNegInt(input.standard_cost, 'standard_cost') : 0;
  const reorderPoint = input.reorder_point != null ? assertNonNegInt(input.reorder_point, 'reorder_point') : 0;

  // UNIQUE (tenant_id, sku)
  const dupe = await runQuery(
    db,
    'SELECT id FROM finance.catalog_items WHERE tenant_id = $1 AND sku = $2',
    [tenantId, sku],
  );
  if (dupe.rows && dupe.rows.length > 0) {
    throw new ValueError(`catalog item with sku "${sku}" already exists in tenant ${tenantId}`);
  }

  const res = await runQuery(
    db,
    `INSERT INTO finance.catalog_items
       (tenant_id, sku, name, description, type, category_id, uom_id, uom_code,
        barcode, vat_class, standard_price, sale_price, standard_cost, reorder_point, archived)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0)
     RETURNING id`,
    [
      tenantId, sku, name, input.description || null, type,
      input.category_id == null ? null : Number(input.category_id),
      input.uom_id == null ? null : Number(input.uom_id),
      uomCode,
      input.barcode || null,
      vatClass,
      standardPrice, salePrice, standardCost, reorderPoint,
    ],
  );

  let id;
  if (res.rows && res.rows.length > 0 && res.rows[0].id != null) {
    id = Number(res.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  return {
    id, sku, name, type, vat_class: vatClass, uom_code: uomCode,
    standard_price: standardPrice, sale_price: salePrice, standard_cost: standardCost,
    reorder_point: reorderPoint,
    tenant_id: tenantId,
  };
}

export async function listCatalogItems(db, tenantId = 0) {
  const res = await runQuery(
    db,
    `SELECT id, sku, name, type, vat_class, uom_code, standard_price, sale_price, standard_cost
       FROM finance.catalog_items
      WHERE tenant_id = $1 AND archived = 0
      ORDER BY name ASC`,
    [tenantId],
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id), sku: r.sku, name: r.name, type: r.type, vat_class: r.vat_class,
    uom_code: r.uom_code,
    standard_price: Number(r.standard_price), sale_price: Number(r.sale_price),
    standard_cost: Number(r.standard_cost), tenant_id: tenantId,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Warehouses
// ────────────────────────────────────────────────────────────────────────

export async function createWarehouse(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const code = assertNonEmpty(input.code, 'code').toUpperCase();
  const name = assertNonEmpty(input.name, 'name');

  const dupe = await runQuery(
    db,
    'SELECT id FROM finance.warehouses WHERE tenant_id = $1 AND code = $2',
    [tenantId, code],
  );
  if (dupe.rows && dupe.rows.length > 0) {
    throw new ValueError(`warehouse with code "${code}" already exists in tenant ${tenantId}`);
  }

  const res = await runQuery(
    db,
    `INSERT INTO finance.warehouses (tenant_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [tenantId, code, name],
  );
  let id;
  if (res.rows && res.rows.length > 0 && res.rows[0].id != null) {
    id = Number(res.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }
  return { id, code, name, tenant_id: tenantId };
}

export async function listWarehouses(db, tenantId = 0) {
  const res = await runQuery(
    db,
    `SELECT id, code, name FROM finance.warehouses
      WHERE tenant_id = $1 AND archived = 0
      ORDER BY code ASC`,
    [tenantId],
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id), code: r.code, name: r.name, tenant_id: tenantId,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Stock locations
// ────────────────────────────────────────────────────────────────────────

export async function createLocation(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const warehouseId = assertPosInt(input.warehouse_id, 'warehouse_id');
  const code = assertNonEmpty(input.code, 'code').toUpperCase();
  const name = assertNonEmpty(input.name, 'name');
  const locationType = input.location_type || 'INTERNAL';
  if (!VALID_LOCATION_TYPES.has(locationType)) {
    throw new ValueError(`location_type must be one of: ${Array.from(VALID_LOCATION_TYPES).join(', ')}`);
  }
  // Warehouse must exist + belong to tenant.
  const wh = await runQuery(
    db,
    'SELECT id FROM finance.warehouses WHERE tenant_id = $1 AND id = $2',
    [tenantId, warehouseId],
  );
  if (!wh.rows || wh.rows.length === 0) {
    throw new ValueError(`warehouse ${warehouseId} not found in tenant ${tenantId}`);
  }
  // UNIQUE (tenant, warehouse, code)
  const dupe = await runQuery(
    db,
    'SELECT id FROM finance.stock_locations WHERE tenant_id = $1 AND warehouse_id = $2 AND code = $3',
    [tenantId, warehouseId, code],
  );
  if (dupe.rows && dupe.rows.length > 0) {
    throw new ValueError(`location with code "${code}" already exists in warehouse ${warehouseId}`);
  }

  const res = await runQuery(
    db,
    `INSERT INTO finance.stock_locations (tenant_id, warehouse_id, code, name, location_type, parent_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tenantId, warehouseId, code, name, locationType, input.parent_id == null ? null : Number(input.parent_id)],
  );
  let id;
  if (res.rows && res.rows.length > 0 && res.rows[0].id != null) {
    id = Number(res.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }
  return { id, warehouse_id: warehouseId, code, name, location_type: locationType, tenant_id: tenantId };
}

export async function listLocations(db, tenantId = 0, warehouseId) {
  const sql = warehouseId != null
    ? `SELECT id, warehouse_id, code, name, location_type, parent_id
         FROM finance.stock_locations
        WHERE tenant_id = $1 AND warehouse_id = $2 AND archived = 0
        ORDER BY code ASC`
    : `SELECT id, warehouse_id, code, name, location_type, parent_id
         FROM finance.stock_locations
        WHERE tenant_id = $1 AND archived = 0
        ORDER BY code ASC`;
  const params = warehouseId != null ? [tenantId, Number(warehouseId)] : [tenantId];
  const res = await runQuery(db, sql, params);
  return (res.rows || []).map((r) => ({
    id: Number(r.id), warehouse_id: Number(r.warehouse_id), code: r.code, name: r.name,
    location_type: r.location_type, parent_id: r.parent_id == null ? null : Number(r.parent_id),
    tenant_id: tenantId,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Stock moves
// ────────────────────────────────────────────────────────────────────────

/**
 * Receive stock at a destination location. POST-style move with a
 * source of NULL (or a SUPPLIER location for in-transit from a
 * specific vendor). Updates the destination's stock_quants row
 * with weighted-average cost.
 */
export async function receiveStock(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const itemId = assertPosInt(input.catalog_item_id, 'catalog_item_id');
  const destLocationId = assertPosInt(input.destination_location_id, 'destination_location_id');
  const quantity = assertPosInt(input.quantity, 'quantity');
  const unitCost = input.unit_cost != null ? assertNonNegInt(input.unit_cost, 'unit_cost') : 0;
  const sourceLocationId = input.source_location_id == null ? null : assertPosInt(input.source_location_id, 'source_location_id');
  const reference = input.reference || null;
  const notes = input.notes || null;
  const userId = input.user_id == null ? null : Number(input.user_id);
  // Lot + serial tracking (Wave 39 commit 2). Optional.
  //   - lot_id: integer; the received quantity belongs to this lot
  //   - serial_ids: integer[]; for unit-tracked items, each physical
  //     unit has a serial. Length must equal `quantity` for unit-tracked
  //     items (mixing unit + bulk in one move is a data error).
  const lotId = input.lot_id == null ? null : assertPosInt(input.lot_id, 'lot_id');
  const serialIds = parseSerialIds(input.serial_ids);

  // Item + dest must exist + belong to tenant.
  const item = await runQuery(
    db,
    'SELECT id, standard_cost FROM finance.catalog_items WHERE tenant_id = $1 AND id = $2 AND archived = 0',
    [tenantId, itemId],
  );
  if (!item.rows || item.rows.length === 0) {
    throw new ValueError(`catalog item ${itemId} not found in tenant ${tenantId}`);
  }
  const dest = await runQuery(
    db,
    'SELECT id, location_type FROM finance.stock_locations WHERE tenant_id = $1 AND id = $2 AND archived = 0',
    [tenantId, destLocationId],
  );
  if (!dest.rows || dest.rows.length === 0) {
    throw new ValueError(`destination location ${destLocationId} not found in tenant ${tenantId}`);
  }
  // If a source_location_id is provided, validate it.
  if (sourceLocationId != null) {
    const src = await runQuery(
      db,
      'SELECT id FROM finance.stock_locations WHERE tenant_id = $1 AND id = $2',
      [tenantId, sourceLocationId],
    );
    if (!src.rows || src.rows.length === 0) {
      throw new ValueError(`source location ${sourceLocationId} not found in tenant ${tenantId}`);
    }
  }

  // Compute the new weighted-average cost at the destination.
  // formula: (existing_qty * existing_avg + received_qty * unit_cost) / (existing_qty + received_qty)
  const existing = await runQuery(
    db,
    'SELECT quantity, average_cost FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
    [tenantId, itemId, destLocationId],
  );
  const existingQty = existing.rows && existing.rows.length > 0 ? Number(existing.rows[0].quantity) : 0;
  const existingAvg = existing.rows && existing.rows.length > 0 ? Number(existing.rows[0].average_cost) : (unitCost > 0 ? unitCost : Number(item.rows[0].standard_cost || 0));
  const newQty = existingQty + quantity;
  // Cost basis: explicit unit_cost > 0 wins, else use the existing average
  // (for non-costed receipts like a return or a transfer-in).
  const effectiveUnitCost = unitCost > 0 ? unitCost : existingAvg;
  const newAvg = newQty > 0 ? Math.floor((existingQty * existingAvg + quantity * effectiveUnitCost) / newQty) : 0;

  // Upsert stock_quants.
  if (existingQty === 0) {
    await runQuery(
      db,
      `INSERT INTO finance.stock_quants (tenant_id, catalog_item_id, location_id, quantity, reserved_quantity, average_cost)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      [tenantId, itemId, destLocationId, quantity, newAvg],
    );
  } else {
    await runQuery(
      db,
      `UPDATE finance.stock_quants
          SET quantity = $1, average_cost = $2, updated_at = datetime('now')
        WHERE tenant_id = $3 AND catalog_item_id = $4 AND location_id = $5`,
      [newQty, newAvg, tenantId, itemId, destLocationId],
    );
  }

  // If a source location was given (transfer from a SUPPLIER
  // location or another internal location), decrement the source.
  if (sourceLocationId != null && sourceLocationId !== destLocationId) {
    const srcRow = await runQuery(
      db,
      'SELECT quantity FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
      [tenantId, itemId, sourceLocationId],
    );
    const srcQty = srcRow.rows && srcRow.rows.length > 0 ? Number(srcRow.rows[0].quantity) : 0;
    const newSrcQty = Math.max(0, srcQty - quantity);
    if (newSrcQty === 0) {
      await runQuery(
        db,
        `DELETE FROM finance.stock_quants
          WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3`,
        [tenantId, itemId, sourceLocationId],
      );
    } else {
      await runQuery(
        db,
        `UPDATE finance.stock_quants
            SET quantity = $1, updated_at = datetime('now')
          WHERE tenant_id = $2 AND catalog_item_id = $3 AND location_id = $4`,
        [newSrcQty, tenantId, itemId, sourceLocationId],
      );
    }
  }

  // Lot + serial integration (Wave 39 commit 2). Optional.
  // If the lots module is available (the deploy has the migration
  // applied), record the lot-level + unit-level movements.
  let lotReceived = null;
  let serialUpdates = [];
  const lotsApi = await lots();
  if (lotsApi) {
    // If lot_id is given, the entire received quantity belongs to
    // that lot. receiveIntoLot validates that the lot is for this
    // catalog_item_id (a mismatch is a data error).
    if (lotId != null) {
      lotReceived = await lotsApi.receiveIntoLot(
        db, tenantId, lotId, destLocationId, itemId, quantity,
      );
    }
    // If serial_ids is given, each unit gets pinned to the destination
    // location + status='in_stock'. For unit-tracked items,
    // serial_ids.length must equal quantity (one serial per physical
    // unit). Mismatch is a data error.
    if (serialIds.length > 0) {
      if (serialIds.length !== quantity) {
        throw new ValueError(
          `serial_ids.length (${serialIds.length}) must equal quantity (${quantity}) for unit-tracked items`,
        );
      }
      for (const sid of serialIds) {
        const updated = await lotsApi.assignSerialLocation(
          db, tenantId, sid, destLocationId, 'in_stock', lotId,
        );
        serialUpdates.push({ id: updated.id, status: updated.status, current_location_id: updated.current_location_id });
      }
    }
  }

  // Append-only move row.
  const moveRes = await runQuery(
    db,
    `INSERT INTO finance.stock_moves
       (tenant_id, move_type, catalog_item_id, source_location_id, destination_location_id, quantity, unit_cost, reference, notes, created_by)
     VALUES ($1, 'RECEIPT', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [tenantId, itemId, sourceLocationId, destLocationId, quantity, effectiveUnitCost, reference, notes, userId],
  );
  let moveId;
  if (moveRes.rows && moveRes.rows.length > 0 && moveRes.rows[0].id != null) {
    moveId = Number(moveRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    moveId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Best-effort GL side-effect (Dr 216 / Cr 521 at receive value).
  await postMoveGL(
    db,
    'postStockReceiveGL',
    { id: moveId, quantity, unit_cost: effectiveUnitCost, created_at: new Date().toISOString() },
    tenantId,
  );

  return {
    move_id: moveId,
    move_type: 'RECEIPT',
    catalog_item_id: itemId,
    destination_location_id: destLocationId,
    source_location_id: sourceLocationId,
    quantity,
    unit_cost: effectiveUnitCost,
    new_quantity_at_destination: newQty,
    new_average_cost: newAvg,
    ...(lotReceived != null ? { lot_received: lotReceived } : {}),
    ...(serialUpdates.length > 0 ? { serial_updates: serialUpdates } : {}),
  };
}

/**
 * Deliver stock from a source location. Decrements the source's
 * stock_quants. The unit_cost at the move is the source's
 * current average_cost (for downstream COGS calculation).
 */
export async function deliverStock(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const itemId = assertPosInt(input.catalog_item_id, 'catalog_item_id');
  const sourceLocationId = assertPosInt(input.source_location_id, 'source_location_id');
  const quantity = assertPosInt(input.quantity, 'quantity');
  const destLocationId = input.destination_location_id == null ? null : assertPosInt(input.destination_location_id, 'destination_location_id');
  const reference = input.reference || null;
  const notes = input.notes || null;
  const userId = input.user_id == null ? null : Number(input.user_id);
  // Lot + serial tracking (Wave 39 commit 2). Optional.
  //   - serial_ids: integer[]; for unit-tracked items, the list of
  //     serials that left the source. Length must equal quantity.
  //   - lot_id is NOT accepted: deliveries use FEFO across all lots
  //     at the source (the caller doesn't pre-select the lot).
  const serialIds = parseSerialIds(input.serial_ids);

  // Source must have enough stock.
  const src = await runQuery(
    db,
    'SELECT quantity, average_cost FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
    [tenantId, itemId, sourceLocationId],
  );
  if (!src.rows || src.rows.length === 0) {
    throw new ValueError(`no stock at source location ${sourceLocationId} for item ${itemId}`);
  }
  const srcQty = Number(src.rows[0].quantity);
  const srcAvg = Number(src.rows[0].average_cost);
  if (srcQty < quantity) {
    throw new ValueError(`insufficient stock at source: have ${srcQty}, requested ${quantity}`);
  }
  // If a destination is given, validate it.
  if (destLocationId != null) {
    const dest = await runQuery(
      db,
      'SELECT id FROM finance.stock_locations WHERE tenant_id = $1 AND id = $2',
      [tenantId, destLocationId],
    );
    if (!dest.rows || dest.rows.length === 0) {
      throw new ValueError(`destination location ${destLocationId} not found in tenant ${tenantId}`);
    }
  }

  const newSrcQty = srcQty - quantity;
  if (newSrcQty === 0) {
    await runQuery(
      db,
      'DELETE FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
      [tenantId, itemId, sourceLocationId],
    );
  } else {
    await runQuery(
      db,
      `UPDATE finance.stock_quants SET quantity = $1, updated_at = datetime('now')
        WHERE tenant_id = $2 AND catalog_item_id = $3 AND location_id = $4`,
      [newSrcQty, tenantId, itemId, sourceLocationId],
    );
  }

  // Optional: increment destination (e.g. customer location for
  // consignment / drop-ship).
  if (destLocationId != null) {
    const destRow = await runQuery(
      db,
      'SELECT quantity, average_cost FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
      [tenantId, itemId, destLocationId],
    );
    const destQty = destRow.rows && destRow.rows.length > 0 ? Number(destRow.rows[0].quantity) : 0;
    const destAvg = destRow.rows && destRow.rows.length > 0 ? Number(destRow.rows[0].average_cost) : srcAvg;
    const newDestQty = destQty + quantity;
    const newDestAvg = newDestQty > 0 ? Math.floor((destQty * destAvg + quantity * srcAvg) / newDestQty) : 0;
    if (destQty === 0) {
      await runQuery(
        db,
        `INSERT INTO finance.stock_quants (tenant_id, catalog_item_id, location_id, quantity, reserved_quantity, average_cost)
         VALUES ($1, $2, $3, $4, 0, $5)`,
        [tenantId, itemId, destLocationId, quantity, newDestAvg],
      );
    } else {
      await runQuery(
        db,
        `UPDATE finance.stock_quants SET quantity = $1, average_cost = $2, updated_at = datetime('now')
          WHERE tenant_id = $3 AND catalog_item_id = $4 AND location_id = $5`,
        [newDestQty, newDestAvg, tenantId, itemId, destLocationId],
      );
    }
  }

  // Lot + serial integration (Wave 39 commit 2). Optional.
  // If the lots module is available, record the lot-level + unit-level
  // movements. FEFO consumption happens BEFORE the move row so the
  // GL side-effect (which reads the move's unit_cost) reflects the
  // true source.
  let lotConsumption = null;
  let serialUpdates = [];
  const lotsApi = await lots();
  if (lotsApi) {
    // Unit-tracked delivery: assign each serial to the destination
    // (or null for external sale → status='sold'). Length must equal
    // quantity (one serial per physical unit).
    if (serialIds.length > 0) {
      if (serialIds.length !== quantity) {
        throw new ValueError(
          `serial_ids.length (${serialIds.length}) must equal quantity (${quantity}) for unit-tracked items`,
        );
      }
      // External sale (no destination) vs internal transfer (destination
      // is another internal location). Status reflects this:
      //   - destLocationId == null OR CUSTOMER → 'sold'
      //   - destLocationId set (INTERNAL) → 'in_stock' at the new location
      const newStatus = (destLocationId == null) ? 'sold' : 'in_stock';
      const newLoc = (destLocationId == null) ? null : destLocationId;
      for (const sid of serialIds) {
        const updated = await lotsApi.assignSerialLocation(
          db, tenantId, sid, newLoc, newStatus, null,
        );
        serialUpdates.push({ id: updated.id, status: updated.status, current_location_id: updated.current_location_id });
      }
    } else {
      // Bulk delivery with lot-tracking at the source: FEFO consumption.
      // If no stock_lots rows exist for (item, source), this is a no-op
      // (graceful degradation — the item is fungible, no lot tracking).
      // If stock_lots rows exist, we MUST have enough lot-tracked stock
      // to satisfy the delivery (the function throws on shortfall).
      // Wrap in try/catch so a missing stock_lots table (pre-migration
      // deploys, some test schemas) doesn't break the move.
      try {
        const stockLotsExist = await runQuery(
          db,
          `SELECT id FROM finance.stock_lots
            WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3
              AND quantity > 0
            LIMIT 1`,
          [tenantId, itemId, sourceLocationId],
        );
        if (stockLotsExist.rows && stockLotsExist.rows.length > 0) {
          lotConsumption = await lotsApi.consumeFromLotsFEFO(
            db, tenantId, itemId, sourceLocationId, quantity,
          );
        }
      } catch (_e) {
        // stock_lots table missing → no FEFO possible, fall through.
        lotConsumption = null;
      }
    }
  }

  // Append-only move row.
  const moveRes = await runQuery(
    db,
    `INSERT INTO finance.stock_moves
       (tenant_id, move_type, catalog_item_id, source_location_id, destination_location_id, quantity, unit_cost, reference, notes, created_by)
     VALUES ($1, 'DELIVERY', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [tenantId, itemId, sourceLocationId, destLocationId, quantity, srcAvg, reference, notes, userId],
  );
  let moveId;
  if (moveRes.rows && moveRes.rows.length > 0 && moveRes.rows[0].id != null) {
    moveId = Number(moveRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    moveId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Best-effort GL side-effect (Dr 711 / Cr 216 at source avg).
  // Transfer is internal — no GL impact (no value crosses the
  // company boundary), so we only post the COGS if the source
  // location is a real outbound (e.g. CUSTOMER delivery) and
  // srcAvg > 0. The postStockDeliverGL function no-ops when
  // unit_cost is 0, so the no-GL cases are handled inside.
  if (srcAvg > 0) {
    await postMoveGL(
      db,
      'postStockDeliverGL',
      { id: moveId, quantity, unit_cost: srcAvg, created_at: new Date().toISOString() },
      tenantId,
    );
  }

  return {
    move_id: moveId,
    move_type: 'DELIVERY',
    catalog_item_id: itemId,
    source_location_id: sourceLocationId,
    destination_location_id: destLocationId,
    quantity,
    unit_cost: srcAvg,
    new_quantity_at_source: newSrcQty,
    ...(lotConsumption != null ? { lot_consumption: lotConsumption } : {}),
    ...(serialUpdates.length > 0 ? { serial_updates: serialUpdates } : {}),
  };
}

/**
 * Transfer stock between two internal locations. Both locations
 * must belong to the tenant and be location_type = INTERNAL.
 */
export async function transferStock(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const itemId = assertPosInt(input.catalog_item_id, 'catalog_item_id');
  const sourceLocationId = assertPosInt(input.source_location_id, 'source_location_id');
  const destLocationId = assertPosInt(input.destination_location_id, 'destination_location_id');
  if (sourceLocationId === destLocationId) {
    throw new ValueError('source and destination must be different');
  }
  const quantity = assertPosInt(input.quantity, 'quantity');
  const reference = input.reference || null;
  const notes = input.notes || null;
  const userId = input.user_id == null ? null : Number(input.user_id);

  // Validate both locations.
  for (const locId of [sourceLocationId, destLocationId]) {
    const loc = await runQuery(
      db,
      'SELECT id, location_type FROM finance.stock_locations WHERE tenant_id = $1 AND id = $2 AND archived = 0',
      [tenantId, locId],
    );
    if (!loc.rows || loc.rows.length === 0) {
      throw new ValueError(`location ${locId} not found in tenant ${tenantId}`);
    }
    if (loc.rows[0].location_type !== 'INTERNAL') {
      throw new ValueError(`location ${locId} is not INTERNAL; transfers require internal locations`);
    }
  }
  const src = await runQuery(
    db,
    'SELECT quantity, average_cost FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
    [tenantId, itemId, sourceLocationId],
  );
  if (!src.rows || src.rows.length === 0) {
    throw new ValueError(`no stock at source location ${sourceLocationId} for item ${itemId}`);
  }
  const srcQty = Number(src.rows[0].quantity);
  if (srcQty < quantity) {
    throw new ValueError(`insufficient stock at source: have ${srcQty}, requested ${quantity}`);
  }
  const srcAvg = Number(src.rows[0].average_cost);

  const destRow = await runQuery(
    db,
    'SELECT quantity, average_cost FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
    [tenantId, itemId, destLocationId],
  );
  const destQty = destRow.rows && destRow.rows.length > 0 ? Number(destRow.rows[0].quantity) : 0;
  const destAvg = destRow.rows && destRow.rows.length > 0 ? Number(destRow.rows[0].average_cost) : srcAvg;

  const newSrcQty = srcQty - quantity;
  const newDestQty = destQty + quantity;
  const newDestAvg = newDestQty > 0 ? Math.floor((destQty * destAvg + quantity * srcAvg) / newDestQty) : 0;

  if (newSrcQty === 0) {
    await runQuery(
      db,
      'DELETE FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
      [tenantId, itemId, sourceLocationId],
    );
  } else {
    await runQuery(
      db,
      `UPDATE finance.stock_quants SET quantity = $1, updated_at = datetime('now')
        WHERE tenant_id = $2 AND catalog_item_id = $3 AND location_id = $4`,
      [newSrcQty, tenantId, itemId, sourceLocationId],
    );
  }
  if (destQty === 0) {
    await runQuery(
      db,
      `INSERT INTO finance.stock_quants (tenant_id, catalog_item_id, location_id, quantity, reserved_quantity, average_cost)
       VALUES ($1, $2, $3, $4, 0, $5)`,
      [tenantId, itemId, destLocationId, quantity, newDestAvg],
    );
  } else {
    await runQuery(
      db,
      `UPDATE finance.stock_quants SET quantity = $1, average_cost = $2, updated_at = datetime('now')
        WHERE tenant_id = $3 AND catalog_item_id = $4 AND location_id = $5`,
      [newDestQty, newDestAvg, tenantId, itemId, destLocationId],
    );
  }

  // Append-only move row.
  const moveRes = await runQuery(
    db,
    `INSERT INTO finance.stock_moves
       (tenant_id, move_type, catalog_item_id, source_location_id, destination_location_id, quantity, unit_cost, reference, notes, created_by)
     VALUES ($1, 'TRANSFER', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [tenantId, itemId, sourceLocationId, destLocationId, quantity, srcAvg, reference, notes, userId],
  );
  let moveId;
  if (moveRes.rows && moveRes.rows.length > 0 && moveRes.rows[0].id != null) {
    moveId = Number(moveRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    moveId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }
  return {
    move_id: moveId,
    move_type: 'TRANSFER',
    quantity,
    new_quantity_at_source: newSrcQty,
    new_quantity_at_destination: newDestQty,
  };
}

/**
 * Adjust the on-hand quantity at a single location to a new
 * absolute value. Records the move with the `delta` column
 * storing the new absolute quantity (NOT the delta in/out).
 * Used for cycle counts, scrap, found stock, etc.
 *
 * Wave 54: the `reason` field is now MANDATORY (was optional
 * before). A free-text reason is required by financial-control
 * best practice: every variance must be explained. The reason
 * is stored in `notes` and the controlled `reason_category` is
 * stored in the dedicated column. Both are required: the
 * category makes reporting/filtering possible, the free text
 * captures the operator's explanation.
 *
 * Allowed reason_category values:
 *   damage     — physical damage to the stock
 *   loss       — stock that has gone missing (theft, unexplained)
 *   found      — stock discovered during a count that wasn't on
 *                the books (positive adjustment)
 *   correction — operator error in a prior move
 *   recount    — adjustment to reflect an actual physical count
 *   writeoff   — formally retiring stock (e.g. expired, obsolete)
 *   other      — anything else (the reason text is the explanation)
 */
const ALLOWED_REASON_CATEGORIES = new Set([
  'damage',
  'loss',
  'found',
  'correction',
  'recount',
  'writeoff',
  'other',
]);

export async function adjustStock(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const itemId = assertPosInt(input.catalog_item_id, 'catalog_item_id');
  const locationId = assertPosInt(input.location_id, 'location_id');
  if (typeof input.new_quantity !== 'number' || !Number.isInteger(input.new_quantity) || input.new_quantity < 0) {
    throw new ValueError('new_quantity must be a non-negative integer');
  }
  const newQty = input.new_quantity;
  // Wave 54: reason is mandatory. Validate: non-empty after
  // trim, min 5 chars, max 500 chars. The min-5 floor prevents
  // single-letter or token-style reasons that don't actually
  // explain anything; the max-500 keeps the audit log readable.
  const rawReason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (rawReason.length < 5) {
    throw new ValueError(
      'reason is required and must be at least 5 characters (explains the variance)',
    );
  }
  if (rawReason.length > 500) {
    throw new ValueError('reason must be 500 characters or fewer');
  }
  const reason = rawReason;
  // reason_category is also mandatory. Pick from the controlled
  // list. The category makes the audit log filterable + reportable;
  // the free-text reason captures the specific explanation.
  const category = typeof input.reason_category === 'string' ? input.reason_category.trim() : '';
  if (!category) {
    throw new ValueError(
      'reason_category is required (one of: damage, loss, found, correction, recount, writeoff, other)',
    );
  }
  if (!ALLOWED_REASON_CATEGORIES.has(category)) {
    throw new ValueError(
      `reason_category must be one of: ${[...ALLOWED_REASON_CATEGORIES].join(', ')}`,
    );
  }
  const userId = input.user_id == null ? null : Number(input.user_id);

  const loc = await runQuery(
    db,
    'SELECT id FROM finance.stock_locations WHERE tenant_id = $1 AND id = $2',
    [tenantId, locationId],
  );
  if (!loc.rows || loc.rows.length === 0) {
    throw new ValueError(`location ${locationId} not found in tenant ${tenantId}`);
  }
  const existing = await runQuery(
    db,
    'SELECT quantity FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
    [tenantId, itemId, locationId],
  );
  const oldQty = existing.rows && existing.rows.length > 0 ? Number(existing.rows[0].quantity) : 0;
  // Capture the pre-adjustment average cost for the GL post. The
  // adjustment GL entry uses (delta × currentAvg) — the unit
  // cost at the time the operator noticed the discrepancy, not
  // the recomputed cost after the adjustment.
  const currentAvgRes = await runQuery(
    db,
    'SELECT average_cost FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
    [tenantId, itemId, locationId],
  );
  const currentAvg =
    currentAvgRes.rows && currentAvgRes.rows.length > 0
      ? Number(currentAvgRes.rows[0].average_cost)
      : 0;
  if (newQty === 0) {
    if (existing.rows && existing.rows.length > 0) {
      await runQuery(
        db,
        'DELETE FROM finance.stock_quants WHERE tenant_id = $1 AND catalog_item_id = $2 AND location_id = $3',
        [tenantId, itemId, locationId],
      );
    }
  } else if (existing.rows && existing.rows.length > 0) {
    await runQuery(
      db,
      `UPDATE finance.stock_quants SET quantity = $1, updated_at = datetime('now')
        WHERE tenant_id = $2 AND catalog_item_id = $3 AND location_id = $4`,
      [newQty, tenantId, itemId, locationId],
    );
  } else {
    await runQuery(
      db,
      `INSERT INTO finance.stock_quants (tenant_id, catalog_item_id, location_id, quantity, reserved_quantity, average_cost)
       VALUES ($1, $2, $3, $4, 0, 0)`,
      [tenantId, itemId, locationId, newQty],
    );
  }
  const moveRes = await runQuery(
    db,
    `INSERT INTO finance.stock_moves
       (tenant_id, move_type, catalog_item_id, destination_location_id, quantity, unit_cost, delta, notes, reason_category, created_by)
     VALUES ($1, 'ADJUSTMENT', $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [tenantId, itemId, locationId, Math.abs(newQty - oldQty), currentAvg, newQty, reason, category, userId],
  );
  let moveId;
  if (moveRes.rows && moveRes.rows.length > 0 && moveRes.rows[0].id != null) {
    moveId = Number(moveRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    moveId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Best-effort GL side-effect (Dr 711 / Cr 216 for a loss, Dr
  // 216 / Cr 711 for a gain). Only posted when the delta × avg is
  // non-zero. The postStockAdjustGL function no-ops when delta=0.
  const deltaAmt = newQty - oldQty;
  if (deltaAmt !== 0 && currentAvg > 0) {
    await postMoveGL(
      db,
      'postStockAdjustGL',
      {
        id: moveId,
        quantity: Math.abs(deltaAmt),
        unit_cost: currentAvg,
        delta: deltaAmt,
        created_at: new Date().toISOString(),
      },
      tenantId,
    );
  }

  return { move_id: moveId, old_quantity: oldQty, new_quantity: newQty, delta: newQty - oldQty };
}

// ────────────────────────────────────────────────────────────────────────
// Stock balances + moves
// ────────────────────────────────────────────────────────────────────────

export async function listBalances(db, tenantId = 0, { itemId, locationId } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  let i = 2;
  if (itemId != null) {
    where.push(`catalog_item_id = $${i++}`);
    params.push(Number(itemId));
  }
  if (locationId != null) {
    where.push(`location_id = $${i}`);
    params.push(Number(locationId));
  }
  const res = await runQuery(
    db,
    `SELECT catalog_item_id, location_id, quantity, reserved_quantity, average_cost
       FROM finance.stock_quants
      WHERE ${where.join(' AND ')}
      ORDER BY catalog_item_id, location_id`,
    params,
  );
  return (res.rows || []).map((r) => ({
    catalog_item_id: Number(r.catalog_item_id),
    location_id: Number(r.location_id),
    quantity: Number(r.quantity),
    reserved_quantity: Number(r.reserved_quantity),
    available_quantity: Number(r.quantity) - Number(r.reserved_quantity),
    average_cost: Number(r.average_cost),
  }));
}

export async function listMoves(db, tenantId = 0, { itemId, moveType, limit = 100 } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  let i = 2;
  if (itemId != null) {
    where.push(`catalog_item_id = $${i++}`);
    params.push(Number(itemId));
  }
  if (moveType != null) {
    where.push(`move_type = $${i++}`);
    params.push(String(moveType));
  }
  const lim = Math.min(Math.max(Number(limit) || 100, 1), 1000);
  const res = await runQuery(
    db,
    `SELECT id, move_type, catalog_item_id, source_location_id, destination_location_id,
            quantity, unit_cost, reference, notes, reason_category, delta, created_at
       FROM finance.stock_moves
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT $${i}`,
    [...params, lim],
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id),
    move_type: r.move_type,
    catalog_item_id: Number(r.catalog_item_id),
    source_location_id: r.source_location_id == null ? null : Number(r.source_location_id),
    destination_location_id: r.destination_location_id == null ? null : Number(r.destination_location_id),
    quantity: Number(r.quantity),
    unit_cost: Number(r.unit_cost),
    reference: r.reference,
    notes: r.notes,
    // Wave 54: the controlled category for ADJUSTMENT moves
    // (NULL for RECEIPT/DELIVERY/TRANSFER). Surfaced here so
    // the standard listMoves endpoint can also be used for
    // adjustment reporting.
    reason_category: r.reason_category,
    delta: r.delta == null ? null : Number(r.delta),
    created_at: r.created_at,
  }));
}

/**
 * List inventory adjustments (move_type='ADJUSTMENT') with
 * optional filters. Wave 54: a focused view on the adjustment
 * subset, since these are the variance explanations the
 * operator needs to review.
 *
 * Filters:
 *   - category: filter by reason_category (e.g. 'damage')
 *   - itemId:   filter by catalog_item_id
 *   - locationId: filter by destination_location_id
 *   - since:    ISO date string, return only moves on or after
 *   - limit:    max rows (default 100, capped at 1000)
 *
 * Returns most-recent-first.
 */
export async function listAdjustments(db, tenantId = 0, opts = {}) {
  const where = ["tenant_id = $1", "move_type = 'ADJUSTMENT'"];
  const params = [tenantId];
  let i = 2;
  if (opts.category != null) {
    where.push(`reason_category = $${i++}`);
    params.push(String(opts.category));
  }
  if (opts.itemId != null) {
    where.push(`catalog_item_id = $${i++}`);
    params.push(Number(opts.itemId));
  }
  if (opts.locationId != null) {
    where.push(`destination_location_id = $${i++}`);
    params.push(Number(opts.locationId));
  }
  if (opts.since != null) {
    // Date string compared lexicographically against the ISO
    // timestamp stored in created_at. The format
    // "YYYY-MM-DDTHH:MM:SS" sorts correctly.
    where.push(`created_at >= $${i++}`);
    params.push(String(opts.since));
  }
  const lim = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
  const res = await runQuery(
    db,
    `SELECT id, move_type, catalog_item_id, destination_location_id,
            quantity, unit_cost, reference, notes, reason_category, delta, created_at, created_by
       FROM finance.stock_moves
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC
      LIMIT $${i}`,
    [...params, lim],
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id),
    move_type: r.move_type,
    catalog_item_id: Number(r.catalog_item_id),
    location_id: r.destination_location_id == null ? null : Number(r.destination_location_id),
    quantity: Number(r.quantity),
    unit_cost: Number(r.unit_cost),
    reference: r.reference,
    // `notes` is the free-text reason; `reason` is the API
    // alias so the operator doesn't have to know the column
    // name. Both are returned for backwards compat.
    reason: r.notes,
    notes: r.notes,
    reason_category: r.reason_category,
    delta: r.delta == null ? null : Number(r.delta),
    created_at: r.created_at,
    created_by: r.created_by == null ? null : Number(r.created_by),
  }));
}

/**
 * Replenishment report — list every catalog item in the tenant whose
 * total stock is below the operator-defined reorder_point, sorted
 * by shortage (largest gap first). An item with reorder_point=0 is
 * treated as "no replenishment trigger" and never appears in the
 * report.
 *
 * The total stock is summed across all locations (or filtered to a
 * single warehouse via opts.warehouseId). Negative on_hand is
 * clamped to 0 in the shortage math — a customer-delivery that
 * over-delivered (rare, but possible if a stock_quant went
 * negative under a previous bug) shouldn't surface as a phantom
 * positive shortage.
 *
 * Returned shape per item:
 *   {
 *     item_id, sku, name, uom_code,
 *     total_stock, reorder_point, shortage,
 *     by_warehouse: [{ warehouse_id, warehouse_code, warehouse_name, stock }],
 *   }
 */
export async function getReplenishmentReport(db, tenantId = 0, opts = {}) {
  const warehouseId = opts.warehouseId != null ? Number(opts.warehouseId) : null;

  // 1. All non-archived items in the tenant that have a non-zero
  //    reorder_point (zero means "no trigger"). The total stock
  //    is computed in a single LEFT JOIN aggregate so we don't
  //    do a per-item query.
  const itemsRes = await runQuery(
    db,
    `SELECT ci.id, ci.sku, ci.name, ci.uom_code, ci.reorder_point,
            COALESCE(SUM(CASE WHEN sq.id IS NOT NULL THEN sq.quantity ELSE 0 END), 0) AS total_stock
       FROM finance.catalog_items ci
       LEFT JOIN finance.stock_quants sq
         ON sq.tenant_id = ci.tenant_id AND sq.catalog_item_id = ci.id
      WHERE ci.tenant_id = $1
        AND ci.archived = 0
        AND ci.reorder_point > 0
        ${warehouseId == null ? '' : 'AND EXISTS (SELECT 1 FROM finance.stock_locations sl2 WHERE sl2.tenant_id = ci.tenant_id AND sl2.warehouse_id = $2 AND sl2.id = sq.location_id)'}
      GROUP BY ci.id
      ORDER BY ci.id`,
    warehouseId == null ? [tenantId] : [tenantId, warehouseId],
  );
  const items = itemsRes.rows || [];
  if (items.length === 0) return [];

  // 2. Filter to items below their reorder_point.
  const below = items
    .map((r) => ({
      item_id: Number(r.id),
      sku: r.sku,
      name: r.name,
      uom_code: r.uom_code,
      reorder_point: Number(r.reorder_point),
      total_stock: Math.max(0, Number(r.total_stock)),
      shortage: Math.max(0, Number(r.reorder_point) - Math.max(0, Number(r.total_stock))),
    }))
    .filter((row) => row.shortage > 0);
  if (below.length === 0) return [];

  // 3. Per-warehouse breakdown for each below-threshold item. The
  //    breakdown uses the same LEFT JOIN pattern so a single SQL
  //    call returns all rows.
  const itemIds = below.map((r) => r.item_id);
  const placeholders = itemIds.map((_, i) => `$${i + 1}`).join(',');
  const breakdownRes = await runQuery(
    db,
    `SELECT sq.catalog_item_id, w.id AS warehouse_id, w.code, w.name,
            COALESCE(SUM(sq.quantity), 0) AS stock
       FROM finance.warehouses w
       LEFT JOIN finance.stock_locations sl
         ON sl.tenant_id = w.tenant_id AND sl.warehouse_id = w.id
       LEFT JOIN finance.stock_quants sq
         ON sq.tenant_id = sl.tenant_id AND sq.location_id = sl.id
            AND sq.catalog_item_id IN (${placeholders})
      WHERE w.tenant_id = $${itemIds.length + 1} AND w.archived = 0
      ${warehouseId == null ? '' : `AND w.id = $${itemIds.length + 2}`}
      GROUP BY w.id, sq.catalog_item_id
      ORDER BY w.id`,
    warehouseId == null ? [...itemIds, tenantId] : [...itemIds, tenantId, warehouseId],
  );
  const byItem = new Map();
  for (const r of breakdownRes.rows || []) {
    const itemId = r.catalog_item_id == null ? null : Number(r.catalog_item_id);
    if (itemId == null) continue;
    if (!byItem.has(itemId)) byItem.set(itemId, []);
    byItem.get(itemId).push({
      warehouse_id: Number(r.warehouse_id),
      warehouse_code: r.code,
      warehouse_name: r.name,
      stock: Math.max(0, Number(r.stock)),
    });
  }
  // Sort by shortage desc (largest gap first) so the operator
  // sees the most-urgent item at the top of the list.
  below.sort((a, b) => b.shortage - a.shortage);
  for (const row of below) {
    row.by_warehouse = byItem.get(row.item_id) || [];
  }
  return below;
}
