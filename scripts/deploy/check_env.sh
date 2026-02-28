#!/usr/bin/env bash
set -euo pipefail

MODE="${1:-}"
ENV_FILE="${ENV_FILE:-}"

if [[ -z "$MODE" ]]; then
  echo "Usage: $0 <api|web>"
  echo "Optional: ENV_FILE=apps/api/.env $0 api"
  exit 1
fi

if [[ -z "$ENV_FILE" ]]; then
  if [[ "$MODE" == "api" && -f "apps/api/.env" ]]; then
    ENV_FILE="apps/api/.env"
  elif [[ "$MODE" == "web" && -f "apps/web/.env.local" ]]; then
    ENV_FILE="apps/web/.env.local"
  elif [[ "$MODE" == "web" && -f "apps/web/.env" ]]; then
    ENV_FILE="apps/web/.env"
  fi
fi

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ENV_FILE not found: $ENV_FILE"
    exit 1
  fi
  echo "Info: loading env from $ENV_FILE"
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

is_true() {
  local raw="${1:-}"
  local normalized
  normalized="$(echo "$raw" | tr '[:upper:]' '[:lower:]' | xargs)"
  [[ "$normalized" == "1" || "$normalized" == "true" || "$normalized" == "yes" || "$normalized" == "on" ]]
}

require_var() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    echo "Missing required env: $name"
    exit 1
  fi
}

warn_default() {
  local name="$1"
  local default_value="$2"
  if [[ -z "${!name:-}" ]]; then
    echo "Info: $name is not set. Using default: $default_value"
  fi
}

check_address() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "$value" =~ ^0x[0-9a-fA-F]{40}$ ]]; then
    echo "Invalid address format for $name: $value"
    exit 1
  fi
}

check_private_key() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "$value" =~ ^(0x)?[0-9a-fA-F]{64}$ ]]; then
    echo "Invalid private key format for $name"
    exit 1
  fi
}

check_url() {
  local name="$1"
  local value="${!name:-}"
  if [[ ! "$value" =~ ^https?:// ]]; then
    echo "Invalid URL format for $name: $value"
    exit 1
  fi
}

if [[ "$MODE" == "api" ]]; then
  require_var DATABASE_URL
  warn_default API_HOST "0.0.0.0"
  warn_default API_PORT "8787"

  if [[ -n "${API_PORT:-}" ]] && [[ ! "${API_PORT}" =~ ^[0-9]+$ ]]; then
    echo "Invalid numeric value for API_PORT: $API_PORT"
    exit 1
  fi

  if is_true "${MARKET_ENABLED:-false}"; then
    require_var MARKET_RPC_URL
    require_var MARKET_CONTRACT_ADDRESS
    require_var MARKET_OPERATOR_PRIVATE_KEY
    check_url MARKET_RPC_URL
    check_address MARKET_CONTRACT_ADDRESS
    check_private_key MARKET_OPERATOR_PRIVATE_KEY
  fi

  local_ai_provider="${AI_PROVIDER:-rules}"
  if [[ "$local_ai_provider" != "rules" && "$local_ai_provider" != "openrouter" ]]; then
    echo "Invalid AI_PROVIDER: $local_ai_provider (allowed: rules|openrouter)"
    exit 1
  fi

  if [[ "$local_ai_provider" == "openrouter" ]]; then
    require_var OPENROUTER_API_KEY
    require_var OPENROUTER_MODEL
    if [[ -n "${OPENROUTER_BASE_URL:-}" ]]; then
      check_url OPENROUTER_BASE_URL
    else
      echo "Info: OPENROUTER_BASE_URL is not set. Using default: https://openrouter.ai/api/v1"
    fi
  fi

  echo "API environment check passed."
  exit 0
fi

if [[ "$MODE" == "web" ]]; then
  require_var VITE_GAME_MODE
  require_var VITE_API_BASE_URL

  if is_true "${VITE_CHAIN_MARKET_ENABLED:-false}"; then
    require_var VITE_MARKET_CHAIN_ID
    require_var VITE_MARKET_CONTRACT_ADDRESS
    check_address VITE_MARKET_CONTRACT_ADDRESS
  fi

  echo "Web environment check passed."
  exit 0
fi

echo "Unknown mode: $MODE"
echo "Usage: $0 <api|web>"
exit 1
