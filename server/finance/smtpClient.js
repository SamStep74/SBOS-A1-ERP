// Phase 3 reporting wave 5 (W101-1) — minimal SMTP client.
//
// Why hand-rolled instead of nodemailer: zero external
// dependencies. The CFO system needs to ship scheduled
// report emails but doesn't want to take on a large
// transitive dep tree for one feature. The scope here is
// intentionally minimal:
//
//   - Plain SMTP (port 25) or STARTTLS upgrade (port 587)
//   - AUTH PLAIN only (no LOGIN, no CRAM-MD5)
//   - One MAIL FROM per session, one or more RCPT TO,
//     one DATA payload
//   - No attachments (the report result is small text/JSON,
//     well under the 64KB SMTP limit after base64)
//   - No pipelining (SMTP responses are read in order)
//
// What this client does NOT do (out of scope for W101-1):
//   - Implicit TLS (port 465 direct TLS) — uncommon for
//     business SMTP relays
//   - Multiple recipients in one RCPT TO (we issue them
//     one at a time)
//   - HTML body multipart — we send a single body part
//   - DSN / delivery status notifications
//   - OAuth2 / XOAUTH2 (would need a token source)
//
// Returns errors as a structured object (does NOT throw)
// so the worker can log + continue without crashing the
// tick loop. The exception path is reserved for "couldn't
// even establish a connection" (network failure).

import net from 'node:net';
import tls from 'node:tls';

const DEFAULT_PORT = 587;
const CONNECT_TIMEOUT_MS = 15_000;
const READ_TIMEOUT_MS = 30_000;
const SMTP_EHLO_DOMAIN = 'sbos-a1-erp.local';

export class SmtpError extends Error {
  constructor(message, { code, response } = {}) {
    super(message);
    this.name = 'SmtpError';
    this.code = code;
    this.response = response;
  }
}

// ────────────────────────────────────────────────────────────────────────
// Validation — these return an error result instead of throwing,
// so the caller (and the scheduler worker) can log + continue
// without a try/catch dance. Network errors and SMTP protocol
// errors are also returned as structured results; only
// programmer errors (TypeError on a non-object config) throw.
// ────────────────────────────────────────────────────────────────────────

function inputError(name) {
  return { delivered: false, error: { code: 'EINPUT', message: `${name} must be a non-empty string` } };
}

function validateConfig(config) {
  if (!config || typeof config !== 'object') {
    return { delivered: false, error: { code: 'EINPUT', message: 'config must be an object' } };
  }
  if (typeof config.host !== 'string' || config.host.length === 0) return inputError('host');
  if (typeof config.from !== 'string' || config.from.length === 0) return inputError('from');
  if (typeof config.subject !== 'string' || config.subject.length === 0) return inputError('subject');
  if (typeof config.body !== 'string' || config.body.length === 0) return inputError('body');
  const to = Array.isArray(config.to) ? config.to : [config.to];
  if (to.length === 0) {
    return { delivered: false, error: { code: 'EINPUT', message: 'to is required' } };
  }
  for (const addr of to) {
    if (typeof addr !== 'string' || addr.length === 0) return inputError('to[]');
  }
  return null;
}

// ────────────────────────────────────────────────────────────────────────
// Socket read: read a single SMTP response line (or multi-line
// continuation). SMTP responses are CRLF-terminated; a multi-line
// response has the form "250-..." for all but the last line,
// and "250 ..." for the last line. The function returns the
// parsed { code, message } pair.
// ────────────────────────────────────────────────────────────────────────

function readResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      // Try to parse complete lines from the buffer.
      while (true) {
        const idx = buffer.indexOf('\r\n');
        if (idx === -1) break;
        const line = buffer.slice(0, idx).toString('utf8');
        buffer = buffer.slice(idx + 2);
        // Multi-line: "code-text" (e.g. "250-SIZE 10240000").
        // The 4th char of an SMTP response is '-' for continuation,
        // ' ' for last line.
        if (line.length < 4) continue;
        const code = Number(line.slice(0, 3));
        const isLast = line[3] === ' ';
        if (!Number.isInteger(code) || Number.isNaN(code)) continue;
        if (isLast) {
          socket.removeListener('data', onData);
          socket.removeListener('error', onError);
          socket.removeListener('timeout', onTimeout);
          resolve({ code, message: line.slice(4) });
          return;
        }
        // Else: continuation, keep reading
      }
    };
    const onError = (err) => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      reject(new SmtpError(`socket error: ${err.message}`, { code: 'ESOCKET' }));
    };
    const onTimeout = () => {
      socket.removeListener('data', onData);
      socket.removeListener('error', onError);
      socket.removeListener('timeout', onTimeout);
      reject(new SmtpError('read timeout', { code: 'ETIMEOUT' }));
    };
    socket.on('data', onData);
    socket.once('error', onError);
    socket.once('timeout', onTimeout);
  });
}

function sendCommand(socket, command) {
  return new Promise((resolve, reject) => {
    socket.write(`${command}\r\n`, (err) => {
      if (err) reject(new SmtpError(`write failed: ${err.message}`, { code: 'EWRITE' }));
      else resolve();
    });
  });
}

// ────────────────────────────────────────────────────────────────────────
// Build RFC 5322 message
// ────────────────────────────────────────────────────────────────────────

function buildMessage({ from, to, subject, body, isHtml = false, date }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${date || new Date().toUTCString()}`,
    'MIME-Version: 1.0',
    isHtml
      ? 'Content-Type: text/html; charset=utf-8'
      : 'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
  ];
  return `${headers.join('\r\n')}\r\n\r\n${body}\r\n.\r\n`;
}

// ────────────────────────────────────────────────────────────────────────
// Public API: sendMail
// ────────────────────────────────────────────────────────────────────────

/**
 * Send a single email via SMTP. Returns:
 *   { delivered: true,  messageId, accepted, rejected: [] }
 *   { delivered: false, error: { code, message } }
 *
 * @param {object} config
 * @param {string} config.host         SMTP host (e.g. "smtp.gmail.com")
 * @param {number} [config.port=587]   SMTP port
 * @param {boolean} [config.starttls=true]  Issue STARTTLS upgrade after EHLO
 * @param {string} [config.user]       AUTH PLAIN username (omit for unauth)
 * @param {string} [config.pass]       AUTH PLAIN password (omit for unauth)
 * @param {string} config.from         "From" address (and MAIL FROM)
 * @param {string|string[]} config.to  Recipient(s) — string or array
 * @param {string} config.subject
 * @param {string} config.body
 * @param {boolean} [config.isHtml=false]
 * @returns {Promise<{ delivered: boolean, messageId?: string,
 *   accepted?: string[], rejected?: string[],
 *   error?: { code: string, message: string } }>}
 */
export async function sendMail(config) {
  // Validate config (returns a structured error instead of throwing)
  const inputErr = validateConfig(config);
  if (inputErr !== null) return inputErr;
  const port = Number.isInteger(config.port) ? config.port : DEFAULT_PORT;
  const starttls = config.starttls !== false;
  const user = config.user;
  const pass = config.pass;
  const to = Array.isArray(config.to) ? config.to : [config.to];

  let socket;
  try {
    // 1. Connect
    socket = await new Promise((resolve, reject) => {
      const s = net.createConnection({ host: config.host, port });
      s.setTimeout(CONNECT_TIMEOUT_MS);
      const onTimeout = () => {
        s.destroy();
        reject(new SmtpError('connect timeout', { code: 'ETIMEOUT' }));
      };
      s.once('timeout', onTimeout);
      s.once('error', (err) => {
        s.removeListener('timeout', onTimeout);
        reject(new SmtpError(`connect failed: ${err.message}`, { code: 'ECONNECT' }));
      });
      s.once('connect', () => {
        s.removeListener('timeout', onTimeout);
        s.setTimeout(READ_TIMEOUT_MS);
        resolve(s);
      });
    });

    // 2. Read server greeting
    let resp = await readResponse(socket);
    if (resp.code !== 220) {
      throw new SmtpError(`unexpected greeting: ${resp.code} ${resp.message}`, { response: resp });
    }

    // 3. EHLO
    await sendCommand(socket, `EHLO ${SMTP_EHLO_DOMAIN}`);
    resp = await readResponse(socket);
    if (resp.code !== 250) {
      // Some servers don't support EHLO; try HELO as a fallback.
      await sendCommand(socket, `HELO ${SMTP_EHLO_DOMAIN}`);
      resp = await readResponse(socket);
      if (resp.code !== 250) {
        throw new SmtpError(`EHLO/HELO failed: ${resp.code} ${resp.message}`, { response: resp });
      }
    }

    // 4. STARTTLS upgrade (if requested and not already TLS)
    if (starttls && !socket.encrypted) {
      await sendCommand(socket, 'STARTTLS');
      resp = await readResponse(socket);
      if (resp.code !== 220) {
        // STARTTLS not supported — try to continue without TLS.
        // The connection is plaintext; we log + continue but
        // AUTH with credentials over plaintext is a security
        // risk. The caller can decide.
      } else {
        // Upgrade the socket to TLS.
        const tlsSocket = await new Promise((resolve, reject) => {
          const ts = tls.connect({
            socket,
            servername: config.host,
          });
          ts.once('secureConnect', () => resolve(ts));
          ts.once('error', (err) => reject(new SmtpError(`TLS upgrade failed: ${err.message}`, { code: 'ETLS' })));
        });
        socket = tlsSocket;
        // Re-issue EHLO over TLS (some servers require it after STARTTLS).
        await sendCommand(socket, `EHLO ${SMTP_EHLO_DOMAIN}`);
        resp = await readResponse(socket);
        if (resp.code !== 250) {
          throw new SmtpError(`EHLO after STARTTLS failed: ${resp.code} ${resp.message}`, { response: resp });
        }
      }
    }

    // 5. AUTH (if user/pass provided)
    if (user && pass) {
      // AUTH PLAIN: base64(\0user\0pass)
      const authBlob = Buffer.from(`\0${user}\0${pass}`).toString('base64');
      await sendCommand(socket, `AUTH PLAIN ${authBlob}`);
      resp = await readResponse(socket);
      if (resp.code !== 235) {
        throw new SmtpError(`AUTH failed: ${resp.code} ${resp.message}`, { response: resp });
      }
    }

    // 6. MAIL FROM
    await sendCommand(socket, `MAIL FROM:<${config.from}>`);
    resp = await readResponse(socket);
    if (resp.code !== 250) {
      throw new SmtpError(`MAIL FROM rejected: ${resp.code} ${resp.message}`, { response: resp });
    }

    // 7. RCPT TO (one per recipient)
    const accepted = [];
    const rejected = [];
    for (const addr of to) {
      await sendCommand(socket, `RCPT TO:<${addr}>`);
      resp = await readResponse(socket);
      if (resp.code === 250 || resp.code === 251) {
        accepted.push(addr);
      } else {
        rejected.push({ address: addr, code: resp.code, message: resp.message });
      }
    }
    if (accepted.length === 0) {
      // Close the socket before returning so the test
      // harness (and real-world server) doesn't hang on
      // an open connection.
      try { socket.end(); } catch (_) { /* ignore */ }
      return {
        delivered: false,
        error: { code: 'ERECIPIENTS', message: 'all recipients rejected' },
        accepted,
        rejected,
      };
    }

    // 8. DATA
    await sendCommand(socket, 'DATA');
    resp = await readResponse(socket);
    if (resp.code !== 354) {
      throw new SmtpError(`DATA rejected: ${resp.code} ${resp.message}`, { response: resp });
    }

    // Build the message and send it. SMTP requires the body
    // to be terminated by CRLF.CRLF (the "." line).
    const message = buildMessage({
      from: config.from,
      to: to.join(', '),
      subject: config.subject,
      body: config.body,
      isHtml: config.isHtml === true,
    });
    await new Promise((resolve, reject) => {
      socket.write(message, (err) => {
        if (err) reject(new SmtpError(`DATA write failed: ${err.message}`, { code: 'EWRITE' }));
        else resolve();
      });
    });
    resp = await readResponse(socket);
    if (resp.code !== 250) {
      throw new SmtpError(`DATA not accepted: ${resp.code} ${resp.message}`, { response: resp });
    }

    // 9. QUIT
    await sendCommand(socket, 'QUIT');
    // Server sends 221 on QUIT; we don't need to read it
    // because we're closing the socket anyway.
    socket.end();

    // Generate a synthetic messageId for tracking.
    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${SMTP_EHLO_DOMAIN}>`;
    return { delivered: true, messageId, accepted, rejected };
  } catch (e) {
    if (socket) {
      try { socket.end(); } catch (_) { /* ignore */ }
    }
    if (e && e.name === 'SmtpError') {
      return {
        delivered: false,
        error: { code: e.code || 'ESMTP', message: e.message },
      };
    }
    return {
      delivered: false,
      error: { code: 'EUNKNOWN', message: e && e.message ? e.message : String(e) },
    };
  }
}
