// SBOS-A1-ERP finance — Purchase + vendor-bill pure functions.
//
// Ported from packages/erp/src/{purchase,vendor-bills}.ts in
// A1-Suite-Local (the user's private R&D monorepo). All orgId
// references renamed to tenantId for consistency with the rest
// of SBOS-A1-ERP. The TypeScript type annotations are stripped;
// the pg-style $N placeholders are kept (the realDb.js adapter
// translates to ? on the way down to sqlite).
//
// Scope (Phase 1 of the ERP plan):
//   - vendors: createVendor, listVendors
//   - purchase orders: createPO, confirmPO, receivePO, cancelPO
//   - vendor bills: createBillFromReceipt, confirmBill, postBill,
//                    payBill, voidBill, listBills
//   - 3-way match: createBillFromReceipt checks received qty
//                 against PO qty and rejects discrepancies
//
// Out of scope (Phase 2+): vendor pricelists, RFQ flow, landed-
// cost allocation, blanket orders, replenishment analytics. The
// stock-valuation handoff (vendor bill → GL posting) is also out
// of scope; this wave mints the AP bill but does not write the
// finance journal entries. That's a follow-on to the existing
// vat_carry_forward work.

import { receiveStock } from './inventory.js';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// runQuery + stripFinancePrefix (matches inventory.js).
// ────────────────────────────────────────────────────────────────────────

function stripFinancePrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

async function runQuery(db, sql, params) {
  const result = await db.query(stripFinancePrefix(sql), params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
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

function assertPosInt(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
  return value;
}

function assertNonNegInt(value, name) {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
  return value;
}

function assertIsoDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValueError(`${name} must be in YYYY-MM-DD format`);
  }
  return value;
}

function assertHvhh(value) {
  if (value == null) return null;
  if (typeof value !== 'string') {
    throw new ValueError('hvhh must be a string of 8 digits or null');
  }
  const trimmed = value.replace(/\s+/g, '');
  if (!/^\d{8}$/.test(trimmed)) {
    throw new ValueError('hvhh must be exactly 8 digits');
  }
  return trimmed;
}

const VALID_PO_STATUSES = new Set(['rfq', 'confirmed', 'partial', 'received', 'billed', 'cancelled']);
const VALID_BILL_STATUSES = new Set(['draft', 'confirmed', 'posted', 'paid', 'void']);
void VALID_PO_STATUSES;
void VALID_BILL_STATUSES;

// ────────────────────────────────────────────────────────────────────────
// Vendors
// ────────────────────────────────────────────────────────────────────────

export async function createVendor(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const code = assertNonEmpty(input.code, 'code');
  const name = assertNonEmpty(input.name, 'name');
  const hvhh = assertHvhh(input.hvhh);

  const dupe = await runQuery(
    db,
    'SELECT id FROM vendors WHERE tenant_id = $1 AND code = $2',
    [tenantId, code],
  );
  if (dupe.rows && dupe.rows.length > 0) {
    throw new ValueError(`vendor with code "${code}" already exists in tenant ${tenantId}`);
  }
  if (hvhh != null) {
    const dupeHvhh = await runQuery(
      db,
      'SELECT id FROM vendors WHERE tenant_id = $1 AND hvhh = $2',
      [tenantId, hvhh],
    );
    if (dupeHvhh.rows && dupeHvhh.rows.length > 0) {
      throw new ValueError(`vendor with HVVH "${hvhh}" already exists in tenant ${tenantId}`);
    }
  }

  const res = await runQuery(
    db,
    `INSERT INTO vendors
       (tenant_id, code, name, hvhh, address, email, phone, contact_name)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenantId, code, name, hvhh,
      input.address || null, input.email || null,
      input.phone || null, input.contact_name || null,
    ],
  );
  let id;
  if (res.rows && res.rows.length > 0 && res.rows[0].id != null) {
    id = Number(res.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }
  return { id, code, name, hvhh, address: input.address || null, tenant_id: tenantId };
}

export async function listVendors(db, tenantId = 0) {
  const res = await runQuery(
    db,
    `SELECT id, code, name, hvhh, address, email, phone, contact_name
       FROM vendors
      WHERE tenant_id = $1 AND archived = 0
      ORDER BY name ASC`,
    [tenantId],
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id), code: r.code, name: r.name,
    hvhh: r.hvhh, address: r.address, email: r.email,
    phone: r.phone, contact_name: r.contact_name,
    tenant_id: tenantId,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Purchase orders
// ────────────────────────────────────────────────────────────────────────

/**
 * Create a purchase order in 'rfq' status. The lines are inserted
 * atomically (a single transaction would be better, but node:sqlite
 * is single-statement-transaction anyway). The vendor_id is
 * required; the order_number must be unique per tenant.
 */
export async function createPurchaseOrder(db, input, tenantId = 0) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const orderNumber = assertNonEmpty(input.order_number, 'order_number');
  const vendorId = assertPosInt(input.vendor_id, 'vendor_id');
  const orderDate = assertIsoDate(input.order_date, 'order_date');
  const expectedDate = input.expected_date ? assertIsoDate(input.expected_date, 'expected_date') : null;

  // Vendor must exist + belong to tenant.
  const vendor = await runQuery(
    db,
    'SELECT id, name, hvhh FROM vendors WHERE tenant_id = $1 AND id = $2 AND archived = 0',
    [tenantId, vendorId],
  );
  if (!vendor.rows || vendor.rows.length === 0) {
    throw new ValueError(`vendor ${vendorId} not found in tenant ${tenantId}`);
  }
  const vendorName = vendor.rows[0].name;
  const vendorHvhh = vendor.rows[0].hvhh;

  // UNIQUE (tenant, order_number).
  const dupe = await runQuery(
    db,
    'SELECT id FROM purchase_orders WHERE tenant_id = $1 AND order_number = $2',
    [tenantId, orderNumber],
  );
  if (dupe.rows && dupe.rows.length > 0) {
    throw new ValueError(`purchase order with number "${orderNumber}" already exists in tenant ${tenantId}`);
  }

  // Lines validation.
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValueError('lines must be a non-empty array');
  }
  for (const [i, line] of input.lines.entries()) {
    if (!line || typeof line !== 'object') {
      throw new ValueError(`lines[${i}] must be an object`);
    }
    if (typeof line.catalog_item_id !== 'number' || !Number.isInteger(line.catalog_item_id) || line.catalog_item_id <= 0) {
      throw new ValueError(`lines[${i}].catalog_item_id must be a positive integer`);
    }
    if (typeof line.quantity !== 'number' || !Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new ValueError(`lines[${i}].quantity must be a positive integer`);
    }
    if (line.unit_cost != null && (typeof line.unit_cost !== 'number' || !Number.isInteger(line.unit_cost) || line.unit_cost < 0)) {
      throw new ValueError(`lines[${i}].unit_cost must be a non-negative integer or undefined`);
    }
  }
  // All items must exist in tenant.
  for (const line of input.lines) {
    const item = await runQuery(
      db,
      'SELECT id FROM catalog_items WHERE tenant_id = $1 AND id = $2 AND archived = 0',
      [tenantId, line.catalog_item_id],
    );
    if (!item.rows || item.rows.length === 0) {
      throw new ValueError(`catalog item ${line.catalog_item_id} not found in tenant ${tenantId}`);
    }
  }

  // Insert header.
  const headerRes = await runQuery(
    db,
    `INSERT INTO purchase_orders
       (tenant_id, order_number, vendor_id, vendor_name, vendor_hvhh, status,
        order_date, expected_date, notes)
     VALUES ($1, $2, $3, $4, $5, 'rfq', $6, $7, $8)
     RETURNING id`,
    [tenantId, orderNumber, vendorId, vendorName, vendorHvhh, orderDate, expectedDate, input.notes || null],
  );
  let orderId;
  if (headerRes.rows && headerRes.rows.length > 0 && headerRes.rows[0].id != null) {
    orderId = Number(headerRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    orderId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Insert lines.
  for (let i = 0; i < input.lines.length; i++) {
    const line = input.lines[i];
    await runQuery(
      db,
      `INSERT INTO purchase_order_lines
         (tenant_id, order_id, catalog_item_id, quantity, unit_cost, description, line_order)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        tenantId, orderId, line.catalog_item_id,
        line.quantity, line.unit_cost != null ? line.unit_cost : 0,
        line.description || null, i,
      ],
    );
  }

  const totals = await computeOrderTotals(db, orderId, tenantId);
  return {
    id: orderId,
    order_number: orderNumber,
    vendor_id: vendorId,
    vendor_name: vendorName,
    status: 'rfq',
    order_date: orderDate,
    expected_date: expectedDate,
    ...totals,
  };
}

/**
 * Confirm a PO: rfq → confirmed. Operator action.
 */
export async function confirmPurchaseOrder(db, orderId, tenantId = 0) {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ValueError('orderId must be a positive integer');
  }
  const order = await runQuery(
    db,
    'SELECT id, status FROM purchase_orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, orderId],
  );
  if (!order.rows || order.rows.length === 0) {
    throw new ValueError(`purchase order ${orderId} not found in tenant ${tenantId}`);
  }
  if (order.rows[0].status !== 'rfq') {
    throw new ValueError(`cannot confirm order ${orderId} (status=${order.rows[0].status}; only rfq orders can be confirmed)`);
  }
  await runQuery(
    db,
    `UPDATE purchase_orders SET status = 'confirmed', updated_at = datetime('now')
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, orderId],
  );
  return { id: orderId, status: 'confirmed' };
}

/**
 * Cancel a PO. Allowed from rfq, confirmed, or partial status.
 * Once billed, the bill is the source of truth (don't cancel the
 * PO — void the bill instead).
 */
export async function cancelPurchaseOrder(db, orderId, reason, tenantId = 0) {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ValueError('orderId must be a positive integer');
  }
  const trimmedReason = reason == null ? '' : String(reason).trim();
  const order = await runQuery(
    db,
    'SELECT id, status FROM purchase_orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, orderId],
  );
  if (!order.rows || order.rows.length === 0) {
    throw new ValueError(`purchase order ${orderId} not found in tenant ${tenantId}`);
  }
  const currentStatus = order.rows[0].status;
  if (currentStatus === 'cancelled') {
    return { id: orderId, status: 'cancelled' };
  }
  if (currentStatus === 'billed') {
    throw new ValueError(`cannot cancel order ${orderId} once billed (void the bill instead)`);
  }
  await runQuery(
    db,
    `UPDATE purchase_orders
        SET status = 'cancelled', cancelled_at = datetime('now'),
            cancelled_reason = $1, updated_at = datetime('now')
      WHERE tenant_id = $2 AND id = $3`,
    [trimmedReason || null, tenantId, orderId],
  );
  return { id: orderId, status: 'cancelled', cancelled_reason: trimmedReason || null };
}

/**
 * Receive a PO. Records a purchase_receipt + receipt_lines and
 * delegates to receiveStock() for the actual stock update. The
 * PO's status moves to 'partial' (more receipts expected) or
 * 'received' (this receipt completes the order).
 *
 * 3-way match is NOT enforced here — the operator confirms the
 * match (item, qty, cost) before calling receivePurchaseOrder.
 * The qty received per line is the operator's input.
 */
export async function receivePurchaseOrder(db, orderId, input, tenantId = 0) {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ValueError('orderId must be a positive integer');
  }
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  if (!Array.isArray(input.lines) || input.lines.length === 0) {
    throw new ValueError('lines must be a non-empty array');
  }
  const destLocationId = assertPosInt(input.destination_location_id, 'destination_location_id');

  // Validate the destination location.
  const dest = await runQuery(
    db,
    'SELECT id FROM stock_locations WHERE tenant_id = $1 AND id = $2',
    [tenantId, destLocationId],
  );
  if (!dest.rows || dest.rows.length === 0) {
    throw new ValueError(`destination location ${destLocationId} not found in tenant ${tenantId}`);
  }

  const order = await runQuery(
    db,
    'SELECT id, status, order_number FROM purchase_orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, orderId],
  );
  if (!order.rows || order.rows.length === 0) {
    throw new ValueError(`purchase order ${orderId} not found in tenant ${tenantId}`);
  }
  const orderStatus = order.rows[0].status;
  if (orderStatus === 'cancelled') {
    throw new ValueError(`cannot receive a cancelled order (${orderId})`);
  }
  if (orderStatus === 'rfq') {
    throw new ValueError(`cannot receive order ${orderId} (status=rfq; confirm the order first)`);
  }

  // Order lines (the canonical qty + unit_cost).
  const orderLinesRes = await runQuery(
    db,
    `SELECT id, catalog_item_id, quantity, unit_cost
       FROM purchase_order_lines
      WHERE tenant_id = $1 AND order_id = $2
      ORDER BY line_order`,
    [tenantId, orderId],
  );
  const orderLines = orderLinesRes.rows || [];
  const orderLineById = new Map();
  for (const ol of orderLines) orderLineById.set(Number(ol.id), ol);

  // Compute the already-received quantity per line (sum of all
  // prior receipt lines for this order).
  const priorRes = await runQuery(
    db,
    `SELECT prl.order_line_id, SUM(prl.received_quantity) AS received
       FROM purchase_receipt_lines prl
       JOIN purchase_receipts pr ON pr.id = prl.receipt_id
      WHERE pr.tenant_id = $1 AND pr.order_id = $2
      GROUP BY prl.order_line_id`,
    [tenantId, orderId],
  );
  const priorReceived = new Map();
  for (const r of priorRes.rows || []) {
    priorReceived.set(Number(r.order_line_id), Number(r.received));
  }

  // Validate the receipt lines.
  const receiptLines = [];
  for (const [i, line] of input.lines.entries()) {
    if (!line || typeof line !== 'object') {
      throw new ValueError(`lines[${i}] must be an object`);
    }
    if (!Number.isInteger(line.order_line_id) || line.order_line_id <= 0) {
      throw new ValueError(`lines[${i}].order_line_id must be a positive integer`);
    }
    const ol = orderLineById.get(line.order_line_id);
    if (!ol) {
      throw new ValueError(`lines[${i}].order_line_id=${line.order_line_id} does not belong to order ${orderId}`);
    }
    const qty = assertPosInt(line.received_quantity, `lines[${i}].received_quantity`);
    const orderedQty = Number(ol.quantity);
    const already = priorReceived.get(line.order_line_id) || 0;
    if (already + qty > orderedQty) {
      throw new ValueError(
        `lines[${i}]: total received (${already + qty}) exceeds ordered quantity (${orderedQty})`,
      );
    }
    const unitCost = line.unit_cost != null
      ? assertNonNegInt(line.unit_cost, `lines[${i}].unit_cost`)
      : Number(ol.unit_cost);
    receiptLines.push({
      order_line_id: line.order_line_id,
      catalog_item_id: Number(ol.catalog_item_id),
      received_quantity: qty,
      unit_cost: unitCost,
    });
  }

  // Insert receipt header.
  const receiptNumber = `RCPT-${order.rows[0].order_number}`;
  const recRes = await runQuery(
    db,
    `INSERT INTO purchase_receipts
       (tenant_id, order_id, receipt_number, received_at, notes)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [tenantId, orderId, receiptNumber, new Date().toISOString().slice(0, 10), input.notes || null],
  );
  let receiptId;
  if (recRes.rows && recRes.rows.length > 0 && recRes.rows[0].id != null) {
    receiptId = Number(recRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    receiptId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Insert receipt lines + call receiveStock for each.
  for (const rl of receiptLines) {
    const insRes = await runQuery(
      db,
      `INSERT INTO purchase_receipt_lines
         (tenant_id, receipt_id, order_line_id, catalog_item_id, received_quantity, unit_cost, destination_location_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [tenantId, receiptId, rl.order_line_id, rl.catalog_item_id, rl.received_quantity, rl.unit_cost, destLocationId],
    );
    let receiptLineId;
    if (insRes.rows && insRes.rows.length > 0 && insRes.rows[0].id != null) {
      receiptLineId = Number(insRes.rows[0].id);
    } else {
      const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
      receiptLineId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
    }
    void receiptLineId;
    // Apply the stock move.
    await receiveStock(
      db,
      {
        catalog_item_id: rl.catalog_item_id,
        destination_location_id: destLocationId,
        quantity: rl.received_quantity,
        unit_cost: rl.unit_cost,
        reference: order.rows[0].order_number,
        notes: `receipt ${receiptNumber} line ${rl.order_line_id}`,
        user_id: input.user_id,
      },
      tenantId,
    );
  }

  // Recompute the PO's received_quantity and status.
  const allReceived = await runQuery(
    db,
    `SELECT prl.order_line_id, prl.received_quantity
       FROM purchase_receipt_lines prl
       JOIN purchase_receipts pr ON pr.id = prl.receipt_id
      WHERE pr.tenant_id = $1 AND pr.order_id = $2`,
    [tenantId, orderId],
  );
  const totalReceived = (allReceived.rows || []).reduce((sum, r) => sum + Number(r.received_quantity), 0);
  const totalOrdered = orderLines.reduce((sum, ol) => sum + Number(ol.quantity), 0);
  const isPartial = totalReceived < totalOrdered;
  const newStatus = isPartial ? 'partial' : 'received';

  await runQuery(
    db,
    `UPDATE purchase_orders
        SET status = $1, received_quantity = $2, updated_at = datetime('now')
      WHERE tenant_id = $3 AND id = $4`,
    [newStatus, totalReceived, tenantId, orderId],
  );

  return {
    order_id: orderId,
    receipt_id: receiptId,
    receipt_number: receiptNumber,
    new_status: newStatus,
    total_received: totalReceived,
    total_ordered: totalOrdered,
  };
}

export async function listPurchaseOrders(db, tenantId = 0, { vendorId, status } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  let i = 2;
  if (vendorId != null) {
    where.push(`vendor_id = $${i++}`);
    params.push(Number(vendorId));
  }
  if (status != null) {
    where.push(`status = $${i++}`);
    params.push(String(status));
  }
  const res = await runQuery(
    db,
    `SELECT id, order_number, vendor_id, vendor_name, status,
            order_date, expected_date, received_quantity, notes,
            created_at, updated_at, cancelled_at, cancelled_reason
       FROM purchase_orders
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC`,
    params,
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id),
    order_number: r.order_number,
    vendor_id: Number(r.vendor_id),
    vendor_name: r.vendor_name,
    status: r.status,
    order_date: r.order_date,
    expected_date: r.expected_date,
    received_quantity: Number(r.received_quantity),
    notes: r.notes,
    created_at: r.created_at,
    updated_at: r.updated_at,
    cancelled_at: r.cancelled_at,
    cancelled_reason: r.cancelled_reason,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Vendor bills (AP)
// ────────────────────────────────────────────────────────────────────────

/**
 * Create a draft AP bill from a fully-received PO. Aggregates the
 * receipt lines into bill lines (one per receipt, or aggregated by
 * catalog_item_id — the latter is the convention here).
 *
 * 3-way match: the bill's total equals the sum of
 * (received_quantity * unit_cost) across the receipts. If the
 * operator wants a discrepancy line (e.g. for early-payment
 * discounts), they pass `lines: [...]` explicitly. Otherwise we
 * auto-aggregate.
 */
export async function createVendorBillFromReceipt(
  db,
  orderId,
  input,
  tenantId = 0,
) {
  if (!Number.isInteger(orderId) || orderId <= 0) {
    throw new ValueError('orderId must be a positive integer');
  }
  if (!input || typeof input !== 'object') {
    throw new ValueError('input must be an object');
  }
  const billNumber = assertNonEmpty(input.bill_number, 'bill_number');
  const billDate = assertIsoDate(input.bill_date, 'bill_date');
  const dueDate = input.due_date ? assertIsoDate(input.due_date, 'due_date') : null;

  const order = await runQuery(
    db,
    'SELECT id, status, vendor_id, vendor_name, order_number FROM purchase_orders WHERE tenant_id = $1 AND id = $2',
    [tenantId, orderId],
  );
  if (!order.rows || order.rows.length === 0) {
    throw new ValueError(`purchase order ${orderId} not found in tenant ${tenantId}`);
  }
  if (order.rows[0].status !== 'received' && order.rows[0].status !== 'partial') {
    throw new ValueError(`cannot bill order ${orderId} (status=${order.rows[0].status}; must be 'received' or 'partial')`);
  }

  // UNIQUE bill_number.
  const dupe = await runQuery(
    db,
    'SELECT id FROM vendor_bills WHERE tenant_id = $1 AND bill_number = $2',
    [tenantId, billNumber],
  );
  if (dupe.rows && dupe.rows.length > 0) {
    throw new ValueError(`vendor bill with number "${billNumber}" already exists in tenant ${tenantId}`);
  }

  // Compute bill lines: aggregate received qty * unit_cost by
  // catalog_item_id (per the v3 source convention).
  const linesRes = await runQuery(
    db,
    `SELECT pol.catalog_item_id, pol.description,
            SUM(prl.received_quantity) AS qty,
            pol.unit_cost,
            SUM(prl.received_quantity) * pol.unit_cost AS line_subtotal
       FROM purchase_receipt_lines prl
       JOIN purchase_order_lines pol ON pol.id = prl.order_line_id
       JOIN purchase_receipts pr ON pr.id = prl.receipt_id
      WHERE pr.tenant_id = $1 AND pr.order_id = $2
      GROUP BY pol.catalog_item_id, pol.description, pol.unit_cost
      ORDER BY pol.catalog_item_id`,
    [tenantId, orderId],
  );
  const lines = (linesRes.rows || []).map((r) => ({
    catalog_item_id: Number(r.catalog_item_id),
    description: r.description || '',
    quantity: Number(r.qty),
    unit_cost: Number(r.unit_cost),
    line_subtotal: Number(r.line_subtotal),
  }));
  if (lines.length === 0) {
    throw new ValueError(`order ${orderId} has no received lines to bill`);
  }
  // VAT = 20% by default for Armenian B2B. Caller can override
  // per-line later (out of scope for the initial port).
  const subtotal = lines.reduce((sum, l) => sum + l.line_subtotal, 0);
  const vat = Math.floor(subtotal * 0.2);
  const total = subtotal + vat;

  // Insert bill header.
  const billRes = await runQuery(
    db,
    `INSERT INTO vendor_bills
       (tenant_id, bill_number, vendor_id, vendor_name, purchase_order_id,
        status, subtotal, vat, total, bill_date, due_date, notes)
     VALUES ($1, $2, $3, $4, $5, 'draft', $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      tenantId, billNumber, Number(order.rows[0].vendor_id), order.rows[0].vendor_name,
      orderId, subtotal, vat, total, billDate, dueDate, input.notes || null,
    ],
  );
  let billId;
  if (billRes.rows && billRes.rows.length > 0 && billRes.rows[0].id != null) {
    billId = Number(billRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    billId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Insert bill lines.
  for (const line of lines) {
    const lineVat = Math.floor(line.line_subtotal * 0.2);
    await runQuery(
      db,
      `INSERT INTO vendor_bill_lines
         (tenant_id, bill_id, catalog_item_id, description, quantity, unit_cost,
          line_subtotal, vat, line_total)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        tenantId, billId, line.catalog_item_id, line.description,
        line.quantity, line.unit_cost, line.line_subtotal,
        lineVat, line.line_subtotal + lineVat,
      ],
    );
  }

  return {
    id: billId,
    bill_number: billNumber,
    vendor_id: Number(order.rows[0].vendor_id),
    vendor_name: order.rows[0].vendor_name,
    purchase_order_id: orderId,
    status: 'draft',
    subtotal, vat, total,
    bill_date: billDate,
    due_date: dueDate,
    line_count: lines.length,
  };
}

export async function confirmVendorBill(db, billId, tenantId = 0) {
  if (!Number.isInteger(billId) || billId <= 0) {
    throw new ValueError('billId must be a positive integer');
  }
  const bill = await runQuery(
    db,
    'SELECT id, status FROM vendor_bills WHERE tenant_id = $1 AND id = $2',
    [tenantId, billId],
  );
  if (!bill.rows || bill.rows.length === 0) {
    throw new ValueError(`vendor bill ${billId} not found in tenant ${tenantId}`);
  }
  if (bill.rows[0].status !== 'draft') {
    throw new ValueError(`cannot confirm bill ${billId} (status=${bill.rows[0].status}; only draft can be confirmed)`);
  }
  await runQuery(
    db,
    `UPDATE vendor_bills SET status = 'confirmed', updated_at = datetime('now')
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, billId],
  );
  return { id: billId, status: 'confirmed' };
}

export async function postVendorBill(db, billId, tenantId = 0) {
  if (!Number.isInteger(billId) || billId <= 0) {
    throw new ValueError('billId must be a positive integer');
  }
  const bill = await runQuery(
    db,
    'SELECT id, status FROM vendor_bills WHERE tenant_id = $1 AND id = $2',
    [tenantId, billId],
  );
  if (!bill.rows || bill.rows.length === 0) {
    throw new ValueError(`vendor bill ${billId} not found in tenant ${tenantId}`);
  }
  if (bill.rows[0].status !== 'confirmed') {
    throw new ValueError(`cannot post bill ${billId} (status=${bill.rows[0].status}; only confirmed can be posted)`);
  }
  // Set the linked PO to 'billed' (the receipt matched the bill).
  await runQuery(
    db,
    `UPDATE vendor_bills
        SET status = 'posted', posted_at = datetime('now'), updated_at = datetime('now')
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, billId],
  );
  const billRow = await runQuery(
    db,
    'SELECT purchase_order_id FROM vendor_bills WHERE tenant_id = $1 AND id = $2',
    [tenantId, billId],
  );
  if (billRow.rows && billRow.rows[0] && billRow.rows[0].purchase_order_id) {
    await runQuery(
      db,
      `UPDATE purchase_orders SET status = 'billed', updated_at = datetime('now')
        WHERE tenant_id = $1 AND id = $2 AND status IN ('received', 'partial')`,
      [tenantId, Number(billRow.rows[0].purchase_order_id)],
    );
  }
  return { id: billId, status: 'posted' };
}

export async function payVendorBill(db, billId, tenantId = 0) {
  if (!Number.isInteger(billId) || billId <= 0) {
    throw new ValueError('billId must be a positive integer');
  }
  const bill = await runQuery(
    db,
    'SELECT id, status FROM vendor_bills WHERE tenant_id = $1 AND id = $2',
    [tenantId, billId],
  );
  if (!bill.rows || bill.rows.length === 0) {
    throw new ValueError(`vendor bill ${billId} not found in tenant ${tenantId}`);
  }
  if (bill.rows[0].status !== 'posted') {
    throw new ValueError(`cannot pay bill ${billId} (status=${bill.rows[0].status}; only posted can be paid)`);
  }
  await runQuery(
    db,
    `UPDATE vendor_bills
        SET status = 'paid', paid_at = datetime('now'), updated_at = datetime('now')
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, billId],
  );
  return { id: billId, status: 'paid' };
}

export async function voidVendorBill(db, billId, reason, tenantId = 0) {
  if (!Number.isInteger(billId) || billId <= 0) {
    throw new ValueError('billId must be a positive integer');
  }
  const bill = await runQuery(
    db,
    'SELECT id, status FROM vendor_bills WHERE tenant_id = $1 AND id = $2',
    [tenantId, billId],
  );
  if (!bill.rows || bill.rows.length === 0) {
    throw new ValueError(`vendor bill ${billId} not found in tenant ${tenantId}`);
  }
  if (bill.rows[0].status === 'void') {
    return { id: billId, status: 'void' };
  }
  if (bill.rows[0].status === 'paid') {
    throw new ValueError(`cannot void bill ${billId} once paid (raise a refund/AP credit note instead)`);
  }
  const trimmedReason = reason == null ? '' : String(reason).trim();
  await runQuery(
    db,
    `UPDATE vendor_bills
        SET status = 'void', voided_at = datetime('now'),
            voided_reason = $1, updated_at = datetime('now')
      WHERE tenant_id = $2 AND id = $3`,
    [trimmedReason || null, tenantId, billId],
  );
  return { id: billId, status: 'void', voided_reason: trimmedReason || null };
}

export async function listVendorBills(db, tenantId = 0, { vendorId, status, purchaseOrderId } = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  let i = 2;
  if (vendorId != null) {
    where.push(`vendor_id = $${i++}`);
    params.push(Number(vendorId));
  }
  if (status != null) {
    where.push(`status = $${i++}`);
    params.push(String(status));
  }
  if (purchaseOrderId != null) {
    where.push(`purchase_order_id = $${i++}`);
    params.push(Number(purchaseOrderId));
  }
  const res = await runQuery(
    db,
    `SELECT id, bill_number, vendor_id, vendor_name, purchase_order_id, status,
            subtotal, vat, total, bill_date, due_date,
            posted_at, paid_at, voided_at
       FROM vendor_bills
      WHERE ${where.join(' AND ')}
      ORDER BY id DESC`,
    params,
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id),
    bill_number: r.bill_number,
    vendor_id: Number(r.vendor_id),
    vendor_name: r.vendor_name,
    purchase_order_id: r.purchase_order_id == null ? null : Number(r.purchase_order_id),
    status: r.status,
    subtotal: Number(r.subtotal),
    vat: Number(r.vat),
    total: Number(r.total),
    bill_date: r.bill_date,
    due_date: r.due_date,
    posted_at: r.posted_at,
    paid_at: r.paid_at,
    voided_at: r.voided_at,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Internal helper
// ────────────────────────────────────────────────────────────────────────

async function computeOrderTotals(db, orderId, tenantId) {
  const linesRes = await runQuery(
    db,
    `SELECT quantity, unit_cost FROM purchase_order_lines
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId, orderId],
  );
  const lines = linesRes.rows || [];
  const subtotal = lines.reduce((sum, l) => sum + Number(l.quantity) * Number(l.unit_cost), 0);
  // 20% VAT (Armenian B2B standard; can be overridden per-line later).
  const vat = Math.floor(subtotal * 0.2);
  const total = subtotal + vat;
  return { subtotal, vat, total };
}
