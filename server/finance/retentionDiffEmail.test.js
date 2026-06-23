// SBOS-A1-ERP retention diff email tests (Wave 74).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildRetentionDiffBody,
  buildRetentionDiffSubject,
} from './retentionDiffEmail.js';

const DIFF_FULL = {
  added: [3, 4],
  removed: [2],
  changed: [
    { tenantId: 1, fields: ['retention_days'] },
    { tenantId: 5, fields: ['has_explicit_config', 'last_purge_count'] },
  ],
};

const DIFF_EMPTY = {
  added: [],
  removed: [],
  changed: [],
};

test('74.1 buildRetentionDiffBody: header includes the window', () => {
  const body = buildRetentionDiffBody({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_EMPTY,
  });
  assert.ok(body.includes('Window: 2026-06-22T00:00:00Z  →  2026-06-23T00:00:00Z'));
});

test('74.2 buildRetentionDiffBody: totals line counts the three sections', () => {
  const body = buildRetentionDiffBody({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_FULL,
  });
  assert.ok(body.includes('Totals: 2 added, 1 removed, 2 changed.'));
});

test('74.3 buildRetentionDiffBody: ADDED section lists each tenant', () => {
  const body = buildRetentionDiffBody({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_FULL,
  });
  assert.ok(body.includes('ADDED (2)'));
  assert.ok(body.includes('+ tenant 3'));
  assert.ok(body.includes('+ tenant 4'));
});

test('74.4 buildRetentionDiffBody: REMOVED section lists each tenant', () => {
  const body = buildRetentionDiffBody({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_FULL,
  });
  assert.ok(body.includes('REMOVED (1)'));
  assert.ok(body.includes('- tenant 2'));
});

test('74.5 buildRetentionDiffBody: CHANGED section lists tenants + changed fields', () => {
  const body = buildRetentionDiffBody({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_FULL,
  });
  assert.ok(body.includes('CHANGED (2)'));
  assert.ok(body.includes('~ tenant 1'));
  assert.ok(body.includes('retention_days'));
  assert.ok(body.includes('~ tenant 5'));
  assert.ok(body.includes('has_explicit_config, last_purge_count'));
});

test('74.6 buildRetentionDiffBody: empty diff emits all three section headers', () => {
  const body = buildRetentionDiffBody({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_EMPTY,
  });
  assert.ok(body.includes('ADDED (0)'));
  assert.ok(body.includes('REMOVED (0)'));
  assert.ok(body.includes('CHANGED (0)'));
  assert.ok(body.includes('(none)'));
});

test('74.7 buildRetentionDiffBody: invalid diff throws TypeError', () => {
  assert.throws(
    () => buildRetentionDiffBody({ from: 'a', to: 'b', diff: null }),
    TypeError,
  );
  assert.throws(
    () => buildRetentionDiffBody({ from: 'a', to: 'b' }),
    TypeError,
  );
});

test('74.8 buildRetentionDiffSubject: short format with counts + dates', () => {
  const subj = buildRetentionDiffSubject({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_FULL,
  });
  assert.equal(subj, '[SBOS] retention: +2 -1 ~2 (2026-06-22 → 2026-06-23)');
});

test('74.9 buildRetentionDiffSubject: empty diff produces zeros', () => {
  const subj = buildRetentionDiffSubject({
    from: '2026-06-22T00:00:00Z',
    to: '2026-06-23T00:00:00Z',
    diff: DIFF_EMPTY,
  });
  assert.equal(subj, '[SBOS] retention: +0 -0 ~0 (2026-06-22 → 2026-06-23)');
});

test('74.10 buildRetentionDiffSubject: missing dates produce ?', () => {
  const subj = buildRetentionDiffSubject({
    from: '',
    to: '',
    diff: DIFF_EMPTY,
  });
  assert.equal(subj, '[SBOS] retention: +0 -0 ~0 (? → ?)');
});
