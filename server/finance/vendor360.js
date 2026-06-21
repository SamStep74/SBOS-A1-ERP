// server/finance/vendor360.js
//
// CFO-facing "360 view" of a vendor: the basic info + every open
// purchase order (with total + outstanding) + recent receipts +
// totals + aging buckets. Mirror of customer360.js (Wave 31) for
// the supply side.
//
// Wave 33: the pure function. The HTTP layer (route + perm gate
// + tenant middleware + smoke) is the same pattern Wave 32 used
// for customer 360.
//
// Tenant scope: every read threads `tenantId` through the
// underlying `getVendor` / `listPurchaseOrders` calls. A
// cross-tenant id returns `null` from `getVendor` (the existing
// pattern), which we surface as a `ValueError` so the route
// layer returns 404 (no existence-oracle leak between tenants).
//
// Open POs: status in ('rfq', 'confirmed', 'partial', 'received').
// Billed POs (status='billed') fall out — their AP exposure lives
// in the vendor_bills table, not the PO. The "outstanding" amount
// for a bill is a follow-up (a separate listBillsForVendor helper);
// for Wave 33 the PO total is what we surface.
//
// Aging: keyed on `expected_date` (when we expect to receive the
// goods). POs that are already fully received fall into the
// "current" bucket (the operator has everything they need).
//
// All SQL stays in here — no string-concat, no eval, every query
// uses parameterized placeholders.

import { getVendor, listPurchaseOrders, ValueError as PurchaseValueError } from './purchase.js';
import { runQuery } from './_pgStyle.js';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// Re-export the purchase.js ValueError so callers + tests can
// `import { ValueError } from './vendor360.js'` regardless of
// which module's error fires.
export { PurchaseValueError };

// ────────────────────────────────────────────────────────────────────────
// Aging bucket boundaries. Same as customer360 — the bucket is
// keyed on days past the deadline. For vendors, the deadline is
// `expected_date` (when we expect to receive the goods).
//
//   current       — expected_date >= today  (not yet due)
//   days_1_30     —  1 ≤ d ≤ 30
//   days_31_60    — 31 ≤ d ≤ 60
//   days_61_90    — 61 ≤ d ≤ 90
//   days_90_plus  — d > 90
// ────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseISODate(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function diffDays(fromISO, toISO) {
  const a = parseISODate(fromISO);
  const b = parseISODate(toISO);
  if (a === null || b === null) return 0;
  return Math.floor((a - b) / MS_PER_DAY);
}

function agingBucket(daysOverdue) {
  if (daysOverdue <= 0) return 'current';
  if (daysOverdue <= 30) return 'days_1_30';
  if (daysOverdue <= 60) return 'days_31_60';
  if (daysOverdue <= 90) return 'days_61_90';
  return 'days_90_plus';
}

// ────────────────────────────────────────────────────────────────────────
// Internal: sum the line items for a PO. Each line has
// quantity * unit_cost. Returns a positive integer (the PO total
// in AMD, the local currency).
// ────────────────────────────────────────────────────────────────────────

async function sumPOLines(db, orderId, tenantId) {
  const result = await runQuery(
    db,
    `SELECT COALESCE(SUM(quantity * unit_cost), 0)::bigint AS total_amd
       FROM purchase_order_lines
      WHERE tenant_id = $1 AND order_id = $2`,
    [tenantId, orderId],
  );
  const raw = result.rows && result.rows[0] ? result.rows[0].total_amd : 0;
  return Number(raw);
}

// ────────────────────────────────────────────────────────────────────────
// getVendor360 — the public API.
//
// Args:
//   db          — duck-typed DB
//   vendorId    — positive integer
//   tenantId    — non-negative integer
//   opts        — { today?: 'YYYY-MM-DD', recentReceiptsLimit?: number }
//
// Returns the full 360 view. Throws ValueError on missing or
// cross-tenant vendor (route layer maps to 404).
// ────────────────────────────────────────────────────────────────────────

export async function getVendor360(db, vendorId, tenantId = 0, opts = {}) {
  if (!Number.isInteger(vendorId) || vendorId <= 0) {
    throw new ValueError(`vendorId must be a positive integer (got ${String(vendorId)})`);
  }
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError(`tenantId must be a non-negative integer (got ${String(tenantId)})`);
  }

  const today = opts.today || new Date().toISOString().slice(0, 10);
  const recentLimit = Math.min(
    Math.max(Number(opts.recentReceiptsLimit) || 10, 1),
    100,
  );

  // 1. Vendor itself. null → missing or cross-tenant, both
  //    surface as ValueError so the route layer returns 404
  //    (no existence-oracle leak between tenants).
  const vendor = await getVendor(db, vendorId, tenantId);
  if (!vendor) {
    throw new ValueError(`vendor ${vendorId} not found in tenant ${tenantId}`);
  }

  // 2. All POs for this vendor. listPurchaseOrders already takes
  //    a { vendorId, status } filter; we ask for all statuses
  //    (the open-vs-closed filter happens client-side).
  const allPOs = await listPurchaseOrders(db, tenantId, { vendorId });

  // 3. Open = any non-cancelled, non-billed PO. Billed falls out
  //    (its AP exposure lives in vendor_bills). Cancelled falls
  //    out (no outstanding).
  const openRows = allPOs.filter(
    (po) => po.status !== 'billed' && po.status !== 'cancelled',
  );

  // 4. For each open PO, sum the line items. Promise.all parallel.
  const openPOs = await Promise.all(
    openRows.map(async (po) => {
      const total_amd = await sumPOLines(db, po.id, tenantId);
      const expectedDate = po.expected_date;
      const daysOverdue = Math.max(0, diffDays(today, expectedDate));
      return {
        id: Number(po.id),
        order_number: po.order_number,
        order_date: po.order_date,
        expected_date: expectedDate,
        status: po.status,
        total_amd,
        // For a non-billed PO, the full amount is "outstanding"
        // (we still owe the vendor if/when the goods arrive + get
        // billed). For a partial receipt, the operator usually
        // expects another delivery; we surface the full total
        // here and let the user drill into the PO for the
        // receipt history. The bill-level outstanding (after
        // billing) is a follow-up.
        outstanding_amd: total_amd,
        days_overdue: daysOverdue,
      };
    }),
  );

  // Sort by expected_date ASC (most urgent first); same date → id
  // ASC for stable ordering.
  openPOs.sort((a, b) => {
    if (a.expected_date !== b.expected_date) return a.expected_date < b.expected_date ? -1 : 1;
    return a.id - b.id;
  });

  // 5. Recent receipts. To avoid a listReceiptsForVendor SQL-level
  //    helper (a pg-vs-sqlite adapter refactor), iterate the most
  //    recent 10 POs and collect their receipts directly via a
  //    scoped query. Bounded N+1 (10 readReceipts queries). Top
  //    N by received_at DESC.
  const recentPOIds = allPOs
    .slice()
    .sort((a, b) => {
      if (a.order_date !== b.order_date) return a.order_date < b.order_date ? 1 : -1;
      return Number(b.id) - Number(a.id);
    })
    .slice(0, 10)
    .map((po) => Number(po.id));

  const recentReceipts = [];
  for (const poId of recentPOIds) {
    const po = allPOs.find((p) => Number(p.id) === poId);
    const r = await runQuery(
      db,
      `SELECT pr.id, pr.order_id, pr.receipt_number, pr.received_at, pr.notes,
              pr.created_at
         FROM purchase_receipts pr
        WHERE pr.tenant_id = $1 AND pr.order_id = $2
        ORDER BY pr.received_at DESC, pr.id DESC`,
      [tenantId, poId],
    );
    for (const row of (r.rows || [])) {
      recentReceipts.push({
        id: Number(row.id),
        purchase_order_id: Number(row.order_id),
        order_number: po ? po.order_number : null,
        receipt_number: row.receipt_number,
        received_at: row.received_at,
        notes: row.notes || null,
      });
    }
  }
  recentReceipts.sort((a, b) => (a.received_at < b.received_at ? 1 : a.received_at > b.received_at ? -1 : 0));
  const topReceipts = recentReceipts.slice(0, recentLimit);

  // 6. Totals.
  let openCount = openPOs.length;
  let openTotalAmd = 0;
  let outstandingAmd = 0;
  for (const po of openPOs) {
    openTotalAmd += po.total_amd;
    outstandingAmd += po.outstanding_amd;
  }

  // 7. Aging buckets — keyed on outstanding_amd for POs that
  //    haven't been received yet. POs with status='received' or
  //    'billed' (the latter is excluded) don't go into overdue
  //    buckets because the operator already has the goods.
  const aging = {
    current: 0,
    days_1_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_90_plus: 0,
  };
  for (const po of openPOs) {
    if (po.status === 'received' || po.status === 'billed') continue;
    if (po.outstanding_amd <= 0) continue;
    const bucket = agingBucket(po.days_overdue);
    aging[bucket] += po.outstanding_amd;
  }

  return {
    vendor: {
      id: vendor.id,
      code: vendor.code,
      name: vendor.name,
      hvhh: vendor.hvhh,
      address: vendor.address,
      email: vendor.email,
      phone: vendor.phone,
      contact_name: vendor.contact_name,
      tenant_id: vendor.tenant_id,
    },
    open_purchase_orders: openPOs,
    recent_receipts: topReceipts,
    totals: {
      open_count: openCount,
      open_total_amd: openTotalAmd,
      outstanding_amd: outstandingAmd,
    },
    aging,
  };
}

// Re-export the internal helpers for tests that want to exercise
// them directly. Not part of the public surface.
export const __internals = Object.freeze({
  MS_PER_DAY,
  parseISODate,
  diffDays,
  agingBucket,
  sumPOLines,
});
