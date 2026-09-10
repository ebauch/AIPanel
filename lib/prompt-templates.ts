export const PROMPT_STAGES = {
  systemContext: {
    title: "System context (sent every turn)",
    vars: ["contextBrief", "roleInstruction", "stanceLabel"],
    description:
      "Sent as the system message on every turn; the documents are appended after it and cached",
  },
  seedNeutral: {
    title: "Opening turn (no stance)",
    vars: [],
  },
  seedStance: {
    title: "Opening turn (with stance)",
    vars: ["stanceLabel", "stanceInstruction"],
  },
  rebuttal: {
    title: "Rebuttal turn",
    vars: ["messages"],
  },
  summary: {
    title: "Takeaways",
    vars: ["contextBrief", "documents", "transcript", "panel"],
  },
} as const;

export type PromptStageKey = keyof typeof PROMPT_STAGES;

export function renderTemplate(
  template: string,
  vars: Record<string, string>,
): string {
  return template.replace(/\{\{(\w+)\}\}/g, (_, key) => vars[key] ?? "");
}

export const DEFAULT_PROMPT_TEMPLATES: Record<PromptStageKey, string> = {
  systemContext: `You are one of several AI models on a panel debating a question posed by a human.

{{roleInstruction}}

## Context brief
{{contextBrief}}`,

  seedNeutral: `## Task
Open this debate with your initial argument or analysis. Be specific, cite details from the source documents where helpful, and keep your opening focused.`,

  seedStance: `## Your assigned stance: {{stanceLabel}}
{{stanceInstruction}}

Do not switch sides or concede your assigned position unless you are rebutting a specific claim.

## Task
Open this debate with your initial argument or analysis, arguing from your assigned stance. Be specific, cite details from the source documents where helpful, and keep your opening focused.`,

  rebuttal: `## What the other debaters said since your last turn
{{messages}}

## Task
Respond directly to their points. Rebut weak claims, strengthen your position, and add new evidence from the documents if useful. Stay concise but substantive.`,

  summary: `You are the neutral moderator of a panel of AI models that just debated a question posed by a human. Your job is to tell the human what to take away. Lead with a one-sentence verdict: the winner, the decision, or the single criterion the panel could not agree on. Everything else belongs in the takeaways. Then list the concrete takeaways: actions the human should take, or findings they should rely on. For every takeaway, record exactly which panel models made or backed the point and which argued against it, using the model names from the panel list verbatim. A takeaway backed by every model is the most valuable output of this debate; be precise about support, and never mark a model as a supporter unless it actually said so. Keep titles short and details to one or two sentences. Do not invent points the panel did not raise. Prefer specifics: name documents, numbers, and sections.

## Context brief
{{contextBrief}}

## Source documents
{{documents}}

## Panel
{{panel}}

## Full debate transcript
{{transcript}}`,
};
