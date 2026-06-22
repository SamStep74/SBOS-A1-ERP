// Phase 3 reporting wave 3 (W96-1) — scheduled report tests.
// Phase 3 reporting wave 8 (W105-1) — retry tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createReportSchedule,
  listReportSchedules,
  getReportSchedule,
  toggleReportSchedule,
  recordReportExecution,
  listReportExecutions,
  resetScheduleRetries,
  ValueError,
} from './reportScheduler.js';

function makeMockDb() {
  const schedules = new Map();
  const executions = new Map();
  let nextSchedId = 1;
  let nextExecId = 1;

  function nextId(map) {
    if (map === schedules) return nextSchedId++;
    if (map === executions) return nextExecId++;
    throw new Error('mock: unknown map');
  }

  function classify(sql) {
    const s = sql.trim().toUpperCase();
    if (/INTO\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /RETURNING/i.test(s)) return 'sched-insert';
    if (/INTO\s+FINANCE\.REPORT_EXECUTIONS/i.test(s) && /RETURNING/i.test(s)) return 'exec-insert';
    // W105-1: resetScheduleRetries issues an UPDATE with
    // "RETRY_COUNT = 0" in the SET clause. The mock
    // matches this BEFORE the generic 'sched-update' so
    // the params are read in the right order.
    if (/UPDATE\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /RETRY_COUNT\s*=\s*0/i.test(s)) return 'sched-retry-reset';
    if (/UPDATE\s+FINANCE\.REPORT_SCHEDULES/i.test(s)) return 'sched-update';
    // getReportSchedule: SELECT * FROM ... WHERE id = $1 AND tenant_id = $2
    // (more specific than the list query — the list has only
    // tenant_id = $1, no id check).
    if (/FROM\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /\bid\s*=\s*\$\d/i.test(s)) return 'sched-get';
    if (/FROM\s+FINANCE\.REPORT_SCHEDULES/i.test(s) && /GROUP\s+BY/i.test(s)) return 'sched-groupby';
    if (/FROM\s+FINANCE\.REPORT_SCHEDULES/i.test(s)) return 'sched';
    if (/FROM\s+FINANCE\.REPORT_EXECUTIONS/i.test(s)) return 'exec';
    return 'passthrough';
  }

  async function query(sql, params = []) {
    const ps = params ?? [];
    const kind = classify(sql);


    if (kind === 'sched-insert') {
      const id = nextId(schedules);
      // W105-1: the INSERT now has 11 columns (max_retries
      // was added as the 11th). The mock reads by position.
      schedules.set(id, {
        id,
        tenant_id: Number(ps[0]),
        name: ps[1],
        report_type: ps[2],
        cron_expression: ps[3],
        enabled: Number(ps[4]),
        params: ps[5] ?? null,
        notify_email: ps[6] ?? null,
        created_by: ps[7] != null ? Number(ps[7]) : null,
        // W105-1: the old INSERT had 10 columns; the new
        // one has 11 (max_retries). The mock previously
        // didn't read ps[8] and ps[9] (notify_webhook_*);
        // it does now (see the production INSERT).
        notify_webhook_url: ps[8] ?? null,
        notify_webhook_secret: ps[9] ?? null,
        max_retries: ps[10] != null ? Number(ps[10]) : 3,
        retry_count: 0,
        last_retry_at: null,
        last_run_at: null,
        next_run_at: null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      });
      return { rows: [{ id }] };
    }
    if (kind === 'exec-insert') {
      const id = nextId(executions);
      executions.set(id, {
        id,
        tenant_id: Number(ps[0]),
        schedule_id: Number(ps[1]),
        report_type: ps[2],
        status: ps[3],
        started_at: ps[4] ?? null,
        completed_at: ps[5] ?? null,
        duration_ms: ps[6] != null ? Number(ps[6]) : null,
        result_json: ps[7] ?? null,
        error_message: ps[8] ?? null,
        created_at: '2026-01-01',
      });
      return { rows: [{ id }] };
    }
    if (kind === 'sched-update') {
      // toggleReportSchedule: UPDATE enabled WHERE id AND tenant
      // params: [enabled, scheduleId, tenantId]
      const enabled = Number(ps[0]);
      const scheduleId = Number(ps[1]);
      const tenantId = Number(ps[2]);
      const sched = schedules.get(scheduleId);
      if (sched && sched.tenant_id === tenantId) {
        sched.enabled = enabled;
        sched.updated_at = '2026-01-02';
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    if (kind === 'sched-retry-reset') {
      // resetScheduleRetries: UPDATE retry_count=0,
      // last_retry_at=NULL, next_run_at=$1 WHERE id=$2 AND tenant_id=$3
      // params: [next_run_at, id, tenant_id]
      const nextRunAt = ps[0];
      const scheduleId = Number(ps[1]);
      const tenantId = Number(ps[2]);
      const sched = schedules.get(scheduleId);
      if (sched && sched.tenant_id === tenantId) {
        sched.retry_count = 0;
        sched.last_retry_at = null;
        sched.next_run_at = nextRunAt;
        sched.updated_at = '2026-01-02';
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    if (kind === 'sched-get') {
      // getReportSchedule: WHERE id = $1 AND tenant_id = $2
      const id = Number(ps[0]);
      const tenantId = Number(ps[1]);
      for (const s of schedules.values()) {
        if (s.id === id && s.tenant_id === tenantId) {
          return { rows: [{ ...s }] };
        }
      }
      return { rows: [] };
    }
    if (kind === 'sched') {
      // Filter by enabled when param provided.
      let rows = [...schedules.values()].map((s) => ({ ...s }));
      if (ps.length >= 2 && (ps[0] != null && ps[1] != null)) {
        const enabled = Number(ps[1]);
        rows = rows.filter((r) => r.enabled === enabled);
      }
      return { rows };
    }
    if (kind === 'exec') {
      // Filter by scheduleId + status when params provided.
      // The 3 query shapes:
      //   ps = [tenantId]                                — all executions
      //   ps = [tenantId, status]                        — by status
      //   ps = [tenantId, scheduleId]                    — by schedule
      //   ps = [tenantId, scheduleId, status]            — by schedule + status
      let rows = [...executions.values()].map((e) => ({ ...e }));
      if (ps.length >= 3 && ps[2] != null) {
        // scheduleId + status
        rows = rows.filter((r) => r.schedule_id === Number(ps[1]) && r.status === ps[2]);
      } else if (ps.length === 2) {
        // Disambiguate by parameter type: Number = scheduleId,
        // string = status.
        if (typeof ps[1] === 'number') {
          rows = rows.filter((r) => r.schedule_id === ps[1]);
        } else {
          rows = rows.filter((r) => r.status === ps[1]);
        }
      }
      return { rows };
    }
    return { rows: [] };
  }

  return {
    _db: { schedules, executions },
    query,
    seedSchedule: (row) => {
      const id = nextId(schedules);
      schedules.set(id, {
        id,
        tenant_id: row.tenant_id ?? 0,
        name: row.name,
        report_type: row.report_type,
        cron_expression: row.cron_expression,
        enabled: row.enabled ?? 1,
        params: row.params ?? null,
        notify_email: row.notify_email ?? null,
        last_run_at: null,
        next_run_at: null,
        created_by: row.created_by ?? null,
        created_at: '2026-01-01',
        updated_at: '2026-01-01',
      });
      return id;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// createReportSchedule + listReportSchedules
// ────────────────────────────────────────────────────────────────────────

test('reportScheduler: createReportSchedule inserts a row + returns id', async () => {
  const db = makeMockDb();
  const out = await createReportSchedule(
    db,
    {
      name: 'Weekly AR aging',
      report_type: 'ar_aging',
      cron_expression: '0 9 * * 1',
      notify_email: 'cfo@example.com',
      created_by: 1,
    },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('reportScheduler: createReportSchedule throws on bad report_type', async () => {
  const db = makeMockDb();
  await assert.rejects(
    createReportSchedule(
      db,
      { name: 'X', report_type: 'unknown_report', cron_expression: '0 9 * * 1' },
      0,
    ),
    /report_type must be one of/,
  );
});

test('reportScheduler: createReportSchedule throws on bad cron_expression (wrong field count)', async () => {
  const db = makeMockDb();
  await assert.rejects(
    createReportSchedule(
      db,
      { name: 'X', report_type: 'ar_aging', cron_expression: '0 9 *' },
      0,
    ),
    /must have 5 fields/,
  );
});

test('reportScheduler: createReportSchedule throws on bad cron_expression (invalid field syntax)', async () => {
  const db = makeMockDb();
  await assert.rejects(
    createReportSchedule(
      db,
      { name: 'X', report_type: 'ar_aging', cron_expression: '0 9 foo * 1' },
      0,
    ),
    /is not a valid cron field/,
  );
});

test('reportScheduler: createReportSchedule throws on missing name', async () => {
  const db = makeMockDb();
  await assert.rejects(
    createReportSchedule(
      db,
      { report_type: 'ar_aging', cron_expression: '0 9 * * 1' },
      0,
    ),
    /name must be a string/,
  );
});

test('reportScheduler: listReportSchedules returns all schedules for the tenant', async () => {
  const db = makeMockDb();
  await createReportSchedule(db, { name: 'A', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  await createReportSchedule(db, { name: 'B', report_type: 'monthly_revenue', cron_expression: '0 0 1 * *' }, 0);
  const rows = await listReportSchedules(db, 0);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'A');
  assert.equal(rows[1].name, 'B');
});

test('reportScheduler: listReportSchedules filters by enabled', async () => {
  const db = makeMockDb();
  await createReportSchedule(db, { name: 'A', report_type: 'ar_aging', cron_expression: '0 9 * * 1', enabled: 1 }, 0);
  await createReportSchedule(db, { name: 'B', report_type: 'monthly_revenue', cron_expression: '0 0 1 * *', enabled: 0 }, 0);
  const enabled = await listReportSchedules(db, 0, { enabled: 1 });
  assert.equal(enabled.length, 1);
  assert.equal(enabled[0].name, 'A');
  const disabled = await listReportSchedules(db, 0, { enabled: 0 });
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].name, 'B');
});

test('reportScheduler: getReportSchedule returns the schedule or throws', async () => {
  const db = makeMockDb();
  const out = await createReportSchedule(db, { name: 'G', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  const r = await getReportSchedule(db, out.id, 0);
  assert.equal(r.name, 'G');
  assert.equal(r.report_type, 'ar_aging');
  assert.equal(r.enabled, 1);
  await assert.rejects(getReportSchedule(db, 999, 0), /report schedule 999 not found/);
});

test('reportScheduler: getReportSchedule throws on bad tenantId', async () => {
  const db = makeMockDb();
  await assert.rejects(getReportSchedule(db, 1, -1), /tenantId must be a non-negative integer/);
});

test('reportScheduler: toggleReportSchedule flips enabled flag', async () => {
  const db = makeMockDb();
  const out = await createReportSchedule(db, { name: 'T', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  const r1 = await toggleReportSchedule(db, out.id, { enabled: 0 }, 0);
  assert.equal(r1.enabled, 0);
  const refreshed = db._db.schedules.get(out.id);
  assert.equal(refreshed.enabled, 0);
  const r2 = await toggleReportSchedule(db, out.id, { enabled: 1 }, 0);
  assert.equal(r2.enabled, 1);
});

test('reportScheduler: toggleReportSchedule throws on bad enabled value', async () => {
  const db = makeMockDb();
  const out = await createReportSchedule(db, { name: 'T', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  await assert.rejects(
    toggleReportSchedule(db, out.id, { enabled: 2 }, 0),
    /enabled must be 0 or 1/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// recordReportExecution + listReportExecutions
// ────────────────────────────────────────────────────────────────────────

test('reportScheduler: recordReportExecution inserts a row + returns id', async () => {
  const db = makeMockDb();
  const sched = await createReportSchedule(db, { name: 'R', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  const out = await recordReportExecution(
    db,
    { schedule_id: sched.id, report_type: 'ar_aging', status: 'completed', started_at: '2026-01-15T09:00:00', completed_at: '2026-01-15T09:00:05', duration_ms: 5000, result_json: '{"total": 1000}' },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('reportScheduler: recordReportExecution throws on bad status', async () => {
  const db = makeMockDb();
  const sched = await createReportSchedule(db, { name: 'R', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  await assert.rejects(
    recordReportExecution(db, { schedule_id: sched.id, report_type: 'ar_aging', status: 'invalid_status' }, 0),
    /status must be one of/,
  );
});

test('reportScheduler: recordReportExecution throws on missing schedule', async () => {
  const db = makeMockDb();
  await assert.rejects(
    recordReportExecution(
      db,
      { schedule_id: 999, report_type: 'ar_aging', status: 'pending' },
      0,
    ),
    /report schedule 999 not found/,
  );
});

test('reportScheduler: listReportExecutions returns all executions for the tenant', async () => {
  const db = makeMockDb();
  const sched = await createReportSchedule(db, { name: 'R', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  await recordReportExecution(db, { schedule_id: sched.id, report_type: 'ar_aging', status: 'completed', duration_ms: 100, result_json: '{}' }, 0);
  await recordReportExecution(db, { schedule_id: sched.id, report_type: 'ar_aging', status: 'failed', error_message: 'timeout' }, 0);
  const rows = await listReportExecutions(db, 0);
  assert.equal(rows.length, 2);
});

test('reportScheduler: listReportExecutions filters by scheduleId + status', async () => {
  const db = makeMockDb();
  const s1 = await createReportSchedule(db, { name: 'R1', report_type: 'ar_aging', cron_expression: '0 9 * * 1' }, 0);
  const s2 = await createReportSchedule(db, { name: 'R2', report_type: 'monthly_revenue', cron_expression: '0 0 1 * *' }, 0);
  await recordReportExecution(db, { schedule_id: s1.id, report_type: 'ar_aging', status: 'completed' }, 0);
  await recordReportExecution(db, { schedule_id: s1.id, report_type: 'ar_aging', status: 'failed' }, 0);
  await recordReportExecution(db, { schedule_id: s2.id, report_type: 'monthly_revenue', status: 'completed' }, 0);
  const s1All = await listReportExecutions(db, 0, { scheduleId: s1.id });
  assert.equal(s1All.length, 2);
  const s1Completed = await listReportExecutions(db, 0, { scheduleId: s1.id, status: 'completed' });
  assert.equal(s1Completed.length, 1);
  const failedAll = await listReportExecutions(db, 0, { status: 'failed' });
  assert.equal(failedAll.length, 1);
  assert.equal(failedAll[0].schedule_id, s1.id);
});

// ────────────────────────────────────────────────────────────────────────
// W105-1: resetScheduleRetries
// ────────────────────────────────────────────────────────────────────────

test('resetScheduleRetries: clears retry_count + last_retry_at + bumps next_run_at', async () => {
  const db = makeMockDb();
  // Create a schedule with retry state set
  const { id } = await createReportSchedule(
    db,
    {
      name: 'Retry smoke',
      report_type: 'ar_aging',
      cron_expression: '0 9 * * 1',
      max_retries: 3,
    },
    0,
  );
  // Manually mutate the schedule to simulate a retry
  // cycle (retry_count=2, last_retry_at set, next_run_at
  // in the past). We do this via the mock's setters.
  const sched = db._db.schedules.get(id);
  sched.retry_count = 2;
  sched.last_retry_at = '2026-06-22T10:00:00.000Z';
  sched.next_run_at = '2026-06-22T10:05:00.000Z';

  // Now reset
  const result = await resetScheduleRetries(db, id, 0);
  assert.equal(result.retry_count, 0);
  assert.equal(result.last_retry_at, null);
  // next_run_at is bumped to NOW (approximately)
  const nextRunMs = new Date(result.next_run_at).getTime();
  const nowMs = Date.now();
  assert.ok(Math.abs(nextRunMs - nowMs) < 5000);
});

test('resetScheduleRetries: 404 on non-existent schedule', async () => {
  const db = makeMockDb();
  await assert.rejects(
    resetScheduleRetries(db, 99999, 0),
    /not found/,
  );
});

test('createReportSchedule: accepts max_retries parameter (default 3)', async () => {
  const db = makeMockDb();
  // Default
  const def = await createReportSchedule(
    db,
    { name: 'A', report_type: 'ar_aging', cron_expression: '0 9 * * 1' },
    0,
  );
  const defRow = db._db.schedules.get(def.id);
  assert.equal(defRow.max_retries, 3);
  // Custom
  const custom = await createReportSchedule(
    db,
    { name: 'B', report_type: 'ar_aging', cron_expression: '0 9 * * 1', max_retries: 5 },
    0,
  );
  const customRow = db._db.schedules.get(custom.id);
  assert.equal(customRow.max_retries, 5);
  // Zero (disable retry)
  const zero = await createReportSchedule(
    db,
    { name: 'C', report_type: 'ar_aging', cron_expression: '0 9 * * 1', max_retries: 0 },
    0,
  );
  const zeroRow = db._db.schedules.get(zero.id);
  assert.equal(zeroRow.max_retries, 0);
});

test('createReportSchedule: rejects invalid max_retries', async () => {
  const db = makeMockDb();
  await assert.rejects(
    createReportSchedule(
      db,
      { name: 'A', report_type: 'ar_aging', cron_expression: '0 9 * * 1', max_retries: 11 },
      0,
    ),
    /max_retries must be/,
  );
  await assert.rejects(
    createReportSchedule(
      db,
      { name: 'A', report_type: 'ar_aging', cron_expression: '0 9 * * 1', max_retries: -1 },
      0,
    ),
    /max_retries must be/,
  );
});