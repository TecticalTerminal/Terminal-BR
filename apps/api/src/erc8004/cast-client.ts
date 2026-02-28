import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from '../utils/http-error.js';

const execFileAsync = promisify(execFile);

function firstNumberLikeToken(input: string): string | null {
  const token = input.match(/0x[0-9a-fA-F]+|\b\d+\b/);
  return token ? token[0] : null;
}

function firstAddressToken(input: string): string | null {
  const token = input.match(/\b0x[0-9a-fA-F]{40}\b/);
  return token ? token[0].toLowerCase() : null;
}

function parseTxHash(output: string): string | null {
  const direct = output.match(/transactionHash\s+([0-9a-fA-Fx]{66})/i);
  if (direct?.[1]) return direct[1].toLowerCase();

  const fallback = output.match(/\b0x[0-9a-fA-F]{64}\b/);
  return fallback ? fallback[0].toLowerCase() : null;
}

function parseOutputString(output: string): string {
  const normalized = output
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (!normalized.length) return '';
  const first = normalized[0];
  if (
    (first.startsWith('"') && first.endsWith('"')) ||
    (first.startsWith("'") && first.endsWith("'"))
  ) {
    return first.slice(1, -1);
  }
  return first;
}

async function runCast(args: string[]): Promise<string> {
  try {
    const { stdout, stderr } = await execFileAsync('cast', args, {
      maxBuffer: 4 * 1024 * 1024
    });
    return `${stdout}\n${stderr}`.trim();
  } catch (error: unknown) {
    const err = error as { stdout?: string; stderr?: string; message?: string };
    const details = [err.stdout, err.stderr, err.message].filter(Boolean).join('\n');
    throw new HttpError(502, `cast command failed: ${details || 'unknown error'}`);
  }
}

export class CastErc8004Client {
  constructor(
    private readonly rpcUrl: string,
    private readonly identityContract: string
  ) {}

  async chainId(): Promise<number> {
    const out = await runCast(['chain-id', '--rpc-url', this.rpcUrl]);
    const token = firstNumberLikeToken(out);
    if (!token) throw new HttpError(502, `Unable to parse chain-id from cast output: ${out}`);
    return Number(token);
  }

  async totalSupply(): Promise<string> {
    const out = await runCast([
      'call',
      this.identityContract,
      'totalSupply()(uint256)',
      '--rpc-url',
      this.rpcUrl
    ]);
    const token = firstNumberLikeToken(out);
    if (!token) throw new HttpError(502, `Unable to parse totalSupply from cast output: ${out}`);
    return token.startsWith('0x') ? BigInt(token).toString() : BigInt(token).toString();
  }

  async ownerOf(tokenId: string): Promise<string> {
    const out = await runCast([
      'call',
      this.identityContract,
      'ownerOf(uint256)(address)',
      tokenId,
      '--rpc-url',
      this.rpcUrl
    ]);
    const address = firstAddressToken(out);
    if (!address) throw new HttpError(502, `Unable to parse ownerOf(${tokenId}): ${out}`);
    return address;
  }

  async agentURI(tokenId: string): Promise<string> {
    const out = await runCast([
      'call',
      this.identityContract,
      'agentURI(uint256)(string)',
      tokenId,
      '--rpc-url',
      this.rpcUrl
    ]);
    return parseOutputString(out);
  }

  async register(agentUri: string, privateKey: string): Promise<string> {
    const out = await runCast([
      'send',
      this.identityContract,
      'register(string)',
      agentUri,
      '--private-key',
      privateKey,
      '--rpc-url',
      this.rpcUrl
    ]);
    const txHash = parseTxHash(out);
    if (!txHash) throw new HttpError(502, `Unable to parse register tx hash from cast output: ${out}`);
    return txHash;
  }

  async updateAgentURI(tokenId: string, newAgentUri: string, privateKey: string): Promise<string> {
    const out = await runCast([
      'send',
      this.identityContract,
      'updateAgentURI(uint256,string)',
      tokenId,
      newAgentUri,
      '--private-key',
      privateKey,
      '--rpc-url',
      this.rpcUrl
    ]);
    const txHash = parseTxHash(out);
    if (!txHash) {
      throw new HttpError(502, `Unable to parse updateAgentURI tx hash from cast output: ${out}`);
    }
    return txHash;
  }
}
