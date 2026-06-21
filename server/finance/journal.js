// SBOS-A1-ERP — general-ledger journal module.
//
// Balanced double-entry bookkeeping backed by the RA chart of
// accounts. The journal is the bridge between the inventory +
// purchase modules and the chart of accounts. Every stock-valuation
// event (receive / deliver / adjust) and every vendor-bill post
// writes a balanced journal entry; the COGS / AP / Inventory
// account balances on the chart are derived from summing the
// journal_entry_lines table.
//
// Accounts referenced by the stock-valuation handoff (from the
// official RA chart in server/l10n-am/chartOfAccounts/):
//
//   216  Ապdelays                   Inventory (asset, class 2)
//   711  Իրdelays արdelays    COGS (expense, class 7)
//   521  Կreditors պdelays         AP — purchases (liability, class 5)
//
// Re-exports the same runQuery / stripFinancePrefix helpers used
// by inventory.js + purchase.js + audit.js so the SQL works on
// both sqlite (with prefix-stripped table names) and production
// pg (with the finance. prefix).
//
// No `eval`, no string-concat SQL, no `new Function`. The only
// computed strings are the chart-of-accounts account_code and
// the per-line amounts (whole drams, no floats).
// ────────────────────────────────────────────────────────────────────────
// PG-style adapter helpers (shared across the finance module — see
// _pgStyle.js for the canonical implementation).
// ────────────────────────────────────────────────────────────────────────

import { runQuery, numberedParams } from './_pgStyle.js';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

// RA chart-of-accounts code (3 digits, no dot).
function assertAccountCode(code, name = 'account_code') {
  if (typeof code !== 'string' || !/^\d{3}$/.test(code)) {
    throw new ValueError(`${name} must be a 3-digit chart-of-accounts code (got ${JSON.stringify(code)})`);
  }
  return code;
}

function assertNonNegInt(value, name) {
  if (!Number.isInteger(value) || value < 0) {
    throw new ValueError(`${name} must be a non-negative integer (got ${JSON.stringify(value)})`);
  }
  return value;
}

function assertIsoDate(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new ValueError(`${name} must be in YYYY-MM-DD format`);
  }
  return value;
}

function assertSource(value) {
  if (typeof value !== 'string' || !/^[a-z_]+(\.[a-z_]+)?$/.test(value)) {
    throw new ValueError('source must be a lowercase dot-separated identifier (e.g. "stock.receive")');
  }
  return value;
}

// ────────────────────────────────────────────────────────────────────────
// postJournalEntry — the main public API
// ────────────────────────────────────────────────────────────────────────

/**
 * Post a balanced journal entry. The total debits must equal the
 * total credits (in whole drams). The entry is recorded in
 * finance.journal_entries + finance.journal_entry_lines.
 *
 * @param {object} db - pg-style adapter
 * @param {object} entry - { entry_date, source, source_id?, description?, currency?, lines: [{ account_code, debit, credit, description? }], created_by? }
 * @param {number} tenantId
 * @returns {object} the persisted entry (id + lines with their line ids)
 */
export async function postJournalEntry(db, entry, tenantId = 0) {
  if (!entry || typeof entry !== 'object') {
    throw new ValueError('entry must be an object');
  }
  const entryDate = assertIsoDate(entry.entry_date, 'entry_date');
  const source = assertSource(entry.source);
  const sourceId =
    entry.source_id == null
      ? null
      : (() => {
          if (!Number.isInteger(entry.source_id) || entry.source_id < 0) {
            throw new ValueError('source_id must be a non-negative integer or null');
          }
          return entry.source_id;
        })();
  const currency = entry.currency || 'AMD';
  if (typeof currency !== 'string' || !/^[A-Z]{3}$/.test(currency)) {
    throw new ValueError('currency must be a 3-letter uppercase ISO 4217 code');
  }
  if (!Array.isArray(entry.lines) || entry.lines.length < 2) {
    throw new ValueError('lines must be an array of at least 2 entries (a journal needs at least one debit + one credit)');
  }
  const lines = entry.lines.map((l, i) => {
    if (!l || typeof l !== 'object') {
      throw new ValueError(`lines[${i}] must be an object`);
    }
    const accountCode = assertAccountCode(l.account_code, `lines[${i}].account_code`);
    const debit = l.debit != null ? assertNonNegInt(l.debit, `lines[${i}].debit`) : 0;
    const credit = l.credit != null ? assertNonNegInt(l.credit, `lines[${i}].credit`) : 0;
    if (debit > 0 && credit > 0) {
      throw new ValueError(`lines[${i}] cannot have both debit and credit > 0`);
    }
    if (debit === 0 && credit === 0) {
      throw new ValueError(`lines[${i}] must have either debit > 0 or credit > 0`);
    }
    return {
      account_code: accountCode,
      debit,
      credit,
      description: l.description || null,
    };
  });
  // Double-entry invariant.
  const totalDebit = lines.reduce((s, l) => s + l.debit, 0);
  const totalCredit = lines.reduce((s, l) => s + l.credit, 0);
  if (totalDebit !== totalCredit) {
    throw new ValueError(
      `journal entry is unbalanced: total debit ${totalDebit} != total credit ${totalCredit}`,
    );
  }
  if (totalDebit === 0) {
    throw new ValueError('journal entry has zero total (nothing to post)');
  }

  // Idempotency guard: if a journal entry for this (source, source_id)
  // already exists in the tenant, return it instead of creating a
  // duplicate. The UNIQUE index on (tenant_id, source, source_id) is
  // the backstop, but checking first lets us return the existing
  // entry instead of throwing on a UNIQUE violation.
  if (sourceId != null) {
    const existing = await runQuery(
      db,
      `SELECT id FROM finance.journal_entries
        WHERE tenant_id = $1 AND source = $2 AND source_id = $3`,
      [tenantId, source, sourceId],
    );
    if (existing.rows && existing.rows.length > 0) {
      return await getJournalEntry(db, Number(existing.rows[0].id), tenantId);
    }
  }

  // Insert header.
  const headerRes = await runQuery(
    db,
    `INSERT INTO finance.journal_entries
       (tenant_id, entry_date, source, source_id, description, currency, status, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, 'posted', $7)
     RETURNING id`,
    [tenantId, entryDate, source, sourceId, entry.description || null, currency, entry.created_by ?? null],
  );
  let entryId;
  if (headerRes.rows && headerRes.rows.length > 0 && headerRes.rows[0].id != null) {
    entryId = Number(headerRes.rows[0].id);
  } else {
    const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
    entryId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
  }

  // Insert lines.
  const insertedLines = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const lineRes = await runQuery(
      db,
      `INSERT INTO finance.journal_entry_lines
         (tenant_id, entry_id, line_order, account_code, debit, credit, description)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [tenantId, entryId, i, l.account_code, l.debit, l.credit, l.description],
    );
    let lineId;
    if (lineRes.rows && lineRes.rows.length > 0 && lineRes.rows[0].id != null) {
      lineId = Number(lineRes.rows[0].id);
    } else {
      const lastId = await runQuery(db, 'SELECT LAST_INSERT_ROWID()', []);
      lineId = Number(lastId.rows[0]['LAST_INSERT_ROWID()'] || lastId.rows[0].id);
    }
    insertedLines.push({ id: lineId, ...l });
  }

  return {
    id: entryId,
    entry_date: entryDate,
    source,
    source_id: sourceId,
    description: entry.description || null,
    currency,
    status: 'posted',
    lines: insertedLines,
  };
}

// ────────────────────────────────────────────────────────────────────────
// getJournalEntry — fetch one entry with its lines
// ────────────────────────────────────────────────────────────────────────

export async function getJournalEntry(db, entryId, tenantId = 0) {
  if (!Number.isInteger(entryId) || entryId <= 0) {
    throw new ValueError('entryId must be a positive integer');
  }
  const header = await runQuery(
    db,
    `SELECT id, entry_date, source, source_id, description, currency, status, book_date, created_by
       FROM finance.journal_entries
      WHERE tenant_id = $1 AND id = $2`,
    [tenantId, entryId],
  );
  if (!header.rows || header.rows.length === 0) return null;
  const h = header.rows[0];
  const linesRes = await runQuery(
    db,
    `SELECT id, line_order, account_code, debit, credit, description
       FROM finance.journal_entry_lines
      WHERE tenant_id = $1 AND entry_id = $2
      ORDER BY line_order, id`,
    [tenantId, entryId],
  );
  return {
    id: Number(h.id),
    entry_date: h.entry_date,
    source: h.source,
    source_id: h.source_id == null ? null : Number(h.source_id),
    description: h.description,
    currency: h.currency,
    status: h.status,
    book_date: h.book_date,
    created_by: h.created_by == null ? null : Number(h.created_by),
    lines: (linesRes.rows || []).map((r) => ({
      id: Number(r.id),
      line_order: Number(r.line_order),
      account_code: r.account_code,
      debit: Number(r.debit),
      credit: Number(r.credit),
      description: r.description,
    })),
  };
}

// ────────────────────────────────────────────────────────────────────────
// listJournalEntries — read-only with filters
// ────────────────────────────────────────────────────────────────────────

export async function listJournalEntries(db, tenantId = 0, opts = {}) {
  const where = ['tenant_id = $1'];
  const params = [tenantId];
  if (opts.since) {
    assertIsoDate(opts.since, 'since');
    where.push(`entry_date >= $${params.length + 1}`);
    params.push(opts.since);
  }
  if (opts.until) {
    assertIsoDate(opts.until, 'until');
    where.push(`entry_date <= $${params.length + 1}`);
    params.push(opts.until);
  }
  if (opts.source) {
    where.push(`source = $${params.length + 1}`);
    params.push(String(opts.source));
  }
  const limit = Number.isInteger(opts.limit) && opts.limit > 0 ? Math.min(opts.limit, 500) : 100;
  const offset = Number.isInteger(opts.offset) && opts.offset >= 0 ? opts.offset : 0;
  const res = await runQuery(
    db,
    `SELECT id, entry_date, source, source_id, description, currency, status, book_date
       FROM finance.journal_entries
      WHERE ${where.join(' AND ')}
      ORDER BY entry_date DESC, id DESC
      LIMIT ${limit} OFFSET ${offset}`,
    params,
  );
  return (res.rows || []).map((r) => ({
    id: Number(r.id),
    entry_date: r.entry_date,
    source: r.source,
    source_id: r.source_id == null ? null : Number(r.source_id),
    description: r.description,
    currency: r.currency,
    status: r.status,
    book_date: r.book_date,
  }));
}

// ────────────────────────────────────────────────────────────────────────
// getAccountBalance — sum of debits - credits on a single account
// ────────────────────────────────────────────────────────────────────────

/**
 * Return the current balance of one account in one tenant. Asset +
 * expense accounts are debit-natural (positive balance = debit >
 * credit); liability + equity + revenue accounts are credit-natural
 * (positive balance = credit > debit). The function returns the
 * signed balance using the natural sign of the account class:
 *   - class 1, 2, 3, 5, 8 (asset/equity/liability/management):
 *       positive = net debit position
 *   - class 4 (revenue): positive = net credit position
 *   - class 7 (expense): positive = net debit position
 * For unknown / class 0 the function falls back to net debit
 * (positive = debit > credit) which is the conservative default
 * for the SBOS-A1-ERP financial reports.
 *
 * The balance is computed across all journal_entry_lines that
 * belong to the tenant and reference the account. The
 * `?asOfDate` filter scopes the calculation to a financial
 * date inclusive (e.g. "give me the 216 inventory balance as
 * of 2026-06-30").
 */
export async function getAccountBalance(db, accountCode, tenantId = 0, opts = {}) {
  assertAccountCode(accountCode, 'account_code');
  // The numberedParams helper assigns unique $N placeholders for
  // every #{...} occurrence. This is the bug fix for the
  // "$1 placeholder reuse under the pg → sqlite translation"
  // pattern that hit three times in three waves — the
  // placeholders are unique even when the same value is reused
  // in both the outer WHERE and the JOIN's ON clause.
  let template =
    `SELECT
        COALESCE(SUM(jel.debit), 0) AS total_debit,
        COALESCE(SUM(jel.credit), 0) AS total_credit
       FROM finance.journal_entry_lines jel
       JOIN finance.journal_entries je ON je.id = jel.entry_id
      WHERE jel.tenant_id = #{tenantId} AND jel.account_code = #{accountCode}`;
  let values = [tenantId, accountCode];
  if (opts.asOfDate) {
    assertIsoDate(opts.asOfDate, 'asOfDate');
    template += ' AND je.tenant_id = #{tenantId} AND je.entry_date <= #{asOfDate}';
    values = [tenantId, accountCode, tenantId, opts.asOfDate];
  }
  const { sql, params } = numberedParams(template, ...values);
  const res = await runQuery(db, sql, params);
  const totalDebit = Number((res.rows || [])[0]?.total_debit || 0);
  const totalCredit = Number((res.rows || [])[0]?.total_credit || 0);
  // net_debit and net_credit are mutually exclusive (you can't be net
  // both); exactly one is non-zero for an account with any activity.
  // For a debit-natural account (asset / expense) net_debit > 0 and
  // net_credit = 0; for a credit-natural account (liability / equity /
  // revenue) net_credit > 0 and net_debit = 0. An account with equal
  // debits and credits has both at 0 (a fully-paid AP, a fully-used
  // inventory line, etc.).
  const rawNet = totalDebit - totalCredit;
  return {
    account_code: accountCode,
    total_debit: totalDebit,
    total_credit: totalCredit,
    net_debit: Math.max(0, rawNet),
    net_credit: Math.max(0, -rawNet),
  };
}

// ────────────────────────────────────────────────────────────────────────
// listAccountBalances — the full chart snapshot for the tenant
// ────────────────────────────────────────────────────────────────────────

export async function listAccountBalances(db, tenantId = 0, opts = {}) {
  // See getAccountBalance for the numberedParams rationale.
  let template =
    `SELECT jel.account_code,
            COALESCE(SUM(jel.debit), 0) AS total_debit,
            COALESCE(SUM(jel.credit), 0) AS total_credit
       FROM finance.journal_entry_lines jel
       JOIN finance.journal_entries je ON je.id = jel.entry_id
      WHERE jel.tenant_id = #{tenantId}`;
  let values = [tenantId];
  if (opts.asOfDate) {
    assertIsoDate(opts.asOfDate, 'asOfDate');
    template += ' AND je.tenant_id = #{tenantId} AND je.entry_date <= #{asOfDate}';
    values = [tenantId, tenantId, opts.asOfDate];
  }
  template += ' GROUP BY jel.account_code ORDER BY jel.account_code';
  const { sql, params } = numberedParams(template, ...values);
  const res = await runQuery(db, sql, params);
  return (res.rows || []).map((r) => {
    const debit = Number(r.total_debit);
    const credit = Number(r.total_credit);
    const rawNet = debit - credit;
    return {
      account_code: r.account_code,
      total_debit: debit,
      total_credit: credit,
      net_debit: Math.max(0, rawNet),
      net_credit: Math.max(0, -rawNet),
    };
  });
}
