# W95 Summary — HR basics wave 3 (employee status transitions)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W90-1 + W91-1 shipped the HR basics data model + HTTP
layer. Employees had a `status` column (4 values: active /
on_leave / suspended / terminated) but the transitions
were unwired — the operator couldn't actually MOVE an
employee from one status to another.

W95-1 ships the state machine: 4 transition functions
that enforce the legal transitions, stamp audit fields,
and reject illegal transitions with clear error messages.

## What shipped

- `server/finance/migrations/0026_hr_employee_status_audit.sql`:
  6 new audit columns
  - `termination_reason TEXT` (operator note on termination)
  - `suspended_at TEXT` (when the employee was suspended)
  - `suspended_by INTEGER` (who suspended them)
  - `on_leave_at TEXT` (when the leave started)
  - `on_leave_until TEXT` (expected return date)
  - `on_leave_reason TEXT` (reason for the leave)
- `server/finance/hr.js`: 4 new pure functions
  - `suspendEmployee(id, input, tenantId)` — flips
    active/on_leave → suspended, stamps `suspended_at` +
    `suspended_by`
  - `reactivateEmployee(id, input, tenantId)` — flips
    on_leave/suspended → active, CLEARS the audit fields
    (suspended_at, suspended_by, on_leave_at, on_leave_until)
  - `setEmployeeOnLeave(id, input, tenantId)` — flips
    active → on_leave, stamps `on_leave_at` +
    `on_leave_until` (optional) + `on_leave_reason`
  - `terminateEmployee(id, input, tenantId)` — flips any
    → terminated, stamps `termination_date` (defaults to
    today) + `termination_reason`
- `server/finance/hr.test.js`: 12 new unit tests
  (including the full state-machine cycle: active →
  suspended → active → on_leave → terminated)
- `server/finance/routes.js`: 4 new routes
  - POST /api/finance/hr/employees/:id/suspend
  - POST /api/finance/hr/employees/:id/reactivate
  - POST /api/finance/hr/employees/:id/on-leave
  - POST /api/finance/hr/employees/:id/terminate
- `scripts/deploy-smoke.sh`: 4 new smoke checks
  (the full state-machine cycle on employee id=1)

## State machine

| From | To | Function |
|---|---|---|
| active | on_leave | setEmployeeOnLeave |
| active | suspended | suspendEmployee |
| active | terminated | terminateEmployee |
| on_leave | active | reactivateEmployee |
| on_leave | suspended | suspendEmployee |
| on_leave | terminated | terminateEmployee |
| suspended | active | reactivateEmployee |
| suspended | terminated | terminateEmployee |
| terminated | (none) | terminal state |

## Test baseline

- 1533/1533 unit tests pass (was 1516; +12 new HR status
  transition tests + 5 from team's parallel work)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **The state machine is enforced at TWO layers: pure
   function + SQL WHERE clause.** Each transition function
   checks the current status with an explicit pre-check
   (returns ValueError with a clear message) AND includes
   the source status in the SQL `WHERE` clause (returns 0
   rows if the status changed concurrently). The
   pre-check provides a clean error message for the user;
   the WHERE clause provides race-condition safety. The
   same pattern as W89-1 (refundSale) and W87-1
   (closeShift). The lesson: **state-machine guards are
   always two layers** — explicit pre-check for the error
   message + WHERE clause for race safety.

2. **The audit fields are CLEARED on reactivate, not
   preserved.** When an employee is reactivated from
   suspended/on_leave, `suspended_at`, `suspended_by`,
   `on_leave_at`, `on_leave_until` are all set to NULL. The
   previous audit is gone from the live row. A future
   wave could preserve the audit in a separate
   `hr_employee_history` table for compliance/audit
   purposes. The lesson: **live data is for current
   state, history is for archive** — mixing them in the
   same row makes the schema harder to reason about. The
   `hr_employees` row should answer "what is the
   employee's status RIGHT NOW" — not "what is the
   employee's complete history".

3. **`terminated` is a terminal state — no transitions
   out.** Once an employee is terminated, you can't
   suspend them, reactivate them, or put them on leave.
   The four functions all check `if (emp.status ===
   'terminated')` and throw. The lesson: **terminal states
   must be checked at EVERY transition entry point**, not
   just at one. If a future wave adds a 5th transition
   function, it MUST also check for terminated. The check
   is the "common exit" — a single source of truth for
   "this employee is gone, no more changes".

4. **The migration adds 6 audit columns to an existing
   table.** This is the right pattern for "add audit to
   an existing table" — the migration runs ALTER TABLE
   ADD COLUMN for each new column, no data loss, no
   schema rebuild. The columns are NULLABLE so existing
   rows are unaffected. The lesson: **adding audit fields
   is an additive migration** — no data migration
   required, no application restart required, no risk of
   losing data.