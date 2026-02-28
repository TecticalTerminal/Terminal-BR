import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from '../utils/http-error.js';

const execFileAsync = promisify(execFile);

function sanitizeArgs(args: string[]): string[] {
  const sanitized = [...args];
  for (let i = 0; i < sanitized.length; i += 1) {
    if (sanitized[i] === '--private-key' && i + 1 < sanitized.length) {
      sanitized[i + 1] = '***';
      i += 1;
    }
  }
  return sanitized;
}

function firstNumberLikeToken(input: string): string | null {
  const token = input.match(/0x[0-9a-fA-F]+|\b\d+\b/);
  return token ? token[0] : null;
}

function parseTxHash(output: string): string | null {
  const direct = output.match(/transactionHash\s+([0-9a-fA-Fx]{66})/i);
  if (direct?.[1]) return direct[1].toLowerCase();

  const fallback = output.match(/\b0x[0-9a-fA-F]{64}\b/);
  return fallback ? fallback[0].toLowerCase() : null;
}

async function runCast(operation: string, args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('cast', args, {
      maxBuffer: 4 * 1024 * 1024
    });
    return `${stdout}\n${stderr}`.trim();
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const details = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    const safeArgs = sanitizeArgs(args).join(' ');
    throw new HttpError(
      502,
      `cast ${operation} failed (args: ${safeArgs}): ${details || 'unknown error'}`
    );
  }
}

export class CastMarketClient {
  constructor(
    private readonly rpcUrl: string,
    private readonly contractAddress: string,
    private readonly operatorPrivateKey: string
  ) {}

  async chainId(): Promise<number> {
    const out = await runCast('chain-id', ['chain-id', '--rpc-url', this.rpcUrl]);
    const token = firstNumberLikeToken(out);
    if (!token) throw new HttpError(502, `Unable to parse chain-id from cast output: ${out}`);
    return Number(token);
  }

  async keccak(input: string): Promise<string> {
    const out = await runCast('keccak', ['keccak', input]);
    const hash = out.match(/0x[0-9a-fA-F]{64}/)?.[0];
    if (!hash) throw new HttpError(502, `Unable to parse keccak hash from cast output: ${out}`);
    return hash.toLowerCase();
  }

  async openRound(gameIdHash: string, lockAt: number): Promise<string | null> {
    const out = await runCast('send.openRound', [
      'send',
      this.contractAddress,
      'openRound(bytes32,uint64)',
      gameIdHash,
      String(lockAt),
      '--private-key',
      this.operatorPrivateKey,
      '--rpc-url',
      this.rpcUrl
    ]);
    return parseTxHash(out);
  }

  async resolveRound(roundId: string, winnerOutcomeHash: string): Promise<string | null> {
    const out = await runCast('send.resolveRound', [
      'send',
      this.contractAddress,
      'resolveRound(uint256,bytes32)',
      roundId,
      winnerOutcomeHash,
      '--private-key',
      this.operatorPrivateKey,
      '--rpc-url',
      this.rpcUrl
    ]);
    return parseTxHash(out);
  }

  async getRoundIdByGameHash(gameIdHash: string): Promise<string> {
    const out = await runCast('call.roundIdByGame', [
      'call',
      this.contractAddress,
      'roundIdByGame(bytes32)(uint256)',
      gameIdHash,
      '--rpc-url',
      this.rpcUrl
    ]);
    const token = firstNumberLikeToken(out);
    if (!token) {
      throw new HttpError(502, `Unable to parse round id from cast output: ${out}`);
    }

    try {
      if (token.startsWith('0x')) return BigInt(token).toString();
      return BigInt(token).toString();
    } catch {
      throw new HttpError(502, `Invalid round id token from cast output: ${token}`);
    }
  }
}
