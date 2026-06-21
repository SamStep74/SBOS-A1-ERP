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

Wave 0 (bootstrap) is in progress — 4 workers run in parallel via the
`sbos-a1-erp-bootstrap` plan. See `.orchestration/sbos-a1-erp-bootstrap.json`
and `docs/PROJECT_STATUS.md` for the live state.

| Worker                | Scope                                                              | Status   |
| --------------------- | ------------------------------------------------------------------ | -------- |
| `repo-foundation`     | package.json, tsconfig, eslint, prettier, CI, sanity test          | starting |
| `seed-from-a1-erp-hy` | Mirror canonical docs (RBAC, DMUX, ERP-comparison, project status) | starting |
| `rbac-port`           | Port `server/rbac/*` from A1-ERP-HY with brand-strip + hardening   | starting |
| `dmux-docs`           | SBOS-A1-ERP-tuned DMUX_WORKFLOWS, PROJECT_STATUS, AGENT_BRIEF      | starting |

## How to run

```bash
nvm use                 # Node 20
npm install
npm test                # node --test
npm run lint
npm run format:check
```

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
