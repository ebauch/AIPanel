// OpenRouter behind the provider interface. This is a thin adapter: the HTTP,
// retry and SSE logic stays in lib/openrouter.ts and the catalog logic in
// lib/models.ts, both unchanged, so OpenRouter debates behave exactly as
// before.
import { AsyncQueue } from "../async-queue";
import { listDebateModels } from "../models";
import { OpenRouterError, streamChatCompletion } from "../openrouter";
import type { DebateModelInfo } from "../types";
import { OPENROUTER_PROVIDER_ID } from "./model-id";
import { isAbortError, type ModelProvider, type StreamChunk } from "./types";

export const MISSING_OPENROUTER_KEY_MESSAGE =
  "No OpenRouter API key. Add one on the Settings page or set OPENROUTER_API_KEY in .env.local.";

export interface OpenRouterProviderDeps {
  listDebateModels: typeof listDebateModels;
  streamChatCompletion: typeof streamChatCompletion;
}

export function createOpenRouterProvider(
  deps: OpenRouterProviderDeps = { listDebateModels, streamChatCompletion },
): ModelProvider {
  return {
    id: OPENROUTER_PROVIDER_ID,
    label: "OpenRouter (API key, per token)",
    kind: "api",
    efforts: [],

    async isConfigured(ctx) {
      return ctx.openRouterApiKey
        ? { state: "ready", detail: "API key configured" }
        : { state: "missing", detail: "missing key: add one below or set OPENROUTER_API_KEY" };
    },

    async listOfferedModels(ctx) {
      const { models } = await deps.listDebateModels(ctx.openRouterApiKey);
      return models.map((model) => ({ id: model.id, displayName: model.displayName }));
    },

    async listModels(ctx, enabled) {
      const result = await deps.listDebateModels(ctx.openRouterApiKey);
      // The full catalog stays in the picker as before. Models enabled in
      // Settings only rename a catalog entry, or add an id the catalog lacks.
      const byId = new Map(enabled.map((entry) => [entry.model, entry]));
      const models: DebateModelInfo[] = result.models.map((model) => {
        const entry = byId.get(model.id);
        return { ...model, providerId: OPENROUTER_PROVIDER_ID, ...(entry ? { displayName: entry.label } : {}) };
      });
      const known = new Set(result.models.map((model) => model.id));
      for (const entry of enabled) {
        if (!known.has(entry.model)) {
          models.push({
            id: entry.model,
            displayName: entry.label,
            available: true,
            recommended: false,
            supportsReasoningEffort: false,
            supportsJsonResponse: false,
            provider: entry.model.includes("/") ? entry.model.slice(0, entry.model.indexOf("/")) : entry.model,
            providerId: OPENROUTER_PROVIDER_ID,
            contextLength: 0,
            pricing: { promptPerMillion: 0, completionPerMillion: 0 },
          });
        }
      }
      return { models, error: result.error };
    },

    stream(req, ctx) {
      return streamOpenRouter(deps, req, ctx.openRouterApiKey);
    },
  };
}

async function* streamOpenRouter(
  deps: OpenRouterProviderDeps,
  req: Parameters<ModelProvider["stream"]>[0],
  apiKey: string | undefined,
): AsyncGenerator<StreamChunk> {
  if (!apiKey) {
    yield { type: "error", message: MISSING_OPENROUTER_KEY_MESSAGE, retryable: false };
    return;
  }
  const queue = new AsyncQueue<StreamChunk>();
  void deps
    .streamChatCompletion({
      apiKey,
      model: req.model,
      messages: req.messages,
      reasoningEffort: req.reasoningEffort,
      supportsReasoningEffort: req.modelInfo?.supportsReasoningEffort ?? false,
      responseFormatJson: req.responseFormatJson,
      signal: req.signal,
      // Same wording runDebate used to build from these callbacks itself.
      onRetry: ({ attempt, maxAttempts, delayMs, rateLimited }) => {
        queue.push({
          type: "activity",
          message: rateLimited
            ? `Rate limited by the provider, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${maxAttempts})…`
            : `Temporary error, retrying in ${Math.round(delayMs / 1000)}s (attempt ${attempt} of ${maxAttempts})…`,
        });
      },
      onReasoning: (text) => queue.push({ type: "reasoning", text }),
      onToken: (text) => queue.push({ type: "delta", text }),
    })
    .then(
      ({ usage }) => {
        if (usage) {
          queue.push({ type: "usage", usage });
        }
        queue.close();
      },
      (err) => {
        if (isAbortError(err)) {
          queue.fail(err);
          return;
        }
        queue.push({
          type: "error",
          message: err instanceof Error ? err.message : String(err),
          retryable: err instanceof OpenRouterError ? err.retryable : false,
        });
        queue.close();
      },
    );

  while (true) {
    const next = await queue.next();
    if (next.done) {
      return;
    }
    yield next.value;
  }
}
