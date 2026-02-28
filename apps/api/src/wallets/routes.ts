import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { WalletCustodyService } from './service.js';

const agentIdParamSchema = z.object({
  agentId: z.string().uuid()
});

const weiStringSchema = z.string().regex(/^\d+$/);

const ensureManagedWalletSchema = z.object({
  forceRotate: z.boolean().optional(),
  policy: z
    .object({
      maxAmountWei: weiStringSchema.optional(),
      dailyLimitWei: weiStringSchema.optional()
    })
    .optional()
});

const bindExternalWalletSchema = z.object({
  address: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
  forceReplace: z.boolean().optional()
});

const signMessageSchema = z.object({
  message: z.string().trim().min(1).max(4096),
  amountWei: weiStringSchema.optional(),
  purpose: z.string().trim().max(128).optional()
});

export async function registerWalletRoutes(app: FastifyInstance, walletService: WalletCustodyService) {
  app.get('/api/agents/:agentId/wallet', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const snapshot = await walletService.getWalletSnapshot(agentId);
    reply.send(snapshot);
  });

  app.post('/api/agents/:agentId/wallet/managed', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = ensureManagedWalletSchema.parse(request.body ?? {});
    const wallet = await walletService.ensureManagedWallet({
      agentId,
      forceRotate: body.forceRotate,
      policy: body.policy
    });
    reply.code(201).send(wallet);
  });

  app.post('/api/agents/:agentId/wallet/managed/rotate', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = ensureManagedWalletSchema.parse(request.body ?? {});
    const wallet = await walletService.ensureManagedWallet({
      agentId,
      forceRotate: true,
      policy: body.policy
    });
    reply.code(201).send(wallet);
  });

  app.post('/api/agents/:agentId/wallet/external', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = bindExternalWalletSchema.parse(request.body);
    const wallet = await walletService.bindExternalWallet({
      agentId,
      address: body.address,
      forceReplace: body.forceReplace
    });
    reply.code(201).send(wallet);
  });

  app.post('/api/agents/:agentId/wallet/sign-message', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = signMessageSchema.parse(request.body);
    const signed = await walletService.signMessage({
      agentId,
      message: body.message,
      amountWei: body.amountWei,
      purpose: body.purpose
    });
    reply.send(signed);
  });
}
