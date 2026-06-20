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
// the mock's GROUP BY branch and the real DB's native SQL.
// ────────────────────────────────────────────────────────────────────────

async function buildPaidByInvoice(db) {
  const out = await runQuery(
    db,
    `SELECT invoice_id, SUM(amount_amd) AS paid_amd
     FROM finance.payments
     GROUP BY invoice_id`,
    [],
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
export async function getArAging(db, asOfDate) {
  assertDate(asOfDate, 'asOfDate');

  const invResult = await runQuery(
    db,
    `SELECT id, due_date, total_amd
     FROM finance.invoices
     WHERE status IN ($1, $2) AND due_date < $3`,
    [UNPAID_STATUSES[0], UNPAID_STATUSES[1], asOfDate],
  );
  const paidByInvoice = await buildPaidByInvoice(db);

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
export async function listOverdueInvoices(db, asOfDate, limit = DEFAULT_OVERDUE_LIMIT) {
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
     WHERE i.status IN ($1, $2) AND i.due_date < $3
     ORDER BY i.due_date ASC`,
    [UNPAID_STATUSES[0], UNPAID_STATUSES[1], asOfDate],
  );

  const paidByInvoice = await buildPaidByInvoice(db);
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
export async function getMonthlyRevenue(db, yearMonth) {
  assertYearMonth(yearMonth, 'yearMonth');
  const { first, last } = monthBounds(yearMonth);

  const invResult = await runQuery(
    db,
    `SELECT id, total_amd
     FROM finance.invoices
     WHERE issue_date >= $1 AND issue_date <= $2`,
    [first, last],
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
     WHERE paid_at >= $1 AND paid_at <= $2`,
    [`${first}T00:00:00Z`, `${last}T23:59:59Z`],
  );
  let collected = 0;
  for (const p of payResult.rows || []) {
    if (idSet.has(Number(p.invoice_id))) collected += Number(p.amount_amd);
  }
  collected = roundAmd(collected);

  // Fully-paid count: in-month invoice whose total_paid_amd >= total_amd.
  const paidByInvoice = await buildPaidByInvoice(db);
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
export async function getTopCustomers(db, { since, until, limit } = {}) {
  if (since !== undefined) assertDate(since, 'since');
  if (until !== undefined) assertDate(until, 'until');
  const effectiveLimit = assertLimit(limit, 'limit', {
    defaultVal: DEFAULT_TOP_CUSTOMERS_LIMIT,
    maxVal: MAX_TOP_CUSTOMERS_LIMIT,
  });

  // Build the optional date-range filter.
  const conds = [`i.status IN (${BILLED_STATUSES.map((_, i) => `$${i + 1}`).join(', ')})`];
  const params = [...BILLED_STATUSES];
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
  const paidByInvoice = await buildPaidByInvoice(db);

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
    // list is small).
    const invs = await runQuery(db, `SELECT id FROM finance.invoices WHERE customer_id = $1`, [
      cid,
    ]);
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
export async function getVatSummary(db, since, until) {
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
     WHERE issue_date >= $1 AND issue_date <= $2
       AND status <> 'void'`,
    [since, until],
  );
  const invoiced = Number(invoicedResult.rows?.[0]?.vat_invoiced_amd ?? 0);
  const invoiceCount = Number(invoicedResult.rows?.[0]?.invoice_count ?? 0);

  // VAT paid: sum of vat_amd on fully paid invoices in the window.
  const paidResult = await runQuery(
    db,
    `SELECT COALESCE(SUM(vat_amd), 0) AS vat_paid_amd
     FROM finance.invoices
     WHERE issue_date >= $1 AND issue_date <= $2
       AND status = 'paid'`,
    [since, until],
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
