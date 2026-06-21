#!/bin/bash
# Print the admin session token from the token file written by
# bin/sbos-server.mjs. The token file is at SBOS_ADMIN_TOKEN_FILE
# (default: the same dir as SBOS_DB, named `admin-token`).
#
# Usage:
#   scripts/print-admin-token.sh                # reads from default path
#   SBOS_ADMIN_TOKEN_FILE=/var/lib/sbos-a1-erp/admin-token \
#     scripts/print-admin-token.sh              # explicit path
#
# In production, this is the right way for the operator to grab
# the token: it's not in the boot log anymore (well, it is, but
# the file is the canonical source). Pair with `systemctl show
# sbos-a1-erp -p Environment` to see the configured path.
set -uo pipefail

DB_PATH=${SBOS_DB:-/var/lib/sbos-a1-erp/sbos.db}
TOKEN_FILE=${SBOS_ADMIN_TOKEN_FILE:-$(dirname "$DB_PATH")/admin-token}

if [ ! -f "$TOKEN_FILE" ]; then
  echo "FAIL: token file not found at $TOKEN_FILE" >&2
  echo "  (Did you set SBOS_ADMIN_TOKEN_FILE in the systemd unit / pm2 config?)" >&2
  exit 1
fi

# Print the token (strip trailing newline).
cat "$TOKEN_FILE" | tr -d '\n'
echo
