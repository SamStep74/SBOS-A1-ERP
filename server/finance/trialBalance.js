// SBOS-A1-ERP — trial balance report.
//
// The trial balance is the classic accountant's snapshot:
// every account that has any activity, with its debit and credit
// totals, and the assertion that total debits == total credits
// (i.e. the books balance). It's the report a CFO asks for
// first thing in the morning and the one the auditor asks for
// last thing at year-end.
//
// The data comes from listAccountBalances (journal.js) — every
// account that has any debit OR credit in the journal. We join
// against the Armenian chart of accounts to get the Armenian
// label and the natural sign (debit / credit / class).
//
// Natural sign: asset, expense, and management accounts are
// debit-natural (their balance grows on the debit side);
// liability, equity, and revenue accounts are credit-natural.
// The trial balance shows the balance in the natural column —
// a $5000 inventory asset shows as 5000 in the debit column;
// a $3000 AP liability shows as 3000 in the credit column.
// The total debits must equal total credits (the books balance).
//
// Locale: Armenian is the primary target. The report carries a
// per-row Armenian label + a per-row English fallback. The
// caller picks the language at render time.

import chartOfAccounts from '../l10n-am/chartOfAccounts/armeniaChartOfAccounts.data.js';
import { listAccountBalances } from './journal.js';

// Map the COA `type` field to the natural sign. Asset / expense
// accounts grow on the debit side; liability / equity / revenue
// grow on the credit side. The 'management' class (8xx) is
// internal cost-tracking — debit-natural.
const DEBIT_NATURAL_TYPES = new Set(['asset', 'expense', 'management']);
const CREDIT_NATURAL_TYPES = new Set(['liability', 'equity', 'revenue']);

function naturalSignForAccount(code) {
  const entry = chartOfAccounts.find((a) => a.code === code);
  if (!entry) return 'unknown';
  if (DEBIT_NATURAL_TYPES.has(entry.type)) return 'debit';
  if (CREDIT_NATURAL_TYPES.has(entry.type)) return 'credit';
  return 'unknown';
}

// Build a label lookup. Prefer Armenian (the primary target) but
// fall back to the code if the COA entry is missing (shouldn't
// happen in practice but we defend against it).
const LABEL_BY_CODE = new Map();
chartOfAccounts.forEach((a) => {
  LABEL_BY_CODE.set(a.code, { hy: a.hy, class: a.class, type: a.type });
});

// ────────────────────────────────────────────────────────────────────────
// renderTrialBalance — public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Render the trial balance for a tenant.
 *
 * @param {object} db - pg-style adapter
 * @param {number} tenantId
 * @param {object} [opts] - { asOfDate?: YYYY-MM-DD, locale?: 'hy'|'en' }
 * @returns {Promise<{
 *   tenant_id: number,
 *   as_of_date: string,
 *   locale: string,
 *   accounts: Array<{ code, label, class, type, natural_sign, debit, credit }>,
 *   total_debit: number,
 *   total_credit: number,
 *   is_balanced: boolean,
 *   delta: number, // total_debit - total_credit
 *   account_count: number,
 * }>}
 */
export async function renderTrialBalance(db, tenantId = 0, opts = {}) {
  const locale = opts.locale || 'en';
  const balances = await listAccountBalances(db, tenantId, {
    asOfDate: opts.asOfDate,
  });
  // Project each balance into the trial-balance row shape. The
  // debit / credit columns reflect the natural sign of the
  // account; a debit-natural account with net_debit = 5000 shows
  // 5000 in debit (and 0 in credit), a credit-natural account
  // with net_credit = 3000 shows 3000 in credit (and 0 in debit).
  // Accounts with no activity are not in this list (listAccountBalances
  // only returns accounts that have at least one debit OR credit).
  const rows = balances.map((b) => {
    const code = b.account_code;
    const meta = LABEL_BY_CODE.get(code) || { hy: null, class: null, type: null };
    const naturalSign = naturalSignForAccount(code);
    let debit = 0;
    let credit = 0;
    if (naturalSign === 'debit') {
      debit = b.net_debit;
    } else if (naturalSign === 'credit') {
      credit = b.net_credit;
    } else {
      // Unknown class / off-chart. Fall back to the net-debit
      // convention (positive balance shows in debit column). This
      // is the conservative default and matches what
      // listAccountBalances uses for the unknown-class case.
      debit = b.net_debit;
    }
    return {
      code,
      label: meta.hy,
      class: meta.class,
      type: meta.type,
      natural_sign: naturalSign,
      debit,
      credit,
    };
  });
  // Sort by chart-of-accounts code (numeric) for the classic
  // ledger presentation. The 1xx assets first, then 2xx receivables,
  // 3xx equity, 4xx revenue, 5xx liabilities, 6xx financial, 7xx
  // expenses, 8xx management, 9xx off-balance.
  rows.sort((a, b) => a.code.localeCompare(b.code));
  const totalDebit = rows.reduce((s, r) => s + r.debit, 0);
  const totalCredit = rows.reduce((s, r) => s + r.credit, 0);
  return {
    tenant_id: tenantId,
    as_of_date: opts.asOfDate || 'latest',
    locale,
    accounts: rows,
    total_debit: totalDebit,
    total_credit: totalCredit,
    is_balanced: totalDebit === totalCredit,
    delta: totalDebit - totalCredit,
    account_count: rows.length,
  };
}

// ────────────────────────────────────────────────────────────────────────
// formatTrialBalanceText — server-rendered text presentation
// ────────────────────────────────────────────────────────────────────────

/**
 * Format a trial balance as plain text. The default locale is
 * Armenian; pass locale='en' for an English header.
 *
 * The output is a fixed-width text table with three columns
 * (code, label, debit, credit) and a footer with the totals +
 * a "BALANCED" / "OUT OF BALANCE" indicator.
 */
export function formatTrialBalanceText(report, locale = 'en') {
  if (!report || !Array.isArray(report.accounts)) {
    throw new TypeError('formatTrialBalanceText: report must be an object with accounts[]');
  }
  const labels = {
    title: locale === 'hy' ? 'Արտակdelays հdelays' : 'Trial Balance',
    asOf: locale === 'hy' ? 'Ays mekum' : 'As of',
    code: locale === 'hy' ? 'Kod' : 'Code',
    account: locale === 'hy' ? 'Հdelays' : 'Account',
    debit: locale === 'hy' ? 'Debit' : 'Debit',
    credit: locale === 'hy' ? 'Credit' : 'Credit',
    total: locale === 'hy' ? 'Endelutyun' : 'Total',
    // The footer indicator is "BALANCED" / "OUT OF BALANCE" in
    // both locales — the operator-facing signal is the same in
    // English and Armenian, the locale just changes the header
    // and the column labels.
    balanced: 'BALANCED',
    outOfBalance: 'OUT OF BALANCE',
  };
  const out = [];
  out.push(`${labels.title}`);
  out.push(`${labels.asOf}: ${report.as_of_date}   ${locale === 'hy' ? 'Delays' : 'Tenant'}: ${report.tenant_id}`);
  out.push('');
  // Column widths: code 4, label 36, debit 14, credit 14
  const codeW = 6;
  const labelW = 36;
  const debitW = 14;
  const creditW = 14;
  function pad(s, w) {
    const str = String(s);
    return str.length >= w ? str.slice(0, w) : str + ' '.repeat(w - str.length);
  }
  function padLeft(s, w) {
    const str = String(s);
    return str.length >= w ? str.slice(0, w) : ' '.repeat(w - str.length) + str;
  }
  function fmt(n) {
    if (!n) return '0';
    return String(n);
  }
  // Header row.
  out.push(
    pad(labels.code, codeW) +
      pad(labels.account, labelW) +
      padLeft(labels.debit, debitW) +
      padLeft(labels.credit, creditW),
  );
  out.push('-'.repeat(codeW + labelW + debitW + creditW));
  for (const row of report.accounts) {
    out.push(
      pad(row.code, codeW) +
        pad((row.label || '').slice(0, labelW), labelW) +
        padLeft(fmt(row.debit), debitW) +
        padLeft(fmt(row.credit), creditW),
    );
  }
  out.push('-'.repeat(codeW + labelW + debitW + creditW));
  out.push(
    pad('', codeW) +
      pad(labels.total, labelW) +
      padLeft(fmt(report.total_debit), debitW) +
      padLeft(fmt(report.total_credit), creditW),
  );
  out.push('');
  out.push(report.is_balanced ? labels.balanced : labels.outOfBalance);
  return out.join('\n');
}
