// server/finance/customer360.js
//
// CFO-facing "360 view" of a customer: the basic info + every open
// invoice (with running balance) + recent payments + totals + aging
// buckets. One endpoint, one round-trip, the full picture.
//
// Wave 31: the pure function. The HTTP layer (route + perm gate +
// tenant middleware + audit + smoke) lands in Wave 32.
//
// All SQL stays in here — no string-concat, no eval, every query
// uses parameterized placeholders. The function works against any
// duck-typed DB that exposes either pg-style `.query(sql, params)`
// returning `{ rows }` or sqlite-style `.prepare(sql).run/all`
// (the existing `pickAdapter` in payment.js handles the dispatch).
//
// Tenant scope: every read threads `tenantId` through the underlying
// `getCustomer` / `listInvoices` / `reconcileInvoice` /
// `listPaymentsForInvoice` calls. A cross-tenant id returns
// `null` from `getCustomer` (the existing pattern), which we
// surface as a `ValueError` so the route layer returns 404
// (no existence-oracle leak between tenants).

import { getCustomer, ValueError as CustomerValueError } from './customer.js';
import { listInvoices } from './invoice.js';
import { listPaymentsForInvoice, reconcileInvoice } from './payment.js';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// Re-export the customer.js ValueError under the same name so callers
// (and tests) can `import { ValueError } from './customer360.js'`
// regardless of which module's error fires.
export { CustomerValueError };

// ────────────────────────────────────────────────────────────────────────
// Aging bucket boundaries. Days overdue counts the number of whole
// days between `due_date` and the `today` arg (or the current date
// if not provided). The bucket assignment is:
//   current   — due_date >= today  (not yet due)
//   days_1_30 —  1 ≤ d ≤ 30
//   days_31_60 — 31 ≤ d ≤ 60
//   days_61_90 — 61 ≤ d ≤ 90
//   days_90_plus — d > 90
// Negative days (due_date in the past) fall into one of the
// overdue buckets; due_date == today is "current".
// ────────────────────────────────────────────────────────────────────────

const MS_PER_DAY = 24 * 60 * 60 * 1000;

function parseISODate(s) {
  if (typeof s !== 'string') return null;
  // Accept YYYY-MM-DD (the canonical date format) and YYYY-MM-DDTHH:MM:SSZ
  // (the timestamp format sqlite's datetime('now') returns).
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
// getCustomer360 — the public API.
//
// Args:
//   db          — duck-typed DB (pg-style or sqlite-style)
//   customerId  — positive integer
//   tenantId    — non-negative integer (0 = bootstrap tenant)
//   opts        — { today?: 'YYYY-MM-DD', recentPaymentsLimit?: number }
//
// Returns the full 360 view. Throws ValueError on missing or
// cross-tenant customer (route layer maps to 404).
//
// Implementation: 1 + N + N reads. N is the customer's invoice
// count. For a typical customer (10-100 invoices) this is fine.
// If the customer has thousands of invoices, the SQL-level
// aggregation is a follow-up wave; for now the read pattern is
// predictable and bounded by the customer's actual data.
// ────────────────────────────────────────────────────────────────────────

export async function getCustomer360(db, customerId, tenantId = 0, opts = {}) {
  if (!Number.isInteger(customerId) || customerId <= 0) {
    throw new ValueError(`customerId must be a positive integer (got ${String(customerId)})`);
  }
  if (!Number.isInteger(tenantId) || tenantId < 0) {
    throw new ValueError(`tenantId must be a non-negative integer (got ${String(tenantId)})`);
  }

  const today = opts.today || new Date().toISOString().slice(0, 10);
  const recentLimit = Math.min(
    Math.max(Number(opts.recentPaymentsLimit) || 10, 1),
    100,
  );

  // 1. The customer itself. null → either missing or cross-tenant
  //    — both surface as ValueError so the route layer returns 404
  //    (no existence-oracle leak).
  const customer = await getCustomer(db, customerId, tenantId);
  if (!customer) {
    throw new ValueError(`customer ${customerId} not found in tenant ${tenantId}`);
  }

  // 2. Every invoice for the customer. We ask for all of them; the
  //    open-invoice filter happens client-side. listInvoices is
  //    tenant-scoped, so this can't leak across tenants.
  const allInvoices = await listInvoices(db, { customer_id: customerId }, tenantId);

  // 3. Open = not paid, not void. Draft invoices are technically
  //    open (not yet sent) but the CFO usually wants to focus on
  //    "owed" — we keep them but they're easy to filter out at the
  //    client.
  const openRows = allInvoices.filter(
    (inv) => inv.status !== 'paid' && inv.status !== 'void',
  );

  // 4. For each open invoice, run reconcileInvoice to get the
  //    current paid + balance. Promise.all runs them in parallel.
  const openInvoices = await Promise.all(
    openRows.map(async (inv) => {
      const r = await reconcileInvoice(db, inv.id, tenantId);
      const dueDate = inv.due_date;
      const daysOverdue = Math.max(0, diffDays(today, dueDate));
      return {
        id: Number(inv.id),
        invoice_number: inv.invoice_number,
        issue_date: inv.issue_date,
        due_date: dueDate,
        status: r.status,
        total_amd: Number(r.total_amd),
        paid_amd: Number(r.paid_amd),
        balance_amd: Number(r.balance_amd),
        days_overdue: daysOverdue,
      };
    }),
  );

  // Sort by due_date ASC (most urgent first). Same due_date → id
  // ASC for stable ordering.
  openInvoices.sort((a, b) => {
    if (a.due_date !== b.due_date) return a.due_date < b.due_date ? -1 : 1;
    return a.id - b.id;
  });

  // 5. Recent payments. To avoid the new listPaymentsForCustomer
  //    helper (a pg-vs-sqlite adapter refactor), iterate the most
  //    recent 10 invoices and collect their payments. Bounded N+1
  //    (10 listPaymentsForInvoice calls). Top N by paid_at DESC.
  const recentInvoiceRows = allInvoices
    .slice()
    .sort((a, b) => {
      if (a.issue_date !== b.issue_date) return a.issue_date < b.issue_date ? 1 : -1;
      return Number(b.id) - Number(a.id);
    })
    .slice(0, 10);

  const recentPayments = [];
  for (const inv of recentInvoiceRows) {
    const payments = await listPaymentsForInvoice(db, inv.id, tenantId);
    for (const p of payments) {
      recentPayments.push({
        id: Number(p.id),
        invoice_id: Number(p.invoice_id),
        invoice_number: inv.invoice_number,
        paid_at: p.paid_at,
        amount_amd: Number(p.amount_amd),
        method: p.method,
        reference: p.reference || null,
      });
    }
  }
  recentPayments.sort((a, b) => (a.paid_at < b.paid_at ? 1 : a.paid_at > b.paid_at ? -1 : 0));
  const topPayments = recentPayments.slice(0, recentLimit);

  // 6. Totals — derived from open_invoices. The "outstanding" total
  //    is the sum of balance_amd (i.e. what the customer still owes).
  let openCount = openInvoices.length;
  let openTotalAmd = 0;
  let paidTotalAmd = 0;
  let outstandingAmd = 0;
  for (const inv of openInvoices) {
    openTotalAmd += inv.total_amd;
    paidTotalAmd += inv.paid_amd;
    outstandingAmd += inv.balance_amd;
  }

  // 7. Aging buckets — keyed on balance_amd (what's actually owed,
  //    not what was invoiced). A partially-paid invoice goes into
  //    the bucket for its days_overdue; the bucket holds the
  //    remaining balance, not the original total.
  const aging = {
    current: 0,
    days_1_30: 0,
    days_31_60: 0,
    days_61_90: 0,
    days_90_plus: 0,
  };
  for (const inv of openInvoices) {
    if (inv.balance_amd <= 0) continue; // overpaid or paid — no aging impact
    const bucket = agingBucket(inv.days_overdue);
    aging[bucket] += inv.balance_amd;
  }

  return {
    customer: {
      id: customer.id,
      name: customer.name,
      hvhh: customer.hvhh,
      address: customer.address,
      email: customer.email,
      tenant_id: customer.tenant_id,
    },
    open_invoices: openInvoices,
    recent_payments: topPayments,
    totals: {
      open_count: openCount,
      open_total_amd: openTotalAmd,
      paid_total_amd: paidTotalAmd,
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
});
