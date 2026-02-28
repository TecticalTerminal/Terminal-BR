import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useGame } from '../context/GameContext';

interface A2AMarketProps {
  onClose: () => void;
}

interface AgentApiProfile {
  displayName: string;
}

interface AgentApiWallet {
  address: string;
}

interface AgentApiItem {
  id: string;
  kind: 'user' | 'bot';
  status: 'active' | 'dead' | 'respawning';
  accountIdentifier: string;
  wallet: AgentApiWallet | null;
  profile: AgentApiProfile | null;
  persistentAssets: {
    currency: Record<string, string>;
  };
}

type ListingStatus = 'open' | 'filled' | 'cancelled' | 'expired';

interface ListingView {
  id: string;
  sellerAgentId: string;
  assetId: string;
  assetType: 'equipment';
  quantity: number;
  unitPrice: string;
  feeBps: number;
  status: ListingStatus;
  expiresAt: string | null;
  closedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TradeView {
  id: string;
  listingId: string;
  buyerAgentId: string;
  sellerAgentId: string;
  assetId: string;
  quantity: number;
  unitPrice: string;
  grossAmount: string;
  feeAmount: string;
  netAmount: string;
  status: 'settled' | 'reverted';
  txRef: string | null;
  settledAt: string;
  createdAt: string;
}

interface AgentBehaviorEvent {
  id: string;
  agentId: string | null;
  gameId: string | null;
  eventSource: 'game_action' | 'lifecycle' | 'market' | 'system';
  eventType: string;
  eventStatus: 'created' | 'accepted' | 'applied' | 'completed' | 'failed' | 'skipped';
  refType: string | null;
  refId: string | null;
  payload: Record<string, unknown>;
  createdAt: string;
}

interface AutoTradeStep {
  step: string;
  status: 'ok' | 'skipped' | 'failed';
  detail: Record<string, unknown>;
}

interface AutoTradeOneShotResult {
  runId: string;
  clientRunId: string | null;
  idempotent: boolean;
  sellerAgentId: string;
  buyerAgentId: string;
  gameId: string | null;
  assetId: string;
  quantity: number;
  unitPrice: string;
  feeBps: number;
  maxBuyUnitPrice: string;
  autoSeed: boolean;
  listing: ListingView;
  trade: TradeView;
  steps: AutoTradeStep[];
}

interface AutoTradeCreditDelta {
  buyerBefore: string;
  buyerAfter: string;
  sellerBefore: string;
  sellerAfter: string;
}

const resolveApiBase = (): string =>
  (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');

const MARKET_EVENT_TYPES = new Set([
  'auto_trade_started',
  'auto_trade_listed',
  'auto_trade_bought',
  'auto_trade_failed',
  'listing_created',
  'listing_cancelled',
  'trade_bought',
  'trade_sold'
]);

const shortId = (value: string, head = 6, tail = 4): string => {
  if (value.length <= head + tail + 3) return value;
  return `${value.slice(0, head)}...${value.slice(-tail)}`;
};

const parseApiError = async (response: Response): Promise<string> => {
  try {
    const data = await response.json();
    if (typeof data?.error === 'string' && data.error.trim()) {
      return data.error.trim();
    }
  } catch {
    // ignore
  }
  return `HTTP_${response.status}`;
};

const toNonNegativeInt = (value: string): number | null => {
  if (!/^\d+$/.test(value)) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : null;
};

export const A2AMarket: React.FC<A2AMarketProps> = ({ onClose }) => {
  const { gameId } = useGame();
  const apiBase = useMemo(resolveApiBase, []);

  const [agents, setAgents] = useState<AgentApiItem[]>([]);
  const [listings, setListings] = useState<ListingView[]>([]);
  const [trades, setTrades] = useState<TradeView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);

  const [statusFilter, setStatusFilter] = useState<'all' | ListingStatus>('all');
  const [buyerAgentId, setBuyerAgentId] = useState('');

  const [sellerAgentId, setSellerAgentId] = useState('');
  const [assetId, setAssetId] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [unitPrice, setUnitPrice] = useState('10');
  const [feeBps, setFeeBps] = useState('250');
  const [expiresInSeconds, setExpiresInSeconds] = useState('3600');
  const [autoMaxBuyUnitPrice, setAutoMaxBuyUnitPrice] = useState('150');
  const [autoClientRunId, setAutoClientRunId] = useState('');
  const [autoSeed, setAutoSeed] = useState(true);
  const [lastAutoResult, setLastAutoResult] = useState<AutoTradeOneShotResult | null>(null);
  const [lastAutoCredits, setLastAutoCredits] = useState<AutoTradeCreditDelta | null>(null);
  const [marketEvents, setMarketEvents] = useState<AgentBehaviorEvent[]>([]);
  const processStreamRef = useRef<HTMLDivElement | null>(null);
  const lastStreamTailEventIdRef = useRef<string | null>(null);

  const activeAgents = useMemo(
    () => agents.filter((agent) => agent.status === 'active'),
    [agents]
  );

  const agentById = useMemo(() => {
    return new Map(agents.map((agent) => [agent.id, agent]));
  }, [agents]);

  const fetchAgents = useCallback(async () => {
    const response = await fetch(`${apiBase}/api/agents?status=active`);
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    const data = await response.json();
    return (Array.isArray(data?.items) ? data.items : []) as AgentApiItem[];
  }, [apiBase]);

  const fetchListings = useCallback(async () => {
    const query = new URLSearchParams();
    if (statusFilter !== 'all') {
      query.set('status', statusFilter);
    }
    query.set('limit', '100');
    query.set('offset', '0');
    const response = await fetch(`${apiBase}/api/a2a-market/listings?${query.toString()}`);
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    const data = await response.json();
    return (Array.isArray(data?.items) ? data.items : []) as ListingView[];
  }, [apiBase, statusFilter]);

  const fetchTrades = useCallback(async () => {
    const query = new URLSearchParams();
    query.set('limit', '100');
    query.set('offset', '0');
    const response = await fetch(`${apiBase}/api/a2a-market/trades?${query.toString()}`);
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    const data = await response.json();
    return (Array.isArray(data?.items) ? data.items : []) as TradeView[];
  }, [apiBase]);

  const fetchMarketEvents = useCallback(async () => {
    const query = new URLSearchParams();
    query.set('eventSource', 'market');
    query.set('limit', '80');
    query.set('offset', '0');
    const response = await fetch(`${apiBase}/api/audit/agent-behaviors?${query.toString()}`);
    if (!response.ok) {
      throw new Error(await parseApiError(response));
    }
    const data = await response.json();
    const items = (Array.isArray(data?.items) ? data.items : []) as AgentBehaviorEvent[];
    return items
      .filter((item) => MARKET_EVENT_TYPES.has(item.eventType))
      .slice(0, 40)
      .reverse();
  }, [apiBase]);

  const refreshData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agentItems, listingItems, tradeItems] = await Promise.all([
        fetchAgents(),
        fetchListings(),
        fetchTrades()
      ]);
      setAgents(agentItems);
      setListings(listingItems);
      setTrades(tradeItems);
      return { agentItems, listingItems, tradeItems };
    } catch (err) {
      setError(err instanceof Error ? err.message : 'A2A_MARKET_REFRESH_FAILED');
      return null;
    } finally {
      setLoading(false);
    }
  }, [fetchAgents, fetchListings, fetchTrades]);

  useEffect(() => {
    let cancelled = false;

    const sync = async () => {
      try {
        const items = await fetchMarketEvents();
        if (!cancelled) {
          setMarketEvents(items);
        }
      } catch {
        // ignore event stream errors to avoid interrupting market operations
      }
    };

    void sync();
    const timer = setInterval(() => {
      void sync();
    }, 2500);

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [fetchMarketEvents]);

  useEffect(() => {
    void refreshData();
  }, [refreshData]);

  useEffect(() => {
    if (sellerAgentId) return;
    const botCandidates = activeAgents.filter((agent) => agent.kind === 'bot');
    const firstSeller = botCandidates[0] ?? activeAgents[0];
    if (!firstSeller) return;
    setSellerAgentId(firstSeller.id);
    const firstBuyer =
      botCandidates.find((agent) => agent.id !== firstSeller.id) ??
      activeAgents.find((agent) => agent.id !== firstSeller.id);
    setBuyerAgentId(firstBuyer?.id ?? firstSeller.id);
  }, [activeAgents, sellerAgentId]);

  const selectedBuyer = buyerAgentId ? agentById.get(buyerAgentId) : null;
  const selectedSeller = sellerAgentId ? agentById.get(sellerAgentId) : null;

  const createListing = async () => {
    setError(null);
    setNotice(null);

    if (!sellerAgentId) {
      setError('sellerAgentId is required.');
      return;
    }
    const cleanedAssetId = assetId.trim();
    if (!cleanedAssetId) {
      setError('assetId is required.');
      return;
    }
    const quantityInt = toNonNegativeInt(quantity);
    if (!quantityInt || quantityInt <= 0) {
      setError('quantity must be a positive integer.');
      return;
    }
    if (!/^\d+$/.test(unitPrice) || unitPrice === '0') {
      setError('unitPrice must be an unsigned integer string > 0.');
      return;
    }

    const feeInt = feeBps.trim() ? toNonNegativeInt(feeBps) : null;
    if (feeBps.trim() && (feeInt === null || feeInt < 0 || feeInt > 10_000)) {
      setError('feeBps must be in [0, 10000].');
      return;
    }

    const expiresInt = expiresInSeconds.trim() ? toNonNegativeInt(expiresInSeconds) : null;
    if (expiresInSeconds.trim() && (!expiresInt || expiresInt <= 0)) {
      setError('expiresInSeconds must be a positive integer.');
      return;
    }

    const payload: Record<string, unknown> = {
      sellerAgentId,
      assetId: cleanedAssetId,
      quantity: quantityInt,
      unitPrice
    };
    if (feeInt !== null) payload.feeBps = feeInt;
    if (expiresInt !== null) payload.expiresInSeconds = expiresInt;
    if (gameId) payload.gameId = gameId;

    setBusyAction('create');
    try {
      const response = await fetch(`${apiBase}/api/a2a-market/listings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const created = (await response.json()) as ListingView;
      setNotice(`LISTING_CREATED ${shortId(created.id)} asset=${created.assetId}`);
      await refreshData();
      setAssetId('');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'LISTING_CREATE_FAILED');
    } finally {
      setBusyAction(null);
    }
  };

  const cancelListing = async (listing: ListingView) => {
    setError(null);
    setNotice(null);
    setBusyAction(`cancel:${listing.id}`);
    try {
      const response = await fetch(`${apiBase}/api/a2a-market/listings/${listing.id}/cancel`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          requesterAgentId: listing.sellerAgentId,
          gameId: gameId ?? null
        })
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      setNotice(`LISTING_CANCELLED ${shortId(listing.id)}`);
      await refreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'LISTING_CANCEL_FAILED');
    } finally {
      setBusyAction(null);
    }
  };

  const buyListing = async (listing: ListingView) => {
    setError(null);
    setNotice(null);

    if (!buyerAgentId) {
      setError('buyerAgentId is required.');
      return;
    }
    if (buyerAgentId === listing.sellerAgentId) {
      setError('Buyer cannot be seller.');
      return;
    }

    setBusyAction(`buy:${listing.id}`);
    try {
      const response = await fetch(`${apiBase}/api/a2a-market/listings/${listing.id}/buy`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          buyerAgentId,
          gameId: gameId ?? null
        })
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const result = (await response.json()) as { listing: ListingView; trade: TradeView };
      setNotice(`TRADE_SETTLED ${shortId(result.trade.id)} gross=${result.trade.grossAmount}`);
      await refreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'LISTING_BUY_FAILED');
    } finally {
      setBusyAction(null);
    }
  };

  const expireListings = async () => {
    setError(null);
    setNotice(null);
    setBusyAction('expire');
    try {
      const response = await fetch(`${apiBase}/api/a2a-market/expire`, {
        method: 'POST'
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const result = (await response.json()) as { expiredCount?: number };
      setNotice(`EXPIRE_DONE count=${result.expiredCount ?? 0}`);
      await refreshData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'EXPIRE_FAILED');
    } finally {
      setBusyAction(null);
    }
  };

  const runAutoTrade = async () => {
    setError(null);
    setNotice(null);

    const payload: Record<string, unknown> = {
      autoSeed
    };

    const trimmedClientRunId = autoClientRunId.trim();
    const effectiveClientRunId = trimmedClientRunId || `web-auto-${Date.now()}`;
    payload.clientRunId = effectiveClientRunId;
    if (!trimmedClientRunId) {
      setAutoClientRunId(effectiveClientRunId);
    }
    if (sellerAgentId) payload.sellerAgentId = sellerAgentId;
    if (buyerAgentId && buyerAgentId !== sellerAgentId) payload.buyerAgentId = buyerAgentId;
    if (gameId) payload.gameId = gameId;

    const cleanedAssetId = assetId.trim();
    if (cleanedAssetId) payload.assetId = cleanedAssetId;

    const quantityInt = toNonNegativeInt(quantity);
    if (quantity.trim()) {
      if (!quantityInt || quantityInt <= 0) {
        setError('quantity must be a positive integer.');
        return;
      }
      payload.quantity = quantityInt;
    }

    const cleanedUnitPrice = unitPrice.trim();
    if (cleanedUnitPrice) {
      if (!/^\d+$/.test(cleanedUnitPrice) || cleanedUnitPrice === '0') {
        setError('unitPrice must be an unsigned integer string > 0.');
        return;
      }
      payload.unitPrice = cleanedUnitPrice;
    }

    const cleanedFeeBps = feeBps.trim();
    if (cleanedFeeBps) {
      const feeInt = toNonNegativeInt(cleanedFeeBps);
      if (feeInt === null || feeInt < 0 || feeInt > 10_000) {
        setError('feeBps must be in [0, 10000].');
        return;
      }
      payload.feeBps = feeInt;
    }

    const cleanedMaxBuyUnitPrice = autoMaxBuyUnitPrice.trim();
    if (cleanedMaxBuyUnitPrice) {
      if (!/^\d+$/.test(cleanedMaxBuyUnitPrice)) {
        setError('maxBuyUnitPrice must be an unsigned integer string.');
        return;
      }
      payload.maxBuyUnitPrice = cleanedMaxBuyUnitPrice;
    }

    const beforeCreditsByAgentId = new Map(
      agents.map((agent) => [agent.id, agent.persistentAssets.currency.credits ?? '0'])
    );

    setBusyAction('auto:one-shot');
    try {
      const response = await fetch(`${apiBase}/api/a2a-market/auto/one-shot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!response.ok) {
        throw new Error(await parseApiError(response));
      }
      const result = (await response.json()) as AutoTradeOneShotResult;
      setLastAutoResult(result);
      setSellerAgentId(result.sellerAgentId);
      setBuyerAgentId(result.buyerAgentId);

      const refreshed = await refreshData();
      const afterCreditsByAgentId = new Map(
        (refreshed?.agentItems ?? []).map((agent) => [
          agent.id,
          agent.persistentAssets.currency.credits ?? '0'
        ])
      );
      setLastAutoCredits({
        buyerBefore: beforeCreditsByAgentId.get(result.buyerAgentId) ?? '0',
        buyerAfter: afterCreditsByAgentId.get(result.buyerAgentId) ?? '0',
        sellerBefore: beforeCreditsByAgentId.get(result.sellerAgentId) ?? '0',
        sellerAfter: afterCreditsByAgentId.get(result.sellerAgentId) ?? '0'
      });

      setNotice(
        `AUTO_TRADE_${result.idempotent ? 'IDEMPOTENT' : 'COMPLETED'} run=${shortId(result.runId, 8, 6)} trade=${shortId(result.trade.id, 8, 6)}`
      );
      const events = await fetchMarketEvents();
      setMarketEvents(events);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'AUTO_TRADE_FAILED');
    } finally {
      setBusyAction(null);
    }
  };

  const visibleMarketEvents = useMemo(() => {
    return marketEvents
      .filter((event) => {
        if (!lastAutoResult) return true;
        if (event.refType === 'auto_trade_run' && event.refId === lastAutoResult.runId) return true;
        if (
          event.agentId &&
          (event.agentId === lastAutoResult.sellerAgentId || event.agentId === lastAutoResult.buyerAgentId)
        ) {
          return true;
        }
        return false;
      })
      .slice(0, 24);
  }, [lastAutoResult, marketEvents]);

  useEffect(() => {
    const tailEventId = visibleMarketEvents.length
      ? visibleMarketEvents[visibleMarketEvents.length - 1]?.id ?? null
      : null;
    if (!tailEventId) return;

    const hasNewEvent = tailEventId !== lastStreamTailEventIdRef.current;
    lastStreamTailEventIdRef.current = tailEventId;
    if (!hasNewEvent) return;

    const container = processStreamRef.current;
    if (!container) return;
    container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' });
  }, [visibleMarketEvents]);

  const formatEventLabel = (event: AgentBehaviorEvent): string => {
    const actor =
      event.agentId && agentById.get(event.agentId)?.profile?.displayName
        ? agentById.get(event.agentId)?.profile?.displayName
        : event.agentId
          ? shortId(event.agentId, 6, 4)
          : 'system';

    const detailKeys = [
      'assetId',
      'quantity',
      'unitPrice',
      'maxBuyUnitPrice',
      'listingId',
      'tradeId',
      'grossAmount',
      'feeAmount',
      'netAmount',
      'reason'
    ] as const;

    const detail = detailKeys
      .map((key) => {
        const value = event.payload?.[key];
        if (value === undefined || value === null || value === '') return null;
        return `${key}=${String(value)}`;
      })
      .filter((item): item is string => Boolean(item))
      .join(' ');

    const base = `${event.eventType.toUpperCase()} [${event.eventStatus}] by ${actor}`;
    return detail ? `${base} | ${detail}` : base;
  };

  return (
    <div className="fixed inset-0 bg-black/95 z-[520] flex flex-col font-mono animate-in fade-in duration-300">
      <div className="flex-none border-b-4 border-[#00FF41] bg-black px-8 py-6">
        <div className="max-w-7xl mx-auto flex items-start justify-between gap-6">
          <div>
            <h2 className="text-4xl font-black italic text-[#00FF41] tracking-tighter leading-none">
              A2A_MARKET // FIXED_PRICE
            </h2>
            <p className="mt-2 text-[11px] uppercase tracking-[0.18em] opacity-60">
              list | buy | cancel | trade-log (closed currency)
            </p>
            <p className="mt-2 text-[10px] uppercase opacity-50 break-all">
              game: {gameId ?? 'none'} | buyer credits: {selectedBuyer?.persistentAssets.currency.credits ?? '0'} | seller credits:{' '}
              {selectedSeller?.persistentAssets.currency.credits ?? '0'}
            </p>
          </div>
          <div className="flex gap-3">
            <button
              onClick={() => {
                void refreshData();
              }}
              disabled={loading || !!busyAction}
              className="border-2 border-white/60 text-white px-4 py-2 text-xs font-black uppercase hover:bg-white hover:text-black transition-all disabled:opacity-40"
            >
              {loading ? 'REFRESHING...' : 'REFRESH'}
            </button>
            <button
              onClick={onClose}
              className="border-2 border-[#F7931A] text-[#F7931A] px-4 py-2 text-xs font-black uppercase hover:bg-[#F7931A] hover:text-black transition-all"
            >
              CLOSE
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto custom-scrollbar bg-[#050505] p-8">
        <div className="max-w-7xl mx-auto grid grid-cols-1 xl:grid-cols-3 gap-6">
          <section className="xl:col-span-1 border-4 border-[#00FF41]/70 bg-[#00FF41]/5 p-5">
            <h3 className="text-lg font-black uppercase tracking-wider text-[#00FF41]">Create Listing</h3>
            <div className="mt-4 space-y-3">
              <label className="block">
                <span className="text-[10px] uppercase opacity-60">seller agent</span>
                <select
                  value={sellerAgentId}
                  onChange={(event) => setSellerAgentId(event.target.value)}
                  className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                >
                  <option value="">SELECT_SELLER</option>
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {(agent.profile?.displayName ?? shortId(agent.id, 8, 4)).toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>

              <label className="block">
                <span className="text-[10px] uppercase opacity-60">asset id (equipment)</span>
                <input
                  value={assetId}
                  onChange={(event) => setAssetId(event.target.value)}
                  placeholder="equipment_id_v1"
                  className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                />
              </label>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] uppercase opacity-60">quantity</span>
                  <input
                    value={quantity}
                    onChange={(event) => setQuantity(event.target.value)}
                    className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase opacity-60">unit price</span>
                  <input
                    value={unitPrice}
                    onChange={(event) => setUnitPrice(event.target.value)}
                    className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                  />
                </label>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <label className="block">
                  <span className="text-[10px] uppercase opacity-60">fee bps</span>
                  <input
                    value={feeBps}
                    onChange={(event) => setFeeBps(event.target.value)}
                    className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                  />
                </label>
                <label className="block">
                  <span className="text-[10px] uppercase opacity-60">expires (sec)</span>
                  <input
                    value={expiresInSeconds}
                    onChange={(event) => setExpiresInSeconds(event.target.value)}
                    className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                  />
                </label>
              </div>

              <button
                onClick={() => {
                  void createListing();
                }}
                disabled={!!busyAction || loading}
                className="w-full border-2 border-[#00FF41] text-[#00FF41] px-4 py-2 text-xs font-black uppercase hover:bg-[#00FF41] hover:text-black transition-all disabled:opacity-40"
              >
                {busyAction === 'create' ? 'CREATING...' : 'CREATE_LISTING'}
              </button>
            </div>

            <div className="mt-6 border-t border-white/15 pt-4">
              <h4 className="text-sm font-black uppercase text-[#F7931A]">Trade Action Context</h4>
              <label className="block mt-3">
                <span className="text-[10px] uppercase opacity-60">buyer agent</span>
                <select
                  value={buyerAgentId}
                  onChange={(event) => setBuyerAgentId(event.target.value)}
                  className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#F7931A]"
                >
                  <option value="">SELECT_BUYER</option>
                  {activeAgents.map((agent) => (
                    <option key={agent.id} value={agent.id}>
                      {(agent.profile?.displayName ?? shortId(agent.id, 8, 4)).toUpperCase()}
                    </option>
                  ))}
                </select>
              </label>
              <button
                onClick={() => {
                  void expireListings();
                }}
                disabled={!!busyAction || loading}
                className="mt-3 w-full border-2 border-white/60 text-white px-4 py-2 text-xs font-black uppercase hover:bg-white hover:text-black transition-all disabled:opacity-40"
              >
                {busyAction === 'expire' ? 'EXPIRING...' : 'RUN_EXPIRE_SWEEP'}
              </button>

            </div>
          </section>

          <section className="xl:col-span-2 space-y-4">
            <div className="h-[420px] border-4 border-white/30 bg-black/40 p-5 flex flex-col overflow-hidden">
              <div className="flex items-center justify-between gap-3">
                <h3 className="text-lg font-black uppercase tracking-wider text-white">Listings</h3>
                <select
                  value={statusFilter}
                  onChange={(event) => setStatusFilter(event.target.value as 'all' | ListingStatus)}
                  className="bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#00FF41]"
                >
                  <option value="all">ALL</option>
                  <option value="open">OPEN</option>
                  <option value="filled">FILLED</option>
                  <option value="cancelled">CANCELLED</option>
                  <option value="expired">EXPIRED</option>
                </select>
              </div>

              <div className="mt-4 flex-1 min-h-0 overflow-auto border border-white/15">
                <table className="min-w-full text-xs">
                  <thead className="bg-white/10 uppercase tracking-wider">
                    <tr>
                      <th className="px-2 py-2 text-left">Listing</th>
                      <th className="px-2 py-2 text-left">Seller</th>
                      <th className="px-2 py-2 text-left">Asset</th>
                      <th className="px-2 py-2 text-right">Qty</th>
                      <th className="px-2 py-2 text-right">Unit</th>
                      <th className="px-2 py-2 text-right">Gross</th>
                      <th className="px-2 py-2 text-left">Status</th>
                      <th className="px-2 py-2 text-left">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listings.map((listing) => {
                      const sellerLabel =
                        agentById.get(listing.sellerAgentId)?.profile?.displayName ??
                        shortId(listing.sellerAgentId, 8, 4);
                      const grossAmount = (
                        BigInt(listing.quantity) * BigInt(listing.unitPrice)
                      ).toString();
                      const canBuy =
                        listing.status === 'open' &&
                        !!buyerAgentId &&
                        buyerAgentId !== listing.sellerAgentId &&
                        !busyAction;
                      const canCancel = listing.status === 'open' && !busyAction;

                      return (
                        <tr key={listing.id} className="border-t border-white/10">
                          <td className="px-2 py-2">{shortId(listing.id, 8, 6)}</td>
                          <td className="px-2 py-2">{sellerLabel}</td>
                          <td className="px-2 py-2">{listing.assetId}</td>
                          <td className="px-2 py-2 text-right">{listing.quantity}</td>
                          <td className="px-2 py-2 text-right">{listing.unitPrice}</td>
                          <td className="px-2 py-2 text-right">{grossAmount}</td>
                          <td className="px-2 py-2 uppercase">{listing.status}</td>
                          <td className="px-2 py-2">
                            <div className="flex gap-2">
                              <button
                                onClick={() => {
                                  void buyListing(listing);
                                }}
                                disabled={!canBuy}
                                className="border border-[#00FF41] text-[#00FF41] px-2 py-1 text-[10px] font-black uppercase hover:bg-[#00FF41] hover:text-black disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {busyAction === `buy:${listing.id}` ? 'BUYING...' : 'BUY'}
                              </button>
                              <button
                                onClick={() => {
                                  void cancelListing(listing);
                                }}
                                disabled={!canCancel}
                                className="border border-[#F7931A] text-[#F7931A] px-2 py-1 text-[10px] font-black uppercase hover:bg-[#F7931A] hover:text-black disabled:opacity-40 disabled:cursor-not-allowed"
                              >
                                {busyAction === `cancel:${listing.id}` ? 'CANCELLING...' : 'CANCEL'}
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                    {!listings.length && (
                      <tr>
                        <td className="px-2 py-4 text-center opacity-60" colSpan={8}>
                          NO_LISTINGS
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>

            <div className="h-[420px] border-4 border-white/30 bg-black/40 p-5 flex flex-col overflow-hidden">
              <h3 className="text-lg font-black uppercase tracking-wider text-white">Autonomous Session</h3>
              <div className="mt-4 flex-1 min-h-0 overflow-y-auto pr-1 space-y-4">
                <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
                  <div className="border border-[#F7931A]/60 bg-[#F7931A]/5 p-3">
                    <h4 className="text-sm font-black uppercase text-[#F7931A]">Autonomous Trade Control</h4>
                    <label className="block mt-3">
                      <span className="text-[10px] uppercase opacity-60">max buy unit price</span>
                      <input
                        value={autoMaxBuyUnitPrice}
                        onChange={(event) => setAutoMaxBuyUnitPrice(event.target.value)}
                        className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#F7931A]"
                      />
                    </label>
                    <label className="block mt-3">
                      <span className="text-[10px] uppercase opacity-60">client run id (optional)</span>
                      <input
                        value={autoClientRunId}
                        onChange={(event) => setAutoClientRunId(event.target.value)}
                        placeholder="demo-auto-001"
                        className="mt-1 w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs focus:outline-none focus:border-[#F7931A]"
                      />
                    </label>
                    <label className="mt-3 flex items-center gap-2 text-[10px] uppercase opacity-80">
                      <input
                        type="checkbox"
                        checked={autoSeed}
                        onChange={(event) => setAutoSeed(event.target.checked)}
                        className="h-3 w-3 accent-[#F7931A]"
                      />
                      AUTO_SEED_PRECONDITIONS
                    </label>
                    <button
                      onClick={() => {
                        void runAutoTrade();
                      }}
                      disabled={!!busyAction || loading}
                      className="mt-3 w-full border-2 border-[#F7931A] text-[#F7931A] px-4 py-2 text-xs font-black uppercase hover:bg-[#F7931A] hover:text-black transition-all disabled:opacity-40"
                    >
                      {busyAction === 'auto:one-shot' ? 'RUNNING_AUTO_TRADE...' : 'RUN_BOT_AUTO_TRADE'}
                    </button>
                  </div>

                  <div className="border border-[#00FF41]/60 bg-[#00FF41]/5 p-3">
                    <h4 className="text-sm font-black uppercase text-[#00FF41]">Agent Process Stream</h4>
                    <p className="mt-1 text-[10px] uppercase opacity-60">
                      live market events (auto + listing + settlement)
                    </p>
                    <div ref={processStreamRef} className="mt-2 h-44 overflow-y-auto border border-white/10 p-2">
                      {visibleMarketEvents.map((event) => (
                        <p key={event.id} className="text-[10px] uppercase opacity-80 break-all">
                          {new Date(event.createdAt).toLocaleTimeString()} | {formatEventLabel(event)}
                        </p>
                      ))}
                      {!visibleMarketEvents.length && (
                        <p className="text-[10px] uppercase opacity-50">NO_MARKET_EVENTS</p>
                      )}
                    </div>
                  </div>
                </div>

                <div className="border border-white/25 bg-white/5 p-3">
                  <h4 className="text-sm font-black uppercase text-white">Last Auto Trade Result</h4>
                  {lastAutoResult ? (
                    <>
                      <p className="mt-2 text-[10px] uppercase opacity-70 break-all">
                        run: {lastAutoResult.runId} | clientRunId: {lastAutoResult.clientRunId ?? 'none'} | idempotent:{' '}
                        {lastAutoResult.idempotent ? 'yes' : 'no'}
                      </p>
                      <p className="text-[10px] uppercase opacity-70 break-all">
                        seller: {shortId(lastAutoResult.sellerAgentId, 8, 6)} | buyer:{' '}
                        {shortId(lastAutoResult.buyerAgentId, 8, 6)} | listing: {lastAutoResult.listing.status} | trade:{' '}
                        {lastAutoResult.trade.status}
                      </p>
                      <p className="text-[10px] uppercase text-[#F7931A]">
                        gross={lastAutoResult.trade.grossAmount} fee={lastAutoResult.trade.feeAmount} net={lastAutoResult.trade.netAmount}
                      </p>
                      {lastAutoCredits && (
                        <p className="text-[10px] uppercase text-[#00FF41]">
                          buyer credits {lastAutoCredits.buyerBefore} -&gt; {lastAutoCredits.buyerAfter} | seller credits{' '}
                          {lastAutoCredits.sellerBefore} -&gt; {lastAutoCredits.sellerAfter}
                        </p>
                      )}
                      <div className="mt-2 max-h-28 overflow-y-auto border border-white/10 p-2">
                        {lastAutoResult.steps.map((step, index) => (
                          <p key={`${step.step}-${index}`} className="text-[10px] uppercase opacity-70 break-all">
                            {step.step}: {step.status}
                          </p>
                        ))}
                      </div>
                    </>
                  ) : (
                    <p className="mt-2 text-[10px] uppercase opacity-50">NO_AUTO_TRADE_RESULT_YET</p>
                  )}
                </div>
              </div>
            </div>
          </section>

          <section className="xl:col-span-3 border-4 border-[#F7931A]/60 bg-[#F7931A]/5 p-5">
            <h3 className="text-lg font-black uppercase tracking-wider text-[#F7931A]">
              Trade History
            </h3>
            <div className="mt-4 overflow-x-auto border border-white/15">
              <table className="min-w-full text-xs">
                <thead className="bg-white/10 uppercase tracking-wider">
                  <tr>
                    <th className="px-2 py-2 text-left">Trade</th>
                    <th className="px-2 py-2 text-left">Listing</th>
                    <th className="px-2 py-2 text-left">Seller</th>
                    <th className="px-2 py-2 text-left">Buyer</th>
                    <th className="px-2 py-2 text-left">Asset</th>
                    <th className="px-2 py-2 text-right">Gross</th>
                    <th className="px-2 py-2 text-right">Fee</th>
                    <th className="px-2 py-2 text-right">Net</th>
                    <th className="px-2 py-2 text-left">SettledAt</th>
                  </tr>
                </thead>
                <tbody>
                  {trades.map((trade) => {
                    const sellerLabel =
                      agentById.get(trade.sellerAgentId)?.profile?.displayName ??
                      shortId(trade.sellerAgentId, 8, 4);
                    const buyerLabel =
                      agentById.get(trade.buyerAgentId)?.profile?.displayName ??
                      shortId(trade.buyerAgentId, 8, 4);

                    return (
                      <tr key={trade.id} className="border-t border-white/10">
                        <td className="px-2 py-2">{shortId(trade.id, 8, 6)}</td>
                        <td className="px-2 py-2">{shortId(trade.listingId, 8, 6)}</td>
                        <td className="px-2 py-2">{sellerLabel}</td>
                        <td className="px-2 py-2">{buyerLabel}</td>
                        <td className="px-2 py-2">
                          {trade.assetId} x{trade.quantity}
                        </td>
                        <td className="px-2 py-2 text-right">{trade.grossAmount}</td>
                        <td className="px-2 py-2 text-right">{trade.feeAmount}</td>
                        <td className="px-2 py-2 text-right">{trade.netAmount}</td>
                        <td className="px-2 py-2">{new Date(trade.settledAt).toLocaleString()}</td>
                      </tr>
                    );
                  })}
                  {!trades.length && (
                    <tr>
                      <td className="px-2 py-4 text-center opacity-60" colSpan={9}>
                        NO_TRADES
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <div className="max-w-7xl mx-auto mt-4">
          {error && <div className="text-xs text-red-400 uppercase break-all">{error}</div>}
          {notice && <div className="text-xs text-[#00FF41] uppercase break-all">{notice}</div>}
        </div>
      </div>
    </div>
  );
};
