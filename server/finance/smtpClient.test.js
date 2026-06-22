// Phase 3 reporting wave 5 (W101-1) — SMTP client tests.
//
// We test against a local mock SMTP server that records the
// commands sent by the client. The mock responds to the
// minimal SMTP dialogue (greeting, EHLO, optional STARTTLS,
// optional AUTH, MAIL FROM, RCPT TO, DATA, QUIT). This is
// enough to verify the client's command sequencing + state
// machine without needing a real external SMTP server.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { sendMail, SmtpError } from './smtpClient.js';
import { startMockSmtpServer } from './smtpClient.test-helper.js';

// ────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────

test('sendMail: plain SMTP, no auth, single recipient — happy path', async () => {
  const server = await startMockSmtpServer({});
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      starttls: false, // no TLS upgrade; the mock doesn't have a TLS layer
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'test',
      body: 'hello world',
    });
    assert.equal(result.delivered, true);
    assert.ok(result.messageId);
    assert.deepEqual(result.accepted, ['rcpt@example.com']);
    // The client should have issued EHLO, MAIL FROM, RCPT TO, DATA.
    // (QUIT is best-effort — the client closes the socket
    // immediately, and the QUIT bytes may not make it into the
    // mock's commands array before the connection is torn down.
    // SMTP allows closing without QUIT.)
    const cmds = server.commands;
    assert.ok(cmds.some((c) => c.toUpperCase().startsWith('EHLO')));
    assert.ok(cmds.some((c) => c.toUpperCase().startsWith('MAIL FROM')));
    assert.ok(cmds.some((c) => c.toUpperCase().startsWith('RCPT TO')));
    assert.ok(cmds.some((c) => c.toUpperCase() === 'DATA'));
  } finally {
    await server.close();
  }
});

test('sendMail: AUTH PLAIN encodes user + pass as base64', async () => {
  const server = await startMockSmtpServer({});
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      starttls: false,
      user: 'alice',
      pass: 'secret',
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'test',
      body: 'hello',
    });
    assert.equal(result.delivered, true);
    // Find the AUTH command and decode the base64 blob.
    const authCmd = server.commands.find((c) => c.toUpperCase().startsWith('AUTH PLAIN '));
    assert.ok(authCmd);
    const blob = authCmd.split(' ').slice(2).join(' ');
    const decoded = Buffer.from(blob, 'base64').toString('utf8');
    assert.equal(decoded, '\0alice\0secret');
  } finally {
    await server.close();
  }
});

test('sendMail: AUTH failure returns delivered=false', async () => {
  const server = await startMockSmtpServer({ authResponse: '535 5.7.8 auth failed\r\n' });
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      starttls: false,
      user: 'alice',
      pass: 'wrong',
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'test',
      body: 'hello',
    });
    assert.equal(result.delivered, false);
    assert.equal(result.error.code, 'ESMTP');
  } finally {
    await server.close();
  }
});

test('sendMail: multiple recipients — issues one RCPT TO each', async () => {
  const server = await startMockSmtpServer({});
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      starttls: false,
      from: 'sender@example.com',
      to: ['a@example.com', 'b@example.com', 'c@example.com'],
      subject: 'test',
      body: 'hello',
    });
    assert.equal(result.delivered, true);
    assert.equal(result.accepted.length, 3);
    const rcpts = server.commands.filter((c) => c.toUpperCase().startsWith('RCPT TO'));
    assert.equal(rcpts.length, 3);
  } finally {
    await server.close();
  }
});

test('sendMail: all recipients rejected returns delivered=false', async () => {
  const server = await startMockSmtpServer({ rcptToResponse: '550 user unknown\r\n' });
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      starttls: false,
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'test',
      body: 'hello',
    });
    assert.equal(result.delivered, false);
    assert.equal(result.error.code, 'ERECIPIENTS');
  } finally {
    await server.close();
  }
});

test('sendMail: connection refused returns ECONNECT', async () => {
  // Find a port that's not listening.
  const probe = net.createServer();
  await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const result = await sendMail({
    host: '127.0.0.1',
    port,
    starttls: false,
    from: 'sender@example.com',
    to: 'rcpt@example.com',
    subject: 'test',
    body: 'hello',
  });
  assert.equal(result.delivered, false);
  // The error code is ECONNECT (connect refused) or EUNKNOWN
  // depending on OS timing.
  assert.ok(['ECONNECT', 'EUNKNOWN', 'ESOCKET'].includes(result.error.code));
});

test('sendMail: input validation — missing host', async () => {
  const result = await sendMail({
    from: 'sender@example.com',
    to: 'rcpt@example.com',
    subject: 'test',
    body: 'hello',
  });
  assert.equal(result.delivered, false);
  assert.equal(result.error.code, 'EINPUT');
});

test('sendMail: input validation — empty to', async () => {
  const result = await sendMail({
    host: '127.0.0.1',
    port: 25,
    starttls: false,
    from: 'sender@example.com',
    to: [],
    subject: 'test',
    body: 'hello',
  });
  assert.equal(result.delivered, false);
  assert.equal(result.error.code, 'EINPUT');
});

test('sendMail: input validation — non-string to', async () => {
  const result = await sendMail({
    host: '127.0.0.1',
    port: 25,
    starttls: false,
    from: 'sender@example.com',
    to: 42,
    subject: 'test',
    body: 'hello',
  });
  assert.equal(result.delivered, false);
  assert.equal(result.error.code, 'EINPUT');
});

test('sendMail: HTML body sets Content-Type: text/html', async () => {
  const server = await startMockSmtpServer({});
  try {
    const result = await sendMail({
      host: '127.0.0.1',
      port: server.port,
      starttls: false,
      from: 'sender@example.com',
      to: 'rcpt@example.com',
      subject: 'test',
      body: '<h1>hello</h1>',
      isHtml: true,
    });
    assert.equal(result.delivered, true);
    const data = server.dataBuffer();
    assert.match(data, /Content-Type: text\/html; charset=utf-8/);
  } finally {
    await server.close();
  }
});
