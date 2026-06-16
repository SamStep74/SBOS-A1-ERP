import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEInvoiceXml, eInvoiceTotals, EINVOICE_NAMESPACE } from './einvoice.js';

const sample = {
  number: 'INV-001',
  issueDate: '2026-06-05',
  dueDate: '2026-07-05',
  currency: 'AMD',
  supplier: { name: 'Իմ Ընկերություն ՍՊԸ', hvhh: '00123456' },
  buyer: { name: 'Գնորդ ՍՊԸ', hvhh: '00987654' },
  lines: [
    { description: 'Ծառայություն', netAmount: 100000, vatRate: 20 },
    { description: 'Ապրանք & <pre>', netAmount: 50000, vatRate: 20 },
  ],
};

test('einvoice: builds a well-formed EInvoice document with the namespace', () => {
  const xml = buildEInvoiceXml(sample);
  assert.match(xml, /^<\?xml version="1\.0" encoding="UTF-8"\?>/);
  assert.ok(xml.includes(`<EInvoice xmlns="${EINVOICE_NAMESPACE}"`));
  assert.ok(xml.includes('<Number>INV-001</Number>'));
  assert.ok(xml.includes('<IssueDate>2026-06-05</IssueDate>'));
  assert.ok(xml.trimEnd().endsWith('</EInvoice>'));
});

test('einvoice: includes supplier and buyer with ՀՎՀՀ as TaxId', () => {
  const xml = buildEInvoiceXml(sample);
  assert.ok(xml.includes('<Name>Իմ Ընկերություն ՍՊԸ</Name>'));
  assert.ok(xml.includes('<TaxId>00123456</TaxId>'));
  assert.ok(xml.includes('<TaxId>00987654</TaxId>'));
});

test('einvoice: supports multiple line items (improvement over single-line)', () => {
  const xml = buildEInvoiceXml(sample);
  assert.equal((xml.match(/<Line>/g) || []).length, 2);
});

test('einvoice: computes per-line VAT from net*rate and rolls up integer-dram totals', () => {
  const xml = buildEInvoiceXml(sample);
  assert.ok(xml.includes('<TotalNet>150000</TotalNet>'));
  assert.ok(xml.includes('<TotalVat>30000</TotalVat>'));
  assert.ok(xml.includes('<TotalAmount>180000</TotalAmount>'));
});

test('einvoice: XML-escapes special characters in free text', () => {
  const xml = buildEInvoiceXml(sample);
  assert.ok(xml.includes('Ապրանք &amp; &lt;pre&gt;'));
  assert.ok(!xml.includes('Ապրանք & <pre>'));
});

test('einvoice: eInvoiceTotals sums net, vat, total across lines (whole dram)', () => {
  const t = eInvoiceTotals(sample.lines);
  assert.equal(t.net, 150000);
  assert.equal(t.vat, 30000);
  assert.equal(t.total, 180000);
});

test('einvoice: an explicit per-line vatAmount overrides the computed one', () => {
  const t = eInvoiceTotals([{ netAmount: 100000, vatRate: 20, vatAmount: 0 }]); // exempt line
  assert.equal(t.vat, 0);
  assert.equal(t.total, 100000);
});

test('einvoice: emits the official transaction type and a distinct creation date', () => {
  const xml = buildEInvoiceXml({ ...sample, transactionType: '2', creationDate: '2026-06-04' });
  assert.ok(xml.includes('<TransactionType>2</TransactionType>'));
  assert.ok(xml.includes('<CreationDate>2026-06-04</CreationDate>'));
});

test('einvoice: creation date defaults to the issue date when omitted', () => {
  const xml = buildEInvoiceXml({ ...sample });
  assert.ok(xml.includes('<CreationDate>2026-06-05</CreationDate>')); // = issueDate
});

test('einvoice: supplier carries the VAT-payer reg number (ԱԱՀՎՀՀ)', () => {
  const xml = buildEInvoiceXml({
    ...sample,
    supplier: { name: 'Ս', hvhh: '00123456', vatId: '1234567' },
  });
  assert.ok(xml.includes('<VatId>1234567</VatId>'));
});

test('einvoice: an individual buyer with no ՀՎՀՀ is identified by passport', () => {
  const xml = buildEInvoiceXml({ ...sample, buyer: { name: 'Անձ', passport: 'AN1234567' } });
  assert.ok(xml.includes('<PassportSeries>AN1234567</PassportSeries>'));
  assert.ok(!xml.includes('<TaxId>AN1234567'));
});

test('einvoice: a line carries unit price, excise and env-fee; total includes them', () => {
  const xml = buildEInvoiceXml({
    ...sample,
    lines: [
      {
        description: 'Ապ',
        quantity: 2,
        netAmount: 100000,
        vatRate: 20,
        exciseAmount: 5000,
        envFee: 1000,
      },
    ],
  });
  assert.ok(xml.includes('<UnitPrice>50000</UnitPrice>')); // 100000 / 2
  assert.ok(xml.includes('<ExciseAmount>5000</ExciseAmount>'));
  assert.ok(xml.includes('<EnvFee>1000</EnvFee>'));
  assert.ok(xml.includes('<LineTotal>126000</LineTotal>')); // 100000 + 20000 + 5000 + 1000
  assert.ok(xml.includes('<TotalExcise>5000</TotalExcise>'));
});
