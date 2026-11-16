import type { DebateModelInfo, Takeaway } from "./types";

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
