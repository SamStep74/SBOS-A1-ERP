// SBOS-A1-ERP invoice attachments (Wave 56).
//
// Store the metadata in finance.invoice_attachments; store the
// file bytes on disk under $SBOS_ATTACHMENTS_DIR (default
// ./attachments). The DB always has the sha256 + size so
// integrity can be verified without re-reading the file.
//
// File layout:
//   $SBOS_ATTACHMENTS_DIR/{tenant_id}/{invoice_id}/{attachment_id}{ext}
//
// The extension comes from the original filename (sanitised).
// The DB stores the original filename + mime_type so the
// download response can return a sensible Content-Disposition.

import { writeFileSync, readFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join, extname, basename } from 'node:path';

export class AttachmentError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'AttachmentError';
    this.statusCode = statusCode;
  }
}

const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024; // 25 MB cap
const ALLOWED_MIME = /^[a-zA-Z0-9][a-zA-Z0-9!#$&^_\-+.]*\/[a-zA-Z0-9!#$&^_\-+.]+$/;
const FORBIDDEN_EXT = new Set(['.exe', '.bat', '.cmd', '.sh', '.com', '.msi', '.scr', '.vbs']);

/**
 * Add an attachment to an invoice.
 *
 * @param pgAdapter  the pg-style adapter (or any node:sqlite handle
 *                   via `{ current: handle }`)
 * @param opts
 *   tenantId, invoiceId — required
 *   buffer            — Buffer of file bytes
 *   filename          — original filename (the on-disk file uses
 *                       a sanitised extension derived from this)
 *   mimeType          — optional, defaults to 'application/octet-stream'
 *   description       — optional, free text
 *   uploadedBy        — optional, user_id of uploader
 *   attachmentsDir    — base directory (default $SBOS_ATTACHMENTS_DIR
 *                       or './attachments')
 *
 * Returns the inserted row.
 */
export async function addAttachment(pgAdapter, opts) {
  if (!opts || !opts.buffer || !opts.filename) {
    throw new AttachmentError('buffer and filename are required');
  }
  const tenantId = Number(opts.tenantId || 0);
  const invoiceId = Number(opts.invoiceId);
  if (!Number.isInteger(invoiceId) || invoiceId <= 0) {
    throw new AttachmentError('invoiceId must be a positive integer');
  }
  if (!Buffer.isBuffer(opts.buffer)) {
    throw new AttachmentError('buffer must be a Buffer');
  }
  if (opts.buffer.length === 0) {
    throw new AttachmentError('buffer must be non-empty');
  }
  if (opts.buffer.length > MAX_ATTACHMENT_BYTES) {
    throw new AttachmentError(
      `attachment too large (max ${MAX_ATTACHMENT_BYTES} bytes)`,
      413,
    );
  }
  const filename = String(opts.filename).trim();
  if (filename.length === 0 || filename.length > 255) {
    throw new AttachmentError('filename must be 1-255 characters');
  }
  // Strip any path components from the filename (security).
  const safeBase = basename(filename);
  if (safeBase !== filename) {
    throw new AttachmentError('filename must not contain path separators');
  }
  const ext = extname(safeBase).toLowerCase();
  if (FORBIDDEN_EXT.has(ext)) {
    throw new AttachmentError(`file extension ${ext} is not allowed`, 415);
  }
  const mimeType = opts.mimeType ? String(opts.mimeType).trim() : 'application/octet-stream';
  if (mimeType && !ALLOWED_MIME.test(mimeType)) {
    throw new AttachmentError('mime_type has an invalid format', 400);
  }
  // Hash the bytes for integrity.
  const sha256 = createHash('sha256').update(opts.buffer).digest('hex');
  // Resolve the attachments dir. The default is $SBOS_ATTACHMENTS_DIR
  // (mirrors the $SBOS_BACKUP_DIR pattern from Wave 47).
  const attachmentsDir = opts.attachmentsDir || process.env.SBOS_ATTACHMENTS_DIR || './attachments';
  // Generate the on-disk filename: {random}.{ext}. The original
  // filename is preserved in the DB so the operator can browse
  // for "signed_quote.pdf" — the on-disk file is named after the
  // attachment_id so concurrent uploads don't collide.
  const id = randomBytes(8).toString('hex');
  const onDiskName = id + (ext || '');
  const dir = join(attachmentsDir, String(tenantId), String(invoiceId));
  mkdirSync(dir, { recursive: true });
  const storagePath = join(dir, onDiskName);
  writeFileSync(storagePath, opts.buffer);
  // Persist metadata. The insert uses the pgAdapter so the live
  // db is used (Wave 52 follow-up — never capture a stale handle).
  const res = await pgAdapter.query(
    `INSERT INTO invoice_attachments
       (tenant_id, invoice_id, filename, mime_type, size_bytes,
        sha256, description, storage_path, uploaded_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     RETURNING id, tenant_id, invoice_id, filename, mime_type,
               size_bytes, sha256, description, storage_path,
               uploaded_by, uploaded_at`,
    [
      tenantId,
      invoiceId,
      safeBase,
      mimeType,
      opts.buffer.length,
      sha256,
      opts.description ? String(opts.description).slice(0, 500) : null,
      storagePath,
      opts.uploadedBy != null ? Number(opts.uploadedBy) : null,
    ],
  );
  const row = res && res.rows && res.rows[0];
  if (!row) {
    // Roll back the file write on insert failure.
    try { unlinkSync(storagePath); } catch (_e) { /* best-effort */ }
    throw new AttachmentError('failed to record attachment metadata', 500);
  }
  return rowToAttachment(row);
}

/**
 * List attachments for an invoice, most-recent first.
 */
export async function listAttachments(pgAdapter, tenantId, invoiceId, opts = {}) {
  const limit = Math.min(Math.max(Number(opts.limit) || 100, 1), 1000);
  const res = await pgAdapter.query(
    `SELECT id, tenant_id, invoice_id, filename, mime_type, size_bytes,
            sha256, description, storage_path, uploaded_by, uploaded_at
       FROM invoice_attachments
      WHERE tenant_id = $1 AND invoice_id = $2
      ORDER BY id DESC
      LIMIT $3`,
    [Number(tenantId || 0), Number(invoiceId), limit],
  );
  return (res.rows || []).map(rowToAttachment);
}

/**
 * Get a single attachment row by id. Returns null if not found
 * (caller maps to 404). Tenant scope is enforced.
 */
export async function getAttachment(pgAdapter, tenantId, attachmentId) {
  const res = await pgAdapter.query(
    `SELECT id, tenant_id, invoice_id, filename, mime_type, size_bytes,
            sha256, description, storage_path, uploaded_by, uploaded_at
       FROM invoice_attachments
      WHERE id = $1 AND tenant_id = $2
      LIMIT 1`,
    [Number(attachmentId), Number(tenantId || 0)],
  );
  const row = res && res.rows && res.rows[0];
  return row ? rowToAttachment(row) : null;
}

/**
 * Delete an attachment (metadata + file on disk). Best-effort:
 * metadata row is the source of truth; file deletion is
 * opportunistic. The metadata delete is what the caller
 * should rely on for "is it gone?".
 */
export async function deleteAttachment(pgAdapter, tenantId, attachmentId) {
  const existing = await getAttachment(pgAdapter, tenantId, attachmentId);
  if (!existing) return false;
  // Remove the file first, then the metadata. If the file
  // delete fails (e.g. permissions), the metadata delete still
  // succeeds and the file becomes orphaned (cleaned up by a
  // future janitor).
  try {
    if (existing.storage_path && existsSync(existing.storage_path)) {
      unlinkSync(existing.storage_path);
    }
  } catch (_e) {
    // best-effort
  }
  await pgAdapter.query(
    'DELETE FROM invoice_attachments WHERE id = $1 AND tenant_id = $2',
    [Number(attachmentId), Number(tenantId || 0)],
  );
  return true;
}

/**
 * Read the file bytes for an attachment. Used by the download
 * endpoint. Verifies the file exists + size matches the DB
 * row (catches drift between metadata and disk).
 */
export async function readAttachmentBytes(attachment) {
  if (!attachment || !attachment.storage_path) {
    throw new AttachmentError('attachment has no storage_path', 500);
  }
  if (!existsSync(attachment.storage_path)) {
    throw new AttachmentError('file missing on disk', 410);
  }
  const buf = readFileSync(attachment.storage_path);
  if (buf.length !== attachment.size_bytes) {
    // Drift — disk and DB disagree. Surface as 500 (the file
    // is corrupted from the DB's perspective).
    throw new AttachmentError(
      `size drift: db=${attachment.size_bytes} disk=${buf.length}`,
      500,
    );
  }
  return buf;
}

function rowToAttachment(r) {
  return {
    id: Number(r.id),
    tenant_id: Number(r.tenant_id),
    invoice_id: Number(r.invoice_id),
    filename: r.filename,
    mime_type: r.mime_type,
    size_bytes: Number(r.size_bytes),
    sha256: r.sha256,
    description: r.description,
    storage_path: r.storage_path,
    uploaded_by: r.uploaded_by == null ? null : Number(r.uploaded_by),
    uploaded_at: r.uploaded_at,
  };
}
