// SBOS-A1-ERP retention tenant-summary (Wave 75).
//
// Pairs with the W63 retention dashboard. The dashboard
// returns per-tenant rows; this module produces a
// rollup summary for the CFO's at-a-glance widget.
//
// The summary has three sections:
//   - totals: counts + sums across the whole dashboard
//   - withOverride: tenants that have an explicit config
//   - withDefault: tenants using the global default
//   - tenants: the full per-tenant list (sorted by
//              tenant_id ASC for stable display)
//
// The function reads from the same source as
// getRetentionDashboard but aggregates the per-tenant
// rows into a smaller, widget-friendly shape.

import { getRetentionDashboard } from './auditRetention.js';

/**
 * Build the retention-summary widget payload.
 *
 * @param {object} db
 * @returns {{
 *   generatedAt: string,
 *   totals: { tenants: number, withOverride: number, withDefault: number, totalAuditRows: number },
 *   tenants: Array<{ tenantId: number, hasExplicitConfig: boolean, retentionDays: number, auditRowCount: number }>
 * }}
 */
export function buildRetentionSummary(db) {
  if (!db || typeof db.prepare !== 'function') {
    throw new TypeError('buildRetentionSummary requires a db handle with prepare()');
  }
  const dashboard = getRetentionDashboard(db);
  // getRetentionDashboard returns { items: [...] } — the
  // dashboard's API shape. Normalise the per-tenant rows
  // into the widget shape (camelCase) and sort for
  // deterministic output.
  const rows = dashboard && Array.isArray(dashboard.items) ? dashboard.items : [];
  const tenants = rows
    .map((row) => ({
      tenantId: Number(row.tenant_id),
      hasExplicitConfig: Boolean(row.has_explicit_config),
      retentionDays: Number(row.retention_days),
      auditRowCount: Number(row.audit_row_count || 0),
    }))
    .sort((a, b) => a.tenantId - b.tenantId);
  const withOverride = tenants.filter((t) => t.hasExplicitConfig).length;
  const withDefault = tenants.length - withOverride;
  const totalAuditRows = tenants.reduce((acc, t) => acc + t.auditRowCount, 0);
  return {
    generatedAt: new Date().toISOString(),
    totals: {
      tenants: tenants.length,
      withOverride,
      withDefault,
      totalAuditRows,
    },
    tenants,
  };
}
