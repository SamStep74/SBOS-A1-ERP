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
//   GET    /api/finance/trial-balance?asOfDate=&locale=&format=  (Wave 22)
//   GET    /api/finance/crm/contacts
//   POST   /api/finance/crm/contacts
//   GET    /api/finance/crm/leads?status=
//   POST   /api/finance/crm/leads
//   GET    /api/finance/desk/cases?status=
//   GET    /api/finance/desk/cases/:id
//   POST   /api/finance/desk/cases
//   GET    /api/finance/desk/cases/:id/replies
//   POST   /api/finance/desk/cases/:id/replies
//   GET    /api/finance/projects?status=
//   GET    /api/finance/projects/:id
//   POST   /api/finance/projects
//   GET    /api/finance/projects/:id/tasks?status=
//   POST   /api/finance/projects/:id/tasks
//   GET    /api/finance/projects/:id/tasks/:taskId
//   GET    /api/finance/projects/:id/tasks/:taskId/time-entries
//   POST   /api/finance/projects/:id/tasks/:taskId/time-entries
//   GET    /api/finance/catalog/categories?parent_id=
//   POST   /api/finance/catalog/categories
//   GET    /api/finance/catalog/categories/:id
//   GET    /api/finance/catalog/categories/:id/path
//   GET    /api/finance/catalog/items/:itemId/variants
//   POST   /api/finance/catalog/items/:itemId/variants
//   GET    /api/finance/catalog/variants/:id
//   GET    /api/finance/catalog/bundles?archived=
//   POST   /api/finance/catalog/bundles
//   GET    /api/finance/catalog/bundles/:id
//   GET    /api/finance/catalog/bundles/:id/items
//   POST   /api/finance/catalog/bundles/:id/items
//   GET    /api/finance/pos/registers           (Phase 3 W88-1)
//   POST   /api/finance/pos/registers
//   GET    /api/finance/pos/registers/:id
//   GET    /api/finance/pos/shifts
//   POST   /api/finance/pos/shifts
//   GET    /api/finance/pos/shifts/:id
//   POST   /api/finance/pos/shifts/:id/close
//   POST   /api/finance/pos/sales
//   POST   /api/finance/pos/sales/:id/lines
//   POST   /api/finance/pos/sales/:id/payments
//   POST   /api/finance/pos/sales/:id/complete   (Phase 3 W89-1)
//   POST   /api/finance/pos/sales/:id/void
//   POST   /api/finance/pos/sales/:id/refund
//   GET    /api/finance/pos/sales/:id/refunds
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
import { getCustomer360 } from './customer360.js';
import { getVendor360 } from './vendor360.js';
import { getDashboard360 } from './dashboard360.js';
import { computeAndCloseVatPeriod } from './vatLedger.js';
import { exportInvoiceEInvoice } from './einvoiceExport.js';
import { requireTenant } from './tenant.js';
import { recordAudit, listAudit, streamAuditCsv } from './audit.js';
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
  createCase,
  listCases,
  getCase,
  createReply,
  listReplies,
} from './desk.js';
import {
  createProject,
  listProjects,
  getProject,
  createTask,
  listTasks,
  getTask,
  createTimeEntry,
  listTimeEntries,
} from './projects.js';
import {
  createCategory,
  listCategories,
  getCategory,
  getCategoryPath,
  createVariant,
  listVariants,
  getVariant,
  createBundle,
  listBundles,
  getBundle,
  addBundleItem,
  listBundleItems,
} from './catalog.js';
import {
  openShift,
  listShifts,
  getShift,
  closeShift,
  addSale,
  addSaleLine,
  addPayment,
  addRegister,
  listRegisters,
  getRegister,
  completeSale,
  voidSale,
  refundSale,
  listRefunds,
} from './pos.js';
import {
  listJournalEntries,
  getJournalEntry,
  listAccountBalances,
  getAccountBalance,
} from './journal.js';
import { findUnpostedMoves, reconcileJournal } from './reconciliation.js';
import { renderTrialBalance, formatTrialBalanceText } from './trialBalance.js';
import { requirePerm } from '../rbac/express-adapter.js';
// Wave 39: lot + serial tracking routes. We import lazily because
// older deploys (pre-0014 migration) may not have the lots/serials
// tables — the lot/serial routes need to fail gracefully (503 or
// a clear 'not_supported' error) in that case.
let lotsModule = null;
async function getLotsModule() {
  if (lotsModule === null) {
    try {
      lotsModule = await import('./lots.js');
    } catch (_e) {
      lotsModule = false;
    }
  }
  return lotsModule || null;
}

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
  // Resolve the resource string for a given request. The route
  // table passes either:
  //   - a static string like 'invoice:new' or 'journal:reconcile'
  //     (the resource is constant per route), OR
  //   - a function (req) => 'invoice:' + req.params.id
  //     (the resource includes the URL parameter — Wave 29
  //     change so the audit row records the actual entity id),
  //     OR
  //   - a function (req, res) => 'invoice:' + res.locals.createdId
  //     (the resource includes the new entity id from the
  //     create response — Wave 30 change so creates also
  //     record the actual id, not the literal ':new').
  //
  // The function form lets every id-based write route
  // (PATCH /invoices/:id, POST /invoices/:id/void, etc.)
  // record 'invoice:42' instead of the literal 'invoice:id',
  // and every create route (POST /invoices, POST /customers,
  // POST /desk/cases/:id/replies, etc.) record
  // 'invoice:<newId>' instead of 'invoice:new'.
  const resolveResource = typeof resource === 'function'
    ? resource
    : () => resource;
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
          resource: resolveResource(req, res),
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
          resource: resolveResource(req, res),
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

  // Dashboard HTML (server-rendered via renderDashboard). Tenant-
  // scoped: the dashboard renders the calling tenant's data, not
  // the bootstrap tenant's. (renderDashboard already accepts
  // opts.tenantId and defaults to 0 if absent; Wave 28 wires it
  // through from the request so non-bootstrap tenants get the
  // right numbers.)
  app.get('/api/finance/dashboard', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const asOfDate = String(req.query.asOfDate || '').trim();
      const { renderDashboard } = await import('./dashboard.js');
      const html = await renderDashboard(pgAdapter, asOfDate, { locale, tenantId: req.tenantId });
      res.status(200).type('text/html; charset=utf-8').send(html);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // CFO dashboard JSON — AR + AP totals + top customers + top
  // vendors. Single round-trip, the whole collections + AP picture.
  // Wave 34/35. Companion to the existing /api/finance/dashboard
  // HTML view (above): same data, JSON shape, designed for an
  // external dashboard client (e.g. a CFO-facing webapp).
  //
  // Perm gate: reports.dashboard.read (the same perm the HTML
  // dashboard uses). Tenant scope: requireTenant middleware.
  //
  // Optional ?today=YYYY-MM-DD override (defaults to current
  // date inside the pure function). Same back-dated-aging pattern
  // as the customer/vendor 360 endpoints.
  app.get(
    '/api/finance/360',
    requireTenant,
    requirePerm('reports.dashboard.read'),
    async (req, res, next) => {
      try {
        const today = typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today)
          ? req.query.today
          : undefined;
        const limit = req.query.limit != null && /^\d+$/.test(String(req.query.limit))
          ? Number(req.query.limit)
          : undefined;
        const opts = {};
        if (today) opts.today = today;
        if (limit != null) opts.limit = limit;
        const out = await getDashboard360(pgAdapter, req.tenantId, opts);
        res.status(200).json(out);
      } catch (err) {
        // The pure function throws ValueError on bad inputs (bad
        // tenantId, bad today format). Map to 400; everything else
        // is a real 500.
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // List invoices — tenant-scoped. The listInvoices pure function already
  // threads tenantId; the route picks it up from req (X-Tenant-Id or
  // req.user.tenant_id) and passes it through.
  app.get('/api/finance/invoices', requireTenant, requirePerm('finance.invoice.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const items = await listInvoices(pgAdapter, {}, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Get one invoice (with lines) — tenant-scoped.
  app.get('/api/finance/invoices/:id', requireTenant, requirePerm('finance.invoice.read'), async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('invoice.create', (req, res) => res.locals.createdId ? `invoice:${res.locals.createdId}` : 'invoice:new', async (req, res) => {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const out = await createInvoice(pgAdapter, body, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Update invoice — tenant-scoped. Patch body: any of { status, due_date, notes }.
  // Cross-tenant id → 404 (same as customers; no existence-oracle leak).
  app.patch(
    '/api/finance/invoices/:id',
    requireTenant,
    requirePerm('finance.invoice.update'),
    wrapFinanceRoute('invoice.update', (req) => `invoice:${req.params.id}`, async (req, res) => {
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
    wrapFinanceRoute('payment.create', (req, res) => `invoice:${req.params.id}:payment:${res.locals.createdId}`, async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const body = req.body || {};
      const out = await recordPayment(pgAdapter, { ...body, invoice_id: id }, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Void an invoice — tenant-scoped. Body: { reason }.
  app.post(
    '/api/finance/invoices/:id/void',
    requireTenant,
    requirePerm('finance.invoice.void'),
    wrapFinanceRoute('invoice.void', (req) => `invoice:${req.params.id}:void`, async (req, res) => {
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
    wrapFinanceRoute('invoice.reconcile', (req) => `invoice:${req.params.id}:reconcile`, async (req, res) => {
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
  app.get('/api/finance/customers', requireTenant, requirePerm('finance.customer.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const items = await listCustomersPure(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // Customer 360 — CFO-facing full view: customer info + every
  // open invoice (with balance) + recent payments + totals + aging
  // buckets. Wave 31/32. Single round-trip, all the data a
  // collections reviewer needs to triage a customer.
  //
  // Perm gate: finance.customer.read (the same perm the customer
  // list / get uses; the 360 view is read-only, no extra perms).
  // Tenant scope: requireTenant (the standard Wave 28 middleware
  // pair — req.tenantId is stamped by the middleware).
  // Audit: this is a GET, so the audit log is NOT written by
  // wrapFinanceRoute (which is for writes only). The audit row
  // for the 360 read itself is unnecessary; the underlying
  // invoices / payments / customer are already auditable through
  // the existing write paths. Operators who want to see "who
  // pulled customer 42's 360 today" can find them via the
  // ?path=/api/finance/customers/42/360 audit filter if needed.
  app.get(
    '/api/finance/customers/:id/360',
    requireTenant,
    requirePerm('finance.customer.read'),
    async (req, res, next) => {
      try {
        const id = parseCustomerId(req.params.id);
        if (id === null) {
          return res.status(404).json({ error: 'not_found' });
        }
        const tenantId = req.tenantId;
        // Optional ?today=YYYY-MM-DD override (defaults to current
        // date inside the pure function). Useful for back-dated
        // aging reports and reproducible tests.
        const today = typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today)
          ? req.query.today
          : undefined;
        const out = await getCustomer360(pgAdapter, id, tenantId, today ? { today } : {});
        res.status(200).json(out);
      } catch (err) {
        // The pure function throws ValueError on missing or
        // cross-tenant customer; map both to 404 (no
        // existence-oracle leak between tenants — same pattern
        // as getProject / getTask / getInvoice).
        if (err && err.name === 'ValueError' && /not found in tenant/.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        next(err);
      }
    },
  );

  // Vendor 360 — CFO-facing full view: vendor info + every open
  // PO (with total + outstanding) + recent receipts + totals +
  // aging buckets. Wave 33/36. Mirror of the customer 360
  // (above) for the supply side.
  //
  // Perm gate: finance.vendor.read (the same perm the vendor
  // list / get uses). Tenant scope: requireTenant middleware.
  app.get(
    '/api/finance/vendors/:id/360',
    requireTenant,
    requirePerm('finance.vendor.read'),
    async (req, res, next) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const tenantId = req.tenantId;
        const today = typeof req.query.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(req.query.today)
          ? req.query.today
          : undefined;
        const out = await getVendor360(pgAdapter, id, tenantId, today ? { today } : {});
        res.status(200).json(out);
      } catch (err) {
        if (err && err.name === 'ValueError' && /not found in tenant/.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        next(err);
      }
    },
  );

  // ────────────────────────────────────────────────────────────────────
  // Wave 39 — lot + serial tracking endpoints
  //
  // Six routes. Read-only (CRUD lives in the lots module for now;
  // route-level create would need audit + form validation that's
  // out of scope for Wave 39 commit 3).
  //
  // Perm gates:
  //   - inventory.lot.read — for /api/finance/lots/:id, /lots (lists),
  //     /items/:itemId/lots, /locations/:locationId/lots
  //   - inventory.serial.read — for /api/finance/serials/:id,
  //     /serials (lists), /items/:itemId/serials,
  //     /locations/:locationId/serials
  //
  // Graceful degradation: if the lots module can't be loaded
  // (pre-0014 migration deploys), the routes return 501 with a
  // clear error message instead of 500. This matches the
  // graceful-degradation contract used for the A1-Validator
  // client (Wave 27 / Wave 38 lessons).
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/lots/:id — single lot by id.
  app.get(
    '/api/finance/lots/:id',
    requireTenant,
    requirePerm('inventory.lot.read'),
    async (req, res, next) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'lots module not available (run migration 0014)' });
        }
        const out = await lotsApi.getLot(pgAdapter, id, req.tenantId);
        if (out == null) {
          return res.status(404).json({ error: 'not_found' });
        }
        res.status(200).json(out);
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/lots — list lots. Required query: ?catalog_item_id=N.
  app.get(
    '/api/finance/lots',
    requireTenant,
    requirePerm('inventory.lot.read'),
    async (req, res, next) => {
      try {
        const itemId = Number(req.query.catalog_item_id);
        if (!Number.isInteger(itemId) || itemId <= 0) {
          return res.status(400).json({ error: 'bad_request', message: 'catalog_item_id is required' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'lots module not available (run migration 0014)' });
        }
        const out = await lotsApi.listLotsForItem(pgAdapter, itemId, req.tenantId);
        res.status(200).json({ items: out });
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/items/:itemId/lots — lots for a specific item,
  // joined with stock_lots so the response includes the per-location
  // quantity (the caller can also pass ?location_id=N to scope).
  app.get(
    '/api/finance/items/:itemId/lots',
    requireTenant,
    requirePerm('inventory.lot.read'),
    async (req, res, next) => {
      try {
        const itemId = Number(req.params.itemId);
        if (!Number.isInteger(itemId) || itemId <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'lots module not available (run migration 0014)' });
        }
        const locationId = req.query.location_id != null ? Number(req.query.location_id) : null;
        if (locationId != null && (!Number.isInteger(locationId) || locationId <= 0)) {
          return res.status(400).json({ error: 'bad_request', message: 'location_id must be a positive integer' });
        }
        if (locationId != null) {
          const lots = await lotsApi.listLotsForLocation(pgAdapter, req.tenantId, locationId);
          // Filter to just the lots for this item (listLotsForLocation
          // returns all lots at the location; client asked for this item).
          const filtered = lots.filter(l => l.catalog_item_id === itemId);
          return res.status(200).json({ items: filtered });
        }
        const out = await lotsApi.listLotsForItem(pgAdapter, itemId, req.tenantId);
        res.status(200).json({ items: out });
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/serials/:id — single serial by id.
  app.get(
    '/api/finance/serials/:id',
    requireTenant,
    requirePerm('inventory.serial.read'),
    async (req, res, next) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'serials module not available (run migration 0014)' });
        }
        const out = await lotsApi.getSerial(pgAdapter, id, req.tenantId);
        if (out == null) {
          return res.status(404).json({ error: 'not_found' });
        }
        res.status(200).json(out);
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/serials — list serials. Required query: ?catalog_item_id=N.
  // Optional: ?status=in_stock|sold|returned|lost|scrap, ?lot_id=N.
  app.get(
    '/api/finance/serials',
    requireTenant,
    requirePerm('inventory.serial.read'),
    async (req, res, next) => {
      try {
        const itemId = Number(req.query.catalog_item_id);
        if (!Number.isInteger(itemId) || itemId <= 0) {
          return res.status(400).json({ error: 'bad_request', message: 'catalog_item_id is required' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'serials module not available (run migration 0014)' });
        }
        const opts = {};
        if (req.query.status != null) opts.status = String(req.query.status);
        if (req.query.lot_id != null) {
          const lotId = Number(req.query.lot_id);
          if (!Number.isInteger(lotId) || lotId <= 0) {
            return res.status(400).json({ error: 'bad_request', message: 'lot_id must be a positive integer' });
          }
          opts.lot_id = lotId;
        }
        const out = await lotsApi.listSerialsForItem(pgAdapter, itemId, req.tenantId, opts);
        res.status(200).json({ items: out });
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/items/:itemId/serials — serials for a specific item,
  // optional ?status= and ?lot_id= filters. Useful for an item's
  // "where are my units?" drill-down.
  app.get(
    '/api/finance/items/:itemId/serials',
    requireTenant,
    requirePerm('inventory.serial.read'),
    async (req, res, next) => {
      try {
        const itemId = Number(req.params.itemId);
        if (!Number.isInteger(itemId) || itemId <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'serials module not available (run migration 0014)' });
        }
        const opts = {};
        if (req.query.status != null) opts.status = String(req.query.status);
        if (req.query.lot_id != null) {
          const lotId = Number(req.query.lot_id);
          if (!Number.isInteger(lotId) || lotId <= 0) {
            return res.status(400).json({ error: 'bad_request', message: 'lot_id must be a positive integer' });
          }
          opts.lot_id = lotId;
        }
        const out = await lotsApi.listSerialsForItem(pgAdapter, itemId, req.tenantId, opts);
        res.status(200).json({ items: out });
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // POST /api/finance/lots/:id/recall — flag a lot as recalled
  // and cascade status='recalled' to every serial in it.
  //
  // Wave 41 (regulatory compliance). Body: { reason, force? }.
  // Perm gate: inventory.lot.recall (high-sensitivity action —
  // the cascade is irreversible without {force: true}).
  app.post(
    '/api/finance/lots/:id/recall',
    requireTenant,
    requirePerm('inventory.lot.recall'),
    async (req, res, next) => {
      try {
        const lotId = Number(req.params.id);
        if (!Number.isInteger(lotId) || lotId <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'lots module not available (run migration 0016)' });
        }
        const body = req.body || {};
        const opts = {
          reason: body.reason,
          user_id: req.user && req.user.id ? Number(req.user.id) : null,
          force: body.force === true,
        };
        const out = await lotsApi.recallLot(pgAdapter, req.tenantId, lotId, opts);
        res.status(200).json(out);
      } catch (err) {
        if (err && err.name === 'ValueError' && /not found in tenant/.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/lots/:id/recalled-serials — list the serials
  // that were flagged recalled for a specific lot. Useful for
  // customer service to find unit numbers to reach out about.
  app.get(
    '/api/finance/lots/:id/recalled-serials',
    requireTenant,
    requirePerm('inventory.lot.read'),
    async (req, res, next) => {
      try {
        const lotId = Number(req.params.id);
        if (!Number.isInteger(lotId) || lotId <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const lotsApi = await getLotsModule();
        if (!lotsApi) {
          return res.status(501).json({ error: 'not_supported', message: 'lots module not available (run migration 0016)' });
        }
        const out = await lotsApi.listRecalledSerials(pgAdapter, req.tenantId, lotId);
        res.status(200).json({ items: out });
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // Create customer — tenant-scoped. Body: { name, hvhh?, address?, email? }.
  app.post(
    '/api/finance/customers',
    requireTenant,
    requirePerm('finance.customer.create'),
    wrapFinanceRoute('customer.create', (req, res) => res.locals.createdId ? `customer:${res.locals.createdId}` : 'customer:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createCustomer(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Update customer — tenant-scoped. Patch body: any of { name, hvhh, address, email }.
  app.patch(
    '/api/finance/customers/:id',
    requireTenant,
    requirePerm('finance.customer.update'),
    wrapFinanceRoute('customer.update', (req) => `customer:${req.params.id}`, async (req, res) => {
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
  app.get('/api/finance/vat/return', requireTenant, requirePerm('finance.tax.read'), async (req, res, next) => {
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
  app.get('/api/finance/einvoice/export/:invoiceId', requireTenant, requirePerm('finance.einvoice.read'), async (req, res, next) => {
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
    wrapFinanceRoute('invoice.update', (req) => `invoice:${req.params.id}:lines`, async (req, res) => {
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
  //
  // Perm gate: `security.audit.read` (bound to the AuditReader
  // perm set, which Owner / Admin / Auditor all hold). Without
  // the perm, the response is 403. The audit log is compliance
  // data — only readers with the audit permission can see it.
  app.get(
    '/api/finance/audit',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
      const tenantId = req.tenantId;
      const filters = {
        tenant_id: tenantId,
        user_id: req.query.user_id,
        action: req.query.action,
        resource_prefix: req.query.resource,
        resource_id: req.query.resource_id,
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
    },
  );

  // GET /api/finance/audit/export — CSV export of the audit log.
  //
  // Streams the audit log as a CSV file for compliance teams
  // (Excel / pandas / etc.). Same filter shape as the JSON
  // endpoint above. Uses async iteration to avoid buffering
  // the whole export in memory — chunks land on `res` as
  // they're read from the DB.
  //
  // Perm gate: `security.audit.read` (same as /audit).
  //
  // Query params (all optional):
  //   user_id, action, resource, resource_id, since, until,
  //   limit (default 10000, max 50000), offset, chunk_size
  app.get(
    '/api/finance/audit/export',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.tenantId;
        const filters = {
          tenant_id: tenantId,
          user_id: req.query.user_id,
          action: req.query.action,
          resource_prefix: req.query.resource,
          resource_id: req.query.resource_id,
          since: req.query.since,
          until: req.query.until,
          limit: req.query.limit,
          offset: req.query.offset,
        };
        const chunkSize = req.query.chunk_size != null ? Number(req.query.chunk_size) : 500;
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res.status(500).json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        // Stream headers — the file is named with today's date so
        // multiple exports on different days don't collide.
        const today = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader('Content-Disposition', `attachment; filename="audit-${today}.csv"`);
        res.setHeader('Cache-Control', 'no-store');
        // Iterate the generator and pipe chunks to res. Express's
        // default compression would gzip the response; CSV
        // is small enough that we don't bother.
        for await (const chunk of streamAuditCsv(rawDb, filters, chunkSize)) {
          // `res.write` returns false when the kernel buffer is full;
          // we await `drain` to avoid backpressure blowing up the
          // memory ceiling on large exports.
          if (!res.write(chunk)) {
            await new Promise((resolve) => res.once('drain', resolve));
          }
        }
        res.end();
      } catch (err) {
        next(err);
      }
    },
  );

  // ─── Phase 1 ERP: Inventory module ───
  //
  // The pure functions live in server/finance/inventory.js. They take
  // the pg-style adapter (which translates pg's $N to sqlite ? for the
  // memory harness) plus a tenantId. All routes are tenant-scoped.

  // Catalog (product) endpoints.
  app.get('/api/finance/catalog/items', requireTenant, requirePerm('finance.product.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('product.create', (req, res) => res.locals.createdId ? `product:${res.locals.createdId}` : 'product:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createCatalogItem(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Warehouse endpoints.
  app.get('/api/finance/warehouses', requireTenant, requirePerm('finance.warehouse.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('warehouse.create', (req, res) => res.locals.createdId ? `warehouse:${res.locals.createdId}` : 'warehouse:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createWarehouse(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Stock location endpoints.
  app.get('/api/finance/stock/locations', requireTenant, requirePerm('finance.warehouse.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('location.create', (req, res) => res.locals.createdId ? `location:${res.locals.createdId}` : 'location:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createLocation(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Stock balance + move endpoints (read-only).
  app.get('/api/finance/stock/balances', requireTenant, requirePerm('finance.stock.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const opts = {};
      if (req.query.item_id) opts.itemId = Number(req.query.item_id);
      if (req.query.location_id) opts.locationId = Number(req.query.location_id);
      const items = await listBalances(pgAdapter, tenantId, opts);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
  app.get('/api/finance/stock/moves', requireTenant, requirePerm('finance.stock.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('stock.receive', (req, res) => `stock_move:${res.locals.createdId}:receive`, async (req, res) => {
      const tenantId = req.tenantId;
      const out = await receiveStock(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/stock/deliver',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.deliver', (req, res) => `stock_move:${res.locals.createdId}:deliver`, async (req, res) => {
      const tenantId = req.tenantId;
      const out = await deliverStock(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/stock/transfer',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.transfer', (req, res) => `stock_move:${res.locals.createdId}:transfer`, async (req, res) => {
      const tenantId = req.tenantId;
      const out = await transferStock(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/stock/adjust',
    requireTenant,
    requirePerm('finance.stock.move'),
    wrapFinanceRoute('stock.adjust', (req, res) => `stock_move:${res.locals.createdId}:adjust`, async (req, res) => {
      const tenantId = req.tenantId;
      const out = await adjustStock(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // ─── Phase 1 ERP: Purchase module ───
  //
  // Vendors — basic CRUD for supplier master.
  app.get('/api/finance/vendors', requireTenant, requirePerm('finance.vendor.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('vendor.create', (req, res) => res.locals.createdId ? `vendor:${res.locals.createdId}` : 'vendor:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createVendor(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Purchase orders.
  app.get('/api/finance/purchase-orders', requireTenant, requirePerm('finance.purchase.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('po.create', (req, res) => res.locals.createdId ? `purchase_order:${res.locals.createdId}` : 'po:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createPurchaseOrder(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/purchase-orders/:id/confirm',
    requireTenant,
    requirePerm('finance.purchase.confirm'),
    wrapFinanceRoute('po.confirm', (req) => `purchase_order:${req.params.id}:confirm`, async (req, res) => {
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
    wrapFinanceRoute('po.cancel', (req) => `purchase_order:${req.params.id}:cancel`, async (req, res) => {
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
    wrapFinanceRoute('po.receive', (req, res) => `purchase_order:${req.params.id}:receive:${res.locals.createdId}`, async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const out = await receivePurchaseOrder(pgAdapter, id, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // Vendor bills.
  app.get('/api/finance/vendor-bills', requireTenant, requirePerm('finance.bill.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('bill.create', (req, res) => res.locals.createdId ? `vendor_bill:${res.locals.createdId}` : 'bill:new', async (req, res) => {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const orderId = Number(body.purchase_order_id);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        return res.status(400).json({ error: 'bad_request', message: 'purchase_order_id must be a positive integer' });
      }
      const out = await createVendorBillFromReceipt(pgAdapter, orderId, body, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );
  app.post(
    '/api/finance/vendor-bills/:id/confirm',
    requireTenant,
    requirePerm('finance.bill.update'),
    wrapFinanceRoute('bill.confirm', (req) => `vendor_bill:${req.params.id}:confirm`, async (req, res) => {
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
    wrapFinanceRoute('bill.post', (req) => `vendor_bill:${req.params.id}:post`, async (req, res) => {
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
    wrapFinanceRoute('bill.pay', (req) => `vendor_bill:${req.params.id}:pay`, async (req, res) => {
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
    wrapFinanceRoute('bill.void', (req) => `vendor_bill:${req.params.id}:void`, async (req, res) => {
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
  app.get('/api/finance/purchase-orders/:id/print', requireTenant, requirePerm('finance.purchase.read'), async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
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
  app.get('/api/finance/receipts/:id/print', requireTenant, requirePerm('finance.purchase.read'), async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
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
  app.get('/api/finance/replenishment-report', requireTenant, requirePerm('finance.stock.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
  app.get('/api/finance/journal-entries', requireTenant, requirePerm('finance.journal.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
  app.get('/api/finance/journal-entries/:id', requireTenant, requirePerm('finance.journal.read'), async (req, res, next) => {
    try {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
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
  app.get('/api/finance/account-balances', requireTenant, requirePerm('finance.journal.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
  app.get('/api/finance/account-balances/:accountCode', requireTenant, requirePerm('finance.journal.read'), async (req, res, next) => {
    try {
      const code = String(req.params.accountCode || '').trim();
      if (!/^\d{3}$/.test(code)) {
        return res.status(400).json({ error: 'bad_request', message: 'accountCode must be 3 digits' });
      }
      const tenantId = req.tenantId;
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
  app.get('/api/finance/journal/reconcile', requireTenant, requirePerm('finance.journal.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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

  // ─── Phase 1 ERP: Trial balance (Wave 22) ───
  //
  // GET /api/finance/trial-balance?asOfDate=&locale=&format=
  //   The classic CFO report: every account in the RA chart of
  //   accounts that has any activity, with its debit and credit
  //   totals in the natural sign of the account, and the
  //   assertion that total debits == total credits (i.e. the
  //   books balance). Optional asOfDate scopes the calculation
  //   to a financial date inclusive.
  //   The report format is JSON by default; pass format=text
  //   to get a server-rendered text report (useful for the
  //   Armenian print workflow).
  app.get('/api/finance/trial-balance', requireTenant, requirePerm('finance.journal.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const opts = {
        asOfDate: req.query.asOfDate,
        locale: String(req.query.locale || 'en'),
      };
      const report = await renderTrialBalance(pgAdapter, tenantId, opts);
      const format = String(req.query.format || 'json');
      if (format === 'text') {
        const text = formatTrialBalanceText(report, opts.locale);
        res.status(200).type('text/plain; charset=utf-8').send(text);
        return;
      }
      res.status(200).json(report);
    } catch (err) {
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 2 CRM (W71-1) — contacts + leads.
  // Wave 1 ships read + create; future waves add update + archive.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/crm/contacts
  //   List active CRM contacts for the caller's tenant.
  app.get('/api/finance/crm/contacts', requireTenant, requirePerm('crm.contact.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('crm.contact.create', (req, res) => res.locals.createdId ? `crm_contact:${res.locals.createdId}` : 'crm_contact:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createContact(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/crm/leads
  //   List CRM leads for the caller's tenant. Optional ?status=
  //   filter (new / qualified / proposal / won / lost). Ordered by
  //   id DESC (most recent first).
  app.get('/api/finance/crm/leads', requireTenant, requirePerm('crm.lead.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
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
    wrapFinanceRoute('crm.lead.create', (req, res) => res.locals.createdId ? `crm_lead:${res.locals.createdId}` : 'crm_lead:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createLead(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // ─────────── Desk (helpdesk / ticketing) — Phase 2 wave 2 (W73) ───────────
  //
  // The desk module is a multi-table ticketing / support module:
  //   desk_cases (id, tenant_id, customer_id, contact_id, subject,
  //     body, status, priority, assignee_id, tracking_number,
  //     created_at, updated_at)
  //   desk_replies (id, tenant_id, case_id, body, author, author_id,
  //     created_at)
  //
  // Statuses: open / pending / resolved / closed.
  // Priorities: low / normal / high / urgent.
  // Reply authors: customer / agent.
  //
  // Wave 2 wires 5 HTTP endpoints (matches the W70->W71 cadence for
  // CRM): 2 reads on cases (list + get), 1 write on cases (create),
  // 1 read on replies (list), 1 write on replies (create). The
  // 5 endpoints map to 3 perm keys:
  //   desk.case.read  — list + get
  //   desk.case.create — create
  //   desk.reply.create — create reply
  // The DeskOperator perm set in server/rbac/matrix.js already
  // includes all 3 keys (no perm changes needed for W73-1).

  // GET /api/finance/desk/cases
  //   List helpdesk cases for the caller's tenant. Optional
  //   ?status= filter (open / pending / resolved / closed). Ordered
  //   by id DESC (most recent first).
  app.get('/api/finance/desk/cases', requireTenant, requirePerm('desk.case.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const status = req.query.status ?? null;
      const items = await listCases(pgAdapter, tenantId, status);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // GET /api/finance/desk/cases/:id
  //   Get a single helpdesk case. Returns 404 if the case is missing
  //   or cross-tenant (the pure function throws ValueError on
  //   "not found in tenant"; the route handler converts to 404
  //   inline, since the global error handler returns 500 for
  //   everything else).
  app.get('/api/finance/desk/cases/:id', requireTenant, requirePerm('desk.case.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const caseId = Number(req.params.id);
      const item = await getCase(pgAdapter, caseId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/desk/cases
  //   Create a new helpdesk case. Body: { subject, body,
  //   status?, priority?, customer_id?, contact_id?,
  //   assignee_id?, tracking_number? }. subject + body are
  //   required. status defaults to 'open'; priority defaults to
  //   'normal'.
  app.post(
    '/api/finance/desk/cases',
    requireTenant,
    requirePerm('desk.case.create'),
    wrapFinanceRoute('desk.case.create', (req, res) => res.locals.createdId ? `desk_case:${res.locals.createdId}` : 'desk_case:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createCase(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/desk/cases/:id/replies
  //   List replies for a helpdesk case (chronological). Returns
  //   404 if the case is missing or cross-tenant. The pure
  //   listReplies function returns an empty array when the case
  //   is missing (it's a normal SQL result), so the route checks
  //   the case's existence first via getCase (which throws
  //   ValueError on "not found in tenant") and converts that to
  //   404 inline.
  app.get('/api/finance/desk/cases/:id/replies', requireTenant, requirePerm('desk.reply.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const caseId = Number(req.params.id);
      // Existence check: a request to list replies on a missing
      // case is 404 (consistent with the single-entity GET
      // /cases/:id pattern). Calling getCase also enforces
      // tenant isolation: a cross-tenant id becomes 404, not
      // 200 with an empty array (no existence-oracle leak).
      await getCase(pgAdapter, caseId, tenantId);
      const items = await listReplies(pgAdapter, caseId, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/desk/cases/:id/replies
  //   Add a reply to a helpdesk case. Body: { body, author,
  //   author_id? }. author must be 'customer' or 'agent'.
  app.post(
    '/api/finance/desk/cases/:id/replies',
    requireTenant,
    requirePerm('desk.reply.create'),
    wrapFinanceRoute(
      'desk.reply.create',
      (req, res) => `desk_reply:${res.locals.createdId}`,
      async (req, res) => {
        const tenantId = req.tenantId;
        const caseId = Number(req.params.id);
        const out = await createReply(pgAdapter, caseId, req.body || {}, tenantId);
        res.status(201).json(out);
      },
    ),
  );

  // ─────────── Projects (project management) — Phase 2 wave 2 (W75) ───────────
  //
  // The projects module is a 3-table hierarchical structure:
  //   projects (id, tenant_id, code, name, description, customer_id,
  //     status, start_date, end_date, owner_id, ...)
  //   project_tasks (id, tenant_id, project_id, name, description,
  //     status, priority, assignee_id, due_date, ...)
  //   project_time_entries (id, tenant_id, task_id, user_id, work_date,
  //     hours, billable, description, ...)
  //
  // Project statuses: active / on_hold / completed / cancelled.
  // Task statuses: todo / in_progress / done / blocked.
  // Task priorities: low / normal / high / urgent.
  //
  // Wave 2 wires 8 HTTP endpoints (matches the W70->W71 cadence for
  // CRM and the W72->W73 cadence for desk): 2 reads on projects
  // (list + get), 1 write on projects (create), 2 reads on tasks
  // (list + get), 1 write on tasks (create), 1 read on time entries
  // (list), 1 write on time entries (create). The 8 endpoints map
  // to 6 perm keys:
  //   projects.project.read    — list + get project
  //   projects.project.create  — create project
  //   projects.task.read       — list + get task
  //   projects.task.create     — create task
  //   projects.time.read       — list time entries
  //   projects.time.create     — create time entry
  // The ProjectsOperator perm set in server/rbac/matrix.js
  // already includes all 6 keys (no perm changes needed for W75-1).

  // GET /api/finance/projects
  //   List projects for the caller's tenant. Optional ?status=
  //   filter (active / on_hold / completed / cancelled). Ordered
  //   by id DESC (most recent first).
  app.get('/api/finance/projects', requireTenant, requirePerm('projects.project.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const status = req.query.status ?? null;
      const items = await listProjects(pgAdapter, tenantId, status);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/projects
  //   Create a new project. Body: { name, code?, description?,
  //   customer_id?, status?, start_date?, end_date?, owner_id? }.
  //   name is required. status defaults to 'active'.
  app.post(
    '/api/finance/projects',
    requireTenant,
    requirePerm('projects.project.create'),
    wrapFinanceRoute('projects.project.create', (req, res) => res.locals.createdId ? `project:${res.locals.createdId}` : 'project:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createProject(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/projects/:id
  //   Get a single project. Returns 404 if the project is missing
  //   or cross-tenant (the pure function throws ValueError on
  //   "not found in tenant"; the route handler converts to 404
  //   inline, consistent with the desk /cases/:id pattern).
  app.get('/api/finance/projects/:id', requireTenant, requirePerm('projects.project.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const projectId = Number(req.params.id);
      const item = await getProject(pgAdapter, projectId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/projects/:id/tasks
  //   List tasks for a project. Optional ?status= filter
  //   (todo / in_progress / done / blocked). Ordered by id ASC
  //   (chronological; tasks are added in order). Returns 404
  //   if the project is missing or cross-tenant.
  app.get('/api/finance/projects/:id/tasks', requireTenant, requirePerm('projects.task.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const projectId = Number(req.params.id);
      const status = req.query.status ?? null;
      // The pure listTasks function does the project existence
      // check; the inline ValueError → 404 conversion is the
      // same pattern as /cases/:id/replies in the desk module.
      const items = await listTasks(pgAdapter, projectId, tenantId, status);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/projects/:id/tasks
  //   Create a new task under a project. Body: { name,
  //   description?, status?, priority?, assignee_id?, due_date? }.
  //   name is required. The project_id is injected from the URL
  //   (the body may also include it; the URL value wins).
  app.post(
    '/api/finance/projects/:id/tasks',
    requireTenant,
    requirePerm('projects.task.create'),
    wrapFinanceRoute('projects.task.create', (req, res) => `project_task:${res.locals.createdId}`, async (req, res) => {
      const tenantId = req.tenantId;
      const projectId = Number(req.params.id);
      // Inject the project_id from the URL into the input
      // (the pure function validates it via its project
      // existence check, so a wrong project_id returns 404
      // not 500).
      const input = { ...(req.body || {}), project_id: projectId };
      const out = await createTask(pgAdapter, input, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/projects/:id/tasks/:taskId
  //   Get a single task. Returns 404 if the task is missing or
  //   cross-tenant. The project_id in the URL is for URL
  //   consistency only; the pure getTask function does the
  //   existence check on the task, not the project.
  app.get('/api/finance/projects/:id/tasks/:taskId', requireTenant, requirePerm('projects.task.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const taskId = Number(req.params.taskId);
      const item = await getTask(pgAdapter, taskId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/projects/:id/tasks/:taskId/time-entries
  //   List time entries for a task (chronological by work_date).
  //   Returns 404 if the task is missing or cross-tenant (the
  //   pure listTimeEntries function does the existence check).
  app.get(
    '/api/finance/projects/:id/tasks/:taskId/time-entries',
    requireTenant,
    requirePerm('projects.time.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.tenantId;
        const taskId = Number(req.params.taskId);
        const items = await listTimeEntries(pgAdapter, taskId, tenantId);
        res.status(200).json({ items });
      } catch (err) {
        if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        next(err);
      }
    },
  );

  // POST /api/finance/projects/:id/tasks/:taskId/time-entries
  //   Add a time entry to a task. Body: { user_id, work_date,
  //   hours, billable?, description? }. user_id, work_date, and
  //   hours are required. The task_id is injected from the URL.
  app.post(
    '/api/finance/projects/:id/tasks/:taskId/time-entries',
    requireTenant,
    requirePerm('projects.time.create'),
    wrapFinanceRoute(
      'projects.time.create',
      (req, res) => `project_time_entry:${res.locals.createdId}`,
      async (req, res) => {
        const tenantId = req.tenantId;
        const taskId = Number(req.params.taskId);
        // Inject the task_id from the URL into the input
        // (the pure function validates it via its task
        // existence check).
        const input = { ...(req.body || {}), task_id: taskId };
         const out = await createTimeEntry(pgAdapter, input, tenantId);
         res.status(201).json(out);
       },
     ),
   );

  // ─────────── Catalog v2 (categories + variants) — Phase 2 wave 2 (W77) ───────────
  //
  // The catalog v2 module extends the existing flat
  // catalog (Wave 7: catalog_items + catalog_variants
  // + catalog_categories tables) with:
  //   - Categories (hierarchical via parent_id) with
  //     slug + description
  //   - Variants (per-item SKU + name + attributes_json
  //     + unit_price_amd + unit_cost_amd)
  //
  // Wave 2 wires 7 HTTP endpoints (consistent with the
  // W70->W71 / W72->W73 / W74->W75 cadence): 2 reads +
  // 1 path on categories, 1 write on categories, 1 read +
  // 1 write on variants, 1 single-entity GET on variant.
  // The 7 endpoints map to 4 perm keys (all NEW in
  // W77-1; added to server/rbac/permissions.js):
  //   finance.category.read  — list + get + path
  //   finance.category.create — create
  //   finance.variant.read   — list + get
  //   finance.variant.create — create
  // The new CatalogOperator perm set in
  // server/rbac/matrix.js bundles all 4 keys (no existing
  // perm set covered categories or variants).

  // GET /api/finance/catalog/categories
  //   List categories for the caller's tenant.
  //   Optional ?parent_id= filter (returns only direct
  //   children of category N). parent_id=null returns
  //   ALL categories (flat list, ordered by id ASC).
  //   The caller can filter to roots by checking
  //   parent_id IS NULL in the response.
  app.get('/api/finance/catalog/categories', requireTenant, requirePerm('finance.category.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const parentIdRaw = req.query.parent_id;
      // Empty string or absent = null (flat list).
      // Numeric string = parentId (filtered list).
      const parentId = parentIdRaw === undefined || parentIdRaw === ''
        ? null
        : Number(parentIdRaw);
      const items = await listCategories(pgAdapter, tenantId, parentId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/catalog/categories
  //   Create a new category. Body: { name, slug?,
  //   description?, parent_id? }. name is required.
  //   slug is optional (when present, must be unique
  //   per tenant). parent_id is optional (null for
  //   root).
  app.post(
    '/api/finance/catalog/categories',
    requireTenant,
    requirePerm('finance.category.create'),
    wrapFinanceRoute(
      'finance.category.create',
      (req, res) => res.locals.createdId ? `catalog_category:${res.locals.createdId}` : 'catalog_category:new',
      async (req, res) => {
        const tenantId = req.tenantId;
        const out = await createCategory(pgAdapter, req.body || {}, tenantId);
        res.status(201).json(out);
      },
    ),
  );

  // GET /api/finance/catalog/categories/:id
  //   Get a single category. Returns 404 if the category
  //   is missing or cross-tenant. The pure getCategory
  //   function throws ValueError on "not found in
  //   tenant"; the route handler converts to 404
  //   inline (the W73-1 pattern).
  app.get('/api/finance/catalog/categories/:id', requireTenant, requirePerm('finance.category.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const categoryId = Number(req.params.id);
      const item = await getCategory(pgAdapter, categoryId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/catalog/categories/:id/path
  //   Get the full breadcrumb path for a category
  //   (root-to-leaf). Returns an array of {id, name}
  //   objects. Empty array for a missing category
  //   (the pure getCategoryPath function returns []
  //   when the SQL recursive CTE finds no rows; this
  //   is the consistent behavior — a missing category
  //   is a 200 with [], NOT a 404, because the
  //   "path" of a non-existent category is the empty
  //   path). UIs can check items.length === 0 to
  //   detect a missing category.
  app.get(
    '/api/finance/catalog/categories/:id/path',
    requireTenant,
    requirePerm('finance.category.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.tenantId;
        const categoryId = Number(req.params.id);
        const items = await getCategoryPath(pgAdapter, categoryId, tenantId);
        res.status(200).json({ items });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/finance/catalog/items/:itemId/variants
  //   List variants for a catalog item. Returns an
  //   empty array when the item has no variants (or
  //   when the item is missing — the SQL returns no
  //   rows for a missing item; the empty array is
  //   the consistent behavior, similar to
  //   /desk/cases/:id/replies).
  app.get(
    '/api/finance/catalog/items/:itemId/variants',
    requireTenant,
    requirePerm('finance.variant.read'),
    async (req, res, next) => {
      try {
        const tenantId = req.tenantId;
        const itemId = Number(req.params.itemId);
        const items = await listVariants(pgAdapter, tenantId, itemId);
        res.status(200).json({ items });
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/finance/catalog/items/:itemId/variants
  //   Create a new variant under a catalog item.
  //   Body: { sku, name, attributes_json?,
  //   unit_price_amd?, unit_cost_amd? }. sku + name
  //   are required. The catalog_item_id is injected
  //   from the URL (consistent with the W75-1
  //   projects pattern).
  app.post(
    '/api/finance/catalog/items/:itemId/variants',
    requireTenant,
    requirePerm('finance.variant.create'),
    wrapFinanceRoute(
      'finance.variant.create',
      (req, res) => `catalog_variant:${res.locals.createdId}`,
      async (req, res) => {
        const tenantId = req.tenantId;
        const itemId = Number(req.params.itemId);
        const input = { ...(req.body || {}), catalog_item_id: itemId };
        const out = await createVariant(pgAdapter, input, tenantId);
        res.status(201).json(out);
      },
    ),
  );

  // GET /api/finance/catalog/variants/:id
  //   Get a single variant. Returns 404 if the variant
  //   is missing or cross-tenant. The pure getVariant
  //   function throws ValueError on "not found in
  //   tenant"; the route handler converts to 404
  //   inline (the W73-1 pattern).
  app.get('/api/finance/catalog/variants/:id', requireTenant, requirePerm('finance.variant.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const variantId = Number(req.params.id);
      const item = await getVariant(pgAdapter, variantId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // ─────────── Catalog v2 wave 3b (bundles) — Phase 2 (W79) ───────────
  //
  // The bundles module extends the catalog with
  // compound items: a bundle has a header row
  // (sku + name + bundle_price_amd) + N child rows
  // referencing catalog_items. Wave 3b wires 5 HTTP
  // endpoints (consistent with the W70->W71 / W72->W73
  // / W74->W75 / W76->W77 cadence): 2 reads on bundles
  // (list + get), 1 write on bundles (create), 1 read
  // on bundle items (list), 1 write on bundle items
  // (add). The 5 endpoints map to 4 perm keys (all
  // NEW in W79-1; added to server/rbac/permissions.js):
  //   finance.bundle.read        — list + get bundle
  //   finance.bundle.create      — create bundle
  //   finance.bundle_item.read   — list bundle items
  //   finance.bundle_item.create — add bundle item
  // The new CatalogOperator perm set bundles all 4
  // keys (now 8 total catalog v2 keys; W76+W77+W78).

  // GET /api/finance/catalog/bundles
  //   List bundles for the caller's tenant. Default
  //   (archived=false) returns only non-archived
  //   bundles. ?archived=true returns all bundles
  //   (including archived) — useful for cleanup views.
  app.get('/api/finance/catalog/bundles', requireTenant, requirePerm('finance.bundle.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const archived = req.query.archived === 'true';
      const items = await listBundles(pgAdapter, tenantId, { archived });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/catalog/bundles
  //   Create a new bundle. Body: { sku, name,
  //   description?, bundle_price_amd? }. sku + name
  //   are required. bundle_price_amd is optional
  //   (null when the bundle's price is computed
  //   dynamically — future work).
  app.post(
    '/api/finance/catalog/bundles',
    requireTenant,
    requirePerm('finance.bundle.create'),
    wrapFinanceRoute('finance.bundle.create', (req, res) => res.locals.createdId ? `catalog_bundle:${res.locals.createdId}` : 'catalog_bundle:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createBundle(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/catalog/bundles/:id
  //   Get a single bundle. Returns 404 if the bundle
  //   is missing or cross-tenant (the pure getBundle
  //   function throws ValueError on "not found in
  //   tenant"; the route handler converts to 404
  //   inline — the W73-1 pattern).
  app.get('/api/finance/catalog/bundles/:id', requireTenant, requirePerm('finance.bundle.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const bundleId = Number(req.params.id);
      const item = await getBundle(pgAdapter, bundleId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/catalog/bundles/:id/items
  //   List the recipe rows (catalog items +
  //   quantities) for a bundle. Returns 404 if the
  //   bundle is missing or cross-tenant (the pure
  //   listBundleItems function does the existence
  //   check).
  app.get('/api/finance/catalog/bundles/:id/items', requireTenant, requirePerm('finance.bundle_item.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const bundleId = Number(req.params.id);
      const items = await listBundleItems(pgAdapter, bundleId, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/catalog/bundles/:id/items
  //   Add a new recipe row to a bundle. Body: {
  //   catalog_item_id, quantity }. The bundle_id
  //   is injected from the URL (the body may also
  //   include it; the URL value wins — consistent
  //   with the W75-1 projects pattern).
  app.post(
    '/api/finance/catalog/bundles/:id/items',
    requireTenant,
    requirePerm('finance.bundle_item.create'),
    wrapFinanceRoute('finance.bundle_item.create', (req, res) => res.locals.createdId ? `catalog_bundle_item:${res.locals.createdId}` : 'catalog_bundle_item:new', async (req, res) => {
      const tenantId = req.tenantId;
      const bundleId = Number(req.params.id);
      const out = await addBundleItem(pgAdapter, bundleId, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 POS basics (W88-1) — register / shift / sale / line /
  // payment endpoints. The pure functions in server/finance/pos.js
  // own all the validation + state-machine guards (open → closed
  // for shifts; open → completed | voided for sales). The routes
  // are thin wrappers that:
  //   - inject req.tenantId
  //   - convert "not found in tenant" ValueErrors to 404
  //   - convert other ValueErrors (validation failures, state-
  //     machine guards, duplicate codes) to 400
  //   - record the action in finance.audit (write routes only)
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/pos/registers
  //   List registers for the caller's tenant. Ordered by id ASC.
  app.get('/api/finance/pos/registers', requireTenant, requirePerm('pos.cash.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const items = await listRegisters(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/pos/registers
  //   Create a new register. Body: { code, name, location? }.
  //   code + name are required; location is optional. code is
  //   unique per tenant.
  app.post(
    '/api/finance/pos/registers',
    requireTenant,
    requirePerm('pos.session.open'),
    wrapFinanceRoute('pos.session.open', (req, res) => res.locals.createdId ? `pos_register:${res.locals.createdId}` : 'pos_register:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await addRegister(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/pos/registers/:id
  //   Get a single register. Returns 404 if missing or
  //   cross-tenant (the pure function throws ValueError on
  //   "not found in tenant").
  app.get('/api/finance/pos/registers/:id', requireTenant, requirePerm('pos.cash.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const registerId = Number(req.params.id);
      const item = await getRegister(pgAdapter, registerId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/pos/shifts
  //   List shifts for the caller's tenant. Optional filters:
  //   ?register_id=N, ?status=open|closed. Ordered by id DESC.
  app.get('/api/finance/pos/shifts', requireTenant, requirePerm('pos.cash.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const registerId = req.query.register_id ? Number(req.query.register_id) : null;
      const status = req.query.status ?? null;
      const items = await listShifts(pgAdapter, tenantId, { registerId, status });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/pos/shifts
  //   Open a new shift on a register. Body: { register_id,
  //   opened_by, opening_cash_amd? }. register_id + opened_by
  //   are required. Returns 400 if the register is missing,
  //   retired, or already has an open shift.
  app.post(
    '/api/finance/pos/shifts',
    requireTenant,
    requirePerm('pos.session.open'),
    wrapFinanceRoute('pos.session.open', (req, res) => res.locals.createdId ? `pos_shift:${res.locals.createdId}` : 'pos_shift:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await openShift(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/pos/shifts/:id
  //   Get a single shift. Returns 404 if missing or
  //   cross-tenant.
  app.get('/api/finance/pos/shifts/:id', requireTenant, requirePerm('pos.cash.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const shiftId = Number(req.params.id);
      const item = await getShift(pgAdapter, shiftId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/pos/shifts/:id/close
  //   Close a shift. Body: { closed_by, closing_cash_amd? }.
  //   Returns 400 if the shift is already closed (state-
  //   machine guard open → closed).
  app.post(
    '/api/finance/pos/shifts/:id/close',
    requireTenant,
    requirePerm('pos.session.close'),
    wrapFinanceRoute('pos.session.close', (req) => `pos_shift:${req.params.id}:close`, async (req, res) => {
      const tenantId = req.tenantId;
      const shiftId = Number(req.params.id);
      const out = await closeShift(pgAdapter, shiftId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/pos/sales
  //   Create a new sale under an open shift. Body: {
  //   shift_id, register_id, cashier_id, customer_id? }.
  //   shift_id + register_id + cashier_id are required.
  //   The shift must exist + be 'open' + match register_id.
  app.post(
    '/api/finance/pos/sales',
    requireTenant,
    requirePerm('pos.sale.create'),
    wrapFinanceRoute('pos.sale.create', (req, res) => res.locals.createdId ? `pos_sale:${res.locals.createdId}` : 'pos_sale:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await addSale(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // POST /api/finance/pos/sales/:id/lines
  //   Add a line item to an open sale. Body: { sale_id?,
  //   catalog_item_id, quantity, unit_price_amd }. sale_id
  //   is injected from the URL (the URL value wins). The
  //   sale must be 'open'; the catalog item must exist.
  //   Recomputes the sale's total_amd on success.
  app.post(
    '/api/finance/pos/sales/:id/lines',
    requireTenant,
    requirePerm('pos.sale.create'),
    wrapFinanceRoute('pos.sale.create', (req, res) => `pos_sale:${req.params.id}:line:${res.locals.createdId}`, async (req, res) => {
      const tenantId = req.tenantId;
      const saleId = Number(req.params.id);
      const body = { ...(req.body || {}), sale_id: saleId };
      const out = await addSaleLine(pgAdapter, body, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // POST /api/finance/pos/sales/:id/payments
  //   Add a payment to an open sale. Body: { sale_id?,
  //   payment_method, amount_amd, tendered_amd,
  //   change_amd?, reference? }. sale_id is injected from
  //   the URL. payment_method must be cash | card | mobile
  //   | bank_transfer | other. tendered_amd >= amount_amd;
  //   change_amd must be 0 for non-cash payments.
  app.post(
    '/api/finance/pos/sales/:id/payments',
    requireTenant,
    requirePerm('pos.sale.create'),
    wrapFinanceRoute('pos.sale.create', (req, res) => `pos_sale:${req.params.id}:payment:${res.locals.createdId}`, async (req, res) => {
      const tenantId = req.tenantId;
      const saleId = Number(req.params.id);
      const body = { ...(req.body || {}), sale_id: saleId };
      const out = await addPayment(pgAdapter, body, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // POST /api/finance/pos/sales/:id/complete
  //   Finalize a sale: status open → completed, completed_at
  //   stamped. Must be 'open' (not yet completed or voided).
  app.post(
    '/api/finance/pos/sales/:id/complete',
    requireTenant,
    requirePerm('pos.sale.create'),
    wrapFinanceRoute('pos.sale.create', (req) => `pos_sale:${req.params.id}:complete`, async (req, res) => {
      const tenantId = req.tenantId;
      const saleId = Number(req.params.id);
      const out = await completeSale(pgAdapter, saleId, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/pos/sales/:id/void
  //   Cancel an OPEN sale: status open → voided. Body: {
  //   voided_by }. Returns 400 if the sale is already
  //   completed (must use refundSale) or already voided.
  //   Does NOT insert a pos_refunds row (a void is not a
  //   refund — no money changed hands).
  app.post(
    '/api/finance/pos/sales/:id/void',
    requireTenant,
    requirePerm('pos.sale.void'),
    wrapFinanceRoute('pos.sale.void', (req) => `pos_sale:${req.params.id}:void`, async (req, res) => {
      const tenantId = req.tenantId;
      const saleId = Number(req.params.id);
      const out = await voidSale(pgAdapter, saleId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/pos/sales/:id/refund
  //   Issue a refund for a COMPLETED sale: inserts pos_refunds
  //   row + flips status completed → voided. Body: {
  //   refunded_by, amount_amd, payment_method, reason? }.
  //   Returns 400 if the sale is open (must voidSale) or
  //   already voided.
  app.post(
    '/api/finance/pos/sales/:id/refund',
    requireTenant,
    requirePerm('pos.refund.create'),
    wrapFinanceRoute('pos.refund.create', (req, res) => `pos_sale:${req.params.id}:refund:${res.locals.createdId}`, async (req, res) => {
      const tenantId = req.tenantId;
      const saleId = Number(req.params.id);
      const out = await refundSale(pgAdapter, saleId, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/pos/sales/:id/refunds
  //   List refunds for a sale (chronological). Returns []
  //   for a sale with no refunds. Used by the POS UI to
  //   display the refund history of a sale.
  app.get('/api/finance/pos/sales/:id/refunds', requireTenant, requirePerm('pos.refund.create'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const saleId = Number(req.params.id);
      const items = await listRefunds(pgAdapter, tenantId, { saleId });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });
}
