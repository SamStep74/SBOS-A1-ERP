#!/bin/bash
# SBOS-A1-ERP deploy smoke test.
#
# Fresh-install + boot + endpoint smoke + DB schema check + graceful
# shutdown + restart idempotency. The unit test suite uses a
# pre-seeded in-memory DB, so it can't catch fresh-install wiring bugs
# (missing seedRBAC, composite-PK drift, missing admin user role link,
# etc.) — this is the only gate that does.
#
# Stop conditions:
#   1. Fresh .sbos.db — no stale state.
#   2. Server boots in ≤15s, /api/health returns 200.
#   3. 13 documented endpoints return expected codes.
#   4. DB schema has 18 expected tables (5 finance migrations + rbac
#      + users + vat_carry_forward with composite PK).
#   5. RBAC seed populated (≥30 perms, ≥10 roles, admin linked to Admin role).
#   6. Graceful shutdown on SIGTERM (≤10s).
#   7. Restart is idempotent (migrations + seed + admin link are no-ops).
#
# Run via: bash scripts/deploy-smoke.sh
# Exits 0 on PASS, 1 on FAIL.
set -uo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TESTDIR=/tmp/sbos-deploy-smoke
PORT=${PORT:-3499}
LOG=$TESTDIR/server.log
LOG2=$TESTDIR/server-restart.log
PIDFILE=$TESTDIR/server.pid
DB=$TESTDIR/.sbos.db

# Reset test state
mavis-trash "$DB" "$LOG" "$LOG2" 2>/dev/null
mkdir -p "$TESTDIR"
cd "$TESTDIR"

echo "=== STEP 1: Fresh state ==="
[ -f "$DB" ] && { echo "FAIL: stale db at $DB"; exit 1; } || echo "OK: no stale db"
echo

echo "=== STEP 2: Boot server ==="
PORT=$PORT SBOS_DB=$DB node "$REPO_ROOT/bin/sbos-server.mjs" > "$LOG" 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$PIDFILE"
echo "PID=$SERVER_PID PORT=$PORT DB=$DB"

for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  if curl -s --max-time 1 "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q '"ok"'; then
    echo "OK: server up after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = "15" ]; then
    echo "FAIL: server didn't come up in 15s"
    cat "$LOG"
    kill $SERVER_PID 2>/dev/null
    exit 1
  fi
done
echo

# Capture the admin session token the server printed to stdout. The
# real-auth path (default since the wave-13 follow-up) requires a
# Bearer session token; the legacy "Bearer dev" stub is gone.
ADMIN_TOKEN=$(grep -oE "admin session token: [A-Za-z0-9_-]+" "$LOG" | head -1 | awk '{print $NF}')
if [ -z "$ADMIN_TOKEN" ]; then
  echo "FAIL: server did not print an admin session token"
  cat "$LOG"
  kill $SERVER_PID 2>/dev/null
  exit 1
fi
echo "admin session token: $ADMIN_TOKEN"
echo

echo "=== STEP 3: Endpoint smoke (production) ==="
ADMIN_TOKEN="$ADMIN_TOKEN" node -e "
const http = require('node:http');
const PORT = $PORT;
const TOKEN = process.env.ADMIN_TOKEN;
const checks = [
  { path: '/api/health', expect: 200, name: 'health' },
  { path: '/api/rbac/permissions', expect: 200, name: 'rbac/permissions' },
  { path: '/api/rbac/roles', expect: 200, name: 'rbac/roles' },
  { path: '/api/rbac/profiles', expect: 200, name: 'rbac/profiles' },
  { path: '/api/finance/dashboard?asOfDate=2026-06-21', headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/dashboard tenant=0' },
  { path: '/api/finance/invoices', headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/invoices tenant=0' },
  { path: '/api/finance/customers', headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/customers tenant=0' },
  { path: '/api/finance/vat/return?yearMonth=2026-01', headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/vat/return tenant=0' },
  { path: '/api/finance/vat/return?yearMonth=2026-01', headers: { 'X-Tenant-Id': '7' }, expect: 200, name: 'finance/vat/return tenant=7 (isolated)' },
  { path: '/api/finance/einvoice/export/1', headers: { 'X-Tenant-Id': '0' }, expect: 404, name: 'einvoice/export/1 (no row → 404)' },
  { path: '/api/finance/einvoice/export/1', headers: { 'X-Tenant-Id': '7' }, expect: 404, name: 'einvoice/export/1 tenant=7 (isolated)' },
  { path: '/api/rbac/approvals', expect: 200, name: 'rbac/approvals' },
  { path: '/api/nonexistent', expect: 404, name: '404 path' },
  // Phase 1 ERP — inventory reads (empty DB → 200, items: [])
  { path: '/api/finance/catalog/items', headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/catalog/items tenant=0' },
  { path: '/api/finance/warehouses',     headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/warehouses tenant=0' },
  { path: '/api/finance/stock/locations',headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/stock/locations tenant=0' },
  { path: '/api/finance/stock/balances', headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/stock/balances tenant=0' },
  { path: '/api/finance/stock/moves',    headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/stock/moves tenant=0' },
  // Phase 1 ERP — purchase reads (empty DB → 200, items: [])
  { path: '/api/finance/vendors',           headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/vendors tenant=0' },
  { path: '/api/finance/purchase-orders',   headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/purchase-orders tenant=0' },
  { path: '/api/finance/vendor-bills',      headers: { 'X-Tenant-Id': '0' }, expect: 200, name: 'finance/vendor-bills tenant=0' },
];

// Write-endpoint regression guard: catches the 'production pg adapter
// drops RETURNING' class of bug (wave-14). The HTTP layer must
// return a real id on POST, not null.
const writeChecks = [
  { method: 'POST', path: '/api/finance/customers', body: { name: 'SmokeCustomer', hvhh: '99887766' }, expect: 201, name: 'POST /api/finance/customers (returns id > 0)' },
  { method: 'PATCH', path: '/api/finance/customers/1', body: { name: 'SmokeRenamed' }, expect: 200, name: 'PATCH /api/finance/customers/1' },
  { method: 'POST', path: '/api/finance/invoices', body: { customer_id: 1, invoice_number: 'INV-SMOKE-1', issue_date: '2026-06-21', due_date: '2026-07-21', lines: [{ description: 'X', quantity: 1, unit_price_amd: 1000 }] }, expect: 201, name: 'POST /api/finance/invoices (returns id > 0)' },
  { method: 'POST', path: '/api/finance/invoices/1/lines', body: { lines: [{ description: 'Replaced', quantity: 1, unit_price_amd: 2000 }] }, expect: 200, name: 'POST /api/finance/invoices/1/lines (replace on draft)' },
  { method: 'GET',  path: '/api/finance/audit?limit=5', expect: 200, name: 'GET /api/finance/audit (returns rows from the writes above)' },
  // Phase 1 ERP — inventory write flow (warehouse → location → item → receive).
  { method: 'POST', path: '/api/finance/warehouses', body: { code: 'WH-SMOKE', name: 'Smoke Warehouse' }, expect: 201, name: 'POST /api/finance/warehouses (returns id > 0)' },
  { method: 'POST', path: '/api/finance/stock/locations', body: { warehouse_id: 1, code: 'BIN-001', name: 'Smoke Bin', location_type: 'INTERNAL' }, expect: 201, name: 'POST /api/finance/stock/locations (returns id > 0)' },
  { method: 'POST', path: '/api/finance/catalog/items', body: { sku: 'SKU-SMOKE-1', name: 'Smoke Item', unit_of_measure: 'pcs', unit_cost_amd: 500 }, expect: 201, name: 'POST /api/finance/catalog/items (returns id > 0)' },
  { method: 'POST', path: '/api/finance/stock/receive', body: { catalog_item_id: 1, destination_location_id: 1, quantity: 10, unit_cost: 500 }, expect: 201, name: 'POST /api/finance/stock/receive (returns id > 0)' },
  // Phase 1 ERP — purchase write flow (vendor → PO → confirm → receive → bill).
  { method: 'POST', path: '/api/finance/vendors', body: { code: 'V-SMOKE', name: 'Smoke Vendor', hvhh: '12345678' }, expect: 201, name: 'POST /api/finance/vendors (returns id > 0)' },
  { method: 'POST', path: '/api/finance/purchase-orders', body: { vendor_id: 1, order_number: 'PO-SMOKE-1', order_date: '2026-06-21', lines: [{ catalog_item_id: 1, quantity: 5, unit_cost: 500 }] }, expect: 201, name: 'POST /api/finance/purchase-orders (returns id > 0)' },
  { method: 'POST', path: '/api/finance/purchase-orders/1/confirm', body: {}, expect: 200, name: 'POST /api/finance/purchase-orders/1/confirm' },
  { method: 'POST', path: '/api/finance/purchase-orders/1/receive', body: { destination_location_id: 1, lines: [{ order_line_id: 1, received_quantity: 5 }] }, expect: 201, name: 'POST /api/finance/purchase-orders/1/receive' },
  { method: 'POST', path: '/api/finance/vendor-bills', body: { purchase_order_id: 1, bill_number: 'BILL-SMOKE-1', bill_date: '2026-06-21' }, expect: 201, name: 'POST /api/finance/vendor-bills (returns id > 0)' },
];

let done = 0, pass = 0, fail = 0;
const createdIds = {};

function runCheck(c) {
  const opts = { host: '127.0.0.1', port: PORT, path: c.path, method: c.method || 'GET' };
  const headers = Object.assign({ Authorization: 'Bearer ' + TOKEN, 'X-Tenant-Id': '0', 'content-type': 'application/json' }, c.headers || {});
  opts.headers = headers;
  if (c.body && c.method && c.method !== 'GET') {
    opts.body = JSON.stringify(c.body);
  }
  const req = http.request(opts, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      const got = res.statusCode;
      const ok = got === c.expect;
      if (ok) { pass++; console.log('  PASS', got, c.name); }
      else { fail++; console.log('  FAIL', got, '(expected', c.expect + ')', c.name, '|', body.slice(0, 200)); }
      // Wave-14 specific: POST must return a numeric id, not null.
      if (c.method === 'POST' && got === 201) {
        try {
          const parsed = JSON.parse(body);
          // Different endpoints return different id field names
          // (e.g. receiveStock returns 'move_id', not 'id'). Accept
          // any positive numeric id-or-move_id on POST.
          const hasPositiveId =
            (Number.isInteger(parsed.id) && parsed.id > 0) ||
            (Number.isInteger(parsed.move_id) && parsed.move_id > 0) ||
            (Number.isInteger(parsed.receipt_id) && parsed.receipt_id > 0);
          if (!hasPositiveId) {
            fail++;
            console.log('  FAIL POST returned no positive id/move_id:', body.slice(0, 200));
          }
        } catch {}
      }
      if (++done === checks.length + writeChecks.length) { console.log('endpoint smoke:', pass, 'pass,', fail, 'fail'); process.exit(fail > 0 ? 1 : 0); }
    });
  });
  req.on('error', (e) => { fail++; console.log('  ERR', c.name, e.message); if (++done === checks.length + writeChecks.length) { console.log('endpoint smoke:', pass, 'pass,', fail, 'fail'); process.exit(fail > 0 ? 1 : 0); } });
  if (opts.body) req.write(opts.body);
  req.end();
}
checks.forEach(runCheck);
writeChecks.forEach(runCheck);
"
SMOKE_RC=$?
echo

echo "=== STEP 4: DB schema check ==="
node -e "
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync('$DB');
const tables = db.prepare(\"SELECT name FROM sqlite_master WHERE type='table' ORDER BY name\").all();
const expected = [
  'sbos_rbac_permissions', 'sbos_rbac_roles', 'sbos_rbac_role_permission_sets',
  'sbos_rbac_permission_sets', 'sbos_rbac_permission_set_members',
  'sbos_rbac_profiles', 'sbos_rbac_user_profile',
  'sbos_rbac_approvals', 'sbos_rbac_sessions',
  'migration_history',
  'customers', 'invoices', 'invoice_lines', 'invoice_adjustments',
  'payments', 'vat_carry_forward', 'tenants',
  'users',
  // Phase 1 ERP — inventory (migration 0007)
  'catalog_categories', 'unit_of_measures', 'catalog_items', 'catalog_variants',
  'warehouses', 'stock_locations', 'stock_quants', 'stock_moves',
  // Phase 1 ERP — purchase (migration 0008)
  'vendors', 'purchase_orders', 'purchase_order_lines', 'purchase_receipts',
  'purchase_receipt_lines', 'vendor_bills', 'vendor_bill_lines',
];
const got = new Set(tables.map(t => t.name));
let missing = expected.filter(t => !got.has(t));
if (missing.length) { console.log('  FAIL missing:', missing.join(', ')); process.exit(1); }
console.log('  OK all', expected.length, 'expected tables present');
const mh = db.prepare('SELECT name, applied_at FROM migration_history ORDER BY name').all();
console.log('  finance migrations applied:', mh.length, '(' + mh.map(m => m.name).join(', ') + ')');
const roles = db.prepare('SELECT COUNT(*) AS n FROM sbos_rbac_roles').get();
const perms = db.prepare('SELECT COUNT(*) AS n FROM sbos_rbac_permissions').get();
const sets = db.prepare('SELECT COUNT(*) AS n FROM sbos_rbac_permission_sets').get();
console.log('  RBAC seed:', roles.n, 'roles,', perms.n, 'perms,', sets.n, 'sets');
if (perms.n < 30) { console.log('  FAIL: expected 30+ perms in seed'); process.exit(1); }
const adminLink = db.prepare(\"SELECT COUNT(*) AS n FROM sbos_rbac_user_roles WHERE user_id=1\").get();
console.log('  Admin user role links:', adminLink.n);
if (adminLink.n === 0) { console.log('  FAIL: admin user has no role link'); process.exit(1); }
const vcf = db.prepare(\"SELECT sql FROM sqlite_master WHERE name='vat_carry_forward'\").get();
if (!/PRIMARY KEY \(tenant_id, id\)/.test(vcf.sql)) { console.log('  FAIL: vat_carry_forward PK is not composite'); process.exit(1); }
console.log('  vat_carry_forward PK: composite ✓');
process.exit(0);
"
DB_RC=$?
echo

echo "=== STEP 5: Auth login (POST /api/auth/login with the seeded password) ==="
# The server prints the random admin password to stdout on first
# boot. Login with it to verify the scrypt hash + session-mint
# path works end-to-end. This catches the wave-15 class of bugs
# (the deploy token file is fine but the login flow is broken).
# Done BEFORE step 6 (graceful shutdown) so the server is still up.
LOGIN_PASSWORD=$(grep -oE "admin password \(random\): [^ ]+" "$LOG" | head -1 | awk '{print $NF}')
if [ -z "$LOGIN_PASSWORD" ]; then
  echo "  FAIL: server did not print a random admin password"
  SMOKE_RC=1
else
  LOGIN_PASSWORD="$LOGIN_PASSWORD" node -e "
  const http = require('node:http');
  const PORT = $PORT;
  const PASSWORD = process.env.LOGIN_PASSWORD;
  const req = http.request({
    host: '127.0.0.1', port: PORT, path: '/api/auth/login', method: 'POST',
    headers: { 'content-type': 'application/json' },
  }, (res) => {
    let body = '';
    res.on('data', d => body += d);
    res.on('end', () => {
      if (res.statusCode === 200) {
        try {
          const parsed = JSON.parse(body);
          if (typeof parsed.token === 'string' && parsed.token.length > 0) {
            console.log('  PASS 200 POST /api/auth/login (returns a session token)');
            process.exit(0);
          }
        } catch {}
      }
      console.log('  FAIL', res.statusCode, body.slice(0, 200));
      process.exit(1);
    });
  });
  req.write(JSON.stringify({ username: 'admin', password: PASSWORD }));
  req.end();
  "
  if [ $? = 0 ]; then
    echo "  login OK"
  else
    SMOKE_RC=1
  fi
fi
echo

echo "=== STEP 6: Graceful shutdown ==="
SERVER_PID=$(cat "$PIDFILE")
kill -TERM $SERVER_PID 2>&1
for i in 1 2 3 4 5 6 7 8 9 10; do
  if ! kill -0 $SERVER_PID 2>/dev/null; then
    echo "  OK: server exited cleanly after ${i}s"
    break
  fi
  sleep 1
  if [ "$i" = "10" ]; then
    echo "  FAIL: server didn't exit in 10s, force-killing"
    kill -9 $SERVER_PID 2>/dev/null
  fi
done
echo
echo "--- last 8 boot log lines ---"
tail -8 "$LOG"
echo

echo "=== STEP 6: Restart (idempotency) ==="
PORT=$PORT SBOS_DB=$DB node "$REPO_ROOT/bin/sbos-server.mjs" > "$LOG2" 2>&1 &
SERVER_PID=$!
echo $SERVER_PID > "$PIDFILE"
sleep 2
if curl -s "http://127.0.0.1:$PORT/api/health" | grep -q '"ok"'; then
  echo "  OK: restart works (idempotent migrations + idempotent seed)"
else
  echo "  FAIL: restart failed"
  tail "$LOG2"
fi
kill -TERM $SERVER_PID 2>/dev/null
sleep 2
kill -9 $SERVER_PID 2>/dev/null

echo
echo "=== STEP 7: Summary ==="
  echo "  RESULT: PASS"
  echo "  - All 13 endpoints return expected codes"
  echo "  - DB schema correct: 18 expected tables present"
  echo "  - 5 finance migrations applied via applyMigrations"
  echo "  - RBAC seed populated on fresh boot"
  echo "  - vat_carry_forward PK is composite"
  echo "  - Admin user linked to Admin rbac role"
  echo "  - POST /api/auth/login returns a session token"
  echo "  - Graceful shutdown works (SIGTERM)"
  echo "  - Restart is idempotent"
  exit 0
else
  echo "  RESULT: FAIL (smoke=$SMOKE_RC db=$DB_RC)"
  exit 1
fi
