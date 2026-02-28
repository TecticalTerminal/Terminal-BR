import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  getAuditOverview,
  listAgentBehaviorLogs,
  listAuditErc8004SyncLogs,
  listAuditOnchainTransactions,
  listAuditPaymentLogs,
  listAuditTradeLogs
} from './repository.js';

const pagingSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const behaviorQuerySchema = pagingSchema.extend({
  agentId: z.string().uuid().optional(),
  gameId: z.string().uuid().optional(),
  eventSource: z.enum(['game_action', 'lifecycle', 'market', 'system']).optional(),
  eventType: z.string().trim().min(1).max(128).optional()
});

const paymentQuerySchema = pagingSchema.extend({
  source: z.enum(['x402', 'ledger']).optional(),
  agentId: z.string().uuid().optional(),
  gameId: z.string().uuid().optional()
});

const tradeQuerySchema = pagingSchema.extend({
  agentId: z.string().uuid().optional(),
  listingId: z.string().uuid().optional()
});

const onchainQuerySchema = pagingSchema.extend({
  status: z.enum(['pending', 'confirmed', 'failed']).optional(),
  operation: z.string().trim().min(1).max(128).optional()
});

const erc8004SyncQuerySchema = pagingSchema.extend({
  agentId: z.string().uuid().optional(),
  status: z.enum(['pending', 'confirmed', 'failed', 'skipped', 'dry_run']).optional(),
  action: z.enum(['register', 'update_agent_uri', 'discover', 'discover_fetch']).optional()
});

export async function registerAuditRoutes(app: FastifyInstance) {
  app.get('/api/audit/overview', async (_request, reply) => {
    const result = await getAuditOverview();
    reply.send(result);
  });

  app.get('/api/audit/agent-behaviors', async (request, reply) => {
    const query = behaviorQuerySchema.parse(request.query);
    const result = await listAgentBehaviorLogs(query);
    reply.send(result);
  });

  app.get('/api/audit/payments', async (request, reply) => {
    const query = paymentQuerySchema.parse(request.query);
    const result = await listAuditPaymentLogs(query);
    reply.send(result);
  });

  app.get('/api/audit/trades', async (request, reply) => {
    const query = tradeQuerySchema.parse(request.query);
    const result = await listAuditTradeLogs(query);
    reply.send(result);
  });

  app.get('/api/audit/onchain-transactions', async (request, reply) => {
    const query = onchainQuerySchema.parse(request.query);
    const result = await listAuditOnchainTransactions(query);
    reply.send(result);
  });

  app.get('/api/audit/erc8004-sync', async (request, reply) => {
    const query = erc8004SyncQuerySchema.parse(request.query);
    const result = await listAuditErc8004SyncLogs(query);
    reply.send(result);
  });
}
