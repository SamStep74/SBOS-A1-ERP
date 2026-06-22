# RETRO — W94-1 (AI agents wave 2) + W95-1 (HR basics wave 3) + W49 (admin unlock)

**Date:** 2026-06-22
**Author:** Mavis (autonomous morning session)

## What shipped

### W94-1 — AI agents wave 2 (advisory)
- 2 new pure functions (`suggestMergeCandidates`, `getDataQualityAlerts`)
- 2 new HTTP routes (`GET /api/finance/ai/merge-candidates`, `GET /api/finance/ai/alerts?threshold=80`)
- 17 new unit tests
- 5 new smoke checks (STEP 7k)
- 0 schema changes (pure read-only)
- REUSE existing `reports.dashboard.read` perm

### W95-1 — HR basics wave 3 (employee status transitions)
- 4 new pure functions (`suspendEmployee`, `reactivateEmployee`, `setEmployeeOnLeave`, `terminateEmployee`)
- 4 new HTTP routes (`POST /api/finance/hr/employees/:id/{suspend,reactivate,on-leave,terminate}`)
- 12 new unit tests
- 1 new migration (`0026_hr_employee_status_audit.sql`) — audit fields for status transitions
- 4 new smoke checks (suspend → reactivate → on-leave → terminate state-machine)

### v1.0.1 — On-demand validate-hvhh + path-to-regexp v8 wildcard fix
- 2 new on-demand endpoints (`POST /api/finance/customers/:id/validate-hvhh`, `POST /api/finance/vendors/:id/validate-hvhh`)
- 1 facade fix (`:name(*) → *name` translation for path-to-regexp v8)
- 9 new unit tests + 1 new smoke step (STEP 7j)
- Tagged v1.0.1 on origin

## Lessons

### 1. Sibling session coordination via rebase

Three parallel sessions ran simultaneously (Wave 49 + W94-1 + W95-1). 
Each session committed to origin/main and pulled in the others' work
via rebase. The pattern: commit + push, fetch + rebase on conflict,
push again. No force-pushes needed; all clean fast-forwards after
the sibling work landed.

**Cost:** ~5 minutes of rebase work per conflict (3 conflicts total).
**Alternative (mavis team plan):** would have been slower due to
verifier cycle time and the work is small enough to coordinate
manually.

### 2. mockDb classifier drift

The mockDb in `dataQuality.test.js` classifies SQL by regex to
decide which handler to call. The first attempt at W94-1 (mine)
used a generic `/SELECT COUNT(*) AS /` regex for 'aggregate' and
added 'inv-count' as a separate kind. But the inv-count query
also matched the generic regex (it's `SELECT COUNT(*) AS n`),
so it was misclassified as 'aggregate'.

**Fix:** the sibling session used a stricter regex
`/SELECT COUNT(*) AS (TOTAL|ISSUED|WITH_HVHH|NO_DRIFT)/` for
'aggregate' — explicitly listing the valid alias names. This
excludes 'AS n' (suggestMergeCandidates' count) by construction.

**Lesson:** when adding new SQL shapes to the mock, the classifier
needs to either:
1. List the explicit alias names (sibling's approach), OR
2. Use negative-lookahead patterns to exclude the new shape, OR
3. Check the most-specific patterns FIRST, fall through to generic
   patterns last.

Option 1 is the most explicit and least error-prone. Going forward,
whenever a new SQL shape is added, the mock's classifier must be
extended to handle it.

### 3. Path-to-regexp v8 wildcard syntax

Wave 46 (commit 387b3ce) tried to make routes portable across
Express 4 (path-to-regexp 0.1.13) and Express 5 (path-to-regexp v8)
by translating `:name(*) → *` (unnamed splat). But path-to-regexp v8
**explicitly rejects** unnamed `*` (requires a name on the splat).

**Fix:** restore `*name` (named) syntax — works in v6+. Add a
handler-side fallback to `req.params[0]` (added in 387b3ce) to
cover the older 0.1.13 case.

**Lesson:** when translating wildcard routes across Express/Fastify
versions, detect the path-to-regexp version and use the right syntax.
The safe default for modern Express is `*name` (named, no colon).

### 4. On-demand validate-hvhh never throws

The 2 new on-demand validate-hvhh endpoints return 200 always —
`ok=false` indicates "the hvhh is invalid" (which is a successful
response — the answer is "no, this is broken"). `404` only when
the customer/vendor row doesn't exist.

This is different from the create-time fail-soft wrappers
(`assertValidHvhhAsync`) which throw `ValueError` and cause
the POST to return 400. The on-demand pattern is "verify, don't
write" — the caller asks "is this hvhh still valid?" and expects
a yes/no answer, not a 400.

**Lesson:** read-time validation and write-time validation have
different contracts. Read-time = "never throw, always return a
verdict". Write-time = "throw on invalid so the POST fails with
400". Don't conflate them.

### 5. AI agents should be advisory, not corrective

Both `suggestMergeCandidates` and `getDataQualityAlerts` are
READ-ONLY. They propose what to do; the operator decides whether
to apply. Auto-correcting data quality issues would:
- Skip the audit trail
- Skip the operator's judgment on which record to keep
- Risk cascading errors (e.g. auto-fixing an invoice's hvhh might
  break a downstream report that expected the original value)

**Lesson:** AI agents in the data quality space should be
advisory. Auto-correction needs a separate approval workflow +
audit trail.

### 6. HR status state machine — explicit transitions only

The HR wave 3 state machine:
- `active → on_leave, suspended, terminated`
- `on_leave → active, suspended, terminated`
- `suspended → active, terminated`
- `terminated → (terminal)`

The state machine is explicit. We don't allow `terminated → active`
(rehire requires a new employee record, not a state transition).
We don't allow `suspended → on_leave` (suspended employees are
paused; they need to be reactivated first, then can go on leave).

**Lesson:** state machines should be explicit. The default should
be "reject" (with a clear error message) rather than "allow and
trust the operator". Every transition needs a reason and a
timestamp for audit. The migration `0026_hr_employee_status_audit.sql`
adds `suspended_at`, `on_leave_at`, `on_leave_until`,
`termination_reason` columns for this.

## Stats

| Item | Before morning | After morning |
|---|---|---|
| Commits on origin/main | 14 (v1.0.1) | 17 (v1.0.1 + W94 + W95 + W49) |
| Unit tests | 1499 | 1533 (+34) |
| Smoke checks | 137 | 145 (+8) |
| Finance migrations | 25 | 26 (+1) |
| HTTP routes | ~50 | ~62 (+12) |
| Pure functions | ~80 | ~91 (+11) |

## Next

- **Reporting wave 3** — scheduled report runs + email delivery
  (more complex; needs a scheduler + email-send integration)
- **Operational:** production pg CI (parallel sqlite + pg smoke runs)
- **CFO-facing next:** on-demand validate-hvhh UI in the dashboard
  (currently only exposed via HTTP; needs a click-to-verify button)
