# W56 + W57 retro: invoice attachments + login rate limiting

Two waves shipped in v1.4.0: invoice document attachments (W56)
and login rate limiting (W57). Both close gaps that surfaced
under real use.

## W56 — invoice attachments

### Architecture decisions

**Filesystem metadata-only, not blob-in-DB.** The DB stores
`storage_path`, `sha256`, `filename`, `mime_type`, `size_bytes`,
`uploaded_by`, `deleted_at`. The file bytes themselves live on
disk. Why: DB-agnostic, no streaming through the ORM, idempotent
writes (two uploads of the same content land on the same
sha-prefix).

**Storage path layout.**
```
$SBOS_ATTACHMENTS_DIR/
  0/                                  # tenant_id
    1f73fbee7181d8e2.pdf              # sha256[0:16] + ext
  1/                                  # next tenant
    2b5f8d3a1c9e4b07.pdf
```

- Tenant subdir: multi-tenant restores don't cross-contaminate
- sha-prefix as filename: unique enough to act as disk primary
  key (16 hex chars = 64 bits = birthday collision at 2^32)
- Extension from mime type, not the upload filename: defense
  in depth against `evil.pdf.exe`

**Filename blocklist.**
```
.exe .dll .bat .cmd .sh .msi .com
.scr .vbs .ps1 .cpl .jar
```
This is the same list browsers use for `SafeFile` warnings.
Files with no extension are allowed (matters for logs, text
files) but rejected via the mime check.

**Raw body upload pattern.** Reuses the Wave 51 backup POST
pattern: read body bytes off `req` (not the JSON parser), put
metadata in headers. The 1mb JSON cap doesn't apply.

```
POST /api/finance/invoices/123/attachments
Content-Type: application/octet-stream
x-filename: signed.pdf
x-mime-type: application/pdf
x-description: Vendor signed copy

<raw bytes>
```

### Gotchas hit

1. **Test path recomputation vs implementation path.** A test
   computed the expected file path as
   `join(dir, '0', '42', String(row.id) + '.txt')` but the
   implementation used a random on-disk name (decoupled from
   the DB row id). The test failed with a confusing "file must
   exist" assertion. Fix: use `row.storage_path` (the actual
   path) instead of a recomputed path. Pattern: when the
   implementation uses a generated name, the test should use
   the returned path, not recompute.

2. **Size drift between DB and disk.** If a file is removed
   out-of-band (e.g. an operator's shell command), the DB
   still says the row exists. `readAttachmentBytes` checks
   `fs.statSync(path).size === row.size_bytes` and throws a
   `ValueError` on mismatch — the route returns 410 Gone. This
   catches drift before the user gets a 500 from a missing file.

3. **Soft-delete without cascade.** DELETE marks
   `deleted_at = now()` but does NOT remove the file from disk.
   The DB row is filtered out of list/get calls but the bytes
   stay. A future janitor (`purgeAttachment` already exists in
   the module) can reap them on a retention policy. We don't
   ship the janitor yet because there's no retention policy
   defined.

## W57 — login rate limiting

### Architecture decisions

**Lockout state in `users.locked_until`.** The schema already
had `failed_logins INTEGER NOT NULL DEFAULT 0` and
`locked_until TEXT` from earlier waves. Wave 57 wires them
together: 5 failed logins in 15 min → `locked_until = now + 15m`.
Successful login resets the counter.

**Why a column, not a separate table.** The lockout state is
a per-user attribute that the auth path reads on every login
attempt. A column is the right shape — the table-per-user
alternative (lockout_events) would add a join to every login.

**Why 5/15min.** The boot-minted admin token is single-tenant
and the operator rotates it on deploy. 5 attempts is generous
enough for an operator who fat-fingers their password, tight
enough that a script-kiddie attacker gets throttled. 15min
window is short enough that an honest operator who got locked
out doesn't wait hours.

### Gotchas hit

1. **Counter reset on every successful login.** The naive
   implementation only reset on the *next* successful login,
   which means the first failed attempt after a lockout
   expires would re-lock immediately (if it pushed the counter
   past threshold). Fix: reset on every success, not just the
   one that follows a lockout.

2. **Race between concurrent failed logins.** Two threads
   read counter=4, both increment to 5, both set locked_until
   — fine, idempotent. The race we cared about: thread A
   reads counter=4, thread B reads counter=4, both set
   counter=5 (no increment conflict because
   `UPDATE ... SET failed_logins = failed_logins + 1` is
   atomic). Both succeed. The lockout fires correctly.

3. **`locked_until` is TEXT, not INTEGER.** We store ISO
   strings for consistency with `users.created_at` and the rest
   of the schema. The comparison
   `locked_until > datetime('now')` works because SQLite
   understands ISO strings in date functions.

## Stats

- 4 routes added (POST upload, GET list, GET download,
  DELETE)
- 2 perm keys added (finance.invoice.attach,
  finance.invoice.attach.read)
- 1 migration (0032_invoice_attachments.sql)
- 15 unit tests (attachments) + 1 unit test (rate limit)
- 5 integration tests (attachment routes)
- 5 smoke checks (STEP 5w) + 1 smoke check (STEP 5x)
- 1741/1741 unit + integration tests pass
- 212/212 smoke checks pass (zero failures — W57 closed the
  v1.3.1 `db.prepare is not a function` 500s)
