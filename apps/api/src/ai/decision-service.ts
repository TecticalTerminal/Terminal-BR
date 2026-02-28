import type { GameAction, GameState } from '@tactical/shared-types';
import { env } from '../config.js';
import {
  buildAiActionCandidates,
  buildStateSummary,
  fallbackRuleAction
} from './candidate-actions.js';
import { OpenRouterClient, OpenRouterError } from './openrouter-client.js';

export interface AiDecisionService {
  decide(state: GameState, aiId: string): Promise<GameAction>;
}

function resolvePolicyPrompt(state: GameState, aiId: string): string | null {
  const actor = state.players.find((player) => player.id === aiId) ?? null;
  const globalPrompt = state.aiConfig?.systemPrompt?.trim() ?? '';
  let actorPrompt = actor?.agent?.prompt?.trim() ?? '';

  if (actor && !actor.isAi && state.aiConfig?.humanControlMode === 'managed') {
    const managedOverride = state.aiConfig.managedUserPromptOverride?.trim() ?? '';
    if (managedOverride) {
      actorPrompt = managedOverride;
    }
  }

  const segments: string[] = [];
  if (globalPrompt) {
    segments.push(`Global strategy:\n${globalPrompt}`);
  }
  if (actorPrompt) {
    segments.push(`Agent strategy:\n${actorPrompt}`);
  }
  if (!segments.length) return null;
  return segments.join('\n\n');
}

function aiDebug(event: string, payload: Record<string, unknown>) {
  if (!env.AI_DEBUG) return;
  // Keep logs JSON-shaped for easier grep/analysis in dev and staging.
  // eslint-disable-next-line no-console
  console.info(
    `[ai-debug] ${JSON.stringify({
      event,
      provider: env.AI_PROVIDER,
      ...payload
    })}`
  );
}

class RulesAiDecisionService implements AiDecisionService {
  async decide(state: GameState, aiId: string): Promise<GameAction> {
    const action = fallbackRuleAction(state, aiId);
    aiDebug('decision.rules', {
      aiId,
      turnCount: state.turnCount,
      actionType: action.type
    });
    return action;
  }
}

class OpenRouterAiDecisionService implements AiDecisionService {
  private static unavailableUntilMs = 0;
  private readonly client: OpenRouterClient;
  private readonly fallbackRules: boolean;
  private readonly cooldownMs: number;

  constructor() {
    this.client = new OpenRouterClient({
      apiKey: env.OPENROUTER_API_KEY!,
      model: env.OPENROUTER_MODEL!,
      baseUrl: env.OPENROUTER_BASE_URL,
      timeoutMs: env.AI_TIMEOUT_MS,
      maxRetries: env.AI_OPENROUTER_MAX_RETRIES,
      retryBaseDelayMs: env.AI_OPENROUTER_RETRY_BASE_DELAY_MS,
      siteUrl: env.OPENROUTER_SITE_URL,
      appName: env.OPENROUTER_APP_NAME
    });
    this.fallbackRules = env.AI_FALLBACK_RULES;
    this.cooldownMs = env.AI_OPENROUTER_COOLDOWN_MS;
  }

  private chooseById(
    candidates: ReturnType<typeof buildAiActionCandidates>,
    choiceId: string
  ): GameAction | null {
    const normalized = choiceId.trim();
    if (!normalized) return null;

    const exact = candidates.find((candidate) => candidate.id === normalized);
    if (exact) return exact.action;

    const lowered = normalized.toLowerCase();
    const caseInsensitive = candidates.find((candidate) => candidate.id.toLowerCase() === lowered);
    return caseInsensitive?.action ?? null;
  }

  async decide(state: GameState, aiId: string): Promise<GameAction> {
    const candidates = buildAiActionCandidates(state, aiId);
    if (!candidates.length) {
      const action = fallbackRuleAction(state, aiId);
      aiDebug('decision.openrouter.no_candidates', {
        aiId,
        turnCount: state.turnCount,
        actionType: action.type
      });
      return action;
    }

    const startedAt = Date.now();
    const now = Date.now();
    if (OpenRouterAiDecisionService.unavailableUntilMs > now) {
      const cooldownRemainingMs = OpenRouterAiDecisionService.unavailableUntilMs - now;
      if (this.fallbackRules) {
        const fallbackAction = fallbackRuleAction(state, aiId);
        aiDebug('decision.openrouter.circuit_open', {
          aiId,
          turnCount: state.turnCount,
          cooldownRemainingMs,
          fallbackActionType: fallbackAction.type
        });
        return fallbackAction;
      }
      throw new Error(
        `AI decision failed with OpenRouter: provider is cooling down (${cooldownRemainingMs}ms remaining)`
      );
    }

    try {
      const result = await this.client.chooseAction({
        aiId,
        stateSummary: buildStateSummary(state, aiId),
        policyPrompt: resolvePolicyPrompt(state, aiId),
        candidates: candidates.map((candidate) => ({
          id: candidate.id,
          label: candidate.label
        }))
      });
      const chosenAction = this.chooseById(candidates, result.choiceId);
      if (!chosenAction) {
        throw new Error(`LLM returned unsupported choiceId: ${result.choiceId}`);
      }
      OpenRouterAiDecisionService.unavailableUntilMs = 0;
      aiDebug('decision.openrouter.success', {
        aiId,
        turnCount: state.turnCount,
        candidateCount: candidates.length,
        choiceId: result.choiceId,
        actionType: chosenAction.type,
        elapsedMs: Date.now() - startedAt
      });
      return chosenAction;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown error';
      const isRetryableProviderError = error instanceof OpenRouterError && error.retryable;
      const zodIssues =
        error instanceof OpenRouterError && Array.isArray(error.details?.zodIssues)
          ? (error.details.zodIssues as string[])
          : undefined;
      if (isRetryableProviderError) {
        OpenRouterAiDecisionService.unavailableUntilMs = Date.now() + this.cooldownMs;
      }
      if (this.fallbackRules) {
        const fallbackAction = fallbackRuleAction(state, aiId);
        aiDebug('decision.openrouter.fallback_rules', {
          aiId,
          turnCount: state.turnCount,
          candidateCount: candidates.length,
          fallbackActionType: fallbackAction.type,
          error: message,
          retryable: isRetryableProviderError,
          zodIssues,
          elapsedMs: Date.now() - startedAt
        });
        return fallbackAction;
      }
      aiDebug('decision.openrouter.failed', {
        aiId,
        turnCount: state.turnCount,
        candidateCount: candidates.length,
        error: message,
        retryable: isRetryableProviderError,
        zodIssues,
        elapsedMs: Date.now() - startedAt
      });
      throw new Error(`AI decision failed with OpenRouter: ${message}`);
    }
  }
}

export function createAiDecisionService(): AiDecisionService {
  if (env.AI_PROVIDER === 'openrouter') {
    return new OpenRouterAiDecisionService();
  }
  return new RulesAiDecisionService();
}
