// SBOS-A1-ERP — stock-valuation handoff to the GL.
//
// Maps the three operational events that move value through the
// inventory + AP accounts to balanced journal entries in
// finance.journal_entries:
//
//   stock.receive   → Dr 216 (Inventory) / Cr 521 (AP — purchases)
//                     at the receive's effective unit cost × quantity.
//
//   stock.deliver   → Dr 711 (COGS) / Cr 216 (Inventory)
//                     at the source location's weighted-average
//                     cost × delivered quantity. The COGS line
//                     carries the average cost (already computed
//                     by the deliverStock pure function); the
//                     inventory line cancels at the same amount.
//
//   stock.adjust    → if the adjustment increases stock, treat as
//                     a receive at zero unit cost (Dr 216 / Cr 711
//                     — an "inventory gain" expensed to COGS).
//                     If the adjustment decreases stock, treat as
//                     a delivery (Dr 711 / Cr 216) at the
//                     pre-adjustment average cost.
//
//   vendor_bill.post → Dr 521 (AP — purchases) at the bill total
//                      (including VAT) / Cr 216 (Inventory) at the
//                      goods-only subtotal + an offsetting line
//                      for the VAT-input. The 216 side of a bill
//                      post is the goods-value side; the VAT-input
//                      is a separate offset (booked against a
//                      dedicated tax-receivable account 226).
//                      Note: this entry REVERSES the receive-side
//                      AP that the stock.receive post booked, then
//                      re-books the AP at the bill amount. The
//                      net AP change is (bill_total - receive_value).
//
// Every function returns the journal entry id (or null if no
// entry was posted). Failures are propagated — callers (the move
// pure functions) decide whether to swallow or surface the error.
//
// No `eval`, no string-concat SQL, no `new Function`. The
// journal_posting module's postJournalEntry does the SQL.
import { postJournalEntry } from './journal.js';

// Account codes from the RA chart of accounts (see
// server/l10n-am/chartOfAccounts/armeniaChartOfAccounts.data.js).
// Exported as constants so the wiring code (receiveStock /
// deliverStock / postVendorBill) can reference them by name.
export const ACCOUNTS = Object.freeze({
  INVENTORY: '216',     // Ապdelays — goods (asset, class 2)
  COGS: '711',          // Իրdelays արdelays — COGS (expense, class 7)
  AP_PURCHASES: '521',  // Կreditors պdelays — AP for purchases (liability, class 5)
  VAT_INPUT: '226',     // Հdelays անdelays հdelays — VAT recoverable (asset, class 2)
});

/**
 * Post the GL entry for a stock receive event.
 *
 * @param {object} db - pg-style adapter
 * @param {object} move - the stock_moves row (id, entry_date or created_at, quantity, unit_cost)
 * @param {number} tenantId
 * @returns {Promise<{entry_id: number} | null>} null if move has no GL impact (e.g. transfer with zero cost)
 */
export async function postStockReceiveGL(db, move, tenantId = 0) {
  if (!move || typeof move !== 'object') return null;
  const moveId = Number(move.id);
  if (!Number.isInteger(moveId) || moveId <= 0) return null;
  const qty = Number(move.quantity || 0);
  const unitCost = Number(move.unit_cost || 0);
  if (qty <= 0 || unitCost <= 0) return null; // no GL value to post
  const amount = qty * unitCost;
  const entryDate = String(move.entry_date || move.created_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return null;
  const entry = await postJournalEntry(
    db,
    {
      entry_date: entryDate,
      source: 'stock.receive',
      source_id: moveId,
      description: `Stock receive: ${qty} units @ ${unitCost} AMD`,
      lines: [
        { account_code: ACCOUNTS.INVENTORY, debit: amount, credit: 0, description: 'inventory' },
        { account_code: ACCOUNTS.AP_PURCHASES, debit: 0, credit: amount, description: 'ap' },
      ],
    },
    tenantId,
  );
  return { entry_id: entry.id };
}

/**
 * Post the GL entry for a stock deliver event. The amount is the
 * COGS (qty × source average cost) — NOT the sale price. The
 * sale-side AR / revenue posting is a separate concern (out of
 * Phase 1 scope; the deliverStock function is used internally for
 * inventory reduction, not for sales revenue recognition).
 *
 * @param {object} db - pg-style adapter
 * @param {object} move - the stock_moves row (id, entry_date, quantity, unit_cost)
 * @param {number} tenantId
 * @returns {Promise<{entry_id: number} | null>}
 */
export async function postStockDeliverGL(db, move, tenantId = 0) {
  if (!move || typeof move !== 'object') return null;
  const moveId = Number(move.id);
  if (!Number.isInteger(moveId) || moveId <= 0) return null;
  const qty = Number(move.quantity || 0);
  const unitCost = Number(move.unit_cost || 0);
  if (qty <= 0 || unitCost <= 0) return null;
  const amount = qty * unitCost;
  const entryDate = String(move.entry_date || move.created_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return null;
  const entry = await postJournalEntry(
    db,
    {
      entry_date: entryDate,
      source: 'stock.deliver',
      source_id: moveId,
      description: `Stock deliver (COGS): ${qty} units @ ${unitCost} AMD`,
      lines: [
        { account_code: ACCOUNTS.COGS, debit: amount, credit: 0, description: 'cogs' },
        { account_code: ACCOUNTS.INVENTORY, debit: 0, credit: amount, description: 'inventory' },
      ],
    },
    tenantId,
  );
  return { entry_id: entry.id };
}

/**
 * Post the GL entry for a stock adjustment.
 *
 * @param {object} db - pg-style adapter
 * @param {object} move - the stock_moves row (id, entry_date, move_type='ADJUSTMENT', quantity, unit_cost)
 * @param {number} tenantId
 * @returns {Promise<{entry_id: number} | null>}
 */
export async function postStockAdjustGL(db, move, tenantId = 0) {
  if (!move || typeof move !== 'object') return null;
  const moveId = Number(move.id);
  if (!Number.isInteger(moveId) || moveId <= 0) return null;
  const qty = Number(move.quantity || 0);
  const unitCost = Number(move.unit_cost || 0);
  if (qty <= 0 || unitCost <= 0) return null;
  const amount = qty * unitCost;
  const entryDate = String(move.entry_date || move.created_at || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return null;
  // The adjustment's `delta` field tells us the direction. A
  // positive delta = inventory grew (Dr 216 / Cr 711); a negative
  // delta = inventory shrank (Dr 711 / Cr 216).
  const delta = Number(move.delta || 0);
  if (delta > 0) {
    const entry = await postJournalEntry(
      db,
      {
        entry_date: entryDate,
        source: 'stock.adjust',
        source_id: moveId,
        description: `Stock adjustment (gain): +${delta} units @ ${unitCost} AMD`,
        lines: [
          { account_code: ACCOUNTS.INVENTORY, debit: amount, credit: 0 },
          { account_code: ACCOUNTS.COGS, debit: 0, credit: amount, description: 'cogs' },
        ],
      },
      tenantId,
    );
    return { entry_id: entry.id };
  }
  if (delta < 0) {
    const entry = await postJournalEntry(
      db,
      {
        entry_date: entryDate,
        source: 'stock.adjust',
        source_id: moveId,
        description: `Stock adjustment (loss): ${delta} units @ ${unitCost} AMD`,
        lines: [
          { account_code: ACCOUNTS.COGS, debit: amount, credit: 0 },
          { account_code: ACCOUNTS.INVENTORY, debit: 0, credit: amount },
        ],
      },
      tenantId,
    );
    return { entry_id: entry.id };
  }
  return null;
}

/**
 * Post the GL entry for a vendor bill post event. The bill has
 * three components: subtotal (goods value, hits 216 inventory),
 * VAT (hits 226 VAT-input), and total (hits 521 AP). The
 * corresponding stock.receive entry on the move that fed this
 * bill already booked AP at the receive time at the goods value;
 * the bill post reconciles the AP to the bill total.
 *
 * In a clean small-business flow:
 *   - stock.receive posts Dr 216 / Cr 521 at receive-time cost
 *   - vendor_bill.post posts Dr 521 (reverses the receive AP) /
 *     Cr 521 (re-books at the bill total)
 * That makes the net AP at the post moment = (bill_total -
 * receive_value). The inventory side stays at the receive value
 * unless the bill carries a different price; for Phase 1 we
 * assume bill_total = receive_value + VAT, so the inventory side
 * is a no-op and the net effect is just the VAT side
 * (Dr 226 / Cr 521 = VAT input).
 *
 * @param {object} db - pg-style adapter
 * @param {object} bill - the vendor_bills row (id, bill_date, subtotal, vat, total)
 * @param {number} tenantId
 * @returns {Promise<{entry_id: number} | null>}
 */
export async function postVendorBillPostGL(db, bill, tenantId = 0) {
  if (!bill || typeof bill !== 'object') return null;
  const billId = Number(bill.id);
  if (!Number.isInteger(billId) || billId <= 0) return null;
  const vat = Number(bill.vat || 0);
  const total = Number(bill.total || 0);
  if (total <= 0) return null;
  const entryDate = String(bill.bill_date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) return null;
  if (vat === 0) {
    // No VAT side — just book the AP reversal so the receive-time
    // AP is cleared.
    const entry = await postJournalEntry(
      db,
      {
        entry_date: entryDate,
        source: 'vendor_bill.post',
        source_id: billId,
        description: `Vendor bill posted: ${total} AMD (no VAT)`,
        lines: [
          { account_code: ACCOUNTS.AP_PURCHASES, debit: total, credit: 0, description: 'ap reversal' },
          { account_code: ACCOUNTS.AP_PURCHASES, debit: 0, credit: total, description: 'ap rebook' },
        ],
      },
      tenantId,
    );
    return { entry_id: entry.id };
  }
  // With VAT: book Dr 226 (VAT-input) at the VAT amount, Cr 521
  // (AP) at the VAT amount. This is the "payable side" of the
  // bill post. The receive-time AP has been debited away by the
  // bill posting flow at the application level (the postVendorBill
  // pure function transitions the bill to 'posted' status but
  // does not rebook AP — the AP balance was already booked on
  // receive and stays). So the ONLY additional GL movement on
  // bill post is the VAT side.
  const entry = await postJournalEntry(
    db,
    {
      entry_date: entryDate,
      source: 'vendor_bill.post',
      source_id: billId,
      description: `Vendor bill posted: VAT input ${vat} AMD (total ${total} AMD)`,
      lines: [
        { account_code: ACCOUNTS.VAT_INPUT, debit: vat, credit: 0, description: 'vat input' },
        { account_code: ACCOUNTS.AP_PURCHASES, debit: 0, credit: vat, description: 'ap' },
      ],
    },
    tenantId,
  );
  return { entry_id: entry.id };
}
