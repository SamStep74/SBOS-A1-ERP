// Tests for server/finance/validate-hvhh.js — on-demand A1-Validator
// HVVH check. Same fail-soft 3-tier as the create-time wrapper but
// with the on-demand contract: never throws on invalid TIN, returns
// ok=false in the body instead.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateHvhhOnDemand, _resetClientForTesting } from './validate-hvhh.js';

test('validateHvhhOnDemand: valid 8-digit hvhh → ok=true (local-regex fallback)', async () => {
  // No A1_VALIDATOR_URL set → client disabled → local regex.
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: '00123456' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, '00123456');
  assert.equal(r._via, 'local-regex');
});

test('validateHvhhOnDemand: invalid 9-digit hvhh → ok=false, error mentions 8 digits', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: '123456789' });
  assert.equal(r.ok, false);
  assert.match(r.error, /8 digits/);
  assert.equal(r._via, undefined);
});

test('validateHvhhOnDemand: non-digit hvhh → ok=false', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: '1234567A' });
  assert.equal(r.ok, false);
  assert.match(r.error, /8 digits/);
});

test('validateHvhhOnDemand: null hvhh → ok=null, _skipped', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: null });
  assert.equal(r.ok, null);
  assert.match(r._skipped, /no hvhh/);
});

test('validateHvhhOnDemand: empty string hvhh → ok=null, _skipped', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: '' });
  assert.equal(r.ok, null);
  assert.match(r._skipped, /no hvhh/);
});

test('validateHvhhOnDemand: undefined hvhh → ok=null, _skipped', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({});
  assert.equal(r.ok, null);
  assert.match(r._skipped, /no hvhh/);
});

test('validateHvhhOnDemand: non-string hvhh → ok=false, error', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: 12345 });
  assert.equal(r.ok, false);
  assert.match(r.error, /string/);
});

test('validateHvhhOnDemand: whitespace in hvhh → stripped to 8 digits, ok=true', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  const r = await validateHvhhOnDemand({ hvhh: '00 123 456' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, '00123456');
});

test('validateHvhhOnDemand: invalid hvhh → never throws (caller does the response handling)', async () => {
  delete process.env.A1_VALIDATOR_URL;
  _resetClientForTesting();
  // Various invalid inputs should all resolve, not reject
  for (const hvhh of ['', null, undefined, 'abc', '12345', '1234567890', '1234567A']) {
    const r = await validateHvhhOnDemand({ hvhh });
    assert.ok(r, `expected a result for ${JSON.stringify(hvhh)}`);
    assert.ok('ok' in r, `expected ok field for ${JSON.stringify(hvhh)}`);
  }
});
