import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { GameAction } from '@tactical/shared-types';
import { applyAction, createGame, getGame, listEvents } from './repository.js';
import { HttpError } from '../utils/http-error.js';
import type { RealtimeHub } from '../realtime/hub.js';
import type { MarketService } from '../markets/service.js';

const createGameSchema = z.object({
  humanCount: z.number().int().min(1).max(8).default(1),
  aiCount: z.number().int().min(0).max(32).default(7),
  mode: z.string().default('online'),
  language: z.enum(['zh', 'en']).optional(),
  agentSnapshots: z
    .array(
      z.object({
        agentId: z.string().min(1).max(128),
        kind: z.enum(['user', 'bot']),
        displayName: z.string().min(1).max(128),
        accountIdentifier: z.string().min(1).max(160).optional(),
        walletAddress: z
          .string()
          .regex(/^0x[a-fA-F0-9]{40}$/)
          .optional()
          .nullable(),
        prompt: z.string().min(1).max(4000).optional().nullable(),
        persistentAssets: z.record(z.string(), z.unknown()).optional()
      })
    )
    .max(16)
    .optional()
})
  .superRefine((value, ctx) => {
    if (!value.agentSnapshots?.length) return;
    const ids = new Set<string>();
    for (const [index, snapshot] of value.agentSnapshots.entries()) {
      if (ids.has(snapshot.agentId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['agentSnapshots', index, 'agentId'],
          message: 'Duplicate agentId in agentSnapshots.'
        });
        continue;
      }
      ids.add(snapshot.agentId);
    }
  });

const gameIdParamsSchema = z.object({
  gameId: z.string().uuid()
});

const listEventsQuerySchema = z.object({
  fromSeq: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(500).default(100)
});

const actionSchema = z
  .object({
    type: z.string().min(1)
  })
  .passthrough();

const applyActionSchema = z.object({
  action: actionSchema,
  expectedSeq: z.number().int().min(0).optional(),
  clientActionId: z.string().min(1).max(128).optional()
});

export async function registerGameRoutes(
  app: FastifyInstance,
  hub: RealtimeHub,
  marketService: MarketService
) {
  const scheduleResolveRetry = (input: {
    gameId: string;
    winnerPlayerId?: string;
    requestId?: string;
    attempt: number;
    maxAttempts: number;
  }) => {
    const delayMs = Math.min(1_000 * input.attempt, 5_000);
    setTimeout(() => {
      void marketService
        .resolveRoundForGame({
          gameId: input.gameId,
          winnerPlayerId: input.winnerPlayerId,
          skipIfNotOpened: true
        })
        .then((mapping) => {
          if (mapping) {
            app.log.info(
              {
                requestId: input.requestId,
                gameId: input.gameId,
                roundId: mapping.roundId,
                resolveTxHash: mapping.resolveTxHash,
                attempt: input.attempt
              },
              'Market auto-resolve succeeded'
            );
          }
        })
        .catch((error) => {
          if (error instanceof HttpError && error.statusCode === 409) {
            app.log.info(
              {
                error: error.message,
                requestId: input.requestId,
                gameId: input.gameId,
                attempt: input.attempt
              },
              'Market auto-resolve deferred (round not closed yet)'
            );
          } else {
            app.log.error(
              { error, requestId: input.requestId, gameId: input.gameId, attempt: input.attempt },
              'Market auto-resolve failed'
            );
          }
          if (input.attempt < input.maxAttempts) {
            scheduleResolveRetry({
              ...input,
              attempt: input.attempt + 1
            });
          }
        });
    }, delayMs);
  };

  app.post('/api/games', async (request, reply) => {
    const body = createGameSchema.parse(request.body);
    const game = await createGame(body);
    let market: Awaited<ReturnType<MarketService['openRoundForGame']>> | null = null;
    let marketOpenError: string | null = null;

    if (marketService.enabled && body.mode === 'online') {
      request.log.info(
        {
          gameId: game.gameId,
          mode: body.mode
        },
        'Market auto-open requested for new game'
      );
      try {
        market = await marketService.openRoundForGame({ gameId: game.gameId });
        request.log.info(
          {
            gameId: game.gameId,
            roundId: market.roundId,
            marketAddress: market.marketAddress,
            chainId: market.chainId,
            syncStatus: market.syncStatus
          },
          'Market auto-open succeeded for new game'
        );
      } catch (error) {
        marketOpenError = error instanceof Error ? error.message : 'Failed to auto-open market.';
        request.log.error(
          { err: error, gameId: game.gameId, mode: body.mode, marketOpenError },
          'Failed to auto-open market for newly created game'
        );
      }
    }

    reply.code(201).send({
      gameId: game.gameId,
      seq: game.seq,
      state: game.state,
      status: game.status,
      market,
      marketOpenError
    });
  });

  app.get('/api/games/:gameId', async (request, reply) => {
    const { gameId } = gameIdParamsSchema.parse(request.params);
    const game = await getGame(gameId);
    reply.send({
      gameId: game.gameId,
      seq: game.seq,
      state: game.state,
      status: game.status,
      updatedAt: game.updatedAt
    });
  });

  app.post('/api/games/:gameId/actions', async (request, reply) => {
    const { gameId } = gameIdParamsSchema.parse(request.params);
    const body = applyActionSchema.parse(request.body);

    const result = await applyAction({
      gameId,
      action: body.action as GameAction,
      expectedSeq: body.expectedSeq,
      clientActionId: body.clientActionId
    });

    hub.broadcastAction(gameId, result);

    if (result.state.phase === 'GAME_OVER') {
      hub.broadcastGameOver(gameId, {
        gameId,
        winnerPlayerId: result.state.winner?.id ?? null,
        seq: result.seq
      });

      if (marketService.enabled) {
        scheduleResolveRetry({
          gameId,
          winnerPlayerId: result.state.winner?.id,
          requestId: request.id,
          attempt: 1,
          maxAttempts: 3
        });
      }
    }

    reply.send(result);
  });

  app.get('/api/games/:gameId/events', async (request, reply) => {
    const { gameId } = gameIdParamsSchema.parse(request.params);
    const query = listEventsQuerySchema.parse(request.query);
    const data = await listEvents({
      gameId,
      fromSeq: query.fromSeq,
      limit: query.limit
    });
    reply.send(data);
  });

  app.setErrorHandler((error, request, reply) => {
    if (error instanceof HttpError) {
      reply.code(error.statusCode).send({ error: error.message });
      return;
    }
    if (error instanceof z.ZodError) {
      reply.code(400).send({ error: 'Invalid request', details: error.issues });
      return;
    }
    request.log.error(error);
    reply.code(500).send({ error: 'Internal server error' });
  });
}
