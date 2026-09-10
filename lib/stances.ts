import type { Stance } from "./types";

// Default stance set offered when a debate uses "assigned_stances" or
// "randomized_stances" mode and the user has not customized the stances.
export const DEFAULT_STANCES: Stance[] = [
  {
    label: "Pro",
    instruction:
      "Argue in favor of the proposition or position described in the context brief. Make the strongest honest case for it, support claims with specifics from the documents, and push back on objections you consider weak.",
  },
  {
    label: "Against",
    instruction:
      "Argue against the proposition or position described in the context brief. Identify its weaknesses, risks, and counter-evidence, support claims with specifics from the documents, and push back on arguments you consider overstated.",
  },
  {
    label: "Balanced",
    instruction:
      "Take no side. Weigh the strongest points made by both sides, point out where either side is overstating or missing evidence, and steer the panel toward the most defensible conclusion.",
  },
];
