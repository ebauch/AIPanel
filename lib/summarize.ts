import { AsyncQueue } from "./async-queue";
import { listDebateModels } from "./models";
import { streamChatCompletion } from "./openrouter";
import { buildSummaryMessages } from "./prompts";
import type {
  DebateStreamEvent,
  Disagreement,
  SummarizeRequest,
  Takeaway,
  Takeaways,
  TokenUsage,
} from "./types";

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((entry): entry is string => typeof entry === "string");
}

/**
 * Match a name the model produced against the panel roster, case-insensitively,
 * and normalize to the canonical display name. Names that don't match any
 * panel member are dropped. Models sometimes echo the "(Stance)" suffix from
 * the panel listing back as part of the name despite instructions not to, so
 * we also retry after stripping a trailing parenthetical.
 */
interface PanelNameEntry {
  canonical: string;
  keys: string[];
}

/** Lowercase, drop a "Provider:" prefix, a trailing "(stance)", and all punctuation. */
function simplifyName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^[^:]{1,40}:\s*/, "")
    .replace(/^[a-z0-9_-]+\//, "")
    .replace(/[^a-z0-9]+/g, "");
}

function buildPanelNameEntries(
  panel: Array<{ modelId?: string; modelDisplayName: string }>,
): PanelNameEntry[] {
  return panel.map((entry) => ({
    canonical: entry.modelDisplayName,
    keys: [entry.modelDisplayName, entry.modelId ?? ""]
      .map(simplifyName)
      .filter((key) => key.length > 0),
  }));
}

function matchPanelName(
  rawName: string,
  entries: PanelNameEntry[],
): string | undefined {
  const needle = simplifyName(rawName);
  if (needle.length === 0) {
    return undefined;
  }

  const exact = entries.find((entry) => entry.keys.includes(needle));
  if (exact) {
    return exact.canonical;
  }

  if (needle.length < 3) {
    return undefined;
  }

  // Partial match in either direction ("Sonnet 5" vs "Claude Sonnet 5",
  // "GPT-5.6 Terra Pro" written as "GPT-5.6 Terra"). When several panel
  // entries match, prefer the one whose key is closest in length.
  const partial = entries
    .map((entry) => {
      const best = entry.keys
        .filter((key) => key.includes(needle) || needle.includes(key))
        .sort((a, b) => Math.abs(a.length - needle.length) - Math.abs(b.length - needle.length))[0];
      return best ? { entry, distance: Math.abs(best.length - needle.length) } : null;
    })
    .filter((hit): hit is { entry: PanelNameEntry; distance: number } => hit !== null)
    .sort((a, b) => a.distance - b.distance);

  return partial[0]?.entry.canonical;
}

function normalizeNames(names: string[], entries: PanelNameEntry[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const rawName of names) {
    const canonical = matchPanelName(rawName, entries);
    if (canonical && !seen.has(canonical)) {
      seen.add(canonical);
      result.push(canonical);
    }
  }
  return result;
}

function parseTakeaways(
  rawText: string,
  panelEntries: PanelNameEntry[],
): Takeaways | null {
  let stripped = rawText.trim();

  // Strip ``` fences if present.
  stripped = stripped.replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();

  const firstBrace = stripped.indexOf("{");
  const lastBrace = stripped.lastIndexOf("}");
  if (firstBrace === -1 || lastBrace === -1 || lastBrace <= firstBrace) {
    return null;
  }

  const jsonSlice = stripped.slice(firstBrace, lastBrace + 1);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonSlice);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }

  const record = parsed as Record<string, unknown>;

  const confidenceRaw = asString(record.confidence).toLowerCase();
  const confidence: Takeaways["confidence"] =
    confidenceRaw === "high" || confidenceRaw === "medium" || confidenceRaw === "low"
      ? confidenceRaw
      : "medium";

  const takeawaysRaw = Array.isArray(record.takeaways) ? record.takeaways : [];
  const takeaways: Takeaway[] = takeawaysRaw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .slice(0, 8)
    .map((entry) => {
      const kindRaw = asString(entry.kind).toLowerCase();
      const kind: Takeaway["kind"] = kindRaw === "action" ? "action" : "finding";
      return {
        title: asString(entry.title),
        detail: asString(entry.detail),
        kind,
        supporters: normalizeNames(asStringArray(entry.supporters), panelEntries),
        dissenters: normalizeNames(asStringArray(entry.dissenters), panelEntries),
      };
    })
    .filter((takeaway) => takeaway.title.length > 0);

  const disagreementsRaw = Array.isArray(record.disagreements) ? record.disagreements : [];
  const disagreements: Disagreement[] = disagreementsRaw
    .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
    .slice(0, 4)
    .map((entry) => {
      const positionsRaw = Array.isArray(entry.positions) ? entry.positions : [];
      const positions = positionsRaw
        .filter((pos): pos is Record<string, unknown> => typeof pos === "object" && pos !== null)
        .map((pos) => ({
          model: matchPanelName(asString(pos.model), panelEntries) ?? asString(pos.model),
          position: asString(pos.position),
        }))
        .filter((pos) => pos.model.length > 0 && pos.position.length > 0);
      return {
        topic: asString(entry.topic),
        positions,
      };
    })
    .filter((disagreement) => disagreement.topic.length > 0 && disagreement.positions.length > 0);

  return {
    verdict: asString(record.verdict),
    confidence,
    takeaways,
    disagreements,
  };
}

export async function* runSummary(
  request: SummarizeRequest,
  options?: { apiKey?: string; signal?: AbortSignal },
): AsyncGenerator<DebateStreamEvent> {
  const apiKey = options?.apiKey;

  if (!apiKey) {
    yield {
      type: "summary_error",
      message:
        "No OpenRouter API key. Add one on the Settings page or set OPENROUTER_API_KEY in .env.local.",
    };
    return;
  }

  if (!request.modelId.trim()) {
    yield {
      type: "summary_error",
      message: "Select a model for the summary.",
    };
    return;
  }

  if (request.transcript.length === 0) {
    yield {
      type: "summary_error",
      message: "No debate transcript available to summarize.",
    };
    return;
  }

  const { models } = await listDebateModels(apiKey);
  const modelInfo = models.find((model) => model.id === request.modelId);
  const modelDisplayName = modelInfo?.displayName ?? request.modelId;

  yield {
    type: "summary_start",
    modelId: request.modelId,
    modelDisplayName,
  };

  const panel = request.panel ?? [];

  const messages = buildSummaryMessages({
    contextBrief: request.contextBrief,
    documents: request.documents,
    transcript: request.transcript.map((message) => ({
      iteration: message.iteration,
      round: message.round,
      speaker: message.modelDisplayName,
      stance: message.stance,
      text: message.text,
    })),
    panel,
    templateOverride: request.promptOverrides?.summary,
  });

  const queue = new AsyncQueue<DebateStreamEvent>();
  let finalResult: { text: string; usage: TokenUsage | null } | null = null;

  void streamChatCompletion({
    apiKey,
    model: request.modelId,
    messages,
    reasoningEffort: request.reasoningEffort,
    supportsReasoningEffort: modelInfo?.supportsReasoningEffort ?? false,
    responseFormatJson: modelInfo?.supportsJsonResponse ?? false,
    signal: options?.signal,
    onToken: (text) => {
      queue.push({ type: "summary_token", text });
    },
  }).then(
    (value) => {
      finalResult = value;
      queue.close();
    },
    (err) => {
      queue.fail(err);
    },
  );

  try {
    while (true) {
      const next = await queue.next();
      if (next.done) {
        break;
      }
      yield next.value;
    }

    if (!finalResult) {
      throw new Error("Stream ended without a result.");
    }

    const { text, usage } = finalResult as { text: string; usage: TokenUsage | null };

    const takeaways = parseTakeaways(text, buildPanelNameEntries(panel));

    console.log(
      `[summary] end model=${request.modelId} chars=${text.length} takeaways=${takeaways ? takeaways.takeaways.length : "null"}`,
    );

    yield {
      type: "summary_end",
      text,
      takeaways,
      usage,
    };
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      return;
    }

    const message = err instanceof Error ? err.message : "Unknown summary error";

    console.error(`[summary] error model=${request.modelId} message=${message}`);

    yield {
      type: "summary_error",
      message,
    };
  }
}
