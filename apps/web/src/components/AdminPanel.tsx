import React, { useEffect, useMemo, useState } from 'react';
import { useGame } from '../context/GameContext';
import { getLootConfig, resolveAiPersonality, generateDefaultPromptForPersonality, getPersonalityDescription, getPersonalityColor } from '@tactical/game-engine';
import { AgentSnapshot, LootPoolItem, ItemType, AiPersonality, PERSONALITY_CONFIGS } from '@tactical/shared-types';
import { useAccount, useConnect, useDisconnect, useSwitchChain } from 'wagmi';
import { chainMarketConfig } from '../lib/chainMarket';
import { pickPreferredConnector } from '../lib/walletConnector';

const AGENT_MATRIX_STORAGE_KEY = 'agent_matrix_start_config_v1';
const DEFAULT_AGENT_PROMPT = 'You are a tactical survival agent. Prioritize long-term survival and assets.';

type SlotKind = 'user' | 'bot';

interface AgentApiProfile {
  displayName: string;
  promptDefault: string;
  promptOverride: string | null;
}

interface AgentApiWallet {
  address: string;
  custodyMode: 'server_managed' | 'external_signer';
}

interface AgentApiItem {
  id: string;
  kind: SlotKind;
  status: 'active' | 'dead' | 'respawning';
  accountIdentifier: string;
  wallet: AgentApiWallet | null;
  profile: AgentApiProfile | null;
}

interface AgentSlotConfig {
  slot: number;
  kind: SlotKind;
  agentId: string;
  prompt: string;
  personality: AiPersonality;
}

interface StoredMatrixConfig {
  slotConfigs: AgentSlotConfig[];
}

const SLOT_DEFS: Array<{ slot: number; kind: SlotKind; label: string }> = [
  { slot: 0, kind: 'user', label: 'USER_00' },
  { slot: 1, kind: 'bot', label: 'BOT_01' },
  { slot: 2, kind: 'bot', label: 'BOT_02' },
  { slot: 3, kind: 'bot', label: 'BOT_03' },
  { slot: 4, kind: 'bot', label: 'BOT_04' },
  { slot: 5, kind: 'bot', label: 'BOT_05' },
  { slot: 6, kind: 'bot', label: 'BOT_06' },
  { slot: 7, kind: 'bot', label: 'BOT_07' }
];

const resolveApiBase = (): string =>
  (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(/\/$/, '');

function preferredPrompt(agent: AgentApiItem | undefined): string {
  if (!agent?.profile) return DEFAULT_AGENT_PROMPT;
  return agent.profile.promptOverride ?? agent.profile.promptDefault ?? DEFAULT_AGENT_PROMPT;
}

function parseWalletFromIdentifier(accountIdentifier: string | null | undefined): string | null {
  if (!accountIdentifier) return null;
  const normalized = accountIdentifier.trim();
  if (!normalized.toLowerCase().startsWith('wallet:')) return null;
  const parts = normalized.split(':');
  const value = parts.slice(1).join(':').trim();
  return value || null;
}

function emptySlotConfigs(): AgentSlotConfig[] {
  return SLOT_DEFS.map((slot) => ({
    slot: slot.slot,
    kind: slot.kind,
    agentId: '',
    prompt: '',
    personality: 'RANDOM' as AiPersonality
  }));
}

function normalizeStoredConfig(input: unknown): AgentSlotConfig[] | null {
  if (!input || typeof input !== 'object') return null;
  const maybe = input as Partial<StoredMatrixConfig>;
  if (!Array.isArray(maybe.slotConfigs)) return null;

  const normalized = maybe.slotConfigs
    .filter((item): item is AgentSlotConfig => {
      if (!item || typeof item !== 'object') return false;
      if (typeof item.slot !== 'number') return false;
      if (item.kind !== 'user' && item.kind !== 'bot') return false;
      if (typeof item.agentId !== 'string') return false;
      if (typeof item.prompt !== 'string') return false;
      // personality 可选，默认 RANDOM
      if (item.personality !== undefined && typeof item.personality !== 'string') return false;
      return true;
    })
    .sort((a, b) => a.slot - b.slot);

  if (normalized.length !== SLOT_DEFS.length) return null;
  // 确保 personality 字段存在
  return normalized.map(item => ({
    ...item,
    personality: (item.personality || 'RANDOM') as AiPersonality
  }));
}

function buildAutoSlotConfigs(agents: AgentApiItem[], stored: AgentSlotConfig[] | null): AgentSlotConfig[] {
  const users = agents.filter((agent) => agent.kind === 'user');
  const bots = agents.filter((agent) => agent.kind === 'bot');
  const fallback = emptySlotConfigs();

  const storedPromptBySlot = new Map<number, string>();
  const storedPersonalityBySlot = new Map<number, AiPersonality>();
  if (stored) {
    for (const slot of stored) {
      storedPromptBySlot.set(slot.slot, slot.prompt);
      storedPersonalityBySlot.set(slot.slot, slot.personality);
    }
  }

  if (users[0]) {
    fallback[0] = {
      slot: 0,
      kind: 'user',
      agentId: users[0].id,
      prompt: storedPromptBySlot.get(0)?.trim() || preferredPrompt(users[0]),
      personality: storedPersonalityBySlot.get(0) || 'RANDOM' as AiPersonality
    };
  }

  for (let i = 1; i < SLOT_DEFS.length; i += 1) {
    const bot = bots[i - 1];
    if (!bot) continue;
    fallback[i] = {
      slot: i,
      kind: 'bot',
      agentId: bot.id,
      prompt: storedPromptBySlot.get(i)?.trim() || preferredPrompt(bot),
      personality: storedPersonalityBySlot.get(i) || 'RANDOM' as AiPersonality
    };
  }

  return fallback;
}

interface AdminPanelProps {
  onClose: () => void;
  onStartGameWithSnapshots?: (agentSnapshots: AgentSnapshot[]) => void;
}

function expectedCustodyMode(kind: SlotKind): 'server_managed' | 'external_signer' {
  return kind === 'user' ? 'external_signer' : 'server_managed';
}

export const AdminPanel: React.FC<AdminPanelProps> = ({ onClose, onStartGameWithSnapshots }) => {
  const { state, dispatch } = useGame();
  const { address, isConnected, chain } = useAccount();
  const { connectAsync, connectors, isPending: connectPending } = useConnect();
  const { disconnectAsync } = useDisconnect();
  const { switchChainAsync, isPending: switchPending } = useSwitchChain();
  const [config, setConfig] = useState(getLootConfig());
  const [searchRate, setSearchRate] = useState((state.settings?.searchSuccessRate ?? 0.5) * 100);
  const [agents, setAgents] = useState<AgentApiItem[]>([]);
  const [slots, setSlots] = useState<AgentSlotConfig[]>(emptySlotConfigs());
  const [matrixLoading, setMatrixLoading] = useState(false);
  const [matrixError, setMatrixError] = useState<string | null>(null);
  const [matrixNotice, setMatrixNotice] = useState<string | null>(null);
  const [walletBinding, setWalletBinding] = useState(false);
  const [walletBindingError, setWalletBindingError] = useState<string | null>(null);
  const [walletBindingNotice, setWalletBindingNotice] = useState<string | null>(null);
  const apiBase = useMemo(resolveApiBase, []);

  const agentById = useMemo(() => {
    return new Map(agents.map((agent) => [agent.id, agent]));
  }, [agents]);

  const agentsByKind = useMemo(() => {
    return {
      user: agents.filter((agent) => agent.kind === 'user'),
      bot: agents.filter((agent) => agent.kind === 'bot')
    };
  }, [agents]);

  const mixedCustodyReadiness = useMemo(() => {
    const selectedAgents = slots
      .map((slot) => ({ slot, agent: slot.agentId ? agentById.get(slot.agentId) : undefined }))
      .filter((item) => !!item.agent);

    const walletSet = new Set<string>();
    let userExternalCount = 0;
    let botManagedCount = 0;
    let missingWalletCount = 0;
    let wrongCustodyCount = 0;
    let duplicateWalletCount = 0;

    for (const item of selectedAgents) {
      const agent = item.agent!;
      const wallet = agent.wallet;
      const expected = expectedCustodyMode(agent.kind);
      if (!wallet?.address) {
        missingWalletCount += 1;
        continue;
      }
      const walletLower = wallet.address.toLowerCase();
      if (walletSet.has(walletLower)) {
        duplicateWalletCount += 1;
      } else {
        walletSet.add(walletLower);
      }
      if (wallet.custodyMode !== expected) {
        wrongCustodyCount += 1;
      } else if (agent.kind === 'user') {
        userExternalCount += 1;
      } else {
        botManagedCount += 1;
      }
    }

    const ready =
      selectedAgents.length === SLOT_DEFS.length &&
      userExternalCount === 1 &&
      botManagedCount === 7 &&
      missingWalletCount === 0 &&
      wrongCustodyCount === 0 &&
      duplicateWalletCount === 0;

    return {
      ready,
      selectedCount: selectedAgents.length,
      userExternalCount,
      botManagedCount,
      missingWalletCount,
      wrongCustodyCount,
      duplicateWalletCount
    };
  }, [agentById, slots]);

  // 计算每个 slot 的 prompt 预览
  const slotPromptPreviews = useMemo(() => {
    return slots.map((slot) => {
      const resolvedPersonality = resolveAiPersonality(slot.personality || 'RANDOM');
      const defaultPrompt = generateDefaultPromptForPersonality(resolvedPersonality);
      const hasCustomPrompt = slot.prompt && slot.prompt.trim().length > 0;
      const effectivePrompt = hasCustomPrompt ? slot.prompt : defaultPrompt;
      const previewLines = effectivePrompt.split('\n').slice(0, 2); // 只显示前两行
      return {
        slot: slot.slot,
        hasCustomPrompt,
        preview: previewLines.join(' ').substring(0, 60) + '...',
        description: getPersonalityDescription(resolvedPersonality),
        color: getPersonalityColor(resolvedPersonality)
      };
    });
  }, [slots]);

  const loadAgents = async (): Promise<void> => {
    setMatrixLoading(true);
    setMatrixError(null);
    try {
      const response = await fetch(`${apiBase}/api/agents?status=active`);
      if (!response.ok) {
        throw new Error(`Failed to load agents: ${response.status}`);
      }
      const data = await response.json();
      const items = Array.isArray(data?.items) ? (data.items as AgentApiItem[]) : [];
      const storedRaw = localStorage.getItem(AGENT_MATRIX_STORAGE_KEY);
      const stored = storedRaw ? normalizeStoredConfig(JSON.parse(storedRaw)) : null;
      setAgents(items);
      setSlots(buildAutoSlotConfigs(items, stored));
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to load agent matrix.';
      setMatrixError(message);
      setSlots(emptySlotConfigs());
    } finally {
      setMatrixLoading(false);
    }
  };

  useEffect(() => {
    void loadAgents();
  }, [apiBase]);

  const saveConfig = () => {
    localStorage.setItem('admin_loot_config', JSON.stringify(config));
    alert('DATABASE_SYNCHRONIZED: 全局掉落矩阵已更新。');
    onClose();
  };

  const handleRateChange = (val: number) => {
    setSearchRate(val);
    dispatch({ type: 'UPDATE_SETTINGS', payload: { searchSuccessRate: val / 100 } });
  };

  const purgeAi = () => {
    if (window.confirm('CRITICAL: 确认执行 PURGE_ALL_AI 指令？所有敌对单元将立即离线。')) {
      dispatch({ type: 'KILL_ALL_AI' });
      onClose();
    }
  };

  const addNewItem = (catIdx: number, type: ItemType) => {
    const newItem: LootPoolItem = {
      id: `custom-${Date.now()}-${Math.random().toString(36).substr(2, 5)}`,
      name: 'NEW_TEMPLATE',
      type,
      weight: 10,
      minStat: 1,
      maxStat: 10,
      description: '待定义的系统物资描述。'
    };
    const newCfg = [...config];
    newCfg[catIdx].items.push(newItem);
    setConfig(newCfg);
  };

  const removeItem = (catIdx: number, itemIdx: number) => {
    if (!window.confirm('确认抹除该物资数据？此操作不可逆。')) return;
    const newCfg = [...config];
    newCfg[catIdx].items.splice(itemIdx, 1);
    setConfig(newCfg);
  };

  const updateItem = (
    catIdx: number,
    itemIdx: number,
    field: keyof LootPoolItem,
    value: string | number
  ) => {
    const newCfg = [...config];
    // @ts-ignore
    newCfg[catIdx].items[itemIdx][field] = value;
    setConfig(newCfg);
  };

  const updateSlotAgent = (slot: number, agentId: string) => {
    setMatrixNotice(null);
    setSlots((prev) =>
      prev.map((item) => {
        if (item.slot !== slot) return item;
        const selectedAgent = agentById.get(agentId);
        return {
          ...item,
          agentId,
          prompt: selectedAgent ? preferredPrompt(selectedAgent) : '',
          // 保留现有个性或使用默认值
          personality: item.personality || 'RANDOM' as AiPersonality
        };
      })
    );
  };

  const updateSlotPersonality = (slot: number, personality: AiPersonality) => {
    setMatrixNotice(null);
    setSlots((prev) => prev.map((item) => (item.slot === slot ? { ...item, personality } : item)));
  };

  const updateSlotPrompt = (slot: number, prompt: string) => {
    setMatrixNotice(null);
    setSlots((prev) => prev.map((item) => (item.slot === slot ? { ...item, prompt } : item)));
  };

  const saveMatrixTemplate = () => {
    localStorage.setItem(AGENT_MATRIX_STORAGE_KEY, JSON.stringify({ slotConfigs: slots }));
    setMatrixNotice('MATRIX_TEMPLATE_SAVED');
  };

  const userSlot = slots.find((slot) => slot.kind === 'user');
  const userAgent = userSlot?.agentId ? agentById.get(userSlot.agentId) : undefined;
  const connectedAddress = address?.toLowerCase() ?? null;
  const boundUserAddress = userAgent?.wallet?.address?.toLowerCase() ?? null;
  const userWalletMatched = !!connectedAddress && !!boundUserAddress && connectedAddress === boundUserAddress;
  const userWalletMissing = !boundUserAddress;
  const userBindLocked = state.phase !== 'WAITING';

  const connectUserWallet = async () => {
    setWalletBindingError(null);
    setWalletBindingNotice(null);
    const connector = pickPreferredConnector(connectors);
    if (!connector) {
      setWalletBindingError('No wallet connector available.');
      return;
    }
    try {
      if (isConnected) {
        await disconnectAsync();
      }

      const injectedProvider = (globalThis as { ethereum?: { request?: (args: unknown) => Promise<unknown> } })
        .ethereum;
      if (injectedProvider?.request) {
        try {
          await injectedProvider.request({
            method: 'wallet_requestPermissions',
            params: [{ eth_accounts: {} }]
          });
        } catch {
          // user may skip account picker; connector flow still works
        }
      }

      const connectResult = await connectAsync({ connector });
      const connectedAccount = connectResult.accounts?.[0];
      if (!connectedAccount) {
        throw new Error('Wallet account is unavailable after connect.');
      }
      if (chain?.id !== chainMarketConfig.chain.id) {
        await switchChainAsync({ chainId: chainMarketConfig.chain.id });
      }
      setWalletBindingNotice(`WALLET_CONNECTED ${connectedAccount.toLowerCase()}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to connect wallet.';
      setWalletBindingError(message);
    }
  };

  const bindCurrentWalletToUser = async () => {
    if (userBindLocked) {
      setWalletBindingError('BIND is only allowed during initialization phase (WAITING).');
      return;
    }
    if (!userAgent) {
      setWalletBindingError('No user agent in matrix.');
      return;
    }
    if (!address) {
      setWalletBindingError('Wallet is not connected.');
      return;
    }
    const nextAddress = address.toLowerCase();
    if (boundUserAddress && boundUserAddress !== nextAddress) {
      const confirmed = window.confirm(
        `Rebind user wallet?\ncurrent=${boundUserAddress}\nnext=${nextAddress}`
      );
      if (!confirmed) {
        return;
      }
    }
    setWalletBinding(true);
    setWalletBindingError(null);
    setWalletBindingNotice(null);
    try {
      const response = await fetch(`${apiBase}/api/agents/${userAgent.id}/wallet/external`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          address,
          forceReplace: true
        })
      });
      if (!response.ok) {
        let message = `Failed to bind wallet: ${response.status}`;
        try {
          const body = await response.json();
          if (typeof body?.error === 'string' && body.error.trim()) {
            message = body.error.trim();
          }
        } catch {
          // ignore
        }
        throw new Error(message);
      }
      await loadAgents();
      setWalletBindingNotice('USER_EXTERNAL_WALLET_BOUND');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to bind user wallet.';
      setWalletBindingError(message);
    } finally {
      setWalletBinding(false);
    }
  };

  const buildSnapshotsFromSlots = (): AgentSnapshot[] | null => {
    if (slots.length !== SLOT_DEFS.length) {
      setMatrixNotice('MATRIX_INVALID: slot count mismatch.');
      return null;
    }

    const selected = slots.map((slot) => slot.agentId).filter((id) => !!id);
    if (selected.length !== SLOT_DEFS.length) {
      setMatrixNotice('MATRIX_INVALID: 8 slots must all bind an agent.');
      return null;
    }

    if (new Set(selected).size !== selected.length) {
      setMatrixNotice('MATRIX_INVALID: duplicate agent selected.');
      return null;
    }

    const snapshots: AgentSnapshot[] = [];
    const walletAddressSet = new Set<string>();

    for (const slot of slots) {
      const agent = agentById.get(slot.agentId);
      if (!agent) {
        setMatrixNotice(`MATRIX_INVALID: missing agent ${slot.agentId}.`);
        return null;
      }
      if (agent.kind !== slot.kind) {
        setMatrixNotice(`MATRIX_INVALID: slot kind mismatch at slot ${slot.slot}.`);
        return null;
      }
      const prompt = slot.prompt.trim() || preferredPrompt(agent);
      if (!prompt) {
        setMatrixNotice(`MATRIX_INVALID: prompt missing at slot ${slot.slot}.`);
        return null;
      }
      const expectedMode = expectedCustodyMode(slot.kind);
      if (!agent.wallet?.address) {
        setMatrixNotice(`MATRIX_INVALID: wallet missing at slot ${slot.slot}.`);
        return null;
      }
      if (agent.wallet.custodyMode !== expectedMode) {
        setMatrixNotice(
          `MATRIX_INVALID: custody mismatch at slot ${slot.slot}. expected=${expectedMode} actual=${agent.wallet.custodyMode}.`
        );
        return null;
      }
      const walletAddressLower = agent.wallet.address.toLowerCase();
      if (walletAddressSet.has(walletAddressLower)) {
        setMatrixNotice(`MATRIX_INVALID: duplicate wallet address at slot ${slot.slot}.`);
        return null;
      }
      walletAddressSet.add(walletAddressLower);
      snapshots.push({
        agentId: agent.id,
        kind: agent.kind,
        displayName: agent.profile?.displayName ?? `${agent.kind.toUpperCase()}_${slot.slot}`,
        accountIdentifier: agent.accountIdentifier,
        walletAddress: agent.wallet?.address ?? null,
        prompt,
        personality: slot.personality
      });
    }

    const userCount = snapshots.filter((snapshot) => snapshot.kind === 'user').length;
    const botCount = snapshots.filter((snapshot) => snapshot.kind === 'bot').length;
    if (userCount !== 1 || botCount !== 7) {
      setMatrixNotice('MATRIX_INVALID: need exactly 1 user + 7 bots.');
      return null;
    }

    return snapshots;
  };

  const startWithMatrix = () => {
    if (state.phase !== 'WAITING') {
      setMatrixNotice('START_BLOCKED: only available when phase=WAITING.');
      return;
    }

    const snapshots = buildSnapshotsFromSlots();
    if (!snapshots) return;

    saveMatrixTemplate();

    if (onStartGameWithSnapshots) {
      onStartGameWithSnapshots(snapshots);
      return;
    }

    dispatch({
      type: 'START_GAME',
      payload: {
        humanCount: 1,
        aiCount: 7,
        agentSnapshots: snapshots
      }
    });
    onClose();
  };

  const isAgentSelectedInOtherSlot = (slot: number, agentId: string): boolean => {
    return slots.some((item) => item.slot !== slot && item.agentId === agentId);
  };

  return (
    <div className="fixed inset-0 bg-black z-[300] flex flex-col font-mono animate-in fade-in duration-300">
      <div className="flex-none bg-black border-b-4 border-white p-8">
        <div className="max-w-6xl mx-auto flex justify-between items-center">
          <div>
            <h1 className="text-4xl font-black italic text-[#F7931A] leading-none">SYSTEM_ADMIN // MATRIX_EDITOR</h1>
            <p className="text-[10px] opacity-40 mt-2 uppercase tracking-widest font-bold">Root_Access: Enabled // Version: 2.3.0-DebugReady</p>
          </div>
          <div className="flex gap-4">
            <button
              onClick={purgeAi}
              className="border-2 border-[#F7931A] text-[#F7931A] px-6 py-3 font-black hover:bg-[#F7931A] hover:text-white transition-all uppercase text-xs"
            >
              [!] PURGE_ALL_AI
            </button>
            <button
              onClick={onClose}
              className="bg-white text-black px-8 py-3 font-black hover:bg-white/80 transition-all border-2 border-white text-xs"
            >
              [ESC] CLOSE
            </button>
          </div>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-10 custom-scrollbar bg-[#050505]">
        <div className="max-w-6xl mx-auto space-y-12">
          <div className="border-4 border-[#00FF41] p-8 bg-[#00FF41]/5 shadow-[0_0_20px_rgba(0,255,65,0.12)]">
            <div className="flex flex-wrap items-center justify-between gap-4 mb-6">
              <div>
                <h2 className="text-2xl font-black text-[#00FF41] uppercase italic tracking-tighter">Agent_Start_Matrix // M1</h2>
                <p className="text-[11px] opacity-60 mt-2 uppercase tracking-[0.18em]">Bind 8 slots (1 user + 7 bots), edit prompt, then start with snapshots.</p>
              </div>
              <div className="flex gap-3">
                <button
                  onClick={saveMatrixTemplate}
                  className="border-2 border-white/60 text-white px-4 py-2 text-xs font-black hover:bg-white hover:text-black transition-all uppercase"
                >
                  SAVE_TEMPLATE
                </button>
                <button
                  onClick={startWithMatrix}
                  disabled={matrixLoading || !!matrixError || !mixedCustodyReadiness.ready || userWalletMissing}
                  className="border-2 border-[#00FF41] text-[#00FF41] px-4 py-2 text-xs font-black hover:bg-[#00FF41] hover:text-black transition-all uppercase disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  START_8_AGENT_RUN
                </button>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {SLOT_DEFS.map((slotDef) => {
                const slot = slots.find((item) => item.slot === slotDef.slot) ?? {
                  slot: slotDef.slot,
                  kind: slotDef.kind,
                  agentId: '',
                  prompt: '',
                  personality: 'RANDOM' as AiPersonality
                };

                const options = slotDef.kind === 'user' ? agentsByKind.user : agentsByKind.bot;
                const selectedAgent = slot.agentId ? agentById.get(slot.agentId) : undefined;
                const accountIdentifier = selectedAgent?.accountIdentifier ?? '';
                const identifierWallet = parseWalletFromIdentifier(accountIdentifier);
                const walletDisplay = selectedAgent?.wallet?.address ?? identifierWallet ?? '-';
                const showAccountIdentifier = !!accountIdentifier && !identifierWallet;

                // 个性选项配置
                const personalityOptions: Array<{ value: AiPersonality; label: string; color: string; desc: string }> = [
                  { value: 'RANDOM', label: '随机', color: 'text-gray-400', desc: '游戏开始时随机分配' },
                  { value: 'AGGRESSIVE', label: '激进战士', color: 'text-red-400', desc: '主动追击，高攻击性' },
                  { value: 'CAUTIOUS', label: '谨慎生存', color: 'text-blue-400', desc: '保守行事，高生存优先' },
                  { value: 'EXPLORER', label: '探索者', color: 'text-green-400', desc: '优先搜索，中等风险' },
                  { value: 'OPPORTUNIST', label: '投机者', color: 'text-yellow-400', desc: '灵活决策，看情况行动' }
                ];

                const promptPreview = slotPromptPreviews.find(p => p.slot === slotDef.slot);

                return (
                  <div key={slotDef.slot} className="border-2 border-white/20 bg-black/40 p-4">
                    <div className="flex items-center justify-between mb-3">
                      <div className="text-xs uppercase tracking-[0.2em] font-black text-[#00FF41]">{slotDef.label}</div>
                      <div className="text-[10px] uppercase opacity-50">{slotDef.kind}</div>
                    </div>
                    <div className="w-full bg-black border-2 border-white/30 text-white px-3 py-2 text-xs font-bold uppercase">
                      {selectedAgent ? selectedAgent.profile?.displayName ?? selectedAgent.id.slice(0, 8) : 'NO_AGENT_AVAILABLE'}
                    </div>

                    {/* 个性选择器 */}
                    <div className="mt-3">
                      <label className="text-[10px] uppercase opacity-60 tracking-[0.1em]">AI Personality</label>
                      <select
                        value={slot.personality}
                        onChange={(e) => updateSlotPersonality(slotDef.slot, e.target.value as AiPersonality)}
                        className="w-full mt-1 bg-black border-2 border-white/30 text-white px-2 py-1 text-xs focus:outline-none focus:border-[#F7931A]"
                      >
                        {personalityOptions.map((opt) => (
                          <option key={opt.value} value={opt.value} className="bg-black">
                            {opt.label} - {opt.desc}
                          </option>
                        ))}
                      </select>
                      <div className={`text-[9px] mt-1 ${personalityOptions.find(p => p.value === slot.personality)?.color || 'text-white/60'}`}>
                        {personalityOptions.find(p => p.value === slot.personality)?.desc}
                      </div>
                    </div>

                    {/* Prompt 预览 */}
                    <div className="mt-2 pt-2 border-t border-white/10">
                      <div className="text-[9px] uppercase opacity-50 tracking-[0.1em] mb-1">
                        AI Prompt {promptPreview.hasCustomPrompt && '(自定义)'}
                      </div>
                      <div className="text-[8px] opacity-70 italic leading-relaxed line-clamp-2">
                        {promptPreview.preview}
                      </div>
                      {!promptPreview.hasCustomPrompt && (
                        <div className={`text-[8px] mt-1 ${promptPreview.color}`}>
                          默认模板基于: {promptPreview.description}
                        </div>
                      )}
                    </div>

                    <textarea
                      value={slot.prompt}
                      onChange={(e) => updateSlotPrompt(slotDef.slot, e.target.value)}
                      placeholder="自定义 LLM Prompt (留空使用个性默认模板)"
                      className="w-full mt-3 h-20 bg-black border-2 border-white/30 text-white p-2 text-xs leading-relaxed focus:outline-none focus:border-[#F7931A] resize-none"
                    />

                    {showAccountIdentifier && <div className="mt-2 text-[10px] opacity-60 break-all">{accountIdentifier}</div>}
                    <div className="text-[10px] opacity-60 break-all">wallet: {walletDisplay}</div>
                    <div className="text-[10px] opacity-60 break-all uppercase">
                      custody: {selectedAgent?.wallet?.custodyMode ?? '-'}
                    </div>
                    <div className="text-[10px] opacity-50 break-all uppercase">
                      required: {expectedCustodyMode(slotDef.kind)}
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="mt-4 border border-white/20 bg-black/40 p-3 text-[10px] uppercase tracking-[0.12em]">
              <div>readiness_selected: {mixedCustodyReadiness.selectedCount}/8</div>
              <div>readiness_user_external: {mixedCustodyReadiness.userExternalCount}/1</div>
              <div>readiness_bot_managed: {mixedCustodyReadiness.botManagedCount}/7</div>
              <div>readiness_missing_wallet: {mixedCustodyReadiness.missingWalletCount}</div>
              <div>readiness_wrong_custody: {mixedCustodyReadiness.wrongCustodyCount}</div>
              <div>readiness_duplicate_wallet: {mixedCustodyReadiness.duplicateWalletCount}</div>
              <div>user_wallet_bound: {boundUserAddress ?? 'none'}</div>
              <div>connected_wallet: {connectedAddress ?? 'none'}</div>
              <div>user_wallet_match: {userWalletMatched ? 'yes' : 'no'}</div>
              <div className={mixedCustodyReadiness.ready ? 'text-[#00FF41]' : 'text-[#F7931A]'}>
                readiness_status: {mixedCustodyReadiness.ready ? 'ready' : 'blocked'}
              </div>
            </div>

            <div className="mt-4 border border-[#F7931A]/40 bg-[#F7931A]/10 p-3 text-[10px] uppercase tracking-[0.12em]">
              <div className="font-black text-[#F7931A]">User Wallet Binding</div>
              <div className="mt-2">user_agent: {userAgent?.id ?? 'none'}</div>
              <div>user_wallet_custody: {userAgent?.wallet?.custodyMode ?? 'none'}</div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  onClick={() => {
                    void connectUserWallet();
                  }}
                  disabled={connectPending || switchPending || walletBinding}
                  className="border border-white/60 text-white px-2 py-1 text-[10px] font-black uppercase hover:bg-white hover:text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {connectPending || switchPending ? 'CONNECTING...' : 'CONNECT_WALLET'}
                </button>
                <button
                  onClick={() => {
                    void bindCurrentWalletToUser();
                  }}
                  disabled={!address || walletBinding || userBindLocked}
                  className="border border-[#00FF41] text-[#00FF41] px-2 py-1 text-[10px] font-black uppercase hover:bg-[#00FF41] hover:text-black transition-all disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  {walletBinding ? 'BINDING...' : 'BIND_CONNECTED_WALLET'}
                </button>
              </div>
              {userBindLocked && (
                <div className="mt-2 text-[#F7931A]">
                  USER_BINDING_LOCKED: game phase is {state.phase}. keep CONNECT for market wallet switching.
                </div>
              )}
              {walletBindingError && <div className="mt-2 text-red-400">{walletBindingError}</div>}
              {walletBindingNotice && <div className="mt-2 text-[#00FF41]">{walletBindingNotice}</div>}
            </div>

            {matrixLoading && <div className="mt-4 text-xs text-white/70 uppercase">LOADING_AGENT_REGISTRY...</div>}
            {matrixError && <div className="mt-4 text-xs text-red-400 uppercase">{matrixError}</div>}
            {matrixNotice && <div className="mt-4 text-xs text-[#F7931A] uppercase">{matrixNotice}</div>}
          </div>

          <div className="border-4 border-[#F7931A] p-8 bg-[#F7931A]/5 shadow-[0_0_20px_rgba(247,147,26,0.1)]">
            <h2 className="text-2xl font-black text-[#F7931A] mb-6 uppercase italic tracking-tighter">Global_System_Parameters</h2>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-10">
              <div className="space-y-4">
                <div className="flex justify-between items-baseline">
                  <span className="text-sm font-black uppercase opacity-60">Scan_Success_Probability</span>
                  <span className="text-2xl font-black text-[#F7931A]">{searchRate}%</span>
                </div>
                <input
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={searchRate}
                  onChange={(e) => handleRateChange(parseInt(e.target.value))}
                  className="w-full accent-[#F7931A] bg-white/10 h-2 appearance-none cursor-pointer"
                />
                <p className="text-[10px] opacity-40 uppercase italic">影响玩家执行 [SCAN_ZONE] 指令时成功探测到物资的几率。</p>
              </div>
              <div className="flex items-center justify-center border-2 border-dashed border-white/10 p-4 opacity-30 italic text-xs uppercase">
                Additional_Parameters_Locked_In_Dev_Mode
              </div>
            </div>
          </div>

          {state.phase !== 'WAITING' && (
            <div className="bg-[#F7931A]/20 text-[#F7931A] p-4 font-bold border-2 border-[#F7931A] shadow-[4px_4px_0px_#F7931A] uppercase text-xs tracking-tighter">
              CRITICAL_WARNING: 游戏会话进行中。修改将在下一次系统初始化时生效。
            </div>
          )}

          {config.map((cat, catIdx) => (
            <div key={cat.type} className="border-4 border-white/10 flex flex-col max-h-[500px] bg-[#080808]">
              <div className="flex-none p-6 border-b-2 border-white/10">
                <div className="flex justify-between items-center mb-6">
                  <div className="flex items-baseline gap-6">
                    <h2 className="text-3xl font-black text-white italic tracking-tighter uppercase">{cat.type}</h2>
                    <div className="flex items-center gap-3">
                      <span className="text-[10px] opacity-40 uppercase font-bold tracking-widest">Global_Weight:</span>
                      <input
                        type="number"
                        value={cat.weight}
                        onChange={(e) => {
                          const newCfg = [...config];
                          newCfg[catIdx].weight = parseInt(e.target.value) || 0;
                          setConfig(newCfg);
                        }}
                        className="bg-black border border-white/40 p-1 w-20 text-center text-[#F7931A] font-bold focus:border-[#F7931A] outline-none"
                      />
                    </div>
                  </div>
                  <button
                    onClick={() => addNewItem(catIdx, cat.type)}
                    className="border-2 border-green-500 text-green-500 px-6 py-2 text-xs font-black hover:bg-green-500 hover:text-black transition-all uppercase"
                  >
                    [+] ADD_ENTRY
                  </button>
                </div>

                <div className="grid grid-cols-12 gap-4 px-3 text-[10px] opacity-40 uppercase font-black tracking-widest">
                  <div className="col-span-3">Item_Identity</div>
                  <div className="col-span-1 text-center">WGT</div>
                  <div className="col-span-1 text-center">MIN</div>
                  <div className="col-span-1 text-center">MAX</div>
                  <div className="col-span-5">Data_Payload_Description</div>
                  <div className="col-span-1 text-right">Term</div>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto p-4 space-y-2 custom-scrollbar">
                {cat.items.map((item, itemIdx) => (
                  <div key={item.id} className="grid grid-cols-12 gap-4 bg-white/5 p-3 border border-white/5 items-center hover:bg-white/10 transition-colors group">
                    <div className="col-span-3">
                      <input
                        type="text"
                        value={item.name}
                        onChange={(e) => updateItem(catIdx, itemIdx, 'name', e.target.value)}
                        className="bg-transparent border-b border-white/10 w-full text-xs font-bold text-white focus:border-[#F7931A] outline-none"
                      />
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        value={item.weight}
                        onChange={(e) => updateItem(catIdx, itemIdx, 'weight', parseInt(e.target.value) || 0)}
                        className="bg-transparent border-b border-white/10 w-full text-center text-xs text-[#F7931A] outline-none font-bold"
                      />
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        value={item.minStat}
                        onChange={(e) => updateItem(catIdx, itemIdx, 'minStat', parseInt(e.target.value) || 0)}
                        className="bg-transparent border-b border-white/10 w-full text-center text-xs outline-none"
                      />
                    </div>
                    <div className="col-span-1">
                      <input
                        type="number"
                        value={item.maxStat}
                        onChange={(e) => updateItem(catIdx, itemIdx, 'maxStat', parseInt(e.target.value) || 0)}
                        className="bg-transparent border-b border-white/10 w-full text-center text-xs outline-none"
                      />
                    </div>
                    <div className="col-span-5">
                      <input
                        type="text"
                        value={item.description}
                        onChange={(e) => updateItem(catIdx, itemIdx, 'description', e.target.value)}
                        className="bg-transparent border-b border-white/10 w-full text-[10px] opacity-70 italic outline-none truncate"
                      />
                    </div>
                    <div className="col-span-1 text-right">
                      <button
                        onClick={() => removeItem(catIdx, itemIdx)}
                        className="text-[#F7931A] opacity-20 group-hover:opacity-100 font-bold hover:bg-[#F7931A] hover:text-white px-3 py-1 transition-all"
                      >
                        [X]
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="flex-none bg-black border-t-4 border-white p-10">
        <div className="max-w-6xl mx-auto">
          <button
            onClick={saveConfig}
            className="w-full bg-[#F7931A] text-white py-6 text-2xl font-black hover:bg-white hover:text-black transition-all shadow-[10px_10px_0px_rgba(255,255,255,0.2)] active:shadow-none active:translate-x-1 active:translate-y-1 border-2 border-white"
          >
            COMMIT_CHANGES_TO_CENTRAL_CORE
          </button>
        </div>
      </div>
    </div>
  );
};
