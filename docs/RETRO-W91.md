# W91 Summary — HR basics wave 2 (routes + perm keys + smoke checks)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W90-1 shipped the HR basics data model + pure functions:
4 tables (`hr_employees` / `hr_contracts` / `hr_payroll_runs`
/ `hr_payroll_lines`) + 9 pure functions + 22 unit tests.

W91-1 closes the wave-2 loop: the HR lifecycle is now
reachable from the HTTP layer.

The smoke flow chains: create employee → create contract
(for the employee) → create payroll run (for a year+month)
→ add payroll line (for the employee + contract). Each
POST returns id > 0 (the wave-14 production pg adapter
regression guard).

## What shipped

- `server/finance/routes.js`: 9 new HR routes
  - GET/POST /api/finance/hr/employees + GET /:id
  - GET/POST /api/finance/hr/contracts + GET /:id
  - GET/POST /api/finance/hr/payroll-runs
  - POST /api/finance/hr/payroll-runs/:id/lines
- `scripts/deploy-smoke.sh`: 11 new smoke checks
  - 5 read checks (empty DB → 200, missing → 404)
  - 6 write checks (full employee → contract → payroll
    run → payroll line lifecycle)

Perm keys: REUSE existing 25 hr.* keys in permissions.js
(employee.read/create, contract.read/create, payroll.read/
run). No new perm additions.

## Test baseline

- 1477/1477 unit tests pass (no test delta — wave 2 is
  route-only)
- `npm run check` clean
- `scripts/deploy-smoke.sh` RESULT: PASS (11 new HR checks)
- 24 finance migrations applied (no new migrations)

## Lessons learned

1. **The route file's import block is fragile — a failed
   Edit silently leaves imports out.** My initial W91-1
   edit added 9 HR function references in routes.js but
   didn't add the import block at the top. ESLint caught
   it immediately (`addEmployee is not defined`), so the
   fix was straightforward — but the lesson is to always
   verify imports when adding a new module's functions to
   the route file. The pattern: Edit → run lint → run npm
   run check → fix → re-run.

2. **HR smoke flow chains entities with cross-test
   dependencies.** The 6 write smoke checks depend on
   each other:
   ```
   POST employee (id=1) → POST contract (employee_id=1)
                       → POST payroll run (year+month, id=1)
                       → POST payroll line (run_id=1, employee_id=1, contract_id=1)
   ```
   If the employee POST fails, the contract POST fails
   (employee doesn't exist), the payroll line POST fails
   (employee + contract don't exist). The smoke test
   order is critical — I added a comment in the smoke
   explaining the cross-check dependency, so the next
   maintainer can reorder safely.