// SBOS-A1-ERP retention diff email body (Wave 74).
//
// W68 added diffRetentionSnapshots — a structured
// {added, removed, changed} payload over a [from, to]
// snapshot window. W74 makes that payload mailable:
//   1. buildRetentionDiffBody({from, to, diff}) —
//      render the diff as a plain-text body suitable
//      for the existing emailService.
//   2. The route layer (server/finance/routes.js)
//      exposes a POST /api/finance/audit/retention/
//      diff/email that takes { from, to, recipients }
//      and dispatches the email via emailService.send.
//
// The body is plain text by design (matches W65 digest).
// HTML formatting is a follow-up slice.

/**
 * Render a retention diff payload as a plain-text email
 * body. The output is human-readable and stable so an
 * operator can scan it in 5 seconds.
 *
 * Sections:
 *   - Header: time range + total counts
 *   - ADDED: list of new tenant IDs
 *   - REMOVED: list of dropped tenant IDs
 *   - CHANGED: list of tenant IDs with the field that
 *     changed (retention_days, has_explicit_config, etc.)
 *
 * Empty sections are still emitted as headers so the
 * reader sees "ADDED (0)" instead of guessing.
 *
 * @param {object} input
 * @param {string} input.from — ISO timestamp (inclusive baseline)
 * @param {string} input.to   — ISO timestamp (exclusive end)
 * @param {object} input.diff — {added: number[], removed: number[], changed: Array<{tenantId, fields: string[]}>}
 * @returns {string}
 */
export function buildRetentionDiffBody({ from, to, diff }) {
  if (!diff || typeof diff !== 'object') {
    throw new TypeError('buildRetentionDiffBody requires a diff object');
  }
  const added = Array.isArray(diff.added) ? diff.added : [];
  const removed = Array.isArray(diff.removed) ? diff.removed : [];
  const changed = Array.isArray(diff.changed) ? diff.changed : [];
  const lines = [];
  lines.push('SBOS Audit Retention — Change Report');
  lines.push('=====================================');
  lines.push('');
  lines.push(`Window: ${from}  →  ${to}`);
  lines.push('');
  lines.push(
    `Totals: ${added.length} added, ${removed.length} removed, ${changed.length} changed.`,
  );
  lines.push('');
  lines.push(`ADDED (${added.length})`);
  lines.push('-------');
  if (added.length === 0) {
    lines.push('  (none)');
  } else {
    for (const tid of added) {
      lines.push(`  + tenant ${tid}`);
    }
  }
  lines.push('');
  lines.push(`REMOVED (${removed.length})`);
  lines.push('---------');
  if (removed.length === 0) {
    lines.push('  (none)');
  } else {
    for (const tid of removed) {
      lines.push(`  - tenant ${tid}`);
    }
  }
  lines.push('');
  lines.push(`CHANGED (${changed.length})`);
  lines.push('---------');
  if (changed.length === 0) {
    lines.push('  (none)');
  } else {
    for (const c of changed) {
      const fields = Array.isArray(c.fields) ? c.fields.join(', ') : '';
      lines.push(`  ~ tenant ${c.tenantId}  (${fields})`);
    }
  }
  lines.push('');
  lines.push('--');
  lines.push('Sent by SBOS retention-diff worker. Edit /api/finance/audit/retention/diff/email to dispatch manually.');
  return lines.join('\n');
}

/**
 * Build the email subject line. Keeps it short so it
 * fits in a notification preview without truncation.
 *
 * Format: `[SBOS] retention: +3 -1 ~2 (Jun 22 → Jun 23)`
 */
export function buildRetentionDiffSubject({ from, to, diff }) {
  if (!diff || typeof diff !== 'object') {
    throw new TypeError('buildRetentionDiffSubject requires a diff object');
  }
  const added = Array.isArray(diff.added) ? diff.added.length : 0;
  const removed = Array.isArray(diff.removed) ? diff.removed.length : 0;
  const changed = Array.isArray(diff.changed) ? diff.changed.length : 0;
  // Trim the ISO timestamps to YYYY-MM-DD for the subject.
  const fromShort = String(from || '').slice(0, 10) || '?';
  const toShort = String(to || '').slice(0, 10) || '?';
  return `[SBOS] retention: +${added} -${removed} ~${changed} (${fromShort} → ${toShort})`;
}
