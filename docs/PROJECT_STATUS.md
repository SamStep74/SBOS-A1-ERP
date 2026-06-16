# PROJECT_STATUS

> **Live state of SBOS-A1-ERP.** Wave 0 in progress, public open-core repo,
> A1-ERP-HY is the private R&D source of truth.

## Current state

Wave 0 (`sbos-a1-erp-bootstrap`) is in progress. Four bootstrap workers run
in parallel via `scripts/orchestrate-worktrees.js`:

| Worker | Scope | Plan ref |
|---|---|---|
| `repo-foundation` | package.json, tsconfig, eslint, prettier, CI, sanity test | `.orchestration/sbos-a1-erp-bootstrap.json` |
| `seed-from-a1-erp-hy` | Mirror canonical docs from A1-ERP-HY with provenance | same |
| `rbac-port` | Port `server/rbac/*` from A1-ERP-HY with brand-strip + hardening | same |
| `dmux-docs` | This doc, plus `DMUX_WORKFLOWS.md` and `AGENT_BRIEF.md` | same |

After wave 0 lands, the next wave typically ports `server/i18n/`,
`server/tax/armenia/`, and adds the first integration test. Plan filenames
follow `<scope>-<ordinal>.json` and live in `.orchestration/`.

## Architecture: two repos, one product

SBOS-A1-ERP (this repo) is the **public, open-core** distribution of the
Armosphera One Claude ERP. A1-ERP-HY (`~/dev/A1-ERP-HY`) is the **private
R&D repo** with 51+ hardening slices and 800+ tests.

| | A1-ERP-HY (private) | SBOS-A1-ERP (public) |
|---|---|---|
| Purpose | R&D, hardening, vendor integration | Public open-core |
| Brand | Armosphera + HayHashvapah identifiers | Brand-neutral |
| Tests | 800+ (full) | 55+ after wave 0, growing per wave |
| Domains | All 9 + i18n + Armenia tax | RBAC first; others port per wave |
| CI | Internal | GitHub Actions |
| License | Proprietary | TBD (open-core proposal) |

Code flows **A1-ERP-HY → SBOS-A1-ERP** via dmux-workflows waves. Workers
treat A1-ERP-HY as **read-only reference** and port with provenance (see
[`DMUX_WORKFLOWS.md` §7](./DMUX_WORKFLOWS.md#7-a1-erp-hy--sbos-a1-erp-worker-convention)).

## Module pipeline

Port order, fastest-feedback to slowest:

1. **RBAC** — domain-agnostic permissions catalog (300+ keys, 18 categories),
   role hierarchy, guards, schema. Source: `~/dev/A1-ERP-HY/server/rbac/`.
   Target: `server/rbac/`. Acceptance: 55+ tests, 4 hardening grep checks
   empty.
2. **i18n** — `en`, `hy-Am`, `ru` message catalogs + ICU MessageFormat
   helpers. Source: A1-ERP-HY `server/i18n/`. Target: `server/i18n/`.
3. **Armenia tax** — chart of accounts, VAT return form (SRC decree
   N 298-Ն), e-invoice XML (taxservice.am). Source: A1-ERP-HY
   `server/tax/armenia/` (`armeniaChartOfAccounts.js`, `vatReturn.js`,
   `einvoice.js`). Target: `server/tax/armenia/`.
4. **CRM** — Pipedrive-shaped data model with AI next-step suggestions.
   Source: A1-ERP-HY `server/crm/`. Target: `server/crm/`.
5. **Finance** — GL, AP/AR, journal entries, financial statements. Source:
   A1-ERP-HY `server/finance/`. Target: `server/finance/`.

Each port follows the wave 0 RBAC pattern: brand-strip, framework-agnostic
core + thin adapter, parameterized SQL, `git grep` acceptance checks.

## Open questions

These need a decision before the relevant wave starts. They are tracked
here so any new agent can pick one up.

| Question | Options | Default until decided |
|---|---|---|
| Package manager | `npm` vs `pnpm` | `npm` (Node default, no extra install step) |
| Runtime | Node 20 only vs Bun compat | Node 20 only (`engines.node: ">=20"`, `.nvmrc` = `20`) |
| CI provider | GitHub Actions vs other | GitHub Actions (`.github/workflows/ci.yml` from wave 0) |
| License | Open-core (proposed) vs custom | TBD — see `docs/SBOS_VS_A1_ERP_HY.md` once `seed-from-a1-erp-hy` lands |
| ORM / query layer | Drizzle vs Kysely vs raw `pg` | Raw `pg` with parameterized SQL (matches A1-ERP-HY) |
| HTTP framework | Express vs Fastify vs Hono | Express (matches A1-ERP-HY; RBAC adapter already wired) |
| Test runner | `node --test` vs Vitest | `node --test` (zero-dep, ships with Node 20) |

## Test gate

Per `~/.claude/rules/common/testing.md`:

- **Minimum 80% coverage** on every module that lands.
- **TDD workflow**: test first (RED) → minimal impl (GREEN) → refactor
  (IMPROVE).
- **Test types required**: unit, integration, E2E for critical flows.
- **Wave 0 RBAC port acceptance**: 55+ tests (45 from A1-ERP-HY + 10 new
  permission keys: `mfg.*`, `mrkt.*`, `compliance.*`, `ai.agent.*`,
  `tenant.*`).
- **Hardening grep checks** (must all return empty):
  - `git grep -nE 'armosphera|hayhashvapah|samvel|a1-erp-hy' server/rbac/`
  - `git grep -nE 'eval\(|new Function' server/rbac/`
  - `git grep -nE 'SELECT.*\+ |INSERT.*\+ |UPDATE.*\+ |DELETE.*\+ ' server/rbac/`

## How to run

```bash
# Pin Node (see .nvmrc — currently 20)
nvm use

# Install dev deps (no runtime libs yet at wave 0)
npm install

# Run the test suite
npm test              # node --test --test-concurrency=4 --test-timeout=60000

# Lint and format
npm run lint          # eslint .
npm run format:check  # prettier --check .
```

If `npm test` fails on a fresh clone, the most common cause is Node
version skew. `nvm use` from the repo root pins to whatever `.nvmrc` says.
The `--test-concurrency=4` and `--test-timeout=60000` flags in
`package.json` exist because bare `node --test` on a 16 GB Mac fills
swap and trips ENOSPC (see memory: `A1-Suite npm test fills disk`).

## Status legend

- `starting` — wave 0 worker pending
- `in-progress` — worker has committed to its branch
- `done` — worker handoff merged to main
- `blocked` — worker waiting on a human / external dependency

## Related docs

- [`DMUX_WORKFLOWS.md`](./DMUX_WORKFLOWS.md) — orchestration guide
- [`AGENT_BRIEF.md`](./AGENT_BRIEF.md) — one-page brief for new agents
- [`.orchestration/README.md`](../.orchestration/README.md) — plan.json schema
- [`.orchestration/sbos-a1-erp-bootstrap.json`](../.orchestration/sbos-a1-erp-bootstrap.json) — wave 0 plan
- [`../README.md`](../README.md) — repo landing page
