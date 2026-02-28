import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config.js';
import { listX402PaymentLogs, runInternalIntelProvider, runX402IntelDemo, x402Fetch } from './service.js';

const x402FetchSchema = z.object({
  url: z.string().url(),
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional(),
  headers: z.record(z.string(), z.string()).optional(),
  body: z.unknown().optional(),
  maxPaymentCents: z.number().int().positive().optional(),
  budgetCents: z.number().int().positive().optional(),
  paymentHeader: z.string().min(1).optional(),
  dryRun: z.boolean().optional()
});

const x402IntelDemoSchema = z.object({
  query: z.string().trim().min(1).max(1000),
  context: z.string().trim().max(4000).optional(),
  paymentHeader: z.string().min(1).optional(),
  dryRun: z.boolean().optional()
});

const x402ProviderIntelBodySchema = z.object({
  query: z.string().trim().min(1).max(1000),
  context: z.string().trim().max(4000).optional()
});

const x402ProviderIntelQuerySchema = z.object({
  query: z.string().trim().min(1).max(1000).default('latest tactical intel'),
  context: z.string().trim().max(4000).optional()
});

const listLogsQuerySchema = z.object({
  status: z
    .enum([
      'no_payment_required',
      'paid_success',
      'paid_failed',
      'blocked_domain',
      'blocked_single_limit',
      'blocked_budget',
      'no_payment_mechanism',
      'invalid_payment_requirement',
      'request_failed',
      'dry_run'
    ])
    .optional(),
  domain: z.string().trim().min(1).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0)
});

export async function registerX402Routes(app: FastifyInstance) {
  const readPaymentHeader = (headers: Record<string, unknown>): string | undefined => {
    const raw = headers['x-payment'];
    if (typeof raw === 'string' && raw.trim()) return raw;
    if (Array.isArray(raw)) {
      const first = raw.find((item): item is string => typeof item === 'string' && item.trim().length > 0);
      if (first) return first;
    }
    return undefined;
  };

  app.get('/api/x402/config', async (_request, reply) => {
    reply.send({
      enabled: env.X402_ENABLED,
      mode: env.X402_MODE,
      facilitatorUrl: env.X402_FACILITATOR_URL,
      allowedDomains: env.X402_ALLOWED_DOMAINS_ITEMS,
      maxSinglePaymentCents: env.X402_MAX_SINGLE_PAYMENT_CENTS,
      budgetCents: env.X402_BUDGET_CENTS,
      timeoutMs: env.X402_TIMEOUT_MS,
      hasStaticPaymentToken: !!env.X402_STATIC_PAYMENT_TOKEN,
      demoIntelConfigured: !!env.X402_DEMO_INTEL_URL,
      demoIntelMethod: env.X402_DEMO_INTEL_METHOD,
      demoIntelUrl: env.X402_DEMO_INTEL_URL ?? null,
      internalProviderPath: '/api/x402/provider/intel'
    });
  });

  app.get('/api/x402/provider/intel', async (request, reply) => {
    const query = x402ProviderIntelQuerySchema.parse(request.query);
    const paymentHeader = readPaymentHeader(request.headers);
    const result = await runInternalIntelProvider({
      query: query.query,
      context: query.context,
      paymentHeader
    });
    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        reply.header(key, value);
      });
    }
    reply.code(result.statusCode).send(result.body);
  });

  app.post('/api/x402/provider/intel', async (request, reply) => {
    const body = x402ProviderIntelBodySchema.parse(request.body);
    const paymentHeader = readPaymentHeader(request.headers);
    const result = await runInternalIntelProvider({
      query: body.query,
      context: body.context,
      paymentHeader
    });
    if (result.headers) {
      Object.entries(result.headers).forEach(([key, value]) => {
        reply.header(key, value);
      });
    }
    reply.code(result.statusCode).send(result.body);
  });

  app.post('/api/x402/fetch', async (request, reply) => {
    const body = x402FetchSchema.parse(request.body);
    const result = await x402Fetch(body);
    reply.send(result);
  });

  app.post('/api/x402/demo/intel', async (request, reply) => {
    const body = x402IntelDemoSchema.parse(request.body);
    const result = await runX402IntelDemo(body);
    reply.send(result);
  });

  app.get('/api/x402/logs', async (request, reply) => {
    const query = listLogsQuerySchema.parse(request.query);
    const result = await listX402PaymentLogs({
      limit: query.limit,
      offset: query.offset,
      status: query.status,
      domain: query.domain
    });
    reply.send(result);
  });
}
