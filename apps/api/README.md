# API Service

Authoritative game service for Tactical Terminal.

## Setup

1. Copy env file:
   - `cp apps/api/.env.example apps/api/.env`
2. Fill `DATABASE_URL` with your Neon Postgres connection string.
3. Optional market integration (`cast` required on server host):
   - `MARKET_ENABLED=true`
   - `MARKET_RPC_URL=...`
   - `MARKET_CONTRACT_ADDRESS=...`
   - `MARKET_OPERATOR_PRIVATE_KEY=...`
   - `MARKET_ROUND_LOCK_SECONDS=180`
   - `MARKET_CHAIN_ID_EXPECTED=11155111`
4. Optional ERC-8004 adapter (`cast` required on server host):
   - `ERC8004_ENABLED=true`
   - `ERC8004_RPC_URL=...`
   - `ERC8004_IDENTITY_CONTRACT=0x...`
   - `ERC8004_CHAIN_ID_EXPECTED=84532` (Base Sepolia default)
   - optional:
     - `ERC8004_AGENT_URI_BASE=https://.../agents`
     - `ERC8004_DISCOVERY_MAX_SCAN=50`
     - `ERC8004_DISCOVERY_CACHE_TTL_SECONDS=3600`
     - `ERC8004_DISCOVERY_FETCH_TIMEOUT_MS=4000`
     - `ERC8004_IPFS_GATEWAY=https://ipfs.io`
5. Optional X402 adapter:
   - `X402_ENABLED=true`
   - `X402_MODE=simulated` (`off` | `simulated` | `strict`)
   - `X402_FACILITATOR_URL=https://facilitator.openx402.ai`
   - `X402_ALLOWED_DOMAINS=conway.tech,api.example.com`
   - `X402_MAX_SINGLE_PAYMENT_CENTS=100`
   - `X402_BUDGET_CENTS=5000`
   - `X402_TIMEOUT_MS=8000`
   - optional:
     - `X402_STATIC_PAYMENT_TOKEN=...` (will be passed as `X-Payment`)
     - `X402_DEMO_INTEL_URL=http://localhost:8787/api/x402/provider/intel`
     - `X402_DEMO_INTEL_METHOD=POST`
6. AI provider (optional, default is local rules engine):
   - `AI_PROVIDER=rules` (default), or `AI_PROVIDER=openrouter`
   - `AI_DEBUG=false` (set `true` to print per-turn AI decision debug logs)
   - `AI_TIMEOUT_MS=1200`
   - `AI_OPENROUTER_MAX_RETRIES=1` (retry count after first failed attempt)
   - `AI_OPENROUTER_RETRY_BASE_DELAY_MS=250` (exponential backoff base delay)
   - `AI_OPENROUTER_COOLDOWN_MS=5000` (temporary cooldown after retryable provider failure)
   - `AI_FALLBACK_RULES=true` (fallback to rules on timeout/parse failure)
   - when `AI_PROVIDER=openrouter`, set:
     - `OPENROUTER_API_KEY=...`
     - `OPENROUTER_MODEL=...` (example: `openai/gpt-4o-mini`)
     - `OPENROUTER_BASE_URL=https://openrouter.ai/api/v1` (optional override)
     - `OPENROUTER_SITE_URL` / `OPENROUTER_APP_NAME` (optional attribution headers)
7. Run migrations:
   - `pnpm --filter @tactical/api run db:migrate`
8. Start dev server:
   - `pnpm --filter @tactical/api run dev`

## Endpoints

- `GET /healthz`
- `POST /api/games`
- `GET /api/games/:gameId`
- `POST /api/games/:gameId/actions`
- `GET /api/games/:gameId/events`
- `GET /api/agents`
- `GET /api/agents/:agentId`
- `GET /api/agents/:agentId/assets/persistent`
- `GET /api/agents/:agentId/respawn`
- `POST /api/agents/:agentId/respawn/request`
- `POST /api/agents/:agentId/respawn/complete`
- `POST /api/a2a-market/listings`
- `GET /api/a2a-market/listings`
- `GET /api/a2a-market/listings/:listingId`
- `POST /api/a2a-market/listings/:listingId/cancel`
- `POST /api/a2a-market/listings/:listingId/buy`
- `POST /api/a2a-market/expire`
- `GET /api/a2a-market/trades`
- `GET /api/a2a-market/listings/:listingId/trade`
- `POST /api/a2a-market/auto/one-shot`
- `GET /api/erc8004/config`
- `POST /api/erc8004/agents/:agentId/sync-uri`
- `GET /api/erc8004/discover`
- `GET /api/x402/config`
- `GET /api/x402/provider/intel`
- `POST /api/x402/provider/intel`
- `POST /api/x402/fetch`
- `POST /api/x402/demo/intel`
- `GET /api/x402/logs`
- `GET /api/audit/overview`
- `GET /api/audit/agent-behaviors`
- `GET /api/audit/payments`
- `GET /api/audit/trades`
- `GET /api/audit/onchain-transactions`
- `GET /api/audit/erc8004-sync`
- `POST /api/markets/open`
- `POST /api/markets/resolve`
- `GET /api/markets/:gameId`
- `WS /ws?gameId=<uuid>`

## Runtime Behavior

- Online mode is authoritative on backend.
- After each accepted player action, backend auto-advances AI turns until:
  - next controllable human turn, or
  - phase leaves `ACTIVE` (`LOOTING` / `GAME_OVER`).
- AI decision flow:
  - `AI_PROVIDER=rules`: use deterministic built-in rules.
  - `AI_PROVIDER=openrouter`: backend sends compact state + legal candidate actions to LLM.
  - LLM must pick `choiceId` from candidates; server validates and maps to action.
  - On timeout/invalid output/provider error, server falls back to rules when `AI_FALLBACK_RULES=true`.
  - OpenRouter failures use retry + backoff, and a short cooldown to avoid repeated timeouts across many AI turns.
- If market integration is enabled:
  - backend auto-opens market round on `POST /api/games` for online mode,
  - backend auto-resolves round on `GAME_OVER` (with retry, when mapping exists),
  - backend persists `game_id <-> round_id` in `game_rounds`,
  - backend tracks `syncStatus` (`open` / `resolved` / `failed`) and `failureReason`.

## API Integration Test Flow (OpenRouter + AI Debug)

1. Configure env (`apps/api/.env`):
   - stable mode (recommended):
     - `AI_PROVIDER=openrouter`
     - `AI_DEBUG=true`
     - `AI_FALLBACK_RULES=true`
     - `AI_TIMEOUT_MS=8000`
     - `AI_OPENROUTER_MAX_RETRIES=1`
     - `AI_OPENROUTER_RETRY_BASE_DELAY_MS=250`
     - `AI_OPENROUTER_COOLDOWN_MS=5000`
     - `OPENROUTER_API_KEY=...`
     - `OPENROUTER_MODEL=openai/gpt-4o-mini`
   - strict mode (for hard validation):
     - `AI_FALLBACK_RULES=false`
2. Start API:
   - `pnpm --filter @tactical/api run dev`
   - expected startup log includes `AI decision config loaded`.
3. Create game:
   - `BASE_URL=http://127.0.0.1:8787`
   - `GAME_RESP=$(curl -sS -X POST "$BASE_URL/api/games" -H "Content-Type: application/json" -d '{"humanCount":1,"aiCount":2,"mode":"online","language":"en"}')`
   - `GAME_ID=$(echo "$GAME_RESP" | jq -r '.gameId')`
4. Activate gameplay phase (`SETUP -> ACTIVE`):
   - `curl -sS -X POST "$BASE_URL/api/games/$GAME_ID/actions" -H "Content-Type: application/json" -d '{"action":{"type":"INIT_AGENT","payload":{"systemPrompt":"debug","apiKey":"dummy"}}}' | jq '.state.phase,.seq'`
   - expected: `"ACTIVE"`.
5. Trigger AI auto-advance with a human action:
   - `STATE=$(curl -sS "$BASE_URL/api/games/$GAME_ID")`
   - `HUMAN_ID=$(echo "$STATE" | jq -r '.state.players[] | select(.isAi==false) | .id')`
   - `curl -sS -X POST "$BASE_URL/api/games/$GAME_ID/actions" -H "Content-Type: application/json" -d "{\"action\":{\"type\":\"SKIP_TURN\",\"payload\":{\"playerId\":\"$HUMAN_ID\"}}}" | jq '{error, appliedActions: (.appliedActions // [])}'`
   - expected: `appliedActions` contains both `client` and `server` sources when AI runs.
6. Check backend logs:
   - success example: `[ai-debug] {"event":"decision.openrouter.success", ...}`
   - fallback example: `[ai-debug] {"event":"decision.openrouter.fallback_rules", ...}`
   - strict mode timeout example: `[ai-debug] {"event":"decision.openrouter.failed", ...}` and request returns error.

Notes:
- `ai-debug` logs only appear when AI decision path is actually executed.
- If strict mode returns error, `appliedActions` can be `null`; use the jq command above to avoid parsing failure.
