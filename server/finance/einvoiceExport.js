// SBOS-A1-ERP e-invoice export — wires server/l10n-am/einvoice/einvoice.js
// to the finance DB so the operator can generate a month's worth of
// SRC-format e-invoices (one per finance.invoices row) in a single call.
//
// Regulatory context (Armenia): the SRC e-invoicing system (src.am)
// requires every issued invoice to be exported in the official XML
// format and submitted via the operator's SRC account/certificate.
// This module produces that XML from the data in finance.invoices +
// finance.invoice_lines. The actual upload to SRC is a separate
// concern (operator action).
//
// Public API:
//   exportInvoiceEInvoice(db, invoiceId, supplier) → { invoiceNumber, xml }
//   exportMonthlyEInvoices(db, yearMonth, supplier) → Array<{ invoiceNumber, xml }>
//
// `supplier` is the company's own profile (name, hvhh, vatId, address).
// It is NOT in the finance DB (this is the operator's own company, not
// a customer); callers pass it in from their config.

import {
  buildEInvoiceXml,
  EINVOICE_NAMESPACE,
  ISSUED_INVOICE_VAT_RATES,
} from '../l10n-am/einvoice/einvoice.js';
import { roundAmd } from '../l10n-am/localization.js';
import { ValueError } from './reports.js';

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

function assertSupplier(supplier) {
  if (!supplier || typeof supplier !== 'object') {
    throw new ValueError('supplier must be an object with name, hvhh, vatId, address');
  }
  if (typeof supplier.name !== 'string' || supplier.name.length === 0) {
    throw new ValueError('supplier.name is required');
  }
}

function assertYearMonth(yearMonth) {
  if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    throw new ValueError('yearMonth must be in YYYY-MM format');
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapters
// ────────────────────────────────────────────────────────────────────────

/**
 * Fetch one invoice + its line items + the customer row.
 * Returns `null` if the invoice doesn't exist.
 */
async function fetchInvoiceWithLines(db, invoiceId) {
  const invResult = await db.query(
    `SELECT i.id, i.invoice_number, i.issue_date, i.due_date,
            i.subtotal_amd, i.vat_amd, i.total_amd, i.status,
            c.id AS customer_id, c.name AS customer_name, c.hvhh, c.address
     FROM finance.invoices i
     JOIN finance.customers c ON c.id = i.customer_id
     WHERE i.id = $1`,
    [invoiceId],
  );
  const invRows = invResult.rows || [];
  if (invRows.length === 0) return null;
  const inv = invRows[0];

  const lineResult = await db.query(
    `SELECT description, quantity, unit_price_amd, line_total_amd
     FROM finance.invoice_lines
     WHERE invoice_id = $1
     ORDER BY id ASC`,
    [invoiceId],
  );
  return { invoice: inv, lines: lineResult.rows || [] };
}

/**
 * Fetch all invoices issued in a given YYYY-MM month, with lines + customer.
 */
async function fetchInvoicesInMonth(db, yearMonth) {
  // Match by issue_date prefix. Works on both pg (text comparison) and
  // sqlite (TEXT column with ISO date strings sorts lexically).
  const prefix = `${yearMonth}-`;
  const invResult = await db.query(
    `SELECT i.id, i.invoice_number, i.issue_date, i.due_date,
            i.subtotal_amd, i.vat_amd, i.total_amd, i.status,
            c.id AS customer_id, c.name AS customer_name, c.hvhh, c.address
     FROM finance.invoices i
     JOIN finance.customers c ON c.id = i.customer_id
     WHERE i.issue_date LIKE $1 || '%'
     ORDER BY i.issue_date ASC, i.id ASC`,
    [prefix],
  );
  const ids = (invResult.rows || []).map((r) => Number(r.id));
  if (ids.length === 0) return [];
  // Build dynamic placeholders for sqlite (which doesn't have
  // = ANY($1)). One-to-one mapping: ids[i] → $(i+1). Works on both
  // pg and sqlite — pg accepts the `IN ($1,$2,...)` form too.
  const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
  const lineResult = await db.query(
    `SELECT invoice_id, description, quantity, unit_price_amd, line_total_amd
     FROM finance.invoice_lines
     WHERE invoice_id IN (${placeholders})
     ORDER BY invoice_id ASC, id ASC`,
    ids,
  );
  const linesByInvoice = new Map();
  for (const l of lineResult.rows || []) {
    const iid = Number(l.invoice_id);
    if (!linesByInvoice.has(iid)) linesByInvoice.set(iid, []);
    linesByInvoice.get(iid).push(l);
  }
  return (invResult.rows || []).map((inv) => ({
    invoice: inv,
    lines: linesByInvoice.get(Number(inv.id)) || [],
  }));
}

// ────────────────────────────────────────────────────────────────────────
// Transform: finance.invoice_lines → e-invoice line shape
// ────────────────────────────────────────────────────────────────────────

/**
 * Compute the VAT rate for a line, given the invoice's VAT ratio
 * (vat_amd / subtotal_amd). The schema doesn't store a per-line
 * rate, but the e-invoice format requires it. We infer the rate
 * from the line's net + the invoice's overall ratio. For 0-VAT
 * invoices (exempt), the rate is 0.
 *
 * Rounds to the nearest 1% (SRC accepts whole-number rates only);
 * falls back to 0 if the net is 0.
 */
function inferVatRate(subtotal_amd, vat_amd) {
  if (subtotal_amd <= 0) return 0;
  const ratio = (Number(vat_amd) / Number(subtotal_amd)) * 100;
  return Math.round(ratio);
}

function toEInvoiceLines(lines, subtotal_amd, vat_amd) {
  const rate = inferVatRate(subtotal_amd, vat_amd);
  return lines.map((l) => {
    const net = roundAmd(l.line_total_amd);
    const vat = roundAmd((net * rate) / 100);
    return {
      description: String(l.description || ''),
      quantity: Number(l.quantity) || 1,
      netAmount: net,
      vatRate: rate,
      exciseAmount: 0,    // not tracked in the schema
      envFee: 0,          // not tracked in the schema
    };
  });
}

function toEInvoiceInput(invoiceRow, lineRows, supplier) {
  return {
    number: String(invoiceRow.invoice_number || ''),
    issueDate: String(invoiceRow.issue_date || ''),
    creationDate: new Date().toISOString().slice(0, 10),
    dueDate: String(invoiceRow.due_date || ''),
    transactionType: '1', // '1' = sale (per SRC e-invoice spec; 2 = return)
    currency: 'AMD',
    supplier,
    buyer: {
      name: String(invoiceRow.customer_name || ''),
      hvhh: invoiceRow.customer_hvhh || null,
      address: invoiceRow.customer_address || null,
    },
    lines: toEInvoiceLines(lineRows, invoiceRow.subtotal_amd, invoiceRow.vat_amd),
  };
}

// ────────────────────────────────────────────────────────────────────────
// Public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Export a single invoice as an SRC-format e-invoice XML string.
 *
 * @param {Db} db
 * @param {number} invoiceId
 * @param {object} supplier  { name, hvhh, vatId, address }
 * @returns {Promise<{ invoiceNumber: string, xml: string, issueDate: string, total_amd: number }>}
 * @throws ValueError if the invoice doesn't exist or the supplier is invalid
 */
export async function exportInvoiceEInvoice(db, invoiceId, supplier) {
  assertSupplier(supplier);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    throw new ValueError('invoiceId must be a positive integer');
  }
  const fetched = await fetchInvoiceWithLines(db, invoiceId);
  if (!fetched) {
    throw new ValueError(`invoice ${invoiceId} not found`);
  }
  const input = toEInvoiceInput(fetched.invoice, fetched.lines, supplier);
  const xml = buildEInvoiceXml(input);
  return {
    invoiceNumber: input.number,
    xml,
    issueDate: input.issueDate,
    total_amd: Number(fetched.invoice.total_amd) || 0,
  };
}

/**
 * Export every invoice issued in the given YYYY-MM month as SRC-format
 * e-invoice XML strings. The result is ordered by issue date ASC, then
 * invoice id ASC. An empty month returns an empty array.
 *
 * @param {Db} db
 * @param {string} yearMonth  'YYYY-MM' inclusive
 * @param {object} supplier  { name, hvhh, vatId, address }
 * @returns {Promise<Array<{ invoiceNumber, xml, issueDate, total_amd }>>}
 */
export async function exportMonthlyEInvoices(db, yearMonth, supplier) {
  assertSupplier(supplier);
  assertYearMonth(yearMonth);
  const rows = await fetchInvoicesInMonth(db, yearMonth);
  // Skip void invoices — they're not real exports.
  const out = [];
  for (const { invoice, lines } of rows) {
    if (invoice.status === 'void') continue;
    const input = toEInvoiceInput(invoice, lines, supplier);
    const xml = buildEInvoiceXml(input);
    out.push({
      invoiceNumber: input.number,
      xml,
      issueDate: input.issueDate,
      total_amd: Number(invoice.total_amd) || 0,
    });
  }
  return out;
}
