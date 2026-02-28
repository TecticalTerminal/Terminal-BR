import { z } from 'zod';

export const DATA_MODEL_FREEZE_VERSION = 'm1m2-v1';

const evmAddressRegex = /^0x[a-fA-F0-9]{40}$/;
const integerStringRegex = /^-?\d+$/;

export const agentKindSchema = z.enum(['user', 'bot']);
export const agentStatusSchema = z.enum(['active', 'dead', 'respawning']);
export const custodyModeSchema = z.enum(['server_managed', 'external_signer']);

export const agentSchema = z.object({
  id: z.string().uuid(),
  kind: agentKindSchema,
  status: agentStatusSchema,
  walletId: z.string().uuid().nullable(),
  erc8004AgentId: z.string().regex(/^\d+$/).nullable(),
  isEnabled: z.boolean(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const agentWalletSchema = z
  .object({
    id: z.string().uuid(),
    agentId: z.string().uuid(),
    custodyMode: custodyModeSchema,
    address: z.string().regex(evmAddressRegex, 'Invalid EVM address'),
    encryptedPrivateKey: z.string().min(1).nullable(),
    kmsKeyId: z.string().min(1).nullable(),
    signerPolicyJson: z.record(z.string(), z.unknown()).nullable(),
    lastKnownNonce: z.string().regex(/^\d+$/).nullable(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .superRefine((value, ctx) => {
    if (value.custodyMode === 'server_managed' && !value.encryptedPrivateKey) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['encryptedPrivateKey'],
        message: 'encryptedPrivateKey is required for server_managed custody mode'
      });
    }
  });

export const agentProfileSchema = z.object({
  agentId: z.string().uuid(),
  displayName: z.string().min(1).max(128),
  avatarUri: z.string().url().nullable(),
  promptDefault: z.string().min(1),
  promptOverride: z.string().min(1).nullable(),
  strategyTags: z.array(z.string().min(1).max(64)),
  metadataJson: z.record(z.string(), z.unknown()),
  profileVersion: z.number().int().positive(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const assetScopeSchema = z.enum(['round', 'persistent']);
export const assetTypeSchema = z.enum(['currency', 'equipment', 'material']);
export const ledgerReasonSchema = z.enum([
  'round_start',
  'loot',
  'shop_buy',
  'shop_sell',
  'round_settlement',
  'respawn_fee',
  'market_lock',
  'market_settle',
  'admin_adjust'
]);

export const agentAssetLedgerSchema = z.object({
  id: z.string().regex(/^\d+$/),
  agentId: z.string().uuid(),
  gameId: z.string().uuid().nullable(),
  scope: assetScopeSchema,
  assetType: assetTypeSchema,
  assetId: z.string().min(1).max(128),
  delta: z.string().regex(integerStringRegex),
  balanceAfter: z.string().regex(integerStringRegex),
  reason: ledgerReasonSchema,
  refType: z.string().min(1).max(32).nullable(),
  refId: z.string().min(1).max(128).nullable(),
  createdAt: z.string().datetime()
});

export const respawnStatusSchema = z.enum([
  'pending',
  'cooling',
  'completed',
  'failed',
  'cancelled'
]);

export const respawnRecordSchema = z.object({
  id: z.string().uuid(),
  agentId: z.string().uuid(),
  gameId: z.string().uuid().nullable(),
  deathSeq: z.string().regex(/^\d+$/).nullable(),
  feeAmount: z.string().regex(/^\d+$/),
  currencyAssetId: z.string().min(1).max(64),
  cooldownSeconds: z.number().int().nonnegative(),
  availableAt: z.string().datetime(),
  respawnedAt: z.string().datetime().nullable(),
  status: respawnStatusSchema,
  paidLedgerId: z.string().regex(/^\d+$/).nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const listingStatusSchema = z.enum(['open', 'filled', 'cancelled', 'expired']);

export const marketListingSchema = z.object({
  id: z.string().uuid(),
  sellerAgentId: z.string().uuid(),
  assetId: z.string().min(1).max(128),
  assetType: z.literal('equipment'),
  quantity: z.number().int().positive(),
  unitPrice: z.string().regex(/^\d+$/),
  feeBps: z.number().int().min(0).max(10_000),
  status: listingStatusSchema,
  expiresAt: z.string().datetime().nullable(),
  closedAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
});

export const tradeStatusSchema = z.enum(['settled', 'reverted']);

export const marketTradeSchema = z
  .object({
    id: z.string().uuid(),
    listingId: z.string().uuid(),
    buyerAgentId: z.string().uuid(),
    sellerAgentId: z.string().uuid(),
    assetId: z.string().min(1).max(128),
    quantity: z.number().int().positive(),
    unitPrice: z.string().regex(/^\d+$/),
    grossAmount: z.string().regex(/^\d+$/),
    feeAmount: z.string().regex(/^\d+$/),
    netAmount: z.string().regex(/^(-?\d+)$/),
    status: tradeStatusSchema,
    txRef: z.string().min(1).max(128).nullable(),
    settledAt: z.string().datetime(),
    createdAt: z.string().datetime()
  })
  .superRefine((value, ctx) => {
    const quantity = BigInt(value.quantity);
    const unitPrice = BigInt(value.unitPrice);
    const gross = BigInt(value.grossAmount);
    const fee = BigInt(value.feeAmount);
    const net = BigInt(value.netAmount);

    if (quantity * unitPrice !== gross) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['grossAmount'],
        message: 'grossAmount must equal quantity * unitPrice'
      });
    }

    if (gross - fee !== net) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['netAmount'],
        message: 'netAmount must equal grossAmount - feeAmount'
      });
    }
  });

export type Agent = z.infer<typeof agentSchema>;
export type AgentWallet = z.infer<typeof agentWalletSchema>;
export type AgentProfile = z.infer<typeof agentProfileSchema>;
export type AgentAssetLedger = z.infer<typeof agentAssetLedgerSchema>;
export type RespawnRecord = z.infer<typeof respawnRecordSchema>;
export type MarketListing = z.infer<typeof marketListingSchema>;
export type MarketTrade = z.infer<typeof marketTradeSchema>;
