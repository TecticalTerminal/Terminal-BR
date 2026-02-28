import { v4 as uuidv4 } from 'uuid';
import { getAgentById, listAgents } from '../agents/repository.js';
import { appendAgentBehaviorLogTx } from '../audit/repository.js';
import { env } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';
import { buyListing, createListing, type ListingView, type TradeView } from './repository.js';

type AssetType = 'currency' | 'equipment' | 'material';
type AutoTradeRunStatus = 'running' | 'completed' | 'failed';

const AUTO_TRADE_LOCK_NS = 12_000;
const AUTO_TRADE_LOCK_KEY = 8004;

export interface AutoTradeOneShotInput {
  clientRunId?: string;
  sellerAgentId?: string;
  buyerAgentId?: string;
  gameId?: string | null;
  assetId?: string;
  quantity?: number;
  unitPrice?: string;
  feeBps?: number;
  maxBuyUnitPrice?: string;
  autoSeed?: boolean;
  buyerCreditsTarget?: string;
  sellerEquipmentTarget?: string;
}

export interface AutoTradeStep {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: Record<string, unknown>;
}

export interface AutoTradeOneShotResult {
  runId: string;
  clientRunId: string | null;
  idempotent: boolean;
  sellerAgentId: string;
  buyerAgentId: string;
  gameId: string | null;
  assetId: string;
  quantity: number;
  unitPrice: string;
  feeBps: number;
  maxBuyUnitPrice: string;
  autoSeed: boolean;
  listing: ListingView;
  trade: TradeView;
  steps: AutoTradeStep[];
}

interface AutoTradeRunRow {
  id: string;
  client_run_id: string | null;
  status: AutoTradeRunStatus;
  request_json: unknown;
  response_json: unknown | null;
  error_message: string | null;
}

function parseUnsignedBigInt(input: string, field: string): bigint {
  if (!/^\d+$/.test(input)) {
    throw new HttpError(400, `${field} must be an unsigned integer string.`);
  }
  return BigInt(input);
}

function normalizeClientRunId(input?: string): string | undefined {
  const candidate = input?.trim();
  if (!candidate) return undefined;
  if (candidate.length > 128) {
    throw new HttpError(400, 'clientRunId must be <= 128 characters.');
  }
  return candidate;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return 'unknown_auto_trade_error';
}

async function withAutoTradeLock<T>(fn: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    const lock = await client.query<{ acquired: boolean }>(
      `SELECT pg_try_advisory_lock($1, $2) AS acquired`,
      [AUTO_TRADE_LOCK_NS, AUTO_TRADE_LOCK_KEY]
    );
    if (!lock.rows[0]?.acquired) {
      throw new HttpError(409, 'Another auto-trade run is in progress.');
    }
    return await fn();
  } finally {
    try {
      await client.query(`SELECT pg_advisory_unlock($1, $2)`, [AUTO_TRADE_LOCK_NS, AUTO_TRADE_LOCK_KEY]);
    } finally {
      client.release();
    }
  }
}

async function findAutoTradeRunByClientRunId(clientRunId: string): Promise<AutoTradeRunRow | null> {
  const result = await pool.query<AutoTradeRunRow>(
    `
      SELECT
        id,
        client_run_id,
        status,
        request_json,
        response_json,
        error_message
      FROM auto_trade_run
      WHERE client_run_id = $1
      LIMIT 1
    `,
    [clientRunId]
  );
  return result.rowCount ? result.rows[0] : null;
}

async function insertAutoTradeRun(input: {
  runId: string;
  clientRunId?: string;
  request: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO auto_trade_run (
        id,
        client_run_id,
        status,
        request_json
      ) VALUES ($1, $2, 'running', $3::jsonb)
    `,
    [input.runId, input.clientRunId ?? null, JSON.stringify(input.request)]
  );
}

async function completeAutoTradeRun(runId: string, result: AutoTradeOneShotResult): Promise<void> {
  await pool.query(
    `
      UPDATE auto_trade_run
      SET status = 'completed',
          response_json = $2::jsonb,
          updated_at = NOW()
      WHERE id = $1
    `,
    [runId, JSON.stringify(result)]
  );
}

async function failAutoTradeRun(runId: string, errorMessage: string): Promise<void> {
  await pool.query(
    `
      UPDATE auto_trade_run
      SET status = 'failed',
          error_message = $2,
          updated_at = NOW()
      WHERE id = $1
    `,
    [runId, errorMessage.slice(0, 2000)]
  );
}

async function appendAutoTradeBehaviorLog(input: {
  agentId?: string | null;
  gameId?: string | null;
  eventType: 'auto_trade_started' | 'auto_trade_listed' | 'auto_trade_bought' | 'auto_trade_failed';
  eventStatus: 'created' | 'completed' | 'failed';
  runId: string;
  payload?: Record<string, unknown>;
}): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await appendAgentBehaviorLogTx(client, {
      agentId: input.agentId ?? null,
      gameId: input.gameId ?? null,
      eventSource: 'market',
      eventType: input.eventType,
      eventStatus: input.eventStatus,
      refType: 'auto_trade_run',
      refId: input.runId,
      payload: input.payload ?? {}
    });
    await client.query('COMMIT');
  } catch {
    await client.query('ROLLBACK');
  } finally {
    client.release();
  }
}

function normalizeTradeInput(input: AutoTradeOneShotInput) {
  const assetId = (input.assetId ?? env.M2_AUTO_TRADE_DEFAULT_ASSET_ID).trim();
  if (!assetId) {
    throw new HttpError(400, 'assetId is required.');
  }

  const quantity = input.quantity ?? env.M2_AUTO_TRADE_DEFAULT_QUANTITY;
  if (!Number.isInteger(quantity) || quantity <= 0) {
    throw new HttpError(400, 'quantity must be a positive integer.');
  }

  const unitPrice = input.unitPrice ?? env.M2_AUTO_TRADE_DEFAULT_UNIT_PRICE;
  const feeBps = input.feeBps ?? env.M2_AUTO_TRADE_DEFAULT_FEE_BPS;
  const maxBuyUnitPrice = input.maxBuyUnitPrice ?? env.M2_AUTO_TRADE_DEFAULT_MAX_BUY_UNIT_PRICE;
  const autoSeed = input.autoSeed ?? env.M2_AUTO_TRADE_DEFAULT_AUTO_SEED;
  const buyerCreditsTargetRaw =
    input.buyerCreditsTarget ?? env.M2_AUTO_TRADE_DEFAULT_BUYER_CREDITS_TARGET.toString();
  const sellerEquipmentTargetRaw =
    input.sellerEquipmentTarget ?? env.M2_AUTO_TRADE_DEFAULT_SELLER_EQUIPMENT_TARGET.toString();

  if (!Number.isInteger(feeBps) || feeBps < 0 || feeBps > 10_000) {
    throw new HttpError(400, 'feeBps must be an integer between 0 and 10000.');
  }

  return {
    clientRunId: normalizeClientRunId(input.clientRunId),
    assetId,
    quantity,
    unitPrice,
    feeBps,
    maxBuyUnitPrice,
    autoSeed,
    gameId: input.gameId ?? null,
    sellerAgentId: input.sellerAgentId ?? env.M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID,
    buyerAgentId: input.buyerAgentId ?? env.M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID,
    buyerCreditsTargetRaw,
    sellerEquipmentTargetRaw
  };
}

async function resolveBotPair(input: {
  sellerAgentId?: string;
  buyerAgentId?: string;
}): Promise<{ sellerAgentId: string; buyerAgentId: string }> {
  const sellerCandidate = input.sellerAgentId?.trim() || undefined;
  const buyerCandidate = input.buyerAgentId?.trim() || undefined;

  if (sellerCandidate) {
    const seller = await getAgentById(sellerCandidate);
    if (seller.kind !== 'bot') {
      throw new HttpError(409, `sellerAgentId must be a bot. agent=${seller.id}`);
    }
    if (seller.status !== 'active') {
      throw new HttpError(409, `sellerAgentId must be ACTIVE. current=${seller.status}`);
    }
  }

  if (buyerCandidate) {
    const buyer = await getAgentById(buyerCandidate);
    if (buyer.kind !== 'bot') {
      throw new HttpError(409, `buyerAgentId must be a bot. agent=${buyer.id}`);
    }
    if (buyer.status !== 'active') {
      throw new HttpError(409, `buyerAgentId must be ACTIVE. current=${buyer.status}`);
    }
  }

  if (sellerCandidate && buyerCandidate) {
    if (sellerCandidate === buyerCandidate) {
      throw new HttpError(409, 'sellerAgentId and buyerAgentId must be different bots.');
    }
    return {
      sellerAgentId: sellerCandidate,
      buyerAgentId: buyerCandidate
    };
  }

  const bots = await listAgents({ kind: 'bot', status: 'active' });
  if (bots.length < 2) {
    throw new HttpError(409, `At least 2 active bots are required. found=${bots.length}`);
  }

  if (sellerCandidate) {
    const buyer = bots.find((bot) => bot.id !== sellerCandidate);
    if (!buyer) {
      throw new HttpError(409, 'Unable to auto-select buyer bot.');
    }
    return {
      sellerAgentId: sellerCandidate,
      buyerAgentId: buyer.id
    };
  }

  if (buyerCandidate) {
    const seller = bots.find((bot) => bot.id !== buyerCandidate);
    if (!seller) {
      throw new HttpError(409, 'Unable to auto-select seller bot.');
    }
    return {
      sellerAgentId: seller.id,
      buyerAgentId: buyerCandidate
    };
  }

  return {
    sellerAgentId: bots[0].id,
    buyerAgentId: bots[1].id
  };
}

async function latestPersistentBalance(
  agentId: string,
  assetType: AssetType,
  assetId: string
): Promise<bigint> {
  const result = await pool.query<{ balance_after: string | number }>(
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

async function ensureTargetBalance(input: {
  agentId: string;
  assetType: AssetType;
  assetId: string;
  target: bigint;
  runId: string;
  gameId?: string | null;
}): Promise<{ before: bigint; after: bigint; delta: bigint }> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
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
      [input.agentId, input.assetType, input.assetId]
    );
    const before = result.rowCount ? BigInt(String(result.rows[0].balance_after)) : 0n;
    const delta = input.target - before;
    const after = before + delta;

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
          ) VALUES ($1, $2, 'persistent', $3, $4, $5, $6, 'admin_adjust', 'auto_trade_run', $7)
        `,
        [
          input.agentId,
          input.gameId ?? null,
          input.assetType,
          input.assetId,
          delta.toString(),
          after.toString(),
          input.runId
        ]
      );
    }

    await client.query('COMMIT');
    return { before, after, delta };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function runAutonomousOneShotTrade(
  input: AutoTradeOneShotInput = {}
): Promise<AutoTradeOneShotResult> {
  const normalized = normalizeTradeInput(input);

  return withAutoTradeLock(async () => {
    if (normalized.clientRunId) {
      const existing = await findAutoTradeRunByClientRunId(normalized.clientRunId);
      if (existing?.status === 'completed' && existing.response_json) {
        return {
          ...(existing.response_json as AutoTradeOneShotResult),
          idempotent: true,
          clientRunId: normalized.clientRunId
        };
      }
      if (existing?.status === 'running') {
        throw new HttpError(409, `clientRunId is currently running: ${normalized.clientRunId}`);
      }
      if (existing?.status === 'failed') {
        throw new HttpError(
          409,
          `clientRunId already failed before: ${normalized.clientRunId}. use a new clientRunId to retry.`
        );
      }
    }

    const runId = uuidv4();
    const steps: AutoTradeStep[] = [];

    await insertAutoTradeRun({
      runId,
      clientRunId: normalized.clientRunId,
      request: {
        ...normalized
      }
    });

    try {
      const { sellerAgentId, buyerAgentId } = await resolveBotPair({
        sellerAgentId: normalized.sellerAgentId,
        buyerAgentId: normalized.buyerAgentId
      });

      await Promise.all([
        appendAutoTradeBehaviorLog({
          agentId: sellerAgentId,
          gameId: normalized.gameId,
          eventType: 'auto_trade_started',
          eventStatus: 'created',
          runId,
          payload: {
            role: 'seller',
            clientRunId: normalized.clientRunId ?? null,
            buyerAgentId,
            assetId: normalized.assetId,
            quantity: normalized.quantity,
            unitPrice: normalized.unitPrice
          }
        }),
        appendAutoTradeBehaviorLog({
          agentId: buyerAgentId,
          gameId: normalized.gameId,
          eventType: 'auto_trade_started',
          eventStatus: 'created',
          runId,
          payload: {
            role: 'buyer',
            clientRunId: normalized.clientRunId ?? null,
            sellerAgentId,
            assetId: normalized.assetId,
            quantity: normalized.quantity,
            unitPrice: normalized.unitPrice
          }
        })
      ]);

      steps.push({
        step: 'select_bots',
        status: 'ok',
        detail: {
          sellerAgentId,
          buyerAgentId
        }
      });

      const quantityBigInt = BigInt(normalized.quantity);
      const unitPriceBigInt = parseUnsignedBigInt(normalized.unitPrice, 'unitPrice');
      if (unitPriceBigInt <= 0n) {
        throw new HttpError(400, 'unitPrice must be greater than 0.');
      }
      const grossAmount = quantityBigInt * unitPriceBigInt;

      const maxBuyUnitPriceBigInt = parseUnsignedBigInt(
        normalized.maxBuyUnitPrice,
        'maxBuyUnitPrice'
      );

      let sellerEquipBalance = await latestPersistentBalance(
        sellerAgentId,
        'equipment',
        normalized.assetId
      );
      let buyerCreditsBalance = await latestPersistentBalance(buyerAgentId, 'currency', 'credits');

      if (normalized.autoSeed) {
        const buyerTargetFromInput = parseUnsignedBigInt(
          normalized.buyerCreditsTargetRaw,
          'buyerCreditsTarget'
        );
        const sellerTargetFromInput = parseUnsignedBigInt(
          normalized.sellerEquipmentTargetRaw,
          'sellerEquipmentTarget'
        );
        const buyerTarget = buyerTargetFromInput > grossAmount ? buyerTargetFromInput : grossAmount;
        const sellerTarget =
          sellerTargetFromInput > quantityBigInt ? sellerTargetFromInput : quantityBigInt;

        const [buyerSeed, sellerSeed] = await Promise.all([
          ensureTargetBalance({
            agentId: buyerAgentId,
            assetType: 'currency',
            assetId: 'credits',
            target: buyerTarget,
            runId,
            gameId: normalized.gameId
          }),
          ensureTargetBalance({
            agentId: sellerAgentId,
            assetType: 'equipment',
            assetId: normalized.assetId,
            target: sellerTarget,
            runId,
            gameId: normalized.gameId
          })
        ]);

        buyerCreditsBalance = buyerSeed.after;
        sellerEquipBalance = sellerSeed.after;
        steps.push({
          step: 'seed_preconditions',
          status: 'ok',
          detail: {
            buyer: {
              before: buyerSeed.before.toString(),
              after: buyerSeed.after.toString(),
              delta: buyerSeed.delta.toString()
            },
            seller: {
              before: sellerSeed.before.toString(),
              after: sellerSeed.after.toString(),
              delta: sellerSeed.delta.toString()
            }
          }
        });
      } else {
        steps.push({
          step: 'seed_preconditions',
          status: 'skipped',
          detail: {
            autoSeed: false
          }
        });
      }

      if (sellerEquipBalance < quantityBigInt) {
        throw new HttpError(
          409,
          `Seller equipment balance is insufficient. required=${quantityBigInt.toString()} balance=${sellerEquipBalance.toString()}`
        );
      }
      if (buyerCreditsBalance < grossAmount) {
        throw new HttpError(
          409,
          `Buyer credits balance is insufficient. required=${grossAmount.toString()} balance=${buyerCreditsBalance.toString()}`
        );
      }

      steps.push({
        step: 'seller_decision',
        status: 'ok',
        detail: {
          rule: 'inventory>0 => list',
          equipmentBalance: sellerEquipBalance.toString(),
          quantity: normalized.quantity,
          unitPrice: normalized.unitPrice
        }
      });

      const listing = await createListing({
        sellerAgentId,
        assetId: normalized.assetId,
        quantity: normalized.quantity,
        unitPrice: normalized.unitPrice,
        feeBps: normalized.feeBps,
        gameId: normalized.gameId
      });

      await appendAutoTradeBehaviorLog({
        agentId: sellerAgentId,
        gameId: normalized.gameId,
        eventType: 'auto_trade_listed',
        eventStatus: 'completed',
        runId,
        payload: {
          role: 'seller',
          listingId: listing.id,
          assetId: listing.assetId,
          quantity: listing.quantity,
          unitPrice: listing.unitPrice,
          feeBps: listing.feeBps
        }
      });

      steps.push({
        step: 'create_listing',
        status: 'ok',
        detail: {
          listingId: listing.id,
          status: listing.status
        }
      });

      const listingUnitPriceBigInt = parseUnsignedBigInt(listing.unitPrice, 'listing.unitPrice');
      if (listingUnitPriceBigInt > maxBuyUnitPriceBigInt) {
        throw new HttpError(
          409,
          `Buyer decision rejected listing price. price=${listingUnitPriceBigInt.toString()} max=${maxBuyUnitPriceBigInt.toString()}`
        );
      }

      steps.push({
        step: 'buyer_decision',
        status: 'ok',
        detail: {
          rule: 'whitelist_hit && unitPrice<=maxBuyUnitPrice => buy',
          listingUnitPrice: listing.unitPrice,
          maxBuyUnitPrice: normalized.maxBuyUnitPrice
        }
      });

      const tradeResult = await buyListing({
        listingId: listing.id,
        buyerAgentId,
        gameId: normalized.gameId,
        txRef: `auto-trade:${runId}`
      });

      await Promise.all([
        appendAutoTradeBehaviorLog({
          agentId: buyerAgentId,
          gameId: normalized.gameId,
          eventType: 'auto_trade_bought',
          eventStatus: 'completed',
          runId,
          payload: {
            role: 'buyer',
            listingId: listing.id,
            tradeId: tradeResult.trade.id,
            grossAmount: tradeResult.trade.grossAmount,
            feeAmount: tradeResult.trade.feeAmount,
            netAmount: tradeResult.trade.netAmount
          }
        }),
        appendAutoTradeBehaviorLog({
          agentId: sellerAgentId,
          gameId: normalized.gameId,
          eventType: 'auto_trade_bought',
          eventStatus: 'completed',
          runId,
          payload: {
            role: 'seller',
            listingId: listing.id,
            tradeId: tradeResult.trade.id,
            grossAmount: tradeResult.trade.grossAmount,
            feeAmount: tradeResult.trade.feeAmount,
            netAmount: tradeResult.trade.netAmount
          }
        })
      ]);

      steps.push({
        step: 'buy_listing',
        status: 'ok',
        detail: {
          tradeId: tradeResult.trade.id,
          grossAmount: tradeResult.trade.grossAmount,
          feeAmount: tradeResult.trade.feeAmount,
          netAmount: tradeResult.trade.netAmount
        }
      });

      const result: AutoTradeOneShotResult = {
        runId,
        clientRunId: normalized.clientRunId ?? null,
        idempotent: false,
        sellerAgentId,
        buyerAgentId,
        gameId: normalized.gameId,
        assetId: normalized.assetId,
        quantity: normalized.quantity,
        unitPrice: normalized.unitPrice,
        feeBps: normalized.feeBps,
        maxBuyUnitPrice: normalized.maxBuyUnitPrice,
        autoSeed: normalized.autoSeed,
        listing: tradeResult.listing,
        trade: tradeResult.trade,
        steps
      };

      await completeAutoTradeRun(runId, result);
      return result;
    } catch (error) {
      await appendAutoTradeBehaviorLog({
        agentId: normalized.sellerAgentId ?? null,
        gameId: normalized.gameId,
        eventType: 'auto_trade_failed',
        eventStatus: 'failed',
        runId,
        payload: {
          clientRunId: normalized.clientRunId ?? null,
          message: toErrorMessage(error)
        }
      });
      try {
        await failAutoTradeRun(runId, toErrorMessage(error));
      } catch {
        // no-op: keep original error
      }
      throw error;
    }
  });
}
