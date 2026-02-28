#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-20}"
X402_QUERY="${X402_QUERY:-latest tactical survival intel summary}"
X402_CONTEXT="${X402_CONTEXT:-demo-from-terminal}"
X402_DRY_RUN="${X402_DRY_RUN:-false}"
X402_PAYMENT_HEADER="${X402_PAYMENT_HEADER:-}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing command: $cmd"
    exit 1
  fi
}

require_cmd curl
require_cmd jq

api_get_json() {
  local path="$1"
  local response status body
  response="$(curl -sS --max-time "$API_TIMEOUT_SECONDS" -w $'\n%{http_code}' "${BASE_URL}${path}")"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "API GET failed: ${path} (status=${status})"
    echo "$body"
    return 1
  fi
  echo "$body"
}

api_post_json() {
  local path="$1"
  local payload="$2"
  local response status body
  response="$({
    curl -sS --max-time "$API_TIMEOUT_SECONDS" \
      -H "Content-Type: application/json" \
      -X POST \
      -d "$payload" \
      -w $'\n%{http_code}' \
      "${BASE_URL}${path}"
  })"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "API POST failed: ${path} (status=${status})"
    echo "$body"
    return 1
  fi
  echo "$body"
}

echo "=== X402 Demo ==="
echo "BASE_URL=$BASE_URL"

echo "=== 0) config ==="
CONFIG="$(api_get_json "/api/x402/config")"
echo "$CONFIG" | jq
ENABLED="$(echo "$CONFIG" | jq -r '.enabled')"
MODE="$(echo "$CONFIG" | jq -r '.mode // "simulated"')"
DEMO_READY="$(echo "$CONFIG" | jq -r '.demoIntelConfigured')"
DEMO_URL="$(echo "$CONFIG" | jq -r '.demoIntelUrl // ""')"
if [[ "$ENABLED" != "true" ]]; then
  echo "X402 adapter is disabled. Set X402_ENABLED=true in apps/api/.env and restart API."
  exit 1
fi
if [[ "$DEMO_READY" != "true" ]]; then
  echo "X402 demo target is not configured. Set X402_DEMO_INTEL_URL in apps/api/.env and restart API."
  exit 1
fi
if [[ -z "$X402_PAYMENT_HEADER" && "$MODE" == "simulated" && "$DEMO_URL" == *"/api/x402/provider/intel" ]]; then
  X402_PAYMENT_HEADER="demo-simulated-payment"
fi

echo "=== 1) run demo intel request ==="
PAYLOAD="$(jq -nc \
  --arg query "$X402_QUERY" \
  --arg context "$X402_CONTEXT" \
  --arg dryRun "$X402_DRY_RUN" \
  --arg paymentHeader "$X402_PAYMENT_HEADER" \
  '
  {
    query: $query,
    context: $context,
    dryRun: (($dryRun | ascii_downcase) == "true" or $dryRun == "1")
  } + (if $paymentHeader == "" then {} else { paymentHeader: $paymentHeader } end)
  ')"
DEMO_RESP="$(api_post_json "/api/x402/demo/intel" "$PAYLOAD")"
echo "$DEMO_RESP" | jq

echo "=== 2) recent logs ==="
api_get_json "/api/x402/logs?limit=5" | jq

echo "=== X402 Demo Done ==="
