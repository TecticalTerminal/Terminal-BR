#!/usr/bin/env bash
# One-shot contract loop runner for PredictionMarket:
# build -> deploy (optional) -> openRound -> placeBet -> resolveRound -> claim.
#
# Execution model:
# - Reads environment from `contracts/.env` (if exists).
# - Can run on Sepolia by default, and on other chains when explicitly allowed.
# - Prints final key outputs for traceability and integration.
set -euo pipefail

SCRIPT_VERSION="2026-02-20.1"

# Resolve repository-local contracts root, then force cwd to this script's root.
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# Auto-load env file for convenience.
# `set -a` exports all sourced variables to subprocesses.
ENV_FILE="${ENV_FILE:-.env}"
if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ENV_FILE"
  set +a
else
  echo "Env file not found: $ENV_FILE"
  echo "Set ENV_FILE=.env.anvil (local) or ENV_FILE=.env.sepolia (testnet)."
  exit 1
fi

# Fail fast if a required command is not present in PATH.
require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing command: $cmd"
    exit 1
  fi
}

# Fail fast when a required env variable is empty/missing.
require_env() {
  local key="$1"
  if [[ -z "${!key:-}" ]]; then
    echo "Missing required env: $key"
    exit 1
  fi
}

require_cmd forge
require_cmd cast

require_contract_code() {
  local address="$1"
  local rpc_url="$2"

  local code
  code="$(cast code "$address" --rpc-url "$rpc_url" 2>/dev/null || true)"
  if [[ -z "$code" || "$code" == "0x" ]]; then
    echo "Contract has no code on current RPC:"
    echo "  MARKET_ADDRESS=$address"
    echo "  RPC_URL=$rpc_url"
    echo "This usually means RPC/chain mismatch or stale MARKET_ADDRESS."
    return 1
  fi
  return 0
}

# Minimum required runtime inputs.
require_env RPC_URL
require_env DEPLOYER_PRIVATE_KEY
require_env OPERATOR_PRIVATE_KEY

# Runtime defaults.
# Note:
# - WINNER_LABEL defaults to OUTCOME_A_LABEL
# - BETTOR keys default to deployer/operator
# - CHAIN_ID_EXPECTED defaults to Sepolia (11155111)
GAME_ID="${GAME_ID:-game-$(date +%s)}"
OUTCOME_A_LABEL="${OUTCOME_A_LABEL:-HUMAN_1}"
OUTCOME_B_LABEL="${OUTCOME_B_LABEL:-AI_1}"
WINNER_LABEL="${WINNER_LABEL:-$OUTCOME_A_LABEL}"
ROUND_LOCK_SECONDS="${ROUND_LOCK_SECONDS:-180}"
BETTOR1_PRIVATE_KEY="${BETTOR1_PRIVATE_KEY:-$DEPLOYER_PRIVATE_KEY}"
BETTOR2_PRIVATE_KEY="${BETTOR2_PRIVATE_KEY:-$OPERATOR_PRIVATE_KEY}"
BET1_VALUE="${BET1_VALUE:-0.01ether}"
BET2_VALUE="${BET2_VALUE:-0.02ether}"
SKIP_CLAIM="${SKIP_CLAIM:-0}"
CHAIN_ID_EXPECTED="${CHAIN_ID_EXPECTED:-11155111}"
ALLOW_NON_SEPOLIA="${ALLOW_NON_SEPOLIA:-0}"

# Resolver can be explicitly configured; if not, derive from OPERATOR_PRIVATE_KEY.
if [[ -z "${MARKET_RESOLVER:-}" ]]; then
  MARKET_RESOLVER="$(cast wallet address --private-key "$OPERATOR_PRIVATE_KEY")"
fi

# Safety guard: default behavior enforces Sepolia.
# For local/another chain, set ALLOW_NON_SEPOLIA=1.
if [[ "$ALLOW_NON_SEPOLIA" != "1" ]]; then
  CHAIN_ID_ACTUAL="$(cast chain-id --rpc-url "$RPC_URL")"
  if [[ "$CHAIN_ID_ACTUAL" != "$CHAIN_ID_EXPECTED" ]]; then
    echo "RPC chain id mismatch: expected=$CHAIN_ID_EXPECTED actual=$CHAIN_ID_ACTUAL"
    echo "Set ALLOW_NON_SEPOLIA=1 if you intentionally run on another chain."
    exit 1
  fi
fi

# Derive addresses from private keys for logs and claim preview.
BETTOR1_ADDR="$(cast wallet address --private-key "$BETTOR1_PRIVATE_KEY")"
BETTOR2_ADDR="$(cast wallet address --private-key "$BETTOR2_PRIVATE_KEY")"
OPERATOR_ADDR="$(cast wallet address --private-key "$OPERATOR_PRIVATE_KEY")"
DEPLOYER_ADDR="$(cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY")"

# Canonical hashing for on-chain identifiers:
# - game id hash maps off-chain game to on-chain round
# - outcome hashes represent bet targets
GAME_ID_HASH="$(cast keccak "$GAME_ID")"
OUTCOME_A="$(cast keccak "$OUTCOME_A_LABEL")"
OUTCOME_B="$(cast keccak "$OUTCOME_B_LABEL")"
WINNER_OUTCOME="$(cast keccak "$WINNER_LABEL")"
ROUND_LOCK_AT="$(( $(date +%s) + ROUND_LOCK_SECONDS ))"

echo "=== Tactical Terminal Contract Loop (v${SCRIPT_VERSION}) ==="
echo "ENV_FILE: $ENV_FILE"
echo "RPC_URL: $RPC_URL"
echo "DEPLOYER_ADDR: $DEPLOYER_ADDR"
echo "OPERATOR_ADDR: $OPERATOR_ADDR"
echo "MARKET_RESOLVER: $MARKET_RESOLVER"
echo "GAME_ID: $GAME_ID"
echo "GAME_ID_HASH: $GAME_ID_HASH"
echo "OUTCOME_A: $OUTCOME_A_LABEL => $OUTCOME_A"
echo "OUTCOME_B: $OUTCOME_B_LABEL => $OUTCOME_B"
echo "WINNER: $WINNER_LABEL => $WINNER_OUTCOME"
echo "ROUND_LOCK_AT: $ROUND_LOCK_AT"

# Always compile first so deployment and ABI calls use latest artifacts.
echo "=== forge build ==="
forge build

# Deployment phase:
# - If MARKET_ADDRESS is already provided, skip deployment.
# - Otherwise run Foundry deploy script and parse address from broadcast file.
if [[ -z "${MARKET_ADDRESS:-}" ]]; then
  echo "=== deploy PredictionMarket ==="
  CHAIN_ID_FOR_BROADCAST="$(cast chain-id --rpc-url "$RPC_URL")"

  # Capture deploy output instead of failing immediately, so we can print full diagnostics.
  set +e
  DEPLOY_OUTPUT="$(
    forge script script/DeployPredictionMarket.s.sol:DeployPredictionMarket \
      --rpc-url "$RPC_URL" \
      --broadcast \
      --private-key "$DEPLOYER_PRIVATE_KEY" \
      -vvvv 2>&1
  )"
  DEPLOY_EXIT_CODE=$?
  set -e

  echo "$DEPLOY_OUTPUT"
  if [[ $DEPLOY_EXIT_CODE -ne 0 ]]; then
    echo "Deployment command failed with exit code $DEPLOY_EXIT_CODE"
    exit $DEPLOY_EXIT_CODE
  fi

  # Foundry writes script tx details under broadcast/<script>/<chainId>/run-latest.json.
  BROADCAST_FILE="broadcast/DeployPredictionMarket.s.sol/${CHAIN_ID_FOR_BROADCAST}/run-latest.json"
  if [[ ! -f "$BROADCAST_FILE" ]]; then
    echo "Broadcast file not found: $BROADCAST_FILE"
    exit 1
  fi

  # Parse deployed contract address from script output JSON.
  MARKET_ADDRESS="$(
    grep -Eo '"contractAddress"[[:space:]]*:[[:space:]]*"0x[a-fA-F0-9]{40}"' "$BROADCAST_FILE" \
      | sed -E 's/.*"(0x[a-fA-F0-9]{40})".*/\1/' \
      | head -n 1
  )"
  if [[ -z "$MARKET_ADDRESS" ]]; then
    echo "Failed to parse MARKET_ADDRESS from broadcast file: $BROADCAST_FILE"
    echo "Run with debug: bash -x ./script/run_contract_loop.sh"
    exit 1
  fi

  if ! require_contract_code "$MARKET_ADDRESS" "$RPC_URL"; then
    exit 1
  fi
else
  echo "Using existing MARKET_ADDRESS: $MARKET_ADDRESS"
  if ! require_contract_code "$MARKET_ADDRESS" "$RPC_URL"; then
    exit 1
  fi
fi

# 1) Open round by resolver/operator.
echo "=== open round ==="
cast send "$MARKET_ADDRESS" "openRound(bytes32,uint64)" "$GAME_ID_HASH" "$ROUND_LOCK_AT" \
  --private-key "$OPERATOR_PRIVATE_KEY" \
  --rpc-url "$RPC_URL"

# Query round id by game hash.
ROUND_ID_RAW="$(cast call "$MARKET_ADDRESS" "roundIdByGame(bytes32)(uint256)" "$GAME_ID_HASH" --rpc-url "$RPC_URL")"
if [[ "$ROUND_ID_RAW" == 0x* ]]; then
  ROUND_ID="$(cast to-dec "$ROUND_ID_RAW")"
else
  ROUND_ID="$ROUND_ID_RAW"
fi

if [[ -z "$ROUND_ID" || "$ROUND_ID" == "0" ]]; then
  echo "Failed to query valid round id."
  exit 1
fi

echo "ROUND_ID: $ROUND_ID"

# 2) Place two sample bets.
echo "=== place bets ==="
cast send "$MARKET_ADDRESS" "placeBet(uint256,bytes32)" "$ROUND_ID" "$OUTCOME_A" \
  --value "$BET1_VALUE" \
  --private-key "$BETTOR1_PRIVATE_KEY" \
  --rpc-url "$RPC_URL"

cast send "$MARKET_ADDRESS" "placeBet(uint256,bytes32)" "$ROUND_ID" "$OUTCOME_B" \
  --value "$BET2_VALUE" \
  --private-key "$BETTOR2_PRIVATE_KEY" \
  --rpc-url "$RPC_URL"

# 3) Wait until lock timestamp is passed, then resolve.
echo "=== wait for lock ==="
NOW="$(date +%s)"
if [[ "$NOW" -lt "$ROUND_LOCK_AT" ]]; then
  SLEEP_SECONDS="$(( ROUND_LOCK_AT - NOW + 3 ))"
  echo "Sleeping ${SLEEP_SECONDS}s until round can be resolved..."
  sleep "$SLEEP_SECONDS"
fi

echo "=== resolve round ==="
cast send "$MARKET_ADDRESS" "resolveRound(uint256,bytes32)" "$ROUND_ID" "$WINNER_OUTCOME" \
  --private-key "$OPERATOR_PRIVATE_KEY" \
  --rpc-url "$RPC_URL"

# 4) Preview claims for both bettors.
echo "=== preview claims ==="
P1_CLAIM="$(cast call "$MARKET_ADDRESS" "previewClaim(uint256,address)(uint256)" "$ROUND_ID" "$BETTOR1_ADDR" --rpc-url "$RPC_URL")"
P2_CLAIM="$(cast call "$MARKET_ADDRESS" "previewClaim(uint256,address)(uint256)" "$ROUND_ID" "$BETTOR2_ADDR" --rpc-url "$RPC_URL")"
echo "BETTOR1 claimable (wei): $P1_CLAIM"
echo "BETTOR2 claimable (wei): $P2_CLAIM"

# 5) Claim phase.
# - SKIP_CLAIM=1 skips claim txs.
# - Only submit claim tx for accounts with claimable > 0.
# - If two private keys map to the same address, second claim would revert (AlreadyClaimed).
if [[ "$SKIP_CLAIM" != "1" ]]; then
  if [[ "$P1_CLAIM" != "0" ]]; then
    echo "=== claim: BETTOR1 ==="
    cast send "$MARKET_ADDRESS" "claim(uint256)" "$ROUND_ID" \
      --private-key "$BETTOR1_PRIVATE_KEY" \
      --rpc-url "$RPC_URL"
  fi

  if [[ "$P2_CLAIM" != "0" ]]; then
    echo "=== claim: BETTOR2 ==="
    cast send "$MARKET_ADDRESS" "claim(uint256)" "$ROUND_ID" \
      --private-key "$BETTOR2_PRIVATE_KEY" \
      --rpc-url "$RPC_URL"
  fi
else
  echo "SKIP_CLAIM=1, skip claim tx."
fi

echo "=== done ==="
echo "MARKET_ADDRESS=$MARKET_ADDRESS"
echo "ROUND_ID=$ROUND_ID"
echo "GAME_ID=$GAME_ID"
echo "GAME_ID_HASH=$GAME_ID_HASH"
echo "WINNER_OUTCOME=$WINNER_OUTCOME"
