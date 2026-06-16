const test = require("node:test");
const assert = require("node:assert/strict");
const { parseAmd, formatAmd } = require("./localization.cjs");

// parseAmd is the STRICT boundary parser. Unlike roundAmd (lenient, returns 0 for
// anything un-parseable — which silently corrupts "1,000" → 0), parseAmd returns
// { ok, amount, error } and is locale-tolerant: it accepts grouped/spaced input and
// round-trips formatAmd output, but fails loud on genuinely non-numeric input.

test("parseAmd: a finite number is accepted and rounded to whole dram", () => {
  assert.deepEqual(parseAmd(1000), { ok: true, amount: 1000 });
  assert.deepEqual(parseAmd(999.99), { ok: true, amount: 1000 });
});

test("parseAmd: a clean numeric string is accepted", () => {
  assert.deepEqual(parseAmd("100000"), { ok: true, amount: 100000 });
});

test("parseAmd: a grouped string (the silent-corruption case) is parsed correctly", () => {
  // roundAmd("1,000") returns 0 — a data-corruption trap. parseAmd parses it.
  assert.deepEqual(parseAmd("1,000"), { ok: true, amount: 1000 });
  assert.deepEqual(parseAmd("1 000"), { ok: true, amount: 1000 });
  assert.deepEqual(parseAmd("2,500,000"), { ok: true, amount: 2500000 });
});

test("parseAmd: formatAmd output round-trips back through parseAmd", () => {
  const formatted = formatAmd(1500); // "1,500 ֏"
  assert.deepEqual(parseAmd(formatted), { ok: true, amount: 1500 });
});

test("parseAmd: a negative amount is accepted (credit notes / reversals)", () => {
  assert.deepEqual(parseAmd(-2000), { ok: true, amount: -2000 });
  assert.deepEqual(parseAmd("-2,000"), { ok: true, amount: -2000 });
});

test("parseAmd: genuinely non-numeric input fails loud (not a silent 0)", () => {
  const r = parseAmd("abc");
  assert.equal(r.ok, false);
  assert.equal(r.amount, 0);
  assert.equal(typeof r.error, "string");
  assert.ok(r.error.length > 0);
});

test("parseAmd: empty/blank/missing input is a required-error, not 0", () => {
  for (const v of ["", "   ", null, undefined]) {
    const r = parseAmd(v);
    assert.equal(r.ok, false, `expected ${JSON.stringify(v)} to fail`);
    assert.ok(r.error.length > 0);
  }
});

test("parseAmd: NaN / Infinity numbers fail loud", () => {
  assert.equal(parseAmd(NaN).ok, false);
  assert.equal(parseAmd(Infinity).ok, false);
  assert.equal(parseAmd(-Infinity).ok, false);
});

test("parseAmd: a malformed numeric-looking string fails (no partial parse)", () => {
  assert.equal(parseAmd("12.3.4").ok, false);
  assert.equal(parseAmd("1,00x").ok, false);
  assert.equal(parseAmd("--5").ok, false);
});
