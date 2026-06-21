// SBOS-A1-ERP — GL reconciliation.
//
// The journal is the projection of the operational moves
// (stock_moves + vendor_bill.post) onto the RA chart of accounts.
// The projection is best-effort: if a move's GL post fails (db
// error, transient outage, etc.), the move still stands and the
// journal falls out of sync.
//
// This module finds every move that has no corresponding journal
// entry and posts the missing GL. It's idempotent (the
// postJournalEntry idempotency guard ensures we never double-post
// a move that already has a journal entry). The reconciliation
// is also safe to run at boot: any move that was created before
// the last successful reconciliation will get its GL entry.
//
// The function returns a summary:
//
//   {
//     scanned: <number of moves examined>,
//     reconciled: <number of GL entries posted by this run>,
//     skipped: <number of moves that were already posted>,
//     errors: [{ move_id, source, error: <message> }, ...],
//   }
//
// Errors are collected (not thrown) so a single bad move doesn't
// abort the whole reconciliation. Each error is logged via
// `console.warn` so the operator sees it in the server log.
import { ValueError as JournalValueError } from './journal.js';
import {
  postStockReceiveGL,
  postStockDeliverGL,
  postStockAdjustGL,
  postVendorBillPostGL,
} from './stockPosting.js';

// ────────────────────────────────────────────────────────────────────────
// PG-style adapter helpers (shared with journal.js / inventory.js /
// purchase.js / audit.js — see _pgStyle.js for the canonical impl).
// ────────────────────────────────────────────────────────────────────────

import { runQuery, numberedParams } from './_pgStyle.js';

// ────────────────────────────────────────────────────────────────────────
// findUnpostedMoves — discover the gap between moves and journal
// ────────────────────────────────────────────────────────────────────────

/**
 * Find every stock_move + posted vendor_bill in the tenant that
 * does NOT have a corresponding journal_entries row. Returns an
 * array of { source, move } pairs the caller can feed back into
 * the post* functions.
 *
 * The query is a UNION of two NOT-EXISTS subqueries — one for
 * stock_moves, one for vendor_bills in 'posted' status. We
 * deliberately exclude stock_moves with quantity=0 or unit_cost=0
 * (those never post a journal entry by design, see stockPosting.js).
 */
export async function findUnpostedMoves(db, tenantId = 0) {
  // The numberedParams helper assigns unique $N placeholders for
  // every #{...} occurrence. This is the bug fix for the
  // "$1 placeholder reuse under the pg → sqlite translation"
  // pattern that hit three times in three waves — even though
  // tenantId is reused 4 times (once per subquery), each
  // occurrence gets a unique $N placeholder, so the test harness's
  // $N → ? translation works correctly.
  const { sql, params } = numberedParams(
    `SELECT id, 'stock.receive' AS source FROM finance.stock_moves
      WHERE tenant_id = #{tenantId} AND move_type = 'RECEIPT'
        AND quantity > 0 AND unit_cost > 0
        AND NOT EXISTS (
          SELECT 1 FROM finance.journal_entries
          WHERE tenant_id = #{tenantId} AND source = 'stock.receive' AND source_id = finance.stock_moves.id
        )
     UNION ALL
     SELECT id, 'stock.deliver' AS source FROM finance.stock_moves
      WHERE tenant_id = #{tenantId} AND move_type = 'DELIVERY'
        AND quantity > 0 AND unit_cost > 0
        AND NOT EXISTS (
          SELECT 1 FROM finance.journal_entries
          WHERE tenant_id = #{tenantId} AND source = 'stock.deliver' AND source_id = finance.stock_moves.id
        )
     UNION ALL
     SELECT id, 'stock.adjust' AS source FROM finance.stock_moves
      WHERE tenant_id = #{tenantId} AND move_type = 'ADJUSTMENT'
        AND quantity > 0 AND unit_cost > 0
        AND delta != 0
        AND NOT EXISTS (
          SELECT 1 FROM finance.journal_entries
          WHERE tenant_id = #{tenantId} AND source = 'stock.adjust' AND source_id = finance.stock_moves.id
        )
     UNION ALL
     SELECT id, 'vendor_bill.post' AS source FROM finance.vendor_bills
      WHERE tenant_id = #{tenantId} AND status = 'posted' AND total > 0
        AND NOT EXISTS (
          SELECT 1 FROM finance.journal_entries
          WHERE tenant_id = #{tenantId} AND source = 'vendor_bill.post' AND source_id = finance.vendor_bills.id
        )
     ORDER BY source, id`,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
    tenantId,
  );
  const res = await runQuery(db, sql, params);
  return (res.rows || []).map((r) => ({
    source: r.source,
    move_id: Number(r.id),
  }));
}

// ────────────────────────────────────────────────────────────────────────
// reconcileJournal — post the missing GL entries
// ────────────────────────────────────────────────────────────────────────

/**
 * Reconcile the journal with the moves. Returns:
 *   {
 *     scanned: <int>,    // total moves examined
 *     reconciled: <int>, // GL entries newly posted by this run
 *     errors: [{ move_id, source, error: <message> }, ...],
 *   }
 *
 * The function never throws on a per-move error — each failed
 * post is collected in the `errors` array. The function only
 * throws if a system-level error prevents the scan (e.g. the
 * db adapter is broken).
 */
export async function reconcileJournal(db, tenantId = 0, opts = {}) {
  const unposted = await findUnpostedMoves(db, tenantId);
  const summary = {
    scanned: unposted.length,
    reconciled: 0,
    errors: [],
  };
  if (opts.dryRun) {
    return summary; // caller asked for the count without posting
  }
  for (const { source, move_id } of unposted) {
    try {
      // Look up the move / bill so we can re-construct the post
      // input. (We don't keep the post input around in the move
      // row, only the result; the re-construction is the
      // idempotency trade-off.)
      const move = await loadMove(db, source, move_id, tenantId);
      if (!move) {
        summary.errors.push({ move_id, source, error: 'move no longer exists' });
        continue;
      }
      if (source === 'stock.receive') {
        await postStockReceiveGL(db, move, tenantId);
      } else if (source === 'stock.deliver') {
        await postStockDeliverGL(db, move, tenantId);
      } else if (source === 'stock.adjust') {
        await postStockAdjustGL(db, move, tenantId);
      } else if (source === 'vendor_bill.post') {
        await postVendorBillPostGL(db, move, tenantId);
      } else {
        summary.errors.push({ move_id, source, error: `unknown source: ${source}` });
        continue;
      }
      summary.reconciled++;
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      summary.errors.push({ move_id, source, error: message });
      // Log the failure so the operator can see it in the server log.
      // (The boot-time call wraps this in try/catch and just logs.)
      console.warn(`[reconcileJournal] failed to post ${source}#${move_id}: ${message}`);
    }
  }
  return summary;
}

// ────────────────────────────────────────────────────────────────────────
// loadMove — re-construct the post* input from a stored row
// ────────────────────────────────────────────────────────────────────────

async function loadMove(db, source, moveId, tenantId) {
  if (source === 'vendor_bill.post') {
    const res = await runQuery(
      db,
      `SELECT id, subtotal, vat, total, bill_date FROM finance.vendor_bills
        WHERE tenant_id = $1 AND id = $2`,
      [tenantId, moveId],
    );
    if (!res.rows || res.rows.length === 0) return null;
    const r = res.rows[0];
    return {
      id: Number(r.id),
      subtotal: Number(r.subtotal),
      vat: Number(r.vat),
      total: Number(r.total),
      bill_date: r.bill_date,
    };
  }
  // All stock_move sources (receive / deliver / adjust) read the
  // same columns.
  const res = await runQuery(
    db,
    `SELECT id, quantity, unit_cost, delta, created_at FROM finance.stock_moves
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, moveId],
  );
  if (!res.rows || res.rows.length === 0) return null;
  const r = res.rows[0];
  return {
    id: Number(r.id),
    quantity: Number(r.quantity),
    unit_cost: Number(r.unit_cost),
    delta: r.delta == null ? null : Number(r.delta),
    created_at: r.created_at,
  };
}

// Re-export the journal ValueError so callers can use it for
// the "no journal" case without importing journal.js directly.
export { JournalValueError };
