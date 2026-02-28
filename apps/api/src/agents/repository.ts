import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';

export type AgentStatus = 'active' | 'dead' | 'respawning';

export interface AgentWalletView {
  id: string;
  custodyMode: 'server_managed' | 'external_signer';
  address: string;
  encryptedPrivateKey: string | null;
  kmsKeyId: string | null;
  signerPolicyJson: Record<string, unknown> | null;
  lastKnownNonce: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AgentProfileView {
  displayName: string;
  avatarUri: string | null;
  promptDefault: string;
  promptOverride: string | null;
  strategyTags: string[];
  metadataJson: Record<string, unknown>;
  profileVersion: number;
  createdAt: string;
  updatedAt: string;
}

export interface AgentPersistentAssetsView {
  currency: Record<string, string>;
}

export interface AgentView {
  id: string;
  kind: 'user' | 'bot';
  status: AgentStatus;
  erc8004AgentId: string | null;
  isEnabled: boolean;
  wallet: AgentWalletView | null;
  profile: AgentProfileView | null;
  persistentAssets: AgentPersistentAssetsView;
  accountIdentifier: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentInput {
  kind: 'user' | 'bot';
  status: AgentStatus;
  erc8004AgentId?: string | null;
  profile: {
    displayName: string;
    avatarUri?: string | null;
    promptDefault: string;
    promptOverride?: string | null;
    strategyTags?: string[];
    metadataJson?: Record<string, unknown>;
  };
  wallet?: {
    custodyMode: 'server_managed' | 'external_signer';
    address: string;
    encryptedPrivateKey?: string | null;
    kmsKeyId?: string | null;
    signerPolicyJson?: Record<string, unknown> | null;
  };
}

export interface ListAgentsFilter {
  kind?: 'user' | 'bot';
  status?: AgentStatus;
}

export interface UpdateAgentProfileInput {
  displayName?: string;
  avatarUri?: string | null;
  promptDefault?: string;
  promptOverride?: string | null;
  strategyTags?: string[];
  metadataJson?: Record<string, unknown>;
}

interface AgentJoinRow {
  agent_id: string;
  kind: 'user' | 'bot';
  status: AgentStatus;
  erc8004_agent_id: string | null;
  is_enabled: boolean;
  agent_created_at: string | Date;
  agent_updated_at: string | Date;
  wallet_row_id: string | null;
  custody_mode: 'server_managed' | 'external_signer' | null;
  address: string | null;
  encrypted_private_key: string | null;
  kms_key_id: string | null;
  signer_policy_json: Record<string, unknown> | null;
  last_known_nonce: string | null;
  wallet_created_at: string | Date | null;
  wallet_updated_at: string | Date | null;
  display_name: string | null;
  avatar_uri: string | null;
  prompt_default: string | null;
  prompt_override: string | null;
  strategy_tags: unknown;
  metadata_json: unknown;
  profile_version: number | null;
  profile_created_at: string | Date | null;
  profile_updated_at: string | Date | null;
}

interface PersistentCurrencyRow {
  agent_id: string;
  asset_id: string;
  balance_after: string | number;
}

const allowedTransitions: Record<AgentStatus, ReadonlySet<AgentStatus>> = {
  active: new Set(['active', 'dead']),
  dead: new Set(['dead', 'respawning']),
  respawning: new Set(['respawning', 'active'])
};

function ensureTransitionAllowed(from: AgentStatus, to: AgentStatus): void {
  if (allowedTransitions[from].has(to)) return;
  throw new HttpError(409, `Invalid lifecycle transition: ${from} -> ${to}`);
}

function normalizeTags(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  return input.filter((item): item is string => typeof item === 'string');
}

function normalizeMetadata(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function emptyPersistentAssets(): AgentPersistentAssetsView {
  return {
    currency: {}
  };
}

function mapAgentRow(
  row: AgentJoinRow,
  persistentAssets: AgentPersistentAssetsView = emptyPersistentAssets()
): AgentView {
  const wallet =
    row.wallet_row_id && row.custody_mode && row.address
      ? {
          id: row.wallet_row_id,
          custodyMode: row.custody_mode,
          address: row.address,
          encryptedPrivateKey: row.encrypted_private_key,
          kmsKeyId: row.kms_key_id,
          signerPolicyJson: row.signer_policy_json,
          lastKnownNonce: row.last_known_nonce,
          createdAt: new Date(row.wallet_created_at!).toISOString(),
          updatedAt: new Date(row.wallet_updated_at!).toISOString()
        }
      : null;

  const profile =
    row.display_name && row.prompt_default && row.profile_version
      ? {
          displayName: row.display_name,
          avatarUri: row.avatar_uri,
          promptDefault: row.prompt_default,
          promptOverride: row.prompt_override,
          strategyTags: normalizeTags(row.strategy_tags),
          metadataJson: normalizeMetadata(row.metadata_json),
          profileVersion: Number(row.profile_version),
          createdAt: new Date(row.profile_created_at!).toISOString(),
          updatedAt: new Date(row.profile_updated_at!).toISOString()
        }
      : null;

  return {
    id: row.agent_id,
    kind: row.kind,
    status: row.status,
    erc8004AgentId: row.erc8004_agent_id,
    isEnabled: row.is_enabled,
    wallet,
    profile,
    persistentAssets,
    accountIdentifier: wallet ? `wallet:${wallet.address.toLowerCase()}` : `agent:${row.agent_id}`,
    createdAt: new Date(row.agent_created_at).toISOString(),
    updatedAt: new Date(row.agent_updated_at).toISOString()
  };
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

function validateWalletForMixedCustody(input: {
  kind: 'user' | 'bot';
  wallet?: CreateAgentInput['wallet'];
}): void {
  const wallet = input.wallet;
  if (!wallet) return;

  if (input.kind === 'user' && wallet.custodyMode !== 'external_signer') {
    throw new HttpError(409, 'Mixed custody mode requires user wallet.custodyMode=external_signer.');
  }
  if (input.kind === 'bot' && wallet.custodyMode !== 'server_managed') {
    throw new HttpError(409, 'Mixed custody mode requires bot wallet.custodyMode=server_managed.');
  }
  if (wallet.custodyMode === 'external_signer' && wallet.encryptedPrivateKey) {
    throw new HttpError(409, 'external_signer wallet must not include encryptedPrivateKey.');
  }
  if (wallet.custodyMode === 'server_managed' && !wallet.encryptedPrivateKey) {
    throw new HttpError(409, 'server_managed wallet must include encryptedPrivateKey.');
  }
}

const selectClause = `
  SELECT
    a.id AS agent_id,
    a.kind,
    a.status,
    a.erc8004_agent_id,
    a.is_enabled,
    a.created_at AS agent_created_at,
    a.updated_at AS agent_updated_at,
    w.id AS wallet_row_id,
    w.custody_mode,
    w.address,
    w.encrypted_private_key,
    w.kms_key_id,
    w.signer_policy_json,
    w.last_known_nonce,
    w.created_at AS wallet_created_at,
    w.updated_at AS wallet_updated_at,
    p.display_name,
    p.avatar_uri,
    p.prompt_default,
    p.prompt_override,
    p.strategy_tags,
    p.metadata_json,
    p.profile_version,
    p.created_at AS profile_created_at,
    p.updated_at AS profile_updated_at
  FROM agent a
  LEFT JOIN agent_wallet w ON w.agent_id = a.id
  LEFT JOIN agent_profile p ON p.agent_id = a.id
`;

async function loadPersistentAssetsByAgentIds(
  agentIds: string[]
): Promise<Map<string, AgentPersistentAssetsView>> {
  if (!agentIds.length) return new Map();

  const result = await pool.query<PersistentCurrencyRow>(
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

  const map = new Map<string, AgentPersistentAssetsView>();
  for (const row of result.rows) {
    const existing = map.get(row.agent_id) ?? emptyPersistentAssets();
    existing.currency[row.asset_id] = String(row.balance_after);
    map.set(row.agent_id, existing);
  }
  return map;
}

export async function listAgents(filter: ListAgentsFilter): Promise<AgentView[]> {
  const where: string[] = [];
  const values: Array<string> = [];

  if (filter.kind) {
    values.push(filter.kind);
    where.push(`a.kind = $${values.length}`);
  }
  if (filter.status) {
    values.push(filter.status);
    where.push(`a.status = $${values.length}`);
  }

  const sql = `${selectClause}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY a.created_at ASC`;
  const result = await pool.query(sql, values);
  const rows = result.rows.map((row) => row as AgentJoinRow);
  const assetsByAgent = await loadPersistentAssetsByAgentIds(rows.map((row) => row.agent_id));
  return rows.map((row) =>
    mapAgentRow(row, assetsByAgent.get(row.agent_id) ?? emptyPersistentAssets())
  );
}

export async function getAgentById(agentId: string): Promise<AgentView> {
  const result = await pool.query(
    `${selectClause}
     WHERE a.id = $1
     LIMIT 1`,
    [agentId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, `Agent not found: ${agentId}`);
  }
  const assetsByAgent = await loadPersistentAssetsByAgentIds([agentId]);
  return mapAgentRow(
    result.rows[0] as AgentJoinRow,
    assetsByAgent.get(agentId) ?? emptyPersistentAssets()
  );
}

export async function getAgentPersistentAssets(agentId: string): Promise<AgentPersistentAssetsView> {
  const agentExists = await pool.query(
    `SELECT 1
     FROM agent
     WHERE id = $1
     LIMIT 1`,
    [agentId]
  );
  if (!agentExists.rowCount) {
    throw new HttpError(404, `Agent not found: ${agentId}`);
  }

  const assetsByAgent = await loadPersistentAssetsByAgentIds([agentId]);
  return assetsByAgent.get(agentId) ?? emptyPersistentAssets();
}

async function getAgentStatusTx(client: PoolClient, agentId: string): Promise<AgentStatus | null> {
  const result = await client.query<{ status: AgentStatus }>(
    `SELECT status
     FROM agent
     WHERE id = $1
     LIMIT 1`,
    [agentId]
  );
  if (!result.rowCount) return null;
  return result.rows[0].status;
}

async function insertWallet(
  client: PoolClient,
  input: CreateAgentInput['wallet'],
  agentId: string
): Promise<string | null> {
  if (!input) return null;

  const walletId = uuidv4();
  await client.query(
    `INSERT INTO agent_wallet (
       id,
       agent_id,
       custody_mode,
       address,
       encrypted_private_key,
       kms_key_id,
       signer_policy_json
     ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      walletId,
      agentId,
      input.custodyMode,
      input.address,
      input.encryptedPrivateKey ?? null,
      input.kmsKeyId ?? null,
      input.signerPolicyJson ? JSON.stringify(input.signerPolicyJson) : null
    ]
  );
  return walletId;
}

export async function createAgent(input: CreateAgentInput): Promise<AgentView> {
  validateWalletForMixedCustody(input);
  const agentId = uuidv4();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO agent (id, kind, status, erc8004_agent_id, is_enabled)
       VALUES ($1, $2, $3, $4, TRUE)`,
      [agentId, input.kind, input.status, input.erc8004AgentId ?? null]
    );

    const walletId = await insertWallet(client, input.wallet, agentId);
    if (walletId) {
      await client.query(
        `UPDATE agent
         SET wallet_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [agentId, walletId]
      );
    }

    await client.query(
      `INSERT INTO agent_profile (
         agent_id,
         display_name,
         avatar_uri,
         prompt_default,
         prompt_override,
         strategy_tags,
         metadata_json
       ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        agentId,
        input.profile.displayName,
        input.profile.avatarUri ?? null,
        input.profile.promptDefault,
        input.profile.promptOverride ?? null,
        JSON.stringify(input.profile.strategyTags ?? []),
        JSON.stringify(input.profile.metadataJson ?? {})
      ]
    );

    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    mapDbError(error);
  } finally {
    client.release();
  }

  return getAgentById(agentId);
}

export async function updateAgentProfile(
  agentId: string,
  patch: UpdateAgentProfileInput
): Promise<AgentView> {
  const sets: string[] = [];
  const values: Array<unknown> = [agentId];
  let index = 2;

  if (patch.displayName !== undefined) {
    sets.push(`display_name = $${index++}`);
    values.push(patch.displayName);
  }
  if (patch.avatarUri !== undefined) {
    sets.push(`avatar_uri = $${index++}`);
    values.push(patch.avatarUri);
  }
  if (patch.promptDefault !== undefined) {
    sets.push(`prompt_default = $${index++}`);
    values.push(patch.promptDefault);
  }
  if (patch.promptOverride !== undefined) {
    sets.push(`prompt_override = $${index++}`);
    values.push(patch.promptOverride);
  }
  if (patch.strategyTags !== undefined) {
    sets.push(`strategy_tags = $${index++}`);
    values.push(JSON.stringify(patch.strategyTags));
  }
  if (patch.metadataJson !== undefined) {
    sets.push(`metadata_json = $${index++}`);
    values.push(JSON.stringify(patch.metadataJson));
  }

  if (!sets.length) {
    throw new HttpError(400, 'No profile fields to update.');
  }

  sets.push(`profile_version = profile_version + 1`);
  sets.push(`updated_at = NOW()`);

  try {
    const result = await pool.query(
      `UPDATE agent_profile
       SET ${sets.join(', ')}
       WHERE agent_id = $1`,
      values
    );

    if (!result.rowCount) {
      throw new HttpError(404, `Agent profile not found: ${agentId}`);
    }
  } catch (error) {
    mapDbError(error);
  }

  return getAgentById(agentId);
}

export async function updateAgentStatus(
  agentId: string,
  status: AgentStatus
): Promise<AgentView> {
  await transitionAgentStatus(agentId, status);
  return getAgentById(agentId);
}

export async function transitionAgentStatusTx(
  client: PoolClient,
  agentId: string,
  toStatus: AgentStatus,
  options?: {
    allowMissing?: boolean;
  }
): Promise<boolean> {
  const currentStatus = await getAgentStatusTx(client, agentId);
  if (!currentStatus) {
    if (options?.allowMissing) return false;
    throw new HttpError(404, `Agent not found: ${agentId}`);
  }

  ensureTransitionAllowed(currentStatus, toStatus);
  if (currentStatus === toStatus) return true;

  try {
    const result = await client.query(
      `UPDATE agent
       SET status = $2, updated_at = NOW()
       WHERE id = $1`,
      [agentId, toStatus]
    );
    if (!result.rowCount) {
      throw new HttpError(404, `Agent not found: ${agentId}`);
    }
  } catch (error) {
    mapDbError(error);
  }

  return true;
}

export async function transitionAgentStatus(agentId: string, toStatus: AgentStatus): Promise<AgentView> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await transitionAgentStatusTx(client, agentId, toStatus);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  return getAgentById(agentId);
}
