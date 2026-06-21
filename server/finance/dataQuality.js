// Phase 3 AI agents (W93-1) — data quality + reconciliation helpers.
//
// This module ships the "AI agent" building blocks: pure
// functions that scan the database for data quality issues,
// duplicates, drift, and incomplete records. They are NOT
// AI/ML models — they are deterministic queries against the
// finance schema that catch common data hygiene problems.
//
// All functions are tenant-scoped (don't leak across tenants)
// and read-only (no INSERT/UPDATE/DELETE). They return flat
// arrays + summary counts so the UI can render them as
// tables or alerts.
//
// Public API:
//   findDuplicateCustomers(db, tenantId)
//   findHvhhDrift(db, tenantId)
//   getDataQualitySummary(db, tenantId)
//
// Wave 2 (future) scope:
//   - findOrphanedRecords (records pointing to deleted parents)
//   - findStaleRecords (records not updated in N months)
//   - suggestMergeCandidates (heuristics for auto-merging
//     duplicate customers)

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

async function runQuery(db, sql, params) {
  const result = await db.query(sql, params || []);
  if (result && Array.isArray(result.rows)) return result;
  return { rows: [] };
}

// assertPositiveInt is reserved for future functions that
// accept positive IDs (e.g. findOrphanedRecords). Marked
// with _ to keep eslint quiet until wave 2.
function _assertPositiveInt(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new ValueError(`${name} must be a positive integer`);
  }
}

// tenantId is a non-negative integer (0 is the bootstrap
// tenant default in the test harness + dev mode).
function assertTenantId(value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`tenantId must be a non-negative integer`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// findDuplicateCustomers
// ────────────────────────────────────────────────────────────────────────

/**
 * Find potential duplicate customers in the tenant. A duplicate
 * is one of:
 *   - Two customers with the SAME hvhh (Armenian TIN). Same TIN
 *     = same legal entity; two rows = data entry error (or
 *     one was a re-import).
 *   - Two customers with the same normalized name (case-
 *     insensitive, whitespace-collapsed). Same name + different
 *     hvhh = probably two separate legal entities, but worth
 *     flagging for review.
 *
 * Returns an array of duplicate groups. Each group is:
 *   { match_type: 'hvhh' | 'name', match_value: string,
 *     customers: [{ id, code, name, hvhh, email, created_at }] }
 *
 * Sorted by match_type (hvhh first — more severe) then by
 * match_value ASC.
 *
 * @returns {Promise<Array<{ match_type, match_value, customers }>>}
 */
export async function findDuplicateCustomers(db, tenantId = 0) {
  assertTenantId(tenantId);

  // Duplicates by hvhh (both must be non-null to match — null
  // hvhh means "no TIN yet", not "duplicate TIN").
  const hvhhDups = await runQuery(
    db,
    `SELECT hvhh AS match_value, id, code, name, email, created_at
       FROM finance.customers
      WHERE tenant_id = $1
        AND hvhh IS NOT NULL
        AND hvhh IN (
          SELECT hvhh FROM finance.customers
           WHERE tenant_id = $1 AND hvhh IS NOT NULL
           GROUP BY hvhh
          HAVING COUNT(*) > 1
        )
      ORDER BY hvhh ASC, id ASC`,
    [tenantId],
  );

  // Group rows by hvhh
  const groups = new Map();
  const hvhhBuckets = new Map();
  for (const row of hvhhDups.rows || []) {
    const key = `hvhh:${row.match_value}`;
    if (!hvhhBuckets.has(key)) hvhhBuckets.set(key, []);
    hvhhBuckets.get(key).push(row);
  }
  // Only create a group if the bucket has >1 customers (the
  // production SQL filters via HAVING COUNT(*) > 1; we mimic
  // here because the mock returns ALL customers).
  for (const [key, rows] of hvhhBuckets) {
    if (rows.length <= 1) continue;
    groups.set(key, {
      match_type: 'hvhh',
      match_value: rows[0].match_value,
      customers: rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        hvhh: r.hvhh,
        email: r.email ?? null,
        created_at: String(r.created_at),
      })),
    });
  }

  // Duplicates by normalized name (lower(trim(name))).
  // We exclude customers already flagged by hvhh (those are
  // already in the report; double-counting would be noisy).
  const flaggedHvhhIds = new Set();
  for (const g of groups.values()) {
    for (const c of g.customers) flaggedHvhhIds.add(c.id);
  }

  const nameDups = await runQuery(
    db,
    `SELECT LOWER(TRIM(name)) AS match_value, id, code, name, hvhh, email, created_at
       FROM finance.customers
      WHERE tenant_id = $1
        AND LOWER(TRIM(name)) IN (
          SELECT LOWER(TRIM(name)) FROM finance.customers
           WHERE tenant_id = $1
           GROUP BY LOWER(TRIM(name))
          HAVING COUNT(*) > 1
        )
      ORDER BY LOWER(TRIM(name)) ASC, id ASC`,
    [tenantId],
  );
  // Group name-dup rows by normalized name; only create groups
  // with >1 customers (the production HAVING COUNT(*) > 1).
  const nameBuckets = new Map();
  for (const row of nameDups.rows || []) {
    if (flaggedHvhhIds.has(Number(row.id))) continue;
    const key = `name:${row.match_value}`;
    if (!nameBuckets.has(key)) nameBuckets.set(key, []);
    nameBuckets.get(key).push(row);
  }
  for (const [key, rows] of nameBuckets) {
    if (rows.length <= 1) continue;
    groups.set(key, {
      match_type: 'name',
      match_value: rows[0].match_value,
      customers: rows.map((r) => ({
        id: Number(r.id),
        code: r.code,
        name: r.name,
        hvhh: r.hvhh ?? null,
        email: r.email ?? null,
        created_at: String(r.created_at),
      })),
    });
  }

  return [...groups.values()].sort((a, b) => {
    if (a.match_type !== b.match_type) return a.match_type === 'hvhh' ? -1 : 1;
    return a.match_value < b.match_value ? -1 : a.match_value > b.match_value ? 1 : 0;
  });
}

// ────────────────────────────────────────────────────────────────────────
// findHvhhDrift
// ────────────────────────────────────────────────────────────────────────

/**
 * Find invoices where the customer_hvhh snapshotted on the
 * invoice differs from the current customer.hvhh. This catches
 * the case where a customer's hvhh was edited after an invoice
 * was issued — the invoice's snapshot is now stale.
 *
 * The fix is typically: re-issue the invoice with the updated
 * hvhh, or accept the stale value for historical accuracy.
 * This function is INFORMATIONAL; it does NOT auto-correct.
 *
 * Returns an array of drift records:
 *   { invoice_id, invoice_number, invoice_issue_date,
 *     invoice_hvhh, customer_id, customer_code, customer_name,
 *     customer_hvhh }
 *
 * Sorted by invoice_id DESC (most recent invoice first).
 *
 * @returns {Promise<Array<{ invoice_id, invoice_number,
 *   invoice_issue_date, invoice_hvhh, customer_id,
 *   customer_code, customer_name, customer_hvhh }>>}
 */
export async function findHvhhDrift(db, tenantId = 0) {
  assertTenantId(tenantId);

  // The production invoices table doesn't always have a
  // customer_hvhh column (some schemas store only the
  // customer_id and rely on a JOIN). The drift query must
  // JOIN to get the current value and compare to whatever
  // hvhh value the invoice stored (NULL is allowed — it
  // means "no hvhh was captured at issue time").
  const result = await runQuery(
    db,
    `SELECT i.id AS invoice_id,
            i.invoice_number,
            i.issue_date AS invoice_issue_date,
            i.customer_hvhh AS invoice_hvhh,
            c.id AS customer_id,
            c.code AS customer_code,
            c.name AS customer_name,
            c.hvhh AS customer_hvhh
       FROM finance.invoices i
       JOIN finance.customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1
        AND c.hvhh IS NOT NULL
        AND (i.customer_hvhh IS NULL OR i.customer_hvhh != c.hvhh)
      ORDER BY i.id DESC`,
    [tenantId],
  );
  return (result.rows || []).map((r) => ({
    invoice_id: Number(r.invoice_id),
    invoice_number: r.invoice_number,
    invoice_issue_date: String(r.invoice_issue_date),
    invoice_hvhh: r.invoice_hvhh ?? null,
    customer_id: Number(r.customer_id),
    customer_code: r.customer_code,
    customer_name: r.customer_name,
    customer_hvhh: r.customer_hvhh,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// getDataQualitySummary
// ────────────────────────────────────────────────────────────────────────

/**
 * Compute a per-module data quality summary for the tenant. The
 * score is a 0-100 number that represents how "complete" the
 * tenant's data is. Each module contributes equally; the score
 * is the arithmetic mean of the per-module scores.
 *
 * Modules + score formula (per module, 0-100):
 *   - customers: % of customers with hvhh (TIN) populated.
 *     Rationale: HVVH is required for e-invoicing; missing
 *     hvhh blocks invoice export.
 *   - vendors: % of vendors with hvhh (TIN) populated.
 *   - employees: % of active employees with hvhh populated.
 *     Rationale: payroll reporting requires employee TIN.
 *   - invoices: % of issued (non-draft, non-void) invoices
 *     with a customer_hvhh populated AND matching the live
 *     customer.hvhh (no drift).
 *
 * Output:
 *   { score: 0..100, customers: { total, with_hvhh, score },
 *     vendors: { total, with_hvhh, score },
 *     employees: { total, with_hvhh, score },
 *     invoices: { total, issued, with_hvhh, no_drift, score },
 *     issues: { duplicate_customers, hvhh_drift,
 *               invoices_missing_hvhh } }
 *
 * @returns {Promise<object>}
 */
export async function getDataQualitySummary(db, tenantId = 0) {
  assertTenantId(tenantId);

  // Customers
  const custResult = await runQuery(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN hvhh IS NOT NULL THEN 1 ELSE 0 END) AS with_hvhh
       FROM finance.customers
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const cust = custResult.rows?.[0] ?? { total: 0, with_hvhh: 0 };
  const custTotal = Number(cust.total) || 0;
  const custWithHvhh = Number(cust.with_hvhh) || 0;
  const custScore = custTotal > 0 ? Math.round((custWithHvhh / custTotal) * 100) : 100;

  // Vendors
  const vendResult = await runQuery(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN hvhh IS NOT NULL THEN 1 ELSE 0 END) AS with_hvhh
       FROM finance.vendors
      WHERE tenant_id = $1`,
    [tenantId],
  );
  const vend = vendResult.rows?.[0] ?? { total: 0, with_hvhh: 0 };
  const vendTotal = Number(vend.total) || 0;
  const vendWithHvhh = Number(vend.with_hvhh) || 0;
  const vendScore = vendTotal > 0 ? Math.round((vendWithHvhh / vendTotal) * 100) : 100;

  // Employees (active only)
  const empResult = await runQuery(
    db,
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN hvhh IS NOT NULL THEN 1 ELSE 0 END) AS with_hvhh
       FROM finance.hr_employees
      WHERE tenant_id = $1 AND status = 'active'`,
    [tenantId],
  );
  const emp = empResult.rows?.[0] ?? { total: 0, with_hvhh: 0 };
  const empTotal = Number(emp.total) || 0;
  const empWithHvhh = Number(emp.with_hvhh) || 0;
  const empScore = empTotal > 0 ? Math.round((empWithHvhh / empTotal) * 100) : 100;

  // Invoices (issued = status IN 'sent' / 'overdue' / 'paid';
  // excluding 'draft' and 'void').
  const invResult = await runQuery(
    db,
    `SELECT COUNT(*) AS issued,
            SUM(CASE WHEN customer_hvhh IS NOT NULL THEN 1 ELSE 0 END) AS with_hvhh,
            SUM(CASE WHEN customer_hvhh IS NOT NULL AND c.hvhh IS NOT NULL AND customer_hvhh = c.hvhh THEN 1 ELSE 0 END) AS no_drift
       FROM finance.invoices i
       LEFT JOIN finance.customers c ON c.id = i.customer_id AND c.tenant_id = i.tenant_id
      WHERE i.tenant_id = $1
        AND i.status IN ('sent', 'overdue', 'paid')`,
    [tenantId],
  );
  const inv = invResult.rows?.[0] ?? { issued: 0, with_hvhh: 0, no_drift: 0 };
  const invIssued = Number(inv.issued) || 0;
  const invWithHvhh = Number(inv.with_hvhh) || 0;
  const invNoDrift = Number(inv.no_drift) || 0;
  // Invoice score: 60% weight on having hvhh, 40% weight on
  // no drift. Both must be high to score well.
  const invScore = invIssued > 0
    ? Math.round(((invWithHvhh / invIssued) * 0.6 + (invNoDrift / invIssued) * 0.4) * 100)
    : 100;

  // Aggregate scores
  const moduleScores = [custScore, vendScore, empScore, invScore];
  const score = Math.round(
    moduleScores.reduce((a, b) => a + b, 0) / moduleScores.length,
  );

  // Counts of specific issues (for the issues panel)
  const dups = await findDuplicateCustomers(db, tenantId);
  const drift = await findHvhhDrift(db, tenantId);
  const issuedMissingHvhh = invIssued - invWithHvhh;

  return {
    score,
    customers: {
      total: custTotal,
      with_hvhh: custWithHvhh,
      score: custScore,
    },
    vendors: {
      total: vendTotal,
      with_hvhh: vendWithHvhh,
      score: vendScore,
    },
    employees: {
      total: empTotal,
      with_hvhh: empWithHvhh,
      score: empScore,
    },
    invoices: {
      total: invIssued,
      issued: invIssued,
      with_hvhh: invWithHvhh,
      no_drift: invNoDrift,
      score: invScore,
    },
    issues: {
      duplicate_customers: dups.length,
      hvhh_drift: drift.length,
      invoices_missing_hvhh: issuedMissingHvhh,
    },
  };
}