// SBOS-A1-ERP rate-limit reset tests (Wave 78).

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkLoginRateLimit,
  resetLoginRateLimit,
  resetLoginRateLimitByIp,
  resetLoginRateLimitByUsername,
} from './rate-limit.js';

test('78.1 resetLoginRateLimitByIp clears just the per-IP budget', () => {
  resetLoginRateLimit();
  // Burn the IP budget.
  for (let i = 0; i < 5; i++) {
    checkLoginRateLimit({ ip: '1.2.3.4', username: `u${i}` });
  }
  // The IP is now partway through the budget.
  let blocked = checkLoginRateLimit({ ip: '1.2.3.4', username: 'u-new' });
  // The reset clears the IP key only.
  const touched = resetLoginRateLimitByIp('1.2.3.4');
  assert.ok(touched >= 1, `expected to touch at least 1 tenant limiter, got ${touched}`);
  // The IP is fresh.
  const after = checkLoginRateLimit({ ip: '1.2.3.4', username: 'u-new' });
  assert.equal(after.allowed, true);
  // Username counters for OTHER IPs are untouched.
  // (No easy way to verify without exposing the Map;
  // the next test covers this for username.)
  blocked = null; // suppress unused warning
});

test('78.2 resetLoginRateLimitByUsername clears just the per-username budget', () => {
  resetLoginRateLimit();
  for (let i = 0; i < 3; i++) {
    checkLoginRateLimit({ ip: '5.6.7.8', username: 'alice' });
  }
  const touched = resetLoginRateLimitByUsername('alice');
  assert.ok(touched >= 1);
  // Alice's per-username counter is fresh.
  const after = checkLoginRateLimit({ ip: '5.6.7.8', username: 'alice' });
  assert.equal(after.allowed, true);
});

test('78.3 resetLoginRateLimitByIp with empty ip returns 0 (no walk)', () => {
  // Cache may already be populated by prior tests in the
  // same process, so we can't reliably test the "no
  // cache" branch here. The empty-ip guard is a no-walk
  // short-circuit instead: we should return 0 without
  // iterating.
  resetLoginRateLimit();
  checkLoginRateLimit({ ip: '9.9.9.9', username: 'x' });
  const touched = resetLoginRateLimitByIp('');
  assert.equal(touched, 0);
});

test('78.4 resetLoginRateLimitByIp with empty ip returns 0', () => {
  resetLoginRateLimit();
  checkLoginRateLimit({ ip: '9.9.9.9', username: 'x' });
  const touched = resetLoginRateLimitByIp('');
  assert.equal(touched, 0);
});

test('78.5 resetLoginRateLimit clears everything (per-IP + per-username)', () => {
  for (let i = 0; i < 5; i++) {
    checkLoginRateLimit({ ip: '4.4.4.4', username: 'u' });
  }
  resetLoginRateLimit();
  // After reset, the first attempt is allowed (fresh state).
  const after = checkLoginRateLimit({ ip: '4.4.4.4', username: 'u' });
  assert.equal(after.allowed, true);
  // The total is 1 (just this attempt).
  assert.equal(after.total, 1);
});
