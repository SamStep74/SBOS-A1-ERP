// Phase 3 reporting wave 5 (W98-1) — webhook notification tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWebhookPayload,
  signPayload,
  sendNotification,
  WEBHOOK_EVENT_VERSION,
  ValueError,
} from './notifications.js';

test('notifications: WEBHOOK_EVENT_VERSION is 1', () => {
  assert.equal(WEBHOOK_EVENT_VERSION, 1);
});

test('buildWebhookPayload: includes all execution fields', () => {
  const started = new Date('2026-06-22T09:00:00.000Z');
  const finished = new Date('2026-06-22T09:00:01.234Z');
  const p = buildWebhookPayload({
    tenantId: 0,
    scheduleId: 42,
    scheduleName: 'Weekly AR aging',
    reportType: 'ar_aging',
    status: 'success',
    startedAt: started,
    finishedAt: finished,
    durationMs: 1234,
    resultSummary: { shape: 'object', row_count: 5 },
    errorMessage: null,
  });
  assert.equal(p.event, 'report.execution');
  assert.equal(p.event_version, 1);
  assert.equal(p.tenant_id, 0);
  assert.equal(p.schedule_id, 42);
  assert.equal(p.schedule_name, 'Weekly AR aging');
  assert.equal(p.report_type, 'ar_aging');
  assert.equal(p.status, 'success');
  assert.equal(p.started_at, '2026-06-22T09:00:00.000Z');
  assert.equal(p.finished_at, '2026-06-22T09:00:01.234Z');
  assert.equal(p.duration_ms, 1234);
  assert.deepEqual(p.result_summary, { shape: 'object', row_count: 5 });
  assert.equal(p.error_message, null);
  assert.ok(p.emitted_at, 'emitted_at should be set');
});

test('buildWebhookPayload: handles ISO string dates', () => {
  const p = buildWebhookPayload({
    tenantId: 0,
    scheduleId: 1,
    scheduleName: 'X',
    reportType: 'ar_aging',
    status: 'failed',
    startedAt: '2026-06-22T09:00:00.000Z',
    finishedAt: '2026-06-22T09:00:01.000Z',
    durationMs: 1000,
    errorMessage: 'db connection lost',
  });
  assert.equal(p.started_at, '2026-06-22T09:00:00.000Z');
  assert.equal(p.finished_at, '2026-06-22T09:00:01.000Z');
  assert.equal(p.error_message, 'db connection lost');
});

test('buildWebhookPayload: null resultSummary is allowed', () => {
  const p = buildWebhookPayload({
    tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'x',
    status: 'failed', startedAt: new Date(), finishedAt: new Date(),
    durationMs: 0, errorMessage: 'boom',
  });
  assert.equal(p.result_summary, null);
});

test('signPayload: returns hex digest, deterministic for same input', () => {
  const a = signPayload('hello', 'secret');
  const b = signPayload('hello', 'secret');
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/); // sha256 = 32 bytes = 64 hex chars
});

test('signPayload: different secret produces different signature', () => {
  const a = signPayload('hello', 'secret-1');
  const b = signPayload('hello', 'secret-2');
  assert.notEqual(a, b);
});

test('signPayload: different body produces different signature', () => {
  const a = signPayload('hello', 'secret');
  const b = signPayload('world', 'secret');
  assert.notEqual(a, b);
});

test('signPayload: empty secret throws', () => {
  assert.throws(() => signPayload('x', ''), /non-empty string/);
  assert.throws(() => signPayload('x', null), /non-empty string/);
});

test('sendNotification: success returns delivered=true + status', async () => {
  const mockFetch = async (url, opts) => ({
    ok: true,
    status: 200,
  });
  const r = await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
  });
  assert.equal(r.delivered, true);
  assert.equal(r.status, 200);
});

test('sendNotification: non-2xx response returns delivered=false + status', async () => {
  const mockFetch = async () => ({ ok: false, status: 500 });
  const r = await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
  });
  assert.equal(r.delivered, false);
  assert.equal(r.status, 500);
});

test('sendNotification: fetch throws (network error) returns delivered=false + error', async () => {
  const mockFetch = async () => { throw new Error('connection refused'); };
  const r = await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
  });
  assert.equal(r.delivered, false);
  assert.match(r.error, /connection refused/);
});

test('sendNotification: timeout (fetch never resolves) returns delivered=false', async () => {
  const mockFetch = (url, opts) => new Promise((_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const e = new Error('aborted');
      e.name = 'AbortError';
      reject(e);
    });
  });
  const r = await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
    timeoutMs: 50,
  });
  assert.equal(r.delivered, false);
  assert.match(r.error, /aborted/);
});

test('sendNotification: includes X-SBOS-Signature header when secret provided', async () => {
  let capturedHeaders = null;
  const mockFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200 };
  };
  await sendNotification({
    url: 'https://example.com/webhook',
    secret: 'shared-secret-123',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
  });
  assert.ok(capturedHeaders['x-sbos-signature']);
  assert.match(capturedHeaders['x-sbos-signature'], /^[0-9a-f]{64}$/);
});

test('sendNotification: no X-SBOS-Signature header when no secret', async () => {
  let capturedHeaders = null;
  const mockFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200 };
  };
  await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
  });
  assert.equal(capturedHeaders['x-sbos-signature'], undefined);
});

test('sendNotification: posts content-type: application/json', async () => {
  let capturedHeaders = null;
  const mockFetch = async (url, opts) => {
    capturedHeaders = opts.headers;
    return { ok: true, status: 200 };
  };
  await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(),
      durationMs: 100,
    },
    fetchImpl: mockFetch,
  });
  assert.equal(capturedHeaders['content-type'], 'application/json');
});

test('sendNotification: body is valid JSON of the payload', async () => {
  let capturedBody = null;
  const mockFetch = async (url, opts) => {
    capturedBody = opts.body;
    return { ok: true, status: 200 };
  };
  await sendNotification({
    url: 'https://example.com/webhook',
    execution: {
      tenantId: 7, scheduleId: 99, scheduleName: 'W',
      reportType: 'monthly_revenue',
      status: 'success',
      startedAt: '2026-06-22T09:00:00.000Z',
      finishedAt: '2026-06-22T09:00:05.000Z',
      durationMs: 5000,
    },
    fetchImpl: mockFetch,
  });
  const parsed = JSON.parse(capturedBody);
  assert.equal(parsed.event, 'report.execution');
  assert.equal(parsed.tenant_id, 7);
  assert.equal(parsed.schedule_id, 99);
  assert.equal(parsed.report_type, 'monthly_revenue');
});

test('sendNotification: missing url throws', async () => {
  await assert.rejects(
    sendNotification({
      url: '',
      execution: { tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'x',
        status: 'success', startedAt: new Date(), finishedAt: new Date(), durationMs: 0 },
    }),
    /non-empty string/
  );
});

test('sendNotification: missing execution returns delivered=false (never throws)', async () => {
  const r = await sendNotification({
    url: 'https://example.com/webhook',
    execution: null,
  });
  assert.equal(r.delivered, false);
  assert.match(r.error, /execution must be an object/);
});

test('sendNotification: no fetch implementation returns delivered=false', async () => {
  // Temporarily clear globalThis.fetch to simulate an env without it
  const originalFetch = globalThis.fetch;
  delete globalThis.fetch;
  try {
    const r = await sendNotification({
      url: 'https://example.com/webhook',
      execution: {
        tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'x',
        status: 'success', startedAt: new Date(), finishedAt: new Date(), durationMs: 0,
      },
      fetchImpl: null, // force no fetchImpl so it falls back to globalThis
    });
    assert.equal(r.delivered, false);
    assert.match(r.error, /no fetch implementation/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('sendNotification: signature is verifiable by recomputing on the receiver', async () => {
  let capturedBody = null;
  let capturedSig = null;
  const mockFetch = async (url, opts) => {
    capturedBody = opts.body;
    capturedSig = opts.headers['x-sbos-signature'];
    return { ok: true, status: 200 };
  };
  const secret = 'shared-secret-456';
  await sendNotification({
    url: 'https://example.com/webhook',
    secret,
    execution: {
      tenantId: 0, scheduleId: 1, scheduleName: 'X', reportType: 'ar_aging',
      status: 'success', startedAt: new Date(), finishedAt: new Date(), durationMs: 0,
    },
    fetchImpl: mockFetch,
  });
  // The receiver recomputes the signature using the same secret
  // and body, then compares to the header.
  const expected = signPayload(capturedBody, secret);
  assert.equal(capturedSig, expected);
});
