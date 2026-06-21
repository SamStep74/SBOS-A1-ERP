// SBOS-A1-ERP finance audit log.
//
// Append-only writer + read API. Every finance write route calls
// `recordAudit(...)` on success (and optionally on failure). The
// GET /api/finance/audit endpoint exposes a tenant-scoped read of
// the same table.
//
// No UPDATE / DELETE in this module — the audit log is append-only
// by design. (Database-level enforcement is up to the deploy; the
// production sqlite WAL files don't enforce row-level constraints.)

const MAX_PAYLOAD_BYTES = 4096;

// ────────────────────────────────────────────────────────────────────────
// recordAudit — fire-and-forget append. Best-effort: a write error
// is logged to stderr but does NOT throw (the user's write already
// succeeded; the audit is a side-channel).
//
// The audit table is named `finance.audit` in pg (with a real
// schema) and `audit` on sqlite (the migration runner strips the
// `finance.` prefix on DDL because sqlite has no schemas). The
// queries here are written without the prefix so they work on both
// backends — pg sees a finance.audit query, sqlite sees an `audit`
// query. (The strip pattern is the same one the production pg
// adapter uses; see server/db/realDb.js makePgAdapter.)
// ────────────────────────────────────────────────────────────────────────

function stripFinancePrefix(sql) {
  return String(sql).replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

export function recordAudit(db, entry) {
  if (!db) return;
  if (!entry || typeof entry !== 'object') return;
  try {
    const tenantId = entry.tenant_id == null ? 0 : Number(entry.tenant_id);
    const userId = entry.user_id == null ? null : Number(entry.user_id);
    const username = entry.username || null;
    const action = String(entry.action || 'unknown').slice(0, 64);
    const resource = String(entry.resource || '').slice(0, 128);
    const method = String(entry.method || 'POST').slice(0, 8);
    const path = String(entry.path || '').slice(0, 256);
    const statusCode = Number(entry.status_code || 0);
    let payloadJson = null;
    if (entry.payload !== undefined && entry.payload !== null) {
      try {
        const serialized = JSON.stringify(entry.payload);
        payloadJson =
          serialized.length > MAX_PAYLOAD_BYTES
            ? serialized.slice(0, MAX_PAYLOAD_BYTES) + '...'
            : serialized;
      } catch {
        payloadJson = '[unserializable]';
      }
    }
    const requestId = entry.request_id || null;
    const sql = stripFinancePrefix(
      `INSERT INTO finance.audit
         (tenant_id, user_id, username, action, resource, method, path, status_code, payload_json, request_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    db.prepare(sql).run(tenantId, userId, username, action, resource, method, path, statusCode, payloadJson, requestId);
  } catch (err) {
    // best-effort; never let audit write failure block the user's request
    console.error('[audit] failed to record entry:', err && err.message ? err.message : err);
  }
}

// ────────────────────────────────────────────────────────────────────────
// listAudit — read API for GET /api/finance/audit.
//
// Filters: tenant (from req.tenantId), optional user_id, action,
// resource prefix, since/until (ISO 8601), and limit (default 100,
// max 1000).
// ────────────────────────────────────────────────────────────────────────

export async function listAudit(db, filters = {}) {
  const tenantId = filters.tenant_id == null ? 0 : Number(filters.tenant_id);
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  let i = 2;

  if (filters.user_id != null) {
    where.push(`user_id = $${i++}`);
    params.push(Number(filters.user_id));
  }
  if (filters.action) {
    where.push(`action = $${i++}`);
    params.push(String(filters.action));
  }
  if (filters.resource_prefix) {
    where.push(`resource LIKE $${i++}`);
    params.push(String(filters.resource_prefix) + '%');
  }
  if (filters.resource_id != null) {
    // Match by the numeric id portion of the resource string. The
    // resource column is shaped like 'invoice:42' or 'invoice:42:void'
    // (Wave 29). The query matches `:<id>` anywhere in the string,
    // with the LIKE wildcard on both sides so 'invoice:42' AND
    // 'invoice:42:void' both match. The trailing `:` (no more
    // colons) variant is the create case (id in the response body,
    // not in the URL — not yet wired in Wave 29, see routes.js
    // wrapFinanceRoute comment).
    where.push(`resource LIKE $${i++}`);
    params.push('%:' + String(filters.resource_id) + '%');
  }
  if (filters.since) {
    where.push(`created_at >= $${i++}`);
    params.push(String(filters.since));
  }
  if (filters.until) {
    where.push(`created_at <= $${i++}`);
    params.push(String(filters.until));
  }

  const limit = Math.min(Math.max(Number(filters.limit) || 100, 1), 1000);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const sql = `SELECT id, tenant_id, user_id, username, action, resource, method, path,
                       status_code, payload_json, request_id, created_at
                  FROM finance.audit
                 WHERE ${where.join(' AND ')}
                 ORDER BY id DESC
                 LIMIT $${i++} OFFSET $${i++}`;
  params.push(limit, offset);

  // The audit table is application infrastructure, not a domain
  // table. Use the raw sqlite handle (db.prepare) directly so this
  // function works the same in tests as in production — the audit
  // table doesn't go through the pg-style adapter that the pure
  // finance functions use. Translate $N → ? for node:sqlite, and
  // strip the `finance.` schema prefix because the production
  // migration runner already stripped it on the DDL side (the
  // table's real name on sqlite is `audit`, not `finance.audit`).
  const translated = sql
    .replace(/\$\d+/g, '?');
  const finalSql = stripFinancePrefix(translated);
  const rows = db.prepare(finalSql).all(...params);
  return (rows || []).map((r) => ({
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    user_id: r.user_id == null ? null : Number(r.user_id),
    username: r.username,
    action: r.action,
    resource: r.resource,
    method: r.method,
    path: r.path,
    status_code: Number(r.status_code),
    payload_json: r.payload_json,
    request_id: r.request_id,
    created_at: r.created_at,
  }));
}

export const __internals = Object.freeze({ MAX_PAYLOAD_BYTES });
