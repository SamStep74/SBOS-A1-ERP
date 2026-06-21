-- 0012_projects.sql
-- Projects (project management: projects, tasks,
-- time entries) foundation for Phase 2 of the
-- ERP plan. Ported from packages/erp/src/projects/*.ts
-- in A1-Suite-Local (the user's private R&D
-- monorepo). All orgId references renamed to
-- tenant_id for consistency with the rest of
-- SBOS-A1-ERP.
--
-- Tables:
--   projects              — the project (status: active
--                           / on_hold / completed /
--                           cancelled)
--   project_tasks         — tasks under a project
--                           (status: todo / in_progress
--                           / done / blocked; priority:
--                           low / normal / high / urgent)
--   project_time_entries  — time tracking entries on
--                           tasks (user_id, work_date,
--                           hours, billable flag)
--
-- The pure functions use these tables in the
-- obvious way:
--   createProject(db, input, tenantId)
--   listProjects(db, tenantId, status?)
--   getProject(db, projectId, tenantId)
--   createTask(db, input, tenantId)        — checks project exists
--   listTasks(db, projectId, tenantId, status?)
--   getTask(db, taskId, tenantId)
--   createTimeEntry(db, input, tenantId)  — checks task exists
--   listTimeEntries(db, taskId, tenantId)
--
-- The customer_id is OPTIONAL (a project may be
-- internal; e.g. an R&D project, not tied to a
-- paying customer). The owner_id and assignee_id
-- reference the users table (not enforced as FK
-- because the users table is in a different
-- migration).
--
-- Phase 2 projects wave 1 (W74-1): schema + pure
-- functions + tests. Wave 2 (future): route
-- wiring + permission keys + smoke check.

-- ───────────── Projects ─────────────

CREATE TABLE IF NOT EXISTS finance.projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  -- Human-friendly code (e.g. "PROJ-2026-001").
  -- Optional; the unique index is partial
  -- (only non-null values are constrained).
  code TEXT,
  name TEXT NOT NULL,
  description TEXT,
  -- Optional FK to finance.customers
  customer_id INTEGER,
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','on_hold','completed','cancelled')),
  start_date TEXT,
  end_date TEXT,
  -- The project owner (a user.id from the
  -- users table; not enforced as FK because
  -- the users table is in a different
  -- migration).
  owner_id INTEGER,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS projects_tenant_idx
    ON finance.projects (tenant_id);
CREATE INDEX IF NOT EXISTS projects_status_idx
    ON finance.projects (status);
CREATE INDEX IF NOT EXISTS projects_customer_idx
    ON finance.projects (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS projects_code_idx
    ON finance.projects (tenant_id, code)
    WHERE code IS NOT NULL;

-- ───────────── Tasks ─────────────

CREATE TABLE IF NOT EXISTS finance.project_tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  project_id INTEGER NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  status TEXT NOT NULL DEFAULT 'todo'
    CHECK (status IN ('todo','in_progress','done','blocked')),
  priority TEXT NOT NULL DEFAULT 'normal'
    CHECK (priority IN ('low','normal','high','urgent')),
  assignee_id INTEGER,
  due_date TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS project_tasks_tenant_idx
    ON finance.project_tasks (tenant_id);
CREATE INDEX IF NOT EXISTS project_tasks_project_idx
    ON finance.project_tasks (project_id);
CREATE INDEX IF NOT EXISTS project_tasks_status_idx
    ON finance.project_tasks (status);
CREATE INDEX IF NOT EXISTS project_tasks_assignee_idx
    ON finance.project_tasks (assignee_id);

-- ───────────── Time entries ─────────────

CREATE TABLE IF NOT EXISTS finance.project_time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  tenant_id INTEGER NOT NULL,
  task_id INTEGER NOT NULL,
  -- The user who logged the time (a users.id;
  -- not enforced as FK because users is in a
  -- different migration).
  user_id INTEGER NOT NULL,
  -- The work date (YYYY-MM-DD string).
  work_date TEXT NOT NULL,
  -- The hours logged (NUMERIC with 2 decimal
  -- places; sqlite stores as REAL but we
  -- validate the precision at the pure
  -- function layer).
  hours REAL NOT NULL CHECK (hours > 0 AND hours <= 24),
  -- Whether the time is billable to the
  -- customer (default: true).
  billable INTEGER NOT NULL DEFAULT 1
    CHECK (billable IN (0, 1)),
  description TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS project_time_entries_tenant_idx
    ON finance.project_time_entries (tenant_id);
CREATE INDEX IF NOT EXISTS project_time_entries_task_idx
    ON finance.project_time_entries (task_id);
CREATE INDEX IF NOT EXISTS project_time_entries_user_idx
    ON finance.project_time_entries (user_id);
CREATE INDEX IF NOT EXISTS project_time_entries_date_idx
    ON finance.project_time_entries (work_date);
