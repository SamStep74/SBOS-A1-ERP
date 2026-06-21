// Phase 3 AI agents (W93-1) — data quality tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findDuplicateCustomers,
  findHvhhDrift,
  getDataQualitySummary,
  ValueError,
} from './dataQuality.js';

function makeMockDb() {
  const customers = new Map();
  const vendors = new Map();
  const employees = new Map();
  const invoices = new Map();
  let nextCustId = 1;
  let nextVendId = 1;
  let nextEmpId = 1;
  let nextInvId = 1;

  function nextId(map) {
    if (map === customers) return nextCustId++;
    if (map === vendors) return nextVendId++;
    if (map === employees) return nextEmpId++;
    if (map === invoices) return nextInvId++;
    throw new Error('mock: unknown map');
  }

  function classify(sql) {
    const s = sql.trim().toUpperCase();
    // Aggregate queries for getDataQualitySummary use
    // `COUNT(*) AS total`. The findDuplicateCustomers queries
    // have `HAVING COUNT(*) > 1` in a subquery — no AS alias.
    if (/SELECT\s+COUNT\(\*\)\s+AS\s+/i.test(s)) return 'aggregate';
    if (/FROM\s+FINANCE\.CUSTOMERS/i.test(s) && /GROUP\s+BY/i.test(s)) return 'cust-groupby';
    if (/FROM\s+FINANCE\.CUSTOMERS/i.test(s)) return 'cust';
    if (/FROM\s+FINANCE\.VENDORS/i.test(s)) return 'vend';
    if (/FROM\s+FINANCE\.HR_EMPLOYEES/i.test(s)) return 'emp';
    if (/FROM\s+FINANCE\.INVOICES\s+I/i.test(s)) return 'inv';
    return 'passthrough';
  }

  // Detect which alias the SELECT uses for the duplicate-match
  // value. The hvhh-dup query aliases `hvhh AS match_value`; the
  // name-dup query aliases `LOWER(TRIM(name)) AS match_value`.
  // We mimic both by inspecting the SQL.
  function matchValueAlias(sql) {
    const upper = sql.toUpperCase();
    if (/LOWER\(TRIM\(NAME\)\)\s+AS\s+MATCH_VALUE/i.test(upper)) return 'name_norm';
    if (/HVHH\s+AS\s+MATCH_VALUE/i.test(upper)) return 'hvhh';
    return null;
  }

  async function query(sql, params = []) {
    const ps = params ?? [];
    const kind = classify(sql);
    const s = sql.trim().toUpperCase();
    const upper = sql.toUpperCase();

    if (kind === 'aggregate') {
      // The 4 aggregate queries (customers / vendors / employees /
      // invoices) all share the same COUNT(*) + SUM(CASE...) shape.
      // We dispatch by table name in the SQL.
      if (/FROM\s+FINANCE\.CUSTOMERS/i.test(s)) {
        const total = customers.size;
        let withHvhh = 0;
        for (const c of customers.values()) if (c.hvhh != null) withHvhh += 1;
        return { rows: [{ total, with_hvhh: withHvhh }] };
      }
      if (/FROM\s+FINANCE\.VENDORS/i.test(s)) {
        const total = vendors.size;
        let withHvhh = 0;
        for (const v of vendors.values()) if (v.hvhh != null) withHvhh += 1;
        return { rows: [{ total, with_hvhh: withHvhh }] };
      }
      if (/FROM\s+FINANCE\.HR_EMPLOYEES/i.test(s)) {
        // Only count active employees
        let total = 0;
        let withHvhh = 0;
        for (const e of employees.values()) {
          if (e.status !== 'active') continue;
          total += 1;
          if (e.hvhh != null) withHvhh += 1;
        }
        return { rows: [{ total, with_hvhh: withHvhh }] };
      }
      if (/FROM\s+FINANCE\.INVOICES/i.test(s)) {
        // Issued invoices: status IN sent/overdue/paid
        let issued = 0;
        let withHvhh = 0;
        let noDrift = 0;
        for (const inv of invoices.values()) {
          if (!['sent', 'overdue', 'paid'].includes(inv.status)) continue;
          issued += 1;
          const cust = customers.get(inv.customer_id);
          const invHvhh = inv.customer_hvhh ?? null;
          if (invHvhh != null) {
            withHvhh += 1;
            if (cust && cust.hvhh != null && invHvhh === cust.hvhh) noDrift += 1;
          }
        }
        return { rows: [{ issued, with_hvhh: withHvhh, no_drift: noDrift }] };
      }
    }
    if (kind === 'cust') {
      return {
        rows: [...customers.values()].map((c) => ({ ...c })),
      };
    }
    if (kind === 'cust-groupby') {
      // findDuplicateCustomers: returns customers with hvhh
      // that appear in a "hvhh IN (...)" subquery OR with
      // normalized name in a similar subquery. The production
      // query aliases the match column as `match_value`. Our
      // mock inspects the SQL and applies the same alias.
      const alias = matchValueAlias(sql);
      return {
        rows: [...customers.values()].map((c) => {
          if (alias === 'hvhh') {
            return { ...c, match_value: c.hvhh };
          }
          if (alias === 'name_norm') {
            return { ...c, match_value: String(c.name || '').toLowerCase().trim() };
          }
          return { ...c };
        }),
      };
    }
    if (kind === 'vend') {
      return {
        rows: [...vendors.values()].map((v) => ({ ...v })),
      };
    }
    if (kind === 'emp') {
      return {
        rows: [...employees.values()].map((e) => ({ ...e })),
      };
    }
    if (kind === 'inv') {
      // JOIN with customers. The production SQL filters
      // WHERE c.hvhh IS NOT NULL AND (i.customer_hvhh IS NULL
      // OR i.customer_hvhh != c.hvhh) and aliases i.id AS
      // invoice_id + i.issue_date AS invoice_issue_date +
      // i.customer_hvhh AS invoice_hvhh. We mimic both the
      // filter and the aliases here.
      const out = [];
      for (const inv of invoices.values()) {
        const cust = customers.get(inv.customer_id);
        if (!cust) continue;
        if (cust.hvhh == null) continue;
        const invHvhh = inv.customer_hvhh ?? null;
        if (invHvhh != null && invHvhh === cust.hvhh) continue;
        out.push({
          invoice_id: inv.id,
          invoice_number: inv.invoice_number,
          invoice_issue_date: inv.issue_date,
          invoice_hvhh: invHvhh,
          customer_id: cust.id,
          customer_code: cust.code,
          customer_name: cust.name,
          customer_hvhh: cust.hvhh,
        });
      }
      return { rows: out };
    }
    return { rows: [] };
  }

  return {
    _db: { customers, vendors, employees, invoices },
    query,
    // Helpers for tests
    seedCustomer: (row) => {
      const id = nextId(customers);
      customers.set(id, {
        id,
        code: row.code,
        name: row.name,
        hvhh: row.hvhh ?? null,
        email: row.email ?? null,
        address: row.address ?? null,
        created_at: row.created_at ?? '2026-01-01',
      });
      return id;
    },
    seedVendor: (row) => {
      const id = nextId(vendors);
      vendors.set(id, {
        id,
        code: row.code,
        name: row.name,
        hvhh: row.hvhh ?? null,
        created_at: '2026-01-01',
      });
      return id;
    },
    seedEmployee: (row) => {
      const id = nextId(employees);
      employees.set(id, {
        id,
        code: row.code,
        first_name: row.first_name,
        last_name: row.last_name,
        hvhh: row.hvhh ?? null,
        status: row.status ?? 'active',
        created_at: '2026-01-01',
      });
      return id;
    },
    seedInvoice: (row) => {
      const id = nextId(invoices);
      invoices.set(id, {
        id,
        invoice_number: row.invoice_number,
        customer_id: row.customer_id,
        issue_date: row.issue_date,
        due_date: row.due_date ?? row.issue_date,
        total_amd: row.total_amd ?? 0,
        customer_hvhh: row.customer_hvhh ?? null,
        status: row.status ?? 'sent',
        created_at: '2026-01-01',
      });
      return id;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────
// findDuplicateCustomers
// ────────────────────────────────────────────────────────────────────────

test('dataQuality: findDuplicateCustomers flags customers with same hvhh', async () => {
  const db = makeMockDb();
  db.seedCustomer({ code: 'CUST-A', name: 'Acme LLC', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-A2', name: 'Acme LLC (duplicate)', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-B', name: 'Beta Inc', hvhh: '11111111' });
  const dups = await findDuplicateCustomers(db, 0);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].match_type, 'hvhh');
  assert.equal(dups[0].match_value, '01234567');
  assert.equal(dups[0].customers.length, 2);
});

test('dataQuality: findDuplicateCustomers flags customers with same normalized name (different hvhh)', async () => {
  const db = makeMockDb();
  db.seedCustomer({ code: 'CUST-1', name: 'Acme LLC', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-2', name: 'ACME LLC', hvhh: '11111111' });
  db.seedCustomer({ code: 'CUST-3', name: '  acme llc  ', hvhh: '22222222' });
  const dups = await findDuplicateCustomers(db, 0);
  // All 3 share the normalized name 'acme llc'
  assert.equal(dups.length, 1);
  assert.equal(dups[0].match_type, 'name');
  assert.equal(dups[0].customers.length, 3);
});

test('dataQuality: findDuplicateCustomers returns empty when no duplicates', async () => {
  const db = makeMockDb();
  db.seedCustomer({ code: 'CUST-A', name: 'Acme LLC', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-B', name: 'Beta Inc', hvhh: '11111111' });
  const dups = await findDuplicateCustomers(db, 0);
  assert.equal(dups.length, 0);
});

test('dataQuality: findDuplicateCustomers prefers hvhh match over name match', async () => {
  const db = makeMockDb();
  // Two customers with same hvhh AND same normalized name;
  // should appear as ONE hvhh group (the name dup is
  // suppressed because the IDs are already flagged).
  db.seedCustomer({ code: 'CUST-A', name: 'Acme LLC', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-B', name: 'ACME LLC', hvhh: '01234567' });
  const dups = await findDuplicateCustomers(db, 0);
  assert.equal(dups.length, 1);
  assert.equal(dups[0].match_type, 'hvhh');
});

test('dataQuality: findDuplicateCustomers throws ValueError on bad tenantId', async () => {
  const db = makeMockDb();
  await assert.rejects(findDuplicateCustomers(db, -1), /tenantId must be a non-negative integer/);
});

// ────────────────────────────────────────────────────────────────────────
// findHvhhDrift
// ────────────────────────────────────────────────────────────────────────

test('dataQuality: findHvhhDrift flags invoices where customer_hvhh != customer.hvhh', async () => {
  const db = makeMockDb();
  const custId = db.seedCustomer({ code: 'CUST-A', name: 'Acme', hvhh: '99999999' });
  db.seedInvoice({
    invoice_number: 'INV-A',
    customer_id: custId,
    issue_date: '2026-01-15',
    customer_hvhh: '01234567',  // stale snapshot
    status: 'sent',
  });
  db.seedInvoice({
    invoice_number: 'INV-B',
    customer_id: custId,
    issue_date: '2026-02-15',
    customer_hvhh: '99999999',  // matches
    status: 'sent',
  });
  const drift = await findHvhhDrift(db, 0);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].invoice_number, 'INV-A');
  assert.equal(drift[0].invoice_hvhh, '01234567');
  assert.equal(drift[0].customer_hvhh, '99999999');
});

test('dataQuality: findHvhhDrift flags invoices where customer_hvhh is NULL but customer has hvhh', async () => {
  const db = makeMockDb();
  const custId = db.seedCustomer({ code: 'CUST-A', name: 'Acme', hvhh: '01234567' });
  db.seedInvoice({
    invoice_number: 'INV-NULL',
    customer_id: custId,
    issue_date: '2026-01-15',
    customer_hvhh: null,  // missing snapshot
    status: 'sent',
  });
  const drift = await findHvhhDrift(db, 0);
  assert.equal(drift.length, 1);
  assert.equal(drift[0].invoice_hvhh, null);
});

test('dataQuality: findHvhhDrift returns empty when no drift', async () => {
  const db = makeMockDb();
  const custId = db.seedCustomer({ code: 'CUST-A', name: 'Acme', hvhh: '01234567' });
  db.seedInvoice({
    invoice_number: 'INV-A',
    customer_id: custId,
    issue_date: '2026-01-15',
    customer_hvhh: '01234567',
    status: 'sent',
  });
  const drift = await findHvhhDrift(db, 0);
  assert.equal(drift.length, 0);
});

// ────────────────────────────────────────────────────────────────────────
// getDataQualitySummary
// ────────────────────────────────────────────────────────────────────────

test('dataQuality: getDataQualitySummary returns score=100 for empty DB', async () => {
  const db = makeMockDb();
  const summary = await getDataQualitySummary(db, 0);
  assert.equal(summary.score, 100);
  assert.equal(summary.customers.total, 0);
  assert.equal(summary.vendors.total, 0);
  assert.equal(summary.employees.total, 0);
  assert.equal(summary.invoices.total, 0);
  assert.equal(summary.issues.duplicate_customers, 0);
  assert.equal(summary.issues.hvhh_drift, 0);
  assert.equal(summary.issues.invoices_missing_hvhh, 0);
});

test('dataQuality: getDataQualitySummary scores customers + vendors + employees + invoices', async () => {
  const db = makeMockDb();
  // 2 customers, 1 with hvhh
  db.seedCustomer({ code: 'CUST-A', name: 'Acme', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-B', name: 'Beta', hvhh: null });
  // 2 vendors, both with hvhh
  db.seedVendor({ code: 'VEND-A', name: 'Vendor A', hvhh: '99999999' });
  db.seedVendor({ code: 'VEND-B', name: 'Vendor B', hvhh: '88888888' });
  // 2 employees, 1 active with hvhh
  db.seedEmployee({ code: 'EMP-A', first_name: 'A', last_name: 'A', hvhh: '77777777', status: 'active' });
  db.seedEmployee({ code: 'EMP-B', first_name: 'B', last_name: 'B', hvhh: null, status: 'inactive' });
  // 2 invoices (sent), both with hvhh matching the customer
  const custId = db.seedCustomer({ code: 'CUST-C', name: 'C', hvhh: '01234567' });
  db.seedInvoice({
    invoice_number: 'INV-A', customer_id: custId, issue_date: '2026-01-15',
    customer_hvhh: '01234567', status: 'sent',
  });
  db.seedInvoice({
    invoice_number: 'INV-B', customer_id: custId, issue_date: '2026-02-15',
    customer_hvhh: '01234567', status: 'sent',
  });
  const summary = await getDataQualitySummary(db, 0);
  // Customer score: 1/2 = 50 (only CUST-A has hvhh, but CUST-C also does;
  // wait, CUST-C was added later in the same fn so let me recount)
  // Total customers: CUST-A, CUST-B, CUST-C = 3; with_hvhh = 2 (A + C).
  // Customer score = 2/3 = 67.
  assert.equal(summary.customers.total, 3);
  assert.equal(summary.customers.with_hvhh, 2);
  assert.equal(summary.customers.score, 67);
  assert.equal(summary.vendors.total, 2);
  assert.equal(summary.vendors.with_hvhh, 2);
  assert.equal(summary.vendors.score, 100);
  // Only EMP-A is active (1 active) with hvhh = 100.
  assert.equal(summary.employees.total, 1);
  assert.equal(summary.employees.score, 100);
  // 2 invoices sent, both with hvhh matching customer = score 100.
  assert.equal(summary.invoices.total, 2);
  assert.equal(summary.invoices.no_drift, 2);
  assert.equal(summary.invoices.score, 100);
});

test('dataQuality: getDataQualitySummary detects issues (duplicates + drift + missing hvhh)', async () => {
  const db = makeMockDb();
  // Duplicate customer by hvhh
  db.seedCustomer({ code: 'CUST-A', name: 'Acme', hvhh: '01234567' });
  db.seedCustomer({ code: 'CUST-A2', name: 'Acme 2', hvhh: '01234567' });
  // Customer with hvhh drift
  const custId = db.seedCustomer({ code: 'CUST-B', name: 'Beta', hvhh: '99999999' });
  db.seedInvoice({
    invoice_number: 'INV-DRIFT', customer_id: custId, issue_date: '2026-01-15',
    customer_hvhh: '01234567', status: 'sent',
  });
  // Invoice missing hvhh
  const custId2 = db.seedCustomer({ code: 'CUST-C', name: 'Gamma', hvhh: '11111111' });
  db.seedInvoice({
    invoice_number: 'INV-NULL', customer_id: custId2, issue_date: '2026-02-15',
    customer_hvhh: null, status: 'sent',
  });
  const summary = await getDataQualitySummary(db, 0);
  assert.equal(summary.issues.duplicate_customers, 1);
  // Both INV-DRIFT (mismatch) and INV-NULL (missing snapshot)
  // are flagged as drift; the function counts BOTH as drift.
  assert.equal(summary.issues.hvhh_drift, 2);
  assert.equal(summary.issues.invoices_missing_hvhh, 1);
  assert.ok(summary.score < 100);
});

test('dataQuality: getDataQualitySummary throws ValueError on bad tenantId', async () => {
  const db = makeMockDb();
  await assert.rejects(getDataQualitySummary(db, -1), /tenantId must be a non-negative integer/);
});