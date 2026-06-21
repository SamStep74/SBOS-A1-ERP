// SBOS-A1-ERP finance reporting module — CFO dashboard queries.
//
// Public API (all functions async, take a duck-type DB; mirror the
// server/finance/invoice.js dispatch contract):
//   getArAging(db, asOfDate)             — AR aging buckets
//   listOverdueInvoices(db, asOfDate, limit?) — past-due invoice list
//   getMonthlyRevenue(db, yearMonth)     — month-summary aggregates
//   getTopCustomers(db, {since, until, limit}) — top-N by gross billed
//   getVatSummary(db, since, until)      — output-VAT rollup
//
// All money is in whole drams (BIGINT AMD). roundAmd from
// server/l10n-am/localization.js enforces the no-float discipline at the
// arithmetic boundary; the report layer adds it back on top of the SQL
// sums to defend against future schemas that store NUMERIC.

import { roundAmd } from '../l10n-am/localization.js';

// ────────────────────────────────────────────────────────────────────────
// Custom error — callers can match by class, not just message.
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// Duck-type DB dispatch — pg-style .query(sql, params) or sqlite-style
// .prepare / .exec. Mirrors server/finance/invoice.js.
// ────────────────────────────────────────────────────────────────────────

function isPgStyle(db) {
  return typeof db.query === 'function';
}

async function runQuery(db, sql, params) {
  if (isPgStyle(db)) {
    return await db.query(sql, params ?? []);
  }
  // sqlite style: every report query is a SELECT, so route through
  // .prepare().all() (the production invoice/payment modules already
  // own the write-path branches).
  const stmt = db.prepare(sql);
  const rows = await stmt.all(...(params ?? []));
  return { rows };
}

// ────────────────────────────────────────────────────────────────────────
// Constants
// ────────────────────────────────────────────────────────────────────────

// Unpaid statuses. Aging / overdue / VAT-paid all operate over this set.
const UNPAID_STATUSES = Object.freeze(['sent', 'overdue']);

// Issued-and-billable statuses (sent + overdue + paid). Used by
// getTopCustomers: drafts are not yet billed to the customer; void
// invoices never were. We exclude both.
const BILLED_STATUSES = Object.freeze(['sent', 'overdue', 'paid']);

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DEFAULT_OVERDUE_LIMIT = 50;
const MAX_OVERDUE_LIMIT = 500;
const DEFAULT_TOP_CUSTOMERS_LIMIT = 10;
const MAX_TOP_CUSTOMERS_LIMIT = 100;

// ────────────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────────────

function assertDate(s, name) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    throw new ValueError(`${name} must be in YYYY-MM-DD format (got ${String(s)})`);
  }
}

function assertYearMonth(s, name) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}$/.test(s)) {
    throw new ValueError(`${name} must be in YYYY-MM format (got ${String(s)})`);
  }
}

function assertLimit(n, name, { defaultVal, maxVal }) {
  // Missing or 0 → use default. Negative / non-integer → reject.
  if (n === undefined || n === null) return defaultVal;
  if (!Number.isInteger(n) || n <= 0) {
    throw new ValueError(`${name} must be a positive integer (got ${String(n)})`);
  }
  return Math.min(n, maxVal);
}

function daysBetween(later, earlier) {
  // Both are 'YYYY-MM-DD' strings. Returns floor((later - earlier) / day).
  // No timezone math: we compare date-strings directly so "2026-06-20" vs
  // "2026-06-10" is exactly 10 days regardless of server tz.
  const a = Date.UTC(
    Number(earlier.slice(0, 4)),
    Number(earlier.slice(5, 7)) - 1,
    Number(earlier.slice(8, 10)),
  );
  const b = Date.UTC(
    Number(later.slice(0, 4)),
    Number(later.slice(5, 7)) - 1,
    Number(later.slice(8, 10)),
  );
  return Math.floor((b - a) / MS_PER_DAY);
}

function monthBounds(yearMonth) {
  // 'YYYY-MM' → ['YYYY-MM-01', last-day-of-month-YYYY-MM']
  const year = Number(yearMonth.slice(0, 4));
  const month = Number(yearMonth.slice(5, 7));
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw new ValueError(`yearMonth must be a real YYYY-MM value (got ${String(yearMonth)})`);
  }
  const first = `${yearMonth}-01`;
  // Day 0 of next month = last day of this month. (Date math: month is 0-indexed.)
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const last = `${yearMonth}-${String(lastDay).padStart(2, '0')}`;
  return { first, last };
}

// ────────────────────────────────────────────────────────────────────────
// Internal: fetch sums and paid-by-invoice map. Single query; works with
// the mock's GROUP BY branch and the real DB's native SQL. Scoped to
// the caller's tenantId so a tenant never sees another tenant's payments.
// ────────────────────────────────────────────────────────────────────────

async function buildPaidByInvoice(db, tenantId) {
  const out = await runQuery(
    db,
    `SELECT invoice_id, SUM(amount_amd) AS paid_amd
     FROM finance.payments
     WHERE tenant_id = $1
     GROUP BY invoice_id`,
    [tenantId],
  );
  const map = new Map();
  for (const row of out.rows || []) {
    map.set(Number(row.invoice_id), Number(row.paid_amd || 0));
  }
  return map;
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Accounts-receivable aging report as of `asOfDate` (YYYY-MM-DD). Buckets
 * unpaid invoices (status IN ('sent', 'overdue')) whose `due_date` is
 * strictly before `asOfDate`:
 *
 *   - 0–30   days past due
 *   - 31–60  days past due
 *   - 61–90  days past due
 *   - 90+    days past due
 *
 * `amount_amd` in each bucket is the sum of OUTSTANDING balances
 * (total_amd - sum of payments). Fully-paid invoices are excluded even
 * if their status hasn't been transitioned to 'paid' yet.
 *
 * @returns {Promise<{
 *   asOfDate: string,
 *   total_outstanding_amd: number,
 *   buckets: {
 *     '0_30':   { invoice_count: number, amount_amd: number },
 *     '31_60':  { invoice_count: number, amount_amd: number },
 *     '61_90':  { invoice_count: number, amount_amd: number },
 *     '90_plus':{ invoice_count: number, amount_amd: number },
 *   }
 * }>}
 */
export async function getArAging(db, asOfDate, tenantId = 0) {
  assertDate(asOfDate, 'asOfDate');

  const invResult = await runQuery(
    db,
    `SELECT id, due_date, total_amd
     FROM finance.invoices
     WHERE tenant_id = $1 AND status IN ($2, $3) AND due_date < $4`,
    [tenantId, UNPAID_STATUSES[0], UNPAID_STATUSES[1], asOfDate],
  );
  const paidByInvoice = await buildPaidByInvoice(db, tenantId);

  const buckets = {
    '0_30': { invoice_count: 0, amount_amd: 0 },
    '31_60': { invoice_count: 0, amount_amd: 0 },
    '61_90': { invoice_count: 0, amount_amd: 0 },
    '90_plus': { invoice_count: 0, amount_amd: 0 },
  };
  let totalRaw = 0;

  for (const inv of invResult.rows || []) {
    const total = Number(inv.total_amd);
    const paid = paidByInvoice.get(Number(inv.id)) || 0;
    const outstanding = total - paid;
    if (outstanding <= 0) continue; // already fully covered, skip

    const days = daysBetween(asOfDate, String(inv.due_date));
    let key;
    if (days <= 30) key = '0_30';
    else if (days <= 60) key = '31_60';
    else if (days <= 90) key = '61_90';
    else key = '90_plus';

    buckets[key].invoice_count += 1;
    buckets[key].amount_amd += outstanding;
    totalRaw += outstanding;
  }

  return {
    asOfDate,
    total_outstanding_amd: roundAmd(totalRaw),
    buckets: {
      '0_30': {
        invoice_count: buckets['0_30'].invoice_count,
        amount_amd: roundAmd(buckets['0_30'].amount_amd),
      },
      '31_60': {
        invoice_count: buckets['31_60'].invoice_count,
        amount_amd: roundAmd(buckets['31_60'].amount_amd),
      },
      '61_90': {
        invoice_count: buckets['61_90'].invoice_count,
        amount_amd: roundAmd(buckets['61_90'].amount_amd),
      },
      '90_plus': {
        invoice_count: buckets['90_plus'].invoice_count,
        amount_amd: roundAmd(buckets['90_plus'].amount_amd),
      },
    },
  };
}

/**
 * List of past-due invoices as of `asOfDate`, sorted by days_overdue DESC
 * (oldest first). Each row carries customer_name, total_amd, paid_amd,
 * balance_amd (= total_amd - paid_amd), and days_overdue. `limit` caps
 * the result count; default 50, max 500.
 *
 * @param {number} [limit=50]
 * @returns {Promise<Array<{
 *   id: number, invoice_number: string, customer_id: number,
 *   customer_name: string, total_amd: number, paid_amd: number,
 *   balance_amd: number, due_date: string, days_overdue: number,
 * }>>}
 */
export async function listOverdueInvoices(
  db,
  asOfDate,
  limit = DEFAULT_OVERDUE_LIMIT,
  tenantId = 0,
) {
  assertDate(asOfDate, 'asOfDate');
  const effectiveLimit = assertLimit(limit, 'limit', {
    defaultVal: DEFAULT_OVERDUE_LIMIT,
    maxVal: MAX_OVERDUE_LIMIT,
  });

  const invResult = await runQuery(
    db,
    `SELECT i.id, i.invoice_number, i.customer_id, i.due_date, i.total_amd,
            c.name AS customer_name
     FROM finance.invoices i
     JOIN finance.customers c ON c.id = i.customer_id
     WHERE i.tenant_id = $1 AND i.status IN ($2, $3) AND i.due_date < $4
     ORDER BY i.due_date ASC`,
    [tenantId, UNPAID_STATUSES[0], UNPAID_STATUSES[1], asOfDate],
  );

  const paidByInvoice = await buildPaidByInvoice(db, tenantId);
  const rows = [];
  for (const inv of invResult.rows || []) {
    const total = Number(inv.total_amd);
    const paid = paidByInvoice.get(Number(inv.id)) || 0;
    const balance = total - paid;
    if (balance <= 0) continue;
    const days = daysBetween(asOfDate, String(inv.due_date));
    rows.push({
      id: Number(inv.id),
      invoice_number: String(inv.invoice_number),
      customer_id: Number(inv.customer_id),
      customer_name: String(inv.customer_name),
      total_amd: roundAmd(total),
      paid_amd: roundAmd(paid),
      balance_amd: roundAmd(balance),
      due_date: String(inv.due_date),
      days_overdue: days,
    });
  }
  // Sort by days_overdue DESC, then by id ASC for stable ties.
  rows.sort((a, b) => {
    if (a.days_overdue !== b.days_overdue) return b.days_overdue - a.days_overdue;
    return a.id - b.id;
  });
  return rows.slice(0, effectiveLimit);
}

/**
 * Revenue summary for a calendar month. `invoiced_amd` is the sum of
 * `total_amd` for invoices whose `issue_date` falls in the month.
 * `collected_amd` is the sum of payments (`payments.paid_at` in the
 * month) attributed to those in-month invoices. `outstanding_amd` is
 * `invoiced_amd - collected_amd` (clamped at 0). `paid_count` is the
 * number of in-month invoices whose cumulative payments now meet or
 * exceed `total_amd`.
 *
 * @param {string} yearMonth 'YYYY-MM' format.
 * @returns {Promise<{
 *   year_month: string,
 *   invoiced_amd: number,
 *   collected_amd: number,
 *   outstanding_amd: number,
 *   invoice_count: number,
 *   paid_count: number,
 * }>}
 */
export async function getMonthlyRevenue(db, yearMonth, tenantId = 0) {
  assertYearMonth(yearMonth, 'yearMonth');
  const { first, last } = monthBounds(yearMonth);

  const invResult = await runQuery(
    db,
    `SELECT id, total_amd
     FROM finance.invoices
     WHERE tenant_id = $1 AND issue_date >= $2 AND issue_date <= $3`,
    [tenantId, first, last],
  );
  const invRows = invResult.rows || [];
  const invoiceIds = invRows.map((r) => Number(r.id));

  let invoiced = 0;
  const idSet = new Set(invoiceIds);
  for (const inv of invRows) invoiced += Number(inv.total_amd);
  invoiced = roundAmd(invoiced);

  // Pull payments whose paid_at falls in the month, then attribute them
  // to their invoices. A payment outside the month is ignored.
  const payResult = await runQuery(
    db,
    `SELECT invoice_id, amount_amd
     FROM finance.payments
     WHERE tenant_id = $1 AND paid_at >= $2 AND paid_at <= $3`,
    [tenantId, `${first}T00:00:00Z`, `${last}T23:59:59Z`],
  );
  let collected = 0;
  for (const p of payResult.rows || []) {
    if (idSet.has(Number(p.invoice_id))) collected += Number(p.amount_amd);
  }
  collected = roundAmd(collected);

  // Fully-paid count: in-month invoice whose total_paid_amd >= total_amd.
  const paidByInvoice = await buildPaidByInvoice(db, tenantId);
  let paidCount = 0;
  for (const inv of invRows) {
    const id = Number(inv.id);
    const total = Number(inv.total_amd);
    const paid = paidByInvoice.get(id) || 0;
    if (paid >= total) paidCount += 1;
  }

  const outstanding = Math.max(0, invoiced - collected);
  return {
    year_month: yearMonth,
    invoiced_amd: invoiced,
    collected_amd: collected,
    outstanding_amd: roundAmd(outstanding),
    invoice_count: invRows.length,
    paid_count: paidCount,
  };
}

/**
 * Top customers by gross billed amount. Billed = total_amd of invoices
 * in status 'sent' / 'overdue' / 'paid' (excludes 'draft' and 'void').
 * If `since` and/or `until` is provided, filters by `issue_date`. `limit`
 * defaults to 10, capped at 100. `total_paid_amd` is the cumulative
 * payment sum against that customer's invoices (across all dates, not
 * just the [since, until] window) — it's a "lifetime receipts" signal
 * surfaced alongside the window-scoped billing.
 *
 * @param {{since?: string, until?: string, limit?: number}} [opts]
 * @returns {Promise<Array<{
 *   customer_id: number, customer_name: string, hvhh: string|null,
 *   total_billed_amd: number, total_paid_amd: number,
 *   invoice_count: number,
 * }>>}
 */
export async function getTopCustomers(db, { since, until, limit } = {}, tenantId = 0) {
  if (since !== undefined) assertDate(since, 'since');
  if (until !== undefined) assertDate(until, 'until');
  const effectiveLimit = assertLimit(limit, 'limit', {
    defaultVal: DEFAULT_TOP_CUSTOMERS_LIMIT,
    maxVal: MAX_TOP_CUSTOMERS_LIMIT,
  });

  // Build the optional date-range filter. tenant_id is the FIRST
  // condition so it can short-circuit on the partial index
  // (idx_finance_invoices_tenant_issue_date).
  const conds = [`i.tenant_id = $1`];
  const params = [tenantId];
  conds.push(
    `i.status IN (${BILLED_STATUSES.map((_, i) => `$${i + 1 + params.length}`).join(', ')})`,
  );
  params.push(...BILLED_STATUSES);
  if (since !== undefined) {
    params.push(since);
    conds.push(`i.issue_date >= $${params.length}`);
  }
  if (until !== undefined) {
    params.push(until);
    conds.push(`i.issue_date <= $${params.length}`);
  }

  const sql = `SELECT c.id AS customer_id, c.name AS customer_name, c.hvhh,
            SUM(i.total_amd) AS total_billed_amd,
            COUNT(*) AS invoice_count
     FROM finance.invoices i
     JOIN finance.customers c ON c.id = i.customer_id
     WHERE ${conds.join(' AND ')}
     GROUP BY c.id, c.name, c.hvhh
     ORDER BY total_billed_amd DESC, c.id ASC
     LIMIT $${params.length + 1}`;
  params.push(effectiveLimit);

  const result = await runQuery(db, sql, params);
  const paidByInvoice = await buildPaidByInvoice(db, tenantId);

  // Compute per-customer paid totals. We need a second pass to know
  // which invoices belong to each customer.
  const out = [];
  for (const row of result.rows || []) {
    const cid = Number(row.customer_id);
    out.push({
      customer_id: cid,
      customer_name: String(row.customer_name),
      hvhh: row.hvhh == null ? null : String(row.hvhh),
      total_billed_amd: roundAmd(Number(row.total_billed_amd || 0)),
      total_paid_amd: 0, // filled below
      invoice_count: Number(row.invoice_count || 0),
    });
  }
  // Build a customer_id → paid_amd map. One query for all invoices in
  // the [since, until] window; we don't currently need to scope paid
  // totals by the same window — see JSDoc.
  for (let i = 0; i < out.length; i += 1) {
    const cid = out[i].customer_id;
    // Re-query invoice ids for this customer (cheap, since the top-N
    // list is small). Also scoped to the tenant so a top-customers call
    // for tenant A never reaches into tenant B's invoice history.
    const invs = await runQuery(
      db,
      `SELECT id FROM finance.invoices WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, cid],
    );
    let totalPaid = 0;
    for (const inv of invs.rows || []) {
      totalPaid += paidByInvoice.get(Number(inv.id)) || 0;
    }
    out[i].total_paid_amd = roundAmd(totalPaid);
  }
  return out;
}

/**
 * VAT summary for an inclusive [since, until] window.
 *
 * **Caveat — output-VAT only.** This view reports the VAT we have
 * INVOICED (output VAT on sales) and the VAT covered by payments on
 * those invoices. The schema does NOT track incoming-purchase invoices
 * or input VAT (no `finance.purchase_invoices` table yet), so this is
 * deliberately a "what we've billed" view. When purchase-invoice
 * support lands, subtract input VAT from this number to get the
 * net-of-input position.
 *
 * `vat_invoiced_amd` = SUM(invoices.vat_amd) for the window (any non-
 * void status; void invoices never contributed output VAT).
 * `vat_paid_amd` = SUM(invoices.vat_amd) over rows that are now
 * fully paid (status='paid').
 * `net_vat_position_amd` = `vat_invoiced_amd` - `vat_paid_amd`
 * (positive means we've billed more VAT than we've collected against).
 *
 * @param {string} since 'YYYY-MM-DD' inclusive
 * @param {string} until 'YYYY-MM-DD' inclusive
 * @returns {Promise<{
 *   since: string, until: string,
 *   vat_invoiced_amd: number,
 *   vat_paid_amd: number,
 *   net_vat_position_amd: number,
 *   invoice_count: number,
 * }>}
 */
export async function getVatSummary(db, since, until, tenantId = 0) {
  assertDate(since, 'since');
  assertDate(until, 'until');
  if (until < since) {
    throw new ValueError(`until (${until}) must be >= since (${since})`);
  }

  // VAT invoiced: exclude void (never contributed); include the rest.
  const invoicedResult = await runQuery(
    db,
    `SELECT COALESCE(SUM(vat_amd), 0) AS vat_invoiced_amd,
            COUNT(*) AS invoice_count
     FROM finance.invoices
     WHERE tenant_id = $1 AND issue_date >= $2 AND issue_date <= $3
       AND status <> 'void'`,
    [tenantId, since, until],
  );
  const invoiced = Number(invoicedResult.rows?.[0]?.vat_invoiced_amd ?? 0);
  const invoiceCount = Number(invoicedResult.rows?.[0]?.invoice_count ?? 0);

  // VAT paid: sum of vat_amd on fully paid invoices in the window.
  const paidResult = await runQuery(
    db,
    `SELECT COALESCE(SUM(vat_amd), 0) AS vat_paid_amd
     FROM finance.invoices
     WHERE tenant_id = $1 AND issue_date >= $2 AND issue_date <= $3
       AND status = 'paid'`,
    [tenantId, since, until],
  );
  const paid = Number(paidResult.rows?.[0]?.vat_paid_amd ?? 0);

  return {
    since,
    until,
    vat_invoiced_amd: roundAmd(invoiced),
    vat_paid_amd: roundAmd(paid),
    net_vat_position_amd: roundAmd(invoiced - paid),
    invoice_count: invoiceCount,
  };
}
// ────────────────────────────────────────────────────────────────────────
// Drill-down functions (W92-1 — Phase 3 reporting wave 2)
//
// The aggregate functions above (getArAging / getMonthlyRevenue /
// getTopCustomers) give the CFO a dashboard view. These drill-down
// functions let the CFO click into an aggregate number and see the
// underlying invoices / customers / months that contribute to it.
//
// Pattern: every drill-down takes (db, ..., tenantId) like the
// aggregate functions. The output is a flat list (not a tree) so
// the UI can render it as a table or paginate it.
// ────────────────────────────────────────────────────────────────────────

const VALID_AGING_BUCKETS = Object.freeze(['0_30', '31_60', '61_90', '90_plus']);
const DEFAULT_TREND_MONTHS = 12;
const MAX_TREND_MONTHS = 36;

function assertAgingBucket(bucket, name) {
  if (!VALID_AGING_BUCKETS.includes(bucket)) {
    throw new ValueError(
      `${name} must be one of: ${VALID_AGING_BUCKETS.join(', ')} (got ${String(bucket)})`,
    );
  }
}

/**
 * List the invoices that fall into a specific aging bucket as of
 * `asOfDate`. Drill-down for the getArAging aggregate. Each row
 * is sorted by days_overdue DESC (oldest first within the bucket).
 *
 * @param {'0_30'|'31_60'|'61_90'|'90_plus'} bucket
 * @returns {Promise<Array<{
 *   id: number, invoice_number: string, customer_id: number,
 *   customer_name: string, total_amd: number, paid_amd: number,
 *   balance_amd: number, due_date: string, days_overdue: number,
 * }>>}
 */
export async function listInvoicesInAgingBucket(
  db,
  asOfDate,
  bucket,
  tenantId = 0,
) {
  assertDate(asOfDate, 'asOfDate');
  assertAgingBucket(bucket, 'bucket');

  const invResult = await runQuery(
    db,
    `SELECT i.id, i.invoice_number, i.customer_id, i.due_date,
            i.total_amd,
            COALESCE(c.name, '') AS customer_name
       FROM finance.invoices i
       LEFT JOIN finance.customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1
        AND i.status IN ($2, $3)
        AND i.due_date < $4
      ORDER BY julianday($4) - julianday(i.due_date) DESC`,
    [tenantId, UNPAID_STATUSES[0], UNPAID_STATUSES[1], asOfDate],
  );
  const paidByInvoice = await buildPaidByInvoice(db, tenantId);

  const rows = [];
  for (const inv of invResult.rows || []) {
    const total = Number(inv.total_amd);
    const paid = paidByInvoice.get(Number(inv.id)) || 0;
    const outstanding = total - paid;
    if (outstanding <= 0) continue;

    const days = daysBetween(asOfDate, String(inv.due_date));
    let key;
    if (days <= 30) key = '0_30';
    else if (days <= 60) key = '31_60';
    else if (days <= 90) key = '61_90';
    else key = '90_plus';

    if (key !== bucket) continue;
    rows.push({
      id: Number(inv.id),
      invoice_number: inv.invoice_number,
      customer_id: inv.customer_id != null ? Number(inv.customer_id) : null,
      customer_name: inv.customer_name,
      total_amd: roundAmd(total),
      paid_amd: roundAmd(paid),
      balance_amd: roundAmd(outstanding),
      due_date: String(inv.due_date),
      days_overdue: days,
    });
  }
  return rows;
}

/**
 * Monthly revenue trend for the last `months` months (including
 * the current month). Drill-down for getMonthlyRevenue: instead
 * of one month at a time, get the trend as a single array.
 *
 * Ordered chronologically (oldest first). The current month is
 * always the last entry, even if its invoices are not yet due.
 *
 * @param {number} [months=12] — how many months back to include
 * @returns {Promise<Array<{
 *   year_month: string, invoice_count: number,
 *   total_billed_amd: number, total_paid_amd: number,
 *   total_outstanding_amd: number,
 * }>>}
 */
export async function listMonthlyRevenueTrend(
  db,
  months = DEFAULT_TREND_MONTHS,
  tenantId = 0,
) {
  if (!Number.isInteger(months) || months < 1 || months > MAX_TREND_MONTHS) {
    throw new ValueError(`months must be 1-${MAX_TREND_MONTHS} (got ${String(months)})`);
  }
  // Compute the (year, month) tuples for the last N months,
  // starting from the current month and walking backwards.
  const now = new Date();
  const tuples = [];
  for (let i = months - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    tuples.push({
      year: d.getFullYear(),
      month: d.getMonth() + 1,
      key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`,
    });
  }
  // Fetch all billable invoices for the trend window in one
  // query (the (year, month) tuples span months - but the
  // date filter is on issue_date which has a regular index).
  // We compute each month's totals in JS — small CPU cost,
  // no extra round-trips.
  const firstKey = tuples[0].key;
  const lastKey = tuples[tuples.length - 1].key;
  const [firstYear, firstMonth] = firstKey.split('-').map(Number);
  const firstDate = `${firstYear}-${String(firstMonth).padStart(2, '0')}-01`;
  const [lastYear, lastMonth] = lastKey.split('-').map(Number);
  const lastDate = new Date(lastYear, lastMonth, 0).toISOString().slice(0, 10);

  const invResult = await runQuery(
    db,
    `SELECT id, issue_date, total_amd, status
       FROM finance.invoices
      WHERE tenant_id = $1
        AND status IN ($2, $3, $4)
        AND issue_date >= $5
        AND issue_date <= $6`,
    [
      tenantId,
      BILLED_STATUSES[0], BILLED_STATUSES[1], BILLED_STATUSES[2],
      firstDate, lastDate,
    ],
  );
  const paidByInvoice = await buildPaidByInvoice(db, tenantId);

  // Initialize per-month buckets
  const byMonth = new Map();
  for (const t of tuples) {
    byMonth.set(t.key, {
      year_month: t.key,
      invoice_count: 0,
      total_billed_amd: 0,
      total_paid_amd: 0,
      total_outstanding_amd: 0,
    });
  }
  // Walk the invoices and accumulate into month buckets
  for (const inv of invResult.rows || []) {
    const issueDate = String(inv.issue_date);
    const ym = issueDate.slice(0, 7); // 'YYYY-MM'
    if (!byMonth.has(ym)) continue;
    const total = Number(inv.total_amd);
    const paid = paidByInvoice.get(Number(inv.id)) || 0;
    const bucket = byMonth.get(ym);
    bucket.invoice_count += 1;
    bucket.total_billed_amd += total;
    bucket.total_paid_amd += Math.min(paid, total);
    bucket.total_outstanding_amd += Math.max(0, total - paid);
  }
  return tuples.map((t) => {
    const b = byMonth.get(t.key);
    return {
      year_month: b.year_month,
      invoice_count: b.invoice_count,
      total_billed_amd: roundAmd(b.total_billed_amd),
      total_paid_amd: roundAmd(b.total_paid_amd),
      total_outstanding_amd: roundAmd(b.total_outstanding_amd),
    };
  });
}

/**
 * Revenue + outstanding breakdown for one customer in a date
 * range. Drill-down for getTopCustomers: instead of "this
 * customer is in the top 5", see all of the customer's
 * activity (invoices + payments + aging).
 *
 * @param {number} customerId
 * @param {string} since — YYYY-MM-DD
 * @param {string} until — YYYY-MM-DD
 * @returns {Promise<{
 *   customer: { id, name, hvhh },
 *   period: { since, until },
 *   invoice_count: number,
 *   total_billed_amd: number,
 *   total_paid_amd: number,
 *   total_outstanding_amd: number,
 *   aging: { '0_30': { count, amount }, '31_60': { count, amount },
 *           '61_90': { count, amount }, '90_plus': { count, amount } },
 *   invoices: Array<{ id, invoice_number, issue_date, due_date,
 *                      total_amd, paid_amd, balance_amd, status }>,
 * }>}
 */
export async function getCustomerRevenueBreakdown(
  db,
  customerId,
  since,
  until,
  tenantId = 0,
) {
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new ValueError('customerId must be a positive integer');
  }
  assertDate(since, 'since');
  assertDate(until, 'until');
  if (since > until) {
    throw new ValueError(`since (${since}) must be <= until (${until})`);
  }

  const custResult = await runQuery(
    db,
    `SELECT id, name, hvhh
       FROM finance.customers
      WHERE id = $1 AND tenant_id = $2`,
    [customerId, tenantId],
  );
  if (!custResult.rows || custResult.rows.length === 0) {
    throw new ValueError(`customer ${customerId} not found in tenant ${tenantId}`);
  }
  const customer = custResult.rows[0];

  const invResult = await runQuery(
    db,
    `SELECT id, invoice_number, issue_date, due_date, total_amd, status
       FROM finance.invoices
      WHERE tenant_id = $1 AND customer_id = $2
        AND issue_date >= $3 AND issue_date <= $4
        AND status IN ($5, $6, $7)
      ORDER BY issue_date ASC, id ASC`,
    [
      tenantId, customerId, since, until,
      BILLED_STATUSES[0], BILLED_STATUSES[1], BILLED_STATUSES[2],
    ],
  );
  const paidByInvoice = await buildPaidByInvoice(db, tenantId);

  const aging = {
    '0_30': { count: 0, amount: 0 },
    '31_60': { count: 0, amount: 0 },
    '61_90': { count: 0, amount: 0 },
    '90_plus': { count: 0, amount: 0 },
  };
  const invoices = [];
  let totalBilled = 0;
  let totalPaid = 0;
  let totalOutstanding = 0;

  for (const inv of invResult.rows || []) {
    const total = Number(inv.total_amd);
    const paid = paidByInvoice.get(Number(inv.id)) || 0;
    const balance = total - paid;
    totalBilled += total;
    totalPaid += Math.min(paid, total);
    totalOutstanding += Math.max(0, balance);
    invoices.push({
      id: Number(inv.id),
      invoice_number: inv.invoice_number,
      issue_date: String(inv.issue_date),
      due_date: String(inv.due_date),
      total_amd: roundAmd(total),
      paid_amd: roundAmd(paid),
      balance_amd: roundAmd(balance),
      status: inv.status,
    });
    if (balance > 0 && inv.status !== 'paid') {
      const days = daysBetween(until, String(inv.due_date));
      let key;
      if (days <= 30) key = '0_30';
      else if (days <= 60) key = '31_60';
      else if (days <= 90) key = '61_90';
      else key = '90_plus';
      aging[key].count += 1;
      aging[key].amount += balance;
    }
  }
  return {
    customer: {
      id: Number(customer.id),
      name: customer.name,
      hvhh: customer.hvhh ?? null,
    },
    period: { since, until },
    invoice_count: invoices.length,
    total_billed_amd: roundAmd(totalBilled),
    total_paid_amd: roundAmd(totalPaid),
    total_outstanding_amd: roundAmd(totalOutstanding),
    aging: {
      '0_30': { count: aging['0_30'].count, amount_amd: roundAmd(aging['0_30'].amount) },
      '31_60': { count: aging['31_60'].count, amount_amd: roundAmd(aging['31_60'].amount) },
      '61_90': { count: aging['61_90'].count, amount_amd: roundAmd(aging['61_90'].amount) },
      '90_plus': { count: aging['90_plus'].count, amount_amd: roundAmd(aging['90_plus'].amount) },
    },
    invoices,
  };
}