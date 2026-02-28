import { createHash } from 'node:crypto';
import { pool } from '../db/pool.js';
import { env } from '../config.js';
import { CastErc8004Client } from './cast-client.js';

export interface AgentCard {
  name: string;
  type?: string;
  description?: string;
  address?: string;
  services?: Array<{
    name: string;
    endpoint: string;
    [key: string]: unknown;
  }>;
  [key: string]: unknown;
}

export interface DiscoveredAgentView {
  chainId: number;
  contractAddress: string;
  tokenId: string;
  owner: string;
  agentUri: string;
  card: AgentCard | null;
  cached: boolean;
}

interface CacheRow {
  chain_id: number;
  contract_address: string;
  token_id: string;
  owner_address: string;
  agent_uri: string;
  agent_card: unknown;
  valid_until: string | Date | null;
}

const MAX_NAME_LENGTH = 128;
const MAX_DESCRIPTION_LENGTH = 2000;
const MAX_SERVICES_COUNT = 20;
const MAX_SERVICE_NAME_LENGTH = 64;
const MAX_SERVICE_ENDPOINT_LENGTH = 512;

export function isInternalNetwork(hostname: string): boolean {
  const blocked = [
    /^127\./,
    /^10\./,
    /^172\.(1[6-9]|2\d|3[01])\./,
    /^192\.168\./,
    /^169\.254\./,
    /^::1$/,
    /^localhost$/i,
    /^0\./
  ];
  return blocked.some((pattern) => pattern.test(hostname));
}

export function isAllowedUri(uri: string): boolean {
  try {
    const url = new URL(uri);
    if (url.protocol !== 'https:' && url.protocol !== 'ipfs:') return false;
    if (url.protocol === 'https:' && isInternalNetwork(url.hostname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function validateAgentCard(data: unknown): AgentCard | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const card = data as Record<string, unknown>;
  if (typeof card.name !== 'string' || !card.name.trim() || card.name.length > MAX_NAME_LENGTH) {
    return null;
  }

  if (card.description !== undefined) {
    if (typeof card.description !== 'string' || card.description.length > MAX_DESCRIPTION_LENGTH) {
      return null;
    }
  }

  if (card.services !== undefined) {
    if (!Array.isArray(card.services) || card.services.length > MAX_SERVICES_COUNT) {
      return null;
    }
    for (const service of card.services) {
      if (!service || typeof service !== 'object' || Array.isArray(service)) return null;
      const maybe = service as Record<string, unknown>;
      if (
        typeof maybe.name !== 'string' ||
        maybe.name.length > MAX_SERVICE_NAME_LENGTH ||
        typeof maybe.endpoint !== 'string' ||
        maybe.endpoint.length > MAX_SERVICE_ENDPOINT_LENGTH
      ) {
        return null;
      }
    }
  }

  return card as AgentCard;
}

function resolveFetchUrl(uri: string): string {
  if (uri.startsWith('ipfs://')) {
    const cid = uri.slice('ipfs://'.length);
    const gateway = env.ERC8004_IPFS_GATEWAY.replace(/\/+$/, '');
    return `${gateway}/ipfs/${cid}`;
  }
  return uri;
}

function toCardHash(card: AgentCard): string {
  return createHash('sha256').update(JSON.stringify(card)).digest('hex');
}

async function getCachedCard(
  chainId: number,
  contractAddress: string,
  tokenId: string
): Promise<{ row: CacheRow; card: AgentCard } | null> {
  const result = await pool.query<CacheRow>(
    `
      SELECT
        chain_id,
        contract_address,
        token_id::text,
        owner_address,
        agent_uri,
        agent_card,
        valid_until
      FROM discovered_agents_cache
      WHERE chain_id = $1
        AND contract_address = $2
        AND token_id = $3::numeric
      LIMIT 1
    `,
    [chainId, contractAddress, tokenId]
  );
  if (!result.rowCount) return null;

  const row = result.rows[0];
  if (row.valid_until && new Date(row.valid_until).getTime() < Date.now()) {
    return null;
  }
  const card = validateAgentCard(row.agent_card);
  if (!card) return null;
  return { row, card };
}

async function upsertDiscoveredCache(input: {
  chainId: number;
  contractAddress: string;
  tokenId: string;
  ownerAddress: string;
  agentUri: string;
  fetchedFrom: string;
  card: AgentCard;
}): Promise<void> {
  const validUntil = new Date(Date.now() + env.ERC8004_DISCOVERY_CACHE_TTL_SECONDS * 1000);
  await pool.query(
    `
      INSERT INTO discovered_agents_cache (
        chain_id,
        contract_address,
        token_id,
        agent_address,
        owner_address,
        agent_uri,
        agent_card,
        fetched_from,
        card_hash,
        valid_until,
        fetch_count,
        last_fetched_at,
        updated_at
      ) VALUES (
        $1,
        $2,
        $3::numeric,
        $4,
        $5,
        $6,
        $7::jsonb,
        $8,
        $9,
        $10,
        1,
        NOW(),
        NOW()
      )
      ON CONFLICT (chain_id, contract_address, token_id)
      DO UPDATE
      SET agent_address = EXCLUDED.agent_address,
          owner_address = EXCLUDED.owner_address,
          agent_uri = EXCLUDED.agent_uri,
          agent_card = EXCLUDED.agent_card,
          fetched_from = EXCLUDED.fetched_from,
          card_hash = EXCLUDED.card_hash,
          valid_until = EXCLUDED.valid_until,
          fetch_count = discovered_agents_cache.fetch_count + 1,
          last_fetched_at = NOW(),
          updated_at = NOW()
    `,
    [
      input.chainId,
      input.contractAddress,
      input.tokenId,
      input.ownerAddress,
      input.ownerAddress,
      input.agentUri,
      JSON.stringify(input.card),
      input.fetchedFrom,
      toCardHash(input.card),
      validUntil.toISOString()
    ]
  );
}

async function fetchAgentCard(agentUri: string): Promise<AgentCard | null> {
  if (!isAllowedUri(agentUri)) return null;
  const fetchUrl = resolveFetchUrl(agentUri);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), env.ERC8004_DISCOVERY_FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(fetchUrl, {
      method: 'GET',
      signal: controller.signal
    });
    if (!response.ok) return null;
    const body = await response.text();
    if (body.length > 512 * 1024) return null;

    const parsed = JSON.parse(body) as unknown;
    return validateAgentCard(parsed);
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

export async function discoverAgents(input: {
  castClient: CastErc8004Client;
  chainId: number;
  contractAddress: string;
  limit: number;
  refresh?: boolean;
}): Promise<{
  totalSupply: string;
  scanned: number;
  items: DiscoveredAgentView[];
}> {
  const totalSupply = await input.castClient.totalSupply();
  const total = Number(totalSupply);
  const scanCount = Math.min(total, input.limit, env.ERC8004_DISCOVERY_MAX_SCAN);
  const items: DiscoveredAgentView[] = [];

  for (let offset = 0; offset < scanCount; offset += 1) {
    const tokenId = String(total - offset);
    try {
      const owner = await input.castClient.ownerOf(tokenId);
      const agentUri = await input.castClient.agentURI(tokenId);

      if (!agentUri) {
        items.push({
          chainId: input.chainId,
          contractAddress: input.contractAddress,
          tokenId,
          owner,
          agentUri,
          card: null,
          cached: false
        });
        continue;
      }

      if (!input.refresh) {
        const cached = await getCachedCard(input.chainId, input.contractAddress, tokenId);
        if (cached && cached.row.agent_uri === agentUri) {
          items.push({
            chainId: input.chainId,
            contractAddress: input.contractAddress,
            tokenId,
            owner,
            agentUri,
            card: cached.card,
            cached: true
          });
          continue;
        }
      }

      const card = await fetchAgentCard(agentUri);
      if (card) {
        await upsertDiscoveredCache({
          chainId: input.chainId,
          contractAddress: input.contractAddress,
          tokenId,
          ownerAddress: owner,
          agentUri,
          fetchedFrom: agentUri,
          card
        });
      }

      items.push({
        chainId: input.chainId,
        contractAddress: input.contractAddress,
        tokenId,
        owner,
        agentUri,
        card,
        cached: false
      });
    } catch {
      continue;
    }
  }

  return {
    totalSupply,
    scanned: scanCount,
    items
  };
}
