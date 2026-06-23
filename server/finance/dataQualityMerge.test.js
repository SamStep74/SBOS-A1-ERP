// Phase 3 AI agents wave 3 (W99-1) — apply merge + audit log tests.
// Phase 3 AI agents wave 4 (W102-1) — undo merge tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyCustomerMerge,
  listCustomerMergeLog,
  undoCustomerMerge,
  ValueError,
} from './dataQuality.js';

// ────────────────────────────────────────────────────────────────────────
// Mock helpers — a small, focused mockDb that handles the
// 6 SQL shapes that applyCustomerMerge + listCustomerMergeLog
// issue. The other 5 dataQuality functions have their own
// tests in dataQuality.test.js; we don't need their mocks here.
// ────────────────────────────────────────────────────────────────────────

function makeMergeMockDb() {
  const customers = new Map();
  const invoices = new Map();
  const payments = new Map();
  const mergeLog = new Map();
  let nextCustId = 1;
  let nextInvId = 1;
  let nextPayId = 1;
  let nextLogId = 1;

  function classify(sql) {
    const s = sql.trim().toUpperCase();
    // INSERT INTO finance.customer_merge_log (audit)
    if (/INTO\s+FINANCE\.CUSTOMER_MERGE_LOG/i.test(s) && /RETURNING/i.test(s)) return 'merge-log-insert';
    // UPDATE finance.customer_merge_log SET undone_at = ... (the undo stamp)
    if (/UPDATE\s+FINANCE\.CUSTOMER_MERGE_LOG/i.test(s) && /UNDONE_AT/i.test(s)) return 'merge-log-undo-stamp';
    // SELECT ... FROM finance.customer_merge_log WHERE id = $1 AND tenant_id = $2 (the undo lookup)
    if (/FROM\s+FINANCE\.CUSTOMER_MERGE_LOG/i.test(s) && /\bID\s*=\s*\$\d/i.test(s)) return 'merge-log-get';
    // UPDATE finance.customers SET archived = 0
    if (/UPDATE\s+FINANCE\.CUSTOMERS/i.test(s) && /ARCHIVED\s*=\s*0/i.test(s)) return 'cust-unarchive';
    // UPDATE finance.customers SET archived = 1
    if (/UPDATE\s+FINANCE\.CUSTOMERS/i.test(s) && /ARCHIVED\s*=\s*1/i.test(s)) return 'cust-archive';
    // SELECT id FROM finance.invoices WHERE customer_id = $ (the list-collection for apply)
    if (/SELECT\s+ID\s+FROM\s+FINANCE\.INVOICES/i.test(s)) return 'inv-id-list';
    // SELECT p.id FROM finance.payments (the list-collection for apply)
    if (/SELECT\s+P\.ID\s+FROM\s+FINANCE\.PAYMENTS\s+P/i.test(s) && /JOIN\s+FINANCE\.INVOICES/i.test(s)) return 'pay-id-list';
    // UPDATE finance.invoices SET customer_id = ... (re-assign, with optional WHERE id IN (...))
    if (/UPDATE\s+FINANCE\.INVOICES/i.test(s) && /SET\s+CUSTOMER_ID/i.test(s)) return 'inv-reassign';
    // customer lookup by single id: SELECT id, archived WHERE id = $ AND tenant_id = $ (undo's secondary check)
    if (/FROM\s+FINANCE\.CUSTOMERS/i.test(s) && /\bARCHIVED\b/i.test(s) && /\bID\s*=\s*\$\d/i.test(s)) return 'cust-get';
    // customer lookup: SELECT id, name, archived WHERE id IN
    if (/FROM\s+FINANCE\.CUSTOMERS/i.test(s) && /\bID\s+IN\s*\(/i.test(s)) return 'cust-lookup';
    // COUNT(*) AS n FROM finance.invoices — for the before/after count
    if (/COUNT\(\*\)\s+AS\s+N\s+FROM\s+FINANCE\.INVOICES/i.test(s)) return 'inv-count';
    // payment count: JOIN payments to invoices
    if (/FROM\s+FINANCE\.PAYMENTS\s+P/i.test(s) && /JOIN\s+FINANCE\.INVOICES/i.test(s)) return 'pay-join';
    // listCustomerMergeLog SELECT (without GROUP BY)
    if (/FROM\s+FINANCE\.CUSTOMER_MERGE_LOG/i.test(s) && /ORDER\s+BY/i.test(s)) return 'merge-log-list';
    return 'passthrough';
  }

  async function query(sql, params = []) {
    const ps = params ?? [];
    const kind = classify(sql);

    if (kind === 'merge-log-insert') {
      const id = nextLogId++;
      const row = {
        id,
        tenant_id: Number(ps[0]),
        primary_customer_id: Number(ps[1]),
        secondary_customer_id: Number(ps[2]),
        invoices_reassigned_count: Number(ps[3]),
        payments_reassigned_count: Number(ps[4]),
        applied_by_user_id: ps[5] != null ? Number(ps[5]) : null,
        reason: ps[6] ?? null,
        reassigned_invoice_ids: ps[7] ?? null,
        reassigned_payment_ids: ps[8] ?? null,
        undone_at: null,
        undone_by_user_id: null,
        undone_reason: null,
        created_at: '2026-06-22',
      };
      mergeLog.set(id, row);
      return { rows: [{ id }] };
    }
    if (kind === 'merge-log-undo-stamp') {
      // params: [undone_at, undone_by_user_id, undone_reason, id, tenant_id]
      const id = Number(ps[3]);
      const tenantId = Number(ps[4]);
      const row = mergeLog.get(id);
      if (row && row.tenant_id === tenantId) {
        row.undone_at = ps[0];
        row.undone_by_user_id = ps[1] != null ? Number(ps[1]) : null;
        row.undone_reason = ps[2] ?? null;
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    if (kind === 'merge-log-get') {
      const id = Number(ps[0]);
      const tenantId = Number(ps[1]);
      const row = mergeLog.get(id);
      if (row && row.tenant_id === tenantId) {
        return { rows: [row] };
      }
      return { rows: [] };
    }
    if (kind === 'cust-get') {
      // params: [id, tenantId] — secondary check in undoCustomerMerge
      const id = Number(ps[0]);
      const tenantId = Number(ps[1]);
      const cust = customers.get(id);
      if (cust && cust.tenant_id === tenantId) {
        return { rows: [{ id: cust.id, archived: cust.archived }] };
      }
      return { rows: [] };
    }
    if (kind === 'cust-archive') {
      const id = Number(ps[0]);
      const cust = customers.get(id);
      if (cust) {
        cust.archived = 1;
        cust.updated_at = '2026-06-22';
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    if (kind === 'cust-unarchive') {
      const id = Number(ps[0]);
      const cust = customers.get(id);
      if (cust) {
        cust.archived = 0;
        cust.updated_at = '2026-06-22';
        return { rows: [], changes: 1 };
      }
      return { rows: [], changes: 0 };
    }
    if (kind === 'inv-id-list') {
      // params: [tenantId, customerId]
      const tenantId = Number(ps[0]);
      const custId = Number(ps[1]);
      const out = [];
      for (const inv of invoices.values()) {
        if (inv.tenant_id === tenantId && inv.customer_id === custId) {
          out.push({ id: inv.id });
        }
      }
      return { rows: out };
    }
    if (kind === 'pay-id-list') {
      const tenantId = Number(ps[0]);
      const custId = Number(ps[1]);
      const out = [];
      for (const p of payments.values()) {
        const inv = invoices.get(p.invoice_id);
        if (!inv) continue;
        if (inv.tenant_id === tenantId && inv.customer_id === custId) {
          out.push({ id: p.id });
        }
      }
      return { rows: out };
    }
    if (kind === 'inv-reassign') {
      // params: [newCustId, tenantId, oldCustId, ...id list]
      const newCustId = Number(ps[0]);
      const tenantId = Number(ps[1]);
      const oldCustId = Number(ps[2]);
      // If id list is present, filter to those ids.
      const idFilter = ps.length > 3 ? ps.slice(3).map(Number) : null;
      let count = 0;
      for (const inv of invoices.values()) {
        if (inv.tenant_id !== tenantId) continue;
        if (inv.customer_id !== oldCustId) continue;
        if (idFilter && !idFilter.includes(inv.id)) continue;
        inv.customer_id = newCustId;
        inv.updated_at = '2026-06-22';
        count += 1;
      }
      return { rows: [], changes: count };
    }
    if (kind === 'cust-lookup') {
      const tenantId = Number(ps[0]);
      const id1 = Number(ps[1]);
      const id2 = Number(ps[2]);
      const out = [];
      for (const c of customers.values()) {
        if (c.tenant_id !== tenantId) continue;
        if (c.id === id1 || c.id === id2) {
          out.push({ id: c.id, name: c.name, archived: c.archived });
        }
      }
      return { rows: out };
    }
    if (kind === 'inv-count') {
      const tenantId = Number(ps[0]);
      const custId = Number(ps[1]);
      // Optional id list at the end (for the "count after
      // restore" query in undoCustomerMerge).
      const idFilter = ps.length > 2 ? ps.slice(2).map(Number) : null;
      let n = 0;
      for (const inv of invoices.values()) {
        if (inv.tenant_id !== tenantId) continue;
        if (inv.customer_id !== custId) continue;
        if (idFilter && !idFilter.includes(inv.id)) continue;
        n += 1;
      }
      return { rows: [{ n }] };
    }
    if (kind === 'pay-join') {
      const tenantId = Number(ps[0]);
      const custId = Number(ps[1]);
      // Optional id filter list at the end.
      const idFilter = ps.length > 2 ? ps.slice(2).map(Number) : null;
      let n = 0;
      for (const p of payments.values()) {
        const inv = invoices.get(p.invoice_id);
        if (!inv) continue;
        if (inv.tenant_id !== tenantId) continue;
        if (inv.customer_id !== custId) continue;
        if (idFilter && !idFilter.includes(inv.id)) continue;
        n += 1;
      }
      return { rows: [{ n }] };
    }
    if (kind === 'merge-log-list') {
      const tenantId = Number(ps[0]);
      // Param layout depends on which optional filters were
      // applied. We sniff by counting the number of params.
      // 2 params: [tenantId, limit]
      // 3 params: [tenantId, primaryId, limit] or
      //           [tenantId, secondaryId, limit]
      // 4 params: [tenantId, primaryId, secondaryId, limit]
      const out = [];
      for (const row of mergeLog.values()) {
        if (row.tenant_id !== tenantId) continue;
        if (ps.length === 3) {
          // Could be primaryId or secondaryId. The production
          // SQL queries use primary_customer_id or
          // secondary_customer_id. The production module
          // produces different SQL shapes depending on
          // which filter is set. We use the param index:
          // ps[1] is the filter value. The mock inspects the
          // SQL to decide which column to filter on.
          const filterCol = /PRIMARY_CUSTOMER_ID/i.test(sql) ? 'primary' : 'secondary';
          if (filterCol === 'primary' && row.primary_customer_id !== Number(ps[1])) continue;
          if (filterCol === 'secondary' && row.secondary_customer_id !== Number(ps[1])) continue;
        }
        if (ps.length === 4) {
          if (row.primary_customer_id !== Number(ps[1])) continue;
          if (row.secondary_customer_id !== Number(ps[2])) continue;
        }
        out.push({ ...row });
      }
      out.sort((a, b) => b.id - a.id); // id DESC (mimics created_at DESC)
      return { rows: out };
    }
    return { rows: [] };
  }

  return {
    query,
    seedCustomer: (row) => {
      const id = nextCustId++;
      customers.set(id, {
        id,
        tenant_id: row.tenant_id ?? 0,
        name: row.name ?? `Cust ${id}`,
        hvhh: row.hvhh ?? null,
        archived: row.archived ?? 0,
        updated_at: '2026-01-01',
      });
      return id;
    },
    seedInvoice: (row) => {
      const id = nextInvId++;
      invoices.set(id, {
        id,
        tenant_id: row.tenant_id ?? 0,
        customer_id: row.customer_id,
        invoice_number: row.invoice_number ?? `INV-${id}`,
        issue_date: row.issue_date ?? '2026-01-15',
        status: row.status ?? 'sent',
        total_amd: row.total_amd ?? 1000,
      });
      return id;
    },
    seedPayment: (row) => {
      const id = nextPayId++;
      payments.set(id, {
        id,
        invoice_id: row.invoice_id,
        amount_amd: row.amount_amd ?? 1000,
      });
      return id;
    },
    // Inspectors
    _isArchived: (id) => (customers.get(id)?.archived ? 1 : 0),
    _invoiceCustomerId: (id) => invoices.get(id)?.customer_id,
    _mergeLogSize: () => mergeLog.size,
    _mergeLogGet: (id) => mergeLog.get(id),
    _customerGet: (id) => customers.get(id),
    _customerDelete: (id) => customers.delete(id),
  };
}

// ────────────────────────────────────────────────────────────────────────
// applyCustomerMerge
// ────────────────────────────────────────────────────────────────────────

test('applyCustomerMerge: happy path re-assigns invoices and archives secondary', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'Acme Corp' });
  const secondary = db.seedCustomer({ name: 'Acme Corporation' });
  const inv1 = db.seedInvoice({ customer_id: secondary });
  const inv2 = db.seedInvoice({ customer_id: secondary });
  const inv3 = db.seedInvoice({ customer_id: primary });

  const result = await applyCustomerMerge(
    db,
    { primary_id: primary, secondary_id: secondary, applied_by_user_id: 7, reason: 'test merge' },
    0,
  );
  assert.equal(result.primary_id, primary);
  assert.equal(result.secondary_id, secondary);
  assert.equal(result.invoices_reassigned, 2);
  assert.equal(result.payments_reassigned, 0);
  assert.ok(result.merge_log_id > 0);
  // W102-1: the reassigned invoice/payment ID lists are
  // populated in the audit row. These are the source of
  // truth for the undo function.
  assert.deepEqual(result.reassigned_invoice_ids.sort(), [inv1, inv2].sort());
  assert.deepEqual(result.reassigned_payment_ids, []);
  // Secondary is now archived
  assert.equal(db._isArchived(secondary), 1);
  assert.equal(db._isArchived(primary), 0);
  // Invoices that belonged to the secondary are now on the primary
  assert.equal(db._invoiceCustomerId(inv1), primary);
  assert.equal(db._invoiceCustomerId(inv2), primary);
  // Primary's existing invoice is untouched
  assert.equal(db._invoiceCustomerId(inv3), primary);
  // Audit row recorded
  assert.equal(db._mergeLogSize(), 1);
});

test('applyCustomerMerge: counts payments via the invoice join', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'Acme' });
  const secondary = db.seedCustomer({ name: 'Acme Inc' });
  const inv1 = db.seedInvoice({ customer_id: secondary });
  const inv2 = db.seedInvoice({ customer_id: secondary });
  db.seedPayment({ invoice_id: inv1 });
  db.seedPayment({ invoice_id: inv2 });
  db.seedPayment({ invoice_id: inv1 });

  const result = await applyCustomerMerge(
    db,
    { primary_id: primary, secondary_id: secondary },
    0,
  );
  assert.equal(result.invoices_reassigned, 2);
  assert.equal(result.payments_reassigned, 3);
});

test('applyCustomerMerge: rejects when primary and secondary are the same', async () => {
  const db = makeMergeMockDb();
  const c = db.seedCustomer({ name: 'A' });
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: c, secondary_id: c }, 0),
    /must be different/,
  );
});

test('applyCustomerMerge: rejects when primary is missing', async () => {
  const db = makeMergeMockDb();
  const c = db.seedCustomer({ name: 'A' });
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: 99999, secondary_id: c }, 0),
    /primary customer 99999 not found/,
  );
});

test('applyCustomerMerge: rejects when secondary is missing', async () => {
  const db = makeMergeMockDb();
  const c = db.seedCustomer({ name: 'A' });
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: c, secondary_id: 99999 }, 0),
    /secondary customer 99999 not found/,
  );
});

test('applyCustomerMerge: rejects when secondary is already archived', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'A' });
  const secondary = db.seedCustomer({ name: 'B', archived: 1 });
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: primary, secondary_id: secondary }, 0),
    /already archived/,
  );
});

test('applyCustomerMerge: rejects cross-tenant (returns not-found for primary)', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ tenant_id: 0, name: 'A' });
  const b = db.seedCustomer({ tenant_id: 0, name: 'B' });
  // Request with tenantId=1 (different tenant) — neither customer is in scope.
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: a, secondary_id: b }, 1),
    /not found/,
  );
});

test('applyCustomerMerge: rejects non-integer primary_id', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: 'abc', secondary_id: 2 }, 0),
    /positive integer/,
  );
});

test('applyCustomerMerge: rejects negative primary_id', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(
    applyCustomerMerge(db, { primary_id: -1, secondary_id: 2 }, 0),
    /positive integer/,
  );
});

test('applyCustomerMerge: rejects too-long reason', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  await assert.rejects(
    applyCustomerMerge(
      db,
      { primary_id: a, secondary_id: b, reason: 'x'.repeat(2000) },
      0,
    ),
    /at most 1024 characters/,
  );
});

test('applyCustomerMerge: rejects non-string reason', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  await assert.rejects(
    applyCustomerMerge(
      db,
      { primary_id: a, secondary_id: b, reason: 42 },
      0,
    ),
    /string or null/,
  );
});

test('applyCustomerMerge: reason is optional (null when omitted)', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const result = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  assert.ok(result.merge_log_id > 0);
  // No exception means success.
});

test('applyCustomerMerge: applied_by_user_id is optional', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  // No applied_by_user_id
  const result = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  assert.ok(result.merge_log_id > 0);
});

test('applyCustomerMerge: rejects non-integer applied_by_user_id', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  await assert.rejects(
    applyCustomerMerge(
      db,
      { primary_id: a, secondary_id: b, applied_by_user_id: 'foo' },
      0,
    ),
    /positive integer/,
  );
});

test('applyCustomerMerge: input is required', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(
    applyCustomerMerge(db, null, 0),
    /input is required/,
  );
});

test('applyCustomerMerge: empty invoices reassigned count is 0', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const result = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  assert.equal(result.invoices_reassigned, 0);
  assert.equal(result.payments_reassigned, 0);
  // Secondary is still archived even if there were no invoices to re-assign.
  assert.equal(db._isArchived(b), 1);
});

// ────────────────────────────────────────────────────────────────────────
// listCustomerMergeLog
// ────────────────────────────────────────────────────────────────────────

test('listCustomerMergeLog: returns audit rows for the tenant', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const c = db.seedCustomer({ name: 'C' });
  await applyCustomerMerge(db, { primary_id: a, secondary_id: b }, 0);
  await applyCustomerMerge(db, { primary_id: a, secondary_id: c }, 0);
  const rows = await listCustomerMergeLog(db, 0);
  assert.equal(rows.length, 2);
});

test('listCustomerMergeLog: respects primaryId filter', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const c = db.seedCustomer({ name: 'C' });
  const d = db.seedCustomer({ name: 'D' });
  await applyCustomerMerge(db, { primary_id: a, secondary_id: b }, 0);
  await applyCustomerMerge(db, { primary_id: c, secondary_id: d }, 0);
  const rows = await listCustomerMergeLog(db, 0, { primaryId: a });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].primary_customer_id, a);
});

test('listCustomerMergeLog: rejects bad limit', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(
    listCustomerMergeLog(db, 0, { limit: 0 }),
    /positive integer/,
  );
  await assert.rejects(
    listCustomerMergeLog(db, 0, { limit: 10000 }),
    /between 1 and 500/,
  );
});

// ────────────────────────────────────────────────────────────────────────
// undoCustomerMerge (W102-1)
// ────────────────────────────────────────────────────────────────────────

test('undoCustomerMerge: happy path — re-assigns invoices back to secondary, un-archives', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'A' });
  const secondary = db.seedCustomer({ name: 'B' });
  const inv1 = db.seedInvoice({ customer_id: secondary });
  const inv2 = db.seedInvoice({ customer_id: secondary });

  // First apply a merge
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: primary, secondary_id: secondary },
    0,
  );
  // Verify post-merge state
  assert.equal(db._isArchived(secondary), 1);
  assert.equal(db._invoiceCustomerId(inv1), primary);
  assert.equal(db._invoiceCustomerId(inv2), primary);

  // Now undo
  const undoRes = await undoCustomerMerge(
    db,
    { merge_log_id: mergeRes.merge_log_id, undone_by_user_id: 7, undone_reason: 'test undo' },
    0,
  );
  assert.equal(undoRes.merge_log_id, mergeRes.merge_log_id);
  assert.equal(undoRes.primary_id, primary);
  assert.equal(undoRes.secondary_id, secondary);
  assert.equal(undoRes.invoices_restored, 2);
  assert.equal(undoRes.payments_restored, 0);
  // Secondary is un-archived
  assert.equal(db._isArchived(secondary), 0);
  // Invoices are back on the secondary
  assert.equal(db._invoiceCustomerId(inv1), secondary);
  assert.equal(db._invoiceCustomerId(inv2), secondary);
});

test('undoCustomerMerge: counts payments that follow the invoice restore', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'A' });
  const secondary = db.seedCustomer({ name: 'B' });
  const inv1 = db.seedInvoice({ customer_id: secondary });
  db.seedPayment({ invoice_id: inv1 });
  db.seedPayment({ invoice_id: inv1 });

  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: primary, secondary_id: secondary },
    0,
  );
  const undoRes = await undoCustomerMerge(
    db,
    { merge_log_id: mergeRes.merge_log_id },
    0,
  );
  assert.equal(undoRes.invoices_restored, 1);
  assert.equal(undoRes.payments_restored, 2);
});

test('undoCustomerMerge: idempotency — second undo returns 400 (already undone)', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const inv1 = db.seedInvoice({ customer_id: b });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  await undoCustomerMerge(db, { merge_log_id: mergeRes.merge_log_id }, 0);
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: mergeRes.merge_log_id }, 0),
    /already been undone/,
  );
});

test('undoCustomerMerge: 404 when merge log row does not exist', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: 99999 }, 0),
    /not found/,
  );
});

test('undoCustomerMerge: cross-tenant returns 404', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: mergeRes.merge_log_id }, 1),
    /not found/,
  );
});

test('undoCustomerMerge: pre-W102-1 merge (no reassigned_invoice_ids) returns 400', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  // Simulate a pre-W102-1 merge by clearing the list
  const logRow = db._mergeLogGet(mergeRes.merge_log_id);
  logRow.reassigned_invoice_ids = null;
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: mergeRes.merge_log_id }, 0),
    /pre-W102-1/,
  );
});

test('undoCustomerMerge: rejects when secondary is not archived (state inconsistent)', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  // Simulate a state where the secondary was un-archived by another path
  const bRow = db._customerGet(b);
  bRow.archived = 0;
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: mergeRes.merge_log_id }, 0),
    /not archived/,
  );
});

test('undoCustomerMerge: rejects when secondary was deleted', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  // Simulate secondary deletion
  db._customerDelete(b);
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: mergeRes.merge_log_id }, 0),
    /not found/,
  );
});

test('undoCustomerMerge: reason validation', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  await assert.rejects(
    undoCustomerMerge(
      db,
      { merge_log_id: mergeRes.merge_log_id, undone_reason: 42 },
      0,
    ),
    /string or null/,
  );
  await assert.rejects(
    undoCustomerMerge(
      db,
      { merge_log_id: mergeRes.merge_log_id, undone_reason: 'x'.repeat(2000) },
      0,
    ),
    /at most 1024/,
  );
});

test('undoCustomerMerge: undone_by_user_id validation', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  await assert.rejects(
    undoCustomerMerge(
      db,
      { merge_log_id: mergeRes.merge_log_id, undone_by_user_id: -1 },
      0,
    ),
    /positive integer/,
  );
});

test('undoCustomerMerge: requires merge_log_id', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(undoCustomerMerge(db, {}, 0), /positive integer/);
});

test('undoCustomerMerge: input is required', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(undoCustomerMerge(db, null, 0), /input is required/);
});

// ────────────────────────────────────────────────────────────────────────
// undoCustomerMerge (W117) — dry-run mode.
// ────────────────────────────────────────────────────────────────────────

test('undoCustomerMerge: dryRun returns preview counts without writing', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'A' });
  const secondary = db.seedCustomer({ name: 'B' });
  const inv1 = db.seedInvoice({ customer_id: secondary });
  const inv2 = db.seedInvoice({ customer_id: secondary });
  db.seedPayment({ invoice_id: inv1 });
  db.seedPayment({ invoice_id: inv1 });

  // Apply a merge so we have something to undo.
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: primary, secondary_id: secondary },
    0,
  );
  // dryRun should NOT change state.
  const beforeArchived = db._isArchived(secondary);
  const beforeInv1 = db._invoiceCustomerId(inv1);
  const beforeInv2 = db._invoiceCustomerId(inv2);
  const beforeLog = db._mergeLogGet(mergeRes.merge_log_id);

  const dry = await undoCustomerMerge(
    db,
    { merge_log_id: mergeRes.merge_log_id, dryRun: true },
    0,
  );
  assert.equal(dry.dryRun, true);
  assert.equal(dry.invoices_restored, 2, 'should preview 2 invoices restored');
  assert.equal(dry.payments_restored, 2, 'should preview 2 payments following');

  // State must NOT have changed.
  assert.equal(db._isArchived(secondary), beforeArchived);
  assert.equal(db._invoiceCustomerId(inv1), beforeInv1);
  assert.equal(db._invoiceCustomerId(inv2), beforeInv2);
  // The log row's undone_at must still be null.
  assert.equal(db._mergeLogGet(mergeRes.merge_log_id).undone_at, beforeLog.undone_at);
});

test('undoCustomerMerge: dryRun still validates log exists', async () => {
  const db = makeMergeMockDb();
  await assert.rejects(
    undoCustomerMerge(db, { merge_log_id: 9999, dryRun: true }, 0),
    /not found/,
  );
});

test('undoCustomerMerge: dryRun still rejects already-undone merges', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  db.seedInvoice({ customer_id: b });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  await undoCustomerMerge(
    db,
    { merge_log_id: mergeRes.merge_log_id },
    0,
  );
  await assert.rejects(
    undoCustomerMerge(
      db,
      { merge_log_id: mergeRes.merge_log_id, dryRun: true },
      0,
    ),
    /already been undone/,
  );
});

test('undoCustomerMerge: dryRun still rejects when secondary was deleted', async () => {
  const db = makeMergeMockDb();
  const a = db.seedCustomer({ name: 'A' });
  const b = db.seedCustomer({ name: 'B' });
  const inv1 = db.seedInvoice({ customer_id: b });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: a, secondary_id: b },
    0,
  );
  // Delete the secondary (simulate operator error or
  // data corruption).
  db._customerDelete(b);
  await assert.rejects(
    undoCustomerMerge(
      db,
      { merge_log_id: mergeRes.merge_log_id, dryRun: true },
      0,
    ),
    /secondary customer.*not found/,
  );
});

test('undoCustomerMerge: real undo after dryRun still works (dryRun is read-only)', async () => {
  const db = makeMergeMockDb();
  const primary = db.seedCustomer({ name: 'A' });
  const secondary = db.seedCustomer({ name: 'B' });
  const inv1 = db.seedInvoice({ customer_id: secondary });
  const inv2 = db.seedInvoice({ customer_id: secondary });
  const mergeRes = await applyCustomerMerge(
    db,
    { primary_id: primary, secondary_id: secondary },
    0,
  );
  // Preview (no state change).
  const dry = await undoCustomerMerge(
    db,
    { merge_log_id: mergeRes.merge_log_id, dryRun: true },
    0,
  );
  assert.equal(dry.dryRun, true);
  // Real undo (does state change).
  const real = await undoCustomerMerge(
    db,
    { merge_log_id: mergeRes.merge_log_id },
    0,
  );
  assert.equal(real.dryRun, undefined, 'real undo should not have dryRun flag');
  assert.equal(real.invoices_restored, 2);
  // Verify the state changed.
  assert.equal(db._isArchived(secondary), 0);
  assert.equal(db._invoiceCustomerId(inv1), secondary);
  assert.equal(db._invoiceCustomerId(inv2), secondary);
});
