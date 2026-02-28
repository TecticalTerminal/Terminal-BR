import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';

export type GameRoundSyncStatus = 'open' | 'resolved' | 'failed';

export interface GameRoundMapping {
  gameId: string;
  gameIdHash: string;
  roundId: string;
  marketAddress: string;
  chainId: number | null;
  openTxHash: string | null;
  resolveTxHash: string | null;
  winnerOutcomeHash: string | null;
  resolvedAt: string | null;
  syncStatus: GameRoundSyncStatus;
  failureReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PendingRoundResolveCandidate {
  gameId: string;
  winnerPlayerId: string | null;
  roundId: string;
  syncStatus: GameRoundSyncStatus;
  updatedAt: string;
}

function mapRow(row: {
  game_id: string;
  game_id_hash: string;
  round_id: string | number | bigint;
  market_address: string;
  chain_id: string | number | null;
  open_tx_hash: string | null;
  resolve_tx_hash: string | null;
  winner_outcome_hash: string | null;
  resolved_at: string | Date | null;
  sync_status: string;
  failure_reason: string | null;
  created_at: string | Date;
  updated_at: string | Date;
}): GameRoundMapping {
  return {
    gameId: row.game_id,
    gameIdHash: row.game_id_hash,
    roundId: String(row.round_id),
    marketAddress: row.market_address,
    chainId: row.chain_id === null ? null : Number(row.chain_id),
    openTxHash: row.open_tx_hash,
    resolveTxHash: row.resolve_tx_hash,
    winnerOutcomeHash: row.winner_outcome_hash,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    syncStatus: row.sync_status as GameRoundSyncStatus,
    failureReason: row.failure_reason,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

export async function getGameRoundMapping(gameId: string): Promise<GameRoundMapping | null> {
  const result = await pool.query(
    `SELECT game_id,
            game_id_hash,
            round_id,
            market_address,
            chain_id,
            open_tx_hash,
            resolve_tx_hash,
            winner_outcome_hash,
            resolved_at,
            sync_status,
            failure_reason,
            created_at,
            updated_at
     FROM game_rounds
     WHERE game_id = $1`,
    [gameId]
  );

  if (!result.rowCount) return null;
  return mapRow(result.rows[0]);
}

export async function createOrUpdateRoundOpened(input: {
  gameId: string;
  gameIdHash: string;
  roundId: string;
  marketAddress: string;
  chainId: number | null;
  openTxHash: string | null;
}): Promise<GameRoundMapping> {
  const result = await pool.query(
    `INSERT INTO game_rounds (
       game_id,
       game_id_hash,
       round_id,
       market_address,
       chain_id,
       open_tx_hash,
       sync_status,
       failure_reason,
       updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, 'open', NULL, NOW())
     ON CONFLICT (game_id)
     DO UPDATE SET
       game_id_hash = EXCLUDED.game_id_hash,
       round_id = EXCLUDED.round_id,
       market_address = EXCLUDED.market_address,
       chain_id = EXCLUDED.chain_id,
       open_tx_hash = COALESCE(EXCLUDED.open_tx_hash, game_rounds.open_tx_hash),
       sync_status = 'open',
       failure_reason = NULL,
       updated_at = NOW()
     RETURNING game_id,
               game_id_hash,
               round_id,
               market_address,
               chain_id,
               open_tx_hash,
               resolve_tx_hash,
               winner_outcome_hash,
               resolved_at,
               sync_status,
               failure_reason,
               created_at,
               updated_at`,
    [
      input.gameId,
      input.gameIdHash,
      input.roundId,
      input.marketAddress,
      input.chainId,
      input.openTxHash
    ]
  );

  return mapRow(result.rows[0]);
}

export async function markRoundResolved(input: {
  gameId: string;
  resolveTxHash: string | null;
  winnerOutcomeHash: string;
}): Promise<GameRoundMapping> {
  const result = await pool.query(
    `UPDATE game_rounds
     SET resolve_tx_hash = COALESCE($2, resolve_tx_hash),
         winner_outcome_hash = $3,
         resolved_at = COALESCE(resolved_at, NOW()),
         sync_status = 'resolved',
         failure_reason = NULL,
         updated_at = NOW()
     WHERE game_id = $1
     RETURNING game_id,
               game_id_hash,
               round_id,
               market_address,
               chain_id,
               open_tx_hash,
               resolve_tx_hash,
               winner_outcome_hash,
               resolved_at,
               sync_status,
               failure_reason,
               created_at,
               updated_at`,
    [input.gameId, input.resolveTxHash, input.winnerOutcomeHash]
  );

  if (!result.rowCount) {
    throw new HttpError(404, `Round mapping not found for game: ${input.gameId}`);
  }

  return mapRow(result.rows[0]);
}

export async function markRoundFailed(input: {
  gameId: string;
  failureReason: string;
}): Promise<GameRoundMapping | null> {
  const result = await pool.query(
    `UPDATE game_rounds
     SET sync_status = 'failed',
         failure_reason = LEFT($2, 2000),
         updated_at = NOW()
     WHERE game_id = $1
       AND sync_status <> 'resolved'
     RETURNING game_id,
               game_id_hash,
               round_id,
               market_address,
               chain_id,
               open_tx_hash,
               resolve_tx_hash,
               winner_outcome_hash,
               resolved_at,
               sync_status,
               failure_reason,
               created_at,
               updated_at`,
    [input.gameId, input.failureReason]
  );

  if (!result.rowCount) return null;
  return mapRow(result.rows[0]);
}

export async function listPendingRoundResolveCandidates(
  limit: number
): Promise<PendingRoundResolveCandidate[]> {
  const safeLimit = Number.isFinite(limit) && limit > 0 ? Math.min(Math.floor(limit), 500) : 50;
  const result = await pool.query<{
    game_id: string;
    winner_player_id: string | null;
    round_id: string | number | bigint;
    sync_status: string;
    updated_at: string | Date;
  }>(
    `
      SELECT
        gr.game_id,
        g.winner_player_id,
        gr.round_id,
        gr.sync_status,
        gr.updated_at
      FROM game_rounds gr
      JOIN games g ON g.id = gr.game_id
      WHERE g.status = 'game_over'
        AND g.winner_player_id IS NOT NULL
        AND gr.resolved_at IS NULL
        AND gr.sync_status IN ('open', 'failed')
      ORDER BY gr.updated_at ASC
      LIMIT $1
    `,
    [safeLimit]
  );

  return result.rows.map((row) => ({
    gameId: row.game_id,
    winnerPlayerId: row.winner_player_id,
    roundId: String(row.round_id),
    syncStatus: row.sync_status as GameRoundSyncStatus,
    updatedAt: new Date(row.updated_at).toISOString()
  }));
}
