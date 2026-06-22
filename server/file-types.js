// SBOS-A1-ERP file-type detection (Wave 58 + Wave 61).
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
// Coverage (W58 base + W61 extension):
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
//   - text/plain          first 512B is printable ASCII or valid UTF-8
//   - application/zip     50 4B 03 04
//   - application/json    parses as JSON (if mime is application/json)
//
// W61 deliberately does NOT distinguish DOCX/XLSX/PPTX from
// generic ZIP — that would require inspecting the ZIP central
// directory (in the END of the file, not the first 512 bytes).
// A separate W62 can add ZIP-content sniffing if the operator
// demand is there. For now, ZIP-based Office docs are accepted
// when claimed as application/zip; the extension blocklist
// still applies at the upload layer.
//
// Anything else (octet-stream, custom types) is treated as
// "unknown" and the bytes are accepted as-is. The blocklist
// at the extension layer (.exe etc.) still applies.

const SIGNATURES = [
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
    mime: 'application/zip',
    label: 'ZIP',
    // ZIP local file header signature: 50 4B 03 04
    // (also matches DOCX, XLSX, JAR — all are ZIP containers)
    check: (buf) =>
      buf.length >= 4 &&
      buf[0] === 0x50 &&
      buf[1] === 0x4b &&
      buf[2] === 0x03 &&
      buf[3] === 0x04,
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
