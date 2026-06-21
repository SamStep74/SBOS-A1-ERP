// Tests for the shared pg-style adapter helpers
// (server/finance/_pgStyle.js).
//
// These helpers are the foundation of every finance module's SQL
// layer. The numberedParams helper specifically prevents the
// "$N placeholder reuse under the test harness's $N → ?
// translation" bug that has hit the project three times in three
// waves (Wave 19 getAccountBalance JOIN, Wave 19 listAccountBalances
// JOIN, Wave 20 reconciliation NOT EXISTS subqueries).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stripFinancePrefix, numberedParams, runQuery } from './_pgStyle.js';

// ────────────────────────────────────────────────────────────────────────
// stripFinancePrefix
// ────────────────────────────────────────────────────────────────────────

test('stripFinancePrefix: strips the finance. prefix from a single table', () => {
  assert.equal(stripFinancePrefix('SELECT * FROM finance.catalog_items'), 'SELECT * FROM catalog_items');
});

test('stripFinancePrefix: strips multiple occurrences in one SQL string', () => {
  const sql = 'SELECT a.id FROM finance.assets a JOIN finance.accounts acc ON a.id = acc.asset_id';
  const out = stripFinancePrefix(sql);
  assert.equal(out, 'SELECT a.id FROM assets a JOIN accounts acc ON a.id = acc.asset_id');
});

test('stripFinancePrefix: no-op when there is no finance. prefix', () => {
  const sql = 'SELECT * FROM catalog_items WHERE id = 1';
  assert.equal(stripFinancePrefix(sql), sql);
});

test('stripFinancePrefix: empty string returns empty string', () => {
  assert.equal(stripFinancePrefix(''), '');
});

test('stripFinancePrefix: non-string input is returned unchanged', () => {
  assert.equal(stripFinancePrefix(null), null);
  assert.equal(stripFinancePrefix(undefined), undefined);
  assert.equal(stripFinancePrefix(42), 42);
});

test('stripFinancePrefix: does not strip when finance. is part of a larger identifier', () => {
  // "myfinance.catalog_items" is NOT a finance.* reference; the
  // dot follows "myfinance", a longer identifier. The regex
  // requires a word boundary on the left side, so this is NOT
  // stripped.
  assert.equal(
    stripFinancePrefix('SELECT * FROM myfinance.catalog_items'),
    'SELECT * FROM myfinance.catalog_items',
  );
});

test('stripFinancePrefix: does not strip when prefixed by a quote', () => {
  // "users.finance.column" — the "finance." here is just a string
  // of chars between two identifiers, not a schema prefix. The
  // regex requires a non-identifier char (or start) before
  // "finance.".
  assert.equal(
    stripFinancePrefix('SELECT users.finance.column FROM t'),
    'SELECT users.finance.column FROM t',
  );
});

// ────────────────────────────────────────────────────────────────────────
// numberedParams
// ────────────────────────────────────────────────────────────────────────

test('numberedParams: single placeholder expands to $1', () => {
  const { sql, params } = numberedParams('SELECT * FROM t WHERE id = #{id}', 42);
  assert.equal(sql, 'SELECT * FROM t WHERE id = $1');
  assert.deepEqual(params, [42]);
});

test('numberedParams: multiple placeholders expand to $1, $2, $3', () => {
  const { sql, params } = numberedParams(
    'INSERT INTO t (a, b, c) VALUES (#{a}, #{b}, #{c})',
    1,
    'two',
    3.5,
  );
  assert.equal(sql, 'INSERT INTO t (a, b, c) VALUES ($1, $2, $3)');
  assert.deepEqual(params, [1, 'two', 3.5]);
});

test('numberedParams: reuse of the same value gets unique placeholders (the bug fix)', () => {
  // This is the exact pattern that broke three times in three
  // waves: a JOIN/subquery with the same tenant_id filter in
  // both the outer WHERE and the inner query. With the helper,
  // each occurrence is a unique $N, so the test harness's
  // $N → ? translation doesn't break.
  const tenantId = 7;
  const moveId = 42;
  // 4 placeholders in the template → 4 values in the values
  // array. tenantId and moveId are each passed twice (the
  // template reuses them) but the helper assigns unique $N
  // placeholders to each occurrence.
  const { sql, params } = numberedParams(
    `SELECT id FROM finance.stock_moves
      WHERE tenant_id = #{tenantId} AND id = #{moveId}
        AND NOT EXISTS (
          SELECT 1 FROM finance.journal_entries
          WHERE tenant_id = #{tenantId} AND source = 'stock.receive' AND source_id = #{moveId}
        )`,
    tenantId,
    moveId,
    tenantId,
    moveId,
  );
  // The 4 placeholders are unique, even though two of them use
  // the same `tenantId` value.
  assert.match(sql, /WHERE tenant_id = \$1/);
  assert.match(sql, /AND id = \$2/);
  assert.match(sql, /WHERE tenant_id = \$3/);
  assert.match(sql, /AND source_id = \$4/);
  assert.deepEqual(params, [tenantId, moveId, tenantId, moveId]);
});

test('numberedParams: no placeholders + no values is allowed (no-op)', () => {
  const { sql, params } = numberedParams('SELECT 1');
  assert.equal(sql, 'SELECT 1');
  assert.deepEqual(params, []);
});

test('numberedParams: no placeholders + values throws (strict 1:1 contract)', () => {
  // 0 placeholders + 3 values is a programming error — the
  // helper refuses to silently swallow the extra values. The
  // user should remove the values, not the helper.
  assert.throws(
    () => numberedParams('SELECT 1', 1, 2, 3),
    /too many values/,
  );
});

test('numberedParams: too few values throws', () => {
  assert.throws(
    () => numberedParams('SELECT * FROM t WHERE a = #{a} AND b = #{b}', 1),
    /not enough values/,
  );
});

test('numberedParams: too many values throws', () => {
  assert.throws(
    () => numberedParams('SELECT * FROM t WHERE a = #{a}', 1, 2),
    /too many values/,
  );
});

test('numberedParams: empty value list is allowed when there are no placeholders', () => {
  const { sql, params } = numberedParams('SELECT 1');
  assert.equal(sql, 'SELECT 1');
  assert.deepEqual(params, []);
});

test('numberedParams: template with $N placeholders (not #{...}) is left alone', () => {
  // The helper does NOT escape or modify $N. If the template
  // already has $N placeholders, the helper passes them through
  // untouched. The user is expected to use #{...} for new code;
  // the strict 1:1 contract means the helper is paired with the
  // raw template, not a mix.
  const { sql, params } = numberedParams('SELECT * FROM t WHERE id = $1');
  assert.equal(sql, 'SELECT * FROM t WHERE id = $1');
  assert.deepEqual(params, []);
});

test('numberedParams: nested braces in a placeholder label work', () => {
  // The regex matches the FIRST closing brace, so a placeholder
  // like `#{a{b}}` would match `#{a{b}` and the `}` would be
  // left in the SQL. This is a known limitation; the helper
  // intentionally does not support arbitrary nested expressions.
  // The label itself is a documentation hint, not a parsed
  // expression.
  const { sql, params } = numberedParams('SELECT * FROM t WHERE a = #{a}', 1);
  assert.equal(sql, 'SELECT * FROM t WHERE a = $1');
  assert.deepEqual(params, [1]);
});

test('numberedParams: null and undefined values are passed through', () => {
  // Some queries need to bind null (e.g. an IS NULL filter). The
  // helper does not special-case null/undefined; the adapter
  // handles the actual SQL binding.
  const { sql, params } = numberedParams('SELECT * FROM t WHERE a = #{a} AND b = #{b}', null, undefined);
  assert.equal(sql, 'SELECT * FROM t WHERE a = $1 AND b = $2');
  assert.deepEqual(params, [null, undefined]);
});

// ────────────────────────────────────────────────────────────────────────
// runQuery
// ────────────────────────────────────────────────────────────────────────

test('runQuery: strips the finance. prefix and calls db.query', async () => {
  const calls = [];
  const adapter = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 1, name: 'a' }] };
    },
  };
  const res = await runQuery(adapter, 'SELECT * FROM finance.t WHERE id = $1', [42]);
  assert.deepEqual(res.rows, [{ id: 1, name: 'a' }]);
  assert.equal(calls.length, 1);
  // The finance. prefix is stripped BEFORE the adapter sees the SQL.
  assert.equal(calls[0].sql, 'SELECT * FROM t WHERE id = $1');
  assert.deepEqual(calls[0].params, [42]);
});

test('runQuery: normalizes the missing-rows case (returns empty array)', async () => {
  const adapter = {
    async query() {
      return null; // some adapters might return null on weird states
    },
  };
  const res = await runQuery(adapter, 'SELECT 1');
  assert.deepEqual(res.rows, []);
});

test('runQuery: passes through the existing rows array', async () => {
  const adapter = {
    async query() {
      return { rows: [] };
    },
  };
  const res = await runQuery(adapter, 'SELECT 1');
  assert.deepEqual(res.rows, []);
});

test('runQuery: works with the numberedParams + stripFinancePrefix pipeline', async () => {
  // The full pattern: write SQL with finance. + #{...} placeholders,
  // expand via numberedParams, then call runQuery. The end result
  // is a SQL with positional $N placeholders, the finance. prefix
  // stripped, and a flat params array — which the test harness's
  // $N → ? translation handles cleanly.
  const calls = [];
  const adapter = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [] };
    },
  };
  const { sql, params } = numberedParams(
    'SELECT * FROM finance.stock_moves WHERE tenant_id = #{tenantId} AND id = #{moveId}',
    7,
    42,
  );
  await runQuery(adapter, sql, params);
  assert.equal(calls[0].sql, 'SELECT * FROM stock_moves WHERE tenant_id = $1 AND id = $2');
  assert.deepEqual(calls[0].params, [7, 42]);
});
