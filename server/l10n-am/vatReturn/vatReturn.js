// Armenian VAT return computation engine — RA finance kernel.
//
// Computes the period VAT position: output VAT (charged on sales) minus recoverable
// input VAT (paid on purchases) = net. A positive net is payable to the SRC; a
// negative net is a carried-forward credit (Armenia does not auto-refund — it carries).
// All amounts are whole dram via the localization kernel.
//
// The CALCULATION is standard RA VAT logic. vatReturnForm() additionally maps the
// figures onto the official SRC VAT-return form lines (decree N 298-Ն,
// arlis.am/hy/acts/136996): output lines 7/9/12/13/16, input lines 17/18/21, net 23.
// Pure functions, no I/O.

import { roundAmd } from '../localization.js';
import { t } from '../i18n.js';

const STANDARD_VAT_RATE = 20;
const IMPUTED_VAT_RATE = 16.67; // VAT fraction of a VAT-inclusive price (20/120); form line 9

const VAT_RETURN_FORM_SOURCE = Object.freeze({
  id: 'am-src-vat-excise-unified-return-n-298',
  titleHy: 'Ավելացված արժեքի հարկի և ակցիզային հարկի միասնական հաշվարկ',
  titleEn: 'VAT and excise tax unified return',
  authorityHy: 'ՀՀ կառավարությանն առընթեր պետական եկամուտների կոմիտեի նախագահ',
  orderNumber: 'N 298-Ն',
  adoptedDate: '2016-12-30',
  effectiveDate: '2018-01-01',
  sourceUrl: 'https://www.arlis.am/hy/acts/136996',
  status: 'active-incorporated',
});

const VAT_RETURN_FORM_LINE_DEFINITIONS = Object.freeze({
  7: Object.freeze({
    section: 'output',
    labelHy: 'ԱԱՀ-ի 20% դրույքաչափով հարկվող գործարքներ',
    fields: Object.freeze(['base', 'vat']),
  }),
  9: Object.freeze({
    section: 'output',
    labelHy: 'ԱԱՀ-ի 16.67% հաշվարկային դրույքաչափով հաշվարկվող գործարքներ',
    fields: Object.freeze(['base', 'vat']),
  }),
  12: Object.freeze({
    section: 'output',
    labelHy: 'ԱԱՀ-ի 0-ական դրույքաչափով հարկվող գործարքներ',
    fields: Object.freeze(['base']),
  }),
  8: Object.freeze({
    section: 'output',
    labelHy: 'Ճշգրտող հարկային հաշիվներով գործարքներ',
    fields: Object.freeze(['baseDecrease', 'baseIncrease']),
  }),
  10: Object.freeze({
    section: 'output',
    labelHy: 'ԱԱՀ-ի գծով այլ հարկային պարտավորություն',
    fields: Object.freeze(['vat']),
  }),
  11: Object.freeze({
    section: 'output',
    labelHy: 'Մատակարարի անունից դուրս գրված ճշգրտող հարկային հաշիվներով գործարքներ',
    fields: Object.freeze(['vatDecrease', 'vatIncrease']),
  }),
  13: Object.freeze({
    section: 'output',
    labelHy: 'ԱԱՀ-ից ազատված գործարքներ',
    fields: Object.freeze(['base']),
  }),
  14: Object.freeze({
    section: 'output',
    labelHy: '27.08.19 N 556-Ն ուժը կորցրել է (REPEALED)',
    fields: Object.freeze(['base']),
  }),
  15: Object.freeze({
    section: 'output',
    labelHy: 'Հաշվարկված ԱԱՀ-ի հարկային պարտավորությունների ճշգրտում (Ավելացում/Պակասեցում)',
    fields: Object.freeze(['vatIncrease', 'vatDecrease']),
  }),
  16: Object.freeze({
    section: 'output-total',
    labelHy: 'Ընդամենը ԱԱՀ-ի կրեդիտ',
    fields: Object.freeze(['base', 'vat']),
  }),
  17: Object.freeze({
    section: 'input',
    labelHy: 'ՀՀ տարածք ներմուծված ապրանքներ',
    fields: Object.freeze(['base', 'vat']),
  }),
  18: Object.freeze({
    section: 'input',
    labelHy: 'ՀՀ տարածքում ձեռք բերված ապրանքներ և ծառայություններ',
    fields: Object.freeze(['base', 'vat']),
  }),
  19: Object.freeze({
    section: 'input',
    labelHy: 'Ձեռքբերումներին վերաբերող ճշգրտող հարկային հաշիվներով գործարքներ',
    fields: Object.freeze(['vatDecrease', 'vatIncrease']),
  }),
  20: Object.freeze({
    section: 'input',
    labelHy: 'Հաշվանցման ենթակա ԱԱՀ-ի գումարի ճշգրտման ընդհանուր գումար',
    fields: Object.freeze(['vatIncrease', 'vatDecrease']),
  }),
  22: Object.freeze({
    section: 'input',
    labelHy: 'Ներմուծված այն ապրանքների, որոնց մասով հարկային օրենսգրքի 79-րդ հոդված',
    fields: Object.freeze(['base', 'vat']),
  }),
  21: Object.freeze({
    section: 'input-total',
    labelHy: 'Ընդամենը ԱԱՀ-ի դեբետ',
    fields: Object.freeze(['vat']),
  }),
  23: Object.freeze({
    section: 'period-net',
    labelHy: 'Հաշվետու ժամանակաշրջանի համար հաշվարկված ԱԱՀ',
    fields: Object.freeze(['payable', 'recoverable']),
  }),
});

function lineVat(line = {}) {
  const net = roundAmd(line.netAmount);
  const rate = Number(line.vatRate) || 0;
  const vat = line.vatAmount != null ? roundAmd(line.vatAmount) : roundAmd((net * rate) / 100);
  return { net, vat };
}

function computeVatReturn({ sales = [], purchases = [] } = {}) {
  let outputVat = 0;
  let taxableSales = 0;
  for (const s of sales) {
    const { net, vat } = lineVat(s);
    outputVat += vat;
    taxableSales += net;
  }

  let inputVat = 0;
  let taxablePurchases = 0;
  for (const p of purchases) {
    const { net, vat } = lineVat(p);
    taxablePurchases += net;
    if (p.recoverable !== false) inputVat += vat; // recoverable by default
  }

  const net = outputVat - inputVat;
  return {
    outputVat,
    inputVat,
    taxableSales,
    taxablePurchases,
    net,
    payable: Math.max(0, net),
    creditCarried: Math.max(0, -net),
  };
}

// Classify a sale into the official form's output buckets.
function classifySale(line = {}) {
  const net = roundAmd(line.netAmount);
  const rate = Number(line.vatRate) || 0;
  const vat = line.vatAmount != null ? roundAmd(line.vatAmount) : roundAmd((net * rate) / 100);
  if (line.category === 'exempt') return { bucket: 'exempt', net, vat: 0 }; // line 13, art. 64
  if (rate === 0) return { bucket: 'zero', net, vat: 0 }; // line 12, zero-rated, art. 65
  if (Math.abs(rate - IMPUTED_VAT_RATE) < 0.01) return { bucket: 'imputed', net, vat }; // line 9
  return { bucket: 'standard', net, vat }; // line 7, 20%
}

// Map a period onto the official SRC VAT-return form lines (decree N 298-Ն).
//   sales:     { netAmount, vatRate, vatAmount?, category?: "exempt" }
//   purchases: { netAmount, vatRate, vatAmount?, source?: "import"|"domestic", recoverable? }
// Each line gives { base, vat } (A = base առանց ԱԱՀ, B = VAT amount), whole dram.
function vatReturnForm({ sales = [], purchases = [] } = {}) {
  const o = {
    standardBase: 0,
    standardVat: 0,
    imputedBase: 0,
    imputedVat: 0,
    zeroBase: 0,
    exemptBase: 0,
    // Correcting tax invoices (Ճշգրտող հարկային հաշիվ) — decree N 298-Ն line 8.
    // Per direction: 'decrease' → baseDecrease, 'increase' → baseIncrease.
    // These sales do NOT roll into line 7 (current-period standard base).
    adjustingBaseDecrease: 0,
    adjustingBaseIncrease: 0,
  };
  for (const s of sales) {
    if (s.adjusting === 'decrease' || s.adjusting === 'increase') {
      const adjBase = roundAmd(s.netAmount);
      if (s.adjusting === 'decrease') o.adjustingBaseDecrease += adjBase;
      else o.adjustingBaseIncrease += adjBase;
      continue;
    }
    const c = classifySale(s);
    if (c.bucket === 'standard') {
      o.standardBase += c.net;
      o.standardVat += c.vat;
    } else if (c.bucket === 'imputed') {
      o.imputedBase += c.net;
      o.imputedVat += c.vat;
    } else if (c.bucket === 'zero') o.zeroBase += c.net;
    else o.exemptBase += c.net;
  }
  const creditBase = o.standardBase + o.imputedBase + o.zeroBase + o.exemptBase;
  const creditVat = o.standardVat + o.imputedVat;

  let importBase = 0,
    importVat = 0,
    domesticBase = 0,
    domesticVat = 0;
  for (const p of purchases) {
    if (p.recoverable === false) continue;
    const { net, vat } = lineVat(p);
    if (p.source === 'import') {
      importBase += net;
      importVat += vat;
    } else {
      domesticBase += net;
      domesticVat += vat;
    }
  }
  const debitVat = importVat + domesticVat;
  const net = creditVat - debitVat;

  return {
    source: VAT_RETURN_FORM_SOURCE,
    lineDefinitions: VAT_RETURN_FORM_LINE_DEFINITIONS,
    lines: {
      7: { base: o.standardBase, vat: o.standardVat }, // 20% taxable transactions
      8: {
        baseDecrease: o.adjustingBaseDecrease,
        baseIncrease: o.adjustingBaseIncrease,
      }, // correcting tax invoices (output base)
      9: { base: o.imputedBase, vat: o.imputedVat }, // 16.67% imputed
      10: { vat: 0 }, // other VAT liability
      11: { vatDecrease: 0, vatIncrease: 0 }, // correcting invoices issued outside supplier name
      12: { base: o.zeroBase }, // zero-rated (art. 65)
      13: { base: o.exemptBase }, // exempt (art. 64)
      14: { base: 0 }, // REPEALED 27.08.19 N 556-Ն (kept for backward compatibility)
      15: { vatIncrease: 0, vatDecrease: 0 }, // VAT credit adjustment
      16: {
        // Cross-foot per decree N 298-Ն: 7+9+12+13+14 bases − 8.dec + 8.inc.
        // creditBase already excludes adjusting invoices (they route to line 8).
        base: creditBase - o.adjustingBaseDecrease + o.adjustingBaseIncrease,
        vat: creditVat,
      }, // total VAT credit (output)
      17: { base: importBase, vat: importVat }, // imported goods
      18: { base: domesticBase, vat: domesticVat }, // domestic acquisitions
      19: { vatDecrease: 0, vatIncrease: 0 }, // acquisition correcting tax invoices
      20: { vatIncrease: 0, vatDecrease: 0 }, // offset VAT adjustment total
      21: { vat: debitVat }, // total VAT debit (input)
      22: { base: 0, vat: 0 }, // imports per Tax Code art. 79 (independent of 21)
      23: { payable: Math.max(0, net), recoverable: Math.max(0, -net) }, // net for the period
    },
  };
}

// Cross-foot guard for an assembled VAT-return form (the output of vatReturnForm,
// possibly after a UI edit). Confirms the official totals tie out EXACTLY — every
// line is whole-dram, so the totals are integer sums and need no tolerance:
//   line 16 base = 7+9+12+13 bases · 16 VAT = 7+9 VAT · 21 VAT = 17+18 VAT
//   line 23 = max(0, 16.vat − 21.vat) payable / recoverable
// Also flags missing lines, non-numeric / fractional / negative amounts. Returns
// { ok, errors:[{field, code, message}] } (same contract as validateEInvoice) and
// never throws — so a finance UI can fail closed before filing.
const VAT_FORM_REQUIRED_LINES = ['7', '9', '12', '13', '16', '17', '18', '21', '23'];
const VAT_FORM_LINE_AMOUNT_FIELDS = Object.freeze({
  7: ['base', 'vat'],
  8: ['baseDecrease', 'baseIncrease'],
  9: ['base', 'vat'],
  10: ['vat'],
  11: ['vatDecrease', 'vatIncrease'],
  12: ['base'],
  13: ['base'],
  14: ['base'],
  15: ['vatIncrease', 'vatDecrease'],
  16: ['base', 'vat'],
  17: ['base', 'vat'],
  18: ['base', 'vat'],
  19: ['vatDecrease', 'vatIncrease'],
  20: ['vatIncrease', 'vatDecrease'],
  21: ['vat'],
  22: ['base', 'vat'],
  23: ['payable', 'recoverable'],
});

function validateVatReturnForm(form = {}, { locale = 'en' } = {}) {
  const lines = (form && typeof form === 'object' && form.lines) || {};
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });

  for (const id of VAT_FORM_REQUIRED_LINES) {
    if (!lines[id] || typeof lines[id] !== 'object') {
      add(`lines.${id}`, 'FORM_MISSING_LINE', t(locale, 'vat.form.missingLine', { id }));
    }
  }

  for (const [id, fields] of Object.entries(VAT_FORM_LINE_AMOUNT_FIELDS)) {
    const line = lines[id];
    if (!line || typeof line !== 'object') continue;
    for (const f of fields) {
      if (line[f] == null) continue; // absence is covered by the cross-foot checks below
      const v = line[f];
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        add(
          `lines.${id}.${f}`,
          'FORM_NON_NUMERIC_AMOUNT',
          t(locale, 'vat.form.nonNumericAmount', { id, field: f }),
        );
        continue;
      }
      if (!Number.isInteger(v)) {
        add(
          `lines.${id}.${f}`,
          'FORM_NON_INTEGER_AMOUNT',
          t(locale, 'vat.form.nonIntegerAmount', { id, field: f }),
        );
      }
      if (v < 0) {
        add(
          `lines.${id}.${f}`,
          'FORM_NEGATIVE_AMOUNT',
          t(locale, 'vat.form.negativeAmount', { id, field: f }),
        );
      }
    }
  }

  // Read a numeric line amount, defaulting absent/invalid to 0 for the cross-foot math.
  const val = (id, f) => {
    const line = lines[id];
    const v = line ? line[f] : undefined;
    return typeof v === 'number' && Number.isFinite(v) ? v : 0;
  };
  const has = (...ids) => ids.every((id) => lines[id] && typeof lines[id] === 'object');

  if (has('16', '7', '9', '12', '13')) {
    const expected =
      val('7', 'base') +
      val('9', 'base') +
      val('12', 'base') +
      val('13', 'base') +
      val('14', 'base') -
      val('8', 'baseDecrease') +
      val('8', 'baseIncrease');
    if (val('16', 'base') !== expected) {
      add(
        'lines.16.base',
        'FORM_16_BASE_MISMATCH',
        t(locale, 'vat.form.line16BaseMismatch', {
          actual: val('16', 'base'),
          expected,
        }),
      );
    }
  }
  if (has('16', '7', '9')) {
    const expected =
      val('7', 'vat') +
      val('9', 'vat') +
      val('10', 'vat') -
      val('11', 'vatDecrease') +
      val('11', 'vatIncrease') +
      val('15', 'vatIncrease') -
      val('15', 'vatDecrease');
    if (val('16', 'vat') !== expected) {
      add(
        'lines.16.vat',
        'FORM_16_VAT_MISMATCH',
        t(locale, 'vat.form.line16VatMismatch', {
          actual: val('16', 'vat'),
          expected,
        }),
      );
    }
  }
  if (has('21', '17', '18')) {
    const expected =
      val('17', 'vat') +
      val('18', 'vat') -
      val('19', 'vatDecrease') +
      val('19', 'vatIncrease') +
      val('20', 'vatIncrease') -
      val('20', 'vatDecrease');
    if (val('21', 'vat') !== expected) {
      add(
        'lines.21.vat',
        'FORM_21_VAT_MISMATCH',
        t(locale, 'vat.form.line21VatMismatch', {
          actual: val('21', 'vat'),
          expected,
        }),
      );
    }
  }
  if (has('23', '16', '21')) {
    const net = val('16', 'vat') - val('21', 'vat');
    const payable = Math.max(0, net);
    const recoverable = Math.max(0, -net);
    if (val('23', 'payable') !== payable || val('23', 'recoverable') !== recoverable) {
      add(
        'lines.23',
        'FORM_23_NET_MISMATCH',
        t(locale, 'vat.form.line23NetMismatch', { payable, recoverable }),
      );
    }
  }

  // Rate-plausibility sanity band for the two rated output lines. The cross-foot above
  // proves the TOTALS tie out, but not that each line's VAT is consistent with its rate
  // — a UI edit could set line 7 base 1,000,000 / VAT 5 and still tie line 16. Because
  // base and VAT are each sums of per-line whole-dram roundings, an exact check would
  // false-positive on real filings, so we use a band (~1% of base + 2 dram) that absorbs
  // rounding drift while catching gross errors. Skips negative bases (already flagged).
  const rateBand = (id, ratePct) => {
    if (!has(id)) return;
    const base = val(id, 'base');
    if (base < 0) return; // negative cells are reported by FORM_NEGATIVE_AMOUNT
    const vat = val(id, 'vat');
    const expected = (base * ratePct) / 100;
    const tolerance = Math.max(2, Math.abs(base) * 0.01 + 2);
    if (Math.abs(vat - expected) > tolerance) {
      add(
        `lines.${id}.vat`,
        `FORM_${id}_RATE_MISMATCH`,
        t(locale, 'vat.form.rateMismatch', {
          id,
          actual: vat,
          base,
          rate: ratePct,
          expected: Math.round(expected),
          tolerance: Math.round(tolerance),
        }),
      );
    }
  };
  rateBand('7', STANDARD_VAT_RATE); // 20%
  rateBand('9', IMPUTED_VAT_RATE); // 16.67% imputed
  rateBand('17', STANDARD_VAT_RATE); // 20% imports
  rateBand('18', STANDARD_VAT_RATE); // 20% domestic acquisitions

  return { ok: errors.length === 0, errors };
}

export {
  STANDARD_VAT_RATE,
  IMPUTED_VAT_RATE,
  VAT_RETURN_FORM_SOURCE,
  VAT_RETURN_FORM_LINE_DEFINITIONS,
  computeVatReturn,
  vatReturnForm,
  validateVatReturnForm,
};
