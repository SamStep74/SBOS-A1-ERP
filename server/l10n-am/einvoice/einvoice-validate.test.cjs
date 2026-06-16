const test = require("node:test");
const assert = require("node:assert/strict");
const { validateEInvoice, buildEInvoiceXml } = require("./einvoice.cjs");

// A fully compliant invoice per the SRC e-Invoicing field set: transaction type
// (Գործարքի տեսակ, mandatory since 2025-03-01), supplier ՀՎՀՀ + name, buyer
// identified by ՀՎՀՀ (org) or passport (individual), and at least one line.
const compliant = {
  number: "INV-001",
  issueDate: "2026-06-05",
  transactionType: "1", // 1 = ordinary sale (Գործարքի տեսակ)
  supplier: { name: "Իմ Ընկերություն ՍՊԸ", hvhh: "00123456" },
  buyer: { name: "Գնորդ ՍՊԸ", hvhh: "00987654" },
  lines: [
    { description: "Ծառայություն", netAmount: 100000, vatRate: 20 },
    { description: "Ապրանք", netAmount: 50000, vatRate: 0 },
  ],
};

function codes(result) {
  return result.errors.map((e) => e.code);
}

test("validateEInvoice: a compliant invoice passes with no errors", () => {
  const result = validateEInvoice(compliant);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateEInvoice: ok is exactly (errors.length === 0)", () => {
  const good = validateEInvoice(compliant);
  assert.equal(good.ok, good.errors.length === 0);
  const bad = validateEInvoice({});
  assert.equal(bad.ok, bad.errors.length === 0);
  assert.equal(bad.ok, false);
});

test("validateEInvoice: every error is {field, code, message}", () => {
  const result = validateEInvoice({});
  assert.ok(result.errors.length > 0);
  for (const err of result.errors) {
    assert.equal(typeof err.field, "string");
    assert.equal(typeof err.code, "string");
    assert.equal(typeof err.message, "string");
    assert.ok(err.field.length > 0 && err.code.length > 0 && err.message.length > 0);
  }
});

test("validateEInvoice: missing transaction type is rejected (mandatory since 2025-03-01)", () => {
  const result = validateEInvoice({ ...compliant, transactionType: "" });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("MISSING_TRANSACTION_TYPE"));
});

test("validateEInvoice: missing invoice number is rejected", () => {
  const result = validateEInvoice({ ...compliant, number: "  " });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("MISSING_NUMBER"));
});

test("validateEInvoice: missing issue date is rejected", () => {
  const result = validateEInvoice({ ...compliant, issueDate: "" });
  assert.ok(codes(result).includes("MISSING_ISSUE_DATE"));
});

test("validateEInvoice: malformed issue date is rejected", () => {
  const result = validateEInvoice({ ...compliant, issueDate: "06/05/2026" });
  assert.ok(codes(result).includes("INVALID_ISSUE_DATE"));
});

test("validateEInvoice: missing supplier name is rejected", () => {
  const result = validateEInvoice({ ...compliant, supplier: { hvhh: "00123456" } });
  assert.ok(codes(result).includes("MISSING_SUPPLIER_NAME"));
});

test("validateEInvoice: missing supplier ՀՎՀՀ is rejected", () => {
  const result = validateEInvoice({ ...compliant, supplier: { name: "X" } });
  assert.ok(codes(result).includes("MISSING_SUPPLIER_HVHH"));
});

test("validateEInvoice: malformed supplier ՀՎՀՀ is rejected", () => {
  const result = validateEInvoice({ ...compliant, supplier: { name: "X", hvhh: "123" } });
  assert.ok(codes(result).includes("INVALID_SUPPLIER_HVHH"));
});

test("validateEInvoice: buyer with neither ՀՎՀՀ nor passport is rejected", () => {
  const result = validateEInvoice({ ...compliant, buyer: { name: "Անհատ" } });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("MISSING_BUYER_ID"));
});

test("validateEInvoice: buyer identified by passport (individual) is accepted", () => {
  const result = validateEInvoice({
    ...compliant,
    buyer: { name: "Անհատ Անձ", passport: "AN1234567" },
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validateEInvoice: malformed buyer ՀՎՀՀ is rejected", () => {
  const result = validateEInvoice({ ...compliant, buyer: { name: "Գ", hvhh: "99" } });
  assert.ok(codes(result).includes("INVALID_BUYER_HVHH"));
});

test("validateEInvoice: an invoice with no lines is rejected", () => {
  const result = validateEInvoice({ ...compliant, lines: [] });
  assert.equal(result.ok, false);
  assert.ok(codes(result).includes("NO_LINES"));
});

test("validateEInvoice: a line with empty description is rejected", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [{ description: "  ", netAmount: 1000, vatRate: 20 }],
  });
  assert.ok(codes(result).includes("INVALID_LINE_DESCRIPTION"));
});

test("validateEInvoice: a line description over 256 chars is rejected", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [{ description: "ա".repeat(257), netAmount: 1000, vatRate: 20 }],
  });
  assert.ok(codes(result).includes("INVALID_LINE_DESCRIPTION"));
});

test("validateEInvoice: a line with non-positive quantity is rejected", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [{ description: "X", quantity: 0, netAmount: 1000, vatRate: 20 }],
  });
  assert.ok(codes(result).includes("INVALID_LINE_QUANTITY"));
});

test("validateEInvoice: a line with a missing quantity defaults to 1 and is accepted", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [{ description: "X", netAmount: 1000, vatRate: 20 }],
  });
  assert.equal(result.ok, true, JSON.stringify(result.errors));
});

test("validateEInvoice: a line with a negative net amount is rejected", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [{ description: "X", netAmount: -1, vatRate: 20 }],
  });
  assert.ok(codes(result).includes("INVALID_LINE_NET"));
});

test("validateEInvoice: a line with an unsupported VAT rate is rejected", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [{ description: "X", netAmount: 1000, vatRate: 17 }],
  });
  assert.ok(codes(result).includes("INVALID_LINE_VAT_RATE"));
});

test("validateEInvoice: line errors carry a 1-based positional field path", () => {
  const result = validateEInvoice({
    ...compliant,
    lines: [
      { description: "ok", netAmount: 1000, vatRate: 20 },
      { description: "", netAmount: 1000, vatRate: 20 },
    ],
  });
  const lineErr = result.errors.find((e) => e.code === "INVALID_LINE_DESCRIPTION");
  assert.ok(lineErr);
  assert.equal(lineErr.field, "lines[2].description");
});

test("validateEInvoice: an empty invoice reports many distinct errors, never throws", () => {
  const result = validateEInvoice({});
  assert.equal(result.ok, false);
  const set = new Set(codes(result));
  assert.ok(set.has("MISSING_TRANSACTION_TYPE"));
  assert.ok(set.has("MISSING_NUMBER"));
  assert.ok(set.has("MISSING_SUPPLIER_NAME"));
  assert.ok(set.has("MISSING_BUYER_ID"));
  assert.ok(set.has("NO_LINES"));
});

test("validateEInvoice: validate-then-build yields a document for a compliant invoice", () => {
  const result = validateEInvoice(compliant);
  assert.equal(result.ok, true);
  const xml = buildEInvoiceXml(compliant);
  assert.ok(xml.includes("<TransactionType>1</TransactionType>"));
});
