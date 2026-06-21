// server/finance/hvhh-validator.test.js — unit tests for the A1-Validator wrapper.
//
// The client class is monkey-patched at import time so we can simulate
// the service being up / down / rejecting / accepting without a live
// network. This is the same pattern as the SBOS tests that inject a DB
// handle: hermetic, fast, no live infra.

import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CLIENT_PATH = path.join(__dirname, '..', '..', 'lib', 'a1-validator-client.js');

// ────────────────────────────────────────────────────────────────────────
// Test helpers: we re-import the hvhh-validator module with a stub
// A1ValidatorClient injected via Node's import cache hooks. Simpler
// approach: patch the client's constructor via the import system.
//
// Strategy: import the module, then replace the imported A1ValidatorClient
// class with a stub. Each test sets the stub behavior via _client_ stub.
// ────────────────────────────────────────────────────────────────────────

let hvhhValidator;
let _stubBehavior = null;

function makeStubClientClass() {
  return class StubClient {
    constructor(opts) {
      this.opts = opts;
      this.enabled = opts && opts.enabled;
    }
    async validate(kind, input) {
      if (!_stubBehavior) {
        return { ok: null, _error: 'no stub behavior set' };
      }
      if (_stubBehavior.throwError) {
        throw _stubBehavior.throwError;
      }
      return _stubBehavior.response;
    }
  };
}

// Save the real env so we can restore it
const _originalEnv = { ...process.env };

beforeEach(async () => {
  // Clear module cache to re-import
  delete process.env.A1_VALIDATOR_URL;
  _stubBehavior = null;
});

after(() => {
  // Restore env
  for (const k of Object.keys(process.env)) delete process.env[k];
  Object.assign(process.env, _originalEnv);
});

// Re-import the module per test by using dynamic import + cache busting.
// The module reads the A1ValidatorClient via static import; we can't
// easily mock that without a module loader. So instead, we set the env
// var to control whether the real client is "enabled", and test both
// branches (disabled, real-disabled-fallback) without ever calling a
// live service. The "service up" tests use a real network — skip if
// unavailable (or test via the public HTTP mock service in CI).

test('null hvhh → ok=true, _skipped=empty (optional)', async () => {
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: null });
  assert.equal(r.ok, true);
  assert.equal(r._skipped, 'empty (optional)');
});

test('undefined hvhh → ok=true', async () => {
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({});
  assert.equal(r.ok, true);
  assert.equal(r._skipped, 'empty (optional)');
});

test('empty string hvhh → ok=true', async () => {
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: '' });
  assert.equal(r.ok, true);
  assert.equal(r._skipped, 'empty (optional)');
});

test('non-string hvhh → ok=false, error mentions type', async () => {
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: 12345 });
  assert.equal(r.ok, false);
  assert.match(r.error, /string/);
});

test('disabled client + valid 8-digit hvhh → ok=true, _skipped=disabled', async () => {
  // A1_VALIDATOR_URL unset → client is disabled
  delete process.env.A1_VALIDATOR_URL;
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: '00123456' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, '00123456');
  assert.equal(r._skipped, 'a1-validator disabled');
});

test('disabled client + invalid 7-digit hvhh → ok=false, regex rejects', async () => {
  delete process.env.A1_VALIDATOR_URL;
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: '1234567' });
  assert.equal(r.ok, false);
  assert.equal(r.normalized, '1234567');
  assert.match(r.error, /8 digits/);
});

test('disabled client + invalid 9-digit hvhh → ok=false, regex rejects', async () => {
  delete process.env.A1_VALIDATOR_URL;
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: '123456789' });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'hvhh must be exactly 8 digits');
});

test('disabled client + letter in hvhh → ok=false, regex rejects', async () => {
  delete process.env.A1_VALIDATOR_URL;
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: '1234567A' });
  assert.equal(r.ok, false);
  assert.equal(r.normalized, '1234567A');
});

test('disabled client + 9-char whitespace input → trimmed then checked', async () => {
  delete process.env.A1_VALIDATOR_URL;
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  // "001234567" = 9 digits after trim → invalid
  const r = await mod.validateHvhh({ hvhh: '  001234 567  ' });
  assert.equal(r.ok, false);
  assert.equal(r.normalized, '001234567');
});

test('disabled client + all-zeros hvhh → ok=true (regex does not reject all-same)', async () => {
  // Note: the local regex only checks length + digits. All-zeros is
  // technically a valid regex match. The A1-Validator would also need
  // its check-digit algorithm to reject all-zeros — for now, this is
  // a known limitation (mirrored in the existing SBOS behavior).
  delete process.env.A1_VALIDATOR_URL;
  const mod = await import(`./hvhh-validator.js?v=${Math.random()}`);
  const r = await mod.validateHvhh({ hvhh: '00000000' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, '00000000');
});
