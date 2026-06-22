import { auditAll } from '../server/l10n-am/audit.js';

const RBAC_DRIFT_TYPES = new Set(['orphan-permission-key', 'unknown-permission-usage']);

const report = auditAll({ root: process.cwd() });
const blockingIssues = report.issues.filter((issue) => !RBAC_DRIFT_TYPES.has(issue.type));

if (blockingIssues.length > 0) {
  console.error('l10n-am audit failed with non-RBAC issues:');
  console.error(JSON.stringify(blockingIssues, null, 2));
  process.exit(1);
}

console.log(`l10n-am audit: ok (${report.issues.length} known RBAC drift issue(s) tolerated)`);
