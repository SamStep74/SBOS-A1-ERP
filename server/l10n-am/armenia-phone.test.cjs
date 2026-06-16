const test = require("node:test");
const assert = require("node:assert/strict");
const {
  normalizeNsn,
  isValidArmenianPhone,
  e164,
  formatPhone,
} = require("./armeniaPhone.cjs");

test("phone: normalizes every common input shape to the 8-digit NSN", () => {
  const nsn = "91234567";
  assert.equal(normalizeNsn("+37491234567"), nsn); // E.164
  assert.equal(normalizeNsn("0037491234567"), nsn); // 00 international prefix
  assert.equal(normalizeNsn("091234567"), nsn); // domestic 0-prefix
  assert.equal(normalizeNsn("91234567"), nsn); // bare NSN
  assert.equal(normalizeNsn("+374 91 23 45 67"), nsn); // spaces
  assert.equal(normalizeNsn("(091) 23-45-67"), nsn); // punctuation + 0
});

test("phone: a Yerevan landline NSN (area 10) normalizes too", () => {
  assert.equal(normalizeNsn("+374 10 561234"), "10561234");
  assert.equal(isValidArmenianPhone("010561234"), true);
});

test("phone: isValidArmenianPhone enforces an 8-digit NSN", () => {
  assert.equal(isValidArmenianPhone("+37491234567"), true);
  assert.equal(isValidArmenianPhone("1234567"), false); // 7 digits
  assert.equal(isValidArmenianPhone("912345678"), false); // 9 digits
  assert.equal(isValidArmenianPhone("00000000"), false); // NSN can't start with 0
  assert.equal(isValidArmenianPhone("9123456A"), false); // non-numeric
  assert.equal(isValidArmenianPhone(""), false);
  assert.equal(isValidArmenianPhone(null), false);
});

test("phone: e164 returns the canonical +374 form or null", () => {
  assert.equal(e164("091234567"), "+37491234567");
  assert.equal(e164("+374 91 234567"), "+37491234567");
  assert.equal(e164("nope"), null);
});

test("phone: formatPhone produces a readable +374 grouping or null", () => {
  assert.equal(formatPhone("091234567"), "+374 91 234567");
  assert.equal(formatPhone("+37410561234"), "+374 10 561234");
  assert.equal(formatPhone("bad"), null);
});
