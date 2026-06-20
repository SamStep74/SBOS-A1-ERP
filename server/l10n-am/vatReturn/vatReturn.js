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
  let importInputVat = 0;
  let domesticInputVat = 0;
  let taxablePurchases = 0;
  for (const p of purchases) {
    const { net, vat } = lineVat(p);
    taxablePurchases += net;
    if (p.recoverable === false) continue;
    inputVat += vat; // total recoverable input VAT (backward-compatible)
    if (p.source === 'import') importInputVat += vat;
    else domesticInputVat += vat;
  }

  const net = outputVat - inputVat;

  // --- wave-4: per-line helpers from decree N 298-Ն ---------------------------
  // Synthesize two virtual invoices (one for sales, one for purchases) so the
  // per-line helpers — which take a single invoice — can be reused both here
  // (period aggregation) and directly by callers operating on one invoice.
  const salesInvoice = { lines: sales };
  const purchasesInvoice = { lines: purchases };

  const totalTaxableBase =
    line7_totalTaxableBase(salesInvoice) + line7_totalTaxableBase(purchasesInvoice);
  const zeroRatedSupplies = line9_zeroRatedSupplies(salesInvoice);
  const exemptSupplies = line12_exemptSupplies(salesInvoice);
  const importsVatBase = line13_importsVatBase(purchasesInvoice);
  const reverseChargeVat =
    line16_reverseChargeVat(salesInvoice) + line16_reverseChargeVat(purchasesInvoice);
  const adjustments =
    line18_adjustments(salesInvoice) + line18_adjustments(purchasesInvoice);
  const inputVatCreditBase = line23_inputVatCreditBase(purchasesInvoice);

  // Line 21 headline (VAT to pay). importVat (output-side) defaults to 0 — no
  // entity in the current dataset re-sells imports to domestic customers under
  // a separate output tracking path; callers can pass it explicitly when needed.
  // Prior-period carry-forward is threaded through so this function reports
  // the actual banked credit (not just the clamped net). Callers that don't
  // pass a prior credit get the historical `payable = Math.max(0, net)`
  // behaviour (no carry-forward bookkeeping).
  const line21 = line21_vatToPay({
    outputVat,
    importVat: 0,
    reverseChargeVat,
    inputVat: domesticInputVat,
    importInputVat,
    adjustments,
  });

  return {
    outputVat,
    inputVat,
    taxableSales,
    taxablePurchases,
    net,
    payable: Math.max(0, net),
    creditCarried: Math.max(0, -net),
    // wave-4 new fields (decree N 298-Ն aggregate view):
    totalTaxableBase, // line 7
    zeroRatedSupplies, // line 9
    exemptSupplies, // line 12
    importsVatBase, // line 13
    reverseChargeVat, // line 16
    adjustments, // line 18
    vatToPay: line21.vatToPay, // line 21 (number, with prior credit applied; 0 if recoverable)
    carryForward: line21.carryForward, // line 21 banked credit for the next period
    inputVatCreditBase, // line 23
    // decomposition (split of inputVat for line-21 audit trail):
    domesticInputVat, // line 19 share of inputVat
    importInputVat, // line 20 share of inputVat
  };
}

// ---------------------------------------------------------------------------
// Per-line helpers (decree N 298-Ն) — pure functions on a single invoice or
// on a VAT decomposition. Each helper isolates one line of the official form
// so a finance UI can compute a single cell, recompute after a UI edit, or
// cross-foot check a single line in isolation. The numbers returned by these
// helpers feed straight into the corresponding VAT_RETURN_FORM_LINE_DEFINITIONS
// fields above; computeVatReturn() calls them to assemble the full period.
//
// Invoice shape: { lines: [{ netAmount, vatRate, vatAmount?, category?,
//                          source?, isReverseCharge?, recoverable? }],
//                   adjustments?: { increase, decrease } }
// All amounts are whole dram via roundAmd.
// ---------------------------------------------------------------------------

// Line 7 — Total taxable base (sum of all line items on the invoice, in AMD).
// This is the period-wide aggregate base across sales AND purchases; per the
// form, line 7 reports the 20% output base, but the aggregate view used by
// the CFO dashboard sums every line-item base regardless of bucket.
function line7_totalTaxableBase(invoice = {}) {
  const lines = invoice && invoice.lines ? invoice.lines : [];
  let total = 0;
  for (const l of lines) total += roundAmd(l.netAmount);
  return roundAmd(total);
}

// Line 9 — Zero-rated supplies (exports, international services, art. 65 RA Tax Code).
// A line is zero-rated when its vatRate is exactly 0 AND it is NOT explicitly
// marked category:'exempt' (exempt has its own line 12 in this view).
function line9_zeroRatedSupplies(invoice = {}) {
  const lines = invoice && invoice.lines ? invoice.lines : [];
  let total = 0;
  for (const l of lines) {
    const rate = Number(l.vatRate);
    if (rate === 0 && l.category !== 'exempt') total += roundAmd(l.netAmount);
  }
  return roundAmd(total);
}

// Line 12 — Exempt supplies (financial, medical, educational, art. 64 RA Tax Code).
// Identified by category:'exempt'. Exempt supplies add to the taxable base but
// carry no output VAT.
function line12_exemptSupplies(invoice = {}) {
  const lines = invoice && invoice.lines ? invoice.lines : [];
  let total = 0;
  for (const l of lines) {
    if (l.category === 'exempt') total += roundAmd(l.netAmount);
  }
  return roundAmd(total);
}

// Line 13 — Imports subject to VAT (base for import lines, RA Tax Code art. 71).
// Identified by source:'import'. Distinct from the form's "exempt supplies" line
// 13 in the official decree text — this aggregate line 13 is the CFO view's
// import-base bucket (matches form line 17 base in the existing engine).
function line13_importsVatBase(invoice = {}) {
  const lines = invoice && invoice.lines ? invoice.lines : [];
  let total = 0;
  for (const l of lines) {
    if (l.source === 'import') total += roundAmd(l.netAmount);
  }
  return roundAmd(total);
}

// Line 16 — Reverse-charge VAT (when the BUYER is the VAT agent, art. 72 RA Tax Code).
// Identified per line by isReverseCharge:true. Computes VAT at the standard rate
// unless the line declares its own vatRate.
function line16_reverseChargeVat(invoice = {}) {
  const lines = invoice && invoice.lines ? invoice.lines : [];
  let total = 0;
  for (const l of lines) {
    if (l.isReverseCharge !== true) continue;
    const net = roundAmd(l.netAmount);
    const rate = Number(l.vatRate) || STANDARD_VAT_RATE;
    total += roundAmd((net * rate) / 100);
  }
  return roundAmd(total);
}

// Line 18 — Adjustments (corrections from prior periods, rounding). Net of
// invoice.adjustments.increase and .decrease. Defaults to 0 when not declared.
function line18_adjustments(invoice = {}) {
  const adj = (invoice && invoice.adjustments) || {};
  const increase = roundAmd(adj.increase || 0);
  const decrease = roundAmd(adj.decrease || 0);
  return roundAmd(increase - decrease);
}

// Line 21 — VAT to pay (the headline — most important number on the return).
// Aggregate per decree N 298-Ն:
//   net = outputVat (line 14)
//       + importVat (line 15, output-side imports)
//       + reverseChargeVat (line 16)
//       - inputVat (line 19, domestic input VAT)
//       - importInputVat (line 20, import input VAT credit)
//       + adjustments (line 18, net)
//
// The result is CLAMPED at 0 — Armenia does not refund excess input VAT
// automatically; the balance is carried forward to the next period.
// Per RA Tax Code art. 68, a negative net is banked — not refunded — and
// the carry-forward reduces the next period's payable (or grows the
// bank's balance if the next period is also negative).
//
// `priorPeriodCarryForward` (whole drams) is the banked credit from the
// previous period's return. It is subtracted from the current net:
//   - net >= priorCredit  → vatToPay = net - priorCredit, carryForward = 0
//   - net <  priorCredit  → vatToPay = 0, carryForward = priorCredit - net
//
// Returns `{ vatToPay, carryForward }` so the caller can persist the new
// carry-forward to the next period's input. The caller is responsible
// for the multi-period ledger (e.g. a `vat_carry_forward` table); this
// function is pure math on a single period's decomposition.
function line21_vatToPay(decomposition = {}, priorPeriodCarryForward = 0) {
  const d = decomposition || {};
  const outputVat = roundAmd(d.outputVat || 0);
  const importVat = roundAmd(d.importVat || 0);
  const reverseChargeVat = roundAmd(d.reverseChargeVat || 0);
  const inputVat = roundAmd(d.inputVat || 0);
  const importInputVat = roundAmd(d.importInputVat || 0);
  const adjustments = roundAmd(d.adjustments || 0);
  const net = roundAmd(
    outputVat + importVat + reverseChargeVat - inputVat - importInputVat + adjustments,
  );
  const prior = roundAmd(priorPeriodCarryForward || 0);
  // Prior-period carry-forward is a credit that REDUCES the current
  // period's payable (and absorbs it if larger than the current net).
  const total = roundAmd(net - prior);
  if (total >= 0) {
    return { vatToPay: total, carryForward: 0 };
  }
  // Current period also recoverable: the bank grows by the excess.
  return { vatToPay: 0, carryForward: -total };
}

// Line 23 — Total purchases subject to input VAT credit (recoverable base).
// Sum of netAmount across all recoverable purchase lines (excluding the
// non-recoverable ones flagged with recoverable:false). Maps to form line 18
// + line 17 base in the existing engine.
function line23_inputVatCreditBase(invoice = {}) {
  const lines = invoice && invoice.lines ? invoice.lines : [];
  let total = 0;
  for (const l of lines) {
    if (l.recoverable === false) continue;
    total += roundAmd(l.netAmount);
  }
  return roundAmd(total);
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
  };
  for (const s of sales) {
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
      8: { baseDecrease: 0, baseIncrease: 0 }, // correcting tax invoices (output base)
      9: { base: o.imputedBase, vat: o.imputedVat }, // 16.67% imputed
      10: { vat: 0 }, // other VAT liability
      11: { vatDecrease: 0, vatIncrease: 0 }, // correcting invoices issued outside supplier name
      12: { base: o.zeroBase }, // zero-rated (art. 65)
      13: { base: o.exemptBase }, // exempt (art. 64)
      14: { base: 0 }, // REPEALED 27.08.19 N 556-Ն (kept for backward compatibility)
      15: { vatIncrease: 0, vatDecrease: 0 }, // VAT credit adjustment
      16: { base: creditBase, vat: creditVat }, // total VAT credit (output)
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
  // wave-4: per-line helpers (decree N 298-Ն aggregate view)
  line7_totalTaxableBase,
  line9_zeroRatedSupplies,
  line12_exemptSupplies,
  line13_importsVatBase,
  line16_reverseChargeVat,
  line18_adjustments,
  line21_vatToPay,
  line23_inputVatCreditBase,
};
