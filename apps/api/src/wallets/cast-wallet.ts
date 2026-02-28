import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { HttpError } from '../utils/http-error.js';

const execFileAsync = promisify(execFile);

function normalizePrivateKey(privateKey: string): string {
  const normalized = privateKey.startsWith('0x') ? privateKey : `0x${privateKey}`;
  if (!/^0x[a-fA-F0-9]{64}$/.test(normalized)) {
    throw new HttpError(400, 'Invalid private key format.');
  }
  return normalized;
}

function parseAddress(output: string): string {
  const match = output.match(/\b0x[a-fA-F0-9]{40}\b/);
  if (!match) {
    throw new HttpError(502, `Failed to parse wallet address from cast output: ${output}`);
  }
  return match[0];
}

function parseSignature(output: string): string {
  const match = output.match(/\b0x[a-fA-F0-9]{130}\b/);
  if (!match) {
    throw new HttpError(502, `Failed to parse wallet signature from cast output: ${output}`);
  }
  return match[0];
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
    throw new HttpError(502, `cast wallet command failed: ${details || 'unknown error'}`);
  }
}

export class CastWalletSigner {
  async addressFromPrivateKey(privateKey: string): Promise<string> {
    const normalized = normalizePrivateKey(privateKey);
    const output = await runCast(['wallet', 'address', '--private-key', normalized]);
    return parseAddress(output);
  }

  async signMessage(privateKey: string, message: string): Promise<string> {
    const normalized = normalizePrivateKey(privateKey);
    const output = await runCast(['wallet', 'sign', '--private-key', normalized, message]);
    return parseSignature(output);
  }
}
