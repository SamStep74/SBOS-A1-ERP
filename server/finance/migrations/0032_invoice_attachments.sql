-- Wave 56: invoice document attachments.
--
-- Operators attach supporting documents to invoices: the
-- signed PDF, the vendor's quote, a photo of the goods
-- received, etc. The DB stores only the metadata; the file
-- bytes live on disk under $SBOS_ATTACHMENTS_DIR (default
-- ./attachments). This pattern mirrors the backup-store
-- approach (Wave 47/51) — metadata in sqlite, blobs on disk
-- — so the DB stays small and the operator can browse files
-- directly.
--
-- File layout on disk:
--   $SBOS_ATTACHMENTS_DIR/{tenant_id}/{invoice_id}/{attachment_id}.{ext}
-- The extension comes from the original filename (sanitised).
-- The DB always holds the original filename, the mime_type,
-- the size, and a sha256 for integrity checks.
--
-- The `description` field is optional free text (e.g. "vendor
-- quote, signed 2026-05-12"). The `uploaded_by` is the
-- user_id of the uploader (foreign key to users.id, not
-- enforced — soft reference for portability).

CREATE TABLE IF NOT EXISTS invoice_attachments (
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

CREATE INDEX IF NOT EXISTS idx_invoice_attachments_invoice
  ON invoice_attachments (tenant_id, invoice_id, uploaded_at DESC);

CREATE INDEX IF NOT EXISTS idx_invoice_attachments_recent
  ON invoice_attachments (uploaded_at DESC);
