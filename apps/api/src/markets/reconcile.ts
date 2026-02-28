import type { FastifyBaseLogger } from 'fastify';
import { env } from '../config.js';
import { HttpError } from '../utils/http-error.js';
import { listPendingRoundResolveCandidates } from './repository.js';
import type { MarketService } from './service.js';

export interface MarketResolveReconciler {
  stop: () => void;
  triggerNow: () => void;
}

export function startMarketResolveReconciler(input: {
  log: FastifyBaseLogger;
  marketService: MarketService;
}): MarketResolveReconciler {
  const { log, marketService } = input;

  if (!marketService.enabled) {
    return {
      stop: () => undefined,
      triggerNow: () => undefined
    };
  }

  let running = false;

  const runOnce = async () => {
    if (running) return;
    running = true;
    try {
      const candidates = await listPendingRoundResolveCandidates(env.MARKET_RESOLVE_RECONCILE_BATCH_SIZE);
      if (candidates.length === 0) return;

      log.info(
        {
          candidateCount: candidates.length
        },
        'Market resolve reconciler scanning pending rounds'
      );

      for (const candidate of candidates) {
        try {
          const mapping = await marketService.resolveRoundForGame({
            gameId: candidate.gameId,
            winnerPlayerId: candidate.winnerPlayerId ?? undefined,
            skipIfNotOpened: true
          });
          if (mapping?.resolvedAt) {
            log.info(
              {
                gameId: candidate.gameId,
                roundId: mapping.roundId,
                resolveTxHash: mapping.resolveTxHash,
                syncStatus: mapping.syncStatus
              },
              'Market resolve reconciler resolved pending round'
            );
          }
        } catch (error) {
          if (error instanceof HttpError && error.statusCode === 409) {
            log.debug(
              {
                gameId: candidate.gameId,
                reason: error.message
              },
              'Market resolve reconciler deferred round (not ready yet)'
            );
            continue;
          }
          log.error(
            {
              error,
              gameId: candidate.gameId
            },
            'Market resolve reconciler failed to resolve pending round'
          );
        }
      }
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void runOnce();
  }, env.MARKET_RESOLVE_RECONCILE_INTERVAL_MS);

  timer.unref();
  void runOnce();

  log.info(
    {
      intervalMs: env.MARKET_RESOLVE_RECONCILE_INTERVAL_MS,
      batchSize: env.MARKET_RESOLVE_RECONCILE_BATCH_SIZE
    },
    'Market resolve reconciler started'
  );

  return {
    stop: () => clearInterval(timer),
    triggerNow: () => {
      void runOnce();
    }
  };
}
