import { gameReducer, generateInitialState } from '@tactical/game-engine';
import type { AgentSnapshot, GameAction, GameState, Language, Player } from '@tactical/shared-types';
import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { transitionAgentStatusTx } from '../agents/repository.js';
import { appendAgentBehaviorLogTx } from '../audit/repository.js';
import { createAiDecisionService } from '../ai/decision-service.js';
import { pool } from '../db/pool.js';
import { hashState } from '../utils/hash.js';
import { HttpError } from '../utils/http-error.js';

type DbGameStatus = 'created' | 'active' | 'game_over' | 'archived';

export interface GameView {
  gameId: string;
  seq: number;
  state: GameState;
  status: DbGameStatus;
  updatedAt: string;
}

export interface GameEventRow {
  seq: number;
  actionType: string;
  actionPayload: unknown;
  stateHash: string;
  createdAt: string;
}

export interface ActionApplyResult {
  accepted: true;
  gameId: string;
  seq: number;
  state: GameState;
  stateHash: string;
  idempotent: boolean;
  appliedActions: {
    seq: number;
    action: GameAction;
    stateHash: string;
    source: 'client' | 'server';
  }[];
}

const aiDecisionService = createAiDecisionService();
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const roundSettlementConfig = {
  inventoryItemCredits: 10n,
  survivalBonusCredits: 50n,
  winnerBonusCredits: 100n,
  marketCarryRatioBps: 1000n // 10%
};

function getManagedAgentIdFromPlayer(player: Player): string | null {
  const candidate = player.agent?.agentId ?? player.id;
  return uuidRegex.test(candidate) ? candidate : null;
}

function extractActorManagedAgentId(action: GameAction): string | null {
  let candidate: string | undefined;
  switch (action.type) {
    case 'MOVE':
    case 'SEARCH':
    case 'TAKE_LOOT':
    case 'USE_ITEM':
    case 'EQUIP_ITEM':
    case 'DROP_ITEM':
    case 'PICKUP_ITEM':
    case 'SKIP_TURN':
    case 'MARKET_BUY':
      candidate = action.payload.playerId;
      break;
    case 'ATTACK':
      candidate = action.payload.attackerId;
      break;
    default:
      candidate = undefined;
      break;
  }
  if (!candidate || !uuidRegex.test(candidate)) return null;
  return candidate;
}

function extractActorPlayerId(action: GameAction): string | null {
  switch (action.type) {
    case 'MOVE':
    case 'SEARCH':
    case 'TAKE_LOOT':
    case 'USE_ITEM':
    case 'EQUIP_ITEM':
    case 'DROP_ITEM':
    case 'PICKUP_ITEM':
    case 'SKIP_TURN':
    case 'MARKET_BUY':
      return action.payload.playerId;
    case 'ATTACK':
      return action.payload.attackerId;
    default:
      return null;
  }
}

function assertManagedHumanActionAllowed(state: GameState, action: GameAction): void {
  if ((state.aiConfig?.humanControlMode ?? 'manual') !== 'managed') return;
  const human = state.players.find((player) => !player.isAi);
  if (!human) return;

  if (action.type === 'INIT_AGENT') return;

  if (action.type === 'NEXT_TURN' || action.type === 'DISCARD_LOOT') {
    throw new HttpError(409, `Action ${action.type} is blocked when humanControlMode=managed.`);
  }

  const actorId = extractActorPlayerId(action);
  if (actorId !== human.id) return;
  if (action.type !== 'SKIP_TURN' && action.type !== 'MARKET_BUY') {
    throw new HttpError(
      409,
      `Human manual action ${action.type} is blocked when humanControlMode=managed.`
    );
  }
}

async function maybeReplaceManagedHumanSkipWithAiAction(
  state: GameState,
  action: GameAction
): Promise<GameAction> {
  if ((state.aiConfig?.humanControlMode ?? 'manual') !== 'managed') return action;
  if (state.phase !== 'ACTIVE') return action;
  if (action.type !== 'SKIP_TURN') return action;

  const human = state.players.find((player) => !player.isAi);
  if (!human || human.status !== 'ALIVE') return action;
  if (action.payload.playerId !== human.id) return action;

  const activePlayer = state.players[state.activePlayerIndex];
  if (!activePlayer || activePlayer.id !== human.id) return action;

  return aiDecisionService.decide(state, human.id);
}

function collectNewlyDeadManagedAgentIds(previous: GameState, next: GameState): string[] {
  const previousDead = new Set<string>();
  for (const player of previous.players) {
    const managedAgentId = getManagedAgentIdFromPlayer(player);
    if (!managedAgentId) continue;
    if (player.status === 'DEAD') {
      previousDead.add(managedAgentId);
    }
  }

  const newlyDead = new Set<string>();
  for (const player of next.players) {
    const managedAgentId = getManagedAgentIdFromPlayer(player);
    if (!managedAgentId) continue;
    if (player.status === 'DEAD' && !previousDead.has(managedAgentId)) {
      newlyDead.add(managedAgentId);
    }
  }
  return [...newlyDead];
}

async function latestPersistentCreditsBalanceTx(client: PoolClient, agentId: string): Promise<bigint> {
  const result = await client.query<{ balance_after: string | number }>(
    `
      SELECT balance_after
      FROM agent_asset_ledger
      WHERE agent_id = $1
        AND scope = 'persistent'
        AND asset_type = 'currency'
        AND asset_id = 'credits'
      ORDER BY id DESC
      LIMIT 1
    `,
    [agentId]
  );
  if (!result.rowCount) return 0n;
  return BigInt(String(result.rows[0].balance_after));
}

async function settledPersistentCreditsAgentIdsTx(
  client: PoolClient,
  gameId: string
): Promise<Set<string>> {
  const result = await client.query<{ agent_id: string }>(
    `
      SELECT agent_id
      FROM agent_asset_ledger
      WHERE game_id = $1
        AND scope = 'persistent'
        AND asset_type = 'currency'
        AND asset_id = 'credits'
        AND reason = 'round_settlement'
    `,
    [gameId]
  );
  return new Set(result.rows.map((row) => row.agent_id));
}

function computeSettlementCredits(state: GameState, player: Player): bigint {
  let credits = BigInt(player.inventory.length) * roundSettlementConfig.inventoryItemCredits;
  if (player.status === 'ALIVE') {
    credits += roundSettlementConfig.survivalBonusCredits;
  }
  if (state.winner?.id === player.id) {
    credits += roundSettlementConfig.winnerBonusCredits;
  }

  const marketValue = Math.max(0, Math.floor(player.market.sharesOwned * player.market.price));
  const marketCarry =
    (BigInt(marketValue) * roundSettlementConfig.marketCarryRatioBps) / 10_000n;
  credits += marketCarry;
  return credits;
}

async function settleRoundAssetsToPersistentTx(
  client: PoolClient,
  gameId: string,
  state: GameState
): Promise<void> {
  if (state.phase !== 'GAME_OVER') return;
  const settledAgentIds = await settledPersistentCreditsAgentIdsTx(client, gameId);

  for (const player of state.players) {
    const agentId = getManagedAgentIdFromPlayer(player);
    if (!agentId) continue;
    if (settledAgentIds.has(agentId)) continue;

    const delta = computeSettlementCredits(state, player);
    if (delta <= 0n) continue;

    const currentBalance = await latestPersistentCreditsBalanceTx(client, agentId);
    const nextBalance = currentBalance + delta;
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
        ) VALUES ($1, $2, 'persistent', 'currency', 'credits', $3, $4, 'round_settlement', 'game', $5)
      `,
      [agentId, gameId, delta.toString(), nextBalance.toString(), gameId]
    );
    settledAgentIds.add(agentId);
  }
}

function mapPhaseToStatus(phase: GameState['phase']): DbGameStatus {
  if (phase === 'GAME_OVER') return 'game_over';
  return 'active';
}

function mapGameRow(row: {
  id: string;
  seq: string | number;
  state_json: GameState;
  status: DbGameStatus;
  updated_at: string | Date;
}): GameView {
  return {
    gameId: row.id,
    seq: Number(row.seq),
    state: row.state_json,
    status: row.status,
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

interface RegistrySnapshotRow {
  id: string;
  kind: 'user' | 'bot';
  display_name: string;
  prompt_default: string;
  prompt_override: string | null;
  address: string | null;
}

interface SnapshotStartValidationRow {
  id: string;
  kind: 'user' | 'bot';
  status: 'active' | 'dead' | 'respawning';
  custody_mode: 'server_managed' | 'external_signer' | null;
  wallet_address: string | null;
  encrypted_private_key: string | null;
}

function asRecord(input: unknown): Record<string, unknown> | null {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return null;
}

async function latestPersistentCurrencyMapByAgentIdsTx(
  client: PoolClient,
  agentIds: string[]
): Promise<Map<string, Record<string, string>>> {
  if (!agentIds.length) return new Map();
  const result = await client.query<{
    agent_id: string;
    asset_id: string;
    balance_after: string | number;
  }>(
    `
      SELECT DISTINCT ON (agent_id, asset_id)
        agent_id,
        asset_id,
        balance_after
      FROM agent_asset_ledger
      WHERE agent_id = ANY($1::uuid[])
        AND scope = 'persistent'
        AND asset_type = 'currency'
      ORDER BY agent_id, asset_id, id DESC
    `,
    [agentIds]
  );

  const map = new Map<string, Record<string, string>>();
  for (const row of result.rows) {
    const existing = map.get(row.agent_id) ?? {};
    existing[row.asset_id] = String(row.balance_after);
    map.set(row.agent_id, existing);
  }
  return map;
}

async function hydrateSnapshotsWithPersistentAssetsTx(
  client: PoolClient,
  snapshots: AgentSnapshot[] | undefined
): Promise<AgentSnapshot[] | undefined> {
  if (!snapshots?.length) return snapshots;
  const managedAgentIds = snapshots
    .map((snapshot) => snapshot.agentId)
    .filter((agentId) => uuidRegex.test(agentId));
  if (!managedAgentIds.length) return snapshots;

  const persistentCurrencyByAgent =
    await latestPersistentCurrencyMapByAgentIdsTx(client, managedAgentIds);

  return snapshots.map((snapshot) => {
    const persistentCurrency = persistentCurrencyByAgent.get(snapshot.agentId);
    if (!persistentCurrency || Object.keys(persistentCurrency).length === 0) {
      return snapshot;
    }

    const baseAssets = asRecord(snapshot.persistentAssets) ?? {};
    const baseCurrency = asRecord(baseAssets.currency) ?? {};

    return {
      ...snapshot,
      persistentAssets: {
        ...baseAssets,
        currency: {
          ...baseCurrency,
          ...persistentCurrency
        }
      }
    };
  });
}

async function loadAgentSnapshotsFromRegistry(
  client: PoolClient,
  humanCount: number,
  aiCount: number
): Promise<AgentSnapshot[] | null> {
  const result = await client.query(
    `
      SELECT
        a.id,
        a.kind,
        p.display_name,
        p.prompt_default,
        p.prompt_override,
        w.address
      FROM agent a
      INNER JOIN agent_profile p ON p.agent_id = a.id
      LEFT JOIN agent_wallet w ON w.agent_id = a.id
      WHERE a.is_enabled = TRUE
        AND a.status = 'active'
      ORDER BY a.created_at ASC
    `
  );

  const users = result.rows.filter((row) => row.kind === 'user') as RegistrySnapshotRow[];
  const bots = result.rows.filter((row) => row.kind === 'bot') as RegistrySnapshotRow[];
  if (users.length < humanCount || bots.length < aiCount) {
    return null;
  }

  const pickRows = [...users.slice(0, humanCount), ...bots.slice(0, aiCount)];
  return pickRows.map((row) => ({
    agentId: row.id,
    kind: row.kind,
    displayName: row.display_name,
    accountIdentifier: row.address ? `wallet:${row.address.toLowerCase()}` : `agent:${row.id}`,
    walletAddress: row.address,
    prompt: row.prompt_override ?? row.prompt_default
  }));
}

async function assertSnapshotsCanStartGame(
  client: PoolClient,
  snapshots: AgentSnapshot[] | undefined
): Promise<void> {
  if (!snapshots?.length) return;
  const managedSnapshots = snapshots.filter((snapshot) => uuidRegex.test(snapshot.agentId));
  const managedAgentIds = managedSnapshots.map((snapshot) => snapshot.agentId);
  if (!managedAgentIds.length) return;
  const snapshotById = new Map(managedSnapshots.map((snapshot) => [snapshot.agentId, snapshot]));

  const result = await client.query<SnapshotStartValidationRow>(
    `
      SELECT
        a.id,
        a.kind,
        a.status,
        w.custody_mode,
        w.address AS wallet_address,
        w.encrypted_private_key
      FROM agent a
      LEFT JOIN agent_wallet w ON w.agent_id = a.id
      WHERE a.id = ANY($1::uuid[])
    `,
    [managedAgentIds]
  );

  const foundIds = new Set(result.rows.map((row) => row.id));
  const missingIds = managedAgentIds.filter((id) => !foundIds.has(id));
  if (missingIds.length) {
    throw new HttpError(404, `Some agents are missing in registry: ${missingIds.join(', ')}`);
  }

  const blocked = result.rows.filter((row) => row.status !== 'active');
  if (blocked.length) {
    const detail = blocked.map((row) => `${row.id}:${row.status}`).join(', ');
    throw new HttpError(409, `Some agents are not ACTIVE and cannot enter game: ${detail}`);
  }

  for (const row of result.rows) {
    const snapshot = snapshotById.get(row.id);
    if (!snapshot) continue;

    if (snapshot.kind !== row.kind) {
      throw new HttpError(
        409,
        `Snapshot kind mismatch. agent=${row.id} snapshotKind=${snapshot.kind} registryKind=${row.kind}`
      );
    }

    const expectedCustody = row.kind === 'user' ? 'external_signer' : 'server_managed';
    if (row.custody_mode !== expectedCustody) {
      throw new HttpError(
        409,
        `Mixed custody violation. agent=${row.id} kind=${row.kind} expected=${expectedCustody} actual=${row.custody_mode ?? 'none'}`
      );
    }

    if (!row.wallet_address) {
      throw new HttpError(409, `Agent wallet address missing. agent=${row.id}`);
    }

    if (row.kind === 'bot' && !row.encrypted_private_key) {
      throw new HttpError(409, `Managed bot wallet key missing. agent=${row.id}`);
    }

    if (
      snapshot.walletAddress &&
      snapshot.walletAddress.toLowerCase() !== row.wallet_address.toLowerCase()
    ) {
      throw new HttpError(
        409,
        `Snapshot wallet mismatch. agent=${row.id} snapshot=${snapshot.walletAddress} registry=${row.wallet_address}`
      );
    }
  }
}

export async function createGame(input: {
  humanCount: number;
  aiCount: number;
  mode: string;
  language?: Language;
  agentSnapshots?: AgentSnapshot[];
}): Promise<GameView> {
  const gameId = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const registrySnapshots =
      input.agentSnapshots?.length === undefined || input.agentSnapshots.length === 0
        ? await loadAgentSnapshotsFromRegistry(client, input.humanCount, input.aiCount)
        : null;
    const chosenSnapshots =
      input.agentSnapshots && input.agentSnapshots.length > 0
        ? input.agentSnapshots
        : registrySnapshots ?? undefined;
    const hydratedSnapshots = await hydrateSnapshotsWithPersistentAssetsTx(client, chosenSnapshots);
    await assertSnapshotsCanStartGame(client, hydratedSnapshots);
    const snapshotHumanCount = hydratedSnapshots
      ? hydratedSnapshots.filter((snapshot) => snapshot.kind === 'user').length
      : input.humanCount;
    const snapshotAiCount = hydratedSnapshots
      ? hydratedSnapshots.filter((snapshot) => snapshot.kind === 'bot').length
      : input.aiCount;
    const agentSnapshotSource =
      input.agentSnapshots?.length ? 'request' : registrySnapshots ? 'registry' : 'fallback';

    const state = generateInitialState(snapshotHumanCount, snapshotAiCount, hydratedSnapshots);
    if (input.language) {
      state.language = input.language;
    }
    const stateHash = hashState(state);

    const gameResult = await client.query(
      `INSERT INTO games (id, status, seq, mode, state_json)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, status, seq, state_json, updated_at`,
      [gameId, 'active', 0, input.mode, JSON.stringify(state)]
    );

    await client.query(
      `INSERT INTO game_events (game_id, seq, action_type, action_payload, state_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        gameId,
        0,
        'GAME_CREATED',
        JSON.stringify({
          ...input,
          agentSnapshots: hydratedSnapshots ?? null,
          agentSnapshotSource
        }),
        stateHash
      ]
    );

    if (hydratedSnapshots?.length) {
      for (const [index, snapshot] of hydratedSnapshots.entries()) {
        if (!uuidRegex.test(snapshot.agentId)) continue;
        await appendAgentBehaviorLogTx(client, {
          agentId: snapshot.agentId,
          gameId,
          eventSource: 'system',
          eventType: 'game_created',
          eventStatus: 'created',
          refType: 'game',
          refId: gameId,
          payload: {
            slot: index,
            kind: snapshot.kind,
            displayName: snapshot.displayName,
            agentSnapshotSource
          }
        });
      }
    }

    await client.query('COMMIT');
    return mapGameRow(gameResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getGame(gameId: string): Promise<GameView> {
  const result = await pool.query(
    `SELECT id, status, seq, state_json, updated_at
     FROM games
     WHERE id = $1`,
    [gameId]
  );

  if (!result.rowCount) {
    throw new HttpError(404, `Game not found: ${gameId}`);
  }

  return mapGameRow(result.rows[0]);
}

export async function listEvents(input: {
  gameId: string;
  fromSeq: number;
  limit: number;
}): Promise<{ events: GameEventRow[]; nextSeq: number }> {
  const result = await pool.query(
    `SELECT seq, action_type, action_payload, state_hash, created_at
     FROM game_events
     WHERE game_id = $1 AND seq >= $2
     ORDER BY seq ASC
     LIMIT $3`,
    [input.gameId, input.fromSeq, input.limit]
  );

  const events: GameEventRow[] = result.rows.map((row) => ({
    seq: Number(row.seq),
    actionType: row.action_type,
    actionPayload: row.action_payload,
    stateHash: row.state_hash,
    createdAt: new Date(row.created_at).toISOString()
  }));

  const nextSeq = events.length > 0 ? events[events.length - 1].seq + 1 : input.fromSeq;
  return { events, nextSeq };
}

async function getGameForUpdate(client: PoolClient, gameId: string) {
  const result = await client.query(
    `SELECT id, status, seq, state_json
     FROM games
     WHERE id = $1
     FOR UPDATE`,
    [gameId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, `Game not found: ${gameId}`);
  }
  return result.rows[0];
}

async function autoAdvanceWithServerAi(state: GameState, maxSteps = 256): Promise<GameAction[]> {
  const actions: GameAction[] = [];
  let currentState = state;

  for (let step = 0; step < maxSteps; step++) {
    if (currentState.phase !== 'ACTIVE') break;

    if (currentState.players.length === 0) break;
    if (currentState.activePlayerIndex >= currentState.players.length) {
      const action: GameAction = { type: 'NEXT_TURN' };
      actions.push(action);
      currentState = gameReducer(currentState, action);
      continue;
    }

    const activePlayer = currentState.players[currentState.activePlayerIndex];
    if (!activePlayer) break;

    if (activePlayer.status !== 'ALIVE') {
      const action: GameAction = {
        type: 'SKIP_TURN',
        payload: { playerId: activePlayer.id }
      };
      actions.push(action);
      currentState = gameReducer(currentState, action);
      continue;
    }

    if (!activePlayer.isAi) {
      break;
    }

    const aiAction = await aiDecisionService.decide(currentState, activePlayer.id);
    actions.push(aiAction);
    currentState = gameReducer(currentState, aiAction);
  }

  return actions;
}

export async function applyAction(input: {
  gameId: string;
  action: GameAction;
  expectedSeq?: number;
  clientActionId?: string;
}): Promise<ActionApplyResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    if (input.clientActionId) {
      const existing = await client.query(
        `SELECT response_json
         FROM game_idempotency
         WHERE game_id = $1 AND client_action_id = $2`,
        [input.gameId, input.clientActionId]
      );
      if (existing.rowCount && existing.rows[0]?.response_json) {
        await client.query('COMMIT');
        return {
          ...(existing.rows[0].response_json as ActionApplyResult),
          idempotent: true
        };
      }
    }

    const gameRow = await getGameForUpdate(client, input.gameId);
    const currentSeq = Number(gameRow.seq);
    if (gameRow.status === 'game_over') {
      throw new HttpError(409, 'Game is already over.');
    }

    if (input.expectedSeq !== undefined && input.expectedSeq !== currentSeq) {
      throw new HttpError(
        409,
        `Sequence mismatch. expected=${input.expectedSeq}, current=${currentSeq}`
      );
    }

    const currentState = gameRow.state_json as GameState;
    assertManagedHumanActionAllowed(currentState, input.action);
    const effectiveClientAction = await maybeReplaceManagedHumanSkipWithAiAction(
      currentState,
      input.action
    );
    const appliedActions: ActionApplyResult['appliedActions'] = [];
    const appendActionBehaviorLog = async (
      action: GameAction,
      seq: number,
      source: 'client' | 'server'
    ): Promise<void> => {
      const actorAgentId = extractActorManagedAgentId(action);
      if (!actorAgentId) return;
      await appendAgentBehaviorLogTx(client, {
        agentId: actorAgentId,
        gameId: input.gameId,
        seq,
        actionType: action.type,
        eventSource: 'game_action',
        eventType: action.type.toLowerCase(),
        eventStatus: 'applied',
        refType: 'game_action',
        refId: `${input.gameId}:${seq}`,
        payload: {
          source,
          action
        }
      });
    };

    let workingState = gameReducer(currentState, effectiveClientAction);
    let workingSeq = currentSeq + 1;
    let workingHash = hashState(workingState);

    await client.query(
      `INSERT INTO game_events (game_id, seq, action_type, action_payload, state_hash)
       VALUES ($1, $2, $3, $4, $5)`,
      [input.gameId, workingSeq, effectiveClientAction.type, JSON.stringify(effectiveClientAction), workingHash]
    );
    appliedActions.push({
      seq: workingSeq,
      action: effectiveClientAction,
      stateHash: workingHash,
      source: 'client'
    });
    await appendActionBehaviorLog(effectiveClientAction, workingSeq, 'client');

    const serverActions = await autoAdvanceWithServerAi(workingState);
    for (const serverAction of serverActions) {
      workingState = gameReducer(workingState, serverAction);
      workingSeq += 1;
      workingHash = hashState(workingState);
      await client.query(
        `INSERT INTO game_events (game_id, seq, action_type, action_payload, state_hash)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          input.gameId,
          workingSeq,
          serverAction.type,
          JSON.stringify(serverAction),
          workingHash
        ]
      );
      appliedActions.push({
        seq: workingSeq,
        action: serverAction,
        stateHash: workingHash,
        source: 'server'
      });
      await appendActionBehaviorLog(serverAction, workingSeq, 'server');
    }

    const newlyDeadAgentIds = collectNewlyDeadManagedAgentIds(currentState, workingState);
    for (const agentId of newlyDeadAgentIds) {
      await transitionAgentStatusTx(client, agentId, 'dead', { allowMissing: true });
      await appendAgentBehaviorLogTx(client, {
        agentId,
        gameId: input.gameId,
        seq: workingSeq,
        eventSource: 'lifecycle',
        eventType: 'agent_dead',
        eventStatus: 'applied',
        refType: 'game',
        refId: input.gameId,
        payload: {
          reason: 'gameplay_death'
        }
      });
    }
    await settleRoundAssetsToPersistentTx(client, input.gameId, workingState);

    const nextStatus = mapPhaseToStatus(workingState.phase);
    const winnerPlayerId = workingState.winner?.id ?? null;
    const finalStateHash = nextStatus === 'game_over' ? workingHash : null;

    await client.query(
      `UPDATE games
       SET seq = $2,
           status = $3,
           state_json = $4,
           winner_player_id = $5,
           final_state_hash = $6,
           updated_at = NOW()
       WHERE id = $1`,
      [
        input.gameId,
        workingSeq,
        nextStatus,
        JSON.stringify(workingState),
        winnerPlayerId,
        finalStateHash
      ]
    );

    const response: ActionApplyResult = {
      accepted: true,
      gameId: input.gameId,
      seq: workingSeq,
      state: workingState,
      stateHash: workingHash,
      idempotent: false,
      appliedActions
    };

    if (input.clientActionId) {
      await client.query(
        `INSERT INTO game_idempotency (game_id, client_action_id, response_json)
         VALUES ($1, $2, $3)`,
        [input.gameId, input.clientActionId, JSON.stringify(response)]
      );
    }

    await client.query('COMMIT');
    return response;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
