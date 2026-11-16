import type { DebateModelInfo, Takeaway } from "./types";

const SUBSCRIPTION_ID_PATTERN = /^(claude-cli|codex-cli):/;
const SUBSCRIPTION_OPUS_PATTERN = /^claude-cli:claude-opus/;

/**
 * The takeaways model when none was chosen. A panel made only of
 * subscription models must never fall through to a per-token (OpenRouter)
 * summarizer: that would spend money on a debate that is otherwise free.
 */
export function pickDefaultSummaryModel(
  allModels: DebateModelInfo[],
  selectedModelIds: string[],
): string {
  const isSubscription = (id: string) => {
    const model = allModels.find((entry) => entry.id === id);
    return model ? model.billing === "subscription" : SUBSCRIPTION_ID_PATTERN.test(id);
  };
  if (selectedModelIds.length > 0 && selectedModelIds.every(isSubscription)) {
    return selectedModelIds.find((id) => SUBSCRIPTION_OPUS_PATTERN.test(id)) ?? selectedModelIds[0];
  }

  const recommendedFable = allModels.find(
    (model) => model.recommended && /anthropic\/claude-fable/i.test(model.id),
  );
  if (recommendedFable) {
    return recommendedFable.id;
  }

  const anyFable = allModels.find((model) =>
    /anthropic\/claude-fable/i.test(model.id),
  );
  if (anyFable) {
    return anyFable.id;
  }

  const opus = allModels.find((model) => /anthropic\/claude-opus/i.test(model.id));
  if (opus) {
    return opus.id;
  }

  return selectedModelIds[0] ?? "";
}

/** Every panel member backed the takeaway and nobody argued against it. */
export function isBackedByWholePanel(
  takeaway: Pick<Takeaway, "supporters" | "dissenters">,
  panel: Array<{ modelDisplayName: string }>,
): boolean {
  if (panel.length === 0) {
    return false;
  }
  return (
    panel.every((member) => takeaway.supporters.includes(member.modelDisplayName)) &&
    takeaway.dissenters.length === 0
  );
}
