
import React from 'react';
import { GameState, Player } from '@tactical/shared-types';

interface GridMapProps {
  state: GameState;
  humanPlayer?: Player;
  godMode?: boolean; 
}

/**
 * 战术地图组件
 * 渲染 8x8 网格，支持视野迷雾、区域预警及多单位同格显示
 */
export const GridMap: React.FC<GridMapProps> = ({ state, humanPlayer, godMode = false }) => {
  
  // 辅助函数：提取 AI 的编号 (例如 "BOT_5" -> "5")
  const getAiLabel = (name: string) => {
    const parts = name.split('_');
    return parts.length > 1 ? parts[1] : name[0];
  };

  return (
    <div className="aspect-square w-full max-w-[500px] border-4 border-white bg-[#050505] grid grid-cols-8 grid-rows-8 p-1 gap-1 relative overflow-hidden">
      {/* 上帝模式开启时的全局视觉反馈 */}
      {godMode && (
        <div className="absolute top-1 left-1 z-50 pointer-events-none">
          <span className="bg-[#00FF41] text-black px-2 py-0.5 text-[8px] font-black uppercase tracking-[0.2em] shadow-lg animate-pulse">
            SYSTEM_OVERRIDE_ACTIVE
          </span>
        </div>
      )}

      {state.grid.map((row, y) => 
        row.map((cell, x) => {
          const px = humanPlayer?.position.x ?? -10;
          const py = humanPlayer?.position.y ?? -10;
          
          const isRestricted = cell.isRestricted;
          const isWarning = cell.isWarning;

          // 视野逻辑
          const isVisible = (Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1) || isRestricted || isWarning || godMode;
          
          // 物资探测逻辑：玩家周围 3x3 范围 (isVisible 覆盖了这个范围) 且有物资
          // 绿色饱和度 20% (rgba 0,255,0, 0.2)
          const isNearPlayer = Math.abs(px - x) <= 1 && Math.abs(py - y) <= 1;
          const hasItems = cell.items.length > 0;
          const showLootHighlight = isNearPlayer && hasItems;

          // 获取该格子内所有玩家对象
          const cellPlayers = cell.players
            .map(id => state.players.find(p => p.id === id))
            .filter((p): p is Player => !!p);

          // 背景样式
          let bgColor = 'bg-transparent';
          let borderColor = 'border-white/10';

          if (isRestricted) {
            bgColor = 'bg-[#F7931A]/40';
            borderColor = 'border-[#F7931A]';
          } else if (isWarning) {
            bgColor = 'bg-yellow-900/30 animate-pulse';
            borderColor = 'border-yellow-500';
          } else if (showLootHighlight) {
            // 绿色 20% 饱和度背景
            bgColor = 'bg-[rgba(0,255,0,0.2)]';
            borderColor = 'border-green-500/50';
          }

          return (
            <div 
              key={`${x}-${y}`}
              className={`relative border ${borderColor} ${bgColor} flex items-center justify-center transition-all duration-300 group overflow-hidden ${!isVisible ? 'brightness-[0.1] grayscale opacity-30' : ''}`}
            >
              {isVisible ? (
                <>
                  {/* 居中坐标显示 [X,Y] */}
                  <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-0">
                    <span className="text-[10px] font-black opacity-20 select-none tracking-widest text-white">
                      [{x},{y}]
                    </span>
                  </div>

                  {/* 如果有物资，右上角依然保留一个小箭头提示，作为双重确认 */}
                  {hasItems && <span className="absolute top-0 right-0 text-[8px] text-green-400 animate-bounce leading-none z-20">▼</span>}
                  
                  {/* 玩家渲染容器：如果超过1人，使用 2x2 网格，否则居中显示 */}
                  <div className={`w-full h-full z-10 p-0.5 ${cellPlayers.length > 1 ? 'grid grid-cols-2 grid-rows-2 gap-0.5' : 'flex items-center justify-center'}`}>
                    {cellPlayers.slice(0, 4).map(p => {
                      const isDead = p.status === 'DEAD';
                      const isHuman = !p.isAi;
                      
                      // 样式计算
                      let iconBg = isHuman ? 'bg-[#F7931A]' : 'bg-white';
                      let iconText = isHuman ? 'text-white' : 'text-black';
                      let iconBorder = isHuman ? 'border-white' : 'border-[#F7931A]';
                      
                      // 死亡样式覆盖
                      if (isDead) {
                         iconBg = 'bg-gray-600';
                         iconText = 'text-gray-400';
                         iconBorder = 'border-gray-800';
                      }

                      return (
                        <div 
                          key={p.id}
                          className={`
                            ${cellPlayers.length > 1 ? 'w-full h-full text-[8px]' : 'w-6 h-6 text-[10px]'} 
                            ${iconBg} ${iconText} border ${iconBorder} 
                            flex items-center justify-center font-black shadow-sm
                            ${isDead ? 'opacity-50 grayscale brightness-50' : 'shadow-[0_0_5px_rgba(255,255,255,0.5)]'}
                            transition-all
                          `}
                          title={`${p.name} (${p.stats.hp} HP)`}
                        >
                          {isHuman ? '@' : getAiLabel(p.name)}
                        </div>
                      );
                    })}
                  </div>
                </>
              ) : (
                <span className="text-[12px] opacity-5 text-white/10 select-none">?</span>
              )}

              {isRestricted && (
                <div className="absolute inset-0 pointer-events-none opacity-20 bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,#F7931A_5px,#F7931A_10px)] z-0" />
              )}
            </div>
          );
        })
      )}
    </div>
  );
};
