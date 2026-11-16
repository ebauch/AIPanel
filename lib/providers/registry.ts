// The one place that knows which providers exist. runDebate, runSummary and
// the API routes route every model through here by its id prefix.
import { loadModelSettings, type ModelSettings } from "../model-settings";
import type { DebateModelInfo } from "../types";
import { createClaudeCliProvider } from "./claude-cli";
import { createCodexCliProvider } from "./codex-cli";
import { parseModelId } from "./model-id";
import { createOpenRouterProvider } from "./openrouter";
import type {
  EnabledModelEntry,
  ModelProvider,
  ProviderContext,
  StreamChunk,
  StreamRequest,
} from "./types";

export interface ResolvedModel {
  provider: ModelProvider;
  /** Provider-local id. */
  model: string;
  /** Its settings entry, when the model is enabled in Settings. */
  entry?: EnabledModelEntry;
}

export interface ProviderRegistry {
  /** In picker order: subscription providers first, then OpenRouter's big catalog. */
  providers: ModelProvider[];
  get(providerId: string): ModelProvider | undefined;
  settings(): ModelSettings;
  enabledFor(providerId: string): EnabledModelEntry[];
  resolve(modelId: string): ResolvedModel | undefined;
  /** Provider ids behind a set of model ids, so only those catalogs get fetched. */
  providerIdsFor(modelIds: string[]): string[];
  /** Picker entries for all providers (or only `providerIds`), grouped by provider. */
  listModels(
    ctx: ProviderContext,
    options?: { providerIds?: string[] },
  ): Promise<{ models: DebateModelInfo[]; error?: string }>;
  stream(modelId: string, req: Omit<StreamRequest, "model">, ctx: ProviderContext): AsyncIterable<StreamChunk>;
}

export function createRegistry(options: {
  providers: ModelProvider[];
  loadSettings: () => ModelSettings;
}): ProviderRegistry {
  const { providers } = options;
  const ids = providers.map((provider) => provider.id);
  const get = (providerId: string) => providers.find((provider) => provider.id === providerId);

  const enabledFor = (providerId: string): EnabledModelEntry[] =>
    options
      .loadSettings()
      .models.map((entry) => ({ entry, parsed: parseModelId(entry.id, ids) }))
      .filter(({ parsed }) => parsed.providerId === providerId)
      .map(({ entry, parsed }) => ({ model: parsed.model, label: entry.label, effort: entry.effort }));

  const resolve = (modelId: string): ResolvedModel | undefined => {
    const parsed = parseModelId(modelId, ids);
    const provider = get(parsed.providerId);
    if (!provider) {
      return undefined;
    }
    const entry = enabledFor(provider.id).find((candidate) => candidate.model === parsed.model);
    return { provider, model: parsed.model, entry };
  };

  return {
    providers,
    get,
    settings: options.loadSettings,
    enabledFor,
    resolve,
    providerIdsFor: (modelIds) => [...new Set(modelIds.map((modelId) => parseModelId(modelId, ids).providerId))],

    async listModels(ctx, listOptions) {
      const wanted = listOptions?.providerIds;
      const selected = wanted ? providers.filter((provider) => wanted.includes(provider.id)) : providers;
      const results = await Promise.all(
        selected.map(async (provider) => {
          try {
            return await provider.listModels(ctx, enabledFor(provider.id));
          } catch (err) {
            return { models: [], error: `${provider.label}: ${err instanceof Error ? err.message : String(err)}` };
          }
        }),
      );
      const errors = results.map((result) => result.error).filter((error): error is string => Boolean(error));
      return {
        models: results.flatMap((result) => result.models),
        ...(errors.length > 0 ? { error: errors.join(" · ") } : {}),
      };
    },

    stream(modelId, req, ctx) {
      const resolved = resolve(modelId);
      if (!resolved) {
        return (async function* () {
          yield { type: "error", message: `No provider for model ${modelId}.`, retryable: false } as StreamChunk;
        })();
      }
      return resolved.provider.stream(
        { ...req, model: resolved.model, effort: req.effort ?? resolved.entry?.effort },
        ctx,
      );
    },
  };
}

let defaultRegistry: ProviderRegistry | undefined;

/** The app's registry: real CLIs (binary paths from AIPANEL_CLAUDE_BIN / AIPANEL_CODEX_BIN) and the settings file. */
export function getRegistry(): ProviderRegistry {
  if (!defaultRegistry) {
    defaultRegistry = createRegistry({
      providers: [createClaudeCliProvider(), createCodexCliProvider(), createOpenRouterProvider()],
      loadSettings: () => loadModelSettings().settings,
    });
  }
  return defaultRegistry;
}
