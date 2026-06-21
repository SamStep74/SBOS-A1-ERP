# SBOS-A1-ERP

> **Sovereign Business Operating System — A1 ERP**
> The public, open-core home of the Armosphera One Claude ERP.

## What this repo is

`SBOS-A1-ERP` is the **public, open-core** distribution of the Armosphera One Claude
ERP — a sovereign, self-hostable Armenian business operating system with phased
one-to-one functional parity to Zoho One (Forms, CRM, Finance, Desk, People-HR,
Docs & Sign, Projects, Catalog & Inventory, Purchase, plus AI-augmented modules).

## Relationship to A1-ERP-HY

A1-ERP-HY (`~/dev/A1-ERP-HY`) is the **private R&D repo** with 51+ hardening slices,
10+ wave plans, and 800+ passing tests. It stays private while vendor integrations,
tenant secrets, and brand-specific code are still in flux.

`SBOS-A1-ERP` (this repo) is where **de-privatized, brand-neutral** code lands for
public release. Code flows **A1-ERP-HY → SBOS-A1-ERP** via dmux-workflows waves:

|             | A1-ERP-HY (private)                   | SBOS-A1-ERP (public)             |
| ----------- | ------------------------------------- | -------------------------------- |
| **Purpose** | R&D, hardening, vendor integration    | Public open-core distribution    |
| **Brand**   | Armosphera + HayHashvapah identifiers | Brand-neutral (rebrandable)      |
| **Tests**   | 800+ (full)                           | 55+ (RBAC port only) and growing |
| **Domains** | All 9 + i18n + Armenia tax            | RBAC first; others port per wave |
| **CI**      | Internal                              | GitHub Actions                   |
| **License** | Proprietary                           | TBD (open-core proposal)         |

See `docs/SBOS_VS_A1_ERP_HY.md` for the full porting protocol.

## Current state

- **Phase 0 (foundation)** — DONE. RBAC seeded (28 roles, 435 perms, 73 sets),
  finance core (invoices, customers, payments, VAT, e-invoice) wired.
- **Wave 11 (ship-it-2day)** — DONE. All 5 producer branches integrated, real
  auth (scrypt + bearer session), audit log, per-permission route guards, 4
  deferred items.
- **Wave 14 (deploy)** — DONE. Dockerfile, systemd unit, pm2 ecosystem, online-safe
  backup, admin token persistence. Production pg adapter fixed. Deploy smoke
  covers 35 endpoints.
- **Wave 16 (Phase 1 ERP — Inventory + Purchase Core)** — DONE.
  - Inventory: warehouses, stock locations, catalog items, weighted-average-cost
    stock moves (receive / deliver / transfer / adjust).
  - Purchase: vendors, POs (rfq → confirmed → partial → received → billed),
    3-way match vendor bills (draft → confirmed → posted → paid / void).
  - All wired to the HTTP layer under `/api/finance/{catalog,warehouses,
    stock,vendors,purchase-orders,vendor-bills}/*` with per-permission guards
    and audit-log integration.
  - 985/985 tests pass. Deploy smoke exercises the full
    warehouse → location → item → receive → vendor → PO → confirm → receive →
    bill flow on a fresh DB.
- **Wave 17 (Phase 1 ERP — Armenian PO + delivery-note templates)** — DONE.
  - Server-rendered PO + delivery-note templates in Armenian (primary),
    English, and Russian. Pure functions in `server/finance/poTemplate.js`;
    routes at `/api/finance/{purchase-orders,receipts}/:id/print?locale=hy&format=html|text`.
  - 1002/1002 tests pass (was 985; +17). Deploy smoke extended to 37
    endpoints with Armenian-text regression guard on the print routes.
- **Wave 18 (Phase 1 ERP — Replenishment report / low-stock alerts)** — DONE.
  - `reorder_point INTEGER NOT NULL DEFAULT 0` on catalog_items
    (migration 0009). `createCatalogItem` accepts it; `listCatalogItems`
    returns it.
  - `getReplenishmentReport(db, tenantId, {warehouseId})` — list every
    item below its reorder_point, sorted by shortage desc, with a
    per-warehouse breakdown. An item with `reorder_point=0` is treated
    as "no trigger" and never appears.
  - Route: `GET /api/finance/replenishment-report?warehouse_id=`.
  - 1013/1013 tests pass (was 1002; +11). Deploy smoke at 38 endpoints.
- **Wave 19 (Phase 1 ERP — Stock-valuation handoff to GL)** — DONE.
  - The journal is the bridge between operational stock + purchase
    events and the Armenian chart of accounts. Every
    stock.receive / stock.deliver / stock.adjust / vendor_bill.post
    writes a balanced journal entry.
  - Migration 0010_journal.sql: finance.journal_entries +
    finance.journal_entry_lines. UNIQUE (tenant_id, source,
    source_id) is the idempotency guard.
  - server/finance/journal.js: postJournalEntry (balanced, validates
    debit == credit, ≥2 lines, 3-digit account codes, ISO dates,
    lowercase-dot source), getJournalEntry, listJournalEntries,
    getAccountBalance, listAccountBalances. Both net_debit and
    net_credit are mutually exclusive (always ≤ 0 / ≥ 0).
  - server/finance/stockPosting.js: postStockReceiveGL
    (Dr 216/Cr 521), postStockDeliverGL (Dr 711/Cr 216 at avg),
    postStockAdjustGL (Dr 216/Cr 711 for gain, Dr 711/Cr 216 for
    loss), postVendorBillPostGL (Dr 226/Cr 521 for the VAT side).
  - Wiring: receiveStock / deliverStock / adjustStock /
    postVendorBill call the corresponding post* function as a
    best-effort side-effect. Failures are swallowed (move is the
    source of truth; the GL is a projection that can be
    reconciled).
  - Routes: `GET /api/finance/journal-entries[?since=&until=&source=&limit=&offset=]`,
    `GET /api/finance/journal-entries/:id`, `GET /api/finance/account-balances[?asOfDate=]`,
    `GET /api/finance/account-balances/:accountCode`.
  - 1054/1054 tests pass (was 1013; +27 journal + +14 stockPosting).
    Deploy smoke at 41 endpoints.
- **Wave 20 (Phase 1 ERP — GL reconciliation)** — DONE.
  - server/finance/reconciliation.js: findUnpostedMoves +
    reconcileJournal. The job finds moves (stock.receive /
    deliver / adjust / vendor_bill.post) that lack a journal
    entry and re-posts the missing GL. Idempotent (UNIQUE on
    source_id); per-move errors are collected, not thrown.
  - 2 routes: GET /api/finance/journal/reconcile?dryRun=true
    (safe, reports the gap) + POST /api/finance/journal/reconcile
    (gated by finance.journal.read, runs the actual post).
  - 11 tests in reconciliation.test.js: gap detection on a
    single move, idempotency (running twice posts each move
    only once), end-to-end re-post after nuking the journal
    (4 chart-of-accounts balances restored), error collection
    not throwing on a per-move failure.
  - 1082/1082 tests pass (was 1054; +28). Deploy smoke at 47
    endpoints.
- **Wave 21 (Phase 1 ERP — bug-prevention refactor)** — DONE.
  - server/finance/_pgStyle.js: shared pg-style adapter
    helpers (stripFinancePrefix, runQuery, numberedParams).
    The numberedParams helper makes the recurring "$N
    placeholder reuse under the pg → sqlite translation" bug
    impossible at the call site: each `#{...}` occurrence
    gets a unique $N placeholder, so subqueries with the same
    tenant_id filter on both sides no longer silently bind
    the wrong value.
  - 22 tests for the helpers (prefix strip edge cases,
    numberedParams single/multiple/reuse, runQuery pipeline).
  - Refactored journal.js + reconciliation.js to use the
    shared helper. inventory.js / purchase.js / poTemplate.js
    / stockPosting.js keep their inline helpers (out of
    scope; the new helper is opt-in for the new files).
  - 1104/1104 tests pass (was 1082; +22). Deploy smoke at 47
    endpoints.
- **Wave 22 (Phase 1 ERP — Trial balance report)** — DONE.
  - server/finance/trialBalance.js: joins
    listAccountBalances (journal.js) with the RA chart of
    accounts (l10n-am/chartOfAccounts) to produce a balanced
    CFO report. Each account's balance is projected into the
    natural sign of the account (debit-natural for asset /
    expense / management, credit-natural for liability /
    equity / revenue). The report asserts that total debits
    == total credits (the books balance) and surfaces
    is_balanced + delta so the operator can see the gap.
  - formatTrialBalanceText: server-rendered text report
    (text/plain; charset=utf-8) for the Armenian print
    workflow. JSON form is the default.
  - Route: GET /api/finance/trial-balance?asOfDate=&locale=hy|en|ru&format=json|text
  - 10 new tests cover: empty DB, single entry, complex flow,
    out-of-balance detection, off-chart account fallback,
    cross-tenant isolation, chart-order sort, Armenian +
    English text formatting, malformed input rejection.
  - 1114/1114 tests pass (was 1104; +10). Deploy smoke at 48
    endpoints.
- **Wave 23 (Phase 2 CRM — ValueError audit)** — DONE.
  - The W73-1 desk gotcha memory entry flagged that desk had
    the minimal ValueError form. A grep audit found CRM with
    the same bug. Fixed (proper constructor with this.name).
  - Added 2 unit regression tests + 1 smoke check (POST
    /api/finance/crm/contacts with bad email → 400, was
    500). The triply-enforced fix catches the next module
    that copies the minimal form.
  - 1130/1130 tests pass (was 1114; +16 with the 14 new
    CRM tests + 2 regression). Deploy smoke at 57 endpoints.
- **Wave 24 (Phase 1 ERP — boot-time reconciliation)** — DONE.
  - bin/sbos-server.mjs now runs reconcileJournal on every
    boot (for tenant 0, the bootstrap tenant). Best-effort:
    a failure is logged but does NOT block the server from
    starting. Skipped if the journal tables don't exist
    (old deploys before Wave 19). Closes the deferred
    "safe to run at boot" thing from Wave 20.
  - Smoke check: the boot log MUST contain a
    `reconciliation: scanned=N reconciled=N errors=N` line
    on every fresh install. Catches accidental removal of
    the hook.
  - 1130/1130 tests pass. Deploy smoke at 57 endpoints.
- **Wave 25 (Phase 2 Projects — route wiring)** — DONE.
  - Wires the projects + tasks + time-entries entities (from
    W74-1's schema + pure functions + 29 tests) into the HTTP
    layer with perm gates.
  - 8 new routes in server/finance/routes.js (list/create/get
    for projects, list/create for tasks under a project, and
    list/create for time-entries under a task). All gated by
    `projects.project.{read,create}` / `projects.task.{read,
    create,update}` (the 17 project perms were seeded in W74-1).
  - The two nested POSTs (`/projects/:id/tasks` and
    `/tasks/:id/time-entries`) inject the URL param into the
    body as `project_id` / `task_id` before calling the pure
    function — same pattern as the CRM and desk nested
    resources.
  - The single-entity GETs (`getProject`, `getTask`) catch the
    pure function's `ValueError("X N not found in tenant T")`
    and map it to 404 — same pattern as customer / inventory /
    purchase / desk / crm.
  - 5 new deploy smoke checks (list + status filter + 404 on
    missing project + 404 on missing tasks list + 404 on the
    nested projects/:id/tasks). Smoke at 68 endpoints
    (was 57; +5 for projects, +6 for desk that landed just
    before this wave).
  - 1159/1159 tests pass (was 1130; +29 from W74-1's
    pre-existing project tests). `npm run check` clean, boundary 0.
- **Wave 26 (Audit endpoint — perm gate + 403 smoke)** — DONE.
  - The `GET /api/finance/audit` endpoint (shipped in `7cda79b`
    "the 4 deferred items") had no perm gate. For a compliance
    endpoint that's a real hole: any authenticated user could
    read the full audit log. Closed by:
    1. Adding `requireTenant` + `requirePerm('security.audit.read')`
       middleware. The perm key exists in the catalog and is
       bound to the `AuditReader` perm set, which `Owner / Admin /
       Auditor` all hold via the role matrix.
    2. Switching the route from `readTenant(req)` (silent fallback
       to 0) to `req.tenantId` (set by the `requireTenant`
       middleware, 400 on missing).
  - 2 new unit tests in `server/rbac/rbac.test.js`:
    - `requirePerm('security.audit.read')` returns false for a
      Bookkeeper (no AuditReader perm set) with `outcome.reason =
      'no_permission'`.
    - `requirePerm('security.audit.read')` returns true for an
      Admin (AuditReader inherited via role matrix).
  - 1 new deploy smoke step (STEP 5b): seeds a Bookkeeper
    user in the running DB, mints a session via
    `server/auth-login.js#login`, hits `/api/finance/audit`
    with the Bookkeeper token, asserts 403. This is the only
    test path that exercises the real-auth + perm-gate wire
    end-to-end (the unit tests in server.test.js run in
    `SBOS_AUTH_MODE=stub` which bypasses real auth and binds
    every request to a stub Admin).
  - 1161/1161 tests pass (was 1159; +2). Smoke 68 endpoints
    + 1 new 403 check. `npm run check` clean, boundary 0.
- **Wave 27 (Finance GETs — systematic perm audit)** — DONE.
  - A pre-wave grep audit found that **33 of 34 finance GET
    routes** had no perm gate. Every POST + PATCH was gated;
    the GETs were all perm-less. For a multi-tenant finance
    system that's a real security gap (any authenticated user
    could read all invoices, all customers, all journal
    entries, the full trial balance, etc.).
  - Fix:
    1. Added `requirePerm('<perm>.read')` middleware to all
       33 GETs in `server/finance/routes.js`. Most map to an
       existing perm (`finance.invoice.read`,
       `finance.journal.read`, `crm.lead.read`,
       `desk.case.read`, `projects.project.read`, etc.).
    2. Added 2 missing read perms to the catalog:
       `finance.customer.read` (bound to CRMOperator, which
       already had `finance.customer.{create,update}`) and
       `desk.reply.read` (bound to DeskOperator, which already
       had `desk.reply.create`).
    3. The dashboard endpoint uses `reports.dashboard.read`,
       which is already in the catalog and bound to multiple
       perm sets.
  - The routes still use `readTenant(req)` (silent fallback
    to 0) — switching to `requireTenant` middleware is a
    related but separate concern. The 33 perm gates are the
    primary hardening; the tenant middleware is a follow-up
    (a few hundred lines of route refactor, ~1 wave).
  - 4 new unit tests in `server/rbac/rbac.test.js`:
    - PayrollClerk (has FinanceOperator, no CRMOperator) gets
      `no_permission` for `finance.customer.read`.
    - Admin gets `allowed` for `finance.customer.read`.
    - SalesRep (no DeskOperator) gets `no_permission` for
      `desk.reply.read`.
    - Admin gets `allowed` for `desk.reply.read`.
  - 1 new deploy smoke step (STEP 5c): seeds an HRSpecialist
    user (no FinanceOperator, no CRMOperator, no DeskOperator
    — pure HR role), mints a session, hits
    `/api/finance/invoices`, asserts 403. Sanity: admin hits
    the same endpoint, asserts 200. HRSpecialist is a good
    test role because it has `HROperator + DocsOperator +
    AIEnabled + StandardUser` but zero finance / customer /
    desk / project perms.
  - RBAC catalog grew from 435 to 437 perms (the 2 new
    `*.read` keys).
  - 1190/1190 tests pass (was 1161; +4 rbac + the +25 from
    the catalog v2 wave 1 commit that landed on origin in
    parallel). Smoke 68 endpoints + 2 new 403 checks (5b
    audit + 5c GET). `npm run check` clean, boundary 0.
- **Wave 28 (Finance GETs — tenant middleware swap)** — DONE.
  - Closes the Wave 27 deferral: the 38 perm-gated GETs now
    also run the `requireTenant` middleware. Previously they
    used `readTenant(req)` (silent fallback to tenant 0); now
    they 400 when no X-Tenant-Id header AND no
    `req.user.tenant_id` (the same middleware the audit
    endpoint + all writes use). This brings the GETs to
    defense-in-depth parity with the writes.
  - 3 things happened in this wave:
    1. Added `requireTenant` middleware to all 38 perm-gated
       GETs (the audit endpoint already had it from Wave 26).
       The middleware runs before `requirePerm`, so a missing
       tenant 400s before the perm check.
    2. Swapped `readTenant(req)` for `req.tenantId` in all
       38 GET handler bodies. `req.tenantId` is stamped by
       the `requireTenant` middleware and is always defined
       when the handler runs.
    3. The dashboard GET now passes
       `tenantId: req.tenantId` to `renderDashboard` (it
       already accepted the option; the route just wasn't
       wiring it through). Non-bootstrap tenants now get
       their own numbers on the dashboard.
  - Also closed a Wave 27 gap that the audit missed: the 5
    catalog v2 GETs from commit `ac41aff` (categories list /
    get / breadcrumb path, variants list / get) were perm-less
    because they were multi-line `app.get(\n  '/path',\n  ...)`
    that the Wave 27 grep audit didn't catch. Gated them with
    `finance.category.read` / `finance.variant.read` (the
    perms already existed in the catalog and were bound to
    perm sets).
  - Removed the now-unused `readTenant(req)` helper from
    `server/finance/routes.js`. The 35 callers are all on
    `req.tenantId` now; the helper was dead code.
  - No new tests added: the existing 78 endpoint smoke
    checks (admin token WITHOUT an X-Tenant-Id header, all
    expect 200) are the regression test. If the middleware
    swap is wrong, the smoke fails. The existing
    `tenant.test.js` already covers the `requireTenant`
    middleware (400 on missing, header-vs-user fallback, etc.)
    — no new test surface needed.
  - 1190/1190 tests pass. Smoke 78 endpoints + STEP 5b + 5c
    all pass. `npm run check` clean, boundary 0.
- **Wave 29 (Audit resource_id — capture the actual entity id)** — DONE.
  - The audit GET (Wave 26, perm-gated) and the audit
    record-on-write (in `wrapFinanceRoute`) were both working
    — every write was recorded, every read was perm-gated.
    But the audit `resource` field was a hardcoded string
    per route: `wrapFinanceRoute('invoice.update',
    'invoice:id', handler)` recorded the literal `invoice:id`,
    not the actual `invoice:42`. The 19 id-based write routes
    (PATCH/POST with `:id` in the path) all suffered from this.
    Consequence: "what happened to invoice 42?" couldn't be
    answered with a simple filter — you had to use a string
    match on `resource LIKE 'invoice:%'` and then eyeball
    which ones were the actual invoice 42.
  - Fix:
    1. Made `wrapFinanceRoute`'s `resource` arg accept
       either a string (backward compatible) or a function
       `(req) => 'invoice:' + req.params.id`. The wrapper
       resolves the function at audit-record time so the
       actual id is captured.
    2. Updated 19 id-based write routes to use the function
       form. Includes: PATCH /invoices/:id, PATCH
       /customers/:id, PATCH /catalog/categories/:id, PATCH
       /catalog/variants/:id, POST /invoices/:id/{payments,
       void, reconcile, lines}, POST /purchase-orders/:id/
       {confirm, cancel, receive}, POST /vendor-bills/:id/
       {confirm, post, pay, void}, POST /desk/cases/:id/
       replies, POST /projects/:id/tasks, POST
       /projects/:id/tasks/:taskId/time-entries, POST
       /catalog/items/:itemId/variants.
    3. Added a new `?resource_id=N` query param to
       `GET /api/finance/audit`. The filter is a substring
       match (`resource LIKE '%:<N>%'`) so it matches
       `invoice:42` AND `invoice:42:void` AND
       `invoice:42:reconcile` etc. — the "what happened
       to invoice 42" use case. Combine with
       `?action=` or `?resource=` for precision.
  - **Limitation documented**: the create routes still
    record `'customer:new'` instead of `'customer:<newId>'`.
    The new id lives in the response body, not in
    `req.params.id`, so the function form needs a way to
    read the response. Closing this needs a small
    `res.locals.createdId = out.id` change in each create
    handler + a `(req, res) => string` resource function.
    Defer to a follow-up wave if needed.
  - 3 new tests:
    - `audit.test.js` — listAudit with `?resource_id=42`
      matches `'invoice:42'` AND `'invoice:42:void'`
      (substring match) but not `'invoice:new'` (no id)
      or `'invoice:43'` (different id).
    - `server.test.js` 36a — PATCH /customers/:id records
      audit with `resource='customer:<id>'` (the actual
      behavior, not the literal).
    - `server.test.js` 36b — `GET /api/finance/audit?resource_id=<id>`
      finds the PATCH row.
  - 1 new deploy smoke step (STEP 5d): creates a customer
    via the admin token, PATCHes it, then GETs
    `/api/finance/audit?resource_id=<custId>` and asserts
    the response includes a row with
    `resource = 'customer:<custId>'` AND `action = 'customer.update'`.
  - 1216/1216 tests pass (was 1213; +3 new). Smoke 78
    endpoints + STEP 5b + 5c + 5d all pass. `npm run check`
    clean, boundary 0.
- **Wave 30 (Audit create-route resource_id — close the Wave 29
  create-route gap)** — DONE.
  - The Wave 29 fix made id-based write routes record the actual
    entity id (`invoice:42` instead of `invoice:id`). It left
    the create routes (POST /invoices, POST /customers, etc.)
    recording the literal `'customer:new'` because the new id
    lives in the response body, not in `req.params.id`. Wave 30
    closes that gap.
  - 2 mechanical changes per create handler:
    1. Each create handler now does
       `res.locals.createdId = out.id;` right before
       `res.status(201).json(out);`. The wrap helper reads
       `res.locals.createdId` when building the audit resource
       string. On the error path (handler never reached the
       assignment), the resource falls back to the literal
       `'X:new'`.
    2. Each create's resource arg is now a function
       `(req, res) => res.locals.createdId ? \`X:\${res.locals.createdId}\` : 'X:new'`
       instead of the static string `'X:new'`.
  - Backward-compat API extension: `wrapFinanceRoute`'s
    `resource` arg was (string | `(req) => string`).
    Wave 30 extends it to `(req, res) => string`. Existing
    call sites pass `(req) => 'invoice:' + req.params.id`
    and still work — JS doesn't enforce arity, the unused
    `res` arg is just ignored. New call sites use the
    `(req, res)` form to read `res.locals.createdId`.
  - 25 create routes touched (the original 19 + 6 that
    the original audit missed: payment.create, stock.{receive,
    deliver, transfer, adjust}, po.receive).
  - 1 new test: `server.test.js` 36c — POST /customers
    records audit with `resource='customer:<newId>'`
    (findable via `?resource_id=<newId>`). The test asserts
    the create row is in the response of
    `GET /api/finance/audit?resource_id=<id>`.
  - 1 new deploy smoke step (STEP 5e): creates a customer,
    then GETs `?resource_id=<custId>` and asserts the
    response includes a row with
    `resource='customer:<custId>'` AND `action='customer.create'`.
  - **End-to-end audit loop closed**: with Waves 26 + 28 + 29
    + 30, you can now answer "what happened to invoice 42?"
    with `GET /api/finance/audit?resource_id=42` and see
    EVERY event in the lifecycle: create (Wave 30), update
    (Wave 29), void, payment, lines replacement, reconcile,
    etc. The audit log is the authoritative source for
    compliance + forensics.
  - 1217/1217 tests pass (was 1216; +1 new). Smoke 86
    endpoints + STEP 5b + 5c + 5d + 5e all pass.
    `npm run check` clean, boundary 0.
- **Wave 31 (Customer 360 — pure function + tests)** — DONE.
  - `server/finance/customer360.js` exports
    `getCustomer360(db, customerId, tenantId, opts)` which
    returns the full 360 view of a customer in one call:
    ```json
    {
      "customer": { id, name, hvhh, address, email, tenant_id },
      "open_invoices": [{
        id, invoice_number, issue_date, due_date, status,
        total_amd, paid_amd, balance_amd, days_overdue
      }],
      "recent_payments": [{
        id, invoice_id, invoice_number, paid_at, amount_amd,
        method, reference
      }],
      "totals": {
        open_count, open_total_amd, paid_total_amd,
        outstanding_amd
      },
      "aging": {
        current, days_1_30, days_31_60, days_61_90, days_90_plus
      }
    }
    ```
  - The aging buckets hold the BALANCE owed (not the original
    total) so a partially-paid invoice buckets by its
    `days_overdue` with the remaining amount — what the CFO
    actually wants to see.
  - 12 tests cover: missing customer (404), cross-tenant
    invisibility, empty customer, 3 aging-bucket cases
    (current / 31-60 / 90+), paid invoice exclusion,
    partial-payment balance, due_date sort order,
    recent_payments limit, invalid customerId / tenantId.
  - Test pattern: real in-memory sqlite with the production
    finance schema (mirrors `realdb-smoke.test.js`). The
    adapter strips pg `::bigint` casts and translates
    `$N` → `?` positional.
  - 1240/1240 tests pass (was 1228; +12 new). Lint clean.
    `npm run check` clean, boundary 0.
- **Wave 32 (Customer 360 — route wiring)** — DONE.
  - Wires the Wave 31 pure function to
    `GET /api/finance/customers/:id/360`. Three middlewares:
    `requireTenant` (Wave 28 defense-in-depth),
    `requirePerm('finance.customer.read')` (the same perm the
    customer list / get uses — 360 is read-only, no extra
    perms), and the handler.
  - Optional `?today=YYYY-MM-DD` query param for back-dated
    aging reports + reproducible tests. Defaults to the
    current date inside the pure function.
  - 404 on missing or cross-tenant customer (no
    existence-oracle leak between tenants — same pattern
    as `getProject` / `getTask` / `getInvoice`).
  - 2 new integration tests in `server.test.js`:
    - 36d — `GET /api/finance/customers/:id/360` returns the
      full 360 shape (customer info, empty open_invoices,
      zero totals, zero aging).
    - 36e — `GET /api/finance/customers/999999/360` returns
      404 with `error: 'not_found'`.
  - 1 new deploy smoke step (STEP 5f): creates a customer,
    hits the 360 endpoint, asserts the response shape
    (customer.id / customer.name / open_invoices=[] /
    totals.open_count=0 / aging.current=0). Sanity: 404
    path on a missing customer.
  - 1242/1242 tests pass (was 1240; +2 new). Smoke 86
    endpoints + STEP 5b + 5c + 5d + 5e + 5f all pass.
    `npm run check` clean, boundary 0.
- **Wave 33 (Vendor 360 — pure function + 13 tests)** — DONE.
  - `server/finance/vendor360.js` exports
    `getVendor360(db, vendorId, tenantId, opts)` — the
    purchase-side mirror of the customer 360. Returns:
    ```json
    {
      "vendor": { id, code, name, hvhh, address, email, phone, contact_name, tenant_id },
      "open_purchase_orders": [{
        id, order_number, order_date, expected_date, status,
        total_amd, outstanding_amd, days_overdue
      }],
      "recent_receipts": [{
        id, purchase_order_id, order_number, receipt_number,
        received_at, notes
      }],
      "totals": { open_count, open_total_amd, outstanding_amd },
      "aging": { current, days_1_30, days_31_60, days_61_90, days_90_plus }
    }
    ```
  - Aging is keyed on `expected_date` (when we expect to
    receive the goods). POs that are already received fall
    into the `current` bucket — the operator has the goods,
    so there's nothing to age. The bill-level outstanding
    (after billing) is a follow-up.
  - Added a small `getVendor(db, id, tenantId)` helper to
    `purchase.js` (the same shape as `getCustomer`) so the
    360 view can fetch vendor basic info with the same
    tenant-scoping pattern.
  - 13 tests cover: missing vendor (404), cross-tenant
    invisibility, empty vendor, 3 aging-bucket cases
    (current / 31-60 / 90+), billed PO exclusion, cancelled
    PO exclusion, due_date sort order, received-PO
    exclusion from overdue, recent_receipts order, invalid
    vendorId / tenantId.
  - 1255/1255 tests pass (was 1242; +13). Lint clean.
- **Wave 34 (Dashboard 360 — pure function + 13 tests)** — DONE.
  - `server/finance/dashboard360.js` exports
    `getDashboard360(db, tenantId, opts)` — the CFO
    dashboard JSON. Returns:
    ```json
    {
      "today": "YYYY-MM-DD",
      "ar": { open_count, outstanding_amd, aging: { ... 5 buckets } },
      "ap": { open_count, outstanding_amd, aging: { ... 5 buckets } },
      "top_customers": [{ id, name, hvhh, outstanding_amd, open_invoice_count }],
      "top_vendors":   [{ id, code, name, hvhh, outstanding_amd, open_po_count }]
    }
    ```
  - 4 SQL aggregates run in parallel (Promise.all): AR
    totals + aging, AP totals + aging, top customers, top
    vendors. Each query is a single scan regardless of how
    many customers / vendors exist — the dashboard scales
    without the per-entity N+1 cost of the customer/vendor
    360 views.
  - Aging on the dashboard uses `julianday($today) -
    julianday(due_date)` for AR and `julianday($today) -
    julianday(expected_date)` for AP. The query uses
    distinct placeholders ($1..$7) so the test adapter's
    pg → sqlite translation preserves parameter identity
    (a regression I hit during Wave 34 — sqlite silently
    fills unfilled `?` with NULL, which made every aging
    bucket return 0 in tests until I switched to distinct
    placeholders).
  - 13 tests cover: empty tenant, AR totals + aging,
    paid-invoice exclusion, top-customers sort, AP totals +
    aging, billed/cancelled PO exclusion, top-vendors sort,
    0-outstanding exclusion, partial-payment reduction,
    cross-tenant isolation, limit cap, invalid tenantId,
    invalid today format.
  - 1268/1268 tests pass (was 1255; +13). Lint clean.
- **Wave 35 (Dashboard 360 — route wiring)** — DONE.
  - Wires the Wave 34 pure function to
    `GET /api/finance/360`. Two middlewares:
    `requireTenant` (Wave 28 defense-in-depth) and
    `requirePerm('reports.dashboard.read')` (the same perm
    the HTML `/api/finance/dashboard` view uses).
  - Optional `?today=YYYY-MM-DD` and `?limit=N` query
    params. The pure function defaults today to the current
    date and limit to 10 (max 50).
  - 2 new integration tests in `server.test.js`:
    - 36f — `GET /api/finance/360` returns the full
      dashboard JSON shape (ar / ap / aging / top_customers /
      top_vendors, all with the expected field types).
    - 36g — `GET /api/finance/360?today=2026-01-01` returns
      `body.today === '2026-01-01'` (back-dated dashboard).
  - 1 new deploy smoke step (STEP 5g): hits the endpoint
    with the admin token, asserts the response shape
    (today regex, ar.open_count/outstanding_amd/aging,
    ap.open_count/outstanding_amd/aging, top_customers +
    top_vendors as arrays). Sanity: `?today=2026-01-01`
    override returns `today=2026-01-01`.
  - **CFO dashboard story complete end-to-end**:
    - HTML dashboard: `GET /api/finance/dashboard` (Wave 14)
    - JSON dashboard: `GET /api/finance/360` (Wave 35)
    - Per-customer drill-down: `GET /api/finance/customers/:id/360` (Wave 32)
    - Per-vendor drill-down: `GET /api/finance/vendors/:id/360` (Wave 36)
  - 1270/1270 tests pass (was 1268; +2). Smoke 86
    endpoints + STEP 5b + 5c + 5d + 5e + 5f + 5g all pass.
    `npm run check` clean, boundary 0.
- **Wave 36 (Vendor 360 — route wiring)** — DONE.
  - Wires the Wave 33 pure function to
    `GET /api/finance/vendors/:id/360`. Two middlewares:
    `requireTenant` (Wave 28 defense-in-depth) and
    `requirePerm('finance.vendor.read')` (the same perm
    the vendor list / get uses).
  - Optional `?today=YYYY-MM-DD` query param for
    back-dated aging (defaults to current date).
  - 404 on missing or cross-tenant vendor (no
    existence-oracle leak between tenants).
  - 1 new integration test in `server.test.js`:
    - 36h — `GET /api/finance/vendors/999998/360` returns
      404 with `error: 'not_found'`. (The 200-shape path
      is covered by the 13 unit tests in `vendor360.test.js`.)
  - 1 new deploy smoke step (STEP 5h): hits a
    non-existent vendor, asserts 404 + `error: 'not_found'`.
  - **CFO dashboard story finally closed**: all 4 endpoints
    are now live (HTML dashboard, JSON dashboard, per-customer
    drill-down, per-vendor drill-down). Phase 1 ERP is now
    end-to-end CFO-grade + perm-gated + tenant-scoped +
    audit-logged.
  - 1287/1287 tests pass (was 1286; +1). Smoke 86 endpoints
    + STEP 5b + 5c + 5d + 5e + 5f + 5g + 5h all pass.
    `npm run check` clean, boundary 0.

## v0.6.0 — A1-Validator integration across customer + vendor + invoice

The first release that ties HHVH (Armenian tax ID) validation to the
[A1-Validator](https://github.com/Armosphera/A1-Validator) HTTP service
end-to-end. Three create endpoints now share the same fail-soft pattern:

1. **`POST /api/finance/customers`** — validates `hvhh` via the
   `assertValidHvhhAsync` wrapper. New `server/finance/hvhh-validator.js`
   (118 lines) wraps `lib/a1-validator-client.js` with a local
   `^\d{8}$` regex fallback.
2. **`POST /api/finance/vendors`** — same wrapper, same pattern.
   Vendor TIN is validated by `assertValidVendorHvhhAsync` (a thin
   re-export of the customer wrapper, kept as a separate name for
   clarity in stack traces).
3. **`POST /api/finance/invoices`** — re-validates the referenced
   customer's `hvhh` at invoice-create time. Catches drift: a
   customer's HVVH could have become invalid since the customer was
   created (e.g. the A1-Validator algorithm was updated, or the
   customer was imported with the validator disabled). The FK check
   now reads `SELECT id, hvhh FROM finance.customers` in one query,
   and the wrapper rejects on invalid HVVH.

**Fail-soft contract** (3-tier):
- `A1_VALIDATOR_URL` unset → the client is disabled; the local regex
  (`^\d{8}$`) is the only enforcement. No HTTP calls, no latency.
- `A1_VALIDATOR_URL` set but service unreachable → falls back to the
  same local regex. The endpoint stays up.
- `A1_VALIDATOR_URL` set + service reachable → calls the service.
  - `ok: true` → proceed.
  - `ok: false` → 400 with the service's error message.

The local regex is always the last-line-of-defense. The
A1-Validator service is an enhancement, never a requirement.

**Stats:**
- 1268/1268 tests pass (was 1242; +26 new across
  hvhh-validator + customer integration + vendor integration +
  invoice integration).
- 88 endpoint smoke checks + STEP 5b/5c/5d/5e/5f/7/7b/7c/7d/7e
  all pass. STEP 7c/7d/7e are the three new fail-soft
  validators wired into the smoke.
- `npm run check` clean, boundary 0.
- 0 dependencies added. Pure ESM + Node 20.

**New deploy smoke steps:**
- STEP 7c: customer HVVH (valid 8-digit persists, invalid 9-digit
  returns 400).
- STEP 7d: vendor TIN (same shape, mirrors customer).
- STEP 7e: invoice customer HVVH drift — creates a customer with
  valid HVVH, creates an invoice (success), then directly UPDATEs
  the customer's HVVH in sqlite to `NOT_AN_HVVH`, restarts the
  server, and verifies that the next invoice-create against the
  now-invalid customer returns 400. End-to-end proof of the
  drift-detection value of the re-validation pass.

## v0.7.0 — A1-Validator drift detection on vendor bills + CRM contacts

Three changes extend the A1-Validator integration from v0.6.0:

1. **Vendor bill HVVH re-validation** — `POST /api/finance/vendor-bills`
   re-validates the vendor HVVH at bill-create time (catches drift in
   the same way invoice-create does for the customer). The vendor bill
   flow re-fetches the live `hvhh` from the `vendors` table, not the
   denormalized value on `purchase_orders.vendor_hvhh`, so a vendor-edit
   that updated the hvhh is caught.

2. **CRM contact TIN** — new migration `0016_crm_contacts_hvhh.sql` adds a
   nullable `hvhh TEXT` column to `finance.crm_contacts`. Most contacts at
   customer companies don't have their own TIN (the company TIN is on
   `finance.customers`), but self-employed contacts may. The `createContact`
   endpoint validates the optional field via the same fail-soft A1-Validator
   wrapper.

3. **CI self-hosted runner fallback** — the org-level hosted-runner quota
   has been intermittently exhausted since 2026-06-21 (`Job is waiting
   for a hosted runner to come online`). `runs-on` is now a list:
   `[self-hosted, sbos-self-hosted, linux, x64, ubuntu-latest]`. The first
   match wins, so a registered self-hosted runner sidesteps the quota
   entirely. Maintainer runbook in `docs/CI.md`.

**Stats:**
- 1320/1320 tests pass (was 1242 at v0.6.0; +78 across all waves).
- All 88 endpoint smoke checks + STEP 5b/5c/5d/5e/5f/5g/5h/7/7b/7c/7d/7e/7f/7g pass.
- `npm run check` clean, boundary 0.
- 0 dependencies added.

**New deploy smoke steps:**
- STEP 7f: vendor bill HVVH drift. End-to-end proof of the re-validation value.
- STEP 7g: CRM contact TIN. Valid persists, invalid returns 400, optional field works.



## v0.8.0 — A1-Validator on CRM leads + migration renumber

Three changes on top of v0.7.0:

1. **A1-Validator on CRM leads** (`POST /api/finance/crm/leads`)
   - New migration `0018_crm_leads_hvhh.sql` adds a nullable `hvhh TEXT` column
     to `finance.crm_leads` (plus a partial index). A lead represents a prospective
     customer; the hvhh is the prospective company's TIN (may be NULL for leads
     that aren't yet formally quoted with a company).
   - Same fail-soft pattern as customer + vendor + invoice + contact: optional
     field, local regex fallback when A1-Validator is disabled/unreachable.
   - Smoke step 7h: valid persists, invalid 9-digit returns 400, omitted is fine.

2. **Migration renumber** — `0013_pos_basics.sql` (POS basics from Wave 41) renamed
   to `0017_pos_basics.sql` to break the duplicate-prefix collision with
   `0013_catalog_v2.sql`. The 0017 position slots between `0016_crm_contacts_hvhh.sql`
   (v0.7.0) and the next free number. Both 0013 and 0017 are independent migrations
   (the POS tables don't FK-reference the catalog tables) so this is a clean rename.

3. **Test suite cleanup** — the v0.7.0-flagged pre-existing failures are now fixed:
   - `npm install` was never run after the `^5.2.1` Express bump (commit b61ac40) —
     `node_modules/express` was stuck on 4.22.2. Ran `npm install` to pick up Express 5.2.1.
   - Lint cleanups in `server/finance/lots.js` (`no-useless-assignment`) and
     `server/finance/pos.js` (3 unused validators prefixed with `_`).

**Stats:**
- 1393/1393 tests pass (was 1242 at v0.6.0; +151 across all waves).
- All 88 endpoint smoke checks + STEP 5b/5c/5d/5e/5f/5g/5h/5i/5j/5k/7/7b/7c/7d/7e/7f/7g/**7h** pass.
- `npm run check` clean, boundary 0.
- 0 dependencies added.



## v0.9.0 — A1-Validator on POS sales + migration renumber cleanup

Three changes on top of v0.8.0:

1. **A1-Validator on POS sales** (`POST /api/finance/pos/sales`)
   - When `customer_id` is provided (walk-in sales with `null` skip the
     check), the customer's HVVH is re-validated at sale-create time.
     Same fail-soft drift-detection pattern as invoice-create
     (v0.6.0) and vendor-bill-create (v0.7.0): re-fetches the live
     value from `finance.customers`, validates via the A1-Validator
     wrapper, throws 400 on invalid.
   - The FK check now reads `SELECT id, hvhh FROM finance.customers`
     (was `SELECT id FROM finance.customers`) — one round-trip for
     both existence and TIN re-validation.
   - Smoke step 7i: valid customer HVVH → sale succeeds, walk-in
     sale (customer_id=null) → succeeds without check, mutate
     customer's HVVH in sqlite → restart server → next sale-create
     against the now-invalid customer returns **400**. End-to-end
     proof of the drift-detection value.

2. **Migration renumber cleanup** — finish the work started in v0.8.0:
   - `0009_replenishment.sql` → `0019_replenishment.sql` (was colliding
     with `0009_crm.sql`)
   - `0014_lots_serials.sql` → `0020_lots_serials.sql` (was colliding
     with `0014_catalog_bundles.sql`)
   - All 20 migration prefixes are now unique. Migration sort order
     preserved (each renumbered file lands in its natural position).

3. **Version bump + release notes** — `package.json` 0.8.0 → 0.9.0.

**Stats:**
- 1397/1397 tests pass (was 1242 at v0.6.0; +155 across all waves).
- All 88 endpoint smoke checks + STEP 5b/5c/5d/5e/5f/5g/5h/5i/5j/5k/7/
  7b/7c/7d/7e/7f/7g/7h/**7i** pass.
- `npm run check` clean, boundary 0.
- 0 dependencies added.

**New deploy smoke step:**
- **STEP 7i**: POS sale customer HVVH drift detection. Valid persists,
  walk-in (customer_id=null) succeeds without check, drifted customer
  HVVH returns 400.

**Migration list (20 migrations total in v0.9.0, all unique prefixes):**

```
0001_init.sql               0010_journal.sql               0017_pos_basics.sql
0002_invoice_status_tracking   0011_desk.sql              0018_crm_leads_hvhh.sql
0003_vat_carry_forward         0012_projects.sql          0019_replenishment.sql
0004_invoice_adjustments       0013_catalog_v2.sql        0020_lots_serials.sql
0005_tenant_id                 0014_catalog_bundles.sql
0006_finance_audit             0015_catalog_pricing.sql
0007_inventory                 0016_crm_contacts_hvhh.sql
0008_purchase
0009_crm
```


Next: Phase 2 (lots / serials, replenishment reports, stock-valuation handoff
to GL, customer 360 + vendor 360 panels, POS). See
`docs/ERP_COMPARISON_IMPLEMENTATION_PLAN.md`.

## How to run

```bash
nvm use                 # Node 20
npm install
npm test                # node --test
npm run lint
npm run format:check
```

## A1-Validator integration (optional, Wave 27)

`lib/a1-validator-client.js` is a zero-dep Node.js client for the
[A1-Validator](https://github.com/Armosphera/A1-Validator) HTTP service
(41 business-ID validators: HHVH, INN, CNPJ, MX RFC, JP My Number, IN PAN, IL ID, SA TIN, TW UBN, etc.).
The integration is **opt-in**: if the service is unreachable, the client
returns `{ ok: null, _error: ... }` (no crash, no blocking).

```js
import { A1ValidatorClient } from './lib/a1-validator-client.js';

const a1 = new A1ValidatorClient({
  baseUrl: process.env.A1_VALIDATOR_URL || 'http://a1-validator:8000',
  timeoutMs: 2000,
  retries: 1,
});

// At boot, log integration state:
const h = await a1.health();
if (h.ok) {
  console.log(`a1-validator ${h.version}: ${h.validators.length} kinds available`);
} else {
  console.log(`a1-validator unreachable: ${h.error} (running in local-fallback mode)`);
}

// Per-request validation (e.g. before creating a customer with a tax id):
const result = await a1.validate('hvvh', { hvhh: input.hvhh });
if (result._skipped || result._error) {
  // Service unavailable — fall back to local regex check
} else if (!result.ok) {
  throw new ValueError(`hvhh is invalid: ${result.error}`);
}
```

**To deploy the A1-Validator sidecar:**

```bash
docker run -d --name a1-validator -p 8000:8000 \
  ghcr.io/armosphera/a1-validator:v0.4.0
export A1_VALIDATOR_URL=http://localhost:8000
npm start
```

**Smoke test:** `scripts/deploy-smoke.sh` STEP 7b verifies the client
loads, `validate()` returns `_skipped` when disabled, and `health()`
returns `ok=false` for an unreachable host (no crash).

## Phase 1 ERP API surface

The Phase 1 ERP release adds the **Inventory** + **Purchase Core** modules
under `/api/finance/*`. All endpoints are tenant-scoped (via `X-Tenant-Id`
header or `req.user.tenant_id`) and gated by `requirePerm(...)` (see
`server/rbac/permissions.js`).

### Inventory (`finance.product.*`, `finance.warehouse.*`, `finance.stock.*`)

| Method | Path                                     | Perm key                  | Body / Notes                              |
| ------ | ---------------------------------------- | ------------------------- | ----------------------------------------- |
| GET    | `/api/finance/catalog/items`             | `finance.product.read`    | List catalog items in the caller's tenant |
| POST   | `/api/finance/catalog/items`             | `finance.product.create`  | `{sku, name, unit_of_measure, unit_cost_amd}` |
| GET    | `/api/finance/warehouses`                | `finance.warehouse.read`  | List warehouses                           |
| POST   | `/api/finance/warehouses`                | `finance.warehouse.create`| `{code, name, address?}`                  |
| GET    | `/api/finance/stock/locations`           | `finance.warehouse.read`  | `?warehouse_id=` filter                   |
| POST   | `/api/finance/stock/locations`           | `finance.warehouse.create`| `{warehouse_id, code, name, location_type}` (`INTERNAL`/`CUSTOMER`/`SUPPLIER`) |
| GET    | `/api/finance/stock/balances`            | `finance.stock.read`      | `?item_id=&location_id=` filters           |
| GET    | `/api/finance/stock/moves`               | `finance.stock.read`      | `?item_id=&move_type=&limit=` filters (audit log of every move) |
| POST   | `/api/finance/stock/receive`             | `finance.stock.move`      | `{catalog_item_id, destination_location_id, quantity, unit_cost}` — updates weighted-average cost |
| POST   | `/api/finance/stock/deliver`             | `finance.stock.move`      | `{catalog_item_id, source_location_id, quantity, unit_price}` — reduces stock + records COGS at source avg |
| POST   | `/api/finance/stock/transfer`            | `finance.stock.move`      | `{catalog_item_id, source_location_id, destination_location_id, quantity}` — same-tenant transfer, average cost recalc at dest |
| POST   | `/api/finance/stock/adjust`              | `finance.stock.move`      | `{catalog_item_id, location_id, new_quantity, reason}` — absolute new qty (set + record delta) |

### Purchase (`finance.vendor.*`, `finance.purchase.*`, `finance.bill.*`)

| Method | Path                                          | Perm key                  | Body / Notes                              |
| ------ | --------------------------------------------- | ------------------------- | ----------------------------------------- |
| GET    | `/api/finance/vendors`                        | `finance.vendor.read`     | List vendors                              |
| POST   | `/api/finance/vendors`                        | `finance.vendor.create`   | `{code, name, hvhh?, address?, email?}` (hvhh = 8-digit Armenian tax ID) |
| GET    | `/api/finance/purchase-orders`                | `finance.purchase.read`   | `?vendor_id=&status=` filters              |
| POST   | `/api/finance/purchase-orders`                | `finance.purchase.create` | `{vendor_id, order_number, order_date, expected_date?, lines:[{catalog_item_id, quantity, unit_cost, description?}]}` — status starts in `rfq` |
| POST   | `/api/finance/purchase-orders/:id/confirm`    | `finance.purchase.confirm`| Locks in unit_cost. `rfq` → `confirmed`   |
| POST   | `/api/finance/purchase-orders/:id/cancel`     | `finance.purchase.cancel` | `{reason}`. Allowed in `rfq`/`confirmed`/`partial` only |
| POST   | `/api/finance/purchase-orders/:id/receive`    | `finance.purchase.receive`| `{destination_location_id, lines:[{order_line_id, received_quantity}]}` — 3-way match guard (no over-receive), creates a stock receipt per line, transitions `confirmed`/`partial` |
| GET    | `/api/finance/vendor-bills`                   | `finance.bill.read`       | `?vendor_id=&status=&purchase_order_id=`   |
| POST   | `/api/finance/vendor-bills`                   | `finance.bill.create`     | `{purchase_order_id, bill_number, bill_date, due_date?}` — auto-builds 3-way match lines (sum received qty × unit_cost per item) + 20% VAT |
| POST   | `/api/finance/vendor-bills/:id/confirm`       | `finance.bill.update`     | `draft` → `confirmed`                      |
| POST   | `/api/finance/vendor-bills/:id/post`          | `finance.bill.approve`    | `confirmed` → `posted` (PO transitions to `billed`) |
| POST   | `/api/finance/vendor-bills/:id/pay`           | `finance.bill.pay`        | `posted` → `paid`                          |
| POST   | `/api/finance/vendor-bills/:id/void`          | `finance.bill.void`       | `{reason}`. Only before payment            |

### Armenian templates (PO + delivery note)

The PO + delivery note have **server-rendered templates** in
Armenian (the primary target), English, and Russian. The templates
are pure functions in `server/finance/poTemplate.js`; the print
routes return them as `text/plain` or `text/html`.

| Method | Path                                                 | Query                              | Returns                                         |
| ------ | ---------------------------------------------------- | ---------------------------------- | ----------------------------------------------- |
| GET    | `/api/finance/purchase-orders/:id/print`             | `?locale=hy\|en\|ru&format=html\|text` | Rendered PO body (text/plain or text/html)       |
| GET    | `/api/finance/receipts/:id/print`                    | `?locale=hy\|en\|ru&format=html\|text` | Rendered delivery-note body (text/plain or text/html) |

Locale defaults to `en`; format defaults to `text`. The Armenian
output is used by the production invoice/PO PDF generator and the
delivery-note printer.

Example:

```bash
curl -s "http://localhost:3000/api/finance/purchase-orders/1/print?locale=hy&format=text" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0'
# -> "Գնման պատվեր #PO-ARM-0001\nՀամար: PO-ARM-0001   Ամսաթիվ: 2026-06-21\n..."

curl -s "http://localhost:3000/api/finance/receipts/1/print?locale=hy&format=html" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0'
# -> "<html-escaped body with <br> line breaks>"
```

### Replenishment report (low-stock alerts)

Each catalog item carries a `reorder_point` (defaults to 0 = "no
trigger"). The replenishment report lists every item whose total
stock across all locations is below its reorder_point, sorted by
shortage desc (largest gap first), with a per-warehouse breakdown.

| Method | Path                                       | Query                 | Returns                                  |
| ------ | ------------------------------------------ | --------------------- | ---------------------------------------- |
| GET    | `/api/finance/replenishment-report`        | `?warehouse_id=` (optional) | `{"items":[{item_id, sku, name, uom_code, total_stock, reorder_point, shortage, by_warehouse:[...]}], ...}` |

Example:

```bash
curl -s "http://localhost:3000/api/finance/replenishment-report" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' | jq
# -> {
#      "items": [
#        { "sku": "WIDGET-1", "total_stock": 3, "reorder_point": 10, "shortage": 7,
#          "by_warehouse": [{"warehouse_code": "WH-1", "stock": 3}, ...] },
#        ...
#      ]
#    }
```

Set `reorder_point` at item creation time via `POST /api/finance/catalog/items`
with `{sku, name, reorder_point: 10}`. The next deployment can wire
this report to an email/Slack alert (out of Phase 1 scope).

### GL journal (stock-valuation handoff)

Every stock-valuation event in the inventory + purchase modules
posts a balanced journal entry to the RA chart of accounts. The
journal is the bridge between operational moves and the financial
books.

| Event                       | Dr                       | Cr                       | Source             |
| --------------------------- | ------------------------ | ------------------------ | ------------------ |
| Stock receive               | 216 Inventory            | 521 AP — purchases       | `stock.receive`   |
| Stock deliver (COGS)        | 711 COGS                 | 216 Inventory            | `stock.deliver`   |
| Stock adjust (gain)         | 216 Inventory            | 711 COGS                 | `stock.adjust`    |
| Stock adjust (loss)         | 711 COGS                 | 216 Inventory            | `stock.adjust`    |
| Vendor bill post (with VAT) | 226 VAT-input            | 521 AP — purchases       | `vendor_bill.post`|

The journal is **balanced** (total debits == total credits on every
entry) and **idempotent** (a `(source, source_id)` pair can post
exactly one entry; re-running the posting for the same move is a
no-op). Failures are best-effort: a failed GL post doesn't roll
back the move; the next reconciliation picks it up.

| Method | Path                                                  | Query                                | Returns                                          |
| ------ | ----------------------------------------------------- | ------------------------------------ | ------------------------------------------------ |
| GET    | `/api/finance/journal-entries`                        | `?since=&until=&source=&limit=&offset=` | `{items: [{id, entry_date, source, source_id, description, currency, status, book_date}]}` |
| GET    | `/api/finance/journal-entries/:id`                    | —                                    | One entry (header + lines)                       |
| GET    | `/api/finance/account-balances`                       | `?asOfDate=` (optional)              | `{items: [{account_code, total_debit, total_credit, net_debit, net_credit}]}` |
| GET    | `/api/finance/account-balances/:accountCode`          | `?asOfDate=` (optional)              | One account: `{account_code, total_debit, total_credit, net_debit, net_credit}` |

Example:

```bash
# All journal entries for the tenant
curl -s "http://localhost:3000/api/finance/journal-entries?limit=10" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' | jq

# Trial balance as of 2026-06-30
curl -s "http://localhost:3000/api/finance/account-balances?asOfDate=2026-06-30" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' | jq
# -> {
#      "items": [
#        { "account_code": "216", "total_debit": 5000, "total_credit": 0,
#          "net_debit": 5000, "net_credit": 0 },
#        { "account_code": "521", "total_debit": 0, "total_credit": 6000,
#          "net_debit": 0, "net_credit": 6000 },
#        ...
#      ]
#    }
```

#### GL reconciliation (closes the move-vs-journal gap)

The journal is a best-effort projection of the operational moves.
A move that fails to post its GL (db error, transient outage) leaves
a gap. The reconciliation job finds those gaps and re-posts the
missing entries (idempotent — the UNIQUE index on (source,
source_id) is the backstop).

| Method | Path                                       | Body / Query              | Returns                                                       |
| ------ | ------------------------------------------ | ------------------------- | ------------------------------------------------------------- |
| GET    | `/api/finance/journal/reconcile`           | `?dryRun=true` (default)  | `{dry_run: true, scanned: <int>, unposted: [...], errors: []}` |
| POST   | `/api/finance/journal/reconcile`           | `{dryRun: true\|false}`   | `{dry_run: false, scanned, reconciled, errors: [{move_id, source, error}]}` |

Example:

```bash
# See what would be reconciled (safe, no posts)
curl -s "http://localhost:3000/api/finance/journal/reconcile?dryRun=true" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' | jq

# Actually re-post the missing entries
curl -sX POST "http://localhost:3000/api/finance/journal/reconcile" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' -d '{"dryRun": false}' | jq
# -> {
#      "dry_run": false,
#      "scanned": 3,         // 3 moves lacked a journal entry
#      "reconciled": 3,     // all 3 were re-posted successfully
#      "errors": []
#    }
```

The reconciliation is **safe to run at boot** (no destructive
operation; the only state change is new journal rows). The
SBOS-A1-ERP server runs the reconciliation automatically on
every boot (Wave 24) — see the `[sbos-server] reconciliation: ...`
line in the boot log. If the reconciliation finds a gap (e.g.
because a previous boot crashed mid-write), it posts the
missing entries and logs the result. A failure here is logged
but does not block the server from starting — the operator
can re-run via `POST /api/finance/journal/reconcile` after
fixing the underlying issue. Future work: a scheduled job
that runs the reconciliation every N minutes as additional
defense in depth.

#### Trial balance report

The classic CFO snapshot: every account in the Armenian chart of
accounts that has any activity, with its debit and credit totals
in the natural sign of the account, and the assertion that
**total debits == total credits** (the books balance).

| Method | Path                                  | Query                                              | Returns                                                                              |
| ------ | ------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------------ |
| GET    | `/api/finance/trial-balance`          | `?asOfDate=&locale=hy\|en\|ru&format=json\|text`  | `{"accounts":[{code, label, class, type, natural_sign, debit, credit}], total_debit, total_credit, is_balanced, delta, account_count}` |

The `natural_sign` is one of `debit` (asset, expense, management)
or `credit` (liability, equity, revenue) — the column where the
account's positive balance shows up. `is_balanced: true` is the
healthy state; `is_balanced: false` (or `delta != 0`) means the
books are out of balance and the operator should investigate.

Example:

```bash
# JSON form (for a UI or a downstream service)
curl -s "http://localhost:3000/api/finance/trial-balance?locale=hy" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' | jq
# -> {
#      "tenant_id": 0,
#      "as_of_date": "latest",
#      "locale": "hy",
#      "accounts": [
#        { "code": "216", "label": "Ապdelays", "class": 2, "type": "asset",
#          "natural_sign": "debit", "debit": 3500, "credit": 0 },
#        { "code": "521", "label": "Kreditorakan pardaqner", "class": 5, "type": "liability",
#          "natural_sign": "credit", "debit": 0, "credit": 3000 },
#        { "code": "711", "label": "COGS", "class": 7, "type": "expense",
#          "natural_sign": "debit", "debit": 1500, "credit": 0 },
#        ...
#      ],
#      "total_debit": 6000, "total_credit": 6000,
#      "is_balanced": true, "delta": 0, "account_count": 4
#    }

# Text form (for the Armenian print workflow)
curl -s "http://localhost:3000/api/finance/trial-balance?locale=hy&format=text" \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0'
# -> Արdelays հdelays
#    Ays mekum: latest
#
#    Kod   Հdelays                                       Debit        Credit
#    --------------------------------------------------------------
#    216   Ապdelays                                     3500             0
#    521   Kreditorakan pardaqner gnmanqeri gitsvox          0           3000
#    711   COGS                                          1500             0
#    --------------------------------------------------------------
#          Endelutyun                                    5000          5000
#
#    BALANCED
```

### Typical end-to-end flow

```bash
# 1. Master data
WAREHOUSE_ID=$(curl -sX POST http://localhost:3000/api/finance/warehouses \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d '{"code":"WH-1","name":"Main Warehouse"}' | jq -r .id)

LOC_ID=$(curl -sX POST http://localhost:3000/api/finance/stock/locations \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d "{\"warehouse_id\":$WAREHOUSE_ID,\"code\":\"BIN-A1\",\"name\":\"Aisle 1\",\"location_type\":\"INTERNAL\"}" | jq -r .id)

ITEM_ID=$(curl -sX POST http://localhost:3000/api/finance/catalog/items \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d '{"sku":"WIDGET-1","name":"Widget","unit_of_measure":"pcs","unit_cost_amd":500}' | jq -r .id)

# 2. Buy from a supplier
VENDOR_ID=$(curl -sX POST http://localhost:3000/api/finance/vendors \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d '{"code":"ACME","name":"ACME Corp","hvhh":"12345678"}' | jq -r .id)

PO_ID=$(curl -sX POST http://localhost:3000/api/finance/purchase-orders \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d "{\"vendor_id\":$VENDOR_ID,\"order_number\":\"PO-1\",\"order_date\":\"2026-06-21\",\"lines\":[{\"catalog_item_id\":$ITEM_ID,\"quantity\":10,\"unit_cost\":500}]}" | jq -r .id)

curl -sX POST http://localhost:3000/api/finance/purchase-orders/$PO_ID/confirm \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' -H 'content-type: application/json' -d '{}'

curl -sX POST http://localhost:3000/api/finance/purchase-orders/$PO_ID/receive \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d "{\"destination_location_id\":$LOC_ID,\"lines\":[{\"order_line_id\":1,\"received_quantity\":10}]}"

# 3. Pay the supplier — creates the AP bill (3-way match) and posts it.
BILL_ID=$(curl -sX POST http://localhost:3000/api/finance/vendor-bills \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' \
  -H 'content-type: application/json' \
  -d "{\"purchase_order_id\":$PO_ID,\"bill_number\":\"BILL-1\",\"bill_date\":\"2026-06-21\"}" | jq -r .id)

curl -sX POST http://localhost:3000/api/finance/vendor-bills/$BILL_ID/post \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' -H 'content-type: application/json' -d '{}'

curl -sX POST http://localhost:3000/api/finance/vendor-bills/$BILL_ID/pay \
  -H "Authorization: Bearer $TOKEN" -H 'X-Tenant-Id: 0' -H 'content-type: application/json' -d '{}'
```

### Stock valuation model

`receiveStock` uses **weighted-average cost** (the most common small-business
valuation method, equivalent to Odoo's "average costing"):

```
new_avg_cost = (current_qty * current_avg + received_qty * new_unit_cost) / new_qty
```

`deliverStock` records COGS at the source location's current average cost. This
is the same number that flows into the financial reports; no implicit
LIFO/FIFO/HIFO guessing.

The full audit trail is in `stock_moves` (filterable by `?item_id=&move_type=`)
and exposed to operators via `GET /api/finance/stock/moves`.

### Out of Phase 1 scope (Phase 2+)

Lot / serial tracking, replenishment reports, automatic stock-valuation
journal entries (vendor bill → GL), vendor pricelists, blanket orders, RFQ
flow with multiple suppliers, landed-cost allocation, customer 360 + vendor
360 panels, UI apps. See `docs/ERP_COMPARISON_IMPLEMENTATION_PLAN.md`.

## How to deploy (single-node, self-hosted)

The product is a single Node.js process backed by a sqlite file. There
is no Docker, no Kubernetes manifest, no cloud account required — the
deployment is one `npm install` + one `node bin/sbos-server.mjs` on
any Linux/macOS host with Node 20+.

```bash
# 1. Install dependencies
nvm use                 # Node 20
npm ci                  # exact versions from package-lock.json

# 2. Back up any existing database (idempotent re-boot preserves the DB)
[ -f .sbos.db ] && cp .sbos.db .sbos.db.bak-$(date +%s)

# 3. Boot the server
PORT=8080 \
HOST=0.0.0.0 \
SBOS_DB=/var/lib/sbos-a1-erp/sbos.db \
SBOS_LOCALE=en \
node bin/sbos-server.mjs

# 4. Capture the admin session token from stdout (printed on first
#    boot; idempotent on restart, so the same token works until the
#    DB is rebuilt from scratch):
#
#    [sbos-server] admin session token: aBcD1234...
#
# 5. Verify it works
curl -s http://127.0.0.1:8080/api/health
# → {"ok":true,"version":"0.1.0"}

curl -s -H "Authorization: Bearer aBcD1234..." \
     -H "X-Tenant-Id: 0" \
     http://127.0.0.1:8080/api/finance/customers
# → {"items":[]}
```

### Environment variables

| Var              | Default          | Description                                                  |
| ---------------- | ---------------- | ------------------------------------------------------------ |
| `PORT`           | `3000`           | HTTP port the server listens on                              |
| `HOST`           | `127.0.0.1`      | Bind host. Set to `0.0.0.0` for LAN/remote access             |
| `SBOS_DB`        | `./.sbos.db`     | Path to the sqlite file. Auto-created on first boot          |
| `SBOS_LOCALE`    | `en`             | Default locale (`en`, `hy`, `ru` supported)                  |
| `SBOS_AUTH_MODE` | `real`           | `real` = session-token auth (production), `stub` = dev/test  |

### Production considerations (not in code, deploy-time concerns)

- **Process supervision**: wrap the boot in systemd, pm2, or a
  Docker restart policy. SIGTERM is handled (clean shutdown).
- **HTTPS**: not built in. Run behind nginx/Caddy/Traefik with
  TLS termination.
- **Backups**: `.sbos.db` is a single file. Snapshot before every
  deploy (see step 2 above). The file is safe to copy while the
  server is running (sqlite WAL mode).
- **Multi-tenancy**: every endpoint except `/api/health` requires
  an `X-Tenant-Id` header (or `req.user.tenant_id` from the auth
  layer). Tenant 0 is the bootstrap tenant; new tenants need a
  row in `finance.tenants` plus a matching `users.tenant_id`.
- **Auth token storage**: the admin session token is printed to
  stdout on first boot. For multi-host deploys, persist it to
  a secret store (Hashicorp Vault, AWS Secrets Manager, k8s
  Secret) and inject via env at boot. The token is idempotent
  on restart against the same DB.
- **Smoke test**: `npm run smoke:deploy` exercises a fresh-install
  boot end-to-end (13 GET endpoints + 3 write endpoints + DB schema
  check + graceful shutdown + restart idempotency). Runs in CI on
  every push and PR.

### Running behind a reverse proxy

```nginx
# /etc/nginx/sites-available/sbos-a1-erp
server {
  listen 443 ssl http2;
  server_name erp.example.com;
  ssl_certificate     /etc/letsencrypt/live/erp.example.com/fullchain.pem;
  ssl_certificate_key /etc/letsencrypt/live/erp.example.com/privkey.pem;

  location / {
    proxy_pass http://127.0.0.1:8080;
    proxy_set_header Host              $host;
    proxy_set_header X-Real-IP         $remote_addr;
    proxy_set_header X-Forwarded-For   $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    # Big request bodies (file uploads) need an explicit limit;
    # the default 1mb on the Node side is the safety net.
    client_max_body_size 10m;
  }
}
```

### Containerized deploy (Docker)

```bash
docker build -t sbos-a1-erp:dev .
docker run --rm -d \
  --name sbos-a1-erp \
  -p 8080:3000 \
  -v sbos-data:/var/lib/sbos-a1-erp \
  -e PORT=3000 \
  -e HOST=0.0.0.0 \
  sbos-a1-erp:dev

# Grab the admin token from the container's logs:
docker logs sbos-a1-erp 2>&1 | grep "admin session token"
# Or read the token file directly (it's at the data volume path):
docker exec sbos-a1-erp cat /var/lib/sbos-a1-erp/admin-token
```

The image is multi-stage (Node 20 alpine, ~80MB), runs as a
non-root `sbos` user, exposes a `HEALTHCHECK` on `/api/health`, and
persists the sqlite file + admin token in a mounted volume at
`/var/lib/sbos-a1-erp`.

### Process supervision

**systemd** (Linux, preferred for production):

```bash
# 1. Copy the unit file and edit the User/Environment/ExecStart paths
sudo cp scripts/sbos-a1-erp.service /etc/systemd/system/
sudo systemctl edit sbos-a1-erp  # optional: drop-in overrides

# 2. Enable + start
sudo systemctl daemon-reload
sudo systemctl enable --now sbos-a1-erp

# 3. Watch the boot log (admin token appears here on first boot)
sudo journalctl -u sbos-a1-erp -f

# 4. Read the token from the file
sudo cat /var/lib/sbos-a1-erp/admin-token

# 5. Backup
sudo /opt/sbos-a1-erp/scripts/backup-sbos.sh
```

**pm2** (cross-platform alternative):

```bash
npm i -g pm2
pm2 start scripts/ecosystem.config.cjs
pm2 startup     # generate the boot-time pm2 daemon
pm2 save        # save the process list for the daemon
pm2 logs        # tail stdout (admin token here on first boot)
pm2 monit       # live resource view
```

The systemd unit hardens the process with `NoNewPrivileges`,
`ProtectSystem=strict`, `ProtectHome`, `PrivateTmp`,
`MemoryDenyWriteExecute`, `RestrictAddressFamilies`, and
`ReadWritePaths=/var/lib/sbos-a1-erp`. The pm2 config is the
cross-platform fallback for hosts without systemd (macOS dev
boxes, some cloud VMs).

### Admin token storage

The admin session token is printed to stdout on first boot AND
persisted to `SBOS_ADMIN_TOKEN_FILE` (default:
`<dir-of-SBOS_DB>/admin-token`, mode 0600). To grab the token:

```bash
# From the file (canonical):
sudo cat /var/lib/sbos-a1-erp/admin-token

# Or via the helper:
npm run token:print

# Or from journalctl (last 50 lines):
sudo journalctl -u sbos-a1-erp -n 50 | grep "admin session token"
```

The token is idempotent on restart against the same DB — only a
fresh DB or a `DELETE FROM sbos_rbac_sessions` rotates it. For
multi-host deploys, persist the file to a shared secret store
(Hashicorp Vault, AWS Secrets Manager, k8s Secret) and inject
via env at boot.

### Database backups

```bash
# One-shot (online-safe, WAL-friendly, retention=7 by default):
npm run backup

# Or directly:
SBOS_DB=/var/lib/sbos-a1-erp/sbos.db \
  BACKUP_DIR=/var/backups/sbos \
  KEEP=30 \
  scripts/backup-sbos.sh

# Cron (daily at 02:00):
echo '0 2 * * * root /opt/sbos-a1-erp/scripts/backup-sbos.sh' \
  | sudo tee /etc/cron.d/sbos-backup
```

The script uses `sqlite3 .backup` (online-safe via the WAL
journal) and falls back to `cp` if the `sqlite3` CLI is missing.
`KEEP` controls how many backups to retain; older files are
pruned. Restore is `cp <backup> /var/lib/sbos-a1-erp/sbos.db`
while the service is stopped.

## How to orchestrate a new wave

```bash
# Dry-run: shows worktree + tmux pane plan, no side effects
node scripts/orchestrate-worktrees.cjs \
  .orchestration/sbos-a1-erp-bootstrap.json \
  --dry-run

# Execute: create worktrees, write per-worker task/handoff/status files,
# launch one tmux pane per worker
node scripts/orchestrate-worktrees.cjs \
  .orchestration/sbos-a1-erp-bootstrap.json

# Just create worktrees and write files, no tmux
node scripts/orchestrate-worktrees.cjs \
  .orchestration/<next-wave>.json \
  --no-tmux
```

See `docs/DMUX_WORKFLOWS.md` for the full guide.

## Karpathy Eval

The open-core release boundary is covered by a fixed, local eval:

```bash
node scripts/check-open-core-boundary-contract.mjs
node scripts/karpathy-eval.mjs --run open-core-boundary-contract
```

The contract keeps this repo publishable as a brand-neutral, open-core
distribution: no tenant identifiers in shipped source, no tracked env files, no
key-shaped secrets, and deploy-time operator branding instead of compiled-in
customer names. The one source exception is the stable e-invoice XML protocol
namespace preserved for mapper compatibility.

While first attaching or editing the eval harness itself, use
`--allow-harness-dirty`; after the harness is committed, run without that flag.

## Layout

```
SBOS-A1-ERP/
├── README.md                       ← this file
├── AGENTS.md                       ← agent conventions (TDD, 80% coverage, immutable)
├── package.json
├── tsconfig.json
├── eslint.config.js
├── .prettierrc.json
├── .nvmrc                          ← 20
├── .github/workflows/ci.yml        ← CI on push / PR
├── scripts/
│   ├── orchestrate-worktrees.cjs    ← plan.json runner
│   ├── tmux-worktree-orchestrator.cjs  ← shared helper (worktree + tmux)
│   └── orchestrate-codex-worker.sh ← codex CLI launcher
├── docs/
│   ├── DMUX_WORKFLOWS.md           ← orchestration guide (SBOS-A1-ERP tuned)
│   ├── PROJECT_STATUS.md           ← current wave, pipeline, open questions
│   ├── AGENT_BRIEF.md              ← one-page brief for new agents/humans
│   ├── SBOS_VS_A1_ERP_HY.md        ← public/private repo relationship
│   ├── HANDOFF-SUMMARY.md          ← A1-ERP-HY HANDOFF.md, first 400 lines
│   ├── ERP_COMPARISON_IMPLEMENTATION_PLAN.md   ← mirrored from A1-ERP-HY
│   ├── RBAC_SYSTEM.md              ← mirrored from A1-ERP-HY
│   └── DMUX_WORKFLOWS.md (source)  ← mirrored from A1-ERP-HY (provenance)
├── server/                         ← runtime code (RBAC lands here in wave 0)
│   └── rbac/                       ← (port target — see rbac-port worker)
├── test/                           ← node:test tests
└── .orchestration/
    ├── README.md                   ← plan.json schema reference
    └── sbos-a1-erp-bootstrap.json  ← wave 0 plan
```

## Related

- [Armosphera/autoresearch-sboss](https://github.com/Armosphera/autoresearch-sboss) — the eval-loop harness the validators come from
- [Armosphera/A1-Validator](https://github.com/Armosphera/A1-Validator) — Python lib for the 37 business-ID validators; consumed via `lib/a1-validator-client.js`
- [Armosphera/A1-Platform](https://github.com/Armosphera/A1-Platform) — the SBOSS product line

## License

TBD (open-core proposal — see `docs/SBOS_VS_A1_ERP_HY.md`).

## Status legend

- starting: wave 0 worker pending
- in-progress: worker has committed to its branch
- done: worker handoff merged to main
- blocked: worker waiting on a human / external dependency
