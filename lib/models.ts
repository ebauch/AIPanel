import { listModels, type OpenRouterModel } from "./openrouter";
import type { DebateModelInfo } from "./types";

const PREFERRED_PROVIDER_ORDER = [
  "anthropic",
  "openai",
  "google",
  "x-ai",
  "deepseek",
  "moonshotai",
  "qwen",
  "meta-llama",
  "mistralai",
];

const RECOMMENDED_PROVIDERS = ["anthropic", "openai", "google", "x-ai"];

const RECOMMENDED_PATTERNS: Record<string, { include: RegExp; exclude?: RegExp }> = {
  anthropic: { include: /opus|fable/i },
  openai: {
    include: /^openai\/gpt-\d/i,
    exclude: /mini|nano|chat|codex|image|audio|realtime|search/i,
  },
  google: {
    include: /gemini-\d/i,
    exclude: /preview|exp|image|lite|customtools/i,
  },
  "x-ai": { include: /grok-\d/i, exclude: /mini|fast|code/i },
};

const NON_CHAT_PATTERN = /-image|tts|whisper/i;

function providerOf(id: string): string {
  const slashIndex = id.indexOf("/");
  return slashIndex === -1 ? id : id.slice(0, slashIndex);
}

function providerSortIndex(provider: string): number {
  const index = PREFERRED_PROVIDER_ORDER.indexOf(provider);
  return index === -1 ? PREFERRED_PROVIDER_ORDER.length : index;
}

function isChatModel(model: OpenRouterModel): boolean {
  if (model.id === "openrouter/auto" || model.id.startsWith("openrouter/auto")) {
    return false;
  }
  if (model.id.endsWith(":batch")) {
    return false;
  }
  if (NON_CHAT_PATTERN.test(model.id)) {
    return false;
  }
  return true;
}

function isFreeOnly(model: OpenRouterModel): boolean {
  if (model.id.includes(":free")) {
    return true;
  }
  return model.pricing.prompt === "0" && model.pricing.completion === "0";
}

function toDebateModelInfo(
  model: OpenRouterModel,
  recommended: boolean,
): DebateModelInfo {
  const supportedParams = model.supported_parameters ?? [];
  const supportsReasoningEffort =
    supportedParams.includes("reasoning") ||
    supportedParams.includes("include_reasoning");
  const supportsJsonResponse =
    supportedParams.includes("response_format") ||
    supportedParams.includes("structured_outputs");

  const promptPerMillion = Number(model.pricing.prompt) * 1_000_000;
  const completionPerMillion = Number(model.pricing.completion) * 1_000_000;

  return {
    id: model.id,
    displayName: model.name,
    description: model.description,
    available: true,
    recommended,
    supportsReasoningEffort,
    supportsJsonResponse,
    provider: providerOf(model.id),
    contextLength: model.context_length,
    pricing: {
      promptPerMillion: Number.isFinite(promptPerMillion) ? promptPerMillion : 0,
      completionPerMillion: Number.isFinite(completionPerMillion)
        ? completionPerMillion
        : 0,
    },
    created: model.created,
  };
}

function pickRecommendedFlagship(
  models: OpenRouterModel[],
  provider: string,
): OpenRouterModel | undefined {
  const pattern = RECOMMENDED_PATTERNS[provider];
  if (!pattern) {
    return undefined;
  }

  let candidates = models.filter(
    (model) => providerOf(model.id) === provider && pattern.include.test(model.id),
  );

  if (pattern.exclude) {
    const filtered = candidates.filter((model) => !pattern.exclude!.test(model.id));
    if (filtered.length > 0) {
      candidates = filtered;
    }
  }

  // Newest first; when several variants ship on the same day (e.g. tiered
  // releases), treat the highest completion price as the flagship.
  const dayOf = (model: OpenRouterModel) => Math.floor(model.created / 86_400);
  candidates = [...candidates].sort((a, b) => {
    if (dayOf(b) !== dayOf(a)) {
      return dayOf(b) - dayOf(a);
    }
    return Number(b.pricing.completion) - Number(a.pricing.completion);
  });
  return candidates[0];
}

export interface ListDebateModelsResult {
  models: DebateModelInfo[];
  error?: string;
}

interface ModelCacheEntry {
  expiresAt: number;
  result: ListDebateModelsResult;
}

const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;
let modelCache: ModelCacheEntry | null = null;

export async function listDebateModels(
  apiKey?: string,
): Promise<ListDebateModelsResult> {
  if (modelCache && modelCache.expiresAt > Date.now()) {
    return modelCache.result;
  }

  try {
    const allModels = await listModels(apiKey);
    const chatModels = allModels.filter(isChatModel);

    const nonFree = chatModels.filter((model) => !isFreeOnly(model));
    const usable = nonFree.length > 0 ? nonFree : chatModels;

    const recommendedIds = new Set<string>();
    for (const provider of RECOMMENDED_PROVIDERS) {
      const flagship = pickRecommendedFlagship(usable, provider);
      if (flagship) {
        recommendedIds.add(flagship.id);
      }
    }

    const infos = usable.map((model) =>
      toDebateModelInfo(model, recommendedIds.has(model.id)),
    );

    infos.sort((a, b) => {
      const providerOrder = providerSortIndex(a.provider) - providerSortIndex(b.provider);
      if (providerOrder !== 0) {
        return providerOrder;
      }
      if (a.provider !== b.provider) {
        return a.provider.localeCompare(b.provider);
      }
      return (b.created ?? 0) - (a.created ?? 0);
    });

    const result: ListDebateModelsResult = { models: infos };
    modelCache = { expiresAt: Date.now() + MODEL_CACHE_TTL_MS, result };
    return result;
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to list models from OpenRouter";
    return { models: [], error: message };
  }
}

