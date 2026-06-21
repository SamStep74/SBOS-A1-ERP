// Test the CRM (Phase 2) pure functions end-to-end.
// Mirrors the pattern in server/finance/customer.test.js:
// each test gets a fresh in-memory DB so the test is hermetic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  createContact,
  listContacts,
  createLead,
  listLeads,
  ValueError,
} from './crm.js';

// ────────────────────────────────────────────────────────────────────────
// Test harness — production-shaped db adapter (db.query returns { rows })
// ────────────────────────────────────────────────────────────────────────

function makeMemoryDb() {
  // Minimal in-memory sqlite-shaped adapter. finance.crm_* tables
  // are created here (matches the production 0009_crm.sql schema).
  const db = new DatabaseSync(':memory:');
  db.exec('ATTACH DATABASE ":memory:" AS finance');
  db.exec(`
    CREATE TABLE finance.crm_contacts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      customer_id INTEGER,
      name TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      role TEXT,
      notes TEXT,
      archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE finance.crm_leads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      company TEXT,
      email TEXT,
      phone TEXT,
      source TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      estimated_value_amd INTEGER,
      notes TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  return {
    _db: db,
    // Production shape: db.query(sql, params) returns { rows: [...] }
    // for SELECT; for INSERT/UPDATE the { rows: [] } fallback is
    // used (the CRM module falls back to LAST_INSERT_ROWID()).
    async query(sql, params = []) {
      // Translate pg-style $N → sqlite ? placeholder.
      const pgStyle = sql.replace(/\$\d+/g, '?');
      const stmt = db.prepare(pgStyle);
      const upper = sql.trim().toUpperCase();
      if (upper.startsWith('SELECT') || upper.includes(' RETURNING')) {
        const rows = stmt.all(...params);
        return { rows };
      }
      // INSERT/UPDATE/DELETE
      const info = stmt.run(...params);
      return {
        rows: [],
        lastInsertRowid: info.lastInsertRowid,
        changes: info.changes,
      };
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// Contacts
// ────────────────────────────────────────────────────────────────────────

test('crm: createContact inserts a row + returns the id', async () => {
  const db = makeMemoryDb();
  const out = await createContact(
    db,
    { name: 'Jane Doe', email: 'jane@example.com', role: 'CEO' },
    0,
  );
  assert.equal(typeof out.id, 'number');
  assert.ok(out.id > 0);
});

test('crm: listContacts returns the active contacts for the tenant', async () => {
  const db = makeMemoryDb();
  await createContact(db, { name: 'Alice' }, 0);
  await createContact(db, { name: 'Bob' }, 0);
  await createContact(db, { name: 'Other-tenant Carol' }, 1);
  const rows = await listContacts(db, 0);
  assert.equal(rows.length, 2);
  // Ordered by name
  assert.equal(rows[0].name, 'Alice');
  assert.equal(rows[1].name, 'Bob');
});

test('crm: listContacts is tenant-scoped', async () => {
  const db = makeMemoryDb();
  await createContact(db, { name: 'Tenant0' }, 0);
  await createContact(db, { name: 'Tenant1' }, 1);
  const rows0 = await listContacts(db, 0);
  const rows1 = await listContacts(db, 1);
  assert.equal(rows0.length, 1);
  assert.equal(rows0[0].name, 'Tenant0');
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].name, 'Tenant1');
});

test('crm: createContact validates email', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createContact(db, { name: 'X', email: 'not-an-email' }, 0),
    /email must be a valid email address/,
  );
});

test('crm: createContact validates phone', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createContact(db, { name: 'X', phone: 'abc-not-a-phone' }, 0),
    /phone must be a valid phone number/,
  );
});

test('crm: createContact requires name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createContact(db, { email: 'x@example.com' }, 0),
    /name must be a string of 1-255 characters/,
  );
});

test('crm: createContact allows all optional fields to be null', async () => {
  const db = makeMemoryDb();
  const out = await createContact(db, { name: 'Minimal' }, 0);
  assert.ok(out.id > 0);
  const rows = await listContacts(db, 0);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].email, null);
  assert.equal(rows[0].phone, null);
  assert.equal(rows[0].role, null);
  assert.equal(rows[0].notes, null);
});

test('crm: createContact with customer_id stores the FK', async () => {
  const db = makeMemoryDb();
  const out = await createContact(
    db,
    { name: 'Linked', customer_id: 42 },
    0,
  );
  assert.ok(out.id > 0);
  const rows = await listContacts(db, 0);
  assert.equal(rows[0].customer_id, 42);
});

// ────────────────────────────────────────────────────────────────────────
// Leads
// ────────────────────────────────────────────────────────────────────────

test('crm: createLead inserts a row with default status=new', async () => {
  const db = makeMemoryDb();
  const out = await createLead(db, { name: 'New prospect' }, 0);
  assert.ok(out.id > 0);
  // The default status is 'new' — verify via the db adapter.
  const rows = await db.query(
    'SELECT status FROM finance.crm_leads WHERE id = $1',
    [out.id],
  );
  assert.equal(rows.rows[0].status, 'new');
});

test('crm: createLead accepts all status values', async () => {
  const db = makeMemoryDb();
  for (const status of ['new', 'qualified', 'proposal', 'won', 'lost']) {
    const out = await createLead(db, { name: `Lead ${status}`, status }, 0);
    assert.ok(out.id > 0);
  }
});

test('crm: createLead rejects invalid status', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createLead(db, { name: 'X', status: 'invalid' }, 0),
    /lead status must be one of/,
  );
});

test('crm: listLeads returns the leads for the tenant (most recent first)', async () => {
  const db = makeMemoryDb();
  await createLead(db, { name: 'First' }, 0);
  await createLead(db, { name: 'Second' }, 0);
  await createLead(db, { name: 'Third' }, 0);
  const rows = await listLeads(db, 0);
  assert.equal(rows.length, 3);
  // Most recent first (by id DESC; auto-increment reflects
  // insertion order, even within the same second).
  assert.equal(rows[0].name, 'Third');
  assert.equal(rows[1].name, 'Second');
  assert.equal(rows[2].name, 'First');
});

test('crm: listLeads filters by status', async () => {
  const db = makeMemoryDb();
  await createLead(db, { name: 'New 1', status: 'new' }, 0);
  await createLead(db, { name: 'New 2', status: 'new' }, 0);
  await createLead(db, { name: 'Won 1', status: 'won' }, 0);
  const all = await listLeads(db, 0);
  const newOnly = await listLeads(db, 0, 'new');
  const wonOnly = await listLeads(db, 0, 'won');
  assert.equal(all.length, 3);
  assert.equal(newOnly.length, 2);
  assert.equal(wonOnly.length, 1);
  assert.equal(wonOnly[0].name, 'Won 1');
});

test('crm: listLeads is tenant-scoped', async () => {
  const db = makeMemoryDb();
  await createLead(db, { name: 'Tenant0' }, 0);
  await createLead(db, { name: 'Tenant1' }, 1);
  const rows0 = await listLeads(db, 0);
  const rows1 = await listLeads(db, 1);
  assert.equal(rows0.length, 1);
  assert.equal(rows0[0].name, 'Tenant0');
  assert.equal(rows1.length, 1);
  assert.equal(rows1[0].name, 'Tenant1');
});

test('crm: createLead validates email + phone', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createLead(db, { name: 'X', email: 'bad' }, 0),
    /email must be a valid email address/,
  );
  await assert.rejects(
    createLead(db, { name: 'X', phone: 'bad' }, 0),
    /phone must be a valid phone number/,
  );
});

test('crm: createLead requires name', async () => {
  const db = makeMemoryDb();
  await assert.rejects(
    createLead(db, { company: 'X Corp' }, 0),
    /name must be a string of 1-255 characters/,
  );
});

test('crm: createLead with estimated_value_amd stores the int', async () => {
  const db = makeMemoryDb();
  const out = await createLead(
    db,
    { name: 'Big deal', estimated_value_amd: 5_000_000 },
    0,
  );
  assert.ok(out.id > 0);
  const rows = await listLeads(db, 0);
  assert.equal(rows[0].estimated_value_amd, 5_000_000);
});
