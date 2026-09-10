import type { ChatMessage, ReasoningEffort, TokenUsage } from "./types";

export const OPENROUTER_BASE = "https://openrouter.ai/api/v1";

const HTTP_REFERER = "https://github.com/ebauch/AIPanel";
const APP_TITLE = "AI Panel";
const CALL_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_ATTEMPTS = 3;
const RATE_LIMIT_MAX_ATTEMPTS = 5;
const RATE_LIMIT_DELAYS_MS = [10_000, 20_000, 40_000, 60_000];
const DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
const RETRY_DELAYS_MS = [3_000, 6_000];

export class OpenRouterError extends Error {
  retryable: boolean;
  status?: number;

  constructor(message: string, options: { retryable: boolean; status?: number }) {
    super(message);
    this.name = "OpenRouterError";
    this.retryable = options.retryable;
    this.status = options.status;
  }
}

export interface OpenRouterModel {
  id: string;
  name: string;
  description?: string;
  created: number;
  context_length: number;
  pricing: {
    prompt: string;
    completion: string;
    [key: string]: string | undefined;
  };
  supported_parameters?: string[];
}

/**
 * Resolve the OpenRouter API key to use for a request: the caller's own key
 * (sent from the browser, stored in localStorage) takes priority over the
 * server's shared key from the environment.
 */
export function resolveApiKey(request?: Request): string | undefined {
  const headerKey = request?.headers.get("x-openrouter-key")?.trim();
  if (headerKey) {
    return headerKey;
  }
  return process.env.OPENROUTER_API_KEY;
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

async function parseErrorBody(response: Response): Promise<string> {
  try {
    const data = (await response.json()) as {
      error?: { message?: string } | string;
    };
    if (typeof data.error === "string") {
      return data.error;
    }
    if (data.error?.message) {
      return data.error.message;
    }
  } catch {
    // Fall through to a generic message below.
  }
  return `OpenRouter request failed (${response.status})`;
}

export async function listModels(
  apiKey?: string,
): Promise<OpenRouterModel[]> {
  const headers: Record<string, string> = {};
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(`${OPENROUTER_BASE}/models`, { headers });

  if (!response.ok) {
    const message = await parseErrorBody(response);
    throw new OpenRouterError(message, {
      retryable: isRetryableStatus(response.status),
      status: response.status,
    });
  }

  const data = (await response.json()) as { data: OpenRouterModel[] };
  return data.data ?? [];
}

interface StreamChatCompletionOptions {
  apiKey: string;
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  supportsReasoningEffort?: boolean;
  responseFormatJson?: boolean;
  /** Output cap sent as max_tokens. Keeps OpenRouter's affordability precheck realistic and bounds runaway turns. */
  maxTokens?: number;
  signal?: AbortSignal;
  onToken?: (text: string) => void;
  onReasoning?: (text: string) => void;
  /** Called before each retry wait so callers can show progress. */
  onRetry?: (info: {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    rateLimited: boolean;
    message: string;
  }) => void;
}

interface StreamChatCompletionResult {
  text: string;
  usage: TokenUsage | null;
}

function mapReasoningEffort(effort: ReasoningEffort): "medium" | "high" {
  return effort === "high" ? "high" : "medium";
}

async function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      },
      { once: true },
    );
  });
}

async function performStreamAttempt(
  options: StreamChatCompletionOptions,
): Promise<StreamChatCompletionResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), CALL_TIMEOUT_MS);

  const onExternalAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onExternalAbort, { once: true });

  const body: Record<string, unknown> = {
    model: options.model,
    messages: options.messages,
    stream: true,
    usage: { include: true },
    max_tokens: options.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
  };

  if (options.reasoningEffort && options.supportsReasoningEffort) {
    body.reasoning = { effort: mapReasoningEffort(options.reasoningEffort) };
  }

  if (options.responseFormatJson) {
    body.response_format = { type: "json_object" };
  }

  try {
    const response = await fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        "HTTP-Referer": HTTP_REFERER,
        "X-Title": APP_TITLE,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const message = await parseErrorBody(response);
      throw new OpenRouterError(message, {
        retryable: isRetryableStatus(response.status),
        status: response.status,
      });
    }

    if (!response.body) {
      throw new OpenRouterError("OpenRouter response had no body.", {
        retryable: true,
      });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let text = "";
    let usage: TokenUsage | null = null;
    let sawAnyToken = false;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line || line.startsWith(":")) {
            continue;
          }
          if (!line.startsWith("data: ")) {
            continue;
          }
          const payload = line.slice(6).trim();
          if (payload === "[DONE]") {
            continue;
          }

          let chunk: {
            choices?: Array<{
              delta?: { content?: string; reasoning?: string };
              finish_reason?: string | null;
            }>;
            usage?: {
              prompt_tokens?: number;
              completion_tokens?: number;
              cost?: number;
              prompt_tokens_details?: {
                cached_tokens?: number;
                cache_write_tokens?: number;
              };
            };
            error?: { message?: string };
          };

          try {
            chunk = JSON.parse(payload);
          } catch {
            continue;
          }

          if (chunk.error?.message) {
            throw new OpenRouterError(chunk.error.message, {
              retryable: sawAnyToken ? false : true,
            });
          }

          const delta = chunk.choices?.[0]?.delta;
          if (delta?.reasoning) {
            options.onReasoning?.(delta.reasoning);
          }
          if (delta?.content) {
            sawAnyToken = true;
            text += delta.content;
            options.onToken?.(delta.content);
          }

          if (chunk.usage) {
            const details = chunk.usage.prompt_tokens_details;
            usage = {
              promptTokens: chunk.usage.prompt_tokens ?? 0,
              completionTokens: chunk.usage.completion_tokens ?? 0,
              cost: typeof chunk.usage.cost === "number" ? chunk.usage.cost : null,
              cachedTokens:
                typeof details?.cached_tokens === "number"
                  ? details.cached_tokens
                  : undefined,
              cacheWriteTokens:
                typeof details?.cache_write_tokens === "number"
                  ? details.cache_write_tokens
                  : undefined,
            };
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    return { text, usage };
  } catch (err) {
    if (err instanceof OpenRouterError) {
      throw err;
    }
    if (err instanceof DOMException && err.name === "AbortError") {
      if (options.signal?.aborted) {
        throw err;
      }
      throw new OpenRouterError(
        `Request timed out after ${CALL_TIMEOUT_MS / 60_000} minutes.`,
        { retryable: true },
      );
    }
    throw new OpenRouterError(
      err instanceof Error ? err.message : "Network error contacting OpenRouter.",
      { retryable: true },
    );
  } finally {
    clearTimeout(timeoutId);
    options.signal?.removeEventListener("abort", onExternalAbort);
  }
}

export async function streamChatCompletion(
  options: StreamChatCompletionOptions,
): Promise<StreamChatCompletionResult> {
  let lastError: unknown;
  let attempt = 0;

  while (true) {
    attempt += 1;

    if (options.signal?.aborted) {
      throw new DOMException("Aborted", "AbortError");
    }

    let sawToken = false;
    const wrappedOnToken = (text: string) => {
      sawToken = true;
      options.onToken?.(text);
    };

    try {
      return await performStreamAttempt({ ...options, onToken: wrappedOnToken });
    } catch (err) {
      lastError = err;

      if (err instanceof DOMException && err.name === "AbortError") {
        throw err;
      }

      const retryable = err instanceof OpenRouterError ? err.retryable : true;
      const rateLimited = err instanceof OpenRouterError && err.status === 429;
      const maxAttempts = rateLimited ? RATE_LIMIT_MAX_ATTEMPTS : MAX_ATTEMPTS;
      const delays = rateLimited ? RATE_LIMIT_DELAYS_MS : RETRY_DELAYS_MS;

      if (!retryable || sawToken || attempt >= maxAttempts) {
        throw err;
      }

      const delayMs = delays[attempt - 1] ?? delays[delays.length - 1];
      options.onRetry?.({
        attempt,
        maxAttempts,
        delayMs,
        rateLimited,
        message: err instanceof Error ? err.message : String(err),
      });
      await sleep(delayMs, options.signal);
    }
  }

  // Unreachable, kept for type completeness.
  throw lastError instanceof Error
    ? lastError
    : new OpenRouterError("OpenRouter request failed.", { retryable: false });
}
