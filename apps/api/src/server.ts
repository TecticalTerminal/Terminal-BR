import Fastify from 'fastify';
import cors from '@fastify/cors';
import { registerA2aMarketRoutes } from './a2a-market/routes.js';
import { registerAgentRoutes } from './agents/routes.js';
import { registerAuditRoutes } from './audit/routes.js';
import { env } from './config.js';
import { pool } from './db/pool.js';
import { registerErc8004Routes } from './erc8004/routes.js';
import { getGame } from './games/repository.js';
import { registerGameRoutes } from './games/routes.js';
import { registerMarketRoutes } from './markets/routes.js';
import { startMarketResolveReconciler } from './markets/reconcile.js';
import { createMarketService } from './markets/service.js';
import { RealtimeHub } from './realtime/hub.js';
import { registerWalletRoutes } from './wallets/routes.js';
import { createWalletCustodyService } from './wallets/service.js';
import { registerX402Routes } from './x402/routes.js';

async function buildServer() {
  const app = Fastify({
    logger: true
  });
  await app.register(cors, {
    origin: true
  });

  const hub = new RealtimeHub(async (gameId) => {
    const game = await getGame(gameId);
    return {
      seq: game.seq,
      state: game.state
    };
  });

  app.server.on('upgrade', (request, socket, head) => {
    hub.handleUpgrade(request, socket, head);
  });

  app.get('/healthz', async () => {
    await pool.query('SELECT 1');
    return { status: 'ok' };
  });

  const marketService = createMarketService();
  const marketResolveReconciler = startMarketResolveReconciler({
    log: app.log,
    marketService
  });
  const walletCustodyService = createWalletCustodyService();
  app.log.info(
    {
      marketEnabled: marketService.enabled,
      marketChainIdExpected: env.MARKET_CHAIN_ID_EXPECTED,
      marketRoundLockSeconds: env.MARKET_ROUND_LOCK_SECONDS,
      marketResolveReconcileIntervalMs: env.MARKET_RESOLVE_RECONCILE_INTERVAL_MS,
      marketResolveReconcileBatchSize: env.MARKET_RESOLVE_RECONCILE_BATCH_SIZE,
      marketRpcConfigured: Boolean(env.MARKET_RPC_URL),
      marketContractConfigured: Boolean(env.MARKET_CONTRACT_ADDRESS),
      marketOperatorKeyConfigured: Boolean(env.MARKET_OPERATOR_PRIVATE_KEY)
    },
    'Market integration config loaded'
  );
  app.log.info(
    {
      aiProvider: env.AI_PROVIDER,
      aiDebug: env.AI_DEBUG,
      aiFallbackRules: env.AI_FALLBACK_RULES,
      aiTimeoutMs: env.AI_TIMEOUT_MS
    },
    'AI decision config loaded'
  );

  await registerAgentRoutes(app);
  await registerWalletRoutes(app, walletCustodyService);
  await registerGameRoutes(app, hub, marketService);
  await registerMarketRoutes(app, marketService);
  await registerA2aMarketRoutes(app);
  await registerErc8004Routes(app);
  await registerX402Routes(app);
  await registerAuditRoutes(app);

  app.addHook('onClose', async () => {
    marketResolveReconciler.stop();
    await pool.end();
  });

  return app;
}

buildServer()
  .then(async (app) => {
    await app.listen({ host: env.API_HOST, port: env.API_PORT });
    app.log.info(`API listening on http://${env.API_HOST}:${env.API_PORT}`);
  })
  .catch((error) => {
    // eslint-disable-next-line no-console
    console.error(error);
    process.exit(1);
  });
