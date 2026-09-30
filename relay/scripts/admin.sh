#!/usr/bin/env bash
# Switch Tohyee addresses off (or back on). Needs the admin password you set
# with `npx wrangler secret put ADMIN_TOKEN`.
#
#   export RELAY_URL=https://api.tohyee.example
#   export ADMIN_TOKEN='the admin password'
#   ./scripts/admin.sh list                 # every address and its status
#   ./scripts/admin.sh block k7m2q9x.tohyee.example
#   ./scripts/admin.sh unblock k7m2q9x.tohyee.example
#   ./scripts/admin.sh stop-new             # no new addresses (existing ones keep working)
#   ./scripts/admin.sh start-new
#   ./scripts/admin.sh status               # are new addresses switched on?
set -euo pipefail

: "${RELAY_URL:?Set RELAY_URL, e.g. export RELAY_URL=https://api.tohyee.example}"
: "${ADMIN_TOKEN:?Set ADMIN_TOKEN to the admin password}"

auth=(-H "Authorization: Bearer ${ADMIN_TOKEN}")
base="${RELAY_URL%/}/v1/admin"

case "${1:-}" in
  list)      curl -sS "${auth[@]}" "$base/addresses" ;;
  block)     curl -sS -X POST "${auth[@]}" "$base/addresses/${2:?Which address?}/block" ;;
  unblock)   curl -sS -X POST "${auth[@]}" "$base/addresses/${2:?Which address?}/unblock" ;;
  stop-new)  curl -sS -X PUT "${auth[@]}" -H 'Content-Type: application/json' -d '{"open":false}' "$base/registrations" ;;
  start-new) curl -sS -X PUT "${auth[@]}" -H 'Content-Type: application/json' -d '{"open":true}' "$base/registrations" ;;
  status)    curl -sS "${auth[@]}" "$base/registrations" ;;
  *) sed -n '2,12p' "$0"; exit 1 ;;
esac
echo
