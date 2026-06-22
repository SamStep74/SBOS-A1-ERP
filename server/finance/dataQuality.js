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

// assertPositiveInt is used by applyCustomerMerge (W99-1)
// for primary_id, secondary_id, applied_by_user_id
// validation. Other functions in this module use direct
// checks (the function bodies are short enough to inline).
function assertPositiveInt(value, name) {
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

// ────────────────────────────────────────────────────────────────────────
// Wave 2 (W94-1) — suggestMergeCandidates + getDataQualityAlerts.
// These are ADVISORY functions — they propose what to do, they do
// NOT mutate state. The operator must explicitly apply the merge
// (via a future applyMerge function) or fix the data quality issues
// (via direct DB updates + audit trail). This separation matters:
// auto-correction would skip the audit trail + the operator's
// judgment call on which record to keep.
// ────────────────────────────────────────────────────────────────────────

/**
 * For each duplicate group, propose a merge plan: pick the
 * PRIMARY record to keep + the SECONDARY record to merge into
 * the primary. The primary selection logic:
 *   - Prefer the record with a non-null hvhh (legal entity is
 *     the one with a TIN).
 *   - On tie, prefer the OLDEST record (lower id; the one
 *     that has been in the system longest — likely the
 *     authoritative one).
 *
 * For each merge plan, also count the number of invoices and
 * payments that would need to be re-assigned from the
 * secondary to the primary. The COUNT(*) queries are read-
 * only — no mutations are made by this function.
 *
 * Returns an array of merge plans. Each plan is:
 *   { group_id, match_type, match_value, primary: { id, code,
 *     name, hvhh, email, created_at }, secondary: { id, code,
 *     name, hvhh, email, created_at }, invoice_count, payment_count,
 *     reason }
 *
 * The group_id is a stable identifier (match_type + match_value
 * joined with ':') so the UI can render the same plan after
 * a page refresh.
 *
 * Empty array if no duplicates.
 *
 * @returns {Promise<Array<object>>}
 */
export async function suggestMergeCandidates(db, tenantId = 0) {
  assertTenantId(tenantId);
  const dups = await findDuplicateCustomers(db, tenantId);
  const plans = [];
  let planCounter = 0;
  for (const group of dups) {
    // Pick the primary: prefer hvhh; tie-break by lowest id.
    const sorted = [...group.customers].sort((a, b) => {
      // Both have hvhh: tie-break by id ASC
      if ((a.hvhh != null) === (b.hvhh != null)) {
        return a.id - b.id;
      }
      // Prefer the one with hvhh
      return a.hvhh != null ? -1 : 1;
    });
    const primary = sorted[0];
    const secondary = sorted[1];
    // Count invoices + payments that would be re-assigned.
    // We need a count per secondary, so the operator can see
    // "this merge would re-assign 12 invoices and 8 payments".
    const invCount = await runQuery(
      db,
      `SELECT COUNT(*) AS n FROM finance.invoices
        WHERE tenant_id = $1 AND customer_id = $2`,
      [tenantId, secondary.id],
    );
    // The payments table may not have a tenant_id column; for
    // safety, count via JOIN to invoices. If a payment exists
    // for an invoice of the secondary customer, it counts.
    const payCount = await runQuery(
      db,
      `SELECT COUNT(*) AS n
         FROM finance.payments p
         JOIN finance.invoices i ON i.id = p.invoice_id
        WHERE i.tenant_id = $1 AND i.customer_id = $2`,
      [tenantId, secondary.id],
    );
    plans.push({
      group_id: `${group.match_type}:${group.match_value}:${++planCounter}`,
      match_type: group.match_type,
      match_value: group.match_value,
      primary: {
        id: primary.id,
        code: primary.code ?? null,
        name: primary.name,
        hvhh: primary.hvhh ?? null,
        email: primary.email ?? null,
        created_at: primary.created_at,
      },
      secondary: {
        id: secondary.id,
        code: secondary.code ?? null,
        name: secondary.name,
        hvhh: secondary.hvhh ?? null,
        email: secondary.email ?? null,
        created_at: secondary.created_at,
      },
      invoice_count: Number(invCount.rows?.[0]?.n ?? 0),
      payment_count: Number(payCount.rows?.[0]?.n ?? 0),
      reason: group.match_type === 'hvhh'
        ? `Both customers share the same TIN (${group.match_value}); same legal entity.`
        : `Both customers have the same normalized name (${group.match_value}); possible duplicate.`,
    });
  }
  return plans;
}

/**
 * Generate data quality alerts for the tenant. An alert is a
 * specific issue that exceeds a threshold — the operator
 * should fix it before it becomes a bigger problem.
 *
 * Each alert has:
 *   - severity: 'critical' (score < 60) | 'warning' (60-79) |
 *     'info' (80-89) | null (>= 90, no alert)
 *   - code: a machine-readable identifier (e.g. 'duplicates',
 *     'hvhh_drift', 'invoices_missing_hvhh', 'score_below_threshold')
 *   - message: human-readable description
 *   - count: the number of records affected (or null for the
 *     overall score alert)
 *   - recommended_action: what to do
 *
 * Sorted by severity (critical first) then by count DESC.
 *
 * The threshold is a 0-100 number below which the overall
 * score is considered an alert. Default 80.
 *
 * @param {number} [threshold=80]
 * @returns {Promise<Array<{ severity, code, message, count,
 *   recommended_action }>>}
 */
export async function getDataQualityAlerts(db, tenantId = 0, threshold = 80) {
  assertTenantId(tenantId);
  if (!Number.isInteger(threshold) || threshold < 0 || threshold > 100) {
    throw new ValueError(`threshold must be 0-100 (got ${String(threshold)})`);
  }
  const summary = await getDataQualitySummary(db, tenantId);
  const alerts = [];

  // Overall score alert
  let overallSeverity = null;
  if (summary.score < 60) overallSeverity = 'critical';
  else if (summary.score < 80) overallSeverity = 'warning';
  else if (summary.score < 90) overallSeverity = 'info';
  if (overallSeverity !== null && summary.score < threshold) {
    alerts.push({
      severity: overallSeverity,
      code: 'score_below_threshold',
      message: `Data quality score is ${summary.score} (below threshold ${threshold})`,
      count: null,
      recommended_action: 'Run GET /api/finance/ai/duplicates and GET /api/finance/ai/hvhh-drift to identify the specific issues. Fix the highest-severity issues first.',
    });
  }

  // Duplicate customers alert
  if (summary.issues.duplicate_customers > 0) {
    const sev = summary.issues.duplicate_customers >= 5 ? 'warning' : 'info';
    alerts.push({
      severity: sev,
      code: 'duplicates',
      message: `${summary.issues.duplicate_customers} duplicate customer group(s) detected`,
      count: summary.issues.duplicate_customers,
      recommended_action: 'Use GET /api/finance/ai/duplicates to see the affected groups, then merge or delete the duplicates.',
    });
  }

  // HVHH drift alert
  if (summary.issues.hvhh_drift > 0) {
    alerts.push({
      severity: 'info',
      code: 'hvhh_drift',
      message: `${summary.issues.hvhh_drift} invoice(s) with HVVH drift`,
      count: summary.issues.hvhh_drift,
      recommended_action: 'Use GET /api/finance/ai/hvhh-drift to see the affected invoices. Re-issue the invoice with the updated TIN or accept the stale snapshot for historical accuracy.',
    });
  }

  // Invoices missing HVVH alert
  if (summary.issues.invoices_missing_hvhh > 0) {
    const sev = summary.issues.invoices_missing_hvhh >= 5 ? 'warning' : 'info';
    alerts.push({
      severity: sev,
      code: 'invoices_missing_hvhh',
      message: `${summary.issues.invoices_missing_hvhh} issued invoice(s) are missing customer HVVH`,
      count: summary.issues.invoices_missing_hvhh,
      recommended_action: 'Update the customer record to have a TIN, then re-issue the invoice. E-invoicing requires a TIN.',
    });
  }

  // Per-module alerts (a single module with score < 50 is critical)
  for (const mod of ['customers', 'vendors', 'employees', 'invoices']) {
    const m = summary[mod];
    if (m.total > 0 && m.score < 50) {
      alerts.push({
        severity: 'critical',
        code: `${mod}_low_score`,
        message: `${mod} module data quality score is ${m.score} (${m.with_hvhh}/${m.total} records have HVVH)`,
        count: m.total - m.with_hvhh,
        recommended_action: `Update ${mod} records with missing HVVH values.`,
      });
    }
  }

  // Sort: critical > warning > info; within severity, count DESC
  const sevRank = { critical: 0, warning: 1, info: 2 };
  alerts.sort((a, b) => {
    const sa = sevRank[a.severity] ?? 9;
    const sb = sevRank[b.severity] ?? 9;
    if (sa !== sb) return sa - sb;
    return (b.count ?? 0) - (a.count ?? 0);
  });

  return alerts;
}
// ────────────────────────────────────────────────────────────────────────
// applyCustomerMerge — W99-1 mutation counterpart to suggestMergeCandidates.
//
// The advisory (W94-1) says "merge these two customers". This
// function actually does it.
//
// The merge is a one-way soft delete + re-assign:
//   1. Verify both customers exist in the tenant (404 if either is missing).
//   2. Verify the two customers are different (400 if same id).
//   3. Verify the secondary is NOT already archived (400 if archived —
//      prevents double-merging the same customer into two primaries).
//   4. Re-assign all finance.invoices.customer_id from secondary to primary
//      (within the tenant scope).
//   5. Record the merge in finance.customer_merge_log (audit row with
//      the operator, reason, and counts).
//   6. Set finance.customers.archived = 1 on the secondary (soft delete).
//
// Returns:
//   { merge_log_id, primary_id, secondary_id,
//     invoices_reassigned, payments_reassigned }
//
// Errors:
//   ValueError with a clear message — the route layer maps to 400.
//   Missing customer maps to a ValueError too (the route layer maps
//   to 404, see the route definition).
//
// The function is tenant-scoped via the WHERE clauses; it cannot
// accidentally merge across tenants.
export async function applyCustomerMerge(db, input, tenantId = 0) {
  assertTenantId(tenantId);
  if (!input || typeof input !== 'object') {
    throw new ValueError('input is required');
  }
  const primaryId = Number(input.primary_id);
  const secondaryId = Number(input.secondary_id);
  assertPositiveInt(primaryId, 'primary_id');
  assertPositiveInt(secondaryId, 'secondary_id');
  if (primaryId === secondaryId) {
    throw new ValueError('primary_id and secondary_id must be different');
  }
  // Reason is optional but bounded — the audit log is human-readable.
  let reason = null;
  if (input.reason !== null && input.reason !== undefined) {
    if (typeof input.reason !== 'string') {
      throw new ValueError('reason must be a string or null');
    }
    if (input.reason.length > 1024) {
      throw new ValueError('reason must be at most 1024 characters');
    }
    reason = input.reason;
  }
  // applied_by_user_id is optional (the route layer will pass the
  // current user id; this function is also callable from tests
  // without a user).
  let appliedByUserId = null;
  if (input.applied_by_user_id !== null && input.applied_by_user_id !== undefined) {
    assertPositiveInt(input.applied_by_user_id, 'applied_by_user_id');
    appliedByUserId = input.applied_by_user_id;
  }

  // Look up both customers in the same query. The query is
  // tenant-scoped via the tenant_id column; cross-tenant
  // returns 0 rows which we map to 404.
  const custResult = await runQuery(
    db,
    `SELECT id, name, archived
       FROM finance.customers
      WHERE tenant_id = $1 AND id IN ($2, $3)`,
    [tenantId, primaryId, secondaryId],
  );
  const custRows = custResult.rows || [];
  if (custRows.length === 0) {
    throw new ValueError(
      `customers not found in tenant ${tenantId} (primary_id=${primaryId}, secondary_id=${secondaryId})`,
    );
  }
  const found = new Map();
  for (const row of custRows) found.set(Number(row.id), row);
  if (!found.has(primaryId)) {
    throw new ValueError(`primary customer ${primaryId} not found in tenant ${tenantId}`);
  }
  if (!found.has(secondaryId)) {
    throw new ValueError(`secondary customer ${secondaryId} not found in tenant ${tenantId}`);
  }
  const secondaryRow = found.get(secondaryId);
  if (Number(secondaryRow.archived) === 1) {
    throw new ValueError(
      `secondary customer ${secondaryId} is already archived; cannot merge again`,
    );
  }

  // Re-assign invoices from secondary to primary. We count
  // BEFORE + AFTER, then the delta is the re-assigned count.
  // This is adapter-agnostic (works for both pg and sqlite
  // because both return rowCount from UPDATE; we use SELECT
  // for the count to keep the logic uniform).
  const invCountBefore = await runQuery(
    db,
    `SELECT COUNT(*) AS n
       FROM finance.invoices
      WHERE tenant_id = $1 AND customer_id = $2`,
    [tenantId, primaryId],
  );
  const payCountBefore = await runQuery(
    db,
    `SELECT COUNT(*) AS n
       FROM finance.payments p
       JOIN finance.invoices i ON i.id = p.invoice_id
      WHERE i.tenant_id = $1 AND i.customer_id = $2`,
    [tenantId, primaryId],
  );
  const beforeInvoices = Number(invCountBefore.rows?.[0]?.n ?? 0);
  const beforePayments = Number(payCountBefore.rows?.[0]?.n ?? 0);

  // The actual re-assignment. UPDATE is scoped by both
  // tenant_id (always-on) and the secondary customer_id. A
  // secondary in another tenant is invisible to this UPDATE.
  await runQuery(
    db,
    `UPDATE finance.invoices
        SET customer_id = $1,
            updated_at = datetime('now')
      WHERE tenant_id = $2 AND customer_id = $3`,
    [primaryId, tenantId, secondaryId],
  );

  const invCountAfter = await runQuery(
    db,
    `SELECT COUNT(*) AS n
       FROM finance.invoices
      WHERE tenant_id = $1 AND customer_id = $2`,
    [tenantId, primaryId],
  );
  const payCountAfter = await runQuery(
    db,
    `SELECT COUNT(*) AS n
       FROM finance.payments p
       JOIN finance.invoices i ON i.id = p.invoice_id
      WHERE i.tenant_id = $1 AND i.customer_id = $2`,
    [tenantId, primaryId],
  );
  const afterInvoices = Number(invCountAfter.rows?.[0]?.n ?? 0);
  const afterPayments = Number(payCountAfter.rows?.[0]?.n ?? 0);
  const invoicesReassigned = afterInvoices - beforeInvoices;
  const paymentsReassigned = afterPayments - beforePayments;

  // Soft-delete the secondary. Updated_at is bumped so the
  // audit UI can show "this customer was archived at...".
  await runQuery(
    db,
    `UPDATE finance.customers
        SET archived = 1,
            updated_at = datetime('now')
      WHERE id = $1 AND tenant_id = $2`,
    [secondaryId, tenantId],
  );

  // Record the audit row. The audit is append-only — no
  // UPDATE on this table from any code path.
  const auditIns = await runQuery(
    db,
    `INSERT INTO finance.customer_merge_log
       (tenant_id, primary_customer_id, secondary_customer_id,
        invoices_reassigned_count, payments_reassigned_count,
        applied_by_user_id, reason)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id`,
    [
      tenantId,
      primaryId,
      secondaryId,
      invoicesReassigned,
      paymentsReassigned,
      appliedByUserId,
      reason,
    ],
  );
  let mergeLogId;
  if (auditIns.rows && auditIns.rows.length > 0 && auditIns.rows[0].id != null) {
    mergeLogId = Number(auditIns.rows[0].id);
  } else {
    // Fallback for adapters that don't support RETURNING.
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    mergeLogId = Number(lastId.rows[0].id);
  }

  return {
    merge_log_id: mergeLogId,
    primary_id: primaryId,
    secondary_id: secondaryId,
    invoices_reassigned: invoicesReassigned,
    payments_reassigned: paymentsReassigned,
  };
}

/**
 * List customer merge log rows for the tenant. Ordered by
 * created_at DESC (most recent first — the operator wants
 * to see the latest merges at the top). Optional filter
 * by primary_customer_id or secondary_customer_id.
 */
export async function listCustomerMergeLog(
  db,
  tenantId = 0,
  { primaryId = null, secondaryId = null, limit = 50 } = {},
) {
  assertTenantId(tenantId);
  if (!Number.isInteger(limit) || limit <= 0 || limit > 500) {
    throw new ValueError('limit must be a positive integer between 1 and 500');
  }
  let result;
  if (primaryId !== null && secondaryId !== null) {
    result = await runQuery(
      db,
      `SELECT id, primary_customer_id, secondary_customer_id,
              invoices_reassigned_count, payments_reassigned_count,
              applied_by_user_id, reason, created_at
         FROM finance.customer_merge_log
        WHERE tenant_id = $1
          AND primary_customer_id = $2
          AND secondary_customer_id = $3
        ORDER BY created_at DESC, id DESC
        LIMIT $4`,
      [tenantId, primaryId, secondaryId, limit],
    );
  } else if (primaryId !== null) {
    result = await runQuery(
      db,
      `SELECT id, primary_customer_id, secondary_customer_id,
              invoices_reassigned_count, payments_reassigned_count,
              applied_by_user_id, reason, created_at
         FROM finance.customer_merge_log
        WHERE tenant_id = $1
          AND primary_customer_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [tenantId, primaryId, limit],
    );
  } else if (secondaryId !== null) {
    result = await runQuery(
      db,
      `SELECT id, primary_customer_id, secondary_customer_id,
              invoices_reassigned_count, payments_reassigned_count,
              applied_by_user_id, reason, created_at
         FROM finance.customer_merge_log
        WHERE tenant_id = $1
          AND secondary_customer_id = $2
        ORDER BY created_at DESC, id DESC
        LIMIT $3`,
      [tenantId, secondaryId, limit],
    );
  } else {
    result = await runQuery(
      db,
      `SELECT id, primary_customer_id, secondary_customer_id,
              invoices_reassigned_count, payments_reassigned_count,
              applied_by_user_id, reason, created_at
         FROM finance.customer_merge_log
        WHERE tenant_id = $1
        ORDER BY created_at DESC, id DESC
        LIMIT $2`,
      [tenantId, limit],
    );
  }
  return result.rows || [];
}
