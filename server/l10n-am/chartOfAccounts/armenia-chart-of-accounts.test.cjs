const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ACCOUNT_CLASSES,
  STANDARD_ACCOUNTS,
  accountClass,
  accountByCode,
  accountsByType,
  accountsByClass,
  normalBalance,
} = require("./armeniaChartOfAccounts.cjs");

test("CoA: defines the 9 RA account classes by leading digit", () => {
  assert.equal(ACCOUNT_CLASSES.length, 9);
  assert.deepEqual(ACCOUNT_CLASSES.map((c) => c.digit), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
  const types = ["asset", "liability", "equity", "income", "expense", "management", "offBalance"];
  for (const c of ACCOUNT_CLASSES) {
    assert.ok(c.hy && c.hy.length > 0, `class ${c.digit} missing hy`);
    assert.ok(types.includes(c.type), `class ${c.digit} bad type ${c.type}`);
    assert.ok(["debit", "credit", null].includes(c.normalBalance));
  }
});

test("CoA: ships the FULL official chart (600+ accounts) with official Armenian names", () => {
  assert.ok(STANDARD_ACCOUNTS.length >= 600, `only ${STANDARD_ACCOUNTS.length} accounts`);
  assert.equal(accountByCode("251").hy, "Դրամարկղ");
  assert.equal(accountByCode("611").type, "income");
  // retained earnings (was missing from the raw parse; added back per arlis.am)
  assert.equal(accountByCode("342").hy, "Նախորդ տարիների չբաշխված շահույթ (չծածկված վնաս)");
  // a 4-digit sub-account exists
  assert.equal(accountByCode("1111").hy, "Շենքեր");
  assert.equal(accountByCode("00000"), null);
});

test("CoA: input-VAT account 226 carries the OFFICIAL name (not HH's simplified one)", () => {
  const a = accountByCode("226");
  assert.equal(a.type, "asset");
  assert.equal(a.class, 2);
  assert.match(a.hy, /անուղղակի հարկեր/); // "...recoverable indirect taxes" (input VAT)
});

test("CoA: accountClass maps a code to its class by leading digit (1-9)", () => {
  assert.equal(accountClass("226").type, "asset");
  assert.equal(accountClass("524").type, "liability");
  assert.equal(accountClass("311").type, "equity");
  assert.equal(accountClass("611").type, "income");
  assert.equal(accountClass("714").type, "expense");
  assert.equal(accountClass("811").type, "management");
  assert.equal(accountClass("911").type, "offBalance");
  assert.equal(accountClass("xyz"), null);
});

test("CoA: every one of the 600+ accounts is internally consistent (type agrees with class)", () => {
  for (const a of STANDARD_ACCOUNTS) {
    const cls = accountClass(a.code);
    assert.ok(cls, `no class for ${a.code}`);
    assert.equal(cls.type, a.type, `account ${a.code} type ${a.type} disagrees with class ${cls.digit} (${cls.type})`);
    assert.match(a.code, /^[0-9]{3,4}$/);
  }
});

test("CoA: normalBalance follows the class (off-balance memo accounts are null)", () => {
  assert.equal(normalBalance("251"), "debit"); // asset
  assert.equal(normalBalance("714"), "debit"); // expense
  assert.equal(normalBalance("611"), "credit"); // income
  assert.equal(normalBalance("311"), "credit"); // equity
  assert.equal(normalBalance("524"), "credit"); // liability
  assert.equal(normalBalance("911"), null); // off-balance memo
});

test("CoA: query helpers by type and class span the full chart", () => {
  assert.ok(accountsByType("expense").every((a) => a.code.startsWith("7")));
  assert.ok(accountsByClass(6).every((a) => a.code.startsWith("6")));
  assert.ok(accountsByClass(9).length > 0); // off-balance class is populated
  assert.ok(accountsByType("asset").length > 50); // classes 1+2 are large
});
