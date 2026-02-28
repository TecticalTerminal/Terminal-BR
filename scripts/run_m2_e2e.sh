#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${BASE_URL:-http://localhost:8787}"
API_TIMEOUT_SECONDS="${API_TIMEOUT_SECONDS:-20}"
AUTO_BOOTSTRAP_AGENTS="${AUTO_BOOTSTRAP_AGENTS:-1}"
M2_QUANTITY="${M2_QUANTITY:-1}"
M2_UNIT_PRICE="${M2_UNIT_PRICE:-120}"
M2_FEE_BPS="${M2_FEE_BPS:-300}"
M2_BUYER_CREDITS_TARGET="${M2_BUYER_CREDITS_TARGET:-2000}"
M2_FEE_COLLECTOR_AGENT_ID="${M2_FEE_COLLECTOR_AGENT_ID:-00000000-0000-0000-0000-00000000f001}"
M2_ASSET_ID="${M2_ASSET_ID:-}"
M2_SUPPRESS_NODE_WARNINGS="${M2_SUPPRESS_NODE_WARNINGS:-1}"

require_cmd() {
  local cmd="$1"
  if ! command -v "$cmd" >/dev/null 2>&1; then
    echo "Missing command: $cmd"
    exit 1
  fi
}

require_cmd curl
require_cmd jq
require_cmd node
require_cmd pnpm

run_api_node() {
  if [[ "$M2_SUPPRESS_NODE_WARNINGS" == "1" ]]; then
    NODE_NO_WARNINGS=1 pnpm --filter @tactical/api exec node --input-type=module -
  else
    pnpm --filter @tactical/api exec node --input-type=module -
  fi
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

load_env_value_from_file() {
  local file_path="$1"
  local key="$2"
  if [[ ! -f "$file_path" ]]; then
    return 1
  fi
  awk -F= -v k="$key" '
    $1 == k {
      sub(/^[^=]*=/, "", $0);
      gsub(/\r$/, "", $0);
      print $0;
      exit 0;
    }
  ' "$file_path"
}

resolve_database_url() {
  if [[ -n "${DATABASE_URL:-}" ]]; then
    echo "$DATABASE_URL"
    return
  fi

  local from_env
  from_env="$(load_env_value_from_file "apps/api/.env" "DATABASE_URL" || true)"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return
  fi

  from_env="$(load_env_value_from_file "apps/api/.env.local" "DATABASE_URL" || true)"
  if [[ -n "$from_env" ]]; then
    echo "$from_env"
    return
  fi

  echo ""
}

resolve_asset_id() {
  if [[ -n "$M2_ASSET_ID" ]]; then
    echo "$M2_ASSET_ID"
    return
  fi

  local whitelist
  whitelist="$(load_env_value_from_file "apps/api/.env" "M2_EQUIPMENT_WHITELIST" || true)"
  if [[ -z "$whitelist" ]]; then
    whitelist="$(load_env_value_from_file "apps/api/.env.local" "M2_EQUIPMENT_WHITELIST" || true)"
  fi

  if [[ -n "$whitelist" ]]; then
    echo "$whitelist" | awk -F, '{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $1); print $1}'
    return
  fi

  echo "m2_demo_blade_$(date +%s)"
}

db_get_balance() {
  local database_url="$1"
  local agent_id="$2"
  local asset_type="$3"
  local asset_id="$4"

  DATABASE_URL="$database_url" AGENT_ID="$agent_id" ASSET_TYPE="$asset_type" ASSET_ID="$asset_id" \
    run_api_node <<'NODE'
import pg from 'pg';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
const result = await client.query(
  `
    SELECT balance_after::text AS balance
    FROM agent_asset_ledger
    WHERE agent_id = $1
      AND scope = 'persistent'
      AND asset_type = $2
      AND asset_id = $3
    ORDER BY id DESC
    LIMIT 1
  `,
  [process.env.AGENT_ID, process.env.ASSET_TYPE, process.env.ASSET_ID]
);
await client.end();
process.stdout.write(result.rowCount ? String(result.rows[0].balance) : '0');
NODE
}

db_set_target_balance() {
  local database_url="$1"
  local agent_id="$2"
  local asset_type="$3"
  local asset_id="$4"
  local target_balance="$5"
  local ref_id="$6"

  DATABASE_URL="$database_url" AGENT_ID="$agent_id" ASSET_TYPE="$asset_type" ASSET_ID="$asset_id" TARGET_BALANCE="$target_balance" REF_ID="$ref_id" \
    run_api_node <<'NODE'
import pg from 'pg';

const { Client } = pg;
const client = new Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query('BEGIN');
  const currentRes = await client.query(
    `
      SELECT balance_after::text AS balance
      FROM agent_asset_ledger
      WHERE agent_id = $1
        AND scope = 'persistent'
        AND asset_type = $2
        AND asset_id = $3
      ORDER BY id DESC
      LIMIT 1
    `,
    [process.env.AGENT_ID, process.env.ASSET_TYPE, process.env.ASSET_ID]
  );

  const current = currentRes.rowCount ? BigInt(String(currentRes.rows[0].balance)) : 0n;
  const target = BigInt(process.env.TARGET_BALANCE);
  const delta = target - current;

  if (delta !== 0n) {
    await client.query(
      `
        INSERT INTO agent_asset_ledger (
          agent_id,
          game_id,
          scope,
          asset_type,
          asset_id,
          delta,
          balance_after,
          reason,
          ref_type,
          ref_id
        ) VALUES ($1, NULL, 'persistent', $2, $3, $4, $5, 'admin_adjust', 'script', $6)
      `,
      [
        process.env.AGENT_ID,
        process.env.ASSET_TYPE,
        process.env.ASSET_ID,
        delta.toString(),
        target.toString(),
        process.env.REF_ID
      ]
    );
  }

  await client.query('COMMIT');
  process.stdout.write(JSON.stringify({
    current: current.toString(),
    target: target.toString(),
    delta: delta.toString()
  }));
} catch (error) {
  await client.query('ROLLBACK');
  throw error;
} finally {
  await client.end();
}
NODE
}

create_agent() {
  local kind="$1"
  local suffix="$2"
  local display_name prompt_default
  if [[ "$kind" == "user" ]]; then
    display_name="AUTO_USER_M2_${suffix}"
    prompt_default="You are the human-controlled tactical survivor. Prioritize survival and asset retention."
  else
    display_name="AUTO_BOT_M2_${suffix}"
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
  need_bots=$(( 1 - active_bot_count ))
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

assert_eq() {
  local name="$1"
  local actual="$2"
  local expected="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "ASSERT FAILED: $name expected=$expected actual=$actual"
    exit 1
  fi
}

echo "=== Step18 / M2 E2E ==="
echo "BASE_URL=$BASE_URL"
echo "AUTO_BOOTSTRAP_AGENTS=$AUTO_BOOTSTRAP_AGENTS"

DATABASE_URL_RESOLVED="$(resolve_database_url)"
if [[ -z "$DATABASE_URL_RESOLVED" ]]; then
  echo "DATABASE_URL not found. Export DATABASE_URL or set apps/api/.env."
  exit 1
fi
ASSET_ID_RESOLVED="$(resolve_asset_id)"
if [[ -z "$ASSET_ID_RESOLVED" ]]; then
  echo "M2_ASSET_ID is empty and whitelist could not be resolved."
  exit 1
fi

echo "DATABASE_URL=***"
echo "asset_id=$ASSET_ID_RESOLVED quantity=$M2_QUANTITY unit_price=$M2_UNIT_PRICE fee_bps=$M2_FEE_BPS"

echo "=== 0) health ==="
api_get_json "/healthz" | jq

echo "=== 1) select buyer(user) + seller(bot) from active registry ==="
ensure_active_agent_pool
AGENTS_JSON="$(api_get_json "/api/agents?status=active")"
BUYER_AGENT_ID="$(echo "$AGENTS_JSON" | jq -r '.items[] | select(.kind=="user") | .id' | head -n 1)"
SELLER_AGENT_ID="$(echo "$AGENTS_JSON" | jq -r '.items[] | select(.kind=="bot") | .id' | head -n 1)"
if [[ -z "$BUYER_AGENT_ID" || "$BUYER_AGENT_ID" == "null" ]]; then
  echo "No active user agent found."
  exit 1
fi
if [[ -z "$SELLER_AGENT_ID" || "$SELLER_AGENT_ID" == "null" ]]; then
  echo "No active bot agent found."
  exit 1
fi
if [[ "$BUYER_AGENT_ID" == "$SELLER_AGENT_ID" ]]; then
  echo "Buyer and seller must be different agents."
  exit 1
fi
echo "BUYER_AGENT_ID=$BUYER_AGENT_ID"
echo "SELLER_AGENT_ID=$SELLER_AGENT_ID"

echo "=== 2) seed persistent balances for deterministic trade ==="
SEED_REF_ID="m2-e2e-$(date +%s)"
GROSS_AMOUNT=$(( M2_QUANTITY * M2_UNIT_PRICE ))
if (( GROSS_AMOUNT <= 0 )); then
  echo "Invalid gross amount: $GROSS_AMOUNT"
  exit 1
fi
BUYER_TARGET="$M2_BUYER_CREDITS_TARGET"
if (( BUYER_TARGET < GROSS_AMOUNT + 100 )); then
  BUYER_TARGET=$(( GROSS_AMOUNT + 100 ))
fi
SELLER_EQUIP_TARGET="$M2_QUANTITY"

echo "seeding buyer credits target=$BUYER_TARGET"
db_set_target_balance "$DATABASE_URL_RESOLVED" "$BUYER_AGENT_ID" "currency" "credits" "$BUYER_TARGET" "$SEED_REF_ID" | jq
echo "seeding seller equipment target=$SELLER_EQUIP_TARGET"
db_set_target_balance "$DATABASE_URL_RESOLVED" "$SELLER_AGENT_ID" "equipment" "$ASSET_ID_RESOLVED" "$SELLER_EQUIP_TARGET" "$SEED_REF_ID" | jq

BUYER_CREDITS_BEFORE="$(db_get_balance "$DATABASE_URL_RESOLVED" "$BUYER_AGENT_ID" "currency" "credits")"
SELLER_CREDITS_BEFORE="$(db_get_balance "$DATABASE_URL_RESOLVED" "$SELLER_AGENT_ID" "currency" "credits")"
FEE_COLLECTOR_CREDITS_BEFORE="$(db_get_balance "$DATABASE_URL_RESOLVED" "$M2_FEE_COLLECTOR_AGENT_ID" "currency" "credits")"
BUYER_EQUIP_BEFORE="$(db_get_balance "$DATABASE_URL_RESOLVED" "$BUYER_AGENT_ID" "equipment" "$ASSET_ID_RESOLVED")"
SELLER_EQUIP_BEFORE="$(db_get_balance "$DATABASE_URL_RESOLVED" "$SELLER_AGENT_ID" "equipment" "$ASSET_ID_RESOLVED")"

echo "BUYER credits before=$BUYER_CREDITS_BEFORE equip_before=$BUYER_EQUIP_BEFORE"
echo "SELLER credits before=$SELLER_CREDITS_BEFORE equip_before=$SELLER_EQUIP_BEFORE"
echo "FEE_COLLECTOR credits before=$FEE_COLLECTOR_CREDITS_BEFORE"

echo "=== 3) create listing ==="
LISTING_PAYLOAD="$(jq -nc \
  --arg sellerAgentId "$SELLER_AGENT_ID" \
  --arg assetId "$ASSET_ID_RESOLVED" \
  --argjson quantity "$M2_QUANTITY" \
  --arg unitPrice "$M2_UNIT_PRICE" \
  --argjson feeBps "$M2_FEE_BPS" \
  '{
    sellerAgentId: $sellerAgentId,
    assetId: $assetId,
    quantity: $quantity,
    unitPrice: $unitPrice,
    feeBps: $feeBps
  }')"
CREATE_LISTING_RESP="$(api_post_json "/api/a2a-market/listings" "$LISTING_PAYLOAD")"
echo "$CREATE_LISTING_RESP" | jq
LISTING_ID="$(echo "$CREATE_LISTING_RESP" | jq -r '.id')"
if [[ -z "$LISTING_ID" || "$LISTING_ID" == "null" ]]; then
  echo "Failed to get listing id."
  exit 1
fi

echo "=== 4) buy listing ==="
BUY_PAYLOAD="$(jq -nc \
  --arg buyerAgentId "$BUYER_AGENT_ID" \
  --arg txRef "m2-e2e-buy-$(date +%s)" \
  '{ buyerAgentId: $buyerAgentId, txRef: $txRef }')"
BUY_RESP="$(api_post_json "/api/a2a-market/listings/${LISTING_ID}/buy" "$BUY_PAYLOAD")"
echo "$BUY_RESP" | jq

TRADE_ID="$(echo "$BUY_RESP" | jq -r '.trade.id')"
TRADE_GROSS="$(echo "$BUY_RESP" | jq -r '.trade.grossAmount')"
TRADE_FEE="$(echo "$BUY_RESP" | jq -r '.trade.feeAmount')"
TRADE_NET="$(echo "$BUY_RESP" | jq -r '.trade.netAmount')"
LISTING_STATUS_AFTER_BUY="$(echo "$BUY_RESP" | jq -r '.listing.status')"
assert_eq "listing status after buy" "$LISTING_STATUS_AFTER_BUY" "filled"

echo "=== 5) verify settlement + fee accounting ==="
EXPECTED_FEE=$(( GROSS_AMOUNT * M2_FEE_BPS / 10000 ))
EXPECTED_NET=$(( GROSS_AMOUNT - EXPECTED_FEE ))
assert_eq "trade gross" "$TRADE_GROSS" "$GROSS_AMOUNT"
assert_eq "trade fee" "$TRADE_FEE" "$EXPECTED_FEE"
assert_eq "trade net" "$TRADE_NET" "$EXPECTED_NET"

BUYER_CREDITS_AFTER="$(db_get_balance "$DATABASE_URL_RESOLVED" "$BUYER_AGENT_ID" "currency" "credits")"
SELLER_CREDITS_AFTER="$(db_get_balance "$DATABASE_URL_RESOLVED" "$SELLER_AGENT_ID" "currency" "credits")"
FEE_COLLECTOR_CREDITS_AFTER="$(db_get_balance "$DATABASE_URL_RESOLVED" "$M2_FEE_COLLECTOR_AGENT_ID" "currency" "credits")"
BUYER_EQUIP_AFTER="$(db_get_balance "$DATABASE_URL_RESOLVED" "$BUYER_AGENT_ID" "equipment" "$ASSET_ID_RESOLVED")"
SELLER_EQUIP_AFTER="$(db_get_balance "$DATABASE_URL_RESOLVED" "$SELLER_AGENT_ID" "equipment" "$ASSET_ID_RESOLVED")"

EXPECTED_BUYER_CREDITS_AFTER=$(( BUYER_CREDITS_BEFORE - GROSS_AMOUNT ))
EXPECTED_SELLER_CREDITS_AFTER=$(( SELLER_CREDITS_BEFORE + EXPECTED_NET ))
EXPECTED_FEE_COLLECTOR_CREDITS_AFTER=$(( FEE_COLLECTOR_CREDITS_BEFORE + EXPECTED_FEE ))
EXPECTED_BUYER_EQUIP_AFTER=$(( BUYER_EQUIP_BEFORE + M2_QUANTITY ))
EXPECTED_SELLER_EQUIP_AFTER=$(( SELLER_EQUIP_BEFORE - M2_QUANTITY ))

assert_eq "buyer credits after" "$BUYER_CREDITS_AFTER" "$EXPECTED_BUYER_CREDITS_AFTER"
assert_eq "seller credits after" "$SELLER_CREDITS_AFTER" "$EXPECTED_SELLER_CREDITS_AFTER"
assert_eq "fee collector credits after" "$FEE_COLLECTOR_CREDITS_AFTER" "$EXPECTED_FEE_COLLECTOR_CREDITS_AFTER"
assert_eq "buyer equipment after" "$BUYER_EQUIP_AFTER" "$EXPECTED_BUYER_EQUIP_AFTER"
assert_eq "seller equipment after" "$SELLER_EQUIP_AFTER" "$EXPECTED_SELLER_EQUIP_AFTER"

echo "=== 6) verify trade record endpoint ==="
TRADE_BY_LISTING_RESP="$(api_get_json "/api/a2a-market/listings/${LISTING_ID}/trade")"
echo "$TRADE_BY_LISTING_RESP" | jq
assert_eq "trade id by listing" "$(echo "$TRADE_BY_LISTING_RESP" | jq -r '.id')" "$TRADE_ID"

echo "=== Step18 PASSED ==="
echo "listing_id=$LISTING_ID"
echo "trade_id=$TRADE_ID"
echo "buyer=$BUYER_AGENT_ID seller=$SELLER_AGENT_ID fee_collector=$M2_FEE_COLLECTOR_AGENT_ID"
