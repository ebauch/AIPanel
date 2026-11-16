import type {
  ChatMessage,
  DebateModelInfo,
  ReasoningEffort,
  TokenUsage,
} from "../types";

/**
 * "api" bills per token (OpenRouter); "subscription" runs through a logged-in
 * CLI (Claude Max via `claude`, ChatGPT Pro via `codex`) and has no per-call $.
 */
export type ProviderKind = "api" | "subscription";

export interface ProviderStatus {
  /** ready = usable now; missing = not set up (no key / no CLI / logged out); error = check failed. */
  state: "ready" | "missing" | "error";
  detail: string;
}

/** Per-request context: things that come from the HTTP request, not the provider. */
export interface ProviderContext {
  /** The caller's OpenRouter key (header) or the server's env key. */
  openRouterApiKey?: string;
}

export interface StreamRequest {
  /** Provider-local model id (no `provider:` prefix). */
  model: string;
  messages: ChatMessage[];
  reasoningEffort?: ReasoningEffort;
  /** Explicit per-model effort from the settings store; wins over reasoningEffort. */
  effort?: string;
  modelInfo?: DebateModelInfo;
  responseFormatJson?: boolean;
  signal?: AbortSignal;
}

export type StreamChunk =
  | { type: "delta"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "activity"; message: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "error"; message: string; retryable: boolean };

export interface OfferedModel {
  /** Provider-local id. */
  id: string;
  displayName: string;
}

export interface ModelProvider {
  id: string;
  label: string;
  kind: ProviderKind;
  /** Valid values for a model's `effort` setting (empty = not configurable). */
  efforts: readonly string[];
  isConfigured(ctx: ProviderContext): Promise<ProviderStatus>;
  /** Models this provider can offer in Settings → "add model". */
  listOfferedModels(ctx: ProviderContext): Promise<OfferedModel[]>;
  /**
   * Picker entries. `enabled` are this provider's entries from the settings
   * store (provider-local ids); providers decide how to merge them.
   */
  listModels(
    ctx: ProviderContext,
    enabled: EnabledModelEntry[],
  ): Promise<{ models: DebateModelInfo[]; error?: string }>;
  /**
   * Stream one completion. Ends after a `usage` chunk, or after a single
   * `error` chunk. Throws a DOMException("AbortError") when `signal` aborts.
   */
  stream(req: StreamRequest, ctx: ProviderContext): AsyncIterable<StreamChunk>;
}

/** One enabled model in the settings store, split into provider + local id. */
export interface EnabledModelEntry {
  model: string;
  label: string;
  effort?: string;
}

export class ProviderError extends Error {
  retryable: boolean;

  constructor(message: string, options: { retryable: boolean }) {
    super(message);
    this.name = "ProviderError";
    this.retryable = options.retryable;
  }
}

export function abortError(): DOMException {
  return new DOMException("Aborted", "AbortError");
}

export function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}

/**
 * Drain a provider stream into callbacks and return the final text + usage.
 * An `error` chunk becomes a thrown ProviderError so callers keep the
 * try/catch shape they had with streamChatCompletion.
 */
export async function collectStream(
  chunks: AsyncIterable<StreamChunk>,
  callbacks: {
    onToken?: (text: string) => void;
    onReasoning?: (text: string) => void;
    onActivity?: (message: string) => void;
  } = {},
): Promise<{ text: string; usage: TokenUsage | null }> {
  let text = "";
  let usage: TokenUsage | null = null;
  for await (const chunk of chunks) {
    switch (chunk.type) {
      case "delta":
        text += chunk.text;
        callbacks.onToken?.(chunk.text);
        break;
      case "reasoning":
        callbacks.onReasoning?.(chunk.text);
        break;
      case "activity":
        callbacks.onActivity?.(chunk.message);
        break;
      case "usage":
        usage = chunk.usage;
        break;
      case "error":
        throw new ProviderError(chunk.message, { retryable: chunk.retryable });
    }
  }
  return { text, usage };
}
