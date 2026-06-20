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
  function classify(sql) {
    const s = sql.trim().toUpperCase();
    if (/SELECT\s+1\s+FROM\s+FINANCE\.CUSTOMERS/.test(s)) return 'customer-exists';
    if (/INSERT\s+INTO\s+FINANCE\.CUSTOMERS/.test(s)) return 'customer-insert';
    if (/INSERT\s+INTO\s+FINANCE\.INVOICES/.test(s)) return 'invoice-insert';
    if (/INSERT\s+INTO\s+FINANCE\.INVOICE_LINES/.test(s)) return 'invoice-line-insert';
    if (/UPDATE\s+FINANCE\.INVOICES\s+SET/.test(s)) return 'invoice-update';
    if (/SELECT\s+\*\s+FROM\s+FINANCE\.INVOICES\s+WHERE\s+ID\s*=/.test(s)) return 'invoice-by-id';
    if (
      /SELECT\s+ID\s+FROM\s+FINANCE\.INVOICES\s+WHERE\s+INVOICE_NUMBER\s*=/.test(s)
    )
      return 'invoice-by-number';
    if (/SELECT\s+\*\s+FROM\s+FINANCE\.INVOICE_LINES\s+WHERE\s+INVOICE_ID\s*=/.test(s))
      return 'lines-by-invoice';
    if (/SELECT\s+.*\s+FROM\s+FINANCE\.INVOICES(\s|$)/.test(s)) return 'invoice-list';
    return 'other';
  }

  // pg-style .query(sql, params)
  async function query(sql, params) {
    statements.push({ kind: classify(sql), sql, params: params ?? [] });
    const kind = classify(sql);
    const ps = params ?? [];

    if (kind === 'customer-exists') {
      const id = Number(ps[0]);
      return { rows: customers.has(id) ? [{ ok: 1 }] : [] };
    }
    if (kind === 'customer-insert') {
      const id = nextIdFor(customers);
      customers.set(id, { id, name: ps[0], hvhh: ps[1] });
      return { rows: [] };
    }
    if (kind === 'invoice-by-number') {
      for (const inv of invoices.values()) {
        if (inv.invoice_number === ps[0]) return { rows: [{ id: inv.id }] };
      }
      return { rows: [] };
    }
    if (kind === 'invoice-insert') {
      const id = nextIdFor(invoices);
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
        sent_at: ps[9] ?? null,
        voided_at: ps[10] ?? null,
        void_reason: ps[11] ?? null,
        created_at: ps[12] ?? null,
        updated_at: ps[13] ?? null,
      };
      invoices.set(id, inv);
      return { rows: [] };
    }
    if (kind === 'invoice-line-insert') {
      const id = nextIdFor(lines);
      lines.set(id, {
        id,
        invoice_id: Number(ps[0]),
        description: ps[1],
        quantity: String(ps[2]),
        unit_price_amd: Number(ps[3]),
        line_total_amd: Number(ps[4]),
      });
      return { rows: [] };
    }
    if (kind === 'invoice-update') {
      // Look up the target invoice by $1 (id).
      const id = Number(ps[ps.length - 1]);
      const inv = invoices.get(id);
      if (!inv) return { rows: [] };
      // Parse the SET clause to figure out which columns changed.
      const setMatch = sql.match(/SET\s+([\s\S]+?)\s+WHERE/i);
      if (!setMatch) return { rows: [] };
      const cols = setMatch[1]
        .split(',')
        .map((c) => c.trim())
        .filter(Boolean);
      // cols[i] is something like "customer_id = $2"; map param index sequentially.
      let paramIdx = 1;
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
      const id = Number(ps[0]);
      const inv = invoices.get(id);
      if (!inv) return { rows: [] };
      return { rows: [inv] };
    }
    if (kind === 'lines-by-invoice') {
      const id = Number(ps[0]);
      const out = [];
      for (const l of lines.values()) {
        if (l.invoice_id === id) out.push(l);
      }
      return { rows: out };
    }
    if (kind === 'invoice-list') {
      // Very small WHERE-clause parser: only the filters we actually use.
      // Filters (any order): status = $N, customer_id = $N, issue_date >= $N,
      // issue_date <= $N, id DESC LIMIT $N.
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
            const v = inv[col];
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
  // the GREEN implementation (a separate test does it).
  function prepare(sql) {
    statements.push({ kind: classify(sql), sql, params: null });
    return {
      run(...params) {
        return query(sql, params);
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
    await db.query(
      'INSERT INTO finance.customers (name, hvhh) VALUES ($1, $2)',
      ['Acme LLC', '12345678'],
    );
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
});