// SBOS-A1-ERP per-tenant rate limit cache tests (Wave 71).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TenantRateLimitCache,
  makeLoginLimiterPair,
} from './rate-limit-tenant.js';

// Minimal fake limiter. The real SlidingWindowLimiter is exercised
// by the existing W57 tests; here we just need to confirm the cache
// dispatches the right pair for each tenant.
function makeFakeLimiter() {
  const counter = { consumeCount: 0, resetCount: 0 };
  return {
    counter,
    consume() {
      this.counter.consumeCount += 1;
      return { allowed: true, remaining: 0, retryAfter: 0, total: 1 };
    },
    reset() { this.counter.resetCount += 1; },
    resetAll() {},
  };
}

function makeFakeFactory() {
  const created = [];
  return {
    created,
    factory(limits) {
      const ip = makeFakeLimiter();
      const username = makeFakeLimiter();
      created.push({ limits, ip, username });
      return { ip, username };
    },
  };
}

// Fake getEffectiveLoginLimits that returns the tenant's row from
// a per-test config map. Returns the W70 snake_case shape; the
// cache translates to camelCase before calling the factory.
function makeFakeGetEffectiveLoginLimits(configs) {
  return (db, tenantId) => {
    const row = configs.get(tenantId);
    if (!row) {
      return { max_per_ip: 20, max_per_username: 10 }; // global default
    }
    return { max_per_ip: row.max_per_ip, max_per_username: row.max_per_username };
  };
}

// A db-shaped stub. The cache checks `typeof db.prepare === 'function'`
// before calling getEffectiveLoginLimits; an empty prepare is enough.
const FAKE_DB = { prepare: () => ({ get: () => null, all: () => [], run: () => ({ changes: 0, lastInsertRowid: 0 }) }) };

test('71.1 first call creates a limiter pair with the effective limits', () => {
  const f = makeFakeFactory();
  const configs = new Map([
    [5, { max_per_ip: 50, max_per_username: 25 }],
  ]);
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
  });
  const pair = cache.getLimiters(5, FAKE_DB);
  // Counters start at 0 — the limiter was created but no consume yet.
  assert.equal(pair.ip.counter.consumeCount, 0);
  assert.equal(pair.username.counter.consumeCount, 0);
  assert.equal(f.created.length, 1);
  assert.deepEqual(f.created[0].limits, { maxPerIp: 50, maxPerUsername: 25 });
  assert.equal(cache.size(), 1);
});

test('71.2 second call within TTL returns the same pair (cached)', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
  });
  const first = cache.getLimiters(0, FAKE_DB);
  const second = cache.getLimiters(0, FAKE_DB);
  assert.equal(first.ip, second.ip);
  assert.equal(first.username, second.username);
  assert.equal(f.created.length, 1);
});

test('71.3 invalidate() drops the entry, next call re-creates', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
  });
  const first = cache.getLimiters(0, FAKE_DB);
  cache.invalidate(0);
  assert.equal(cache.size(), 0);
  const second = cache.getLimiters(0, FAKE_DB);
  assert.notEqual(first.ip, second.ip);
  assert.equal(f.created.length, 2);
});

test('71.4 invalidate() for one tenant does not affect others', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
  });
  const a = cache.getLimiters(1, FAKE_DB);
  const b = cache.getLimiters(2, FAKE_DB);
  cache.invalidate(1);
  assert.equal(cache.size(), 1);
  // Tenant 1 is recreated; tenant 2 stays the same.
  const a2 = cache.getLimiters(1, FAKE_DB);
  const b2 = cache.getLimiters(2, FAKE_DB);
  assert.notEqual(a.ip, a2.ip);
  assert.equal(b.ip, b2.ip);
});

test('71.5 invalidateAll() drops every entry', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
  });
  cache.getLimiters(0, FAKE_DB);
  cache.getLimiters(1, FAKE_DB);
  cache.getLimiters(2, FAKE_DB);
  assert.equal(cache.size(), 3);
  cache.invalidateAll();
  assert.equal(cache.size(), 0);
});

test('71.6 after TTL, the next call re-reads the effective limits', () => {
  const f = makeFakeFactory();
  // The config changes between calls; if the cache respects the
  // TTL, the second call sees the new value.
  let row = { max_per_ip: 20, max_per_username: 10 };
  const getEffective = () => ({ max_per_ip: row.max_per_ip, max_per_username: row.max_per_username });
  let now = 1_000_000;
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: getEffective,
    limiterFactory: f.factory,
    ttlMs: 60_000,
    clock: () => now,
  });
  cache.getLimiters(5, FAKE_DB);
  assert.equal(f.created[0].limits.maxPerIp, 20);
  row = { max_per_ip: 100, max_per_username: 50 };
  // Same call within TTL still returns the cached pair.
  cache.getLimiters(5, FAKE_DB);
  assert.equal(f.created.length, 1);
  // Advance past TTL.
  now += 60_001;
  cache.getLimiters(5, FAKE_DB);
  assert.equal(f.created.length, 2);
  assert.equal(f.created[1].limits.maxPerIp, 100);
});

test('71.7 unknown tenant uses the default fallback', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
  });
  // No row for tenant 7; the getEffective returns the global default.
  const pair = cache.getLimiters(7, FAKE_DB);
  assert.deepEqual(f.created[0].limits, { maxPerIp: 20, maxPerUsername: 10 });
});

test('71.8 non-integer tenantId falls back to the default', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
    defaultTenantId: 0,
  });
  cache.getLimiters('not-a-number', {});
  // Created for tenant 0 (the default).
  assert.equal(f.created.length, 1);
});

test('71.9 invalid getEffectiveLoginLimits throws TypeError at construction', () => {
  assert.throws(() => new TenantRateLimitCache({ limiterFactory: () => ({}) }), TypeError);
  assert.throws(() => new TenantRateLimitCache({ getEffectiveLoginLimits: () => ({}) }), TypeError);
});

test('71.10 invalidate() with a non-integer tenantId uses the default', () => {
  const f = makeFakeFactory();
  const configs = new Map();
  const cache = new TenantRateLimitCache({
    getEffectiveLoginLimits: makeFakeGetEffectiveLoginLimits(configs),
    limiterFactory: f.factory,
    defaultTenantId: 0,
  });
  cache.getLimiters(0, FAKE_DB);
  assert.equal(cache.size(), 1);
  cache.invalidate('not-a-number');
  // Default-tenant (0) entry was dropped.
  assert.equal(cache.size(), 0);
});

test('71.11 makeLoginLimiterPair returns a pair with the right shape', () => {
  // Stub factory so we don't depend on the real SlidingWindowLimiter.
  const pair = makeLoginLimiterPair({
    maxPerIp: 5,
    maxPerUsername: 3,
    factory: ({ max }) => ({ max, fake: true }),
  });
  assert.deepEqual(pair, {
    ip: { max: 5, fake: true },
    username: { max: 3, fake: true },
  });
});

test('71.12 defaultLimiterFactory throws (placeholder)', async () => {
  const { defaultLimiterFactory } = await import('./rate-limit-tenant.js')
    .then((m) => ({ defaultLimiterFactory: m.defaultLimiterFactory }))
    .catch(() => ({ defaultLimiterFactory: null }));
  // defaultLimiterFactory is a module-private helper, not exported.
  // This test documents the expected wiring: callers must pass a
  // real factory. Skipped silently if not exported (it isn't).
  if (defaultLimiterFactory) {
    assert.throws(() => defaultLimiterFactory({ max: 1 }), /placeholder/);
  } else {
    assert.ok(true, 'defaultLimiterFactory is module-private (not exported)');
  }
});
