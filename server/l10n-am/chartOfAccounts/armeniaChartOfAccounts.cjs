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

const STANDARD_ACCOUNTS = require("./armeniaChartOfAccounts.data.cjs");

const ACCOUNT_CLASSES = Object.freeze([
  { digit: 1, hy: "Ոչ ընթացիկ ակտիվներ", en: "Non-current assets", type: "asset", normalBalance: "debit" },
  { digit: 2, hy: "Ընթացիկ ակտիվներ", en: "Current assets", type: "asset", normalBalance: "debit" },
  { digit: 3, hy: "Սեփական կապիտալ", en: "Equity", type: "equity", normalBalance: "credit" },
  { digit: 4, hy: "Ոչ ընթացիկ պարտավորություններ", en: "Non-current liabilities", type: "liability", normalBalance: "credit" },
  { digit: 5, hy: "Ընթացիկ պարտավորություններ", en: "Current liabilities", type: "liability", normalBalance: "credit" },
  { digit: 6, hy: "Եկամուտներ", en: "Income", type: "income", normalBalance: "credit" },
  { digit: 7, hy: "Ծախսեր", en: "Expenses", type: "expense", normalBalance: "debit" },
  { digit: 8, hy: "Կառավարչական հաշվառման հաշիվներ", en: "Management accounting", type: "management", normalBalance: "debit" },
  { digit: 9, hy: "Արտահաշվեկշռային հաշիվներ", en: "Off-balance-sheet", type: "offBalance", normalBalance: null },
]);

const _classByDigit = new Map(ACCOUNT_CLASSES.map((c) => [c.digit, c]));
const _byCode = new Map(STANDARD_ACCOUNTS.map((a) => [a.code, a]));

function accountClass(code) {
  const s = String(code == null ? "" : code).trim();
  if (!/^[0-9]/.test(s)) return null;
  return _classByDigit.get(Number(s[0])) || null;
}

function accountByCode(code) {
  return _byCode.get(String(code == null ? "" : code).trim()) || null;
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

module.exports = {
  ACCOUNT_CLASSES,
  STANDARD_ACCOUNTS,
  accountClass,
  accountByCode,
  accountsByType,
  accountsByClass,
  normalBalance,
};
