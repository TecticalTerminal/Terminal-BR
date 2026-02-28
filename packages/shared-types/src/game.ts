export type Language = 'zh' | 'en';
export type ItemType = 'WEAPON' | 'ARMOR' | 'CONSUMABLE' | 'TRAP' | 'EMPTY';
export type Slot = 'HEAD' | 'BODY' | 'HANDS' | 'FEET' | 'WEAPON' | 'BAG';

// AI 个性类型
export type AiPersonality =
  | 'AGGRESSIVE'   // 激进战士: 主动追击，高攻击性
  | 'CAUTIOUS'     // 谨慎生存: 保守行事，高生存
  | 'EXPLORER'     // 探索者: 优先搜索，中等风险
  | 'OPPORTUNIST'  // 投机者: 灵活决策，看情况
  | 'RANDOM';      // 随机个性

// AI 个性配置参数
export interface PersonalityConfig {
  aggression: number;      // 攻击性 0-100
  survival: number;        // 生存倾向 0-100
  exploration: number;     // 探索倾向 0-100
  riskTolerance: number;   // 风险容忍 0-100 (影响战力优势要求)
  attackThreshold: number; // 攻击血量阈值 (HP低于此值不攻击)
  chaseRange: number;      // 追击范围 (格子数)
  searchProbability: number; // 搜索概率 0-100
}

// AI 记忆系统
export interface AiMemory {
  lastSeenEnemies: Map<string, { x: number; y: number; turn: number }>;
  dangerousAreas: Set<string>;
  grudges: Map<string, number>;
  lastAction: string;
  consecutiveSkips: number;
}

// AI 个性配置映射
export const PERSONALITY_CONFIGS: Record<AiPersonality, PersonalityConfig> = {
  AGGRESSIVE: {
    aggression: 90,
    survival: 20,
    exploration: 30,
    riskTolerance: 80,    // 80% 战力即可战斗
    attackThreshold: 20,  // HP>20 就攻击
    chaseRange: 3,        // 追击3格
    searchProbability: 35
  },
  CAUTIOUS: {
    aggression: 20,
    survival: 90,
    exploration: 40,
    riskTolerance: 150,   // 需要150%战力优势
    attackThreshold: 60,  // HP>60 才攻击
    chaseRange: 1,        // 只追1格
    searchProbability: 45
  },
  EXPLORER: {
    aggression: 40,
    survival: 50,
    exploration: 90,
    riskTolerance: 120,   // 需要120%战力优势
    attackThreshold: 40,  // HP>40 才攻击
    chaseRange: 2,        // 追击2格
    searchProbability: 70  // 高搜索概率
  },
  OPPORTUNIST: {
    aggression: 70,
    survival: 40,
    exploration: 50,
    riskTolerance: 100,   // 需要100%战力优势
    attackThreshold: 35,  // HP>35 才攻击
    chaseRange: 2,        // 追击2格
    searchProbability: 50
  },
  RANDOM: {
    aggression: 50,
    survival: 50,
    exploration: 50,
    riskTolerance: 100,
    attackThreshold: 40,
    chaseRange: 2,
    searchProbability: 50
  }
};

export interface Item {
  id: string;
  name: string;
  type: ItemType;
  rarity: 'COMMON' | 'RARE' | 'EPIC';
  slot?: Slot; 
  stats: {
    atk?: number;
    def?: number;
    heal?: number;
    hunger?: number;
    thirst?: number;
  };
  description: string;
}

export interface LootPoolItem {
  id: string;
  name: string;
  type: ItemType;
  slot?: Slot;
  weight: number;
  minStat: number;
  maxStat: number;
  description: string;
}

export interface LootCategory {
  type: ItemType;
  weight: number;
  items: LootPoolItem[];
}

export interface PlayerStats {
  hp: number;
  maxHp: number;
  hunger: number;
  thirst: number;
  maxHunger: number;
  maxThirst: number;
}

// 新增市场数据接口
export interface MarketData {
  price: number;
  lastPrice: number;
  history: number[]; // 存储最近 20 次价格历史用于绘图
  sharesOwned: number; // 用户持有的份额
  trend: 'UP' | 'DOWN' | 'FLAT';
}

export interface Player {
  id: string;
  name: string;
  isAi: boolean;
  // AI 个性 (规则模式下使用)
  personality?: AiPersonality;
  agent?: {
    agentId: string;
    kind: 'user' | 'bot';
    lifecycleStatus?: 'ACTIVE' | 'DEAD' | 'RESPAWNING';
    accountIdentifier?: string;
    walletAddress?: string | null;
    prompt?: string | null;
    persistentAssets?: Record<string, unknown>;
  };
  stats: PlayerStats;
  equipment: Record<Slot, Item | null>;
  inventory: Item[];
  position: { x: number; y: number };
  status: 'ALIVE' | 'DEAD' | 'RESPAWNING';
  // 每个玩家关联的市场数据
  market: MarketData;
}

export interface GridCell {
  x: number;
  y: number;
  isRestricted: boolean;
  isWarning: boolean;
  items: Item[];
  players: string[];
}

export interface GameSettings {
  searchSuccessRate: number; // 0.0 到 1.0 之间
  // AI 个性配置 (可选)
  aiPersonalities?: Record<string, AiPersonality>;
}

export interface AiConfig {
  systemPrompt: string;
  apiKey: string;
  humanControlMode?: 'manual' | 'managed';
  managedUserPromptOverride?: string | null;
}

export interface AgentSnapshot {
  agentId: string;
  kind: 'user' | 'bot';
  displayName: string;
  accountIdentifier?: string;
  walletAddress?: string | null;
  prompt?: string | null;
  personality?: AiPersonality; // AI 个性
  persistentAssets?: Record<string, unknown>;
}

export interface GameState {
  players: Player[];
  grid: GridCell[][];
  turnCount: number;
  activePlayerIndex: number;
  log: string[];
  phase: 'WAITING' | 'SETUP' | 'ACTIVE' | 'LOOTING' | 'GAME_OVER';
  pendingLoot?: Item | null;
  winner?: Player | null;
  language: Language;
  settings: GameSettings;
  aiConfig?: AiConfig;
  // 新增：用户在预测市场的现金余额
  userBalance: number;
}

export type GameAction =
  | {
      type: 'START_GAME';
      payload: { humanCount: number; aiCount: number; agentSnapshots?: AgentSnapshot[] };
    }
  | { type: 'LOAD_GAME'; payload: GameState }
  | { type: 'SET_LANGUAGE'; payload: Language }
  | { type: 'EXIT_TO_MENU' }
  | { type: 'INIT_AGENT'; payload: AiConfig }
  | { type: 'MOVE'; payload: { playerId: string; direction: 'UP' | 'DOWN' | 'LEFT' | 'RIGHT' } }
  | { type: 'SEARCH'; payload: { playerId: string } }
  | { type: 'TAKE_LOOT'; payload: { playerId: string } }
  | { type: 'DISCARD_LOOT' }
  | { type: 'ATTACK'; payload: { attackerId: string; targetId: string } }
  | { type: 'USE_ITEM'; payload: { playerId: string; itemId: string } }
  | { type: 'EQUIP_ITEM'; payload: { playerId: string; itemId: string } }
  | { type: 'DROP_ITEM'; payload: { playerId: string; itemId: string } }
  | { type: 'PICKUP_ITEM'; payload: { playerId: string; itemId: string } }
  | { type: 'SKIP_TURN'; payload: { playerId: string } }
  | { type: 'KILL_ALL_AI' }
  | { type: 'UPDATE_SETTINGS'; payload: Partial<GameSettings> }
  | { type: 'NEXT_TURN' }
  // 新增：购买股票
  | { type: 'MARKET_BUY'; payload: { playerId: string; amount: number } };
