import { createHash } from 'node:crypto';
import type { GameState } from '@tactical/shared-types';

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortDeep);
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a.localeCompare(b)
    );
    const output: Record<string, unknown> = {};
    for (const [key, nested] of entries) {
      output[key] = sortDeep(nested);
    }
    return output;
  }
  return value;
}

export function hashState(state: GameState): string {
  // Never include api key in hash material.
  const sanitized: GameState = {
    ...state,
    aiConfig: state.aiConfig ? { ...state.aiConfig, apiKey: '' } : undefined
  };
  const stable = JSON.stringify(sortDeep(sanitized));
  return createHash('sha256').update(stable).digest('hex');
}
