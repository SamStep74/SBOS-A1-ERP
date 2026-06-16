import test from 'node:test';
import assert from 'node:assert/strict';
import { validateEInvoice, buildEInvoiceXml } from './einvoice.js';

const base = {
  number: 'INV-1',
  issueDate: '2026-06-06',
  transactionType: '1',
  supplier: { name: 'Մատակարար ՍՊԸ', hvhh: '00123456' },
  buyer: { name: 'Գնորդ ՍՊԸ', hvhh: '00987654' },
};

function codes(result) {
  return result.errors.map((e) => e.code);
}

test('line consistency: a line declaring 20% but VAT amount 0 is rejected', () => {
  const result = validateEInvoice({
    ...base,
    lines: [{ description: 'Ծառայություն', netAmount: 100000, vatRate: 20, vatAmount: 0 }],
  });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes('LINE_VAT_MISMATCH'));
});

test('line consistency: a line with a consistent explicit VAT amount passes', () => {
  const result = validateEInvoice({
    ...base,
    lines: [{ description: 'Ծառայություն', netAmount: 100000, vatRate: 20, vatAmount: 20000 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('line consistency: a 0% line with VAT amount 0 passes', () => {
  const result = validateEInvoice({
    ...base,
    lines: [{ description: 'Արտահանում', netAmount: 100000, vatRate: 0, vatAmount: 0 }],
  });
  assert.ok(!codes(result).includes('LINE_VAT_MISMATCH'));
});

test('line consistency: a line with no explicit VAT amount is not cross-checked', () => {
  const result = validateEInvoice({
    ...base,
    lines: [{ description: 'Ծառայություն', netAmount: 100000, vatRate: 20 }],
  });
  assert.ok(!codes(result).includes('LINE_VAT_MISMATCH'));
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test('line consistency: a non-numeric explicit VAT amount is rejected', () => {
  const result = validateEInvoice({
    ...base,
    lines: [{ description: 'Ծառայություն', netAmount: 100000, vatRate: 20, vatAmount: 'lots' }],
  });
  assert.ok(codes(result).includes('INVALID_LINE_VAT_AMOUNT'));
});

test('builder: a non-finite quantity renders a finite number, never NaN', () => {
  const xml = buildEInvoiceXml({
    ...base,
    lines: [{ description: 'X', netAmount: 1000, vatRate: 20, quantity: '1<x' }],
  });
  assert.ok(!xml.includes('NaN'), 'XML must not contain NaN');
  assert.ok(xml.includes('<Quantity>0</Quantity>'));
});
