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

const AMD = Object.freeze({ code: "AMD", symbol: "֏", subunit: 0 });

// ՀՎՀՀ is exactly 8 numeric digits: 7 serial + 1 check digit. The official
// check-digit algorithm is not publicly published, so we validate the verifiable
// invariants (length, numeric, non-degenerate). `checkDigitVerifier` is a documented
// seam: pass one in once the official algorithm is sourced to tighten validation.
const HVHH_LENGTH = 8;

function normalizeHvhh(value) {
  if (value === null || value === undefined) return "";
  // Strip separators users commonly type (spaces, dots, hyphens).
  return String(value).replace(/[\s.\-]/g, "");
}

function validateHvhh(value, { checkDigitVerifier } = {}) {
  const normalized = normalizeHvhh(value);
  if (!normalized) return { ok: false, normalized: "", error: "ՀՎՀՀ-ն պարտադիր է" };
  if (!/^[0-9]+$/.test(normalized)) {
    return { ok: false, normalized, error: "ՀՎՀՀ-ն պետք է պարունակի միայն թվանշաններ" };
  }
  if (normalized.length !== HVHH_LENGTH) {
    return { ok: false, normalized, error: `ՀՎՀՀ-ն պետք է լինի ${HVHH_LENGTH} նիշ` };
  }
  if (/^(\d)\1{7}$/.test(normalized)) {
    return { ok: false, normalized, error: "ՀՎՀՀ-ն անվավեր է" };
  }
  if (typeof checkDigitVerifier === "function" && !checkDigitVerifier(normalized)) {
    return { ok: false, normalized, error: "ՀՎՀՀ-ի ստուգիչ նիշը սխալ է" };
  }
  return { ok: true, normalized, error: null };
}

function isValidHvhh(value, options) {
  return validateHvhh(value, options).ok;
}

// AMD money. Amounts are whole drams; round before storing/displaying.
function roundAmd(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n);
}

function groupThousands(digits) {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function formatAmd(amount, { symbol = true } = {}) {
  const drams = roundAmd(amount);
  const sign = drams < 0 ? "-" : "";
  const grouped = sign + groupThousands(String(Math.abs(drams)));
  return symbol ? `${grouped} ${AMD.symbol}` : grouped;
}

// Strict, locale-tolerant boundary parser for AMD input. Unlike roundAmd (which
// returns 0 for anything un-parseable — silently corrupting "1,000" → 0), this
// returns { ok, amount, error }: it accepts grouped/spaced strings and round-trips
// formatAmd output, but fails LOUD on missing or non-numeric input. Use it at
// system boundaries (API bodies, form fields, imports) before trusting an amount;
// keep roundAmd for internal already-validated numbers.
function parseAmd(value) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return { ok: false, amount: 0, error: "Amount must be a finite number." };
    return { ok: true, amount: roundAmd(value) };
  }
  if (value == null) return { ok: false, amount: 0, error: "Amount is required." };
  const raw = String(value).trim();
  if (raw === "") return { ok: false, amount: 0, error: "Amount is required." };
  // Drop grouping separators (spaces, commas) and the AMD symbol/code so a formatted
  // value round-trips; keep an optional leading sign, digits, and one decimal point.
  const cleaned = raw.split(AMD.symbol).join("").replace(/AMD/gi, "").replace(/[\s,]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { ok: false, amount: 0, error: `Amount is not a valid number: ${raw}` };
  }
  return { ok: true, amount: roundAmd(Number(cleaned)) };
}

module.exports = {
  AMD,
  HVHH_LENGTH,
  normalizeHvhh,
  validateHvhh,
  isValidHvhh,
  roundAmd,
  parseAmd,
  formatAmd,
};
