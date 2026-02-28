import { GameState, GameAction, Player, PERSONALITY_CONFIGS, AiPersonality, PersonalityConfig, AgentSnapshot } from '@tactical/shared-types';
import { fuseBehaviorConfig, generateFusedBehaviorDescription, getBehaviorStyleLabels } from './behaviorFusion.js';

// AI 记忆存储 (模块级)
const aiMemories = new Map<string, {
  lastSeenEnemies: Map<string, { x: number; y: number; turn: number }>;
  dangerousAreas: Set<string>;
  grudges: Map<string, number>;
  lastAction: string;
  consecutiveSkips: number;
}>();

// 获取或创建 AI 记忆
function getAiMemory(aiId: string) {
  if (!aiMemories.has(aiId)) {
    aiMemories.set(aiId, {
      lastSeenEnemies: new Map(),
      dangerousAreas: new Set(),
      grudges: new Map(),
      lastAction: '',
      consecutiveSkips: 0
    });
  }
  return aiMemories.get(aiId)!;
}

// 清除所有 AI 记忆
export function clearAiMemories() {
  aiMemories.clear();
}

// 随机分配 AI 个性
export function assignAiPersonality(): AiPersonality {
  const personalities: AiPersonality[] = ['AGGRESSIVE', 'CAUTIOUS', 'EXPLORER', 'OPPORTUNIST'];
  return personalities[Math.floor(Math.random() * personalities.length)];
}

// 解析个性 (处理 RANDOM 类型)
function resolvePersonality(personality?: AiPersonality): AiPersonality {
  if (!personality || personality === 'RANDOM') {
    return assignAiPersonality();
  }
  return personality;
}

// 战斗力计算
function calculatePower(player: Player): number {
  const hpFactor = player.stats.hp / player.stats.maxHp;
  const weaponAtk = player.equipment.WEAPON?.stats.atk || 0;
  const defValue = Object.values(player.equipment)
    .reduce((sum, item) => sum + (item?.stats.def || 0), 0);
  return (weaponAtk * 2 + defValue + 10) * hpFactor;
}

// 查找附近敌人 (在指定范围内)
function findNearbyEnemy(
  gameState: GameState,
  player: Player,
  range: number
): { enemy: Player; distance: number } | null {
  const { x, y } = player.position;
  const gridSize = 8;

  for (let r = 1; r <= range; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.abs(dx) !== r && Math.abs(dy) !== r) continue;

        const nx = x + dx;
        const ny = y + dy;

        if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;

        const cell = gameState.grid[ny]?.[nx];
        if (!cell) continue;

        for (const playerId of cell.players) {
          if (playerId === player.id) continue;
          const target = gameState.players.find(p => p.id === playerId);
          if (target && target.status === 'ALIVE') {
            return { enemy: target, distance: r };
          }
        }
      }
    }
  }
  return null;
}

// 获取移动方向
function getMoveDirection(
  fromX: number,
  fromY: number,
  toX: number,
  toY: number
): 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' | null {
  const dx = toX - fromX;
  const dy = toY - fromY;

  if (Math.abs(dx) > Math.abs(dy)) {
    return dx > 0 ? 'RIGHT' : 'LEFT';
  } else {
    return dy > 0 ? 'DOWN' : 'UP';
  }
}

// 智能移动 (避开危险区域)
function getSmartMove(
  gameState: GameState,
  player: Player,
  preferX?: number,
  preferY?: number
): GameAction | null {
  const { x, y } = player.position;
  const gridSize = 8;
  const memory = getAiMemory(player.id);
  const directions: Array<'UP' | 'DOWN' | 'LEFT' | 'RIGHT'> = ['UP', 'DOWN', 'LEFT', 'RIGHT'];

  // 根据偏好目标排序方向
  if (preferX !== undefined || preferY !== undefined) {
    directions.sort((a, b) => {
      let ax = x, ay = y;
      if (a === 'UP') ay--;
      if (a === 'DOWN') ay++;
      if (a === 'LEFT') ax--;
      if (a === 'RIGHT') ax++;

      let bx = x, by = y;
      if (b === 'UP') by--;
      if (b === 'DOWN') by++;
      if (b === 'LEFT') bx--;
      if (b === 'RIGHT') bx++;

      const distA = Math.hypot(ax - (preferX ?? x), ay - (preferY ?? y));
      const distB = Math.hypot(bx - (preferX ?? x), by - (preferY ?? y));

      return distA - distB;
    });
  } else {
    // 随机打乱
    directions.sort(() => Math.random() - 0.5);
  }

  for (const dir of directions) {
    let nx = x, ny = y;
    if (dir === 'UP') ny--;
    if (dir === 'DOWN') ny++;
    if (dir === 'LEFT') nx--;
    if (dir === 'RIGHT') nx++;

    if (nx < 0 || nx >= gridSize || ny < 0 || ny >= gridSize) continue;

    const cell = gameState.grid[ny][nx];
    if (cell.isRestricted) continue;
    if (memory.dangerousAreas.has(`${nx},${ny}`)) continue;

    return { type: 'MOVE', payload: { playerId: player.id, direction: dir } };
  }

  return null;
}

// 主决策函数 (基于个性，规则模式忽略 prompt)
export function decideAiActionWithPersonality(
  gameState: GameState,
  aiId: string,
  personality?: AiPersonality
): GameAction {
  const player = gameState.players.find(p => p.id === aiId);
  if (!player || player.status === 'DEAD') {
    return { type: 'NEXT_TURN' };
  }

  // 解析个性（使用传入的个性或玩家自身的个性）
  const resolvedPersonality = resolvePersonality(personality || player.personality);
  const config = PERSONALITY_CONFIGS[resolvedPersonality];
  const memory = getAiMemory(aiId);

  // 更新记忆：清除过期的敌人位置
  for (const [enemyId, data] of memory.lastSeenEnemies.entries()) {
    if (gameState.turnCount - data.turn > 3) {
      memory.lastSeenEnemies.delete(enemyId);
    }
  }

  const { x, y } = player.position;
  const currentCell = gameState.grid[y][x];

  // === 优先级 1: 紧急生存 ===
  // HP 或 饥饿/口渴 极低时使用消耗品
  if (player.stats.hp < 25 || player.stats.hunger < 20 || player.stats.thirst < 20) {
    const consumable = player.inventory.find(item => item.type === 'CONSUMABLE');
    if (consumable) {
      memory.lastAction = 'USE_ITEM';
      return { type: 'USE_ITEM', payload: { playerId: aiId, itemId: consumable.id } };
    }
  }

  // === 优先级 2: 逃离禁区 ===
  if (currentCell.isRestricted) {
    const move = getSmartMove(gameState, player);
    if (move) return move;
  }

  // === 优先级 3: 同格敌人战斗决策 ===
  const sameCellEnemyId = currentCell.players
    .find(pid => {
      const p = gameState.players.find(pl => pl.id === pid);
      return pid !== aiId && p && p.status === 'ALIVE';
    });

  const sameCellEnemy = sameCellEnemyId
    ? gameState.players.find(p => p.id === sameCellEnemyId)
    : null;

  if (sameCellEnemy) {
    const myPower = calculatePower(player);
    const enemyPower = calculatePower(sameCellEnemy);
    const powerRatio = myPower / (enemyPower || 1);

    // 根据融合后的配置决定是否战斗
    if (player.stats.hp > config.attackThreshold && powerRatio * 100 >= config.riskTolerance) {
      memory.lastAction = 'ATTACK';
      return { type: 'ATTACK', payload: { attackerId: aiId, targetId: sameCellEnemy.id } };
    } else {
      // 逃跑
      const fleeMove = getSmartMove(gameState, player);
      if (fleeMove) {
        memory.lastAction = 'FLEE';
        // 标记当前位置为危险
        memory.dangerousAreas.add(`${x},${y}`);
        return fleeMove;
      }
    }
  }

  // === 优先级 4: 拾取物品 ===
  if (currentCell.items.length > 0 && player.inventory.length < 6) {
    memory.lastAction = 'PICKUP_ITEM';
    return { type: 'PICKUP_ITEM', payload: { playerId: aiId, itemId: currentCell.items[0].id } };
  }

  // === 优先级 5: 主动追击 (基于融合配置的攻击性) ===
  if (config.aggression >= 60) {
    const nearby = findNearbyEnemy(gameState, player, config.chaseRange);
    if (nearby && player.stats.hp > config.attackThreshold) {
      // 更新敌人位置记忆
      memory.lastSeenEnemies.set(nearby.enemy.id, {
        x: nearby.enemy.position.x,
        y: nearby.enemy.position.y,
        turn: gameState.turnCount
      });

      const move = getSmartMove(gameState, player, nearby.enemy.position.x, nearby.enemy.position.y);
      if (move) {
        memory.lastAction = 'CHASE';
        return move;
      }
    }
  }

  // === 优先级 6: 融合配置驱动的行为 ===
  const random = Math.random() * 100;

  // 根据探索倾向决定搜索（降低饥饿要求，提高优先级）
  if (config.exploration >= 70 && player.stats.hunger > 10) {
    if (random < config.searchProbability) {
      memory.lastAction = 'SEARCH';
      return { type: 'SEARCH', payload: { playerId: aiId } };
    }
  }

  // 高攻击性: 继续寻找敌人或随机移动
  if (config.aggression >= 70) {
    const nearby = findNearbyEnemy(gameState, player, config.chaseRange + 1);
    if (nearby) {
      const move = getSmartMove(gameState, player, nearby.enemy.position.x, nearby.enemy.position.y);
      if (move) return move;
    }
    // 随机移动保持活跃
    if (random < 50) {
      const move = getSmartMove(gameState, player);
      if (move) return move;
    }
  }

  // 高生存/低攻击性: 搜索概率低，优先移动到安全区域（降低饥饿要求）
  if (config.survival >= 70 || config.aggression <= 30) {
    if (random < config.searchProbability && player.stats.hunger > 20) {
      memory.lastAction = 'SEARCH';
      return { type: 'SEARCH', payload: { playerId: aiId } };
    }
    // 向中心移动（相对安全）
    const move = getSmartMove(gameState, player, 3.5, 3.5);
    if (move) return move;
  }

  // === 优先级 7: 默认搜索（降低饥饿要求） ===
  if (player.stats.hunger > 15 && random < 65) {
    memory.lastAction = 'SEARCH';
    return { type: 'SEARCH', payload: { playerId: aiId } };
  }

  // === 优先级 8: 智能移动 ===
  const move = getSmartMove(gameState, player);
  if (move) return move;

  memory.consecutiveSkips++;
  memory.lastAction = 'SKIP';
  return { type: 'NEXT_TURN' };
}
