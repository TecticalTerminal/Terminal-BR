import { v4 as uuidv4 } from 'uuid';
import type { PoolClient } from 'pg';
import { env } from '../config.js';
import { appendAgentBehaviorLogTx } from '../audit/repository.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';
import { getAgentById, transitionAgentStatusTx } from './repository.js';

export interface RespawnRecordView {
  id: string;
  agentId: string;
  gameId: string | null;
  deathSeq: string | null;
  feeAmount: string;
  currencyAssetId: string;
  cooldownSeconds: number;
  availableAt: string;
  respawnedAt: string | null;
  status: 'pending' | 'cooling' | 'completed' | 'failed' | 'cancelled';
  paidLedgerId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RequestRespawnInput {
  agentId: string;
  gameId?: string | null;
  deathSeq?: number | null;
  feeAmount?: string;
  currencyAssetId?: string;
  cooldownSeconds?: number;
}

interface RespawnRow {
  id: string;
  agent_id: string;
  game_id: string | null;
  death_seq: string | number | null;
  fee_amount: string | number;
  currency_asset_id: string;
  cooldown_seconds: number;
  available_at: string | Date;
  respawned_at: string | Date | null;
  status: 'pending' | 'cooling' | 'completed' | 'failed' | 'cancelled';
  paid_ledger_id: string | number | null;
  created_at: string | Date;
  updated_at: string | Date;
}

function mapDbError(error: unknown): never {
  const dbError = error as { code?: string; message?: string; constraint?: string };
  if (dbError.code === '23505') {
    throw new HttpError(409, `Unique constraint violation: ${dbError.constraint ?? 'unknown'}`);
  }
  if (dbError.code === '23503') {
    throw new HttpError(409, `Foreign key violation: ${dbError.constraint ?? 'unknown'}`);
  }
  if (dbError.code === '23514') {
    throw new HttpError(400, `Constraint violation: ${dbError.constraint ?? dbError.message ?? ''}`.trim());
  }
  throw error;
}

function mapRespawnRow(row: RespawnRow): RespawnRecordView {
  return {
    id: row.id,
    agentId: row.agent_id,
    gameId: row.game_id,
    deathSeq: row.death_seq === null ? null : String(row.death_seq),
    feeAmount: String(row.fee_amount),
    currencyAssetId: row.currency_asset_id,
    cooldownSeconds: Number(row.cooldown_seconds),
    availableAt: new Date(row.available_at).toISOString(),
    respawnedAt: row.respawned_at ? new Date(row.respawned_at).toISOString() : null,
    status: row.status,
    paidLedgerId: row.paid_ledger_id === null ? null : String(row.paid_ledger_id),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function parseUnsignedBigInt(input: string, field: string): bigint {
  if (!/^\d+$/.test(input)) {
    throw new HttpError(400, `${field} must be an unsigned integer string.`);
  }
  return BigInt(input);
}

async function latestPersistentCurrencyBalanceTx(
  client: PoolClient,
  agentId: string,
  assetId: string
): Promise<bigint> {
  const result = await client.query<{ balance_after: string | number }>(
    `
      SELECT balance_after
      FROM agent_asset_ledger
      WHERE agent_id = $1
        AND scope = 'persistent'
        AND asset_type = 'currency'
        AND asset_id = $2
      ORDER BY id DESC
      LIMIT 1
    `,
    [agentId, assetId]
  );

  if (!result.rowCount) return 0n;
  return BigInt(String(result.rows[0].balance_after));
}

async function getOpenRespawnTx(client: PoolClient, agentId: string): Promise<RespawnRow | null> {
  const result = await client.query<RespawnRow>(
    `
      SELECT
        id,
        agent_id,
        game_id,
        death_seq,
        fee_amount,
        currency_asset_id,
        cooldown_seconds,
        available_at,
        respawned_at,
        status,
        paid_ledger_id,
        created_at,
        updated_at
      FROM respawn_record
      WHERE agent_id = $1
        AND status IN ('pending', 'cooling')
      ORDER BY created_at DESC
      LIMIT 1
      FOR UPDATE
    `,
    [agentId]
  );
  if (!result.rowCount) return null;
  return result.rows[0];
}

export async function getLatestRespawn(agentId: string): Promise<RespawnRecordView | null> {
  const result = await pool.query<RespawnRow>(
    `
      SELECT
        id,
        agent_id,
        game_id,
        death_seq,
        fee_amount,
        currency_asset_id,
        cooldown_seconds,
        available_at,
        respawned_at,
        status,
        paid_ledger_id,
        created_at,
        updated_at
      FROM respawn_record
      WHERE agent_id = $1
      ORDER BY created_at DESC
      LIMIT 1
    `,
    [agentId]
  );
  if (!result.rowCount) return null;
  return mapRespawnRow(result.rows[0]);
}

export async function requestRespawn(input: RequestRespawnInput): Promise<RespawnRecordView> {
  const feeAmount = parseUnsignedBigInt(input.feeAmount ?? env.RESPAWN_FEE_CREDITS, 'feeAmount');
  const cooldownSeconds =
    input.cooldownSeconds === undefined ? env.RESPAWN_COOLDOWN_SECONDS : input.cooldownSeconds;
  if (!Number.isInteger(cooldownSeconds) || cooldownSeconds < 0) {
    throw new HttpError(400, 'cooldownSeconds must be a non-negative integer.');
  }
  const currencyAssetId = (input.currencyAssetId ?? 'credits').trim();
  if (!currencyAssetId) {
    throw new HttpError(400, 'currencyAssetId is required.');
  }

  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const agent = await getAgentById(input.agentId);
    if (agent.status !== 'dead') {
      throw new HttpError(409, `Agent must be DEAD to request respawn. current=${agent.status}`);
    }

    const openRespawn = await getOpenRespawnTx(client, input.agentId);
    if (openRespawn) {
      throw new HttpError(409, `Respawn already in progress: ${openRespawn.id}`);
    }

    const currentBalance = await latestPersistentCurrencyBalanceTx(client, input.agentId, currencyAssetId);
    if (currentBalance < feeAmount) {
      throw new HttpError(
        409,
        `Insufficient ${currencyAssetId} balance for respawn. required=${feeAmount.toString()} balance=${currentBalance.toString()}`
      );
    }

    const respawnId = uuidv4();
    const nextBalance = currentBalance - feeAmount;
    const ledgerResult = await client.query<{ id: string | number }>(
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
        ) VALUES ($1, $2, 'persistent', 'currency', $3, $4, $5, 'respawn_fee', 'respawn', $6)
        RETURNING id
      `,
      [
        input.agentId,
        input.gameId ?? null,
        currencyAssetId,
        (-feeAmount).toString(),
        nextBalance.toString(),
        respawnId
      ]
    );
    const paidLedgerId = String(ledgerResult.rows[0].id);

    await transitionAgentStatusTx(client, input.agentId, 'respawning');

    const respawnResult = await client.query<RespawnRow>(
      `
        INSERT INTO respawn_record (
          id,
          agent_id,
          game_id,
          death_seq,
          fee_amount,
          currency_asset_id,
          cooldown_seconds,
          available_at,
          status,
          paid_ledger_id
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          NOW() + make_interval(secs => $7::int),
          'cooling',
          $8
        )
        RETURNING
          id,
          agent_id,
          game_id,
          death_seq,
          fee_amount,
          currency_asset_id,
          cooldown_seconds,
          available_at,
          respawned_at,
          status,
          paid_ledger_id,
          created_at,
          updated_at
      `,
      [
        respawnId,
        input.agentId,
        input.gameId ?? null,
        input.deathSeq ?? null,
        feeAmount.toString(),
        currencyAssetId,
        cooldownSeconds,
        paidLedgerId
      ]
    );

    await appendAgentBehaviorLogTx(client, {
      agentId: input.agentId,
      gameId: input.gameId ?? null,
      eventSource: 'lifecycle',
      eventType: 'respawn_requested',
      eventStatus: 'created',
      refType: 'respawn',
      refId: respawnId,
      payload: {
        feeAmount: feeAmount.toString(),
        currencyAssetId,
        cooldownSeconds,
        paidLedgerId
      }
    });

    await client.query('COMMIT');
    return mapRespawnRow(respawnResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }
}

export async function completeRespawn(agentId: string): Promise<RespawnRecordView> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const activeRespawn = await getOpenRespawnTx(client, agentId);
    if (!activeRespawn) {
      throw new HttpError(404, `No pending/cooling respawn record for agent: ${agentId}`);
    }

    const now = Date.now();
    const availableAtMs = new Date(activeRespawn.available_at).getTime();
    if (now < availableAtMs) {
      const seconds = Math.ceil((availableAtMs - now) / 1000);
      throw new HttpError(409, `Respawn cooldown not finished. retryAfterSeconds=${seconds}`);
    }

    await transitionAgentStatusTx(client, agentId, 'active');

    const updateResult = await client.query<RespawnRow>(
      `
        UPDATE respawn_record
        SET status = 'completed',
            respawned_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
        RETURNING
          id,
          agent_id,
          game_id,
          death_seq,
          fee_amount,
          currency_asset_id,
          cooldown_seconds,
          available_at,
          respawned_at,
          status,
          paid_ledger_id,
          created_at,
          updated_at
      `,
      [activeRespawn.id]
    );
    if (!updateResult.rowCount) {
      throw new HttpError(500, 'Failed to complete respawn.');
    }

    await appendAgentBehaviorLogTx(client, {
      agentId,
      gameId: updateResult.rows[0].game_id,
      eventSource: 'lifecycle',
      eventType: 'respawn_completed',
      eventStatus: 'completed',
      refType: 'respawn',
      refId: activeRespawn.id,
      payload: {
        cooldownSeconds: updateResult.rows[0].cooldown_seconds
      }
    });

    await client.query('COMMIT');
    return mapRespawnRow(updateResult.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }
}
