#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-}"
LANGUAGE="${LANGUAGE:-en}"

if [[ -z "$BASE_URL" ]]; then
  echo "BASE_URL is required."
  echo "Usage: BASE_URL=https://your-api.onrender.com $0"
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required."
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required."
  exit 1
fi

echo "== health check =="
curl -fsS "$BASE_URL/healthz" | jq .

echo "== create online game =="
CREATE_RESP="$(
  curl -fsS -X POST "$BASE_URL/api/games" \
    -H "Content-Type: application/json" \
    -d "{\"humanCount\":1,\"aiCount\":2,\"mode\":\"online\",\"language\":\"$LANGUAGE\"}"
)"
echo "$CREATE_RESP" | jq '{gameId,seq,status,marketOpenError}'

GAME_ID="$(echo "$CREATE_RESP" | jq -r '.gameId')"
if [[ -z "$GAME_ID" || "$GAME_ID" == "null" ]]; then
  echo "Failed to get gameId from create response."
  exit 1
fi

echo "== query game =="
GAME_RESP="$(curl -fsS "$BASE_URL/api/games/$GAME_ID")"
echo "$GAME_RESP" | jq '{gameId,seq,status,phase:.state.phase,activePlayerIndex:.state.activePlayerIndex}'

HUMAN_ID="$(echo "$GAME_RESP" | jq -r '.state.players[] | select(.isAi==false) | .id' | head -n 1)"
if [[ -z "$HUMAN_ID" || "$HUMAN_ID" == "null" ]]; then
  echo "Failed to resolve human player id."
  exit 1
fi

echo "== init agent (SETUP -> ACTIVE) =="
curl -fsS -X POST "$BASE_URL/api/games/$GAME_ID/actions" \
  -H "Content-Type: application/json" \
  -d '{"action":{"type":"INIT_AGENT","payload":{"systemPrompt":"deploy-smoke","apiKey":"dummy"}}}' \
  | jq '{seq,phase:.state.phase}'

echo "== trigger one action =="
curl -fsS -X POST "$BASE_URL/api/games/$GAME_ID/actions" \
  -H "Content-Type: application/json" \
  -d "{\"action\":{\"type\":\"SKIP_TURN\",\"payload\":{\"playerId\":\"$HUMAN_ID\"}}}" \
  | jq '{seq,error,appliedActions:(.appliedActions // [] | map({source,type:.action.type}))}'

echo "Smoke test passed."
