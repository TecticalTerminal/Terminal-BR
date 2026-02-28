import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { PoolClient } from 'pg';
import { v4 as uuidv4 } from 'uuid';
import { env } from '../config.js';
import { pool } from '../db/pool.js';
import { HttpError } from '../utils/http-error.js';
import { CastWalletSigner } from './cast-wallet.js';

export interface WalletSigningPolicy {
  maxAmountWei: string;
  dailyLimitWei: string;
  dailySpentWei: string;
  dailyWindowStart: string;
}

export interface ManagedWalletView {
  walletId: string;
  agentId: string;
  custodyMode: 'server_managed' | 'external_signer';
  address: string;
  lastKnownNonce: string | null;
  policy: WalletSigningPolicy;
  createdAt: string;
  updatedAt: string;
}

export interface WalletSnapshot {
  agentId: string;
  wallet: ManagedWalletView | null;
}

export interface EnsureManagedWalletInput {
  agentId: string;
  forceRotate?: boolean;
  policy?: Partial<Pick<WalletSigningPolicy, 'maxAmountWei' | 'dailyLimitWei'>>;
}

export interface BindExternalWalletInput {
  agentId: string;
  address: string;
  forceReplace?: boolean;
}

export interface SignMessageInput {
  agentId: string;
  message: string;
  amountWei?: string;
  purpose?: string;
}

export interface SignMessageResult {
  agentId: string;
  address: string;
  signature: string;
  purpose: string;
  policy: WalletSigningPolicy;
}

export interface WalletCustodyService {
  getWalletSnapshot(agentId: string): Promise<WalletSnapshot>;
  ensureManagedWallet(input: EnsureManagedWalletInput): Promise<ManagedWalletView>;
  bindExternalWallet(input: BindExternalWalletInput): Promise<ManagedWalletView>;
  signMessage(input: SignMessageInput): Promise<SignMessageResult>;
}

interface WalletDbRow {
  agent_id: string;
  agent_kind: 'user' | 'bot';
  wallet_id: string | null;
  custody_mode: 'server_managed' | 'external_signer' | null;
  address: string | null;
  encrypted_private_key: string | null;
  signer_policy_json: unknown;
  last_known_nonce: string | null;
  wallet_created_at: string | Date | null;
  wallet_updated_at: string | Date | null;
}

const defaultMaxAmountWei = BigInt(env.WALLET_SIGN_MAX_AMOUNT_WEI);
const defaultDailyLimitWei = BigInt(env.WALLET_SIGN_DAILY_LIMIT_WEI);
const masterKey = (() => {
  const raw = env.WALLET_ENCRYPTION_KEY.trim();
  if (/^(0x)?[a-fA-F0-9]{64}$/.test(raw)) {
    return Buffer.from(raw.replace(/^0x/, ''), 'hex');
  }
  return createHash('sha256').update(raw).digest();
})();

function todayDateString(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function parseNonNegativeWei(value: string, field: string): bigint {
  if (!/^\d+$/.test(value)) {
    throw new HttpError(400, `${field} must be an unsigned integer string.`);
  }
  return BigInt(value);
}

function parseAddress(value: string, field: string): string {
  const normalized = value.trim();
  if (!/^0x[a-fA-F0-9]{40}$/.test(normalized)) {
    throw new HttpError(400, `${field} must be a valid 0x-prefixed EVM address.`);
  }
  return normalized;
}

function mapDbError(error: unknown): never {
  const dbError = error as { code?: string; message?: string; constraint?: string };
  if (dbError.code === '23505') {
    throw new HttpError(409, `Unique constraint violation: ${dbError.constraint ?? 'unknown'}`);
  }
  if (dbError.code === '23503') {
    throw new HttpError(409, `Foreign key violation: ${dbError.constraint ?? 'unknown'}`);
  }
  if (dbError.code === '23514') {
    throw new HttpError(400, `Constraint violation: ${dbError.constraint ?? dbError.message ?? ''}`.trim());
  }
  throw error;
}

function normalizePolicy(
  raw: unknown,
  overrides?: Partial<Pick<WalletSigningPolicy, 'maxAmountWei' | 'dailyLimitWei'>>
): WalletSigningPolicy {
  const input =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? (raw as Partial<WalletSigningPolicy>)
      : {};

  const maxAmountWei = overrides?.maxAmountWei ?? input.maxAmountWei ?? defaultMaxAmountWei.toString();
  const dailyLimitWei =
    overrides?.dailyLimitWei ?? input.dailyLimitWei ?? defaultDailyLimitWei.toString();
  const dailySpentWei = input.dailySpentWei ?? '0';
  const dailyWindowStart = input.dailyWindowStart ?? todayDateString();

  const max = parseNonNegativeWei(maxAmountWei, 'policy.maxAmountWei');
  const daily = parseNonNegativeWei(dailyLimitWei, 'policy.dailyLimitWei');
  const spent = parseNonNegativeWei(dailySpentWei, 'policy.dailySpentWei');
  if (max > daily) {
    throw new HttpError(400, 'policy.maxAmountWei cannot exceed policy.dailyLimitWei.');
  }
  if (spent > daily) {
    throw new HttpError(400, 'policy.dailySpentWei cannot exceed policy.dailyLimitWei.');
  }

  return {
    maxAmountWei: max.toString(),
    dailyLimitWei: daily.toString(),
    dailySpentWei: spent.toString(),
    dailyWindowStart
  };
}

function encryptPrivateKey(privateKey: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', masterKey, iv);
  const ciphertext = Buffer.concat([cipher.update(privateKey, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${ciphertext.toString('hex')}`;
}

function decryptPrivateKey(payload: string): string {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'v1') {
    throw new HttpError(500, 'Invalid encrypted private key payload.');
  }
  const [, ivHex, tagHex, dataHex] = parts;
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const ciphertext = Buffer.from(dataHex, 'hex');
  const decipher = createDecipheriv('aes-256-gcm', masterKey, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  if (!/^0x[a-fA-F0-9]{64}$/.test(plaintext)) {
    throw new HttpError(500, 'Decrypted private key is invalid.');
  }
  return plaintext;
}

function mapWalletRow(row: WalletDbRow): ManagedWalletView | null {
  if (!row.wallet_id || !row.custody_mode || !row.address || !row.wallet_created_at || !row.wallet_updated_at) {
    return null;
  }
  return {
    walletId: row.wallet_id,
    agentId: row.agent_id,
    custodyMode: row.custody_mode,
    address: row.address,
    lastKnownNonce: row.last_known_nonce,
    policy: normalizePolicy(row.signer_policy_json),
    createdAt: new Date(row.wallet_created_at).toISOString(),
    updatedAt: new Date(row.wallet_updated_at).toISOString()
  };
}

async function loadWalletRow(client: PoolClient, agentId: string, forUpdate = false): Promise<WalletDbRow> {
  const result = await client.query(
    `
      SELECT
        a.id AS agent_id,
        a.kind AS agent_kind,
        w.id AS wallet_id,
        w.custody_mode,
        w.address,
        w.encrypted_private_key,
        w.signer_policy_json,
        w.last_known_nonce,
        w.created_at AS wallet_created_at,
        w.updated_at AS wallet_updated_at
      FROM agent a
      LEFT JOIN agent_wallet w ON w.agent_id = a.id
      WHERE a.id = $1
      ${forUpdate ? 'FOR UPDATE OF a' : ''}
      LIMIT 1
    `,
    [agentId]
  );

  if (!result.rowCount) {
    throw new HttpError(404, `Agent not found: ${agentId}`);
  }
  const row = result.rows[0] as WalletDbRow;

  // `agent_wallet` is nullable in LEFT JOIN; lock it separately when present.
  if (forUpdate && row.wallet_id) {
    await client.query(
      `
        SELECT id
        FROM agent_wallet
        WHERE id = $1
        FOR UPDATE
      `,
      [row.wallet_id]
    );
  }

  return row;
}

class PostgresWalletCustodyService implements WalletCustodyService {
  private readonly signer = new CastWalletSigner();

  async getWalletSnapshot(agentId: string): Promise<WalletSnapshot> {
    const client = await pool.connect();
    try {
      const row = await loadWalletRow(client, agentId, false);
      return {
        agentId,
        wallet: mapWalletRow(row)
      };
    } finally {
      client.release();
    }
  }

  private async createOrRotateManagedWalletTx(
    client: PoolClient,
    row: WalletDbRow,
    input: EnsureManagedWalletInput
  ): Promise<string> {
    const nextPolicy = normalizePolicy(row.signer_policy_json, input.policy);
    const rawPrivateKey = `0x${randomBytes(32).toString('hex')}`;
    const address = await this.signer.addressFromPrivateKey(rawPrivateKey);
    const encrypted = encryptPrivateKey(rawPrivateKey);

    if (row.wallet_id) {
      await client.query(
        `UPDATE agent_wallet
         SET custody_mode = 'server_managed',
             address = $2,
             encrypted_private_key = $3,
             signer_policy_json = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [row.wallet_id, address, encrypted, JSON.stringify(nextPolicy)]
      );
      await client.query(
        `UPDATE agent
         SET wallet_id = $2, updated_at = NOW()
         WHERE id = $1`,
        [row.agent_id, row.wallet_id]
      );
      return row.wallet_id;
    }

    const walletId = uuidv4();
    await client.query(
      `INSERT INTO agent_wallet (
         id,
         agent_id,
         custody_mode,
         address,
         encrypted_private_key,
         signer_policy_json
       ) VALUES ($1, $2, 'server_managed', $3, $4, $5)`,
      [walletId, row.agent_id, address, encrypted, JSON.stringify(nextPolicy)]
    );
    await client.query(
      `UPDATE agent
       SET wallet_id = $2, updated_at = NOW()
       WHERE id = $1`,
      [row.agent_id, walletId]
    );
    return walletId;
  }

  private async updateManagedPolicyTx(
    client: PoolClient,
    row: WalletDbRow,
    policy: Partial<Pick<WalletSigningPolicy, 'maxAmountWei' | 'dailyLimitWei'>>
  ): Promise<void> {
    if (!row.wallet_id) {
      throw new HttpError(409, 'Managed wallet does not exist.');
    }
    if (row.custody_mode !== 'server_managed' || !row.encrypted_private_key) {
      throw new HttpError(409, 'Managed wallet does not exist.');
    }

    const nextPolicy = normalizePolicy(row.signer_policy_json, policy);
    await client.query(
      `UPDATE agent_wallet
       SET signer_policy_json = $2,
           updated_at = NOW()
       WHERE id = $1`,
      [row.wallet_id, JSON.stringify(nextPolicy)]
    );
  }

  async ensureManagedWallet(input: EnsureManagedWalletInput): Promise<ManagedWalletView> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await loadWalletRow(client, input.agentId, true);
      if (row.agent_kind !== 'bot') {
        throw new HttpError(409, `Only bot agents can use managed custody. agentKind=${row.agent_kind}`);
      }

      const current = mapWalletRow(row);
      const hasReusableManagedWallet =
        current &&
        row.custody_mode === 'server_managed' &&
        !!row.encrypted_private_key;

      if (hasReusableManagedWallet && !input.forceRotate && input.policy) {
        await this.updateManagedPolicyTx(client, row, input.policy);
      } else if (!(hasReusableManagedWallet && !input.forceRotate && !input.policy)) {
        await this.createOrRotateManagedWalletTx(client, row, input);
      }

      const refreshed = await loadWalletRow(client, input.agentId, false);
      const wallet = mapWalletRow(refreshed);
      if (!wallet) {
        throw new HttpError(500, 'Failed to initialize managed wallet.');
      }

      await client.query('COMMIT');
      return wallet;
    } catch (error) {
      await client.query('ROLLBACK');
      mapDbError(error);
    } finally {
      client.release();
    }
  }

  async bindExternalWallet(input: BindExternalWalletInput): Promise<ManagedWalletView> {
    const address = parseAddress(input.address, 'address');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await loadWalletRow(client, input.agentId, true);
      if (row.agent_kind !== 'user') {
        throw new HttpError(409, `Only user agents can bind external signer wallet. agentKind=${row.agent_kind}`);
      }

      const existingWalletId = row.wallet_id;
      if (existingWalletId) {
        if (row.custody_mode === 'server_managed' && !input.forceReplace) {
          throw new HttpError(
            409,
            'User currently has a server_managed wallet. Set forceReplace=true to switch to external_signer.'
          );
        }
        await client.query(
          `UPDATE agent_wallet
           SET custody_mode = 'external_signer',
               address = $2,
               encrypted_private_key = NULL,
               kms_key_id = NULL,
               signer_policy_json = NULL,
               last_known_nonce = NULL,
               updated_at = NOW()
           WHERE id = $1`,
          [existingWalletId, address]
        );
        await client.query(
          `UPDATE agent
           SET wallet_id = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [row.agent_id, existingWalletId]
        );
      } else {
        const walletId = uuidv4();
        await client.query(
          `INSERT INTO agent_wallet (
             id,
             agent_id,
             custody_mode,
             address,
             encrypted_private_key,
             kms_key_id,
             signer_policy_json,
             last_known_nonce
           ) VALUES ($1, $2, 'external_signer', $3, NULL, NULL, NULL, NULL)`,
          [walletId, row.agent_id, address]
        );
        await client.query(
          `UPDATE agent
           SET wallet_id = $2,
               updated_at = NOW()
           WHERE id = $1`,
          [row.agent_id, walletId]
        );
      }

      const refreshed = await loadWalletRow(client, input.agentId, false);
      const wallet = mapWalletRow(refreshed);
      if (!wallet) {
        throw new HttpError(500, 'Failed to bind external wallet.');
      }
      await client.query('COMMIT');
      return wallet;
    } catch (error) {
      await client.query('ROLLBACK');
      mapDbError(error);
    } finally {
      client.release();
    }
  }

  async signMessage(input: SignMessageInput): Promise<SignMessageResult> {
    const message = input.message.trim();
    if (!message) {
      throw new HttpError(400, 'message is required.');
    }
    const amountWei = input.amountWei ? parseNonNegativeWei(input.amountWei, 'amountWei') : 0n;
    const purpose = (input.purpose ?? 'generic').trim() || 'generic';

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const row = await loadWalletRow(client, input.agentId, true);
      const wallet = mapWalletRow(row);
      if (!wallet) {
        throw new HttpError(404, `Wallet not found for agent: ${input.agentId}`);
      }
      if (wallet.custodyMode !== 'server_managed') {
        throw new HttpError(409, `Wallet custody mode ${wallet.custodyMode} does not support server signing.`);
      }
      if (!row.encrypted_private_key) {
        throw new HttpError(500, 'Managed wallet private key payload missing.');
      }

      let policy = normalizePolicy(row.signer_policy_json);
      const today = todayDateString();
      if (policy.dailyWindowStart !== today) {
        policy = {
          ...policy,
          dailyWindowStart: today,
          dailySpentWei: '0'
        };
      }

      const maxAmount = BigInt(policy.maxAmountWei);
      const dailyLimit = BigInt(policy.dailyLimitWei);
      const dailySpent = BigInt(policy.dailySpentWei);

      if (amountWei > maxAmount) {
        throw new HttpError(
          403,
          `Signing amount exceeds per-request limit. amount=${amountWei.toString()} max=${maxAmount.toString()}`
        );
      }
      if (dailySpent + amountWei > dailyLimit) {
        throw new HttpError(
          403,
          `Signing amount exceeds daily limit. spent=${dailySpent.toString()} amount=${amountWei.toString()} dailyLimit=${dailyLimit.toString()}`
        );
      }

      const privateKey = decryptPrivateKey(row.encrypted_private_key);
      const signature = await this.signer.signMessage(privateKey, message);

      const nextPolicy: WalletSigningPolicy = {
        ...policy,
        dailySpentWei: (dailySpent + amountWei).toString()
      };
      await client.query(
        `UPDATE agent_wallet
         SET signer_policy_json = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [wallet.walletId, JSON.stringify(nextPolicy)]
      );

      await client.query('COMMIT');
      return {
        agentId: input.agentId,
        address: wallet.address,
        signature,
        purpose,
        policy: nextPolicy
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
}

export function createWalletCustodyService(): WalletCustodyService {
  return new PostgresWalletCustodyService();
}
