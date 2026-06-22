# W98 Summary — Phase 3 reporting wave 5 (webhook notifications)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W97-1 shipped the scheduler worker. Every minute it
checks enabled schedules, fires the ones that are due,
and (if `notify_email` is set) calls the email stub.

The email stub was intentionally minimal: it just logs
to console. The user (CFO) actually wants reports in
their inbox. The natural next step is to wire a real
notification transport.

W98-1 adds a **webhook** alternative. The webhook is a
POST to a configured URL with the report result as
JSON. Works with any service that accepts JSON POST:
Slack / Discord / Microsoft Teams bots, Sendgrid's HTTP
API, an internal "inbox" service, or a custom
email-to-SMS bridge.

## Why not just SMTP?

SMTP direct (via nodemailer) would add ~50 transitive
deps. A webhook uses built-in `fetch` (Node 20+) and
needs 0 new deps. The user can chain:

  SBOS scheduler → webhook URL → email service → inbox

or skip the chain and consume the JSON directly (e.g. a
custom UI that shows the latest report result in a
dashboard widget).

## What shipped

- `server/finance/notifications.js` (new, 180 lines):
  - `buildWebhookPayload(execution)` — versioned JSON
    contract (event_version: 1)
  - `signPayload(body, secret)` — HMAC-SHA256
  - `sendNotification({ url, execution, secret, fetchImpl, timeoutMs })`
    — POSTs the JSON; never throws; returns
    `{ delivered, status, error }`

- `server/finance/migrations/0029_report_webhook.sql`:
  - `ALTER TABLE finance.report_schedules ADD COLUMN
    notify_webhook_url TEXT`
  - `ALTER TABLE finance.report_schedules ADD COLUMN
    notify_webhook_secret TEXT`
  (SQLite limitation: ADD COLUMN can only do one column
  at a time, so the two statements are split.)

- `server/finance/scheduleRunner.js` (extended):
  `tickOnce` now fires the webhook (after the email) if
  `sched.notify_webhook_url` is set. Webhook failure is
  non-fatal — the execution is still recorded as
  success/failed.

- `server/finance/reportScheduler.js` (extended):
  `createReportSchedule` accepts the new fields; the
  SELECTs (list + get) return them.

- 20 new unit tests in `notifications.test.js`
  (payload shape, HMAC signing, success/non-2xx/network
  error/timeout, signature verification).

- 2 new tests in `scheduleRunner.test.js` (webhook
  fires when configured; webhook failure is non-fatal).

- STEP 7p smoke: 4 OKs (create with webhook, fields
  persisted, column exists).

## Test counts

| Item | Before | After |
|---|---|---|
| Unit tests | 1604 | 1642 (+38) |
| Smoke checks | ~155 | 159 (+4) |
| Finance migrations | 28 | 29 (+1) |
| HTTP routes | ~80 | 80 (no new routes; the
  existing POST/PATCH `/api/finance/reports/schedules`
  and `/api/finance/reports/schedules/:id` now accept
  the new fields) |

## Lessons

### 1. Webhook > SMTP for an MVP

SMTP is a 30-year-old protocol with quirky
implementations (STARTTLS, AUTH PLAIN vs LOGIN, IPv6
fallback, etc). A webhook is just `fetch()` and JSON —
200 lines of code, 0 new deps, 0% chance of an obscure
TLS issue biting a deployment.

For the MVP, webhook is the right call. SMTP can come
later as an opt-in nodemailer wrapper if the user
specifically wants direct delivery.

### 2. SQLite ALTER TABLE: one column at a time

PostgreSQL/MySQL allow `ALTER TABLE foo ADD COLUMN a TEXT,
ADD COLUMN b TEXT` in a single statement. SQLite does
NOT — you get `near ",": syntax error`. Split the
two columns into two separate ALTER TABLE statements.

Caught at boot: the server failed to migrate, the
smoke step 7p caught the `near ",": syntax error` in
the migration log, and I split the statement.

**Lesson:** whenever writing a SQLite migration that
adds multiple columns, split into N statements. The
existing migration tool will apply them in order
(0029 runs in one transaction by default? if so, the
rollback is also handled). For the smoke test, this
was a real failure caught by STEP 7p, not a unit test.

### 3. Webhook signature: HMAC-SHA256 of the body

The webhook consumer (Slack, Sendgrid, etc) needs to
verify that the request came from a trusted SBOS
instance. The standard pattern: include the
HMAC-SHA256 of the request body in a header
(`X-SBOS-Signature`). The consumer recomputes the HMAC
with the shared secret and compares.

The signature uses the EXACT bytes of the request
body — not the JSON object — so the consumer can verify
without re-serializing. Implementation:

  const body = JSON.stringify(payload);
  const sig = createHmac('sha256', secret).update(body).digest('hex');
  headers['x-sbos-signature'] = sig;

The test verifies this end-to-end: the mock fetch
captures the body and signature; the test recomputes
the signature and confirms it matches.

### 4. Webhook failure is non-fatal

The scheduler must record every execution, even if the
notification fails. A network blip to Slack shouldn't
cause the report run to be marked as failed — the run
itself succeeded. The notification is "fire and
forget" with structured logging on failure.

This is the same pattern as the email transport: any
notification failure logs a warning but doesn't fail
the tick. The `summary.fired` count reflects the run
outcome, not the notification outcome.

## What's next

- **Production pg CI** — operational; needed for real
  PostgreSQL deployment.
- **CFO-facing UI** — a click-to-verify button on the
  customer detail page (uses the on-demand validate-hvhh
  endpoint from v1.0.1).
- **AI agents wave 4** — apply-merge for vendors
  (same shape as customers).
- **A1-Validator** — production PyPI publish (deferred).
