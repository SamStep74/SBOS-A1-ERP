# AGENT_BRIEF

> **One-page brief for any new agent or human joining SBOS-A1-ERP.**
> Read this first. It links to the docs that have the rest.

## Goal

SBOS-A1-ERP is the **public, open-core** home of the Armosphera One Claude
ERP — a sovereign, self-hostable Armenian business OS with phased parity to
Zoho One. Code flows **A1-ERP-HY (private R&D) → SBOS-A1-ERP (public
distribution)** via dmux-workflows waves, after brand-strip and
de-privatization.

## Current wave

**Wave 0 (`sbos-a1-erp-bootstrap`)** is in progress. Four workers run in
parallel: `repo-foundation`, `seed-from-a1-erp-hy`, `rbac-port`, `dmux-docs`.
See [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) for the live state and
[`.orchestration/sbos-a1-erp-bootstrap.json`](../.orchestration/sbos-a1-erp-bootstrap.json)
for the plan.

## Where to read first

1. [`../README.md`](../README.md) — repo landing page, layout, relationship
   to A1-ERP-HY.
2. [`DMUX_WORKFLOWS.md`](./DMUX_WORKFLOWS.md) — orchestration pattern,
   plan.json schema, worker protocol, troubleshooting.
3. [`PROJECT_STATUS.md`](./PROJECT_STATUS.md) — current state, module
   pipeline, open questions, test gate.
4. [`.orchestration/README.md`](../.orchestration/README.md) — plan.json
   schema reference.
5. `AGENTS.md` (in repo root, written by the `repo-foundation` worker in
   wave 0) — TDD, 80% coverage, immutable data, conventional commits, no
   hardcoded secrets, prefer porting A1-ERP-HY over net-new invention.

## Conventions

- **TDD** — test first, then implementation. 80% coverage floor.
- **Immutable data** — no in-place mutation; spread, `Object.freeze`,
  `Readonly<T>`.
- **Conventional commits** — `feat:`, `fix:`, `refactor:`, `docs:`, `test:`,
  `chore:`, `perf:`, `ci:`. Scope allowed: `feat(rbac): ...`.
- **Node 20** — pinned in `.nvmrc`. `npm test` uses `node --test`.
- **A1-ERP-HY is read-only.** Port with provenance. Brand-strip every file.
  See [`DMUX_WORKFLOWS.md` §7](./DMUX_WORKFLOWS.md#7-a1-erp-hy--sbos-a1-erp-worker-convention).
- **Workers write to their worktree only.** Never edit files in the repo
  root, sibling worktrees, or another worker's `.orchestration/<session>/`
  directory.
- **Each worker writes `handoff.md` and ticks `status.md` on completion.**

## Who to ask

- **Orchestration / dmux / wave mechanics** — read
  [`DMUX_WORKFLOWS.md`](./DMUX_WORKFLOWS.md); if still unclear, ask the wave
  planner.
- **A1-ERP-HY source code** — it's a private repo at `~/dev/A1-ERP-HY`.
  Treat as read-only reference; cite provenance in every port.
- **Armenia tax / regulatory specifics** — see A1-ERP-HY's
  `armeniaChartOfAccounts.js`, `vatReturn.js`, `einvoice.js` (canonical
  implementations). Authoritative sources: arlis.am (acts 75961, 136996),
  taxservice.am e-invoice guide.
- **Open questions** (package manager, runtime, CI, license, ORM, HTTP
  framework, test runner) — see [`PROJECT_STATUS.md`](./PROJECT_STATUS.md)
  § Open questions. Each has a default until a decision is made.
