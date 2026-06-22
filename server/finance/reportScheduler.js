// Phase 3 reporting wave 3 (W96-1) — scheduled report runs.
//
// This module ships the data model + API for scheduled
// report runs. The actual scheduler worker (a cron-like
// trigger) is out of scope for wave 3 — wave 3 ships:
//   1. The finance.report_schedules + finance.report_executions
//      tables (migration 0027).
//   2. Pure functions to create / list / get / update /
//      delete schedules.
//   3. Pure functions to record + list report executions
//      (the history of past runs).
//   4. HTTP routes for the schedule CRUD + execution list.
//
// A future wave (W97+) can add the scheduler worker that
// actually triggers report runs on a cron schedule. The
// data model + API are already in place; the worker just
// needs to call recordReportExecution when a run completes.

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

async function runQuery(db, sql, params) {
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

function assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

function assertTenantId(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError('tenantId must be a non-negative integer');
  }
}

// The valid report types — a CLIENT/SERVER contract, NOT
// a schema invariant. The list is duplicated from
// server/finance/reports.js (each report function has its
// own getMonthlyRevenue / getArAging / etc. — the report
// schedule stores the function name as a string). New
// report types can be added without a migration; the
// scheduler worker (future wave) is responsible for
// dispatching the right function based on the string.
const VALID_REPORT_TYPES = Object.freeze([
  'ar_aging',
  'monthly_revenue',
  'top_customers',
  'data_quality',
  'revenue_trend',
  'customer_breakdown',
]);

function assertReportType(value) {
  if (!VALID_REPORT_TYPES.includes(value)) {
    throw new ValueError(
      `report_type must be one of: ${VALID_REPORT_TYPES.join(', ')} (got ${String(value)})`,
    );
  }
}

// Minimal cron validation. The 5-field standard cron
// format is "minute hour day-of-month month day-of-week".
// We don't parse it (the scheduler worker will) — we just
// verify the shape (5 space-separated fields, all numeric
// or wildcards or ranges).
const CRON_FIELD_RE = /^(\*|\*\/\d+|\d+(-\d+)?(,\d+(-\d+)?)*)$/;

function assertCronExpression(value) {
  if (typeof value !== 'string' || value.length > 64) {
    throw new ValueError('cron_expression must be a string up to 64 characters');
  }
  const fields = value.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new ValueError(
      `cron_expression must have 5 fields (minute hour day-of-month month day-of-week); got ${fields.length}`,
    );
  }
  for (const f of fields) {
    if (!CRON_FIELD_RE.test(f)) {
      throw new ValueError(
        `cron_expression field '${f}' is not a valid cron field (use *, */N, or N[-N][,N[-N]]*)`,
      );
    }
  }
}

function assertOptionalString(value, name, { max = 8192 } = {}) {
  if (value === null || value === undefined) return;
  if (typeof value !== 'string' || value.length > max) {
    throw new ValueError(`${name} must be a string up to ${max} characters or null`);
  }
}

function validateCreateReportScheduleInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('report schedule input is required');
  }
  if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 128) {
    throw new ValueError('name must be a string of 1-128 characters');
  }
  assertReportType(input.report_type);
  assertCronExpression(input.cron_expression);
  assertOptionalString(input.params, 'params', { max: 4096 });
  assertOptionalString(input.notify_email, 'notify_email', { max: 255 });
  assertOptionalString(input.notify_webhook_url, 'notify_webhook_url', { max: 1024 });
  assertOptionalString(input.notify_webhook_secret, 'notify_webhook_secret', { max: 256 });
  if (input.enabled !== undefined && input.enabled !== null) {
    if (input.enabled !== 0 && input.enabled !== 1) {
      throw new ValueError('enabled must be 0 or 1');
    }
  }
  if (input.created_by !== undefined && input.created_by !== null) {
    assertPositiveInt(input.created_by, 'created_by');
  }
  // W105-1: max_retries per schedule. 0 disables retry
  // (the original W97-1 behavior — wait for the next cron
  // fire). Default 3. Cap at 10 to prevent pathological
  // settings.
  if (input.max_retries !== undefined && input.max_retries !== null) {
    if (!Number.isInteger(input.max_retries) || input.max_retries < 0 || input.max_retries > 10) {
      throw new ValueError('max_retries must be an integer between 0 and 10');
    }
  }
}

function validateRecordReportExecutionInput(input) {
  if (!input || typeof input !== 'object') {
    throw new ValueError('report execution input is required');
  }
  assertPositiveInt(input.schedule_id, 'schedule_id');
  assertReportType(input.report_type);
  if (!['pending', 'running', 'completed', 'failed'].includes(input.status)) {
    throw new ValueError('status must be one of: pending, running, completed, failed');
  }
  assertOptionalString(input.started_at, 'started_at', { max: 32 });
  assertOptionalString(input.completed_at, 'completed_at', { max: 32 });
  if (input.duration_ms !== undefined && input.duration_ms !== null) {
    if (!Number.isInteger(input.duration_ms) || input.duration_ms < 0) {
      throw new ValueError('duration_ms must be a non-negative integer');
    }
  }
  assertOptionalString(input.result_json, 'result_json', { max: 65536 });
  assertOptionalString(input.error_message, 'error_message', { max: 4096 });
  // triggered_by: 'scheduler' (default) or 'manual' (forced run).
  // W103-1 introduced manual runs. The validation accepts
  // any of the two; other values are rejected.
  if (input.triggered_by !== undefined && input.triggered_by !== null) {
    if (!['scheduler', 'manual'].includes(input.triggered_by)) {
      throw new ValueError("triggered_by must be one of: 'scheduler', 'manual'");
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Schedules CRUD
// ────────────────────────────────────────────────────────────────────────

/**
 * Create a new report schedule. The schedule is the
 * DEFINITION of a recurring report; the actual runs
 * (executions) are tracked separately.
 *
 * @returns {Promise<{ id: number }>}
 */
export async function createReportSchedule(db, input, tenantId = 0) {
  assertTenantId(tenantId);
  validateCreateReportScheduleInput(input);
  const ins = await runQuery(
    db,
    `INSERT INTO finance.report_schedules
       (tenant_id, name, report_type, cron_expression,
        enabled, params, notify_email, notify_webhook_url, notify_webhook_secret,
        created_by, max_retries)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id`,
    [
      tenantId,
      input.name,
      input.report_type,
      input.cron_expression,
      input.enabled ?? 1,
      input.params ?? null,
      input.notify_email ?? null,
      input.notify_webhook_url ?? null,
      input.notify_webhook_secret ?? null,
      input.created_by ?? null,
      input.max_retries ?? 3,
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

/**
 * List report schedules for the tenant. Optional filter
 * by enabled status. Ordered by id ASC.
 */
export async function listReportSchedules(
  db,
  tenantId = 0,
  { enabled = null } = {},
) {
  assertTenantId(tenantId);
  let result;
  if (enabled !== null) {
    result = await runQuery(
      db,
      `SELECT id, name, report_type, cron_expression, enabled,
              params, notify_email, notify_webhook_url, notify_webhook_secret,
              last_run_at, next_run_at,
              created_by, created_at, updated_at
         FROM finance.report_schedules
        WHERE tenant_id = $1 AND enabled = $2
        ORDER BY id ASC`,
      [tenantId, enabled],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, name, report_type, cron_expression, enabled,
              params, notify_email, last_run_at, next_run_at,
              created_by, created_at, updated_at
         FROM finance.report_schedules
        WHERE tenant_id = $1
        ORDER BY id ASC`,
      [tenantId],
    );
  }
  return result.rows;
}

/**
 * Get a single report schedule. Throws ValueError on
 * missing or cross-tenant.
 */
export async function getReportSchedule(db, scheduleId, tenantId = 0) {
  assertPositiveInt(scheduleId, 'scheduleId');
  assertTenantId(tenantId);
  const result = await runQuery(
    db,
    `SELECT id, tenant_id, name, report_type, cron_expression,
            enabled, params, notify_email,
            notify_webhook_url, notify_webhook_secret,
            last_run_at, next_run_at,
            retry_count, max_retries, last_retry_at,
            created_by, created_at, updated_at
       FROM finance.report_schedules
      WHERE id = $1 AND tenant_id = $2`,
    [scheduleId, tenantId],
  );
  if (!result.rows || result.rows.length === 0) {
    throw new ValueError(`report schedule ${scheduleId} not found in tenant ${tenantId}`);
  }
  return result.rows[0];
}

/**
 * Toggle the enabled flag for a schedule. The operator
 * uses this to pause / resume a schedule without deleting
 * it. Returns the new enabled value.
 */
export async function toggleReportSchedule(db, scheduleId, input, tenantId = 0) {
  assertPositiveInt(scheduleId, 'scheduleId');
  assertTenantId(tenantId);
  if (!input || (input.enabled !== 0 && input.enabled !== 1)) {
    throw new ValueError('input.enabled must be 0 or 1');
  }
  // Verify the schedule exists (raises ValueError if not).
  await getReportSchedule(db, scheduleId, tenantId);
  await runQuery(
    db,
    `UPDATE finance.report_schedules
        SET enabled = $1,
            updated_at = datetime('now')
      WHERE id = $2 AND tenant_id = $3`,
    [input.enabled, scheduleId, tenantId],
  );
  return { id: scheduleId, enabled: input.enabled };
}

// ────────────────────────────────────────────────────────────────────────
// Executions
// ────────────────────────────────────────────────────────────────────────

/**
 * Record a report execution. Called by the scheduler
 * worker when a run starts (status='running') and again
 * when it completes (status='completed' or 'failed').
 *
 * For wave 3, the actual scheduler worker is out of scope.
 * This function is the API the worker will use.
 */
export async function recordReportExecution(db, input, tenantId = 0) {
  assertTenantId(tenantId);
  validateRecordReportExecutionInput(input);
  // Verify the schedule exists (raises ValueError if not).
  await getReportSchedule(db, input.schedule_id, tenantId);
  const ins = await runQuery(
    db,
    `INSERT INTO finance.report_executions
       (tenant_id, schedule_id, report_type, status,
        started_at, completed_at, duration_ms,
        result_json, error_message, triggered_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     RETURNING id`,
    [
      tenantId,
      input.schedule_id,
      input.report_type,
      input.status,
      input.started_at ?? null,
      input.completed_at ?? null,
      input.duration_ms ?? null,
      input.result_json ?? null,
      input.error_message ?? null,
      input.triggered_by ?? 'scheduler',
    ],
  );
  let id;
  if (ins.rows && ins.rows.length > 0 && ins.rows[0].id != null) {
    id = Number(ins.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    id = Number(lastId.rows[0].id);
  }
  // If the execution is completed, also update the
  // schedule's last_run_at + bump updated_at.
  if (input.status === 'completed' || input.status === 'failed') {
    await runQuery(
      db,
      `UPDATE finance.report_schedules
          SET last_run_at = $1,
              updated_at = datetime('now')
        WHERE id = $2 AND tenant_id = $3`,
      [input.completed_at ?? new Date().toISOString(), input.schedule_id, tenantId],
    );
  }
  return { id };
}

/**
 * List report executions for the tenant. Optional filter
 * by scheduleId + status. Ordered by id DESC (most recent
 * first — the operator wants to see the latest runs at
 * the top of the list).
 */
export async function listReportExecutions(
  db,
  tenantId = 0,
  { scheduleId = null, status = null } = {},
) {
  assertTenantId(tenantId);
  let result;
  if (scheduleId !== null && status !== null) {
    result = await runQuery(
      db,
      `SELECT id, schedule_id, report_type, status,
              started_at, completed_at, duration_ms,
              result_json, error_message, created_at
         FROM finance.report_executions
        WHERE tenant_id = $1 AND schedule_id = $2 AND status = $3
        ORDER BY id DESC`,
      [tenantId, scheduleId, status],
    );
  } else if (scheduleId !== null) {
    result = await runQuery(
      db,
      `SELECT id, schedule_id, report_type, status,
              started_at, completed_at, duration_ms,
              result_json, error_message, created_at
         FROM finance.report_executions
        WHERE tenant_id = $1 AND schedule_id = $2
        ORDER BY id DESC`,
      [tenantId, scheduleId],
    );
  } else if (status !== null) {
    result = await runQuery(
      db,
      `SELECT id, schedule_id, report_type, status,
              started_at, completed_at, duration_ms,
              result_json, error_message, created_at
         FROM finance.report_executions
        WHERE tenant_id = $1 AND status = $2
        ORDER BY id DESC`,
      [tenantId, status],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, schedule_id, report_type, status,
              started_at, completed_at, duration_ms,
              result_json, error_message, created_at
         FROM finance.report_executions
        WHERE tenant_id = $1
        ORDER BY id DESC`,
      [tenantId],
    );
  }
  return result.rows || [];
}

// ────────────────────────────────────────────────────────────────────────
// resetScheduleRetries (W105-1) — clear the retry state.
//
// The retry mechanism (in tickOnce) bumps retry_count
// after a failed run, with exponential backoff. After
// max_retries, the schedule is "exhausted" and waits
// for the next cron fire. The operator can use this
// function to manually clear the retry state and
// trigger an immediate retry.
//
// What it does:
//   1. retry_count = 0
//   2. last_retry_at = NULL
//   3. next_run_at = now (so the next tick fires immediately)
//
// Returns the updated schedule row. 404 if the schedule
// doesn't exist in the tenant.
export async function resetScheduleRetries(db, scheduleId, tenantId = 0) {
  assertPositiveInt(scheduleId, 'scheduleId');
  assertTenantId(tenantId);
  // Verify the schedule exists (raises ValueError if not).
  // We do this BEFORE the update so we return a clean 404
  // for missing schedules.
  await getReportSchedule(db, scheduleId, tenantId);
  const now = new Date().toISOString();
  await runQuery(
    db,
    `UPDATE finance.report_schedules
        SET retry_count = 0,
            last_retry_at = NULL,
            next_run_at = $1,
            updated_at = datetime('now')
      WHERE id = $2 AND tenant_id = $3`,
    [now, scheduleId, tenantId],
  );
  // Return the updated row.
  return await getReportSchedule(db, scheduleId, tenantId);
}