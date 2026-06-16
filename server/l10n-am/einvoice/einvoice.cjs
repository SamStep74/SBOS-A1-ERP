// E-invoice XML builder — Armenian invoice export engine.
//
// Produces a structured e-invoice document (ported from the A1 schema
// `urn:hayhashvapah:einvoice:1`), improved with MULTI-LINE support, whole-dram AMD
// amounts (via the localization kernel), and the official SRC e-invoice field set
// (per the SRC e-Invoicing User Guide): transaction type (Գործարքի տեսակ, mandatory
// since 2025-03-01), supplier VAT-payer reg № (ԱԱՀՎՀՀ), buyer passport fallback when
// no ՀՎՀՀ, and per-line unit price / excise / environmental fee.
//
// This is a structured EXPORT the user maps to the official SRC (src.am) e-invoice
// XSD before upload — the XSD ships inside the SRC desktop program (not published
// publicly) and submission requires the client's own SRC account + certificate, so
// the formal XSD mapping and submission are intentionally out of scope. Element
// names below are our representation of the official fields.
//
// Pure functions, no I/O.

const { roundAmd, isValidHvhh } = require("../localization.cjs");

const EINVOICE_NAMESPACE = "urn:hayhashvapah:einvoice:1";

// VAT rates that may appear on an ISSUED e-invoice line: 20% standard and 0%
// (zero-rated / exempt, rendered as an empty rate). 16.67% is the IMPUTED rate
// used only when computing the VAT return — it is never an issued-invoice rate,
// so it is intentionally excluded here. No public XSD exists (it ships inside the
// SRC desktop program), so this is a STRUCTURAL compliance gate, not schema validation.
const ISSUED_INVOICE_VAT_RATES = [0, 20];
const MAX_LINE_DESCRIPTION = 256; // official: line item name ≤ 256 characters

function str(value) {
  return String(value == null ? "" : value).trim();
}

function xmlEscape(value) {
  return String(value == null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Normalize a raw line into integer-dram amounts. Computes VAT from net*rate and the
// line total (= net + VAT + excise + env-fee, per the official form) unless provided.
function normalizeLine(line = {}) {
  const net = roundAmd(line.netAmount);
  const rate = Number(line.vatRate) || 0;
  const vat = line.vatAmount != null ? roundAmd(line.vatAmount) : roundAmd((net * rate) / 100);
  const excise = roundAmd(line.exciseAmount); // defaults 0
  const envFee = roundAmd(line.envFee); // defaults 0
  const rawQuantity = line.quantity != null ? Number(line.quantity) : 1;
  const quantity = Number.isFinite(rawQuantity) ? rawQuantity : 0; // never emit NaN
  const unitPrice = line.unitPrice != null
    ? roundAmd(line.unitPrice)
    : (quantity ? roundAmd(net / quantity) : 0);
  const total = line.lineTotal != null
    ? roundAmd(line.lineTotal)
    : roundAmd(net + vat + excise + envFee);
  return { description: line.description || "", quantity, unitPrice, net, rate, vat, excise, envFee, total };
}

function eInvoiceTotals(lines) {
  return (lines || []).map(normalizeLine).reduce(
    (a, l) => ({
      net: a.net + l.net, vat: a.vat + l.vat,
      excise: a.excise + l.excise, envFee: a.envFee + l.envFee, total: a.total + l.total,
    }),
    { net: 0, vat: 0, excise: 0, envFee: 0, total: 0 },
  );
}

function buildEInvoiceXml(invoice = {}) {
  const {
    number = "", issueDate = "", creationDate = "", dueDate = "", currency = "AMD",
    transactionType = "", supplier = {}, buyer = {}, lines = [],
  } = invoice;
  const norm = (lines || []).map(normalizeLine);
  const totals = norm.reduce(
    (a, l) => ({
      net: a.net + l.net, vat: a.vat + l.vat,
      excise: a.excise + l.excise, envFee: a.envFee + l.envFee, total: a.total + l.total,
    }),
    { net: 0, vat: 0, excise: 0, envFee: 0, total: 0 },
  );

  // Buyer identification: ՀՎՀՀ (TaxId) for organizations, else passport for individuals.
  const buyerId = (buyer.hvhh || buyer.taxId)
    ? `    <TaxId>${xmlEscape(buyer.hvhh || buyer.taxId)}</TaxId>`
    : (buyer.passport ? `    <PassportSeries>${xmlEscape(buyer.passport)}</PassportSeries>` : "    <TaxId/>");

  const out = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<!-- A1 e-invoice export. Map fields to the official SRC e-invoice XSD",
    "     (https://src.am) before upload; submission requires the client's SRC account/certificate. -->",
    `<EInvoice xmlns="${EINVOICE_NAMESPACE}" currency="${xmlEscape(currency)}">`,
    `  <Number>${xmlEscape(number)}</Number>`,
    `  <TransactionType>${xmlEscape(transactionType)}</TransactionType>`,
    `  <IssueDate>${xmlEscape(String(issueDate).slice(0, 10))}</IssueDate>`,
    `  <CreationDate>${xmlEscape(String(creationDate || issueDate).slice(0, 10))}</CreationDate>`,
    `  <DueDate>${xmlEscape(String(dueDate || "").slice(0, 10))}</DueDate>`,
    "  <Supplier>",
    `    <Name>${xmlEscape(supplier.name)}</Name>`,
    `    <TaxId>${xmlEscape(supplier.hvhh || supplier.taxId || "")}</TaxId>`,
    `    <VatId>${xmlEscape(supplier.vatId || "")}</VatId>`,
    `    <Address>${xmlEscape(supplier.address || "")}</Address>`,
    "  </Supplier>",
    "  <Buyer>",
    `    <Name>${xmlEscape(buyer.name)}</Name>`,
    buyerId,
    `    <Address>${xmlEscape(buyer.address || "")}</Address>`,
    "  </Buyer>",
    "  <Lines>",
  ];
  for (const l of norm) {
    out.push(
      "    <Line>",
      `      <Description>${xmlEscape(l.description)}</Description>`,
      `      <Quantity>${l.quantity}</Quantity>`,
      `      <UnitPrice>${l.unitPrice}</UnitPrice>`,
      `      <NetAmount>${l.net}</NetAmount>`,
      `      <ExciseAmount>${l.excise}</ExciseAmount>`,
      `      <EnvFee>${l.envFee}</EnvFee>`,
      `      <VatRate>${l.rate}</VatRate>`,
      `      <VatAmount>${l.vat}</VatAmount>`,
      `      <LineTotal>${l.total}</LineTotal>`,
      "    </Line>",
    );
  }
  out.push(
    "  </Lines>",
    "  <Totals>",
    `    <TotalNet>${totals.net}</TotalNet>`,
    `    <TotalExcise>${totals.excise}</TotalExcise>`,
    `    <TotalEnvFee>${totals.envFee}</TotalEnvFee>`,
    `    <TotalVat>${totals.vat}</TotalVat>`,
    `    <TotalAmount>${totals.total}</TotalAmount>`,
    "  </Totals>",
    "</EInvoice>",
  );
  return out.join("\n");
}

// Structural compliance gate for an e-invoice BEFORE it is mapped to the official
// SRC XSD and submitted. Returns { ok, errors:[{field, code, message}] } and never
// throws on malformed input, so callers can validate-then-build (submission) or
// build-raw (drafts/previews). Fails CLOSED on every mandatory SRC field.
function validateEInvoice(invoice = {}) {
  const inv = invoice || {};
  const errors = [];
  const add = (field, code, message) => errors.push({ field, code, message });

  if (!str(inv.transactionType)) {
    add(
      "transactionType",
      "MISSING_TRANSACTION_TYPE",
      "Գործարքի տեսակ (transaction type) is mandatory for SRC e-invoices since 2025-03-01.",
    );
  }

  if (!str(inv.number)) {
    add("number", "MISSING_NUMBER", "Invoice number/series is required.");
  }

  const issueDate = str(inv.issueDate);
  if (!issueDate) {
    add("issueDate", "MISSING_ISSUE_DATE", "Issue date is required.");
  } else if (!/^\d{4}-\d{2}-\d{2}/.test(issueDate)) {
    add("issueDate", "INVALID_ISSUE_DATE", "Issue date must be ISO format (YYYY-MM-DD).");
  }

  const supplier = inv.supplier || {};
  if (!str(supplier.name)) {
    add("supplier.name", "MISSING_SUPPLIER_NAME", "Supplier name is required.");
  }
  const supplierHvhh = str(supplier.hvhh || supplier.taxId);
  if (!supplierHvhh) {
    add("supplier.hvhh", "MISSING_SUPPLIER_HVHH", "Supplier ՀՎՀՀ (tax ID) is required.");
  } else if (!isValidHvhh(supplierHvhh)) {
    add("supplier.hvhh", "INVALID_SUPPLIER_HVHH", "Supplier ՀՎՀՀ is malformed (expected 8 digits).");
  }

  // Buyer is identified by ՀՎՀՀ (organization) OR a passport (individual) — one is required.
  const buyer = inv.buyer || {};
  const buyerHvhh = str(buyer.hvhh || buyer.taxId);
  const buyerPassport = str(buyer.passport);
  if (!buyerHvhh && !buyerPassport) {
    add(
      "buyer",
      "MISSING_BUYER_ID",
      "Buyer must be identified by ՀՎՀՀ (organization) or passport (individual).",
    );
  } else if (buyerHvhh && !isValidHvhh(buyerHvhh)) {
    add("buyer.hvhh", "INVALID_BUYER_HVHH", "Buyer ՀՎՀՀ is malformed (expected 8 digits).");
  }

  const lines = Array.isArray(inv.lines) ? inv.lines : [];
  if (lines.length === 0) {
    add("lines", "NO_LINES", "At least one invoice line is required.");
  } else {
    lines.forEach((line, i) => {
      const pos = i + 1; // 1-based positional path, e.g. lines[2].description
      const l = line || {};
      const description = str(l.description);
      if (!description || description.length > MAX_LINE_DESCRIPTION) {
        add(
          `lines[${pos}].description`,
          "INVALID_LINE_DESCRIPTION",
          `Line description is required and must be ≤ ${MAX_LINE_DESCRIPTION} characters.`,
        );
      }
      const quantity = l.quantity != null ? Number(l.quantity) : 1;
      if (!Number.isFinite(quantity) || quantity <= 0) {
        add(`lines[${pos}].quantity`, "INVALID_LINE_QUANTITY", "Line quantity must be a positive number.");
      }
      const net = l.netAmount != null ? Number(l.netAmount) : 0;
      if (!Number.isFinite(net) || net < 0) {
        add(`lines[${pos}].netAmount`, "INVALID_LINE_NET", "Line net amount must be a non-negative number.");
      }
      const rate = str(l.vatRate) !== "" ? Number(l.vatRate) : 0;
      if (!ISSUED_INVOICE_VAT_RATES.includes(rate)) {
        add(
          `lines[${pos}].vatRate`,
          "INVALID_LINE_VAT_RATE",
          `Line VAT rate must be ${ISSUED_INVOICE_VAT_RATES.join("% or ")}% (16.67% is imputed — VAT-return only).`,
        );
      }
      // If an explicit VAT amount is supplied it must be consistent with the line's
      // rate (whole-dram). Otherwise a line could claim 20% yet declare VAT 0 and
      // still pass the gate. Skipped when vatAmount is absent (it is then derived).
      if (l.vatAmount != null && str(l.vatAmount) !== "") {
        const declaredVat = Number(l.vatAmount);
        if (!Number.isFinite(declaredVat)) {
          add(`lines[${pos}].vatAmount`, "INVALID_LINE_VAT_AMOUNT", "Line VAT amount must be a number.");
        } else {
          const expectedVat = Math.round((net * rate) / 100);
          if (Math.abs(declaredVat - expectedVat) > 1) {
            add(
              `lines[${pos}].vatAmount`,
              "LINE_VAT_MISMATCH",
              `Line VAT amount ${declaredVat} is inconsistent with ${rate}% of net ${net} (expected ~${expectedVat}).`,
            );
          }
        }
      }
    });
  }

  return { ok: errors.length === 0, errors };
}

module.exports = {
  EINVOICE_NAMESPACE,
  ISSUED_INVOICE_VAT_RATES,
  xmlEscape,
  normalizeLine,
  eInvoiceTotals,
  buildEInvoiceXml,
  validateEInvoice,
};
