// Tests for server/finance/reports.js — CFO dashboard queries (AR aging,
// revenue, top customers, VAT summary).
//
// All tests share an in-memory mock DB (mirroring the invoice.test.js
// makeMockDb pattern) that models finance.customers, finance.invoices, and
// finance.payments. The reports module is read-only — it never issues
// INSERT/UPDATE/DELETE — so the mock's only job is to evaluate SELECT
// queries against the in-memory model and return { rows }.
//
// TDD: this file lands in commit A (RED). The reports.js module is a stub
// that throws NotImplementedError on every export. Tests are expected to
// fail until commit B introduces the real implementation.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

// ────────────────────────────────────────────────────────────────────────────
// In-memory mock DB — read-only reporting surface + minimal seed path.
// Mirrors the schema in server/finance/migrations/0001_init.sql +
// 0002_invoice_status_tracking.sql.
// ────────────────────────────────────────────────────────────────────────────

function makeMockDb() {
  const customers = new Map(); // id → row
  const invoices = new Map(); // id → row
  const payments = new Map(); // id → row
  let nextCustomerId = 1;
  let nextInvoiceId = 1;
  let nextPaymentId = 1;
  const statements = [];

  function nextId(map) {
    if (map === customers) return nextCustomerId++;
    if (map === invoices) return nextInvoiceId++;
    if (map === payments) return nextPaymentId++;
    throw new Error('mock: unknown map');
  }

  // Tiny SQL classifier — enough to route the report queries to the
  // right in-memory handler. The reports module issues ONLY SELECTs
  // (no INSERT/UPDATE/DELETE) so we only need to model the read paths.
  function classify(sql) {
    const s = sql.trim().toUpperCase();
    if (/^INSERT\s+INTO\s+FINANCE\.CUSTOMERS/.test(s)) return 'customer-insert';
    if (/^INSERT\s+INTO\s+FINANCE\.INVOICES/.test(s)) return 'invoice-insert';
    if (/^INSERT\s+INTO\s+FINANCE\.PAYMENTS/.test(s)) return 'payment-insert';
    // Use [\s\S] instead of . so the match tolerates newlines (the
    // production SQL is multi-line). JOINs: invoice↔customer and
    // payment↔invoice need to be detected explicitly so the mock
    // stitches the two tables together.
    if (/SELECT[\s\S]*FROM\s+FINANCE\.INVOICES/i.test(s) && /JOIN\s+FINANCE\.CUSTOMERS/i.test(s))
      return 'report-join';
    if (/SELECT[\s\S]*FROM\s+FINANCE\.PAYMENTS/i.test(s) && /JOIN\s+FINANCE\.INVOICES/i.test(s))
      return 'report-payments-join';
    if (/SELECT[\s\S]*FROM\s+FINANCE\.INVOICES/i.test(s)) return 'report-invoices';
    if (/SELECT[\s\S]*FROM\s+FINANCE\.PAYMENTS/i.test(s)) return 'report-payments';
    return 'passthrough';
  }

  // pg-style .query(sql, params)
  async function query(sql, params) {
    statements.push({ kind: classify(sql), sql, params: params ?? [] });
    const ps = params ?? [];
    const kind = classify(sql);

    if (kind === 'customer-insert') {
      const id = nextId(customers);
      customers.set(id, { id, name: ps[0], hvhh: ps[1] ?? null });
      return { rows: [] };
    }
    if (kind === 'invoice-insert') {
      const id = nextId(invoices);
      invoices.set(id, {
        id,
        customer_id: Number(ps[0]),
        invoice_number: ps[1],
        issue_date: ps[2],
        due_date: ps[3],
        subtotal_amd: Number(ps[4]),
        vat_amd: Number(ps[5]),
        total_amd: Number(ps[6]),
        status: ps[7] ?? 'sent',
        notes: ps[8] ?? null,
        sent_at: ps[7] && ps[7] !== 'draft' ? new Date().toISOString() : null,
        voided_at: null,
        void_reason: null,
      });
      return { rows: [] };
    }
    if (kind === 'payment-insert') {
      const id = nextId(payments);
      payments.set(id, {
        id,
        invoice_id: Number(ps[0]),
        paid_at: ps[1],
        amount_amd: Number(ps[2]),
        method: ps[3] ?? 'bank_transfer',
        reference: ps[4] ?? null,
      });
      return { rows: [] };
    }

    // ── Read paths ──────────────────────────────────────────────────────
    // Parse out the optional WHERE clause (if any), the column list, and
    // whether the query asks for SUM(...) aggregations.
    const upper = sql.toUpperCase();
    const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+GROUP\s+BY|\s+ORDER\s+BY|\s+LIMIT|$)/i);
    const groupBy = /GROUP\s+BY/i.test(upper);
    const orderBy = sql.match(/ORDER\s+BY\s+([\s\S]+?)(?:\s+LIMIT|$)/i);
    // LIMIT can use either a literal (`LIMIT 10`) or a parameter
    // (`LIMIT $N`). Pick the placeholder index and read the value from
    // `ps` like the conds loop does.
    const limitMatch = sql.match(/LIMIT\s+\$?(\d+)/i);
    let limit;
    if (limitMatch) {
      const idx = Number(limitMatch[1]) - 1;
      if (limitMatch[0].includes('$')) {
        limit = ps[idx] != null ? Number(ps[idx]) : undefined;
      } else {
        limit = idx;
      }
    }

    // Build the candidate row set.
    const candidateRows = [];
    if (kind === 'report-payments-join') {
      // Payment-side JOIN: payment row + invoice row stitched together
      // (caller SELECTs the columns it wants; we hand back the join).
      for (const p of payments.values()) {
        const inv = invoices.get(p.invoice_id);
        if (!inv) continue;
        candidateRows.push({ ...p, ...inv });
      }
    } else if (kind === 'report-join') {
      // Customer × invoice JOIN
      for (const inv of invoices.values()) {
        const cust = customers.get(inv.customer_id);
        if (!cust) continue;
        // Surface the customer id under BOTH `cust_id` (the join key) and
        // `customer_id` (the alias the production SQL uses after the
        // JOIN: `c.id AS customer_id`). The original invoice fields are
        // kept verbatim so the WHERE/GROUP BY on `i.*` still work.
        candidateRows.push({
          ...inv,
          name: cust.name,
          hvhh: cust.hvhh,
          cust_id: cust.id,
        });
      }
    } else if (kind === 'report-invoices') {
      for (const inv of invoices.values()) candidateRows.push({ ...inv });
    } else if (kind === 'report-payments') {
      for (const p of payments.values()) candidateRows.push({ ...p });
    } else {
      return { rows: [] };
    }

    // Apply WHERE filters.
    let filtered = candidateRows;
    if (whereMatch) {
      const where = whereMatch[1];
      const conds = where.split(/\s+AND\s+/i);
      for (const c of conds) {
        // Match `col op <rhs>` where rhs is either a $N parameter or a
        // 'literal' string. col can be a table-prefixed reference like
        // `i.due_date` (we strip the prefix for the row lookup). Ops:
        // =, !=, <>, <, >, <=, >=.
        const m = c.match(/([\w.]+)\s*(=|!=|<>|<=|>=|<|>)\s*('([^']*)'|\$?(\d+))/);
        if (!m) continue;
        const rawCol = m[1];
        const col = rawCol.includes('.') ? rawCol.split('.').pop() : rawCol;
        const op = m[2];
        let val;
        if (m[4] !== undefined) {
          val = m[4]; // string literal
        } else {
          val = ps[Number(m[5]) - 1]; // param ref
        }
        filtered = filtered.filter((row) => {
          const v = row[col];
          if (op === '=') return v === val;
          if (op === '!=' || op === '<>') return v !== val;
          if (op === '<=') return v <= val;
          if (op === '>=') return v >= val;
          if (op === '<') return v < val;
          if (op === '>') return v > val;
          return true;
        });
      }
      // Also support status IN (...) pattern: "status IN ($1, $2, ...)".
      // The column reference can be table-prefixed (e.g. `i.status`).
      const inMatch = where.match(/(?:[\w.]+\.)?status\s+IN\s*\(([^)]+)\)/i);
      if (inMatch) {
        const placeholders = inMatch[1].split(',').map((s) => s.trim());
        const statuses = placeholders.map((p) => {
          const m2 = p.match(/\$?(\d+)/);
          return ps[Number(m2[1]) - 1];
        });
        filtered = filtered.filter((row) => statuses.includes(row.status));
      }
    }

    // Build the result row set, then apply ORDER BY + LIMIT at the end
    // so aliases (`total_billed_amd`) resolve on the projected row, not
    // on the raw candidate row.
    let resultRows = null;

    // Project SELECT columns.
    const selectMatch = sql.match(/SELECT\s+([\s\S]+?)\s+FROM/i);
    if (selectMatch) {
      const cols = selectMatch[1].trim();
      // GROUP BY first — when grouping, SUM/COUNT are per-group, not
      // global. This matters for the getTopCustomers and
      // buildPaidByInvoice paths.
      if (groupBy) {
        const groupByMatch = sql.match(/GROUP\s+BY\s+([\s\S]+?)(?:\s+ORDER\s+BY|\s+LIMIT|$)/i);
        if (groupByMatch) {
          // Support multiple group-by columns, each possibly table-prefixed
          // (`c.id, c.name, c.hvhh`). We resolve `prefix.col` to the
          // underlying row field — for the customer alias `c`, the id
          // lives in the joined row's `cust_id` (the invoice's
          // `customer_id` would also work, but the join places the
          // customer row's id separately so the column references resolve
          // unambiguously).
          const groupCols = groupByMatch[1].split(',').map((s) => s.trim());
          const resolveCol = (ref) => {
            if (!ref.includes('.')) return ref;
            const [alias, col] = ref.split('.');
            if (alias === 'c') {
              // customer alias: id → cust_id, others map directly
              if (col === 'id') return 'cust_id';
              return col;
            }
            // default: strip prefix
            return col;
          };
          const resolvedCols = groupCols.map(resolveCol);
          const groups = new Map();
          for (const row of filtered) {
            const key = resolvedCols.map((c) => row[c]).join('\x00');
            if (!groups.has(key)) {
              groups.set(key, {
                keyCols: resolvedCols.map((c) => row[c]),
                rows: [],
              });
            }
            groups.get(key).rows.push(row);
          }
          const out = [];
          for (const g of groups.values()) {
            const r = {};
            // Populate the group-by columns under their resolved names.
            for (let i = 0; i < resolvedCols.length; i += 1) r[resolvedCols[i]] = g.keyCols[i];
            // SUM(col) AS alias — resolve the column reference (strip
            // table alias prefix) so `i.total_amd` looks up `row.total_amd`.
            const sumRegex = /SUM\s*\(\s*([^)]+?)\s*\)\s+AS\s+(\w+)/gi;
            let sm;
            while ((sm = sumRegex.exec(cols)) !== null) {
              const sumRef = sm[1];
              const sumCol = sumRef.includes('.') ? sumRef.split('.').pop() : sumRef;
              const alias = sm[2];
              r[alias] = g.rows.reduce((acc, row) => acc + Number(row[sumCol] || 0), 0);
            }
            // COUNT(*) AS alias
            const countRegex = /COUNT\s*\(\s*\*\s*\)\s+AS\s+(\w+)/i;
            const cm = cols.match(countRegex);
            if (cm) r[cm[1]] = g.rows.length;
            // Copy through non-aggregated, non-group columns from the first
            // row (e.g. `c.name AS customer_name`).
            const colList = cols.split(',').map((s) => s.trim());
            for (const c of colList) {
              if (/^(SUM|COUNT|COALESCE)\s*\(/i.test(c)) continue;
              // `prefix.col` (no AS) — resolve alias, copy if not already a group col.
              const bare = c.match(/^([\w]+)\.(\w+)$/);
              if (bare) {
                const fieldName = resolveCol(c);
                if (!(fieldName in r)) r[fieldName] = g.rows[0][fieldName];
                continue;
              }
              // `prefix.col AS alias` — resolve prefix, copy under alias.
              const prefAs = c.match(/^([\w]+)\.(\w+)\s+AS\s+(\w+)$/i);
              if (prefAs) {
                const fieldName = resolveCol(`${prefAs[1]}.${prefAs[2]}`);
                r[prefAs[3]] = g.rows[0][fieldName];
                continue;
              }
              // `col AS alias` (no prefix)
              const asMatch = c.match(/^(\w+)\s+AS\s+(\w+)$/i);
              if (asMatch) {
                if (!(asMatch[2] in r)) r[asMatch[2]] = g.rows[0][asMatch[1]];
                continue;
              }
              // bare column name
              if (/^\w+$/.test(c) && !(c in r)) {
                r[c] = g.rows[0][c];
              }
            }
            out.push(r);
          }
          resultRows = out;
        }
      } else {
        // No GROUP BY: support multiple aggregations in one row.
        const sumMatch = cols.match(/SUM\s*\(\s*([^)]+?)\s*\)/i);
        const countMatch = cols.match(/COUNT\s*\(\s*\*\s*\)/i);
        if (sumMatch || countMatch) {
          const out = {};
          if (sumMatch) {
            // Strip COALESCE(SUM(col), 0) wrappers for the column lookup.
            const sumCol = sumMatch[1]
              .replace(/^COALESCE\s*\(\s*|\s*,\s*0\s*\)(\s+AS\s+\w+)?$/gi, '')
              .trim();
            const total = filtered.reduce((acc, row) => acc + Number(row[sumCol] || 0), 0);
            // Find the alias for this SUM. Use a non-greedy scan so we pair
            // the SUM with its nearest AS.
            const sumAliasMatch = cols.match(
              new RegExp(
                `SUM\\s*\\(\\s*${sumCol.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\s*\\)\\s*(?:,\\s*0\\s*\\))?\\s+AS\\s+(\\w+)`,
                'i',
              ),
            );
            if (sumAliasMatch) out[sumAliasMatch[1]] = total;
            else out.sum = total;
          }
          if (countMatch) {
            const countAliasMatch = cols.match(/COUNT\s*\(\s*\*\s*\)\s+AS\s+(\w+)/i);
            if (countAliasMatch) out[countAliasMatch[1]] = filtered.length;
            else out.count = filtered.length;
          }
          resultRows = [out];
        } else if (cols === '*') {
          // Wildcard: keep raw row objects so any subsequent SELECT-list
          // replacement (e.g. by callers) sees the full schema.
          resultRows = filtered;
        } else {
          // Column list: project. Strip table prefixes so `i.id` looks up
          // `row.id`, and `c.name AS customer_name` looks up `row.name`.
          const colList = cols.split(',').map((s) => s.trim());
          resultRows = filtered.map((row) => {
            const out = {};
            for (const c of colList) {
              // `prefix.col` (no AS)
              const bare = c.match(/^[\w]+\.(\w+)$/);
              if (bare) {
                out[bare[1]] = row[bare[1]];
                continue;
              }
              // `prefix.col AS alias`
              const prefAs = c.match(/^[\w]+\.(\w+)\s+AS\s+(\w+)$/i);
              if (prefAs) {
                out[prefAs[2]] = row[prefAs[1]];
                continue;
              }
              // `col AS alias`
              const asMatch = c.match(/^(\w+)\s+AS\s+(\w+)$/i);
              if (asMatch) {
                out[asMatch[2]] = row[asMatch[1]];
                continue;
              }
              // bare col
              out[c] = row[c];
            }
            return out;
          });
        }
      }
    }
    if (resultRows === null) resultRows = filtered;

    // Apply ORDER BY, then LIMIT, to the post-aggregation / post-projection
    // rows. Aliased column references resolve on the projected row, and
    // LIMIT bounds the number of groups the caller sees.
    if (orderBy) resultRows = applyOrderBy(resultRows, orderBy);
    if (limit !== undefined) resultRows = resultRows.slice(0, limit);

    return { rows: resultRows };
  }

  // Apply an `ORDER BY <cols>` clause to an array of rows. Each sort
  // key can be a bare column or a table-prefixed column (`i.due_date`).
  // The `dir` is `ASC` (default) or `DESC`. Nulls sort last.
  function applyOrderBy(rows, orderBy) {
    const orderClause = orderBy[1].trim();
    const sortKeys = orderClause.split(',').map((s) => {
      const parts = s.trim().split(/\s+/);
      const col = parts[0];
      const dir = (parts[1] || 'ASC').toUpperCase();
      const field = col.includes('.') ? col.split('.').pop() : col;
      return { field, dir };
    });
    return [...rows].sort((a, b) => {
      for (const k of sortKeys) {
        const av = a[k.field];
        const bv = b[k.field];
        if (av == null && bv == null) continue;
        if (av == null) return 1;
        if (bv == null) return -1;
        if (av < bv) return k.dir === 'DESC' ? 1 : -1;
        if (av > bv) return k.dir === 'DESC' ? -1 : 1;
      }
      return 0;
    });
  }

  // sqlite-style .prepare() — same routing.
  function prepare(sql) {
    return {
      run() {
        return { changes: 0 };
      },
      async all(...params) {
        return (await query(sql, params)).rows;
      },
      async get(...params) {
        const r = await query(sql, params);
        return r.rows[0] ?? null;
      },
    };
  }
  function exec(sql) {
    return query(sql, []);
  }

  return {
    kind: 'mock',
    customers,
    invoices,
    payments,
    statements,
    query,
    prepare,
    exec,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Seed helpers — keep test setup terse.
// ────────────────────────────────────────────────────────────────────────────

async function seedCustomer(db, { name, hvhh = null }) {
  await db.query('INSERT INTO finance.customers (name, hvhh) VALUES ($1, $2)', [name, hvhh]);
  return db.customers.size; // last id assigned
}

async function seedInvoice(
  db,
  { customer_id, invoice_number, issue_date, due_date, total_amd, vat_amd = 0, status = 'sent' },
) {
  const subtotal = total_amd - vat_amd;
  await db.query(
    `INSERT INTO finance.invoices
       (customer_id, invoice_number, issue_date, due_date,
        subtotal_amd, vat_amd, total_amd, status, notes, sent_at, voided_at, void_reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
    [
      customer_id,
      invoice_number,
      issue_date,
      due_date,
      subtotal,
      vat_amd,
      total_amd,
      status,
      null,
      status !== 'draft' ? new Date().toISOString() : null,
      null,
      null,
    ],
  );
  return db.invoices.size;
}

async function seedPayment(db, { invoice_id, paid_at, amount_amd, method = 'bank_transfer' }) {
  await db.query(
    `INSERT INTO finance.payments (invoice_id, paid_at, amount_amd, method, reference) VALUES ($1, $2, $3, $4, $5)`,
    [invoice_id, paid_at, amount_amd, method, null],
  );
  return db.payments.size;
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('finance reports', () => {
  let db;
  let getArAging;
  let listOverdueInvoices;
  let getMonthlyRevenue;
  let getTopCustomers;
  let getVatSummary;

  before(async () => {
    db = makeMockDb();
    const mod = await import('./reports.js');
    getArAging = mod.getArAging;
    listOverdueInvoices = mod.listOverdueInvoices;
    getMonthlyRevenue = mod.getMonthlyRevenue;
    getTopCustomers = mod.getTopCustomers;
    getVatSummary = mod.getVatSummary;
  });

  // ──────────────────────────────────────────────────────────────────
  // getArAging
  // ──────────────────────────────────────────────────────────────────

  describe('getArAging', () => {
    test('1. empty DB → all buckets zero, total 0', async () => {
      const out = await getArAging(db, '2026-06-20');
      assert.equal(out.asOfDate, '2026-06-20');
      assert.equal(out.total_outstanding_amd, 0);
      assert.deepEqual(out.buckets, {
        '0_30': { invoice_count: 0, amount_amd: 0 },
        '31_60': { invoice_count: 0, amount_amd: 0 },
        '61_90': { invoice_count: 0, amount_amd: 0 },
        '90_plus': { invoice_count: 0, amount_amd: 0 },
      });
    });

    test('2. mixed-age scenario: one invoice per bucket', async () => {
      // Use a fresh DB for this test to keep counts predictable.
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'Acme LLC', hvhh: '12345678' });
      // asOfDate = 2026-06-20
      // 0-30 days overdue → due_date in (2026-05-21 .. 2026-06-20]  i.e. due 2026-06-01 (49 days ago? no)
      //   Wait: days_overdue = asOfDate - due_date. So 0-30 → due_date in [asOf-30d, asOf-1d]
      //   = [2026-05-21, 2026-06-19]
      // 31-60 days overdue → due_date in [2026-04-21, 2026-05-20]
      // 61-90 days overdue → due_date in [2026-03-22, 2026-04-20]
      // 90+ days overdue    → due_date <= 2026-03-21
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'A-1',
        issue_date: '2026-05-01',
        due_date: '2026-06-10',
        total_amd: 100000,
        status: 'sent',
      }); // 10 days overdue → 0_30
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'A-2',
        issue_date: '2026-04-01',
        due_date: '2026-05-10',
        total_amd: 200000,
        status: 'sent',
      }); // 41 days overdue → 31_60
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'A-3',
        issue_date: '2026-03-01',
        due_date: '2026-04-10',
        total_amd: 300000,
        status: 'overdue',
      }); // 71 days overdue → 61_90
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'A-4',
        issue_date: '2025-12-01',
        due_date: '2026-01-15',
        total_amd: 400000,
        status: 'overdue',
      }); // 156 days overdue → 90_plus
      const out = await getArAging(localDb, '2026-06-20');
      assert.equal(out.buckets['0_30'].invoice_count, 1);
      assert.equal(out.buckets['0_30'].amount_amd, 100000);
      assert.equal(out.buckets['31_60'].invoice_count, 1);
      assert.equal(out.buckets['31_60'].amount_amd, 200000);
      assert.equal(out.buckets['61_90'].invoice_count, 1);
      assert.equal(out.buckets['61_90'].amount_amd, 300000);
      assert.equal(out.buckets['90_plus'].invoice_count, 1);
      assert.equal(out.buckets['90_plus'].amount_amd, 400000);
      assert.equal(out.total_outstanding_amd, 1000000);
    });

    test('3. paid invoice is excluded from aging', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'P-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 999999,
        status: 'paid',
      });
      const out = await getArAging(localDb, '2026-06-20');
      assert.equal(out.total_outstanding_amd, 0);
      assert.equal(out.buckets['90_plus'].invoice_count, 0);
    });

    test('4. draft and void invoices are excluded from aging', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'D-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 100000,
        status: 'draft',
      });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'V-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 200000,
        status: 'void',
      });
      const out = await getArAging(localDb, '2026-06-20');
      assert.equal(out.total_outstanding_amd, 0);
    });

    test('5. partial payments reduce the outstanding amount', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      const invId = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'PP-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 100000,
        status: 'sent',
      });
      await seedPayment(localDb, {
        invoice_id: invId,
        paid_at: '2026-05-01T00:00:00Z',
        amount_amd: 30000,
      });
      const out = await getArAging(localDb, '2026-06-20');
      // 100000 - 30000 = 70000 outstanding in 90_plus bucket
      assert.equal(out.buckets['90_plus'].amount_amd, 70000);
      assert.equal(out.total_outstanding_amd, 70000);
    });

    test('6. not-yet-due invoices are excluded from aging', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'F-1',
        issue_date: '2026-06-01',
        due_date: '2026-07-15',
        total_amd: 100000,
        status: 'sent',
      });
      const out = await getArAging(localDb, '2026-06-20');
      assert.equal(out.total_outstanding_amd, 0);
    });

    test('7. asOfDate format check: rejects bad input', async () => {
      await assert.rejects(() => getArAging(db, 'not-a-date'), /asOfDate|YYYY/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // listOverdueInvoices
  // ──────────────────────────────────────────────────────────────────

  describe('listOverdueInvoices', () => {
    test('8. empty → []', async () => {
      const localDb = makeMockDb();
      const out = await listOverdueInvoices(localDb, '2026-06-20');
      assert.deepEqual(out, []);
    });

    test('9. mixed invoices: sorted by days_overdue DESC, balances correct', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'Acme LLC' });
      // 30 days overdue
      const inv1 = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'OV-1',
        issue_date: '2026-04-20',
        due_date: '2026-05-21',
        total_amd: 100000,
        status: 'sent',
      });
      // 90 days overdue
      const inv2 = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'OV-2',
        issue_date: '2026-02-20',
        due_date: '2026-03-22',
        total_amd: 200000,
        status: 'overdue',
      });
      // 10 days overdue (partial paid)
      const inv3 = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'OV-3',
        issue_date: '2026-05-01',
        due_date: '2026-06-10',
        total_amd: 50000,
        status: 'sent',
      });
      await seedPayment(localDb, {
        invoice_id: inv3,
        paid_at: '2026-06-01T00:00:00Z',
        amount_amd: 20000,
      });

      const out = await listOverdueInvoices(localDb, '2026-06-20');
      assert.equal(out.length, 3);
      // Sorted by days_overdue DESC: inv2 (90) > inv1 (30) > inv3 (10)
      assert.equal(out[0].invoice_number, 'OV-2');
      assert.equal(out[0].days_overdue, 90);
      assert.equal(out[0].balance_amd, 200000);
      assert.equal(out[1].invoice_number, 'OV-1');
      assert.equal(out[1].days_overdue, 30);
      assert.equal(out[1].balance_amd, 100000);
      assert.equal(out[2].invoice_number, 'OV-3');
      assert.equal(out[2].days_overdue, 10);
      assert.equal(out[2].paid_amd, 20000);
      assert.equal(out[2].balance_amd, 30000);
      assert.equal(out[0].customer_name, 'Acme LLC');
      // IDs match
      assert.equal(out[0].id, inv2);
      assert.equal(out[1].id, inv1);
      assert.equal(out[2].id, inv3);
    });

    test('10. respects limit parameter (default 50, custom 2)', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      // Create 5 invoices with different days_overdue.
      for (let i = 0; i < 5; i++) {
        const daysAgo = (i + 1) * 10; // 10, 20, 30, 40, 50
        const due = new Date('2026-06-20');
        due.setDate(due.getDate() - daysAgo);
        const dueStr = due.toISOString().slice(0, 10);
        await seedInvoice(localDb, {
          customer_id: custId,
          invoice_number: `L-${i}`,
          issue_date: '2026-01-01',
          due_date: dueStr,
          total_amd: 10000,
          status: 'sent',
        });
      }
      const def = await listOverdueInvoices(localDb, '2026-06-20');
      assert.equal(def.length, 5); // only 5 exist
      const lim = await listOverdueInvoices(localDb, '2026-06-20', 2);
      assert.equal(lim.length, 2);
      // top 2 by days_overdue DESC
      assert.equal(lim[0].days_overdue, 50);
      assert.equal(lim[1].days_overdue, 40);
    });

    test('11. paid and future invoices excluded', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'P-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 100000,
        status: 'paid',
      });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'F-1',
        issue_date: '2026-06-01',
        due_date: '2026-07-15',
        total_amd: 100000,
        status: 'sent',
      });
      const out = await listOverdueInvoices(localDb, '2026-06-20');
      assert.equal(out.length, 0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // getMonthlyRevenue
  // ──────────────────────────────────────────────────────────────────

  describe('getMonthlyRevenue', () => {
    test('12. empty month → all zeros', async () => {
      const out = await getMonthlyRevenue(db, '2026-06');
      assert.deepEqual(out, {
        year_month: '2026-06',
        invoiced_amd: 0,
        collected_amd: 0,
        outstanding_amd: 0,
        invoice_count: 0,
        paid_count: 0,
      });
    });

    test('13. mixed month: partial + full payments, invoiced/collected/outstanding', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      // Invoice A: 100k issued in June, fully paid in June
      const invA = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'M-A',
        issue_date: '2026-06-05',
        due_date: '2026-07-05',
        total_amd: 100000,
        status: 'paid',
      });
      await seedPayment(localDb, {
        invoice_id: invA,
        paid_at: '2026-06-15T00:00:00Z',
        amount_amd: 100000,
      });
      // Invoice B: 50k issued in June, partially paid (20k) in June
      const invB = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'M-B',
        issue_date: '2026-06-10',
        due_date: '2026-07-10',
        total_amd: 50000,
        status: 'sent',
      });
      await seedPayment(localDb, {
        invoice_id: invB,
        paid_at: '2026-06-20T00:00:00Z',
        amount_amd: 20000,
      });
      // Invoice C: 30k issued in July (out of month)
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'M-C',
        issue_date: '2026-07-05',
        due_date: '2026-08-05',
        total_amd: 30000,
        status: 'sent',
      });
      const out = await getMonthlyRevenue(localDb, '2026-06');
      assert.equal(out.invoiced_amd, 150000); // A + B
      assert.equal(out.collected_amd, 120000); // 100k + 20k
      assert.equal(out.outstanding_amd, 30000); // 50k - 20k on B
      assert.equal(out.invoice_count, 2);
      assert.equal(out.paid_count, 1);
    });

    test('14. month filter excludes out-of-month invoices', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'APR',
        issue_date: '2026-04-15',
        due_date: '2026-05-15',
        total_amd: 99999,
        status: 'paid',
      });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'JUL',
        issue_date: '2026-07-15',
        due_date: '2026-08-15',
        total_amd: 88888,
        status: 'paid',
      });
      const out = await getMonthlyRevenue(localDb, '2026-06');
      assert.equal(out.invoiced_amd, 0);
      assert.equal(out.invoice_count, 0);
    });

    test('15. invalid yearMonth format → ValueError', async () => {
      await assert.rejects(() => getMonthlyRevenue(db, '2026-6'), /YYYY-MM/);
      await assert.rejects(() => getMonthlyRevenue(db, 'june-2026'), /YYYY-MM/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // getTopCustomers
  // ──────────────────────────────────────────────────────────────────

  describe('getTopCustomers', () => {
    test('16. empty → []', async () => {
      const out = await getTopCustomers(db);
      assert.deepEqual(out, []);
    });

    test('17. mixed: sort by billed DESC, totals correct, hvhh included', async () => {
      const localDb = makeMockDb();
      const c1 = await seedCustomer(localDb, { name: 'Big Customer', hvhh: '11111111' });
      const c2 = await seedCustomer(localDb, { name: 'Medium Co', hvhh: '22222222' });
      const c3 = await seedCustomer(localDb, { name: 'Small LLC' }); // hvhh null
      // Big: 3 invoices, 500k total
      await seedInvoice(localDb, {
        customer_id: c1,
        invoice_number: 'B-1',
        issue_date: '2026-05-01',
        due_date: '2026-05-31',
        total_amd: 200000,
        status: 'paid',
      });
      await seedInvoice(localDb, {
        customer_id: c1,
        invoice_number: 'B-2',
        issue_date: '2026-05-15',
        due_date: '2026-06-14',
        total_amd: 200000,
        status: 'sent',
      });
      await seedInvoice(localDb, {
        customer_id: c1,
        invoice_number: 'B-3',
        issue_date: '2026-06-01',
        due_date: '2026-07-01',
        total_amd: 100000,
        status: 'sent',
      });
      // Medium: 1 invoice, 300k, fully paid
      const m1 = await seedInvoice(localDb, {
        customer_id: c2,
        invoice_number: 'M-1',
        issue_date: '2026-05-10',
        due_date: '2026-06-09',
        total_amd: 300000,
        status: 'paid',
      });
      await seedPayment(localDb, {
        invoice_id: m1,
        paid_at: '2026-05-20T00:00:00Z',
        amount_amd: 300000,
      });
      // Small: 1 invoice, 50k, unpaid
      await seedInvoice(localDb, {
        customer_id: c3,
        invoice_number: 'S-1',
        issue_date: '2026-06-05',
        due_date: '2026-07-05',
        total_amd: 50000,
        status: 'sent',
      });

      const out = await getTopCustomers(localDb);
      assert.equal(out.length, 3);
      assert.equal(out[0].customer_name, 'Big Customer');
      assert.equal(out[0].total_billed_amd, 500000);
      assert.equal(out[0].hvhh, '11111111');
      assert.equal(out[0].invoice_count, 3);
      assert.equal(out[0].total_paid_amd, 0); // B-1 has no payment recorded in seed
      assert.equal(out[1].customer_name, 'Medium Co');
      assert.equal(out[1].total_billed_amd, 300000);
      assert.equal(out[1].total_paid_amd, 300000);
      assert.equal(out[2].customer_name, 'Small LLC');
      assert.equal(out[2].hvhh, null);
      assert.equal(out[2].total_billed_amd, 50000);
    });

    test('18. respects limit and since/until window', async () => {
      const localDb = makeMockDb();
      const c1 = await seedCustomer(localDb, { name: 'A' });
      const c2 = await seedCustomer(localDb, { name: 'B' });
      const c3 = await seedCustomer(localDb, { name: 'C' });
      await seedInvoice(localDb, {
        customer_id: c1,
        invoice_number: 'A-1',
        issue_date: '2026-04-15',
        due_date: '2026-05-15',
        total_amd: 100000,
        status: 'paid',
      });
      await seedInvoice(localDb, {
        customer_id: c2,
        invoice_number: 'B-1',
        issue_date: '2026-05-20',
        due_date: '2026-06-19',
        total_amd: 200000,
        status: 'paid',
      });
      await seedInvoice(localDb, {
        customer_id: c3,
        invoice_number: 'C-1',
        issue_date: '2026-06-10',
        due_date: '2026-07-10',
        total_amd: 300000,
        status: 'paid',
      });
      // Default limit (10) returns all 3
      const all = await getTopCustomers(localDb);
      assert.equal(all.length, 3);
      // Limit 2 → top 2 by billed DESC (C then B; A is out)
      const lim = await getTopCustomers(localDb, { limit: 2 });
      assert.equal(lim.length, 2);
      assert.equal(lim[0].customer_name, 'C');
      assert.equal(lim[1].customer_name, 'B');
      // since/until = June only → only C
      const june = await getTopCustomers(localDb, { since: '2026-06-01', until: '2026-06-30' });
      assert.equal(june.length, 1);
      assert.equal(june[0].customer_name, 'C');
      // since/until = May only → only B
      const may = await getTopCustomers(localDb, { since: '2026-05-01', until: '2026-05-31' });
      assert.equal(may.length, 1);
      assert.equal(may[0].customer_name, 'B');
    });

    test('19. void invoices excluded from totals', async () => {
      const localDb = makeMockDb();
      const c1 = await seedCustomer(localDb, { name: 'VCo' });
      await seedInvoice(localDb, {
        customer_id: c1,
        invoice_number: 'V-1',
        issue_date: '2026-05-01',
        due_date: '2026-05-31',
        total_amd: 999999,
        status: 'void',
      });
      const out = await getTopCustomers(localDb);
      assert.equal(out.length, 0);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // getVatSummary
  // ──────────────────────────────────────────────────────────────────

  describe('getVatSummary', () => {
    test('20. empty window → all zeros', async () => {
      const out = await getVatSummary(db, '2026-01-01', '2026-12-31');
      assert.equal(out.since, '2026-01-01');
      assert.equal(out.until, '2026-12-31');
      assert.equal(out.vat_invoiced_amd, 0);
      assert.equal(out.vat_paid_amd, 0);
      assert.equal(out.net_vat_position_amd, 0);
      assert.equal(out.invoice_count, 0);
    });

    test('21. mixed (paid + unpaid): net position math', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      // Invoice 1: 100k subtotal + 20k VAT = 120k total, paid
      const inv1 = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'V-1',
        issue_date: '2026-05-01',
        due_date: '2026-05-31',
        total_amd: 120000,
        vat_amd: 20000,
        status: 'paid',
      });
      await seedPayment(localDb, {
        invoice_id: inv1,
        paid_at: '2026-05-15T00:00:00Z',
        amount_amd: 120000,
      });
      // Invoice 2: 50k subtotal + 10k VAT = 60k total, unpaid
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'V-2',
        issue_date: '2026-06-01',
        due_date: '2026-07-01',
        total_amd: 60000,
        vat_amd: 10000,
        status: 'sent',
      });
      // Out of window: 80k total, 16k VAT
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'V-3',
        issue_date: '2027-01-01',
        due_date: '2027-02-01',
        total_amd: 96000,
        vat_amd: 16000,
        status: 'sent',
      });
      const out = await getVatSummary(localDb, '2026-01-01', '2026-12-31');
      assert.equal(out.vat_invoiced_amd, 30000); // 20k + 10k
      assert.equal(out.vat_paid_amd, 20000); // only inv1 is fully paid
      assert.equal(out.net_vat_position_amd, 10000); // 30k - 20k
      assert.equal(out.invoice_count, 2);
    });

    test('22. date range filter: invoices outside window excluded', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'IN',
        issue_date: '2026-06-15',
        due_date: '2026-07-15',
        total_amd: 24000,
        vat_amd: 4000,
        status: 'paid',
      });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'OUT',
        issue_date: '2025-12-15',
        due_date: '2026-01-15',
        total_amd: 12000,
        vat_amd: 2000,
        status: 'paid',
      });
      const out = await getVatSummary(localDb, '2026-06-01', '2026-06-30');
      assert.equal(out.vat_invoiced_amd, 4000);
      assert.equal(out.invoice_count, 1);
    });

    test('23. invalid date format → ValueError', async () => {
      await assert.rejects(() => getVatSummary(db, 'bad', '2026-12-31'), /since/);
      await assert.rejects(() => getVatSummary(db, '2026-01-01', 'nope'), /until/);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // Branch coverage: input-validation guards + sqlite adapter.
  // These push the c8 branch-coverage floor above 80%.
  // ──────────────────────────────────────────────────────────────────

  describe('input validation + sqlite adapter (branch coverage)', () => {
    test('24. listOverdueInvoices: non-positive / non-integer limit → ValueError', async () => {
      await assert.rejects(() => listOverdueInvoices(db, '2026-06-20', 0), /limit/);
      await assert.rejects(() => listOverdueInvoices(db, '2026-06-20', -1), /limit/);
      await assert.rejects(() => listOverdueInvoices(db, '2026-06-20', 'abc'), /limit/);
      await assert.rejects(() => listOverdueInvoices(db, '2026-06-20', 1.5), /limit/);
    });

    test('25. getMonthlyRevenue: invalid month (e.g. 13) → ValueError', async () => {
      await assert.rejects(() => getMonthlyRevenue(db, '2026-13'), /YYYY-MM|real/);
      await assert.rejects(() => getMonthlyRevenue(db, '2026-00'), /YYYY-MM|real/);
    });

    test('26. listOverdueInvoices: limit clamped to MAX_OVERDUE_LIMIT (500)', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'X-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 1000,
        status: 'sent',
      });
      // limit 9999 should be clamped to 500 (no error, no truncation here
      // because we only have 1 row, but the clamp logic is exercised).
      const out = await listOverdueInvoices(localDb, '2026-06-20', 9999);
      assert.equal(out.length, 1);
    });

    test('27. getTopCustomers: limit clamped to MAX_TOP_CUSTOMERS_LIMIT (100)', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'X-1',
        issue_date: '2026-01-01',
        due_date: '2026-01-15',
        total_amd: 1000,
        status: 'paid',
      });
      const out = await getTopCustomers(localDb, { limit: 9999 });
      assert.equal(out.length, 1);
    });

    test('28. getVatSummary: until < since → ValueError', async () => {
      await assert.rejects(() => getVatSummary(db, '2026-12-31', '2026-01-01'), /until.*>=.*since/);
    });

    test('29. listOverdueInvoices: stable sort by id when days_overdue ties', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'X' });
      // Two invoices, both 30 days overdue (same due_date).
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'TIE-A',
        issue_date: '2026-05-01',
        due_date: '2026-05-21',
        total_amd: 10000,
        status: 'sent',
      });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'TIE-B',
        issue_date: '2026-05-02',
        due_date: '2026-05-21',
        total_amd: 20000,
        status: 'sent',
      });
      const out = await listOverdueInvoices(localDb, '2026-06-20');
      assert.equal(out.length, 2);
      // Both have 30 days_overdue; stable order by id ASC.
      assert.equal(out[0].invoice_number, 'TIE-A');
      assert.equal(out[1].invoice_number, 'TIE-B');
    });

    test('30. sqlite-style adapter: works through prepare()/.all()', async () => {
      // Clone the pg-style mock but strip the `query` method so the
      // adapter's `isPgStyle(db)` returns false and the sqlite branch
      // is exercised. (The mock's `prepare(sql).all()` forwards to the
      // same in-memory model, so the test data still applies.)
      const localDb = makeMockDb();
      // Seed through `localDb` (which has both query and prepare) so
      // the test data is in the shared in-memory maps, then hand the
      // sqlite-only surface to getArAging.
      const custId = await seedCustomer(localDb, { name: 'Acme', hvhh: '12345678' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'SQ-1',
        issue_date: '2026-05-01',
        due_date: '2026-06-10',
        total_amd: 100000,
        status: 'sent',
      });
      const sqliteDb = {
        kind: 'sqlite',
        customers: localDb.customers,
        invoices: localDb.invoices,
        payments: localDb.payments,
        prepare(sql) {
          return localDb.prepare(sql);
        },
        exec(sql) {
          return localDb.exec(sql);
        },
      };
      const out = await getArAging(sqliteDb, '2026-06-20');
      assert.equal(out.buckets['0_30'].invoice_count, 1);
      assert.equal(out.buckets['0_30'].amount_amd, 100000);
    });

    test('31. listOverdueInvoices: fully-paid overdue invoice is excluded (balance <= 0 path)', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'Paid' });
      // An invoice past due, but with a payment that covers the full
      // amount. balance_amd = 0, so the `if (balance <= 0) continue;`
      // branch is hit and the invoice is excluded from the overdue list.
      const inv = await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'PAID-1',
        issue_date: '2026-04-01',
        due_date: '2026-05-01',
        total_amd: 50000,
        status: 'sent',
      });
      console.log('[DBG] invoice id:', inv, 'payments:', [...localDb.payments.values()]);
      await seedPayment(localDb, { invoice_id: inv, amount_amd: 50000 });
      console.log('[DBG] after payment, payments:', [...localDb.payments.values()]);
      const out = await listOverdueInvoices(localDb, '2026-06-20');
      console.log('[DBG] out:', out);
      assert.equal(out.length, 0, 'fully-paid invoice must not appear in overdue list');
    });

    test('32. getMonthlyRevenue: month with no payments → collected_amd = 0', async () => {
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'NoPay' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'NOPAY-1',
        issue_date: '2026-06-05',
        due_date: '2026-07-05',
        total_amd: 75000,
        status: 'sent',
      });
      const out = await getMonthlyRevenue(localDb, '2026-06');
      assert.equal(out.invoiced_amd, 75000);
      assert.equal(out.collected_amd, 0, 'no payments → collected is zero');
      assert.equal(out.outstanding_amd, 75000);
      assert.equal(out.invoice_count, 1);
      assert.equal(out.paid_count, 0);
    });

    test('33. getArAging: invoice 1 day overdue (days=1) → 0_30 bucket boundary', async () => {
      // Boundary: an invoice whose due_date is 1 day before asOfDate is
      // 1 day past due, which lands in the 0_30 bucket. (due_date ==
      // asOfDate is "not yet overdue" — the query uses `due_date <`, so
      // it's excluded; we test the day-after-the-boundary case instead.)
      const localDb = makeMockDb();
      const custId = await seedCustomer(localDb, { name: 'OnDue' });
      await seedInvoice(localDb, {
        customer_id: custId,
        invoice_number: 'ONDUE-1',
        issue_date: '2026-05-01',
        due_date: '2026-06-19',
        total_amd: 40000,
        status: 'sent',
      });
      const out = await getArAging(localDb, '2026-06-20');
      assert.equal(out.buckets['0_30'].invoice_count, 1);
      assert.equal(out.buckets['0_30'].amount_amd, 40000);
      assert.equal(out.total_outstanding_amd, 40000);
    });
  });
});
