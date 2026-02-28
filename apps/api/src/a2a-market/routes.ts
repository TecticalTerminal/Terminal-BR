import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runAutonomousOneShotTrade } from './autonomous.js';
import {
  buyListing,
  cancelListing,
  createListing,
  expireDueListings,
  getListing,
  getTradeByListing,
  listListings,
  listTrades
} from './repository.js';

const listingIdParamSchema = z.object({
  listingId: z.string().uuid()
});

const createListingSchema = z.object({
  sellerAgentId: z.string().uuid(),
  assetId: z.string().trim().min(1).max(128),
  quantity: z.number().int().positive().default(1),
  unitPrice: z.string().regex(/^\d+$/),
  feeBps: z.number().int().min(0).max(10_000).optional(),
  expiresInSeconds: z.number().int().positive().max(30 * 24 * 3600).optional().nullable(),
  gameId: z.string().uuid().optional().nullable()
});

const cancelListingSchema = z.object({
  requesterAgentId: z.string().uuid(),
  gameId: z.string().uuid().optional().nullable()
});

const buyListingSchema = z.object({
  buyerAgentId: z.string().uuid(),
  gameId: z.string().uuid().optional().nullable(),
  txRef: z.string().trim().min(1).max(128).optional().nullable()
});

const listListingsQuerySchema = z.object({
  status: z.enum(['open', 'filled', 'cancelled', 'expired']).optional(),
  sellerAgentId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const listTradesQuerySchema = z.object({
  agentId: z.string().uuid().optional(),
  listingId: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

const autoOneShotSchema = z.object({
  clientRunId: z.string().trim().min(1).max(128).optional(),
  sellerAgentId: z.string().uuid().optional(),
  buyerAgentId: z.string().uuid().optional(),
  gameId: z.string().uuid().optional().nullable(),
  assetId: z.string().trim().min(1).max(128).optional(),
  quantity: z.number().int().positive().max(100).optional(),
  unitPrice: z.string().regex(/^\d+$/).optional(),
  feeBps: z.number().int().min(0).max(10_000).optional(),
  maxBuyUnitPrice: z.string().regex(/^\d+$/).optional(),
  autoSeed: z.boolean().optional(),
  buyerCreditsTarget: z.string().regex(/^\d+$/).optional(),
  sellerEquipmentTarget: z.string().regex(/^\d+$/).optional()
});

export async function registerA2aMarketRoutes(app: FastifyInstance) {
  app.post('/api/a2a-market/listings', async (request, reply) => {
    const body = createListingSchema.parse(request.body);
    const listing = await createListing(body);
    reply.code(201).send(listing);
  });

  app.get('/api/a2a-market/listings', async (request, reply) => {
    const query = listListingsQuerySchema.parse(request.query);
    const data = await listListings(query);
    reply.send(data);
  });

  app.get('/api/a2a-market/listings/:listingId', async (request, reply) => {
    const { listingId } = listingIdParamSchema.parse(request.params);
    const listing = await getListing(listingId);
    reply.send(listing);
  });

  app.post('/api/a2a-market/listings/:listingId/cancel', async (request, reply) => {
    const { listingId } = listingIdParamSchema.parse(request.params);
    const body = cancelListingSchema.parse(request.body);
    const listing = await cancelListing({
      listingId,
      requesterAgentId: body.requesterAgentId,
      gameId: body.gameId
    });
    reply.send(listing);
  });

  app.post('/api/a2a-market/listings/:listingId/buy', async (request, reply) => {
    const { listingId } = listingIdParamSchema.parse(request.params);
    const body = buyListingSchema.parse(request.body);
    const result = await buyListing({
      listingId,
      buyerAgentId: body.buyerAgentId,
      gameId: body.gameId,
      txRef: body.txRef
    });
    reply.send(result);
  });

  app.post('/api/a2a-market/expire', async (_request, reply) => {
    const result = await expireDueListings();
    reply.send(result);
  });

  app.get('/api/a2a-market/trades', async (request, reply) => {
    const query = listTradesQuerySchema.parse(request.query);
    const data = await listTrades(query);
    reply.send(data);
  });

  app.get('/api/a2a-market/listings/:listingId/trade', async (request, reply) => {
    const { listingId } = listingIdParamSchema.parse(request.params);
    const trade = await getTradeByListing(listingId);
    reply.send(trade);
  });

  app.post('/api/a2a-market/auto/one-shot', async (request, reply) => {
    const body = autoOneShotSchema.parse(request.body ?? {});
    const result = await runAutonomousOneShotTrade(body);
    reply.send(result);
  });
}
