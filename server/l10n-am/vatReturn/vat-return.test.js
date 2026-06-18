import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeVatReturn,
  vatReturnForm,
  validateVatReturnForm,
  STANDARD_VAT_RATE,
  IMPUTED_VAT_RATE,
  VAT_RETURN_FORM_SOURCE,
  VAT_RETURN_FORM_LINE_DEFINITIONS,
} from './vatReturn.js';

test('vat-return: net = output VAT minus recoverable input VAT (payable to SRC)', () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 1000000, vatRate: 20 }],
    purchases: [{ netAmount: 400000, vatRate: 20 }],
  });
  assert.equal(r.outputVat, 200000);
  assert.equal(r.inputVat, 80000);
  assert.equal(r.net, 120000);
  assert.equal(r.payable, 120000);
  assert.equal(r.creditCarried, 0);
  assert.equal(r.taxableSales, 1000000);
});

test('vat-return: input exceeding output yields a carried credit, not a negative payable', () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 100000, vatRate: 20 }], // output 20000
    purchases: [{ netAmount: 500000, vatRate: 20 }], // input 100000
  });
  assert.equal(r.net, -80000);
  assert.equal(r.payable, 0);
  assert.equal(r.creditCarried, 80000);
});

test('vat-return: non-recoverable purchases are excluded from input VAT', () => {
  const r = computeVatReturn({
    sales: [],
    purchases: [
      { netAmount: 100000, vatRate: 20, recoverable: true },
      { netAmount: 100000, vatRate: 20, recoverable: false },
    ],
  });
  assert.equal(r.inputVat, 20000); // only the recoverable one
});

test('vat-return: zero-rated/exempt sales add to base but not to output VAT', () => {
  const r = computeVatReturn({
    sales: [
      { netAmount: 100000, vatRate: 20 }, // 20000
      { netAmount: 50000, vatRate: 0 }, // exempt/zero-rated
    ],
    purchases: [],
  });
  assert.equal(r.outputVat, 20000);
  assert.equal(r.taxableSales, 150000);
});

test('vat-return: an explicit vatAmount overrides the computed one', () => {
  const r = computeVatReturn({
    sales: [{ netAmount: 100000, vatRate: 20, vatAmount: 0 }],
    purchases: [],
  });
  assert.equal(r.outputVat, 0);
});

test('vat-return: empty period is all zeros; RA standard rate is 20%', () => {
  const r = computeVatReturn({ sales: [], purchases: [] });
  assert.deepEqual(
    { o: r.outputVat, i: r.inputVat, n: r.net, p: r.payable, c: r.creditCarried },
    { o: 0, i: 0, n: 0, p: 0, c: 0 },
  );
  assert.equal(STANDARD_VAT_RATE, 20);
});

test('vat-return-form: maps 20% sales to line 7 and rolls up total credit (line 16)', () => {
  const f = vatReturnForm({ sales: [{ netAmount: 1000000, vatRate: 20 }], purchases: [] });
  assert.deepEqual(f.lines['7'], { base: 1000000, vat: 200000 });
  assert.deepEqual(f.lines['16'], { base: 1000000, vat: 200000 });
});

test('vat-return-form: carries official SRC source metadata and line definitions', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.equal(f.source, VAT_RETURN_FORM_SOURCE);
  assert.equal(f.source.sourceUrl, 'https://www.arlis.am/hy/acts/136996');
  assert.equal(f.source.orderNumber, 'N 298-Ն');
  assert.match(f.source.titleHy, /Ավելացված արժեքի հարկ/);
  assert.equal(f.lineDefinitions, VAT_RETURN_FORM_LINE_DEFINITIONS);
  assert.deepEqual(f.lineDefinitions['7'].fields, ['base', 'vat']);
  assert.equal(f.lineDefinitions['7'].section, 'output');
  assert.match(f.lineDefinitions['18'].labelHy, /ձեռք բերված/);
  assert.deepEqual(f.lineDefinitions['23'].fields, ['payable', 'recoverable']);
});

test('vat-return-form: separates zero-rated (line 12) from exempt (line 13)', () => {
  const f = vatReturnForm({
    sales: [
      { netAmount: 100000, vatRate: 0 }, // zero-rated → line 12
      { netAmount: 50000, vatRate: 0, category: 'exempt' }, // exempt → line 13
    ],
    purchases: [],
  });
  assert.equal(f.lines['12'].base, 100000);
  assert.equal(f.lines['13'].base, 50000);
  assert.equal(f.lines['16'].vat, 0);
  assert.equal(f.lines['16'].base, 150000);
});

test('vat-return-form: 16.67% imputed sales go to line 9', () => {
  const f = vatReturnForm({
    sales: [{ netAmount: 120000, vatRate: IMPUTED_VAT_RATE, vatAmount: 20000 }],
    purchases: [],
  });
  assert.equal(f.lines['9'].base, 120000);
  assert.equal(f.lines['9'].vat, 20000);
});

test('vat-return-form: splits imports (line 17) from domestic (line 18) and totals debit (21)', () => {
  const f = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 300000, vatRate: 20, source: 'import' },
      { netAmount: 200000, vatRate: 20, source: 'domestic' },
      { netAmount: 100000, vatRate: 20, recoverable: false }, // excluded
    ],
  });
  assert.deepEqual(f.lines['17'], { base: 300000, vat: 60000 });
  assert.deepEqual(f.lines['18'], { base: 200000, vat: 40000 });
  assert.equal(f.lines['21'].vat, 100000);
});

test('vat-return-form: line 23 nets credit against debit (payable vs recoverable)', () => {
  const payable = vatReturnForm({
    sales: [{ netAmount: 1000000, vatRate: 20 }],
    purchases: [{ netAmount: 400000, vatRate: 20 }],
  });
  assert.deepEqual(payable.lines['23'], { payable: 120000, recoverable: 0 });

  const refund = vatReturnForm({
    sales: [{ netAmount: 100000, vatRate: 20 }],
    purchases: [{ netAmount: 500000, vatRate: 20 }],
  });
  assert.deepEqual(refund.lines['23'], { payable: 0, recoverable: 80000 });
});

// --- decree N 298-Ն line definitions 8/10/11/14/15/19/20/22 --------------------
// The remaining output/input adjustment lines per the official VAT return form.
// Lines 8/11/15/19/20 have multiple sub-cells (decrease/increase); line 14 was
// repealed (27.08.19 N 556-Ն) but is still in the form layout for backward
// compatibility; line 22 is independent (Art. 79 imports).

test('vat-return-form: line 8 (correcting tax invoices, output base) has decrease/increase cells', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['8'], 'line 8 definition must exist');
  assert.equal(f.lineDefinitions['8'].section, 'output');
  assert.deepEqual(f.lineDefinitions['8'].fields, ['baseDecrease', 'baseIncrease']);
  assert.match(f.lineDefinitions['8'].labelHy, /Ճշգրտող/);
  // defaulted to zero when absent — UI/manual entries, not derived from sales
  assert.deepEqual(f.lines['8'], { baseDecrease: 0, baseIncrease: 0 });
});

test('vat-return-form: line 10 (other VAT liability) is output VAT only', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['10'], 'line 10 definition must exist');
  assert.equal(f.lineDefinitions['10'].section, 'output');
  assert.deepEqual(f.lineDefinitions['10'].fields, ['vat']);
  assert.match(f.lineDefinitions['10'].labelHy, /այլ հարկային պարտավորություն/);
  assert.deepEqual(f.lines['10'], { vat: 0 });
});

test('vat-return-form: line 11 (correcting invoices issued outside supplier name) is output VAT with decrease/increase', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['11'], 'line 11 definition must exist');
  assert.equal(f.lineDefinitions['11'].section, 'output');
  assert.deepEqual(f.lineDefinitions['11'].fields, ['vatDecrease', 'vatIncrease']);
  assert.match(f.lineDefinitions['11'].labelHy, /Մատակարարի անունից/);
  assert.deepEqual(f.lines['11'], { vatDecrease: 0, vatIncrease: 0 });
});

test('vat-return-form: line 14 (REPEALED 27.08.19 N 556-Ն) is preserved for backward compatibility', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['14'], 'line 14 definition must exist (repealed but in form)');
  assert.equal(f.lineDefinitions['14'].section, 'output');
  assert.deepEqual(f.lineDefinitions['14'].fields, ['base']);
  // The decree text explicitly notes the line lost force — preserved as base-only
  assert.match(f.lineDefinitions['14'].labelHy, /(ուժը կորցրել|REPEALED|556-Ն)/);
  assert.deepEqual(f.lines['14'], { base: 0 });
});

test('vat-return-form: line 15 (VAT credit adjustment) is output VAT with increase/decrease cells', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['15'], 'line 15 definition must exist');
  assert.equal(f.lineDefinitions['15'].section, 'output');
  assert.deepEqual(f.lineDefinitions['15'].fields, ['vatIncrease', 'vatDecrease']);
  assert.match(f.lineDefinitions['15'].labelHy, /(Ավելացում|Պակասեցում|ճշգրտում)/);
  assert.deepEqual(f.lines['15'], { vatIncrease: 0, vatDecrease: 0 });
});

test('vat-return-form: line 19 (acquisition correcting tax invoices) is input VAT with decrease/increase', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['19'], 'line 19 definition must exist');
  assert.equal(f.lineDefinitions['19'].section, 'input');
  assert.deepEqual(f.lineDefinitions['19'].fields, ['vatDecrease', 'vatIncrease']);
  assert.match(f.lineDefinitions['19'].labelHy, /Ձեռքբերումներին/);
  assert.deepEqual(f.lines['19'], { vatDecrease: 0, vatIncrease: 0 });
});

test('vat-return-form: line 20 (offset VAT adjustment total) is input VAT with increase/decrease', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['20'], 'line 20 definition must exist');
  assert.equal(f.lineDefinitions['20'].section, 'input');
  assert.deepEqual(f.lineDefinitions['20'].fields, ['vatIncrease', 'vatDecrease']);
  assert.match(f.lineDefinitions['20'].labelHy, /(Հաշվանցման|ընդհանուր գումար)/);
  assert.deepEqual(f.lines['20'], { vatIncrease: 0, vatDecrease: 0 });
});

test('vat-return-form: line 22 (imports per Tax Code art. 79) is input base + VAT, independent of line 21', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  assert.ok(f.lineDefinitions['22'], 'line 22 definition must exist');
  assert.equal(f.lineDefinitions['22'].section, 'input');
  assert.deepEqual(f.lineDefinitions['22'].fields, ['base', 'vat']);
  assert.match(f.lineDefinitions['22'].labelHy, /79-րդ հոդված/);
  assert.deepEqual(f.lines['22'], { base: 0, vat: 0 });
});

test('vat-return-form: a purchase flagged art79: true (imports per Tax Code art. 79) routes base + VAT to line 22, not to lines 17/18', () => {
  // Per decree N 298-Ն: goods imported under Tax Code art. 79 are reported
  // on line 22 (independent liability) — NOT on line 17/18 (which only cover
  // ordinary current-period imports of goods/services subject to reverse charge).
  // The art. 79 VAT is paid at customs, not via the regular VAT return input-
  // credit path; line 22 carries the full base and VAT for reconciliation.
  const f = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 200000, vatRate: 20, vatAmount: 40000, source: 'import', art79: true },
    ],
  });
  assert.equal(f.lines['22'].base, 200000);
  assert.equal(f.lines['22'].vat, 40000);
  // art. 79 import must NOT have leaked into lines 17/18 (current-period reverse charge)
  assert.equal(f.lines['17'].base, 0);
  assert.equal(f.lines['17'].vat, 0);
  assert.equal(f.lines['18'].base, 0);
  assert.equal(f.lines['18'].vat, 0);
});

test('vat-return-form: line 22 (art. 79 imports) and lines 17/18 (regular imports) coexist; line 21 only includes recoverable regular VAT', () => {
  // Two imports in the same period:
  //   - one ordinary import of services (source='import', no art79) → lines 17/18,
  //     line 21 VAT is the recoverable reverse-charge input credit
  //   - one art. 79 import of goods (source='import', art79=true) → line 22,
  //     NOT recoverable in line 21 (customs-paid, separate liability)
  // Cross-foot invariant: line 21 vat excludes the art. 79 amount entirely.
  const f = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 100000, vatRate: 20, vatAmount: 20000, source: 'import' },
      { netAmount: 300000, vatRate: 20, vatAmount: 60000, source: 'import', art79: true },
    ],
  });
  // regular import → lines 17/18
  assert.equal(f.lines['17'].base, 100000);
  assert.equal(f.lines['17'].vat, 20000);
  // art. 79 import → line 22
  assert.equal(f.lines['22'].base, 300000);
  assert.equal(f.lines['22'].vat, 60000);
  // line 21 only includes the RECOVERABLE regular input VAT (20,000)
  // the art. 79 amount (60,000) is NOT in line 21 — it's reported on line 22
  // as a separate calculated liability paid at customs
  assert.equal(f.lines['21'].vat, 20000);
});

test('vat-return-form: a sale flagged as a correcting invoice routes base to line 8 sub-cell per direction', () => {
  // A Ճշգրտող հարկային հաշիվ (correcting tax invoice) is a separate document
  // that adjusts a previously issued sale. Per decree N 298-Ն it does NOT
  // roll into line 7 (current-period 20% sales); instead its base flows to
  // line 8 (baseDecrease when direction='decrease', baseIncrease when 'increase').
  const dec = vatReturnForm({
    sales: [{ netAmount: 50000, vatRate: 20, adjusting: 'decrease' }],
    purchases: [],
  });
  assert.equal(dec.lines['8'].baseDecrease, 50000);
  assert.equal(dec.lines['8'].baseIncrease, 0);
  // the correcting base must NOT have leaked into line 7 (no current-period sale)
  assert.equal(dec.lines['7'].base, 0);
  assert.equal(dec.lines['7'].vat, 0);

  const inc = vatReturnForm({
    sales: [{ netAmount: 80000, vatRate: 20, adjusting: 'increase' }],
    purchases: [],
  });
  assert.equal(inc.lines['8'].baseDecrease, 0);
  assert.equal(inc.lines['8'].baseIncrease, 80000);
  assert.equal(inc.lines['7'].base, 0);
  assert.equal(inc.lines['7'].vat, 0);
});

test('vat-return-form: line 16 base reflects correcting-invoice adjustments (7+9+12+13 − 8.dec + 8.inc)', () => {
  // Cross-foot invariant from decree N 298-Ն:
  //   line 16 base = 7 + 9 + 12 + 13 + 14 − 8.baseDecrease + 8.baseIncrease
  // Mixing a 1,000,000 standard sale with a 200,000 correcting decrease and
  // a 50,000 correcting increase must produce line 16 base = 850,000 — NOT
  // the naive 1,000,000 that ignores the line-8 adjustments.
  const f = vatReturnForm({
    sales: [
      { netAmount: 1000000, vatRate: 20 }, // standard → line 7
      { netAmount: 200000, vatRate: 20, adjusting: 'decrease' }, // line 8 dec
      { netAmount: 50000, vatRate: 20, adjusting: 'increase' }, // line 8 inc
    ],
    purchases: [],
  });
  assert.equal(f.lines['7'].base, 1000000);
  assert.equal(f.lines['8'].baseDecrease, 200000);
  assert.equal(f.lines['8'].baseIncrease, 50000);
  assert.equal(f.lines['16'].base, 850000); // 1,000,000 − 200,000 + 50,000
});

test('vat-return-form: a purchase flagged as a correcting invoice routes VAT to line 19 sub-cell per direction', () => {
  // Line 19 covers correcting tax invoices for INPUT side (acquisitions).
  // Per decree N 298-Ն: adjusting='decrease' → vatDecrease (you owe back input VAT),
  // adjusting='increase' → vatIncrease (you can claim more input VAT).
  // Routed amount is VAT (not base) — unlike line 8 which is base for OUTPUT.
  const dec = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 100000, vatRate: 20, vatAmount: 20000, adjusting: 'decrease' },
    ],
  });
  assert.equal(dec.lines['19'].vatDecrease, 20000);
  assert.equal(dec.lines['19'].vatIncrease, 0);
  // correcting purchase must NOT have leaked into line 18 (no current-period acquisition)
  assert.equal(dec.lines['18'].base, 0);
  assert.equal(dec.lines['18'].vat, 0);

  const inc = vatReturnForm({
    sales: [],
    purchases: [
      { netAmount: 50000, vatRate: 20, vatAmount: 10000, adjusting: 'increase' },
    ],
  });
  assert.equal(inc.lines['19'].vatDecrease, 0);
  assert.equal(inc.lines['19'].vatIncrease, 10000);
  assert.equal(inc.lines['18'].base, 0);
  assert.equal(inc.lines['18'].vat, 0);
});

test('vat-return-form: a sale with adjustingInSupplierName routes VAT to line 11 sub-cell per direction (agent-issued correcting invoices)', () => {
  // A Ճշգրտող հարկային հաշիվ issued Մատակարարի անունից (in the supplier's
  // name — agent/commission scenario) is the OUTPUT-side mirror of line 19.
  // Unlike line 8 (where the regular adjusting flow routes BASE), line 11
  // routes VAT. Per decree N 298-Ն:
  //   adjusting=increase + adjustingInSupplierName → line 11.vatIncrease
  //   adjusting=decrease + adjustingInSupplierName → line 11.vatDecrease
  const dec = vatReturnForm({
    sales: [
      {
        netAmount: 100000,
        vatRate: 20,
        vatAmount: 20000,
        adjusting: 'decrease',
        adjustingInSupplierName: true,
      },
    ],
    purchases: [],
  });
  assert.equal(dec.lines['11'].vatDecrease, 20000);
  assert.equal(dec.lines['11'].vatIncrease, 0);
  // agent-issued must NOT leak into line 8 (which is for seller-issued base adjustments)
  assert.equal(dec.lines['8'].baseDecrease, 0);
  assert.equal(dec.lines['8'].baseIncrease, 0);

  const inc = vatReturnForm({
    sales: [
      {
        netAmount: 50000,
        vatRate: 20,
        vatAmount: 10000,
        adjusting: 'increase',
        adjustingInSupplierName: true,
      },
    ],
    purchases: [],
  });
  assert.equal(inc.lines['11'].vatDecrease, 0);
  assert.equal(inc.lines['11'].vatIncrease, 10000);
  assert.equal(inc.lines['8'].baseDecrease, 0);
  assert.equal(inc.lines['8'].baseIncrease, 0);
});

test('vat-return-form: a sale with adjustingToCredit routes VAT to line 15 sub-cell per direction (output VAT credit-adjustment invoices)', () => {
  // A Ճշգրտող հարկային հաշիվ that adjusts the period-end VAT credit (decree N 298-Ն
  // line 15 — "Հաշվարկված ԱԱՀ-ի հարկային պարտավորությունների ճշգրտում (Ավելացում/Պակասեցում)").
  // Like line 11, it routes VAT (not base); distinct from line 11 because line 15
  // adjusts the VAT credit TOTAL itself (not a specific supplier's invoice).
  // Schema flag: `adjustingToCredit: true` (mirrors `adjustingInSupplierName`).
  // Per decree N 298-Ն:
  //   adjusting=increase + adjustingToCredit → line 15.vatIncrease
  //   adjusting=decrease + adjustingToCredit → line 15.vatDecrease
  const dec = vatReturnForm({
    sales: [
      { netAmount: 100000, vatRate: 20, vatAmount: 20000, adjusting: 'decrease', adjustingToCredit: true },
    ],
    purchases: [],
  });
  assert.equal(dec.lines['15'].vatDecrease, 20000);
  assert.equal(dec.lines['15'].vatIncrease, 0);
  // credit-adjusting must NOT leak into line 8 (seller-issued base adjustments)
  assert.equal(dec.lines['8'].baseDecrease, 0);
  assert.equal(dec.lines['8'].baseIncrease, 0);
  // credit-adjusting must NOT leak into line 11 (agent-issued supplier adjustments)
  assert.equal(dec.lines['11'].vatDecrease, 0);
  assert.equal(dec.lines['11'].vatIncrease, 0);

  const inc = vatReturnForm({
    sales: [
      { netAmount: 50000, vatRate: 20, vatAmount: 10000, adjusting: 'increase', adjustingToCredit: true },
    ],
    purchases: [],
  });
  assert.equal(inc.lines['15'].vatDecrease, 0);
  assert.equal(inc.lines['15'].vatIncrease, 10000);
  assert.equal(inc.lines['8'].baseDecrease, 0);
  assert.equal(inc.lines['8'].baseIncrease, 0);
  assert.equal(inc.lines['11'].vatDecrease, 0);
  assert.equal(inc.lines['11'].vatIncrease, 0);
});

test('vat-return-form: regular (line 8) and agent-issued (line 11) adjusting invoices coexist independently', () => {
  // Both routing buckets must work side-by-side in the same period: regular
  // adjusting sales → line 8 base; agent-issued adjusting sales → line 11 VAT.
  // Neither should pollute the other.
  const f = vatReturnForm({
    sales: [
      // seller-issued regular correcting invoice → line 8 (base)
      { netAmount: 200000, vatRate: 20, adjusting: 'decrease' },
      // agent-issued correcting invoice → line 11 (VAT)
      { netAmount: 150000, vatRate: 20, vatAmount: 30000, adjusting: 'decrease', adjustingInSupplierName: true },
      // regular current-period sale → line 7
      { netAmount: 5000000, vatRate: 20 },
    ],
    purchases: [],
  });
  // line 7: only the current-period sale
  assert.equal(f.lines['7'].base, 5000000);
  // line 8: only the regular seller-issued adjustment (base)
  assert.equal(f.lines['8'].baseDecrease, 200000);
  assert.equal(f.lines['8'].baseIncrease, 0);
  // line 11: only the agent-issued adjustment (VAT)
  assert.equal(f.lines['11'].vatDecrease, 30000);
  assert.equal(f.lines['11'].vatIncrease, 0);
  // line 16 base cross-foot unchanged: 5,000,000 − 200,000 = 4,800,000
  assert.equal(f.lines['16'].base, 4800000);
});

test('vat-return-form: regular (8), agent-issued (11), and credit-adjusting (15) invoices coexist; line 16 VAT cross-foots 7+9 − 11.dec + 11.inc + 15.inc − 15.dec', () => {
  // Cross-foot invariant from decree N 298-Ն for the output side, now including line 15:
  //   line 16.vat = 7.vat + 9.vat + 10.vat − 11.vatDecrease + 11.vatIncrease
  //                 + 15.vatIncrease − 15.vatDecrease
  //   line 16.base = 7.base + 9.base + 12.base + 13.base + 14.base
  //                  − 8.baseDecrease + 8.baseIncrease
  // Pick a mix where only line 7 is present (9/10/12/13/14 are zero):
  //   7:  5,000,000 base / 1,000,000 vat
  //   8:  200,000 base dec
  //   11: 30,000 vat dec
  //   15: 20,000 vat inc
  // line 16.vat = 1,000,000 − 30,000 + 20,000 = 990,000
  const f = vatReturnForm({
    sales: [
      { netAmount: 5000000, vatRate: 20 }, // line 7
      { netAmount: 200000, vatRate: 20, adjusting: 'decrease' }, // line 8 (base)
      { netAmount: 150000, vatRate: 20, vatAmount: 30000, adjusting: 'decrease', adjustingInSupplierName: true }, // line 11
      { netAmount: 100000, vatRate: 20, vatAmount: 20000, adjusting: 'increase', adjustingToCredit: true }, // line 15
    ],
    purchases: [],
  });
  assert.equal(f.lines['7'].base, 5000000);
  assert.equal(f.lines['7'].vat, 1000000);
  assert.equal(f.lines['8'].baseDecrease, 200000);
  assert.equal(f.lines['8'].baseIncrease, 0);
  assert.equal(f.lines['11'].vatDecrease, 30000);
  assert.equal(f.lines['11'].vatIncrease, 0);
  assert.equal(f.lines['15'].vatDecrease, 0);
  assert.equal(f.lines['15'].vatIncrease, 20000);
  // base cross-foot: 5,000,000 − 200,000 = 4,800,000
  assert.equal(f.lines['16'].base, 4800000);
  // VAT cross-foot: 1,000,000 − 30,000 + 20,000 = 990,000
  assert.equal(f.lines['16'].vat, 990000);
  const v = validateVatReturnForm(f);
  assert.equal(v.ok, true, `unexpected errors: ${JSON.stringify(v.errors)}`);
});

test('vat-return-form: a sale flagged otherLiability routes VAT to line 10 (other VAT liability), with no leak to 7/8/9/11/15', () => {
  // Per decree N 298-Ն line 10 ("ԱԱՀ-ի գծով այլ հարկային պարտավորություն") is the
  // catch-all for OUTPUT VAT liabilities that do not fit any other bucket:
  // not a current-period 20% sale (line 7), not imputed (line 9), not zero-rated
  // (line 12), not exempt (line 13), and not a correcting invoice (lines 8/11/15).
  // Typical use: VAT self-assessed under a special regime, VAT on gambling/
  // lottery, or any other passthrough VAT liability the taxpayer owes on a
  // transaction that is not in the standard sale scope. Schema flag:
  // `otherLiability: true` (mirrors the boolean-pre-branch pattern used by
  // `art79` on the input side). The sale's net amount is intentionally NOT
  // tracked on line 10 (it carries VAT only); the base is irrelevant to this
  // bucket by decree design.
  const f = vatReturnForm({
    sales: [
      {
        netAmount: 250000,
        vatRate: 0, // explicit vatAmount overrides derived rate
        vatAmount: 50000,
        otherLiability: true,
      },
    ],
    purchases: [],
  });
  assert.equal(f.lines['10'].vat, 50000);
  // must NOT have leaked into the standard buckets
  assert.equal(f.lines['7'].base, 0);
  assert.equal(f.lines['7'].vat, 0);
  assert.equal(f.lines['9'].base, 0);
  assert.equal(f.lines['9'].vat, 0);
  assert.equal(f.lines['12'].base, 0);
  assert.equal(f.lines['13'].base, 0);
  // must NOT have leaked into the adjusting buckets
  assert.equal(f.lines['8'].baseDecrease, 0);
  assert.equal(f.lines['8'].baseIncrease, 0);
  assert.equal(f.lines['11'].vatDecrease, 0);
  assert.equal(f.lines['11'].vatIncrease, 0);
  assert.equal(f.lines['15'].vatDecrease, 0);
  assert.equal(f.lines['15'].vatIncrease, 0);
});

test('vat-return-form: lines 7/8/11/15/10 coexist; line 16 VAT cross-foots 7+9+10 − 11.dec + 11.inc + 15.inc − 15.dec', () => {
  // Cross-foot invariant from decree N 298-Ն for the output side, now with line 10:
  //   line 16.vat = 7.vat + 9.vat + 10.vat
  //                 − 11.vatDecrease + 11.vatIncrease
  //                 + 15.vatIncrease − 15.vatDecrease
  //   line 16.base = 7.base + 9.base + 12.base + 13.base + 14.base
  //                  − 8.baseDecrease + 8.baseIncrease
  // Pick a mix with line 10 contributing its VAT — additive only (no sub-cell
  // balance, no offsetting direction — line 10 has a single VAT cell per decree).
  //   7:  5,000,000 base / 1,000,000 vat
  //   8:  200,000 base dec
  //   10: 50,000 vat (other liability, passthrough)
  //   11: 30,000 vat dec
  //   15: 20,000 vat inc
  // line 16.vat = 1,000,000 + 50,000 − 30,000 + 20,000 = 1,040,000
  const f = vatReturnForm({
    sales: [
      { netAmount: 5000000, vatRate: 20 }, // line 7
      { netAmount: 200000, vatRate: 20, adjusting: 'decrease' }, // line 8 (base)
      {
        netAmount: 250000,
        vatRate: 0,
        vatAmount: 50000,
        otherLiability: true,
      }, // line 10 (other VAT liability)
      {
        netAmount: 150000,
        vatRate: 20,
        vatAmount: 30000,
        adjusting: 'decrease',
        adjustingInSupplierName: true,
      }, // line 11
      {
        netAmount: 100000,
        vatRate: 20,
        vatAmount: 20000,
        adjusting: 'increase',
        adjustingToCredit: true,
      }, // line 15
    ],
    purchases: [],
  });
  assert.equal(f.lines['7'].base, 5000000);
  assert.equal(f.lines['7'].vat, 1000000);
  assert.equal(f.lines['8'].baseDecrease, 200000);
  assert.equal(f.lines['8'].baseIncrease, 0);
  assert.equal(f.lines['10'].vat, 50000);
  assert.equal(f.lines['11'].vatDecrease, 30000);
  assert.equal(f.lines['11'].vatIncrease, 0);
  assert.equal(f.lines['15'].vatDecrease, 0);
  assert.equal(f.lines['15'].vatIncrease, 20000);
  // base cross-foot: 5,000,000 − 200,000 = 4,800,000
  assert.equal(f.lines['16'].base, 4800000);
  // VAT cross-foot: 1,000,000 + 50,000 − 30,000 + 20,000 = 1,040,000
  assert.equal(f.lines['16'].vat, 1040000);
  const v = validateVatReturnForm(f);
  assert.equal(v.ok, true, `unexpected errors: ${JSON.stringify(v.errors)}`);
});

test('vat-return-form: line 21 VAT reflects purchase correcting-invoice adjustments (17+18 − 19.dec + 19.inc)', () => {
  // Cross-foot invariant from decree N 298-Ն for the input side:
  //   line 21.vat = 17.vat + 18.vat − 19.vatDecrease + 19.vatIncrease + 20.inc − 20.dec
  // Pick a realistic mix where current acquisitions dominate so line 21 stays
  // non-negative (the form validator blocks negative totals). 1,000,000-base
  // domestic purchase (200,000 VAT) + 30,000 correcting dec + 5,000 correcting inc
  // = 175,000 — exactly the −dec +inc cross-foot.
  const f = vatReturnForm({
    sales: [{ netAmount: 5000000, vatRate: 20 }],
    purchases: [
      { netAmount: 1000000, vatRate: 20 }, // standard → line 18: vat 200000
      { netAmount: 150000, vatRate: 20, vatAmount: 30000, adjusting: 'decrease' }, // line 19 dec
      { netAmount: 25000, vatRate: 20, vatAmount: 5000, adjusting: 'increase' }, // line 19 inc
    ],
  });
  assert.equal(f.lines['18'].vat, 200000);
  assert.equal(f.lines['19'].vatDecrease, 30000);
  assert.equal(f.lines['19'].vatIncrease, 5000);
  assert.equal(f.lines['21'].vat, 175000); // 200000 − 30000 + 5000
  // validateVatReturnForm must accept this assembled form
  const v = validateVatReturnForm(f);
  assert.equal(v.ok, true, `unexpected errors: ${JSON.stringify(v.errors)}`);
});

test('vat-return-form: a purchase with adjustingToDebit routes VAT to line 20 sub-cell per direction (input VAT offset adjustment total)', () => {
  // Line 20 — decree N 298-Ն "Հաշվանցման ենթակա ԱԱՀ-ի գումարի ճշգրտման ընդհանուր գումար" —
  // is the INPUT-side mirror of line 15 (output VAT credit adjustment). It carries
  // a period-total adjustment of the input VAT offset (not a per-acquisition
  // correcting invoice like line 19). Routed amount is VAT (not base).
  // Per direction:
  //   adjusting=increase + adjustingToDebit → line 20.vatIncrease (more input credit)
  //   adjusting=decrease + adjustingToDebit → line 20.vatDecrease (refund input credit)
  // Schema flag: `adjustingToDebit: true` (mirrors output-side `adjustingToCredit`).
  const dec = vatReturnForm({
    sales: [],
    purchases: [
      {
        netAmount: 100000,
        vatRate: 20,
        vatAmount: 20000,
        adjusting: 'decrease',
        adjustingToDebit: true,
      },
    ],
  });
  assert.equal(dec.lines['20'].vatDecrease, 20000);
  assert.equal(dec.lines['20'].vatIncrease, 0);
  // offset-adjustment must NOT leak into line 18 (recoverable acquisitions) or
  // line 19 (per-acquisition correcting invoices).
  assert.equal(dec.lines['18'].base, 0);
  assert.equal(dec.lines['18'].vat, 0);
  assert.equal(dec.lines['19'].vatDecrease, 0);
  assert.equal(dec.lines['19'].vatIncrease, 0);

  const inc = vatReturnForm({
    sales: [],
    purchases: [
      {
        netAmount: 50000,
        vatRate: 20,
        vatAmount: 10000,
        adjusting: 'increase',
        adjustingToDebit: true,
      },
    ],
  });
  assert.equal(inc.lines['20'].vatDecrease, 0);
  assert.equal(inc.lines['20'].vatIncrease, 10000);
  assert.equal(inc.lines['18'].base, 0);
  assert.equal(inc.lines['18'].vat, 0);
  assert.equal(inc.lines['19'].vatDecrease, 0);
  assert.equal(inc.lines['19'].vatIncrease, 0);
});

test('vat-return-form: lines 17/18 + 19 (per-acq) + 20 (offset total) coexist; line 21 cross-foots 17+18 − 19.dec + 19.inc + 20.inc − 20.dec', () => {
  // Cross-foot invariant from decree N 298-Ն for the input side, now with line 20:
  //   line 21.vat = 17.vat + 18.vat − 19.vatDecrease + 19.vatIncrease
  //                 + 20.vatIncrease − 20.vatDecrease
  // Pick a realistic mix: a domestic 1M-base purchase (200k vat) for line 18,
  // a 30k line-19 decrease, a 5k line-19 increase, a 40k line-20 decrease,
  // a 15k line-20 increase. Line 21 = 200000 − 30000 + 5000 + 15000 − 40000 = 150000.
  const f = vatReturnForm({
    sales: [{ netAmount: 5000000, vatRate: 20 }],
    purchases: [
      { netAmount: 1000000, vatRate: 20 }, // standard → line 18: vat 200000
      { netAmount: 150000, vatRate: 20, vatAmount: 30000, adjusting: 'decrease' }, // line 19 dec
      { netAmount: 25000, vatRate: 20, vatAmount: 5000, adjusting: 'increase' }, // line 19 inc
      { netAmount: 200000, vatRate: 20, vatAmount: 40000, adjusting: 'decrease', adjustingToDebit: true }, // line 20 dec
      { netAmount: 75000, vatRate: 20, vatAmount: 15000, adjusting: 'increase', adjustingToDebit: true }, // line 20 inc
    ],
  });
  assert.equal(f.lines['18'].vat, 200000);
  assert.equal(f.lines['19'].vatDecrease, 30000);
  assert.equal(f.lines['19'].vatIncrease, 5000);
  assert.equal(f.lines['20'].vatDecrease, 40000);
  assert.equal(f.lines['20'].vatIncrease, 15000);
  assert.equal(f.lines['21'].vat, 150000); // 200000 − 30000 + 5000 + 15000 − 40000
  const v = validateVatReturnForm(f);
  assert.equal(v.ok, true, `unexpected errors: ${JSON.stringify(v.errors)}`);
});

test('vat-return-form: every line definition carries the same shape (section/labelHy/fields)', () => {
  const f = vatReturnForm({ sales: [], purchases: [] });
  for (const id of ['8', '10', '11', '14', '15', '19', '20', '22']) {
    const def = f.lineDefinitions[id];
    assert.ok(def, `line ${id} definition missing`);
    assert.ok(['output', 'input'].includes(def.section), `line ${id} section must be output or input`);
    assert.equal(typeof def.labelHy, 'string');
    assert.ok(def.labelHy.length > 0, `line ${id} labelHy must be non-empty`);
    assert.ok(Array.isArray([...def.fields]), `line ${id} fields must be an array`);
    assert.ok(def.fields.length > 0, `line ${id} must declare at least one field`);
  }
});
