// Tests for the W70 tenant rate limit config.
//
// The W57 login rate limiter uses global defaults
// (20 per 5 min per IP, 10 per 5 min per username). The
// W70 config lets operators override on a per-tenant
// basis. This module reads the config and resolves the
// effective limits for a tenant.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
  getTenantRateLimit,
  setTenantRateLimit,
  getEffectiveLoginLimits,
  DEFAULT_LOGIN_MAX_PER_IP,
  DEFAULT_LOGIN_MAX_PER_USERNAME,
} from './tenantRateLimit.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE tenant_rate_limit (
      tenant_id INTEGER PRIMARY KEY,
      login_max_per_ip INTEGER,
      login_max_per_username INTEGER,
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_by INTEGER
    );
  `);
  return db;
}

test('getEffectiveLoginLimits: returns the global defaults when no config exists', () => {
  const db = makeDb();
  const limits = getEffectiveLoginLimits(db, 0);
  assert.equal(limits.max_per_ip, DEFAULT_LOGIN_MAX_PER_IP);
  assert.equal(limits.max_per_username, DEFAULT_LOGIN_MAX_PER_USERNAME);
});

test('getEffectiveLoginLimits: returns the per-tenant overrides when set', () => {
  const db = makeDb();
  setTenantRateLimit(db, 0, 50, 25, 1);
  const limits = getEffectiveLoginLimits(db, 0);
  assert.equal(limits.max_per_ip, 50);
  assert.equal(limits.max_per_username, 25);
});

test('getEffectiveLoginLimits: falls back to default for a NULL field', () => {
  const db = makeDb();
  // Per-IP set, per-username not. Per-IP override applies;
  // per-username falls back to the global default.
  setTenantRateLimit(db, 0, 50, null, 1);
  const limits = getEffectiveLoginLimits(db, 0);
  assert.equal(limits.max_per_ip, 50);
  assert.equal(limits.max_per_username, DEFAULT_LOGIN_MAX_PER_USERNAME);
});

test('setTenantRateLimit: upserts (second call replaces the first)', () => {
  const db = makeDb();
  setTenantRateLimit(db, 0, 50, 25, 1);
  setTenantRateLimit(db, 0, 100, 50, 2);
  const cfg = getTenantRateLimit(db, 0);
  assert.equal(cfg.login_max_per_ip, 100);
  assert.equal(cfg.login_max_per_username, 50);
  assert.equal(cfg.updated_by, 2);
});

test('setTenantRateLimit: rejects non-positive values', () => {
  const db = makeDb();
  assert.throws(() => setTenantRateLimit(db, 0, 0, 10, 1), /positive integer/);
  assert.throws(() => setTenantRateLimit(db, 0, 10, -5, 1), /positive integer/);
});

test('setTenantRateLimit: accepts NULL to fall back to default', () => {
  const db = makeDb();
  setTenantRateLimit(db, 0, null, null, 1);
  const cfg = getTenantRateLimit(db, 0);
  assert.equal(cfg.login_max_per_ip, null);
  assert.equal(cfg.login_max_per_username, null);
  // The effective limits fall back to the global defaults.
  const limits = getEffectiveLoginLimits(db, 0);
  assert.equal(limits.max_per_ip, DEFAULT_LOGIN_MAX_PER_IP);
  assert.equal(limits.max_per_username, DEFAULT_LOGIN_MAX_PER_USERNAME);
});

test('getTenantRateLimit: returns null fields for the default policy', () => {
  const db = makeDb();
  const cfg = getTenantRateLimit(db, 0);
  assert.equal(cfg, null, 'no config row exists for the default policy');
});
