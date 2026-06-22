// Phase 3 reporting wave 5 (W101-1) — email service tests.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { createEmailService } from './emailService.js';
import { startMockSmtpServer } from './smtpClient.test-helper.js';

function makeTempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sbos-email-test-'));
}

test('createEmailService: defaults to capture mode', () => {
  const svc = createEmailService();
  assert.equal(svc.mode, 'capture');
});

test('createEmailService: rejects unknown mode', () => {
  assert.throws(() => createEmailService({ mode: 'banana' }), /mode must be one of/);
});

test('createEmailService: log mode logs the payload + returns delivered=true', async () => {
  let logged = null;
  const logger = { log: (line) => { logged = line; }, warn: () => {}, error: () => {} };
  const svc = createEmailService({ mode: 'log', logger });
  const result = await svc.send({
    to: 'cfo@example.com',
    subject: 'test',
    body: 'hello',
  });
  assert.equal(result.delivered, true);
  assert.equal(result.mode, 'log');
  assert.match(logged, /to=cfo@example.com/);
});

test('createEmailService: capture mode writes to JSONL file', async () => {
  const tmpDir = makeTempDir();
  try {
    const svc = createEmailService({ mode: 'capture', captureDir: tmpDir });
    const result = await svc.send({
      to: 'cfo@example.com',
      subject: 'Weekly AR Aging',
      body: '...',
    });
    assert.equal(result.delivered, true);
    assert.equal(result.mode, 'capture');
    assert.ok(result.captured);
    assert.ok(fs.existsSync(result.captured));
    // The file is named YYYY-MM-DD.jsonl; today's date.
    const today = new Date().toISOString().substring(0, 10);
    assert.equal(path.basename(result.captured), `${today}.jsonl`);
    // Read the entry back; verify the shape.
    const content = fs.readFileSync(result.captured, 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 1);
    const entry = JSON.parse(lines[0]);
    assert.equal(entry.to, 'cfo@example.com');
    assert.equal(entry.subject, 'Weekly AR Aging');
    assert.equal(entry.body, '...');
    assert.equal(entry.is_html, false);
    assert.ok(entry.sent_at);
    assert.ok(entry.from);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createEmailService: capture mode appends multiple entries', async () => {
  const tmpDir = makeTempDir();
  try {
    const svc = createEmailService({ mode: 'capture', captureDir: tmpDir });
    await svc.send({ to: 'a@example.com', subject: 's1', body: 'b1' });
    await svc.send({ to: 'b@example.com', subject: 's2', body: 'b2' });
    await svc.send({ to: 'c@example.com', subject: 's3', body: 'b3' });
    const files = fs.readdirSync(tmpDir);
    assert.equal(files.length, 1);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const lines = content.trim().split('\n');
    assert.equal(lines.length, 3);
    const entries = lines.map((l) => JSON.parse(l));
    assert.equal(entries[0].to, 'a@example.com');
    assert.equal(entries[1].to, 'b@example.com');
    assert.equal(entries[2].to, 'c@example.com');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createEmailService: capture mode is_html true sets is_html', async () => {
  const tmpDir = makeTempDir();
  try {
    const svc = createEmailService({ mode: 'capture', captureDir: tmpDir });
    await svc.send({ to: 'cfo@example.com', subject: 's', body: '<h1>hi</h1>', isHtml: true });
    const files = fs.readdirSync(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const entry = JSON.parse(content.trim().split('\n')[0]);
    assert.equal(entry.is_html, true);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createEmailService: smtp mode falls back to capture when no host', async () => {
  const tmpDir = makeTempDir();
  let warned = null;
  const logger = { log: () => {}, warn: (m) => { warned = m; }, error: () => {} };
  try {
    const svc = createEmailService({
      mode: 'smtp',
      captureDir: tmpDir,
      logger,
      // smtp.host is NOT set — should fall back to capture
    });
    assert.equal(svc.mode, 'capture');
    assert.match(warned, /no SBOS_SMTP_HOST/);
    const result = await svc.send({ to: 'a@example.com', subject: 's', body: 'b' });
    assert.equal(result.delivered, true);
    assert.equal(result.mode, 'capture');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createEmailService: smtp mode sends via SMTP when host is set', async () => {
  const server = await startMockSmtpServer({});
  try {
    const svc = createEmailService({
      mode: 'smtp',
      smtp: { host: '127.0.0.1', port: server.port, starttls: false },
      from: 'cfo@sbos.local',
    });
    assert.equal(svc.mode, 'smtp');
    const result = await svc.send({
      to: 'cfo@example.com',
      subject: 'test smtp',
      body: 'hello',
    });
    assert.equal(result.delivered, true);
    assert.equal(result.mode, 'smtp');
    assert.ok(result.messageId);
    // The mock should have seen our MAIL FROM with the right from address.
    const mailFrom = server.commands.find((c) => c.toUpperCase().startsWith('MAIL FROM'));
    assert.ok(mailFrom);
    assert.match(mailFrom, /cfo@sbos\.local/);
  } finally {
    await server.close();
  }
});

test('createEmailService: input validation — missing to', async () => {
  const svc = createEmailService({ mode: 'log' });
  await assert.rejects(
    svc.send({ subject: 's', body: 'b' }),
    /msg\.to/,
  );
});

test('createEmailService: input validation — missing subject', async () => {
  const svc = createEmailService({ mode: 'log' });
  await assert.rejects(
    svc.send({ to: 'a@example.com', body: 'b' }),
    /msg\.subject/,
  );
});

test('createEmailService: input validation — empty body', async () => {
  const svc = createEmailService({ mode: 'log' });
  await assert.rejects(
    svc.send({ to: 'a@example.com', subject: 's', body: '' }),
    /msg\.body/,
  );
});

test('createEmailService: msg.from overrides default from', async () => {
  const tmpDir = makeTempDir();
  try {
    const svc = createEmailService({ mode: 'capture', captureDir: tmpDir, from: 'default@sbos.local' });
    await svc.send({ to: 'a@example.com', subject: 's', body: 'b', from: 'override@sbos.local' });
    const files = fs.readdirSync(tmpDir);
    const content = fs.readFileSync(path.join(tmpDir, files[0]), 'utf8');
    const entry = JSON.parse(content.trim().split('\n')[0]);
    assert.equal(entry.from, 'override@sbos.local');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('createEmailService: close is a no-op for capture/log', async () => {
  const svc = createEmailService({ mode: 'log' });
  await svc.close(); // no throw
});

test('createEmailService: capture mode auto-creates the directory', () => {
  const tmpRoot = makeTempDir();
  const nested = path.join(tmpRoot, 'a', 'b', 'c');
  try {
    const svc = createEmailService({ mode: 'capture', captureDir: nested });
    assert.equal(svc.mode, 'capture');
    // The directory should now exist.
    assert.ok(fs.existsSync(nested));
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
