// lib/a1-validator-client.test.js — Node --test style tests for the client.
//
// Uses an injected fetch mock so the tests are hermetic (no real network).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { A1ValidatorClient } from './a1-validator-client.js';

function makeMockFetch(responses) {
  // responses: array of { status, body } in call order
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, opts });
    const r = responses.shift();
    if (!r) throw new Error('No mock response left');
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      json: async () => r.body,
    };
  };
  return { fn, calls };
}

test('disabled client returns _skipped', async () => {
  const c = new A1ValidatorClient({ enabled: false, baseUrl: 'http://nope' });
  const r = await c.validate('hvvh', { hvhh: '00123456' });
  assert.equal(r.ok, null);
  assert.equal(r._skipped, true);
});

test('health() returns ok=true on 200', async () => {
  const { fn } = makeMockFetch([{ status: 200, body: { name: 'a1-validator', version: '0.4.0', validators: ['hhvh', 'inn'] } }]);
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn });
  const h = await c.health();
  assert.equal(h.ok, true);
  assert.equal(h.name, 'a1-validator');
  assert.equal(h.version, '0.4.0');
  assert.deepEqual(h.validators, ['hhvh', 'inn']);
});

test('health() returns ok=false on connection refused', async () => {
  const fn = async () => { throw new Error('ECONNREFUSED'); };
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn, retries: 0 });
  const h = await c.health();
  assert.equal(h.ok, false);
  assert.match(h.error, /unreachable/);
});

test('listKinds() returns kinds array', async () => {
  const { fn } = makeMockFetch([{ status: 200, body: { validators: ['hhvh', 'inn', 'mx_rfc', 'kr_brn'] } }]);
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn });
  const kinds = await c.listKinds();
  assert.deepEqual(kinds, ['hhvh', 'inn', 'mx_rfc', 'kr_brn']);
});

test('listKinds() returns [] on 500', async () => {
  const { fn } = makeMockFetch([{ status: 500, body: {} }]);
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn });
  const kinds = await c.listKinds();
  assert.deepEqual(kinds, []);
});

test('validate() POSTs JSON to /validate/<kind>', async () => {
  const { fn, calls } = makeMockFetch([{ status: 200, body: { ok: true, normalized: '00123456', error: null } }]);
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn });
  const r = await c.validate('hvvh', { hvhh: '00123456' });
  assert.equal(r.ok, true);
  assert.equal(r.normalized, '00123456');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'http://x/validate/hvvh');
  assert.equal(calls[0].opts.method, 'POST');
  assert.equal(calls[0].opts.headers['content-type'], 'application/json');
  const body = JSON.parse(calls[0].opts.body);
  assert.deepEqual(body, { hvhh: '00123456' });
});

test('validate() returns ok=null on 4xx (no crash)', async () => {
  const { fn } = makeMockFetch([{ status: 404, body: { error: 'Unknown kind' } }]);
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn });
  const r = await c.validate('does_not_exist', { x: 1 });
  assert.equal(r.ok, null);
  assert.equal(r._error, 'HTTP 404');
});

test('validate() retries on network error', async () => {
  let attempts = 0;
  const fn = async (url) => {
    attempts++;
    if (attempts < 3) throw new Error('ECONNRESET');
    return { ok: true, status: 200, json: async () => ({ ok: true, normalized: 'X' }) };
  };
  const c = new A1ValidatorClient({ baseUrl: 'http://x', fetch: fn, retries: 2, timeoutMs: 5000 });
  const r = await c.validate('hvvh', { hvhh: 'X' });
  assert.equal(attempts, 3);
  assert.equal(r.ok, true);
});

test('trailing slash is stripped from baseUrl', () => {
  const c = new A1ValidatorClient({ baseUrl: 'http://x:8000///', fetch: () => {} });
  assert.equal(c.baseUrl, 'http://x:8000');
});
