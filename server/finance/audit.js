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
  if (filters.q != null && String(filters.q).length > 0) {
    // Full-text search across the action, resource, and payload_json
    // columns. Escapes LIKE special chars (% and _) in the search
    // term so a search for "100%" doesn't accidentally match
    // everything (the % is a LIKE wildcard). Case-insensitive
    // (SQLite's LIKE is case-insensitive for ASCII by default).
    //
    // IMPORTANT: SQLite binds positional `?` placeholders by position,
    // NOT by name. Each `?` needs its own value in the params array.
    // So we push the q value 3 times (once per LIKE clause) — pushing
    // it once would cause "datatype mismatch" because the 2nd and 3rd
    // `?` would have no value.
    //
    // The ESCAPE '\' clause tells SQLite to treat \ as the escape
    // character. In the JS string, '\\' = 1 literal backslash, so
    // ESCAPE '\\' = the SQL string '\' (1 backslash) which is the
    // escape character.
    const q = '%' + String(filters.q).replace(/[%_\\]/g, '\\$&') + '%';
    where.push(`(action LIKE $${i} ESCAPE '\\' OR resource LIKE $${i + 1} ESCAPE '\\' OR payload_json LIKE $${i + 2} ESCAPE '\\')`);
    params.push(q, q, q);
    i += 3;
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
                 LIMIT $${i++} OFFSET $${i}`;
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

// ────────────────────────────────────────────────────────────────────────
// CSV export (Wave 40). Compliance teams want to pull the audit
// log as a flat file for offline analysis (Excel, pandas, etc.).
//
// This is an async generator — the route handler can pipe chunks
// to `res` as they arrive instead of buffering the whole export
// in memory. The query uses the same filter shape as listAudit
// (tenant_id is mandatory; everything else optional).
//
// CSV format: header line + one line per row. Fields are escaped
// per RFC 4180: wrap in double quotes if the value contains
// comma / newline / quote, and double up any embedded quotes.
// payload_json is rendered as a single escaped string column.
// ────────────────────────────────────────────────────────────────────────

const CSV_HEADERS = Object.freeze([
  'id', 'tenant_id', 'user_id', 'username', 'action', 'resource',
  'method', 'path', 'status_code', 'payload_json', 'request_id',
  'created_at',
]);

function csvEscape(value) {
  if (value == null) return '';
  const s = String(value);
  if (/[",\n\r]/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvLine(values) {
  return values.map(csvEscape).join(',') + '\n';
}

/**
 * Async generator that yields CSV chunks for the audit log.
 * First chunk is the header line. Subsequent chunks are data
 * rows (one row per yield). Uses the same filter shape as
 * listAudit; chunk size is configurable (default 500 rows).
 *
 * The generator does NOT buffer — each yield is ready to write
 * to res immediately. Memory-bounded by chunk size × row size.
 *
 * @param {object} db  raw node:sqlite handle (audit table is app infra)
 * @param {object} filters  { tenant_id, user_id, action, resource_prefix,
 *                            resource_id, since, until, limit, offset }
 * @param {number} [chunkSize=500]  rows per yield
 */
export async function* streamAuditCsv(db, filters = {}, chunkSize = 500) {
  const size = Math.min(Math.max(Number(chunkSize) || 500, 1), 5000);
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

  // Default to a higher cap for CSV export — 10k rows ≈ a few MB,
  // which is a sensible upper bound for a compliance dump.
  const limit = Math.min(Math.max(Number(filters.limit) || 10000, 1), 50000);
  const offset = Math.max(Number(filters.offset) || 0, 0);

  const sql = `SELECT id, tenant_id, user_id, username, action, resource,
                       method, path, status_code, payload_json, request_id, created_at
                  FROM audit
                 WHERE ${where.join(' AND ')}
                 ORDER BY id ASC
                 LIMIT $${i++} OFFSET $${i}`;
  params.push(limit, offset);

  const translated = sql.replace(/\$\d+/g, '?');
  const stmt = db.prepare(translated);

  // Yield the header first so the client always sees a valid CSV.
  yield csvLine(CSV_HEADERS);

  // Iterate in chunks so the generator can interleave yields with
  // the caller's `res.write()` calls.
  let buf = [];
  for (const row of stmt.iterate(...params)) {
    buf.push(csvLine([
      row.id,
      row.tenant_id,
      row.user_id,
      row.username,
      row.action,
      row.resource,
      row.method,
      row.path,
      row.status_code,
      row.payload_json,
      row.request_id,
      row.created_at,
    ]));
    if (buf.length >= size) {
      yield buf.join('');
      buf = [];
    }
  }
  if (buf.length > 0) {
    yield buf.join('');
  }
}

export const __internals = Object.freeze({ MAX_PAYLOAD_BYTES, CSV_HEADERS, csvEscape, csvLine });
