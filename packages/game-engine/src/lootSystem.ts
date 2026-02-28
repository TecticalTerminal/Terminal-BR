
import { Item, LootCategory, LootPoolItem, ItemType } from '@tactical/shared-types';

// 默认掉落配置
const DEFAULT_LOOT_TABLE: LootCategory[] = [
  {
    type: 'WEAPON',
    weight: 20,
    items: [
      { id: 'w1', name: 'RUSTED BLADE', type: 'WEAPON', weight: 50, minStat: 2, maxStat: 8, description: '一把锈迹斑斑的长剑。' },
      { id: 'w2', name: 'TACTICAL KNIFE', type: 'WEAPON', weight: 30, minStat: 8, maxStat: 15, description: '特种部队使用的多功能匕首。' },
      { id: 'w3', name: 'PLASMA CUTTER', type: 'WEAPON', weight: 10, minStat: 20, maxStat: 35, description: '能切开重型护甲的高能激光。' },
    ]
  },
  {
    type: 'ARMOR',
    weight: 20,
    items: [
      { id: 'a1', name: 'SCRAP VEST', type: 'ARMOR', weight: 60, minStat: 1, maxStat: 2, description: '粗劣拼凑的废铁胸甲。' },
      { id: 'a2', name: 'KEVLAR PAD', type: 'ARMOR', weight: 30, minStat: 2, maxStat: 4, description: '坚韧的凯夫拉衬垫。' },
    ]
  },
  {
    type: 'CONSUMABLE',
    weight: 50,
    items: [
      { id: 'c1', name: 'NUTRIENT PASTE', type: 'CONSUMABLE', weight: 50, minStat: 20, maxStat: 30, description: '味道糟糕但富有营养。' },
      { id: 'c2', name: 'PURIFIED WATER', type: 'CONSUMABLE', weight: 40, minStat: 25, maxStat: 40, description: '珍贵的清洁水源。' },
      { id: 'c3', name: 'MEDKIT', type: 'CONSUMABLE', weight: 10, minStat: 40, maxStat: 60, description: '紧急医疗包。' },
    ]
  }
];

const STORAGE_KEY = 'admin_loot_config';

/**
 * 获取当前的掉落配置
 */
export const getLootConfig = (): LootCategory[] => {
  const storage = (globalThis as { localStorage?: { getItem: (key: string) => string | null } })
    .localStorage;
  if (!storage) {
    return DEFAULT_LOOT_TABLE;
  }
  const saved = storage.getItem(STORAGE_KEY);
  return saved ? JSON.parse(saved) : DEFAULT_LOOT_TABLE;
};

/**
 * 核心掉落生成函数
 */
export const generateLoot = (): Item | null => {
  const config = getLootConfig();
  
  // 1. 抽取类别
  const totalCatWeight = config.reduce((acc, cat) => acc + cat.weight, 0);
  let roll = Math.random() * totalCatWeight;
  let selectedCat: LootCategory | null = null;
  
  for (const cat of config) {
    if (roll < cat.weight) {
      selectedCat = cat;
      break;
    }
    roll -= cat.weight;
  }

  if (!selectedCat || selectedCat.items.length === 0) return null;

  // 2. 抽取具体物品
  const totalItemWeight = selectedCat.items.reduce((acc, it) => acc + it.weight, 0);
  let itemRoll = Math.random() * totalItemWeight;
  let template: LootPoolItem | null = null;

  for (const item of selectedCat.items) {
    if (itemRoll < item.weight) {
      template = item;
      break;
    }
    itemRoll -= item.weight;
  }

  if (!template) return null;

  // 3. 随机化属性
  const statValue = Math.floor(Math.random() * (template.maxStat - template.minStat + 1)) + template.minStat;
  
  const item: Item = {
    id: `loot-${Date.now()}-${Math.random()}`,
    name: template.name,
    type: template.type,
    rarity: statValue > template.maxStat * 0.8 ? 'EPIC' : (statValue > template.maxStat * 0.5 ? 'RARE' : 'COMMON'),
    description: template.description,
    stats: {}
  };

  if (template.type === 'WEAPON') item.stats.atk = statValue;
  if (template.type === 'ARMOR') item.stats.def = statValue;
  if (template.name.includes('WATER')) item.stats.thirst = statValue;
  if (template.name.includes('PASTE')) item.stats.hunger = statValue;
  if (template.name.includes('MEDKIT')) item.stats.heal = statValue;

  return item;
};
