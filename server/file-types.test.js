// Unit tests for server/file-types.js (Wave 58).
//
// Tests:
//   - detectMimeType: each known format is detected
//   - detectMimeType: random bytes return null
//   - verifyMimeType: claimed=detected → matches=true
//   - verifyMimeType: claimed != detected (smuggling) → matches=false
//   - verifyMimeType: claimed=octet-stream → always accepted
//   - verifyMimeType: claimed=unknown custom type → accepted
//   - verifyMimeType: malformed mime type (e.g. "; charset") is normalized

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { detectMimeType, verifyMimeType, listKnownTypes } from './file-types.js';

const PDF = Buffer.from('%PDF-1.4\n%\x93\x8c\x8b\x9e...');
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d]);
const GIF87 = Buffer.from('GIF87a...');
const GIF89 = Buffer.from('GIF89a...');
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0, 0]);
const TEXT = Buffer.from('Hello, world!\nThis is plain text.\n');
const JSON_DOC = Buffer.from('{"a":1,"b":2}');
const EXE = Buffer.from([0x4d, 0x5a, 0x90, 0, 3, 0, 0, 0]); // MZ header
const PNG_AS_PDF = Buffer.concat([PDF, Buffer.from(' (claimed: png)')]);

test('detectMimeType: PDF (with version 1.4)', () => {
  assert.equal(detectMimeType(PDF), 'application/pdf');
});

test('detectMimeType: JPEG (FF D8 FF E0)', () => {
  assert.equal(detectMimeType(JPEG), 'image/jpeg');
});

test('detectMimeType: PNG (full 8-byte signature)', () => {
  assert.equal(detectMimeType(PNG), 'image/png');
});

test('detectMimeType: GIF87a + GIF89a', () => {
  assert.equal(detectMimeType(GIF87), 'image/gif');
  assert.equal(detectMimeType(GIF89), 'image/gif');
});

test('detectMimeType: ZIP / Office container', () => {
  assert.equal(detectMimeType(ZIP), 'application/zip');
});

test('detectMimeType: plain text (ASCII)', () => {
  assert.equal(detectMimeType(TEXT), 'text/plain');
});

test('detectMimeType: JSON parses', () => {
  assert.equal(detectMimeType(JSON_DOC), 'application/json');
});

test('detectMimeType: executable bytes (MZ) return null', () => {
  assert.equal(detectMimeType(EXE), null);
});

test('detectMimeType: empty buffer returns null', () => {
  assert.equal(detectMimeType(Buffer.alloc(0)), null);
  assert.equal(detectMimeType(null), null);
  assert.equal(detectMimeType(undefined), null);
});

test('verifyMimeType: claimed matches detected', () => {
  assert.deepEqual(verifyMimeType(PDF, 'application/pdf'), { matches: true, detected: 'application/pdf' });
  assert.deepEqual(verifyMimeType(PNG, 'image/png'), { matches: true, detected: 'image/png' });
  assert.deepEqual(verifyMimeType(JPEG, 'image/jpeg'), { matches: true, detected: 'image/jpeg' });
});

test('verifyMimeType: claimed=octet-stream is always accepted (no claim to verify)', () => {
  // The operator explicitly said "I don't know what this is".
  // We accept as-is rather than rejecting.
  assert.equal(verifyMimeType(EXE, 'application/octet-stream').matches, true);
  assert.equal(verifyMimeType(PDF, 'octet-stream').matches, true);
  assert.equal(verifyMimeType(EXE, 'binary').matches, true);
  assert.equal(verifyMimeType(EXE, undefined).matches, true);
  assert.equal(verifyMimeType(EXE, '').matches, true);
  assert.equal(verifyMimeType(EXE, null).matches, true);
});

test('verifyMimeType: claimed != detected (smuggling attempt) is rejected', () => {
  // A PDF claimed as JPEG (or vice versa) is rejected.
  const pdfAsJpeg = verifyMimeType(PDF, 'image/jpeg');
  assert.equal(pdfAsJpeg.matches, false);
  assert.equal(pdfAsJpeg.detected, 'application/pdf');
  assert.equal(pdfAsJpeg.claimed, 'image/jpeg');
  assert.ok(/pdf.*jpeg/i.test(pdfAsJpeg.reason));

  // An executable claimed as anything-known is rejected with
  // a clear reason.
  const exeAsPdf = verifyMimeType(EXE, 'application/pdf');
  assert.equal(exeAsPdf.matches, false);
  assert.equal(exeAsPdf.detected, 'unknown');
  assert.equal(exeAsPdf.claimed, 'application/pdf');
  assert.ok(/do not match/.test(exeAsPdf.reason));
});

test('verifyMimeType: claimed mime type with parameters is normalized', () => {
  // "application/json; charset=utf-8" is normalized to
  // "application/json" for the comparison.
  assert.deepEqual(
    verifyMimeType(JSON_DOC, 'application/json; charset=utf-8'),
    { matches: true, detected: 'application/json' },
  );
});

test('verifyMimeType: claimed unknown custom type is accepted (no signature to verify)', () => {
  // application/x-frobnicator is not in our known list, so
  // we can't verify it. The operator's claim is accepted
  // as-is. The extension blocklist still applies.
  assert.equal(verifyMimeType(EXE, 'application/x-frobnicator').matches, true);
});

test('listKnownTypes: returns the registered signatures', () => {
  const types = listKnownTypes();
  assert.ok(Array.isArray(types));
  // Every type has a mime + label.
  for (const t of types) {
    assert.ok(t.mime, `missing mime in ${JSON.stringify(t)}`);
    assert.ok(t.label, `missing label in ${JSON.stringify(t)}`);
  }
  // At minimum, the common types we expect.
  const mimes = types.map((t) => t.mime);
  for (const expected of [
    'application/pdf',
    'image/jpeg',
    'image/png',
    'image/gif',
  ]) {
    assert.ok(mimes.includes(expected), `missing ${expected}`);
  }
});

test('verifyMimeType: PNG bytes falsely claimed as PDF are rejected', () => {
  // Common smuggling pattern: take a PNG, rename to .pdf,
  // claim application/pdf. The bytes say no.
  const pngAsPdf = verifyMimeType(PNG, 'application/pdf');
  assert.equal(pngAsPdf.matches, false);
  assert.equal(pngAsPdf.detected, 'image/png');
});
