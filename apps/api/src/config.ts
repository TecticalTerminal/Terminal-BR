import { config as loadEnv } from 'dotenv';
import { z } from 'zod';

loadEnv();

const boolish = new Set(['1', 'true', 'yes', 'on']);
const parseBool = (value?: string) => boolish.has((value ?? '').trim().toLowerCase());

const envSchema = z.object({
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().positive().default(8787),
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  MARKET_ENABLED: z
    .string()
    .optional()
    .transform((value) => parseBool(value)),
  MARKET_RPC_URL: z.string().optional(),
  MARKET_CONTRACT_ADDRESS: z.string().optional(),
  MARKET_OPERATOR_PRIVATE_KEY: z.string().optional(),
  MARKET_ROUND_LOCK_SECONDS: z.coerce.number().int().positive().default(180),
  MARKET_CHAIN_ID_EXPECTED: z.coerce.number().int().positive().default(11155111),
  MARKET_RESOLVE_RECONCILE_INTERVAL_MS: z.coerce.number().int().min(1000).max(60_000).default(5000),
  MARKET_RESOLVE_RECONCILE_BATCH_SIZE: z.coerce.number().int().min(1).max(200).default(30),
  AI_PROVIDER: z.enum(['rules', 'openrouter']).default('rules'),
  AI_DEBUG: z
    .string()
    .optional()
    .transform((value) => parseBool(value)),
  AI_TIMEOUT_MS: z.coerce.number().int().positive().default(1200),
  AI_OPENROUTER_MAX_RETRIES: z.coerce.number().int().min(0).max(5).default(1),
  AI_OPENROUTER_RETRY_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  AI_OPENROUTER_COOLDOWN_MS: z.coerce.number().int().positive().default(5000),
  AI_FALLBACK_RULES: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? true : parseBool(value))),
  OPENROUTER_API_KEY: z.string().optional(),
  OPENROUTER_MODEL: z.string().optional(),
  OPENROUTER_BASE_URL: z.string().default('https://openrouter.ai/api/v1'),
  OPENROUTER_SITE_URL: z.string().optional(),
  OPENROUTER_APP_NAME: z.string().optional(),
  WALLET_ENCRYPTION_KEY: z.string().min(8).default('dev-only-wallet-master-key'),
  WALLET_SIGN_MAX_AMOUNT_WEI: z
    .string()
    .regex(/^\d+$/)
    .default('100000000000000000'),
  WALLET_SIGN_DAILY_LIMIT_WEI: z
    .string()
    .regex(/^\d+$/)
    .default('1000000000000000000'),
  M2_MARKET_CIRCUIT_BREAKER: z
    .string()
    .optional()
    .transform((value) => parseBool(value)),
  M2_MARKET_DEFAULT_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
  M2_MARKET_MAX_SINGLE_TRADE_GROSS_CREDITS: z
    .string()
    .regex(/^\d+$/)
    .default('100000'),
  M2_MARKET_MAX_TRADES_PER_GAME: z.coerce.number().int().min(1).max(1000).default(20),
  M2_EQUIPMENT_WHITELIST: z.string().default(''),
  M2_FEE_COLLECTOR_AGENT_ID: z.string().uuid().default('00000000-0000-4000-8000-00000000f001'),
  M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID: z.string().default(''),
  M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID: z.string().default(''),
  M2_AUTO_TRADE_DEFAULT_ASSET_ID: z.string().default('demo_blade'),
  M2_AUTO_TRADE_DEFAULT_QUANTITY: z.coerce.number().int().min(1).max(100).default(1),
  M2_AUTO_TRADE_DEFAULT_UNIT_PRICE: z
    .string()
    .regex(/^\d+$/)
    .default('120'),
  M2_AUTO_TRADE_DEFAULT_FEE_BPS: z.coerce.number().int().min(0).max(10_000).default(300),
  M2_AUTO_TRADE_DEFAULT_MAX_BUY_UNIT_PRICE: z
    .string()
    .regex(/^\d+$/)
    .default('150'),
  M2_AUTO_TRADE_DEFAULT_AUTO_SEED: z
    .string()
    .optional()
    .transform((value) => (value === undefined ? true : parseBool(value))),
  M2_AUTO_TRADE_DEFAULT_BUYER_CREDITS_TARGET: z
    .string()
    .regex(/^\d+$/)
    .default('2000'),
  M2_AUTO_TRADE_DEFAULT_SELLER_EQUIPMENT_TARGET: z
    .string()
    .regex(/^\d+$/)
    .default('1'),
  ERC8004_ENABLED: z
    .string()
    .optional()
    .transform((value) => parseBool(value)),
  ERC8004_RPC_URL: z.string().optional(),
  ERC8004_IDENTITY_CONTRACT: z.string().optional(),
  ERC8004_CHAIN_ID_EXPECTED: z.coerce.number().int().positive().default(84532),
  ERC8004_AGENT_URI_BASE: z.string().default(''),
  ERC8004_DISCOVERY_MAX_SCAN: z.coerce.number().int().min(1).max(1000).default(50),
  ERC8004_DISCOVERY_CACHE_TTL_SECONDS: z.coerce.number().int().min(1).max(7 * 24 * 3600).default(3600),
  ERC8004_DISCOVERY_FETCH_TIMEOUT_MS: z.coerce.number().int().min(200).max(30_000).default(4000),
  ERC8004_IPFS_GATEWAY: z.string().default('https://ipfs.io'),
  X402_ENABLED: z
    .string()
    .optional()
    .transform((value) => parseBool(value)),
  X402_MODE: z.enum(['off', 'simulated', 'strict']).default('simulated'),
  X402_FACILITATOR_URL: z.string().default('https://facilitator.openx402.ai'),
  X402_ALLOWED_DOMAINS: z.string().default('conway.tech'),
  X402_MAX_SINGLE_PAYMENT_CENTS: z.coerce.number().int().min(1).max(100_000).default(100),
  X402_BUDGET_CENTS: z.coerce.number().int().min(1).max(10_000_000).default(5000),
  X402_TIMEOUT_MS: z.coerce.number().int().min(200).max(60_000).default(8000),
  X402_STATIC_PAYMENT_TOKEN: z.string().optional(),
  X402_DEMO_INTEL_URL: z.string().optional(),
  X402_DEMO_INTEL_METHOD: z.enum(['GET', 'POST']).default('POST'),
  RESPAWN_FEE_CREDITS: z
    .string()
    .regex(/^\d+$/)
    .default('100'),
  RESPAWN_COOLDOWN_SECONDS: z.coerce.number().int().min(0).default(60)
});

const parsedEnv = envSchema.parse(process.env);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

if (parsedEnv.MARKET_ENABLED) {
  if (!parsedEnv.MARKET_RPC_URL || !/^https?:\/\//.test(parsedEnv.MARKET_RPC_URL)) {
    throw new Error('MARKET_RPC_URL is required when MARKET_ENABLED=true');
  }
  if (!parsedEnv.MARKET_CONTRACT_ADDRESS || !/^0x[a-fA-F0-9]{40}$/.test(parsedEnv.MARKET_CONTRACT_ADDRESS)) {
    throw new Error('MARKET_CONTRACT_ADDRESS is required when MARKET_ENABLED=true');
  }
  if (
    !parsedEnv.MARKET_OPERATOR_PRIVATE_KEY ||
    !/^(0x)?[a-fA-F0-9]{64}$/.test(parsedEnv.MARKET_OPERATOR_PRIVATE_KEY)
  ) {
    throw new Error('MARKET_OPERATOR_PRIVATE_KEY is required when MARKET_ENABLED=true');
  }
}

if (parsedEnv.ERC8004_ENABLED) {
  if (!parsedEnv.ERC8004_RPC_URL || !/^https?:\/\//.test(parsedEnv.ERC8004_RPC_URL)) {
    throw new Error('ERC8004_RPC_URL is required when ERC8004_ENABLED=true');
  }
  if (
    !parsedEnv.ERC8004_IDENTITY_CONTRACT ||
    !/^0x[a-fA-F0-9]{40}$/.test(parsedEnv.ERC8004_IDENTITY_CONTRACT)
  ) {
    throw new Error('ERC8004_IDENTITY_CONTRACT is required when ERC8004_ENABLED=true');
  }
}

if (!/^https?:\/\//.test(parsedEnv.ERC8004_IPFS_GATEWAY)) {
  throw new Error('ERC8004_IPFS_GATEWAY must be a valid http(s) URL');
}

if (parsedEnv.X402_ENABLED && parsedEnv.X402_DEMO_INTEL_URL) {
  if (!/^https?:\/\//.test(parsedEnv.X402_DEMO_INTEL_URL)) {
    throw new Error('X402_DEMO_INTEL_URL must be a valid http(s) URL');
  }
}

if (!/^https?:\/\//.test(parsedEnv.X402_FACILITATOR_URL)) {
  throw new Error('X402_FACILITATOR_URL must be a valid http(s) URL');
}

if (parsedEnv.AI_PROVIDER === 'openrouter') {
  if (!parsedEnv.OPENROUTER_API_KEY) {
    throw new Error('OPENROUTER_API_KEY is required when AI_PROVIDER=openrouter');
  }
  if (!parsedEnv.OPENROUTER_MODEL) {
    throw new Error('OPENROUTER_MODEL is required when AI_PROVIDER=openrouter');
  }
  if (!/^https?:\/\//.test(parsedEnv.OPENROUTER_BASE_URL)) {
    throw new Error('OPENROUTER_BASE_URL must be a valid http(s) URL');
  }
}

if (
  parsedEnv.M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID.trim() &&
  !UUID_REGEX.test(parsedEnv.M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID.trim())
) {
  throw new Error('M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID must be a valid UUID');
}

if (
  parsedEnv.M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID.trim() &&
  !UUID_REGEX.test(parsedEnv.M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID.trim())
) {
  throw new Error('M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID must be a valid UUID');
}

export const env = {
  ...parsedEnv,
  X402_ENABLED: parsedEnv.X402_ENABLED && parsedEnv.X402_MODE !== 'off',
  M2_MARKET_MAX_SINGLE_TRADE_GROSS_CREDITS: BigInt(parsedEnv.M2_MARKET_MAX_SINGLE_TRADE_GROSS_CREDITS),
  M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID:
    parsedEnv.M2_AUTO_TRADE_DEFAULT_SELLER_AGENT_ID.trim() || undefined,
  M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID:
    parsedEnv.M2_AUTO_TRADE_DEFAULT_BUYER_AGENT_ID.trim() || undefined,
  M2_AUTO_TRADE_DEFAULT_BUYER_CREDITS_TARGET: BigInt(
    parsedEnv.M2_AUTO_TRADE_DEFAULT_BUYER_CREDITS_TARGET
  ),
  M2_AUTO_TRADE_DEFAULT_SELLER_EQUIPMENT_TARGET: BigInt(
    parsedEnv.M2_AUTO_TRADE_DEFAULT_SELLER_EQUIPMENT_TARGET
  ),
  M2_EQUIPMENT_WHITELIST_ITEMS: parsedEnv.M2_EQUIPMENT_WHITELIST
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0),
  X402_ALLOWED_DOMAINS_ITEMS: parsedEnv.X402_ALLOWED_DOMAINS
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item.length > 0),
  ERC8004_IDENTITY_CONTRACT: parsedEnv.ERC8004_IDENTITY_CONTRACT?.toLowerCase(),
  MARKET_OPERATOR_PRIVATE_KEY:
    parsedEnv.MARKET_OPERATOR_PRIVATE_KEY &&
    !parsedEnv.MARKET_OPERATOR_PRIVATE_KEY.startsWith('0x')
      ? `0x${parsedEnv.MARKET_OPERATOR_PRIVATE_KEY}`
      : parsedEnv.MARKET_OPERATOR_PRIVATE_KEY
};
