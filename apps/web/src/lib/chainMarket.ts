import { createConfig, http } from 'wagmi';
import { injected, metaMask } from 'wagmi/connectors';
import { foundry, sepolia } from 'wagmi/chains';
import { type Address, defineChain, keccak256, stringToHex } from 'viem';

const resolveApiBase = (): string =>
  (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const resolveChainId = (): number => {
  const raw = import.meta.env.VITE_MARKET_CHAIN_ID;
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : sepolia.id;
};

const resolveContractAddress = (): Address | null => {
  const raw = import.meta.env.VITE_MARKET_CONTRACT_ADDRESS?.trim();
  if (!raw) return null;
  if (!/^0x[a-fA-F0-9]{40}$/.test(raw)) return null;
  return raw as Address;
};

const resolveDefaultBetWei = (): bigint => {
  const raw = import.meta.env.VITE_MARKET_BET_WEI_DEFAULT?.trim();
  if (!raw) return 1_000_000_000_000_000n; // 0.001 ETH
  try {
    const parsed = BigInt(raw);
    if (parsed <= 0n) return 1_000_000_000_000_000n;
    return parsed;
  } catch {
    return 1_000_000_000_000_000n;
  }
};

const resolveChainRpc = (chainId: number): string => {
  const configured = import.meta.env.VITE_MARKET_RPC_URL?.trim();
  if (configured) return configured;
  if (chainId === foundry.id) return 'http://127.0.0.1:8545';
  if (chainId === sepolia.id) return 'https://rpc.sepolia.org';
  return 'http://127.0.0.1:8545';
};

const resolveChain = (chainId: number, rpcUrl: string) => {
  if (chainId === sepolia.id) return sepolia;
  if (chainId === foundry.id) return foundry;
  return defineChain({
    id: chainId,
    name: `Custom ${chainId}`,
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: {
      default: { http: [rpcUrl] }
    }
  });
};

const chainId = resolveChainId();
const marketRpcUrl = resolveChainRpc(chainId);
const marketChain = resolveChain(chainId, marketRpcUrl);
const marketContractAddress = resolveContractAddress();

export const chainMarketConfig = {
  requested: import.meta.env.VITE_CHAIN_MARKET_ENABLED === 'true',
  enabled:
    import.meta.env.VITE_CHAIN_MARKET_ENABLED === 'true' && marketContractAddress !== null,
  apiBase: resolveApiBase(),
  chainId,
  rpcUrl: marketRpcUrl,
  chain: marketChain,
  contractAddress: marketContractAddress,
  defaultBetWei: resolveDefaultBetWei()
} as const;

export const predictionMarketAbi = [
  { type: 'error', name: 'Unauthorized', inputs: [] },
  { type: 'error', name: 'InvalidRound', inputs: [] },
  { type: 'error', name: 'InvalidGameId', inputs: [] },
  { type: 'error', name: 'InvalidOutcome', inputs: [] },
  { type: 'error', name: 'InvalidLockTime', inputs: [] },
  { type: 'error', name: 'InvalidAddress', inputs: [] },
  { type: 'error', name: 'InvalidAmount', inputs: [] },
  { type: 'error', name: 'RoundAlreadyOpened', inputs: [] },
  { type: 'error', name: 'RoundClosed', inputs: [] },
  { type: 'error', name: 'RoundNotClosed', inputs: [] },
  { type: 'error', name: 'RoundAlreadyResolved', inputs: [] },
  { type: 'error', name: 'RoundNotResolved', inputs: [] },
  { type: 'error', name: 'AlreadyClaimed', inputs: [] },
  { type: 'error', name: 'NothingToClaim', inputs: [] },
  { type: 'error', name: 'TransferFailed', inputs: [] },
  { type: 'error', name: 'ReentrancyGuard', inputs: [] },
  {
    type: 'function',
    name: 'placeBet',
    stateMutability: 'payable',
    inputs: [
      { name: 'roundId', type: 'uint256' },
      { name: 'outcome', type: 'bytes32' }
    ],
    outputs: []
  },
  {
    type: 'function',
    name: 'claim',
    stateMutability: 'nonpayable',
    inputs: [{ name: 'roundId', type: 'uint256' }],
    outputs: [{ name: 'payout', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'previewClaim',
    stateMutability: 'view',
    inputs: [
      { name: 'roundId', type: 'uint256' },
      { name: 'user', type: 'address' }
    ],
    outputs: [{ name: '', type: 'uint256' }]
  },
  {
    type: 'function',
    name: 'claimed',
    stateMutability: 'view',
    inputs: [
      { name: 'roundId', type: 'uint256' },
      { name: 'user', type: 'address' }
    ],
    outputs: [{ name: '', type: 'bool' }]
  },
  {
    type: 'function',
    name: 'rounds',
    stateMutability: 'view',
    inputs: [{ name: 'roundId', type: 'uint256' }],
    outputs: [
      { name: 'gameIdHash', type: 'bytes32' },
      { name: 'lockAt', type: 'uint64' },
      { name: 'resolvedAt', type: 'uint64' },
      { name: 'winnerOutcome', type: 'bytes32' },
      { name: 'totalPool', type: 'uint256' },
      { name: 'distributablePool', type: 'uint256' },
      { name: 'winnerPool', type: 'uint256' },
      { name: 'resolved', type: 'bool' }
    ]
  }
] as const;

export interface GameRoundMapping {
  gameId: string;
  gameIdHash: string;
  roundId: string;
  marketAddress: string;
  chainId: number | null;
  openTxHash: string | null;
  resolveTxHash: string | null;
  winnerOutcomeHash: string | null;
  resolvedAt: string | null;
  syncStatus?: 'open' | 'resolved' | 'failed';
  failureReason?: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GameMarketResponse {
  gameId: string;
  gameStatus: string;
  gameSeq: number;
  winnerPlayerId: string | null;
  mapping: GameRoundMapping | null;
}

export const outcomeHashForPlayer = (playerId: string) => keccak256(stringToHex(playerId));

export async function fetchMarketByGameId(gameId: string): Promise<GameMarketResponse> {
  const response = await fetch(`${chainMarketConfig.apiBase}/api/markets/${encodeURIComponent(gameId)}`);
  if (!response.ok) {
    throw new Error(`Failed to fetch market metadata: ${response.status}`);
  }
  return (await response.json()) as GameMarketResponse;
}

export const wagmiConfig = createConfig({
  chains: [chainMarketConfig.chain],
  connectors: [metaMask(), injected()],
  transports: {
    [chainMarketConfig.chain.id]: http(chainMarketConfig.rpcUrl)
  }
});
