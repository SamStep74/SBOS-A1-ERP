// SBOS-A1-ERP finance HTTP routes — thin Express wrappers around the
// finance pure functions (server/finance/{invoice,reports,vatLedger,
// einvoiceExport}.js). The wrapper exists so that the bootable
// `npm run serve` entry point can expose the finance domain over HTTP.
//
// Endpoints:
//   GET  /api/finance/dashboard?asOfDate=YYYY-MM-DD
//   GET  /api/finance/invoices
//   GET  /api/finance/invoices/:id
//   GET  /api/finance/customers
//   GET  /api/finance/vat/return?yearMonth=YYYY-MM
//   GET  /api/finance/einvoice/export/:invoiceId
//
// All routes accept `opts.pgAdapter` from createApp({ pgAdapter }) —
// the pg-style adapter is what the finance pure functions speak.
// `opts.locale` flows into the dashboard render.
//
// No `eval`, no string-concat SQL, no `new Function`. The SQL the
// pure functions emit is fixed-string; we just translate param style.
import { listInvoices, getInvoice } from './invoice.js';
import { computeAndCloseVatPeriod } from './vatLedger.js';
import { exportInvoiceEInvoice } from './einvoiceExport.js';

// ────────────────────────────────────────────────────────────────────────
// Validation helpers
// ────────────────────────────────────────────────────────────────────────

function assertYearMonth(yearMonth) {
  if (typeof yearMonth !== 'string' || !/^\d{4}-\d{2}$/.test(yearMonth)) {
    const err = new Error('yearMonth must be in YYYY-MM format');
    err.name = 'ValueError';
    throw err;
  }
  // Format check accepts "2026-13"; also reject month 00 or > 12.
  const month = Number(yearMonth.slice(5, 7));
  if (!Number.isInteger(month) || month < 1 || month > 12) {
    const err = new Error('yearMonth must be a real YYYY-MM value');
    err.name = 'ValueError';
    throw err;
  }
}

// parseInvoiceId — robust against non-numeric path segments.
// Returns null if the segment is not a positive integer (so the route
// can 404 cleanly without 500'ing on /api/finance/invoices/abc).
function parseInvoiceId(segment) {
  if (typeof segment !== 'string') return null;
  const n = Number(segment);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// ────────────────────────────────────────────────────────────────────────
// listCustomers — minimal helper. Lives here (not in a separate
// finance/customers.js) because the routes file is the only consumer.
// ────────────────────────────────────────────────────────────────────────

async function listCustomers(db) {
  const { rows } = await db.query(
    'SELECT id, name, hvhh, address FROM finance.customers ORDER BY id ASC',
    [],
  );
  return rows || [];
}

// ────────────────────────────────────────────────────────────────────────
// Supplier stub — Task 2 replaces this with real per-tenant config.
// ────────────────────────────────────────────────────────────────────────

function defaultSupplier() {
  return {
    name: 'Demo Supplier LLC',
    hvhh: '00000000',
    vatId: '00000000',
    address: 'Yerevan, Armenia',
  };
}

// ────────────────────────────────────────────────────────────────────────
// registerFinanceRoutes(app, opts)
// ────────────────────────────────────────────────────────────────────────

export function registerFinanceRoutes(app, opts = {}) {
  const pgAdapter = opts.pgAdapter || (opts.app && opts.app.locals && opts.app.locals.pgAdapter);
  if (!pgAdapter) {
    throw new Error('finance routes require pgAdapter: pass opts.pgAdapter');
  }
  const locale = opts.locale || 'en';

  // Dashboard HTML (server-rendered via renderDashboard).
  app.get('/api/finance/dashboard', async (req, res, next) => {
    try {
      const asOfDate = String(req.query.asOfDate || '').trim();
      const { renderDashboard } = await import('./dashboard.js');
      const html = await renderDashboard(pgAdapter, asOfDate, { locale });
      res.status(200).type('text/html; charset=utf-8').send(html);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // List invoices.
  app.get('/api/finance/invoices', async (req, res, next) => {
    try {
      const items = await listInvoices(pgAdapter, {});
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Get one invoice (with lines).
  app.get('/api/finance/invoices/:id', async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const invoice = await getInvoice(pgAdapter, id);
      if (!invoice) {
        return res.status(404).json({ error: 'not_found' });
      }
      res.status(200).json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // List customers.
  app.get('/api/finance/customers', async (req, res, next) => {
    try {
      const items = await listCustomers(pgAdapter);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // VAT return for a given YYYY-MM.
  app.get('/api/finance/vat/return', async (req, res, next) => {
    try {
      const yearMonth = String(req.query.yearMonth || '').trim();
      assertYearMonth(yearMonth);
      // Empty DB → empty sales/purchases → all-zero return. The pure
      // function handles the carry-forward read/write on the same DB.
      const result = await computeAndCloseVatPeriod(pgAdapter, yearMonth, [], []);
      res.status(200).json(result);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // e-invoice export for a single invoice.
  app.get('/api/finance/einvoice/export/:invoiceId', async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.invoiceId);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const supplier = defaultSupplier();
      const result = await exportInvoiceEInvoice(pgAdapter, id, supplier);
      res.status(200).json(result);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });
}
