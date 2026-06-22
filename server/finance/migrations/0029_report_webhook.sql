-- Phase 3 reporting wave 5 (W98-1) — webhook notification target.
--
-- Wave 3 (W96-1) added notify_email (TEXT) to
-- finance.report_schedules for email-based notifications.
-- Wave 5 adds notify_webhook_url (TEXT) for HTTP webhook
-- notifications — the "email" target was SMTP-only; the
-- webhook target is HTTP-based and works with any service
-- that accepts JSON POST (Slack, Discord, Sendgrid's HTTP
-- API, an internal inbox service, etc).
--
-- The webhook is fired AFTER the email (if both are
-- configured). Both failures are non-fatal — the execution
-- is recorded as success/failed based on the report run,
-- not the notification outcome.
--
-- The notify_webhook_secret (TEXT, nullable) column lets
-- the operator set an HMAC-SHA256 secret to sign the
-- webhook payload. Webhook consumers verify the signature
-- by recomputing the HMAC with the same secret.

-- SQLite limitation: ALTER TABLE can only add ONE column at
-- a time. Split the two ADD COLUMN statements.

ALTER TABLE finance.report_schedules
  ADD COLUMN notify_webhook_url TEXT;

ALTER TABLE finance.report_schedules
  ADD COLUMN notify_webhook_secret TEXT;
