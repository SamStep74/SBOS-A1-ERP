// Armenian (RA) localization kernel.
//
// Reusable, dependency-free primitives that every A1 module attaches to:
//   - ՀՎՀՀ (HVHH): the Armenian taxpayer identification number, which also serves
//     as the business VAT id. Required on organizations, customers, and vendors.
//   - AMD: Armenian dram money formatting/rounding (dram has no minor unit in practice).
//
// Pure functions, offline, no I/O — safe to require from anywhere (server, scripts, tests).
// This is the localization "kernel" the operational modules (catalog, inventory,
// purchase, POS) depend on per the suite's Localization Checklist.

import { t } from './i18n.js';

const AMD = Object.freeze({ code: 'AMD', symbol: '֏', subunit: 0 });

// ՀՎՀՀ is exactly 8 numeric digits: 7 serial + 1 check digit. The official
// check-digit algorithm is not publicly published, so we validate the verifiable
// invariants (length, numeric, non-degenerate). `checkDigitVerifier` is a documented
// seam: pass one in once the official algorithm is sourced to tighten validation.
const HVHH_LENGTH = 8;
// Default locale for HVHH error messages. Armenian is the native locale for
// this id and matches the strings the rest of the suite was written against;
// callers can override per-request via the `locale` option.
const HVHH_DEFAULT_LOCALE = 'hy';
// Default locale for AMD error messages. parseAmd's hardcoded strings were
// English, so the default stays 'en' to keep existing call sites green.
const AMD_DEFAULT_LOCALE = 'en';

function normalizeHvhh(value) {
  if (value === null || value === undefined) return '';
  // Strip separators users commonly type (spaces, dots, hyphens).
  return String(value).replace(/[\s.\-]/g, '');
}

function validateHvhh(value, { checkDigitVerifier, locale = HVHH_DEFAULT_LOCALE } = {}) {
  const normalized = normalizeHvhh(value);
  if (!normalized) return { ok: false, normalized: '', error: t(locale, 'hvhh.required') };
  if (!/^[0-9]+$/.test(normalized)) {
    return { ok: false, normalized, error: t(locale, 'hvhh.notNumeric') };
  }
  if (normalized.length !== HVHH_LENGTH) {
    return {
      ok: false,
      normalized,
      error: t(locale, 'hvhh.length', { length: String(HVHH_LENGTH) }),
    };
  }
  if (/^(\d)\1{7}$/.test(normalized)) {
    return { ok: false, normalized, error: t(locale, 'hvhh.degenerate') };
  }
  if (typeof checkDigitVerifier === 'function' && !checkDigitVerifier(normalized)) {
    return { ok: false, normalized, error: t(locale, 'hvhh.checkDigit') };
  }
  return { ok: true, normalized, error: null };
}

function isValidHvhh(value, options) {
  return validateHvhh(value, options).ok;
}

// Strict, locale-tolerant boundary parser for ՀՎՀՀ input. Unlike normalizeHvhh
// (which silently returns '' for bad input) and isValidHvhh (boolean only), this
// returns { ok, hvhh, error }: it strips separators, normalizes to 8 digits, and
// fails LOUD on missing, non-numeric, wrong-length, or degenerate input. On
// success, `error` is omitted (so { ok: true, hvhh } deep-equals cleanly); on
// failure, the normalized form is still exposed so callers can log or echo it
// back to the user. Accepts the same options as validateHvhh — `checkDigitVerifier`
// and `locale` (defaults to 'hy'). Use at system boundaries (API bodies, form
// fields, CSV imports) before trusting an id; keep normalizeHvhh for
// already-validated internal numbers.
function parseHvhh(value, options) {
  const result = validateHvhh(value, options);
  if (result.ok) return { ok: true, hvhh: result.normalized };
  return { ok: false, hvhh: result.normalized, error: result.error };
}

// AMD money. Amounts are whole drams; round before storing/displaying.
function roundAmd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function formatAmd(amount, { symbol = true } = {}) {
  const drams = roundAmd(amount);
  const sign = drams < 0 ? '-' : '';
  const grouped = sign + groupThousands(String(Math.abs(drams)));
  return symbol ? `${grouped} ${AMD.symbol}` : grouped;
}

// Strict, locale-tolerant boundary parser for AMD input. Unlike roundAmd (which
// returns 0 for anything un-parseable — silently corrupting "1,000" → 0), this
// returns { ok, amount, error }: it accepts grouped/spaced strings and round-trips
// formatAmd output, but fails LOUD on missing or non-numeric input. Accepts an
// optional `locale` option (default 'en') so callers can route errors through
// the i18n kernel. The {{raw}} interpolation is intentional: it echoes the
// user's exact input back so a CSV import bug surfaces "you sent `abc`" rather
// than a generic "not a number". Use it at system boundaries (API bodies, form
// fields, imports) before trusting an amount; keep roundAmd for internal
// already-validated numbers.
function parseAmd(value, { locale = AMD_DEFAULT_LOCALE } = {}) {
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return { ok: false, amount: 0, error: t(locale, 'amd.notFinite') };
    return { ok: true, amount: roundAmd(value) };
  }
  if (value == null) return { ok: false, amount: 0, error: t(locale, 'amd.required') };
  const raw = String(value).trim();
  if (raw === '') return { ok: false, amount: 0, error: t(locale, 'amd.required') };
  // Drop grouping separators (spaces, commas) and the AMD symbol/code so a formatted
  // value round-trips; keep an optional leading sign, digits, and one decimal point.
  const cleaned = raw.split(AMD.symbol).join('').replace(/AMD/gi, '').replace(/[\s,]/g, '');
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, amount: 0, error: t(locale, 'amd.notNumber', { raw }) };
  }
  return { ok: true, amount: roundAmd(Number(cleaned)) };
}

export {
  AMD,
  HVHH_LENGTH,
  HVHH_DEFAULT_LOCALE,
  AMD_DEFAULT_LOCALE,
  normalizeHvhh,
  validateHvhh,
  isValidHvhh,
  parseHvhh,
  roundAmd,
  parseAmd,
  formatAmd,
};
