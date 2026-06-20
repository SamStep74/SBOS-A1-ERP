# Wave 1 Summary — SBOS-A1-ERP

**Date:** 2026-06-16
**Branch:** `main`
**Final commit:** `191e9f0` — refactor(l10n-am): convert CJS (.cjs) to ESM (.js) for native module type

---

## What landed

Wave 1 ports the Armenian localization kernel + four fiscal modules from
the upstream A1 codebase into this package as a first-class ESM surface
under `server/l10n-am/`. The five leaf modules and the integration commit
form a single, reviewable atomic story.

### Modules ported

| Module             | Path                              | Source files | Tests   | Commit    |
| ------------------ | --------------------------------- | ------------ | ------- | --------- |
| l10n-kernel        | `server/l10n-am/` (root)          | 3 + 1 helper | 3 files | `f22eed0` |
| l10n-coa           | `server/l10n-am/chartOfAccounts/` | 1 + 1 data   | 1 file  | `d1d284e` |
| l10n-vat           | `server/l10n-am/vatReturn/`       | 1            | 4 files | `b63f806` |
| l10n-einv          | `server/l10n-am/einvoice/`        | 1            | 3 files | `c7abe7c` |
| l10n-payroll       | `server/l10n-am/` (root)          | 1            | 1 file  | `22239b0` |
| CJS→ESM conversion | `server/l10n-am/` (all 21 files)  | —            | —       | `191e9f0` |

### Wave 1 commit graph (chronological)

```
f22eed0  feat(l10n-am): port l10n kernel (localization, phone, regions)
d1d284e  feat(l10n-am): port Armenian chart of accounts (623 accounts, 9 classes)
31ea104  merge: l10n-kernel dependency (localization.cjs, armeniaPhone.cjs, armeniaRegions.cjs)
b63f806  feat(l10n-am): port VAT return engine + 4 tests (33/33 pass)
c2f4451  merge: l10n-kernel dependency
c7abe7c  feat(l10n-am): port e-invoice engine (preserve URN) + 3 tests (41/41 pass)
828ba64  merge: l10n-kernel dependency
901cc76  merge: l10n-kernel dependency
22239b0  feat(l10n-am): port payroll engine + 8 tests (8/8 pass)
5ef588d  merge: wave 1 — l10n-coa (Armenian chart of accounts, 623/9)
941da22  merge: wave 1 — l10n-vat (VAT return engine)
d1e4c47  merge: wave 1 — l10n-einv (e-invoice engine + URN preserve)
7e19e6a  merge: wave 1 — l10n-payroll (Armenian payroll engine)
191e9f0  refactor(l10n-am): convert CJS (.cjs) to ESM (.js) for native module type
```

### Source SHA1s (provenance)

Each ported file preserves the upstream SHA1 in its `// ported from <sha>`
provenance header, written by the dmux-workflow worker at port time. The
SHA1s are the authoritative reference if any dispute arises about which
upstream byte was carried over.

---

## Final state

- **Source files:** 7 modules, all native ESM (`import`/`export`).
- **Test files:** 13 (one per test concern), **119/119 pass**.
- **Stable URN preserved:** `EINVOICE_NAMESPACE = 'urn:hayhashvapah:einvoice:1'`
  in `server/l10n-am/einvoice/einvoice.js:20`. This is a wire-format
  identifier exchanged with the SRC e-invoice gateway, **not** a brand
  leak, and must not change under any brand-strip rule.
- **Armenian UTF-8 preserved:** `armeniaRegions.js` (marze names), the
  623-entry chart of accounts (`armeniaChartOfAccounts.data.js`), and
  payroll test labels round-tripped byte-for-byte through the conversion
  (in-process via Node `fs`, not the file-write tool, to avoid non-ASCII
  corruption).

## CJS→ESM conversion rules applied (commit `191e9f0`)

```
const { x, y } = require("./foo.cjs")       ->  import { x, y } from "./foo.js"
const { x, y } = require("../foo.cjs")      ->  import { x, y } from "../foo.js"
const ns       = require("./data.cjs")      ->  import ns from "./data.js"
const test     = require("node:test")       ->  import test from "node:test"
const assert   = require("node:assert/strict") -> import assert from "node:assert/strict"

module.exports = { foo, bar }               ->  export { foo, bar }
module.exports = { KEY: "literal" }         ->  const KEY = "literal"; export { KEY }
module.exports = Object.freeze([...])       ->  export default Object.freeze([...])
```

The conversion script (in-process Node, not the file-write tool) handled
all 21 files. Prettier pass applied afterwards; no semantic changes.

---

## Verification

```bash
node --test --test-concurrency=4 --test-timeout=60000 \
  server/l10n-am/armenia-phone.test.js \
  server/l10n-am/armenia-regions.test.js \
  server/l10n-am/armeniaPayroll.test.js \
  server/l10n-am/parse-amd.test.js \
  server/l10n-am/localization.test.js \
  server/l10n-am/chartOfAccounts/armenia-chart-of-accounts.test.js \
  server/l10n-am/einvoice/einvoice.test.js \
  server/l10n-am/einvoice/einvoice-validate.test.js \
  server/l10n-am/einvoice/einvoice-line-consistency.test.js \
  server/l10n-am/vatReturn/vat-return.test.js \
  server/l10n-am/vatReturn/vat-return-rate-sanity.test.js \
  server/l10n-am/vatReturn/vat-return-reconciliation.test.js \
  server/l10n-am/vatReturn/vat-return-validate.test.js
```

```
ℹ tests 119
ℹ pass  119
ℹ fail  0
```

## Brand-strip contract

Scrubbed from ported **code** (not mirrored docs):
`armosphera|hayhashvapah|samvel|a1-erp-hy|HayHashvapah|Armosphera`.

Exception (wire-format, preserved verbatim): the `EINVOICE_NAMESPACE`
constant value `urn:hayhashvapah:einvoice:1` is the canonical
RA-government e-invoice namespace string and must not be changed.

## What did NOT land in wave 1

- The 4 wave-1 leaf branches (`l10n-coa`, `l10n-einv`, `l10n-payroll`,
  `l10n-vat`) are still present locally. They are merged into main and
  reachable via `git log --first-parent main`; safe to delete with
  `git branch -d l10n-coa l10n-einv l10n-payroll l10n-vat` if desired.
- The orchestrator scripts (`scripts/orchestrate-worktrees.cjs`,
  `scripts/tmux-worktree-orchestrator.cjs`) and the wave-1 plan
  (`.orchestration/sbos-a1-erp-l10n-am.json`) are still untracked.
  They belong on a separate `dmux-docs` / `repo-foundation` branch.

## Next (wave 2 candidate)

- A payroll consumer (e.g. an `employmentContract.test.js` covering
  end-to-end gross→net across brackets, written **after** the engine is
  ported, not before — the kernel here is the engine itself).
- A migration preview path for `STANDARD_ACCOUNTS` (623 entries is too
  large for any UI to render whole; needs a paged lookup).
- A `parseHvhh` parser that complements `validateHvhh` (parse + return
  `{ ok, normalized, error }` shape, mirroring `parseAmd`).
