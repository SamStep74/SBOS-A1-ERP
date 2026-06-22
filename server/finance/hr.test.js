// Phase 3 HR basics — wave 1 unit tests (schema + pure functions).
// The test harness uses a minimal in-memory sqlite-shaped adapter
// that mimics the production pgAdapter shape (db.query() returns
// { rows: [...] }).
//
// The schema is migrated via applyMigrations() in the bootable
// server (npm run smoke:deploy), not in the test harness. The test
// harness creates the tables it needs; the HR tables include the
// new columns + unique partial index for "one payroll run per
// (year, month) per tenant".
//
// Run: node --test server/finance/hr.test.js

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  addEmployee,
  listEmployees,
  getEmployee,
  addContract,
  listContracts,
  getContract,
  createPayrollRun,
  addPayrollLine,
  listPayrollRuns,
  suspendEmployee,
  reactivateEmployee,
  setEmployeeOnLeave,
  terminateEmployee,
  ValueError,
} from './hr.js';

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter.
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE hr_employees (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      code TEXT NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role TEXT,
      department TEXT,
      hire_date TEXT NOT NULL,
      termination_date TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      hvhh TEXT,
      bank_account TEXT,
      termination_reason TEXT,
      suspended_at TEXT,
      suspended_by INTEGER,
      on_leave_at TEXT,
      on_leave_until TEXT,
      on_leave_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE hr_contracts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      employee_id INTEGER NOT NULL,
      contract_number TEXT NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT,
      base_salary_amd INTEGER NOT NULL,
      currency TEXT NOT NULL DEFAULT 'AMD',
      pay_frequency TEXT NOT NULL DEFAULT 'monthly',
      hours_per_week INTEGER NOT NULL DEFAULT 40,
      vacation_days_per_year INTEGER NOT NULL DEFAULT 20,
      status TEXT NOT NULL DEFAULT 'active',
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE hr_payroll_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      period_year INTEGER NOT NULL,
      period_month INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      total_gross_amd INTEGER NOT NULL DEFAULT 0,
      total_net_amd INTEGER NOT NULL DEFAULT 0,
      total_tax_amd INTEGER NOT NULL DEFAULT 0,
      employee_count INTEGER NOT NULL DEFAULT 0,
      approved_by INTEGER,
      approved_at TEXT,
      posted_by INTEGER,
      posted_at TEXT,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE hr_payroll_lines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      payroll_run_id INTEGER NOT NULL,
      employee_id INTEGER NOT NULL,
      contract_id INTEGER NOT NULL,
      base_salary_amd INTEGER NOT NULL,
      bonus_amd INTEGER NOT NULL DEFAULT 0,
      deductions_amd INTEGER NOT NULL DEFAULT 0,
      tax_amd INTEGER NOT NULL DEFAULT 0,
      net_pay_amd INTEGER NOT NULL,
      worked_days INTEGER NOT NULL DEFAULT 22,
      vacation_days INTEGER NOT NULL DEFAULT 0,
      sick_days INTEGER NOT NULL DEFAULT 0,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE UNIQUE INDEX hr_employees_tenant_code_idx
        ON hr_employees (tenant_id, code);
    CREATE UNIQUE INDEX hr_contracts_tenant_number_idx
        ON hr_contracts (tenant_id, contract_number);
  `);
  return {
    _db: db,
    async query(sql, params = []) {
      const pgStyle = sql.replace(/\$\d+/g, (m) => '?' + m.slice(1));
      const mainSchema = pgStyle.replace(/finance\./g, '');
      const stmt = db.prepare(mainSchema);
      const upper = sql.trim().toUpperCase();
      const isRead =
        upper.startsWith('SELECT') ||
        upper.startsWith('WITH') ||
        upper.includes(' RETURNING');
      if (isRead) {
        const rows = stmt.all(...params);
        return { rows };
      }
      const info = stmt.run(...params);
      return {
        rows: [],
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes,
      };
    },
  };
}

// Helper: create a hire-able employee (so tests have a
// parent for contracts).
async function makeEmployee(db, code = 'EMP-001', firstName = 'John', lastName = 'Doe') {
  const out = await addEmployee(
    db,
    {
      code,
      first_name: firstName,
      last_name: lastName,
      hire_date: '2026-01-01',
    },
    0,
  );
  return { id: Number(out.id) };
}

// Helper: create a signable contract.
async function makeContract(db, employeeId, baseSalary = 500000, number = 'C-2026-001') {
  const out = await addContract(
    db,
    {
      employee_id: employeeId,
      contract_number: number,
      start_date: '2026-01-01',
      base_salary_amd: baseSalary,
    },
    0,
  );
  return { id: Number(out.id) };
}

// ────────────────────────────────────────────────────────────────────────
// Employees
// ────────────────────────────────────────────────────────────────────────

test('hr: addEmployee inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await addEmployee(
    db,
    {
      code: 'EMP-001',
      first_name: 'Anna',
      last_name: 'Harutyunyan',
      email: 'anna@example.com',
      department: 'Finance',
      hire_date: '2026-01-15',
    },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('hr: addEmployee throws ValueError on duplicate code', async () => {
  const db = makeMemoryDb();
  await addEmployee(
    db,
    { code: 'EMP-DUP', first_name: 'A', last_name: 'B', hire_date: '2026-01-01' },
    0,
  );
  await assert.rejects(
    addEmployee(
      db,
      { code: 'EMP-DUP', first_name: 'C', last_name: 'D', hire_date: '2026-01-01' },
      0,
    ),
    /already exists/,
  );
});

test('hr: addEmployee throws ValueError when required fields missing', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    addEmployee(db, { first_name: 'A', last_name: 'B', hire_date: '2026-01-01' }, 0),
    /code must be a string/,
  );
  await assert.rejects(
    addEmployee(db, { code: 'X', last_name: 'B', hire_date: '2026-01-01' }, 0),
    /first_name must be a string/,
  );
  await assert.rejects(
    addEmployee(db, { code: 'X', first_name: 'A', hire_date: '2026-01-01' }, 0),
    /last_name must be a string/,
  );
  await assert.rejects(
    addEmployee(db, { code: 'X', first_name: 'A', last_name: 'B' }, 0),
    /hire_date/,
  );
});

test('hr: listEmployees returns all employees for the tenant (ordered by id ASC)', async () => {
  const db = makeMemoryDb();
  await addEmployee(db, { code: 'EMP-1', first_name: 'A', last_name: 'A', hire_date: '2026-01-01' }, 0);
  await addEmployee(db, { code: 'EMP-2', first_name: 'B', last_name: 'B', hire_date: '2026-02-01' }, 0);
  const rows = await listEmployees(db, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].code, 'EMP-1');
  assert.equal(rows[1].code, 'EMP-2');
});

test('hr: listEmployees filters by status + department', async () => {
  const db = makeMemoryDb();
  await addEmployee(
    db,
    { code: 'EMP-1', first_name: 'A', last_name: 'A', hire_date: '2026-01-01', department: 'Finance', status: 'active' },
    0,
  );
  await addEmployee(
    db,
    { code: 'EMP-2', first_name: 'B', last_name: 'B', hire_date: '2026-02-01', department: 'Operations', status: 'on_leave' },
    0,
  );
  const financeActive = await listEmployees(db, 0, { status: 'active', department: 'Finance' });
  assert.equal(financeActive.length, 1);
  assert.equal(financeActive[0].code, 'EMP-1');
  const onLeave = await listEmployees(db, 0, { status: 'on_leave' });
  assert.equal(onLeave.length, 1);
  assert.equal(onLeave[0].code, 'EMP-2');
});

test('hr: getEmployee returns the employee or throws ValueError', async () => {
  const db = makeMemoryDb();
  const out = await addEmployee(
    db,
    { code: 'EMP-G', first_name: 'G', last_name: 'G', hire_date: '2026-01-01' },
    0,
  );
  const r = await getEmployee(db, out.id, 0);
  assert.equal(r.code, 'EMP-G');
  assert.equal(r.status, 'active');
  await assert.rejects(getEmployee(db, 999, 0), /employee 999 not found in tenant 0/);
});

// ────────────────────────────────────────────────────────────────────────
// Contracts
// ────────────────────────────────────────────────────────────────────────

test('hr: addContract inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const out = await addContract(
    db,
    {
      employee_id: emp.id,
      contract_number: 'C-2026-001',
      start_date: '2026-01-01',
      base_salary_amd: 600000,
    },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('hr: addContract throws ValueError on missing employee', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    addContract(
      db,
      {
        employee_id: 999,
        contract_number: 'C-X',
        start_date: '2026-01-01',
        base_salary_amd: 500000,
      },
      0,
    ),
    /employee 999 not found/,
  );
});

test('hr: addContract throws ValueError on duplicate contract_number', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await addContract(
    db,
    { employee_id: emp.id, contract_number: 'C-DUP', start_date: '2026-01-01', base_salary_amd: 500000 },
    0,
  );
  await assert.rejects(
    addContract(
      db,
      { employee_id: emp.id, contract_number: 'C-DUP', start_date: '2026-02-01', base_salary_amd: 500000 },
      0,
    ),
    /already exists/,
  );
});

test('hr: addContract throws ValueError on bad currency', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await assert.rejects(
    addContract(
      db,
      { employee_id: emp.id, contract_number: 'C-BAD-CUR', start_date: '2026-01-01', base_salary_amd: 500000, currency: 'BTC' },
      0,
    ),
    /currency must be one of/,
  );
});

test('hr: listContracts returns all contracts for the tenant (ordered by id ASC)', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await addContract(db, { employee_id: emp.id, contract_number: 'C-1', start_date: '2026-01-01', base_salary_amd: 500000 }, 0);
  await addContract(db, { employee_id: emp.id, contract_number: 'C-2', start_date: '2026-02-01', base_salary_amd: 600000 }, 0);
  const rows = await listContracts(db, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].contract_number, 'C-1');
  assert.equal(rows[1].contract_number, 'C-2');
});

test('hr: listContracts filters by employeeId + status', async () => {
  const db = makeMemoryDb();
  const emp1 = await makeEmployee(db, 'EMP-1', 'A', 'A');
  const emp2 = await makeEmployee(db, 'EMP-2', 'B', 'B');
  await addContract(db, { employee_id: emp1.id, contract_number: 'C-1', start_date: '2026-01-01', base_salary_amd: 500000, status: 'active' }, 0);
  await addContract(db, { employee_id: emp1.id, contract_number: 'C-2', start_date: '2026-02-01', base_salary_amd: 600000, status: 'terminated' }, 0);
  await addContract(db, { employee_id: emp2.id, contract_number: 'C-3', start_date: '2026-03-01', base_salary_amd: 700000, status: 'active' }, 0);
  const emp1Active = await listContracts(db, 0, { employeeId: emp1.id, status: 'active' });
  assert.equal(emp1Active.length, 1);
  assert.equal(emp1Active[0].contract_number, 'C-1');
  const emp1All = await listContracts(db, 0, { employeeId: emp1.id });
  assert.equal(emp1All.length, 2);
});

test('hr: getContract returns the contract or throws ValueError', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const out = await addContract(db, { employee_id: emp.id, contract_number: 'C-G', start_date: '2026-01-01', base_salary_amd: 500000 }, 0);
  const r = await getContract(db, out.id, 0);
  assert.equal(r.contract_number, 'C-G');
  assert.equal(r.currency, 'AMD');
  assert.equal(r.status, 'active');
  await assert.rejects(getContract(db, 999, 0), /contract 999 not found in tenant 0/);
});

// ────────────────────────────────────────────────────────────────────────
// Payroll runs
// ────────────────────────────────────────────────────────────────────────

test('hr: createPayrollRun inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await createPayrollRun(
    db,
    { period_year: 2026, period_month: 1, notes: 'January 2026 payroll' },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('hr: createPayrollRun throws ValueError on duplicate (year, month)', async () => {
  const db = makeMemoryDb();
  await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  await assert.rejects(
    createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0),
    /already exists for 2026-01/,
  );
});

test('hr: createPayrollRun throws ValueError on bad period', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createPayrollRun(db, { period_year: 1999, period_month: 1 }, 0),
    /period_year must be between/,
  );
  await assert.rejects(
    createPayrollRun(db, { period_year: 2026, period_month: 13 }, 0),
    /period_month must be between/,
  );
});

test('hr: addPayrollLine inserts a row + recomputes run totals', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const contract = await makeContract(db, emp.id, 600000);
  const run = await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  const out = await addPayrollLine(
    db,
    {
      payroll_run_id: run.id,
      employee_id: emp.id,
      contract_id: contract.id,
      base_salary_amd: 600000,
      bonus_amd: 50000,
      deductions_amd: 10000,
      tax_amd: 60000,
      worked_days: 22,
      vacation_days: 0,
      sick_days: 0,
    },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
  const runRefreshed = db._db.prepare(
    'SELECT total_gross_amd, total_net_amd, total_tax_amd, employee_count FROM hr_payroll_runs WHERE id = ?',
  ).get(run.id);
  assert.equal(runRefreshed.total_gross_amd, 650000); // 600000 + 50000
  assert.equal(runRefreshed.total_tax_amd, 60000);
  assert.equal(runRefreshed.employee_count, 1);
  // net = 600000 + 50000 - 10000 - 60000 = 580000
  assert.equal(runRefreshed.total_net_amd, 580000);
});

test('hr: addPayrollLine throws ValueError when run is not draft', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const contract = await makeContract(db, emp.id);
  const run = await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  // Manually update the run to approved (simulating post-approval)
  db._db.prepare("UPDATE hr_payroll_runs SET status = 'approved' WHERE id = ?").run(run.id);
  await assert.rejects(
    addPayrollLine(
      db,
      {
        payroll_run_id: run.id,
        employee_id: emp.id,
        contract_id: contract.id,
        base_salary_amd: 500000,
      },
      0,
    ),
    /cannot add lines to a non-draft run/,
  );
});

test('hr: addPayrollLine throws ValueError on negative net pay', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const contract = await makeContract(db, emp.id);
  const run = await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  await assert.rejects(
    addPayrollLine(
      db,
      {
        payroll_run_id: run.id,
        employee_id: emp.id,
        contract_id: contract.id,
        base_salary_amd: 500000,
        deductions_amd: 600000,
      },
      0,
    ),
    /net_pay_amd.*would be negative/,
  );
});

test('hr: addPayrollLine accumulates totals across multiple lines', async () => {
  const db = makeMemoryDb();
  const emp1 = await makeEmployee(db, 'EMP-1', 'A', 'A');
  const emp2 = await makeEmployee(db, 'EMP-2', 'B', 'B');
  const contract1 = await makeContract(db, emp1.id, 500000, 'C-1');
  const contract2 = await makeContract(db, emp2.id, 600000, 'C-2');
  const run = await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  await addPayrollLine(db, { payroll_run_id: run.id, employee_id: emp1.id, contract_id: contract1.id, base_salary_amd: 500000, bonus_amd: 0, deductions_amd: 0, tax_amd: 50000 }, 0);
  await addPayrollLine(db, { payroll_run_id: run.id, employee_id: emp2.id, contract_id: contract2.id, base_salary_amd: 600000, bonus_amd: 50000, deductions_amd: 0, tax_amd: 65000 }, 0);
  const runRefreshed = db._db.prepare(
    'SELECT total_gross_amd, total_net_amd, total_tax_amd, employee_count FROM hr_payroll_runs WHERE id = ?',
  ).get(run.id);
  assert.equal(runRefreshed.total_gross_amd, 1150000); // 500000 + 600000+50000
  assert.equal(runRefreshed.total_tax_amd, 115000); // 50000 + 65000
  assert.equal(runRefreshed.employee_count, 2);
  // net1 = 500000 - 50000 = 450000
  // net2 = 600000 + 50000 - 65000 = 585000
  // total = 1035000
  assert.equal(runRefreshed.total_net_amd, 1035000);
});

test('hr: listPayrollRuns returns all runs for the tenant (most recent first)', async () => {
  const db = makeMemoryDb();
  await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  await createPayrollRun(db, { period_year: 2026, period_month: 2 }, 0);
  const rows = await listPayrollRuns(db, 0);
  assert.equal(rows.length, 2);
  // Most recent first: 2026-02 before 2026-01
  assert.equal(rows[0].period_month, 2);
  assert.equal(rows[1].period_month, 1);
});

test('hr: listPayrollRuns filters by status + periodYear', async () => {
  const db = makeMemoryDb();
  await createPayrollRun(db, { period_year: 2026, period_month: 1 }, 0);
  await createPayrollRun(db, { period_year: 2026, period_month: 2 }, 0);
  await createPayrollRun(db, { period_year: 2025, period_month: 12 }, 0);
  // Manually void the December 2025 run
  db._db.prepare("UPDATE hr_payroll_runs SET status = 'voided' WHERE period_year = 2025 AND period_month = 12").run();
  const draft2026 = await listPayrollRuns(db, 0, { status: 'draft', periodYear: 2026 });
  assert.equal(draft2026.length, 2);
  const voided = await listPayrollRuns(db, 0, { status: 'voided' });
  assert.equal(voided.length, 1);
  assert.equal(voided[0].period_year, 2025);
});// ────────────────────────────────────────────────────────────────────────
// Employee status transitions (W95-1 — wave 3)
// ────────────────────────────────────────────────────────────────────────

test('hr: suspendEmployee flips active → suspended', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const out = await suspendEmployee(db, emp.id, { user_id: 1 }, 0);
  assert.equal(out.status, 'suspended');
  const refreshed = db._db.prepare('SELECT status, suspended_by FROM hr_employees WHERE id = ?').get(emp.id);
  assert.equal(refreshed.status, 'suspended');
  assert.equal(refreshed.suspended_by, 1);
});

test('hr: suspendEmployee throws on already-suspended', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await suspendEmployee(db, emp.id, { user_id: 1 }, 0);
  await assert.rejects(
    suspendEmployee(db, emp.id, { user_id: 1 }, 0),
    /already suspended/,
  );
});

test('hr: suspendEmployee throws on terminated employee', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await terminateEmployee(db, emp.id, { user_id: 1 }, 0);
  await assert.rejects(
    suspendEmployee(db, emp.id, { user_id: 1 }, 0),
    /is terminated/,
  );
});

test('hr: reactivateEmployee flips suspended → active + clears audit', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await suspendEmployee(db, emp.id, { user_id: 1 }, 0);
  const out = await reactivateEmployee(db, emp.id, { user_id: 1 }, 0);
  assert.equal(out.status, 'active');
  const refreshed = db._db.prepare('SELECT status, suspended_at, suspended_by FROM hr_employees WHERE id = ?').get(emp.id);
  assert.equal(refreshed.status, 'active');
  assert.equal(refreshed.suspended_at, null);
  assert.equal(refreshed.suspended_by, null);
});

test('hr: reactivateEmployee throws on already-active', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await assert.rejects(
    reactivateEmployee(db, emp.id, { user_id: 1 }, 0),
    /already active/,
  );
});

test('hr: reactivateEmployee throws on terminated employee', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await terminateEmployee(db, emp.id, { user_id: 1 }, 0);
  await assert.rejects(
    reactivateEmployee(db, emp.id, { user_id: 1 }, 0),
    /is terminated/,
  );
});

test('hr: setEmployeeOnLeave flips active → on_leave + stamps audit fields', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const out = await setEmployeeOnLeave(
    db,
    emp.id,
    { user_id: 1, expected_return_date: '2026-08-01', reason: 'maternity leave' },
    0,
  );
  assert.equal(out.status, 'on_leave');
  const refreshed = db._db.prepare(
    'SELECT status, on_leave_until, on_leave_reason FROM hr_employees WHERE id = ?',
  ).get(emp.id);
  assert.equal(refreshed.status, 'on_leave');
  assert.equal(refreshed.on_leave_until, '2026-08-01');
  assert.equal(refreshed.on_leave_reason, 'maternity leave');
});

test('hr: setEmployeeOnLeave throws on already-on-leave', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await setEmployeeOnLeave(db, emp.id, { user_id: 1 }, 0);
  await assert.rejects(
    setEmployeeOnLeave(db, emp.id, { user_id: 1 }, 0),
    /already on leave/,
  );
});

test('hr: setEmployeeOnLeave throws on suspended (must reactivate first)', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await suspendEmployee(db, emp.id, { user_id: 1 }, 0);
  await assert.rejects(
    setEmployeeOnLeave(db, emp.id, { user_id: 1 }, 0),
    /is suspended/,
  );
});

test('hr: terminateEmployee flips any → terminated + stamps termination_date', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  const out = await terminateEmployee(
    db,
    emp.id,
    { user_id: 1, reason: 'resigned', termination_date: '2026-06-21' },
    0,
  );
  assert.equal(out.status, 'terminated');
  const refreshed = db._db.prepare(
    'SELECT status, termination_date, termination_reason FROM hr_employees WHERE id = ?',
  ).get(emp.id);
  assert.equal(refreshed.status, 'terminated');
  assert.equal(refreshed.termination_date, '2026-06-21');
  assert.equal(refreshed.termination_reason, 'resigned');
});

test('hr: terminateEmployee defaults termination_date to today when not provided', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await terminateEmployee(db, emp.id, { user_id: 1 }, 0);
  const refreshed = db._db.prepare(
    'SELECT termination_date FROM hr_employees WHERE id = ?',
  ).get(emp.id);
  // Should be today's date (YYYY-MM-DD format)
  const today = new Date().toISOString().slice(0, 10);
  assert.equal(refreshed.termination_date, today);
});

test('hr: terminateEmployee throws on already-terminated', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  await terminateEmployee(db, emp.id, { user_id: 1 }, 0);
  await assert.rejects(
    terminateEmployee(db, emp.id, { user_id: 1 }, 0),
    /already terminated/,
  );
});

test('hr: full state machine cycle: active → suspended → active → on_leave → terminated', async () => {
  const db = makeMemoryDb();
  const emp = await makeEmployee(db);
  // 1. active → suspended
  let out = await suspendEmployee(db, emp.id, { user_id: 1 }, 0);
  assert.equal(out.status, 'suspended');
  // 2. suspended → active (reactivate)
  out = await reactivateEmployee(db, emp.id, { user_id: 1 }, 0);
  assert.equal(out.status, 'active');
  // 3. active → on_leave
  out = await setEmployeeOnLeave(db, emp.id, { user_id: 1, reason: 'sabbatical' }, 0);
  assert.equal(out.status, 'on_leave');
  // 4. on_leave → terminated
  out = await terminateEmployee(db, emp.id, { user_id: 1, reason: 'career change' }, 0);
  assert.equal(out.status, 'terminated');
});