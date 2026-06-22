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
//   POST   /api/finance/invoices/:id/attachments            (finance.invoice.attach) — Wave 56
//   GET    /api/finance/invoices/:id/attachments            (finance.invoice.attach.read)
//   GET    /api/finance/invoices/:id/attachments/:attId     (download, finance.invoice.attach.read)
//   DELETE /api/finance/invoices/:id/attachments/:attId     (finance.invoice.attach)
//   GET    /api/finance/customers
//   POST   /api/finance/customers
//   PATCH  /api/finance/customers/:id
//   GET    /api/finance/audit
//   GET    /api/finance/audit/export
//   GET    /api/finance/audit/retention                  (security.audit.read)        — W60 read retention config
//   PUT    /api/finance/audit/retention                  (security.audit.retention.update) — W60 set retention config
//   POST   /api/finance/audit/purge                      (security.audit.retention.update) — W60 manual purge
//   GET    /api/finance/audit/retention/dashboard        (security.audit.read)          — W63 dashboard
//   GET    /api/finance/audit/retention/dashboard/export (security.audit.read)          — W64 CSV export
//   POST   /api/finance/audit/retention/digest          (security.audit.export)         — W65 weekly digest email
//   GET    /api/finance/audit/retention/history         (security.audit.read)          — W66 per-tenant snapshot history
//   POST   /api/finance/audit/retention/history/snapshot (security.audit.retention.update) — W66 manual snapshot
//   GET    /api/finance/audit/retention/history/export  (security.audit.read)          — W67 CSV export
//   GET    /api/finance/audit/retention/history/diff    (security.audit.read)          — W68 per-tenant diff between two snapshots
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
//   POST   /api/finance/stock/adjust                  (finance.stock.move) — manual adjust with reason
//   GET    /api/finance/stock/adjustments             (finance.stock.read) — list adjustments (Wave 54)
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
import {
  addAttachment,
  listAttachments,
  getAttachment,
  deleteAttachment,
  readAttachmentBytes,
  AttachmentError,
} from './attachments.js';
import { recordPayment, reconcileInvoice } from './payment.js';
import { createCustomer, updateCustomer, listCustomers as listCustomersPure, getCustomer } from './customer.js';
import { getCustomer360 } from './customer360.js';
import { validateHvhhOnDemand } from './validate-hvhh.js';
import { getVendor360 } from './vendor360.js';
import { getDashboard360 } from './dashboard360.js';
import {
  // The aggregate functions (getArAging / listOverdueInvoices /
  // getMonthlyRevenue / getTopCustomers / getVatSummary) are
  // imported for the dashboard route in the existing code; the
  // drill-down functions below are wired in W92-1.
  listInvoicesInAgingBucket,
  listMonthlyRevenueTrend,
  getCustomerRevenueBreakdown,
} from './reports.js';
import { computeAndCloseVatPeriod } from './vatLedger.js';
import { exportInvoiceEInvoice } from './einvoiceExport.js';
import { requireTenant } from './tenant.js';
import { recordAudit, listAudit, streamAuditCsv } from './audit.js';
import {
  getAuditRetention,
  setAuditRetention,
  purgeOldAuditEvents,
  recordPurgeRun,
  getRetentionDashboard,
  streamRetentionDashboardCsv,
  getRetentionDigestSummary,
  buildRetentionDigestBody,
} from './auditRetention.js';
import {
  listRetentionHistory,
  snapshotRetentionDashboard,
  streamRetentionHistoryCsv,
  diffRetentionSnapshots,
} from './retentionHistory.js';
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
  listAdjustments,
  getReplenishmentReport,
} from './inventory.js';
import {
  createVendor,
  getVendor,
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
  createPricingRule,
  listPricingRules,
  getPricingRule,
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
  addEmployee,
  listEmployees,
  getEmployee,
  addContract,
  listContracts,
  getContract,
  createPayrollRun,
  addPayrollLine,
  listPayrollRuns,
  suspendEmployee,
  reactivateEmployee,
  setEmployeeOnLeave,
  terminateEmployee,
} from './hr.js';
import {
  findDuplicateCustomers,
  findHvhhDrift,
  getDataQualitySummary,
  suggestMergeCandidates,
  getDataQualityAlerts,
  applyCustomerMerge,
  listCustomerMergeLog,
  undoCustomerMerge,
} from './dataQuality.js';
import {
  createReportSchedule,
  listReportSchedules,
  getReportSchedule,
  toggleReportSchedule,
  recordReportExecution,
  listReportExecutions,
  resetScheduleRetries,
} from './reportScheduler.js';
import { runReportNow } from './scheduleRunner.js';
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

  // ─── Wave 56: invoice document attachments ───
  //
  // Operators attach supporting documents to invoices: the
  // signed PDF, the vendor's quote, a photo of the goods
  // received, etc. The DB stores the metadata; the file
  // bytes live on disk under $SBOS_ATTACHMENTS_DIR.

  // POST /api/finance/invoices/:id/attachments — upload a
  // file as raw bytes. The metadata is supplied via headers
  // (no multipart parsing — keep the route small):
  //   x-filename    original filename (required, no path sep)
  //   x-mime-type   mime type (optional, default octet-stream)
  //   x-description free text (optional, max 500 chars)
  app.post(
    '/api/finance/invoices/:id/attachments',
    requireTenant,
    requirePerm('finance.invoice.attach'),
    async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      // Read the raw body. express.json() doesn't handle
      // application/octet-stream so we read from req directly.
      const chunks = [];
      for await (const chunk of req) {
        chunks.push(chunk);
      }
      const buffer = Buffer.concat(chunks);
      const filename = String(req.headers['x-filename'] || '').trim();
      const mimeType = req.headers['x-mime-type']
        ? String(req.headers['x-mime-type'])
        : null;
      const description = req.headers['x-description']
        ? String(req.headers['x-description'])
        : null;
      try {
        const row = await addAttachment(pgAdapter, {
          tenantId,
          invoiceId: id,
          buffer,
          filename,
          mimeType,
          description,
          uploadedBy: req.user ? req.user.id : null,
        });
        res.status(201).json(row);
      } catch (err) {
        if (err instanceof AttachmentError) {
          return res
            .status(err.statusCode || 400)
            .json({ error: 'invalid_request', message: err.message });
        }
        res.status(500).json({ error: 'internal_error', message: err && err.message });
      }
    },
  );

  // GET /api/finance/invoices/:id/attachments — list the
  // metadata for all attachments on this invoice.
  app.get(
    '/api/finance/invoices/:id/attachments',
    requireTenant,
    requirePerm('finance.invoice.attach.read'),
    async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      if (id === null) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const items = await listAttachments(pgAdapter, tenantId, id, {
        limit: req.query.limit,
      });
      res.status(200).json({ items });
    },
  );

  // GET /api/finance/invoices/:id/attachments/:attachmentId
  // — download the raw file bytes. The Content-Disposition
  // header carries the original filename so the browser
  // saves it as that name.
  app.get(
    '/api/finance/invoices/:id/attachments/:attachmentId',
    requireTenant,
    requirePerm('finance.invoice.attach.read'),
    async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      const attId = Number(req.params.attachmentId);
      if (id === null || !Number.isInteger(attId) || attId <= 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      const row = await getAttachment(pgAdapter, tenantId, attId);
      if (!row || Number(row.invoice_id) !== Number(id)) {
        return res.status(404).json({ error: 'not_found' });
      }
      try {
        const buf = await readAttachmentBytes(row);
        res
          .status(200)
          .set('Content-Type', row.mime_type || 'application/octet-stream')
          .set('Content-Length', String(buf.length))
          .set('Content-Disposition', `attachment; filename="${row.filename}"`)
          .send(buf);
      } catch (err) {
        if (err instanceof AttachmentError) {
          return res
            .status(err.statusCode || 500)
            .json({ error: 'attachment_unavailable', message: err.message });
        }
        res.status(500).json({ error: 'internal_error', message: err && err.message });
      }
    },
  );

  // DELETE /api/finance/invoices/:id/attachments/:attachmentId
  // — remove the attachment (metadata + file).
  app.delete(
    '/api/finance/invoices/:id/attachments/:attachmentId',
    requireTenant,
    requirePerm('finance.invoice.attach'),
    async (req, res) => {
      const id = parseInvoiceId(req.params.id);
      const attId = Number(req.params.attachmentId);
      if (id === null || !Number.isInteger(attId) || attId <= 0) {
        return res.status(404).json({ error: 'not_found' });
      }
      const tenantId = req.tenantId;
      // Verify the attachment belongs to this invoice (tenant
      // check is in getAttachment; the invoice_id check is
      // here so a wrong invoice id returns 404 not 500).
      const existing = await getAttachment(pgAdapter, tenantId, attId);
      if (!existing || Number(existing.invoice_id) !== Number(id)) {
        return res.status(404).json({ error: 'not_found' });
      }
      const ok = await deleteAttachment(pgAdapter, tenantId, attId);
      if (!ok) {
        return res.status(404).json({ error: 'not_found' });
      }
      res.status(204).send();
    },
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

  // Customer HVVH on-demand validation — calls the A1-Validator HTTP
  // service to verify the customer's HVVH is still valid. Useful for
  // ad-hoc compliance checks ("is customer 42 still good?"). Same
  // fail-soft 3-tier as the create-time wrapper; never throws on
  // invalid TIN (returns ok=false in the body). Returns 200 always
  // (unless the customer doesn't exist, which is 404).
  app.post(
    '/api/finance/customers/:id/validate-hvhh',
    requireTenant,
    requirePerm('finance.customer.read'),
    async (req, res, next) => {
      try {
        const id = parseCustomerId(req.params.id);
        if (id === null) {
          return res.status(404).json({ error: 'not_found' });
        }
        const tenantId = req.tenantId;
        const cust = await getCustomer(pgAdapter, id, tenantId);
        if (!cust) {
          return res.status(404).json({ error: 'not_found' });
        }
        const result = await validateHvhhOnDemand({ hvhh: cust.hvhh });
        res.status(200).json({
          customer_id: id,
          hvhh: cust.hvhh,
          ok: result.ok,
          normalized: result.normalized,
          error: result.error,
          _via: result._via,
          _skipped: result._skipped,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // Vendor HVVH on-demand validation — mirror of customer version.
  app.post(
    '/api/finance/vendors/:id/validate-hvhh',
    requireTenant,
    requirePerm('finance.vendor.read'),
    async (req, res, next) => {
      try {
        const id = Number(req.params.id);
        if (!Number.isInteger(id) || id <= 0) {
          return res.status(404).json({ error: 'not_found' });
        }
        const tenantId = req.tenantId;
        const vendor = await getVendor(pgAdapter, id, tenantId);
        if (!vendor) {
          return res.status(404).json({ error: 'not_found' });
        }
        const result = await validateHvhhOnDemand({ hvhh: vendor.hvhh });
        res.status(200).json({
          vendor_id: id,
          hvhh: vendor.hvhh,
          ok: result.ok,
          normalized: result.normalized,
          error: result.error,
          _via: result._via,
          _skipped: result._skipped,
        });
      } catch (err) {
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
        q: req.query.q, // full-text search across action/resource/payload
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

  // GET /api/finance/audit/retention — read the per-tenant
  // audit retention config. Returns the current
  // retention_days (or the default 365 if the operator has
  // never set it explicitly) + the row's updated_at /
  // updated_by for audit-trail context.
  //
  // Perm gate: `security.audit.read` (same as /audit). Read-
  // only.
  app.get(
    '/api/finance/audit/retention',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const cfg = getAuditRetention(rawDb, req.tenantId);
        res.status(200).json(cfg);
      } catch (err) {
        next(err);
      }
    },
  );

  // PUT /api/finance/audit/retention — set the per-tenant
  // retention window. Body: { retention_days: <int> }.
  // 0 = keep forever. Persists the row; subsequent GET
  // returns the stored config rather than the default.
  //
  // Perm gate: `security.audit.retention.update` (new
  // W60 perm; bound to Admin via AuditRetentionManager).
  app.put(
    '/api/finance/audit/retention',
    requireTenant,
    requirePerm('security.audit.retention.update'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const body = req.body || {};
        const days = Number(body.retention_days);
        if (!Number.isFinite(days) || !Number.isInteger(days) || days < 0) {
          return res.status(400).json({
            error: 'invalid_request',
            message: 'retention_days must be a non-negative integer',
          });
        }
        const updatedBy =
          req.user && req.user.id != null ? Number(req.user.id) : null;
        const cfg = setAuditRetention(rawDb, req.tenantId, days, updatedBy);
        res.status(200).json(cfg);
      } catch (err) {
        // setAuditRetention throws RangeError on bad input. Map
        // to 400 so the operator gets a useful error.
        if (err instanceof RangeError) {
          return res.status(400).json({
            error: 'invalid_request',
            message: err.message,
          });
        }
        next(err);
      }
    },
  );

  // POST /api/finance/audit/purge — manually trigger the
  // purge with the current retention config. Returns the
  // number of rows deleted. Useful after a one-off
  // regulatory retention change ("the data is past N years
  // now, please purge"), or in a smoke test that wants to
  // verify the purge path.
  //
  // Body (optional): { retention_days: <int> } — if present,
  // uses the override for this run only (does NOT update the
  // stored config). If absent, uses the stored config.
  //
  // Perm gate: `security.audit.retention.update` (same as
  // the PUT).
  app.post(
    '/api/finance/audit/purge',
    requireTenant,
    requirePerm('security.audit.retention.update'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const body = req.body || {};
        let days;
        if (body.retention_days != null) {
          const d = Number(body.retention_days);
          if (!Number.isFinite(d) || !Number.isInteger(d) || d < 0) {
            return res.status(400).json({
              error: 'invalid_request',
              message: 'retention_days must be a non-negative integer',
            });
          }
          days = d;
        } else {
          const cfg = getAuditRetention(rawDb, req.tenantId);
          days = cfg.retention_days;
        }
        const purged = purgeOldAuditEvents(rawDb, req.tenantId, days);
        // Record the purge run on the audit_retention row so
        // the W63 dashboard can show "last purge deleted N
        // rows on YYYY-MM-DD". Silent no-op if the tenant
        // is on the default 365d policy (no config row).
        try {
          recordPurgeRun(rawDb, req.tenantId, purged, days);
        } catch (_e) {
          // best-effort — purge already happened; do not
          // surface a write failure as a route error
        }
        res.status(200).json({
          purged,
          retention_days: days,
          tenant_id: req.tenantId,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/finance/audit/retention/dashboard — CFO-facing
  // view of every tenant's audit retention state. Pure
  // read; no destructive ops.
  //
  // Returns a list of tenants (every tenant that has an
  // explicit retention config OR any audit rows). For each
  // tenant we surface:
  //   - retention_days (explicit or DEFAULT_RETENTION_DAYS)
  //   - has_explicit_config (true if the operator set a
  //     non-default config; false if the tenant is on the
  //     default 365d policy)
  //   - last_purge_at + last_purge_count + last_purge_days
  //     (timestamp + count + window of the LAST purge run,
  //     null if no purge has run yet)
  //   - audit_row_count (current rows in the audit table
  //     for this tenant — operators can spot the bloat
  //     before it becomes a regulatory problem)
  //
  // Perm gate: `security.audit.read` (same as the read
  // audit endpoint). Read-only.
  app.get(
    '/api/finance/audit/retention/dashboard',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        // The dashboard is intentionally NOT tenant-scoped —
        // it shows every tenant's state. Operators with
        // security.audit.read on the calling tenant can see
        // the full picture (the route's perm is already
        // tenant-scoped via the requireTenant middleware).
        // For multi-tenant deploys the CFO perm is the gate.
        const dashboard = getRetentionDashboard(rawDb);
        res.status(200).json(dashboard);
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/finance/audit/retention/dashboard/export — CSV
  // export of the W63 dashboard. Same use case as the
  // /api/finance/audit/export endpoint (compliance teams
  // prefer spreadsheet-friendly CSV over JSON for the
  // periodic retention snapshot).
  //
  // Streams the dashboard as text/csv with the documented
  // 9-column header (tenant_id, retention_days,
  // has_explicit_config, updated_at, updated_by,
  // last_purge_at, last_purge_count, last_purge_days,
  // audit_row_count).
  //
  // Perm gate: `security.audit.read` (same as the
  // dashboard GET).
  app.get(
    '/api/finance/audit/retention/dashboard/export',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const today = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="retention-dashboard-${today}.csv"`,
        );
        res.setHeader('Cache-Control', 'no-store');
        // Stream chunks via the async generator. We do not
        // await drain between writes — the dashboard is
        // small (one row per tenant), so the kernel buffer
        // is plenty.
        for await (const chunk of streamRetentionDashboardCsv(rawDb)) {
          res.write(chunk);
        }
        res.end();
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/finance/audit/retention/digest — generate the
  // weekly retention digest and email it to the operator.
  // Body: { to: <email>, subject?: <text> }.
  // Uses the email service in capture mode (writes to
  // var/sbos-emails/YYYY-MM-DD.jsonl) by default; real
  // SMTP delivery requires SBOS_EMAIL_MODE=smtp + the
  // SMTP_* env vars (see server/index.js createApp).
  //
  // The CFO is a busy person — the digest is intentionally
  // a plain-text summary, not an HTML report. The full
  // per-tenant detail lives in the dashboard (W63) and the
  // CSV export (W64). The digest is the "what's the state
  // of the system?" summary.
  //
  // Perm gate: `security.audit.export` — the same perm
  // that gates the CSV export. Digest is a read-side
  // export, no destructive ops.
  app.post(
    '/api/finance/audit/retention/digest',
    requireTenant,
    requirePerm('security.audit.export'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const body = req.body || {};
        const to = String(body.to || '').trim();
        if (!to) {
          return res
            .status(400)
            .json({ error: 'invalid_request', message: 'to (recipient email) is required' });
        }
        // Build the summary + body. Pure functions, no
        // I/O — easy to unit test and re-render on demand.
        const summary = getRetentionDigestSummary(rawDb);
        const text = buildRetentionDigestBody(summary);
        // Send via the email service if present. In
        // capture mode (default) the email is written to
        // var/sbos-emails/YYYY-MM-DD.jsonl; in smtp mode
        // it goes to the SMTP relay. If no email service
        // is wired in (e.g. test harness), we still return
        // the rendered body so the caller can use it.
        const emailService = req.app && req.app.locals && req.app.locals.emailService;
        if (emailService && typeof emailService.send === 'function') {
          await emailService.send({
            to,
            subject: body.subject || 'SBOS Audit Retention Digest',
            body: text,
          });
        }
        res.status(200).json({
          ok: true,
          sent: Boolean(emailService),
          recipient: to,
          summary,
          body: text,
        });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/finance/audit/retention/history — per-tenant
  // history of retention snapshots. The CFO can answer
  // "what did the retention state look like last Tuesday?"
  // by reading the history.
  //
  // Query params:
  //   since:  optional ISO timestamp (lower bound)
  //   until:  optional ISO timestamp (upper bound)
  //   limit:  default 100, max 1000
  //
  // Returns: { items: [...] } sorted by snapshot_at DESC.
  // The route is tenant-scoped: the calling tenant sees
  // only its own history (req.tenantId from the
  // requireTenant middleware). Cross-tenant access would
  // require a CFO-level perm; not exposed here.
  //
  // Perm gate: `security.audit.read` (same as the
  // dashboard GET).
  app.get(
    '/api/finance/audit/retention/history',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const history = listRetentionHistory(rawDb, {
          tenantId: req.tenantId,
          since: req.query.since,
          until: req.query.until,
          limit: req.query.limit,
        });
        res.status(200).json(history);
      } catch (err) {
        next(err);
      }
    },
  );

  // POST /api/finance/audit/retention/history/snapshot —
  // manually trigger a snapshot. Useful in tests + the
  // smoke runner; production deploys use the opt-in
  // auto-snapshot worker (SBOS_RETENTION_HISTORY_ENABLED).
  //
  // Perm gate: `security.audit.retention.update` (same
  // as the manual purge route — both are write-side ops
  // on the retention state).
  app.post(
    '/api/finance/audit/retention/history/snapshot',
    requireTenant,
    requirePerm('security.audit.retention.update'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const count = snapshotRetentionDashboard(rawDb);
        res.status(200).json({ ok: true, snapshots: count });
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/finance/audit/retention/history/export — CSV
  // export of the W66 history. Mirrors the W64 dashboard
  // export pattern: streams text/csv with attachment
  // filename + documented 8-column header.
  //
  // Query params: since, until, limit (default 100, max
  // 1000). Same shape as the history GET.
  //
  // Perm gate: `security.audit.read` (same as the
  // history GET).
  app.get(
    '/api/finance/audit/retention/history/export',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        const today = new Date().toISOString().slice(0, 10);
        res.setHeader('Content-Type', 'text/csv; charset=utf-8');
        res.setHeader(
          'Content-Disposition',
          `attachment; filename="retention-history-${today}.csv"`,
        );
        res.setHeader('Cache-Control', 'no-store');
        // Stream chunks. The history is bounded by the
        // limit (default 100, max 1000), so the kernel
        // buffer is plenty — no need to await drain.
        for await (const chunk of streamRetentionHistoryCsv(rawDb, {
          tenantId: req.tenantId,
          since: req.query.since,
          until: req.query.until,
          limit: req.query.limit,
        })) {
          res.write(chunk);
        }
        res.end();
      } catch (err) {
        next(err);
      }
    },
  );

  // GET /api/finance/audit/retention/history/diff —
  // compare two retention snapshots and return per-tenant
  // deltas. The CFO can ask "what changed between last
  // Tuesday and this Tuesday?" without writing SQL.
  //
  // Query params (required):
  //   from: ISO timestamp (baseline)
  //   to:   ISO timestamp (current)
  //
  // Returns: { from, to, added[], removed[], changed[] }
  //   added:   tenant_ids that appeared in (from, to]
  //   removed: tenant_ids that existed at-or-before from
  //            but have no new snapshot in the window
  //   changed: per-tenant diffs with { from, to } pairs
  //
  // The diff is tenant-scoped: only tenants in the
  // calling tenant's history are surfaced. The history
  // is per-tenant by design (we don't snapshot across
  // tenants).
  //
  // Perm gate: `security.audit.read` (same as the
  // history GET).
  app.get(
    '/api/finance/audit/retention/history/diff',
    requireTenant,
    requirePerm('security.audit.read'),
    async (req, res, next) => {
      try {
        const rawDb = req.app && req.app.locals && req.app.locals.db;
        if (!rawDb) {
          return res
            .status(500)
            .json({ error: 'internal_error', message: 'audit db unavailable' });
        }
        // Scope the diff to the calling tenant. The
        // underlying diff function operates on the full
        // history table; we filter to the calling tenant
        // by passing tenantId-prefixed queries. Simpler
        // approach: pass the tenantId to the diff function
        // via a "tenant filter" — but the diff function
        // is cross-tenant by design (operator may want
        // a multi-tenant view). For now we filter the
        // result by req.tenantId.
        const diff = diffRetentionSnapshots(rawDb, {
          from: req.query.from,
          to: req.query.to,
        });
        // Filter to the calling tenant. The diff is
        // cross-tenant by design (operator may want a
        // multi-tenant view in a future CFO-perm-gated
        // endpoint), but the W68 endpoint is tenant-
        // scoped for now.
        const scoped = {
          from: diff.from,
          to: diff.to,
          added: diff.added.filter((t) => t === req.tenantId),
          removed: diff.removed.filter((t) => t === req.tenantId),
          changed: diff.changed.filter((c) => c.tenant_id === req.tenantId),
        };
        res.status(200).json(scoped);
      } catch (err) {
        // diffRetentionSnapshots throws RangeError on
        // missing from/to. Map to 400.
        if (err instanceof RangeError) {
          return res
            .status(400)
            .json({ error: 'invalid_request', message: err.message });
        }
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

  // GET /api/finance/stock/adjustments — list inventory
  // adjustments (move_type='ADJUSTMENT') with filters. Wave 54
  // addition: paired with the now-mandatory reason + category
  // on POST /api/finance/stock/adjust, this lets the operator
  // audit variance explanations.
  //
  // Filters: ?category, ?itemId, ?locationId, ?since, ?limit
  // Perm: finance.stock.read (existing).
  app.get(
    '/api/finance/stock/adjustments',
    requireTenant,
    requirePerm('finance.stock.read'),
    async (req, res) => {
      const tenantId = req.tenantId;
      const items = await listAdjustments(pgAdapter, tenantId, {
        category: req.query.category,
        itemId: req.query.itemId,
        locationId: req.query.locationId,
        since: req.query.since,
        limit: req.query.limit,
      });
      res.json({ items });
    },
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

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 HR basics (W91-1) — employee / contract / payroll
  // endpoints. The pure functions in server/finance/hr.js own
  // all the validation + state-machine guards (draft-only
  // payroll lines; unique codes; FK checks across migrations).
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/hr/employees
  //   List employees for the caller's tenant. Optional
  //   filters: ?status=, ?department=. Ordered by id ASC.
  app.get('/api/finance/hr/employees', requireTenant, requirePerm('hr.employee.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const status = req.query.status ?? null;
      const department = req.query.department ?? null;
      const items = await listEmployees(pgAdapter, tenantId, { status, department });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/hr/employees
  //   Create a new employee. Body: { code, first_name,
  //   last_name, email?, phone?, role?, department?,
  //   hire_date, status?, hvhh?, bank_account? }. code is
  //   unique per tenant.
  app.post(
    '/api/finance/hr/employees',
    requireTenant,
    requirePerm('hr.employee.create'),
    wrapFinanceRoute('hr.employee.create', (req, res) => res.locals.createdId ? `hr_employee:${res.locals.createdId}` : 'hr_employee:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await addEmployee(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/hr/employees/:id
  //   Get a single employee. Returns 404 if missing or
  //   cross-tenant.
  app.get('/api/finance/hr/employees/:id', requireTenant, requirePerm('hr.employee.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const employeeId = Number(req.params.id);
      const item = await getEmployee(pgAdapter, employeeId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/hr/contracts
  //   List contracts for the caller's tenant. Optional
  //   filters: ?employee_id=, ?status=. Ordered by id ASC.
  app.get('/api/finance/hr/contracts', requireTenant, requirePerm('hr.contract.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const employeeId = req.query.employee_id ? Number(req.query.employee_id) : null;
      const status = req.query.status ?? null;
      const items = await listContracts(pgAdapter, tenantId, { employeeId, status });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/hr/contracts
  //   Create a new employment contract. Body: {
  //   employee_id, contract_number, start_date, end_date?,
  //   base_salary_amd, currency?, pay_frequency?,
  //   hours_per_week?, vacation_days_per_year?, status?,
  //   notes? }. employee_id must exist; contract_number
  //   is unique per tenant.
  app.post(
    '/api/finance/hr/contracts',
    requireTenant,
    requirePerm('hr.contract.create'),
    wrapFinanceRoute('hr.contract.create', (req, res) => res.locals.createdId ? `hr_contract:${res.locals.createdId}` : 'hr_contract:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await addContract(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/hr/contracts/:id
  //   Get a single contract. Returns 404 if missing or
  //   cross-tenant.
  app.get('/api/finance/hr/contracts/:id', requireTenant, requirePerm('hr.contract.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const contractId = Number(req.params.id);
      const item = await getContract(pgAdapter, contractId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/hr/payroll-runs
  //   List payroll runs for the caller's tenant. Optional
  //   filters: ?status=, ?period_year=. Ordered by
  //   period_year DESC, period_month DESC (most recent
  //   first).
  app.get('/api/finance/hr/payroll-runs', requireTenant, requirePerm('hr.payroll.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const status = req.query.status ?? null;
      const periodYear = req.query.period_year ? Number(req.query.period_year) : null;
      const items = await listPayrollRuns(pgAdapter, tenantId, { status, periodYear });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/hr/payroll-runs
  //   Create a new payroll run for a (year, month). Body:
  //   { period_year, period_month, notes? }. Status
  //   defaults to 'draft'. UNIQUE (tenant_id,
  //   period_year, period_month) — a tenant cannot have
  //   two runs for the same month.
  app.post(
    '/api/finance/hr/payroll-runs',
    requireTenant,
    requirePerm('hr.payroll.run'),
    wrapFinanceRoute('hr.payroll.run', (req, res) => res.locals.createdId ? `hr_payroll_run:${res.locals.createdId}` : 'hr_payroll_run:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createPayrollRun(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

//   POST   /api/finance/hr/payroll-runs/:id/lines
//   POST   /api/finance/hr/employees/:id/suspend  (Phase 3 W95-1)
//   POST   /api/finance/hr/employees/:id/reactivate
//   POST   /api/finance/hr/employees/:id/on-leave
//   POST   /api/finance/hr/employees/:id/terminate
//   GET    /api/finance/ai/duplicates               (Phase 3 W93-1)
//   GET    /api/finance/ai/hvhh-drift
//   GET    /api/finance/ai/data-quality
//   GET    /api/finance/ai/merge-candidates        (Phase 3 W94-1)
//   GET    /api/finance/ai/alerts?threshold=
//   GET    /api/finance/reports/schedules           (Phase 3 W96-1)
//   POST   /api/finance/reports/schedules
//   GET    /api/finance/reports/schedules/:id
//   POST   /api/finance/reports/schedules/:id/toggle
//   POST   /api/finance/reports/executions
//   GET    /api/finance/reports/executions
  //   Add a per-employee pay line to a draft payroll run.
  //   Body: { employee_id, contract_id, base_salary_amd,
  //   bonus_amd?, deductions_amd?, tax_amd?, worked_days?,
  //   vacation_days?, sick_days?, notes? }. Recomputes the
  //   run's aggregate totals on success. Returns 400 if
  //   the run is not in 'draft' status.
  app.post(
    '/api/finance/hr/payroll-runs/:id/lines',
    requireTenant,
    requirePerm('hr.payroll.run'),
    wrapFinanceRoute('hr.payroll.run', (req, res) => `hr_payroll_run:${req.params.id}:line:${res.locals.createdId}`, async (req, res) => {
      const tenantId = req.tenantId;
      const runId = Number(req.params.id);
      const body = { ...(req.body || {}), payroll_run_id: runId };
      const out = await addPayrollLine(pgAdapter, body, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 reporting drill-downs (W92-1) — the clickable
  // detail rows behind the dashboard's aggregate numbers.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/reports/ar-aging-bucket?asOfDate=&bucket=
  //   Drill-down for getArAging: list the actual invoices
  //   that fall into a specific aging bucket (0_30, 31_60,
  //   61_90, 90_plus). Sorted by days_overdue DESC.
  app.get('/api/finance/reports/ar-aging-bucket', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const asOfDate = String(req.query.asOfDate ?? '');
      const bucket = String(req.query.bucket ?? '');
      const items = await listInvoicesInAgingBucket(pgAdapter, asOfDate, bucket, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/reports/revenue-trend?months=
  //   Drill-down for getMonthlyRevenue: revenue trend for
  //   the last N months (default 12, max 36). Ordered
  //   chronologically.
  app.get('/api/finance/reports/revenue-trend', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const months = req.query.months ? Number(req.query.months) : 12;
      const items = await listMonthlyRevenueTrend(pgAdapter, months, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/reports/customer-breakdown/:id?since=&until=
  //   Drill-down for getTopCustomers: per-invoice breakdown
  //   for one customer in a date range. Returns the
  //   customer's profile, billing totals, aging buckets,
  //   and per-invoice detail.
  app.get('/api/finance/reports/customer-breakdown/:id', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const customerId = Number(req.params.id);
      const since = String(req.query.since ?? '');
      const until = String(req.query.until ?? '');
      const out = await getCustomerRevenueBreakdown(pgAdapter, customerId, since, until, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 HR basics wave 3 (W95-1) — employee status
  // transitions (suspend / reactivate / on-leave / terminate).
  // ────────────────────────────────────────────────────────────────────

  // POST /api/finance/hr/employees/:id/suspend
  //   Body: { user_id }. Flips status active/on_leave →
  //   suspended. Stamps suspended_at + suspended_by.
  app.post(
    '/api/finance/hr/employees/:id/suspend',
    requireTenant,
    requirePerm('hr.employee.update'),
    wrapFinanceRoute('hr.employee.update', (req) => `hr_employee:${req.params.id}:suspend`, async (req, res) => {
      const tenantId = req.tenantId;
      const employeeId = Number(req.params.id);
      const out = await suspendEmployee(pgAdapter, employeeId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/hr/employees/:id/reactivate
  //   Body: { user_id }. Flips status on_leave/suspended →
  //   active. Clears suspended_at + on_leave_at.
  app.post(
    '/api/finance/hr/employees/:id/reactivate',
    requireTenant,
    requirePerm('hr.employee.update'),
    wrapFinanceRoute('hr.employee.update', (req) => `hr_employee:${req.params.id}:reactivate`, async (req, res) => {
      const tenantId = req.tenantId;
      const employeeId = Number(req.params.id);
      const out = await reactivateEmployee(pgAdapter, employeeId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/hr/employees/:id/on-leave
  //   Body: { user_id, expected_return_date?, reason? }.
  //   Flips status active → on_leave. Stamps on_leave_at.
  app.post(
    '/api/finance/hr/employees/:id/on-leave',
    requireTenant,
    requirePerm('hr.employee.update'),
    wrapFinanceRoute('hr.employee.update', (req) => `hr_employee:${req.params.id}:on_leave`, async (req, res) => {
      const tenantId = req.tenantId;
      const employeeId = Number(req.params.id);
      const out = await setEmployeeOnLeave(pgAdapter, employeeId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/hr/employees/:id/terminate
  //   Body: { user_id, reason?, termination_date? }.
  //   Flips status any → terminated. Stamps termination_date
  //   (defaults to today) + termination_reason.
  app.post(
    '/api/finance/hr/employees/:id/terminate',
    requireTenant,
    requirePerm('hr.employee.update'),
    wrapFinanceRoute('hr.employee.update', (req) => `hr_employee:${req.params.id}:terminate`, async (req, res) => {
      const tenantId = req.tenantId;
      const employeeId = Number(req.params.id);
      const out = await terminateEmployee(pgAdapter, employeeId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 AI agents — data quality (W93-1) — read-only
  // tenant-scoped scans that surface data hygiene issues.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/ai/duplicates
  //   Find potential duplicate customers in the tenant
  //   (same hvhh OR same normalized name). Sorted by
  //   match_type (hvhh first, more severe) then by
  //   match_value ASC.
  app.get('/api/finance/ai/duplicates', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const items = await findDuplicateCustomers(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/ai/hvhh-drift
  //   Find invoices where the customer_hvhh snapshotted on
  //   the invoice differs from the live customer.hvhh.
  //   Sorted by invoice_id DESC (most recent first).
  app.get('/api/finance/ai/hvhh-drift', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const items = await findHvhhDrift(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/ai/data-quality
  //   Overall data quality summary for the tenant: per-
  //   module scores (customers/vendors/employees/invoices)
  //   + issue counts (duplicates, drift, missing hvhh).
  app.get('/api/finance/ai/data-quality', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const out = await getDataQualitySummary(pgAdapter, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 AI agents wave 2 (W94-1) — merge candidates + alerts.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/ai/merge-candidates
  //   For each duplicate group, propose a primary + secondary
  //   merge plan (the operator decides whether to apply).
  app.get('/api/finance/ai/merge-candidates', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const items = await suggestMergeCandidates(pgAdapter, tenantId);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/ai/alerts?threshold=80
  //   Data quality alerts: severity-sorted list of specific
  //   issues that exceed the threshold. Default threshold 80.
  app.get('/api/finance/ai/alerts', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const threshold = req.query.threshold ? Number(req.query.threshold) : 80;
      const items = await getDataQualityAlerts(pgAdapter, tenantId, threshold);
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 AI agents wave 3 (W99-1) — apply customer merge.
  // ────────────────────────────────────────────────────────────────────

  // POST /api/finance/ai/apply-merge
  //   Re-assign invoices from secondary to primary, archive
  //   the secondary, record an audit row in
  //   finance.customer_merge_log. Perm-gated by
  //   finance.customer.merge (a high-sensitivity perm; only
  //   the CRMOperator role holds it by default).
  //
  //   Body: { primary_id, secondary_id, reason?, applied_by_user_id? }
  //     - primary_id, secondary_id: required positive integers
  //     - reason: optional operator note (≤ 1024 chars)
  //     - applied_by_user_id: optional; defaults to the current user
  //       (req.user.id) if not provided in the body
  //
  //   Returns 200 with { merge_log_id, primary_id, secondary_id,
  //   invoices_reassigned, payments_reassigned } on success.
  //   Returns 400 for ValueError (bad input, already archived,
  //   same primary/secondary).
  app.post('/api/finance/ai/apply-merge', requireTenant, requirePerm('finance.customer.merge'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const body = req.body || {};
      // Default applied_by_user_id to the current user if not provided.
      const input = {
        primary_id: body.primary_id,
        secondary_id: body.secondary_id,
        reason: body.reason ?? null,
        applied_by_user_id: body.applied_by_user_id ?? (req.user && req.user.id) ?? null,
      };
      const result = await applyCustomerMerge(pgAdapter, input, tenantId);
      res.status(200).json(result);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        // Distinguish "not found" (404) from "bad input" (400).
        // The pure function throws ValueError for both; we use
        // the message prefix to decide.
        if (/not found/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // GET /api/finance/ai/merge-log
  //   List merge log rows for the tenant. Ordered by created_at
  //   DESC (most recent first). Optional filter by primary_id or
  //   secondary_id. Default limit 50, max 500.
  app.get('/api/finance/ai/merge-log', requireTenant, requirePerm('finance.customer.merge'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const primaryId = req.query.primary_id ? Number(req.query.primary_id) : null;
      const secondaryId = req.query.secondary_id ? Number(req.query.secondary_id) : null;
      const limit = req.query.limit ? Number(req.query.limit) : 50;
      const items = await listCustomerMergeLog(pgAdapter, tenantId, { primaryId, secondaryId, limit });
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 AI agents wave 4 (W102-1) — undo customer merge.
  // ────────────────────────────────────────────────────────────────────

  // POST /api/finance/ai/undo-merge
  //   Inverse of apply-merge: re-assigns the listed invoices
  //   back to the secondary, un-archives the secondary, and
  //   stamps the audit row with the undo metadata.
  //
  //   Body: { merge_log_id, undone_reason?, undone_by_user_id? }
  //     - merge_log_id: required positive integer (the audit
  //       row id from the original apply-merge call)
  //     - undone_reason: optional operator note (≤ 1024 chars)
  //     - undone_by_user_id: optional; defaults to the current
  //       user (req.user.id) if not provided in the body
  //
  //   Returns 200 with { merge_log_id, primary_id, secondary_id,
  //   invoices_restored, payments_restored } on success.
  //   Returns 404 if the merge log row doesn't exist in the tenant
  //   or if the secondary was hard-deleted.
  //   Returns 400 if the merge has already been undone, the
  //   merge log row has no reassigned_invoice_ids (pre-W102-1),
  //   or the secondary is not currently archived (state inconsistent).
  app.post('/api/finance/ai/undo-merge', requireTenant, requirePerm('finance.customer.merge'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const body = req.body || {};
      const input = {
        merge_log_id: body.merge_log_id,
        undone_reason: body.undone_reason ?? null,
        undone_by_user_id: body.undone_by_user_id ?? (req.user && req.user.id) ?? null,
      };
      const result = await undoCustomerMerge(pgAdapter, input, tenantId);
      res.status(200).json(result);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        // Distinguish "not found" (404) from "bad input" (400).
        if (/not found/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 reporting wave 3 (W96-1) — scheduled report runs.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/reports/schedules
  //   List report schedules. Optional filter by enabled.
  app.get('/api/finance/reports/schedules', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const enabled = req.query.enabled != null ? Number(req.query.enabled) : null;
      const items = await listReportSchedules(pgAdapter, tenantId, { enabled });
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/reports/schedules
  //   Create a new schedule. Body: { name, report_type,
  //   cron_expression, enabled?, params?, notify_email?,
  //   created_by? }.
  app.post(
    '/api/finance/reports/schedules',
    requireTenant,
    requirePerm('reports.dashboard.read'),
    wrapFinanceRoute('reports.schedule.create', (req, res) => res.locals.createdId ? `report_schedule:${res.locals.createdId}` : 'report_schedule:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await createReportSchedule(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/reports/schedules/:id
  //   Get a single schedule. Returns 404 if missing or
  //   cross-tenant.
  app.get('/api/finance/reports/schedules/:id', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const scheduleId = Number(req.params.id);
      const item = await getReportSchedule(pgAdapter, scheduleId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/reports/schedules
  //   Create a new report schedule. The body has:
  //     name, report_type, cron_expression, enabled (default 1),
  //     params (object, default null), notify_email (string, default null)
  //   cron_expression is a 5-field cron (minute, hour, day-of-month,
  //   month, day-of-week) — e.g. "0 9 * * 1" = every Monday at 09:00.
  app.post('/api/finance/reports/schedules', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const out = await createReportSchedule(pgAdapter, req.body || {}, tenantId);
      res.status(201).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/reports/schedules/:id/toggle
  //   Body: { enabled: 0|1 } — toggle the schedule on or off.
  //   The full updated schedule is returned.
  app.post('/api/finance/reports/schedules/:id/toggle', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const tenantId = req.tenantId;
      const enabled = Number(req.body?.enabled ?? 1);
      const out = await toggleReportSchedule(pgAdapter, id, { enabled }, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/reports/schedules/:id/reset-retries
  //   Clears the schedule's retry state (W105-1): retry_count=0,
  //   last_retry_at=null, next_run_at=NOW. Used by the operator
  //   to manually trigger a retry after a schedule was
  //   "exhausted" by the W105-1 retry mechanism.
  //
  //   Returns 200 with the updated schedule.
  //   Returns 404 if the schedule doesn't exist.
  app.post('/api/finance/reports/schedules/:id/reset-retries', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      const tenantId = req.tenantId;
      const out = await resetScheduleRetries(pgAdapter, id, tenantId);
      res.status(200).json(out);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });

  // POST /api/finance/reports/schedules/:id/toggle
  //   Toggle the enabled flag. Body: { enabled: 0 | 1 }.
  app.post(
    '/api/finance/reports/schedules/:id/toggle',
    requireTenant,
    requirePerm('reports.dashboard.read'),
    wrapFinanceRoute('reports.schedule.update', (req) => `report_schedule:${req.params.id}:toggle`, async (req, res) => {
      const tenantId = req.tenantId;
      const scheduleId = Number(req.params.id);
      const out = await toggleReportSchedule(pgAdapter, scheduleId, req.body || {}, tenantId);
      res.status(200).json(out);
    }),
  );

  // POST /api/finance/reports/executions
  //   Record a report execution (called by the scheduler
  //   worker when a run completes). Body: { schedule_id,
  //   report_type, status, started_at?, completed_at?,
  //   duration_ms?, result_json?, error_message? }.
  app.post(
    '/api/finance/reports/executions',
    requireTenant,
    requirePerm('reports.dashboard.read'),
    wrapFinanceRoute('reports.execution.create', (req, res) => res.locals.createdId ? `report_execution:${res.locals.createdId}` : 'report_execution:new', async (req, res) => {
      const tenantId = req.tenantId;
      const out = await recordReportExecution(pgAdapter, req.body || {}, tenantId);
      res.locals.createdId = out.id;
      res.status(201).json(out);
    }),
  );

  // GET /api/finance/reports/executions
  //   List report executions. Optional filter by scheduleId
  //   + status.
  app.get('/api/finance/reports/executions', requireTenant, requirePerm('reports.dashboard.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const scheduleId = req.query.schedule_id ? Number(req.query.schedule_id) : null;
      const status = req.query.status ?? null;
      const items = await listReportExecutions(pgAdapter, tenantId, { scheduleId, status });
      res.status(200).json({ items });
    } catch (err) {
      if (err && err.name === 'ValueError') {
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 reporting wave 9 (W108-1) — scheduler observability.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/reports/scheduler
  //   Return the W104-1 scheduler metrics + the email
  //   mode. The operator's dashboard reads this to show
  //   "is the worker healthy?" + "what's the email
  //   mode?".
  //
  //   Returns 200 with the snapshot.
  //   Returns 503 if the scheduler was disabled at boot
  //   (createApp was called with { scheduler: false }).
  app.get('/api/finance/reports/scheduler', requireTenant, requirePerm('reports.dashboard.read'), async (req, res) => {
    const scheduler = req.app.locals.scheduler;
    if (!scheduler) {
      return res.status(503).json({
        error: 'scheduler_disabled',
        message: 'scheduler worker is not running (disabled at boot)',
      });
    }
    const emailService = req.app.locals.emailService;
    const emailMode = emailService ? emailService.mode : 'stub';
    // The metrics object is a live getter bag — read it
    // once and snapshot the values into a plain object.
    const metrics = {
      totalTicks: scheduler.metrics.totalTicks,
      skippedTicks: scheduler.metrics.skippedTicks,
      completedTicks: scheduler.metrics.completedTicks,
      erroredTicks: scheduler.metrics.erroredTicks,
      inProgress: scheduler.metrics.inProgress,
      lastTickAt: scheduler.metrics.lastTickAt,
      lastTickDurationMs: scheduler.metrics.lastTickDurationMs,
      lastTickError: scheduler.metrics.lastTickError,
    };
    res.status(200).json({
      tickMs: scheduler.tickMs,
      emailMode,
      scheduler: metrics,
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Phase 3 reporting wave 6 (W103-1) — run-now admin endpoint.
  // ────────────────────────────────────────────────────────────────────

  // POST /api/finance/reports/schedules/:id/run-now
  //   Force a schedule to run immediately (without waiting
  //   for the next cron tick). The execution is recorded
  //   in finance.report_executions with triggered_by='manual'.
  //   The schedule's next_run_at is NOT changed — a manual
  //   run is an additional execution in the history, not
  //   a shift in the cron cadence.
  //
  //   Use cases:
  //   - Verify a data quality fix without waiting for the
  //     next scheduled tick
  //   - Re-run a report that failed in the last tick
  //   - Pre-flight a new schedule before enabling it
  //
  //   Perm gate: finance.reports.execute (high sensitivity).
  //
  //   Returns 200 with { execution_id, schedule_id,
  //   report_type, status, duration_ms, result, error? }
  //   on success.
  //   Returns 404 if the schedule doesn't exist in the tenant.
  //   Returns 400 on dispatch error (the function records
  //   the failure as a 'failed' execution and returns 400
  //   with the error message).
  app.post('/api/finance/reports/schedules/:id/run-now', requireTenant, requirePerm('finance.reports.execute'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const scheduleId = Number(req.params.id);
      // The email service is stored on app.locals by
      // createApp(). If the worker hasn't been started
      // (opts.scheduler === false), emailService is null
      // and the run still works — emails are just skipped.
      const emailService = req.app.locals.emailService ?? null;
      const result = await runReportNow(pgAdapter, pgAdapter, scheduleId, tenantId, undefined, emailService);
      res.status(200).json(result);
    } catch (err) {
      if (err && err.name === 'ValueError') {
        if (/not found in tenant/i.test(err.message)) {
          return res.status(404).json({ error: 'not_found', message: err.message });
        }
        return res.status(400).json({ error: 'bad_request', message: err.message });
      }
      next(err);
    }
  });

  // ────────────────────────────────────────────────────────────────────
  // Catalog pricing rules (Phase 2 catalog v2 wave 3d)
  // Wires the createPricingRule / listPricingRules / getPricingRule
  // pure functions (from W80-1) into 3 HTTP endpoints.
  // ────────────────────────────────────────────────────────────────────

  // GET /api/finance/catalog/pricing-rules
  //   List pricing rules for the caller's tenant. Default
  //   (archived=false) returns only non-archived rules;
  //   ?archived=true returns all. ?type=volume_discount |
  //   time_based | category_discount filters by rule type.
  app.get('/api/finance/catalog/pricing-rules', requireTenant, requirePerm('finance.pricing_rule.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const archived = req.query.archived === 'true';
      const type = typeof req.query.type === 'string' && req.query.type.length > 0 ? req.query.type : null;
      const items = await listPricingRules(pgAdapter, tenantId, { archived, type });
      res.status(200).json({ items });
    } catch (err) {
      next(err);
    }
  });

  // POST /api/finance/catalog/pricing-rules
  //   Create a new pricing rule. Body: { name, type,
  //   config_json?, priority?, valid_from?, valid_to? }.
  //   name + type are required. config_json is opaque
  //   (≤8192 chars). priority defaults to 100.
  app.post(
    '/api/finance/catalog/pricing-rules',
    requireTenant,
    requirePerm('finance.pricing_rule.create'),
    async (req, res, next) => {
      try {
        const tenantId = req.tenantId;
        const out = await createPricingRule(pgAdapter, req.body || {}, tenantId);
        res.status(201).json(out);
      } catch (err) {
        if (err && err.name === 'ValueError') {
          return res.status(400).json({ error: 'bad_request', message: err.message });
        }
        next(err);
      }
    },
  );

  // GET /api/finance/catalog/pricing-rules/:id
  //   Get a single pricing rule. 404 if missing or
  //   cross-tenant (W73-1 pattern).
  app.get('/api/finance/catalog/pricing-rules/:id', requireTenant, requirePerm('finance.pricing_rule.read'), async (req, res, next) => {
    try {
      const tenantId = req.tenantId;
      const ruleId = Number(req.params.id);
      const item = await getPricingRule(pgAdapter, ruleId, tenantId);
      res.status(200).json(item);
    } catch (err) {
      if (err && err.name === 'ValueError' && /not found in tenant/i.test(err.message)) {
        return res.status(404).json({ error: 'not_found', message: err.message });
      }
      next(err);
    }
  });
}
