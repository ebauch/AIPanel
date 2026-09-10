import {
  DEFAULT_PROMPT_TEMPLATES,
  type PromptStageKey,
} from "./prompt-templates";
import type { PromptOverrides } from "./types";

const STORAGE_PREFIX = "ai-panel.prompt.";

function storageKey(stage: PromptStageKey): string {
  return `${STORAGE_PREFIX}${stage}`;
}

export function readPromptOverrides(): PromptOverrides {
  if (typeof window === "undefined") {
    return {};
  }

  const overrides: PromptOverrides = {};
  for (const stage of Object.keys(
    DEFAULT_PROMPT_TEMPLATES,
  ) as PromptStageKey[]) {
    const stored = localStorage.getItem(storageKey(stage));
    if (stored !== null && stored.length > 0) {
      overrides[stage] = stored;
    }
  }
  return overrides;
}

export function readPromptOverride(stage: PromptStageKey): string | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }
  const stored = localStorage.getItem(storageKey(stage));
  return stored !== null && stored.length > 0 ? stored : undefined;
}

export function writePromptOverride(stage: PromptStageKey, template: string) {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(storageKey(stage), template);
}

export function resetPromptOverride(stage: PromptStageKey) {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.removeItem(storageKey(stage));
}

export function resetAllPromptOverrides() {
  if (typeof window === "undefined") {
    return;
  }
  for (const stage of Object.keys(
    DEFAULT_PROMPT_TEMPLATES,
  ) as PromptStageKey[]) {
    localStorage.removeItem(storageKey(stage));
  }
}

export function isPromptOverrideModified(stage: PromptStageKey): boolean {
  const override = readPromptOverride(stage);
  if (override === undefined) {
    return false;
  }
  return override !== DEFAULT_PROMPT_TEMPLATES[stage];
}

export function effectivePromptTemplate(stage: PromptStageKey): string {
  return readPromptOverride(stage) ?? DEFAULT_PROMPT_TEMPLATES[stage];
}
