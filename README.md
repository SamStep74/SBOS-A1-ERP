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

Next: Phase 2 (lots / serials, replenishment reports, stock-valuation handoff
to GL, customer 360 + vendor 360 panels). See
`docs/ERP_COMPARISON_IMPLEMENTATION_PLAN.md`.

## How to run

```bash
nvm use                 # Node 20
npm install
npm test                # node --test
npm run lint
npm run format:check
```

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

## License

TBD (open-core proposal — see `docs/SBOS_VS_A1_ERP_HY.md`).

## Status legend

- starting: wave 0 worker pending
- in-progress: worker has committed to its branch
- done: worker handoff merged to main
- blocked: worker waiting on a human / external dependency
