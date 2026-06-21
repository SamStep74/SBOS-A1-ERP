# W68 Summary — `docs/DEPLOY.md` operator runbook

**Date:** 2026-06-21.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

The SBOS-A1-ERP ships a
production-grade bootable
HTTP server (`bin/sbos-server.mjs`)
+ a complete deploy story
(systemd unit, pm2
ecosystem, backup script,
smoke check, token helper)
but had **no single
operator-facing entry-point
doc** for the deploy.

Operators had to dig
through:
- `scripts/sbos-a1-erp.service`
  comments
- `scripts/ecosystem.config.cjs`
  comments
- `scripts/print-admin-token.sh`
  docstring
- `scripts/backup-sbos.sh`
  docstring
- `scripts/deploy-smoke.sh`
- `bin/sbos-server.mjs`
  comments
- commit messages

That's a lot of synthesis work
for a 5-minute deploy. The
operator's first question
("how do I deploy this?")
required 6+ file reads.

W68 closes the gap.

## What shipped

### W68-1 — `docs/DEPLOY.md` (570 lines)

The operator's single entry
point. Covers:

1. **Quick start** — 1 page
   from clone → smoke-green.
2. **Env-var contract** — 8
   vars with defaults +
   production checklist.
3. **3 deploy paths** — bare
   metal / Docker / systemd+pm2.
4. **Admin session token** —
   mint + persist + retrieve +
   use (curl example).
5. **Smoke check** — 35
   endpoints end-to-end,
   exit-code contract.
6. **Backup** — online-safe via
   sqlite3 `.backup`, cron +
   restore.
7. **Troubleshooting** — 7
   common errors with fixes
   (EADDRINUSE, SQLITE_CANTOPEN,
   EACCES on token file, 401 on
   smoke, 500 on smoke, no
   token printed, smoke-green
   but real endpoint fails).
8. **Production checklist** —
   10 items before declaring
   prod-ready (env vars, paths,
   systemd/pm2, smoke, backup,
   journal log, reverse proxy,
   health check, etc.).
9. **See also** — cross-
   references to `docs/CI.md`,
   `docs/RBAC_SYSTEM.md`,
   `docs/PROJECT_STATUS.md`,
   `docs/AGENT_BRIEF.md`.

### W68-2 — push to `origin/main`

`bb18eb5` is the SHA. Pushed
successfully.

## Why it matters

The operator's first question
("how do I deploy this?") now
has a one-page answer in
`docs/DEPLOY.md`. The
operator doesn't have to
synthesize 6+ files to figure
out the deploy story.

**Pattern alignment:** this
is the same pattern as the
SBOSS sovereign monorepo's
`docs/DEPLOY.md` (shipped in
plan 7). Both repos now
have an operator's single
entry point. The pattern
"operator-facing deploy
runbook" is reusable across
the Armosphera portfolio.

**Production readiness:** the
SBOS-A1-ERP is now
production-grade for a
single-node self-hosted
deploy. The 10-item
production checklist in
§8 of `docs/DEPLOY.md` is the
operator's green-light gate.

## Test baseline

- **1002 / 1002** tests pass
  (full suite, no regressions)
- **`npm run check`** clean
  (lint + typecheck + test +
  boundary-check)
- **`scripts/deploy-smoke.sh`**
  35 / 35 endpoints green
  (the smoke check itself is
  the regression net)

## Carry-forward

The SBOS-A1-ERP is now
production-grade for a
single-node self-hosted
deploy. The remaining work
on this repo is the
**Phase 2+ ERP modules**:
catalog (the rest of CRUD;
GET exists, no POST), CRM,
desk, projects — per the
"next module ports" list
from the recent wave-16
work.

**W68 work** is wrap-up
polish (operator docs); the
substantive code work was
the wave-16 / wave-17
deliveries (Phase 1 ERP +
PO/delivery-note template).

**Open items** (follow-up
plans, not blocking):

- Phase 2+ module ports
  (catalog POST, CRM, desk,
  projects)
- Multi-host / K8s deploy
  story (the current deploy
  is single-node only)
- Backup verification
  (cron restores are
  unverified)

## Lessons learned

1. **An operator-facing
   entry-point doc is the
   right home for deploy
   info.** Previously the
   deploy story was
   distributed across 6+
   files. After W68, it's
   all in one place. The
   "discoverability through
   central docs" pattern is
   reusable for any product
   that has a non-trivial
   deploy story.

2. **The "first question"
   test for docs.** A good
   doc answers the operator's
   first question on the
   first page. "How do I
   deploy this?" is the
   most common first question
   for any backend product.
   The DEPLOY.md's §1
   "Quick start" is the
   answer; the rest of the
   doc is detail for
   follow-up questions.

3. **The production checklist
   is the green-light gate.**
   §8 of DEPLOY.md has 10
   items. A deploy is
   production-ready only when
   all 10 are checked. This
   is the operator's contract
   for "I can ship this".

4. **The same pattern
   generalizes across
   repos.** The SBOSS
   sovereign monorepo's
   `docs/DEPLOY.md` (plan 7)
   and the SBOS-A1-ERP's
   `docs/DEPLOY.md` (W68)
   follow the same structure
   (Quick start → Env vars →
   Deploy paths → Token →
   Smoke → Backup →
   Troubleshooting →
   Production checklist).
   The pattern is reusable;
   future Armosphera
   products can use it as a
   template.
