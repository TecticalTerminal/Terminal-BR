import { AgentSnapshot, GameState, GridCell, Player, Item, Slot, AiPersonality } from '@tactical/shared-types';
import { resolveAiPersonality, generateDefaultPromptForPersonality } from './promptTemplate.js';

const GRID_SIZE = 8;

const getInitialLoadout = (): { weapon: Item; bread: Item; water: Item } => ({
  weapon: {
    id: `item-init-weapon-${Math.random()}`,
    name: 'WOODEN STICK',
    type: 'WEAPON',
    rarity: 'COMMON',
    stats: { atk: 1 },
    description: '一块随处可见的木棍。'
  },
  bread: {
    id: `item-init-food-${Math.random()}`,
    name: 'BREAD',
    type: 'CONSUMABLE',
    rarity: 'COMMON',
    stats: { hunger: 40 },
    description: '干燥但能填饱肚子的面包。'
  },
  water: {
    id: `item-init-water-${Math.random()}`,
    name: 'WATER',
    type: 'CONSUMABLE',
    rarity: 'COMMON',
    stats: { thirst: 40 },
    description: '纯净的饮用水。'
  }
});

const buildFallbackSnapshots = (humanCount: number, aiCount: number): AgentSnapshot[] => {
  const humans = Array.from({ length: humanCount }, (_, i) => ({
    agentId: `agent-user-${i + 1}`,
    kind: 'user' as const,
    displayName: `USER_${i + 1}`,
    accountIdentifier: `agent:agent-user-${i + 1}`
  }));
  const bots = Array.from({ length: aiCount }, (_, i) => ({
    agentId: `agent-bot-${i + 1}`,
    kind: 'bot' as const,
    displayName: `BOT_${i + 1}`,
    accountIdentifier: `agent:agent-bot-${i + 1}`
  }));
  return [...humans, ...bots];
};

const normalizeAgentSnapshots = (
  humanCount: number,
  aiCount: number,
  input?: AgentSnapshot[]
): AgentSnapshot[] => {
  const candidates = input?.length ? input : buildFallbackSnapshots(humanCount, aiCount);
  const deduped = new Set<string>();
  const normalized: AgentSnapshot[] = [];

  for (const raw of candidates) {
    const agentId = raw.agentId.trim();
    if (!agentId || deduped.has(agentId)) continue;
    deduped.add(agentId);
    normalized.push({
      agentId,
      kind: raw.kind,
      displayName: raw.displayName.trim() || agentId,
      accountIdentifier: raw.accountIdentifier,
      walletAddress: raw.walletAddress ?? null,
      prompt: raw.prompt ?? null,
      personality: raw.personality, // 保留个性配置
      persistentAssets: raw.persistentAssets
    });
  }

  return normalized;
};

export const generateInitialState = (
  humanCount: number,
  aiCount: number,
  agentSnapshots?: AgentSnapshot[]
): GameState => {
  const grid: GridCell[][] = Array.from({ length: GRID_SIZE }, (_, y) =>
    Array.from({ length: GRID_SIZE }, (_, x) => ({
      x,
      y,
      isRestricted: false,
      isWarning: false,
      items: [],
      players: []
    }))
  );

  const players: Player[] = [];
  const snapshots = normalizeAgentSnapshots(humanCount, aiCount, agentSnapshots);
  const totalPlayers = snapshots.length;
  const usedPositions = new Set<string>();

  for (let i = 0; i < totalPlayers; i++) {
    let x, y;
    do {
      x = Math.floor(Math.random() * GRID_SIZE);
      y = Math.floor(Math.random() * GRID_SIZE);
    } while (usedPositions.has(`${x},${y}`));

    usedPositions.add(`${x},${y}`);

    const snapshot = snapshots[i];
    const isAi = snapshot.kind === 'bot';
    const loadout = getInitialLoadout();
    const playerId = snapshot.agentId;

    // 分配并解析 AI 个性 (BOT 必须有个性，USER 可选)
    let personality: AiPersonality | undefined;
    if (snapshot.personality) {
      // 解析个性（RANDOM 转换为具体个性）
      personality = resolveAiPersonality(snapshot.personality);
    } else if (isAi) {
      // BOT 没有指定个性时，随机分配
      personality = resolveAiPersonality('RANDOM');
    }

    // 生成 Prompt：优先使用用户自定义的，否则根据个性生成默认模板
    const agentPrompt = snapshot.prompt?.trim()
      ? snapshot.prompt.trim()
      : (personality ? generateDefaultPromptForPersonality(personality) : null);

    // 初始股价：随机 10.00 到 50.00
    const startPrice = parseFloat((Math.random() * 40 + 10).toFixed(2));

    const player: Player = {
      id: playerId,
      name: snapshot.displayName,
      isAi,
      personality, // 添加个性
      agent: {
        agentId: snapshot.agentId,
        kind: snapshot.kind,
        lifecycleStatus: 'ACTIVE',
        accountIdentifier: snapshot.accountIdentifier,
        walletAddress: snapshot.walletAddress ?? null,
        prompt: agentPrompt, // 使用生成的或自定义的 prompt
        persistentAssets: snapshot.persistentAssets
      },
      stats: {
        hp: 100, maxHp: 100,
        hunger: 100, thirst: 100,
        maxHunger: 100, maxThirst: 100
      },
      equipment: {
        HEAD: null, BODY: null, HANDS: null, FEET: null, WEAPON: loadout.weapon, BAG: null
      },
      inventory: [loadout.bread, loadout.water],
      position: { x, y },
      status: 'ALIVE',
      // 初始化市场数据
      market: {
        price: startPrice,
        lastPrice: startPrice,
        history: [startPrice, startPrice, startPrice, startPrice], // 预填充一些数据以便绘图
        sharesOwned: 0,
        trend: 'FLAT'
      }
    };

    players.push(player);
    grid[y][x].players.push(playerId);
  }

  return {
    players,
    grid,
    turnCount: 1,
    activePlayerIndex: 0,
    log: ['>>> TERMINAL BOOTED.', '>>> OPERATION: NEON_VOID INITIATED.', '>>> MARKET SYSTEM ONLINE.'],
    phase: 'SETUP',
    language: 'zh',
    settings: {
      searchSuccessRate: 0.5 
    },
    // 初始资金 1000 信用点
    userBalance: 1000
  };
};
