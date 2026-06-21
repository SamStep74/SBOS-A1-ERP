// SBOS-A1-ERP finance HTTP routes — thin Express wrappers around the
// finance pure functions (server/finance/{invoice,reports,vatLedger,
// einvoiceExport}.js). The wrapper exists so that the bootable
// `npm run serve` entry point can expose the finance domain over HTTP.
//
// Endpoints:
//   GET    /api/finance/dashboard?asOfDate=YYYY-MM-DD
//   GET    /api/finance/invoices
//   GET    /api/finance/invoices/:id
//   POST   /api/finance/invoices
//   PATCH  /api/finance/invoices/:id
//   POST   /api/finance/invoices/:id/payments
//   POST   /api/finance/invoices/:id/void
//   POST   /api/finance/invoices/:id/reconcile
//   GET    /api/finance/customers
//   POST   /api/finance/customers
//   PATCH  /api/finance/customers/:id
//   GET    /api/finance/vat/return?yearMonth=YYYY-MM
//   GET    /api/finance/einvoice/export/:invoiceId
//
// All routes accept `opts.pgAdapter` from createApp({ pgAdapter }) —
// the pg-style adapter is what the finance pure functions speak.
// `opts.locale` flows into the dashboard render.
// `req.tenantId` (or X-Tenant-Id / req.user.tenant_id fallback) is the
// tenant scope; write routes also accept the requireTenant middleware
// via `opts.requireTenantMiddleware`.
//
// No `eval`, no string-concat SQL, no `new Function`. The SQL the
// pure functions emit is fixed-string; we just translate param style.
import {
  listInvoices,
  getInvoice,
  createInvoice,
  updateInvoice,
  voidInvoice,
} from './invoice.js';
import { recordPayment, reconcileInvoice } from './payment.js';
import { createCustomer, updateCustomer, listCustomers as listCustomersPure } from './customer.js';
import { computeAndCloseVatPeriod } from './vatLedger.js';
import { exportInvoiceEInvoice } from './einvoiceExport.js';
import { requireTenant } from './tenant.js';

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

// parseCustomerId — same shape as parseInvoiceId, separate function for
// clarity in route code (the segment might be a customer id in a
// /api/finance/customers/:id path).
function parseCustomerId(segment) {
  if (typeof segment !== 'string') return null;
  const n = Number(segment);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

// readTenant — extracts the tenant scope from the request. Falls back
// to X-Tenant-Id header, then req.user.tenant_id, then 0. The auth
// stub in server/index.js sets req.user = { id, role, tenant_id: 0 }
// so the default is "tenant 0" (the bootstrap tenant).
function readTenant(req) {
  if (req && req.tenantId !== undefined && req.tenantId !== null) return Number(req.tenantId);
  const headerVal = req && req.headers && req.headers['x-tenant-id'];
  if (headerVal !== undefined && headerVal !== '') {
    const n = Number(headerVal);
    if (Number.isInteger(n) && n >= 0) return n;
  }
  if (req && req.user && req.user.tenant_id !== undefined) return Number(req.user.tenant_id);
  return 0;
}

// ────────────────────────────────────────────────────────────────────────
// Supplier stub — Task 2 replaces this with real per-tenant config.
// ────────────────────────────────────────────────────────────────────────

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

  // List invoices — tenant-scoped. The listInvoices pure function already
  // threads tenantId; the route picks it up from req (X-Tenant-Id or
  // req.user.tenant_id) and passes it through.
  app.get('/api/finance/invoices', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const items = await listInvoices(pgAdapter, {}, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Get one invoice (with lines) — tenant-scoped.
  app.get('/api/finance/invoices/:id', async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = readTenant(req);
      const invoice = await getInvoice(pgAdapter, id, tenantId);
      if (!invoice) {
        return res.status(404).json({ error: 'not_found' });
      }
      res.status(200).json(invoice);
    } catch (err) {
      next(err);
    }
  });

  // Create invoice — tenant-scoped. The body must include customer_id,
  // invoice_number, issue_date, due_date, lines[]; vat_amd/notes optional.
  app.post('/api/finance/invoices', requireTenant, async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const out = await createInvoice(pgAdapter, body, tenantId);
      res.status(201).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // Update invoice — tenant-scoped. Patch body: any of { status, due_date, notes }.
  // Cross-tenant id → 404 (same as customers; no existence-oracle leak).
  app.patch('/api/finance/invoices/:id', requireTenant, async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await updateInvoice(pgAdapter, id, req.body || {}, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        if (/invoice \d+ not found/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // Record a payment against an invoice — tenant-scoped.
  // Body: { amount_amd, method?, reference?, paid_at? }.
  app.post('/api/finance/invoices/:id/payments', requireTenant, async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const body = req.body || {};
      const out = await recordPayment(pgAdapter, { ...body, invoice_id: id }, tenantId);
      res.status(201).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        if (/invoice \d+ not found/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // Void an invoice — tenant-scoped. Body: { reason }.
  app.post('/api/finance/invoices/:id/void', requireTenant, async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const reason = String((req.body && req.body.reason) || '').trim();
      const out = await voidInvoice(pgAdapter, id, reason, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        if (/not found/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // Reconcile an invoice — recompute its status from the payments sum.
  // Useful for a manual operator action after a payment lands outside
  // the system. Tenant-scoped.
  app.post('/api/finance/invoices/:id/reconcile', requireTenant, async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await reconcileInvoice(pgAdapter, id, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        if (/not found/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // List customers — tenant-scoped.
  app.get('/api/finance/customers', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const items = await listCustomersPure(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Create customer — tenant-scoped. Body: { name, hvhh?, address?, email? }.
  app.post('/api/finance/customers', requireTenant, async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const out = await createCustomer(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // Update customer — tenant-scoped. Patch body: any of { name, hvhh, address, email }.
  app.patch('/api/finance/customers/:id', requireTenant, async (req, res, next) => {
    try {
      const id = parseCustomerId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await updateCustomer(pgAdapter, id, req.body || {}, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        // updateCustomer throws ValueError both for invalid input AND for
        // "not found in tenant" — distinguish by message text so the
        // route returns 404 for the latter, 400 for the former.
        if (/not found in tenant/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
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
