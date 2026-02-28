import { z } from 'zod';

export interface OpenRouterCandidateView {
  id: string;
  label: string;
}

export interface OpenRouterChoiceResponse {
  choiceId: string;
  reason?: string;
  raw: string;
}

export interface OpenRouterClientInput {
  aiId: string;
  stateSummary: unknown;
  candidates: OpenRouterCandidateView[];
  policyPrompt?: string | null;
}

interface OpenRouterClientOptions {
  apiKey: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
  maxRetries: number;
  retryBaseDelayMs: number;
  siteUrl?: string;
  appName?: string;
}

interface ChatCompletionChoice {
  message?: {
    content?: string | Array<{ type?: string; text?: string }>;
  };
}

interface ChatCompletionResponse {
  choices?: ChatCompletionChoice[];
  error?: { message?: string };
}

const openRouterChoiceSchema = z
  .object({
    choiceId: z.string().trim().min(1, 'choiceId is required'),
    reason: z.string().trim().min(1).max(400).optional()
  })
  .strict();

function summarizeZodIssues(issues: z.ZodIssue[]): string[] {
  return issues.slice(0, 6).map((issue) => {
    const path = issue.path.length ? issue.path.join('.') : '$';
    return `${path}: ${issue.message}`;
  });
}

function extractMessageContent(response: ChatCompletionResponse): string {
  const rawContent = response.choices?.[0]?.message?.content;
  if (typeof rawContent === 'string') return rawContent;
  if (!Array.isArray(rawContent)) return '';
  return rawContent
    .map((part) => (typeof part.text === 'string' ? part.text : ''))
    .join('')
    .trim();
}

function stripCodeFence(content: string): string {
  const trimmed = content.trim();
  const fenceMatch = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  return trimmed;
}

function parseJsonSafely(raw: string): unknown | null {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function extractJsonObjectSnippet(raw: string): string | null {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start, end + 1);
}

function parseChoice(content: string): {
  choice: Pick<OpenRouterChoiceResponse, 'choiceId' | 'reason'> | null;
  zodIssues?: string[];
} {
  const normalized = stripCodeFence(content);
  const attempts: string[] = [normalized];
  const snippet = extractJsonObjectSnippet(normalized);
  if (snippet && snippet !== normalized) attempts.push(snippet);
  let lastZodIssues: string[] | undefined;

  for (const attempt of attempts) {
    const parsed = parseJsonSafely(attempt);
    if (!parsed) continue;
    const validated = openRouterChoiceSchema.safeParse(parsed);
    if (!validated.success) {
      lastZodIssues = summarizeZodIssues(validated.error.issues);
      continue;
    }
    return { choice: validated.data };
  }

  return {
    choice: null,
    zodIssues: lastZodIssues
  };
}

export class OpenRouterClient {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryBaseDelayMs: number;
  private readonly siteUrl?: string;
  private readonly appName?: string;

  constructor(options: OpenRouterClientOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model;
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.timeoutMs = options.timeoutMs;
    this.maxRetries = options.maxRetries;
    this.retryBaseDelayMs = options.retryBaseDelayMs;
    this.siteUrl = options.siteUrl;
    this.appName = options.appName;
  }

  private async sleep(ms: number): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private getRetryDelayMs(attempt: number): number {
    const exponential = this.retryBaseDelayMs * Math.pow(2, attempt - 1);
    const jitter = Math.floor(Math.random() * 101);
    return exponential + jitter;
  }

  private async chooseActionOnce(input: OpenRouterClientInput): Promise<OpenRouterChoiceResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const guidance = input.policyPrompt?.trim();
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          ...(this.siteUrl ? { 'HTTP-Referer': this.siteUrl } : {}),
          ...(this.appName ? { 'X-Title': this.appName } : {})
        },
        body: JSON.stringify({
          model: this.model,
          temperature: 0.1,
          max_tokens: 120,
          messages: [
            {
              role: 'system',
              content:
                'You are the tactical game AI. Pick exactly one candidate action id from the provided list. Return JSON only: {"choiceId":"<id>","reason":"<short reason>"}'
            },
            ...(guidance
              ? [
                  {
                    role: 'system' as const,
                    content: `Agent strategy guidance:\n${guidance}`
                  }
                ]
              : []),
            {
              role: 'user',
              content: JSON.stringify({
                aiId: input.aiId,
                state: input.stateSummary,
                candidates: input.candidates
              })
            }
          ]
        }),
        signal: controller.signal
      });

      const rawText = await response.text();
      let parsedResponse: ChatCompletionResponse = {};
      try {
        parsedResponse = JSON.parse(rawText) as ChatCompletionResponse;
      } catch {
        // Keep fallback error handling below.
      }

      if (!response.ok) {
        const providerError = parsedResponse.error?.message;
        const detail = providerError || rawText || `HTTP ${response.status}`;
        const retryable = response.status === 429 || (response.status >= 500 && response.status <= 599);
        throw new OpenRouterError(`OpenRouter request failed: ${detail}`, {
          retryable,
          statusCode: response.status
        });
      }

      const content = extractMessageContent(parsedResponse);
      if (!content) {
        throw new Error('OpenRouter returned empty message content.');
      }

      const parsedChoice = parseChoice(content);
      if (!parsedChoice.choice) {
        throw new OpenRouterError(`Failed to parse LLM choice payload: ${content}`, {
          retryable: false,
          details: {
            zodIssues: parsedChoice.zodIssues
          }
        });
      }

      return {
        choiceId: parsedChoice.choice.choiceId,
        reason: parsedChoice.choice.reason,
        raw: content
      };
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new OpenRouterError(`OpenRouter request timed out after ${this.timeoutMs}ms`, {
          retryable: true
        });
      }
      if (error instanceof OpenRouterError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : 'unknown error';
      throw new OpenRouterError(`OpenRouter request failed: ${message}`, {
        retryable: true
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async chooseAction(input: OpenRouterClientInput): Promise<OpenRouterChoiceResponse> {
    const maxAttempts = this.maxRetries + 1;
    let lastError: OpenRouterError | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        return await this.chooseActionOnce(input);
      } catch (error) {
        if (!(error instanceof OpenRouterError)) {
          throw error;
        }
        lastError = error;

        const canRetry = error.retryable && attempt < maxAttempts;
        if (!canRetry) {
          throw error;
        }
        await this.sleep(this.getRetryDelayMs(attempt));
      }
    }

    throw lastError ?? new OpenRouterError('OpenRouter request failed', { retryable: true });
  }
}

export class OpenRouterError extends Error {
  readonly retryable: boolean;
  readonly statusCode?: number;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    input: {
      retryable: boolean;
      statusCode?: number;
      details?: Record<string, unknown>;
    }
  ) {
    super(message);
    this.name = 'OpenRouterError';
    this.retryable = input.retryable;
    this.statusCode = input.statusCode;
    this.details = input.details;
  }
}
