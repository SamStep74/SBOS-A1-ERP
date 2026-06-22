// Phase 3 reporting wave 5 (W101-1) — email service.
//
// Wraps the SMTP client (or a capture-mode stand-in) behind
// a single `send(message)` interface. The W97-1 worker
// calls `send({ to, subject, body })` and the service
// routes the message based on the configured mode:
//
//   'capture' — appends the message to a JSONL file at
//     `<captureDir>/YYYY-MM-DD.jsonl`. This is the DEFAULT
//     for dev/test: the CFO system has email-shaped output
//     (the W97-1 worker logs "delivered" to the scheduler
//     status) but doesn't actually leave the box. Easy to
//     audit + replay later.
//
//   'log' — just `console.log` the payload. Useful for
//     debugging in dev mode without writing to disk.
//
//   'smtp' — uses the SMTP client (server/finance/smtpClient.js)
//     to actually send the email. Requires SBOS_SMTP_HOST
//     + credentials to be set. If SBOS_SMTP_HOST is not
//     set and mode='smtp', the service falls back to
//     'capture' mode (with a warning log line).
//
// The service is created at boot time and passed to
// `startScheduler` via the `emailService` option. The
// service is single-instance; multiple workers can
// share one service.

import fs from 'node:fs';
import path from 'node:path';
import { sendMail as smtpSendMail } from './smtpClient.js';

// ────────────────────────────────────────────────────────────────────────
// Validation
// ────────────────────────────────────────────────────────────────────────

function assertNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
}

const VALID_MODES = Object.freeze(['capture', 'log', 'smtp']);

function assertMode(mode) {
  if (!VALID_MODES.includes(mode)) {
    throw new TypeError(`mode must be one of: ${VALID_MODES.join(', ')} (got ${String(mode)})`);
  }
}

// ────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────

function todayIsoDate() {
  return new Date().toISOString().substring(0, 10);
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

// ────────────────────────────────────────────────────────────────────────
// createEmailService factory
// ────────────────────────────────────────────────────────────────────────

/**
 * Create an email service.
 *
 * @param {object} [opts]
 * @param {string} [opts.mode='capture']
 *   'capture' | 'log' | 'smtp'
 * @param {string} [opts.captureDir='var/sbos-emails']
 *   Directory for capture-mode JSONL files. Created if missing.
 * @param {string} [opts.from='sbos-a1-erp@localhost']
 *   Default From address.
 * @param {object} [opts.smtp]
 *   SMTP config (only used when mode='smtp'):
 *     - host (required for smtp mode)
 *     - port (default 587)
 *     - user, pass (optional — omit for unauthenticated relay)
 *     - starttls (default true)
 * @param {object} [opts.logger=console]
 *   Logger with .log() / .warn() / .error() methods.
 *
 * @returns {{
 *   mode: string,
 *   send: (msg: { to: string, subject: string, body: string, isHtml?: boolean, from?: string }) =>
 *     Promise<{ delivered: boolean, mode: string, messageId?: string, captured?: string, error?: object }>,
 *   close: () => Promise<void>,
 * }}
 */
export function createEmailService(opts = {}) {
  const mode = opts.mode ?? 'capture';
  assertMode(mode);
  const captureDir = opts.captureDir ?? 'var/sbos-emails';
  const from = opts.from ?? 'sbos-a1-erp@localhost';
  const smtpConfig = opts.smtp ?? {};
  const logger = opts.logger ?? console;

  // If mode='smtp' but no host is set, fall back to capture.
  let effectiveMode = mode;
  if (mode === 'smtp' && (typeof smtpConfig.host !== 'string' || smtpConfig.host.length === 0)) {
    logger.warn('[email] mode=smtp but no SBOS_SMTP_HOST set; falling back to capture');
    effectiveMode = 'capture';
  }

  if (effectiveMode === 'capture') {
    ensureDir(captureDir);
  }

  // ─── send ───
  async function send(msg) {
    if (!msg || typeof msg !== 'object') {
      throw new TypeError('msg is required');
    }
    assertNonEmptyString(msg.to, 'msg.to');
    assertNonEmptyString(msg.subject, 'msg.subject');
    assertNonEmptyString(msg.body, 'msg.body');
    const fromAddr = msg.from || from;
    const isHtml = msg.isHtml === true;

    if (effectiveMode === 'log') {
      logger.log(`[email:log] to=${msg.to} subject=${JSON.stringify(msg.subject)} bytes=${msg.body.length}`);
      return { delivered: true, mode: 'log' };
    }

    if (effectiveMode === 'capture') {
      const filePath = path.join(captureDir, `${todayIsoDate()}.jsonl`);
      const entry = JSON.stringify({
        to: msg.to,
        from: fromAddr,
        subject: msg.subject,
        body: msg.body,
        is_html: isHtml,
        sent_at: new Date().toISOString(),
      });
      // Append synchronously — capture mode is local FS, the
      // latency is dominated by the syscall, and async
      // append would complicate the "did the file actually
      // have the entry by the time we return" invariant.
      fs.appendFileSync(filePath, `${entry}\n`, 'utf8');
      return { delivered: true, mode: 'capture', captured: filePath };
    }

    // mode === 'smtp' (the fall-through path)
    const result = await smtpSendMail({
      host: smtpConfig.host,
      port: smtpConfig.port,
      starttls: smtpConfig.starttls,
      user: smtpConfig.user,
      pass: smtpConfig.pass,
      from: fromAddr,
      to: msg.to,
      subject: msg.subject,
      body: msg.body,
      isHtml,
    });
    if (result.delivered) {
      return { delivered: true, mode: 'smtp', messageId: result.messageId };
    }
    return { delivered: false, mode: 'smtp', error: result.error };
  }

  // ─── close ───
  async function close() {
    // Capture mode uses sync FS; nothing to flush. SMTP mode
    // closes sockets per-message; nothing to flush. Future
    // batch / queued modes would flush here.
  }

  return { mode: effectiveMode, send, close };
}
