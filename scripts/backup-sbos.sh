#!/bin/bash
# SBOS-A1-ERP database backup.
#
# Online-safe via sqlite3's `.backup` command (WAL-friendly). Falls
# back to plain `cp` if `sqlite3` CLI is unavailable (the file is
# still safe to copy while the server is running, in WAL mode).
#
# Usage:
#   scripts/backup-sbos.sh                # backs up SBOS_DB (default ./sbos.db)
#   BACKUP_DIR=/var/backups/sbos \
#     scripts/backup-sbos.sh              # custom backup directory
#   KEEP=30 scripts/backup-sbos.sh        # keep 30 most recent (default 7)
#   PRE_DEPLOY=1 scripts/backup-sbos.sh   # suffix with .pre-deploy-YYYYMMDD
#
# Cron example (daily 02:00):
#   0 2 * * * /opt/sbos-a1-erp/scripts/backup-sbos.sh >> /var/log/sbos-backup.log 2>&1
#
# Restore:
#   systemctl stop sbos-a1-erp
#   cp /var/backups/sbos/sbos-YYYYMMDDTHHMMSS.db /var/lib/sbos-a1-erp/sbos.db
#   systemctl start sbos-a1-erp
set -uo pipefail

DB_PATH=${SBOS_DB:-/var/lib/sbos-a1-erp/sbos.db}
BACKUP_DIR=${BACKUP_DIR:-$(dirname "$DB_PATH")/backups}
KEEP=${KEEP:-7}
TIMESTAMP=$(date +%Y%m%dT%H%M%S)
SUFFIX=""
[ "${PRE_DEPLOY:-0}" = "1" ] && SUFFIX=".pre-deploy"

if [ ! -f "$DB_PATH" ]; then
  echo "[backup] FAIL: database not found at $DB_PATH" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"
BACKUP_FILE="$BACKUP_DIR/sbos-${TIMESTAMP}${SUFFIX}.db"

# Prefer the sqlite3 CLI's `.backup` command — it's online-safe
# (WAL checkpoint + atomic copy at the journal level). Falls back
# to plain `cp` if the CLI isn't available; in WAL mode the file
# can still be safely copied while the server is running, but
# a checkpoint is recommended before the copy.
if command -v sqlite3 >/dev/null 2>&1; then
  if sqlite3 "$DB_PATH" ".timeout 5000" ".backup '$BACKUP_FILE'"; then
    : # success path
  else
    echo "[backup] WARN: sqlite3 .backup failed, falling back to cp" >&2
    cp "$DB_PATH" "$BACKUP_FILE"
  fi
else
  echo "[backup] WARN: sqlite3 CLI not installed, using cp (consider installing sqlite3 for online-safe backup)" >&2
  cp "$DB_PATH" "$BACKUP_FILE"
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "[backup] FAIL: backup file was not created at $BACKUP_FILE" >&2
  exit 1
fi

BACKUP_SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat -c%s "$BACKUP_FILE" 2>/dev/null || echo "?")
echo "[backup] OK: $BACKUP_FILE ($BACKUP_SIZE bytes)"

# Retention: keep the KEEP most recent backups. Older files are deleted.
# Uses a glob — the timestamp filename sorts lexicographically the same
# way it sorts chronologically, so a head + delete-older works.
if [ -d "$BACKUP_DIR" ]; then
  cd "$BACKUP_DIR" || exit 1
  # List all backup files (sbos-*.db), newest first by mtime.
  ls -1t sbos-*.db 2>/dev/null | tail -n +$((KEEP + 1)) | while read -r old; do
    rm -f "$old"
    echo "[backup] pruned: $old"
  done
fi
