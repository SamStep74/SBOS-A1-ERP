# Wave 3 Summary — SBOS-A1-ERP

**Date:** <TBD — fill at close>
**Branch:** `<TBD — branches + final commit>`
**Final commit:** `<TBD — last commit SHA on the integration branch>`

> **Status:** TEMPLATE. This file is committed at the start of wave 3 as a
> planning artifact. The integrator fills in the `<TBD>` placeholders after
> the three workers land and the integration commit hits main. The structure
> mirrors `docs/WAVE-1-SUMMARY.md` so the closeout is reviewable in the
> same shape.

---

## What landed

Wave 3 hardens the live SBOS-A1-ERP platform along three orthogonal axes:

- **l10n-audit-hardening** — the wave-2 audit scanner gains three new check
  families (hardcoded tax rates, `eval`/`new Function`, string-concat SQL)
  with three new CLI flags (`--check-rates`, `--check-eval`, `--check-sql`).
  Operators can now run a single `audit-cli` invocation to catch the three
  most common regulatory-footgun patterns in `server/l10n-am/`.
- **rbac-fastify-coverage** — fills the remaining `server/rbac/` test gaps:
  impersonation policy branches, FLS edge cases (nested redaction,
  empty-`redactFields` graceful skip), and role-hierarchy cross-cuts (Owner
  implicit-all via catalog fallback, Admin inheritance from Owner).
- **docs-walkthrough** — ships the `docs/sales/WALKTHROUGH.md` that
  `README.md` §3 has been promising since wave 0. A 30-minute operator
  script, paired with a `CONSOLE.md` showing the expected screen output.
  Closes the prospect-facing surface gap.

The three workers operate on disjoint file groups (no overlap), and the
project is already ESM-stabilized since wave 1, so no post-merge
integration fix is expected.

### Workers + deliverables

| Worker                | Path                                                                          | Surface                           | Commit  |
| --------------------- | ----------------------------------------------------------------------------- | --------------------------------- | ------- |
| l10n-audit-hardening  | `server/l10n-am/audit.js` + `audit-cli.js`                                    | 3 new functions + 3 new CLI flags | `<TBD>` |
| rbac-fastify-coverage | `server/rbac/rbac.test.js` (+ tiny `guards.js` / `routes.js` fixes if needed) | 10+ new tests, ≥80% coverage      | `<TBD>` |
| docs-walkthrough      | `docs/sales/WALKTHROUGH.md` + `CONSOLE.md`                                    | 2 new files, brand-stripped       | `<TBD>` |

### Wave 3 commit graph (chronological)

```
<TBD>  feat(l10n-am): audit scanner hardening (rates, eval, sql)
<TBD>  test(rbac): cover impersonation + FLS + role-hierarchy edge cases
<TBD>  docs(sales): operator walkthrough + console narrative
<TBD>  merge: wave 3 — l10n-audit-hardening
<TBD>  merge: wave 3 — rbac-fastify-coverage
<TBD>  merge: wave 3 — docs-walkthrough
```

(Final integration commit on main: `<TBD>`.)

### Source SHA1s (provenance)

Each ported file preserves the upstream SHA1 in its `// ported from <sha>`
provenance header, written by the dmux-workflow worker at port time. The
SHA1s are the authoritative reference if any dispute arises about which
upstream byte was carried over. Wave 3 mostly extends existing files; the
only new file is `docs/sales/WALKTHROUGH.md` (no upstream source) and
`docs/sales/CONSOLE.md` (no upstream source). The audit scanner changes
inherit the wave-2 `d10b9ef` provenance.

---

## Final state

- **Test files:** `<TBD>` (l10n-am 214 + rbac 55 + the 10+ new rbac tests + 12+ new audit tests + sanity 4)
- **Total test count:** `<TBD>` (target: 460+)
- **Coverage:**
  - `server/l10n-am/audit.js`: ≥80% statements (target: maintain ~95%)
  - `server/l10n-am/audit-cli.js`: ≥80% statements
  - `server/rbac/`: ≥80% statements (target: lift from ~93% to 95%+)
- **Brand-strip:** zero matches for `armosphera|hayhashvapah|samvel|a1-erp-hy`
  in code or new docs. Stable URN `EINVOICE_NAMESPACE = 'urn:hayhashvapah:einvoice:1'`
  preserved verbatim (wave-1 rule still in force).

## Hardening contract (unchanged from wave 1)

```
- `eval(` and `new Function(` are banned in `server/`.
- String-concat SQL (`SELECT.*+`, `INSERT.*+`, `UPDATE.*+`, `DELETE.*+`)
  is banned in `server/`.
- Hardcoded secrets are banned; use env vars validated at process start.
- Brand-strip scrubs `armosphera|hayhashvapah|samvel|a1-erp-hy` from
  code; doc files (README, INTEGRATION, this WAVE-3-SUMMARY) are exempt
  but must reference upstream sources by path, not by name.
```

Wave 3's new `audit-cli --check-eval` and `--check-sql` flags are the
machine-readable version of the first two rules; the integrator should
run them as a CI step after wave 3 merges.

---

## Verification

```bash
# Full SBOS-A1-ERP suite
npm test --silent

# Targeted
npm test --silent -- server/l10n-am/audit.test.js
npm test --silent -- server/l10n-am/audit-cli.test.js
npm test --silent -- server/rbac/rbac.test.js

# Coverage
npx c8 --reporter=text-summary --include='server/l10n-am/audit*.js' node --test server/l10n-am/audit*.test.js
npx c8 --reporter=text-summary --include='server/rbac/**/*.js' node --test server/rbac/rbac.test.js

# Hardening greps
git grep -nE 'eval\(|new Function\(' server/
git grep -nE 'SELECT.*\+|INSERT.*\+|UPDATE.*\+|DELETE.*\+' server/
git grep -nE 'armosphera|hayhashvapah|samvel|a1-erp-hy' server/

# Audit CLI on the live repo
node server/l10n-am/audit-cli.js --quiet
node server/l10n-am/audit-cli.js --check-rates
node server/l10n-am/audit-cli.js --check-eval
node server/l10n-am/audit-cli.js --check-sql
```

Expected:

- `npm test` shows `<TBD>` passed, 0 failed.
- `audit.js` and `audit-cli.js` coverage ≥80%.
- All four hardening greps return zero matches (the audit-cli output is
  the human-readable counterpart).
- `audit-cli --check-rates` and `--check-eval` and `--check-sql` exit 0
  on the current repo (clean) and exit non-zero on a sample tampered dir
  (e.g. one with an `eval(` injected).

---

## What did NOT land in wave 3

- **The stamp duty module** is part of `plan30/orch-foundation-2-stamp-duty`
  (the orchestrator-foundation branch), not wave 3. It is excluded from
  this plan to keep the three workers' file groups disjoint.
- **The orchestrator-foundation branch's own merge** — the wave 3 plan
  lives on `main` (per `baseRef: "main"`); the orchestrator-foundation
  work is tracked separately. The integrator decides whether to merge
  `plan30/orch-foundation-2` into main before or after wave 3 ships.
- **Catalog drift detection across the new l10n-am audit checks** —
  wave 3's three new audit flags are file-level regex scanners, not
  AST-based. A future wave can lift them to AST-based via a real parser
  if the regex false-positive rate becomes a problem.

## Open questions (carry into wave 4)

- **CRM and Finance modules** — `docs/PROJECT_STATUS.md` lists them as
  the next pipeline entries after l10n-am. Wave 4 candidates include a
  Customer schema (mirroring A1-ERP-HY's `crm/customers.js`), a Quote
  engine, and an Invoice generator. None of these are in wave 3 scope.
- **Reporting layer** — the project README references "Reports" as a
  future domain (Phase 6+ per the ERP comparison plan). Wave 4 or
  later can lift the audit scanner's output into a reporting surface
  (a `node audit-cli --format json` consumer).
- **A1-ERP-HY mirror cadence** — the wave-0 `seed-from-a1-erp-hy`
  worker mirrored docs once. Wave 3 doesn't re-mirror. A future wave
  should re-mirror with provenance after the A1-ERP-HY repo ships new
  fiscal-year changes (e.g. the 2027 RA tax code revisions).
