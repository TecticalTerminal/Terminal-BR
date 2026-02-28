
import React, { useEffect, useState } from 'react';
import { useGame } from '../context/GameContext';

const DEFAULT_SYSTEM_PROMPT_ZH = `你是 Terminal Survival 的战术代理协调器。
目标优先级（从高到低）：
1) 生存优先：避免死亡，保持 HP/Hunger/Thirst 在安全区间。
2) 稳定收益：在安全前提下搜索、拾取、装备，提升跨局资产结转价值。
3) 风险控制：非必要不硬拼；资源不足时优先补给或脱离危险格。

执行约束：
- 你只能在候选动作中选择一个动作，禁止输出候选外动作。
- 若处于高风险（低血/低饥饿/低口渴/危险区域），优先保命与撤离。
- 同格遭遇时，仅在胜算明显时攻击，否则规避或续命。
- 当收益与风险相近时，选择更稳健的动作。`;

const DEFAULT_SYSTEM_PROMPT_EN = `You are the tactical coordinator for Terminal Survival.
Priorities (high to low):
1) Survival first: avoid death; keep HP/Hunger/Thirst in safe ranges.
2) Stable gains: when safe, search/loot/equip to improve cross-round carry value.
3) Risk control: avoid unnecessary fights; recover resources before taking risks.

Execution constraints:
- Choose exactly one action from provided candidates; never invent actions.
- Under high risk (low HP/Hunger/Thirst or danger zone), prioritize survival/escape.
- Attack only with clear advantage in same-cell encounters; otherwise disengage or recover.
- If options are close, choose the safer action.`;

export const AgentSetupModal: React.FC = () => {
  const { dispatch, state, mode, onlineError } = useGame();
  const [prompt, setPrompt] = useState(() =>
    state.language === 'zh' ? DEFAULT_SYSTEM_PROMPT_ZH : DEFAULT_SYSTEM_PROMPT_EN
  );
  const [humanControlMode, setHumanControlMode] = useState<'manual' | 'managed'>('managed');
  const [managedUserPrompt, setManagedUserPrompt] = useState('');
  const matrixUserPrompt = state.players.find((player) => !player.isAi)?.agent?.prompt?.trim() ?? '';

  useEffect(() => {
    if (humanControlMode !== 'managed') return;
    setManagedUserPrompt((previous) => (previous.trim() ? previous : matrixUserPrompt));
  }, [humanControlMode, matrixUserPrompt]);

  const handleStart = () => {
    const managedOverride =
      humanControlMode === 'managed' && managedUserPrompt.trim() ? managedUserPrompt.trim() : null;
    dispatch({ 
      type: 'INIT_AGENT', 
      payload: {
        systemPrompt: prompt,
        apiKey: '',
        humanControlMode,
        managedUserPromptOverride: managedOverride
      } 
    });
  };

  const t = {
    zh: {
      TITLE: "初始化 AI 代理",
      SUBTITLE: "配置神经链路参数 // NEURAL_LINK_CONFIG",
      PROMPT_LABEL: "系统指令 (PROMPT)",
      CONTROL_MODE_LABEL: "人类控制模式 (HUMAN_CONTROL_MODE)",
      MODE_MANUAL: "手动模式 (MANUAL)",
      MODE_MANAGED: "托管模式 (MANAGED)",
      MODE_MANUAL_DESC: "人类可通过 COMMAND_MATRIX 手动操作。",
      MODE_MANAGED_DESC: "人类回合自动托管，COMMAND_MATRIX 禁用。",
      MANAGED_USER_PROMPT_LABEL: "托管 User 快捷提示词（覆盖矩阵配置）",
      MANAGED_USER_PROMPT_DESC: "仅托管模式生效；留空时将回退矩阵中的 User 提示词。",
      MATRIX_USER_PROMPT: "矩阵 User 提示词",
      MANAGED_USER_PROMPT_PLACEHOLDER: "输入托管 User 提示词（本局覆盖）",
      BTN_CREATE: "创建 AI AGENT",
    },
    en: {
      TITLE: "INITIALIZE AI AGENT",
      SUBTITLE: "CONFIGURE NEURAL LINK // NEURAL_LINK_CONFIG",
      PROMPT_LABEL: "SYSTEM PROMPT",
      CONTROL_MODE_LABEL: "HUMAN CONTROL MODE",
      MODE_MANUAL: "MANUAL",
      MODE_MANAGED: "MANAGED",
      MODE_MANUAL_DESC: "Human can control via COMMAND_MATRIX.",
      MODE_MANAGED_DESC: "Human turn is managed automatically; COMMAND_MATRIX disabled.",
      MANAGED_USER_PROMPT_LABEL: "Managed User Quick Prompt (override matrix prompt)",
      MANAGED_USER_PROMPT_DESC: "Only for managed mode; empty uses matrix user prompt.",
      MATRIX_USER_PROMPT: "Matrix User Prompt",
      MANAGED_USER_PROMPT_PLACEHOLDER: "Input managed user prompt for this run",
      BTN_CREATE: "CREATE AI AGENT",
    }
  }[state.language];

  return (
    <div className="fixed inset-0 bg-[#050505] z-[200] flex items-center justify-center p-6 animate-in fade-in duration-500">
      {/* 背景网格装饰 */}
      <div className="absolute inset-0 pointer-events-none opacity-10 bg-[linear-gradient(rgba(0,255,0,0.1)_1px,transparent_1px),linear-gradient(90deg,rgba(0,255,0,0.1)_1px,transparent_1px)] bg-[size:40px_40px]" />

      <div className="w-full max-w-2xl bg-black border-4 border-[#F7931A] p-10 relative shadow-[0_0_50px_rgba(247,147,26,0.15)] flex flex-col gap-8">
        
        {/* 标题区 */}
        <div className="border-b-2 border-white/20 pb-4">
          <h1 className="text-4xl font-black italic text-[#F7931A] uppercase tracking-tighter text-glow mb-2">
            {t.TITLE}
          </h1>
          <p className="text-xs uppercase font-bold tracking-[0.4em] opacity-50">
            {t.SUBTITLE}
          </p>
        </div>

        {/* 表单区 */}
        <div className="space-y-6">
          <div className="space-y-2">
            <label className="block text-sm font-black uppercase tracking-widest text-white/80">
              {t.PROMPT_LABEL}
            </label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              className="w-full h-32 bg-[#080808] border-2 border-white/30 p-4 text-white font-mono focus:border-[#F7931A] focus:outline-none focus:shadow-[0_0_15px_rgba(247,147,26,0.2)] transition-all resize-none text-sm leading-relaxed"
            />
          </div>

          <div className="space-y-2">
            <label className="block text-sm font-black uppercase tracking-widest text-white/80">
              {t.CONTROL_MODE_LABEL}
            </label>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setHumanControlMode('manual')}
                className={`border-2 px-3 py-3 text-left transition-all ${
                  humanControlMode === 'manual'
                    ? 'border-[#00FF41] bg-[#00FF41]/10 text-[#00FF41]'
                    : 'border-white/30 text-white/80 hover:border-white/60'
                }`}
              >
                <div className="text-xs font-black uppercase tracking-[0.12em]">{t.MODE_MANUAL}</div>
                <div className="text-[10px] opacity-70 mt-1 uppercase tracking-[0.08em]">{t.MODE_MANUAL_DESC}</div>
              </button>
              <button
                type="button"
                onClick={() => setHumanControlMode('managed')}
                className={`border-2 px-3 py-3 text-left transition-all ${
                  humanControlMode === 'managed'
                    ? 'border-[#F7931A] bg-[#F7931A]/10 text-[#F7931A]'
                    : 'border-white/30 text-white/80 hover:border-white/60'
                }`}
              >
                <div className="text-xs font-black uppercase tracking-[0.12em]">{t.MODE_MANAGED}</div>
                <div className="text-[10px] opacity-70 mt-1 uppercase tracking-[0.08em]">{t.MODE_MANAGED_DESC}</div>
              </button>
            </div>
          </div>

          {humanControlMode === 'managed' && (
            <div className="space-y-2">
              <label className="block text-sm font-black uppercase tracking-widest text-white/80">
                {t.MANAGED_USER_PROMPT_LABEL}
              </label>
              <p className="text-[10px] uppercase tracking-[0.08em] opacity-60">{t.MANAGED_USER_PROMPT_DESC}</p>
              <textarea
                value={managedUserPrompt}
                onChange={(e) => setManagedUserPrompt(e.target.value)}
                placeholder={t.MANAGED_USER_PROMPT_PLACEHOLDER}
                className="w-full h-24 bg-[#080808] border-2 border-white/30 p-3 text-white font-mono focus:border-[#00FF41] focus:outline-none transition-all resize-none text-xs leading-relaxed"
              />
              <div className="text-[10px] uppercase tracking-[0.08em] opacity-50 break-all">
                {t.MATRIX_USER_PROMPT}: {matrixUserPrompt || '-'}
              </div>
            </div>
          )}
        </div>

        {/* 按钮区 */}
        <div className="pt-4 border-t border-white/10">
          {mode === 'online' && onlineError && (
            <div className="mb-4 border border-red-500/60 bg-red-500/10 px-3 py-2 text-[10px] font-black uppercase tracking-[0.12em] text-red-300">
              {onlineError}
            </div>
          )}
          <button
            onClick={handleStart}
            className="w-full py-5 bg-white text-black text-xl font-black uppercase tracking-widest hover:bg-[#F7931A] hover:text-white transition-all shadow-[8px_8px_0px_rgba(255,255,255,0.1)] active:translate-y-1 active:shadow-none"
          >
            {t.BTN_CREATE}
          </button>
        </div>

      </div>
    </div>
  );
};
