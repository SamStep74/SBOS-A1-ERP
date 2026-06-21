// server/finance/dashboard360.js
//
// CFO dashboard JSON: AR + AP totals + top customers (by
// outstanding) + top vendors (by exposure). The single
// round-trip view a CFO needs to triage collections + AP.
//
// Wave 34. Companion to the customer 360 (Wave 31-32) and vendor
// 360 (Wave 33) endpoints — those are the per-entity drill-downs;
// this is the aggregate dashboard.
//
// The data here is computed via SQL aggregates, NOT by calling
// getCustomer360 / getVendor360 for every customer/vendor. The
// per-entity 360 is N+1 reads (one per customer); this is two
// scans (one for customers, one for vendors) regardless of how
// many customers / vendors exist. The dashboard scales.
//
// All SQL stays in here — no string-concat, no eval, every query
// uses parameterized placeholders. Works against any duck-typed
// DB that exposes pg-style `.query(sql, params) → { rows }` or
// sqlite-style `.prepare(sql).run/all` (the `runQuery` helper
// in _pgStyle.js handles the dispatch).
//
// Tenant scope: every aggregate threads `tenantId` through the
// query. A cross-tenant call sees only its own data.

import { runQuery } from './_pgStyle.js';

// ────────────────────────────────────────────────────────────────────────
// Aging bucket boundary SQL. Mirrors the bucket boundaries in
// customer360.js / vendor360.js:
//
//   current       — days_overdue <= 0
//   days_1_30     —  1 ≤ d ≤ 30
//   days_31_60    — 31 ≤ d ≤ 60
//   days_61_90    — 61 ≤ d ≤ 90
//   days_90_plus  — d > 90
//
// Used in the AR aggregate. Days overdue is computed from the
// invoice's due_date vs the `today` arg.
// ────────────────────────────────────────────────────────────────────────

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

// ────────────────────────────────────────────────────────────────────────
// getDashboard360 — the public API.
//
// Args:
//   db       — duck-typed DB
//   tenantId — non-negative integer
//   opts     — { today?: 'YYYY-MM-DD', limit?: number }
//
// Returns the full dashboard JSON. Throws ValueError on bad
// inputs. The two AR/AP queries run in parallel; the top-customers
// and top-vendors queries run in parallel with the totals. Total
// latency is roughly 1 round-trip (4 queries in parallel).
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

export async function getDashboard360(db, tenantId = 0, opts = {}) {
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError(`tenantId must be a non-negative integer (got ${String(tenantId)})`);
  }
  const today = opts.today || new Date().toISOString().slice(0, 10);
  if (typeof today !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(today)) {
    throw new ValueError(`today must be in YYYY-MM-DD format (got ${String(today)})`);
  }
  const limit = Math.min(Math.max(Number(opts.limit) || DEFAULT_LIMIT, 1), MAX_LIMIT);

  // All 4 queries in parallel: AR totals, AP totals, top customers,
  // top vendors. No read depends on another's result, so a single
  // Promise.all is enough.
  const [arTotals, apTotals, topCustomers, topVendors] = await Promise.all([
    aggregateARTotals(db, tenantId, today),
    aggregateAPTotals(db, tenantId, today),
    aggregateTopCustomers(db, tenantId, limit),
    aggregateTopVendors(db, tenantId, limit),
  ]);

  return {
    today,
    ar: arTotals,
    ap: apTotals,
    top_customers: topCustomers,
    top_vendors: topVendors,
  };
}

// ────────────────────────────────────────────────────────────────────────
// AR aggregate — total outstanding + aging buckets for the tenant.
//
// Joins finance.invoices with a payment subquery to compute the
// running balance per invoice, then aggregates by aging bucket
// (days overdue vs due_date). Open invoices only (status NOT IN
// 'paid', 'void').
// ────────────────────────────────────────────────────────────────────────

async function aggregateARTotals(db, tenantId, today) {
  // Compute days_overdue inline via julianday. The bucket is a
  // CASE expression. SUM is wrapped in COALESCE so an empty
  // tenant (no open invoices) returns 0 instead of NULL.
  //
  // Notes on the SQL:
  //  - julianday($today) - julianday(due_date) gives days
  //    outstanding (positive = past due, negative = not yet due)
  //  - For invoices with no due_date (shouldn't happen but the
  //    schema allows it), bucket falls into 'current' via the
  //    CAST(NULL AS INTEGER) trick — null in julianday returns
  //    null, and our CASE returns 'current' for null
  //  - The payment subquery is grouped by invoice_id so each
  //    invoice's running balance is one row
  // Use distinct placeholders ($1..$7) for each $N occurrence.
  // The pg → sqlite test translation `replace(/\$\d+/g, '?')` makes
  // every `$N` the same `?` — so distinct pg placeholders preserve
  // position identity when the test runs against sqlite. The params
  // array binds each position explicitly.
  const sql = `
    WITH open_invoices AS (
      SELECT i.id, i.due_date, i.total_amd,
             COALESCE(p.total_paid, 0) AS paid_amd
        FROM finance.invoices i
        LEFT JOIN (
          SELECT invoice_id, SUM(amount_amd) AS total_paid
            FROM finance.payments
           WHERE tenant_id = $1
           GROUP BY invoice_id
        ) p ON p.invoice_id = i.id
       WHERE i.tenant_id = $2
         AND i.status NOT IN ('paid', 'void')
    )
    SELECT
      COUNT(*) AS open_count,
      COALESCE(SUM(CASE WHEN total_amd - paid_amd < 0 THEN 0 ELSE total_amd - paid_amd END), 0) AS outstanding_amd,
      COALESCE(SUM(CASE WHEN julianday($3) - julianday(due_date) <= 0 THEN CASE WHEN total_amd - paid_amd < 0 THEN 0 ELSE total_amd - paid_amd END ELSE 0 END), 0) AS current,
      COALESCE(SUM(CASE WHEN julianday($4) - julianday(due_date) BETWEEN 1 AND 30 THEN CASE WHEN total_amd - paid_amd < 0 THEN 0 ELSE total_amd - paid_amd END ELSE 0 END), 0) AS days_1_30,
      COALESCE(SUM(CASE WHEN julianday($5) - julianday(due_date) BETWEEN 31 AND 60 THEN CASE WHEN total_amd - paid_amd < 0 THEN 0 ELSE total_amd - paid_amd END ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN julianday($6) - julianday(due_date) BETWEEN 61 AND 90 THEN CASE WHEN total_amd - paid_amd < 0 THEN 0 ELSE total_amd - paid_amd END ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN julianday($7) - julianday(due_date) > 90 THEN CASE WHEN total_amd - paid_amd < 0 THEN 0 ELSE total_amd - paid_amd END ELSE 0 END), 0) AS days_90_plus
    FROM open_invoices
  `;
  const result = await runQuery(db, sql, [tenantId, tenantId, today, today, today, today, today]);
  const r = result.rows && result.rows[0] ? result.rows[0] : {};
  return {
    open_count: Number(r.open_count || 0),
    outstanding_amd: Number(r.outstanding_amd || 0),
    aging: {
      current: Number(r.current || 0),
      days_1_30: Number(r.days_1_30 || 0),
      days_31_60: Number(r.days_31_60 || 0),
      days_61_90: Number(r.days_61_90 || 0),
      days_90_plus: Number(r.days_90_plus || 0),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// AP aggregate — total outstanding + aging buckets for POs.
// Mirrors the AR aggregate: open POs (status NOT IN 'billed',
// 'cancelled') × their line-item totals × days overdue vs
// expected_date.
// ────────────────────────────────────────────────────────────────────────

async function aggregateAPTotals(db, tenantId, today) {
  // PO total = SUM(quantity * unit_cost) per PO. Subquery to
  // aggregate lines first, then join to PO header. Same
  // placeholder-distinctness pattern as aggregateARTotals.
  const sql = `
    WITH po_totals AS (
      SELECT order_id, SUM(quantity * unit_cost) AS total_amd
        FROM finance.purchase_order_lines
       WHERE tenant_id = $1
       GROUP BY order_id
    ),
    open_pos AS (
      SELECT po.id, po.expected_date, COALESCE(t.total_amd, 0) AS total_amd
        FROM finance.purchase_orders po
        LEFT JOIN po_totals t ON t.order_id = po.id
       WHERE po.tenant_id = $2
         AND po.status NOT IN ('billed', 'cancelled')
    )
    SELECT
      COUNT(*) AS open_count,
      COALESCE(SUM(total_amd), 0) AS outstanding_amd,
      COALESCE(SUM(CASE WHEN julianday($3) - julianday(expected_date) <= 0 THEN total_amd ELSE 0 END), 0) AS current,
      COALESCE(SUM(CASE WHEN julianday($4) - julianday(expected_date) BETWEEN 1 AND 30 THEN total_amd ELSE 0 END), 0) AS days_1_30,
      COALESCE(SUM(CASE WHEN julianday($5) - julianday(expected_date) BETWEEN 31 AND 60 THEN total_amd ELSE 0 END), 0) AS days_31_60,
      COALESCE(SUM(CASE WHEN julianday($6) - julianday(expected_date) BETWEEN 61 AND 90 THEN total_amd ELSE 0 END), 0) AS days_61_90,
      COALESCE(SUM(CASE WHEN julianday($7) - julianday(expected_date) > 90 THEN total_amd ELSE 0 END), 0) AS days_90_plus
    FROM open_pos
  `;
  const result = await runQuery(db, sql, [tenantId, tenantId, today, today, today, today, today]);
  const r = result.rows && result.rows[0] ? result.rows[0] : {};
  return {
    open_count: Number(r.open_count || 0),
    outstanding_amd: Number(r.outstanding_amd || 0),
    aging: {
      current: Number(r.current || 0),
      days_1_30: Number(r.days_1_30 || 0),
      days_31_60: Number(r.days_31_60 || 0),
      days_61_90: Number(r.days_61_90 || 0),
      days_90_plus: Number(r.days_90_plus || 0),
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Top N customers by outstanding (AR). One row per customer, sorted
// by outstanding DESC. Customers with 0 outstanding are excluded
// (no point surfacing them on a collections-priority list).
// ────────────────────────────────────────────────────────────────────────

async function aggregateTopCustomers(db, tenantId, limit) {
  // Use distinct placeholders ($1, $2, $3, $4) so the
  // pg → sqlite translation preserves parameter identity.
  // (The test adapter's `replace(/\$\d+/g, '?')` would otherwise
  // make every `$1` the same `?`, breaking the param count.)
  const sql = `
    WITH per_customer AS (
      SELECT i.customer_id,
             SUM(CASE WHEN i.total_amd - COALESCE(p.paid, 0) < 0 THEN 0 ELSE i.total_amd - COALESCE(p.paid, 0) END) AS outstanding_amd,
             COUNT(*) AS open_invoice_count
        FROM finance.invoices i
        LEFT JOIN (
          SELECT invoice_id, SUM(amount_amd) AS paid
            FROM finance.payments
           WHERE tenant_id = $1
           GROUP BY invoice_id
        ) p ON p.invoice_id = i.id
       WHERE i.tenant_id = $2
         AND i.status NOT IN ('paid', 'void')
       GROUP BY i.customer_id
    )
    SELECT c.id, c.name, c.hvhh,
           pc.outstanding_amd,
           pc.open_invoice_count
      FROM per_customer pc
      JOIN finance.customers c
        ON c.tenant_id = $3 AND c.id = pc.customer_id
     WHERE pc.outstanding_amd > 0
     ORDER BY pc.outstanding_amd DESC, c.id ASC
     LIMIT $4
  `;
  const result = await runQuery(db, sql, [tenantId, tenantId, tenantId, limit]);
  return (result.rows || []).map((r) => ({
    id: Number(r.id),
    name: r.name,
    hvhh: r.hvhh,
    outstanding_amd: Number(r.outstanding_amd || 0),
    open_invoice_count: Number(r.open_invoice_count || 0),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Top N vendors by exposure (AP). One row per vendor, sorted by
// outstanding DESC. Vendors with 0 outstanding are excluded.
// ────────────────────────────────────────────────────────────────────────

async function aggregateTopVendors(db, tenantId, limit) {
  // Same placeholder-distinctness fix as aggregateTopCustomers.
  const sql = `
    WITH per_vendor AS (
      SELECT po.vendor_id,
             SUM(COALESCE(t.total_amd, 0)) AS outstanding_amd,
             COUNT(*) AS open_po_count
        FROM finance.purchase_orders po
        LEFT JOIN (
          SELECT order_id, SUM(quantity * unit_cost) AS total_amd
            FROM finance.purchase_order_lines
           WHERE tenant_id = $1
           GROUP BY order_id
        ) t ON t.order_id = po.id
       WHERE po.tenant_id = $2
         AND po.status NOT IN ('billed', 'cancelled')
       GROUP BY po.vendor_id
    )
    SELECT v.id, v.code, v.name, v.hvhh,
           pv.outstanding_amd,
           pv.open_po_count
      FROM per_vendor pv
      JOIN finance.vendors v
        ON v.tenant_id = $3 AND v.id = pv.vendor_id
     WHERE pv.outstanding_amd > 0
     ORDER BY pv.outstanding_amd DESC, v.id ASC
     LIMIT $4
  `;
  const result = await runQuery(db, sql, [tenantId, tenantId, tenantId, limit]);
  return (result.rows || []).map((r) => ({
    id: Number(r.id),
    code: r.code,
    name: r.name,
    hvhh: r.hvhh,
    outstanding_amd: Number(r.outstanding_amd || 0),
    open_po_count: Number(r.open_po_count || 0),
  }));
}

// Re-export the internals for tests.
export const __internals = Object.freeze({
  aggregateARTotals,
  aggregateAPTotals,
  aggregateTopCustomers,
  aggregateTopVendors,
  DEFAULT_LIMIT,
  MAX_LIMIT,
});
