
import React from 'react';
import { GameAction, Player } from '@tactical/shared-types';

interface ControlPanelProps {
  player?: Player;
  dispatch: React.Dispatch<GameAction>;
  disabled?: boolean;
  killAllDisabled?: boolean;
  onActionComplete: () => void;
}

export const ControlPanel: React.FC<ControlPanelProps> = ({
  player,
  dispatch,
  disabled,
  killAllDisabled,
  onActionComplete
}) => {
  if (!player || player.status === 'DEAD') return null;

  const handleAction = (action: GameAction) => {
    dispatch(action);
    onActionComplete();
  };

  const btnClass = "border-2 border-white hover:bg-white hover:text-black transition-all p-3 font-black uppercase text-xs flex items-center justify-center disabled:opacity-20 disabled:cursor-not-allowed transform active:translate-y-0.5 active:shadow-none shadow-[2px_2px_0px_rgba(255,255,255,0.2)]";

  return (
    <div className="w-full flex flex-col gap-3 bg-transparent">
      {/* 移动控制 */}
      <div className="grid grid-cols-3 gap-2">
        <div />
        <button 
          disabled={disabled}
          onClick={() => handleAction({ type: 'MOVE', payload: { playerId: player.id, direction: 'UP' } })}
          className={btnClass}
        >
          [W] UP
        </button>
        <div />
        
        <button 
          disabled={disabled}
          onClick={() => handleAction({ type: 'MOVE', payload: { playerId: player.id, direction: 'LEFT' } })}
          className={btnClass}
        >
          [A] LFT
        </button>
        <button 
          disabled={disabled}
          onClick={() => handleAction({ type: 'MOVE', payload: { playerId: player.id, direction: 'DOWN' } })}
          className={btnClass}
        >
          [S] DWN
        </button>
        <button 
          disabled={disabled}
          onClick={() => handleAction({ type: 'MOVE', payload: { playerId: player.id, direction: 'RIGHT' } })}
          className={btnClass}
        >
          [D] RGT
        </button>
      </div>

      {/* 基础动作 */}
      <div className="grid grid-cols-3 gap-2">
        <button 
          disabled={disabled}
          onClick={() => handleAction({ type: 'SEARCH', payload: { playerId: player.id } })}
          className={`${btnClass} col-span-1 border-[#F7931A] text-[#F7931A] hover:bg-[#F7931A] hover:text-white shadow-[2px_2px_0px_rgba(247,147,26,0.2)]`}
        >
          [F] SCAN
        </button>

        <button 
          // 此按钮继承了 "FORCE_NEXT" 的逻辑 (SKIP_TURN)
          disabled={disabled}
          onClick={() => handleAction({ type: 'SKIP_TURN', payload: { playerId: player.id } })}
          className={`${btnClass} col-span-2 bg-white text-black hover:bg-gray-400 hover:text-white shadow-[2px_2px_0px_rgba(255,255,255,0.2)]`}
        >
          [SPACE] END_TURN
        </button>
      </div>

      {/* 调试/高级指令 */}
      <div className="w-full flex gap-2 pt-2 border-t border-white/10 mt-2">
        {/* Force Next 按钮已移除，功能合并至 END_TURN */}

        <button 
          disabled={killAllDisabled ?? disabled}
          onClick={() => handleAction({ type: 'KILL_ALL_AI' })}
          className="relative z-10 flex-1 border-2 border-[#F7931A] text-[#F7931A] p-2 font-black uppercase text-[10px] hover:bg-[#F7931A] hover:text-white transition-all shadow-[2px_2px_0px_rgba(247,147,26,0.2)] cursor-pointer pointer-events-auto"
        >
          [☠] KILL_ALL_AI
        </button>
      </div>
    </div>
  );
};
