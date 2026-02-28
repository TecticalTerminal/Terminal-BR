
import { GameState, GameAction, Player, GridCell, Item } from '@tactical/shared-types';

/**
 * AI 决策核心函数
 * 按照优先级：逃离禁区 > 生存维持 > 战斗行为 > 资源搜刮 > 随机游荡/向中心移动
 */
export const decideAiAction = (gameState: GameState, aiId: string): GameAction => {
  const player = gameState.players.find(p => p.id === aiId);
  if (!player || player.status === 'DEAD') {
    return { type: 'NEXT_TURN' }; // 如果死亡或找不到，跳过
  }

  const { x, y } = player.position;
  const currentCell = gameState.grid[y][x];

  // --- 优先级 1: 紧急避险 (逃离禁区) ---
  if (currentCell.isRestricted) {
    const safeMove = getSafeDirection(gameState, player);
    if (safeMove) return safeMove;
  }

  // --- 优先级 2: 生存维持 (状态检查) ---
  // HP 低于 40 或 饥饿/口渴低于 25 时尝试使用消耗品
  if (player.stats.hp < 40 || player.stats.hunger < 25 || player.stats.thirst < 25) {
    const survivalItem = player.inventory.find(item => item.type === 'CONSUMABLE');
    if (survivalItem) {
      return { type: 'USE_ITEM', payload: { playerId: aiId, itemId: survivalItem.id } };
    }
  }

  // --- 优先级 3: 战斗决策 (同格攻击) ---
  // 检查当前格子内是否有其他活着的玩家
  const otherPlayerId = currentCell.players.find(pid => {
    const p = gameState.players.find(playerObj => playerObj.id === pid);
    return pid !== aiId && p && p.status === 'ALIVE';
  });

  if (otherPlayerId) {
    // 简单的侵略性检查：如果 HP 高于 30 则尝试攻击
    if (player.stats.hp > 30) {
      return { type: 'ATTACK', payload: { attackerId: aiId, targetId: otherPlayerId } };
    } else {
      // HP 太低，尝试逃离
      const fleeMove = getSafeDirection(gameState, player);
      if (fleeMove) return fleeMove;
    }
  }

  // --- 优先级 4: 资源搜刮 (搜索或拾取) ---
  // 如果地面上有物品且背包未满
  if (currentCell.items.length > 0 && player.inventory.length < 8) {
    return { type: 'PICKUP_ITEM', payload: { playerId: aiId, itemId: currentCell.items[0].id } };
  }

  // 如果处于安全区域且饥饿值允许，尝试搜索
  if (player.stats.hunger > 30) {
    // 50% 几率搜索，50% 几率移动（避免死守一个格子）
    if (Math.random() > 0.5) {
      return { type: 'SEARCH', payload: { playerId: aiId } };
    }
  }

  // --- 优先级 5: 战略移动 (向中心靠拢) ---
  const centerMove = getMoveTowardsCenter(gameState, player);
  if (centerMove) return centerMove;

  // 最后兜底：结束回合
  return { type: 'NEXT_TURN' };
};

/**
 * 获取逃离禁区的安全方向
 */
function getSafeDirection(gameState: GameState, player: Player): GameAction | null {
  const { x, y } = player.position;
  const directions: ('UP' | 'DOWN' | 'LEFT' | 'RIGHT')[] = ['UP', 'DOWN', 'LEFT', 'RIGHT'];
  
  // 随机打乱方向增加多样性
  directions.sort(() => Math.random() - 0.5);

  for (const dir of directions) {
    let nx = x, ny = y;
    if (dir === 'UP') ny--;
    if (dir === 'DOWN') ny++;
    if (dir === 'LEFT') nx--;
    if (dir === 'RIGHT') nx++;

    // 检查边界
    if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8) {
      const cell = gameState.grid[ny][nx];
      // 如果目标格子不是禁区
      if (!cell.isRestricted) {
        return { type: 'MOVE', payload: { playerId: player.id, direction: dir } };
      }
    }
  }
  return null;
}

/**
 * 计算向地图中心移动的方向
 */
function getMoveTowardsCenter(gameState: GameState, player: Player): GameAction | null {
  const { x, y } = player.position;
  const targetX = 3.5; // 8x8 的中心点
  const targetY = 3.5;

  const possibleDirs: ('UP' | 'DOWN' | 'LEFT' | 'RIGHT')[] = [];

  if (x < targetX) possibleDirs.push('RIGHT');
  else if (x > targetX) possibleDirs.push('LEFT');

  if (y < targetY) possibleDirs.push('DOWN');
  else if (y > targetY) possibleDirs.push('UP');

  // 随机选一个能缩短距离的方向
  for (const dir of possibleDirs.sort(() => Math.random() - 0.5)) {
    let nx = x, ny = y;
    if (dir === 'UP') ny--;
    if (dir === 'DOWN') ny++;
    if (dir === 'LEFT') nx--;
    if (dir === 'RIGHT') nx++;

    if (nx >= 0 && nx < 8 && ny >= 0 && ny < 8 && !gameState.grid[ny][nx].isRestricted) {
      return { type: 'MOVE', payload: { playerId: player.id, direction: dir } };
    }
  }

  return getSafeDirection(gameState, player); // 如果不能靠近中心，就随机找个安全地方
}
