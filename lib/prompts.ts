import { truncateDocumentContent } from "./limits";
import { DEFAULT_PROMPT_TEMPLATES, renderTemplate } from "./prompt-templates";
import type { ChatMessage, LabeledDocument, Stance } from "./types";

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

function roleInstructionFor(stance: Stance | null): string {
  return stance
    ? stance.instruction
    : "You have no assigned side. Give an honest, balanced analysis. Acknowledge tradeoffs and uncertainty where appropriate.";
}

/**
 * Build the system message for a debate turn as two content parts: a stable
 * "context" part (panel framing + role + brief) and a "documents" part that
 * carries an Anthropic-style cache_control marker. Both parts are
 * byte-identical across every turn a given model takes within an iteration,
 * so providers that support explicit prompt caching (and OpenAI's automatic
 * caching) stop re-billing the documents on rebuttal turns.
 */
export function buildSystemMessage(options: {
  contextBrief: string;
  documents: LabeledDocument[];
  stance: Stance | null;
  templateOverride?: string;
}): ChatMessage {
  const contextText = renderTemplate(
    options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.systemContext,
    {
      contextBrief: options.contextBrief.trim(),
      roleInstruction: roleInstructionFor(options.stance),
      stanceLabel: options.stance?.label ?? "",
    },
  );

  const documentsText = `## Source documents\n${formatDocumentsBlock(options.documents)}`;

  return {
    role: "system",
    content:
      options.documents.length > 0
        ? [
            { type: "text", text: contextText },
            {
              type: "text",
              text: documentsText,
              cache_control: { type: "ephemeral", ttl: "1h" },
            },
          ]
        : [
            { type: "text", text: contextText },
            { type: "text", text: documentsText },
          ],
  };
}

export function buildSeedMessages(options: {
  contextBrief: string;
  documents: LabeledDocument[];
  stance: Stance | null;
  templateOverride?: string;
  systemTemplateOverride?: string;
}): ChatMessage[] {
  const systemMessage = buildSystemMessage({
    contextBrief: options.contextBrief,
    documents: options.documents,
    stance: options.stance,
    templateOverride: options.systemTemplateOverride,
  });

  const userContent =
    options.stance === null
      ? renderTemplate(
          options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.seedNeutral,
          {},
        )
      : renderTemplate(
          options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.seedStance,
          {
            stanceLabel: options.stance.label,
            stanceInstruction: options.stance.instruction,
          },
        );

  return [systemMessage, { role: "user", content: userContent }];
}

export function buildRebuttalMessages(options: {
  contextBrief: string;
  documents: LabeledDocument[];
  stance: Stance | null;
  messages: Array<{ speaker: string; stance: string | null; text: string }>;
  /** The speaker's own earlier turns in this iteration, oldest first. Empty when memory is off. */
  ownMessages?: Array<{ round: number; text: string }>;
  templateOverride?: string;
  systemTemplateOverride?: string;
}): ChatMessage[] {
  const systemMessage = buildSystemMessage({
    contextBrief: options.contextBrief,
    documents: options.documents,
    stance: options.stance,
    templateOverride: options.systemTemplateOverride,
  });

  const formattedMessages =
    options.messages.length > 0
      ? options.messages
          .map((message) => {
            const stanceLabel = message.stance ? ` [${message.stance}]` : "";
            return `**${message.speaker}${stanceLabel}:**\n${message.text.trim()}`;
          })
          .join("\n\n")
      : "(no new messages since your last turn — continue the debate with your next contribution)";

  const ownMessages = options.ownMessages ?? [];
  const formattedOwnMessages =
    ownMessages.length > 0
      ? `## What you argued in your earlier turns\nStay consistent with your position unless the other debaters have genuinely changed your mind.\n\n${ownMessages
          .map((message) => `**Round ${message.round}:**\n${message.text.trim()}`)
          .join("\n\n")}\n\n`
      : "";

  const userContent = renderTemplate(
    options.templateOverride ?? DEFAULT_PROMPT_TEMPLATES.rebuttal,
    {
      messages: formattedMessages,
      ownMessages: formattedOwnMessages,
    },
  );

  return [systemMessage, { role: "user", content: userContent }];
}

const TAKEAWAYS_SCHEMA_BLOCK = `## Output format
Respond with ONLY a JSON object matching this shape, no code fences, no prose before or after:

{
  "verdict": string,               // ONE sentence, at most 25 words. Name the winner, the decision, or the single criterion the panel split on. Do NOT restate points that already appear in takeaways.
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

Rules: at most 8 takeaways and 4 disagreements; only include a disagreement for a genuine split, not routine variation in phrasing; in "supporters", "dissenters", and "model" fields use ONLY the model's name exactly as it appears before the parenthesis in the panel list (e.g. panel entry "GPT-5.4 Nano (Pro)" -> use "GPT-5.4 Nano", never "GPT-5.4 Nano (Pro)"); never mark a model as a supporter or dissenter unless it actually took that position; the verdict must be one sentence of at most 25 words and must not repeat takeaway content.`;

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
