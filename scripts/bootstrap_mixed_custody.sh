#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-20}"
AUTO_BOOTSTRAP_AGENTS="${AUTO_BOOTSTRAP_AGENTS:-1}"

MIXED_USER_EXTERNAL_ADDRESS="${MIXED_USER_EXTERNAL_ADDRESS:-}"
USER_FORCE_REPLACE="${USER_FORCE_REPLACE:-1}"

BOT_FORCE_ROTATE="${BOT_FORCE_ROTATE:-0}"
BOT_POLICY_MAX_AMOUNT_WEI="${BOT_POLICY_MAX_AMOUNT_WEI:-10000000000000000}"
BOT_POLICY_DAILY_LIMIT_WEI="${BOT_POLICY_DAILY_LIMIT_WEI:-100000000000000000}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing command: $cmd"
    exit 1
  fi
}

require_cmd curl
require_cmd jq

bool_to_json() {
  local raw
  raw="$(echo "${1:-}" | tr '[:upper:]' '[:lower:]' | xargs)"
  if [[ "$raw" == "1" || "$raw" == "true" || "$raw" == "yes" || "$raw" == "on" ]]; then
    echo "true"
  else
    echo "false"
  fi
}

api_get_json() {
  local path="$1"
  local response status body
  response="$(curl -sS --max-time "$API_TIMEOUT_SECONDS" -w $'\n%{http_code}' "${BASE_URL}${path}")"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "API GET failed: ${path} (status=${status})" >&2
    echo "$body" >&2
    return 1
  fi
  echo "$body"
}

api_post_json() {
  local path="$1"
  local payload="$2"
  local response status body
  response="$(
    curl -sS --max-time "$API_TIMEOUT_SECONDS" \
      -H "Content-Type: application/json" \
      -X POST \
      -d "$payload" \
      -w $'\n%{http_code}' \
      "${BASE_URL}${path}"
  )"
  status="${response##*$'\n'}"
  body="${response%$'\n'*}"
  if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
    echo "API POST failed: ${path} (status=${status})" >&2
    echo "$body" >&2
    return 1
  fi
  echo "$body"
}

create_agent() {
  local kind="$1"
  local index="$2"
  local display_name prompt_default
  if [[ "$kind" == "user" ]]; then
    display_name="MIXED_USER_${index}"
    prompt_default="You are the user-controlled tactical survivor. Prioritize survival and long-term gains."
  else
    display_name="MIXED_BOT_${index}"
    prompt_default="You are an autonomous tactical bot. Optimize survival, trading and long-term assets."
  fi

  local payload
  payload="$(jq -nc \
    --arg kind "$kind" \
    --arg displayName "$display_name" \
    --arg promptDefault "$prompt_default" \
    '{
      kind: $kind,
      status: "active",
      profile: {
        displayName: $displayName,
        promptDefault: $promptDefault
      }
    }')"
  api_post_json "/api/agents" "$payload" >/dev/null
}

ensure_agent_pool() {
  local active_user_count active_bot_count need_users need_bots i
  active_user_count="$(api_get_json "/api/agents?kind=user&status=active" | jq -r '.count // 0')"
  active_bot_count="$(api_get_json "/api/agents?kind=bot&status=active" | jq -r '.count // 0')"
  echo "active users=${active_user_count}, active bots=${active_bot_count}"

  if [[ "$AUTO_BOOTSTRAP_AGENTS" != "1" ]]; then
    return 0
  fi

  need_users=$(( 1 - active_user_count ))
  need_bots=$(( 7 - active_bot_count ))
  if (( need_users < 0 )); then need_users=0; fi
  if (( need_bots < 0 )); then need_bots=0; fi

  if (( need_users == 0 && need_bots == 0 )); then
    return 0
  fi

  echo "bootstrapping missing agents: users=${need_users}, bots=${need_bots}"
  for ((i=1; i<=need_users; i++)); do
    create_agent "user" "$(date +%s)-u-${RANDOM}-${i}"
  done
  for ((i=1; i<=need_bots; i++)); do
    create_agent "bot" "$(date +%s)-b-${RANDOM}-${i}"
  done
}

print_wallet_snapshot() {
  local agent_id="$1"
  local snap mode addr
  snap="$(api_get_json "/api/agents/${agent_id}/wallet")"
  mode="$(echo "$snap" | jq -r '.wallet.custodyMode // "none"')"
  addr="$(echo "$snap" | jq -r '.wallet.address // "-"')"
  echo "  - ${agent_id} mode=${mode} address=${addr}"
}

echo "=== Scheme-C Bootstrap (1 user external + 7 bots managed) ==="
echo "BASE_URL=${BASE_URL}"

echo "=== 0) health ==="
api_get_json "/healthz" | jq

echo "=== 1) ensure active registry pool ==="
ensure_agent_pool

AGENTS_JSON="$(api_get_json "/api/agents?status=active")"
USER_ID="$(echo "$AGENTS_JSON" | jq -r '.items[] | select(.kind=="user") | .id' | head -n 1)"
BOT_IDS="$(echo "$AGENTS_JSON" | jq -r '.items[] | select(.kind=="bot") | .id' | head -n 7)"
BOT_COUNT="$(echo "$BOT_IDS" | sed '/^$/d' | wc -l | xargs)"

if [[ -z "$USER_ID" || "$USER_ID" == "null" ]]; then
  echo "No active user agent found."
  exit 1
fi
if [[ "$BOT_COUNT" -lt 7 ]]; then
  echo "Need at least 7 active bots. current=${BOT_COUNT}"
  exit 1
fi

echo "USER_ID=${USER_ID}"
echo "BOT_COUNT=${BOT_COUNT}"

echo "=== 2) bind user external wallet ==="
if [[ -z "$MIXED_USER_EXTERNAL_ADDRESS" ]]; then
  echo "MIXED_USER_EXTERNAL_ADDRESS is empty; skip binding user external wallet."
else
  OCCUPIED_BY="$(echo "$AGENTS_JSON" | jq -r \
    --arg addr "$(echo "$MIXED_USER_EXTERNAL_ADDRESS" | tr '[:upper:]' '[:lower:]')" \
    '.items[]
      | select((.wallet.address // "" | ascii_downcase) == $addr)
      | .id' | head -n 1)"
  if [[ -n "$OCCUPIED_BY" && "$OCCUPIED_BY" != "$USER_ID" ]]; then
    echo "wallet address already occupied by another agent: $OCCUPIED_BY"
    echo "please use a different MIXED_USER_EXTERNAL_ADDRESS"
    exit 1
  fi

  USER_FORCE_REPLACE_JSON="$(bool_to_json "$USER_FORCE_REPLACE")"
  USER_PAYLOAD="$(jq -nc \
    --arg address "$MIXED_USER_EXTERNAL_ADDRESS" \
    --argjson forceReplace "$USER_FORCE_REPLACE_JSON" \
    '{address: $address, forceReplace: $forceReplace}')"
  BIND_RESP="$(api_post_json "/api/agents/${USER_ID}/wallet/external" "$USER_PAYLOAD")"
  if echo "$BIND_RESP" | jq -e . >/dev/null 2>&1; then
    echo "$BIND_RESP" | jq
  else
    echo "$BIND_RESP"
  fi
fi

echo "=== 3) ensure bot managed wallets ==="
BOT_FORCE_ROTATE_JSON="$(bool_to_json "$BOT_FORCE_ROTATE")"
while IFS= read -r bot_id; do
  [[ -z "$bot_id" ]] && continue
  payload="$(jq -nc \
    --argjson forceRotate "$BOT_FORCE_ROTATE_JSON" \
    --arg maxAmountWei "$BOT_POLICY_MAX_AMOUNT_WEI" \
    --arg dailyLimitWei "$BOT_POLICY_DAILY_LIMIT_WEI" \
    '{
      forceRotate: $forceRotate,
      policy: {
        maxAmountWei: $maxAmountWei,
        dailyLimitWei: $dailyLimitWei
      }
    }')"
  api_post_json "/api/agents/${bot_id}/wallet/managed" "$payload" >/dev/null
  echo "managed wallet ensured: ${bot_id}"
done <<< "$BOT_IDS"

echo "=== 4) summary ==="
echo "user wallet:"
print_wallet_snapshot "$USER_ID"

echo "bot wallets:"
while IFS= read -r bot_id; do
  [[ -z "$bot_id" ]] && continue
  print_wallet_snapshot "$bot_id"
done <<< "$BOT_IDS"

echo "=== done ==="
