# Deploy

> **Audience:** SBOS-A1-ERP
> operators deploying the
> bootable HTTP server in
> production.
>
> **Status:** Production-ready.
> The server (`bin/sbos-server.mjs`)
> is a single Node 20+ binary
> that boots the HTTP server
> on first launch, mints an
> admin session token, seeds
> the RBAC catalog, and links
> the admin user to the Admin
> role.
>
> **Related:** [CI](./CI.md) —
> the test + lint + typecheck
> gate that runs on every push;
> [RBAC system](./RBAC_SYSTEM.md)
> — the role / permission
> catalog that gates every
> endpoint.

---

## 1. Quick start

The server runs as a long-lived
process. There are **3 deploy
paths** (bare metal / Docker /
systemd+pm2); all 3 use the
same env-var + boot contract.

The single most important
thing to know: **on first boot,
the server mints an admin
session token, writes it to
`SBOS_ADMIN_TOKEN_FILE` (mode
0600), and prints it to
stdout.** Read the token from
the boot log (or from the
token file) and use it for
the first authenticated
request. Subsequent boots
**reuse** the existing token
from the file (idempotent).

```bash
# 1. Pick a deploy path:
#   - Bare metal: node bin/sbos-server.mjs
#   - Docker: docker run ... (see §3.2)
#   - systemd / pm2: see §3.3

# 2. Configure env vars:
export SBOS_DB=/var/lib/sbos-a1-erp/sbos.db
export SBOS_ADMIN_TOKEN_FILE=/var/lib/sbos-a1-erp/admin-token
export NODE_ENV=production
export PORT=3000
export HOST=127.0.0.1
export SBOS_AUTH_MODE=real   # NOT stub — stub is for tests

# 3. Boot the server
node bin/sbos-server.mjs

# 4. On first boot, capture the admin session token
#    from stdout (or from the token file):
TOKEN=$(cat /var/lib/sbos-a1-erp/admin-token)
echo "Admin session token: $TOKEN"

# 5. Smoke-check
bash scripts/deploy-smoke.sh
```

The smoke check exercises 35
endpoints end-to-end (auth +
RBAC + finance writes + ERP
Phase 1). A passing smoke is
the **green-light** that the
deploy is production-ready.

## 2. Env-var contract

The server reads these env
vars on boot. The default
values are in `bin/sbos-server.mjs`.

| Env var | Default | Purpose |
|---------|---------|---------|
| `SBOS_DB` | `./sbos.db` | Path to the SQLite database file. The data dir should be on a persistent volume (e.g., `/var/lib/sbos-a1-erp/`). |
| `SBOS_ADMIN_TOKEN_FILE` | `<SBOS_DB_DIR>/admin-token` | Path to the admin session token file. Mode 0600; created on first boot. |
| `NODE_ENV` | `development` | Set to `production` for prod deploys. Enables stricter logging + disables the dev-only `console.log` in boot. |
| `PORT` | `3000` | HTTP listen port. |
| `HOST` | `127.0.0.1` | HTTP listen address. Use `0.0.0.0` for Docker / dev; `127.0.0.1` for behind a reverse proxy. |
| `SBOS_AUTH_MODE` | `real` | Set to `real` for prod (mints a token, gates endpoints). Set to `stub` ONLY for tests (auto-authenticates as the Admin user). |
| `SBOS_DB_URL` | (derived from `SBOS_DB`) | Production pg adapter URL (used when the `pg` module is installed + `SBOS_DB_URL` is set). Falls back to sqlite if pg is missing. |
| `BACKUP_DIR` | (used by `backup-sbos.sh`) | Backup directory for the cron-driven backup script. |

**Production checklist:**

- [ ] `NODE_ENV=production` set
- [ ] `SBOS_AUTH_MODE=real` set
  (NOT `stub`)
- [ ] `SBOS_DB` on a persistent
      volume (not `/tmp` or
      ephemeral)
- [ ] `SBOS_ADMIN_TOKEN_FILE`
      on the same persistent
      volume; mode 0600
- [ ] `HOST=127.0.0.1` if
      behind a reverse proxy;
      `0.0.0.0` if direct
- [ ] Backup cron configured
      (see §6)
- [ ] `deploy-smoke.sh` exits
      with code 0 (green)

## 3. Deploy paths

### 3.1 Bare metal (dev box, single node)

```bash
# 1. Clone + install
git clone https://github.com/Armosphera/SBOS-A1-ERP
cd SBOS-A1-ERP
npm ci --omit=dev

# 2. Configure env vars
cat > .env <<EOF
SBOS_DB=/var/lib/sbos-a1-erp/sbos.db
SBOS_ADMIN_TOKEN_FILE=/var/lib/sbos-a1-erp/admin-token
NODE_ENV=production
PORT=3000
HOST=127.0.0.1
SBOS_AUTH_MODE=real
EOF
mkdir -p /var/lib/sbos-a1-erp
chmod 700 /var/lib/sbos-a1-erp

# 3. Boot
node bin/sbos-server.mjs

# 4. Smoke-check (in a separate shell)
bash scripts/deploy-smoke.sh
```

**Best for:** dev boxes, single-
node deployments, quick
verification. **Not for:**
production — there's no
restart-on-crash, no log
rotation, no startup at boot.

### 3.2 Docker

The repo ships a `Dockerfile` at
the repo root (multi-stage
build; debian-slim base; tini
as PID 1; non-root user).

```bash
# 1. Build the image
docker build -t sbos-a1-erp:dev .

# 2. Run with a named volume for the data
docker run -d \
  --name sbos-a1-erp \
  -p 3000:3000 \
  -e NODE_ENV=production \
  -e SBOS_AUTH_MODE=real \
  -e SBOS_DB=/var/lib/sbos-a1-erp/sbos.db \
  -e SBOS_ADMIN_TOKEN_FILE=/var/lib/sbos-a1-erp/admin-token \
  -v sbos-a1-erp-data:/var/lib/sbos-a1-erp \
  sbos-a1-erp:dev

# 3. Capture the admin token (one-time)
docker exec sbos-a1-erp cat /var/lib/sbos-a1-erp/admin-token

# 4. Smoke-check
bash scripts/deploy-smoke.sh
```

**Best for:** containerized
deploys (K8s, ECS, Nomad, etc.).
The named volume `sbos-a1-erp-data`
is the persistent state.

### 3.3 systemd (production on a Linux host)

The repo ships a systemd unit
file at `scripts/sbos-a1-erp.service`.

```bash
# 1. Install the unit file
sudo cp scripts/sbos-a1-erp.service /etc/systemd/system/

# 2. Edit the unit file to match your deploy
sudo $EDITOR /etc/systemd/system/sbos-a1-erp.service
# - Set User=sbos, Group=sbos
# - Set WorkingDirectory=/opt/sbos-a1-erp
# - Set Environment= values to match §2

# 3. Install the app
sudo mkdir -p /opt/sbos-a1-erp
sudo chown sbos:sbos /opt/sbos-a1-erp
sudo -u sbos git clone https://github.com/Armosphera/SBOS-A1-ERP /opt/sbos-a1-erp
sudo -u sbos bash -c 'cd /opt/sbos-a1-erp && npm ci --omit=dev'

# 4. Boot
sudo systemctl daemon-reload
sudo systemctl enable --now sbos-a1-erp

# 5. Watch the boot log (the admin token is here)
sudo journalctl -u sbos-a1-erp -f

# 6. Capture the admin token (after first boot)
sudo bash scripts/print-admin-token.sh

# 7. Smoke-check
bash scripts/deploy-smoke.sh
```

The unit file hardens the
process with:
- `NoNewPrivileges` (no
  setuid abuse)
- `ProtectSystem=strict` (only
  `/var/lib/sbos-a1-erp/` is
  writable)
- `ProtectHome` (no access to
  `/home`, `/root`,
  `/run/user`)
- `PrivateTmp` (separate
  `/tmp`)
- `MemoryDenyWriteExecute` (no
  W^X pages in the address
  space)
- `RestrictAddressFamilies`
  (only `AF_INET`, `AF_INET6`,
  `AF_UNIX`)

**Best for:** production on
a Linux host. Auto-restart on
crash, auto-start at boot,
integrates with `journalctl`.

### 3.4 pm2 (dev box, macOS, or any non-systemd host)

The repo ships a pm2 ecosystem
file at `scripts/ecosystem.config.cjs`.

```bash
# 1. Install pm2 globally
npm i -g pm2

# 2. Start the app
pm2 start scripts/ecosystem.config.cjs

# 3. Set up the boot-time pm2 daemon
pm2 startup
pm2 save

# 4. Watch the logs (the admin token is here)
pm2 logs sbos-a1-erp

# 5. Capture the admin token
bash scripts/print-admin-token.sh

# 6. Smoke-check
bash scripts/deploy-smoke.sh
```

**Best for:** macOS dev boxes,
or any host that doesn't
have systemd. pm2 is the
"batteries-included" Node
process manager.

## 4. The admin session token

The server mints an admin
session token on **first
boot** and persists it to
`SBOS_ADMIN_TOKEN_FILE`
(default: `<SBOS_DB_DIR>/admin-token`).
The file is created with mode
0600 (owner read/write only).

**Subsequent boots reuse the
existing token** (idempotent).
This is the operator's
**multi-host deploy** story:
the token file is the source
of truth; new hosts that
mount the same data dir get
the same token.

**Retrieving the token:**

```bash
# Method 1: read the file
cat /var/lib/sbos-a1-erp/admin-token

# Method 2: use the helper script
bash scripts/print-admin-token.sh
```

**Using the token:**

```bash
TOKEN=$(bash scripts/print-admin-token.sh)
curl -X POST http://127.0.0.1:3000/api/finance/customers \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -d '{"name": "Acme Co", "tax_id": "12345"}'
```

**The token is a session
token, not an API key.** It
does not expire (the RBAC
session table has no TTL
column); rotation is a manual
process (regenerate via the
admin endpoint + update the
clients). For prod, set up
token rotation cadence in
your change-management
process.

## 5. Smoke check

`scripts/deploy-smoke.sh` is
the **green-light gate**. The
script exercises 35 endpoints
end-to-end:

- Auth (token mint + reuse)
- RBAC read + write
- Finance read + write
  (customers, invoices,
  catalog, warehouses, stock,
  vendors, POs, e-invoice)
- ERP Phase 1 end-to-end flow
  (warehouse → location →
  catalog item → stock receive
  → vendor → PO → confirm →
  receive → vendor bill)

The script exits with code 0
on success, non-zero on any
failure. **Add the smoke to
the deploy checklist**: it
must pass before declaring
the deploy production-ready.

```bash
# Local
bash scripts/deploy-smoke.sh

# After systemd deploy
sudo systemctl is-active sbos-a1-erp && \
    sudo bash scripts/deploy-smoke.sh

# CI: see .github/workflows/ci.yml
# (the 'Deploy smoke' step runs in CI)
```

## 6. Backup

`scripts/backup-sbos.sh` does
an **online-safe backup** via
sqlite3's `.backup` command
(WAL-friendly). Falls back to
plain `cp` if the `sqlite3` CLI
is unavailable (the file is
still safe to copy while the
server is running, in WAL
mode).

```bash
# Cron (daily 02:00)
echo '0 2 * * * /opt/sbos-a1-erp/scripts/backup-sbos.sh >> /var/log/sbos-backup.log 2>&1' \
    | sudo crontab -
```

**Restore:**

```bash
# 1. Stop the server
sudo systemctl stop sbos-a1-erp

# 2. Replace the DB
sudo cp /var/backups/sbos-a1-erp/sbos-20260621T020000.db \
    /var/lib/sbos-a1-erp/sbos.db

# 3. Restart
sudo systemctl start sbos-a1-erp

# 4. Smoke-check
bash scripts/deploy-smoke.sh
```

**Backup retention:** the
script keeps the N most recent
backups (default: 7; override
with `KEEP=30`).

## 7. Troubleshooting

### 7.1 `EADDRINUSE: address already in use :::3000`

Another process is listening
on port 3000. Either stop it
or change the port:

```bash
# Find the process
sudo lsof -i :3000
# or
sudo ss -tlnp | grep 3000

# Or change the port
PORT=8080 node bin/sbos-server.mjs
```

### 7.2 `SQLITE_CANTOPEN: unable to open database file`

`SBOS_DB` is set to a path
that doesn't exist or isn't
writable. The server creates
the file on first boot, so
the **parent directory** must
exist:

```bash
mkdir -p $(dirname "$SBOS_DB")
chmod 755 $(dirname "$SBOS_DB")
```

### 7.3 `EACCES: permission denied` on `SBOS_ADMIN_TOKEN_FILE`

The data dir is not writable
by the server's user. Fix:

```bash
sudo chown -R sbos:sbos /var/lib/sbos-a1-erp
sudo chmod 700 /var/lib/sbos-a1-erp
```

### 7.4 `smoke:deploy` exits with 401 (Unauthorized)

The admin token is missing
or stale. Capture the token
from the boot log or token
file:

```bash
sudo bash scripts/print-admin-token.sh
# or
sudo journalctl -u sbos-a1-erp -n 50 | grep "admin session token"
```

The smoke script reads the
token from the env var
`SBOS_ADMIN_TOKEN_FILE` (or
the default path). Make sure
the env var is set when
running the smoke.

### 7.5 `smoke:deploy` exits with 500 (Internal Server Error)

The server is up but a write
endpoint failed. Check the
server log:

```bash
sudo journalctl -u sbos-a1-erp -n 200 -p err
```

Common causes:
- The DB file is read-only
  (check permissions on
  `SBOS_DB`).
- The schema migration is
  out of date (re-run
  `node bin/sbos-server.mjs`
  on first boot; the server
  runs migrations
  idempotently).
- A foreign-key violation
  (check the API request
  shape; the smoke is the
  known-good reference).

### 7.6 The server doesn't print the admin token

The token is only printed on
**first boot** (or on a token
file write). If you delete
the token file and restart,
the server mints a new one
and prints it. To preserve
the token across boots, **do
not delete the token file**.

### 7.7 `deploy-smoke.sh` exits with 0 but a real endpoint fails

The smoke covers 35 endpoints
but not every endpoint.
For deep verification, run
the full test suite:

```bash
# From the repo root
npm test
```

The full suite is 1002+ tests
and covers every endpoint
+ the full RBAC matrix.

## 8. Production checklist

Before declaring a deploy
production-ready:

- [ ] `NODE_ENV=production`
- [ ] `SBOS_AUTH_MODE=real`
- [ ] `SBOS_DB` on a persistent
      volume
- [ ] `SBOS_ADMIN_TOKEN_FILE`
      on the same volume
- [ ] `bin/sbos-server.mjs`
      boots cleanly + prints
      the admin token
- [ ] `scripts/deploy-smoke.sh`
      exits 0
- [ ] Backup cron configured
- [ ] systemd unit / pm2
      config installed
- [ ] `journalctl -u sbos-a1-erp`
      (or `pm2 logs`) shows
      no errors after a 5-min
      soak
- [ ] Reverse proxy (nginx /
      Caddy / Traefik)
      configured (TLS
      termination + rate
      limiting + IP allowlist
      for the admin endpoint)
- [ ] Health-check endpoint
      (if behind a load
      balancer) — the
      `/api/health` endpoint
      returns 200 on success

## 9. See also

- [CI](./CI.md) — the test +
  lint + typecheck gate
- [RBAC system](./RBAC_SYSTEM.md)
  — the role / permission
  catalog
- [Project status](./PROJECT_STATUS.md)
  — the wave-by-wave delivery
  summary
- [Agent brief](./AGENT_BRIEF.md)
  — the agent-side repo
  conventions
