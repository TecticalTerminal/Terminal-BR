#!/usr/bin/env bash
# Full-stack E2E smoke runner for Tactical Terminal (API + Contract path).
#
# Goal:
#   create game -> ensure/open round -> place bets -> end game -> resolve -> claim
#
# Design principles:
# - Does NOT replace or modify `contracts/run_contract_loop.sh`.
# - Uses backend APIs for game lifecycle and mapping.
# - Uses `cast` for user-side bet/claim tx, matching frontend contract path.
# - Works for both local and Sepolia when env values are set correctly.
#
# Typical usage:
#   ENV_FILE=contracts/.env.anvil BASE_URL=http://localhost:8787 ./scripts/run_fullstack_e2e.sh
#   ENV_FILE=contracts/.env.sepolia BASE_URL=http://localhost:8787 ./scripts/run_fullstack_e2e.sh
#
# Required env (can come from ENV_FILE):
#   RPC_URL
#   MARKET_ADDRESS
#   BETTOR1_PRIVATE_KEY (or DEPLOYER_PRIVATE_KEY as fallback)
#   BETTOR2_PRIVATE_KEY (or OPERATOR_PRIVATE_KEY as fallback)
#
# Optional env:
#   BASE_URL=http://localhost:8787
#   ENV_FILE=contracts/.env
#   HUMAN_COUNT=1
#   AI_COUNT=7
#   GAME_LANGUAGE=zh
#   LOCK_SECONDS=60
#   BET1_VALUE=0.001ether
#   BET2_VALUE=0.002ether
#   MANUAL_OPEN_IF_MISSING=1
#   MANUAL_RESOLVE_RETRY=1
#   RESOLVE_POLL_INTERVAL_SECONDS=5
#   MAX_RESOLVE_WAIT_SECONDS=300
#   SKIP_CLAIM=0

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

SCRIPT_VERSION="2026-02-20.1"

ENV_FILE="${ENV_FILE:-contracts/.env}"
BASE_URL="${BASE_URL:-http://localhost:8787}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-20}"

HUMAN_COUNT="${HUMAN_COUNT:-1}"
AI_COUNT="${AI_COUNT:-7}"
GAME_LANGUAGE="${GAME_LANGUAGE:-zh}"
LOCK_SECONDS="${LOCK_SECONDS:-60}"

BET1_VALUE="${BET1_VALUE:-0.001ether}"
BET2_VALUE="${BET2_VALUE:-0.002ether}"

MANUAL_OPEN_IF_MISSING="${MANUAL_OPEN_IF_MISSING:-1}"
MANUAL_RESOLVE_RETRY="${MANUAL_RESOLVE_RETRY:-1}"
RESOLVE_POLL_INTERVAL_SECONDS="${RESOLVE_POLL_INTERVAL_SECONDS:-5}"
MAX_RESOLVE_WAIT_SECONDS="${MAX_RESOLVE_WAIT_SECONDS:-300}"
SKIP_CLAIM="${SKIP_CLAIM:-0}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing command: $cmd"
    exit 1
  fi
}

require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env: $key"
    exit 1
  fi
}

normalize_uint() {
  local raw="$1"
  if [[ "$raw" == 0x* ]]; then
    cast to-dec "$raw"
  else
    echo "$raw"
  fi
}

parse_tx_hash() {
  local text="$1"
  local direct
  direct="$(echo "$text" | sed -nE 's/.*transactionHash[[:space:]]+((0x)?[a-fA-F0-9]{64}).*/\1/p' | head -n 1)"
  if [[ -n "$direct" ]]; then
    if [[ "$direct" == 0x* ]]; then
      echo "$direct"
    else
      echo "0x${direct}"
    fi
    return 0
  fi

  echo "$text" | grep -Eo '0x[a-fA-F0-9]{64}' | head -n 1
}

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
    echo "API POST failed: ${path} (status=${status})"
    echo "$body"
    return 1
  fi
  echo "$body"
}

# Same as api_post_json but does not fail hard; used for retry loops.
api_post_json_soft() {
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
  echo "$status"
  echo "$body"
}

cast_send_and_hash() {
  local address="$1"
  local signature="$2"
  local arg1="$3"
  local arg2="$4"
  local value="$5"
  local private_key="$6"
  local output

  if [[ -n "$value" ]]; then
    output="$(
      cast send "$address" "$signature" "$arg1" "$arg2" \
        --value "$value" \
        --private-key "$private_key" \
        --rpc-url "$RPC_URL" 2>&1
    )"
  else
    output="$(
      cast send "$address" "$signature" "$arg1" \
        --private-key "$private_key" \
        --rpc-url "$RPC_URL" 2>&1
    )"
  fi

  echo "$output" >&2
  parse_tx_hash "$output"
}

require_cmd curl
require_cmd jq
require_cmd cast

if [[ ! -f "$ENV_FILE" ]]; then
  echo "Env file not found: $ENV_FILE"
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$ENV_FILE"
set +a

# Fallbacks let users reuse existing contract env files directly.
BETTOR1_PRIVATE_KEY="${BETTOR1_PRIVATE_KEY:-${DEPLOYER_PRIVATE_KEY:-}}"
BETTOR2_PRIVATE_KEY="${BETTOR2_PRIVATE_KEY:-${OPERATOR_PRIVATE_KEY:-}}"

require_env RPC_URL
require_env MARKET_ADDRESS
require_env BETTOR1_PRIVATE_KEY
require_env BETTOR2_PRIVATE_KEY

MARKET_CODE="$(cast code "$MARKET_ADDRESS" --rpc-url "$RPC_URL" 2>/dev/null || true)"
if [[ -z "$MARKET_CODE" || "$MARKET_CODE" == "0x" ]]; then
  echo "Contract has no code on RPC. Check MARKET_ADDRESS / RPC_URL."
  echo "MARKET_ADDRESS=$MARKET_ADDRESS"
  echo "RPC_URL=$RPC_URL"
  exit 1
fi

BETTOR1_ADDR="$(cast wallet address --private-key "$BETTOR1_PRIVATE_KEY")"
BETTOR2_ADDR="$(cast wallet address --private-key "$BETTOR2_PRIVATE_KEY")"

echo "=== Tactical Terminal Fullstack E2E (v${SCRIPT_VERSION}) ==="
echo "ENV_FILE: $ENV_FILE"
echo "BASE_URL: $BASE_URL"
echo "RPC_URL: $RPC_URL"
echo "MARKET_ADDRESS: $MARKET_ADDRESS"
echo "BETTOR1_ADDR: $BETTOR1_ADDR"
echo "BETTOR2_ADDR: $BETTOR2_ADDR"

echo "=== 0) health check ==="
api_get_json "/healthz" | jq

echo "=== 1) create online game ==="
CREATE_PAYLOAD="$(jq -nc \
  --argjson humanCount "$HUMAN_COUNT" \
  --argjson aiCount "$AI_COUNT" \
  --arg mode "online" \
  --arg language "$GAME_LANGUAGE" \
  '{humanCount:$humanCount, aiCount:$aiCount, mode:$mode, language:$language}')"
CREATE_RESP="$(api_post_json "/api/games" "$CREATE_PAYLOAD")"
echo "$CREATE_RESP" | jq

GAME_ID="$(echo "$CREATE_RESP" | jq -r '.gameId')"
if [[ -z "$GAME_ID" || "$GAME_ID" == "null" ]]; then
  echo "Failed to parse gameId from create response."
  exit 1
fi

HUMAN_PLAYER_ID="$(echo "$CREATE_RESP" | jq -r '.state.players[] | select(.isAi == false) | .id' | head -n 1)"
AI_PLAYER_ID="$(echo "$CREATE_RESP" | jq -r '.state.players[] | select(.isAi == true) | .id' | head -n 1)"
if [[ -z "$HUMAN_PLAYER_ID" || -z "$AI_PLAYER_ID" ]]; then
  echo "Failed to parse player ids from game state."
  exit 1
fi

echo "GAME_ID=$GAME_ID"
echo "HUMAN_PLAYER_ID=$HUMAN_PLAYER_ID"
echo "AI_PLAYER_ID=$AI_PLAYER_ID"

echo "=== 2) query market mapping ==="
MARKET_RESP="$(api_get_json "/api/markets/${GAME_ID}")"
echo "$MARKET_RESP" | jq

ROUND_ID="$(echo "$MARKET_RESP" | jq -r '.mapping.roundId // empty')"
if [[ -z "$ROUND_ID" && "$MANUAL_OPEN_IF_MISSING" == "1" ]]; then
  echo "No mapping yet, manual open fallback..."
  OPEN_PAYLOAD="$(jq -nc --arg gameId "$GAME_ID" --argjson lockSeconds "$LOCK_SECONDS" \
    '{gameId:$gameId, lockSeconds:$lockSeconds}')"
  OPEN_RESP="$(api_post_json "/api/markets/open" "$OPEN_PAYLOAD")"
  echo "$OPEN_RESP" | jq
  MARKET_RESP="$(api_get_json "/api/markets/${GAME_ID}")"
  echo "$MARKET_RESP" | jq
  ROUND_ID="$(echo "$MARKET_RESP" | jq -r '.mapping.roundId // empty')"
fi

if [[ -z "$ROUND_ID" ]]; then
  echo "Round mapping not available for game: $GAME_ID"
  exit 1
fi

ROUND_ID="$(normalize_uint "$ROUND_ID")"
GAME_ID_HASH="$(echo "$MARKET_RESP" | jq -r '.mapping.gameIdHash')"
echo "ROUND_ID=$ROUND_ID"
echo "GAME_ID_HASH=$GAME_ID_HASH"

echo "=== 3) place bets on-chain ==="
OUTCOME_HUMAN="$(cast keccak "$HUMAN_PLAYER_ID")"
OUTCOME_AI="$(cast keccak "$AI_PLAYER_ID")"
echo "OUTCOME_HUMAN=$OUTCOME_HUMAN"
echo "OUTCOME_AI=$OUTCOME_AI"

BET1_TX="$(cast_send_and_hash "$MARKET_ADDRESS" "placeBet(uint256,bytes32)" "$ROUND_ID" "$OUTCOME_HUMAN" "$BET1_VALUE" "$BETTOR1_PRIVATE_KEY")"
BET2_TX="$(cast_send_and_hash "$MARKET_ADDRESS" "placeBet(uint256,bytes32)" "$ROUND_ID" "$OUTCOME_AI" "$BET2_VALUE" "$BETTOR2_PRIVATE_KEY")"
echo "BET1_TX=$BET1_TX"
echo "BET2_TX=$BET2_TX"

echo "=== 4) end game (KILL_ALL_AI) ==="
GAME_VIEW="$(api_get_json "/api/games/${GAME_ID}")"
EXPECTED_SEQ="$(echo "$GAME_VIEW" | jq -r '.seq')"
ACTION_PAYLOAD="$(jq -nc --argjson expectedSeq "$EXPECTED_SEQ" \
  '{action:{type:"KILL_ALL_AI"}, expectedSeq:$expectedSeq}')"
ACTION_RESP="$(api_post_json "/api/games/${GAME_ID}/actions" "$ACTION_PAYLOAD")"
echo "$ACTION_RESP" | jq

echo "=== 5) wait/poll resolve ==="
START_TS="$(date +%s)"
RESOLVED_AT=""
RESOLVE_TX=""
WINNER_PLAYER_ID=""
while true; do
  MARKET_RESP="$(api_get_json "/api/markets/${GAME_ID}")"
  RESOLVED_AT="$(echo "$MARKET_RESP" | jq -r '.mapping.resolvedAt // empty')"
  RESOLVE_TX="$(echo "$MARKET_RESP" | jq -r '.mapping.resolveTxHash // empty')"
  WINNER_PLAYER_ID="$(echo "$MARKET_RESP" | jq -r '.winnerPlayerId // empty')"

  if [[ -n "$RESOLVED_AT" ]]; then
    echo "Resolved at: $RESOLVED_AT"
    break
  fi

  NOW_TS="$(date +%s)"
  ELAPSED="$(( NOW_TS - START_TS ))"
  if [[ "$ELAPSED" -ge "$MAX_RESOLVE_WAIT_SECONDS" ]]; then
    echo "Resolve timeout after ${MAX_RESOLVE_WAIT_SECONDS}s."
    echo "$MARKET_RESP" | jq
    exit 1
  fi

  if [[ "$MANUAL_RESOLVE_RETRY" == "1" ]]; then
    # Soft call: on pre-lock windows this usually returns RoundNotClosed.
    mapfile -t RESOLVE_LINES < <(api_post_json_soft "/api/markets/resolve" "$(jq -nc --arg gameId "$GAME_ID" '{gameId:$gameId}')")
    RESOLVE_STATUS="${RESOLVE_LINES[0]}"
    RESOLVE_BODY="${RESOLVE_LINES[1]:-}"
    if [[ "$RESOLVE_STATUS" -ge 200 && "$RESOLVE_STATUS" -lt 300 ]]; then
      echo "Manual resolve accepted."
      echo "$RESOLVE_BODY" | jq .
    else
      echo "Manual resolve pending/fail (status=$RESOLVE_STATUS), retrying..."
      echo "$RESOLVE_BODY" | jq . 2>/dev/null || echo "$RESOLVE_BODY"
    fi
  fi

  sleep "$RESOLVE_POLL_INTERVAL_SECONDS"
done

echo "WINNER_PLAYER_ID=$WINNER_PLAYER_ID"
echo "RESOLVE_TX=$RESOLVE_TX"

echo "=== 6) preview claim ==="
P1_CLAIM_RAW="$(cast call "$MARKET_ADDRESS" "previewClaim(uint256,address)(uint256)" "$ROUND_ID" "$BETTOR1_ADDR" --rpc-url "$RPC_URL")"
P2_CLAIM_RAW="$(cast call "$MARKET_ADDRESS" "previewClaim(uint256,address)(uint256)" "$ROUND_ID" "$BETTOR2_ADDR" --rpc-url "$RPC_URL")"
P1_CLAIM="$(normalize_uint "$P1_CLAIM_RAW")"
P2_CLAIM="$(normalize_uint "$P2_CLAIM_RAW")"
echo "P1_CLAIM_WEI=$P1_CLAIM"
echo "P2_CLAIM_WEI=$P2_CLAIM"

CLAIM1_TX=""
CLAIM2_TX=""

if [[ "$SKIP_CLAIM" != "1" ]]; then
  echo "=== 7) claim ==="
  if [[ "$P1_CLAIM" != "0" ]]; then
    CLAIM1_TX="$(cast_send_and_hash "$MARKET_ADDRESS" "claim(uint256)" "$ROUND_ID" "" "" "$BETTOR1_PRIVATE_KEY")"
    echo "CLAIM1_TX=$CLAIM1_TX"
  fi

  if [[ "$P2_CLAIM" != "0" ]]; then
    if [[ "$BETTOR2_ADDR" == "$BETTOR1_ADDR" ]]; then
      echo "Skip second claim: BETTOR1_ADDR == BETTOR2_ADDR (avoid AlreadyClaimed)."
    else
      CLAIM2_TX="$(cast_send_and_hash "$MARKET_ADDRESS" "claim(uint256)" "$ROUND_ID" "" "" "$BETTOR2_PRIVATE_KEY")"
      echo "CLAIM2_TX=$CLAIM2_TX"
    fi
  fi
else
  echo "SKIP_CLAIM=1, skip claim txs."
fi

echo "=== done ==="
echo "GAME_ID=$GAME_ID"
echo "ROUND_ID=$ROUND_ID"
echo "GAME_ID_HASH=$GAME_ID_HASH"
echo "HUMAN_PLAYER_ID=$HUMAN_PLAYER_ID"
echo "AI_PLAYER_ID=$AI_PLAYER_ID"
echo "WINNER_PLAYER_ID=$WINNER_PLAYER_ID"
echo "BET1_TX=$BET1_TX"
echo "BET2_TX=$BET2_TX"
echo "RESOLVE_TX=$RESOLVE_TX"
echo "CLAIM1_TX=$CLAIM1_TX"
echo "CLAIM2_TX=$CLAIM2_TX"
