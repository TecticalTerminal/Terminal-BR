
import React from 'react';
import { Player, Item, GameAction } from '@tactical/shared-types';

interface InventoryProps {
  player?: Player;
  isHumanTurn: boolean;
  dispatch: React.Dispatch<GameAction>;
  onHoverItem: (item: Item | null) => void;
  language: 'zh' | 'en';
}

export const Inventory: React.FC<InventoryProps> = ({ player, isHumanTurn, dispatch, onHoverItem, language }) => {
  const t = {
    zh: { TITLE: "背包状态_0x8", VOID: "空无一物", EQUIP: "装备", USE: "使用", DROP: "丢弃" },
    en: { TITLE: "INVENTORY_0x8", VOID: "VOID_INVENTORY", EQUIP: "EQUIP", USE: "USE", DROP: "DROP" }
  }[language];

  if (!player) return null;

  return (
    <div className="flex-1 border-4 border-white p-6 bg-black overflow-hidden flex flex-col shadow-[10px_10px_0px_rgba(255,255,255,0.05)]">
      <h3 className="text-sm font-black border-b-2 border-white/20 mb-4 pb-2 uppercase tracking-widest">{t.TITLE}</h3>
      <div className="flex-1 overflow-y-auto space-y-2 pr-2 custom-scrollbar min-h-0">
        {player.inventory.map((item) => (
          <div 
            key={item.id}
            onMouseEnter={() => onHoverItem(item)}
            onMouseLeave={() => onHoverItem(null)}
            className="w-full text-left p-3 border-2 border-white/10 hover:border-[#F7931A] hover:bg-white/5 transition-all flex justify-between group items-center bg-black/40"
          >
            <div className="flex flex-col min-w-0 flex-1">
              <span className={`text-lg font-black tracking-tighter truncate ${item.rarity === 'EPIC' ? 'text-purple-400' : (item.rarity === 'RARE' ? 'text-blue-400' : 'text-white')}`}>
                {item.name}
              </span>
              <span className="text-[10px] opacity-40 uppercase font-black">{item.type}</span>
            </div>
            
            <div className="flex gap-2 items-center">
              <button 
                disabled={!isHumanTurn}
                onClick={() => dispatch({ type: 'USE_ITEM', payload: { playerId: player.id, itemId: item.id } })}
                className="opacity-0 group-hover:opacity-100 uppercase text-xs bg-white text-black px-4 py-2 font-black transition-all hover:bg-[#F7931A] hover:text-white disabled:opacity-0"
              >
                [{item.type === 'WEAPON' || item.type === 'ARMOR' ? t.EQUIP : t.USE}]
              </button>
              <button 
                disabled={!isHumanTurn}
                onClick={() => dispatch({ type: 'DROP_ITEM', payload: { playerId: player.id, itemId: item.id } })}
                className="opacity-0 group-hover:opacity-100 uppercase text-xs text-[#F7931A] border border-[#F7931A] px-3 py-2 font-black transition-all hover:bg-[#F7931A] hover:text-white disabled:opacity-0"
              >
                {t.DROP}
              </button>
            </div>
          </div>
        ))}
        {player.inventory.length === 0 && (
          <div className="text-xl opacity-20 italic p-10 text-center border-2 border-dashed border-white/10 font-black uppercase tracking-[0.5em]">
            {t.VOID}
          </div>
        )}
      </div>
    </div>
  );
};
