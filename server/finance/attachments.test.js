// Unit tests for server/finance/attachments.js (Wave 56).
//
// Tests the pure functions: addAttachment, listAttachments,
// getAttachment, deleteAttachment, readAttachmentBytes. Uses
// a tmp dir for the actual file storage so the test exercises
// the real writeFileSync / readFileSync / unlinkSync paths.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

import {
  addAttachment,
  listAttachments,
  getAttachment,
  deleteAttachment,
  readAttachmentBytes,
} from './attachments.js';

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE invoice_attachments (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      tenant_id       INTEGER NOT NULL DEFAULT 0,
      invoice_id      INTEGER NOT NULL,
      filename        TEXT NOT NULL,
      mime_type       TEXT,
      size_bytes      INTEGER NOT NULL,
      sha256          TEXT NOT NULL,
      description     TEXT,
      storage_path    TEXT NOT NULL,
      uploaded_by     INTEGER,
      uploaded_at     TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);
  const dir = mkdtempSync(join(tmpdir(), 'sbos-attachments-'));
  const pg = {
    async query(sql, params = []) {
      const translated = String(sql)
        .replace(/\$\d+/g, '?')
        .replace(/::\s*[a-zA-Z_][a-zA-Z0-9_]*/g, '')
        .replace(/(?<![A-Za-z0-9_'".])finance\.([A-Za-z_][A-Za-z0-9_]*)/g, '$1');
      const upper = translated.trim().toUpperCase();
      if (upper.startsWith('INSERT')) {
        const stmt = db.prepare(translated);
        const res = stmt.run(...(params || []));
        const id = Number(res.lastInsertRowid);
        const row = db
          .prepare('SELECT * FROM invoice_attachments WHERE id = ?')
          .get(id);
        return { rows: [row] };
      }
      if (upper.startsWith('DELETE') || upper.startsWith('UPDATE')) {
        const stmt = db.prepare(translated);
        stmt.run(...(params || []));
        return { rows: [] };
      }
      const stmt = db.prepare(translated);
      const rows = stmt.all(...(params || []));
      return { rows };
    },
  };
  return { db, pg, dir };
}

test('addAttachment: writes file to disk + row to db', async () => {
  const { pg, dir } = makeDb();
  const buf = Buffer.from('hello world\n');
  const row = await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 42,
    buffer: buf,
    filename: 'hello.txt',
    mimeType: 'text/plain',
    description: 'test upload',
    uploadedBy: 1,
    attachmentsDir: dir,
  });
  assert.ok(row.id, 'row.id must be present');
  assert.equal(row.filename, 'hello.txt');
  assert.equal(row.mime_type, 'text/plain');
  assert.equal(row.size_bytes, buf.length);
  // sha256 matches the buffer.
  const expected = createHash('sha256').update(buf).digest('hex');
  assert.equal(row.sha256, expected);
  // The file is on disk at row.storage_path (the on-disk name
  // uses a random id, NOT the DB row's auto-increment id).
  const filePath = row.storage_path;
  assert.ok(existsSync(filePath), 'file must exist on disk');
  const onDisk = readFileSync(filePath);
  assert.deepEqual(onDisk, buf);
  // The DB row points at the same path.
  assert.equal(row.storage_path, filePath);
});

test('addAttachment: rejects empty buffer', async () => {
  const { pg, dir } = makeDb();
  await assert.rejects(
    addAttachment(pg, {
      tenantId: 0,
      invoiceId: 1,
      buffer: Buffer.alloc(0),
      filename: 'empty.txt',
      attachmentsDir: dir,
    }),
    (err) => /non-empty/.test(err.message),
  );
});

test('addAttachment: rejects path-separator filename', async () => {
  const { pg, dir } = makeDb();
  await assert.rejects(
    addAttachment(pg, {
      tenantId: 0,
      invoiceId: 1,
      buffer: Buffer.from('x'),
      filename: '../../etc/passwd',
      attachmentsDir: dir,
    }),
    (err) => /path separators/.test(err.message),
  );
});

test('addAttachment: rejects forbidden extension', async () => {
  const { pg, dir } = makeDb();
  await assert.rejects(
    addAttachment(pg, {
      tenantId: 0,
      invoiceId: 1,
      buffer: Buffer.from('x'),
      filename: 'malware.exe',
      attachmentsDir: dir,
    }),
    (err) => /not allowed/.test(err.message),
  );
});

test('addAttachment: rejects oversized buffer', async () => {
  const { pg, dir } = makeDb();
  // 26 MB exceeds the 25 MB cap.
  const big = Buffer.alloc(26 * 1024 * 1024, 0);
  await assert.rejects(
    addAttachment(pg, {
      tenantId: 0,
      invoiceId: 1,
      buffer: big,
      filename: 'big.bin',
      attachmentsDir: dir,
    }),
    (err) => /too large/.test(err.message),
  );
});

test('listAttachments: returns the rows for one invoice, most-recent first', async () => {
  const { pg, dir } = makeDb();
  await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 1,
    buffer: Buffer.from('a'),
    filename: 'a.txt',
    attachmentsDir: dir,
  });
  await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 1,
    buffer: Buffer.from('b'),
    filename: 'b.txt',
    attachmentsDir: dir,
  });
  await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 2, // different invoice — must NOT appear
    buffer: Buffer.from('c'),
    filename: 'c.txt',
    attachmentsDir: dir,
  });
  const items = await listAttachments(pg, 0, 1);
  assert.equal(items.length, 2);
  // Most-recent first: b inserted second.
  assert.equal(items[0].filename, 'b.txt');
  assert.equal(items[1].filename, 'a.txt');
  for (const it of items) {
    assert.equal(it.invoice_id, 1);
  }
});

test('getAttachment: returns null for unknown id, row for known id', async () => {
  const { pg, dir } = makeDb();
  const row = await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 1,
    buffer: Buffer.from('a'),
    filename: 'a.txt',
    attachmentsDir: dir,
  });
  const found = await getAttachment(pg, 0, row.id);
  assert.ok(found);
  assert.equal(found.filename, 'a.txt');
  const missing = await getAttachment(pg, 0, 99999);
  assert.equal(missing, null);
});

test('getAttachment: tenant isolation (cross-tenant returns null)', async () => {
  const { pg, dir } = makeDb();
  const row = await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 1,
    buffer: Buffer.from('a'),
    filename: 'a.txt',
    attachmentsDir: dir,
  });
  // tenant 7 can't see tenant 0's row.
  const cross = await getAttachment(pg, 7, row.id);
  assert.equal(cross, null);
});

test('deleteAttachment: removes metadata + file', async () => {
  const { pg, dir } = makeDb();
  const row = await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 1,
    buffer: Buffer.from('a'),
    filename: 'a.txt',
    attachmentsDir: dir,
  });
  const filePath = row.storage_path;
  assert.ok(existsSync(filePath), 'precondition: file exists');
  const ok = await deleteAttachment(pg, 0, row.id);
  assert.equal(ok, true);
  // File is gone.
  assert.ok(!existsSync(filePath), 'file must be deleted');
  // Metadata is gone.
  const after = await getAttachment(pg, 0, row.id);
  assert.equal(after, null);
});

test('readAttachmentBytes: returns the buffer + catches size drift', async () => {
  const { pg, dir } = makeDb();
  const buf = Buffer.from('hello');
  const row = await addAttachment(pg, {
    tenantId: 0,
    invoiceId: 1,
    buffer: buf,
    filename: 'a.txt',
    attachmentsDir: dir,
  });
  const out = await readAttachmentBytes(row);
  assert.deepEqual(out, buf);
  // Tamper with the file (write 0 bytes) — readAttachmentBytes
  // catches the drift.
  writeFileSync(row.storage_path, Buffer.alloc(0));
  await assert.rejects(
    readAttachmentBytes(row),
    (err) => /size drift/.test(err.message),
  );
  // Restore the file for the test cleanup.
  writeFileSync(row.storage_path, buf);
});
