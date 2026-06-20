// SBOS-A1-ERP CFO dashboard — server-rendered HTML view of the 5
// reporting functions in server/finance/reports.js.
//
// The CFO (or their assistant) opens a browser, sees the AR aging, overdue
// invoices, monthly revenue, top customers, and YTD VAT summary — all
// computed live from the finance tables on each page load.
//
// Public API:
//   renderDashboard(db, asOfDate, opts?) → HTML string
//   serveDashboard(db, opts?) → starts an HTTP server (returns the
//                                server handle so the caller can close it)
//
// Style: minimal embedded CSS, no client-side JavaScript, no external
// dependencies. Server-side rendering only. HTML-escaped at every
// dynamic value (caller-supplied invoice_number, customer_name, etc. —
// these flow from user-facing inputs).

import { createServer } from 'node:http';
import {
  getArAging,
  listOverdueInvoices,
  getMonthlyRevenue,
  getTopCustomers,
  getVatSummary,
} from './reports.js';

// ────────────────────────────────────────────────────────────────────────
// HTML escaping — minimal but sufficient for the fields we render.
// Covers: customer name, invoice number, customer hvhh, yearMonth,
// dates, asOfDate, integer values converted to strings. All values flow
// through this before insertion into HTML.
// ────────────────────────────────────────────────────────────────────────

function escapeHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function fmtAmd(n) {
  // Whole-dram AMD — thousands separator, no decimals.
  const v = Number(n) || 0;
  // Group with spaces (common in EU/RU/AM accounting) for readability.
  const negative = v < 0;
  const abs = Math.abs(v);
  const grouped = abs.toLocaleString('en-US').replace(/,/g, ' ');
  return (negative ? '−' : '') + grouped + ' AMD';
}

function fmtPct(n) {
  const v = Number(n) || 0;
  return v.toFixed(1) + '%';
}

// ────────────────────────────────────────────────────────────────────────
// Page chrome — minimal embedded CSS, no external assets.
// ────────────────────────────────────────────────────────────────────────

const STYLES = `
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
         margin: 2rem; color: #1a1a1a; background: #fafafa; }
  h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
  h2 { font-size: 1.15rem; margin: 2rem 0 0.5rem; padding-bottom: 0.25rem;
       border-bottom: 2px solid #2563eb; }
  .meta { color: #666; font-size: 0.9rem; margin-bottom: 1rem; }
  table { border-collapse: collapse; width: 100%; background: white;
          box-shadow: 0 1px 3px rgba(0,0,0,0.05); }
  th, td { padding: 0.5rem 0.75rem; text-align: left; border-bottom: 1px solid #eee; }
  th { background: #f5f5f5; font-weight: 600; font-size: 0.85rem;
       text-transform: uppercase; letter-spacing: 0.03em; }
  td.num { text-align: right; font-variant-numeric: tabular-nums; }
  .bucket-row td { font-weight: 500; }
  .total { font-weight: 600; font-size: 1.05rem; padding: 0.75rem;
           background: #eff6ff; border-top: 2px solid #2563eb; }
  .empty { color: #999; font-style: italic; padding: 0.5rem 0; }
  .badge { display: inline-block; padding: 0.1rem 0.4rem; border-radius: 3px;
           font-size: 0.8rem; font-weight: 500; }
  .badge.draft { background: #e0e7ff; color: #3730a3; }
  .badge.sent  { background: #dbeafe; color: #1e40af; }
  .badge.paid  { background: #d1fae5; color: #065f46; }
  .badge.void  { background: #fee2e2; color: #991b1b; }
  .badge.overdue { background: #fef3c7; color: #92400e; }
  .right { text-align: right; }
`;

// ────────────────────────────────────────────────────────────────────────
// Section renderers — one per report function. Each returns a string of
// <section>...</section> HTML. The main page composes them.
// ────────────────────────────────────────────────────────────────────────

function renderArAgingSection(ar) {
  const b = ar.buckets || {};
  const cell = (key) => {
    const v = b[key] || { invoice_count: 0, amount_amd: 0 };
    return `<td class="num">${v.invoice_count} inv<br>${escapeHtml(fmtAmd(v.amount_amd))}</td>`;
  };
  return `
  <h2>AR Aging</h2>
  <p class="meta">${escapeHtml(ar.asOfDate)} — outstanding receivables by days past due.</p>
  <table>
    <tr>
      <th>0–30 days</th>
      <th>31–60 days</th>
      <th>61–90 days</th>
      <th>90+ days</th>
      <th>Total</th>
    </tr>
    <tr class="bucket-row">
      ${cell('0_30')}
      ${cell('31_60')}
      ${cell('61_90')}
      ${cell('90_plus')}
      <td class="num total">${escapeHtml(fmtAmd(ar.total_outstanding_amd))}</td>
    </tr>
  </table>
  `;
}

function renderOverdueSection(rows) {
  if (!rows || rows.length === 0) {
    return `
    <h2>Overdue Invoices (top ${rows?.length || 0})</h2>
    <p class="empty">No overdue invoices. 🎉</p>
    `;
  }
  return `
  <h2>Overdue Invoices (top ${rows.length})</h2>
  <p class="meta">Past-due as of the report date, sorted by days overdue DESC.</p>
  <table>
    <tr>
      <th>Invoice #</th>
      <th>Customer</th>
      <th class="right">Balance</th>
      <th class="right">Days overdue</th>
    </tr>
    ${rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.invoice_number)}</td>
      <td>${escapeHtml(r.customer_name)}</td>
      <td class="num">${escapeHtml(fmtAmd(r.balance_amd))}</td>
      <td class="num">${r.days_overdue}</td>
    </tr>`).join('')}
  </table>
  `;
}

function renderMonthlySection(m) {
  return `
  <h2>This Month's Revenue</h2>
  <p class="meta">${escapeHtml(m.year_month)} — period revenue and collection.</p>
  <table>
    <tr>
      <th>Invoiced</th>
      <th>Collected</th>
      <th>Outstanding</th>
      <th>Invoices</th>
      <th>Paid</th>
      <th>Collection rate</th>
    </tr>
    <tr>
      <td class="num">${escapeHtml(fmtAmd(m.invoiced_amd))}</td>
      <td class="num">${escapeHtml(fmtAmd(m.collected_amd))}</td>
      <td class="num">${escapeHtml(fmtAmd(m.outstanding_amd))}</td>
      <td class="num">${m.invoice_count}</td>
      <td class="num">${m.paid_count}</td>
      <td class="num">${escapeHtml(fmtPct(m.invoiced_amd > 0 ? (m.collected_amd / m.invoiced_amd) * 100 : 0))}</td>
    </tr>
  </table>
  `;
}

function renderTopCustomersSection(rows) {
  if (!rows || rows.length === 0) {
    return `
    <h2>Top Customers</h2>
    <p class="empty">No customers in the selected window.</p>
    `;
  }
  return `
  <h2>Top Customers</h2>
  <p class="meta">By gross billed amount in the selected window.</p>
  <table>
    <tr>
      <th>Customer</th>
      <th>HVHH (tax ID)</th>
      <th class="right">Billed</th>
      <th class="right">Paid</th>
      <th class="right">Invoices</th>
    </tr>
    ${rows.map((r) => `
    <tr>
      <td>${escapeHtml(r.customer_name)}</td>
      <td>${escapeHtml(r.hvhh || '—')}</td>
      <td class="num">${escapeHtml(fmtAmd(r.total_billed_amd))}</td>
      <td class="num">${escapeHtml(fmtAmd(r.total_paid_amd))}</td>
      <td class="num">${r.invoice_count}</td>
    </tr>`).join('')}
  </table>
  `;
}

function renderVatSection(v) {
  return `
  <h2>VAT Summary (YTD)</h2>
  <p class="meta">${escapeHtml(v.since)} → ${escapeHtml(v.until)} — output-VAT rollup.</p>
  <table>
    <tr>
      <th>VAT invoiced (output)</th>
      <th>VAT paid (on collected invoices)</th>
      <th>Net VAT position</th>
      <th>Invoices</th>
    </tr>
    <tr>
      <td class="num">${escapeHtml(fmtAmd(v.vat_invoiced_amd))}</td>
      <td class="num">${escapeHtml(fmtAmd(v.vat_paid_amd))}</td>
      <td class="num total">${escapeHtml(fmtAmd(v.net_vat_position_amd))}</td>
      <td class="num">${v.invoice_count}</td>
    </tr>
  </table>
  `;
}

// ────────────────────────────────────────────────────────────────────────
// Top-level renderDashboard — composes the 5 sections into a single HTML
// page. All 5 report functions run in parallel for faster TTFB.
// ────────────────────────────────────────────────────────────────────────

/**
 * Render the CFO dashboard as a self-contained HTML page.
 * @param {Db} db  duck-type DB (pg-style .query or sqlite-style .prepare)
 * @param {string} asOfDate  'YYYY-MM-DD' — the "as of" date for the report
 * @param {object} [opts]
 * @param {number} [opts.overdueLimit=10]  how many overdue invoices to show
 * @param {number} [opts.topCustomersLimit=10]
 * @returns {Promise<string>}  the full HTML page
 */
export async function renderDashboard(db, asOfDate, opts = {}) {
  if (typeof asOfDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(asOfDate)) {
    throw new ValueError('asOfDate must be in YYYY-MM-DD format');
  }
  const overdueLimit = opts.overdueLimit ?? 10;
  const topLimit = opts.topCustomersLimit ?? 10;
  const yearMonth = asOfDate.substring(0, 7);
  const yearStart = `${asOfDate.substring(0, 4)}-01-01`;

  // Run all 5 reports in parallel — they're independent reads.
  const [arAging, overdue, monthRevenue, topCustomers, vatSummary] = await Promise.all([
    getArAging(db, asOfDate),
    listOverdueInvoices(db, asOfDate, overdueLimit),
    getMonthlyRevenue(db, yearMonth),
    getTopCustomers(db, { since: yearStart, until: asOfDate, limit: topLimit }),
    getVatSummary(db, yearStart, asOfDate),
  ]);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>CFO Dashboard — ${escapeHtml(asOfDate)}</title>
  <style>${STYLES}</style>
</head>
<body>
  <h1>CFO Dashboard</h1>
  <p class="meta">As of ${escapeHtml(asOfDate)} — generated ${escapeHtml(new Date().toISOString())}</p>
  ${renderArAgingSection(arAging)}
  ${renderOverdueSection(overdue)}
  ${renderMonthlySection(monthRevenue)}
  ${renderTopCustomersSection(topCustomers)}
  ${renderVatSection(vatSummary)}
</body>
</html>
`;
}

// ────────────────────────────────────────────────────────────────────────
// HTTP server — wires renderDashboard to a minimal node:http handler.
// Returns the server handle so the caller can close it (tests can start
// + stop the server without leaking the port).
// ────────────────────────────────────────────────────────────────────────

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

/**
 * Start a minimal HTTP server that serves the dashboard at GET /.
 * @param {Db} db
 * @param {{ port?: number, host?: string }} [opts]
 * @returns {Promise<import('node:http').Server>}
 */
export function serveDashboard(db, opts = {}) {
  const port = opts.port ?? 3000;
  const host = opts.host ?? '127.0.0.1';
  return new Promise((resolve, reject) => {
    const server = createServer(async (req, res) => {
      // Tiny router — only GET / is supported.
      if (req.method !== 'GET' || req.url !== '/') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not Found\n');
        return;
      }
      try {
        // Default asOfDate to today in YYYY-MM-DD.
        const asOfDate = new Date().toISOString().substring(0, 10);
        const html = await renderDashboard(db, asOfDate);
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(html);
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end(`Server error: ${e?.message || String(e)}\n`);
      }
    });
    server.once('error', reject);
    server.listen(port, host, () => {
      // Resolve once listening; the server handle is returned for the
      // caller to close.
      resolve(server);
    });
  });
}
