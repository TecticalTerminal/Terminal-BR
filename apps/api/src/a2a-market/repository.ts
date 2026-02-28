import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { appendAgentBehaviorLogTx } from '../audit/repository.js';
import { env } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';

export type ListingStatus = 'open' | 'filled' | 'cancelled' | 'expired';
export type TradeStatus = 'settled' | 'reverted';

export interface ListingView {
  id: string;
  sellerAgentId: string;
  assetId: string;
  assetType: 'equipment';
  quantity: number;
  unitPrice: string;
  feeBps: number;
  status: ListingStatus;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface TradeView {
  id: string;
  listingId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  assetId: string;
  quantity: number;
  unitPrice: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  status: TradeStatus;
  txRef: string | null;
  settledAt: string;
  createdAt: string;
}

export interface CreateListingInput {
  sellerAgentId: string;
  assetId: string;
  quantity: number;
  unitPrice: string;
  feeBps?: number;
  expiresInSeconds?: number | null;
  gameId?: string | null;
}

export interface CancelListingInput {
  listingId: string;
  requesterAgentId: string;
  gameId?: string | null;
}

export interface BuyListingInput {
  listingId: string;
  buyerAgentId: string;
  gameId?: string | null;
  txRef?: string | null;
}

export interface ListListingsInput {
  status?: ListingStatus;
  sellerAgentId?: string;
  limit: number;
  offset: number;
}

export interface ListTradesInput {
  agentId?: string;
  listingId?: string;
  limit: number;
  offset: number;
}

interface ListingRow {
  id: string;
  seller_agent_id: string;
  asset_id: string;
  asset_type: 'equipment';
  quantity: number;
  unit_price: string | number;
  fee_bps: number;
  status: ListingStatus;
  expires_at: string | Date | null;
  closed_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface TradeRow {
  id: string;
  listing_id: string;
  buyer_agent_id: string;
  seller_agent_id: string;
  asset_id: string;
  quantity: number;
  unit_price: string | number;
  gross_amount: string | number;
  fee_amount: string | number;
  net_amount: string | number;
  status: TradeStatus;
  tx_ref: string | null;
  settled_at: string | Date;
  created_at: string | Date;
}

interface AgentStatusRow {
  id: string;
  status: 'active' | 'dead' | 'respawning';
}

const FEE_COLLECTOR_AGENT_ID = env.M2_FEE_COLLECTOR_AGENT_ID;

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

function parseUnsignedBigInt(input: string, field: string): bigint {
  if (!/^\d+$/.test(input)) {
    throw new HttpError(400, `${field} must be an unsigned integer string.`);
  }
  return BigInt(input);
}

function ensureMarketWritable(): void {
  if (!env.M2_MARKET_CIRCUIT_BREAKER) return;
  throw new HttpError(503, 'A2A market circuit breaker is enabled.');
}

function ensureEquipmentWhitelisted(assetId: string): void {
  if (!env.M2_EQUIPMENT_WHITELIST_ITEMS.length) return;
  if (env.M2_EQUIPMENT_WHITELIST_ITEMS.includes(assetId)) return;
  throw new HttpError(409, `Equipment is not in whitelist: ${assetId}`);
}

function mapListingRow(row: ListingRow): ListingView {
  return {
    id: row.id,
    sellerAgentId: row.seller_agent_id,
    assetId: row.asset_id,
    assetType: row.asset_type,
    quantity: Number(row.quantity),
    unitPrice: String(row.unit_price),
    feeBps: Number(row.fee_bps),
    status: row.status,
    expiresAt: row.expires_at ? new Date(row.expires_at).toISOString() : null,
    closedAt: row.closed_at ? new Date(row.closed_at).toISOString() : null,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapTradeRow(row: TradeRow): TradeView {
  return {
    id: row.id,
    listingId: row.listing_id,
    buyerAgentId: row.buyer_agent_id,
    sellerAgentId: row.seller_agent_id,
    assetId: row.asset_id,
    quantity: Number(row.quantity),
    unitPrice: String(row.unit_price),
    grossAmount: String(row.gross_amount),
    feeAmount: String(row.fee_amount),
    netAmount: String(row.net_amount),
    status: row.status,
    txRef: row.tx_ref,
    settledAt: new Date(row.settled_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString()
  };
}

async function latestPersistentBalanceTx(
  client: PoolClient,
  agentId: string,
  assetType: 'currency' | 'equipment' | 'material',
  assetId: string
): Promise<bigint> {
  const result = await client.query<{ balance_after: string | number }>(
    `
      SELECT balance_after
      FROM agent_asset_ledger
      WHERE agent_id = $1
        AND scope = 'persistent'
        AND asset_type = $2
        AND asset_id = $3
      ORDER BY id DESC
      LIMIT 1
    `,
    [agentId, assetType, assetId]
  );
  if (!result.rowCount) return 0n;
  return BigInt(String(result.rows[0].balance_after));
}

async function appendLedgerTx(input: {
  client: PoolClient;
  agentId: string;
  gameId?: string | null;
  assetType: 'currency' | 'equipment' | 'material';
  assetId: string;
  delta: bigint;
  balanceAfter: bigint;
  reason: 'market_lock' | 'market_settle';
  refType: 'listing' | 'trade';
  refId: string;
}): Promise<void> {
  await input.client.query(
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
      ) VALUES ($1, $2, 'persistent', $3, $4, $5, $6, $7, $8, $9)
    `,
    [
      input.agentId,
      input.gameId ?? null,
      input.assetType,
      input.assetId,
      input.delta.toString(),
      input.balanceAfter.toString(),
      input.reason,
      input.refType,
      input.refId
    ]
  );
}

async function lockAgentsTx(client: PoolClient, agentIds: string[]): Promise<Map<string, AgentStatusRow>> {
  const uniqueIds = [...new Set(agentIds)];
  if (!uniqueIds.length) return new Map();
  const result = await client.query<AgentStatusRow>(
    `
      SELECT id, status
      FROM agent
      WHERE id = ANY($1::uuid[])
      FOR UPDATE
    `,
    [uniqueIds]
  );
  const map = new Map(result.rows.map((row) => [row.id, row]));
  for (const id of uniqueIds) {
    if (!map.has(id)) {
      throw new HttpError(404, `Agent not found: ${id}`);
    }
  }
  return map;
}

async function ensureFeeCollectorAgentTx(client: PoolClient): Promise<void> {
  await client.query(
    `
      INSERT INTO agent (id, kind, status, is_enabled)
      VALUES ($1, 'bot', 'active', FALSE)
      ON CONFLICT (id) DO NOTHING
    `,
    [FEE_COLLECTOR_AGENT_ID]
  );
}

async function expireDueListingsTx(client: PoolClient): Promise<number> {
  const dueResult = await client.query<Pick<ListingRow, 'id' | 'seller_agent_id' | 'asset_id' | 'quantity'>>(
    `
      SELECT id, seller_agent_id, asset_id, quantity
      FROM market_listing
      WHERE status = 'open'
        AND expires_at IS NOT NULL
        AND expires_at <= NOW()
      FOR UPDATE SKIP LOCKED
    `
  );

  for (const row of dueResult.rows) {
    await client.query(
      `
        UPDATE market_listing
        SET status = 'expired',
            closed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [row.id]
    );

    const currentEquip = await latestPersistentBalanceTx(
      client,
      row.seller_agent_id,
      'equipment',
      row.asset_id
    );
    const unlockDelta = BigInt(row.quantity);
    await appendLedgerTx({
      client,
      agentId: row.seller_agent_id,
      assetType: 'equipment',
      assetId: row.asset_id,
      delta: unlockDelta,
      balanceAfter: currentEquip + unlockDelta,
      reason: 'market_lock',
      refType: 'listing',
      refId: row.id
    });
  }

  return dueResult.rowCount ?? 0;
}

async function countTradesByGameTx(client: PoolClient, gameId: string, agentId: string): Promise<number> {
  const result = await client.query<{ count: string }>(
    `
      SELECT COUNT(*)::text AS count
      FROM agent_asset_ledger
      WHERE game_id = $1
        AND agent_id = $2
        AND scope = 'persistent'
        AND asset_type = 'currency'
        AND reason = 'market_settle'
        AND ref_type = 'trade'
    `,
    [gameId, agentId]
  );
  return Number(result.rows[0]?.count ?? '0');
}

async function getListingForUpdateTx(client: PoolClient, listingId: string): Promise<ListingRow> {
  const result = await client.query<ListingRow>(
    `
      SELECT
        id,
        seller_agent_id,
        asset_id,
        asset_type,
        quantity,
        unit_price,
        fee_bps,
        status,
        expires_at,
        closed_at,
        created_at,
        updated_at
      FROM market_listing
      WHERE id = $1
      FOR UPDATE
    `,
    [listingId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, `Listing not found: ${listingId}`);
  }
  return result.rows[0];
}

async function getListingById(listingId: string): Promise<ListingView> {
  const result = await pool.query<ListingRow>(
    `
      SELECT
        id,
        seller_agent_id,
        asset_id,
        asset_type,
        quantity,
        unit_price,
        fee_bps,
        status,
        expires_at,
        closed_at,
        created_at,
        updated_at
      FROM market_listing
      WHERE id = $1
      LIMIT 1
    `,
    [listingId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, `Listing not found: ${listingId}`);
  }
  return mapListingRow(result.rows[0]);
}

async function getTradeByListingId(listingId: string): Promise<TradeView> {
  const result = await pool.query<TradeRow>(
    `
      SELECT
        id,
        listing_id,
        buyer_agent_id,
        seller_agent_id,
        asset_id,
        quantity,
        unit_price,
        gross_amount,
        fee_amount,
        net_amount,
        status,
        tx_ref,
        settled_at,
        created_at
      FROM market_trade
      WHERE listing_id = $1
      LIMIT 1
    `,
    [listingId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, `Trade not found for listing: ${listingId}`);
  }
  return mapTradeRow(result.rows[0]);
}

export async function createListing(input: CreateListingInput): Promise<ListingView> {
  ensureMarketWritable();
  ensureEquipmentWhitelisted(input.assetId);

  const unitPrice = parseUnsignedBigInt(input.unitPrice, 'unitPrice');
  if (unitPrice <= 0n) {
    throw new HttpError(400, 'unitPrice must be greater than 0.');
  }

  const feeBps = input.feeBps ?? env.M2_MARKET_DEFAULT_FEE_BPS;
  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new HttpError(400, 'feeBps must be an integer between 0 and 10000.');
  }

  if (input.expiresInSeconds !== undefined && input.expiresInSeconds !== null) {
    if (!Number.isInteger(input.expiresInSeconds) || input.expiresInSeconds <= 0) {
      throw new HttpError(400, 'expiresInSeconds must be a positive integer.');
    }
  }

  const listingId = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireDueListingsTx(client);

    const statuses = await lockAgentsTx(client, [input.sellerAgentId]);
    const seller = statuses.get(input.sellerAgentId)!;
    if (seller.status !== 'active') {
      throw new HttpError(409, `Seller agent must be ACTIVE. current=${seller.status}`);
    }

    const currentEquipBalance = await latestPersistentBalanceTx(
      client,
      input.sellerAgentId,
      'equipment',
      input.assetId
    );
    const quantityBigInt = BigInt(input.quantity);
    if (currentEquipBalance < quantityBigInt) {
      throw new HttpError(
        409,
        `Insufficient equipment balance. asset=${input.assetId} required=${input.quantity} balance=${currentEquipBalance.toString()}`
      );
    }

    await client.query(
      `
        INSERT INTO market_listing (
          id,
          seller_agent_id,
          asset_id,
          asset_type,
          quantity,
          unit_price,
          fee_bps,
          status,
          expires_at
        ) VALUES (
          $1,
          $2,
          $3,
          'equipment',
          $4,
          $5,
          $6,
          'open',
          CASE WHEN $7::int IS NULL THEN NULL ELSE NOW() + make_interval(secs => $7::int) END
        )
      `,
      [
        listingId,
        input.sellerAgentId,
        input.assetId,
        input.quantity,
        unitPrice.toString(),
        feeBps,
        input.expiresInSeconds ?? null
      ]
    );

    await appendLedgerTx({
      client,
      agentId: input.sellerAgentId,
      gameId: input.gameId,
      assetType: 'equipment',
      assetId: input.assetId,
      delta: -quantityBigInt,
      balanceAfter: currentEquipBalance - quantityBigInt,
      reason: 'market_lock',
      refType: 'listing',
      refId: listingId
    });

    await appendAgentBehaviorLogTx(client, {
      agentId: input.sellerAgentId,
      gameId: input.gameId ?? null,
      eventSource: 'market',
      eventType: 'listing_created',
      eventStatus: 'created',
      refType: 'listing',
      refId: listingId,
      payload: {
        assetId: input.assetId,
        quantity: input.quantity,
        unitPrice: unitPrice.toString(),
        feeBps
      }
    });

    await client.query('COMMIT');
    return getListingById(listingId);
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }
}

export async function cancelListing(input: CancelListingInput): Promise<ListingView> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireDueListingsTx(client);

    const listing = await getListingForUpdateTx(client, input.listingId);
    if (listing.seller_agent_id !== input.requesterAgentId) {
      throw new HttpError(403, 'Only seller can cancel listing.');
    }
    if (listing.status !== 'open') {
      throw new HttpError(409, `Listing is not OPEN. current=${listing.status}`);
    }

    await client.query(
      `
        UPDATE market_listing
        SET status = 'cancelled',
            closed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [input.listingId]
    );

    const currentEquipBalance = await latestPersistentBalanceTx(
      client,
      listing.seller_agent_id,
      'equipment',
      listing.asset_id
    );
    const unlockDelta = BigInt(listing.quantity);
    await appendLedgerTx({
      client,
      agentId: listing.seller_agent_id,
      gameId: input.gameId,
      assetType: 'equipment',
      assetId: listing.asset_id,
      delta: unlockDelta,
      balanceAfter: currentEquipBalance + unlockDelta,
      reason: 'market_lock',
      refType: 'listing',
      refId: listing.id
    });

    await appendAgentBehaviorLogTx(client, {
      agentId: listing.seller_agent_id,
      gameId: input.gameId ?? null,
      eventSource: 'market',
      eventType: 'listing_cancelled',
      eventStatus: 'completed',
      refType: 'listing',
      refId: listing.id,
      payload: {
        assetId: listing.asset_id,
        quantity: listing.quantity
      }
    });

    await client.query('COMMIT');
    return getListingById(input.listingId);
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }
}

export async function buyListing(input: BuyListingInput): Promise<{ listing: ListingView; trade: TradeView }> {
  ensureMarketWritable();

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await expireDueListingsTx(client);

    const listing = await getListingForUpdateTx(client, input.listingId);
    if (listing.status !== 'open') {
      throw new HttpError(409, `Listing is not OPEN. current=${listing.status}`);
    }

    ensureEquipmentWhitelisted(listing.asset_id);

    if (listing.seller_agent_id === input.buyerAgentId) {
      throw new HttpError(409, 'Buyer cannot be seller.');
    }

    await ensureFeeCollectorAgentTx(client);

    const statuses = await lockAgentsTx(client, [input.buyerAgentId, listing.seller_agent_id, FEE_COLLECTOR_AGENT_ID]);
    const buyerStatus = statuses.get(input.buyerAgentId)!;
    const sellerStatus = statuses.get(listing.seller_agent_id)!;

    if (buyerStatus.status !== 'active') {
      throw new HttpError(409, `Buyer agent must be ACTIVE. current=${buyerStatus.status}`);
    }
    if (sellerStatus.status !== 'active') {
      throw new HttpError(409, `Seller agent must be ACTIVE. current=${sellerStatus.status}`);
    }

    const quantity = BigInt(listing.quantity);
    const unitPrice = BigInt(String(listing.unit_price));
    const grossAmount = quantity * unitPrice;
    if (grossAmount > env.M2_MARKET_MAX_SINGLE_TRADE_GROSS_CREDITS) {
      throw new HttpError(
        409,
        `Trade exceeds max gross amount. limit=${env.M2_MARKET_MAX_SINGLE_TRADE_GROSS_CREDITS.toString()} gross=${grossAmount.toString()}`
      );
    }

    if (input.gameId) {
      const [buyerTradeCount, sellerTradeCount] = await Promise.all([
        countTradesByGameTx(client, input.gameId, input.buyerAgentId),
        countTradesByGameTx(client, input.gameId, listing.seller_agent_id)
      ]);
      if (buyerTradeCount >= env.M2_MARKET_MAX_TRADES_PER_GAME) {
        throw new HttpError(
          409,
          `Buyer exceeded per-game trade limit. limit=${env.M2_MARKET_MAX_TRADES_PER_GAME}`
        );
      }
      if (sellerTradeCount >= env.M2_MARKET_MAX_TRADES_PER_GAME) {
        throw new HttpError(
          409,
          `Seller exceeded per-game trade limit. limit=${env.M2_MARKET_MAX_TRADES_PER_GAME}`
        );
      }
    }

    const feeAmount = (grossAmount * BigInt(listing.fee_bps)) / 10_000n;
    const netAmount = grossAmount - feeAmount;

    const buyerCredits = await latestPersistentBalanceTx(client, input.buyerAgentId, 'currency', 'credits');
    if (buyerCredits < grossAmount) {
      throw new HttpError(
        409,
        `Insufficient buyer credits. required=${grossAmount.toString()} balance=${buyerCredits.toString()}`
      );
    }

    const sellerCredits = await latestPersistentBalanceTx(client, listing.seller_agent_id, 'currency', 'credits');
    const feeCollectorCredits = await latestPersistentBalanceTx(
      client,
      FEE_COLLECTOR_AGENT_ID,
      'currency',
      'credits'
    );
    const buyerEquip = await latestPersistentBalanceTx(client, input.buyerAgentId, 'equipment', listing.asset_id);

    const tradeId = uuidv4();
    await client.query(
      `
        INSERT INTO market_trade (
          id,
          listing_id,
          buyer_agent_id,
          seller_agent_id,
          asset_id,
          quantity,
          unit_price,
          gross_amount,
          fee_amount,
          net_amount,
          status,
          tx_ref,
          settled_at
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          'settled',
          $11,
          NOW()
        )
      `,
      [
        tradeId,
        listing.id,
        input.buyerAgentId,
        listing.seller_agent_id,
        listing.asset_id,
        listing.quantity,
        unitPrice.toString(),
        grossAmount.toString(),
        feeAmount.toString(),
        netAmount.toString(),
        input.txRef ?? null
      ]
    );

    await client.query(
      `
        UPDATE market_listing
        SET status = 'filled',
            closed_at = NOW(),
            updated_at = NOW()
        WHERE id = $1
      `,
      [listing.id]
    );

    await appendLedgerTx({
      client,
      agentId: input.buyerAgentId,
      gameId: input.gameId,
      assetType: 'currency',
      assetId: 'credits',
      delta: -grossAmount,
      balanceAfter: buyerCredits - grossAmount,
      reason: 'market_settle',
      refType: 'trade',
      refId: tradeId
    });

    await appendLedgerTx({
      client,
      agentId: listing.seller_agent_id,
      gameId: input.gameId,
      assetType: 'currency',
      assetId: 'credits',
      delta: netAmount,
      balanceAfter: sellerCredits + netAmount,
      reason: 'market_settle',
      refType: 'trade',
      refId: tradeId
    });

    if (feeAmount > 0n) {
      await appendLedgerTx({
        client,
        agentId: FEE_COLLECTOR_AGENT_ID,
        gameId: input.gameId,
        assetType: 'currency',
        assetId: 'credits',
        delta: feeAmount,
        balanceAfter: feeCollectorCredits + feeAmount,
        reason: 'market_settle',
        refType: 'trade',
        refId: tradeId
      });
    }

    await appendLedgerTx({
      client,
      agentId: input.buyerAgentId,
      gameId: input.gameId,
      assetType: 'equipment',
      assetId: listing.asset_id,
      delta: quantity,
      balanceAfter: buyerEquip + quantity,
      reason: 'market_settle',
      refType: 'trade',
      refId: tradeId
    });

    await appendAgentBehaviorLogTx(client, {
      agentId: input.buyerAgentId,
      gameId: input.gameId ?? null,
      eventSource: 'market',
      eventType: 'trade_bought',
      eventStatus: 'completed',
      refType: 'trade',
      refId: tradeId,
      payload: {
        listingId: listing.id,
        assetId: listing.asset_id,
        quantity: listing.quantity,
        grossAmount: grossAmount.toString(),
        feeAmount: feeAmount.toString()
      }
    });
    await appendAgentBehaviorLogTx(client, {
      agentId: listing.seller_agent_id,
      gameId: input.gameId ?? null,
      eventSource: 'market',
      eventType: 'trade_sold',
      eventStatus: 'completed',
      refType: 'trade',
      refId: tradeId,
      payload: {
        listingId: listing.id,
        assetId: listing.asset_id,
        quantity: listing.quantity,
        netAmount: netAmount.toString(),
        feeAmount: feeAmount.toString()
      }
    });

    await client.query('COMMIT');

    const [latestListing, trade] = await Promise.all([
      getListingById(listing.id),
      getTradeByListingId(listing.id)
    ]);
    return {
      listing: latestListing,
      trade
    };
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }
}

export async function expireDueListings(): Promise<{ expiredCount: number }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const expiredCount = await expireDueListingsTx(client);
    await client.query('COMMIT');
    return { expiredCount };
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }
}

export async function listListings(input: ListListingsInput): Promise<{ items: ListingView[]; count: number }> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (input.status) {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.sellerAgentId) {
    values.push(input.sellerAgentId);
    where.push(`seller_agent_id = $${values.length}`);
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const sql = `
    SELECT
      id,
      seller_agent_id,
      asset_id,
      asset_type,
      quantity,
      unit_price,
      fee_bps,
      status,
      expires_at,
      closed_at,
      created_at,
      updated_at
    FROM market_listing
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY created_at DESC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
  `;

  const [rows, countRows] = await Promise.all([
    pool.query<ListingRow>(sql, values),
    pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM market_listing
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `,
      values.slice(0, where.length)
    )
  ]);

  return {
    items: rows.rows.map(mapListingRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}

export async function getListing(listingId: string): Promise<ListingView> {
  return getListingById(listingId);
}

export async function listTrades(input: ListTradesInput): Promise<{ items: TradeView[]; count: number }> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (input.agentId) {
    values.push(input.agentId);
    where.push(`(buyer_agent_id = $${values.length} OR seller_agent_id = $${values.length})`);
  }
  if (input.listingId) {
    values.push(input.listingId);
    where.push(`listing_id = $${values.length}`);
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const sql = `
    SELECT
      id,
      listing_id,
      buyer_agent_id,
      seller_agent_id,
      asset_id,
      quantity,
      unit_price,
      gross_amount,
      fee_amount,
      net_amount,
      status,
      tx_ref,
      settled_at,
      created_at
    FROM market_trade
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY settled_at DESC, created_at DESC
    LIMIT $${limitIndex}
    OFFSET $${offsetIndex}
  `;

  const [rows, countRows] = await Promise.all([
    pool.query<TradeRow>(sql, values),
    pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM market_trade
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `,
      values.slice(0, where.length)
    )
  ]);

  return {
    items: rows.rows.map(mapTradeRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}

export async function getTradeByListing(listingId: string): Promise<TradeView> {
  return getTradeByListingId(listingId);
}
