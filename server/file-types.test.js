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

// ─── W61: extended file-type coverage (images + video) ───

// BMP — Windows Bitmap. Magic: "BM" (0x42 0x4D) at offset 0.
const BMP = Buffer.concat([Buffer.from([0x42, 0x4d]), Buffer.alloc(50, 0xff)]);

// TIFF — little-endian (II*\0) and big-endian (MM\0*).
const TIFF_LE = Buffer.concat([Buffer.from([0x49, 0x49, 0x2a, 0x00]), Buffer.alloc(20, 0)]);
const TIFF_BE = Buffer.concat([Buffer.from([0x4d, 0x4d, 0x00, 0x2a]), Buffer.alloc(20, 0)]);

// WEBP — RIFF container with WEBP brand at offset 8.
const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4, 0x10),     // file size (placeholder)
  Buffer.from('WEBP'),
  Buffer.from('VP8 '),       // sub-chunk
  Buffer.alloc(20, 0xff),
]);

// ICO — Windows icon. Magic: \x00\x00\x01\x00.
const ICO = Buffer.concat([Buffer.from([0x00, 0x00, 0x01, 0x00]), Buffer.alloc(40, 0)]);

// MP4 — ISO base media file format. ftyp at offset 4 + 'isom' brand.
// Layout: [size:4][ftyp:4][brand:4][...]
const MP4 = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),     // size
  Buffer.from('ftyp'),
  Buffer.from('isom'),                       // brand
  Buffer.alloc(20, 0x00),
]);

// MOV — QuickTime. Same ftyp layout but brand is 'qt  '.
const MOV = Buffer.concat([
  Buffer.from([0x00, 0x00, 0x00, 0x20]),
  Buffer.from('ftyp'),
  Buffer.from('qt  '),
  Buffer.alloc(20, 0x00),
]);

// AVI — RIFF container with AVI brand at offset 8.
const AVI = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.alloc(4, 0x10),
  Buffer.from('AVI '),
  Buffer.from('LIST'),
  Buffer.alloc(20, 0xff),
]);

test('detectMimeType: BMP', () => {
  assert.equal(detectMimeType(BMP), 'image/bmp');
});
test('detectMimeType: TIFF (little-endian)', () => {
  assert.equal(detectMimeType(TIFF_LE), 'image/tiff');
});
test('detectMimeType: TIFF (big-endian)', () => {
  assert.equal(detectMimeType(TIFF_BE), 'image/tiff');
});
test('detectMimeType: WEBP', () => {
  assert.equal(detectMimeType(WEBP), 'image/webp');
});
test('detectMimeType: ICO', () => {
  assert.equal(detectMimeType(ICO), 'image/x-icon');
});
test('detectMimeType: MP4 (isom brand)', () => {
  assert.equal(detectMimeType(MP4), 'video/mp4');
});
test('detectMimeType: MOV (qt  brand)', () => {
  assert.equal(detectMimeType(MOV), 'video/quicktime');
});
test('detectMimeType: AVI', () => {
  assert.equal(detectMimeType(AVI), 'video/x-msvideo');
});

test('verifyMimeType: BMP claimed as JPEG is rejected', () => {
  const r = verifyMimeType(BMP, 'image/jpeg');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'image/bmp');
});
test('verifyMimeType: MP4 claimed as image/png is rejected', () => {
  const r = verifyMimeType(MP4, 'image/png');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'video/mp4');
});
test('verifyMimeType: AVI bytes claimed as video/quicktime is rejected', () => {
  const r = verifyMimeType(AVI, 'video/quicktime');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'video/x-msvideo');
});
test('verifyMimeType: real MP4 claimed as video/mp4 is accepted', () => {
  const r = verifyMimeType(MP4, 'video/mp4');
  assert.equal(r.matches, true);
  assert.equal(r.detected, 'video/mp4');
});

test('detectMimeType: listKnownTypes includes the new W61 types', () => {
  // Smoke check: every new type is exposed in the catalog
  // so operators / docs can see what's supported.
  const known = listKnownTypes().map((t) => t.mime);
  for (const m of [
    'image/bmp',
    'image/tiff',
    'image/webp',
    'image/x-icon',
    'video/mp4',
    'video/quicktime',
    'video/x-msvideo',
  ]) {
    assert.ok(known.includes(m), `expected ${m} in listKnownTypes`);
  }
});

// ─── W62: Office document detection (OOXML + ODF) ───

// OOXML documents are ZIP containers with a specific entry
// path that identifies the format. We synthesise a fake
// "ZIP" by prepending the PK\x03\x04 magic + a bit of
// padding + the entry-name marker. The detection function
// is a substring search, so the padding/marker layout
// just needs to put the marker inside the buffer.

// DOCX — word/document.xml inside the ZIP.
const DOCX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),       // ZIP magic
  Buffer.from('[Content_Types].xml fake header'),
  Buffer.from('word/document.xml'),            // DOCX marker
  Buffer.alloc(50, 0x00),
]);

// XLSX — xl/workbook.xml inside the ZIP.
const XLSX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('[Content_Types].xml fake header'),
  Buffer.from('xl/workbook.xml'),              // XLSX marker
  Buffer.alloc(50, 0x00),
]);

// PPTX — ppt/presentation.xml inside the ZIP.
const PPTX = Buffer.concat([
  Buffer.from([0x50, 0x4b, 0x03, 0x04]),
  Buffer.from('[Content_Types].xml fake header'),
  Buffer.from('ppt/presentation.xml'),         // PPTX marker
  Buffer.alloc(50, 0x00),
]);

// ODF documents store the mimetype UNCOMPRESSED at the
// very start of the file. Detection looks for the exact
// mimetype string at offset 0 (no ZIP magic at the start
// of the actual content — the local-file-header sits
// BEFORE the mimetype entry's payload).

// ODT — application/vnd.oasis.opendocument.text at offset 0.
const ODT = Buffer.concat([
  Buffer.from('application/vnd.oasis.opendocument.text'),
  Buffer.from('\n# rest of mimetype entry fake content'),
  Buffer.alloc(50, 0x00),
]);

// ODS — application/vnd.oasis.opendocument.spreadsheet at offset 0.
const ODS = Buffer.concat([
  Buffer.from('application/vnd.oasis.opendocument.spreadsheet'),
  Buffer.from('\n# rest of mimetype entry fake content'),
  Buffer.alloc(50, 0x00),
]);

// ODP — application/vnd.oasis.opendocument.presentation at offset 0.
const ODP = Buffer.concat([
  Buffer.from('application/vnd.oasis.opendocument.presentation'),
  Buffer.from('\n# rest of mimetype entry fake content'),
  Buffer.alloc(50, 0x00),
]);

test('detectMimeType: DOCX (ZIP with word/document.xml)', () => {
  assert.equal(detectMimeType(DOCX), 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
});
test('detectMimeType: XLSX (ZIP with xl/workbook.xml)', () => {
  assert.equal(detectMimeType(XLSX), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
});
test('detectMimeType: PPTX (ZIP with ppt/presentation.xml)', () => {
  assert.equal(detectMimeType(PPTX), 'application/vnd.openxmlformats-officedocument.presentationml.presentation');
});
test('detectMimeType: ODT (mimetype at offset 0)', () => {
  assert.equal(detectMimeType(ODT), 'application/vnd.oasis.opendocument.text');
});
test('detectMimeType: ODS (mimetype at offset 0)', () => {
  assert.equal(detectMimeType(ODS), 'application/vnd.oasis.opendocument.spreadsheet');
});
test('detectMimeType: ODP (mimetype at offset 0)', () => {
  assert.equal(detectMimeType(ODP), 'application/vnd.oasis.opendocument.presentation');
});

// Order matters: when the buffer starts with the ODF mimetype
// string (which doesn't begin with the ZIP magic), the OOXML
// branch should NOT match — the OOXML branch requires PK\x03\x04
// at offset 0. Likewise a generic ZIP without any office
// marker should still detect as application/zip.
test('detectMimeType: generic ZIP without office markers is still ZIP', () => {
  const genericZip = Buffer.concat([
    Buffer.from([0x50, 0x4b, 0x03, 0x04]),
    Buffer.from('hello world from a plain ZIP entry'),
    Buffer.alloc(50, 0x00),
  ]);
  assert.equal(detectMimeType(genericZip), 'application/zip');
});

test('verifyMimeType: DOCX claimed as application/zip is REJECTED', () => {
  // Claiming a generic ZIP type when the bytes are actually
  // a DOCX is a smuggling pattern — accept the upload but
  // reject because the claimed mime is wrong.
  const r = verifyMimeType(DOCX, 'application/zip');
  assert.equal(r.matches, false);
});

test('verifyMimeType: XLSX claimed as DOCX is REJECTED', () => {
  // Distinct OOXML formats are NOT interchangeable.
  const r = verifyMimeType(XLSX, 'application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  assert.equal(r.matches, false);
});

test('verifyMimeType: ODT bytes claimed as ODT is accepted', () => {
  const r = verifyMimeType(ODT, 'application/vnd.oasis.opendocument.text');
  assert.equal(r.matches, true);
});

test('detectMimeType: listKnownTypes includes the new W62 types', () => {
  // Smoke check: every new type is exposed in the catalog
  // so operators / docs can see what's supported.
  const known = listKnownTypes().map((t) => t.mime);
  for (const m of [
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    'application/vnd.oasis.opendocument.text',
    'application/vnd.oasis.opendocument.spreadsheet',
    'application/vnd.oasis.opendocument.presentation',
  ]) {
    assert.ok(known.includes(m), `expected ${m} in listKnownTypes`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Wave 72: additional archive + video formats
//   - Matroska / WebM (shared EBML magic; we label both as Matroska
//     since the DocType element requires full EBML parsing to
//     distinguish — out of scope for a magic-byte check)
//   - RAR 4.x + 5.x (both start with "Rar!\x1a\x07")
//   - 7z ("7z\xbc\xaf\x27\x1c")
// ──────────────────────────────────────────────────────────────────────

const MKV = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, // EBML magic
  0x93, // length of EBML header
  0x42, 0x86, 0x81, 0x01, // EBMLVersion = 1
  0x42, 0xf7, 0x81, 0x01, // EBMLReadVersion = 1
  0x42, 0xf2, 0x81, 0x04, // EBMLMaxIDLength = 4
  0x42, 0xf3, 0x81, 0x08, // EBMLMaxSizeLength = 8
  0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d, // DocType = "webm"
  0x42, 0x87, 0x81, 0x04, // DocTypeVersion = 4
  0x42, 0x85, 0x81, 0x02, // DocTypeReadVersion = 2
]);
const MKV_MATROSKA = Buffer.from([
  0x1a, 0x45, 0xdf, 0xa3, // EBML magic
  0xa3, // length of EBML header
  0x42, 0x86, 0x81, 0x01, // EBMLVersion
  0x42, 0xf7, 0x81, 0x01, // EBMLReadVersion
  0x42, 0xf2, 0x81, 0x04, // EBMLMaxIDLength
  0x42, 0xf3, 0x81, 0x08, // EBMLMaxSizeLength
  0x42, 0x82, 0x88, 0x6d, 0x61, 0x74, 0x72, 0x6f, 0x73, 0x6b, 0x61, // DocType = "matroska"
  0x42, 0x87, 0x81, 0x02, // DocTypeVersion
  0x42, 0x85, 0x81, 0x02, // DocTypeReadVersion
]);
const RAR4 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x00, 0x00]);
const RAR5 = Buffer.from([0x52, 0x61, 0x72, 0x21, 0x1a, 0x07, 0x01, 0x00]);
const SEVENZ = Buffer.from([0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c, 0x00, 0x04]);

test('detectMimeType: MKV (Matroska with EBML magic)', () => {
  assert.equal(detectMimeType(MKV), 'video/x-matroska');
});

test('detectMimeType: MKV (WebM with EBML magic — same detection)', () => {
  // WebM and Matroska share the EBML magic 1A 45 DF A3.
  // Distinguishing them requires parsing the DocType
  // element, which is out of scope for a magic-byte check.
  // Both are labelled as Matroska; the operator can
  // distinguish via file extension or further inspection.
  assert.equal(detectMimeType(MKV_MATROSKA), 'video/x-matroska');
});

test('detectMimeType: EBML magic only (4 bytes) is enough to detect', () => {
  // The first 4 bytes are the EBML signature. A real
  // MKV/WebM file is much larger, but the magic check
  // works on the first 4 bytes.
  const header = Buffer.from([0x1a, 0x45, 0xdf, 0xa3]);
  assert.equal(detectMimeType(header), 'video/x-matroska');
});

test('detectMimeType: EBML magic on a 3-byte buffer does NOT match', () => {
  // The check requires at least 4 bytes.
  const tooShort = Buffer.from([0x1a, 0x45, 0xdf]);
  assert.equal(detectMimeType(tooShort), null);
});

test('detectMimeType: RAR 4.x', () => {
  assert.equal(detectMimeType(RAR4), 'application/vnd.rar');
});

test('detectMimeType: RAR 5.x', () => {
  assert.equal(detectMimeType(RAR5), 'application/vnd.rar');
});

test('detectMimeType: 7z (7z\xBC\xAF\x27\x1C)', () => {
  assert.equal(detectMimeType(SEVENZ), 'application/x-7z-compressed');
});

test('verifyMimeType: RAR claimed as ZIP is REJECTED', () => {
  const r = verifyMimeType(RAR4, 'application/zip');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'application/vnd.rar');
});

test('verifyMimeType: 7z claimed as octet-stream is accepted', () => {
  // Generic types are accepted (no claim to verify).
  const r = verifyMimeType(SEVENZ, 'application/octet-stream');
  assert.equal(r.matches, true);
});

test('verifyMimeType: Matroska claimed as MP4 is REJECTED', () => {
  const r = verifyMimeType(MKV, 'video/mp4');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'video/x-matroska');
});

test('listKnownTypes: includes the W72 types', () => {
  const known = listKnownTypes().map((t) => t.mime);
  for (const m of [
    'video/x-matroska',
    'application/vnd.rar',
    'application/x-7z-compressed',
  ]) {
    assert.ok(known.includes(m), `expected ${m} in listKnownTypes`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// Wave 76: 3D file format detection
//   - STL (stereolithography): "solid" ASCII prefix or
//     binary with 80-byte header + 4-byte triangle count
//   - OBJ (Wavefront): "v " or "vn " or "vt " or "f " or
//     "#" comment line, or "mtllib" reference
//   - glTF (JSON-based): "{" then later "scene" + "meshes"
//     (lighter check: glTF's JSON has gltfVersion key)
//   - glb (binary glTF): "glTF" magic at offset 0
// ──────────────────────────────────────────────────────────────────────

const STL_ASCII = Buffer.from(
  'solid cube\n  facet normal 0 0 1\n    outer loop\n      vertex 0 0 0\n    endloop\n  endfacet\nendsolid cube\n',
);
const STL_BINARY_HEADER = Buffer.alloc(84);
// 80-byte header (zeros) + 4-byte triangle count (little-endian 32-bit)
STL_BINARY_HEADER.writeUInt32LE(1, 80);

const OBJ = Buffer.from(
  '# Wavefront OBJ\nmtllib cube.mtl\nv 0 0 0\nv 1 0 0\nv 0 1 0\nf 1 2 3\n',
);
const GLTF_JSON = Buffer.from(
  '{"asset":{"version":"2.0"},"scene":0,"scenes":[{"nodes":[0]}],"nodes":[{"mesh":0}],"meshes":[{"primitives":[]}]}\n',
);
const GLB_HEADER = Buffer.from([0x67, 0x6c, 0x54, 0x46, 0x02, 0x00, 0x00, 0x00]);

test('detectMimeType: STL (ASCII header "solid ")', () => {
  assert.equal(detectMimeType(STL_ASCII), 'model/stl');
});

// Note: binary STL has no clean magic bytes — the 80-byte
// header is arbitrary content. W76 only ships ASCII STL
// detection. Binary STL falls through to the catch-all
// (treated as text/plain in the absence of a recognizable
// signature). Operators with binary STL uploads should
// claim the mime explicitly.

test('detectMimeType: OBJ (mtllib / v / f / # comment)', () => {
  assert.equal(detectMimeType(OBJ), 'model/obj');
});

test('detectMimeType: glTF (JSON with scene key)', () => {
  assert.equal(detectMimeType(GLTF_JSON), 'model/gltf+json');
});

test('detectMimeType: GLB (binary glTF "glTF" magic)', () => {
  assert.equal(detectMimeType(GLB_HEADER), 'model/gltf-binary');
});

test('verifyMimeType: STL claimed as PDF is REJECTED', () => {
  const r = verifyMimeType(STL_ASCII, 'application/pdf');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'model/stl');
});

test('verifyMimeType: glTF claimed as JSON is REJECTED', () => {
  const r = verifyMimeType(GLTF_JSON, 'application/json');
  assert.equal(r.matches, false);
  assert.equal(r.detected, 'model/gltf+json');
});

test('listKnownTypes: includes the W76 types', () => {
  const known = listKnownTypes().map((t) => t.mime);
  for (const m of [
    'model/stl',
    'model/obj',
    'model/gltf+json',
    'model/gltf-binary',
  ]) {
    assert.ok(known.includes(m), `expected ${m} in listKnownTypes`);
  }
});
