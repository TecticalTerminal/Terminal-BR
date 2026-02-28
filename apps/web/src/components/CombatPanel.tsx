
import React from 'react';
import { Player, Item, Slot } from '@tactical/shared-types';
import { calculateTotalAtk, calculateTotalDef } from '@tactical/game-engine';

interface CombatPanelProps {
  player: Player;
  hoveredItem?: Item | null;
  language: 'zh' | 'en';
}

export const CombatPanel: React.FC<CombatPanelProps> = ({ player, hoveredItem, language }) => {
  const currentAtk = calculateTotalAtk(player);
  const currentDef = calculateTotalDef(player);

  let predictedAtk = currentAtk;
  let predictedDef = currentDef;

  const t = {
    zh: { TITLE: "装备矩阵_LOADOUT" },
    en: { TITLE: "EQUIPMENT_MATRIX" }
  }[language];

  if (hoveredItem && (hoveredItem.type === 'WEAPON' || hoveredItem.type === 'ARMOR')) {
    const slot = hoveredItem.slot || (hoveredItem.type === 'WEAPON' ? 'WEAPON' : 'BODY');
    const oldItem = player.equipment[slot];
    
    if (hoveredItem.type === 'WEAPON') {
      predictedAtk = (currentAtk - (oldItem?.stats.atk || 0)) + (hoveredItem.stats.atk || 0);
    } else {
      predictedDef = (currentDef - (oldItem?.stats.def || 0)) + (hoveredItem.stats.def || 0);
    }
  }

  const StatDisplay = ({ label, current, predicted, color }: { label: string, current: number, predicted: number, color: string }) => {
    const diff = predicted - current;
    return (
      <div className="flex flex-col items-center">
        <span className="text-[10px] opacity-40 uppercase font-black tracking-widest">{label}</span>
        <div className="flex items-baseline gap-2">
          <span className={`text-2xl font-black ${color}`}>{current}</span>
          {diff !== 0 && (
            <span className={`text-xs font-black animate-pulse ${diff > 0 ? 'text-green-500' : 'text-[#F7931A]'}`}>
              {diff > 0 ? `+${diff}` : diff}
            </span>
          )}
        </div>
      </div>
    );
  };

  return (
    <div className="h-full border-4 border-white p-6 bg-black flex flex-col shadow-[10px_10px_0px_rgba(255,255,255,0.05)] overflow-hidden">
      {/* 统一页眉内容 */}
      <h3 className="text-sm font-black border-b-2 border-white/20 mb-4 pb-2 uppercase tracking-widest">
        {t.TITLE}
      </h3>

      <div className="flex justify-around items-center border-b border-white/10 pb-4 mb-2">
        <StatDisplay label="ATK" current={currentAtk} predicted={predictedAtk} color="text-[#F7931A]" />
        <StatDisplay label="DEF" current={currentDef} predicted={predictedDef} color="text-blue-500" />
      </div>

      {/* 自动缩放的 3x3 网格 */}
      <div className="flex-1 grid grid-cols-3 gap-2 min-h-0 items-center justify-items-center">
        <div className="w-full aspect-square opacity-0"></div>
        <EquipSlot slot="HEAD" item={player.equipment.HEAD} />
        <div className="w-full aspect-square opacity-0"></div>
        
        <EquipSlot slot="WEAPON" item={player.equipment.WEAPON} />
        <EquipSlot slot="BODY" item={player.equipment.BODY} />
        <EquipSlot slot="HANDS" item={player.equipment.HANDS} />

        <div className="w-full aspect-square opacity-0"></div>
        <EquipSlot slot="FEET" item={player.equipment.FEET} />
        <div className="w-full aspect-square opacity-0"></div>
      </div>
    </div>
  );
};

const EquipSlot = ({ slot, item }: { slot: Slot, item: Item | null }) => {
  return (
    <div className={`w-full max-w-[80px] aspect-square border-2 ${item ? 'border-white bg-white/10' : 'border-dashed border-white/20'} flex flex-col items-center justify-center p-1 relative transition-all duration-200 overflow-hidden`}>
      <span className="text-[8px] opacity-40 absolute top-0.5 uppercase font-black tracking-tighter pointer-events-none">
        {slot}
      </span>
      <div className="flex items-center justify-center w-full h-full pt-1">
        {item ? (
          <span className="text-[8px] md:text-[9px] font-black text-center leading-tight break-words px-0.5 text-white uppercase line-clamp-2">
            {item.name}
          </span>
        ) : (
          <span className="text-[12px] opacity-10 font-black">?</span>
        )}
      </div>
      
      {item && (
        <div className="absolute top-0 right-0 w-1.5 h-1.5 bg-green-500" />
      )}
    </div>
  );
};
