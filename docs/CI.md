# CI

This repo uses a single GitHub Actions workflow (`.github/workflows/ci.yml`)
that runs on every push to `main` / `master` and on every pull request
targeting those branches. The workflow is intentionally simple: one job
on a single Node 20 matrix cell, with a small chain of well-named steps
that mirror the local `npm run <script>` experience.

## What the workflow runs (and why)

| Step                          | Local command                       | Why it's in CI                                                                                              |
| ----------------------------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| **Lint**                      | `npm run lint`                      | ESLint 9 with `typescript-eslint` strict-type-checked. Catches dead imports, `no-undef` (e.g. `fetch`), and style regressions before they reach review. |
| **Lint check (new only)**     | `npm run lint:check-new`            | Baseline-aware lint: compares the current tree's lint output against `.lint-baseline.json` and fails ONLY on violations not already in the baseline. Lets `npm run lint` stay the canonical "clean tree" gate while giving the orchestrator a way to gate PRs against pre-existing drift across multi-worker integrations. See [Lint baseline mechanism](#lint-baseline-mechanism) below. |
| **Typecheck**                 | `npm run typecheck`                 | Runs `tsc --noEmit` if any `.ts` source exists; otherwise the wrapper script (`scripts/typecheck-if-typescript.mjs`) prints a one-line "no TS source, skipping" message and exits 0. The repo is currently JS-only; the stub stays so the moment a `.ts` file lands, the gate activates automatically. |
| **Format check**              | `npm run format`                    | `prettier --check .` on the whole tree. Drift in `*.test.{js,ts}` is pre-existing (see [Open issues](#open-issues)); the step is `continue-on-error: true` so production-code drift still fails the run, but a test-only cosmetic mismatch is non-blocking. |
| **Open-core boundary check**  | `npm run boundary-check`            | The single most important guardrail. See [The open-core boundary contract](#the-open-core-boundary-contract) below. |
| **Test**                      | `npm test`                          | `node --test` across the whole repo, 4-way concurrency, 60s per-test timeout. 776 tests at the time of writing. |
| **l10n-am audit (CLI)**       | `node server/l10n-am/audit-cli.js --quiet` | Static audit of the l10n-am catalog: missing-key detection, hardcoded Armenian strings, parity vs. the i18n catalog. |
| **All-in-one check**          | `npm run check`                     | Chains `lint && typecheck && test && boundary-check` exactly as a developer would run it locally. Catches ordering / shell-only bugs that the per-step view hides. |

## Lint baseline mechanism

When a multi-worker integration merges branches that were each clean in
isolation, the merged tree often surfaces lint warnings from workers
that haven't yet swept their code (unused imports, `console.log` in
boot scripts, etc.). A strict `npm run lint` on the merged tree fails
red, even though no single PR introduced the failures.

The baseline mechanism captures the *current* set of lint findings
into a checked-in file, `.lint-baseline.json`, and lets
`npm run lint:check-new` fail only on violations NOT already in the
baseline:

```bash
# 1. Capture the current lint state. Run this on the integrated
#    tree after a merge wave is complete, then commit the result.
npm run lint:baseline         # writes .lint-baseline.json

# 2. In a follow-up PR (e.g. a worker that's still cleaning up), the
#    baseline-aware gate runs in CI and fails ONLY if the PR
#    introduces NEW violations.
npm run lint:check-new        # exits 1 only on new violations

# 3. Dry-run reports the delta without exiting non-zero — useful for
#    the smoke tests under test/ci-scripts.test.mjs and for
#    "how bad is this PR?" reports.
node scripts/lint-baseline.mjs check --dry-run
```

The baseline is a sorted JSON array of `(filePath, ruleId, line,
column)` tuples. We intentionally drop the message text so the
baseline survives message-text reflows. A "new violation" is one
where the tuple is not in the baseline — severity is baseline-recorded
too so a future `--max-warnings 0` policy is a one-line update, not a
baseline re-capture.

**When to refresh the baseline:** after a wave of pre-existing-drift
cleanup PRs land and `npm run lint` is green on the integrated tree.
Treat the baseline as a moving target, not a permanent contract.

**What the baseline is NOT:** the baseline does NOT silence
`scripts/check-open-core-boundary-contract.mjs` or `npm test`. The
boundary check has its own allowlist (intentional, tiny, and
documented), and the test runner is unrelated to lint. If you want a
test-tree lint suppression, edit `eslint.config.js` (see the test
override block) — don't add it to the baseline.

## The open-core boundary contract

This repo (`SBOS-A1-ERP`) is the **public-facing open-core** target of
the A1 ecosystem. The companion repo `A1-ERP-HY` is the private R&D and
hardening ground: it contains tenant-specific keys, brand identifiers
(`armosphera`, `hayhashvapah`, `samvel`), and operational hardening that
must never leak into the public release. The contract — see
[`docs/SBOS_VS_A1_ERP_HY.md`](SBOS_VS_A1_ERP_HY.md) for the full
rationale — is enforced by `scripts/check-open-core-boundary-contract.mjs`:

1. The README must declare the public, open-core distribution and the
   de-privatized, brand-neutral landing zone, and must link to
   `docs/SBOS_VS_A1_ERP_HY.md` and `check-open-core-boundary-contract.mjs`.
2. The boundary doc must describe the private R&D source repo, the
   public-facing open-core target, the secret-scrubbing rule, the
   vendor-name normalization rule, the ban on brand identifiers in
   shipped source, and the deploy-time branding requirement.
3. `package.json` must keep `name = "sbos-a1-erp"` and `private = true`
   until the license and release gate are explicit.
4. `.gitignore` must ignore `.env` and `.env.*`, must allow
   `.env.example`, and must ignore local Karpathy eval results.
5. No tracked `.env` files (any name other than `.env.example`).
6. The brand-identifier regex `(?:armosphera|hayhashvapah|samvel)` must
   not appear in any file under `server/`, `scripts/`, `test/`,
   `package.json`, `tsconfig.json`, `eslint.config.js`, `AGENTS.md`,
   or `.github/workflows/`. The one stable exception is the wire-format
   e-invoice namespace constant
   `const EINVOICE_NAMESPACE = 'urn:hayhashvapah:einvoice:1';` in
   `server/l10n-am/einvoice/einvoice.js` — it is a SRC (Armenian tax
   authority) protocol identifier and must be preserved byte-for-byte.
7. No key-shaped secrets in tracked text files (GitHub tokens,
   `sk-…` keys, Google `AIza…` keys, PEM private keys, bearer tokens).

To debug a leak, run `npm run boundary-check` locally and read the
single-line `open_core_boundary_error=…` output — it points at the
file and line. The fix is to either remove the literal and import the
canonical constant (the `EINVOICE_NAMESPACE` re-export in
`server/finance/einvoiceExport.js` is the canonical pattern), or to
strip the brand from the test fixture / comment.

## How to debug a failed CI run locally

1. **Find the failing step** in the PR checks UI. The job name is the
   step name verbatim, e.g. `Lint` / `Typecheck` / `Format check` /
   `Open-core boundary check` / `Test` / `l10n-am audit (CLI)` /
   `All-in-one check (npm run check)`.
2. **Reproduce locally** with the exact command from the step:

   ```bash
   npm ci
   npm run lint                  # → Lint
   npm run lint:check-new        # → Lint check (new only)
   npm run typecheck             # → Typecheck
   npm run format                # → Format check
   npm run boundary-check        # → Open-core boundary check
   npm test                      # → Test
   node server/l10n-am/audit-cli.js --quiet   # → l10n-am audit
   npm run check                 # → All-in-one
   ```

3. **Iterate** with the fix-up variant (when one exists):

   ```bash
   npm run lint:fix              # eslint . --fix
   npm run format:fix            # prettier --write .
   npm run lint:baseline         # refresh .lint-baseline.json after a wave of cleanup
   ```

4. **For ESLint** the error message includes the file path and a rule
   id (e.g. `no-unused-vars`). If a particular test file is noisy
   because the suite imports a helper that isn't referenced in every
   test, look at `eslint.config.js` — the test-override block already
   disables `no-unused-vars` and `no-console` for the `test/` tree and
   the `*.test.{js,ts}` pattern. Add a similar block only if the
   pattern is widely shared; one-off suppressions should be
   file-local `// eslint-disable-next-line <rule>` comments.
5. **For the boundary check** the single-line output is meant to be
   diff-friendly in CI logs. If it points at a brand identifier, the
   fix is to import the canonical constant (e.g. `EINVOICE_NAMESPACE`)
   rather than embedding the literal. If it points at a missing doc
   paragraph, edit the relevant `requireMatch` target.
6. **For test failures** the `node --test` runner prints a TAP-style
   report with the suite / test name. Re-run a single file by passing
   it explicitly:

   ```bash
   node --test --test-concurrency=1 server/finance/dashboard.test.js
   ```

7. **Re-run the failing job** in the GitHub UI via
   *Re-run jobs → Re-run failed jobs*. Use this only after a local
   fix, not as a retry-on-flake — `node --test` is deterministic in
   this repo.

## How to add a new check

The workflow is intentionally a single `build-and-test` job with
linear steps, so adding a check is mechanical:

1. Add a new `scripts/<name>.mjs` (or `.sh`) that exits 0 on success
   and 1 on failure. Keep it self-contained: resolve the repo root
   from `import.meta.url`, print a one-line `…=0` / `…=1` summary so
   CI logs stay grep-friendly, and exit with the right code.
2. Wire it into `package.json` as a script, e.g. `npm run my-check`.
3. Add a step in `.github/workflows/ci.yml` *before* the
   `All-in-one check` step so it runs in the per-step view too.
4. If the check belongs in the canonical chain, add it to the
   `check` script in `package.json` in the same order it appears in
   the per-step view.
5. Add a row to the **What the workflow runs** table above with a
   one-sentence "why it's in CI" justification. Reviewers will read
   the doc more carefully than the YAML.
6. If the check has a `--dry-run` mode (e.g. a config validator that
   can lint the config without applying it), add a smoke test under
   `test/` that exercises the dry-run path. This repo's convention
   for boundary / wiring scripts is "they exit 0 on a clean repo" —
   that itself is a smoke test, and `npm run check` is the harness.
7. Update this doc. Always update this doc.

## Open issues

- **`*.test.{js,ts}` prettier drift** — 6 test files (under
  `server/finance/`, `server/l10n-am/i18n.test.js`, and
  `server/rbac/rbac.test.js`) carry pre-existing prettier drift. The
  `Format check` step is `continue-on-error: true` so a future
  production-code regression still fails the build, but the test
  drift is non-blocking until a follow-up PR runs `npm run format:fix`
  on the test tree. Tracked separately to keep the ci-hardening diff
  scoped to infrastructure (not test logic).
- **Node matrix is single-cell (Node 20)** — the repo's `engines`
  field pins `>= 20` and the test runner is Node-version-sensitive
  (native `node:sqlite`). Adding a second cell is a v1.1 follow-up.

## Hosted runner fallback (v0.7.0+)

**The problem.** As of 2026-06-21, the Armosphera GitHub org's
hosted-runner quota has been intermittently exhausted. CI jobs
queued on `ubuntu-latest` get stuck with
`Job is waiting for a hosted runner to come online` for ~2
seconds and then fail with empty steps. This is an org-level
infrastructure problem, not a code problem — local
`npm run check` and `npm run smoke:deploy` continue to pass
green on every commit.

**The fix.** The `runs-on` line in `.github/workflows/ci.yml`
is now a *list* of runner labels:

```yaml
runs-on: [self-hosted, sbos-self-hosted, linux, x64, ubuntu-latest]
```

GitHub Actions picks the first available match. When the
maintainer's self-hosted runner is registered with the
`sbos-self-hosted` label, jobs run there — sidestepping the
hosted-runner quota entirely. When no self-hosted runner is
registered (or it's offline), the workflow falls back to
`ubuntu-latest`, preserving the canonical CI signal but
re-exposing the org-level capacity risk.

**Maintainer runbook: register a self-hosted runner.**

```bash
# On a Linux box with Node 20.19.0 installed:

# 1. Grab a fresh runner token from
#    https://github.com/Armosphera/SBOS-A1-ERP/settings/actions/runners/new
#    (must have repo admin access). Use the "Add new runner" → Linux → x64
#    flow and copy the `./config.sh` token.

# 2. Download + extract the runner:
mkdir actions-runner && cd actions-runner
curl -o actions-runner-linux-x64-2.319.1.tar.gz -L \
  https://github.com/actions/runner/releases/download/v2.319.1/actions-runner-linux-x64-2.319.1.tar.gz
tar xzf ./actions-runner-linux-x64-2.319.1.tar.gz

# 3. Configure with the labels that match the workflow:
./config.sh --url https://github.com/Armosphera/SBOS-A1-ERP \
            --token <TOKEN_FROM_STEP_1> \
            --labels "sbos-self-hosted,self-hosted,linux,x64" \
            --unattended

# 4. Run once interactively to verify:
./run.sh   # should pick up a job within ~30s of a push

# 5. Install as a systemd unit for 24/7 availability:
sudo ./svc.sh install
sudo ./svc.sh start
sudo ./svc.sh status
```

**Why the labels match exactly.** GitHub's `runs-on` list
semantics is "match any". A runner registered with only
`self-hosted, linux, x64` would also match — but the
`sbos-self-hosted` label is the org-specific discriminator
that lets the runner pool be repurposed for other
Armosphera repos later (via a separate workflow that lists
`[self-hosted, armosphera-*, ubuntu-latest]`).

**What to do when CI is red.**

| Symptom | Cause | Fix |
|---|---|---|
| CI fails with empty steps after ~2s, "Job is waiting for a hosted runner to come online" | Hosted-runner quota exhausted | Self-hosted runner is offline — check `sudo ./svc.sh status` |
| CI fails with `Error: Cannot find module '...'` | Self-hosted runner has stale `node_modules` | `cd $REPO && npm ci` (the workflow runs `npm ci` so this should self-heal) |
| CI passes on `main` but fails on PR | The self-hosted runner only checked out the PR ref, not the upstream | Push a no-op commit to `main` to re-trigger the run with the latest `main` checkout |
| CI fails lint but local `npm run lint` passes | The runner has a different Node version | Confirm `node --version` on the runner is 20.19.0 (matches the matrix cell) |
