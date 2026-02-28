
import { Player, Item, ItemType } from '@tactical/shared-types';

/**
 * 计算玩家的总攻击力
 * 基础值 5 + 武器加成
 */
export const calculateTotalAtk = (player: Player): number => {
  const baseAtk = 5;
  const weaponAtk = player.equipment.WEAPON?.stats.atk || 0;
  return baseAtk + weaponAtk;
};

/**
 * 计算玩家的总防御力
 */
export const calculateTotalDef = (player: Player): number => {
  let def = 0;
  Object.values(player.equipment).forEach(item => {
    if (item && item.stats.def) def += item.stats.def;
  });
  return def;
};

/**
 * 该函数已在 lootSystem.ts 中被重写为更复杂的版本
 * 保持此文件仅用于基础战斗逻辑
 */
export const getLootDrop = () => null;
