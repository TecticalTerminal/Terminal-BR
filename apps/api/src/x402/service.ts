import { v4 as uuidv4 } from 'uuid';
import { env } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';

type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

type PaymentLogStatus =
  | 'no_payment_required'
  | 'paid_success'
  | 'paid_failed'
  | 'blocked_domain'
  | 'blocked_single_limit'
  | 'blocked_budget'
  | 'no_payment_mechanism'
  | 'invalid_payment_requirement'
  | 'request_failed'
  | 'dry_run';

interface PaymentRequirement {
  scheme: string;
  network: string;
  maxAmountRequired: string;
  payToAddress?: string;
  requiredDeadlineSeconds?: number;
  usdcAddress?: string;
}

interface ParsedPaymentRequirement {
  x402Version: number;
  requirement: PaymentRequirement;
}

export interface X402FetchInput {
  url: string;
  method?: HttpMethod;
  headers?: Record<string, string>;
  body?: unknown;
  maxPaymentCents?: number;
  budgetCents?: number;
  paymentHeader?: string;
  dryRun?: boolean;
}

export interface X402FetchResult {
  success: boolean;
  paid: boolean;
  status: number;
  dryRun: boolean;
  paymentRequired: boolean;
  domain: string;
  requiredAmountCents: number | null;
  maxAllowedCents: number;
  budgetLimitCents: number;
  budgetSpentBeforeCents: number;
  logId: string;
  response?: unknown;
  error?: string;
  paymentContext?: {
    x402Version: number;
    network: string;
    scheme: string;
    maxAmountRequired: string;
  };
}

export interface X402PaymentLogView {
  id: string;
  requestUrl: string;
  requestDomain: string;
  method: HttpMethod;
  status: PaymentLogStatus;
  x402Version: number | null;
  network: string | null;
  maxAmountRequired: string | null;
  requiredAmountCents: number | null;
  approvedAmountCents: number | null;
  budgetBeforeCents: number | null;
  budgetAfterCents: number | null;
  paymentHeaderSource: 'request' | 'env_static' | null;
  httpStatus: number | null;
  errorMessage: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}

interface X402PaymentLogRow {
  id: string;
  request_url: string;
  request_domain: string;
  method: HttpMethod;
  status: PaymentLogStatus;
  x402_version: number | null;
  network: string | null;
  max_amount_required: string | null;
  required_amount_cents: number | null;
  approved_amount_cents: number | null;
  budget_before_cents: number | null;
  budget_after_cents: number | null;
  payment_header_source: 'request' | 'env_static' | null;
  http_status: number | null;
  error_message: string | null;
  metadata_json: unknown;
  created_at: string | Date;
}

const USDC_ADDRESS_BY_NETWORK: Record<string, string> = {
  'eip155:8453': '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
  'eip155:84532': '0x036CbD53842c5426634e7929541eC2318f3dCF7e'
};

const INTERNAL_PROVIDER_REQUIREMENT: PaymentRequirement = {
  scheme: 'exact',
  network: 'eip155:84532',
  maxAmountRequired: '0.10',
  payToAddress: '0x0000000000000000000000000000000000000001',
  requiredDeadlineSeconds: 300,
  usdcAddress: USDC_ADDRESS_BY_NETWORK['eip155:84532']
};

export interface X402Challenge {
  x402Version: number;
  accepts: PaymentRequirement[];
}

export interface X402InternalProviderResult {
  statusCode: number;
  headers?: Record<string, string>;
  body: Record<string, unknown>;
}

function buildInternalChallenge(): X402Challenge {
  return {
    x402Version: 2,
    accepts: [INTERNAL_PROVIDER_REQUIREMENT]
  };
}

function buildIntelInsights(query: string, context?: string): string[] {
  const normalized = query.trim().toLowerCase();
  const insights: string[] = [];
  if (normalized.includes('market') || normalized.includes('trade')) {
    insights.push('Market liquidity is thin; prefer smaller clip sizes and staggered execution windows.');
  }
  if (normalized.includes('survival') || normalized.includes('respawn')) {
    insights.push('Keep a respawn reserve above 3x fee to avoid forced inactivity after chain events.');
  }
  if (normalized.includes('bot') || normalized.includes('agent')) {
    insights.push('Agent prompts should cap max spend per turn and require whitelist checks before x402 payment.');
  }
  if (context && context.trim().length > 0) {
    insights.push(`Context tag received: ${context.trim().slice(0, 120)}.`);
  }
  if (!insights.length) {
    insights.push('No critical intel flags. Maintain budget guardrails and monitor payment-log anomalies.');
  }
  return insights;
}

export function getInternalX402Challenge(): X402Challenge {
  return buildInternalChallenge();
}

export async function runInternalIntelProvider(input: {
  query: string;
  context?: string;
  paymentHeader?: string;
}): Promise<X402InternalProviderResult> {
  const challenge = buildInternalChallenge();
  const paymentHeader = input.paymentHeader?.trim();

  if (!paymentHeader) {
    const payload = {
      error: 'payment required',
      message: 'Provide X-Payment header and retry.',
      ...challenge
    };
    return {
      statusCode: 402,
      headers: {
        'X-Payment-Required': JSON.stringify(challenge)
      },
      body: payload
    };
  }

  if (env.X402_MODE === 'strict') {
    return {
      statusCode: 501,
      body: {
        error: 'strict mode unsupported for internal provider',
        message: 'Point X402_DEMO_INTEL_URL to a real x402 endpoint when X402_MODE=strict.'
      }
    };
  }

  return {
    statusCode: 200,
    body: {
      ok: true,
      paid: true,
      mode: env.X402_MODE,
      provider: 'internal-simulated',
      quote: challenge.accepts[0],
      intel: {
        query: input.query,
        context: input.context ?? '',
        generatedAt: new Date().toISOString(),
        insights: buildIntelInsights(input.query, input.context)
      }
    }
  };
}

function mapLogRow(row: X402PaymentLogRow): X402PaymentLogView {
  return {
    id: row.id,
    requestUrl: row.request_url,
    requestDomain: row.request_domain,
    method: row.method,
    status: row.status,
    x402Version: row.x402_version,
    network: row.network,
    maxAmountRequired: row.max_amount_required,
    requiredAmountCents: row.required_amount_cents,
    approvedAmountCents: row.approved_amount_cents,
    budgetBeforeCents: row.budget_before_cents,
    budgetAfterCents: row.budget_after_cents,
    paymentHeaderSource: row.payment_header_source,
    httpStatus: row.http_status,
    errorMessage: row.error_message,
    metadataJson:
      row.metadata_json && typeof row.metadata_json === 'object' && !Array.isArray(row.metadata_json)
        ? (row.metadata_json as Record<string, unknown>)
        : {},
    createdAt: new Date(row.created_at).toISOString()
  };
}

function isDomainAllowed(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const allowlist = env.X402_ALLOWED_DOMAINS_ITEMS;
  if (!allowlist.length) return false;
  for (const allowed of allowlist) {
    if (allowed.startsWith('*.')) {
      const suffix = allowed.slice(2);
      if (host === suffix || host.endsWith(`.${suffix}`)) {
        return true;
      }
      continue;
    }
    if (host === allowed || host.endsWith(`.${allowed}`)) {
      return true;
    }
  }
  return false;
}

function parseMaxAmountToCents(maxAmountRequired: string, x402Version: number): number {
  const raw = maxAmountRequired.trim();
  if (!raw) throw new HttpError(400, 'maxAmountRequired is empty.');

  let cents: bigint;
  if (raw.includes('.')) {
    if (!/^\d+\.\d+$/.test(raw)) {
      throw new HttpError(400, `Invalid decimal maxAmountRequired: ${raw}`);
    }
    const [whole, fracRaw] = raw.split('.');
    const frac2 = (fracRaw + '00').slice(0, 2);
    cents = BigInt(whole) * 100n + BigInt(frac2);
  } else {
    if (!/^\d+$/.test(raw)) {
      throw new HttpError(400, `Invalid integer maxAmountRequired: ${raw}`);
    }
    const value = BigInt(raw);
    if (x402Version >= 2 || raw.length > 6) {
      cents = value / 10_000n;
    } else {
      cents = value * 100n;
    }
  }

  if (cents < 0n) {
    throw new HttpError(400, `Invalid maxAmountRequired cents: ${raw}`);
  }
  if (cents > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new HttpError(400, `maxAmountRequired too large: ${raw}`);
  }
  return Number(cents);
}

function normalizeMethod(input?: string): HttpMethod {
  const method = (input ?? 'GET').toUpperCase();
  if (method === 'GET' || method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE') {
    return method;
  }
  throw new HttpError(400, `Unsupported method: ${input}`);
}

async function parseResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  const contentType = response.headers.get('content-type') ?? '';
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return text;
    }
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function safeJsonParse(input: string): unknown | null {
  try {
    return JSON.parse(input) as unknown;
  } catch {
    return null;
  }
}

function normalizeRequirement(input: unknown): PaymentRequirement | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const value = input as Record<string, unknown>;

  const scheme = typeof value.scheme === 'string' ? value.scheme : null;
  const network = typeof value.network === 'string' ? value.network : null;
  const maxAmountRequired =
    typeof value.maxAmountRequired === 'string'
      ? value.maxAmountRequired
      : typeof value.maxAmountRequired === 'number'
        ? String(value.maxAmountRequired)
        : null;

  if (!scheme || !network || !maxAmountRequired) {
    return null;
  }

  return {
    scheme,
    network,
    maxAmountRequired,
    payToAddress: typeof value.payToAddress === 'string' ? value.payToAddress : undefined,
    requiredDeadlineSeconds:
      typeof value.requiredDeadlineSeconds === 'number' ? Math.floor(value.requiredDeadlineSeconds) : undefined,
    usdcAddress: typeof value.usdcAddress === 'string' ? value.usdcAddress : undefined
  };
}

function parsePaymentRequiredPayload(payload: unknown): ParsedPaymentRequirement | null {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const root = payload as Record<string, unknown>;

  if (!Array.isArray(root.accepts) || root.accepts.length === 0) return null;
  const x402Version =
    typeof root.x402Version === 'number' && Number.isFinite(root.x402Version) && root.x402Version > 0
      ? Math.floor(root.x402Version)
      : 1;

  const normalized = root.accepts
    .map((item) => normalizeRequirement(item))
    .filter((item): item is PaymentRequirement => item !== null);
  if (!normalized.length) return null;

  const exact = normalized.find((item) => item.scheme === 'exact');
  return {
    x402Version,
    requirement: exact ?? normalized[0]
  };
}

async function parsePaymentRequired(response: Response): Promise<ParsedPaymentRequirement | null> {
  const header = response.headers.get('X-Payment-Required');
  if (header) {
    const direct = parsePaymentRequiredPayload(safeJsonParse(header));
    if (direct) return direct;

    try {
      const decoded = Buffer.from(header, 'base64').toString('utf8');
      const fromBase64 = parsePaymentRequiredPayload(safeJsonParse(decoded));
      if (fromBase64) return fromBase64;
    } catch {
      // ignored
    }
  }

  try {
    const body = await parseResponseBody(response);
    return parsePaymentRequiredPayload(body);
  } catch {
    return null;
  }
}

function toRequestBody(method: HttpMethod, body: unknown): string | undefined {
  if (method === 'GET') return undefined;
  if (body === undefined || body === null) return undefined;
  if (typeof body === 'string') return body;
  return JSON.stringify(body);
}

async function fetchWithTimeout(input: {
  url: string;
  method: HttpMethod;
  headers: Record<string, string>;
  body?: string;
}): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), env.X402_TIMEOUT_MS);
  try {
    return await fetch(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.body,
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }
}

async function currentBudgetSpentTodayCents(): Promise<number> {
  const result = await pool.query<{ total: string }>(
    `
      SELECT COALESCE(SUM(approved_amount_cents), 0)::text AS total
      FROM x402_payment_log
      WHERE status = 'paid_success'
        AND created_at >= date_trunc('day', NOW())
    `
  );
  return Number(result.rows[0]?.total ?? '0');
}

async function insertX402PaymentLog(input: {
  requestUrl: string;
  requestDomain: string;
  method: HttpMethod;
  status: PaymentLogStatus;
  x402Version?: number | null;
  network?: string | null;
  maxAmountRequired?: string | null;
  requiredAmountCents?: number | null;
  approvedAmountCents?: number | null;
  budgetBeforeCents?: number | null;
  budgetAfterCents?: number | null;
  paymentHeaderSource?: 'request' | 'env_static' | null;
  httpStatus?: number | null;
  errorMessage?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  const id = uuidv4();
  await pool.query(
    `
      INSERT INTO x402_payment_log (
        id,
        request_url,
        request_domain,
        method,
        status,
        x402_version,
        network,
        max_amount_required,
        required_amount_cents,
        approved_amount_cents,
        budget_before_cents,
        budget_after_cents,
        payment_header_source,
        http_status,
        error_message,
        metadata_json
      ) VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::jsonb
      )
    `,
    [
      id,
      input.requestUrl,
      input.requestDomain,
      input.method,
      input.status,
      input.x402Version ?? null,
      input.network ?? null,
      input.maxAmountRequired ?? null,
      input.requiredAmountCents ?? null,
      input.approvedAmountCents ?? null,
      input.budgetBeforeCents ?? null,
      input.budgetAfterCents ?? null,
      input.paymentHeaderSource ?? null,
      input.httpStatus ?? null,
      input.errorMessage ?? null,
      JSON.stringify(input.metadata ?? {})
    ]
  );
  return id;
}

export async function x402Fetch(input: X402FetchInput): Promise<X402FetchResult> {
  if (!env.X402_ENABLED) {
    throw new HttpError(503, 'X402 adapter is disabled.');
  }

  const url = new URL(input.url);
  const method = normalizeMethod(input.method);
  const domain = url.hostname.toLowerCase();
  const maxAllowedCents = input.maxPaymentCents ?? env.X402_MAX_SINGLE_PAYMENT_CENTS;
  const budgetLimitCents = input.budgetCents ?? env.X402_BUDGET_CENTS;
  const budgetSpentBeforeCents = await currentBudgetSpentTodayCents();
  const dryRun = input.dryRun ?? false;

  if (!isDomainAllowed(domain)) {
    const logId = await insertX402PaymentLog({
      requestUrl: input.url,
      requestDomain: domain,
      method,
      status: 'blocked_domain',
      budgetBeforeCents: budgetSpentBeforeCents,
      budgetAfterCents: budgetSpentBeforeCents,
      errorMessage: `Domain not in whitelist: ${domain}`
    });
    return {
      success: false,
      paid: false,
      status: 403,
      dryRun,
      paymentRequired: false,
      domain,
      requiredAmountCents: null,
      maxAllowedCents,
      budgetLimitCents,
      budgetSpentBeforeCents,
      logId,
      error: `Domain not in whitelist: ${domain}`
    };
  }

  const headers: Record<string, string> = {
    ...(input.headers ?? {})
  };
  const bodyPayload = toRequestBody(method, input.body);
  if (bodyPayload !== undefined && !Object.keys(headers).some((key) => key.toLowerCase() === 'content-type')) {
    headers['Content-Type'] = 'application/json';
  }

  try {
    const initialResponse = await fetchWithTimeout({
      url: input.url,
      method,
      headers,
      body: bodyPayload
    });

    if (initialResponse.status !== 402) {
      const payload = await parseResponseBody(initialResponse);
      const logId = await insertX402PaymentLog({
        requestUrl: input.url,
        requestDomain: domain,
        method,
        status: 'no_payment_required',
        budgetBeforeCents: budgetSpentBeforeCents,
        budgetAfterCents: budgetSpentBeforeCents,
        httpStatus: initialResponse.status
      });
      return {
        success: initialResponse.ok,
        paid: false,
        status: initialResponse.status,
        dryRun,
        paymentRequired: false,
        domain,
        requiredAmountCents: null,
        maxAllowedCents,
        budgetLimitCents,
        budgetSpentBeforeCents,
        logId,
        response: payload
      };
    }

    const parsed = await parsePaymentRequired(initialResponse.clone());
    if (!parsed) {
      const raw = await parseResponseBody(initialResponse);
      const logId = await insertX402PaymentLog({
        requestUrl: input.url,
        requestDomain: domain,
        method,
        status: 'invalid_payment_requirement',
        budgetBeforeCents: budgetSpentBeforeCents,
        budgetAfterCents: budgetSpentBeforeCents,
        httpStatus: initialResponse.status,
        errorMessage: 'Could not parse payment requirement'
      });
      return {
        success: false,
        paid: false,
        status: initialResponse.status,
        dryRun,
        paymentRequired: true,
        domain,
        requiredAmountCents: null,
        maxAllowedCents,
        budgetLimitCents,
        budgetSpentBeforeCents,
        logId,
        error: 'Could not parse payment requirement',
        response: raw
      };
    }

    const requiredAmountCents = parseMaxAmountToCents(
      parsed.requirement.maxAmountRequired,
      parsed.x402Version
    );

    if (requiredAmountCents > maxAllowedCents) {
      const logId = await insertX402PaymentLog({
        requestUrl: input.url,
        requestDomain: domain,
        method,
        status: 'blocked_single_limit',
        x402Version: parsed.x402Version,
        network: parsed.requirement.network,
        maxAmountRequired: parsed.requirement.maxAmountRequired,
        requiredAmountCents,
        budgetBeforeCents: budgetSpentBeforeCents,
        budgetAfterCents: budgetSpentBeforeCents,
        httpStatus: 402,
        errorMessage: `Payment exceeds single limit: required=${requiredAmountCents} max=${maxAllowedCents}`
      });
      return {
        success: false,
        paid: false,
        status: 402,
        dryRun,
        paymentRequired: true,
        domain,
        requiredAmountCents,
        maxAllowedCents,
        budgetLimitCents,
        budgetSpentBeforeCents,
        logId,
        error: `Payment exceeds single limit: required=${requiredAmountCents} max=${maxAllowedCents}`,
        paymentContext: {
          x402Version: parsed.x402Version,
          network: parsed.requirement.network,
          scheme: parsed.requirement.scheme,
          maxAmountRequired: parsed.requirement.maxAmountRequired
        }
      };
    }

    if (budgetSpentBeforeCents + requiredAmountCents > budgetLimitCents) {
      const logId = await insertX402PaymentLog({
        requestUrl: input.url,
        requestDomain: domain,
        method,
        status: 'blocked_budget',
        x402Version: parsed.x402Version,
        network: parsed.requirement.network,
        maxAmountRequired: parsed.requirement.maxAmountRequired,
        requiredAmountCents,
        budgetBeforeCents: budgetSpentBeforeCents,
        budgetAfterCents: budgetSpentBeforeCents,
        httpStatus: 402,
        errorMessage: `Payment exceeds budget: spent=${budgetSpentBeforeCents} required=${requiredAmountCents} limit=${budgetLimitCents}`
      });
      return {
        success: false,
        paid: false,
        status: 402,
        dryRun,
        paymentRequired: true,
        domain,
        requiredAmountCents,
        maxAllowedCents,
        budgetLimitCents,
        budgetSpentBeforeCents,
        logId,
        error: `Payment exceeds budget: spent=${budgetSpentBeforeCents} required=${requiredAmountCents} limit=${budgetLimitCents}`,
        paymentContext: {
          x402Version: parsed.x402Version,
          network: parsed.requirement.network,
          scheme: parsed.requirement.scheme,
          maxAmountRequired: parsed.requirement.maxAmountRequired
        }
      };
    }

    const paymentHeaderFromRequest = input.paymentHeader?.trim();
    const paymentHeaderFromEnv = env.X402_STATIC_PAYMENT_TOKEN?.trim();
    const paymentHeader = paymentHeaderFromRequest || paymentHeaderFromEnv;
    const paymentHeaderSource: 'request' | 'env_static' | null = paymentHeaderFromRequest
      ? 'request'
      : paymentHeaderFromEnv
        ? 'env_static'
        : null;

    if (!paymentHeader) {
      const logId = await insertX402PaymentLog({
        requestUrl: input.url,
        requestDomain: domain,
        method,
        status: 'no_payment_mechanism',
        x402Version: parsed.x402Version,
        network: parsed.requirement.network,
        maxAmountRequired: parsed.requirement.maxAmountRequired,
        requiredAmountCents,
        budgetBeforeCents: budgetSpentBeforeCents,
        budgetAfterCents: budgetSpentBeforeCents,
        httpStatus: 402,
        errorMessage: 'No paymentHeader provided and X402_STATIC_PAYMENT_TOKEN is empty.'
      });
      return {
        success: false,
        paid: false,
        status: 402,
        dryRun,
        paymentRequired: true,
        domain,
        requiredAmountCents,
        maxAllowedCents,
        budgetLimitCents,
        budgetSpentBeforeCents,
        logId,
        error: 'No paymentHeader provided and X402_STATIC_PAYMENT_TOKEN is empty.',
        paymentContext: {
          x402Version: parsed.x402Version,
          network: parsed.requirement.network,
          scheme: parsed.requirement.scheme,
          maxAmountRequired: parsed.requirement.maxAmountRequired
        }
      };
    }

    if (dryRun) {
      const logId = await insertX402PaymentLog({
        requestUrl: input.url,
        requestDomain: domain,
        method,
        status: 'dry_run',
        x402Version: parsed.x402Version,
        network: parsed.requirement.network,
        maxAmountRequired: parsed.requirement.maxAmountRequired,
        requiredAmountCents,
        approvedAmountCents: requiredAmountCents,
        budgetBeforeCents: budgetSpentBeforeCents,
        budgetAfterCents: budgetSpentBeforeCents,
        paymentHeaderSource
      });
      return {
        success: true,
        paid: false,
        status: 200,
        dryRun: true,
        paymentRequired: true,
        domain,
        requiredAmountCents,
        maxAllowedCents,
        budgetLimitCents,
        budgetSpentBeforeCents,
        logId,
        paymentContext: {
          x402Version: parsed.x402Version,
          network: parsed.requirement.network,
          scheme: parsed.requirement.scheme,
          maxAmountRequired: parsed.requirement.maxAmountRequired
        },
        response: {
          message: 'Dry run completed. Payment not sent.',
          wouldPayCents: requiredAmountCents
        }
      };
    }

    const paidResponse = await fetchWithTimeout({
      url: input.url,
      method,
      headers: {
        ...headers,
        'X-Payment': paymentHeader
      },
      body: bodyPayload
    });
    const paidPayload = await parseResponseBody(paidResponse);
    const paidSuccess = paidResponse.ok;
    const budgetAfterCents = paidSuccess
      ? budgetSpentBeforeCents + requiredAmountCents
      : budgetSpentBeforeCents;

    const logId = await insertX402PaymentLog({
      requestUrl: input.url,
      requestDomain: domain,
      method,
      status: paidSuccess ? 'paid_success' : 'paid_failed',
      x402Version: parsed.x402Version,
      network: parsed.requirement.network,
      maxAmountRequired: parsed.requirement.maxAmountRequired,
      requiredAmountCents,
      approvedAmountCents: requiredAmountCents,
      budgetBeforeCents: budgetSpentBeforeCents,
      budgetAfterCents,
      paymentHeaderSource,
      httpStatus: paidResponse.status,
      errorMessage: paidSuccess ? null : 'Paid retry returned non-2xx status'
    });

    return {
      success: paidSuccess,
      paid: paidSuccess,
      status: paidResponse.status,
      dryRun: false,
      paymentRequired: true,
      domain,
      requiredAmountCents,
      maxAllowedCents,
      budgetLimitCents,
      budgetSpentBeforeCents,
      logId,
      response: paidPayload,
      error: paidSuccess ? undefined : 'Paid retry returned non-2xx status',
      paymentContext: {
        x402Version: parsed.x402Version,
        network: parsed.requirement.network,
        scheme: parsed.requirement.scheme,
        maxAmountRequired: parsed.requirement.maxAmountRequired
      }
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'x402 request failed';
    const logId = await insertX402PaymentLog({
      requestUrl: input.url,
      requestDomain: domain,
      method,
      status: 'request_failed',
      budgetBeforeCents: budgetSpentBeforeCents,
      budgetAfterCents: budgetSpentBeforeCents,
      errorMessage: message
    });
    return {
      success: false,
      paid: false,
      status: 500,
      dryRun,
      paymentRequired: false,
      domain,
      requiredAmountCents: null,
      maxAllowedCents,
      budgetLimitCents,
      budgetSpentBeforeCents,
      logId,
      error: message
    };
  }
}

export async function runX402IntelDemo(input: {
  query: string;
  context?: string;
  paymentHeader?: string;
  dryRun?: boolean;
}): Promise<X402FetchResult & { targetUrl: string; method: 'GET' | 'POST' }> {
  if (!env.X402_DEMO_INTEL_URL) {
    throw new HttpError(409, 'X402_DEMO_INTEL_URL is not configured.');
  }
  const method = env.X402_DEMO_INTEL_METHOD;
  const body =
    method === 'GET'
      ? undefined
      : {
          query: input.query,
          context: input.context ?? ''
        };
  const result = await x402Fetch({
    url: env.X402_DEMO_INTEL_URL,
    method,
    body,
    paymentHeader: input.paymentHeader,
    dryRun: input.dryRun
  });
  return {
    ...result,
    targetUrl: env.X402_DEMO_INTEL_URL,
    method
  };
}

export async function listX402PaymentLogs(input: {
  limit: number;
  offset: number;
  status?: PaymentLogStatus;
  domain?: string;
}): Promise<{ items: X402PaymentLogView[]; count: number }> {
  const where: string[] = [];
  const values: Array<string | number> = [];

  if (input.status) {
    values.push(input.status);
    where.push(`status = $${values.length}`);
  }
  if (input.domain) {
    values.push(input.domain.toLowerCase());
    where.push(`request_domain = $${values.length}`);
  }

  values.push(input.limit);
  const limitIndex = values.length;
  values.push(input.offset);
  const offsetIndex = values.length;

  const [rows, countRows] = await Promise.all([
    pool.query<X402PaymentLogRow>(
      `
        SELECT
          id,
          request_url,
          request_domain,
          method,
          status,
          x402_version,
          network,
          max_amount_required,
          required_amount_cents,
          approved_amount_cents,
          budget_before_cents,
          budget_after_cents,
          payment_header_source,
          http_status,
          error_message,
          metadata_json,
          created_at
        FROM x402_payment_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY created_at DESC
        LIMIT $${limitIndex}
        OFFSET $${offsetIndex}
      `,
      values
    ),
    pool.query<{ count: string }>(
      `
        SELECT COUNT(*)::text AS count
        FROM x402_payment_log
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      `,
      values.slice(0, where.length)
    )
  ]);

  return {
    items: rows.rows.map(mapLogRow),
    count: Number(countRows.rows[0]?.count ?? '0')
  };
}
