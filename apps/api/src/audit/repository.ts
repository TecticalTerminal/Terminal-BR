import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool.js';

type AuditEventSource = 'game_action' | 'lifecycle' | 'market' | 'system';
type AuditEventStatus = 'created' | 'accepted' | 'applied' | 'completed' | 'failed' | 'skipped';

interface AgentBehaviorLogRow {
  id: string;
  agent_id: string | null;
  game_id: string | null;
  seq: string | number | null;
  action_type: string | null;
  event_source: AuditEventSource;
  event_type: string;
  event_status: AuditEventStatus;
  ref_type: string | null;
  ref_id: string | null;
  payload_json: unknown;
  created_at: string | Date;
}

interface PaymentLogRow {
  id: string;
  source: 'x402' | 'ledger';
  agent_id: string | null;
  game_id: string | null;
  status: string;
  amount: string | number | null;
  asset_id: string | null;
  ref_type: string | null;
  ref_id: string | null;
  metadata_json: unknown;
  created_at: string | Date;
}

interface TradeLogRow {
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
  status: 'settled' | 'reverted';
  tx_ref: string | null;
  settled_at: string | Date;
  created_at: string | Date;
}

interface OnchainTxRow {
  id: string;
  tx_hash: string;
  chain: string;
  operation: string;
  status: 'pending' | 'confirmed' | 'failed';
  metadata: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

interface Erc8004SyncLogRow {
  id: string;
  agent_id: string | null;
  chain: string;
  contract_address: string;
  action: 'register' | 'update_agent_uri' | 'discover' | 'discover_fetch';
  status: 'pending' | 'confirmed' | 'failed' | 'skipped' | 'dry_run';
  erc8004_agent_id: string | null;
  agent_uri: string | null;
  tx_hash: string | null;
  error_message: string | null;
  metadata_json: unknown;
  created_at: string | Date;
}

function asRecord(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

export interface AgentBehaviorLogView {
  id: string;
  agentId: string | null;
  gameId: string | null;
  seq: string | null;
  actionType: string | null;
  eventSource: AuditEventSource;
  eventType: string;
  eventStatus: AuditEventStatus;
  refType: string | null;
  refId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

export interface AuditPaymentLogView {
  id: string;
  source: 'x402' | 'ledger';
  agentId: string | null;
  gameId: string | null;
  status: string;
  amount: string | null;
  assetId: string | null;
  refType: string | null;
  refId: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export interface AuditTradeLogView {
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
  status: 'settled' | 'reverted';
  txRef: string | null;
  settledAt: string;
  createdAt: string;
}

export interface AuditOnchainTxLogView {
  id: string;
  txHash: string;
  chain: string;
  operation: string;
  status: 'pending' | 'confirmed' | 'failed';
  metadata: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface AuditErc8004SyncLogView {
  id: string;
  agentId: string | null;
  chain: string;
  contractAddress: string;
  action: 'register' | 'update_agent_uri' | 'discover' | 'discover_fetch';
  status: 'pending' | 'confirmed' | 'failed' | 'skipped' | 'dry_run';
  erc8004AgentId: string | null;
  agentUri: string | null;
  txHash: string | null;
  errorMessage: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

export async function appendAgentBehaviorLogTx(
  client: PoolClient,
  input: {
    agentId?: string | null;
    gameId?: string | null;
    seq?: number | null;
    actionType?: string | null;
    eventSource: AuditEventSource;
    eventType: string;
    eventStatus: AuditEventStatus;
    refType?: string | null;
    refId?: string | null;
    payload?: Record<string, unknown>;
  }
): Promise<string> {
  const id = uuidv4();
  await client.query(
    `
      INSERT INTO agent_behavior_log (
        id,
        agent_id,
        game_id,
        seq,
        action_type,
        event_source,
        event_type,
        event_status,
        ref_type,
        ref_id,
        payload_json
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
        $11::jsonb
      )
    `,
    [
      id,
      input.agentId ?? null,
      input.gameId ?? null,
      input.seq ?? null,
      input.actionType ?? null,
      input.eventSource,
      input.eventType,
      input.eventStatus,
      input.refType ?? null,
      input.refId ?? null,
      JSON.stringify(input.payload ?? {})
    ]
  );
  return id;
}

function mapBehaviorRow(row: AgentBehaviorLogRow): AgentBehaviorLogView {
  return {
    id: row.id,
    agentId: row.agent_id,
    gameId: row.game_id,
    seq: row.seq === null ? null : String(row.seq),
    actionType: row.action_type,
    eventSource: row.event_source,
    eventType: row.event_type,
    eventStatus: row.event_status,
    refType: row.ref_type,
    refId: row.ref_id,
    payload: asRecord(row.payload_json),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapPaymentRow(row: PaymentLogRow): AuditPaymentLogView {
  return {
    id: row.id,
    source: row.source,
    agentId: row.agent_id,
    gameId: row.game_id,
    status: row.status,
    amount: row.amount === null ? null : String(row.amount),
    assetId: row.asset_id,
    refType: row.ref_type,
    refId: row.ref_id,
    metadata: asRecord(row.metadata_json),
    createdAt: new Date(row.created_at).toISOString()
  };
}

function mapTradeRow(row: TradeLogRow): AuditTradeLogView {
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

function mapOnchainTxRow(row: OnchainTxRow): AuditOnchainTxLogView {
  return {
    id: row.id,
    txHash: row.tx_hash,
    chain: row.chain,
    operation: row.operation,
    status: row.status,
    metadata: asRecord(row.metadata),
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString()
  };
}

function mapErc8004SyncRow(row: Erc8004SyncLogRow): AuditErc8004SyncLogView {
  return {
    id: row.id,
    agentId: row.agent_id,
    chain: row.chain,
    contractAddress: row.contract_address,
    action: row.action,
    status: row.status,
    erc8004AgentId: row.erc8004_agent_id,
    agentUri: row.agent_uri,
    txHash: row.tx_hash,
    errorMessage: row.error_message,
    metadata: asRecord(row.metadata_json),
    createdAt: new Date(row.created_at).toISOString()
  };
}

export async function listAgentBehaviorLogs(input: {
  limit: number;
  offset: number;
  agentId?: string;
  gameId?: string;
  eventSource?: AuditEventSource;
  eventType?: string;
}): Promise<{ items: AgentBehaviorLogView[]; count: number }> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (input.agentId) {
    values.push(input.agentId);
    where.push(`agent_id = $${values.length}`);
  }
  if (input.gameId) {
    values.push(input.gameId);
    where.push(`game_id = $${values.length}`);
  }
  if (input.eventSource) {
    values.push(input.eventSource);
    where.push(`event_source = $${values.length}`);
  }
  if (input.eventType) {
    values.push(input.eventType);
    where.push(`event_type = $${values.length}`);
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const [rows, countRows] = await Promise.all([
    pool.query<AgentBehaviorLogRow>(
      `
        SELECT
          id,
          agent_id,
          game_id,
          seq,
          action_type,
          event_source,
          event_type,
          event_status,
          ref_type,
          ref_id,
          payload_json,
          created_at
        FROM agent_behavior_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      values
    ),
    pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM agent_behavior_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `,
      values.slice(0, where.length)
    )
  ]);

  return {
    items: rows.rows.map(mapBehaviorRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}

export async function listAuditPaymentLogs(input: {
  limit: number;
  offset: number;
  source?: 'x402' | 'ledger';
  agentId?: string;
  gameId?: string;
}): Promise<{ items: AuditPaymentLogView[]; count: number }> {
  const [rows, countRows] = await Promise.all([
    pool.query<PaymentLogRow>(
      `
        WITH payments AS (
          SELECT
            x.id::text AS id,
            'x402'::text AS source,
            NULL::uuid AS agent_id,
            NULL::uuid AS game_id,
            x.status::text AS status,
            x.approved_amount_cents::bigint AS amount,
            'usd_cents'::text AS asset_id,
            NULL::text AS ref_type,
            NULL::text AS ref_id,
            x.metadata_json,
            x.created_at
          FROM x402_payment_log x
          UNION ALL
          SELECT
            l.id::text AS id,
            'ledger'::text AS source,
            l.agent_id,
            l.game_id,
            l.reason::text AS status,
            l.delta AS amount,
            l.asset_id,
            l.ref_type,
            l.ref_id,
            jsonb_build_object(
              'scope', l.scope,
              'assetType', l.asset_type,
              'balanceAfter', l.balance_after
            ) AS metadata_json,
            l.created_at
          FROM agent_asset_ledger l
          WHERE l.asset_type = 'currency'
            AND l.reason IN ('respawn_fee', 'market_settle')
        )
        SELECT
          id,
          source::text AS source,
          agent_id,
          game_id,
          status,
          amount,
          asset_id,
          ref_type,
          ref_id,
          metadata_json,
          created_at
        FROM payments
        WHERE ($1::text IS NULL OR source = $1::text)
          AND ($2::uuid IS NULL OR agent_id = $2::uuid)
          AND ($3::uuid IS NULL OR game_id = $3::uuid)
        ORDER BY created_at DESC
        LIMIT $4
        OFFSET $5
      `,
      [input.source ?? null, input.agentId ?? null, input.gameId ?? null, input.limit, input.offset]
    ),
    pool.query<{ count: string }>(
      `
        WITH payments AS (
          SELECT
            'x402'::text AS source,
            NULL::uuid AS agent_id,
            NULL::uuid AS game_id
          FROM x402_payment_log
          UNION ALL
          SELECT
            'ledger'::text AS source,
            l.agent_id,
            l.game_id
          FROM agent_asset_ledger l
          WHERE l.asset_type = 'currency'
            AND l.reason IN ('respawn_fee', 'market_settle')
        )
        SELECT COUNT(*)::text AS count
        FROM payments
        WHERE ($1::text IS NULL OR source = $1::text)
          AND ($2::uuid IS NULL OR agent_id = $2::uuid)
          AND ($3::uuid IS NULL OR game_id = $3::uuid)
      `,
      [input.source ?? null, input.agentId ?? null, input.gameId ?? null]
    )
  ]);

  return {
    items: rows.rows.map(mapPaymentRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}

export async function listAuditTradeLogs(input: {
  limit: number;
  offset: number;
  agentId?: string;
  listingId?: string;
}): Promise<{ items: AuditTradeLogView[]; count: number }> {
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

  const [rows, countRows] = await Promise.all([
    pool.query<TradeLogRow>(
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
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY settled_at DESC, created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      values
    ),
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

export async function listAuditOnchainTransactions(input: {
  limit: number;
  offset: number;
  status?: 'pending' | 'confirmed' | 'failed';
  operation?: string;
}): Promise<{ items: AuditOnchainTxLogView[]; count: number }> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (input.status) {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.operation) {
    values.push(input.operation);
    where.push(`operation = $${values.length}`);
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const [rows, countRows] = await Promise.all([
    pool.query<OnchainTxRow>(
      `
        SELECT
          id,
          tx_hash,
          chain,
          operation,
          status,
          metadata,
          created_at,
          updated_at
        FROM onchain_transactions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      values
    ),
    pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM onchain_transactions
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `,
      values.slice(0, where.length)
    )
  ]);

  return {
    items: rows.rows.map(mapOnchainTxRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}

export async function listAuditErc8004SyncLogs(input: {
  limit: number;
  offset: number;
  agentId?: string;
  status?: 'pending' | 'confirmed' | 'failed' | 'skipped' | 'dry_run';
  action?: 'register' | 'update_agent_uri' | 'discover' | 'discover_fetch';
}): Promise<{ items: AuditErc8004SyncLogView[]; count: number }> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (input.agentId) {
    values.push(input.agentId);
    where.push(`agent_id = $${values.length}`);
  }
  if (input.status) {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.action) {
    values.push(input.action);
    where.push(`action = $${values.length}`);
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const [rows, countRows] = await Promise.all([
    pool.query<Erc8004SyncLogRow>(
      `
        SELECT
          id,
          agent_id,
          chain,
          contract_address,
          action,
          status,
          erc8004_agent_id::text,
          agent_uri,
          tx_hash,
          error_message,
          metadata_json,
          created_at
        FROM erc8004_sync_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      values
    ),
    pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM erc8004_sync_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `,
      values.slice(0, where.length)
    )
  ]);

  return {
    items: rows.rows.map(mapErc8004SyncRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}

export async function getAuditOverview(): Promise<{
  agentBehaviorLogCount: number;
  x402PaymentLogCount: number;
  tradeLogCount: number;
  onchainTransactionCount: number;
  erc8004SyncLogCount: number;
}> {
  const [behavior, payment, trade, onchain, sync] = await Promise.all([
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM agent_behavior_log`),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM x402_payment_log`),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM market_trade`),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM onchain_transactions`),
    pool.query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM erc8004_sync_log`)
  ]);

  return {
    agentBehaviorLogCount: Number(behavior.rows[0]?.count ?? '0'),
    x402PaymentLogCount: Number(payment.rows[0]?.count ?? '0'),
    tradeLogCount: Number(trade.rows[0]?.count ?? '0'),
    onchainTransactionCount: Number(onchain.rows[0]?.count ?? '0'),
    erc8004SyncLogCount: Number(sync.rows[0]?.count ?? '0')
  };
}
