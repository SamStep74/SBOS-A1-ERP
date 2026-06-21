// Projects (project management) — Phase 2 wave 1.
//
// Ported from packages/erp/src/projects/*.ts in
// A1-Suite-Local (the user's private R&D monorepo).
// The pure-function layer threads tenant_id into
// every read and write.
//
// This module ships the minimum-viable projects:
//   - projects             — the project (status:
//                            active / on_hold /
//                            completed / cancelled)
//   - project_tasks        — tasks under a project
//                            (status: todo / in_progress
//                            / done / blocked; priority:
//                            low / normal / high / urgent)
//   - project_time_entries — time tracking on tasks
//                            (user_id, work_date, hours,
//                            billable flag)
//
// Phase 2 projects wave 1 (W74-1): schema + pure
// functions + tests. Wave 2 (future): route wiring
// + permission keys + smoke check.

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// ────────────────────────────────────────────────────────────────────────
// DB adapter helper (matches the pattern in customer.js /
// inventory.js / crm.js / desk.js)
// ────────────────────────────────────────────────────────────────────────

async function runQuery(db, sql, params) {
  // The production adapter is a pg-style adapter (rows property,
  // $N placeholders). The test adapter uses $N too (the test
  // helper translates $N → ?). The projects pure functions
  // speak the production shape.
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

const PROJECT_STATUSES = ['active', 'on_hold', 'completed', 'cancelled'];
const TASK_STATUSES = ['todo', 'in_progress', 'done', 'blocked'];
const TASK_PRIORITIES = ['low', 'normal', 'high', 'urgent'];

function assertString(value, name, { min = 1, max = 8192 } = {}) {
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

function assertOptionalInt(value, name) {
  if (value === null || value === undefined) return;
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer`);
  }
}

function assertProjectStatus(value) {
  if (value === null || value === undefined) return;
  if (!PROJECT_STATUSES.includes(value)) {
    throw new ValueError(`project status must be one of: ${PROJECT_STATUSES.join(', ')}`);
  }
}

function assertTaskStatus(value) {
  if (value === null || value === undefined) return;
  if (!TASK_STATUSES.includes(value)) {
    throw new ValueError(`task status must be one of: ${TASK_STATUSES.join(', ')}`);
  }
}

function assertTaskPriority(value) {
  if (value === null || value === undefined) return;
  if (!TASK_PRIORITIES.includes(value)) {
    throw new ValueError(`task priority must be one of: ${TASK_PRIORITIES.join(', ')}`);
  }
}

function assertDateString(value, name) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValueError(`${name} must be a date string in YYYY-MM-DD format`);
  }
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertHours(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValueError('hours must be a finite number');
  }
  if (value <= 0 || value > 24) {
    throw new ValueError('hours must be > 0 and <= 24');
  }
  // Allow up to 2 decimal places of precision.
  if (Math.round(value * 100) !== value * 100) {
    throw new ValueError('hours must be a number with at most 2 decimal places');
  }
}

function assertBillable(value) {
  if (value !== 0 && value !== 1 && value !== true && value !== false) {
    throw new ValueError('billable must be 0, 1, true, or false');
  }
}

function validateCreateProjectInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('project input is required');
  }
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalString(input.code, 'code', { max: 64 });
  assertOptionalString(input.description, 'description', { max: 8192 });
  assertOptionalInt(input.customer_id, 'customer_id');
  assertProjectStatus(input.status);
  assertDateString(input.start_date, 'start_date');
  assertDateString(input.end_date, 'end_date');
  assertOptionalInt(input.owner_id, 'owner_id');
}

function validateCreateTaskInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('task input is required');
  }
  assertPositiveInt(input.project_id, 'project_id');
  assertString(input.name, 'name', { min: 1, max: 255 });
  assertOptionalString(input.description, 'description', { max: 8192 });
  assertTaskStatus(input.status);
  assertTaskPriority(input.priority);
  assertOptionalInt(input.assignee_id, 'assignee_id');
  assertDateString(input.due_date, 'due_date');
}

function validateCreateTimeEntryInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('time entry input is required');
  }
  assertPositiveInt(input.task_id, 'task_id');
  assertPositiveInt(input.user_id, 'user_id');
  assertString(input.work_date, 'work_date', { min: 10, max: 10 });
  assertHours(input.hours);
  if (input.billable !== undefined) assertBillable(input.billable);
  assertOptionalString(input.description, 'description', { max: 8192 });
}

// ────────────────────────────────────────────────────────────────────────
// Projects
// ────────────────────────────────────────────────────────────────────────

export async function createProject(db, input, tenantId = 0) {
  validateCreateProjectInput(input);
  const ins = await runQuery(
    db,
    `INSERT INTO finance.projects
       (tenant_id, code, name, description, customer_id,
        status, start_date, end_date, owner_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id`,
    [
      tenantId,
      input.code ?? null,
      input.name,
      input.description ?? null,
      input.customer_id ?? null,
      input.status ?? 'active',
      input.start_date ?? null,
      input.end_date ?? null,
      input.owner_id ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listProjects(db, tenantId = 0, status = null) {
  // Order by id DESC (most recent first; consistent
  // with listCases / listLeads / listInvoices).
  let result;
  if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, code, name, customer_id, status,
              start_date, end_date, owner_id,
              created_at, updated_at
         FROM finance.projects
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id DESC`,
      [tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, code, name, customer_id, status,
              start_date, end_date, owner_id,
              created_at, updated_at
         FROM finance.projects
        WHERE tenant_id = $1
        ORDER BY id DESC`,
      [tenantId],
    );
  }
  return result.rows;
}

export async function getProject(db, projectId, tenantId = 0) {
  assertPositiveInt(projectId, 'projectId');
  const result = await runQuery(
    db,
    `SELECT id, code, name, description, customer_id,
            status, start_date, end_date, owner_id,
            created_at, updated_at
       FROM finance.projects
      WHERE id = $1 AND tenant_id = $2`,
    [projectId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`project ${projectId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

// ────────────────────────────────────────────────────────────────────────
// Tasks
// ────────────────────────────────────────────────────────────────────────

export async function createTask(db, input, tenantId = 0) {
  validateCreateTaskInput(input);
  // Verify the project exists in the tenant
  // (so the FK reference is valid; we don't
  // have a real FK because project_tasks is
  // in a separate migration).
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.projects
      WHERE id = $1 AND tenant_id = $2`,
    [input.project_id, tenantId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(`project ${input.project_id} not found in tenant ${tenantId}`);
  }
  const ins = await runQuery(
    db,
    `INSERT INTO finance.project_tasks
       (tenant_id, project_id, name, description,
        status, priority, assignee_id, due_date)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id`,
    [
      tenantId,
      input.project_id,
      input.name,
      input.description ?? null,
      input.status ?? 'todo',
      input.priority ?? 'normal',
      input.assignee_id ?? null,
      input.due_date ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listTasks(db, projectId, tenantId = 0, status = null) {
  assertPositiveInt(projectId, 'projectId');
  // Verify the project exists in the tenant
  // (consistent with the listReplies pattern
  // in desk.js; existence check prevents an
  // empty-array response on a missing project
  // from masking a real client bug).
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.projects
      WHERE id = $1 AND tenant_id = $2`,
    [projectId, tenantId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(`project ${projectId} not found in tenant ${tenantId}`);
  }
  let result;
  if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, project_id, name, status, priority,
              assignee_id, due_date,
              created_at, updated_at
         FROM finance.project_tasks
        WHERE project_id = $1 AND tenant_id = $2
          AND status = $3
        ORDER BY id ASC`,
      [projectId, tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, project_id, name, status, priority,
              assignee_id, due_date,
              created_at, updated_at
         FROM finance.project_tasks
        WHERE project_id = $1 AND tenant_id = $2
        ORDER BY id ASC`,
      [projectId, tenantId],
    );
  }
  return result.rows;
}

export async function getTask(db, taskId, tenantId = 0) {
  assertPositiveInt(taskId, 'taskId');
  const result = await runQuery(
    db,
    `SELECT id, project_id, name, description, status,
            priority, assignee_id, due_date,
            created_at, updated_at
       FROM finance.project_tasks
      WHERE id = $1 AND tenant_id = $2`,
    [taskId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`task ${taskId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

// ────────────────────────────────────────────────────────────────────────
// Time entries
// ────────────────────────────────────────────────────────────────────────

export async function createTimeEntry(db, input, tenantId = 0) {
  validateCreateTimeEntryInput(input);
  // Verify the task exists in the tenant.
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.project_tasks
      WHERE id = $1 AND tenant_id = $2`,
    [input.task_id, tenantId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(`task ${input.task_id} not found in tenant ${tenantId}`);
  }
  // Normalize billable to 0/1 (the schema CHECK
  // constraint requires integer; the API layer
  // may send true/false).
  let billable = 1;
  if (input.billable === false || input.billable === 0) billable = 0;
  const ins = await runQuery(
    db,
    `INSERT INTO finance.project_time_entries
       (tenant_id, task_id, user_id, work_date, hours,
        billable, description)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tenantId,
      input.task_id,
      input.user_id,
      input.work_date,
      input.hours,
      billable,
      input.description ?? null,
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(
      db,
      'SELECT LAST_INSERT_ROWID()',
      [],
    );
    id = Number(lastId.rows[0].id);
  }
  return { id };
}

export async function listTimeEntries(db, taskId, tenantId = 0) {
  assertPositiveInt(taskId, 'taskId');
  // Verify the task exists in the tenant
  // (consistent with the listReplies pattern).
  const existing = await runQuery(
    db,
    `SELECT id FROM finance.project_tasks
      WHERE id = $1 AND tenant_id = $2`,
    [taskId, tenantId],
  );
  if (!existing.rows || existing.rows.length === 0) {
    throw new ValueError(`task ${taskId} not found in tenant ${tenantId}`);
  }
  const result = await runQuery(
    db,
    `SELECT id, task_id, user_id, work_date, hours,
            billable, description, created_at
       FROM finance.project_time_entries
      WHERE task_id = $1 AND tenant_id = $2
      ORDER BY work_date ASC, id ASC`,
    [taskId, tenantId],
  );
  return result.rows;
}
