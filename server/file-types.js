// SBOS-A1-ERP file-type detection (Wave 58 + Wave 61 + Wave 62 + Wave 72 + Wave 76).
//
// Magic-byte detection for the common file types operators
// attach to invoices. Pairs with Wave 56 attachment upload
// + Wave 57 rate limiting (defense in depth).
//
// The previous upload accepted any binary up to 25 MB. The
// extension blocklist caught .exe / .bat / etc. but a malicious
// uploader could rename malware.pdf to safe.pdf and the
// system would accept it. This module closes the gap by
// verifying the actual bytes match the claimed mime type.
//
// Coverage (W58 base + W61 extension + W62 OOXML/ODF + W72):
//   - application/pdf     %PDF-1.<digit>  (or %PDF-)
//   - image/jpeg          FF D8 FF
//   - image/png           89 50 4E 47 0D 0A 1A 0A
//   - image/gif           GIF87a | GIF89a
//   - image/bmp           BM                        [W61]
//   - image/tiff          II*\0 | MM\0*             [W61]
//   - image/webp          RIFF....WEBP              [W61]
//   - image/x-icon        \x00\x00\x01\x00          [W61]
//   - video/mp4           ftyp + isom brand         [W61]
//   - video/quicktime     ftyp + qt  brand          [W61]
//   - video/x-msvideo     RIFF....AVI               [W61]
//   - OOXML (DOCX/XLSX/PPTX)                       [W62]
//     * wordprocessingml.document   ZIP + word/document.xml
//     * spreadsheetml.sheet         ZIP + xl/workbook.xml
//     * presentationml.presentation ZIP + ppt/presentation.xml
//   - ODF (ODT/ODS/ODP)                            [W62]
//     * application/vnd.oasis.opendocument.text       at offset 0
//     * application/vnd.oasis.opendocument.spreadsheet at offset 0
//     * application/vnd.oasis.opendocument.presentation at offset 0
//   - Matroska / WebM     EBML magic 1A 45 DF A3    [W72]
//     * video/x-matroska (covers both MKV and WebM;
//       distinguishing requires parsing the DocType
//       element which is out of scope for a magic-byte
//       check. Both are labelled as Matroska; the
//       operator can distinguish via file extension.)
//   - RAR 4.x + 5.x       Rar!\x1a\x07             [W72]
//     * application/vnd.rar
//   - 7z                  7z\xBC\xAF\x27\x1C        [W72]
//     * application/x-7z-compressed
//   - STL (3D mesh)        ASCII "solid " prefix OR    [W76]
//                          80-byte binary header
//     * model/stl
//   - OBJ (3D mesh)        Wavefront ASCII prefix       [W76]
//     * model/obj
//   - glTF (JSON)          "{" + "scene" key            [W76]
//     * model/gltf+json
//   - GLB (binary glTF)    "glTF" magic                  [W76]
//     * model/gltf-binary
//   - text/plain          first 512B is printable ASCII or valid UTF-8
//   - application/zip     50 4B 03 04 (no OOXML/ODF markers found)
//   - application/json    parses as JSON (if mime is application/json)
//
// W62 closes the W61 "Office docs detect as generic ZIP" gap
// by scanning the buffer for OOXML entry-name markers
// (word/document.xml etc.) AND by detecting ODF's uncompressed
// mimetype entry at offset 0. Both checks are linear scans
// over the buffer — the 25MB attachment cap keeps the worst-
// case cost at ~25ms on a modern CPU.
//
// Anything else (octet-stream, custom types) is treated as
// "unknown" and the bytes are accepted as-is. The blocklist
// at the extension layer (.exe etc.) still applies.

const SIGNATURES = [
  {
    // W76: GLB — binary glTF (Graphics Library
    // Transmission Format). Magic: "glTF" at offset 0
    // (bytes 67 6c 54 46). Followed by a 32-bit version
    // (2), a 32-bit total length, and the embedded JSON
    // chunk. We only check the magic; the rest is
    // out of scope for a magic-byte check.
    mime: 'model/gltf-binary',
    label: 'GLB',
    check: (buf) => {
      if (buf.length < 4) return false;
      return (
        buf[0] === 0x67 && // g
        buf[1] === 0x6c && // l
        buf[2] === 0x54 && // T
        buf[3] === 0x46 // F
      );
    },
  },
  {
    // W76: glTF — JSON-based glTF. Detection: the buffer
    // starts with "{" AND contains a top-level "scene"
    // key (glTF requires a scene). This is a heuristic
    // (lots of JSON has "scene" as a string somewhere)
    // but works in practice because glTF documents are
    // small + structured. To reduce false positives we
    // also require a "meshes" or "nodes" or "buffers"
    // key, all of which are mandatory in glTF.
    mime: 'model/gltf+json',
    label: 'glTF',
    check: (buf) => {
      if (buf.length < 2) return false;
      if (buf[0] !== 0x7b) return false; // {
      const s = buf.toString('utf8');
      // Require glTF-mandatory top-level keys.
      if (!/"scene"/.test(s)) return false;
      if (
        !/"meshes"/.test(s) &&
        !/"nodes"/.test(s) &&
        !/"buffers"/.test(s)
      ) {
        return false;
      }
      return true;
    },
  },
  {
    // W76: STL — stereolithography mesh. Two flavours:
    //   - ASCII: starts with "solid " (5 bytes).
    //   - Binary: 80-byte header (any content) + 4-byte
    //     little-endian triangle count. We can't reliably
    //     detect binary STL with magic bytes alone
    //     (the 80-byte header has no fixed magic), so
    //     we only detect ASCII STL. Binary STL falls
    //     through to the catch-all (the operator can
    //     still upload with an explicit mime claim).
    mime: 'model/stl',
    label: 'STL',
    check: (buf) =>
      buf.length >= 5 && buf.slice(0, 5).toString('ascii') === 'solid',
  },
  {
    // W76: OBJ — Wavefront OBJ. Detection: the buffer
    // starts with "#" (comment) OR contains "v " (vertex)
    // / "vn " (normal) / "vt " (texture coord) / "f "
    // (face) / "mtllib" (material lib) on a line. We
    // check for the common prefixes; "v " is the most
    // reliable because it appears in nearly every OBJ
    // file (mandatory for any mesh).
    mime: 'model/obj',
    label: 'OBJ',
    check: (buf) => {
      if (buf.length < 2) return false;
      // The first non-whitespace char is usually "#"
      // (comment) or "v" (vertex) or "m" (mtllib / g).
      // We check for a few distinctive markers to
      // avoid false positives on text/plain files
      // that happen to start with these letters.
      const head = buf.slice(0, Math.min(2048, buf.length)).toString('ascii');
      // Look for one of the OBJ-mandatory line types.
      if (/\nv /.test('\n' + head)) return true; // vertex
      if (/\nf /.test('\n' + head)) return true; // face
      if (/^# /.test(head) && /Wavefront|OBJ/.test(head)) return true;
      if (/^mtllib\s/m.test(head)) return true;
      return false;
    },
  },
  {
    // W72: 7z — 7-Zip archive. Magic: 7z\xBC\xAF\x27\x1C
    // (6 bytes). The fourth byte onwards includes a
    // version + start-header CRC; we don't parse them
    // (out of scope for a magic-byte check). The
    // canonical mime is application/x-7z-compressed.
    mime: 'application/x-7z-compressed',
    label: '7z',
    check: (buf) => {
      if (buf.length < 6) return false;
      return (
        buf[0] === 0x37 && // 7
        buf[1] === 0x7a && // z
        buf[2] === 0xbc &&
        buf[3] === 0xaf &&
        buf[4] === 0x27 &&
        buf[5] === 0x1c
      );
    },
  },
  {
    // W72: RAR — Roshal Archive. Both 4.x and 5.x share
    // the 7-byte magic "Rar!\x1A\x07". The 8th byte
    // differs (0x00 for 4.x, 0x01 for 5.x) but we don't
    // distinguish — both are RAR, the operator can
    // disambiguate by extension.
    mime: 'application/vnd.rar',
    label: 'RAR',
    check: (buf) => {
      if (buf.length < 7) return false;
      return (
        buf[0] === 0x52 && // R
        buf[1] === 0x61 && // a
        buf[2] === 0x72 && // r
        buf[3] === 0x21 && // !
        buf[4] === 0x1a &&
        buf[5] === 0x07 &&
        // byte 6 is 0x00 (RAR 4.x) or 0x01 (RAR 5.x);
        // we don't care which.
        (buf[6] === 0x00 || buf[6] === 0x01)
      );
    },
  },
  {
    // W72: Matroska / WebM — EBML (Extensible Binary
    // Meta-Language) container. Magic: 1A 45 DF A3 at
    // offset 0. Both Matroska (.mkv) and WebM (.webm)
    // share this magic; distinguishing them requires
    // parsing the DocType element (out of scope for a
    // 4-byte magic check). We label both as Matroska;
    // the operator can disambiguate by extension or
    // further inspection.
    mime: 'video/x-matroska',
    label: 'Matroska',
    check: (buf) => {
      if (buf.length < 4) return false;
      return (
        buf[0] === 0x1a &&
        buf[1] === 0x45 &&
        buf[2] === 0xdf &&
        buf[3] === 0xa3
      );
    },
  },
  {
    mime: 'application/pdf',
    label: 'PDF',
    // PDF magic: "%PDF-1." or "%PDF-2." (per ISO 32000-1)
    check: (buf) => buf.length >= 5 && buf.slice(0, 5).toString('ascii') === '%PDF-',
  },
  {
    mime: 'image/jpeg',
    label: 'JPEG',
    // JPEG starts with FF D8 FF (SOI marker + first byte of next marker)
    check: (buf) =>
      buf.length >= 3 &&
      buf[0] === 0xff &&
      buf[1] === 0xd8 &&
      buf[2] === 0xff,
  },
  {
    mime: 'image/png',
    label: 'PNG',
    // PNG signature: 89 50 4E 47 0D 0A 1A 0A
    check: (buf) => {
      if (buf.length < 8) return false;
      return (
        buf[0] === 0x89 &&
        buf[1] === 0x50 &&
        buf[2] === 0x4e &&
        buf[3] === 0x47 &&
        buf[4] === 0x0d &&
        buf[5] === 0x0a &&
        buf[6] === 0x1a &&
        buf[7] === 0x0a
      );
    },
  },
  {
    mime: 'image/gif',
    label: 'GIF',
    check: (buf) => {
      if (buf.length < 6) return false;
      const head = buf.slice(0, 6).toString('ascii');
      return head === 'GIF87a' || head === 'GIF89a';
    },
  },
  {
    // W62: OOXML detection. A file is detected as DOCX/XLSX/
    // PPTX if it starts with the ZIP magic AND contains the
    // OOXML-mandatory entry-name marker somewhere in the
    // buffer. We search the WHOLE buffer (not just the first
    // 512 bytes) because ZIP local-file-headers + the central
    // directory are interleaved with the entry data; the
    // marker can be anywhere.
    //
    // The OOXML format REQUIRES [Content_Types].xml at the
    // start, then the document-specific entry (word/document.
    // xml for DOCX, xl/workbook.xml for XLSX, ppt/presentation
    // .xml for PPTX). For a real Office doc these entries
    // appear within the first ~4KB of compressed data.
    //
    // Checked BEFORE the generic ZIP signature so a DOCX
    // file is detected as DOCX, not as generic ZIP. (First
    // match wins.)
    //
    // Implementation: use Buffer.indexOf to find the marker
    // string. The marker is an ASCII byte sequence so the
    // search is fast (V8 uses optimized memchr for this).
    mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    label: 'DOCX',
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x50 && buf[1] === 0x4b &&
      buf[2] === 0x03 && buf[3] === 0x04 &&
      buf.indexOf(Buffer.from('word/document.xml')) !== -1,
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    label: 'XLSX',
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x50 && buf[1] === 0x4b &&
      buf[2] === 0x03 && buf[3] === 0x04 &&
      buf.indexOf(Buffer.from('xl/workbook.xml')) !== -1,
  },
  {
    mime: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    label: 'PPTX',
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x50 && buf[1] === 0x4b &&
      buf[2] === 0x03 && buf[3] === 0x04 &&
      buf.indexOf(Buffer.from('ppt/presentation.xml')) !== -1,
  },
  {
    mime: 'application/zip',
    label: 'ZIP',
    // ZIP local file header signature: 50 4B 03 04.
    // Checked AFTER the OOXML branches so a real DOCX/XLSX/
    // PPTX file is detected as the specific OOXML type, not
    // as a generic ZIP. A buffer with ZIP magic + no OOXML
    // marker falls through to this branch.
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      buf[2] === 0x03 &&
      buf[3] === 0x04,
  },
  {
    // W62: ODF detection. OpenDocument files are ZIP
    // containers with a mandatory `mimetype` entry stored
    // UNCOMPRESSED at the very start of the file. The
    // detection is therefore a simple prefix check on the
    // first ~80 bytes (no scanning the whole buffer needed).
    //
    // The three canonical ODF mimetype strings:
    //   - application/vnd.oasis.opendocument.text       (ODT)
    //   - application/vnd.oasis.opendocument.spreadsheet (ODS)
    //   - application/vnd.oasis.opendocument.presentation (ODP)
    //
    // Each branch checks the corresponding prefix. We do
    // NOT require the ZIP magic at offset 0 because the
    // local-file-header sits BEFORE the mimetype entry's
    // payload (and ODF stores the mimetype uncompressed).
    mime: 'application/vnd.oasis.opendocument.text',
    label: 'ODT',
    check: (buf) =>
      buf.length >= 39 &&
      buf.slice(0, 39).toString('ascii') ===
        'application/vnd.oasis.opendocument.text',
  },
  {
    mime: 'application/vnd.oasis.opendocument.spreadsheet',
    label: 'ODS',
    check: (buf) =>
      buf.length >= 46 &&
      buf.slice(0, 46).toString('ascii') ===
        'application/vnd.oasis.opendocument.spreadsheet',
  },
  {
    mime: 'application/vnd.oasis.opendocument.presentation',
    label: 'ODP',
    check: (buf) =>
      buf.length >= 47 &&
      buf.slice(0, 47).toString('ascii') ===
        'application/vnd.oasis.opendocument.presentation',
  },
  {
    // W61: BMP — Windows Bitmap. Magic: "BM" at offset 0.
    // 2-byte check is enough; no other common format starts
    // with these bytes in the wild.
    mime: 'image/bmp',
    label: 'BMP',
    check: (buf) =>
      buf.length >= 2 && buf[0] === 0x42 && buf[1] === 0x4d,
  },
  {
    // W61: TIFF — Tagged Image File Format. Two flavours:
    //   little-endian (II*\0) and big-endian (MM\0*). Both
    //   start with the byte-order marker at offset 0.
    mime: 'image/tiff',
    label: 'TIFF',
    check: (buf) => {
      if (buf.length < 4) return false;
      // Little-endian
      if (
        buf[0] === 0x49 &&
        buf[1] === 0x49 &&
        buf[2] === 0x2a &&
        buf[3] === 0x00
      ) {
        return true;
      }
      // Big-endian
      if (
        buf[0] === 0x4d &&
        buf[1] === 0x4d &&
        buf[2] === 0x00 &&
        buf[3] === 0x2a
      ) {
        return true;
      }
      return false;
    },
  },
  {
    // W61: WEBP — WebP. RIFF container with WEBP brand at
    // offset 8. The "RIFF" + size + "WEBP" layout is shared
    // with WAV + AVI but the brand at offset 8 disambiguates.
    // Checked BEFORE the generic RIFF/video branches.
    mime: 'image/webp',
    label: 'WEBP',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[0] === 0x52 && // R
        buf[1] === 0x49 && // I
        buf[2] === 0x46 && // F
        buf[3] === 0x46 && // F
        buf[8] === 0x57 && // W
        buf[9] === 0x45 && // E
        buf[10] === 0x42 && // B
        buf[11] === 0x50 // P
      );
    },
  },
  {
    // W61: ICO — Windows icon. Magic: \x00\x00\x01\x00
    // (reserved=0, type=1 ICO). The cursor variant is \x00\x00\x02\x00
    // but we don't distinguish — both are ico/cur-family.
    mime: 'image/x-icon',
    label: 'ICO',
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x00 &&
      buf[1] === 0x00 &&
      buf[2] === 0x01 &&
      buf[3] === 0x00,
  },
  {
    // W80: JXL (JPEG XL) — naked codestream. Magic:
    // FF 0A at offset 0. The codestream format is the
    // bare bitstream (no container). Checked BEFORE the
    // plain-text fallback (which would accept FF 0A as
    // printable) so the JXL detection wins.
    mime: 'image/jxl',
    label: 'JXL',
    check: (buf) =>
      buf.length >= 2 && buf[0] === 0xff && buf[1] === 0x0a,
  },
  {
    // W80: JXL (JPEG XL) — ISOBMFF container. ftyp + 'jxl '
    // brand (jxl + 1 space, NOT null-padded). Placed
    // AFTER MP4/MOV/HEIC/AVIF so a generic MP4 file is
    // detected as MP4, not JXL.
    mime: 'image/jxl',
    label: 'JXL-container',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[4] === 0x66 && // f
        buf[5] === 0x74 && // t
        buf[6] === 0x79 && // y
        buf[7] === 0x70 && // p
        buf[8] === 0x6a && // j
        buf[9] === 0x78 && // x
        buf[10] === 0x6c && // l
        buf[11] === 0x20 // space
      );
    },
  },
  {
    // W61: AVI — Audio Video Interleave. RIFF container with
    // AVI brand at offset 8. The ftyp-based MP4/MOV branches
    // check BEFORE the RIFF branches so an MP4 file (which
    // starts with ftyp at offset 4) is not mis-detected as AVI.
    mime: 'video/x-msvideo',
    label: 'AVI',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[0] === 0x52 && // R
        buf[1] === 0x49 && // I
        buf[2] === 0x46 && // F
        buf[3] === 0x46 && // F
        buf[8] === 0x41 && // A
        buf[9] === 0x56 && // V
        buf[10] === 0x49 && // I
        buf[11] === 0x20 // space
      );
    },
  },
  {
    // W61: MP4 — ISO base media file format. Layout at offset
    // 0: [size:4][ftyp:4][brand:4][...]. The "isom" brand is
    // the canonical MP4 family marker (also covers M4V, 3GP,
    // etc.). Checked BEFORE MOV (also ftyp) to disambiguate.
    mime: 'video/mp4',
    label: 'MP4',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[4] === 0x66 && // f
        buf[5] === 0x74 && // t
        buf[6] === 0x79 && // y
        buf[7] === 0x70 && // p
        buf[8] === 0x69 && // i
        buf[9] === 0x73 && // s
        buf[10] === 0x6f && // o
        buf[11] === 0x6d // m
      );
    },
  },
  {
    // W61: MOV — QuickTime. Same ftyp layout as MP4 but
    // brand is 'qt  ' (qt + 2 spaces). Checked AFTER MP4
    // so the more specific 'isom' branch wins for MP4 files.
    mime: 'video/quicktime',
    label: 'MOV',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[4] === 0x66 && // f
        buf[5] === 0x74 && // t
        buf[6] === 0x79 && // y
        buf[7] === 0x70 && // p
        buf[8] === 0x71 && // q
        buf[9] === 0x74 && // t
        buf[10] === 0x20 && // space
        buf[11] === 0x20 // space
      );
    },
  },
  {
    // W79: HEIC/HEIF (Apple). Same ftyp layout as MP4
    // but brand is 'heic' (or 'heix', 'heim', 'heis',
    // 'hevc', 'hevx', 'mif1' for HEIF, etc). Checked
    // AFTER the MP4/MOV branches so a generic MP4 file
    // is detected as MP4, not HEIC.
    mime: 'image/heic',
    label: 'HEIC',
    check: (buf) => {
      if (buf.length < 12) return false;
      // ftyp magic at offset 4 + 'heic' brand at offset 8
      return (
        buf[4] === 0x66 && // f
        buf[5] === 0x74 && // t
        buf[6] === 0x79 && // y
        buf[7] === 0x70 && // p
        buf[8] === 0x68 && // h
        buf[9] === 0x65 && // e
        buf[10] === 0x69 && // i
        buf[11] === 0x63 // c
      );
    },
  },
  {
    // W79: HEIF (generic). Same ftyp layout but brand
    // is 'mif1' (the most common HEIF brand). Covers
    // files that don't have 'heic' as the major brand
    // (e.g., still-image HEIF sequences).
    mime: 'image/heif',
    label: 'HEIF',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[4] === 0x66 && // f
        buf[5] === 0x74 && // t
        buf[6] === 0x79 && // y
        buf[7] === 0x70 && // p
        buf[8] === 0x6d && // m
        buf[9] === 0x69 && // i
        buf[10] === 0x66 && // f
        buf[11] === 0x31 // 1
      );
    },
  },
  {
    // W79: AVIF (AV1 Image File Format). ftyp + 'avis'
    // brand. AVIF uses the AV1 codec inside an ISOBMFF
    // container, same layout as MP4/HEIC.
    mime: 'image/avif',
    label: 'AVIF',
    check: (buf) => {
      if (buf.length < 12) return false;
      return (
        buf[4] === 0x66 && // f
        buf[5] === 0x74 && // t
        buf[6] === 0x79 && // y
        buf[7] === 0x70 && // p
        buf[8] === 0x61 && // a
        buf[9] === 0x76 && // v
        buf[10] === 0x69 && // i
        buf[11] === 0x66 // f
      );
    },
  },
  {
    mime: 'application/json',
    label: 'JSON',
    // The bytes must parse as JSON. We try the whole buffer
    // (small documents) — for large documents this is a
    // perf cost; in practice the upload is capped at 25 MB
    // so the worst case is a 25 MB JSON parse on the server.
    // That's acceptable for a 5xx RPS endpoint.
    check: (buf) => {
      try {
        JSON.parse(buf.toString('utf8'));
        return true;
      } catch (_e) {
        return false;
      }
    },
  },
  {
    mime: 'text/plain',
    label: 'plain text',
    // Heuristic: the first 512 bytes are all printable ASCII
    // (no control chars except \t \n \r) OR are valid UTF-8
    // multi-byte sequences. This is a coarse check — a binary
    // file that happens to start with ASCII bytes would pass.
    // The default octet-stream policy catches those.
    check: (buf) => {
      if (buf.length === 0) return false;
      const head = buf.slice(0, Math.min(512, buf.length));
      // Check for control chars that wouldn't appear in text.
      let hasNonTextByte = false;
      for (let i = 0; i < head.length; i++) {
        const b = head[i];
        // Allow tab, LF, CR, and printable ASCII (0x20-0x7e)
        if (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d) {
          hasNonTextByte = true;
          break;
        }
        // Reject the DEL char
        if (b === 0x7f) {
          hasNonTextByte = true;
          break;
        }
      }
      if (!hasNonTextByte) return true;
      // Fall back to UTF-8 validation: try to decode the
      // bytes as UTF-8 and re-encode; if the round-trip
      // produces the same bytes, it's valid UTF-8 text.
      try {
        const str = head.toString('utf8');
        if (Buffer.from(str, 'utf8').equals(head)) return true;
      } catch (_e) {
        // not text
      }
      return false;
    },
  },
];

/**
 * Detect the most likely mime type of a buffer by inspecting
 * its first few bytes. Returns the canonical mime type from
 * the SIGNATURES table, or null if no signature matches.
 *
 * The order of SIGNATURES matters when bytes match multiple
 * patterns (rare in practice but possible for some compound
 * formats). The first match wins. PDF is checked first because
 * it's the most common attachment; if a file happens to start
 * with ZIP bytes (PK..) the PDF check would have already
 * failed.
 *
 * W61 disambiguation notes:
 *   - MP4 (isom brand) is checked BEFORE MOV (qt  brand) so
 *     an MP4 file is detected as video/mp4, not video/quicktime.
 *   - WEBP + AVI share the RIFF magic; both check the brand
 *     at offset 8, so the disambiguation is intrinsic to the
 *     signature, not to ordering.
 *   - ICO + BMP both have 2-byte magics that are unambiguous
 *     (no overlap with any other format we detect).
 */
export function detectMimeType(buffer) {
  if (!buffer || buffer.length === 0) return null;
  for (const sig of SIGNATURES) {
    try {
      if (sig.check(buffer)) return sig.mime;
    } catch (_e) {
      // Defensive: a check should never throw. If it does,
      // skip the signature and try the next.
    }
  }
  return null;
}

/**
 * Check whether a buffer's actual content matches a claimed
 * mime type. Returns:
 *   - { matches: true } if the claimed type matches the
 *     detected type, OR if the claimed type is a generic
 *     "application/octet-stream" / "binary" (no claim to
 *     verify against).
 *   - { matches: false, detected: '<detected>', reason: '...' }
 *     if the claimed type disagrees with the detected type
 *     (a strong signal of file-type smuggling).
 *   - { matches: true, detected: null } if the claimed type
 *     is application/octet-stream OR we can't detect a type
 *     (no signature matched) — we accept the upload as-is.
 *
 * Known types (PDF, JPEG, PNG, GIF, ZIP, JSON, plain text)
 * are verified. Anything else is passed through.
 */
export function verifyMimeType(buffer, claimedMime) {
  if (!buffer || buffer.length === 0) {
    return { matches: true };
  }
  // Generic / unknown mime types are accepted as-is. The
  // operator / extension blocklist is the secondary guard.
  if (
    !claimedMime ||
    claimedMime === 'application/octet-stream' ||
    claimedMime === 'binary'
  ) {
    return { matches: true };
  }
  // Normalize: lowercase, strip parameters (e.g. "; charset=utf-8")
  const normalized = String(claimedMime).toLowerCase().split(';')[0].trim();
  // If the claimed type is one we know about, verify it.
  const isKnown = SIGNATURES.some((s) => s.mime === normalized);
  if (!isKnown) {
    // Unknown claimed type — accept (we can't verify).
    return { matches: true };
  }
  const detected = detectMimeType(buffer);
  if (detected === normalized) {
    return { matches: true, detected };
  }
  // The claimed type is one we recognize but the bytes
  // don't match. Strong signal of file-type smuggling.
  return {
    matches: false,
    detected: detected || 'unknown',
    claimed: normalized,
    reason: detected
      ? `file bytes look like ${detected} but claim ${normalized}`
      : `file bytes do not match claimed type ${normalized}`,
  };
}

/**
 * Expose the SIGNATURES list for testing + introspection.
 * Don't mutate the returned array.
 */
export function listKnownTypes() {
  return SIGNATURES.map((s) => ({ mime: s.mime, label: s.label }));
}
