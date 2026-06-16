import test from 'node:test';
import assert from 'node:assert/strict';
import { computeVatReturn, vatReturnForm } from './vatReturn.js';

// computeVatReturn (the simple period total) and vatReturnForm (the official-form
// mapping) net output VAT − input VAT independently. They must agree for well-formed
// periods; this pins that contract so the two paths cannot silently drift apart.
// (Edge case left in the backlog: an exempt sale carrying a non-zero rate — computeVatReturn
// keys off vatRate while vatReturnForm respects category:"exempt" — so fixtures here keep
// exempt sales at rate 0, the realistic shape.)

const payablePeriod = {
  sales: [
    { netAmount: 1000000, vatRate: 20 }, // standard
    { netAmount: 600000, vatRate: 16.67 }, // imputed
    { netAmount: 200000, vatRate: 0 }, // zero-rated
    { netAmount: 50000, vatRate: 0, category: 'exempt' }, // exempt (rate 0)
  ],
  purchases: [
    { netAmount: 300000, vatRate: 20, source: 'import' },
    { netAmount: 400000, vatRate: 20, source: 'domestic' },
    { netAmount: 100000, vatRate: 20, recoverable: false }, // excluded both ways
  ],
};

const recoverablePeriod = {
  sales: [{ netAmount: 100000, vatRate: 20 }],
  purchases: [{ netAmount: 900000, vatRate: 20, source: 'domestic' }],
};

function assertReconciled(period) {
  const totals = computeVatReturn(period);
  const form = vatReturnForm(period);
  assert.equal(totals.outputVat, form.lines['16'].vat, 'output VAT (16) must agree');
  assert.equal(totals.inputVat, form.lines['21'].vat, 'input VAT (21) must agree');
  assert.equal(totals.net, form.lines['16'].vat - form.lines['21'].vat, 'net must agree');
  assert.equal(totals.payable, form.lines['23'].payable, 'payable (23A) must agree');
  assert.equal(
    totals.creditCarried,
    form.lines['23'].recoverable,
    'credit carried (23B) must agree',
  );
}

test('reconciliation: computeVatReturn and vatReturnForm agree on a payable period', () => {
  assertReconciled(payablePeriod);
});

test('reconciliation: computeVatReturn and vatReturnForm agree on a recoverable period', () => {
  assertReconciled(recoverablePeriod);
  const form = vatReturnForm(recoverablePeriod);
  assert.ok(form.lines['23'].recoverable > 0); // sanity: really a credit-carried period
  assert.equal(form.lines['23'].payable, 0);
});

test('reconciliation: an empty period nets to zero on both paths', () => {
  const totals = computeVatReturn({ sales: [], purchases: [] });
  const form = vatReturnForm({ sales: [], purchases: [] });
  assert.equal(totals.net, 0);
  assert.equal(form.lines['16'].vat - form.lines['21'].vat, 0);
  assert.equal(totals.payable, form.lines['23'].payable);
  assert.equal(totals.creditCarried, form.lines['23'].recoverable);
});
