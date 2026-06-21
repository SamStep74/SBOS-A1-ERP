// Tests for server/finance/invoice.js — invoice CRUD + status lifecycle.
//
// The CRUD module is a thin layer over a duck-type DB (pg-style .query() or
// sqlite-style .prepare()/exec()). We exercise it with an in-memory mock DB
// that records every SQL statement, captures params, and simulates the two
// key constraints the real DB would enforce:
//   1. FK: customer_id must exist in finance.customers.
//   2. UNIQUE: invoice_number must be unique.
//
// All tests share a single mock DB so getInvoice / listInvoices can see
// what createInvoice wrote (the suite mirrors the wave-4 migrate.test.js
// pattern — but with a real in-memory table, not just statement capture).
//
// TDD: this file lands in commit A (RED). The invoice.js module is a stub
// that throws NotImplementedError on the RED branch. Tests are expected to
// fail until commit B introduces the real implementation.

import { describe, test, before } from 'node:test';
import assert from 'node:assert/strict';

// ────────────────────────────────────────────────────────────────────────────
// In-memory mock DB (shared across tests via describe-level setup).
// Implements both pg-style .query() and sqlite-style .prepare() so the same
// object exercises both adapter branches. Persists data across calls.
// ────────────────────────────────────────────────────────────────────────────

function makeMockDb() {
  // Tables we model. Schema mirrors 0001_init.sql + 0002_invoice_status_tracking.sql.
  const customers = new Map(); // id → row
  const invoices = new Map(); // id → row
  const lines = new Map(); // id → row
  let nextCustomerId = 1;
  let nextInvoiceId = 1;
  let nextLineId = 1;
  // Tracks every SQL call for assertions / debugging.
  const statements = [];

  // Serialise into a pseudo-bigint-ish id for ordering; mocked DB does not
  // need 64-bit fidelity, JS numbers are fine.

  function nextIdFor(map) {
    if (map === customers) return nextCustomerId++;
    if (map === invoices) return nextInvoiceId++;
    if (map === lines) return nextLineId++;
    throw new Error('mock: unknown map');
  }

  // Helper: detect a SQL kind by regex.
  // Wave-13 added `tenant_id = $N AND` to every WHERE clause, so the
  // single-column regexes below now match `WHERE TENANT_ID = $N AND
  // <col> = $M` as well as the pre-wave-13 `WHERE <col> = $M`. The
  // dispatchers (invoice-by-id, lines-by-invoice, invoice-by-number)
  // handle both shapes and default tenant_id to 0 when the row has no
  // tenant_id field.
  function classify(sql) {
    const s = sql.trim().toUpperCase();
    if (/SELECT\s+(1|ID|.*?HVHH.*?)\s+FROM\s+FINANCE\.CUSTOMERS/.test(s)) return 'customer-exists';
    if (/INSERT\s+INTO\s+FINANCE\.CUSTOMERS/.test(s)) return 'customer-insert';
    if (/INSERT\s+INTO\s+FINANCE\.INVOICES/.test(s)) return 'invoice-insert';
    if (/INSERT\s+INTO\s+FINANCE\.INVOICE_LINES/.test(s)) return 'invoice-line-insert';
    if (/DELETE\s+FROM\s+FINANCE\.INVOICE_LINES/.test(s)) return 'lines-delete';
    if (/UPDATE\s+FINANCE\.INVOICES\s+SET/.test(s)) return 'invoice-update';
    if (/SELECT\s+LAST_INSERT_ROWID\(\)/.test(s)) return 'last-insert-rowid';
    if (/SELECT\s+\*\s+FROM\s+FINANCE\.INVOICES\s+WHERE/.test(s) && /\bID\s*=/.test(s))
      return 'invoice-by-id';
    if (/SELECT\s+ID\s+FROM\s+FINANCE\.INVOICES\s+WHERE/.test(s) && /\bINVOICE_NUMBER\s*=/.test(s))
      return 'invoice-by-number';
    if (/SELECT\s+\*\s+FROM\s+FINANCE\.INVOICE_LINES\s+WHERE/.test(s) && /\bINVOICE_ID\s*=/.test(s))
      return 'lines-by-invoice';
    if (/SELECT\s+.*\s+FROM\s+FINANCE\.INVOICES(\s|$)/.test(s)) return 'invoice-list';
    return 'other';
  }

  // pg-style .query(sql, params)
  async function query(sql, params) {
    statements.push({ kind: classify(sql), sql, params: params ?? [] });
    const kind = classify(sql);
    const ps = params ?? [];

    if (kind === 'last-insert-rowid') {
      let maxId = 0;
      for (const id of invoices.keys()) if (id > maxId) maxId = id;
      return { rows: [{ id: maxId }] };
    }
    if (kind === 'customer-exists') {
      // After wave-13 the FK check is tenant-scoped: `WHERE tenant_id = $1
      // AND id = $2`. Pre-wave-13 mocks may still match the un-scoped form
      // `WHERE id = $1`. We accept both — tenant id 0 is the bootstrap
      // (default) so a row seeded without tenant_id matches the new
      // WHERE clause transparently.
      //
      // Wave-34: production now also fetches `hvhh` so the A1-Validator
      // pass can re-validate it at invoice-create time. The mock returns
      // the customer's hvhh alongside the existence marker.
      const tenantId = ps[0] != null && ps.length > 1 ? Number(ps[0]) : 0;
      const id = ps.length > 1 ? Number(ps[1]) : Number(ps[0]);
      for (const c of customers.values()) {
        const cTenant = c.tenant_id ?? 0;
        if (c.id === id && cTenant === tenantId) return { rows: [{ ok: 1, id: c.id, hvhh: c.hvhh ?? null }] };
      }
      return { rows: [] };
    }
    if (kind === 'customer-insert') {
      const id = nextIdFor(customers);
      customers.set(id, { id, name: ps[0], hvhh: ps[1] });
      return { rows: [] };
    }
    if (kind === 'invoice-by-number') {
      // Wave-13: scoped to tenant. pre-wave-13 mock seeds pass tenant=0
      // implicitly, so we default `row.tenant_id ?? 0` to match.
      const tenantId = ps[0] != null && ps.length > 1 ? Number(ps[0]) : 0;
      const number = ps.length > 1 ? ps[1] : ps[0];
      for (const inv of invoices.values()) {
        if (inv.invoice_number === number && (inv.tenant_id ?? 0) === tenantId) {
          return { rows: [{ id: inv.id }] };
        }
      }
      return { rows: [] };
    }
    if (kind === 'invoice-insert') {
      const id = nextIdFor(invoices);
      // Schema columns in INSERT VALUES order:
      //   customer_id, invoice_number, issue_date, due_date,
      //   subtotal_amd, vat_amd, total_amd, status, notes,
      //   tenant_id, created_at, updated_at
      // (Wave-13 added tenant_id between notes and created_at.) The mock
      // accepts both forms: if a test inserts without tenant_id, it is
      // recorded as 0 so the always-on `WHERE tenant_id = $N` reads match.
      const inv = {
        id,
        customer_id: Number(ps[0]),
        invoice_number: ps[1],
        issue_date: ps[2],
        due_date: ps[3],
        subtotal_amd: Number(ps[4]),
        vat_amd: Number(ps[5]),
        total_amd: Number(ps[6]),
        status: ps[7] ?? 'draft',
        notes: ps[8] ?? null,
        // Wave-13: tenant_id lives at ps[9]. Pre-wave-13 seeds used
        // ps[9]=created_at; if the value at that position parses as a
        // timestamp, assume the old shape and treat tenant_id=0.
        tenant_id: ps.length >= 12 ? Number(ps[9] ?? 0) : 0,
        created_at: ps.length >= 12 ? (ps[10] ?? null) : (ps[9] ?? null),
        updated_at: ps.length >= 12 ? (ps[11] ?? null) : (ps[10] ?? null),
        sent_at: null,
        voided_at: null,
        void_reason: null,
      };
      invoices.set(id, inv);
      // pg-style `INSERT ... RETURNING id` returns the new row's id.
      if (/RETURNING\s+id/i.test(sql)) {
        return { rows: [{ id }] };
      }
      return { rows: [] };
    }
    if (kind === 'invoice-line-insert') {
      const id = nextIdFor(lines);
      // Wave-13: tenant_id is the LAST param on invoice_lines. Pre-wave-13
      // inserts had 5 params; wave-13 inserts have 6. Default to 0 when
      // missing.
      lines.set(id, {
        id,
        invoice_id: Number(ps[0]),
        description: ps[1],
        quantity: String(ps[2]),
        unit_price_amd: Number(ps[3]),
        line_total_amd: Number(ps[4]),
        tenant_id: ps.length >= 6 ? Number(ps[5] ?? 0) : 0,
      });
      return { rows: [] };
    }
    if (kind === 'lines-delete') {
      // Wave-13: scoped. `WHERE tenant_id = $1 AND invoice_id = $2`. The
      // pre-wave-13 form was `WHERE invoice_id = $1`. Accept both.
      const tenantId = ps[0] != null && ps.length > 1 ? Number(ps[0]) : 0;
      const id = ps.length > 1 ? Number(ps[1]) : Number(ps[0]);
      for (const [lid, l] of lines) {
        if (l.invoice_id === id && (l.tenant_id ?? 0) === tenantId) lines.delete(lid);
      }
      return { rows: [] };
    }
    if (kind === 'invoice-update') {
      // Wave-13: the WHERE clause ends with `tenant_id = $N AND id = $M`.
      // We pull the id and tenant out of the WHERE clause; the SET clause
      // still uses 0-indexed params (which is what the production
      // code emits).
      const whereMatch = sql.match(/WHERE\s+([\s\S]+)$/i);
      let tenantId = 0;
      let id = null;
      if (whereMatch) {
        const t = whereMatch[1].match(/tenant_id\s*=\s*\$(\d+)/i);
        const i = whereMatch[1].match(/\bid\s*=\s*\$(\d+)/i);
        if (t) tenantId = Number(ps[Number(t[1]) - 1] ?? 0);
        if (i) id = Number(ps[Number(i[1]) - 1]);
      }
      // Pre-wave-13 fallback: id is the last param, no tenant predicate.
      if (id === null) {
        id = Number(ps[ps.length - 1]);
      }
      const inv = invoices.get(id);
      if (!inv) return { rows: [] };
      // Tenant guard: if the row's tenant_id doesn't match the predicate,
      // treat it as a no-op (the real DB would silently UPDATE 0 rows).
      if ((inv.tenant_id ?? 0) !== tenantId) return { rows: [] };
      // Parse the SET clause to figure out which columns changed.
      const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
      if (!setMatch) return { rows: [] };
      const cols = setMatch[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      let paramIdx = 0;
      for (const col of cols) {
        const eq = col.split('=');
        const colName = eq[0].trim();
        const val = ps[paramIdx];
        paramIdx++;
        if (colName === 'updated_at') {
          inv.updated_at = val;
        } else if (colName === 'sent_at') {
          inv.sent_at = val;
        } else if (colName === 'voided_at') {
          inv.voided_at = val;
        } else if (colName === 'void_reason') {
          inv.void_reason = val;
        } else {
          inv[colName] = colName === 'status' ? String(val) : val;
        }
      }
      return { rows: [] };
    }
    if (kind === 'invoice-by-id') {
      // Wave-13: scoped. `WHERE tenant_id = $1 AND id = $2`.
      const tenantId = ps[0] != null && ps.length > 1 ? Number(ps[0]) : 0;
      const id = ps.length > 1 ? Number(ps[1]) : Number(ps[0]);
      for (const inv of invoices.values()) {
        if (inv.id === id && (inv.tenant_id ?? 0) === tenantId) {
          return { rows: [inv] };
        }
      }
      return { rows: [] };
    }
    if (kind === 'lines-by-invoice') {
      // Wave-13: scoped. `WHERE tenant_id = $1 AND invoice_id = $2`. The
      // pre-wave-13 form was `WHERE invoice_id = $1`. Accept both.
      const tenantId = ps[0] != null && ps.length > 1 ? Number(ps[0]) : 0;
      const id = ps.length > 1 ? Number(ps[1]) : Number(ps[0]);
      const out = [];
      for (const l of lines.values()) {
        if (l.invoice_id === id && (l.tenant_id ?? 0) === tenantId) out.push(l);
      }
      return { rows: out };
    }
    if (kind === 'invoice-list') {
      // Wave-13: tenant_id is the FIRST WHERE condition. We accept either
      // form (with or without the leading tenant_id) and default missing
      // tenant_id to 0 on every row, so pre-wave-13 fixtures still work.
      let out = [...invoices.values()];
      const whereMatch = sql.match(/WHERE\s+([\s\S]+?)(?:\s+ORDER|\s+LIMIT|$)/i);
      const orderDesc = /ORDER\s+BY\s+ID\s+DESC/i.test(sql);
      const limitMatch = sql.match(/LIMIT\s+\$(\d+)/i);
      if (whereMatch) {
        const where = whereMatch[1];
        const conds = where.split(/\s+AND\s+/i);
        for (const c of conds) {
          const m = c.match(/(\w+)\s*(=|>=|<=)\s*\$(\d+)/);
          if (!m) continue;
          const col = m[1];
          const op = m[2];
          const idx = Number(m[3]) - 1;
          const val = ps[idx];
          out = out.filter((inv) => {
            const v = col === 'tenant_id' ? (inv[col] ?? 0) : inv[col];
            if (op === '=') return v === val;
            if (op === '>=') return v >= val;
            if (op === '<=') return v <= val;
            return true;
          });
        }
      }
      if (orderDesc) out.sort((a, b) => b.id - a.id);
      if (limitMatch) {
        const idx = Number(limitMatch[1]) - 1;
        const lim = Number(ps[idx]);
        out = out.slice(0, lim);
      }
      return { rows: out };
    }
    // Default: accept silently.
    return { rows: [] };
  }

  // sqlite-style surface — used to exercise the adapter duck-type branch in
  // the GREEN implementation. prepare() returns an object whose .run() mimics
  // better-sqlite3: returns {lastInsertRowid, changes} for INSERTs.
  let lastInsertRowid = 0;
  function prepare(sql) {
    statements.push({ kind: classify(sql), sql, params: null });
    return {
      run(...params) {
        void query(sql, params);
        // For INSERTs, simulate better-sqlite3's lastInsertRowid behavior by
        // remembering the largest invoice id we've assigned. (Sqlite's actual
        // last_insert_rowid() is per-connection; this approximation is enough
        // for our mock to drive the adapter's id-resolution branch.)
        const insertMatch = /INSERT\s+INTO\s+finance\.invoices/i.test(sql);
        if (insertMatch) {
          // Find the assigned id from the most recent invoice-insert statement.
          let maxId = 0;
          for (const id of invoices.keys()) if (id > maxId) maxId = id;
          lastInsertRowid = maxId;
        }
        return { lastInsertRowid, changes: 1 };
      },
      all(...params) {
        return query(sql, params).then((r) => r.rows);
      },
      get(...params) {
        return query(sql, params).then((r) => r.rows[0] ?? null);
      },
    };
  }
  function exec(sql) {
    statements.push({ kind: classify(sql), sql, params: null });
    return query(sql, []);
  }

  return {
    kind: 'mock',
    customers,
    invoices,
    lines,
    statements,
    query,
    prepare,
    exec,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

describe('invoice CRUD', () => {
  let db;
  let invoice;
  let createInvoice;
  let getInvoice;
  let listInvoices;
  let updateInvoice;
  let voidInvoice;

  before(async () => {
    db = makeMockDb();
    // Seed a customer so FK checks pass.
    await db.query('INSERT INTO finance.customers (name, hvhh) VALUES ($1, $2)', [
      'Acme LLC',
      '12345678',
    ]);
    const mod = await import('./invoice.js');
    createInvoice = mod.createInvoice;
    getInvoice = mod.getInvoice;
    listInvoices = mod.listInvoices;
    updateInvoice = mod.updateInvoice;
    voidInvoice = mod.voidInvoice;
  });

  // 1. Create minimal valid invoice
  test('1. createInvoice: minimal valid invoice (1 line) → status=draft, correct subtotal/total', async () => {
    const out = await createInvoice(db, {
      customer_id: 1,
      invoice_number: 'INV-2026-0001',
      issue_date: '2026-06-01',
      due_date: '2026-06-30',
      lines: [{ description: 'Consulting', quantity: 1, unit_price_amd: 100000 }],
    });
    assert.equal(out.status, 'draft');
    assert.equal(out.subtotal_amd, 100000);
    assert.equal(out.total_amd, 100000);
    assert.equal(out.customer_id, 1);
    assert.equal(out.invoice_number, 'INV-2026-0001');
    assert.equal(typeof out.id, 'number');
    assert.ok(Array.isArray(out.lines) && out.lines.length === 1);
    assert.equal(out.lines[0].description, 'Consulting');
    assert.equal(out.lines[0].line_total_amd, 100000);
    invoice = out; // hold for later tests
  });

  // 2. Multiple lines
  test('2. createInvoice: multiple lines → subtotal = sum of line totals', async () => {
    const out = await createInvoice(db, {
      customer_id: 1,
      invoice_number: 'INV-2026-0002',
      issue_date: '2026-06-01',
      due_date: '2026-06-30',
      lines: [
        { description: 'Item A', quantity: 2, unit_price_amd: 50000 },
        { description: 'Item B', quantity: 3, unit_price_amd: 25000 },
        { description: 'Item C', quantity: 1, unit_price_amd: 100000 },
      ],
    });
    assert.equal(out.subtotal_amd, 2 * 50000 + 3 * 25000 + 1 * 100000); // 275000
    assert.equal(out.total_amd, 275000);
    assert.equal(out.lines.length, 3);
  });

  // 3. quantity=0 → ValueError
  test('3. createInvoice: quantity=0 → ValueError', async () => {
    await assert.rejects(
      () =>
        createInvoice(db, {
          customer_id: 1,
          invoice_number: 'INV-2026-0003',
          issue_date: '2026-06-01',
          due_date: '2026-06-30',
          lines: [{ description: 'Bad', quantity: 0, unit_price_amd: 1000 }],
        }),
      /quantity|positive|greater/i,
    );
  });

  // 4. due_date < issue_date → ValueError
  test('4. createInvoice: due_date < issue_date → ValueError', async () => {
    await assert.rejects(
      () =>
        createInvoice(db, {
          customer_id: 1,
          invoice_number: 'INV-2026-0004',
          issue_date: '2026-06-30',
          due_date: '2026-06-01',
          lines: [{ description: 'X', quantity: 1, unit_price_amd: 1000 }],
        }),
      /due_date|after|>=|greater/i,
    );
  });

  // 5. Empty lines → ValueError
  test('5. createInvoice: empty lines → ValueError', async () => {
    await assert.rejects(
      () =>
        createInvoice(db, {
          customer_id: 1,
          invoice_number: 'INV-2026-0005',
          issue_date: '2026-06-01',
          due_date: '2026-06-30',
          lines: [],
        }),
      /line|at least|empty/i,
    );
  });

  // 6. Non-existent customer_id → ValueError
  test('6. createInvoice: non-existent customer_id → ValueError', async () => {
    await assert.rejects(
      () =>
        createInvoice(db, {
          customer_id: 9999,
          invoice_number: 'INV-2026-0006',
          issue_date: '2026-06-01',
          due_date: '2026-06-30',
          lines: [{ description: 'X', quantity: 1, unit_price_amd: 1000 }],
        }),
      /customer|foreign|exists/i,
    );
  });

  // 7. getInvoice: existing
  test('7. getInvoice: existing invoice → full invoice with lines', async () => {
    const got = await getInvoice(db, invoice.id);
    assert.equal(got.id, invoice.id);
    assert.equal(got.invoice_number, 'INV-2026-0001');
    assert.ok(Array.isArray(got.lines) && got.lines.length === 1);
    assert.equal(got.lines[0].description, 'Consulting');
  });

  // 8. getInvoice: missing → null
  test('8. getInvoice: non-existent id → null', async () => {
    const got = await getInvoice(db, 99999);
    assert.equal(got, null);
  });

  // 9. updateInvoice: recompute on lines change
  test('9. updateInvoice: draft invoice lines → subtotal recomputed', async () => {
    const updated = await updateInvoice(db, invoice.id, {
      lines: [
        { description: 'A', quantity: 4, unit_price_amd: 75000 },
        { description: 'B', quantity: 2, unit_price_amd: 50000 },
      ],
    });
    assert.equal(updated.subtotal_amd, 4 * 75000 + 2 * 50000); // 400000
    assert.equal(updated.total_amd, 400000);
    assert.equal(updated.lines.length, 2);
    assert.equal(updated.status, 'draft');
  });

  // 10. updateInvoice: non-draft → ValueError
  test('10. updateInvoice: lines on non-draft invoice → ValueError', async () => {
    // Mark the invoice as sent first.
    await updateInvoice(db, invoice.id, { status: 'sent' });
    await assert.rejects(
      () =>
        updateInvoice(db, invoice.id, {
          lines: [{ description: 'X', quantity: 1, unit_price_amd: 100 }],
        }),
      /draft|immutable|status/i,
    );
  });

  // 11. listInvoices: status filter
  test('11. listInvoices: status filter → only matching status returned', async () => {
    const drafts = await listInvoices(db, { status: 'draft' });
    assert.ok(Array.isArray(drafts));
    assert.ok(drafts.every((i) => i.status === 'draft'));
    const sents = await listInvoices(db, { status: 'sent' });
    assert.ok(Array.isArray(sents));
    assert.ok(sents.every((i) => i.status === 'sent'));
    assert.ok(sents.length >= 1);
  });

  // 12. voidInvoice: draft → void
  test('12. voidInvoice: draft invoice → status=void, void_reason set', async () => {
    // Use INV-2026-0002 (still draft) for the void test.
    const target = await getInvoice(db, 2);
    const out = await voidInvoice(db, target.id, 'duplicate of INV-2026-0001');
    assert.equal(out.status, 'void');
    assert.equal(out.void_reason, 'duplicate of INV-2026-0001');
    assert.ok(out.voided_at);
  });

  // 13. Mark draft as sent → status='sent', sent_at set
  test('13. updateInvoice: draft → sent → status=sent, sent_at set', async () => {
    // INV-2026-0002 was just voided; use INV-2026-0003 (we only got partway
    // before the quantity=0 test failed, so let me re-look — actually that
    // test failed BEFORE insert. Make a fresh invoice here.
    const fresh = await createInvoice(db, {
      customer_id: 1,
      invoice_number: 'INV-2026-0007',
      issue_date: '2026-06-01',
      due_date: '2026-06-30',
      lines: [{ description: 'Service', quantity: 1, unit_price_amd: 50000 }],
    });
    const sent = await updateInvoice(db, fresh.id, { status: 'sent' });
    assert.equal(sent.status, 'sent');
    assert.ok(sent.sent_at, 'sent_at must be set after transition');
  });

  // ────────────────────────────────────────────────────────────────────────
  // Branch-coverage tests (added to push coverage above the 80% floor).
  // These exercise the validation-error paths and the additional filter
  // combinations on listInvoices that the original 13 tests didn't cover.
  // ────────────────────────────────────────────────────────────────────────

  test('14. listInvoices: no filters → all invoices returned', async () => {
    const all = await listInvoices(db);
    assert.ok(Array.isArray(all));
    assert.ok(all.length >= 1);
  });

  test('15. listInvoices: customer_id filter → only that customer', async () => {
    const only = await listInvoices(db, { customer_id: 1 });
    assert.ok(only.every((i) => i.customer_id === 1));
  });

  test('16. listInvoices: since/until date range filter', async () => {
    const ranged = await listInvoices(db, {
      since: '2026-06-01',
      until: '2026-06-30',
    });
    assert.ok(ranged.every((i) => i.issue_date >= '2026-06-01' && i.issue_date <= '2026-06-30'));
  });

  test('17. listInvoices: limit filter → at most N rows', async () => {
    const limited = await listInvoices(db, { limit: 2 });
    assert.ok(limited.length <= 2);
  });

  test('18. listInvoices: non-string status filter → ValueError', async () => {
    await assert.rejects(() => listInvoices(db, { status: 123 }), /status/);
  });

  test('19. listInvoices: non-positive customer_id filter → ValueError', async () => {
    await assert.rejects(() => listInvoices(db, { customer_id: 0 }), /customer_id/);
  });

  test('20. listInvoices: invalid since date format → ValueError', async () => {
    await assert.rejects(() => listInvoices(db, { since: 'not-a-date' }), /since/);
  });

  test('21. listInvoices: invalid until date format → ValueError', async () => {
    await assert.rejects(() => listInvoices(db, { until: 'xx' }), /until/);
  });

  test('22. listInvoices: non-positive limit → ValueError', async () => {
    await assert.rejects(() => listInvoices(db, { limit: 0 }), /limit/);
  });

  test('23. listInvoices: non-integer limit → ValueError', async () => {
    await assert.rejects(() => listInvoices(db, { limit: 'abc' }), /limit/);
  });

  test('24. updateInvoice: non-existent id → ValueError', async () => {
    await assert.rejects(() => updateInvoice(db, 9999, { status: 'sent' }), /not found/);
  });

  test('25. updateInvoice: invalid status transition (sent → paid) → ValueError', async () => {
    // invoice 1 was set to 'sent' in test 10; try to move it to 'paid'.
    await assert.rejects(
      () => updateInvoice(db, invoice.id, { status: 'paid' }),
      /invalid status transition/,
    );
  });

  test('26. voidInvoice: empty reason → ValueError', async () => {
    await assert.rejects(() => voidInvoice(db, 1, ''), /non-empty reason/);
  });

  test('27. voidInvoice: non-string reason → ValueError', async () => {
    await assert.rejects(() => voidInvoice(db, 1, 42), /non-empty reason/);
  });

  test('28. voidInvoice: reason > 500 chars → ValueError', async () => {
    const long = 'x'.repeat(501);
    await assert.rejects(() => voidInvoice(db, 1, long), /500 characters/);
  });

  test('29. voidInvoice: non-existent id → ValueError', async () => {
    await assert.rejects(() => voidInvoice(db, 9999, 'some reason'), /not found/);
  });

  test('30. updateInvoice: status = current.status → no-op (no error)', async () => {
    // invoice 1 is 'sent'; setting status='sent' again should be a no-op.
    const noop = await updateInvoice(db, invoice.id, { status: 'sent' });
    assert.equal(noop.status, 'sent');
  });
});

// ────────────────────────────────────────────────────────────────────────
// A1-Validator wiring — invoice re-validates the customer's HVVH at
// create-invoice time. With A1_VALIDATOR_URL unset, the client is
// disabled and the local regex enforces 8 digits (the regex in
// hvhh-validator.js — same as customer/vendor).
// ────────────────────────────────────────────────────────────────────────

describe('createInvoice: customer HVVH re-validation (A1-Validator wiring)', () => {
  let db;
  let createInvoice;

  async function seedCustomer(name, hvhh, tenantId = 0) {
    // Use direct INSERT so the mock's customer-insert handler stores hvhh.
    await db.query(
      'INSERT INTO finance.customers (name, hvhh, tenant_id) VALUES ($1, $2, $3)',
      [name, hvhh, tenantId],
    );
  }

  before(async () => {
    db = makeMockDb();
    const mod = await import('./invoice.js');
    createInvoice = mod.createInvoice;
  });

  test('happy path: customer has valid 8-digit HVVH → invoice created', async () => {
    await seedCustomer('GoodCo', '00123456');
    const out = await createInvoice(
      db,
      {
        customer_id: 1,
        invoice_number: 'INV-A1-001',
        issue_date: '2026-06-21',
        due_date: '2026-07-21',
        lines: [
          { description: 'Consulting', quantity: 1, unit_price_amd: 100000 },
        ],
      },
      0,
    );
    assert.ok(Number.isInteger(out.id) && out.id > 0);
    assert.equal(out.customer_id, 1);
  });

  test('customer with malformed 9-digit HVVH → ValueError (A1-Validator wrapper)', async () => {
    await seedCustomer('BadCo', '123456789');
    await assert.rejects(
      createInvoice(
        db,
        {
          customer_id: 2,
          invoice_number: 'INV-A1-002',
          issue_date: '2026-06-21',
          due_date: '2026-07-21',
          lines: [
            { description: 'x', quantity: 1, unit_price_amd: 1000 },
          ],
        },
        0,
      ),
      /hvhh must be exactly 8 digits/,
    );
  });

  test('customer with no HVVH (null) → invoice created (optional field)', async () => {
    await seedCustomer('NoHvhh', null);
    const out = await createInvoice(
      db,
      {
        customer_id: 3,
        invoice_number: 'INV-A1-003',
        issue_date: '2026-06-21',
        due_date: '2026-07-21',
        lines: [
          { description: 'x', quantity: 1, unit_price_amd: 1000 },
        ],
      },
      0,
    );
    assert.ok(Number.isInteger(out.id) && out.id > 0);
  });

  test('customer with non-digit HVVH → ValueError', async () => {
    await seedCustomer('ChrCo', '1234567A');
    await assert.rejects(
      createInvoice(
        db,
        {
          customer_id: 4,
          invoice_number: 'INV-A1-004',
          issue_date: '2026-06-21',
          due_date: '2026-07-21',
          lines: [
            { description: 'x', quantity: 1, unit_price_amd: 1000 },
          ],
        },
        0,
      ),
      /hvhh must be exactly 8 digits/,
    );
  });
});
