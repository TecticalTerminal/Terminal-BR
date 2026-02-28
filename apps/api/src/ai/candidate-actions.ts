import { decideAiAction } from '@tactical/game-engine';
import type { GameAction, GameState, Player } from '@tactical/shared-types';

export interface AiActionCandidate {
  id: string;
  action: GameAction;
  label: string;
}

const GRID_SIZE = 8;
const MOVE_DIRECTIONS: Array<'UP' | 'DOWN' | 'LEFT' | 'RIGHT'> = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

function getPlayer(state: GameState, playerId: string): Player | null {
  const found = state.players.find((player) => player.id === playerId);
  return found ?? null;
}

function canMoveInDirection(player: Player, direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT'): boolean {
  if (player.stats.hunger < 2 || player.stats.thirst < 5) return false;

  let nextX = player.position.x;
  let nextY = player.position.y;
  if (direction === 'UP') nextY -= 1;
  if (direction === 'DOWN') nextY += 1;
  if (direction === 'LEFT') nextX -= 1;
  if (direction === 'RIGHT') nextX += 1;
  return nextX >= 0 && nextX < GRID_SIZE && nextY >= 0 && nextY < GRID_SIZE;
}

function isSameCell(a: Player, b: Player): boolean {
  return a.position.x === b.position.x && a.position.y === b.position.y;
}

export function buildAiActionCandidates(state: GameState, aiId: string): AiActionCandidate[] {
  const ai = getPlayer(state, aiId);
  if (!ai || ai.status !== 'ALIVE') {
    return [];
  }

  const candidates: AiActionCandidate[] = [];

  for (const direction of MOVE_DIRECTIONS) {
    if (!canMoveInDirection(ai, direction)) continue;
    candidates.push({
      id: `move_${direction.toLowerCase()}`,
      action: { type: 'MOVE', payload: { playerId: aiId, direction } },
      label: `MOVE ${direction}`
    });
  }

  candidates.push({
    id: 'search',
    action: { type: 'SEARCH', payload: { playerId: aiId } },
    label: 'SEARCH'
  });

  for (const target of state.players) {
    if (target.id === aiId || target.status !== 'ALIVE') continue;
    if (!isSameCell(ai, target)) continue;
    candidates.push({
      id: `attack_${target.id}`,
      action: { type: 'ATTACK', payload: { attackerId: aiId, targetId: target.id } },
      label: `ATTACK ${target.id}`
    });
  }

  const useItems = ai.inventory.slice(0, 4);
  for (const item of useItems) {
    candidates.push({
      id: `use_${item.id}`,
      action: { type: 'USE_ITEM', payload: { playerId: aiId, itemId: item.id } },
      label: `USE_ITEM ${item.id}`
    });
  }

  const currentCell = state.grid[ai.position.y]?.[ai.position.x];
  if (currentCell && ai.inventory.length < 8) {
    for (const item of currentCell.items.slice(0, 3)) {
      candidates.push({
        id: `pickup_${item.id}`,
        action: { type: 'PICKUP_ITEM', payload: { playerId: aiId, itemId: item.id } },
        label: `PICKUP_ITEM ${item.id}`
      });
    }
  }

  candidates.push({
    id: 'skip',
    action: { type: 'SKIP_TURN', payload: { playerId: aiId } },
    label: 'SKIP_TURN'
  });

  return candidates;
}

export function buildStateSummary(state: GameState, aiId: string) {
  const ai = getPlayer(state, aiId);
  if (!ai) {
    return {
      aiId,
      phase: state.phase,
      note: 'AI not found'
    };
  }

  const currentCell = state.grid[ai.position.y]?.[ai.position.x];
  const nearbyAlivePlayers = state.players
    .filter((player) => player.id !== aiId && player.status === 'ALIVE' && isSameCell(player, ai))
    .map((player) => ({
      id: player.id,
      hp: player.stats.hp
    }));

  return {
    ai: {
      id: ai.id,
      hp: ai.stats.hp,
      hunger: ai.stats.hunger,
      thirst: ai.stats.thirst,
      inventoryCount: ai.inventory.length,
      position: ai.position
    },
    phase: state.phase,
    turnCount: state.turnCount,
    activePlayerIndex: state.activePlayerIndex,
    cell: currentCell
      ? {
          isRestricted: currentCell.isRestricted,
          isWarning: currentCell.isWarning,
          itemCount: currentCell.items.length,
          players: currentCell.players
        }
      : null,
    nearbyAlivePlayers
  };
}

export function sanitizeActionForAi(
  state: GameState,
  aiId: string,
  action: GameAction
): GameAction | null {
  const candidates = buildAiActionCandidates(state, aiId);
  const candidate = candidates.find((entry) => JSON.stringify(entry.action) === JSON.stringify(action));
  if (candidate) return candidate.action;

  if (action.type === 'NEXT_TURN') {
    return action;
  }

  return null;
}

export function fallbackRuleAction(state: GameState, aiId: string): GameAction {
  const fromRules = decideAiAction(state, aiId);
  const sanitized = sanitizeActionForAi(state, aiId, fromRules);
  if (sanitized) return sanitized;
  return { type: 'SKIP_TURN', payload: { playerId: aiId } };
}
