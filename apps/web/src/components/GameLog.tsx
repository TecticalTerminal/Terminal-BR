
import React, { useEffect, useRef } from 'react';
import { useGame } from '../context/GameContext';

interface GameLogProps {
  logs: string[];
}

export const GameLog: React.FC<GameLogProps> = ({ logs }) => {
  const { state } = useGame();
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [logs]);

  return (
    <div className="border-4 border-white bg-[#080808] h-full flex flex-col p-6 font-mono shadow-inner">
      <div className="text-xs uppercase opacity-40 border-b-2 border-white/20 mb-4 pb-2 flex justify-between font-black tracking-[0.2em]">
        <span>Terminal_Data_Stream</span>
        <span>{state.language === 'zh' ? '显存状态' : 'VRAM_BUFFER'}: {logs.length}/50</span>
      </div>
      <div 
        ref={scrollRef}
        className="flex-1 overflow-y-auto space-y-2 scrollbar-hide text-base"
      >
        {logs.map((log, i) => {
          let textColor = 'text-white';
          if (log.includes('WARNING') || log.includes('警告')) textColor = 'text-[#F7931A] font-bold';
          if (log.includes('SYSTEM') || log.includes('系统')) textColor = 'text-[#F7931A] font-black';
          if (log.includes('COMBAT') || log.includes('战斗')) textColor = 'text-yellow-400';
          if (log.includes('VICTORY') || log.includes('胜利')) textColor = 'text-green-500 font-black';

          return (
            <div key={i} className={`${textColor} leading-relaxed flex gap-4 border-l-2 border-transparent hover:border-white/10 pl-2 transition-colors`}>
              <span className="opacity-20 select-none">[{i.toString().padStart(3, '0')}]</span>
              <span className="tracking-tight">{log}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
};
