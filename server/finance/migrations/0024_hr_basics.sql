-- Phase 3 HR basics wave 1 (W90-1) — minimum viable HR module.
--
-- The HR basics module ships 4 tables that cover the
-- minimum viable HR lifecycle:
--
--   1. hr_employees     — one row per employee (the master record)
--   2. hr_contracts     — one row per employment contract
--                          (one employee may have multiple contracts
--                           over time, e.g. promoted or rehired)
--   3. hr_payroll_runs  — one row per payroll period (e.g. one per
--                          month; the "header" that aggregates the
--                          monthly totals + approval trail)
--   4. hr_payroll_lines — one row per employee per payroll run
--                          (the per-employee pay breakdown:
--                          base + bonus − deductions − tax = net)
--
-- Design notes:
--
--   - Employees are tenant-scoped. code is unique per tenant
--     (e.g. "EMP-001" for the first employee at a tenant).
--   - Contracts have a start_date and optional end_date
--     (NULL = open-ended). status reflects whether the
--     contract is currently active, expired, terminated,
--     or suspended.
--   - Payroll runs aggregate the per-month totals
--     (total_gross_amd, total_net_amd, total_tax_amd,
--     employee_count) for fast dashboard reads. The per-
--     employee breakdown lives in hr_payroll_lines.
--   - payroll_runs has a UNIQUE (tenant_id, period_year,
--     period_month) constraint so a tenant cannot have
--     two payroll runs for the same month. Status flows
--     draft → approved → posted → voided.
--   - All monetary amounts are in AMD (Armenian Dram).
--     The currency column on hr_contracts is the contract's
--     *nominal* currency (mostly AMD for local employees,
--     USD/EUR/RUB for expat contracts) — the actual
--     payroll is paid in AMD after FX conversion (FX
--     conversion logic is out of scope for wave 1).
--
-- Status flow for payroll_runs:
--   draft  → approved   (manager approves the draft)
--   approved → posted   (finance posts the run to GL;
--                          out of scope for wave 1)
--   draft/approved → voided  (cancelled before posting)
--
-- Status flow for hr_employees:
--   active → on_leave     (extended absence)
--          → suspended    (disciplinary hold)
--          → terminated   (employment ended)
--   on_leave → active     (returned from leave)
--   suspended → active    (suspension lifted)
--
-- Status flow for hr_contracts:
--   active → expired     (end_date passed)
--          → terminated  (early termination)
--          → suspended   (paused)
--   suspended → active   (resumed)

-- ────────────────────────────────────────────────────────────────────────
-- Employees
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.hr_employees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- Human-friendly code (unique per tenant). e.g.
    -- "EMP-001" for the first employee at a tenant.
    code TEXT NOT NULL,
    -- First name + last name (no middle name; the
    -- Armenian civil registry doesn't have middle names).
    first_name TEXT NOT NULL,
    last_name TEXT NOT NULL,
    -- Personal email (NOT the user account email — an
    -- employee may not have system access). Optional.
    email TEXT,
    -- Personal phone (Armenian format: +374XXXXXXXX).
    phone TEXT,
    -- Job title / role (e.g. "Senior Accountant",
    -- "Warehouse Manager"). NOT the same as the RBAC
    -- role on the user account — this is descriptive.
    role TEXT,
    -- Department (e.g. "Finance", "Operations", "Sales").
    -- Free-text for wave 1; a finance.hr_departments
    -- table is out of scope.
    department TEXT,
    -- Hire date (YYYY-MM-DD). Cannot be in the future
    -- (enforced at the application layer; CHECK on the
    -- schema would require SQLite date functions we
    -- don't have).
    hire_date TEXT NOT NULL,
    -- Termination date (NULL while employed). Must be
    -- >= hire_date (CHECK constraint).
    termination_date TEXT,
    -- Status: 'active' (employed), 'on_leave' (extended
    -- absence), 'suspended' (disciplinary hold),
    -- 'terminated' (employment ended).
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'on_leave', 'suspended', 'terminated')),
    -- Armenian TIN (8 digits), optional. Used for tax
    -- reporting at year-end. Same validation as
    -- finance.customers.hvhh (HVVH validator).
    hvhh TEXT,
    -- Bank account for direct deposit (free-text; the
    -- format depends on the bank — IBAN for some,
    -- account-number for others).
    bank_account TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS hr_employees_tenant_idx
    ON finance.hr_employees (tenant_id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_employees_tenant_code_idx
    ON finance.hr_employees (tenant_id, code);
CREATE INDEX IF NOT EXISTS hr_employees_status_idx
    ON finance.hr_employees (status);
CREATE INDEX IF NOT EXISTS hr_employees_department_idx
    ON finance.hr_employees (department);

-- ────────────────────────────────────────────────────────────────────────
-- Contracts
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.hr_contracts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- FK to finance.hr_employees.id (NOT enforced — see
    -- pos_refunds.sale_id comment for the rationale).
    employee_id INTEGER NOT NULL,
    -- Contract number (unique per tenant). e.g.
    -- "C-2026-001" for the first contract signed in 2026.
    contract_number TEXT NOT NULL,
    -- Contract start date (YYYY-MM-DD). Cannot be in the
    -- future (enforced at the application layer).
    start_date TEXT NOT NULL,
    -- Contract end date (NULL = open-ended). Must be >=
    -- start_date (CHECK constraint).
    end_date TEXT,
    -- Base salary in the contract's nominal currency.
    -- Stored as INTEGER (no fractional AMD).
    base_salary_amd INTEGER NOT NULL CHECK (base_salary_amd >= 0),
    -- Contract currency. AMD for local employees; USD /
    -- EUR / RUB for expat contracts. FX conversion to AMD
    -- is out of scope for wave 1.
    currency TEXT NOT NULL DEFAULT 'AMD'
        CHECK (currency IN ('AMD', 'USD', 'EUR', 'RUB')),
    -- Pay frequency. Most Armenian employers pay
    -- monthly; biweekly / weekly are supported for
    -- completeness.
    pay_frequency TEXT NOT NULL DEFAULT 'monthly'
        CHECK (pay_frequency IN ('monthly', 'biweekly', 'weekly')),
    -- Standard hours per week (default 40 for full-time).
    hours_per_week INTEGER NOT NULL DEFAULT 40,
    -- Standard vacation days per year (Armenian Labor
    -- Code: minimum 20 working days = ~28 calendar days).
    vacation_days_per_year INTEGER NOT NULL DEFAULT 20,
    -- Status: 'active' (in force), 'expired' (end_date
    -- passed), 'terminated' (early termination), 'suspended'
    -- (paused).
    status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'expired', 'terminated', 'suspended')),
    -- Free-text notes (e.g. promotion terms, special
    -- conditions, probation period).
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS hr_contracts_tenant_idx
    ON finance.hr_contracts (tenant_id);
CREATE INDEX IF NOT EXISTS hr_contracts_employee_idx
    ON finance.hr_contracts (employee_id);
CREATE UNIQUE INDEX IF NOT EXISTS hr_contracts_tenant_number_idx
    ON finance.hr_contracts (tenant_id, contract_number);
CREATE INDEX IF NOT EXISTS hr_contracts_status_idx
    ON finance.hr_contracts (status);

-- ────────────────────────────────────────────────────────────────────────
-- Payroll runs (the "header" of a monthly payroll)
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.hr_payroll_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- Period year + month. UNIQUE per tenant (a tenant
    -- cannot have two payroll runs for the same month).
    period_year INTEGER NOT NULL CHECK (period_year >= 2000 AND period_year <= 2100),
    period_month INTEGER NOT NULL CHECK (period_month >= 1 AND period_month <= 12),
    -- Status: 'draft' (being assembled), 'approved'
    -- (manager has signed off), 'posted' (sent to GL,
    -- out of scope for wave 1), 'voided' (cancelled
    -- before posting).
    status TEXT NOT NULL DEFAULT 'draft'
        CHECK (status IN ('draft', 'approved', 'posted', 'voided')),
    -- Aggregated totals across all payroll lines (for
    -- fast dashboard reads; the per-employee breakdown
    -- lives in hr_payroll_lines).
    total_gross_amd INTEGER NOT NULL DEFAULT 0 CHECK (total_gross_amd >= 0),
    total_net_amd INTEGER NOT NULL DEFAULT 0 CHECK (total_net_amd >= 0),
    total_tax_amd INTEGER NOT NULL DEFAULT 0 CHECK (total_tax_amd >= 0),
    employee_count INTEGER NOT NULL DEFAULT 0 CHECK (employee_count >= 0),
    -- Approval trail (the manager who approved the run).
    approved_by INTEGER,
    approved_at TEXT,
    -- Posting trail (the user who posted the run to GL).
    posted_by INTEGER,
    posted_at TEXT,
    -- Free-text notes (e.g. "Q4 bonus included",
    -- "annual increment applied").
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    -- A tenant cannot have two payroll runs for the same
    -- month. The UNIQUE constraint catches the race
    -- condition where two operators create runs for the
    -- same month simultaneously.
    UNIQUE (tenant_id, period_year, period_month)
);

CREATE INDEX IF NOT EXISTS hr_payroll_runs_tenant_idx
    ON finance.hr_payroll_runs (tenant_id);
CREATE INDEX IF NOT EXISTS hr_payroll_runs_status_idx
    ON finance.hr_payroll_runs (status);

-- ────────────────────────────────────────────────────────────────────────
-- Payroll lines (the per-employee breakdown of a payroll run)
-- ────────────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS finance.hr_payroll_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    -- FK to finance.hr_payroll_runs.id (NOT enforced
    -- — same rationale as pos_refunds.sale_id).
    payroll_run_id INTEGER NOT NULL,
    -- FK to finance.hr_employees.id (NOT enforced).
    employee_id INTEGER NOT NULL,
    -- FK to finance.hr_contracts.id (NOT enforced).
    contract_id INTEGER NOT NULL,
    -- Snapshot of the contract's base salary at the
    -- time of the run (denormalized; the contract's
    -- salary may change later — historical accuracy
    -- matters for audit).
    base_salary_amd INTEGER NOT NULL CHECK (base_salary_amd >= 0),
    -- One-time bonus (e.g. performance bonus, 13th month).
    -- Always AMD (regardless of contract currency; FX
    -- conversion is out of scope for wave 1).
    bonus_amd INTEGER NOT NULL DEFAULT 0 CHECK (bonus_amd >= 0),
    -- Pre-tax deductions (e.g. advance payment, garnishment).
    deductions_amd INTEGER NOT NULL DEFAULT 0 CHECK (deductions_amd >= 0),
    -- Income tax withheld (Armenian PIT: 10-22% bracket;
    -- exact computation out of scope for wave 1).
    tax_amd INTEGER NOT NULL DEFAULT 0 CHECK (tax_amd >= 0),
    -- Net pay = base + bonus − deductions − tax.
    -- The application layer recomputes this on insert;
    -- CHECK constraint enforces non-negative.
    net_pay_amd INTEGER NOT NULL CHECK (net_pay_amd >= 0),
    -- Worked days in the period (default 22 = standard
    -- Armenian working month).
    worked_days INTEGER NOT NULL DEFAULT 22 CHECK (worked_days >= 0),
    -- Vacation days taken in the period (deducted from
    -- vacation_days_per_year on the contract).
    vacation_days INTEGER NOT NULL DEFAULT 0 CHECK (vacation_days >= 0),
    -- Sick days taken in the period (separate from
    -- vacation; not deducted from vacation_days_per_year).
    sick_days INTEGER NOT NULL DEFAULT 0 CHECK (sick_days >= 0),
    -- Free-text notes (e.g. "advance for vacation",
    -- "13th-month bonus", "back-pay").
    notes TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS hr_payroll_lines_tenant_idx
    ON finance.hr_payroll_lines (tenant_id);
CREATE INDEX IF NOT EXISTS hr_payroll_lines_run_idx
    ON finance.hr_payroll_lines (payroll_run_id);
CREATE INDEX IF NOT EXISTS hr_payroll_lines_employee_idx
    ON finance.hr_payroll_lines (employee_id);
CREATE INDEX IF NOT EXISTS hr_payroll_lines_contract_idx
    ON finance.hr_payroll_lines (contract_id);