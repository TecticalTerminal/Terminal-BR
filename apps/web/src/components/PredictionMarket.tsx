
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useGame } from '../context/GameContext';
import { Player } from '@tactical/shared-types';
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWriteContract } from 'wagmi';
import { formatEther, type Hash } from 'viem';
import {
  chainMarketConfig,
  fetchMarketByGameId,
  outcomeHashForPlayer,
  predictionMarketAbi,
  type GameMarketResponse
} from '../lib/chainMarket';
import { pickPreferredConnector } from '../lib/walletConnector';

interface PredictionMarketProps {
  onClose: () => void;
}

// 简单的 SVG 折线图组件 (保持不变，但容器可能会调整)
const PriceChart: React.FC<{ players: Player[] }> = ({ players }) => {
  const topPlayers = [...players]
    .filter(p => p.status === 'ALIVE')
    .sort((a, b) => b.market.price - a.market.price)
    .slice(0, 3);

  const colors = ['#00FF41', '#FFFF00', '#00FFFF'];
  const height = 150;
  const width = 400;

  let allPrices: number[] = [];
  topPlayers.forEach(p => allPrices = [...allPrices, ...p.market.history]);
  const minPrice = Math.min(...allPrices, 0) * 0.9;
  const maxPrice = Math.max(...allPrices, 50) * 1.1;

  const getPoints = (history: number[]) => {
    return history.map((price, index) => {
      const x = (index / (history.length - 1)) * width;
      const y = height - ((price - minPrice) / (maxPrice - minPrice)) * height;
      return `${x},${y}`;
    }).join(' ');
  };

  return (
    <div className="w-full h-full bg-black border-2 border-white/20 relative p-2 overflow-hidden">
      <div className="absolute top-2 left-2 text-[10px] uppercase font-black tracking-widest text-white/50">Alpha_Trend // Top 3</div>
      <svg width="100%" height="100%" viewBox={`0 0 ${width} ${height}`} className="overflow-visible" preserveAspectRatio="none">
        <line x1="0" y1={height/2} x2={width} y2={height/2} stroke="white" strokeOpacity="0.1" strokeDasharray="4 4" />
        {topPlayers.map((p, i) => (
          <g key={p.id}>
             <polyline 
               points={getPoints(p.market.history)} 
               fill="none" 
               stroke={colors[i]} 
               strokeWidth="2"
               strokeLinejoin="round"
               vectorEffect="non-scaling-stroke" 
               className="drop-shadow-[0_0_5px_rgba(255,255,255,0.5)]"
             />
          </g>
        ))}
      </svg>
      <div className="absolute bottom-1 right-1 flex gap-3 bg-black/80 p-1 pointer-events-none">
        {topPlayers.map((p, i) => (
          <div key={p.id} className="flex items-center gap-1">
            <div className="w-2 h-2" style={{ backgroundColor: colors[i] }}></div>
            <span className="text-[8px] font-bold" style={{ color: colors[i] }}>{p.name.split('_')[1] || p.name.substr(0,3)}</span>
          </div>
        ))}
      </div>
    </div>
  );
};

// 紧凑型 AI 市场卡片
const MarketCardCompact: React.FC<{
  player: Player;
  canTrade: boolean;
  buyLabel: string;
  readOnlyReason?: string | null;
  onBuy: (id: string) => void;
  onShowPrompt: (p: Player) => void;
}> = ({ player, canTrade, buyLabel, readOnlyReason, onBuy, onShowPrompt }) => {
  const isUp = player.market.trend === 'UP';
  const isDown = player.market.trend === 'DOWN';
  const color = isUp ? 'text-[#00FF41]' : (isDown ? 'text-[#F7931A]' : 'text-white');
  const borderColor = isUp ? 'border-[#00FF41]' : (isDown ? 'border-[#F7931A]' : 'border-white/20');
  const arrow = isUp ? '▲' : (isDown ? '▼' : '-');
  const percentChange = ((player.market.price - player.market.lastPrice) / player.market.lastPrice) * 100;

  return (
    // 移除固定高度 h-[80px]，改为 h-auto，使其自适应内容
    <div className={`bg-black border ${borderColor} p-2 flex flex-col justify-between relative group transition-all hover:bg-white/5 h-auto min-h-[80px]`}>
      {player.status === 'DEAD' && (
        <div className="absolute inset-0 bg-black/80 z-20 flex items-center justify-center pointer-events-none">
          <span className="text-[#F7931A] font-black text-sm border border-[#F7931A] px-1 transform -rotate-12">DELISTED</span>
        </div>
      )}
      
      {/* 头部信息：名称和价格 */}
      <div className="flex justify-between items-start cursor-pointer" onClick={() => onShowPrompt(player)}>
        <div className="flex items-baseline gap-2">
          <h4 className="text-[10px] font-black text-white/90 uppercase truncate max-w-[60px]">{player.name}</h4>
          <div className={`text-sm font-black ${color} flex items-center gap-0.5`}>
            {arrow}{player.market.price.toFixed(1)}
          </div>
        </div>
        <div className={`text-[9px] font-bold ${color}`}>
          {percentChange > 0 ? '+' : ''}{percentChange.toFixed(1)}%
        </div>
      </div>

      {/* 状态条区域 */}
      <div className="flex flex-col gap-1 mt-2 cursor-pointer" onClick={() => onShowPrompt(player)}>
         <div className="flex items-center gap-1">
            {/* HP 恢复红色 */}
            <span className="text-[8px] text-red-600 font-bold w-3">HP</span>
            <div className="flex-1 h-1 bg-gray-800">
               <div className="h-full bg-red-600" style={{ width: `${(player.stats.hp / player.stats.maxHp) * 100}%` }}></div>
            </div>
            <span className="text-[8px] text-white/50 w-4 text-right">{player.stats.hp}</span>
         </div>
         <div className="flex items-center gap-1">
            <span className="text-[8px] text-yellow-600 font-bold w-3">HG</span>
            <div className="flex-1 h-1 bg-gray-800">
               <div className="h-full bg-yellow-600" style={{ width: `${(player.stats.hunger / player.stats.maxHunger) * 100}%` }}></div>
            </div>
            <span className="text-[8px] text-white/50 w-4 text-right">{player.stats.hunger}</span>
         </div>
         <div className="flex items-center gap-1">
            <span className="text-[8px] text-blue-600 font-bold w-3">TH</span>
            <div className="flex-1 h-1 bg-gray-800">
               <div className="h-full bg-blue-600" style={{ width: `${(player.stats.thirst / player.stats.maxThirst) * 100}%` }}></div>
            </div>
            <span className="text-[8px] text-white/50 w-4 text-right">{player.stats.thirst}</span>
         </div>
      </div>

      {/* 购买按钮覆盖层（Hover显示） */}
      <div className="absolute bottom-1 right-1 opacity-0 group-hover:opacity-100 transition-opacity z-10">
         <button
           onClick={(e) => { e.stopPropagation(); onBuy(player.id); }}
           disabled={player.status === 'DEAD' || !canTrade}
           title={!canTrade ? readOnlyReason ?? 'READ_ONLY' : buyLabel}
           className={`px-2 py-0.5 text-[9px] font-black uppercase shadow-lg border border-white
             ${isUp ? 'bg-[#00FF41] text-black hover:bg-white' : 'bg-white text-black hover:bg-gray-300'}
             disabled:opacity-40 disabled:cursor-not-allowed
           `}
         >
           {canTrade ? buyLabel : 'READ ONLY'}
         </button>
      </div>
    </div>
  );
};

const shortAddress = (value?: string | null) => {
  if (!value) return '--';
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
};

const isReceiptSuccess = (receipt: unknown): boolean => {
  if (!receipt || typeof receipt !== 'object') return false;
  const status = (receipt as { status?: unknown }).status;
  return status === 'success' || status === 1 || status === 1n;
};

const GAS_LIMIT_CAP = 1_500_000n;

const addGasBuffer = (estimated: bigint): bigint => {
  const withBuffer = (estimated * 12n) / 10n; // +20%
  return withBuffer > GAS_LIMIT_CAP ? GAS_LIMIT_CAP : withBuffer;
};

const ZERO_HASH = '0x0000000000000000000000000000000000000000000000000000000000000000';

interface RoundSnapshot {
  gameIdHash: string;
  lockAt: number;
  resolvedAt: number;
  winnerOutcome: string;
  totalPool: bigint;
  distributablePool: bigint;
  winnerPool: bigint;
  resolved: boolean;
}

const toSafeBigInt = (value: unknown): bigint => {
  try {
    if (typeof value === 'bigint') return value;
    if (typeof value === 'number') return BigInt(value);
    if (typeof value === 'string') return BigInt(value);
    return 0n;
  } catch {
    return 0n;
  }
};

const toSafeNumber = (value: unknown): number => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'bigint') return Number(value);
  if (typeof value === 'string') {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
};

const parseRoundSnapshot = (value: unknown): RoundSnapshot | null => {
  if (!Array.isArray(value) || value.length < 8) return null;
  return {
    gameIdHash: String(value[0]),
    lockAt: toSafeNumber(value[1]),
    resolvedAt: toSafeNumber(value[2]),
    winnerOutcome: String(value[3]),
    totalPool: toSafeBigInt(value[4]),
    distributablePool: toSafeBigInt(value[5]),
    winnerPool: toSafeBigInt(value[6]),
    resolved: Boolean(value[7])
  };
};

const formatCountdown = (seconds: number): string => {
  if (seconds <= 0) return '00:00';
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
};

const toReadOnlyMessage = (reason: string | null): string => {
  if (!reason) return 'BET_READY';
  switch (reason) {
    case 'SPECTATOR_MODE':
      return 'READ_ONLY: SPECTATOR_MODE';
    case 'NO_ACTIVE_GAME':
      return 'READ_ONLY: NO_ACTIVE_GAME';
    case 'CHAIN_MARKET_DISABLED':
      return 'READ_ONLY: CHAIN_MARKET_DISABLED';
    case 'ROUND_NOT_READY':
      return 'READ_ONLY: ROUND_NOT_READY';
    case 'ROUND_LOCKED':
      return 'READ_ONLY: ROUND_LOCKED';
    case 'ROUND_RESOLVED':
      return 'READ_ONLY: ROUND_RESOLVED';
    case 'WALLET_NOT_CONNECTED':
      return 'READ_ONLY: WALLET_NOT_CONNECTED';
    case 'TX_IN_PROGRESS':
      return 'READ_ONLY: TX_IN_PROGRESS';
    default:
      if (reason.startsWith('WRONG_NETWORK_')) {
        const match = reason.match(/^WRONG_NETWORK_(.+)_EXPECT_(.+)$/);
        if (match) {
          const actual = match[1];
          const expected = match[2];
          return `READ_ONLY: SWITCH_${actual}_TO_${expected}`;
        }
        return `READ_ONLY: ${reason}`;
      }
      return `READ_ONLY: ${reason}`;
  }
};

export const PredictionMarket: React.FC<PredictionMarketProps> = ({ onClose }) => {
  const {
    state,
    dispatch,
    isSpectator,
    mode,
    gameId,
    isOnlineReady,
    connectionState,
    onlineInteractionBlockedReason
  } =
    useGame();
  const [selectedAi, setSelectedAi] = useState<Player | null>(null);
  const [marketMetadata, setMarketMetadata] = useState<GameMarketResponse | null>(null);
  const [marketMetadataError, setMarketMetadataError] = useState<string | null>(null);
  const [marketMetadataLoading, setMarketMetadataLoading] = useState(false);
  const [txStatus, setTxStatus] = useState<string | null>(null);
  const [txError, setTxError] = useState<string | null>(null);
  const [txHash, setTxHash] = useState<Hash | null>(null);
  const [claimableAmount, setClaimableAmount] = useState<bigint>(0n);
  const [alreadyClaimed, setAlreadyClaimed] = useState(false);
  const [claimLoading, setClaimLoading] = useState(false);
  const [roundSnapshot, setRoundSnapshot] = useState<RoundSnapshot | null>(null);
  const [roundStateError, setRoundStateError] = useState<string | null>(null);
  const [nowSec, setNowSec] = useState(() => Math.floor(Date.now() / 1000));

  const { address, isConnected, chain, connector } = useAccount();
  const { connectAsync, connectors, isPending: connectPending } = useConnect();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const { writeContractAsync, isPending: writePending } = useWriteContract();
  const publicClient = usePublicClient({ chainId: chainMarketConfig.chain.id }) as
    | {
        readContract: (args: unknown) => Promise<unknown>;
        estimateContractGas: (args: unknown) => Promise<bigint>;
        waitForTransactionReceipt: (args: { hash: Hash }) => Promise<unknown>;
      }
    | undefined;

  const chainModeRequested = mode === 'online' && chainMarketConfig.requested;
  const chainModeEnabled = mode === 'online' && chainMarketConfig.enabled;

  const aliveCount = state.players.filter(p => p.status === 'ALIVE').length;
  const progress = Math.min(100, (state.turnCount / 50) * 100);
  const localTradeReady = !isSpectator && (mode === 'local' || (!!gameId && connectionState === 'connected'));
  const walletWrongNetwork =
    chainModeEnabled && isConnected && chain?.id !== chainMarketConfig.chain.id;
  const roundId = useMemo(() => {
    const value = marketMetadata?.mapping?.roundId;
    if (!value) return null;
    try {
      return BigInt(value);
    } catch {
      return null;
    }
  }, [marketMetadata?.mapping?.roundId]);
  const isRoundResolved = roundSnapshot?.resolved ?? Boolean(marketMetadata?.mapping?.resolvedAt);
  const isRoundClosedByTime = roundSnapshot ? nowSec >= roundSnapshot.lockAt : false;
  const roundPending = chainModeRequested && roundId === null;
  const roundStatus = roundPending
    ? 'PENDING'
    : isRoundResolved
      ? 'RESOLVED'
      : isRoundClosedByTime
        ? 'LOCKED'
        : 'OPEN';
  const roundStatusClass = roundPending
    ? 'text-white/70 border-white/30'
    : isRoundResolved
      ? 'text-[#00FF41] border-[#00FF41]'
      : isRoundClosedByTime
        ? 'text-[#F7931A] border-[#F7931A]'
        : 'text-cyan-300 border-cyan-300';
  const lockCountdownLabel = roundSnapshot
    ? isRoundResolved
      ? 'RESOLVED'
      : isRoundClosedByTime
        ? 'LOCKED'
        : formatCountdown(Math.max(0, roundSnapshot.lockAt - nowSec))
    : roundPending
      ? 'PENDING'
      : '--:--';
  const lockAtLabel = roundSnapshot?.lockAt
    ? new Date(roundSnapshot.lockAt * 1000).toLocaleString()
    : '--';
  const winnerPlayer = marketMetadata?.winnerPlayerId
    ? state.players.find((player) => player.id === marketMetadata.winnerPlayerId) ?? null
    : null;
  const winnerName = winnerPlayer?.name ?? marketMetadata?.winnerPlayerId ?? '--';
  const winnerOutcomeLabel = marketMetadata?.mapping?.winnerOutcomeHash
    ? marketMetadata.mapping.winnerOutcomeHash
    : roundSnapshot?.winnerOutcome && roundSnapshot.winnerOutcome !== ZERO_HASH
      ? roundSnapshot.winnerOutcome
      : '--';
  const poolTotalEth = roundSnapshot ? formatEther(roundSnapshot.totalPool) : '0';
  const poolDistributableEth = roundSnapshot ? formatEther(roundSnapshot.distributablePool) : '0';
  const marketInfoMessage = !chainModeEnabled
    ? 'Chain market enabled but `VITE_MARKET_CONTRACT_ADDRESS` is missing/invalid.'
    : marketMetadataError ??
      roundStateError ??
      (marketMetadata?.mapping?.syncStatus === 'failed'
        ? `Round sync failed: ${marketMetadata.mapping.failureReason ?? 'unknown'}`
        : null) ??
      (marketMetadataLoading
        ? 'Loading market mapping...'
        : chainModeRequested && !marketMetadata?.mapping
          ? 'Round mapping unavailable. Check API market open logs and MARKET_* env.'
          : null);
  const marketTxMessage = txStatus
    ? `${txStatus}${txHash ? ` (${shortAddress(txHash)})` : ''}`
    : txError;
  const marketTxMessageClass = txStatus ? 'text-[#00FF41]' : txError ? 'text-red-400' : 'text-white/60';
  const chainTradeBlockReason = !chainModeRequested
    ? null
    : isSpectator
      ? 'SPECTATOR_MODE'
      : !gameId
        ? 'NO_ACTIVE_GAME'
        : !chainModeEnabled
          ? 'CHAIN_MARKET_DISABLED'
          : roundId === null
            ? 'ROUND_NOT_READY'
            : isRoundResolved
              ? 'ROUND_RESOLVED'
              : isRoundClosedByTime
                ? 'ROUND_LOCKED'
                : !isConnected
                  ? 'WALLET_NOT_CONNECTED'
                  : walletWrongNetwork
                    ? `WRONG_NETWORK_${chain?.id ?? 'UNKNOWN'}_EXPECT_${chainMarketConfig.chain.id}`
                    : writePending
                      ? 'TX_IN_PROGRESS'
                      : null;
  const chainTradeReady = chainTradeBlockReason === null;
  const tradeReadOnlyMessage = chainModeRequested
    ? toReadOnlyMessage(chainTradeBlockReason)
    : (localTradeReady ? 'BET_READY' : (onlineInteractionBlockedReason ?? 'READ_ONLY'));
  const buyLabel = chainModeRequested
    ? `BET ${formatEther(chainMarketConfig.defaultBetWei)} ETH`
    : 'BUY $100';
  const claimableLabel = claimableAmount > 0n ? `${formatEther(claimableAmount)} ETH` : '0 ETH';

  const loadMarketMetadata = useCallback(async () => {
    if (!chainModeRequested || !gameId) {
      setMarketMetadata(null);
      setMarketMetadataError(null);
      return;
    }
    setMarketMetadataLoading(true);
    try {
      const data = await fetchMarketByGameId(gameId);
      setMarketMetadata(data);
      setMarketMetadataError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to fetch market metadata.';
      setMarketMetadataError(message);
    } finally {
      setMarketMetadataLoading(false);
    }
  }, [chainModeRequested, gameId]);

  useEffect(() => {
    if (!chainModeRequested) return;
    void loadMarketMetadata();
    const timer = setInterval(() => {
      void loadMarketMetadata();
    }, 8_000);
    return () => clearInterval(timer);
  }, [chainModeRequested, loadMarketMetadata]);

  const refreshRoundState = useCallback(async () => {
    if (
      !chainModeEnabled ||
      !chainMarketConfig.contractAddress ||
      !publicClient ||
      roundId === null
    ) {
      setRoundSnapshot(null);
      setRoundStateError(null);
      return;
    }

    try {
      const roundData = await publicClient.readContract({
        address: chainMarketConfig.contractAddress,
        abi: predictionMarketAbi,
        functionName: 'rounds',
        args: [roundId]
      } as any);
      const parsed = parseRoundSnapshot(roundData);
      if (!parsed) {
        throw new Error('Failed to decode round state.');
      }
      setRoundSnapshot(parsed);
      setRoundStateError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh round state.';
      setRoundStateError(message);
    }
  }, [chainModeEnabled, publicClient, roundId]);

  const refreshClaimState = useCallback(async () => {
    if (
      !chainModeEnabled ||
      !chainMarketConfig.contractAddress ||
      !publicClient ||
      !address ||
      roundId === null
    ) {
      setClaimableAmount(0n);
      setAlreadyClaimed(false);
      return;
    }
    setClaimLoading(true);
    try {
      const [preview, claimed] = await Promise.all([
        publicClient.readContract({
          address: chainMarketConfig.contractAddress,
          abi: predictionMarketAbi,
          functionName: 'previewClaim',
          args: [roundId, address]
        } as any),
        publicClient.readContract({
          address: chainMarketConfig.contractAddress,
          abi: predictionMarketAbi,
          functionName: 'claimed',
          args: [roundId, address]
        } as any)
      ]);
      setClaimableAmount(BigInt(preview as string | number | bigint));
      setAlreadyClaimed(Boolean(claimed));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to refresh claim state.';
      setTxError(message);
    } finally {
      setClaimLoading(false);
    }
  }, [address, publicClient, roundId, chainModeEnabled]);

  useEffect(() => {
    void refreshClaimState();
  }, [refreshClaimState]);

  useEffect(() => {
    if (!chainModeRequested) return;
    const timer = setInterval(() => {
      void refreshClaimState();
    }, 8_000);
    return () => clearInterval(timer);
  }, [chainModeRequested, refreshClaimState]);

  useEffect(() => {
    if (!chainModeRequested) return;
    void refreshClaimState();
  }, [chainModeRequested, marketMetadata?.mapping?.resolvedAt, refreshClaimState]);

  useEffect(() => {
    if (!chainModeRequested) return;
    void refreshRoundState();
    const timer = setInterval(() => {
      void refreshRoundState();
    }, 8_000);
    return () => clearInterval(timer);
  }, [chainModeRequested, refreshRoundState]);

  useEffect(() => {
    if (!chainModeRequested) return;
    const timer = setInterval(() => {
      setNowSec(Math.floor(Date.now() / 1000));
    }, 1_000);
    return () => clearInterval(timer);
  }, [chainModeRequested]);

  const ensureWalletReady = useCallback(async (): Promise<string | null> => {
    if (!chainModeEnabled) return null;
    if (!chainMarketConfig.contractAddress) {
      setTxError('VITE_MARKET_CONTRACT_ADDRESS is missing or invalid.');
      return null;
    }
    if (!publicClient) {
      setTxError('RPC client is not ready.');
      return null;
    }

    let activeAccount = address ?? null;

    if (!isConnected) {
      const connector = pickPreferredConnector(connectors);
      if (!connector) {
        setTxError('No wallet connector available.');
        return null;
      }
      try {
        const connectResult = await connectAsync({ connector });
        activeAccount = connectResult.accounts[0] ?? null;
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to connect wallet.';
        setTxError(message);
        return null;
      }
    }

    if (chain?.id !== chainMarketConfig.chain.id) {
      try {
        await switchChainAsync({ chainId: chainMarketConfig.chain.id });
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to switch wallet network.';
        setTxError(message);
        return null;
      }
    }

    if (!activeAccount) {
      setTxError('Wallet account is unavailable.');
      return null;
    }

    return activeAccount;
  }, [
    address,
    chain?.id,
    connectAsync,
    connectors,
    isConnected,
    publicClient,
    switchChainAsync,
    chainModeEnabled
  ]);

  const handleBuy = async (playerId: string) => {
    if (!chainModeRequested) {
      if (!localTradeReady) return;
      dispatch({ type: 'MARKET_BUY', payload: { playerId, amount: 100 } });
      return;
    }

    if (!chainTradeReady) {
      setTxError(toReadOnlyMessage(chainTradeBlockReason));
      return;
    }

    if (!chainModeEnabled) {
      setTxError('Chain market is requested, but contract env config is invalid.');
      return;
    }

    if (roundId === null) {
      setTxError('Round is not available on-chain yet. Please retry in a moment.');
      await loadMarketMetadata();
      return;
    }

    const account = await ensureWalletReady();
    if (!account || !chainMarketConfig.contractAddress || !publicClient) return;

    setTxError(null);
    setTxHash(null);
    try {
      const estimatedGas = await publicClient.estimateContractGas({
        account: account as `0x${string}`,
        address: chainMarketConfig.contractAddress,
        abi: predictionMarketAbi,
        functionName: 'placeBet',
        args: [roundId, outcomeHashForPlayer(playerId)],
        value: chainMarketConfig.defaultBetWei
      });
      const gas = addGasBuffer(estimatedGas);

      setTxStatus(`Submitting bet for ${playerId}...`);
      const hash = await writeContractAsync({
        account: account as `0x${string}`,
        chain: chainMarketConfig.chain,
        address: chainMarketConfig.contractAddress,
        abi: predictionMarketAbi,
        functionName: 'placeBet',
        args: [roundId, outcomeHashForPlayer(playerId)],
        value: chainMarketConfig.defaultBetWei,
        gas
      });
      setTxHash(hash);
      setTxStatus('Bet submitted, waiting for confirmation...');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!isReceiptSuccess(receipt)) {
        throw new Error('Bet transaction reverted on-chain.');
      }
      setTxStatus('Bet confirmed on-chain.');
      await Promise.all([loadMarketMetadata(), refreshClaimState(), refreshRoundState()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'placeBet transaction failed.';
      setTxError(message);
      setTxStatus(null);
    }
  };

  const handleClaim = async () => {
    if (!chainModeEnabled) return;
    if (roundId === null || !chainMarketConfig.contractAddress || !publicClient) {
      setTxError('Cannot claim: missing round metadata.');
      return;
    }
    if (claimableAmount <= 0n || alreadyClaimed) {
      setTxError('No claimable amount for current wallet.');
      return;
    }

    const account = await ensureWalletReady();
    if (!account) return;

    setTxError(null);
    setTxHash(null);
    try {
      const estimatedGas = await publicClient.estimateContractGas({
        account: account as `0x${string}`,
        address: chainMarketConfig.contractAddress,
        abi: predictionMarketAbi,
        functionName: 'claim',
        args: [roundId]
      });
      const gas = addGasBuffer(estimatedGas);

      setTxStatus('Submitting claim transaction...');
      const hash = await writeContractAsync({
        account: account as `0x${string}`,
        chain: chainMarketConfig.chain,
        address: chainMarketConfig.contractAddress,
        abi: predictionMarketAbi,
        functionName: 'claim',
        args: [roundId],
        gas
      });
      setTxHash(hash);
      setTxStatus('Claim submitted, waiting for confirmation...');
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      if (!isReceiptSuccess(receipt)) {
        throw new Error('Claim transaction reverted on-chain.');
      }
      setTxStatus('Claim confirmed on-chain.');
      await Promise.all([refreshClaimState(), refreshRoundState()]);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'claim transaction failed.';
      setTxError(message);
      setTxStatus(null);
    }
  };

  const handleConnectWallet = async () => {
    const connector = pickPreferredConnector(connectors);
    if (!connector) {
      setTxError('No wallet connector available.');
      return;
    }
    try {
      await connectAsync({ connector });
      setTxError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect wallet.';
      setTxError(message);
    }
  };

  const handleSwitchNetwork = async () => {
    try {
      await switchChainAsync({ chainId: chainMarketConfig.chain.id });
      setTxError(null);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to switch network.';
      setTxError(message);
    }
  };

  const totalInvested = state.players.reduce((acc, p) => acc + (p.market.sharesOwned * p.market.price), 0);
  const isProfitable = (totalInvested + state.userBalance) > 1000;
  
  // 获取完整的日志用于展示大数据流
  const allLogs = [...state.log].reverse();

  return (
    <div className="fixed inset-0 bg-black/95 z-[600] flex flex-col p-4 animate-in slide-in-from-bottom duration-300 font-mono overflow-hidden">
      {/* 背景噪点 */}
      <div className="absolute inset-0 opacity-[0.03] pointer-events-none" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.65' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)'/%3E%3C/svg%3E")` }}></div>

      {/* 提示词查看弹窗 */}
      {selectedAi && (
        <div className="absolute inset-0 z-[700] bg-black/80 flex items-center justify-center p-10 animate-in fade-in duration-200" onClick={() => setSelectedAi(null)}>
           <div className="bg-[#111] border-2 border-[#00FF41] p-6 max-w-2xl w-full shadow-[0_0_50px_rgba(0,255,65,0.2)]" onClick={e => e.stopPropagation()}>
              <h3 className="text-[#00FF41] text-xl font-black mb-4 uppercase">Neural Protocol // {selectedAi.name}</h3>
              <div className="bg-black p-4 border border-white/10 font-mono text-sm text-white/80 leading-relaxed whitespace-pre-wrap">
                 {state.aiConfig?.systemPrompt || "NO PROTOCOL DATA AVAILABLE."}
              </div>
              <button onClick={() => setSelectedAi(null)} className="mt-6 w-full bg-[#00FF41] text-black font-black py-3 uppercase hover:bg-white">Close Protocol Viewer</button>
           </div>
        </div>
      )}

      {/* 顶部状态栏 */}
      <div className="flex-none border-b-4 border-white pb-2 mb-4 flex justify-between items-end relative z-10">
        <div>
          <h1 className="text-3xl font-black italic text-[#00FF41] leading-none uppercase tracking-tighter text-glow">
            NEON_MARKET <span className="text-white text-sm not-italic opacity-50 ml-2">v2.0-PRO</span>
          </h1>
          <div className="flex gap-4 mt-1 text-[10px] font-bold uppercase tracking-widest text-white/60">
             <span>CYCLE: {state.turnCount}</span>
             <span>ALIVE: {aliveCount}/8</span>
          </div>
          {tradeReadOnlyMessage !== 'BET_READY' && (
            <div className="mt-2 inline-block border border-[#F7931A]/60 bg-[#F7931A]/10 px-2 py-1 text-[10px] font-black uppercase tracking-[0.15em] text-[#F7931A]">
              {tradeReadOnlyMessage}
            </div>
          )}
          {chainModeRequested && (
            <div className="mt-2 space-y-2 min-h-[132px]">
              <div className="flex flex-wrap gap-2 text-[10px] font-black uppercase tracking-[0.15em] text-white/70">
                <span className="border border-white/20 px-2 py-1">CHAIN {chainMarketConfig.chain.id}</span>
                <span className="border border-white/20 px-2 py-1">WALLET_CHAIN {chain?.id ?? '--'}</span>
                <span className="border border-white/20 px-2 py-1">
                  ROUND {roundId?.toString() ?? '--'}
                </span>
                <span className="border border-white/20 px-2 py-1">WALLET {shortAddress(address)}</span>
                <span className="border border-white/20 px-2 py-1">CONNECTOR {connector?.name ?? '--'}</span>
                <span className={`border px-2 py-1 ${roundStatusClass}`}>STATUS {roundStatus}</span>
                <span className="border border-white/20 px-2 py-1">LOCK IN {lockCountdownLabel}</span>
              </div>
              <div className="text-[10px] text-white/50 uppercase font-bold tracking-[0.12em]">
                LOCK_AT {lockAtLabel}
              </div>
              <div className="text-[10px] text-white/50 uppercase font-bold tracking-[0.12em]">
                WINNER {winnerName}
              </div>
              <div className="text-[10px] text-white/50 uppercase font-bold tracking-[0.12em]">
                WINNER_OUTCOME{' '}
                <span className="inline-block max-w-[420px] align-bottom truncate" title={winnerOutcomeLabel}>
                  {winnerOutcomeLabel}
                </span>
              </div>
              <div className="text-[10px] text-white/50 uppercase font-bold tracking-[0.12em]">
                POOL {poolTotalEth} ETH / DISTRIBUTABLE {poolDistributableEth} ETH
              </div>
              <div
                className={`min-h-[14px] text-[10px] uppercase font-bold ${
                  marketInfoMessage ? 'text-red-400' : 'text-white/60'
                }`}
              >
                {marketInfoMessage ?? <span className="opacity-0">placeholder</span>}
              </div>
              <div className={`min-h-[14px] text-[10px] uppercase font-bold ${marketTxMessageClass}`}>
                {marketTxMessage ?? <span className="opacity-0">placeholder</span>}
              </div>
            </div>
          )}
        </div>
        
        <div className="w-1/3 flex flex-col gap-2">
           <div className="flex justify-between text-[10px] font-black uppercase">
             <span>Protocol Progress</span>
             <span>{progress.toFixed(0)}%</span>
           </div>
           <div className="h-2 bg-gray-900 border border-white/30 relative">
              <div className="absolute inset-y-0 left-0 bg-[#F7931A]" style={{ width: `${progress}%` }}></div>
           </div>
           {chainModeRequested && (
             <div className="flex justify-end gap-2 mt-1">
               {!isConnected && (
                 <button
                   disabled={connectPending}
                   onClick={() => {
                     void handleConnectWallet();
                   }}
                   className="border border-[#00FF41] px-3 py-1 text-[10px] font-black uppercase text-[#00FF41] hover:bg-[#00FF41] hover:text-black disabled:opacity-40"
                 >
                   {connectPending ? 'CONNECTING...' : 'CONNECT WALLET'}
                 </button>
               )}
               {isConnected && walletWrongNetwork && (
                 <button
                   disabled={switchPending}
                   onClick={() => {
                     void handleSwitchNetwork();
                   }}
                   className="border border-[#F7931A] px-3 py-1 text-[10px] font-black uppercase text-[#F7931A] hover:bg-[#F7931A] hover:text-black disabled:opacity-40"
                 >
                   {switchPending ? 'SWITCHING...' : `SWITCH ${chainMarketConfig.chain.id}`}
                 </button>
               )}
             </div>
           )}
        </div>

        <button onClick={onClose} className="border border-white px-4 py-1 hover:bg-white hover:text-black font-black uppercase text-xs transition-all">
          [ESC] EXIT
        </button>
      </div>

      {/* 主内容区 - 50/50 分割 */}
      <div className="flex-1 flex gap-4 min-h-0 relative z-10">
        
        {/* 左侧 (50%): 图表 + AI 网格 */}
        <div className="w-1/2 flex flex-col gap-4">
           {/* 图表区域 (约 25% 高度) */}
           <div className="h-1/4 min-h-[120px]">
              <PriceChart players={state.players} />
           </div>

           {/* AI 网格 (剩余高度) */}
           <div className="flex-1 bg-[#0a0a0a] border border-white/10 p-2 overflow-y-auto">
              <div className="grid grid-cols-2 gap-2">
                 {state.players.map(p => (
                   <MarketCardCompact
                     key={p.id}
                     player={p}
                     canTrade={chainModeRequested ? chainTradeReady : localTradeReady}
                     buyLabel={buyLabel}
                     readOnlyReason={tradeReadOnlyMessage}
                     onBuy={(playerId) => {
                       void handleBuy(playerId);
                     }}
                     onShowPrompt={setSelectedAi}
                   />
                 ))}
              </div>
           </div>
        </div>

        {/* 右侧 (50%): 资产 + 大数据流 */}
        <div className="w-1/2 flex flex-col gap-4">
           {/* 资产概览 */}
           <div className="bg-[#0a0a0a] border-2 border-white/20 p-3 flex justify-between items-end gap-4">
              <div>
                 <div className="text-[10px] text-white/50 uppercase font-black">Portfolio Value</div>
                 <div className={`text-2xl font-black ${isProfitable ? 'text-[#00FF41]' : 'text-[#F7931A]'}`}>
                    ${(totalInvested + state.userBalance).toFixed(0)}
                 </div>
              </div>
              <div className="text-right">
                 <div className="text-[10px] text-white/50 uppercase font-black">Cash Available</div>
                 <div className="text-xl font-black text-white">${state.userBalance.toFixed(0)}</div>
              </div>
              {chainModeRequested && (
                <div className="text-right">
                  <div className="text-[10px] text-white/50 uppercase font-black">Claimable</div>
                  <div className="text-base font-black text-[#00FF41]">{claimableLabel}</div>
                  <button
                    disabled={
                      !chainModeEnabled ||
                      roundId === null ||
                      !isConnected ||
                      walletWrongNetwork ||
                      claimLoading ||
                      writePending ||
                      claimableAmount <= 0n ||
                      alreadyClaimed
                    }
                    onClick={() => {
                      void handleClaim();
                    }}
                    className="mt-2 border border-[#00FF41] px-3 py-1 text-[10px] font-black uppercase text-[#00FF41] hover:bg-[#00FF41] hover:text-black disabled:opacity-40"
                  >
                    {alreadyClaimed
                      ? 'CLAIMED'
                      : claimLoading || writePending
                        ? 'PROCESSING...'
                        : 'CLAIM'}
                  </button>
                </div>
              )}
           </div>

           {/* 实时数据流 (占满剩余空间 - 占据半个屏幕视觉重心) */}
           <div className="flex-1 bg-black border-2 border-[#F7931A]/30 p-4 overflow-hidden flex flex-col shadow-[inset_0_0_20px_rgba(0,0,0,0.8)] relative">
              <div className="absolute top-0 left-0 right-0 bg-[#F7931A]/10 border-b border-[#F7931A]/30 p-1 px-2 flex justify-between items-center z-10 backdrop-blur-sm">
                 <span className="text-[10px] uppercase font-black text-[#F7931A] animate-pulse">&gt;&gt; LIVE_DATA_STREAM_FEED</span>
                 <span className="text-[9px] text-[#F7931A]/70">RECEIVING...</span>
              </div>
              <div className="flex-1 overflow-y-auto pt-8 space-y-1.5 custom-scrollbar">
                 {allLogs.map((log, i) => (
                   <div key={i} className="text-[11px] font-mono leading-tight border-l-2 border-[#F7931A]/20 pl-2 text-white/80 hover:text-white hover:border-[#F7931A] transition-colors">
                     <span className="opacity-30 mr-2 text-[9px]">{new Date().toLocaleTimeString()}</span>
                     {log}
                   </div>
                 ))}
              </div>
           </div>
        </div>

      </div>
    </div>
  );
};
