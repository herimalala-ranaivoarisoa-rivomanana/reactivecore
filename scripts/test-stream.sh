#!/usr/bin/env bash
set -euo pipefail

if [[ -z ${DEV_API_TOKEN:-} ]]; then
  echo 'Load DEV_API_TOKEN from your local laboratory configuration first.' >&2
  exit 1
fi

pharmacy_id=${1:-22222222-2222-4222-8222-222222222222}
if [[ ! $pharmacy_id =~ ^[[:xdigit:]-]{36}$ ]]; then
  echo 'Expected a pharmacy UUID.' >&2
  exit 1
fi

curl --no-buffer --fail-with-body --silent --show-error \
  "${REACTIVECORE_API_URL:-http://127.0.0.1:${PORT:-4000}}/api/reactive/subscribe" \
  -H 'Content-Type: application/json' \
  -H "X-Dev-Token: $DEV_API_TOKEN" \
  --data "{\"name\":\"inventory.list\",\"args\":{\"pharmacyId\":\"$pharmacy_id\"}}"
