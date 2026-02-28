
import React, { useState, useEffect, useRef } from 'react';
import { useGame } from '../context/GameContext';
import { GridMap } from './GridMap';
import { StatBar } from './StatBar';
import { GameLog } from './GameLog';
import { ControlPanel } from './ControlPanel';
import { LootModal } from './LootModal';
import { AdminPanel } from './AdminPanel';
import { CombatPanel } from './CombatPanel';
import { Inventory } from './Inventory';
import { AgentSnapshot, Item } from '@tactical/shared-types';
import { decideAiAction, decideAiActionWithPersonality } from '@tactical/game-engine';
import { AgentSetupModal } from './AgentSetupModal';
import { PredictionMarket } from './PredictionMarket'; // 引入新组件
import { A2AMarket } from './A2AMarket';

const TRANSLATIONS = {
  zh: {
    TITLE: "战术终端",
    SUBTITLE: "8x8 网格 // 生存协议 082",
    START: "初始化系统",
    RESUME: "恢复会话进度",
    LANG: "切换语言: EN",
    CYCLE: "周期",
    ALIVE: "存活",
    DURATION: "时长",
    PROFILE: "单位诊断",
    SYSTEM_BUSY: "系统繁忙: 计算敌方单位行动...",
    MISSION_END: "任务终结",
    SURVIVOR: "幸存者",
    REBOOT: "重置模拟",
    EXIT: "终止会话",
    RETURN_TERMINAL: "返回终端",
    YOUR_TURN: "当前轮到你",
    EXIT_CONFIRM: "确认终止当前会话？",
    SAVE_EXIT: "保存并退出",
    RESTART: "重新开始",
    CANCEL: "返回",
    ADMIN: "进入矩阵管理 [ADMIN]",
    MARKET: "预测市场",
    A2A_MARKET: "A2A交易市场"
  },
  en: {
    TITLE: "TACTICAL_VOID",
    SUBTITLE: "GRID_8X8 // SURVIVAL_PROTOCOL_082",
    START: "INITIALIZE_SYSTEM",
    RESUME: "RESUME_SESSION",
    LANG: "SWITCH_LANG: ZH",
    CYCLE: "CYCLE",
    ALIVE: "ALIVE",
    DURATION: "TIME",
    PROFILE: "USER_DIAGNOSTICS",
    SYSTEM_BUSY: "SYSTEM_BUSY: PROCESSING_HOSTILE...",
    MISSION_END: "MISSION_END",
    SURVIVOR: "SURVIVOR",
    REBOOT: "REINITIALIZE",
    EXIT: "TERMINATE",
    RETURN_TERMINAL: "RETURN TERMINAL",
    YOUR_TURN: "YOUR TURN",
    EXIT_CONFIRM: "TERMINATE CURRENT SESSION?",
    SAVE_EXIT: "SAVE & EXIT",
    RESTART: "RESTART",
    CANCEL: "CANCEL",
    ADMIN: "ADMIN_MATRIX_ACCESS",
    MARKET: "PREDICTION MARKET",
    A2A_MARKET: "A2A MARKET"
  }
};

const STORAGE_KEY = 'tactical_terminal_save';
const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface RespawnRecordView {
  id: string;
  agentId: string;
  gameId: string | null;
  deathSeq: string | null;
  feeAmount: string;
  currencyAssetId: string;
  cooldownSeconds: number;
  availableAt: string;
  respawnedAt: string | null;
  status: 'pending' | 'cooling' | 'completed' | 'failed' | 'cancelled';
  paidLedgerId: string | null;
  createdAt: string;
  updatedAt: string;
}

const parseApiError = async (response: Response): Promise<string> => {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string' && data.error.trim()) {
      return data.error.trim();
    }
  } catch {
    // ignore parse error
  }
  return `HTTP_${response.status}`;
};

interface DashboardProps {
  initialSpectatorGameId?: string | null;
}

const setRootRoute = () => {
  if (typeof window === 'undefined') return;
  window.history.replaceState({}, '', '/');
};

const setWatchRoute = (gameId: string) => {
  if (typeof window === 'undefined') return;
  window.history.replaceState({}, '', `/watch/${encodeURIComponent(gameId)}`);
};

// 格式化游戏时长（秒 -> MM:SS 或 HH:MM:SS）
const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;

  if (hours > 0) {
    return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

export const Dashboard: React.FC<DashboardProps> = ({ initialSpectatorGameId = null }) => {
  const {
    state,
    dispatch,
    mode,
    gameId,
    seq,
    isSpectator,
    connectionState,
    onlineError,
    actionInFlight,
    isOnlineReady,
    onlineInteractionBlockedReason,
    joinSpectator
  } = useGame();
  const [isAiProcessing, setIsAiProcessing] = useState(false);
  const [showExitModal, setShowExitModal] = useState(false);
  const [showAdmin, setShowAdmin] = useState(false);
  const [showMarket, setShowMarket] = useState(false); // 新增市场模态框状态
  const [showA2AMarket, setShowA2AMarket] = useState(false);
  const [showGameOverOverlay, setShowGameOverOverlay] = useState(true);
  const [hasSave, setHasSave] = useState(false);
  const [hoveredItem, setHoveredItem] = useState<Item | null>(null);
  const [godMode, setGodMode] = useState(false);
  const [spectatorTarget, setSpectatorTarget] = useState('');
  const [spectatorError, setSpectatorError] = useState('');
  const [isJoiningSpectator, setIsJoiningSpectator] = useState(false);
  const [shareCopied, setShareCopied] = useState(false);
  const [respawnRecord, setRespawnRecord] = useState<RespawnRecordView | null>(null);
  const [respawnLoading, setRespawnLoading] = useState(false);
  const [respawnPendingAction, setRespawnPendingAction] = useState<'request' | 'complete' | null>(null);
  const [respawnError, setRespawnError] = useState<string | null>(null);
  const [respawnNotice, setRespawnNotice] = useState<string | null>(null);
  const [respawnNow, setRespawnNow] = useState(Date.now());
  const [gameDuration, setGameDuration] = useState(0); // 游戏时长（秒）
  const autoJoinRef = useRef(false);

  // Fix: Replaced NodeJS.Timeout with ReturnType<typeof setTimeout> to resolve environment-specific type errors.
  const aiTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const managedTurnTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gameTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const t = TRANSLATIONS[state.language];
  const humanPlayer = state.players.find(p => !p.isAi);
  const isGameOver = state.phase === 'GAME_OVER';
  const activePlayer = state.players[state.activePlayerIndex];
  const humanControlMode = state.aiConfig?.humanControlMode ?? 'manual';
  const isHumanManagedMode = humanControlMode === 'managed';
  const humanAgentId =
    humanPlayer?.agent?.agentId && uuidRegex.test(humanPlayer.agent.agentId)
      ? humanPlayer.agent.agentId
      : null;

  const isHumanTurn =
    !isSpectator &&
    activePlayer &&
    !activePlayer.isAi &&
    state.phase === 'ACTIVE' &&
    !isHumanManagedMode &&
    !isAiProcessing &&
    (mode === 'local' || isOnlineReady);
  const canKillAllAi =
    !isSpectator &&
    state.phase === 'ACTIVE' &&
    !isGameOver &&
    (mode === 'local' || !!gameId);
  const watchShareUrl =
    gameId && typeof window !== 'undefined'
      ? `${window.location.origin}/watch/${encodeURIComponent(gameId)}`
      : '';
  const onlineStatusText =
    connectionState === 'connected'
      ? actionInFlight
        ? 'SYNCING'
        : 'ONLINE'
      : connectionState === 'reconnecting'
        ? 'RECONNECTING'
        : connectionState === 'connecting'
          ? 'CONNECTING'
          : 'OFFLINE';
  const onlineStatusClass =
    connectionState === 'connected'
      ? actionInFlight
        ? 'text-[#F7931A] border-[#F7931A]'
        : 'text-[#00FF41] border-[#00FF41]'
      : 'text-red-400 border-red-400';
  // Prediction/A2A market access should not be blocked by transient WS disconnects.
  // Both panels can operate via HTTP fallback when online gameId exists.
  const marketEntryDisabled = mode === 'online' && !gameId;
  const humanControlModeLabel = isHumanManagedMode ? 'MANAGED' : 'MANUAL';
  const respawnRemainingSeconds =
    respawnRecord?.status === 'cooling'
      ? Math.max(0, Math.ceil((new Date(respawnRecord.availableAt).getTime() - respawnNow) / 1000))
      : 0;
  const canRequestRespawn =
    !!humanAgentId &&
    humanPlayer?.status === 'DEAD' &&
    (!respawnRecord || !['pending', 'cooling'].includes(respawnRecord.status));
  const canCompleteRespawn =
    !!humanAgentId &&
    !!respawnRecord &&
    ['pending', 'cooling'].includes(respawnRecord.status) &&
    respawnRemainingSeconds <= 0;
  const showRespawnPanel =
    mode === 'online' &&
    !!humanAgentId &&
    (humanPlayer?.status === 'DEAD' ||
      !!respawnRecord &&
        ['pending', 'cooling'].includes(respawnRecord.status));

  const startGameWithSnapshots = (agentSnapshots: AgentSnapshot[]) => {
    setRootRoute();
    dispatch({
      type: 'START_GAME',
      payload: {
        humanCount: 1,
        aiCount: 7,
        agentSnapshots
      }
    });
    setShowAdmin(false);
  };

  const loadRespawnRecord = async (agentId: string): Promise<RespawnRecordView | null> => {
    const apiBase = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
    const response = await fetch(`${apiBase}/api/agents/${agentId}/respawn`);
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    const data = await response.json();
    return (data?.record ?? null) as RespawnRecordView | null;
  };

  const handleRequestRespawn = async () => {
    if (!humanAgentId || !gameId) return;
    const apiBase = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
    setRespawnPendingAction('request');
    setRespawnError(null);
    setRespawnNotice(null);
    try {
      const response = await fetch(`${apiBase}/api/agents/${humanAgentId}/respawn/request`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          gameId,
          deathSeq: seq
        })
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const record = (await response.json()) as RespawnRecordView;
      setRespawnRecord(record);
      setRespawnNotice(
        `RESPAWN_REQUEST_ACCEPTED fee=${record.feeAmount} ${record.currencyAssetId}, cooldown=${record.cooldownSeconds}s`
      );
    } catch (error) {
      setRespawnError(error instanceof Error ? error.message : 'RESPAWN_REQUEST_FAILED');
    } finally {
      setRespawnPendingAction(null);
    }
  };

  const handleCompleteRespawn = async () => {
    if (!humanAgentId) return;
    const apiBase = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');
    setRespawnPendingAction('complete');
    setRespawnError(null);
    setRespawnNotice(null);
    try {
      const response = await fetch(`${apiBase}/api/agents/${humanAgentId}/respawn/complete`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const record = (await response.json()) as RespawnRecordView;
      setRespawnRecord(record);
      setRespawnNotice('RESPAWN_COMPLETED: agent is ACTIVE for next round.');
    } catch (error) {
      setRespawnError(error instanceof Error ? error.message : 'RESPAWN_COMPLETE_FAILED');
    } finally {
      setRespawnPendingAction(null);
    }
  };

  useEffect(() => {
    if (isGameOver) {
      setShowGameOverOverlay(true);
    } else {
      setShowGameOverOverlay(false);
    }
  }, [isGameOver]);

  useEffect(() => {
    if (mode === 'online') {
      setHasSave(false);
      return;
    }
    const save = localStorage.getItem(STORAGE_KEY);
    setHasSave(!!save);
  }, [mode, state.phase]);

  useEffect(() => {
    if (mode !== 'online' || !humanAgentId || isSpectator) {
      setRespawnRecord(null);
      return;
    }

    let cancelled = false;

    const sync = async () => {
      try {
        setRespawnLoading(true);
        const latestRecord = await loadRespawnRecord(humanAgentId);
        if (!cancelled) {
          setRespawnRecord(latestRecord);
        }
        if (!cancelled) {
          setRespawnError(null);
        }
      } catch (error) {
        if (!cancelled) {
          const message = error instanceof Error ? error.message : 'RESPAWN_STATUS_FETCH_FAILED';
          setRespawnError(message);
        }
      } finally {
        if (!cancelled) {
          setRespawnLoading(false);
        }
      }
    };

    void sync();
    const timer = setInterval(() => {
      void sync();
    }, 5000);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [humanAgentId, isSpectator, mode]);

  useEffect(() => {
    if (!respawnRecord || respawnRecord.status !== 'cooling') return;
    const timer = setInterval(() => {
      setRespawnNow(Date.now());
    }, 1000);
    return () => clearInterval(timer);
  }, [respawnRecord]);

  // 游戏时长计时
  useEffect(() => {
    // 游戏进行中时计时
    const isGameActive = state.phase === 'ACTIVE' || state.phase === 'LOOTING';

    if (isGameActive) {
      gameTimerRef.current = setInterval(() => {
        setGameDuration(prev => prev + 1);
      }, 1000);
    } else {
      // 游戏结束或不在进行中，清除计时器并重置时长
      if (gameTimerRef.current) {
        clearInterval(gameTimerRef.current);
        gameTimerRef.current = null;
      }
      if (state.phase === 'SETUP') {
        setGameDuration(0);
      }
    }

    return () => {
      if (gameTimerRef.current) {
        clearInterval(gameTimerRef.current);
        gameTimerRef.current = null;
      }
    };
  }, [state.phase]);

  /**
   * 监控回合切换与 AI 执行
   */
  useEffect(() => {
    if (mode === 'online') {
      return;
    }
    // 基础状态过滤
    if (state.phase !== 'ACTIVE' || isGameOver || isAiProcessing || showExitModal) return;

    // 索引越界安全处理
    if (state.activePlayerIndex >= state.players.length) {
      dispatch({ type: 'NEXT_TURN' });
      return;
    }

    const currentPlayer = state.players[state.activePlayerIndex];

    // 跳过已死亡玩家
    if (currentPlayer.status === 'DEAD') {
      dispatch({ type: 'SKIP_TURN', payload: { playerId: currentPlayer.id } });
      return;
    }

    // 执行 AI 逻辑（托管模式下，人类回合同样由自动决策接管）
    if (currentPlayer.isAi || isHumanManagedMode) {
      setIsAiProcessing(true);
      
      // 清除旧定时器防止重叠
      if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
      
      aiTimerRef.current = setTimeout(() => {
        // 规则模式：只使用个性，不使用 prompt
        const action = decideAiActionWithPersonality(state, currentPlayer.id, currentPlayer.personality);
        dispatch(action);
        setIsAiProcessing(false);
      }, 500); // 适中的延迟感
    }

    return () => {
      if (aiTimerRef.current) clearTimeout(aiTimerRef.current);
    };
  }, [mode, state.activePlayerIndex, state.phase, isGameOver, state.players.length, showExitModal, isHumanManagedMode]);

  useEffect(() => {
    if (!isHumanManagedMode) return;
    if (mode !== 'online') return;
    if (state.phase !== 'ACTIVE' || isGameOver || showExitModal || isSpectator) return;
    if (!activePlayer || activePlayer.isAi || activePlayer.status !== 'ALIVE') return;
    if (!isOnlineReady || actionInFlight) return;

    if (managedTurnTimerRef.current) {
      clearTimeout(managedTurnTimerRef.current);
    }

    managedTurnTimerRef.current = setTimeout(() => {
      dispatch({ type: 'SKIP_TURN', payload: { playerId: activePlayer.id } });
    }, 450);

    return () => {
      if (managedTurnTimerRef.current) {
        clearTimeout(managedTurnTimerRef.current);
      }
    };
  }, [
    activePlayer,
    actionInFlight,
    dispatch,
    isGameOver,
    isHumanManagedMode,
    isOnlineReady,
    isSpectator,
    mode,
    showExitModal,
    state.phase
  ]);

  const handleJoinSpectator = async () => {
    setSpectatorError('');
    setIsJoiningSpectator(true);
    try {
      const target = spectatorTarget.trim();
      await joinSpectator(target);
      setWatchRoute(target);
      setSpectatorTarget('');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to join game.';
      setSpectatorError(message);
    } finally {
      setIsJoiningSpectator(false);
    }
  };

  const handleCopyWatchUrl = async () => {
    if (!watchShareUrl) return;
    try {
      await navigator.clipboard.writeText(watchShareUrl);
      setShareCopied(true);
      setTimeout(() => setShareCopied(false), 1200);
    } catch {
      window.prompt('Copy watch URL:', watchShareUrl);
    }
  };

  useEffect(() => {
    if (!initialSpectatorGameId || autoJoinRef.current) return;
    autoJoinRef.current = true;
    if (mode !== 'online') {
      setSpectatorError('Watch route requires VITE_GAME_MODE=online.');
      return;
    }
    setSpectatorTarget(initialSpectatorGameId);
    setIsJoiningSpectator(true);
    setSpectatorError('');
    joinSpectator(initialSpectatorGameId)
      .then(() => {
        setWatchRoute(initialSpectatorGameId);
      })
      .catch((error) => {
        const message = error instanceof Error ? error.message : 'Failed to join game.';
        setSpectatorError(message);
      })
      .finally(() => {
        setIsJoiningSpectator(false);
      });
  }, [initialSpectatorGameId, joinSpectator, mode]);

  if (state.phase === 'WAITING') {
    const menuBtnClass = "w-full border-4 border-white text-white px-12 md:px-16 py-5 md:py-6 text-2xl md:text-3xl font-black bg-transparent hover:bg-white hover:text-black transition-all duration-200 uppercase tracking-widest";

    return (
      <div className="h-screen flex flex-col items-center justify-center bg-[#050505] relative overflow-hidden p-4 md:p-6 terminal-scanline">
        <div className="z-10 border-8 border-white p-4 md:p-6 lg:p-8 text-center bg-black min-w-[320px] md:min-w-[600px] lg:min-w-[700px] shadow-[30px_30px_0px_rgba(255,255,255,0.1)] flex flex-col max-h-[95vh] overflow-y-auto">
          <h1 className="text-4xl md:text-6xl lg:text-7xl font-black italic tracking-tighter text-[#F7931A] mb-2 md:mb-4 text-glow leading-none">{t.TITLE}</h1>
          <p className="mb-4 md:mb-8 font-mono text-sm md:text-xl lg:text-2xl opacity-60 tracking-[0.2em] md:tracking-[0.3em] uppercase">{t.SUBTITLE}</p>

          <div className="flex flex-col gap-3 md:gap-4 max-w-lg mx-auto">
            <button
              disabled={mode === 'online' && (isJoiningSpectator || connectionState === 'connecting')}
              onClick={() => {
                setRootRoute();
                dispatch({ type: 'START_GAME', payload: { humanCount: 1, aiCount: 7 } });
              }}
              className={`${menuBtnClass} disabled:opacity-40 disabled:cursor-not-allowed`}
            >
              {t.START}
            </button>
            {mode === 'local' && hasSave && (
              <button onClick={() => { const s = localStorage.getItem(STORAGE_KEY); if(s) dispatch({type: 'LOAD_GAME', payload: JSON.parse(s)}); }} className={menuBtnClass}>{t.RESUME}</button>
            )}
            <button onClick={() => dispatch({ type: 'SET_LANGUAGE', payload: state.language === 'zh' ? 'en' : 'zh' })} className={menuBtnClass}>{t.LANG}</button>
            {mode === 'online' && (
              <div className="mt-2 md:mt-4 border-4 border-white/20 p-3 md:p-4 text-left">
                <p className="text-[10px] md:text-xs opacity-60 uppercase tracking-[0.15em] mb-2">Spectator / Read Only</p>
                <p className={`text-[9px] md:text-[10px] uppercase font-black tracking-[0.15em] mb-2 inline-block border px-1 md:px-2 py-0.5 md:py-1 ${onlineStatusClass}`}>
                  {onlineStatusText}
                </p>
                <input
                  value={spectatorTarget}
                  onChange={(e) => setSpectatorTarget(e.target.value)}
                  placeholder="Game UUID"
                  className="w-full bg-black border-2 border-white/40 text-white px-2 md:px-4 py-2 md:py-3 font-mono text-xs md:text-sm focus:outline-none focus:border-[#F7931A]"
                />
                <button
                  disabled={isJoiningSpectator || !spectatorTarget.trim()}
                  onClick={() => { void handleJoinSpectator(); }}
                  className="w-full mt-2 border-2 border-[#F7931A] text-[#F7931A] py-2 md:py-3 text-xs md:text-sm font-black uppercase hover:bg-[#F7931A] hover:text-black disabled:opacity-40"
                >
                  {isJoiningSpectator ? 'CONNECTING...' : 'WATCH GAME'}
                </button>
                {spectatorError && <p className="mt-1 md:mt-2 text-[10px] md:text-xs text-red-400">{spectatorError}</p>}
                {onlineError && <p className="mt-1 md:mt-2 text-[10px] md:text-xs text-red-400">{onlineError}</p>}
              </div>
            )}
          </div>

          <div className="mt-4 md:mt-6 pt-3 md:pt-4 border-t border-white/10">
            <div className="flex flex-col items-center justify-center gap-1.5 md:gap-2">
              <button onClick={() => setShowAdmin(true)} className="text-[10px] md:text-xs text-white/30 hover:text-[#F7931A] hover:opacity-100 uppercase transition-all tracking-[0.15em] md:tracking-[0.2em] py-1.5 md:py-2 px-3 md:px-4 border border-transparent hover:border-white/20 hover:bg-white/5 backdrop-blur-md font-bold whitespace-nowrap">
                --- ROOT_ACCESS_GRANTED [{t.ADMIN}] ---
              </button>
              <button onClick={() => setShowA2AMarket(true)} className="text-[10px] md:text-xs text-white/40 hover:text-[#00FF41] hover:opacity-100 uppercase transition-all tracking-[0.15em] md:tracking-[0.2em] py-1.5 md:py-2 px-3 md:px-4 border border-transparent hover:border-white/20 hover:bg-white/5 backdrop-blur-md font-bold whitespace-nowrap">
                --- OPEN [{t.A2A_MARKET}] ---
              </button>
            </div>
          </div>
        </div>

        {showA2AMarket && <A2AMarket onClose={() => setShowA2AMarket(false)} />}
        {showAdmin && (
          <AdminPanel
            onClose={() => setShowAdmin(false)}
            onStartGameWithSnapshots={startGameWithSnapshots}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-screen flex flex-col p-6 gap-6 bg-[#050505] text-white font-mono terminal-scanline select-none overflow-hidden text-base">
      <LootModal onHoverItem={setHoveredItem} />
      {showAdmin && (
        <AdminPanel
          onClose={() => setShowAdmin(false)}
          onStartGameWithSnapshots={startGameWithSnapshots}
        />
      )}
      {showMarket && <PredictionMarket onClose={() => setShowMarket(false)} />}
      {showA2AMarket && <A2AMarket onClose={() => setShowA2AMarket(false)} />}
      
      {/* 新增：AI 配置弹窗，在 SETUP 阶段显示 */}
      {state.phase === 'SETUP' && <AgentSetupModal />}
      
      <header className="flex justify-between items-end border-b-8 border-[#F7931A] pb-4 flex-none">
        <div className="flex items-end gap-10">
          <div>
            <h2 className="text-5xl font-black italic text-[#F7931A] leading-none text-glow uppercase tracking-tighter">{t.TITLE}</h2>
            <div className="text-xs opacity-40 uppercase tracking-[0.2em] mt-2 font-black">
              NODE_{activePlayer?.id.slice(-2)} // {activePlayer?.name}{isSpectator ? ' // SPECTATOR_MODE' : ''}
            </div>
            {mode === 'online' && (
              <div className={`mt-2 inline-block border px-3 py-1 text-[10px] font-black uppercase tracking-[0.25em] ${onlineStatusClass}`}>
                {onlineStatusText}
              </div>
            )}
            <div
              className={`mt-2 inline-block border px-3 py-1 text-[10px] font-black uppercase tracking-[0.2em] ${
                isHumanManagedMode
                  ? 'border-[#00FF41] text-[#00FF41]'
                  : 'border-white/40 text-white/70'
              }`}
            >
              CONTROL_MODE: {humanControlModeLabel}
            </div>
          </div>
        </div>
        <div className="flex gap-12 items-center text-right">
          {mode === 'online' && gameId && (
            <button
              onClick={() => { void handleCopyWatchUrl(); }}
              className="border-2 border-white/30 text-white px-4 py-1 text-xs font-black hover:bg-white hover:text-black transition-all uppercase tracking-widest"
            >
              [{shareCopied ? 'COPIED' : 'SHARE_WATCH_URL'}]
            </button>
          )}
          {/* 新增：预测市场按钮 */}
          <button
            onClick={() => setShowMarket(true)}
            className="border-2 border-[#00FF41] text-[#00FF41] px-4 py-1 text-xs font-black hover:bg-[#00FF41] hover:text-black transition-all uppercase tracking-widest shadow-[0_0_10px_rgba(0,255,65,0.2)] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={marketEntryDisabled}
          >
            [{t.MARKET}]
          </button>
          <button
            onClick={() => setShowA2AMarket(true)}
            className="border-2 border-[#F7931A] text-[#F7931A] px-4 py-1 text-xs font-black hover:bg-[#F7931A] hover:text-black transition-all uppercase tracking-widest shadow-[0_0_10px_rgba(247,147,26,0.2)] disabled:opacity-40 disabled:cursor-not-allowed"
            disabled={marketEntryDisabled}
          >
            [{t.A2A_MARKET}]
          </button>

          <div><div className="text-xs opacity-40 uppercase font-black">{t.CYCLE}</div><div className="text-4xl font-black">{state.turnCount}</div></div>
          <div><div className="text-xs opacity-40 uppercase font-black">{t.ALIVE}</div><div className="text-4xl font-black">{state.players.filter(p=>p.status==='ALIVE').length}</div></div>
          <div><div className="text-xs opacity-40 uppercase font-black">{t.DURATION}</div><div className="text-4xl font-black">{formatDuration(gameDuration)}</div></div>
          <button onClick={() => setShowExitModal(true)} className="border-4 border-white/40 px-6 py-2 text-sm font-black hover:bg-white hover:text-black transition-all uppercase tracking-widest">[{t.EXIT}]</button>
        </div>
      </header>

      <div className="flex-1 grid grid-cols-2 gap-6 min-h-0 overflow-hidden">
        {mode === 'online' && onlineError && (
          <div className="lg:col-span-2 border-2 border-red-500/80 bg-red-500/10 px-4 py-2 text-xs font-bold uppercase tracking-wider text-red-300">
            {onlineError}
          </div>
        )}
        <div className="flex flex-col gap-6 min-h-0 overflow-hidden">
          <div className="flex-1 min-h-0 flex flex-col items-center justify-center bg-[#0a0a0a] border-4 border-white/20 relative shadow-inner overflow-hidden">
            <div className="w-full max-w-[500px] flex justify-end mb-2">
              <button
                onClick={() => setGodMode(!godMode)}
                className={`text-[10px] px-3 py-1 font-bold border-2 transition-all uppercase tracking-widest ${godMode ? 'bg-[#00FF41] text-black border-[#00FF41]' : 'bg-transparent text-white/30 border-white/10 hover:border-white/30'}`}
              >
                [DEBUG: VISION_{godMode ? 'ON' : 'OFF'}]
              </button>
            </div>

            <GridMap state={state} humanPlayer={humanPlayer} godMode={godMode} />

            {isAiProcessing && (
              <div className="absolute top-10 right-10 bg-[#F7931A] text-black px-8 py-3 text-xl font-black animate-pulse shadow-[0_0_30px_#F7931A] border-4 border-white z-20">
                [{t.SYSTEM_BUSY}]
              </div>
            )}
          </div>
          <div className="h-64 flex-none min-h-0">
            <GameLog logs={state.log} />
          </div>
        </div>

        <div className="grid grid-cols-2 grid-rows-2 gap-6 min-h-0 overflow-hidden auto-rows-fr">
          <div className="min-h-0 flex flex-col border-4 border-white p-4 bg-black shadow-[10px_10px_0px_rgba(255,255,255,0.05)] overflow-hidden">
            {humanPlayer && (
              <CombatPanel player={humanPlayer} hoveredItem={hoveredItem} language={state.language} />
            )}
          </div>
          <div className="min-h-0 flex flex-col border-4 border-white p-4 bg-black shadow-[10px_10px_0px_rgba(255,255,255,0.05)] overflow-hidden">
            <h3 className="text-sm font-black border-b-2 border-white/20 mb-3 pb-2 flex justify-between uppercase tracking-widest flex-shrink-0">
              <span>{t.PROFILE}</span>
              {isHumanTurn && <span className="text-[#F7931A] animate-pulse">{t.YOUR_TURN}</span>}
            </h3>
            {humanPlayer && (
              <div className="space-y-4">
                <div className={humanPlayer.status === 'DEAD' ? 'opacity-30 grayscale space-y-2' : 'space-y-2'}>
                  {/* 恢复红色 */}
                  <StatBar label="HP" value={humanPlayer.stats.hp} maxValue={humanPlayer.stats.maxHp} color="bg-red-600" />
                  <StatBar label="HUNGER" value={humanPlayer.stats.hunger} maxValue={humanPlayer.stats.maxHunger} color="bg-yellow-600" />
                  <StatBar label="THIRST" value={humanPlayer.stats.thirst} maxValue={humanPlayer.stats.maxThirst} color="bg-blue-600" />
                </div>

                {showRespawnPanel && (
                  <div className="border-2 border-[#F7931A]/70 bg-[#F7931A]/10 p-3">
                    <div className="flex items-center justify-between">
                      <p className="text-[10px] font-black uppercase tracking-[0.2em] text-[#F7931A]">
                        RESPAWN_CONSOLE
                      </p>
                      {respawnLoading && (
                        <p className="text-[10px] opacity-60 uppercase">
                          SYNCING...
                        </p>
                      )}
                    </div>
                    <p className="mt-2 text-[10px] opacity-70 break-all">
                      agent: {humanAgentId}
                    </p>
                    <p className="text-[10px] opacity-70 uppercase">
                      game_status: {humanPlayer.status}
                    </p>
                    <p className="text-[10px] opacity-70 uppercase">
                      respawn_status: {respawnRecord?.status ?? 'none'}
                    </p>
                    <p className="text-[10px] opacity-70 uppercase">
                      fee: {respawnRecord ? `${respawnRecord.feeAmount} ${respawnRecord.currencyAssetId}` : 'server_default'}
                    </p>
                    {respawnRecord?.status === 'cooling' && (
                      <p className="text-[10px] uppercase text-[#00FF41]">
                        cooldown_remaining: {respawnRemainingSeconds}s
                      </p>
                    )}

                    <div className="mt-3 flex gap-2">
                      <button
                        onClick={() => { void handleRequestRespawn(); }}
                        disabled={!canRequestRespawn || !!respawnPendingAction || actionInFlight}
                        className="border border-[#F7931A] text-[#F7931A] px-2 py-1 text-[10px] font-black uppercase hover:bg-[#F7931A] hover:text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {respawnPendingAction === 'request' ? 'REQUESTING...' : 'REQUEST_RESPAWN'}
                      </button>
                      <button
                        onClick={() => { void handleCompleteRespawn(); }}
                        disabled={!canCompleteRespawn || !!respawnPendingAction || actionInFlight}
                        className="border border-[#00FF41] text-[#00FF41] px-2 py-1 text-[10px] font-black uppercase hover:bg-[#00FF41] hover:text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                      >
                        {respawnPendingAction === 'complete' ? 'COMPLETING...' : 'COMPLETE_RESPAWN'}
                      </button>
                    </div>

                    {respawnError && (
                      <p className="mt-2 text-[10px] text-red-400 break-all">
                        {respawnError}
                      </p>
                    )}
                    {respawnNotice && (
                      <p className="mt-2 text-[10px] text-[#00FF41] break-all">
                        {respawnNotice}
                      </p>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>
          <div className="min-h-0 flex flex-col border-4 border-white p-4 bg-black shadow-[10px_10px_0px_rgba(255,255,255,0.05)] overflow-hidden">
            <Inventory
              player={humanPlayer}
              isHumanTurn={isHumanTurn}
              dispatch={dispatch}
              onHoverItem={setHoveredItem}
              language={state.language}
            />
          </div>
          <div className="min-h-0 flex flex-col border-4 border-white p-4 bg-black shadow-[10px_10px_0px_rgba(255,255,255,0.05)] overflow-hidden">
             <h3 className="text-sm font-black border-b-2 border-white/20 mb-3 pb-2 uppercase tracking-widest flex-shrink-0">
                COMMAND_MATRIX
             </h3>
             {mode === 'online' && !isSpectator && onlineInteractionBlockedReason && (
              <div className="mb-3 border border-[#F7931A]/60 bg-[#F7931A]/10 px-2 py-2 text-[10px] font-black uppercase tracking-[0.15em] text-[#F7931A] flex-shrink-0">
                {onlineInteractionBlockedReason}
              </div>
             )}
             <div className="flex-1 min-h-0 overflow-y-auto pr-1">
               <div className="min-h-full flex items-start justify-center">
                 <ControlPanel
                   player={humanPlayer}
                   dispatch={dispatch}
                   disabled={!isHumanTurn}
                   killAllDisabled={!canKillAllAi}
                   onActionComplete={() => {}}
                 />
               </div>
             </div>
          </div>
        </div>
      </div>

      {showExitModal && (
        <div className="fixed inset-0 bg-black/90 flex items-center justify-center z-[500] backdrop-blur-md animate-in fade-in duration-300">
          <div className="border-8 border-white p-16 bg-black text-center min-w-[600px] shadow-[20px_20px_0px_#F7931A]">
            <h3 className="text-5xl font-black mb-12 text-[#F7931A] uppercase italic tracking-tighter leading-none">{t.EXIT_CONFIRM}</h3>
            <div className="flex flex-col gap-6">
              {mode === 'local' && (
                <button onClick={() => { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); dispatch({ type: 'EXIT_TO_MENU' }); setShowExitModal(false); }} className="bg-white text-black py-8 text-3xl font-black hover:bg-[#F7931A] hover:text-white transition-all uppercase">{t.SAVE_EXIT}</button>
              )}
              <button onClick={() => { setRootRoute(); dispatch({ type: 'EXIT_TO_MENU' }); setShowExitModal(false); }} className="bg-white/10 border-4 border-white text-white py-8 text-3xl font-black hover:bg-white hover:text-black transition-all uppercase">{t.EXIT}</button>
              <button onClick={() => { setRootRoute(); dispatch({ type: 'START_GAME', payload: { humanCount: 1, aiCount: 7 } }); setShowExitModal(false); }} className="border-4 border-white text-white py-8 text-3xl font-black hover:bg-white hover:text-black transition-all uppercase">{t.RESTART}</button>
              <button onClick={() => setShowExitModal(false)} className="text-lg opacity-50 hover:opacity-100 uppercase mt-4 tracking-[0.5em] font-black underline underline-offset-8 transition-all">{t.CANCEL}</button>
            </div>
          </div>
        </div>
      )}

      {isGameOver && showGameOverOverlay && !showMarket && !showA2AMarket && (
        <div className="fixed inset-0 bg-black/98 flex flex-col items-center justify-center z-[1000] p-3 sm:p-4 md:p-6 animate-in fade-in zoom-in duration-700 overflow-y-auto">
          <div className="border-[6px] sm:border-[8px] md:border-[10px] border-[#F7931A] p-4 sm:p-6 md:p-8 text-center bg-black w-full max-w-3xl max-h-[92vh] overflow-y-auto shadow-[0_0_80px_rgba(247,147,26,0.45)] flex flex-col items-center">
            <h2 className="text-3xl sm:text-4xl md:text-5xl lg:text-6xl font-black italic mb-3 text-[#F7931A] uppercase leading-none tracking-tighter text-glow break-words w-full">
              {t.MISSION_END}
            </h2>
            <div className="text-base sm:text-lg md:text-2xl font-black mb-4 sm:mb-6 md:mb-8 border-y-2 sm:border-y-4 border-white py-2 sm:py-3 md:py-4 uppercase tracking-[0.14em] sm:tracking-[0.2em] w-full">
              {t.SURVIVOR}: {state.winner?.name || 'NONE'}
            </div>
            <div className="w-full flex flex-col gap-2 sm:gap-3">
              <button
                onClick={() => setShowMarket(true)}
                className="w-full border-2 sm:border-4 border-[#00FF41] text-[#00FF41] py-2.5 sm:py-3 md:py-4 text-sm sm:text-base md:text-xl font-black hover:bg-[#00FF41] hover:text-black transition-all uppercase whitespace-nowrap"
              >
                {t.MARKET}
              </button>
              <button
                onClick={() => setShowA2AMarket(true)}
                className="w-full border-2 sm:border-4 border-[#F7931A] text-[#F7931A] py-2.5 sm:py-3 md:py-4 text-sm sm:text-base md:text-xl font-black hover:bg-[#F7931A] hover:text-black transition-all uppercase whitespace-nowrap"
              >
                {t.A2A_MARKET}
              </button>
              <button
                onClick={() => {
                  setShowGameOverOverlay(false);
                }}
                className="w-full border-2 sm:border-4 border-white/60 text-white py-2.5 sm:py-3 md:py-4 text-sm sm:text-base md:text-xl font-black hover:bg-white hover:text-black transition-all uppercase whitespace-nowrap"
              >
                {t.RETURN_TERMINAL}
              </button>
              <button onClick={() => { setRootRoute(); dispatch({ type: 'START_GAME', payload: { humanCount: 1, aiCount: 7 } }); }} className="w-full bg-white text-black py-3 sm:py-4 md:py-6 text-base sm:text-lg md:text-2xl font-black hover:bg-[#F7931A] hover:text-white transition-all shadow-[6px_6px_0px_rgba(255,255,255,0.18)] uppercase whitespace-nowrap">
              {t.REBOOT}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
