import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { discoverErc8004Agents, syncAgentUri } from './service.js';

const agentIdParamSchema = z.object({
  agentId: z.string().uuid()
});

const syncAgentUriBodySchema = z.object({
  agentUri: z.string().url().optional(),
  registerIfMissing: z.boolean().optional(),
  dryRun: z.boolean().optional()
});

const discoverQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(20),
  refresh: z.coerce.boolean().default(false)
});

export async function registerErc8004Routes(app: FastifyInstance) {
  app.get('/api/erc8004/config', async (_request, reply) => {
    reply.send({
      enabled: env.ERC8004_ENABLED,
      rpcUrl: env.ERC8004_ENABLED ? env.ERC8004_RPC_URL : null,
      chainIdExpected: env.ERC8004_CHAIN_ID_EXPECTED,
      identityContract: env.ERC8004_IDENTITY_CONTRACT ?? null,
      discovery: {
        maxScan: env.ERC8004_DISCOVERY_MAX_SCAN,
        cacheTtlSeconds: env.ERC8004_DISCOVERY_CACHE_TTL_SECONDS,
        fetchTimeoutMs: env.ERC8004_DISCOVERY_FETCH_TIMEOUT_MS,
        ipfsGateway: env.ERC8004_IPFS_GATEWAY
      }
    });
  });

  app.post('/api/erc8004/agents/:agentId/sync-uri', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = syncAgentUriBodySchema.parse(request.body ?? {});
    const result = await syncAgentUri({
      agentId,
      agentUri: body.agentUri,
      registerIfMissing: body.registerIfMissing,
      dryRun: body.dryRun
    });
    reply.send(result);
  });

  app.get('/api/erc8004/discover', async (request, reply) => {
    const query = discoverQuerySchema.parse(request.query);
    const result = await discoverErc8004Agents({
      limit: query.limit,
      refresh: query.refresh
    });
    reply.send(result);
  });
}
