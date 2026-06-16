// Armenian phone-number helpers — part of the RA localization kernel.
//
// Armenia (country code +374) uses an 8-digit National Significant Number (NSN).
// We normalize the many shapes users type (+374…, 00374…, domestic 0…, bare, with
// spaces/punctuation) down to the canonical 8-digit NSN, then format/validate.
//
// We validate the STABLE invariant (8-digit NSN, not starting with 0) rather than
// hard-coding operator prefixes — operator ranges change, and over-validation would
// reject legitimate numbers. Pure functions, no I/O.

function normalizeNsn(value) {
  let s = String(value == null ? "" : value).replace(/[^\d]/g, "");
  if (s.startsWith("00374")) s = s.slice(5); // 00 international prefix
  else if (s.length === 11 && s.startsWith("374")) s = s.slice(3); // 374 + 8-digit NSN
  else if (s.length === 9 && s.startsWith("0")) s = s.slice(1); // domestic trunk 0 + NSN
  return /^[1-9]\d{7}$/.test(s) ? s : "";
}

function isValidArmenianPhone(value) {
  return normalizeNsn(value) !== "";
}

function e164(value) {
  const nsn = normalizeNsn(value);
  return nsn ? `+374${nsn}` : null;
}

function formatPhone(value) {
  const nsn = normalizeNsn(value);
  return nsn ? `+374 ${nsn.slice(0, 2)} ${nsn.slice(2)}` : null;
}

module.exports = {
  COUNTRY_CODE: "374",
  NSN_LENGTH: 8,
  normalizeNsn,
  isValidArmenianPhone,
  e164,
  formatPhone,
};
