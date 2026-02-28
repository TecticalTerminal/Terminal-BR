import { createDecipheriv, createHash } from 'node:crypto';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';
import { CastErc8004Client } from './cast-client.js';
import { discoverAgents, type DiscoveredAgentView } from './discovery.js';

interface AgentSyncRow {
  id: string;
  erc8004_agent_id: string | null;
  wallet_address: string | null;
  custody_mode: 'server_managed' | 'external_signer' | null;
  encrypted_private_key: string | null;
  metadata_json: unknown;
}

function normalizeMetadata(input: unknown): Record<string, unknown> {
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    return input as Record<string, unknown>;
  }
  return {};
}

function masterKeyBuffer(): Buffer {
  const raw = env.WALLET_ENCRYPTION_KEY.trim();
  if (/^(0x)?[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw.replace(/^0x/, ''), 'hex');
  }
  return createHash('sha256').update(raw).digest();
}

function decryptPrivateKey(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new HttpError(500, 'Invalid encrypted private key payload.');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', masterKeyBuffer(), iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  if (!/^0x[a-fA-F0-9]{64}$/.test(plaintext)) {
    throw new HttpError(500, 'Decrypted private key is invalid.');
  }
  return plaintext;
}

function resolveAgentUri(row: AgentSyncRow, override?: string): string {
  const explicit = override?.trim();
  if (explicit) return explicit;

  const metadata = normalizeMetadata(row.metadata_json);
  const metadataUri = metadata.erc8004AgentUri;
  if (typeof metadataUri === 'string' && metadataUri.trim()) {
    return metadataUri.trim();
  }

  const base = env.ERC8004_AGENT_URI_BASE.trim() || 'https://terminal.local/agents';
  return `${base.replace(/\/+$/, '')}/${row.id}.json`;
}

async function loadAgentForSync(agentId: string): Promise<AgentSyncRow> {
  const result = await pool.query<AgentSyncRow>(
    `
      SELECT
        a.id,
        a.erc8004_agent_id::text,
        w.address AS wallet_address,
        w.custody_mode,
        w.encrypted_private_key,
        p.metadata_json
      FROM agent a
      LEFT JOIN agent_wallet w ON w.agent_id = a.id
      LEFT JOIN agent_profile p ON p.agent_id = a.id
      WHERE a.id = $1
      LIMIT 1
    `,
    [agentId]
  );
  if (!result.rowCount) {
    throw new HttpError(404, `Agent not found: ${agentId}`);
  }
  return result.rows[0];
}

async function insertSyncLog(input: {
  agentId?: string;
  action: 'register' | 'update_agent_uri' | 'discover' | 'discover_fetch';
  status: 'pending' | 'confirmed' | 'failed' | 'skipped' | 'dry_run';
  erc8004AgentId?: string | null;
  agentUri?: string | null;
  txHash?: string | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO erc8004_sync_log (
        id,
        agent_id,
        chain,
        contract_address,
        action,
        status,
        erc8004_agent_id,
        agent_uri,
        tx_hash,
        error_message,
        metadata_json
      ) VALUES (
        $1,
        $2,
        $3,
        $4,
        $5,
        $6,
        $7::numeric,
        $8,
        $9,
        $10,
        $11::jsonb
      )
    `,
    [
      uuidv4(),
      input.agentId ?? null,
      `eip155:${env.ERC8004_CHAIN_ID_EXPECTED}`,
      env.ERC8004_IDENTITY_CONTRACT ?? '0x0000000000000000000000000000000000000000',
      input.action,
      input.status,
      input.erc8004AgentId ?? null,
      input.agentUri ?? null,
      input.txHash ?? null,
      input.errorMessage ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

async function insertOnchainTx(input: {
  txHash: string;
  operation: string;
  status: 'pending' | 'confirmed' | 'failed';
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await pool.query(
    `
      INSERT INTO onchain_transactions (
        id,
        tx_hash,
        chain,
        operation,
        status,
        metadata
      ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
      ON CONFLICT (tx_hash) DO UPDATE
      SET status = EXCLUDED.status,
          metadata = EXCLUDED.metadata,
          updated_at = NOW()
    `,
    [
      uuidv4(),
      input.txHash,
      `eip155:${env.ERC8004_CHAIN_ID_EXPECTED}`,
      input.operation,
      input.status,
      JSON.stringify(input.metadata ?? {})
    ]
  );
}

function buildCastClient(): CastErc8004Client {
  if (!env.ERC8004_RPC_URL || !env.ERC8004_IDENTITY_CONTRACT) {
    throw new HttpError(503, 'ERC-8004 adapter config missing (RPC or contract).');
  }
  return new CastErc8004Client(env.ERC8004_RPC_URL, env.ERC8004_IDENTITY_CONTRACT);
}

function assertServerManagedPrivateKey(row: AgentSyncRow): string {
  if (row.custody_mode !== 'server_managed') {
    throw new HttpError(409, `Agent wallet custody mode must be server_managed. current=${row.custody_mode ?? 'none'}`);
  }
  if (!row.encrypted_private_key) {
    throw new HttpError(409, 'Managed wallet private key payload missing.');
  }
  return decryptPrivateKey(row.encrypted_private_key);
}

export interface SyncAgentUriInput {
  agentId: string;
  agentUri?: string;
  registerIfMissing?: boolean;
  dryRun?: boolean;
}

export interface SyncAgentUriResult {
  enabled: boolean;
  action: 'register' | 'update_agent_uri' | 'skip';
  status: 'confirmed' | 'skipped' | 'dry_run';
  reason?: string;
  agentId: string;
  erc8004AgentId: string | null;
  agentUri: string;
  txHash: string | null;
}

export async function syncAgentUri(input: SyncAgentUriInput): Promise<SyncAgentUriResult> {
  const row = await loadAgentForSync(input.agentId);
  const agentUri = resolveAgentUri(row, input.agentUri);
  const registerIfMissing = input.registerIfMissing ?? false;
  const dryRun = input.dryRun ?? false;

  if (!env.ERC8004_ENABLED) {
    await insertSyncLog({
      agentId: row.id,
      action: 'update_agent_uri',
      status: 'skipped',
      erc8004AgentId: row.erc8004_agent_id,
      agentUri,
      errorMessage: 'ERC8004 adapter disabled'
    });
    return {
      enabled: false,
      action: 'skip',
      status: 'skipped',
      reason: 'ERC8004 adapter disabled',
      agentId: row.id,
      erc8004AgentId: row.erc8004_agent_id,
      agentUri,
      txHash: null
    };
  }

  const action: 'register' | 'update_agent_uri' | 'skip' = row.erc8004_agent_id
    ? 'update_agent_uri'
    : registerIfMissing
      ? 'register'
      : 'skip';

  if (dryRun) {
    await insertSyncLog({
      agentId: row.id,
      action: action === 'skip' ? 'update_agent_uri' : action,
      status: 'dry_run',
      erc8004AgentId: row.erc8004_agent_id,
      agentUri,
      metadata: { registerIfMissing }
    });
    return {
      enabled: true,
      action,
      status: 'dry_run',
      reason: action === 'skip' ? 'Missing erc8004AgentId and registerIfMissing=false' : undefined,
      agentId: row.id,
      erc8004AgentId: row.erc8004_agent_id,
      agentUri,
      txHash: null
    };
  }

  if (action === 'skip') {
    await insertSyncLog({
      agentId: row.id,
      action: 'update_agent_uri',
      status: 'skipped',
      erc8004AgentId: row.erc8004_agent_id,
      agentUri,
      errorMessage: 'Missing erc8004AgentId and registerIfMissing=false'
    });
    return {
      enabled: true,
      action,
      status: 'skipped',
      reason: 'Missing erc8004AgentId and registerIfMissing=false',
      agentId: row.id,
      erc8004AgentId: row.erc8004_agent_id,
      agentUri,
      txHash: null
    };
  }

  const castClient = buildCastClient();
  const chainId = await castClient.chainId();
  if (chainId !== env.ERC8004_CHAIN_ID_EXPECTED) {
    throw new HttpError(
      409,
      `ERC8004 chain mismatch. expected=${env.ERC8004_CHAIN_ID_EXPECTED} actual=${chainId}`
    );
  }

  const privateKey = assertServerManagedPrivateKey(row);
  let txHash: string | null = null;
  let erc8004AgentId = row.erc8004_agent_id;

  try {
    if (action === 'register') {
      const supplyBefore = BigInt(await castClient.totalSupply());
      txHash = await castClient.register(agentUri, privateKey);
      await insertOnchainTx({
        txHash,
        operation: 'erc8004.register',
        status: 'confirmed',
        metadata: { agentId: row.id, agentUri }
      });
      const supplyAfter = BigInt(await castClient.totalSupply());
      if (supplyAfter <= supplyBefore) {
        throw new HttpError(502, 'ERC8004 register tx confirmed but token id could not be inferred.');
      }
      erc8004AgentId = supplyAfter.toString();
      await pool.query(
        `
          UPDATE agent
          SET erc8004_agent_id = $2::numeric,
              updated_at = NOW()
          WHERE id = $1
        `,
        [row.id, erc8004AgentId]
      );
    } else {
      txHash = await castClient.updateAgentURI(row.erc8004_agent_id!, agentUri, privateKey);
      await insertOnchainTx({
        txHash,
        operation: 'erc8004.updateAgentURI',
        status: 'confirmed',
        metadata: { agentId: row.id, erc8004AgentId: row.erc8004_agent_id, agentUri }
      });
    }

    await insertSyncLog({
      agentId: row.id,
      action,
      status: 'confirmed',
      erc8004AgentId,
      agentUri,
      txHash
    });

    return {
      enabled: true,
      action,
      status: 'confirmed',
      agentId: row.id,
      erc8004AgentId,
      agentUri,
      txHash
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'ERC8004 sync failed';
    if (txHash) {
      await insertOnchainTx({
        txHash,
        operation: action === 'register' ? 'erc8004.register' : 'erc8004.updateAgentURI',
        status: 'failed',
        metadata: { agentId: row.id, error: message }
      });
    }
    await insertSyncLog({
      agentId: row.id,
      action,
      status: 'failed',
      erc8004AgentId,
      agentUri,
      txHash,
      errorMessage: message
    });
    throw error;
  }
}

export interface DiscoverErc8004Input {
  limit: number;
  refresh?: boolean;
}

export async function discoverErc8004Agents(input: DiscoverErc8004Input): Promise<{
  enabled: boolean;
  chainId: number;
  contractAddress: string;
  totalSupply: string;
  scanned: number;
  items: DiscoveredAgentView[];
}> {
  if (!env.ERC8004_ENABLED) {
    return {
      enabled: false,
      chainId: env.ERC8004_CHAIN_ID_EXPECTED,
      contractAddress: env.ERC8004_IDENTITY_CONTRACT ?? '0x0000000000000000000000000000000000000000',
      totalSupply: '0',
      scanned: 0,
      items: []
    };
  }

  const castClient = buildCastClient();
  const chainId = await castClient.chainId();
  if (chainId !== env.ERC8004_CHAIN_ID_EXPECTED) {
    throw new HttpError(
      409,
      `ERC8004 chain mismatch. expected=${env.ERC8004_CHAIN_ID_EXPECTED} actual=${chainId}`
    );
  }

  const result = await discoverAgents({
    castClient,
    chainId,
    contractAddress: env.ERC8004_IDENTITY_CONTRACT!,
    limit: input.limit,
    refresh: input.refresh ?? false
  });

  await insertSyncLog({
    action: 'discover',
    status: 'confirmed',
    metadata: {
      chainId,
      contractAddress: env.ERC8004_IDENTITY_CONTRACT,
      scanned: result.scanned,
      totalSupply: result.totalSupply
    }
  });

  return {
    enabled: true,
    chainId,
    contractAddress: env.ERC8004_IDENTITY_CONTRACT!,
    totalSupply: result.totalSupply,
    scanned: result.scanned,
    items: result.items
  };
}
