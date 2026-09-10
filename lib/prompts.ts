import { truncateDocumentContent } from "./limits";
import { DEFAULT_PROMPT_TEMPLATES, renderTemplate } from "./prompt-templates";
import type { LabeledDocument, Stance } from "./types";

const PANEL_CONTEXT_LINE =
  "You are one of several AI models on a panel debating a question posed by a human.";

export function formatDocumentsBlock(documents: LabeledDocument[]): string {
  if (documents.length === 0) {
    return "(no source documents provided)";
  }

  return documents
    .map((doc, index) => {
      const label = doc.label.trim() || `Document ${index + 1}`;
      const content = truncateDocumentContent(doc.content.trim());
      return `### Document ${index + 1}: ${label}\n${content}`;
    })
    .join("\n\n");
}

export function buildSystemMessage(stance: Stance | null): string {
  const roleInstruction = stance
    ? stance.instruction
    : "You have no assigned side. Give an honest, balanced analysis. Acknowledge tradeoffs and uncertainty where appropriate.";

  return `${roleInstruction}\n\n${PANEL_CONTEXT_LINE}`;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export function buildSeedMessages(options: {
  contextBrief: string;
  documents: LabeledDocument[];
  stance: Stance | null;
  templateOverride?: string;
}): ChatMessage[] {
  const documentsBlock = formatDocumentsBlock(options.documents);

  const userContent =
    options.stance === null
      ? renderTemplate(
          options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.seedNeutral,
          {
            contextBrief: options.contextBrief.trim(),
            documents: documentsBlock,
          },
        )
      : renderTemplate(
          options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.seedStance,
          {
            contextBrief: options.contextBrief.trim(),
            stanceLabel: options.stance.label,
            stanceInstruction: options.stance.instruction,
            documents: documentsBlock,
          },
        );

  return [
    { role: "system", content: buildSystemMessage(options.stance) },
    { role: "user", content: userContent },
  ];
}

export function buildRebuttalMessages(options: {
  contextBrief: string;
  documents: LabeledDocument[];
  stance: Stance | null;
  messages: Array<{ speaker: string; stance: string | null; text: string }>;
  templateOverride?: string;
}): ChatMessage[] {
  const documentsBlock = formatDocumentsBlock(options.documents);

  const formattedMessages =
    options.messages.length > 0
      ? options.messages
          .map((message) => {
            const stanceLabel = message.stance ? ` [${message.stance}]` : "";
            return `**${message.speaker}${stanceLabel}:**\n${message.text.trim()}`;
          })
          .join("\n\n")
      : "(no new messages since your last turn — continue the debate with your next contribution)";

  const userContent = renderTemplate(
    options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.rebuttal,
    {
      contextBrief: options.contextBrief.trim(),
      documents: documentsBlock,
      messages: formattedMessages,
    },
  );

  return [
    { role: "system", content: buildSystemMessage(options.stance) },
    { role: "user", content: userContent },
  ];
}

const TAKEAWAYS_SCHEMA_BLOCK = `## Output format
Respond with ONLY a JSON object matching this shape, no code fences, no prose before or after:

{
  "verdict": string,               // 1-3 sentences: the single most important conclusion or recommendation
  "confidence": "high" | "medium" | "low", // how much the panel converged
  "takeaways": [
    {
      "title": string,             // short imperative or declarative headline
      "detail": string,            // one or two sentences, may reference documents
      "kind": "action" | "finding", // "action" when the human should do something, "finding" otherwise
      "supporters": string[],      // panel model names (verbatim from the panel list) that made or backed this point
      "dissenters": string[]       // panel model names (verbatim) that argued against this point
    }
  ],
  "disagreements": [
    {
      "topic": string,
      "positions": [ { "model": string, "position": string } ]
    }
  ]
}

Rules: at most 8 takeaways and 4 disagreements; only include a disagreement for a genuine split, not routine variation in phrasing; in "supporters", "dissenters", and "model" fields use ONLY the model's name exactly as it appears before the parenthesis in the panel list (e.g. panel entry "GPT-5.4 Nano (Pro)" -> use "GPT-5.4 Nano", never "GPT-5.4 Nano (Pro)"); never mark a model as a supporter or dissenter unless it actually took that position.`;

/** "Anthropic: Claude Sonnet 5" -> "Claude Sonnet 5" */
export function shortModelName(displayName: string): string {
  return displayName.replace(/^[^:]{1,40}:\s*/, "").trim() || displayName;
}

export function buildSummaryMessages(options: {
  contextBrief: string;
  documents: LabeledDocument[];
  transcript: Array<{
    iteration: number;
    round: number;
    speaker: string;
    stance: string | null;
    text: string;
  }>;
  panel: Array<{ modelId?: string; modelDisplayName: string; stance: string | null }>;
  templateOverride?: string;
}): ChatMessage[] {
  const documentsBlock = formatDocumentsBlock(options.documents);

  const formattedTranscript =
    options.transcript.length > 0
      ? options.transcript
          .map((message) => {
            const stanceLabel = message.stance ? ` [${message.stance}]` : "";
            return `### Iteration ${message.iteration}, Round ${message.round} — ${message.speaker}${stanceLabel}\n${message.text.trim()}`;
          })
          .join("\n\n")
      : "(empty transcript)";

  const formattedPanel =
    options.panel.length > 0
      ? options.panel
          .map(
            (entry) =>
              `- ${shortModelName(entry.modelDisplayName)}${entry.stance ? ` (${entry.stance})` : ""}`,
          )
          .join("\n")
      : "(no panel roster provided)";

  const templateContent = renderTemplate(
    options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.summary,
    {
      contextBrief: options.contextBrief.trim(),
      documents: documentsBlock,
      transcript: formattedTranscript,
      panel: formattedPanel,
    },
  );

  const userContent = `${templateContent}\n\n${TAKEAWAYS_SCHEMA_BLOCK}`;

  return [
    {
      role: "system",
      content: "You are a neutral analyst summarizing a multi-model debate for a human reader.",
    },
    { role: "user", content: userContent },
  ];
}
