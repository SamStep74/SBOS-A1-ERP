// Test the customer pure functions end-to-end. Mirrors the pattern in
// server/finance/invoice.test.js: each test gets a fresh in-memory DB
// (makeRealDb) so the test is hermetic.
//
// The sqlite path uses realDb.js' mock/pg adapter; the pg path
// exercises the real adapter shape via the same interface.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { createCustomer, updateCustomer, listCustomers, getCustomer, ValueError } from './customer.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness — same shape as invoice.test.js uses
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter. finance.* tables are created
  // here; cross-tenant rows seeded explicitly.
  const db = new DatabaseSync(':memory:');
  db.exec('ATTACH DATABASE ":memory:" AS finance');
  db.exec(`
    CREATE TABLE finance.customers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL DEFAULT 0,
      name TEXT NOT NULL,
      hvhh TEXT,
      address TEXT,
      email TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  // Mimic realDb.js' pg adapter (returns { rows } shape, uses positional $1,$2 params)
  return {
    _db: db,
    async query(sql, params = []) {
      const pgStyle = sql.replace(/\$\d+/g, '?');
      const stmt = db.prepare(pgStyle);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.startsWith('RETURNING') || upper.includes(' RETURNING')) {
        const rows = stmt.all(...params);
        return { rows };
      }
      // INSERT/UPDATE/DELETE — also return RETURNING if present
      const info = stmt.run(...params);
      if (upper.includes(' RETURNING')) {
        // For tests, fetch the last inserted/updated row by re-running
        // the SELECT for it. Tests use specific ids, so this is fine.
        // (For sqlite, INSERT/UPDATE RETURNING is supported in node:sqlite
        // via the run() return, but the abstraction prefers the rows shape.)
        const out = db.prepare(pgStyle.replace(/RETURNING.*$/i, '').trim());
        // Re-derive by querying via the change. For tests, we re-select the row.
        // Simpler: use lastInsertRowid for INSERT, then select.
        if (upper.startsWith('INSERT')) {
          const id = info.lastInsertRowid;
          const sel = db.prepare('SELECT * FROM finance.customers WHERE id = ?').all(id);
          return { rows: sel };
        }
        return { rows: [] };
      }
      return { rows: [] };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

test('createCustomer: minimal valid input → returns id + row', async () => {
  const db = makeMemoryDb();
  const out = await createCustomer(db, { name: 'Acme LLC' }, 0);
  assert.equal(out.name, 'Acme LLC');
  assert.equal(out.hvhh, null);
  assert.equal(out.tenant_id, 0);
  assert.ok(Number.isInteger(out.id) && out.id > 0);
});

test('createCustomer: full input (name+hvhh+address+email) persists all fields', async () => {
  const db = makeMemoryDb();
  const out = await createCustomer(db, { name: 'Beta Inc', hvhh: '01234567', address: 'Yerevan', email: 'ar@beta.am' }, 5);
  assert.equal(out.hvhh, '01234567');
  assert.equal(out.address, 'Yerevan');
  assert.equal(out.email, 'ar@beta.am');
  assert.equal(out.tenant_id, 5);
  const back = await getCustomer(db, out.id, 5);
  assert.deepEqual(back, out);
});

test('createCustomer: rejects empty / non-string name with ValueError', async () => {
  const db = makeMemoryDb();
  await assert.rejects(createCustomer(db, { name: '' }, 0), ValueError);
  await assert.rejects(createCustomer(db, { name: 123 }, 0), ValueError);
  await assert.rejects(createCustomer(db, {}, 0), ValueError);
});

test('createCustomer: rejects malformed hvhh (not 8 digits)', async () => {
  const db = makeMemoryDb();
  await assert.rejects(createCustomer(db, { name: 'x', hvhh: '123' }, 0), ValueError);
  await assert.rejects(createCustomer(db, { name: 'x', hvhh: '123456789' }, 0), ValueError);
  await assert.rejects(createCustomer(db, { name: 'x', hvhh: 'abcdefgh' }, 0), ValueError);
});

test('createCustomer: hvhh uniqueness scoped to tenant (same hvhh different tenants OK)', async () => {
  const db = makeMemoryDb();
  const a = await createCustomer(db, { name: 'Tenant-0 Acme', hvhh: '11111111' }, 0);
  const b = await createCustomer(db, { name: 'Tenant-7 Acme', hvhh: '11111111' }, 7);
  assert.notEqual(a.id, b.id);
  assert.equal(a.tenant_id, 0);
  assert.equal(b.tenant_id, 7);
});

test('createCustomer: duplicate hvhh within same tenant → ValueError', async () => {
  const db = makeMemoryDb();
  await createCustomer(db, { name: 'First', hvhh: '22222222' }, 0);
  await assert.rejects(
    createCustomer(db, { name: 'Dup', hvhh: '22222222' }, 0),
    (e) => e instanceof ValueError && /already exists/.test(e.message),
  );
});

test('updateCustomer: name change persists', async () => {
  const db = makeMemoryDb();
  const c = await createCustomer(db, { name: 'Old Name' }, 0);
  const out = await updateCustomer(db, c.id, { name: 'New Name' }, 0);
  assert.equal(out.name, 'New Name');
  const back = await getCustomer(db, c.id, 0);
  assert.equal(back.name, 'New Name');
});

test('updateCustomer: rejects unknown field', async () => {
  const db = makeMemoryDb();
  const c = await createCustomer(db, { name: 'X' }, 0);
  await assert.rejects(updateCustomer(db, c.id, { evil: 'sql' }, 0), ValueError);
});

test('updateCustomer: rejects empty patch', async () => {
  const db = makeMemoryDb();
  const c = await createCustomer(db, { name: 'X' }, 0);
  await assert.rejects(updateCustomer(db, c.id, {}, 0), ValueError);
});

test('updateCustomer: cross-tenant id is invisible (not found in tenant)', async () => {
  const db = makeMemoryDb();
  const c = await createCustomer(db, { name: 'Tenant-0' }, 0);
  await assert.rejects(
    updateCustomer(db, c.id, { name: 'Hacked' }, 7),
    (e) => e instanceof ValueError && /not found in tenant/.test(e.message),
  );
  // The original row is unchanged.
  const back = await getCustomer(db, c.id, 0);
  assert.equal(back.name, 'Tenant-0');
});

test('listCustomers: tenant-scoped (tenant 0 cannot see tenant 7)', async () => {
  const db = makeMemoryDb();
  await createCustomer(db, { name: 'A' }, 0);
  await createCustomer(db, { name: 'B' }, 0);
  await createCustomer(db, { name: 'C' }, 7);
  const t0 = await listCustomers(db, 0);
  const t7 = await listCustomers(db, 7);
  assert.equal(t0.length, 2);
  assert.equal(t7.length, 1);
  assert.equal(t7[0].name, 'C');
  assert.equal(t0.every((c) => c.tenant_id === 0), true);
});

test('getCustomer: returns null for non-existent or cross-tenant id', async () => {
  const db = makeMemoryDb();
  assert.equal(await getCustomer(db, 999, 0), null);
  const c = await createCustomer(db, { name: 'A' }, 0);
  assert.equal(await getCustomer(db, c.id, 7), null);
  assert.notEqual(await getCustomer(db, c.id, 0), null);
});
