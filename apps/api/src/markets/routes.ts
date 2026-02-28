import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getGame } from '../games/repository.js';
import type { MarketService } from './service.js';

const openMarketSchema = z.object({
  gameId: z.string().uuid(),
  lockSeconds: z.number().int().positive().max(7 * 24 * 3600).optional()
});

const resolveMarketSchema = z.object({
  gameId: z.string().uuid(),
  winnerPlayerId: z.string().min(1).optional()
});

const gameIdParamsSchema = z.object({
  gameId: z.string().uuid()
});

export async function registerMarketRoutes(app: FastifyInstance, marketService: MarketService) {
  app.post('/api/markets/open', async (request, reply) => {
    const body = openMarketSchema.parse(request.body);
    request.log.info(
      {
        gameId: body.gameId,
        lockSeconds: body.lockSeconds ?? null
      },
      'Manual market open requested'
    );
    const mapping = await marketService.openRoundForGame({
      gameId: body.gameId,
      lockSeconds: body.lockSeconds
    });
    request.log.info(
      {
        gameId: body.gameId,
        roundId: mapping.roundId,
        chainId: mapping.chainId,
        syncStatus: mapping.syncStatus
      },
      'Manual market open succeeded'
    );
    reply.code(201).send(mapping);
  });

  app.post('/api/markets/resolve', async (request, reply) => {
    const body = resolveMarketSchema.parse(request.body);
    request.log.info(
      {
        gameId: body.gameId,
        winnerPlayerId: body.winnerPlayerId ?? null
      },
      'Manual market resolve requested'
    );
    const mapping = await marketService.resolveRoundForGame({
      gameId: body.gameId,
      winnerPlayerId: body.winnerPlayerId
    });
    request.log.info(
      {
        gameId: body.gameId,
        resolved: Boolean(mapping?.resolvedAt),
        roundId: mapping?.roundId ?? null,
        resolveTxHash: mapping?.resolveTxHash ?? null,
        syncStatus: mapping?.syncStatus ?? null
      },
      'Manual market resolve completed'
    );
    reply.send(mapping);
  });

  app.get('/api/markets/:gameId', async (request, reply) => {
    const { gameId } = gameIdParamsSchema.parse(request.params);
    const [mapping, game] = await Promise.all([marketService.getMapping(gameId), getGame(gameId)]);
    if (!mapping && marketService.enabled) {
      request.log.warn(
        {
          gameId,
          gameStatus: game.status,
          gameSeq: game.seq
        },
        'Market mapping missing for game (round not opened or open failed)'
      );
    } else if (mapping?.syncStatus === 'failed') {
      request.log.warn(
        {
          gameId,
          roundId: mapping.roundId,
          failureReason: mapping.failureReason
        },
        'Market mapping is in failed status'
      );
    }
    reply.send({
      gameId,
      gameStatus: game.status,
      gameSeq: game.seq,
      winnerPlayerId: game.state.winner?.id ?? null,
      mapping
    });
  });
}
