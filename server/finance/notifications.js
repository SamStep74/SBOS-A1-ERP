// Phase 3 reporting wave 5 (W98-1) — webhook notifications.
//
// W97-1 shipped the scheduler worker with a `sendNotificationEmail`
// stub. This module replaces the stub with a real
// `sendNotification` that supports a generic HTTP webhook
// transport. The webhook is the "email" target — the user can
// point it at any HTTP service that accepts JSON POST:
//   - Slack / Discord / Microsoft Teams (via their webhook URLs)
//   - Sendgrid / Mailgun / Postmark (their HTTP API)
//   - An internal "inbox" service
//   - A custom email-to-SMS bridge
//
// Why not SMTP directly? Adding nodemailer would pull in
// ~50 transitive deps. A webhook needs 0 deps (uses
// built-in fetch). The user can chain:
//   SBOS scheduler → webhook URL → email service → inbox
// or skip the chain and consume the JSON directly.
//
// The webhook sends a JSON payload with the report result:
//   { event: "report.execution",
//     tenant_id, schedule_id, schedule_name, report_type,
//     status, started_at, finished_at, duration_ms,
//     result_summary, error_message }
//
// Authentication: optional HMAC-SHA256 signature in the
// `X-SBOS-Signature` header. Configure via SBOS_WEBHOOK_SECRET.
// Recipients (Slack, Mailgun) verify the signature to ensure
// the request is from a trusted SBOS instance.

import { createHmac } from 'node:crypto';

export class ValueError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ValueError';
  }
}

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValueError(`${name} must be a non-empty string`);
  }
}

/**
 * Build the JSON payload for a webhook notification. The
 * shape is a public contract — webhook consumers (Slack
 * bots, email bridges, etc) parse it. Changes to the shape
 * are breaking changes for downstream consumers; version
 * the field via the `event_version` constant.
 */
export const WEBHOOK_EVENT_VERSION = 1;

export function buildWebhookPayload({
  tenantId,
  scheduleId,
  scheduleName,
  reportType,
  status,
  startedAt,
  finishedAt,
  durationMs,
  resultSummary,
  errorMessage,
}) {
  return {
    event: 'report.execution',
    event_version: WEBHOOK_EVENT_VERSION,
    tenant_id: tenantId,
    schedule_id: scheduleId,
    schedule_name: scheduleName,
    report_type: reportType,
    status, // 'success' | 'failed'
    started_at: startedAt instanceof Date ? startedAt.toISOString() : String(startedAt),
    finished_at: finishedAt instanceof Date ? finishedAt.toISOString() : String(finishedAt),
    duration_ms: durationMs,
    result_summary: resultSummary ?? null,
    error_message: errorMessage ?? null,
    emitted_at: new Date().toISOString(),
  };
}

/**
 * Sign a payload with HMAC-SHA256. Returns a hex digest.
 * The webhook consumer verifies by recomputing the HMAC
 * with the shared secret.
 */
export function signPayload(payload, secret) {
  if (typeof secret !== 'string' || secret.length === 0) {
    throw new ValueError('secret must be a non-empty string');
  }
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return createHmac('sha256', secret).update(body).digest('hex');
}

/**
 * Send a notification to a webhook URL. Uses the global
 * `fetch` (Node 20+). The `fetchImpl` parameter allows tests
 * to inject a mock.
 *
 * The function:
 * 1. Builds the payload (versioned contract).
 * 2. Optionally signs it with HMAC-SHA256.
 * 3. POSTs as `application/json`.
 * 4. Returns the response status + a `delivered` flag.
 *
 * Never throws. The scheduler worker must record every
 * execution (success or failure) regardless of notification
 * outcome.
 *
 * @param {object} args
 * @param {string} args.url — the webhook URL
 * @param {object} args.execution — the execution record
 *   { tenantId, scheduleId, scheduleName, reportType,
 *     status, startedAt, finishedAt, durationMs,
 *     resultSummary, errorMessage }
 * @param {string} [args.secret] — optional HMAC secret
 * @param {object} [args.fetchImpl] — injected fetch (default: globalThis.fetch)
 * @param {number} [args.timeoutMs=5000] — request timeout
 * @returns {Promise<{ delivered: boolean, status?: number, error?: string }>}
 */
export async function sendNotification({
  url,
  execution,
  secret = null,
  fetchImpl = null,
  timeoutMs = 5000,
}) {
  assertNonEmptyString(url, 'url');
  if (!execution || typeof execution !== 'object') {
    return { delivered: false, error: 'execution must be an object' };
  }
  const payload = buildWebhookPayload(execution);
  const body = JSON.stringify(payload);
  const headers = {
    'content-type': 'application/json',
    'user-agent': 'sbos-scheduler/1.0',
  };
  if (secret) {
    headers['x-sbos-signature'] = signPayload(body, secret);
  }
  const fetch = fetchImpl || globalThis.fetch;
  if (typeof fetch !== 'function') {
    return { delivered: false, error: 'no fetch implementation available' };
  }
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const res = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: controller.signal,
    });
    clearTimeout(timer);
    return {
      delivered: res.ok,
      status: res.status,
    };
  } catch (err) {
    return {
      delivered: false,
      error: err && err.message ? err.message : String(err),
    };
  }
}
