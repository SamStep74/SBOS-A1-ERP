import test from 'node:test';
import assert from 'node:assert/strict';
import {
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
} from './armeniaChartOfAccounts.js';

test('CoA: defines the 9 RA account classes by leading digit', () => {
  assert.equal(ACCOUNT_CLASSES.length, 9);
  assert.deepEqual(
    ACCOUNT_CLASSES.map((c) => c.digit),
    [1, 2, 3, 4, 5, 6, 7, 8, 9],
  );
  const types = ['asset', 'liability', 'equity', 'income', 'expense', 'management', 'offBalance'];
  for (const c of ACCOUNT_CLASSES) {
    assert.ok(c.hy && c.hy.length > 0, `class ${c.digit} missing hy`);
    assert.ok(types.includes(c.type), `class ${c.digit} bad type ${c.type}`);
    assert.ok(['debit', 'credit', null].includes(c.normalBalance));
  }
});

test('CoA: ships the FULL official chart (600+ accounts) with official Armenian names', () => {
  assert.ok(STANDARD_ACCOUNTS.length >= 600, `only ${STANDARD_ACCOUNTS.length} accounts`);
  assert.equal(accountByCode('251').hy, 'Դրամարկղ');
  assert.equal(accountByCode('611').type, 'income');
  // retained earnings (was missing from the raw parse; added back per arlis.am)
  assert.equal(accountByCode('342').hy, 'Նախորդ տարիների չբաշխված շահույթ (չծածկված վնաս)');
  // a 4-digit sub-account exists
  assert.equal(accountByCode('1111').hy, 'Շենքեր');
  assert.equal(accountByCode('00000'), null);
});

test("CoA: input-VAT account 226 carries the OFFICIAL name (not HH's simplified one)", () => {
  const a = accountByCode('226');
  assert.equal(a.type, 'asset');
  assert.equal(a.class, 2);
  assert.match(a.hy, /անուղղակի հարկեր/); // "...recoverable indirect taxes" (input VAT)
});

test('CoA: accountClass maps a code to its class by leading digit (1-9)', () => {
  assert.equal(accountClass('226').type, 'asset');
  assert.equal(accountClass('524').type, 'liability');
  assert.equal(accountClass('311').type, 'equity');
  assert.equal(accountClass('611').type, 'income');
  assert.equal(accountClass('714').type, 'expense');
  assert.equal(accountClass('811').type, 'management');
  assert.equal(accountClass('911').type, 'offBalance');
  assert.equal(accountClass('xyz'), null);
});

test('CoA: every one of the 600+ accounts is internally consistent (type agrees with class)', () => {
  for (const a of STANDARD_ACCOUNTS) {
    const cls = accountClass(a.code);
    assert.ok(cls, `no class for ${a.code}`);
    assert.equal(
      cls.type,
      a.type,
      `account ${a.code} type ${a.type} disagrees with class ${cls.digit} (${cls.type})`,
    );
    assert.match(a.code, /^[0-9]{3,4}$/);
  }
});

test('CoA: normalBalance follows the class (off-balance memo accounts are null)', () => {
  assert.equal(normalBalance('251'), 'debit'); // asset
  assert.equal(normalBalance('714'), 'debit'); // expense
  assert.equal(normalBalance('611'), 'credit'); // income
  assert.equal(normalBalance('311'), 'credit'); // equity
  assert.equal(normalBalance('524'), 'credit'); // liability
  assert.equal(normalBalance('911'), null); // off-balance memo
});

test('CoA: query helpers by type and class span the full chart', () => {
  assert.ok(accountsByType('expense').every((a) => a.code.startsWith('7')));
  assert.ok(accountsByClass(6).every((a) => a.code.startsWith('6')));
  assert.ok(accountsByClass(9).length > 0); // off-balance class is populated
  assert.ok(accountsByType('asset').length > 50); // classes 1+2 are large
});

// ---- pagedAccounts: lets a UI fetch the full 600+ chart in slices rather than
// render the whole table. Shape mirrors the API response envelope from the
// typescript/rules patterns (data + meta with total/page/limit) so this
// helper slots directly into a Fastify route or React/Solid query layer.

test('pagedAccounts: page 1 with default size returns the first slice and a complete meta envelope', () => {
  const r = pagedAccounts();
  assert.equal(r.data.length, PAGE_SIZE_DEFAULT);
  assert.deepEqual(r.meta, {
    total: STANDARD_ACCOUNTS.length,
    page: 1,
    limit: PAGE_SIZE_DEFAULT,
  });
  // first page is the first pageSize accounts, in original chart order
  for (let i = 0; i < PAGE_SIZE_DEFAULT; i += 1) {
    assert.equal(r.data[i], STANDARD_ACCOUNTS[i]);
  }
});

test('pagedAccounts: page 2 returns the next slice with no overlap against page 1', () => {
  const p1 = pagedAccounts({ page: 1, pageSize: 25 });
  const p2 = pagedAccounts({ page: 2, pageSize: 25 });
  assert.equal(p2.data.length, 25);
  const p1Codes = new Set(p1.data.map((a) => a.code));
  for (const a of p2.data) assert.ok(!p1Codes.has(a.code), `overlap on ${a.code}`);
  assert.equal(p2.data[0], STANDARD_ACCOUNTS[25]);
  assert.equal(p2.meta.page, 2);
  assert.equal(p2.meta.limit, 25);
});

test('pagedAccounts: out-of-range page returns empty data with valid meta (no throw)', () => {
  const totalPages = Math.ceil(STANDARD_ACCOUNTS.length / 50);
  const r = pagedAccounts({ page: totalPages + 10 });
  assert.deepEqual(r.data, []);
  assert.equal(r.meta.page, totalPages + 10);
  assert.equal(r.meta.total, STANDARD_ACCOUNTS.length);
});

test('pagedAccounts: clamps page < 1 to 1 (no negative-page or 0-page results)', () => {
  const r0 = pagedAccounts({ page: 0 });
  const rNeg = pagedAccounts({ page: -3 });
  assert.equal(r0.meta.page, 1);
  assert.equal(rNeg.meta.page, 1);
  // both must equal the natural page 1
  const r1 = pagedAccounts({ page: 1 });
  assert.deepEqual(r0.data, r1.data);
});

test('pagedAccounts: clamps pageSize to PAGE_SIZE_DEFAULT when invalid (<1 or NaN)', () => {
  for (const bad of [0, -1, NaN, '50', null, undefined]) {
    const r = pagedAccounts({ pageSize: bad });
    assert.equal(r.meta.limit, PAGE_SIZE_DEFAULT, `pageSize=${String(bad)}`);
  }
});

test('pagedAccounts: caps pageSize at PAGE_SIZE_MAX so a runaway client cannot OOM the response', () => {
  const r = pagedAccounts({ pageSize: 1_000_000 });
  assert.equal(r.meta.limit, PAGE_SIZE_MAX);
  assert.equal(r.data.length, Math.min(PAGE_SIZE_MAX, STANDARD_ACCOUNTS.length));
});

test('pagedAccounts: type filter narrows the result set and meta.total reflects the filter', () => {
  const r = pagedAccounts({ type: 'expense', pageSize: 10 });
  assert.ok(r.data.every((a) => a.type === 'expense'));
  assert.equal(r.meta.total, accountsByType('expense').length);
  assert.equal(r.data.length, Math.min(10, r.meta.total));
});

test('pagedAccounts: class filter (digit) narrows the result set', () => {
  const r = pagedAccounts({ class: 6, pageSize: 10 });
  assert.ok(r.data.every((a) => a.code.startsWith('6')));
  assert.equal(r.meta.total, accountsByClass(6).length);
});

test('pagedAccounts: type + class filters compose with AND semantics', () => {
  const r = pagedAccounts({ type: 'asset', class: 2, pageSize: 10 });
  // type='asset' spans classes 1+2; class=2 narrows to current assets only
  const expected = STANDARD_ACCOUNTS.filter(
    (a) => a.type === 'asset' && a.code.startsWith('2'),
  );
  assert.equal(r.meta.total, expected.length);
  assert.deepEqual(
    r.data.map((a) => a.code),
    expected.slice(0, 10).map((a) => a.code),
  );
});

test('pagedAccounts: unknown type / unknown class → empty data, total=0, no throw', () => {
  const r = pagedAccounts({ type: 'banana', class: 99 });
  assert.deepEqual(r.data, []);
  assert.equal(r.meta.total, 0);
});

test('pagedAccounts: does not mutate STANDARD_ACCOUNTS (immutability contract)', () => {
  const before = STANDARD_ACCOUNTS.slice();
  pagedAccounts({ page: 2, pageSize: 25, type: 'asset' });
  pagedAccounts({ page: 999, pageSize: 10_000 });
  assert.deepEqual(STANDARD_ACCOUNTS, before);
});
