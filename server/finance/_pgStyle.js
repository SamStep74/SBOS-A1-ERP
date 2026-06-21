// SBOS-A1-ERP finance — shared pg-style adapter helpers.
//
// The finance module (inventory, purchase, poTemplate, journal,
// stockPosting, reconciliation) writes SQL in the pg-style
// ($N placeholders, finance. table prefix). The production
// adapter is pg-native and the test harness is a small pg-style
// adapter over node:sqlite. To make both paths work:
//
//   1. SQL is written with the finance. prefix (canonical
//      production name). The same SQL works on pg (kept as-is)
//      and on sqlite (the migration runner strips the prefix
//      at the table level, but the pure-function SQL needs to
//      strip at DML time too — see stripFinancePrefix below).
//   2. Placeholders are pg-style $N. On pg they're kept as-is;
//      on the test harness they're translated to positional ?
//      by the adapter (which is then bound positionally).
//
// The tricky part: a $N placeholder is only a placeholder in pg.
// Under the test harness $1 → ? and the placeholder identity
// is LOST — every ? becomes a positional bind. This means
// `WHERE tenant_id = $1 AND x IN (SELECT id FROM y WHERE
// tenant_id = $1)` — a perfectly valid pg pattern — silently
// binds the second $1 to the wrong value under the test path.
// This bug has hit the project THREE times in three waves
// (Wave 19 getAccountBalance JOIN, Wave 19 listAccountBalances
// JOIN, Wave 20 reconciliation NOT EXISTS subqueries). Each
// time the fix was the same: unique $N placeholders + duplicate
// the value in the params array.
//
// numberedParams below makes that pattern impossible. You
// write `WHERE tenant_id = #{tenantId} AND ... = #{tenantId}`
// (JS template-literal syntax with #, not $) and the helper
// returns `{sql, params}` with $1, $2, ... in the same order.
// Reuse is safe: each `#{value}` is a unique placeholder.
//
// Why the # syntax: $1 is invalid JS template-literal syntax
// (the $ is a real character but the digit after breaks the
// interpolation). Using # makes the call site read like a
// template literal (`#{tenantId}`) but the underlying SQL is
// still pg-style with $N placeholders.

// ────────────────────────────────────────────────────────────────────────
// stripFinancePrefix
// ────────────────────────────────────────────────────────────────────────

/**
 * Strip the `finance.` schema prefix from a SQL string. The
 * production migration runner does the same on the real DB
 * (the table is `catalog_items` on sqlite, `finance.catalog_items`
 * on pg). The pure-function SQL is written with the prefix for
 * readability; the strip happens at DML time so the same SQL
 * works on both backends.
 *
 * Safe under all conditions:
 *   - empty string → empty string
 *   - no `finance.` in the string → unchanged
 *   - multiple occurrences → all stripped
 *   - `finance.foo` inside a string literal or identifier-like
 *     context is NOT in the SQL grammar of the finance module's
 *     queries, so no false positives in practice
 */
export function stripFinancePrefix(sql) {
  if (typeof sql !== 'string') return sql;
  return sql.replace(
    /(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g,
    '$1',
  );
}

// ────────────────────────────────────────────────────────────────────────
// numberedParams
// ────────────────────────────────────────────────────────────────────────

/**
 * Build a `{sql, params}` pair from a SQL template and a list of
 * values. Each `#{value}` occurrence in the template is replaced
 * with a unique $N placeholder, and the corresponding value is
 * pushed into the params array. This is the safe replacement
 * for raw template-literal SQL — placeholder identity is
 * preserved (so the test harness's $N → ? translation works
 * correctly), and reuse is automatic (each `#{x}` is unique).
 *
 * Usage:
 *   const { sql, params } = numberedParams(
 *     'SELECT * FROM t WHERE a = #{a} AND b = #{a}',
 *     'foo',  // a
 *     'bar',  // b — note: a is reused, but the placeholders are unique
 *   );
 *   // sql:    'SELECT * FROM t WHERE a = $1 AND b = $2'
 *   // params: ['foo', 'bar']
 *
 * Note: the #{name} is a JS template-literal-style syntax (with #,
 * not $). The reason: $1, $2 are not valid identifier-style
 * interpolation in a JS template literal — you'd have to escape
 * them with `\$1`, which is ugly. The # is a clean sentinel
 * that doesn't conflict with either pg or JS.
 *
 * If the template doesn't contain any `#{...}` occurrences, the
 * helper is a no-op: returns the template as the sql + an empty
 * params array. This makes it safe to wrap any SQL string.
 */
export function numberedParams(template, ...values) {
  if (typeof template !== 'string') {
    throw new TypeError('numberedParams: template must be a string');
  }
  const params = [];
  // Match #{anything-but-} — the simplest reasonable template
  // placeholder syntax. We deliberately allow any chars inside
  // because the # prefix is the sentinel; the inner contents are
  // not parsed (we don't try to do JS-expression interpolation
  // inside #{...}, which would be too magical and too fragile).
  const sql = template.replace(/#\{([^}]*)\}/g, (_, _label) => {
    if (params.length >= values.length) {
      throw new Error(
        `numberedParams: not enough values for the #{...} placeholders in the template (got ${params.length + 1} placeholders but only ${values.length} values)`,
      );
    }
    params.push(values[params.length]);
    return `$${params.length}`;
  });
  if (params.length < values.length) {
    throw new Error(
      `numberedParams: too many values (got ${values.length} but only ${params.length} #{...} placeholders in the template)`,
    );
  }
  return { sql, params };
}

// ────────────────────────────────────────────────────────────────────────
// runQuery
// ────────────────────────────────────────────────────────────────────────

/**
 * Run a SQL query against a pg-style adapter, stripping the
 * finance. prefix first. The adapter is expected to be the
 * production realDb.js (pg-native) or the test harness's
 * makeMemoryDb (node:sqlite wrapped in a pg-style API).
 *
 * The adapter's `query(sql, params)` method returns
 * `{rows: [...]}` for SELECTs and either nothing or
 * `{lastInsertRowid: ...}` for non-SELECTs. This helper
 * normalizes the return so the caller always sees `{rows}`.
 */
export async function runQuery(db, sql, params) {
  const result = await db.query(stripFinancePrefix(sql), params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}
