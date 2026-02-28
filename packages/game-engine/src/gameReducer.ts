
import { GameState, GameAction, Player, GridCell, Item, Slot } from '@tactical/shared-types';
import { generateInitialState } from './gameInit';
import { calculateTotalAtk, calculateTotalDef } from './gameLogic';
import { generateLoot } from './lootSystem';

const GRID_SIZE = 8;
const isAlivePlayer = (player: Player) => player.status === 'ALIVE';
const markPlayerDead = (player: Player, stats?: Player['stats']): Player => ({
  ...player,
  status: 'DEAD',
  agent: player.agent ? { ...player.agent, lifecycleStatus: 'DEAD' } : player.agent,
  stats: { ...(stats ?? player.stats), hp: 0 },
  market: { ...player.market, price: 0, trend: 'DOWN' }
});

// 辅助函数：更新股价
// impact: 价格变动百分比 (例如 0.05 代表涨 5%, -0.05 代表跌 5%)
const updatePrice = (player: Player, impact: number, randomNoise: boolean = true): Player => {
  if (!isAlivePlayer(player)) {
    return {
      ...player,
      market: { ...player.market, price: 0, trend: 'DOWN', history: [...player.market.history, 0].slice(-20) }
    };
  }

  // 添加随机市场波动噪音 (-1% 到 +1%)
  const noise = randomNoise ? (Math.random() * 0.02 - 0.01) : 0;
  const changePercent = impact + noise;
  
  let newPrice = player.market.price * (1 + changePercent);
  newPrice = Math.max(0.1, parseFloat(newPrice.toFixed(2))); // 最低价格 0.1

  const trend = newPrice > player.market.price ? 'UP' : (newPrice < player.market.price ? 'DOWN' : 'FLAT');
  const newHistory = [...player.market.history, newPrice].slice(-20); // 保留最后20个数据点

  return {
    ...player,
    market: {
      ...player.market,
      lastPrice: player.market.price,
      price: newPrice,
      history: newHistory,
      trend
    }
  };
};

export const gameReducer = (state: GameState, action: GameAction): GameState => {
  const newLog = [...state.log];
  const addLog = (msg: string) => {
    newLog.push(`> ${msg}`);
    if (newLog.length > 50) newLog.shift();
  };

  /**
   * 增强版回合推进逻辑
   */
  const getNextStateWithActivePlayer = (currentState: GameState): GameState => {
    let nextIndex = currentState.activePlayerIndex + 1;
    
    if (nextIndex >= currentState.players.length) {
      return gameReducer({ ...currentState, activePlayerIndex: 0 }, { type: 'NEXT_TURN' });
    }

    if (!isAlivePlayer(currentState.players[nextIndex])) {
      return getNextStateWithActivePlayer({ ...currentState, activePlayerIndex: nextIndex });
    }
    
    return { ...currentState, activePlayerIndex: nextIndex, log: newLog };
  };

  switch (action.type) {
    case 'SET_LANGUAGE':
      return { ...state, language: action.payload };

    case 'UPDATE_SETTINGS':
      return { ...state, settings: { ...state.settings, ...action.payload } };

    case 'START_GAME':
      return {
        ...generateInitialState(
          action.payload.humanCount,
          action.payload.aiCount,
          action.payload.agentSnapshots
        ),
        language: state.language
      };

    case 'LOAD_GAME':
      return { ...action.payload, phase: 'ACTIVE' };

    case 'EXIT_TO_MENU':
      return { ...state, phase: 'WAITING' };

    case 'INIT_AGENT':
      addLog(state.language === 'zh' ? '指令确认：AI AGENT 已激活。' : 'COMMAND CONFIRMED: AI AGENT ACTIVATED.');
      addLog(state.language === 'zh' ? '>>> 任务开始。祝好运。' : '>>> MISSION START. GOOD LUCK.');
      return {
        ...state,
        aiConfig: action.payload,
        phase: 'ACTIVE'
      };

    // 新增：购买股票逻辑
    case 'MARKET_BUY': {
      const { playerId, amount } = action.payload; // amount 是购买的金额
      const pIdx = state.players.findIndex(p => p.id === playerId);
      const player = state.players[pIdx];

      if (!player || !isAlivePlayer(player)) {
         // 简单的错误提示，实际UI可能不显示
         return state;
      }

      if (state.userBalance < amount) return state;

      const sharesToBuy = amount / player.market.price;
      
      const updatedPlayers = [...state.players];
      
      // 购买导致股价上涨 (模拟 Bonding Curve: 买入推高价格, 简单设为 +2% 每次购买)
      const newPlayerState = updatePrice(player, 0.02, false);
      newPlayerState.market.sharesOwned += sharesToBuy;
      
      updatedPlayers[pIdx] = newPlayerState;

      addLog(state.language === 'zh' 
        ? `MARKET: 买入 ${player.name} $${amount}。股价上涨。` 
        : `MARKET: BOUGHT ${player.name} FOR $${amount}. PRICE UP.`);

      return {
        ...state,
        userBalance: state.userBalance - amount,
        players: updatedPlayers,
        log: newLog
      };
    }

    case 'KILL_ALL_AI': {
      const human = state.players.find(p => !p.isAi);
      const updatedPlayers = state.players.map(p => {
        if (p.isAi) {
          // AI 死亡，股价归零
          return markPlayerDead(p, { ...p.stats });
        }
        return p;
      });

      addLog(state.language === 'zh' ? 'ADMIN: 强制离线所有敌对 AI。' : 'ADMIN: PURGED ALL AI.');

      // KILL_ALL_AI should hard-stop the current game in all modes.
      // This avoids managed-mode edge cases where game remains ACTIVE.
      // Keep winner deterministic for post-game market resolve/claim:
      // if human exists, force winner to human on KILL_ALL_AI (managed/manual parity).
      const winner = human ?? state.winner;
      if (human && winner && winner.id === human.id) {
        addLog(state.language === 'zh' ? '系统: 威胁清除完毕。胜利。' : 'SYSTEM: THREATS ELIMINATED. VICTORY.');
      } else {
        addLog(state.language === 'zh' ? '系统: 回合已强制终止。' : 'SYSTEM: ROUND FORCE-TERMINATED.');
      }

      return { 
        ...state, 
        players: updatedPlayers, 
        phase: 'GAME_OVER',
        winner, 
        activePlayerIndex: 0, 
        log: newLog 
      };
    }

    case 'MOVE': {
      const { playerId, direction } = action.payload;
      const playerIndex = state.players.findIndex(p => p.id === playerId);
      const player = state.players[playerIndex];
      if (!player || !isAlivePlayer(player)) return getNextStateWithActivePlayer(state);
      
      const { x, y } = player.position;
      let newX = x, newY = y;
      if (direction === 'UP') newY--;
      if (direction === 'DOWN') newY++;
      if (direction === 'LEFT') newX--;
      if (direction === 'RIGHT') newX++;

      if (newX < 0 || newX >= GRID_SIZE || newY < 0 || newY >= GRID_SIZE || player.stats.hunger < 2 || player.stats.thirst < 5) {
        addLog(state.language === 'zh' ? `${player.name} 无法移动。` : `${player.name} MOVE BLOCKED.`);
        return getNextStateWithActivePlayer(state);
      }

      const updatedPlayers = [...state.players];
      // 移动消耗体力，股价微小随机波动 (模拟活跃度)
      const movedPlayer = updatePrice(player, 0.005); // 活跃 +0.5%
      updatedPlayers[playerIndex] = {
        ...movedPlayer,
        position: { x: newX, y: newY },
        stats: { ...player.stats, hunger: Math.max(0, player.stats.hunger - 2), thirst: Math.max(0, player.stats.thirst - 5) }
      };

      const updatedGrid = state.grid.map(row => row.map(cell => ({ ...cell, players: [...cell.players] })));
      updatedGrid[y][x].players = updatedGrid[y][x].players.filter(id => id !== playerId);
      updatedGrid[newY][newX].players.push(playerId);
      
      addLog(state.language === 'zh' ? `${player.name} 移动至 [${newX}, ${newY}]。` : `${player.name} MOVED TO [${newX}, ${newY}].`);
      return getNextStateWithActivePlayer({ ...state, players: updatedPlayers, grid: updatedGrid });
    }

    case 'SEARCH': {
      const { playerId } = action.payload;
      const pIdx = state.players.findIndex(p => p.id === playerId);
      const player = state.players[pIdx];
      if (!player || !isAlivePlayer(player)) return getNextStateWithActivePlayer(state);
      const isManagedHuman =
        !player.isAi && (state.aiConfig?.humanControlMode ?? 'manual') === 'managed';

      const successProb = state.settings?.searchSuccessRate ?? 0.5;
      const isSuccess = Math.random() < successProb;

      const updatedPlayers = [...state.players];
      // 搜索行为本身消耗资源，轻微利空，但如果成功则大涨
      updatedPlayers[pIdx] = { ...player, stats: { ...player.stats, hunger: Math.max(0, player.stats.hunger - 5) } };

      if (!isSuccess) {
        // 搜索失败，股价微跌
        updatedPlayers[pIdx] = updatePrice(updatedPlayers[pIdx], -0.01); 
        addLog(state.language === 'zh' ? `[${player.name}] 搜索无果。` : `[${player.name}] SEARCH FAILED.`);
        return getNextStateWithActivePlayer({ ...state, players: updatedPlayers });
      }

      const loot = generateLoot();
      if (!loot) return getNextStateWithActivePlayer({ ...state, players: updatedPlayers });
      
      // 发现物资，股价大涨 +5%
      updatedPlayers[pIdx] = updatePrice(updatedPlayers[pIdx], 0.05);

      if (isManagedHuman) {
        if (player.inventory.length < 8) {
          updatedPlayers[pIdx] = {
            ...updatedPlayers[pIdx],
            inventory: [...updatedPlayers[pIdx].inventory, loot]
          };
          addLog(
            state.language === 'zh'
              ? `托管模式: ${player.name} 自动拾取了 ${loot.name}。`
              : `MANAGED MODE: ${player.name} AUTO-TOOK ${loot.name}.`
          );
        } else {
          addLog(
            state.language === 'zh'
              ? `托管模式: ${player.name} 背包已满，自动丢弃 ${loot.name}。`
              : `MANAGED MODE: ${player.name} INV FULL, AUTO-DISCARDED ${loot.name}.`
          );
        }
        return getNextStateWithActivePlayer({ ...state, players: updatedPlayers });
      }

      if (!player.isAi) {
        return { ...state, players: updatedPlayers, phase: 'LOOTING', pendingLoot: loot, log: newLog };
      } else {
        if (player.inventory.length < 8) {
          updatedPlayers[pIdx] = {
            ...updatedPlayers[pIdx],
            inventory: [...updatedPlayers[pIdx].inventory, loot]
          };
          addLog(state.language === 'zh' ? `AI ${player.name} 拾取了 ${loot.name}。` : `AI ${player.name} TOOK ${loot.name}.`);
        }
        return getNextStateWithActivePlayer({ ...state, players: updatedPlayers });
      }
    }

    case 'TAKE_LOOT': {
      const { playerId } = action.payload;
      const pIdx = state.players.findIndex(p => p.id === playerId);
      if (pIdx === -1 || !state.pendingLoot) return { ...state, phase: 'ACTIVE' };
      
      const player = state.players[pIdx];
      const updatedPlayers = [...state.players];
      
      if (player.inventory.length < 8) {
        // 成功获取装备，股价大涨
        const lootPlayer = updatePrice(player, 0.05);
        updatedPlayers[pIdx] = { ...lootPlayer, inventory: [...player.inventory, state.pendingLoot] };
        addLog(state.language === 'zh' ? `获得了 ${state.pendingLoot.name}。` : `ACQUIRED ${state.pendingLoot.name}.`);
      } else {
        addLog(state.language === 'zh' ? `背包已满，未能获得物品。` : `INV FULL, ITEM DISCARDED.`);
      }

      const intermediateState = { ...state, players: updatedPlayers, phase: 'ACTIVE' as const, pendingLoot: null };
      return getNextStateWithActivePlayer(intermediateState);
    }

    case 'DISCARD_LOOT':
      addLog(state.language === 'zh' ? `舍弃了发现的物资。` : `ITEM DISCARDED.`);
      return getNextStateWithActivePlayer({ ...state, phase: 'ACTIVE', pendingLoot: null });

    case 'ATTACK': {
      const { attackerId, targetId } = action.payload;
      const attackerIdx = state.players.findIndex(p => p.id === attackerId);
      const targetIdx = state.players.findIndex(p => p.id === targetId);
      const attacker = state.players[attackerIdx];
      const target = state.players[targetIdx];

      if (!attacker || !target || !isAlivePlayer(attacker) || !isAlivePlayer(target)) {
        return getNextStateWithActivePlayer(state);
      }

      const damage = Math.max(1, calculateTotalAtk(attacker) - calculateTotalDef(target));
      const updatedPlayers = [...state.players];
      const newHp = Math.max(0, target.stats.hp - damage);
      
      // 攻击者表现积极，股价上涨 +3%
      let newAttacker = updatePrice(attacker, 0.03);
      // 受害者受伤，股价下跌 -5% (如果死亡则会在下面处理)
      let newTarget = updatePrice(target, -0.05);

      const nextTargetStatus = newHp <= 0 ? 'DEAD' : 'ALIVE';
      newTarget = {
        ...newTarget,
        agent: newTarget.agent
          ? {
              ...newTarget.agent,
              lifecycleStatus: nextTargetStatus === 'DEAD' ? 'DEAD' : newTarget.agent.lifecycleStatus
            }
          : newTarget.agent,
        stats: { ...newTarget.stats, hp: newHp },
        status: nextTargetStatus
      };

      // 如果目标死亡，攻击者股价再次暴涨 +10%，目标股价归零
      if (newHp <= 0) {
        newAttacker = updatePrice(newAttacker, 0.10);
        newTarget.market.price = 0;
        newTarget.market.trend = 'DOWN';
      }

      updatedPlayers[attackerIdx] = newAttacker;
      updatedPlayers[targetIdx] = newTarget;

      addLog(state.language === 'zh' ? `${attacker.name} -> ${target.name} [-${damage}HP]` : `${attacker.name} -> ${target.name} [-${damage}HP]`);
      
      if (newHp <= 0) {
        addLog(state.language === 'zh' ? `${target.name} 已被淘汰。` : `${target.name} ELIMINATED.`);
      }

      return getNextStateWithActivePlayer({ ...state, players: updatedPlayers });
    }

    case 'USE_ITEM': {
      const { playerId, itemId } = action.payload;
      const pIdx = state.players.findIndex(p => p.id === playerId);
      const player = state.players[pIdx];
      const itemIdx = player.inventory.findIndex(i => i.id === itemId);
      const item = player.inventory[itemIdx];
      if (!item) return getNextStateWithActivePlayer(state);

      const updatedPlayers = [...state.players];
      
      // 使用物品，生存几率增加，股价小涨 +2%
      const usedItemPlayer = updatePrice(player, 0.02);

      const updatedPlayer = { ...usedItemPlayer, inventory: [...player.inventory] };
      updatedPlayer.inventory.splice(itemIdx, 1);

      if (item.type === 'WEAPON' || item.type === 'ARMOR') {
        const slot = item.slot || (item.type === 'WEAPON' ? 'WEAPON' : 'BODY');
        const oldItem = player.equipment[slot];
        if (oldItem) updatedPlayer.inventory.push(oldItem);
        updatedPlayer.equipment[slot] = item;
      } else {
        if (item.stats.heal) updatedPlayer.stats.hp = Math.min(updatedPlayer.stats.maxHp, updatedPlayer.stats.hp + item.stats.heal);
        if (item.stats.hunger) updatedPlayer.stats.hunger = Math.min(updatedPlayer.stats.maxHunger, updatedPlayer.stats.hunger + item.stats.hunger);
        if (item.stats.thirst) updatedPlayer.stats.thirst = Math.min(updatedPlayer.stats.maxThirst, updatedPlayer.stats.thirst + item.stats.thirst);
      }
      
      updatedPlayers[pIdx] = updatedPlayer;
      addLog(state.language === 'zh' ? `使用了 ${item.name}。` : `USED ${item.name}.`);
      return getNextStateWithActivePlayer({ ...state, players: updatedPlayers });
    }

    case 'PICKUP_ITEM': {
      const { playerId, itemId } = action.payload;
      const pIdx = state.players.findIndex(p => p.id === playerId);
      const player = state.players[pIdx];
      const { x, y } = player.position;
      const item = state.grid[y][x].items.find(i => i.id === itemId);
      
      if (!item || player.inventory.length >= 8) return getNextStateWithActivePlayer(state);
      
      const updatedPlayers = [...state.players];
      // 捡东西，股价涨
      const pickedPlayer = updatePrice(player, 0.03);

      updatedPlayers[pIdx] = { ...pickedPlayer, inventory: [...player.inventory, item] };
      const updatedGrid = state.grid.map((row, ry) => row.map((c, cx) => 
        (ry === y && cx === x) ? { ...c, items: c.items.filter(i => i.id !== itemId) } : c
      ));
      
      addLog(state.language === 'zh' ? `拾取了地面的物品。` : `PICKED UP ITEM.`);
      return getNextStateWithActivePlayer({ ...state, players: updatedPlayers, grid: updatedGrid });
    }

    case 'SKIP_TURN':
      return getNextStateWithActivePlayer(state);

    case 'NEXT_TURN': {
      let updatedTurnCount = state.turnCount + 1;
      let updatedGrid = state.grid.map(row => row.map(cell => ({ ...cell, isWarning: false, players: [...cell.players], items: [...cell.items] })));
      
      state.grid.forEach((row, y) => row.forEach((cell, x) => {
        if (cell.isWarning) updatedGrid[y][x].isRestricted = true;
      }));

      if ((updatedTurnCount + 1) % 5 === 0) {
        const potential = [];
        for (let y = 0; y < GRID_SIZE; y++) 
          for (let x = 0; x < GRID_SIZE; x++) 
            if (!updatedGrid[y][x].isRestricted) potential.push({x, y});
        if (potential.length > 0) {
          const t = potential[Math.floor(Math.random() * potential.length)];
          updatedGrid[t.y][t.x].isWarning = true;
          addLog(state.language === 'zh' ? `! 警告：区域 [${t.x}, ${t.y}] 即将坍塌。` : `! WARNING: SECTOR [${t.x}, ${t.y}] COLLAPSE IMMINENT.`);
        }
      }

      let updatedPlayers = state.players.map(p => {
        if (!isAlivePlayer(p)) return p;
        
        // 环境回合：所有存活玩家因为存活了一轮，股价微涨 +1%
        let newP = updatePrice(p, 0.01);

        const stats = { ...newP.stats, hunger: Math.max(0, newP.stats.hunger - 1), thirst: Math.max(0, newP.stats.thirst - 1) };
        
        if (updatedGrid[newP.position.y][newP.position.x].isRestricted) {
          addLog(state.language === 'zh' ? `${newP.name} 被禁区吞噬。` : `${newP.name} DIED IN ZONE.`);
          // 禁区死亡
          return markPlayerDead(newP, stats);
        }
        return { ...newP, stats };
      });

      const alive = updatedPlayers.filter(p => p.status === 'ALIVE');
      let phase = state.phase;
      let winner = state.winner;

      if (alive.length === 1) { 
        phase = 'GAME_OVER'; 
        winner = alive[0]; 
      } else if (alive.length === 0) { 
        phase = 'GAME_OVER'; 
      }
      
      return { 
        ...state, 
        turnCount: updatedTurnCount, 
        activePlayerIndex: 0, 
        players: updatedPlayers, 
        grid: updatedGrid, 
        phase: phase === 'LOOTING' ? 'ACTIVE' : phase, 
        winner, 
        log: newLog 
      };
    }

    default:
      return state;
  }
};
