// Unit tests for server/rate-limit.js (Wave 57).
//
// Tests the SlidingWindowLimiter sliding-window behavior:
//   - up to `max` attempts within `windowMs` are allowed
//   - the (max+1)th attempt is denied with retryAfter
//   - after the window slides, attempts are allowed again
//   - per-key isolation (different keys have independent budgets)
//   - peek() doesn't record an attempt
//   - reset() + resetAll() clear state
//   - the login rate-limit singleton has the configured policy

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  SlidingWindowLimiter,
  checkLoginRateLimit,
  resetLoginRateLimit,
} from './rate-limit.js';

test('SlidingWindowLimiter: allows up to max attempts in the window', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 3 });
  assert.deepEqual(lim.consume('a'), { allowed: true, remaining: 2, retryAfter: 0, total: 1 });
  assert.deepEqual(lim.consume('a'), { allowed: true, remaining: 1, retryAfter: 0, total: 2 });
  assert.deepEqual(lim.consume('a'), { allowed: true, remaining: 0, retryAfter: 0, total: 3 });
});

test('SlidingWindowLimiter: denies the (max+1)th attempt with retryAfter', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 2 });
  lim.consume('a');
  lim.consume('a');
  const third = lim.consume('a');
  assert.equal(third.allowed, false);
  assert.equal(third.remaining, 0);
  assert.ok(third.retryAfter > 0 && third.retryAfter <= 1, `retryAfter in (0,1]: ${third.retryAfter}`);
  assert.equal(third.total, 3);
});

test('SlidingWindowLimiter: per-key isolation', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 2 });
  lim.consume('a');
  lim.consume('a');
  // 'a' is now at max; 'b' has its own budget.
  const aThird = lim.consume('a');
  const bFirst = lim.consume('b');
  assert.equal(aThird.allowed, false);
  assert.equal(bFirst.allowed, true);
  assert.equal(bFirst.remaining, 1);
});

test('SlidingWindowLimiter: peek does not record an attempt', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 5 });
  lim.consume('a'); // total = 1
  const peek1 = lim.peek('a');
  assert.equal(peek1.total, 1);
  assert.equal(peek1.remaining, 4);
  // Peek again — still total=1, not 2.
  const peek2 = lim.peek('a');
  assert.equal(peek2.total, 1);
  // A real consume bumps the total.
  lim.consume('a');
  assert.equal(lim.peek('a').total, 2);
});

test('SlidingWindowLimiter: reset/resetAll clear state', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 2 });
  lim.consume('a');
  lim.consume('a');
  assert.equal(lim.consume('a').allowed, false);
  lim.reset('a');
  assert.equal(lim.consume('a').allowed, true);
  lim.consume('a');
  assert.equal(lim.consume('a').allowed, false);
  lim.resetAll();
  assert.equal(lim.consume('a').allowed, true);
});

test('SlidingWindowLimiter: window slides — old attempts expire', async () => {
  const lim = new SlidingWindowLimiter({ windowMs: 50, max: 2 });
  lim.consume('a');
  lim.consume('a');
  assert.equal(lim.consume('a').allowed, false);
  // Wait for the window to slide.
  await new Promise((r) => setTimeout(r, 70));
  // Old attempts are pruned; we have a fresh budget.
  assert.equal(lim.consume('a').allowed, true);
});

test('SlidingWindowLimiter: empty key is allowed (defensive)', () => {
  const lim = new SlidingWindowLimiter({ windowMs: 1000, max: 2 });
  const r = lim.consume('');
  assert.equal(r.allowed, true);
  assert.equal(r.remaining, 2);
});

test('checkLoginRateLimit: per-IP and per-username are independent', () => {
  resetLoginRateLimit();
  // Same IP, different usernames → IP budget shared, user budgets independent.
  for (let i = 0; i < 3; i++) {
    const r = checkLoginRateLimit({ ip: '1.1.1.1', username: `user${i}` });
    assert.equal(r.allowed, true);
  }
  // Same IP, same username → user budget fills up.
  for (let i = 0; i < 10; i++) {
    checkLoginRateLimit({ ip: '1.1.1.1', username: 'alice' });
  }
  // The 11th attempt for alice is denied.
  const denied = checkLoginRateLimit({ ip: '1.1.1.1', username: 'alice' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, 'user');
  assert.ok(denied.retryAfter > 0);
  // A different username from the same IP is still allowed.
  const ok = checkLoginRateLimit({ ip: '1.1.1.1', username: 'bob' });
  assert.equal(ok.allowed, true);
});

test('checkLoginRateLimit: per-IP limit blocks even with different usernames', () => {
  resetLoginRateLimit();
  // 20 attempts from the same IP with different usernames should
  // hit the per-IP limit.
  for (let i = 0; i < 20; i++) {
    const r = checkLoginRateLimit({ ip: '2.2.2.2', username: `u${i}` });
    assert.equal(r.allowed, true);
  }
  // The 21st attempt is denied with scope=ip.
  const denied = checkLoginRateLimit({ ip: '2.2.2.2', username: 'new-user' });
  assert.equal(denied.allowed, false);
  assert.equal(denied.scope, 'ip');
});

test('checkLoginRateLimit: a fresh IP is not affected by a denied IP', () => {
  resetLoginRateLimit();
  // Burn the IP budget for 3.3.3.3.
  for (let i = 0; i < 20; i++) {
    checkLoginRateLimit({ ip: '3.3.3.3', username: `u3-${i}` });
  }
  const denied = checkLoginRateLimit({ ip: '3.3.3.3', username: 'u3-new' });
  assert.equal(denied.allowed, false);
  // 4.4.4.4 has its own IP budget + uses a different username
  // (so the per-user budget for 'u3-new' is fresh too).
  const ok = checkLoginRateLimit({ ip: '4.4.4.4', username: 'u4-fresh' });
  assert.equal(ok.allowed, true);
});
