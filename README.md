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

| | A1-ERP-HY (private) | SBOS-A1-ERP (public) |
|---|---|---|
| **Purpose** | R&D, hardening, vendor integration | Public open-core distribution |
| **Brand** | Armosphera + HayHashvapah identifiers | Brand-neutral (rebrandable) |
| **Tests** | 800+ (full) | 55+ (RBAC port only) and growing |
| **Domains** | All 9 + i18n + Armenia tax | RBAC first; others port per wave |
| **CI** | Internal | GitHub Actions |
| **License** | Proprietary | TBD (open-core proposal) |

See `docs/SBOS_VS_A1_ERP_HY.md` for the full porting protocol.

## Current state

Wave 0 (bootstrap) is in progress — 4 workers run in parallel via the
`sbos-a1-erp-bootstrap` plan. See `.orchestration/sbos-a1-erp-bootstrap.json`
and `docs/PROJECT_STATUS.md` for the live state.

| Worker | Scope | Status |
|---|---|---|
| `repo-foundation` | package.json, tsconfig, eslint, prettier, CI, sanity test | starting |
| `seed-from-a1-erp-hy` | Mirror canonical docs (RBAC, DMUX, ERP-comparison, project status) | starting |
| `rbac-port` | Port `server/rbac/*` from A1-ERP-HY with brand-strip + hardening | starting |
| `dmux-docs` | SBOS-A1-ERP-tuned DMUX_WORKFLOWS, PROJECT_STATUS, AGENT_BRIEF | starting |

## How to run

```bash
nvm use                 # Node 20
npm install
npm test                # node --test
npm run lint
npm run format:check
```

## Karpathy Eval Harness

This repo exposes a narrow product-research contract for the public open-core
boundary:

```bash
npm run karpathy:list
npm run karpathy:program -- open-core-boundary-contract
npm run karpathy:run -- open-core-boundary-contract --best 0
node scripts/check-open-core-boundary-contract.mjs
```

The `open-core-boundary-contract` eval uses `failing_checks` as a minimize metric.
It keeps the editable surface limited to open-core boundary docs, ignore rules, and
the e-invoice namespace exception, while guarding against tracked env files,
key-shaped secrets, source-level brand leaks, and accidental removal of the stable
e-invoice protocol URN.

## How to orchestrate a new wave

```bash
# Dry-run: shows worktree + tmux pane plan, no side effects
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json \
  --dry-run

# Execute: create worktrees, write per-worker task/handoff/status files,
# launch one tmux pane per worker
node scripts/orchestrate-worktrees.js \
  .orchestration/sbos-a1-erp-bootstrap.json

# Just create worktrees and write files, no tmux
node scripts/orchestrate-worktrees.js \
  .orchestration/<next-wave>.json \
  --no-tmux
```

See `docs/DMUX_WORKFLOWS.md` for the full guide.

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
│   ├── orchestrate-worktrees.js    ← plan.json runner
│   ├── tmux-worktree-orchestrator.js  ← shared helper (worktree + tmux)
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
