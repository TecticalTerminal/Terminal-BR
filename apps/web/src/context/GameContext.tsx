import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  ReactNode
} from 'react';
import { GameState, GameAction, AgentSnapshot } from '@tactical/shared-types';
import { gameReducer } from '@tactical/game-engine';

/**
 * 初始状态
 */
const initialState: GameState = {
  players: [],
  grid: [],
  turnCount: 0,
  activePlayerIndex: 0,
  log: ['WAITING FOR COMMAND...'],
  phase: 'WAITING',
  language: 'zh', // 默认语言为中文
  // Fix: Added missing 'settings' property to satisfy GameState interface
  settings: {
    searchSuccessRate: 0.5
  },
  userBalance: 1000
};

/**
 * 定义 Context 类型
 */
interface GameContextType {
  state: GameState;
  dispatch: (action: GameAction) => void;
  mode: 'local' | 'online';
  gameId: string | null;
  seq: number;
  isSpectator: boolean;
  connectionState: 'idle' | 'connecting' | 'connected' | 'reconnecting';
  onlineError: string | null;
  actionInFlight: boolean;
  isOnlineReady: boolean;
  onlineInteractionBlockedReason: string | null;
  joinSpectator: (targetGameId: string) => Promise<void>;
  leaveSpectator: () => void;
}

const GameContext = createContext<GameContextType | undefined>(undefined);

const resolveMode = (): 'local' | 'online' => {
  const mode = (import.meta.env.VITE_GAME_MODE ?? 'local').toLowerCase();
  return mode === 'online' ? 'online' : 'local';
};

const resolveApiBase = (): string =>
  (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const toWebSocketBase = (httpBase: string): string => {
  if (httpBase.startsWith('https://')) return `wss://${httpBase.slice('https://'.length)}`;
  if (httpBase.startsWith('http://')) return `ws://${httpBase.slice('http://'.length)}`;
  return httpBase;
};

/**
 * 游戏状态提供者组件
 */
export const GameProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const mode = useMemo(resolveMode, []);
  const apiBase = useMemo(resolveApiBase, []);
  const wsBase = useMemo(() => toWebSocketBase(apiBase), [apiBase]);
  const [state, setState] = useState<GameState>(initialState);
  const [gameId, setGameId] = useState<string | null>(null);
  const [seq, setSeq] = useState(0);
  const [isSpectator, setIsSpectator] = useState(false);
  const [connectionState, setConnectionState] = useState<
    'idle' | 'connecting' | 'connected' | 'reconnecting'
  >('idle');
  const [onlineError, setOnlineError] = useState<string | null>(null);
  const [actionInFlight, setActionInFlight] = useState(false);
  const wsRef = useRef<WebSocket | null>(null);
  const gameIdRef = useRef<string | null>(null);
  const seqRef = useRef(0);
  const stateRef = useRef(initialState);
  const spectatorRef = useRef(false);
  const reconnectAttemptsRef = useRef(0);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const reconnectEnabledRef = useRef(false);
  const actionInFlightRef = useRef(false);
  const priorityActionRef = useRef<GameAction | null>(null);
  const wsWarnAtRef = useRef(0);

  useEffect(() => {
    gameIdRef.current = gameId;
  }, [gameId]);

  useEffect(() => {
    seqRef.current = seq;
  }, [seq]);

  useEffect(() => {
    stateRef.current = state;
  }, [state]);

  useEffect(() => {
    spectatorRef.current = isSpectator;
  }, [isSpectator]);

  useEffect(() => {
    actionInFlightRef.current = actionInFlight;
  }, [actionInFlight]);

  const resetToWaiting = useCallback(() => {
    setState((prev) => ({
      ...initialState,
      language: prev.language,
      settings: prev.settings
    }));
    setSeq(0);
    setGameId(null);
    setIsSpectator(false);
    setConnectionState('idle');
    setOnlineError(null);
    setActionInFlight(false);
  }, []);

  const clearReconnectTimer = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
  }, []);

  const closeSocket = useCallback(() => {
    clearReconnectTimer();
    if (wsRef.current) {
      const socket = wsRef.current;
      wsRef.current = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      socket.close();
    }
  }, [clearReconnectTimer]);

  const reportWsWarning = useCallback((message: string) => {
    const now = Date.now();
    if (now - wsWarnAtRef.current < 5000) return;
    wsWarnAtRef.current = now;
    // eslint-disable-next-line no-console
    console.warn(`[ws] ${message}`);
  }, []);

  const refreshGame = useCallback(
    async (id: string): Promise<{ seq: number; state: GameState }> => {
      const response = await fetch(`${apiBase}/api/games/${id}`);
      if (!response.ok) {
        throw new Error(`Failed to refresh game ${id}: ${response.status}`);
      }
      const data = await response.json();
      if ((data.seq as number) < seqRef.current) {
        return {
          seq: seqRef.current,
          state: stateRef.current
        };
      }
      stateRef.current = data.state as GameState;
      seqRef.current = data.seq as number;
      setState(data.state);
      setSeq(data.seq);
      return {
        seq: data.seq as number,
        state: data.state as GameState
      };
    },
    [apiBase]
  );

  const leaveSpectator = useCallback(() => {
    reconnectEnabledRef.current = false;
    closeSocket();
    resetToWaiting();
  }, [closeSocket, resetToWaiting]);

  const connectSocket = useCallback(
    (id: string, isReconnect = false) => {
      if (mode !== 'online') return;
      reconnectEnabledRef.current = true;
      clearReconnectTimer();
      closeSocket();
      setConnectionState(isReconnect ? 'reconnecting' : 'connecting');
      const socket = new WebSocket(`${wsBase}/ws?gameId=${id}`);
      wsRef.current = socket;

      socket.onopen = () => {
        reconnectAttemptsRef.current = 0;
        setConnectionState('connected');
        setOnlineError(null);
        void refreshGame(id).catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to sync game state.';
          setOnlineError(message);
        });
      };

      socket.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          if (message?.type === 'state_snapshot' && message?.payload?.gameId === gameIdRef.current) {
            const nextSeq = Number(message.payload.seq);
            if (Number.isFinite(nextSeq) && nextSeq >= seqRef.current) {
              stateRef.current = message.payload.state as GameState;
              seqRef.current = nextSeq;
              setState(message.payload.state);
              setSeq(nextSeq);
            }
            return;
          }
          if (message?.type === 'action_applied' && message?.payload?.gameId === gameIdRef.current) {
            if (typeof message.payload.seq === 'number' && message.payload.seq >= seqRef.current) {
              if (message.payload.state) {
                stateRef.current = message.payload.state as GameState;
                setState(message.payload.state);
              }
              seqRef.current = message.payload.seq;
              setSeq(message.payload.seq);
            }
          }
        } catch (error) {
          // eslint-disable-next-line no-console
          console.error('Failed to parse ws message', error);
        }
      };

      socket.onerror = () => {
        setOnlineError(null);
        reportWsWarning('WebSocket connection error.');
      };

      socket.onclose = () => {
        if (mode !== 'online') return;
        if (!reconnectEnabledRef.current) return;
        if (gameIdRef.current !== id) return;

        setConnectionState('reconnecting');
        const attempts = reconnectAttemptsRef.current + 1;
        reconnectAttemptsRef.current = attempts;
        const delay = Math.min(1000 * 2 ** Math.min(attempts, 4), 15_000);
        clearReconnectTimer();
        reconnectTimerRef.current = setTimeout(() => {
          if (!reconnectEnabledRef.current) return;
          if (gameIdRef.current !== id) return;
          connectSocket(id, true);
        }, delay);
      };
    },
    [clearReconnectTimer, closeSocket, mode, refreshGame, reportWsWarning, wsBase]
  );

  useEffect(() => {
    return () => {
      reconnectEnabledRef.current = false;
      closeSocket();
    };
  }, [closeSocket]);

  const startOnlineGame = useCallback(
    async (payload: { humanCount: number; aiCount: number; agentSnapshots?: AgentSnapshot[] }) => {
      reconnectEnabledRef.current = false;
      closeSocket();
      setGameId(null);
      setSeq(0);
      setIsSpectator(false);
      setOnlineError(null);
      setConnectionState('connecting');

      const response = await fetch(`${apiBase}/api/games`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          ...payload,
          mode: 'online',
          language: stateRef.current.language
        })
      });

      if (!response.ok) {
        throw new Error(`Failed to create game: ${response.status}`);
      }

      const data = await response.json();
      setGameId(data.gameId);
      setSeq(data.seq);
      setState(data.state);
      connectSocket(data.gameId);
    },
    [apiBase, closeSocket, connectSocket]
  );

  const joinSpectator = useCallback(
    async (targetGameId: string) => {
      if (mode !== 'online') {
        throw new Error('Spectator mode is only available in online mode.');
      }
      const normalized = targetGameId.trim();
      if (!normalized) {
        throw new Error('Game ID is required.');
      }

      reconnectEnabledRef.current = false;
      closeSocket();
      setOnlineError(null);
      setConnectionState('connecting');
      try {
        const response = await fetch(`${apiBase}/api/games/${normalized}`);
        if (!response.ok) {
          throw new Error(`Failed to join game ${normalized}: ${response.status}`);
        }
        const data = await response.json();
        setGameId(normalized);
        setSeq(data.seq);
        setState(data.state);
        setIsSpectator(true);
        connectSocket(normalized);
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to join game.';
        setConnectionState('idle');
        setOnlineError(message);
        throw error;
      }
    },
    [apiBase, closeSocket, connectSocket, mode]
  );

  const submitOnlineAction = useCallback(
    async (action: GameAction) => {
      const id = gameIdRef.current;
      if (!id) {
        setOnlineError('No active online game session.');
        return;
      }
      if (actionInFlightRef.current) {
        return;
      }
      setActionInFlight(true);
      actionInFlightRef.current = true;

      const clientActionId =
        typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random()}`;

      try {
        const expectedSeq = action.type === 'KILL_ALL_AI' ? undefined : seqRef.current;
        const response = await fetch(`${apiBase}/api/games/${id}/actions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            action,
            expectedSeq,
            clientActionId
          })
        });

        if (response.status === 409) {
          const latest = await refreshGame(id);
          // Managed mode may race with auto actions; keep kill deterministic by re-queueing
          // when the game is still active after a seq conflict refresh.
          if (action.type === 'KILL_ALL_AI' && latest.state.phase === 'ACTIVE') {
            priorityActionRef.current = action;
          }
          return;
        }

        if (!response.ok) {
          throw new Error(`Failed to apply action: ${response.status}`);
        }

        const data = await response.json();
        if ((data.seq as number) >= seqRef.current) {
          stateRef.current = data.state as GameState;
          seqRef.current = data.seq as number;
          setState(data.state);
          setSeq(data.seq);
        }
        setOnlineError(null);
      } finally {
        setActionInFlight(false);
        actionInFlightRef.current = false;

        // Emergency action lane: ensure KILL_ALL_AI is not starved by managed-mode auto actions.
        const queued = priorityActionRef.current;
        if (queued) {
          priorityActionRef.current = null;
          void submitOnlineAction(queued).catch((error) => {
            const message = error instanceof Error ? error.message : 'Failed to submit queued action.';
            setOnlineError(message);
          });
        }
      }
    },
    [apiBase, refreshGame]
  );

  const dispatch = useCallback(
    (action: GameAction) => {
      if (mode === 'online') {
        if (action.type === 'SET_LANGUAGE') {
          setState((prev) => gameReducer(prev, action));
          return;
        }

        if (action.type === 'START_GAME') {
          void startOnlineGame(action.payload).catch((error) => {
            const message = error instanceof Error ? error.message : 'Failed to create online game.';
            setOnlineError(message);
            setConnectionState('idle');
          });
          return;
        }

        if (action.type === 'EXIT_TO_MENU') {
          if (spectatorRef.current) {
            leaveSpectator();
            return;
          }
          reconnectEnabledRef.current = false;
          closeSocket();
          resetToWaiting();
          return;
        }

        if (action.type === 'LOAD_GAME') {
          setState(action.payload);
          return;
        }

        if (spectatorRef.current) {
          setOnlineError('Spectator mode is read-only.');
          return;
        }
        if (!gameIdRef.current) {
          setOnlineError('No active online game session.');
          return;
        }
        if (actionInFlightRef.current) {
          if (action.type === 'KILL_ALL_AI') {
            priorityActionRef.current = action;
            setOnlineError('KILL_ALL_AI queued. Executing after current action...');
            return;
          }
          setOnlineError('Waiting for server confirmation...');
          return;
        }

        // Keep gameplay operable even when WS is temporarily unavailable:
        // actions are still submitted through HTTP and local state is updated
        // from the response payload.
        if (connectionState !== 'connected') {
          setOnlineError(null);
          reportWsWarning('WebSocket unavailable. Using HTTP fallback for actions.');
        }

        void submitOnlineAction(action).catch((error) => {
          const message = error instanceof Error ? error.message : 'Failed to submit action.';
          setOnlineError(message);
        });
        return;
      }

      setState((prev) => gameReducer(prev, action));
    },
    [
      closeSocket,
      connectionState,
      leaveSpectator,
      mode,
      resetToWaiting,
      startOnlineGame,
      submitOnlineAction,
      reportWsWarning
    ]
  );

  const onlineInteractionBlockedReason = useMemo(() => {
    if (mode !== 'online') return null;
    if (isSpectator) return 'Spectator mode is read-only.';
    if (!gameId) return 'No active online game session.';
    if (actionInFlight) return 'Waiting for server confirmation...';
    return null;
  }, [actionInFlight, gameId, isSpectator, mode]);

  const isOnlineReady = mode === 'online' && onlineInteractionBlockedReason === null;

  return (
    <GameContext.Provider
      value={{
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
        joinSpectator,
        leaveSpectator
      }}
    >
      {children}
    </GameContext.Provider>
  );
};

/**
 * 游戏状态 Hook
 */
export const useGame = () => {
  const context = useContext(GameContext);
  if (!context) {
    throw new Error('useGame must be used within a GameProvider');
  }
  return context;
};
