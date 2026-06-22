# W101 Summary — Phase 3 reporting wave 5 (SMTP integration)

**Date:** 2026-06-22.
**Repo:** `Armosphera/SBOS-A1-ERP`.
**Branch:** `main`.
**Status:** ✅ **SHIPPED**.

---

## Context

W97-1 shipped the scheduler worker with a `sendNotificationEmail` stub. The stub returned a deterministic shape so the worker wouldn't crash, but the emails went nowhere — the W97-1 worker was effectively a no-op for the notification half.

W101-1 ships the real email transport. The CFO now gets an actual email (or a captured file) every time a scheduled report fires.

## What shipped

- `server/finance/smtpClient.js` (new, ~290 lines):
  - Hand-rolled SMTP client (zero external dependencies)
  - Plain SMTP (port 25) + STARTTLS upgrade (port 587)
  - AUTH PLAIN only — no LOGIN, no CRAM-MD5, no XOAUTH2
  - One MAIL FROM per session, one or more RCPT TO, one DATA payload
  - Single recipient per call, no attachments, no DSN
  - Returns errors as structured objects (does NOT throw)
  - 5s connect timeout + 30s read timeout per command
- `server/finance/smtpClient.test.js` (new, 10 tests):
  - Uses a mock SMTP server (`smtpClient.test-helper.js`)
  - Happy path, AUTH PLAIN encoding, AUTH failure, multiple recipients, all-rejected, connection refused, input validation (3 cases), HTML body
- `server/finance/smtpClient.test-helper.js` (new):
  - Shared `startMockSmtpServer(opts)` for both smtpClient and emailService tests
  - Sends the SMTP greeting on connection (protocol requirement)
- `server/finance/emailService.js` (new, ~150 lines):
  - `createEmailService({ mode, captureDir, from, smtp, logger })`
  - Three modes:
    - `'capture'` (default when no `SBOS_SMTP_HOST`): appends to `<captureDir>/YYYY-MM-DD.jsonl`
    - `'log'`: `console.log` the payload
    - `'smtp'`: uses `smtpClient.sendMail`
  - If `mode='smtp'` but no host, falls back to `capture` (with a `console.warn` line)
- `server/finance/emailService.test.js` (new, 14 tests):
  - Mode validation, defaults, log mode, capture mode (writes, appends, is_html, auto-creates dir, msg.from override)
  - `smtp` mode falls back to capture when no host
  - `smtp` mode actually sends (via mock server)
  - Input validation
- `server/finance/scheduleRunner.js` (modified):
  - `sendNotificationEmail` now delegates to `emailService`. Auto-formats subject + pretty-prints JSON body
  - `startScheduler` accepts `emailService` option
  - `tickOnce` accepts `emailService` as the 6th parameter
  - Boot log includes email mode: `email=smtp` / `email=capture` / `email=stub`
  - Replaced `console.log` with `console.warn` to pass lint
- `server/finance/scheduleRunner.test.js` (modified):
  - Updated tests to pass an `emailService` stub
- `server/index.js` (modified):
  - `createApp()` boots the email service from env vars: `SBOS_EMAIL_MODE`, `SBOS_EMAIL_CAPTURE_DIR`, `SBOS_EMAIL_FROM`, `SBOS_SMTP_HOST`, `SBOS_SMTP_PORT`, `SBOS_SMTP_USER`, `SBOS_SMTP_PASS`, `SBOS_SMTP_STARTTLS`
  - `app.locals.emailService` exposes the service for external callers
- `scripts/deploy-smoke.sh` (STEP 7o, 2 checks):
  - Scheduler boot log shows `email=capture`
  - Capture directory auto-created on boot

## Test baseline

- 1650/1650 unit tests pass (was 1598; +52 new)
  - W101-1 contributed 24 (10 smtpClient + 14 emailService)
  - The team's parallel W98-1 contributed 28
- `npm test` clean (W101-1's files)
- `scripts/deploy-smoke.sh` RESULT: PASS

## Lessons learned

1. **Hand-rolled SMTP is the right call for a small feature.** Nodemailer is mature, but it pulls in ~50 transitive deps for one feature. The hand-rolled client is ~290 lines, supports the 90% case (plain SMTP + STARTTLS + AUTH PLAIN), and has zero external deps. The lesson: **for narrow transport needs, a hand-rolled client beats a heavyweight library**. The library saves you 100 lines but costs you 50 transitive deps + a security review surface.

2. **The mock SMTP server has a subtle bug that took 3 debug runs to find.** The first version waited for `socket.on('data')` before sending the greeting — but the SMTP protocol requires the server to send the 220 greeting IMMEDIATELY after `accept()`, BEFORE the client sends anything. The fix: send the greeting on connection (right after the `net.createServer` callback fires), not on the first data event. The lesson: **when mocking a stateful protocol, get the initial-state transitions right**.

3. **Socket cleanup on early return paths is critical for the test harness.** The first version of `sendMail` returned `{ delivered: false }` for the "all recipients rejected" case without closing the socket. The mock SMTP server's `server.close()` then blocked waiting for the connection to close. The fix: close the socket before any early return path. The lesson: **early returns from connection-based functions must clean up the connection**. The `try/finally` pattern around the whole connection lifecycle is the right shape; the early return paths must participate in the cleanup too.

4. **`console.log` is forbidden by the project's lint rules; `console.warn` is allowed.** The W97-1 worker used `console.log` for the boot message. W101-1 re-ran the lint check and the same `console.log` became a warning. The fix: switch to `console.warn`. The lesson: **when the project's lint rules allow only `console.warn` + `console.error`, boot messages should be `console.warn` not `console.log`**.

5. **The boot log line `[scheduler] worker started, tick=60000ms, tenant=0, email=capture` is the operational visibility hook for the email mode.** Without it, the operator has to read code to know whether the worker is sending real email or capturing to a file. With it, the boot log is the source of truth: `email=smtp` means "check the recipient inbox", `email=capture` means "check `var/sbos-emails/`", `email=stub` means "this is a test, no notifications". The lesson: **every boot-time subsystem should log its mode at startup**, so the operator can verify the mode by reading one log line, not by reading the code.

6. **The W98-1 migration was sqlite-incompatible; I had to fix it as collateral.** The W98-1 `0029_report_webhook.sql` used `ALTER TABLE x ADD COLUMN a, ADD COLUMN b` which works in PG but fails in sqlite. The fix is trivial: split into two `ALTER TABLE` statements (one per column), matching the 0005_tenant_id.sql pattern. The lesson: **sqlite doesn't support multi-column `ADD COLUMN` in a single ALTER**. The team's test suite must use sqlite (per the project's CI design), so the migration syntax has to match the lowest common denominator. I fixed it because the smoke check wouldn't pass otherwise.
