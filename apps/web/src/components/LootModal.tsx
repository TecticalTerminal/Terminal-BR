
import React, { useEffect, useState, useRef } from 'react';
import { useGame } from '../context/GameContext';
import { Item } from '@tactical/shared-types';

interface LootModalProps {
  onHoverItem: (item: Item | null) => void;
}

const DISCARD_COUNTDOWN = 10; // 倒计时秒数

export const LootModal: React.FC<LootModalProps> = ({ onHoverItem }) => {
  const { state, dispatch, isSpectator, mode, isOnlineReady, onlineInteractionBlockedReason } = useGame();
  const [countdown, setCountdown] = useState(DISCARD_COUNTDOWN);
  const countdownTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const autoDiscardTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMountedRef = useRef(true);

  const item = state.pendingLoot;
  const humanPlayer = state.players.find(p => !p.isAi);
  const interactionDisabled = mode === 'online' && !isOnlineReady;

  // 清除所有计时器
  const clearTimers = () => {
    if (countdownTimerRef.current) {
      clearInterval(countdownTimerRef.current);
      countdownTimerRef.current = null;
    }
    if (autoDiscardTimerRef.current) {
      clearTimeout(autoDiscardTimerRef.current);
      autoDiscardTimerRef.current = null;
    }
  };

  // 倒计时和自动丢弃逻辑 - 必须在早期返回之前
  useEffect(() => {
    // 如果没有物品，不启动计时器
    if (!item) return;

    isMountedRef.current = true;
    setCountdown(DISCARD_COUNTDOWN);

    console.log('[LootModal] 计时器开始，物品:', item.name, '倒计时:', DISCARD_COUNTDOWN, '秒');

    // 倒计时显示（每秒递减）
    countdownTimerRef.current = setInterval(() => {
      setCountdown((prev) => {
        if (prev > 1) return prev - 1;
        return 0;
      });
    }, 1000);

    // 10秒后自动丢弃
    autoDiscardTimerRef.current = setTimeout(() => {
      console.log('[LootModal] 自动丢弃触发，物品:', item.name);
      // 确保组件仍然挂载
      if (!isMountedRef.current) {
        console.log('[LootModal] 组件已卸载，取消自动丢弃');
        return;
      }
      clearTimers();
      dispatch({ type: 'DISCARD_LOOT' });
      onHoverItem(null);
    }, DISCARD_COUNTDOWN * 1000);

    return () => {
      console.log('[LootModal] 清理计时器');
      isMountedRef.current = false;
      clearTimers();
    };
  }, [item?.id, dispatch, onHoverItem]); // 当物品改变时重新开始倒计时

  // 早期返回必须在所有 Hooks 之后
  if (isSpectator) return null;
  if (state.phase !== 'LOOTING' || !item) return null;

  const rarityColor = {
    COMMON: 'text-white',
    RARE: 'text-blue-400',
    EPIC: 'text-purple-500 font-black'
  };

  const t = {
    zh: { TITLE: '检测到物资', TAKE: '放入背包', DISCARD: '丢弃', FULL: '背包容量已满！', AUTO: '自动' },
    en: { TITLE: 'LOOT DETECTED', TAKE: 'TAKE ITEM', DISCARD: 'DISCARD', FULL: 'INVENTORY FULL!', AUTO: 'AUTO' }
  }[state.language];

  // 处理拾取操作
  const handleTake = () => {
    console.log('[LootModal] 用户选择拾取');
    clearTimers();
    dispatch({ type: 'TAKE_LOOT', payload: { playerId: humanPlayer!.id } });
    onHoverItem(null);
  };

  // 处理丢弃操作
  const handleDiscard = () => {
    console.log('[LootModal] 用户选择丢弃');
    clearTimers();
    dispatch({ type: 'DISCARD_LOOT' });
    onHoverItem(null);
  };

  return (
    <div className="fixed inset-0 bg-black/40 z-[400] flex items-center justify-center backdrop-blur-sm animate-in fade-in duration-300">
      <div
        onMouseEnter={() => onHoverItem(item)}
        onMouseLeave={() => onHoverItem(null)}
        className="border-8 border-white bg-black p-12 max-w-lg w-full relative shadow-[30px_30px_0px_#F7931A]"
      >
        {/* 背景装饰线 */}
        <div className="absolute inset-0 opacity-5 pointer-events-none bg-[repeating-linear-gradient(0deg,transparent,transparent_4px,white_4px,white_8px)]" />

        <h2 className="text-3xl font-black italic border-b-4 border-white mb-10 pb-4 text-[#F7931A] uppercase tracking-tighter">
          {t.TITLE}
        </h2>

        <div className="mb-12 space-y-8 relative z-10">
          <div className="flex justify-between items-start">
            <div>
              <div className={`text-5xl font-black leading-none uppercase italic tracking-tighter ${rarityColor[item.rarity]}`}>{item.name}</div>
              <div className="text-xs opacity-40 uppercase tracking-[0.3em] font-black mt-2">{item.type} // RANK_{item.rarity}</div>
            </div>
          </div>

          <div className="bg-white/5 p-6 border-2 border-white/10 italic text-lg leading-relaxed border-l-8 border-l-[#F7931A]">
            "{item.description}"
          </div>

          <div className="space-y-3">
            {Object.entries(item.stats).map(([key, val]) => (
              <div key={key} className="flex justify-between text-base border-b-2 border-white/10 pb-2 items-baseline">
                <span className="uppercase font-black opacity-60 tracking-widest">{key}</span>
                <span className="text-green-500 font-black text-2xl">+{val}</span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex flex-col gap-4">
          <button
            disabled={interactionDisabled}
            onClick={handleTake}
            className="bg-white text-black py-8 text-3xl font-black hover:bg-[#F7931A] hover:text-white transition-all transform active:scale-95 uppercase tracking-widest disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {t.TAKE}
          </button>
          <button
            disabled={interactionDisabled}
            onClick={handleDiscard}
            className={`border-4 border-white text-white py-4 text-sm font-black hover:bg-white hover:text-black transition-all uppercase tracking-[0.5em] disabled:opacity-40 disabled:cursor-not-allowed ${
              countdown <= 3 ? 'animate-pulse border-red-500' : ''
            }`}
          >
            {t.DISCARD} ({countdown > 0 ? `${t.AUTO} ${countdown}s` : `${t.AUTO}`})
          </button>
        </div>

        {interactionDisabled && (
          <div className="mt-4 text-center text-xs font-black uppercase tracking-[0.12em] text-[#F7931A]">
            {onlineInteractionBlockedReason ?? 'Waiting for online sync...'}
          </div>
        )}

        {humanPlayer && humanPlayer.inventory.length >= 8 && (
          <div className="mt-6 text-center text-[#F7931A] text-sm font-black animate-pulse uppercase tracking-widest">
            !! {t.FULL} !!
          </div>
        )}
      </div>
    </div>
  );
};
