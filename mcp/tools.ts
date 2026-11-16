// AIPanel's MCP tools. Imports the app's own lib/ directly (no HTTP), so it
// works whether or not the web app is running. Relative imports only: the
// server is started with tsx from whatever cwd Claude Code uses, where the
// "@/" alias of the app's tsconfig would not resolve.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
} from "@modelcontextprotocol/sdk/types.js";
import {
  continueSavedDebate,
  startSavedDebate,
  validateContinueOptions,
} from "../lib/debate-runner";
import {
  DEFAULT_DEBATE_SETTINGS,
  DEFAULT_TOOL_PRESET,
  debateToolInputSchema,
  resolveDebateSettings,
  ROUNDS_RANGE,
  validateAgainstSchema,
  type DebateSettingKey,
  type JsonSchema,
} from "../lib/debate-settings";
import {
  formatDebateCost,
  isDebateId,
  USER_SPEAKER_INDEX,
  type DebateStore,
  type SavedDebate,
} from "../lib/debate-store";
import { checkDocumentRef, loadDocumentRef } from "../lib/extract";
import { buildPresets, PRESET_DESCRIPTIONS, PRESET_TIERS, type PresetName } from "../lib/presets";
import { createSerialQueue } from "../lib/providers/cli-process";
import type { ProviderRegistry } from "../lib/providers/registry";
import { isBackedByWholePanel } from "../lib/summary-utils";
import type { DebateModelInfo, DebateStreamEvent, LabeledDocument } from "../lib/types";

export const DEBATE_TIMEOUT_MS = 30 * 60 * 1000;
export const LIST_DEBATES_MAX = 50;

export interface McpDeps {
  store: DebateStore;
  registry: ProviderRegistry;
  apiKey?: string;
  /** Overall limit per debate / continuation (default 30 min). */
  timeoutMs?: number;
  /** Base for relative document paths. */
  cwd?: string;
  /** Local documents must live under this dir (default: the home dir). */
  documentRoot?: string;
}

const CONTINUE_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["id"],
  properties: {
    id: { type: "string", minLength: 1, maxLength: 40, description: "Debate id (from debate or list_debates)." },
    followup: {
      type: "string",
      maxLength: 20_000,
      description: "A follow-up question or instruction the panel answers in the next round(s).",
    },
    rounds: {
      type: "integer",
      minimum: ROUNDS_RANGE.min,
      maximum: ROUNDS_RANGE.max,
      default: 1,
      description: "How many more rounds to run (default 1).",
    },
  },
};

const LIST_DEBATES_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  properties: {
    limit: { type: "integer", minimum: 1, maximum: LIST_DEBATES_MAX, default: 10, description: "How many, newest first." },
  },
};

const LIST_MODELS_SCHEMA: JsonSchema = { type: "object", additionalProperties: false, properties: {} };

export function toolDefinitions() {
  return [
    {
      name: "debate",
      description:
        "Put a debatable question to the AIPanel model panel. Runs a full multi-round debate (can take many minutes) and returns the verdict, the to-dos every model backed, open disagreements, each model's stance, the cost and the path of the saved transcript, plus a debate id for continue_debate. All settings are optional: explicit arguments > preset > the app's defaults (see list_models).",
      inputSchema: debateToolInputSchema(),
    },
    {
      name: "continue_debate",
      description:
        "Continue a saved debate: add a follow-up and/or run more rounds with the same panel and the full prior transcript, then re-summarize. Returns the same sections as debate.",
      inputSchema: CONTINUE_SCHEMA,
    },
    {
      name: "list_debates",
      description: "Recent saved debates (web and MCP), newest first: id, title, date, status, models.",
      inputSchema: LIST_DEBATES_SCHEMA,
    },
    {
      name: "list_models",
      description:
        "Enabled models, the presets, the default preset and the default settings a debate uses when an argument is left out.",
      inputSchema: LIST_MODELS_SCHEMA,
    },
  ];
}

class ToolInputError extends Error {}

function text(body: string, isError = false): CallToolResult {
  return { content: [{ type: "text", text: body }], ...(isError ? { isError: true } : {}) };
}

function firstSentence(value: string, max = 200): string {
  const flat = value.replace(/[#*_`>]/g, "").replace(/\s+/g, " ").trim();
  const match = /^(.+?[.!?])(\s|$)/.exec(flat);
  const sentence = match ? match[1] : flat;
  return sentence.length > max ? `${sentence.slice(0, max - 1).trimEnd()}…` : sentence;
}

/** The tool's answer: verdict first, then to-dos, disagreements, stances, cost, transcript. */
export function formatDebateResult(record: SavedDebate, transcriptPath: string, note?: string): string {
  const lines: string[] = [];
  const takeaways = record.summary?.takeaways ?? null;
  if (note) {
    lines.push(`> ${note}`, "");
  }
  lines.push("## Verdict", "");
  if (takeaways) {
    lines.push(`${takeaways.verdict} (confidence: ${takeaways.confidence})`);
  } else if (record.summary?.error) {
    lines.push(`(No verdict: the summary failed: ${record.summary.error})`);
  } else if (record.summary?.text) {
    lines.push("(The summary was not in the expected format; its raw text follows.)", "", record.summary.text.trim());
  } else {
    lines.push(`(No summary: debate status is ${record.status}${record.error ? `: ${record.error}` : ""}.)`);
  }

  if (takeaways) {
    const todos = takeaways.takeaways.filter(
      (item) => item.kind === "action" && isBackedByWholePanel(item, record.panel),
    );
    lines.push("", "## To-dos every model backed", "");
    lines.push(...(todos.length > 0 ? todos.map((item) => `- **${item.title}** — ${item.detail}`) : ["(none)"]));

    lines.push("", "## Open disagreements", "");
    if (takeaways.disagreements.length === 0) {
      lines.push("(none)");
    }
    for (const disagreement of takeaways.disagreements) {
      lines.push(`- **${disagreement.topic}**`);
      for (const position of disagreement.positions) {
        lines.push(`  - ${position.model}: ${position.position}`);
      }
    }
  }

  lines.push("", "## Where each model ended up", "");
  for (const member of record.panel) {
    const last = [...record.turns]
      .reverse()
      .find((turn) => turn.modelId === member.modelId && turn.speakerIndex !== USER_SPEAKER_INDEX && turn.text.trim());
    const stance = member.stance ? ` [${member.stance}]` : "";
    lines.push(`- **${member.modelDisplayName}**${stance}: ${last ? firstSentence(last.text) : "(no turn)"}`);
  }

  lines.push("", `Cost: ${formatDebateCost(record.cost)}`);
  lines.push(`Full transcript: ${transcriptPath}`);
  lines.push(`Debate id: ${record.id} (status ${record.status}; continue with continue_debate)`);
  return lines.join("\n");
}

function presetPanels(models: DebateModelInfo[]): Record<PresetName, string[]> {
  const built = buildPresets(models);
  return {
    subscriptions: built.subscriptions,
    flagship: built.flagship,
    balanced: built.balanced,
    budget: built.budget,
  };
}

export function createAipanelServer(deps: McpDeps): Server {
  const server = new Server(
    { name: "aipanel", version: "0.1.0" },
    { capabilities: { tools: {} } },
  );
  // One debate at a time: they share the same CLI logins and rate limits.
  const enqueue = createSerialQueue();
  let pending = 0;

  const catalog = async () => (await deps.registry.listModels({ openRouterApiKey: deps.apiKey })).models;

  async function resolvePanel(args: Record<string, unknown>): Promise<{ modelIds: string[]; preset?: string }> {
    const models = await catalog();
    const summaryModelId = typeof args.summaryModelId === "string" ? args.summaryModelId.trim() : "";
    if (summaryModelId && !models.some((model) => model.id === summaryModelId && model.available)) {
      throw new ToolInputError(`summaryModelId ${summaryModelId} is not enabled. Call list_models for the enabled ids.`);
    }
    if (Array.isArray(args.models)) {
      // The picker keeps OpenRouter ids bare; accept the explicit prefix too.
      const ids = [...new Set((args.models as string[]).map((id) => id.replace(/^openrouter:/, "")))];
      const unknown = ids.filter((id) => !models.some((model) => model.id === id && model.available));
      if (unknown.length > 0) {
        throw new ToolInputError(
          `Not enabled (or not available): ${unknown.join(", ")}. Call list_models for the enabled ids.`,
        );
      }
      if (ids.length < 2) {
        throw new ToolInputError("models needs at least two different models.");
      }
      return { modelIds: ids };
    }
    const preset = (args.preset as PresetName | undefined) ?? DEFAULT_TOOL_PRESET;
    const ids = presetPanels(models)[preset];
    if (ids.length < 2) {
      throw new ToolInputError(
        `Preset "${preset}" (${PRESET_DESCRIPTIONS[preset]}) is not available: its models are not enabled${
          preset === "subscriptions" ? " in Settings" : " or there is no OpenRouter key"
        }. Pass models explicitly or pick another preset (see list_models).`,
      );
    }
    return { modelIds: ids, preset };
  }

  /** Run one queued job with the 30-min limit, a cancel hook, and per-round progress. */
  async function runQueued(
    extra: {
      signal: AbortSignal;
      sendNotification: (n: { method: "notifications/progress"; params: Record<string, unknown> }) => Promise<void>;
      _meta?: { progressToken?: string | number };
    },
    plannedRounds: number,
    summarize: boolean,
    job: (signal: AbortSignal, onEvent: (event: DebateStreamEvent) => void) => Promise<SavedDebate>,
  ): Promise<{ record: SavedDebate; note?: string }> {
    const token = extra._meta?.progressToken;
    let progress = 0;
    const total = plannedRounds + (summarize ? 1 : 0);
    const notify = (message: string, step = 1) => {
      if (token === undefined) {
        return;
      }
      progress += step;
      void extra
        .sendNotification({ method: "notifications/progress", params: { progressToken: token, progress, total, message } })
        .catch(() => undefined);
    };
    if (pending > 0) {
      notify("Queued: another debate is running.", 0);
    }
    pending += 1;
    return enqueue(async () => {
      const controller = new AbortController();
      let timedOut = false;
      const timeoutMs = deps.timeoutMs ?? DEBATE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, timeoutMs);
      const onCancel = () => controller.abort();
      extra.signal.addEventListener("abort", onCancel);
      let roundsDone = 0;
      try {
        if (extra.signal.aborted) {
          throw new Error("Cancelled before it started.");
        }
        const record = await job(controller.signal, (event) => {
          if (event.type === "round_end") {
            roundsDone += 1;
            notify(`Round ${event.round} done (${roundsDone} of ${plannedRounds}${event.iteration > 1 ? `, iteration ${event.iteration}` : ""}).`);
          } else if (event.type === "summary_start") {
            notify(`Summarizing with ${event.modelDisplayName}…`, 0);
          } else if (event.type === "summary_end" || event.type === "summary_error") {
            notify("Summary done.");
          }
        });
        const limit =
          timeoutMs >= 60_000 ? `${Math.round(timeoutMs / 60_000)}-minute` : `${timeoutMs / 1000}-second`;
        const note = timedOut
          ? `Stopped after the ${limit} limit; what ran so far is saved. Use continue_debate to run more rounds.`
          : extra.signal.aborted
            ? "Cancelled; what ran so far is saved."
            : undefined;
        return { record, note };
      } finally {
        clearTimeout(timer);
        extra.signal.removeEventListener("abort", onCancel);
        pending -= 1;
      }
    });
  }

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions() as never }));

  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const args = { ...(request.params.arguments ?? {}) } as Record<string, unknown>;
    try {
      switch (request.params.name) {
        case "debate": {
          // The picker keeps OpenRouter ids bare; accept the explicit prefix (as for models).
          if (typeof args.summaryModelId === "string") {
            args.summaryModelId = args.summaryModelId.trim().replace(/^openrouter:/, "");
          }
          const errors = validateAgainstSchema(args, debateToolInputSchema());
          const docRefs = (Array.isArray(args.documents) ? args.documents : []) as string[];
          if (errors.length === 0) {
            for (const ref of docRefs) {
              const problem = checkDocumentRef(ref, deps.cwd, deps.documentRoot);
              if (problem) {
                errors.push(problem);
              }
            }
          }
          if (errors.length > 0) {
            throw new ToolInputError(errors.join("\n"));
          }
          const panel = await resolvePanel(args);
          const settings = resolveDebateSettings(args as Partial<Record<DebateSettingKey, unknown>>);
          const iterations = settings.mode === "randomized_stances" ? settings.iterations : 1;
          const { record, note } = await runQueued(extra, settings.rounds * iterations, settings.summarize, async (signal, onEvent) => {
            const documents: LabeledDocument[] = [];
            for (const ref of docRefs) {
              documents.push(await loadDocumentRef(ref, deps.cwd, deps.documentRoot));
            }
            return startSavedDebate(
              {
                source: "mcp",
                question: args.question as string,
                context: args.context as string | undefined,
                documents,
                preset: panel.preset,
                modelIds: panel.modelIds,
                settings,
              },
              { store: deps.store, registry: deps.registry, apiKey: deps.apiKey, signal, onEvent },
            );
          });
          return text(formatDebateResult(record, deps.store.markdownPath(record.id), note));
        }

        case "continue_debate": {
          const errors = validateAgainstSchema(args, CONTINUE_SCHEMA);
          if (errors.length > 0) {
            throw new ToolInputError(errors.join("\n"));
          }
          const id = String(args.id);
          const existing = isDebateId(id) ? deps.store.load(id) : null;
          if (!existing) {
            throw new ToolInputError(`No saved debate with id ${id}. Call list_debates for ids.`);
          }
          const options = { followup: args.followup as string | undefined, rounds: args.rounds as number | undefined };
          const problem = validateContinueOptions(options);
          if (problem) {
            throw new ToolInputError(problem);
          }
          const { record, note } = await runQueued(extra, options.rounds ?? 1, existing.settings.summarize, (signal, onEvent) =>
            continueSavedDebate(id, options, { store: deps.store, registry: deps.registry, apiKey: deps.apiKey, signal, onEvent }),
          );
          return text(formatDebateResult(record, deps.store.markdownPath(record.id), note));
        }

        case "list_debates": {
          const errors = validateAgainstSchema(args, LIST_DEBATES_SCHEMA);
          if (errors.length > 0) {
            throw new ToolInputError(errors.join("\n"));
          }
          const { debates, total } = deps.store.list({ limit: (args.limit as number | undefined) ?? 10 });
          return text(JSON.stringify({ total, debates }, null, 2));
        }

        case "list_models": {
          const models = (await catalog()).filter((model) => model.available);
          const panels = presetPanels(models);
          // The full OpenRouter catalog (hundreds of ids) would drown the
          // answer: list subscription models, OpenRouter models enabled in
          // Settings, recommended ones and preset members; count the rest.
          const enabledOpenRouter = new Set(deps.registry.enabledFor("openrouter").map((entry) => entry.model));
          const inPreset = new Set(Object.values(panels).flat());
          const listed = models.filter(
            (model) =>
              model.billing === "subscription" || model.recommended || enabledOpenRouter.has(model.id) || inPreset.has(model.id),
          );
          const presets = Object.fromEntries(
            PRESET_TIERS.map((tier) => [
              tier,
              { description: PRESET_DESCRIPTIONS[tier], models: panels[tier], available: panels[tier].length >= 2 },
            ]),
          );
          return text(
            JSON.stringify(
              {
                models: listed.map((model) => ({
                    id: model.id,
                    name: model.displayName,
                    billing: model.billing ?? "per-token",
                    ...(model.effort ? { effort: model.effort } : {}),
                  })),
                otherOpenRouterModels: models.length - listed.length,
                presets,
                defaultPreset: DEFAULT_TOOL_PRESET,
                defaults: DEFAULT_DEBATE_SETTINGS,
                precedence: "explicit argument > preset (chooses the panel) > defaults",
              },
              null,
              2,
            ),
          );
        }

        default:
          return text(`Unknown tool: ${request.params.name}`, true);
      }
    } catch (err) {
      return text(err instanceof Error ? err.message : String(err), true);
    }
  });

  return server;
}
