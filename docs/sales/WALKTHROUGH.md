# Operator Walkthrough — 30 minutes with a prospect

> The script you read aloud when a buyer is in the room.
> 30 minutes total. Six beats. Every command is copy-paste-runnable.
>
> **Tone:** direct, evidence-first. You are not selling — you are
> pointing at the screen. The artefacts do the talking.

---

## Pre-call setup (2 minutes)

Your own checklist, not the prospect's. Do this before the call.

```bash
# Replace <upstream-org> with the GitHub org that hosts your fork.
git clone https://github.com/<upstream-org>/SBOS-A1-ERP.git
cd SBOS-A1-ERP
nvm use                 # Node 20 (pinned in .nvmrc)
npm install
npm test                # confirm green at the bottom of wave 3
```

If `npm test` shows anything other than `fail 0`, **stop** and resolve
before the call. A red demo is worse than no demo.

Open the project in your editor. Have a second terminal ready for the
demo commands. Mute your notifications.

---

## 1. Cold-start (5 minutes) — "here's the orchestration pattern"

**What to say:** *"Every wave of work on this codebase runs through one
plan file. Watch what it does in dry-run."*

```bash
node scripts/orchestrate-worktrees.cjs \
  .orchestration/sbos-a1-erp-l10n-am.json \
  --dry-run
```

The output is a JSON document describing the wave-1 worktree plan:
session name, per-worker worktree paths, per-worker tmux launch
commands, all marked `"dryRun": true`. The prospect sees the full
topology — five workers, five worktrees, five tmux panes — in one
terminal hit. See [`docs/sales/CONSOLE.md`](./CONSOLE.md) for the
exact bytes that hit the screen.

**Then say:** *"That was the dry-run. Here's what actually happened
when we executed it."*

Open [`docs/WAVE-1-SUMMARY.md`](../WAVE-1-SUMMARY.md) and scroll to
the commit graph. Point at the seven leaf branches that all merged
into main in a single wave. Frame it as: *"one plan JSON, seven
workers, zero integration bugs — because every worker wrote in its own
worktree, and the orchestrator handled the merge shape."*

---

## 2. RBAC tour (5 minutes) — "the foundation everything else builds on"

**What to say:** *"Before any feature ships, it has to pass through
the role-based access control layer. Here's the test suite that gates
it."*

```bash
node --test server/rbac/rbac.test.js
```

Expect ~190 tests covering catalog integrity, role hierarchy,
permission resolution, field-level security, record-level security,
sensitivity gating, impersonation policy, the Express adapter
middleware, and seed idempotency. Watch the `pass`/`fail` counter
at the bottom — every line of red is a feature the prospect can ask
about.

**Then say:** *"The tests prove the engine. The spec explains the
model."*

Open [`docs/RBAC_SYSTEM.md`](../RBAC_SYSTEM.md) and read the
15-section table of contents aloud (Goals & Non-Goals, Core
Concepts, Hierarchy Model, Permission Catalog, Permission Sets,
Roles, Sensitivity & MFA, Field-Level Security, Record-Level
Security, Session Policy & Impersonation, API Reference, Custom
Roles, Migration From Ad-Hoc Checks, Comparison With Industry
Systems, Operational Runbook). Frame it as: *"Salesforce-style
composition, with field-level redaction on top. Defense in depth,
not defense in checkboxes."*

---

## 3. l10n-am fiscal walk (10 minutes) — "Armenian tax law, implemented"

**What to say:** *"The hard part of any country-specific ERP is the
regulatory math. We don't fake it. Watch."*

```bash
node --test \
  server/l10n-am/armenia-phone.test.js \
  server/l10n-am/armenia-regions.test.js \
  server/l10n-am/armeniaPayroll.test.js \
  server/l10n-am/i18n.test.js \
  server/l10n-am/localization.test.js \
  server/l10n-am/parse-amd.test.js \
  server/l10n-am/parse-hvhh.test.js \
  server/l10n-am/stampDuty.test.js \
  server/l10n-am/audit.test.js \
  server/l10n-am/audit-cli.test.js \
  server/l10n-am/chartOfAccounts/*.test.js \
  server/l10n-am/einvoice/*.test.js \
  server/l10n-am/vatReturn/*.test.js
```

Expect 235 tests across 7 suites. The counter ticks fast; that is
the point — every test is a rule, every rule has a citation.

**Then say:** *"One concrete example. The VAT return — output 20%
on a 1,000,000 dram sale, input 20% recoverable on a 200,000 dram
purchase."*

```bash
node -e 'import("./server/l10n-am/vatReturn/vatReturn.js").then(m => {
  console.log(JSON.stringify(m.computeVatReturn({
    sales:     [{ netAmount: 1_000_000, vatRate: 20 }],
    purchases: [{ netAmount:   200_000, vatRate: 20, recoverable: true }],
  }), null, 2));
})'
```

You should see:

```json
{
  "outputVat": 200000,
  "inputVat": 40000,
  "taxableSales": 1000000,
  "taxablePurchases": 200000,
  "net": 160000,
  "payable": 160000,
  "creditCarried": 0
}
```

**Then say:** *"That number is not a mock. It's the output of a pure
function that maps onto Armenian SRC decree N 298-Ն, lines 7-23 —
the unified VAT and excise return. The full citation is in
[`server/l10n-am/vatReturn/vatReturn.js`](../../server/l10n-am/vatReturn/vatReturn.js).
The tests in `vat-return-rate-sanity.test.js` prove the math doesn't
drift if someone refactors it."*

If the prospect asks "what about refunds?" answer: *"Armenia does not
auto-refund — a negative net carries forward as a credit. That's the
law; the engine implements it."*

---

## 4. Audit scanner (5 minutes) — "the safety net"

**What to say:** *"Before any commit lands, an audit scanner walks
the codebase and flags the patterns that have bitten us before."*

```bash
node server/l10n-am/audit-cli.js --quiet
```

Expect a clean exit (exit code 0) and silent output — `--quiet`
suppresses the per-file OK lines. The scanner today validates the
i18n catalog (catalog balance, source `t()` key validity).

The wave-3 hardening commit (sibling branch
`l10n-audit-hardening`) adds three new flags:

```bash
node server/l10n-am/audit-cli.js --check-rates --check-eval --check-sql
```

After that merge, each finding prints as `file:line:col:
<value|kind|pattern>`. The scanner then catches hardcoded tax
rates, `eval(` and `new Function(` calls, and SQL string-concat
patterns anywhere under `server/`. Frame it as: *"this is the
equivalent of a pre-commit lint, but tuned for the failure modes we
actually see in fiscal code."*

If the flags aren't on `main` yet (the merge is racing this
walkthrough), pull `plan30/wave3-audit-hardening` or just point at
the `--quiet` invocation — the catalogue scanner alone is the
proof point.

---

## 5. Close (3 minutes) — "what landed and what's next"

**What to say:** *"Wave 3 — the wave you're looking at — shipped
three things:"*

1. The audit scanner hardening (`--check-rates`, `--check-eval`,
   `--check-sql`).
2. The RBAC coverage expansion (`rbac-fastify-coverage` worker —
   impersonation, FLS edge cases, role-hierarchy cross-cuts).
3. **This walkthrough.** The thing you just sat through.

**Then say:** *"The next waves in the pipeline:"*

- **CRM** — accounts, contacts, deals, activities. Phased parity
  to Zoho CRM, with the same RBAC enforcement pattern you just saw.
- **Finance** — general ledger on top of the chart of accounts
  (623 entries, 9 classes — already in the box), AP/AR, bank
  reconciliation, period close.
- **Reporting** — cross-module reports (VAT, payroll, sales
  pipeline), each one a pure function with a test, each one backed
  by the audit scanner.

Close with the line that matters: *"If you have a specific module
you want to see first, point at it. The wave plan JSON changes in
an hour, and your wave ships the next sprint."*

---

## Appendix — what to do when something breaks mid-demo

| Symptom | Fix |
|---|---|
| `npm install` fails on Apple Silicon | `nvm use && rm -rf node_modules && npm install` |
| `npm test` shows a red line | `node --test <that-file>` to isolate; consult `docs/PROJECT_STATUS.md` |
| `audit-cli` exits 1 | `node server/l10n-am/audit-cli.js --format json` for the structured report |
| Prospect asks a question you can't answer | *"That's a great question. Let me write it down and route it to the wave planner."* — then do exactly that, in front of them |

---

*This file ships in wave 3. Next revision when the CRM wave lands —
swap section 3 (l10n-am fiscal walk) for a CRM deal-pipeline walk.*