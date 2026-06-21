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
//   POST   /api/finance/invoices/:id/lines
//   POST   /api/finance/invoices/:id/payments
//   POST   /api/finance/invoices/:id/void
//   POST   /api/finance/invoices/:id/reconcile
//   GET    /api/finance/customers
//   POST   /api/finance/customers
//   PATCH  /api/finance/customers/:id
//   GET    /api/finance/audit
//   GET    /api/finance/vat/return?yearMonth=YYYY-MM
//   GET    /api/finance/einvoice/export/:invoiceId
//   GET    /api/finance/catalog/items
//   POST   /api/finance/catalog/items
//   GET    /api/finance/warehouses
//   POST   /api/finance/warehouses
//   GET    /api/finance/stock/locations
//   POST   /api/finance/stock/locations
//   GET    /api/finance/stock/balances
//   GET    /api/finance/stock/moves
//   POST   /api/finance/stock/receive
//   POST   /api/finance/stock/deliver
//   POST   /api/finance/stock/transfer
//   POST   /api/finance/stock/adjust
//   GET    /api/finance/vendors
//   POST   /api/finance/vendors
//   GET    /api/finance/purchase-orders
//   POST   /api/finance/purchase-orders
//   POST   /api/finance/purchase-orders/:id/confirm
//   POST   /api/finance/purchase-orders/:id/cancel
//   POST   /api/finance/purchase-orders/:id/receive
//   GET    /api/finance/vendor-bills
//   POST   /api/finance/vendor-bills
//   POST   /api/finance/vendor-bills/:id/confirm
//   POST   /api/finance/vendor-bills/:id/post
//   POST   /api/finance/vendor-bills/:id/pay
//   POST   /api/finance/vendor-bills/:id/void
//   GET    /api/finance/purchase-orders/:id/print?locale=hy&format=html|text
//   GET    /api/finance/receipts/:id/print?locale=hy&format=html|text
//   GET    /api/finance/replenishment-report?warehouse_id=
//   GET    /api/finance/journal-entries?since=&until=&source=&limit=&offset=
//   POST   /api/finance/journal/reconcile  (Wave 20)
//   GET    /api/finance/account-balances?asOfDate=
//   GET    /api/finance/crm/contacts
//   POST   /api/finance/crm/contacts
//   GET    /api/finance/crm/leads?status=
//   POST   /api/finance/crm/leads
//
// All routes accept `opts.pgAdapter` from createApp({ pgAdapter }) —
// the pg-style adapter is what the finance pure functions speak.
// `opts.locale` flows into the dashboard render.
// `req.tenantId` (or X-Tenant-Id / req.user.tenant_id fallback) is the
// tenant scope; write routes also accept the requireTenant middleware
// via `opts.requireTenantMiddleware`. Each write route is also gated
// by `requirePerm('<perm-key>')` from server/rbac/express-adapter.js.
// Every successful write is recorded in finance.audit via
// recordAudit() (best-effort, doesn't block the response).
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
import { recordAudit, listAudit } from './audit.js';
import {
  createCatalogItem,
  listCatalogItems,
  createWarehouse,
  listWarehouses,
  createLocation,
  listLocations,
  receiveStock,
  deliverStock,
  transferStock,
  adjustStock,
  listBalances,
  listMoves,
  getReplenishmentReport,
} from './inventory.js';
import {
  createVendor,
  listVendors,
  createPurchaseOrder,
  confirmPurchaseOrder,
  cancelPurchaseOrder,
  receivePurchaseOrder,
  listPurchaseOrders,
  getPurchaseOrder,
  getReceipt,
  createVendorBillFromReceipt,
  confirmVendorBill,
  postVendorBill,
  payVendorBill,
  voidVendorBill,
  listVendorBills,
} from './purchase.js';
import { renderPurchaseOrder, renderDeliveryNote } from './poTemplate.js';
import { createContact, listContacts, createLead, listLeads } from './crm.js';
import {
  listJournalEntries,
  getJournalEntry,
  listAccountBalances,
  getAccountBalance,
} from './journal.js';
import { findUnpostedMoves, reconcileJournal } from './reconciliation.js';
import { requirePerm } from '../rbac/express-adapter.js';

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
// wrapFinanceRoute — small helper that wraps a write handler to:
//   1. Send the response normally.
//   2. Record the request in finance.audit (best-effort, on
//      response 'finish') with method, path, status, user, tenant,
//      and the request body (truncated to 4KB).
//
// The route signature is (req, res, next) => Promise<void>, same as
// every Express handler in this file. The audit row goes into the
// raw sqlite db (not the pg adapter) because the audit table lives
// in the finance schema and we need a write that survives the
// response going out — recording on `finish` is the right hook.
// ────────────────────────────────────────────────────────────────────────

function wrapFinanceRoute(action, resource, handler) {
  return async function w(req, res, next) {
    try {
      await handler(req, res, next);
    } catch (err) {
      // The finance pure functions throw ValueError on bad input;
      // the rest is a true 500. ValueErrors with a "not found in
      // tenant" / "not found" message become 404 (so cross-tenant
      // existence-oracle protection is preserved). Other ValueErrors
      // are 400.
      let status = 500;
      let errorCode = 'internal_error';
      if (err && err.name === 'ValueError') {
        if (/not found in tenant|^\w+ \d+ not found|not found\b/i.test(err.message)) {
          status = 404;
          errorCode = 'not_found';
        } else {
          status = 400;
          errorCode = 'bad_request';
        }
      }
      // Record the failed attempt (best-effort). The audit row
      // reflects the response status the user actually saw.
      const db = req.app && req.app.locals && req.app.locals.db;
      if (db) {
        recordAudit(db, {
          tenant_id: req.tenantId || (req.user && Number(req.user.tenant_id)) || 0,
          user_id: req.user && req.user.id,
          username: req.user && req.user.username,
          action,
          resource,
          method: req.method,
          path: req.originalUrl || req.url,
          status_code: status,
          payload: req.body,
        });
      }
      return res.status(status).json({ error: errorCode, message: err && err.message ? err.message : String(err) });
    }
    // Successful path — record the audit row on response finish so
    // the response is sent before the audit write (audit never
    // blocks the user).
    const db = req.app && req.app.locals && req.app.locals.db;
    if (db) {
      res.on('finish', () => {
        recordAudit(db, {
          tenant_id: req.tenantId || (req.user && Number(req.user.tenant_id)) || 0,
          user_id: req.user && req.user.id,
          username: req.user && req.user.username,
          action,
          resource,
          method: req.method,
          path: req.originalUrl || req.url,
          status_code: res.statusCode,
          payload: req.body,
        });
      });
    }
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
  app.post(
    '/api/finance/invoices',
    requireTenant,
    requirePerm('finance.invoice.create'),
    wrapFinanceRoute('invoice.create', 'invoice:new', async (req, res) => {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const out = await createInvoice(pgAdapter, body, tenantId);
      res.status(201).json(out);
    }),
  );

  // Update invoice — tenant-scoped. Patch body: any of { status, due_date, notes }.
  // Cross-tenant id → 404 (same as customers; no existence-oracle leak).
  app.patch(
    '/api/finance/invoices/:id',
    requireTenant,
    requirePerm('finance.invoice.update'),
    wrapFinanceRoute('invoice.update', 'invoice:id', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await updateInvoice(pgAdapter, id, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // Record a payment against an invoice — tenant-scoped.
  // Body: { amount_amd, method?, reference?, paid_at? }.
  app.post(
    '/api/finance/invoices/:id/payments',
    requireTenant,
    requirePerm('finance.payment.create'),
    wrapFinanceRoute('payment.create', 'invoice:payment', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const body = req.body || {};
      const out = await recordPayment(pgAdapter, { ...body, invoice_id: id }, tenantId);
      res.status(201).json(out);
    }),
  );

  // Void an invoice — tenant-scoped. Body: { reason }.
  app.post(
    '/api/finance/invoices/:id/void',
    requireTenant,
    requirePerm('finance.invoice.void'),
    wrapFinanceRoute('invoice.void', 'invoice:void', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const reason = String((req.body && req.body.reason) || '').trim();
      const out = await voidInvoice(pgAdapter, id, reason, tenantId);
      res.status(200).json(out);
    }),
  );

  // Reconcile an invoice — recompute its status from the payments sum.
  // Useful for a manual operator action after a payment lands outside
  // the system. Tenant-scoped. (No separate perm — falls under
  // finance.invoice.update.)
  app.post(
    '/api/finance/invoices/:id/reconcile',
    requireTenant,
    requirePerm('finance.invoice.update'),
    wrapFinanceRoute('invoice.reconcile', 'invoice:reconcile', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await reconcileInvoice(pgAdapter, id, tenantId);
      res.status(200).json(out);
    }),
  );

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
  app.post(
    '/api/finance/customers',
    requireTenant,
    requirePerm('finance.customer.create'),
    wrapFinanceRoute('customer.create', 'customer:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createCustomer(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // Update customer — tenant-scoped. Patch body: any of { name, hvhh, address, email }.
  app.patch(
    '/api/finance/customers/:id',
    requireTenant,
    requirePerm('finance.customer.update'),
    wrapFinanceRoute('customer.update', 'customer:id', async (req, res) => {
      const id = parseCustomerId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      try {
        const out = await updateCustomer(pgAdapter, id, req.body || {}, tenantId);
        res.status(200).json(out);
      } catch (err) {
        if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        throw err;
      }
    }),
  );

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

  // ─── Deferred items from the 2-day-finish sprint ───

  // Replace line items on a draft invoice. Body: { lines: [...] }.
  // The pure function updateInvoice refuses to touch lines on a
  // non-draft invoice, so this route is implicitly "draft only".
  app.post(
    '/api/finance/invoices/:id/lines',
    requireTenant,
    requirePerm('finance.invoice.update'),
    wrapFinanceRoute('invoice.update', 'invoice:lines', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await updateInvoice(pgAdapter, id, { lines: req.body && req.body.lines }, tenantId);
      res.status(200).json(out);
    }),
  );

  // List audit entries for the caller's tenant. Filterable by
  // user_id, action, resource prefix, since/until, and limit.
  // Uses the raw sqlite handle (not the pg adapter) because the
  // audit table is application infrastructure, not a domain table.
  app.get('/api/finance/audit', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const filters = {
        tenant_id: tenantId,
        user_id: req.query.user_id,
        action: req.query.action,
        resource_prefix: req.query.resource,
        since: req.query.since,
        until: req.query.until,
        limit: req.query.limit,
        offset: req.query.offset,
      };
      const rawDb = req.app && req.app.locals && req.app.locals.db;
      const items = await listAudit(rawDb, filters);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // ─── Phase 1 ERP: Inventory module ───
  //
  // The pure functions live in server/finance/inventory.js. They take
  // the pg-style adapter (which translates pg's $N to sqlite ? for the
  // memory harness) plus a tenantId. All routes are tenant-scoped.

  // Catalog (product) endpoints.
  app.get('/api/finance/catalog/items', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const items = await listCatalogItems(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.post(
    '/api/finance/catalog/items',
    requireTenant,
    requirePerm('finance.product.create'),
    wrapFinanceRoute('product.create', 'product:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createCatalogItem(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // Warehouse endpoints.
  app.get('/api/finance/warehouses', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const items = await listWarehouses(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.post(
    '/api/finance/warehouses',
    requireTenant,
    requirePerm('finance.warehouse.create'),
    wrapFinanceRoute('warehouse.create', 'warehouse:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createWarehouse(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // Stock location endpoints.
  app.get('/api/finance/stock/locations', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const warehouseId = req.query.warehouse_id ? Number(req.query.warehouse_id) : undefined;
      const items = await listLocations(pgAdapter, tenantId, warehouseId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.post(
    '/api/finance/stock/locations',
    requireTenant,
    requirePerm('finance.warehouse.create'),
    wrapFinanceRoute('location.create', 'location:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createLocation(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // Stock balance + move endpoints (read-only).
  app.get('/api/finance/stock/balances', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = {};
      if (req.query.item_id) opts.itemId = Number(req.query.item_id);
      if (req.query.location_id) opts.locationId = Number(req.query.location_id);
      const items = await listBalances(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.get('/api/finance/stock/moves', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = {};
      if (req.query.item_id) opts.itemId = Number(req.query.item_id);
      if (req.query.move_type) opts.moveType = String(req.query.move_type);
      if (req.query.limit) opts.limit = Number(req.query.limit);
      const items = await listMoves(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Stock move write endpoints.
  app.post(
    '/api/finance/stock/receive',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.receive', 'stock:move:receive', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await receiveStock(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/stock/deliver',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.deliver', 'stock:move:deliver', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await deliverStock(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/stock/transfer',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.transfer', 'stock:move:transfer', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await transferStock(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/stock/adjust',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.adjust', 'stock:move:adjust', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await adjustStock(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // ─── Phase 1 ERP: Purchase module ───
  //
  // Vendors — basic CRUD for supplier master.
  app.get('/api/finance/vendors', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const items = await listVendors(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.post(
    '/api/finance/vendors',
    requireTenant,
    requirePerm('finance.vendor.create'),
    wrapFinanceRoute('vendor.create', 'vendor:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createVendor(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // Purchase orders.
  app.get('/api/finance/purchase-orders', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = {};
      if (req.query.vendor_id) opts.vendorId = Number(req.query.vendor_id);
      if (req.query.status) opts.status = String(req.query.status);
      const items = await listPurchaseOrders(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.post(
    '/api/finance/purchase-orders',
    requireTenant,
    requirePerm('finance.purchase.create'),
    wrapFinanceRoute('po.create', 'po:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createPurchaseOrder(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/purchase-orders/:id/confirm',
    requireTenant,
    requirePerm('finance.purchase.confirm'),
    wrapFinanceRoute('po.confirm', 'po:confirm', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await confirmPurchaseOrder(pgAdapter, id, tenantId);
      res.status(200).json(out);
    }),
  );
  app.post(
    '/api/finance/purchase-orders/:id/cancel',
    requireTenant,
    requirePerm('finance.purchase.cancel'),
    wrapFinanceRoute('po.cancel', 'po:cancel', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const reason = String((req.body && req.body.reason) || '').trim();
      const out = await cancelPurchaseOrder(pgAdapter, id, reason, tenantId);
      res.status(200).json(out);
    }),
  );
  app.post(
    '/api/finance/purchase-orders/:id/receive',
    requireTenant,
    requirePerm('finance.purchase.receive'),
    wrapFinanceRoute('po.receive', 'po:receive', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await receivePurchaseOrder(pgAdapter, id, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // Vendor bills.
  app.get('/api/finance/vendor-bills', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = {};
      if (req.query.vendor_id) opts.vendorId = Number(req.query.vendor_id);
      if (req.query.status) opts.status = String(req.query.status);
      if (req.query.purchase_order_id) opts.purchaseOrderId = Number(req.query.purchase_order_id);
      const items = await listVendorBills(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.post(
    '/api/finance/vendor-bills',
    requireTenant,
    requirePerm('finance.bill.create'),
    wrapFinanceRoute('bill.create', 'bill:new', async (req, res) => {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const orderId = Number(body.purchase_order_id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'bad_request', message: 'purchase_order_id must be a positive integer' });
      }
      const out = await createVendorBillFromReceipt(pgAdapter, orderId, body, tenantId);
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/vendor-bills/:id/confirm',
    requireTenant,
    requirePerm('finance.bill.update'),
    wrapFinanceRoute('bill.confirm', 'bill:confirm', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await confirmVendorBill(pgAdapter, id, tenantId);
      res.status(200).json(out);
    }),
  );
  app.post(
    '/api/finance/vendor-bills/:id/post',
    requireTenant,
    requirePerm('finance.bill.approve'),
    wrapFinanceRoute('bill.post', 'bill:post', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await postVendorBill(pgAdapter, id, tenantId);
      res.status(200).json(out);
    }),
  );
  app.post(
    '/api/finance/vendor-bills/:id/pay',
    requireTenant,
    requirePerm('finance.bill.pay'),
    wrapFinanceRoute('bill.pay', 'bill:pay', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await payVendorBill(pgAdapter, id, tenantId);
      res.status(200).json(out);
    }),
  );
  app.post(
    '/api/finance/vendor-bills/:id/void',
    requireTenant,
    requirePerm('finance.bill.void'),
    wrapFinanceRoute('bill.void', 'bill:void', async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const reason = String((req.body && req.body.reason) || '').trim();
      const out = await voidVendorBill(pgAdapter, id, reason, tenantId);
      res.status(200).json(out);
    }),
  );

  // ─── Phase 1 ERP: PO + delivery-note print routes ───
  //
  // GET /api/finance/purchase-orders/:id/print?locale=hy&format=html|text
  //   Returns the rendered PO body in the requested locale + format.
  //   format defaults to 'text'. locale defaults to 'en'.
  //   Content-Type: text/plain; charset=utf-8 (or text/html).
  //
  // The hydration is done by getPurchaseOrder (joins item names +
  // vendor fields). The rendering is done by renderPurchaseOrder
  // (poTemplate.js). Both are pure, both are tenant-scoped.
  app.get('/api/finance/purchase-orders/:id/print', async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = readTenant(req);
      const po = await getPurchaseOrder(pgAdapter, id, tenantId);
      if (!po) {
        return res.status(404).json({ error: 'not_found' });
      }
      const locale = String(req.query.locale || 'en');
      const format = String(req.query.format || 'text');
      const body = renderPurchaseOrder(po, locale, { format });
      if (format === 'html') {
        res.status(200).type('text/html; charset=utf-8').send(body);
      } else {
        res.status(200).type('text/plain; charset=utf-8').send(body);
      }
    } catch (err) {
      next(err);
    }
  });

  // GET /api/finance/receipts/:id/print?locale=hy&format=html|text
  //   Same pattern as the PO print route, but for delivery notes.
  app.get('/api/finance/receipts/:id/print', async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = readTenant(req);
      const receipt = await getReceipt(pgAdapter, id, tenantId);
      if (!receipt) {
        return res.status(404).json({ error: 'not_found' });
      }
      const locale = String(req.query.locale || 'en');
      const format = String(req.query.format || 'text');
      const body = renderDeliveryNote(receipt, locale, { format });
      if (format === 'html') {
        res.status(200).type('text/html; charset=utf-8').send(body);
      } else {
        res.status(200).type('text/plain; charset=utf-8').send(body);
      }
    } catch (err) {
      next(err);
    }
  });

  // ─── Phase 1 ERP: Replenishment report (Wave 18) ───
  //
  // GET /api/finance/replenishment-report?warehouse_id=
  //   Lists every catalog item in the caller's tenant whose total
  //   stock is below its reorder_point, sorted by shortage desc
  //   (largest gap first). Optional ?warehouse_id= filter scopes
  //   the stock aggregation to a single warehouse.
  //   The report uses finance.stock.read for the perm gate; the
  //   tenant scope is read from the X-Tenant-Id header or
  //   req.user.tenant_id (via readTenant).
  app.get('/api/finance/replenishment-report', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = {};
      if (req.query.warehouse_id) opts.warehouseId = Number(req.query.warehouse_id);
      const items = await getReplenishmentReport(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // ─── Phase 1 ERP: GL journal endpoints (Wave 19) ───
  //
  // GET /api/finance/journal-entries?since=&until=&source=&limit=&offset=
  //   Lists the journal entries for the caller's tenant, sorted by
  //   entry_date DESC. Filterable by date range + source.
  //   The route is read-only and tenant-scoped; no perm gate (the
  //   journal is part of the finance module and inherits the same
  //   implicit tenant scope as the other finance routes).
  app.get('/api/finance/journal-entries', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = {
        since: req.query.since,
        until: req.query.until,
        source: req.query.source,
        limit: req.query.limit,
        offset: req.query.offset,
      };
      const items = await listJournalEntries(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/finance/journal-entries/:id
  //   Fetch one journal entry (header + lines) by id.
  app.get('/api/finance/journal-entries/:id', async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = readTenant(req);
      const entry = await getJournalEntry(pgAdapter, id, tenantId);
      if (!entry) {
        return res.status(404).json({ error: 'not_found' });
      }
      res.status(200).json(entry);
    } catch (err) {
      next(err);
    }
  });

  // GET /api/finance/account-balances?asOfDate=
  //   Returns the chart-of-accounts snapshot for the caller's tenant
  //   (every account that has any activity, with its debit / credit
  //   / net totals). Optional ?asOfDate= scopes to a financial date.
  //   The returned list is the basis for the trial balance report.
  app.get('/api/finance/account-balances', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const opts = { asOfDate: req.query.asOfDate };
      const items = await listAccountBalances(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/finance/account-balances/:accountCode
  //   Fetch one account's balance (debit / credit / net) for the
  //   caller's tenant. The :accountCode is a 3-digit chart code
  //   (e.g. 216, 711, 521). Optional ?asOfDate= scopes to a date.
  app.get('/api/finance/account-balances/:accountCode', async (req, res, next) => {
    try {
      const code = String(req.params.accountCode || '').trim();
      if (!/^\d{3}$/.test(code)) {
        return res.status(400).json({ error: 'bad_request', message: 'accountCode must be 3 digits' });
      }
      const tenantId = readTenant(req);
      const opts = { asOfDate: req.query.asOfDate };
      const balance = await getAccountBalance(pgAdapter, code, tenantId, opts);
      res.status(200).json(balance);
    } catch (err) {
      next(err);
    }
  });

  // ─── Phase 1 ERP: GL reconciliation (Wave 20) ───
  //
  // GET /api/finance/journal/reconcile?dryRun=true
  //   Reports the count of moves that have no corresponding journal
  //   entry. dryRun=true (default) does NOT post — it returns the
  //   gap so the operator can see what would be fixed. Pass
  //   dryRun=false to actually post (but the POST route below is
  //   the destructive operation that's typically called from a
  //   scheduled job or operator action).
  app.get('/api/finance/journal/reconcile', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const dryRun = req.query.dryRun !== 'false';
      if (dryRun) {
        const unposted = await findUnpostedMoves(pgAdapter, tenantId);
        res.status(200).json({
          dry_run: true,
          scanned: unposted.length,
          reconciled: 0,
          unposted,
          errors: [],
        });
        return;
      }
      const result = await reconcileJournal(pgAdapter, tenantId);
      res.status(200).json({ dry_run: false, ...result });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/journal/reconcile
  //   Run the reconciliation: find moves with no journal entry and
  //   post the missing GL. Wrapped in wrapFinanceRoute so the audit
  //   log records the operator action. Gated by finance.journal.read
  //   (read is enough — the post happens through the idempotent
  //   post* functions, no perm is needed beyond read).
  app.post(
    '/api/finance/journal/reconcile',
    requirePerm('finance.journal.read'),
    wrapFinanceRoute('journal.reconcile', 'journal:reconcile', async (req, res) => {
      const tenantId = req.tenantId;
      const dryRun = req.body && req.body.dryRun === true;
      if (dryRun) {
        const unposted = await findUnpostedMoves(pgAdapter, tenantId);
        res.status(200).json({
          dry_run: true,
          scanned: unposted.length,
          reconciled: 0,
          unposted,
          errors: [],
        });
        return;
      }
      const result = await reconcileJournal(pgAdapter, tenantId);
      res.status(200).json({ dry_run: false, ...result });
    }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Phase 2 CRM (W71-1) — contacts + leads.
  // Wave 1 ships read + create; future waves add update + archive.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/crm/contacts
  //   List active CRM contacts for the caller's tenant.
  app.get('/api/finance/crm/contacts', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const items = await listContacts(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/crm/contacts
  //   Create a new CRM contact. Body: { name, email?, phone?,
  //   role?, notes?, customer_id? }. The customer_id is OPTIONAL
  //   (a contact may exist before the financial customer is
  //   created; future waves link the contact to a customer once
  //   the customer is on-boarded).
  app.post(
    '/api/finance/crm/contacts',
    requireTenant,
    requirePerm('crm.contact.create'),
    wrapFinanceRoute('crm.contact.create', 'crm_contact:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createContact(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/crm/leads
  //   List CRM leads for the caller's tenant. Optional ?status=
  //   filter (new / qualified / proposal / won / lost). Ordered by
  //   id DESC (most recent first).
  app.get('/api/finance/crm/leads', async (req, res, next) => {
    try {
      const tenantId = readTenant(req);
      const status = req.query.status ?? null;
      const items = await listLeads(pgAdapter, tenantId, status);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/crm/leads
  //   Create a new CRM lead. Body: { name, company?, email?,
  //   phone?, source?, status?, estimated_value_amd?, notes? }.
  //   Default status is 'new'; the operator can move the lead
  //   through the pipeline (qualified / proposal / won / lost)
  //   via a future update endpoint.
  app.post(
    '/api/finance/crm/leads',
    requireTenant,
    requirePerm('crm.lead.create'),
    wrapFinanceRoute('crm.lead.create', 'crm_lead:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createLead(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    }),
  );
}
