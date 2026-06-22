-- Phase 3 HR basics wave 3 (W95-1) — employee status
-- transitions: add the optional termination_reason
-- column + extend the status state machine with audit
-- fields (suspended_at / suspended_by / on_leave_at /
-- on_leave_until).
--
-- Background:
--   The hr_employees status column (W90-1) supports 4 values
--   (active / on_leave / suspended / terminated). The state
--   transitions need audit fields so the operator can see
--   WHEN an employee was suspended, BY WHOM, and (for
--   on_leave) when they're expected to return.
--
--   The audit fields are NULL while the employee is in
--   'active' status. They're stamped at the time of the
--   transition (e.g. suspended_at = datetime('now') when
--   suspendEmployee is called). The pure functions
--   enforce that the status + audit fields are consistent
--   (e.g. an employee in 'suspended' status MUST have
--   suspended_at populated).

ALTER TABLE finance.hr_employees ADD COLUMN termination_reason TEXT;
ALTER TABLE finance.hr_employees ADD COLUMN suspended_at TEXT;
ALTER TABLE finance.hr_employees ADD COLUMN suspended_by INTEGER;
ALTER TABLE finance.hr_employees ADD COLUMN on_leave_at TEXT;
ALTER TABLE finance.hr_employees ADD COLUMN on_leave_until TEXT;
ALTER TABLE finance.hr_employees ADD COLUMN on_leave_reason TEXT;