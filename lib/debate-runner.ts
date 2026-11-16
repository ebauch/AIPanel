// Runs debates against the saved-debate store: taps the runDebate / runSummary
// event streams into the record (saving after every turn), and implements
// "continue" (a follow-up and/or more rounds appended to the same debate).
// Used by the web API routes and the MCP server alike.
import { runDebate } from "./debate";
import {
  buildContextBrief,
  MAX_QUESTION_CHARS,
  ROUNDS_RANGE,
  toDebateConfig,
  type DebateSettings,
} from "./debate-settings";
import {
  addUsage,
  isRunningNow,
  transcriptOf,
  USER_DISPLAY_NAME,
  USER_MODEL_ID,
  USER_SPEAKER_INDEX,
  type DebateStatus,
  type DebateStore,
  type NewDebateInput,
  type PanelMember,
  type SavedDebate,
} from "./debate-store";
import { getRegistry, type ProviderRegistry } from "./providers/registry";
import { runSummary } from "./summarize";
import { pickDefaultSummaryModel } from "./summary-utils";
import type { DebateStreamEvent, LabeledDocument } from "./types";

export interface RunnerDeps {
  store: DebateStore;
  registry?: ProviderRegistry;
  apiKey?: string;
  signal?: AbortSignal;
  onEvent?: (event: DebateStreamEvent) => void;
}

/** Save, but keep a title that was renamed on disk while the debate ran. */
function saveRecord(store: DebateStore, record: SavedDebate): void {
  try {
    const onDisk = store.load(record.id);
    if (onDisk) {
      record.title = onDisk.title;
    }
  } catch {
    // Unreadable file: overwrite it with the in-memory record.
  }
  store.save(record);
}

/**
 * Pass debate events through while recording them. With `create`, the record
 * is created on `debate_start` (so a run rejected up front leaves nothing
 * behind) and a `debate_saved` event announces its id.
 */
export async function* recordDebate(
  store: DebateStore,
  events: AsyncIterable<DebateStreamEvent>,
  target: { record: SavedDebate } | { create: () => SavedDebate },
): AsyncGenerator<DebateStreamEvent> {
  let record = "record" in target ? target.record : null;
  let assignments: PanelMember[] = [];
  try {
    for await (const event of events) {
      if (!record && "create" in target && event.type === "debate_start") {
        record = target.create();
        yield { type: "debate_saved", id: record.id };
      }
      if (record) {
        switch (event.type) {
          case "iteration_start":
            assignments = event.assignments;
            if (record.panel.length === 0) {
              record.panel = event.assignments.map((a) => ({ ...a }));
              saveRecord(store, record);
            }
            break;
          case "turn_end": {
            const who = assignments[event.speakerIndex];
            record.turns.push({
              iteration: event.iteration,
              round: event.round,
              speakerIndex: event.speakerIndex,
              modelId: event.modelId,
              modelDisplayName: who?.modelDisplayName ?? event.modelId,
              stance: who?.stance ?? null,
              text: event.text,
              usage: event.usage,
              ...(event.error ? { error: event.error } : {}),
              at: new Date().toISOString(),
            });
            record.cost = addUsage(record.cost, event.usage);
            saveRecord(store, record);
            break;
          }
          case "debate_end":
            record.status = "done";
            delete record.pid;
            saveRecord(store, record);
            break;
          case "error":
            record.status = "error";
            record.error = event.message;
            delete record.pid;
            saveRecord(store, record);
            break;
          default:
            break;
        }
      }
      yield event;
    }
  } finally {
    // Aborted (stop button, closed tab, timeout) or the consumer went away.
    if (record && record.status === "running") {
      record.status = "stopped";
      delete record.pid;
      saveRecord(store, record);
    }
  }
}

/** Pass summary events through and store the result on the debate. */
export async function* recordSummary(
  store: DebateStore,
  id: string,
  events: AsyncIterable<DebateStreamEvent>,
): AsyncGenerator<DebateStreamEvent> {
  let modelId = "";
  let modelDisplayName = "";
  for await (const event of events) {
    if (event.type === "summary_start") {
      modelId = event.modelId;
      modelDisplayName = event.modelDisplayName;
    }
    if (event.type === "summary_end" || event.type === "summary_error") {
      const record = store.load(id);
      if (record) {
        const at = new Date().toISOString();
        if (event.type === "summary_end") {
          record.summary = { modelId, modelDisplayName, text: event.text, takeaways: event.takeaways, usage: event.usage, at };
          record.cost = addUsage(record.cost, event.usage);
        } else {
          record.summary = { modelId, modelDisplayName, text: "", takeaways: null, usage: null, error: event.message, at };
        }
        store.save(record);
      }
    }
    yield event;
  }
}

async function drain(events: AsyncIterable<DebateStreamEvent>, onEvent?: (event: DebateStreamEvent) => void) {
  for await (const event of events) {
    onEvent?.(event);
  }
}

/** Summarize a saved debate's whole transcript (follow-ups included) and store it. */
export async function summarizeSavedDebate(id: string, deps: RunnerDeps): Promise<void> {
  const { store } = deps;
  const record = store.load(id);
  if (!record) {
    throw new Error("Debate not found.");
  }
  const registry = deps.registry ?? getRegistry();
  let modelId = record.settings.summaryModelId ?? "";
  if (!modelId) {
    const { models } = await registry.listModels({ openRouterApiKey: deps.apiKey });
    modelId = pickDefaultSummaryModel(models, record.modelIds);
  }
  const events = runSummary(
    {
      contextBrief: buildContextBrief(record.question, record.context),
      documents: store.loadDocuments(record.documents),
      transcript: transcriptOf(record),
      modelId,
      reasoningEffort: record.settings.reasoningEffort,
      promptOverrides: record.settings.promptOverrides,
      panel: record.panel,
    },
    { apiKey: deps.apiKey, signal: deps.signal, registry },
  );
  await drain(recordSummary(store, id, events), deps.onEvent);
}

export interface StartDebateInput {
  source: NewDebateInput["source"];
  question: string;
  context?: string;
  documents: LabeledDocument[];
  preset?: string;
  modelIds: string[];
  settings: DebateSettings;
}

/** Run a new debate (and its summary when enabled) to completion, saving as it goes. */
export async function startSavedDebate(input: StartDebateInput, deps: RunnerDeps): Promise<SavedDebate> {
  const { store } = deps;
  const config = toDebateConfig({
    contextBrief: buildContextBrief(input.question, input.context),
    documents: input.documents,
    modelIds: input.modelIds,
    settings: input.settings,
  });
  let created: SavedDebate | null = null;
  let failure: string | null = null;
  await drain(
    recordDebate(store, runDebate(config, { apiKey: deps.apiKey, signal: deps.signal, registry: deps.registry }), {
      create: () => {
        created = store.create(input);
        return created;
      },
    }),
    (event) => {
      if (event.type === "error") {
        failure = event.message;
      }
      deps.onEvent?.(event);
    },
  );
  const record = created as SavedDebate | null;
  if (!record) {
    throw new Error(failure ?? (deps.signal?.aborted ? "Debate stopped before it started." : "Debate did not start."));
  }
  if (record.status === "done" && input.settings.summarize && !deps.signal?.aborted) {
    await summarizeSavedDebate(record.id, deps);
  }
  return store.load(record.id) ?? record;
}

/** The brief for continued rounds: question, the whole debate so far, the follow-up. */
export function continuationBrief(record: SavedDebate, followup?: string): string {
  const sections = [buildContextBrief(record.question, record.context)];
  const transcript = transcriptOf(record);
  if (transcript.length > 0) {
    sections.push(
      `## The debate so far\n\n${transcript
        .map((turn) =>
          turn.speakerIndex === USER_SPEAKER_INDEX
            ? `### Round ${turn.round}: follow-up from the user\n${turn.text.trim()}`
            : `### Round ${turn.round}: ${turn.modelDisplayName}${turn.stance ? ` [${turn.stance}]` : ""}\n${turn.text.trim()}`,
        )
        .join("\n\n")}`,
    );
  }
  if (followup) {
    sections.push(
      `## Follow-up from the user\nThe user has read the debate so far and asks: ${followup}\nAddress this in your next contributions.`,
    );
  }
  return sections.join("\n\n");
}

export interface ContinueOptions {
  followup?: string;
  rounds?: number;
}

/** Problems with continue arguments, before anything runs. */
export function validateContinueOptions(options: ContinueOptions): string | null {
  if (options.followup !== undefined && typeof options.followup !== "string") {
    return "followup must be a string.";
  }
  if ((options.followup?.length ?? 0) > MAX_QUESTION_CHARS) {
    return `followup must be at most ${MAX_QUESTION_CHARS.toLocaleString("en-US")} characters.`;
  }
  if (
    options.rounds !== undefined &&
    (typeof options.rounds !== "number" ||
      !Number.isInteger(options.rounds) ||
      options.rounds < ROUNDS_RANGE.min ||
      options.rounds > ROUNDS_RANGE.max)
  ) {
    return `rounds must be an integer between ${ROUNDS_RANGE.min} and ${ROUNDS_RANGE.max}.`;
  }
  return null;
}

/**
 * Continue a saved debate: append the follow-up (if any) as a user message,
 * run `rounds` (default 1) more rounds with the same panel and settings, each
 * model seeing the whole prior transcript, then re-summarize everything.
 */
export async function continueSavedDebate(id: string, options: ContinueOptions, deps: RunnerDeps): Promise<SavedDebate> {
  const { store } = deps;
  const problem = validateContinueOptions(options);
  if (problem) {
    throw new Error(problem);
  }
  const record = store.load(id);
  if (!record) {
    throw new Error(`No saved debate with id ${id}.`);
  }
  if (isRunningNow(record)) {
    throw new Error("This debate is still running; wait for it to finish or stop it first.");
  }

  const rounds = options.rounds ?? 1;
  const iteration = Math.max(1, ...record.turns.map((turn) => turn.iteration));
  const startRound =
    Math.max(0, ...record.turns.filter((turn) => turn.iteration === iteration).map((turn) => turn.round)) + 1;
  const followup = options.followup?.trim();
  // Each CLI call is stateless and a rebuttal prompt only carries the turns
  // since the speaker's last one, so the full prior debate (and the
  // follow-up, for every continued round) goes into the brief.
  const contextBrief = continuationBrief(record, followup);
  if (followup) {
    record.turns.push({
      iteration,
      round: startRound,
      speakerIndex: USER_SPEAKER_INDEX,
      modelId: USER_MODEL_ID,
      modelDisplayName: USER_DISPLAY_NAME,
      stance: null,
      text: followup,
      at: new Date().toISOString(),
    });
  }
  record.status = "running";
  record.pid = process.pid;
  delete record.error;
  store.save(record);

  const config = toDebateConfig({
    contextBrief,
    documents: store.loadDocuments(record.documents),
    modelIds: record.modelIds,
    settings: { ...record.settings, rounds },
  });
  // Randomized mode: continue the last iteration (same stance shuffle).
  config.iterations = record.settings.mode === "randomized_stances" ? Math.max(iteration, config.iterations) : 1;

  await drain(
    recordDebate(
      store,
      runDebate(config, {
        apiKey: deps.apiKey,
        signal: deps.signal,
        registry: deps.registry,
        resume: {
          // Follow-ups live in the brief; keep them out of the rebuttal messages.
          transcript: transcriptOf(record).filter((turn) => turn.speakerIndex !== USER_SPEAKER_INDEX),
          iteration,
          startRound,
        },
      }),
      { record },
    ),
    deps.onEvent,
  );
  // recordDebate updated the status while the debate ran.
  const finalStatus = record.status as DebateStatus;
  if (finalStatus === "done" && record.settings.summarize && !deps.signal?.aborted) {
    await summarizeSavedDebate(record.id, deps);
  }
  return store.load(record.id) ?? record;
}
