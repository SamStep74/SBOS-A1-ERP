// Republic of Armenia chart of accounts — RA localization kernel (full official chart).
//
// The RA standard chart numbers accounts so the LEADING DIGIT encodes the account
// class, which implies its accounting type and normal balance:
//   1 non-current assets · 2 current assets · 3 equity · 4 non-current liabilities
//   5 current liabilities · 6 income · 7 expenses · 8 management accounting
//   9 off-balance-sheet
//
// STANDARD_ACCOUNTS is the FULL official chart (623 accounts, 3-digit synthetic +
// 4-digit sub-accounts), generated from the RA Ministry of Finance order
// (arlis.am/hy/acts/75961) as published in the Հաշվային պլան (accountant.am).
// See server/armeniaChartOfAccounts.data.js (auto-generated; do not hand-edit).
//
// Pure data + lookups, no I/O.

import STANDARD_ACCOUNTS from './armeniaChartOfAccounts.data.js';

const ACCOUNT_CLASSES = Object.freeze([
  {
    digit: 1,
    hy: 'Ոչ ընթացիկ ակտիվներ',
    en: 'Non-current assets',
    type: 'asset',
    normalBalance: 'debit',
  },
  { digit: 2, hy: 'Ընթացիկ ակտիվներ', en: 'Current assets', type: 'asset', normalBalance: 'debit' },
  { digit: 3, hy: 'Սեփական կապիտալ', en: 'Equity', type: 'equity', normalBalance: 'credit' },
  {
    digit: 4,
    hy: 'Ոչ ընթացիկ պարտավորություններ',
    en: 'Non-current liabilities',
    type: 'liability',
    normalBalance: 'credit',
  },
  {
    digit: 5,
    hy: 'Ընթացիկ պարտավորություններ',
    en: 'Current liabilities',
    type: 'liability',
    normalBalance: 'credit',
  },
  { digit: 6, hy: 'Եկամուտներ', en: 'Income', type: 'income', normalBalance: 'credit' },
  { digit: 7, hy: 'Ծախսեր', en: 'Expenses', type: 'expense', normalBalance: 'debit' },
  {
    digit: 8,
    hy: 'Կառավարչական հաշվառման հաշիվներ',
    en: 'Management accounting',
    type: 'management',
    normalBalance: 'debit',
  },
  {
    digit: 9,
    hy: 'Արտահաշվեկշռային հաշիվներ',
    en: 'Off-balance-sheet',
    type: 'offBalance',
    normalBalance: null,
  },
]);

const _classByDigit = new Map(ACCOUNT_CLASSES.map((c) => [c.digit, c]));
const _byCode = new Map(STANDARD_ACCOUNTS.map((a) => [a.code, a]));

function accountClass(code) {
  const s = String(code == null ? '' : code).trim();
  if (!/^[0-9]/.test(s)) return null;
  return _classByDigit.get(Number(s[0])) || null;
}

function accountByCode(code) {
  return _byCode.get(String(code == null ? '' : code).trim()) || null;
}

function accountsByType(type) {
  return STANDARD_ACCOUNTS.filter((a) => a.type === type);
}

function accountsByClass(digit) {
  const d = Number(digit);
  return STANDARD_ACCOUNTS.filter((a) => Number(a.code[0]) === d);
}

function normalBalance(code) {
  const cls = accountClass(code);
  return cls ? cls.normalBalance : null;
}

// Paged query over the full chart. A UI must not render all 623 accounts at once
// — this returns one slice plus a complete meta envelope so a Fastify route or a
// React/Solid query layer can drive a virtualized list / paginator without ever
// materializing the whole table on the client.
//
// All inputs are clamped (no throw on bad input). `type` and `class` filter
// compose with AND semantics. The slice is taken from a *new* filtered array —
// STANDARD_ACCOUNTS is never mutated and remains a frozen reference for the
// other lookup helpers.
const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 500;

function pagedAccounts({ page, pageSize, type, class: classDigit } = {}) {
  const rawPage = Number(page);
  const safePage = Number.isInteger(rawPage) && rawPage >= 1 ? rawPage : 1;
  const rawSize = Number(pageSize);
  const safeSize =
    Number.isInteger(rawSize) && rawSize >= 1
      ? Math.min(rawSize, PAGE_SIZE_MAX)
      : PAGE_SIZE_DEFAULT;

  const filtered = STANDARD_ACCOUNTS.filter((a) => {
    if (type != null && a.type !== type) return false;
    if (classDigit != null && !a.code.startsWith(String(classDigit))) return false;
    return true;
  });

  const start = (safePage - 1) * safeSize;
  const data = filtered.slice(start, start + safeSize);

  return Object.freeze({
    data: Object.freeze(data),
    meta: Object.freeze({
      total: filtered.length,
      page: safePage,
      limit: safeSize,
    }),
  });
}

export {
  ACCOUNT_CLASSES,
  STANDARD_ACCOUNTS,
  accountClass,
  accountByCode,
  accountsByType,
  accountsByClass,
  normalBalance,
  pagedAccounts,
  PAGE_SIZE_DEFAULT,
  PAGE_SIZE_MAX,
};
