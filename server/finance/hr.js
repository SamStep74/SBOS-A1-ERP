// Phase 3 HR basics (W90-1) — minimum viable HR module.
//
// This module ships the HR lifecycle: employees → contracts →
// payroll runs → payroll lines. Each step enforces tenant
// isolation, parent-existence checks, and status state-machine
// guards.
//
// Wave 1 (W90-1) scope:
//   - addEmployee / listEmployees / getEmployee
//   - addContract / listContracts / getContract
//   - createPayrollRun / addPayrollLine / listPayrollRuns
//
// Wave 2 (W91-1) scope:
//   - route wiring + perm keys + smoke checks
//
// Wave 3 (future) scope:
//   - approvePayrollRun / postPayrollRun / getPayrollRun /
//     listPayrollLines (the approval + posting + read paths)
//   - employee status transitions (terminate, suspend, etc.)
//   - PII field separation (hr.employee.pii.* perm keys)

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapter helper (matches the pattern in customer.js /
// inventory.js / crm.js / desk.js / projects.js / catalog.js
// / pos.js)
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

const EMPLOYEE_STATUSES = ['active', 'on_leave', 'suspended', 'terminated'];
const CONTRACT_STATUSES = ['active', 'expired', 'terminated', 'suspended'];
const CURRENCIES = ['AMD', 'USD', 'EUR', 'RUB'];
const PAY_FREQUENCIES = ['monthly', 'biweekly', 'weekly'];
// PAYROLL_STATUSES is intentionally defined for documentation;
// the state-machine guards are inline in addPayrollLine /
// future approvePayrollRun. Marked with _ to keep eslint quiet
// until wave 2 adds the approval + posting flows.
const _PAYROLL_STATUSES = ['draft', 'approved', 'posted', 'voided'];

function _assertString(value, name, { min = 1, max = 8192 } = {}) {
  if (typeof value !== 'string' || value.length < min || value.length > max) {
    throw new ValueError(`${name} must be a string of ${min}-${max} characters`);
  }
}

function assertOptionalString(value, name, { max = 8192 } = {}) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || value.length > max) {
    throw new ValueError(`${name} must be a string up to ${max} characters or null`);
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertNonNegativeInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

// assertOptionalInt is intentionally defined for the future
// approvePayrollRun / postPayrollRun / employee status
// transitions. Kept as a helper for symmetry with the other
// validators. Marked with _ to keep eslint quiet.
function _assertOptionalInt(value, name) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer or null`);
  }
}

function _assertDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValueError(`${name} must be a date in YYYY-MM-DD format`);
  }
}

function _assertCurrency(value) {
  if (!CURRENCIES.includes(value)) {
    throw new ValueError(`currency must be one of: ${CURRENCIES.join(', ')}`);
  }
}

function _assertPayFrequency(value) {
  if (!PAY_FREQUENCIES.includes(value)) {
    throw new ValueError(`pay_frequency must be one of: ${PAY_FREQUENCIES.join(', ')}`);
  }
}

function _assertEmployeeStatus(value) {
  if (value === null || value === undefined) return;
  if (!EMPLOYEE_STATUSES.includes(value)) {
    throw new ValueError(`employee status must be one of: ${EMPLOYEE_STATUSES.join(', ')}`);
  }
}

function _assertContractStatus(value) {
  if (value === null || value === undefined) return;
  if (!CONTRACT_STATUSES.includes(value)) {
    throw new ValueError(`contract status must be one of: ${CONTRACT_STATUSES.join(', ')}`);
  }
}

function validateAddEmployeeInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('employee input is required');
  }
  _assertString(input.code, 'code', { min: 1, max: 64 });
  _assertString(input.first_name, 'first_name', { min: 1, max: 128 });
  _assertString(input.last_name, 'last_name', { min: 1, max: 128 });
  assertOptionalString(input.email, 'email', { max: 255 });
  assertOptionalString(input.phone, 'phone', { max: 32 });
  assertOptionalString(input.role, 'role', { max: 128 });
  assertOptionalString(input.department, 'department', { max: 128 });
  _assertDate(input.hire_date, 'hire_date');
  assertOptionalString(input.termination_date, 'termination_date', { max: 32 });
  _assertEmployeeStatus(input.status ?? 'active');
  assertOptionalString(input.hvhh, 'hvhh', { max: 32 });
  assertOptionalString(input.bank_account, 'bank_account', { max: 64 });
}

function validateAddContractInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('contract input is required');
  }
  assertPositiveInt(input.employee_id, 'employee_id');
  _assertString(input.contract_number, 'contract_number', { min: 1, max: 64 });
  _assertDate(input.start_date, 'start_date');
  assertOptionalString(input.end_date, 'end_date', { max: 32 });
  assertNonNegativeInt(input.base_salary_amd, 'base_salary_amd');
  _assertCurrency(input.currency ?? 'AMD');
  _assertPayFrequency(input.pay_frequency ?? 'monthly');
  assertPositiveInt(input.hours_per_week ?? 40, 'hours_per_week');
  assertPositiveInt(input.vacation_days_per_year ?? 20, 'vacation_days_per_year');
  _assertContractStatus(input.status ?? 'active');
  assertOptionalString(input.notes, 'notes', { max: 4096 });
}

function validateCreatePayrollRunInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('payroll run input is required');
  }
  assertPositiveInt(input.period_year, 'period_year');
  assertPositiveInt(input.period_month, 'period_month');
  if (input.period_year < 2000 || input.period_year > 2100) {
    throw new ValueError('period_year must be between 2000 and 2100');
  }
  if (input.period_month < 1 || input.period_month > 12) {
    throw new ValueError('period_month must be between 1 and 12');
  }
  assertOptionalString(input.notes, 'notes', { max: 4096 });
}

function validateAddPayrollLineInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('payroll line input is required');
  }
  assertPositiveInt(input.payroll_run_id, 'payroll_run_id');
  assertPositiveInt(input.employee_id, 'employee_id');
  assertPositiveInt(input.contract_id, 'contract_id');
  assertNonNegativeInt(input.base_salary_amd, 'base_salary_amd');
  assertNonNegativeInt(input.bonus_amd ?? 0, 'bonus_amd');
  assertNonNegativeInt(input.deductions_amd ?? 0, 'deductions_amd');
  assertNonNegativeInt(input.tax_amd ?? 0, 'tax_amd');
  assertNonNegativeInt(input.worked_days ?? 22, 'worked_days');
  assertNonNegativeInt(input.vacation_days ?? 0, 'vacation_days');
  assertNonNegativeInt(input.sick_days ?? 0, 'sick_days');
  assertOptionalString(input.notes, 'notes', { max: 4096 });
}

// ────────────────────────────────────────────────────────────────────────
// Internal helpers
// ────────────────────────────────────────────────────────────────────────

async function fetchEmployee(db, employeeId, tenantId) {
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, code, first_name, last_name, email, phone,
            role, department, hire_date, termination_date, status,
            hvhh, bank_account, created_at, updated_at
       FROM finance.hr_employees
      WHERE id = $1 AND tenant_id = $2`,
    [employeeId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`employee ${employeeId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

async function fetchContract(db, contractId, tenantId) {
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, employee_id, contract_number, start_date,
            end_date, base_salary_amd, currency, pay_frequency,
            hours_per_week, vacation_days_per_year, status, notes,
            created_at, updated_at
       FROM finance.hr_contracts
      WHERE id = $1 AND tenant_id = $2`,
    [contractId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`contract ${contractId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

async function fetchPayrollRun(db, runId, tenantId) {
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, period_year, period_month, status,
            total_gross_amd, total_net_amd, total_tax_amd,
            employee_count, approved_by, approved_at, posted_by,
            posted_at, notes, created_at, updated_at
       FROM finance.hr_payroll_runs
      WHERE id = $1 AND tenant_id = $2`,
    [runId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`payroll run ${runId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

// ────────────────────────────────────────────────────────────────────────
// Employees
// ────────────────────────────────────────────────────────────────────────

export async function addEmployee(db, input, tenantId = 0) {
  validateAddEmployeeInput(input);
  // Check uniqueness: code is per-tenant (UNIQUE INDEX
  // hr_employees_tenant_code_idx enforces this). The
  // pure-function check gives a clean 400 instead of a
  // 500 from the UNIQUE violation.
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.hr_employees
      WHERE tenant_id = $1 AND code = $2`,
    [tenantId, input.code],
  );
  if (existing.rows && existing.rows.length > 0) {
    throw new ValueError(
      `employee with code '${input.code}' already exists in tenant ${tenantId}`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.hr_employees
       (tenant_id, code, first_name, last_name, email, phone, role,
        department, hire_date, termination_date, status, hvhh,
        bank_account)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      tenantId,
      input.code,
      input.first_name,
      input.last_name,
      input.email ?? null,
      input.phone ?? null,
      input.role ?? null,
      input.department ?? null,
      input.hire_date,
      input.termination_date ?? null,
      input.status ?? 'active',
      input.hvhh ?? null,
      input.bank_account ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listEmployees(
  db,
  tenantId = 0,
  { status = null, department = null } = {},
) {
  // Order by id ASC (chronological — oldest employee first;
  // consistent with listRegisters / listBundles).
  let result;
  if (status !== null && department !== null) {
    result = await runQuery(
      db,
      `SELECT id, code, first_name, last_name, email, phone, role,
              department, hire_date, termination_date, status,
              hvhh, bank_account, created_at, updated_at
         FROM finance.hr_employees
        WHERE tenant_id = $1 AND status = $2 AND department = $3
        ORDER BY id ASC`,
      [tenantId, status, department],
    );
  } else if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, code, first_name, last_name, email, phone, role,
              department, hire_date, termination_date, status,
              hvhh, bank_account, created_at, updated_at
         FROM finance.hr_employees
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id ASC`,
      [tenantId, status],
    );
  } else if (department !== null) {
    result = await runQuery(
      db,
      `SELECT id, code, first_name, last_name, email, phone, role,
              department, hire_date, termination_date, status,
              hvhh, bank_account, created_at, updated_at
         FROM finance.hr_employees
        WHERE tenant_id = $1 AND department = $2
        ORDER BY id ASC`,
      [tenantId, department],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, code, first_name, last_name, email, phone, role,
              department, hire_date, termination_date, status,
              hvhh, bank_account, created_at, updated_at
         FROM finance.hr_employees
        WHERE tenant_id = $1
        ORDER BY id ASC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getEmployee(db, employeeId, tenantId = 0) {
  assertPositiveInt(employeeId, 'employeeId');
  return await fetchEmployee(db, employeeId, tenantId);
}

// ────────────────────────────────────────────────────────────────────────
// Contracts
// ────────────────────────────────────────────────────────────────────────

export async function addContract(db, input, tenantId = 0) {
  validateAddContractInput(input);
  // Verify the employee exists in the tenant.
  await fetchEmployee(db, input.employee_id, tenantId);
  // Check uniqueness: contract_number is per-tenant (UNIQUE
  // INDEX hr_contracts_tenant_number_idx).
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.hr_contracts
      WHERE tenant_id = $1 AND contract_number = $2`,
    [tenantId, input.contract_number],
  );
  if (existing.rows && existing.rows.length > 0) {
    throw new ValueError(
      `contract with number '${input.contract_number}' already exists in tenant ${tenantId}`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.hr_contracts
       (tenant_id, employee_id, contract_number, start_date,
        end_date, base_salary_amd, currency, pay_frequency,
        hours_per_week, vacation_days_per_year, status, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING id`,
    [
      tenantId,
      input.employee_id,
      input.contract_number,
      input.start_date,
      input.end_date ?? null,
      input.base_salary_amd,
      input.currency ?? 'AMD',
      input.pay_frequency ?? 'monthly',
      input.hours_per_week ?? 40,
      input.vacation_days_per_year ?? 20,
      input.status ?? 'active',
      input.notes ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listContracts(
  db,
  tenantId = 0,
  { employeeId = null, status = null } = {},
) {
  // Order by id ASC (chronological).
  let result;
  if (employeeId !== null && status !== null) {
    result = await runQuery(
      db,
      `SELECT id, employee_id, contract_number, start_date,
              end_date, base_salary_amd, currency, pay_frequency,
              hours_per_week, vacation_days_per_year, status, notes,
              created_at, updated_at
         FROM finance.hr_contracts
        WHERE tenant_id = $1 AND employee_id = $2 AND status = $3
        ORDER BY id ASC`,
      [tenantId, employeeId, status],
    );
  } else if (employeeId !== null) {
    result = await runQuery(
      db,
      `SELECT id, employee_id, contract_number, start_date,
              end_date, base_salary_amd, currency, pay_frequency,
              hours_per_week, vacation_days_per_year, status, notes,
              created_at, updated_at
         FROM finance.hr_contracts
        WHERE tenant_id = $1 AND employee_id = $2
        ORDER BY id ASC`,
      [tenantId, employeeId],
    );
  } else if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, employee_id, contract_number, start_date,
              end_date, base_salary_amd, currency, pay_frequency,
              hours_per_week, vacation_days_per_year, status, notes,
              created_at, updated_at
         FROM finance.hr_contracts
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id ASC`,
      [tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, employee_id, contract_number, start_date,
              end_date, base_salary_amd, currency, pay_frequency,
              hours_per_week, vacation_days_per_year, status, notes,
              created_at, updated_at
         FROM finance.hr_contracts
        WHERE tenant_id = $1
        ORDER BY id ASC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getContract(db, contractId, tenantId = 0) {
  assertPositiveInt(contractId, 'contractId');
  return await fetchContract(db, contractId, tenantId);
}

// ────────────────────────────────────────────────────────────────────────
// Payroll runs
// ────────────────────────────────────────────────────────────────────────

export async function createPayrollRun(db, input, tenantId = 0) {
  validateCreatePayrollRunInput(input);
  // The UNIQUE INDEX on (tenant_id, period_year, period_month)
  // enforces "at most one run per month" at the DB level.
  // We check inline too (for a clean 400 with the existing
  // run's id — same pattern as openShift's one-open-shift
  // invariant).
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.hr_payroll_runs
      WHERE tenant_id = $1 AND period_year = $2 AND period_month = $3`,
    [tenantId, input.period_year, input.period_month],
  );
  if (existing.rows && existing.rows.length > 0) {
    throw new ValueError(
      `payroll run already exists for ${input.period_year}-${String(input.period_month).padStart(2, '0')} in tenant ${tenantId} (id=${existing.rows[0].id})`,
    );
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.hr_payroll_runs
       (tenant_id, period_year, period_month, status, notes)
     VALUES ($1, $2, $3, 'draft', $4)
     RETURNING id`,
    [
      tenantId,
      input.period_year,
      input.period_month,
      input.notes ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function addPayrollLine(db, input, tenantId = 0) {
  validateAddPayrollLineInput(input);
  // Verify the payroll run exists in the tenant.
  const run = await fetchPayrollRun(db, input.payroll_run_id, tenantId);
  // State-machine guard: only 'draft' payroll runs accept
  // new lines. Once approved / posted / voided, the run is
  // immutable (a new draft would need to be created).
  if (run.status !== 'draft') {
    throw new ValueError(
      `payroll run ${input.payroll_run_id} is ${run.status} (cannot add lines to a non-draft run)`,
    );
  }
  // Verify the employee + contract exist in the tenant
  // (catches cross-tenant FK violations — the schema
  // doesn't enforce FKs across migrations).
  await fetchEmployee(db, input.employee_id, tenantId);
  await fetchContract(db, input.contract_id, tenantId);
  // Compute net_pay_amd from the inputs. The application
  // layer is the source of truth for this calculation —
  // the CHECK constraint enforces non-negative but the
  // actual math is here.
  const netPay =
    input.base_salary_amd +
    (input.bonus_amd ?? 0) -
    (input.deductions_amd ?? 0) -
    (input.tax_amd ?? 0);
  if (netPay < 0) {
    throw new ValueError(
      `net_pay_amd (${netPay}) would be negative — check base + bonus − deductions − tax`,
    );
  }
  // Insert the line (append-only — payroll lines are
  // immutable once inserted; to correct a mis-entry, void
  // the run and start a new one).
  const ins = await runQuery(
    db,
    `INSERT INTO finance.hr_payroll_lines
       (tenant_id, payroll_run_id, employee_id, contract_id,
        base_salary_amd, bonus_amd, deductions_amd, tax_amd,
        net_pay_amd, worked_days, vacation_days, sick_days, notes)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
     RETURNING id`,
    [
      tenantId,
      input.payroll_run_id,
      input.employee_id,
      input.contract_id,
      input.base_salary_amd,
      input.bonus_amd ?? 0,
      input.deductions_amd ?? 0,
      input.tax_amd ?? 0,
      netPay,
      input.worked_days ?? 22,
      input.vacation_days ?? 0,
      input.sick_days ?? 0,
      input.notes ?? null,
    ],
  );
  let lineId;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    lineId = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    lineId = Number(lastId.rows[0].id);
  }
  // Recompute the run's aggregate totals by summing across
  // all lines (the materialized columns are a query-speed
  // optimization — same pattern as pos_sales.total_amd).
  await runQuery(
    db,
    `UPDATE finance.hr_payroll_runs
        SET total_gross_amd = (
          SELECT COALESCE(SUM(base_salary_amd + bonus_amd), 0)
            FROM finance.hr_payroll_lines
           WHERE payroll_run_id = $1 AND tenant_id = $2
        ),
        total_net_amd = (
          SELECT COALESCE(SUM(net_pay_amd), 0)
            FROM finance.hr_payroll_lines
           WHERE payroll_run_id = $1 AND tenant_id = $2
        ),
        total_tax_amd = (
          SELECT COALESCE(SUM(tax_amd), 0)
            FROM finance.hr_payroll_lines
           WHERE payroll_run_id = $1 AND tenant_id = $2
        ),
        employee_count = (
          SELECT COUNT(*)
            FROM finance.hr_payroll_lines
           WHERE payroll_run_id = $1 AND tenant_id = $2
        ),
        updated_at = datetime('now')
      WHERE id = $1 AND tenant_id = $2`,
    [input.payroll_run_id, tenantId],
  );
  return { id: lineId };
}

export async function listPayrollRuns(
  db,
  tenantId = 0,
  { status = null, periodYear = null } = {},
) {
  // Order by period_year DESC, period_month DESC (most
  // recent first — same as listShifts / listCases).
  let result;
  if (status !== null && periodYear !== null) {
    result = await runQuery(
      db,
      `SELECT id, period_year, period_month, status,
              total_gross_amd, total_net_amd, total_tax_amd,
              employee_count, approved_by, approved_at,
              posted_by, posted_at, notes, created_at, updated_at
         FROM finance.hr_payroll_runs
        WHERE tenant_id = $1 AND status = $2 AND period_year = $3
        ORDER BY period_year DESC, period_month DESC`,
      [tenantId, status, periodYear],
    );
  } else if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, period_year, period_month, status,
              total_gross_amd, total_net_amd, total_tax_amd,
              employee_count, approved_by, approved_at,
              posted_by, posted_at, notes, created_at, updated_at
         FROM finance.hr_payroll_runs
        WHERE tenant_id = $1 AND status = $2
        ORDER BY period_year DESC, period_month DESC`,
      [tenantId, status],
    );
  } else if (periodYear !== null) {
    result = await runQuery(
      db,
      `SELECT id, period_year, period_month, status,
              total_gross_amd, total_net_amd, total_tax_amd,
              employee_count, approved_by, approved_at,
              posted_by, posted_at, notes, created_at, updated_at
         FROM finance.hr_payroll_runs
        WHERE tenant_id = $1 AND period_year = $2
        ORDER BY period_year DESC, period_month DESC`,
      [tenantId, periodYear],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, period_year, period_month, status,
              total_gross_amd, total_net_amd, total_tax_amd,
              employee_count, approved_by, approved_at,
              posted_by, posted_at, notes, created_at, updated_at
         FROM finance.hr_payroll_runs
         WHERE tenant_id = $1
        ORDER BY period_year DESC, period_month DESC`,
      [tenantId],
    );
  }
  return result.rows;
}

// ────────────────────────────────────────────────────────────────────────
// Employee status transitions (W95-1 — wave 3)
//
// State machine for hr_employees.status:
//   active → on_leave, suspended, terminated
//   on_leave → active, suspended, terminated
//   suspended → active, terminated
//   terminated → (terminal — no transitions out)
//
// The audit fields (suspended_at, on_leave_at, on_leave_until,
// termination_reason) are stamped at the time of the transition.
// They are NOT cleared on subsequent transitions (a 'terminated'
// employee retains their previous 'suspended_at' for audit
// purposes — the operator can see "this employee was suspended
// in 2025-01, terminated in 2025-06").
// ────────────────────────────────────────────────────────────────────────

function validateTransitionInput(input, name) {
  if (!input || typeof input !== 'object') {
    throw new ValueError(`${name} is required`);
  }
  assertPositiveInt(input.user_id, 'user_id');
}

function validateOnLeaveInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('on_leave input is required');
  }
  assertPositiveInt(input.user_id, 'user_id');
  if (input.expected_return_date !== null && input.expected_return_date !== undefined) {
    _assertDate(input.expected_return_date, 'expected_return_date');
  }
  assertOptionalString(input.reason, 'reason', { max: 1024 });
}

function validateTerminateInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('terminate input is required');
  }
  assertPositiveInt(input.user_id, 'user_id');
  assertOptionalString(input.reason, 'reason', { max: 1024 });
  if (input.termination_date !== null && input.termination_date !== undefined) {
    _assertDate(input.termination_date, 'termination_date');
  }
}

/**
 * Suspend an employee. Flips status: active/on_leave →
 * suspended. Stamps suspended_at + suspended_by.
 *
 * @returns {Promise<{ id: number, status: 'suspended' }>}
 */
export async function suspendEmployee(db, employeeId, input, tenantId = 0) {
  assertPositiveInt(employeeId, 'employeeId');
  validateTransitionInput(input, 'input');
  const emp = await fetchEmployee(db, employeeId, tenantId);
  if (emp.status === 'suspended') {
    throw new ValueError(`employee ${employeeId} is already suspended`);
  }
  if (emp.status === 'terminated') {
    throw new ValueError(
      `employee ${employeeId} is terminated (cannot suspend a terminated employee)`,
    );
  }
  const upd = await runQuery(
    db,
    `UPDATE finance.hr_employees
        SET status = 'suspended',
            suspended_at = datetime('now'),
            suspended_by = $1
      WHERE id = $2 AND tenant_id = $3 AND status != 'suspended'`,
    [input.user_id, employeeId, tenantId],
  );
  if (typeof upd.changes === 'number' && upd.changes === 0) {
    throw new ValueError(
      `employee ${employeeId} is no longer active (concurrent update?)`,
    );
  }
  return { id: employeeId, status: 'suspended' };
}

/**
 * Reactivate an employee. Flips status: on_leave/suspended
 * → active. Clears suspended_at + on_leave_at.
 *
 * @returns {Promise<{ id: number, status: 'active' }>}
 */
export async function reactivateEmployee(db, employeeId, input, tenantId = 0) {
  assertPositiveInt(employeeId, 'employeeId');
  validateTransitionInput(input, 'input');
  const emp = await fetchEmployee(db, employeeId, tenantId);
  if (emp.status === 'active') {
    throw new ValueError(`employee ${employeeId} is already active`);
  }
  if (emp.status === 'terminated') {
    throw new ValueError(
      `employee ${employeeId} is terminated (cannot reactivate a terminated employee)`,
    );
  }
  const upd = await runQuery(
    db,
    `UPDATE finance.hr_employees
        SET status = 'active',
            suspended_at = NULL,
            suspended_by = NULL,
            on_leave_at = NULL,
            on_leave_until = NULL
      WHERE id = $1 AND tenant_id = $2 AND status IN ('on_leave', 'suspended')`,
    [employeeId, tenantId],
  );
  if (typeof upd.changes === 'number' && upd.changes === 0) {
    throw new ValueError(
      `employee ${employeeId} is no longer on_leave/suspended (concurrent update?)`,
    );
  }
  return { id: employeeId, status: 'active' };
}

/**
 * Set an employee to on_leave. Flips status: active →
 * on_leave. Stamps on_leave_at + on_leave_until (optional
 * expected return date) + on_leave_reason.
 *
 * @param {object} input — { user_id, expected_return_date?, reason? }
 * @returns {Promise<{ id: number, status: 'on_leave' }>}
 */
export async function setEmployeeOnLeave(db, employeeId, input, tenantId = 0) {
  assertPositiveInt(employeeId, 'employeeId');
  validateOnLeaveInput(input);
  const emp = await fetchEmployee(db, employeeId, tenantId);
  if (emp.status === 'on_leave') {
    throw new ValueError(`employee ${employeeId} is already on leave`);
  }
  if (emp.status === 'terminated') {
    throw new ValueError(
      `employee ${employeeId} is terminated (cannot put a terminated employee on leave)`,
    );
  }
  if (emp.status === 'suspended') {
    throw new ValueError(
      `employee ${employeeId} is suspended (reactivate first, then set on leave)`,
    );
  }
  const upd = await runQuery(
    db,
    `UPDATE finance.hr_employees
        SET status = 'on_leave',
            on_leave_at = datetime('now'),
            on_leave_until = $1,
            on_leave_reason = $2
      WHERE id = $3 AND tenant_id = $4 AND status = 'active'`,
    [input.expected_return_date ?? null, input.reason ?? null, employeeId, tenantId],
  );
  if (typeof upd.changes === 'number' && upd.changes === 0) {
    throw new ValueError(
      `employee ${employeeId} is no longer active (concurrent update?)`,
    );
  }
  return { id: employeeId, status: 'on_leave' };
}

/**
 * Terminate an employee. Flips status: any → terminated.
 * Stamps termination_date (if not provided, uses today) +
 * termination_reason.
 *
 * @param {object} input — { user_id, reason?, termination_date? }
 * @returns {Promise<{ id: number, status: 'terminated' }>}
 */
export async function terminateEmployee(db, employeeId, input, tenantId = 0) {
  assertPositiveInt(employeeId, 'employeeId');
  validateTerminateInput(input);
  const emp = await fetchEmployee(db, employeeId, tenantId);
  if (emp.status === 'terminated') {
    throw new ValueError(`employee ${employeeId} is already terminated`);
  }
  const terminationDate = input.termination_date ?? new Date().toISOString().slice(0, 10);
  const upd = await runQuery(
    db,
    `UPDATE finance.hr_employees
        SET status = 'terminated',
            termination_date = $1,
            termination_reason = $2
      WHERE id = $3 AND tenant_id = $4 AND status != 'terminated'`,
    [terminationDate, input.reason ?? null, employeeId, tenantId],
  );
  if (typeof upd.changes === 'number' && upd.changes === 0) {
    throw new ValueError(
      `employee ${employeeId} is no longer active (concurrent update?)`,
    );
  }
  return { id: employeeId, status: 'terminated' };
}