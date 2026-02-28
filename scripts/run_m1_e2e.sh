#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-20}"
RESPAWN_FEE="${RESPAWN_FEE:-10}"
AUTO_BOOTSTRAP_AGENTS="${AUTO_BOOTSTRAP_AGENTS:-1}"
RESPAWN_COMPLETE_MAX_ATTEMPTS="${RESPAWN_COMPLETE_MAX_ATTEMPTS:-20}"

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

api_post_json_soft() {
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
  printf '%s\n%s\n' "$status" "$body"
}

extract_error_message() {
  local body="$1"
  local err
  err="$(echo "$body" | jq -r '.error // empty' 2>/dev/null || true)"
  if [[ -n "$err" ]]; then
    echo "$err"
  else
    echo "$body"
  fi
}

extract_retry_after_seconds() {
  local text="$1"
  echo "$text" | sed -nE 's/.*retryAfterSeconds=([0-9]+).*/\1/p' | head -n 1
}

get_agent_status() {
  local agent_id="$1"
  api_get_json "/api/agents/${agent_id}" | jq -r '.status'
}

complete_respawn_with_retry() {
  local agent_id="$1"
  local attempt status body err retry_after

  for ((attempt=1; attempt<=RESPAWN_COMPLETE_MAX_ATTEMPTS; attempt++)); do
    mapfile_tmp="$(api_post_json_soft "/api/agents/${agent_id}/respawn/complete" '{}')"
    status="$(echo "$mapfile_tmp" | head -n 1)"
    body="$(echo "$mapfile_tmp" | tail -n +2)"
    err="$(extract_error_message "$body")"

    if [[ "$status" -ge 200 && "$status" -lt 300 ]]; then
      return 0
    fi

    if [[ "$status" == "404" ]]; then
      if [[ "$(get_agent_status "$agent_id")" == "active" ]]; then
        return 0
      fi
    fi

    if [[ "$status" == "409" ]]; then
      retry_after="$(extract_retry_after_seconds "$err")"
      if [[ -z "$retry_after" ]]; then
        retry_after=1
      fi
      echo "complete-respawn retry bot=$agent_id attempt=$attempt wait=${retry_after}s reason=$err"
      sleep "$retry_after"
      continue
    fi

    echo "complete-respawn failed bot=$agent_id status=$status error=$err"
    return 1
  done

  echo "complete-respawn failed bot=$agent_id attempts_exhausted=$RESPAWN_COMPLETE_MAX_ATTEMPTS"
  return 1
}

respawn_bot_with_recovery() {
  local bot_id="$1"
  local req_payload="$2"
  local response status body err

  response="$(api_post_json_soft "/api/agents/${bot_id}/respawn/request" "$req_payload")"
  status="$(echo "$response" | head -n 1)"
  body="$(echo "$response" | tail -n +2)"
  err="$(extract_error_message "$body")"

  if [[ "$status" -ge 200 && "$status" -lt 300 ]]; then
    complete_respawn_with_retry "$bot_id" || return 1
    [[ "$(get_agent_status "$bot_id")" == "active" ]]
    return $?
  fi

  if [[ "$status" == "409" && "$err" == *"Respawn already in progress"* ]]; then
    echo "respawn in-progress detected, bot=$bot_id -> complete existing record first"
    complete_respawn_with_retry "$bot_id" || return 1

    if [[ "$(get_agent_status "$bot_id")" == "active" ]]; then
      return 0
    fi

    response="$(api_post_json_soft "/api/agents/${bot_id}/respawn/request" "$req_payload")"
    status="$(echo "$response" | head -n 1)"
    body="$(echo "$response" | tail -n +2)"
    err="$(extract_error_message "$body")"
    if [[ "$status" -lt 200 || "$status" -ge 300 ]]; then
      echo "respawn-request failed after recovery bot=$bot_id status=$status error=$err"
      return 1
    fi

    complete_respawn_with_retry "$bot_id" || return 1
    [[ "$(get_agent_status "$bot_id")" == "active" ]]
    return $?
  fi

  echo "respawn-request failed bot=$bot_id status=$status error=$err"
  return 1
}

create_agent() {
  local kind="$1"
  local suffix="$2"
  local display_name prompt_default
  if [[ "$kind" == "user" ]]; then
    display_name="AUTO_USER_${suffix}"
    prompt_default="You are the human-controlled tactical survivor. Prioritize survival and asset retention."
  else
    display_name="AUTO_BOT_${suffix}"
    prompt_default="You are an autonomous tactical bot. Optimize survival, loot value, and long-term assets."
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

ensure_active_agent_pool() {
  local active_user_count active_bot_count need_users need_bots i
  active_user_count="$(api_get_json "/api/agents?kind=user&status=active" | jq -r '.count // 0')"
  active_bot_count="$(api_get_json "/api/agents?kind=bot&status=active" | jq -r '.count // 0')"

  echo "active users=$active_user_count, active bots=$active_bot_count"

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

  echo "auto bootstrap enabled, creating missing agents: users=$need_users bots=$need_bots"

  for ((i=1; i<=need_users; i++)); do
    create_agent "user" "$(date +%s)-u-${RANDOM}-${i}"
  done
  for ((i=1; i<=need_bots; i++)); do
    create_agent "bot" "$(date +%s)-b-${RANDOM}-${i}"
  done
}

echo "=== Step13 / M1 E2E ==="
echo "BASE_URL=$BASE_URL"
echo "AUTO_BOOTSTRAP_AGENTS=$AUTO_BOOTSTRAP_AGENTS"
echo "RESPAWN_COMPLETE_MAX_ATTEMPTS=$RESPAWN_COMPLETE_MAX_ATTEMPTS"

echo "=== 0) health ==="
api_get_json "/healthz" | jq

echo "=== 1) select 1 user + 7 bots from active registry ==="
ensure_active_agent_pool
AGENTS_JSON="$(api_get_json "/api/agents?status=active")"
USER_ID="$(echo "$AGENTS_JSON" | jq -r '.items[] | select(.kind=="user") | .id' | head -n 1)"
BOT_COUNT="$(echo "$AGENTS_JSON" | jq -r '[.items[] | select(.kind=="bot")] | length')"
if [[ -z "$USER_ID" || "$USER_ID" == "null" ]]; then
  echo "No active user agent found."
  exit 1
fi
if [[ "$BOT_COUNT" -lt 7 ]]; then
  echo "Need at least 7 active bots. current=$BOT_COUNT"
  exit 1
fi

SNAPSHOTS="$(echo "$AGENTS_JSON" | jq -c '
  (.items | map(select(.kind=="user")) | .[0:1]) as $users |
  (.items | map(select(.kind=="bot")) | .[0:7]) as $bots |
  ($users + $bots) | map({
    agentId: .id,
    kind: .kind,
    displayName: (.profile.displayName // .id),
    accountIdentifier: .accountIdentifier,
    walletAddress: (.wallet.address // null),
    prompt: (.profile.promptOverride // .profile.promptDefault)
  })
')"

SELECTED_COUNT="$(echo "$SNAPSHOTS" | jq 'length')"
if [[ "$SELECTED_COUNT" -ne 8 ]]; then
  echo "Failed to build 8 snapshots. count=$SELECTED_COUNT"
  exit 1
fi

FIRST_BOT_ID="$(echo "$SNAPSHOTS" | jq -r '.[] | select(.kind=="bot") | .agentId' | head -n 1)"

before_credits() {
  local agent_id="$1"
  api_get_json "/api/agents/${agent_id}/assets/persistent" | jq -r '.persistentAssets.currency.credits // "0"'
}

USER_CREDITS_BEFORE="$(before_credits "$USER_ID")"
BOT1_CREDITS_BEFORE="$(before_credits "$FIRST_BOT_ID")"

echo "USER_ID=$USER_ID credits_before=$USER_CREDITS_BEFORE"
echo "BOT1_ID=$FIRST_BOT_ID credits_before=$BOT1_CREDITS_BEFORE"

echo "=== 2) create game #1 with snapshots ==="
CREATE1_PAYLOAD="$(jq -nc --argjson snapshots "$SNAPSHOTS" '{humanCount:1, aiCount:7, mode:"online", language:"zh", agentSnapshots:$snapshots}')"
CREATE1_RESP="$(api_post_json "/api/games" "$CREATE1_PAYLOAD")"
echo "$CREATE1_RESP" | jq '{gameId, seq, status, phase: .state.phase}'

GAME1_ID="$(echo "$CREATE1_RESP" | jq -r '.gameId')"
HUMAN_PLAYER_ID="$(echo "$CREATE1_RESP" | jq -r '.state.players[] | select(.isAi==false) | .id' | head -n 1)"

if [[ -z "$GAME1_ID" || "$GAME1_ID" == "null" ]]; then
  echo "Failed to create game #1"
  exit 1
fi

echo "=== 3) activate game then force finish round ==="
api_post_json "/api/games/${GAME1_ID}/actions" '{"action":{"type":"INIT_AGENT","payload":{"systemPrompt":"m1-e2e","apiKey":"demo"}}}' >/dev/null
ACTION_END_RESP="$(api_post_json "/api/games/${GAME1_ID}/actions" '{"action":{"type":"KILL_ALL_AI"}}')"
PHASE_AFTER_END="$(echo "$ACTION_END_RESP" | jq -r '.state.phase')"
if [[ "$PHASE_AFTER_END" != "GAME_OVER" ]]; then
  echo "Expected GAME_OVER after KILL_ALL_AI, got: $PHASE_AFTER_END"
  exit 1
fi
echo "$ACTION_END_RESP" | jq '{seq, phase: .state.phase, winner: .state.winner.id}'

SEQ_AFTER_GAME1="$(echo "$ACTION_END_RESP" | jq -r '.seq')"

echo "=== 4) verify settlement credits were written ==="
USER_CREDITS_AFTER_GAME1="$(before_credits "$USER_ID")"
BOT1_CREDITS_AFTER_GAME1="$(before_credits "$FIRST_BOT_ID")"
echo "USER credits: $USER_CREDITS_BEFORE -> $USER_CREDITS_AFTER_GAME1"
echo "BOT1 credits: $BOT1_CREDITS_BEFORE -> $BOT1_CREDITS_AFTER_GAME1"

if [[ "$USER_CREDITS_AFTER_GAME1" -lt "$USER_CREDITS_BEFORE" ]]; then
  echo "User credits did not increase as expected."
  exit 1
fi
if [[ "$BOT1_CREDITS_AFTER_GAME1" -lt "$BOT1_CREDITS_BEFORE" ]]; then
  echo "Bot credits did not increase as expected."
  exit 1
fi

DEAD_BOTS=()
while IFS= read -r id; do
  [[ -z "$id" ]] && continue
  status="$(api_get_json "/api/agents/${id}" | jq -r '.status')"
  if [[ "$status" == "dead" ]]; then
    DEAD_BOTS+=("$id")
  fi
done < <(echo "$SNAPSHOTS" | jq -r '.[] | select(.kind=="bot") | .agentId')

if [[ "${#DEAD_BOTS[@]}" -eq 0 ]]; then
  echo "No dead bots found, expected dead agents after GAME_OVER."
  exit 1
fi

echo "=== 5) paid respawn for dead bots (fee=$RESPAWN_FEE, cooldown=0) ==="
RESPAWN_FAILED=()
for bot_id in "${DEAD_BOTS[@]}"; do
  req_payload="$(jq -nc --arg gameId "$GAME1_ID" --arg fee "$RESPAWN_FEE" --argjson deathSeq "$SEQ_AFTER_GAME1" '{gameId:$gameId, deathSeq:$deathSeq, feeAmount:$fee, cooldownSeconds:0}')"
  if ! respawn_bot_with_recovery "$bot_id" "$req_payload"; then
    status="$(get_agent_status "$bot_id")"
    RESPAWN_FAILED+=("${bot_id}:${status}")
    echo "respawn failed bot=$bot_id status=$status"
    continue
  fi
  status="$(get_agent_status "$bot_id")"
  echo "respawned bot=$bot_id status=$status"
done

if [[ "${#RESPAWN_FAILED[@]}" -gt 0 ]]; then
  echo "Respawn failures:"
  printf '  - %s\n' "${RESPAWN_FAILED[@]}"
  exit 1
fi

echo "=== 6) create game #2 with same snapshots (inheritance check) ==="
CREATE2_PAYLOAD="$CREATE1_PAYLOAD"
CREATE2_RESP="$(api_post_json "/api/games" "$CREATE2_PAYLOAD")"
GAME2_ID="$(echo "$CREATE2_RESP" | jq -r '.gameId')"
if [[ -z "$GAME2_ID" || "$GAME2_ID" == "null" ]]; then
  echo "Failed to create game #2"
  exit 1
fi

BOT1_SNAPSHOT_CREDITS="$(echo "$CREATE2_RESP" | jq -r --arg id "$FIRST_BOT_ID" '.state.players[] | select(.id==$id) | .agent.persistentAssets.currency.credits // empty')"
if [[ -z "$BOT1_SNAPSHOT_CREDITS" ]]; then
  echo "Game #2 snapshot missing persistent credits for bot=$FIRST_BOT_ID"
  exit 1
fi
BOT1_CREDITS_AFTER_RESPAWN="$(before_credits "$FIRST_BOT_ID")"
if [[ "$BOT1_SNAPSHOT_CREDITS" != "$BOT1_CREDITS_AFTER_RESPAWN" ]]; then
  echo "Game #2 snapshot credits mismatch for bot=$FIRST_BOT_ID snapshot=$BOT1_SNAPSHOT_CREDITS ledger=$BOT1_CREDITS_AFTER_RESPAWN"
  exit 1
fi

echo "$CREATE2_RESP" | jq '{gameId, seq, status, phase: .state.phase}'
echo "BOT1 persistent credits in game#2 snapshot: $BOT1_SNAPSHOT_CREDITS"

echo "=== Step13 PASSED ==="
echo "Verified: round settlement -> paid respawn -> next-round snapshot inheritance"
