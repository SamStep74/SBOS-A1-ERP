# Console Narrative — what the operator sees on screen

> The exact bytes that hit the terminal during the walkthrough.
> One section per beat of [`WALKTHROUGH.md`](./WALKTHROUGH.md).
> Truncated to the first 5-10 lines so the operator knows what
> success looks like (and what failure looks like).

---

## 0. Pre-call setup

`npm install` should end with something like:

```
added 423 packages in 12s

42 packages are looking for funding
  run `npm fund` for details
```

`npm test` (the umbrella command) should end with:

```
ℹ tests 423
ℹ pass  423
ℹ fail  0
```

The exact `pass` count varies per wave. Anything other than `fail 0`
stops the demo.

---

## 1. Cold-start — `node scripts/orchestrate-worktrees.cjs ... --dry-run`

The output is a single JSON document. First few lines:

```json
{
  "sessionName": "sbos-a1-erp-l10n-am",
  "workers": [
    {
      "name": "l10n-kernel",
      "worktree": "/Users/.../sbos-a1-erp-l10n-am/.claude/worktrees/l10n-kernel",
      "files": "/Users/.../sbos-a1-erp-l10n-am/.orchestration/sbos-a1-erp-l10n-am/l10n-kernel",
      "tmux": "tmux new-window -t sbos-a1-erp-l10n-am -n l10n-kernel ...",
      "dryRun": true
    },
```

The full document lists every worker in the wave (l10n-kernel,
l10n-coa, l10n-vat, l10n-einv, l10n-payroll for the wave-1 plan).
Exit code 0. No side effects.

**Failure shape:** if the plan JSON is malformed or the script
errors, expect a JS stack trace on stderr and exit 1. Re-run after
fixing the plan file.

---

## 2. RBAC tour — `node --test server/rbac/rbac.test.js`

Hundreds of `✔ <test name> (<ms>ms)` lines stream past (use
`--test-reporter=spec` if not default). Last ten lines:

```
  ✔ seeds the expected number of rows (when sqlite is available) (0.055ms)
  ✔ is idempotent — re-running does not duplicate or error (0.037ms)
  ✔ readVersions returns the seeded versions (0.030ms)
✔ Seed installer (in-memory SQLite) (1.014ms)
ℹ tests 188
ℹ suites 21
ℹ pass 188
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 163
```

**Failure shape:** any `✖ <test name>` line in the body, or `fail > 0`
in the summary block. Stop the demo, isolate the failing file with
`node --test <file>`, consult `docs/PROJECT_STATUS.md`.

---

## 3. l10n-am fiscal walk — `node --test ...`

The umbrella command in section 3 of WALKTHROUGH.md fans out across
12 test files. Last ten lines:

```
  ✔ vat-return-form: line 22 (imports per Tax Code art. 79) is input base + VAT, independent of line 21 (0.053ms)
  ✔ vat-return-form: every line definition carries the same shape (section/labelHy/fields) (0.074ms)
ℹ tests 235
ℹ suites 7
ℹ pass 235
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 472
```

### 3a. VAT return — `node -e '...'`

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

**Failure shape:** if `netAmount`/`vatRate` are missing or zero, expect
`{ outputVat: 0, inputVat: 0, ... }` — that's the engine saying "no
input". Means the prospect typo'd, not a bug. Re-type the example.

---

## 4. Audit scanner — `node server/l10n-am/audit-cli.js --quiet`

Silent. Exit 0. The whole point of `--quiet` is "no news is good
news".

```bash
$ node server/l10n-am/audit-cli.js --quiet
$ echo $?
0
```

Without `--quiet`, expect a per-file scan progress block plus a
summary:

```
scanning server/l10n-am/ (12 files)...
✔ armeniaPhone.js
✔ armeniaRegions.js
✔ armeniaPayroll.js
✔ localization.js
✔ i18n.js
✔ audit.js
✔ audit-cli.js
... (rest of files)
ok: 12 files scanned, 0 issues
```

### 4a. Audit hardening (wave-3 sibling branch)

After the `l10n-audit-hardening` worker merges, the new flags
become available:

```bash
$ node server/l10n-am/audit-cli.js --check-rates --check-eval --check-sql
```

Clean exit produces no output. A finding prints as:

```
server/l10n-am/someModule.js:42:18: 0.20  const STANDARD_VAT_RATE = 0.20
server/l10n-am/legacy.js:88:5:  eval-call
```

**Failure shape:** exit 1 means at least one finding. Treat the
finding as a real defect to triage, not noise.

---

## 5. Close — no command, talking points only

The close is a 3-minute speech. There is nothing for the operator
to type. The talking points are in [`WALKTHROUGH.md` §5](./WALKTHROUGH.md#5-close-3-minutes--what-landed-and-whats-next).

The "expected output" for a verbal section is the operator's
speaking script. The block below is the literal words to say
during the close. Read it slowly. Pause after each beat.

```
[Beat 1 — the artefacts]   "The artefacts do the talking.
                              Three wave-3 deliverables just shipped:
                              audit scanner hardening, rbac coverage,
                              and this walkthrough."

[Beat 2 — the pipeline]     "The open pipeline is CRM, Finance,
                              and Reporting. The dmux-workflow pattern
                              is how each lands — three workers per
                              wave, disjoint file groups, one merge."

[Beat 3 — the posture]       "Open-core. No proprietary lock-in.
                              Brand-neutral. The sovereign stack
                              is yours to fork, audit, and ship."

[Beat 4 — the door]          "Thank you. I'll leave you with the
                              walkthrough and the console narrative.
                              Ping me if anything in there doesn't
                              hold up under your own hands-on test."
```

If the prospect asks to see the wave-3 plan JSON itself, point at
[`.orchestration/sbos-a1-erp-wave-3.json`](../../.orchestration/sbos-a1-erp-wave-3.json) — three workers,
three disjoint surfaces, one merge commit.

---

*This file ships alongside WALKTHROUGH.md in wave 3. Keep the
output samples in sync with reality — every block in this file was
captured from a real run on `main @ 77366a0` (or noted as
"post-merge" for sibling-branch output).*