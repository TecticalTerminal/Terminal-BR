#!/usr/bin/env bash
set -euo pipefail

ENV_FILE="${ENV_FILE:-}"

if [[ -n "$ENV_FILE" ]]; then
  if [[ ! -f "$ENV_FILE" ]]; then
    echo "ENV_FILE not found: $ENV_FILE"
    exit 1
  fi
  set -a
  # shellcheck source=/dev/null
  source "$ENV_FILE"
  set +a
fi

if [[ -z "${DATABASE_URL:-}" ]]; then
  echo "DATABASE_URL is required."
  echo "Usage: DATABASE_URL=... $0"
  echo "   or: ENV_FILE=apps/api/.env $0"
  exit 1
fi

echo "Running migrations for @tactical/api ..."
pnpm --filter @tactical/api run db:migrate
echo "Migrations completed."
