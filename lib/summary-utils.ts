import type { DebateModelInfo } from "./types";

export function pickDefaultSummaryModel(
  allModels: DebateModelInfo[],
  selectedModelIds: string[],
): string {
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
