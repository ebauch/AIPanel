import type { DebateModelInfo } from "./types";

// Providers considered for presets, in the order a preset panel prefers them.
const PRESET_PROVIDERS = ["anthropic", "openai", "google", "x-ai"] as const;

// Candidate pool excludes previews, experiments, and non-text-debate models.
const CANDIDATE_EXCLUDE_PATTERN =
  /preview|exp|image|audio|realtime|search|codex|chat-latest|:free|:batch/i;

// A handful of "budget" ids that are actually cut-down image models, not
// cheap chat models — skip them for the budget tier unless nothing else fits.
const BUDGET_EXCLUDE_PATTERN = /lite-image|nano-image/i;

const EIGHTEEN_MONTHS_MS = 18 * 30.44 * 24 * 60 * 60 * 1000;

export interface PanelPresets {
  flagship: string[];
  balanced: string[];
  budget: string[];
  /** "Opus 5.5 vs Astra (subscriptions)": empty unless both models are enabled. */
  subscriptions: string[];
}

export type PresetTier = "flagship" | "balanced" | "budget" | "subscriptions" | "custom";

/** Claude Max (claude CLI) vs ChatGPT Pro (codex CLI): no per-token spend. */
export const SUBSCRIPTION_PRESET = {
  label: "Opus 5.5 vs Astra",
  description: "Opus 5.5 vs Astra (subscriptions)",
  ids: ["claude-cli:claude-opus-5-5", "codex-cli:gpt-6-astra"],
} as const;

/** Preset names the MCP tool accepts, default first. */
export const PRESET_TIERS = ["subscriptions", "flagship", "balanced", "budget"] as const;

export type PresetName = (typeof PRESET_TIERS)[number];

export const PRESET_DESCRIPTIONS: Record<PresetName, string> = {
  subscriptions: SUBSCRIPTION_PRESET.description,
  flagship: "each vendor's flagship model (OpenRouter, per-token $)",
  balanced: "mid-priced models (OpenRouter, per-token $)",
  budget: "cheapest capable models (OpenRouter, per-token $)",
};

function isRecent(createdSec: number | undefined): boolean {
  if (!createdSec) {
    return false;
  }
  return Date.now() - createdSec * 1000 <= EIGHTEEN_MONTHS_MS;
}

function dayOf(model: DebateModelInfo): number {
  return Math.floor((model.created ?? 0) / 86_400);
}

/** Newest first; ties on the same release day break toward `tieBreak`. */
function sortNewestFirst(
  candidates: DebateModelInfo[],
  tieBreak: "higher-price" | "lower-price",
): DebateModelInfo[] {
  return [...candidates].sort((a, b) => {
    const dayDiff = dayOf(b) - dayOf(a);
    if (dayDiff !== 0) {
      return dayDiff;
    }
    return tieBreak === "higher-price"
      ? b.pricing.completionPerMillion - a.pricing.completionPerMillion
      : a.pricing.completionPerMillion - b.pricing.completionPerMillion;
  });
}

function candidatePool(
  models: DebateModelInfo[],
  provider: string,
): DebateModelInfo[] {
  return models.filter(
    (model) =>
      model.provider === provider &&
      isRecent(model.created) &&
      !CANDIDATE_EXCLUDE_PATTERN.test(model.id),
  );
}

function pickFlagship(
  models: DebateModelInfo[],
  provider: string,
): DebateModelInfo | undefined {
  return models.find(
    (model) => model.provider === provider && model.recommended,
  );
}

function pickBalanced(
  pool: DebateModelInfo[],
  flagship: DebateModelInfo,
): DebateModelInfo | undefined {
  const flagshipPrice = flagship.pricing.completionPerMillion;
  if (flagshipPrice <= 0) {
    return undefined;
  }
  if (flagshipPrice <= 5) {
    return flagship;
  }

  const candidates = pool.filter((model) => {
    const ratio = model.pricing.completionPerMillion / flagshipPrice;
    return ratio >= 0.15 && ratio <= 0.35;
  });

  return sortNewestFirst(candidates, "higher-price")[0];
}

function pickBudget(
  pool: DebateModelInfo[],
  flagship: DebateModelInfo,
): DebateModelInfo | undefined {
  const flagshipPrice = flagship.pricing.completionPerMillion;
  if (flagshipPrice <= 0) {
    return undefined;
  }

  const withinRatio = (maxRatio: number) =>
    pool.filter((model) => {
      const price = model.pricing.completionPerMillion;
      return (
        price > 0 &&
        price / flagshipPrice <= maxRatio &&
        !BUDGET_EXCLUDE_PATTERN.test(model.id)
      );
    });

  const strict = withinRatio(0.1);
  const candidates = strict.length > 0 ? strict : withinRatio(0.2);

  return sortNewestFirst(candidates, "lower-price")[0];
}

/**
 * Build the three preset panels from the live model catalog. Each tier is
 * assembled independently: walk the providers in order and take the first
 * three that produce a model for that specific tier (a provider with no
 * budget candidate, say, is simply skipped for the budget tier while still
 * contributing to flagship/balanced).
 */
export function buildPresets(models: DebateModelInfo[]): PanelPresets {
  const result: PanelPresets = { flagship: [], balanced: [], budget: [], subscriptions: [] };

  const usable = (id: string) => models.some((model) => model.id === id && model.available);
  if (SUBSCRIPTION_PRESET.ids.every(usable)) {
    result.subscriptions = [...SUBSCRIPTION_PRESET.ids];
  }

  for (const provider of PRESET_PROVIDERS) {
    const flagship = pickFlagship(models, provider);
    if (!flagship) {
      continue;
    }

    const pool = candidatePool(models, provider);

    if (result.flagship.length < 3) {
      result.flagship.push(flagship.id);
    }

    if (result.balanced.length < 3) {
      const balanced = pickBalanced(pool, flagship);
      if (balanced) {
        result.balanced.push(balanced.id);
      }
    }

    if (result.budget.length < 3) {
      const budget = pickBudget(pool, flagship);
      if (budget) {
        result.budget.push(budget.id);
      }
    }
  }

  return result;
}

/** Set-equality (order-insensitive) match of `selectedIds` against one of the preset tiers. */
export function detectPreset(
  selectedIds: string[],
  presets: PanelPresets,
): PresetTier {
  const selected = new Set(selectedIds);

  const matches = (ids: string[]) =>
    ids.length > 0 &&
    ids.length === selected.size &&
    ids.every((id) => selected.has(id));

  if (matches(presets.flagship)) {
    return "flagship";
  }
  if (matches(presets.balanced)) {
    return "balanced";
  }
  if (matches(presets.budget)) {
    return "budget";
  }
  if (matches(presets.subscriptions)) {
    return "subscriptions";
  }
  return "custom";
}
