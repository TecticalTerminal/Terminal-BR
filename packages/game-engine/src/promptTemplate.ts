import { AiPersonality } from '@tactical/shared-types';

/**
 * 根据个性生成默认的 LLM Prompt 模板
 * 当用户没有自定义 prompt 时使用
 */
export function generateDefaultPromptForPersonality(personality: AiPersonality): string {
  const basePrompt = `你是 Terminal Survival 的战术代理协调器。
目标优先级（从高到低）：
1) 生存优先：避免死亡，保持 HP/Hunger/Thirst 在安全区间。
2) 稳定收益：在安全前提下搜索、拾取、装备，提升跨局资产结转价值。
3) 风险控制：非必要不硬拼；资源不足时优先补给或脱离危险格。

执行约束：
- 你只能在候选动作中选择一个动作，禁止输出候选外动作。
- 若处于高风险（低血/低饥饿/低口渴/危险区域），优先保命与撤离。
- 同格遭遇时，仅在胜算明显时攻击，否则规避或续命。
- 当收益与风险相近时，选择更稳健的动作。`;

  const personalityModifiers: Record<AiPersonality, string> = {
    AGGRESSIVE: `
【个性修正：激进战士】
- 行为风格：主动出击，积极寻找并消灭敌人
- 风险偏好：较高，愿意为优势资源承担风险
- 战斗策略：HP > 30 时优先攻击敌人，追击范围 3 格
- 搜集策略：次于战斗，仅在安全时搜索`,

    CAUTIOUS: `
【个性修正：谨慎生存】
- 行为风格：保存实力，避免不必要的冲突
- 风险偏好：低，只在其有绝对优势时才行动
- 战斗策略：HP > 60 且有装备优势时才战斗
- 搜集策略：优先搜索物资，积累优势后再战斗`,

    EXPLORER: `
【个性修正：探索者】
- 行为风格：优先探索地图，收集资源和装备
- 风险偏好：中等，以资源积累为核心目标
- 战斗策略：HP > 40 且有武器优势时考虑战斗
- 搜集策略：极高搜索频率，优先移动到未探索区域`,

    OPPORTUNIST: `
【个性修正：投机者】
- 行为风格：灵活评估局势，在有利时出击
- 风险偏好：动态调整，根据收益/风险比决策
- 战斗策略：HP > 35 且有明显优势时战斗
- 搜集策略：根据当前状态灵活调整`,

    RANDOM: `
【个性修正：平衡策略】
- 行为风格：平衡发展，根据局势灵活应对
- 风险偏好：中等，综合评估后行动
- 战斗策略：HP > 40 且有优势时战斗
- 搜集策略：保持适度搜索，积累资源`
  };

  const modifier = personalityModifiers[personality] || personalityModifiers.RANDOM;

  return `${basePrompt}${modifier}`;
}

/**
 * 解析并翻译个性
 * - 如果是 RANDOM，随机分配一个具体个性
 * - 否则返回原个性
 */
export function resolveAiPersonality(personality: AiPersonality | 'RANDOM'): AiPersonality {
  if (personality === 'RANDOM') {
    const personalities: AiPersonality[] = ['AGGRESSIVE', 'CAUTIOUS', 'EXPLORER', 'OPPORTUNIST'];
    return personalities[Math.floor(Math.random() * personalities.length)];
  }
  return personality;
}

/**
 * 获取个性的简短描述
 */
export function getPersonalityDescription(personality: AiPersonality): string {
  const descriptions: Record<AiPersonality, string> = {
    AGGRESSIVE: '激进战士 - 主动追击，高攻击性',
    CAUTIOUS: '谨慎生存 - 保守行事，高生存优先',
    EXPLORER: '探索者 - 优先搜索，中等风险',
    OPPORTUNIST: '投机者 - 灵活决策，看情况行动',
    RANDOM: '随机 - 游戏开始时随机分配'
  };
  return descriptions[personality];
}

/**
 * 获取个性的颜色标识 (用于 UI)
 */
export function getPersonalityColor(personality: AiPersonality): string {
  const colors: Record<AiPersonality, string> = {
    AGGRESSIVE: 'text-red-400',
    CAUTIOUS: 'text-blue-400',
    EXPLORER: 'text-green-400',
    OPPORTUNIST: 'text-yellow-400',
    RANDOM: 'text-gray-400'
  };
  return colors[personality];
}
