#!/usr/bin/env bash
set -u -o pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-20}"
AUTO_BOOTSTRAP_AGENTS="${AUTO_BOOTSTRAP_AGENTS:-1}"
RESPAWN_FEE="${RESPAWN_FEE:-10}"
RESPAWN_COMPLETE_MAX_ATTEMPTS="${RESPAWN_COMPLETE_MAX_ATTEMPTS:-20}"

M2_QUANTITY="${M2_QUANTITY:-1}"
M2_UNIT_PRICE="${M2_UNIT_PRICE:-120}"
M2_FEE_BPS="${M2_FEE_BPS:-300}"
M2_BUYER_CREDITS_TARGET="${M2_BUYER_CREDITS_TARGET:-2000}"
M2_FEE_COLLECTOR_AGENT_ID="${M2_FEE_COLLECTOR_AGENT_ID:-00000000-0000-0000-0000-00000000f001}"
M2_ASSET_ID="${M2_ASSET_ID:-}"
M2_SUPPRESS_NODE_WARNINGS="${M2_SUPPRESS_NODE_WARNINGS:-1}"

ENV_FILE="${ENV_FILE:-contracts/.env}"
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

LOG_ROOT="${LOG_ROOT:-/tmp/tactical_demo_acceptance_$(date +%Y%m%d_%H%M%S)}"
mkdir -p "$LOG_ROOT"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing command: $cmd"
    exit 1
  fi
}

require_cmd bash
require_cmd tee
require_cmd date

if ! type mapfile >/dev/null 2>&1 && [[ "$MANUAL_RESOLVE_RETRY" == "1" ]]; then
  echo "NOTICE: current bash does not support mapfile; forcing MANUAL_RESOLVE_RETRY=0 for fullstack script."
  MANUAL_RESOLVE_RETRY=0
fi

case_status_inherit="FAIL"
case_status_respawn="FAIL"
case_status_a2a="FAIL"
case_status_prediction="FAIL"

case_duration_inherit="0"
case_duration_respawn="0"
case_duration_a2a="0"
case_duration_prediction="0"

log_m1="${LOG_ROOT}/step13_m1.log"
log_m2="${LOG_ROOT}/step18_m2.log"
log_pred="${LOG_ROOT}/prediction_fullstack.log"

RUN_LAST_EXIT_CODE=0
RUN_LAST_DURATION=0

run_cmd_with_log() {
  local log_file="$1"
  shift
  local start_ts end_ts
  start_ts="$(date +%s)"
  "$@" 2>&1 | tee "$log_file"
  local exit_code=${PIPESTATUS[0]}
  end_ts="$(date +%s)"
  RUN_LAST_EXIT_CODE="$exit_code"
  RUN_LAST_DURATION="$(( end_ts - start_ts ))"
  return 0
}

echo "=== Demo Acceptance (Step28) ==="
echo "BASE_URL=${BASE_URL}"
echo "ENV_FILE=${ENV_FILE}"
echo "LOG_ROOT=${LOG_ROOT}"
echo

echo "=== CaseGroup A: M1 (cross-round inheritance + paid respawn) ==="
run_cmd_with_log "$log_m1" env \
  BASE_URL="$BASE_URL" \
  API_TIMEOUT_SECONDS="$API_TIMEOUT_SECONDS" \
  AUTO_BOOTSTRAP_AGENTS="$AUTO_BOOTSTRAP_AGENTS" \
  RESPAWN_FEE="$RESPAWN_FEE" \
  RESPAWN_COMPLETE_MAX_ATTEMPTS="$RESPAWN_COMPLETE_MAX_ATTEMPTS" \
  ./scripts/run_m1_e2e.sh
m1_code="$RUN_LAST_EXIT_CODE"
case_duration_inherit="$RUN_LAST_DURATION"
case_duration_respawn="$RUN_LAST_DURATION"
if [[ "$m1_code" == "0" ]]; then
  case_status_inherit="PASS"
  case_status_respawn="PASS"
  echo "M1 checks PASS"
else
  echo "M1 checks FAIL (exit=${m1_code})"
fi
echo

echo "=== Case B: M2 (AtoA listing -> buy -> settle -> fee) ==="
run_cmd_with_log "$log_m2" env \
  BASE_URL="$BASE_URL" \
  API_TIMEOUT_SECONDS="$API_TIMEOUT_SECONDS" \
  AUTO_BOOTSTRAP_AGENTS="$AUTO_BOOTSTRAP_AGENTS" \
  M2_QUANTITY="$M2_QUANTITY" \
  M2_UNIT_PRICE="$M2_UNIT_PRICE" \
  M2_FEE_BPS="$M2_FEE_BPS" \
  M2_BUYER_CREDITS_TARGET="$M2_BUYER_CREDITS_TARGET" \
  M2_FEE_COLLECTOR_AGENT_ID="$M2_FEE_COLLECTOR_AGENT_ID" \
  M2_ASSET_ID="$M2_ASSET_ID" \
  M2_SUPPRESS_NODE_WARNINGS="$M2_SUPPRESS_NODE_WARNINGS" \
  ./scripts/run_m2_e2e.sh
m2_code="$RUN_LAST_EXIT_CODE"
case_duration_a2a="$RUN_LAST_DURATION"
if [[ "$m2_code" == "0" ]]; then
  case_status_a2a="PASS"
  echo "M2 check PASS"
else
  echo "M2 check FAIL (exit=${m2_code})"
fi
echo

echo "=== Case C: PredictionMarket non-regression ==="
run_cmd_with_log "$log_pred" env \
  BASE_URL="$BASE_URL" \
  API_TIMEOUT_SECONDS="$API_TIMEOUT_SECONDS" \
  ENV_FILE="$ENV_FILE" \
  HUMAN_COUNT="$HUMAN_COUNT" \
  AI_COUNT="$AI_COUNT" \
  GAME_LANGUAGE="$GAME_LANGUAGE" \
  LOCK_SECONDS="$LOCK_SECONDS" \
  BET1_VALUE="$BET1_VALUE" \
  BET2_VALUE="$BET2_VALUE" \
  MANUAL_OPEN_IF_MISSING="$MANUAL_OPEN_IF_MISSING" \
  MANUAL_RESOLVE_RETRY="$MANUAL_RESOLVE_RETRY" \
  RESOLVE_POLL_INTERVAL_SECONDS="$RESOLVE_POLL_INTERVAL_SECONDS" \
  MAX_RESOLVE_WAIT_SECONDS="$MAX_RESOLVE_WAIT_SECONDS" \
  SKIP_CLAIM="$SKIP_CLAIM" \
  ./scripts/run_fullstack_e2e.sh
pred_code="$RUN_LAST_EXIT_CODE"
case_duration_prediction="$RUN_LAST_DURATION"
if [[ "$pred_code" == "0" ]]; then
  case_status_prediction="PASS"
  echo "PredictionMarket check PASS"
else
  echo "PredictionMarket check FAIL (exit=${pred_code})"
fi
echo

echo "=== Acceptance Summary ==="
printf '%-64s | %-4s | %5ss | %s\n' "UseCase" "Stat" "Dur" "Log"
printf '%-64s | %-4s | %5ss | %s\n' "1) M1 cross-round inheritance" "$case_status_inherit" "$case_duration_inherit" "$log_m1"
printf '%-64s | %-4s | %5ss | %s\n' "2) M1 paid respawn" "$case_status_respawn" "$case_duration_respawn" "$log_m1"
printf '%-64s | %-4s | %5ss | %s\n' "3) M2 AtoA settlement + fee" "$case_status_a2a" "$case_duration_a2a" "$log_m2"
printf '%-64s | %-4s | %5ss | %s\n' "4) PredictionMarket open/bet/resolve/claim" "$case_status_prediction" "$case_duration_prediction" "$log_pred"

fail_count=0
[[ "$case_status_inherit" == "PASS" ]] || fail_count=$(( fail_count + 1 ))
[[ "$case_status_respawn" == "PASS" ]] || fail_count=$(( fail_count + 1 ))
[[ "$case_status_a2a" == "PASS" ]] || fail_count=$(( fail_count + 1 ))
[[ "$case_status_prediction" == "PASS" ]] || fail_count=$(( fail_count + 1 ))

if [[ "$fail_count" -eq 0 ]]; then
  echo "=== RESULT: PASS (4/4) ==="
  exit 0
fi

echo "=== RESULT: FAIL ($((4 - fail_count))/4) ==="
exit 1
