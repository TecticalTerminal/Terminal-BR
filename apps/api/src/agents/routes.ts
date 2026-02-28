import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  agentKindSchema,
  agentStatusSchema,
  custodyModeSchema
} from '../domain/m1m2-model.js';
import {
  createAgent,
  getAgentPersistentAssets,
  getAgentById,
  listAgents,
  updateAgentProfile,
  updateAgentStatus
} from './repository.js';
import { completeRespawn, getLatestRespawn, requestRespawn } from './respawn.js';

const evmAddressRegex = /^0x[a-fA-F0-9]{40}$/;

const agentIdParamSchema = z.object({
  agentId: z.string().uuid()
});

const listAgentsQuerySchema = z.object({
  kind: agentKindSchema.optional(),
  status: agentStatusSchema.optional()
});

const createAgentSchema = z.object({
  kind: agentKindSchema.default('bot'),
  status: agentStatusSchema.default('active'),
  erc8004AgentId: z.string().regex(/^\d+$/).optional().nullable(),
  profile: z.object({
    displayName: z.string().trim().min(1).max(128),
    avatarUri: z.string().url().optional().nullable(),
    promptDefault: z.string().trim().min(1),
    promptOverride: z.string().trim().min(1).optional().nullable(),
    strategyTags: z.array(z.string().trim().min(1).max(64)).optional(),
    metadataJson: z.record(z.string(), z.unknown()).optional()
  }),
  wallet: z
    .object({
      custodyMode: custodyModeSchema,
      address: z.string().regex(evmAddressRegex),
      encryptedPrivateKey: z.string().trim().min(1).optional().nullable(),
      kmsKeyId: z.string().trim().min(1).optional().nullable(),
      signerPolicyJson: z.record(z.string(), z.unknown()).optional().nullable()
    })
    .optional()
}).superRefine((value, ctx) => {
  if (!value.wallet) return;
  if (value.kind === 'user' && value.wallet.custodyMode !== 'external_signer') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wallet', 'custodyMode'],
      message: 'Mixed custody mode requires user agent wallet.custodyMode=external_signer.'
    });
  }
  if (value.kind === 'bot' && value.wallet.custodyMode !== 'server_managed') {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wallet', 'custodyMode'],
      message: 'Mixed custody mode requires bot agent wallet.custodyMode=server_managed.'
    });
  }
  if (value.wallet.custodyMode === 'external_signer' && value.wallet.encryptedPrivateKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wallet', 'encryptedPrivateKey'],
      message: 'external_signer wallet must not carry encryptedPrivateKey.'
    });
  }
  if (value.wallet.custodyMode === 'server_managed' && !value.wallet.encryptedPrivateKey) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['wallet', 'encryptedPrivateKey'],
      message: 'server_managed wallet requires encryptedPrivateKey at create time.'
    });
  }
});

const updateProfileSchema = z
  .object({
    displayName: z.string().trim().min(1).max(128).optional(),
    avatarUri: z.string().url().optional().nullable(),
    promptDefault: z.string().trim().min(1).optional(),
    promptOverride: z.string().trim().min(1).optional().nullable(),
    strategyTags: z.array(z.string().trim().min(1).max(64)).optional(),
    metadataJson: z.record(z.string(), z.unknown()).optional()
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'At least one field is required.'
  });

const updateStatusSchema = z.object({
  status: agentStatusSchema
});

const requestRespawnSchema = z.object({
  gameId: z.string().uuid().optional().nullable(),
  deathSeq: z.number().int().min(0).optional().nullable(),
  feeAmount: z.string().regex(/^\d+$/).optional(),
  currencyAssetId: z.string().min(1).max(64).optional(),
  cooldownSeconds: z.number().int().min(0).max(24 * 3600).optional()
});

const promptTemplates = [
  {
    id: 'survival_first_v1',
    label: 'Survival First',
    prompt:
      'You are a cautious survivor. Prioritize HP, hunger, and thirst safety before combat.'
  },
  {
    id: 'aggressive_raider_v1',
    label: 'Aggressive Raider',
    prompt:
      'You are an aggressive raider. Prioritize nearby combat opportunities and loot after kills.'
  },
  {
    id: 'economy_trader_v1',
    label: 'Economy Trader',
    prompt:
      'You optimize long-term assets. Avoid unnecessary fights, collect value, and trade efficiently.'
  }
];

export async function registerAgentRoutes(app: FastifyInstance) {
  app.get('/api/agents', async (request, reply) => {
    const query = listAgentsQuerySchema.parse(request.query);
    const agents = await listAgents({
      kind: query.kind,
      status: query.status
    });
    reply.send({ items: agents, count: agents.length });
  });

  app.post('/api/agents', async (request, reply) => {
    const body = createAgentSchema.parse(request.body);
    const agent = await createAgent(body);
    reply.code(201).send(agent);
  });

  app.get('/api/agents/:agentId', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const agent = await getAgentById(agentId);
    reply.send(agent);
  });

  app.get('/api/agents/:agentId/assets/persistent', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const persistentAssets = await getAgentPersistentAssets(agentId);
    reply.send({ agentId, persistentAssets });
  });

  app.patch('/api/agents/:agentId/profile', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = updateProfileSchema.parse(request.body);
    const agent = await updateAgentProfile(agentId, body);
    reply.send(agent);
  });

  app.patch('/api/agents/:agentId/status', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = updateStatusSchema.parse(request.body);
    const agent = await updateAgentStatus(agentId, body.status);
    reply.send(agent);
  });

  app.get('/api/agents/:agentId/respawn', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const record = await getLatestRespawn(agentId);
    reply.send({ agentId, record });
  });

  app.post('/api/agents/:agentId/respawn/request', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const body = requestRespawnSchema.parse(request.body ?? {});
    const record = await requestRespawn({
      agentId,
      gameId: body.gameId,
      deathSeq: body.deathSeq,
      feeAmount: body.feeAmount,
      currencyAssetId: body.currencyAssetId,
      cooldownSeconds: body.cooldownSeconds
    });
    reply.code(201).send(record);
  });

  app.post('/api/agents/:agentId/respawn/complete', async (request, reply) => {
    const { agentId } = agentIdParamSchema.parse(request.params);
    const record = await completeRespawn(agentId);
    reply.send(record);
  });

  app.get('/api/agents/prompt-templates', async (_request, reply) => {
    reply.send({
      items: promptTemplates
    });
  });
}
