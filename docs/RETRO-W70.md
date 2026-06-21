# W70 Summary — K8s manifests + Phase 2 CRM wave 1

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

The W68 / W69 work shipped
the v0.1.0 deploy story +
status report. The remaining
work on this repo (per the
W69 status report §"What's
next" + "What's blocked") was:

- **Multi-host / K8s deploy
  story** (W70-1)
- **Phase 2+ module ports**
  (CRM, desk, projects,
  catalog v2) — W70-2
  covers CRM wave 1

Plan 70 ships both: the
K8s manifest set + the
first Phase 2 CRM wave.

## What shipped

### W70-1 — `k8s/` manifests (7 files)

The operator's K8s deploy
story. 7 manifests:

1. **`00-namespace.yaml`** —
   dedicated `sbos-a1-erp`
   namespace.
2. **`10-configmap.yaml`** —
   non-secret env vars
   (`NODE_ENV`, `PORT`,
   `HOST`, `SBOS_AUTH_MODE`,
   `SBOS_DB`,
   `SBOS_ADMIN_TOKEN_FILE`,
   `SBOS_LOCALE`).
3. **`20-secret.yaml`** —
   admin session token
   (optional; the server
   mints + persists to the
   PVC on first boot; the
   Secret is for backup-
   restore scenarios).
4. **`30-pvc.yaml`** — 10Gi
   ReadWriteOnce persistent
   volume.
5. **`40-deployment.yaml`** —
   3-replica Deployment with
   liveness + readiness probes
   hitting `/api/health`.
   Rolling update with
   `maxUnavailable: 0` +
   `maxSurge: 1` (zero
   downtime). Topology-spread
   across nodes. Hardened
   securityContext
   (`allowPrivilegeEscalation: false`,
   `runAsNonRoot: true`,
   `readOnlyRootFilesystem: true`,
   `capabilities drop ALL`).
6. **`50-service.yaml`** —
   ClusterIP Service routing
   to the pods' `http` port.
7. **`60-ingress.yaml`** —
   NGINX Ingress (TLS via
   cert-manager, commented out
   by default).

Plus **`k8s/README.md`** (350+
lines): operator runbook
covering quick start, manifest
inventory, env-var contract,
3 deploy paths (single cluster +
multi-cluster + RWX HA),
upgrade flow, backup CronJob
sample, pre-existing admin
token injection, 5-error
troubleshooting, production
checklist.

**Why these patterns:**

- 3 replicas + topology
  spread = HA across nodes.
- Shared PVC for the admin
  token = consistent auth
  across replicas.
- `/api/health` probe =
  matches the Dockerfile
  HEALTHCHECK.
- No Helm / Kustomize =
  single source of truth;
  `kubectl apply -f k8s/` is
  the simplest deploy story.

### W70-2 — Phase 2 CRM wave 1

The first Phase 2 module port.
3 files:

1. **`server/finance/migrations/0009_crm.sql`**
   — schema:
   - `finance.crm_contacts`:
     people at customer
     companies (name, email,
     phone, role, notes;
     optional `customer_id`
     FK to `finance.customers`).
   - `finance.crm_leads`:
     potential customers /
     sales pipeline (name,
     company, email, phone,
     source, status,
     `estimated_value_amd`,
     notes; status: new /
     qualified / proposal /
     won / lost).

2. **`server/finance/crm.js`**
   — pure functions:
   - `createContact(db, input,
     tenantId)` — INSERT,
     returns `{id}`.
   - `listContacts(db,
     tenantId)` — SELECT
     active (ordered by name).
   - `createLead(db, input,
     tenantId)` — INSERT,
     returns `{id}`.
   - `listLeads(db, tenantId,
     status?)` — SELECT
     (ordered by `id DESC`
     because SQLite's
     `datetime('now')` is
     second-precision; the
     auto-incrementing id is
     the actual creation
     order).
   - `ValueError` class export
     (matches the
     `customer.js` /
     `inventory.js` pattern).

3. **`server/finance/crm.test.js`**
   — 17 tests, all green:
   - `createContact`: insert,
     validate email/phone,
     require name, optional
     fields, FK to customer.
   - `listContacts`:
     tenant-scoped, ordered
     by name.
   - `createLead`: default
     status=new, accept all
     status values, reject
     invalid status, validate
     email/phone, require name.
   - `listLeads`:
     tenant-scoped, most
     recent first (by `id
     DESC`), filter by status.

**W70-2 closes the Phase 2
CRM wave 1.** Wave 2
(future): route wiring +
permission keys + smoke
check + audit log.

### W70-3 — push to `origin/main`

Pushed successfully at SHA
`2a49277`.

## Test baseline

- **1057 / 1057** tests pass
  (was 1013 before W70-2;
  the 17 new CRM tests +
  27 other tests that the
  remote added)
- **`npm run check`** clean
  (lint + typecheck + test +
  boundary-check)
- **`scripts/deploy-smoke.sh`**
  13 / 13 endpoints green
  (the smoke check itself is
  the regression net)

## Carry-forward

The SBOS-A1-ERP is now
**multi-host / K8s deploy-
ready** (W70-1) + has the
**Phase 2 CRM wave 1
shipped** (W70-2). The
remaining Phase 2 work:

- **Phase 2 CRM wave 2** —
  route wiring + permission
  keys + smoke check + audit
  log (the natural follow-up
  to W70-2).
- **Phase 2 desk wave 1** —
  ticketing / support (cases,
  replies, KB).
- **Phase 2 projects wave 1**
  — project management (tasks,
  time entries, milestones).
- **Phase 2 catalog v2** —
  categories, variants,
  bundles, pricing rules
  (the current catalog is
  minimal: SKU + name + UOM +
  unit cost).

**Open items** (follow-up
plans, not blocking):

- Production pg CI (the
  current CI uses sqlite;
  a parallel job should spin
  up pg and run the smoke
  against the pg adapter).
- Restore verification
  (cron restores are
  unverified).
- K8s multi-cluster pattern
  (the current K8s story is
  single-cluster; multi-
  cluster is a follow-up).

## Lessons learned

1. **K8s manifests as plain
   YAML are the simplest
   deploy story.** 7 files
   vs a Helm chart. The
   7-file set can be read
   end-to-end in 5 min; a
   Helm chart needs a `values.yaml`
   + `Chart.yaml` + the
   templates. The 7-file
   approach is right for
   single-env-per-cluster
   deploys; Helm shines when
   you have multiple envs
   (dev / staging / prod) and
   a templating layer saves
   duplication. Future
   multi-env needs would be
   the trigger to introduce
   Kustomize overlays (or
   Helm).

2. **The CRM wave 1 was
   small enough to ship in
   one slice.** 3 files,
   543 insertions, 17 tests.
   The full Phase 2 CRM port
   is ~3-4 waves (wave 1 =
   schema + pure functions;
   wave 2 = route wiring +
   perm + smoke; wave 3 =
   audit log integration;
   wave 4 = polish). The
   wave 1 was a clean
   minimum-viable: 2 tables
   + 4 pure functions + 17
   tests. The next wave can
   build on this without
   re-doing the schema.

3. **`id DESC` is the
   reliable order for
   recent-first in SQLite.**
   `created_at` is a string
   `datetime('now')` which is
   second-precision. Multiple
   inserts in the same second
   share the same `created_at`,
   and `ORDER BY created_at
   DESC` is then
   non-deterministic. The
   `id` column is the
   auto-incrementing
   primary key; it's unique
   + reflects insertion order.
   `ORDER BY id DESC` is the
   right pattern. The same
   pattern applies to any
   "recent first" query in
   a SQLite-backed system.

4. **The plan 70 design was
   right: 2 work slices, 1
   retro slice.** The user
   picked "1-2" candidates
   (option 1 = Phase 2+ ports;
   option 2 = multi-host / K8s
   deploy). I shipped both as
   2 work slices in one plan
   (W70-1 = option 2; W70-2 =
   option 1 first slice). The
   plan was 3 slices total,
   matching the recent
   pattern (W47-W69). The
   2-work-slice budget
   matches the user's "1-2"
   signal.
