import { AsyncQueue } from "./async-queue";
import { listDebateModels } from "./models";
import { OpenRouterError, streamChatCompletion } from "./openrouter";
import { buildRebuttalMessages, buildSeedMessages } from "./prompts";
import { DEFAULT_STANCES } from "./stances";
import type {
  ChatMessage,
  DebateConfig,
  DebateModelInfo,
  DebateStreamEvent,
  DebaterAssignment,
  Stance,
  TokenUsage,
  TranscriptMessage,
} from "./types";

const MAX_TURN_ATTEMPTS = 2;
const TURN_RETRY_DELAY_MS = 3_000;

function iterationCount(config: DebateConfig): number {
  return config.mode === "randomized_stances" ? config.iterations : 1;
}

function stanceLabel(stance: Stance | null): string | null {
  return stance?.label ?? null;
}

function assignStances(
  config: DebateConfig,
  modelCatalog: Map<string, DebateModelInfo>,
  iteration: number,
): DebaterAssignment[] {
  const stances = config.stances.filter(
    (stance) =>
      stance.label.trim().length > 0 && stance.instruction.trim().length > 0,
  );

  if (config.mode === "conversation") {
    return config.modelIds.map((modelId) => ({
      modelId,
      modelDisplayName: modelCatalog.get(modelId)?.displayName ?? modelId,
      stance: null,
    }));
  }

  const effectiveStances = stances.length >= 2 ? stances : DEFAULT_STANCES;

  let orderedModelIds = [...config.modelIds];

  if (config.mode === "randomized_stances") {
    orderedModelIds = shuffleWithSeed(orderedModelIds, iteration);
  }

  return orderedModelIds.map((modelId, index) => ({
    modelId,
    modelDisplayName: modelCatalog.get(modelId)?.displayName ?? modelId,
    stance: effectiveStances[index % effectiveStances.length],
  }));
}

function shuffleWithSeed<T>(items: T[], seed: number): T[] {
  const copy = [...items];
  let state = seed * 2654435761;

  for (let i = copy.length - 1; i > 0; i -= 1) {
    state = (state * 1664525 + 1013904223) >>> 0;
    const j = state % (i + 1);
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }

  return copy;
}

function messagesSinceLastTurn(
  transcript: TranscriptMessage[],
  iteration: number,
  speakerIndex: number,
): TranscriptMessage[] {
  let lastSeenIndex = -1;

  for (let i = transcript.length - 1; i >= 0; i -= 1) {
    const message = transcript[i];
    if (message.iteration !== iteration) {
      continue;
    }
    if (message.speakerIndex === speakerIndex) {
      lastSeenIndex = i;
      break;
    }
  }

  return transcript.filter(
    (message, index) =>
      message.iteration === iteration &&
      index > lastSeenIndex &&
      message.speakerIndex !== speakerIndex,
  );
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(err: unknown): boolean {
  if (err instanceof OpenRouterError) {
    return err.retryable;
  }
  return false;
}

async function* runDebateTurn(options: {
  apiKey: string;
  assignment: DebaterAssignment;
  modelInfo: DebateModelInfo | undefined;
  reasoningEffort: DebateConfig["reasoningEffort"];
  messages: ChatMessage[];
  iteration: number;
  round: number;
  speakerIndex: number;
  signal?: AbortSignal;
  suppressTurnStart?: boolean;
}): AsyncGenerator<DebateStreamEvent, { text: string; usage: TokenUsage | null }> {
  if (options.signal?.aborted) {
    throw new DOMException("Debate aborted", "AbortError");
  }

  if (!options.suppressTurnStart) {
    yield {
      type: "turn_start",
      iteration: options.iteration,
      round: options.round,
      speakerIndex: options.speakerIndex,
      modelId: options.assignment.modelId,
      modelDisplayName: options.assignment.modelDisplayName,
      stance: options.assignment.stance?.label ?? null,
    };
  }

  const queue = new AsyncQueue<DebateStreamEvent>();
  let sawReasoningActivity = false;
  let sawContentToken = false;
  let finalResult: { text: string; usage: TokenUsage | null } | null = null;

  void streamChatCompletion({
    apiKey: options.apiKey,
    model: options.assignment.modelId,
    messages: options.messages,
    reasoningEffort: options.reasoningEffort,
    supportsReasoningEffort: options.modelInfo?.supportsReasoningEffort ?? false,
    signal: options.signal,
    onReasoning: (text) => {
      if (!sawReasoningActivity && !sawContentToken) {
        sawReasoningActivity = true;
        queue.push({
          type: "activity",
          iteration: options.iteration,
          round: options.round,
          speakerIndex: options.speakerIndex,
          message: "Thinking…",
        });
      }
      queue.push({
        type: "reasoning",
        iteration: options.iteration,
        round: options.round,
        speakerIndex: options.speakerIndex,
        text,
      });
    },
    onToken: (text) => {
      sawContentToken = true;
      queue.push({
        type: "token",
        iteration: options.iteration,
        round: options.round,
        speakerIndex: options.speakerIndex,
        text,
      });
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

  yield {
    type: "turn_end",
    iteration: options.iteration,
    round: options.round,
    speakerIndex: options.speakerIndex,
    modelId: options.assignment.modelId,
    text,
    usage,
  };

  return { text, usage };
}

export async function* runDebate(
  config: DebateConfig,
  options?: { apiKey?: string; signal?: AbortSignal },
): AsyncGenerator<DebateStreamEvent> {
  const apiKey = options?.apiKey;

  if (!apiKey) {
    yield {
      type: "error",
      message:
        "No OpenRouter API key. Add one on the Settings page or set OPENROUTER_API_KEY in .env.local.",
    };
    return;
  }

  if (config.modelIds.length < 2) {
    yield {
      type: "error",
      message: "Select at least two models to run a debate.",
    };
    return;
  }

  const { models } = await listDebateModels(apiKey);
  const modelCatalog = new Map(models.map((model) => [model.id, model]));
  const transcript: TranscriptMessage[] = [];
  const totalIterations = iterationCount(config);

  yield {
    type: "debate_start",
    totalIterations,
    rounds: config.rounds,
  };

  for (let iteration = 1; iteration <= totalIterations; iteration += 1) {
    if (options?.signal?.aborted) {
      return;
    }

    const assignments = assignStances(config, modelCatalog, iteration);

    yield {
      type: "iteration_start",
      iteration,
      assignments: assignments.map((assignment) => ({
        modelId: assignment.modelId,
        modelDisplayName: assignment.modelDisplayName,
        stance: stanceLabel(assignment.stance),
      })),
    };

    for (let round = 1; round <= config.rounds; round += 1) {
      if (options?.signal?.aborted) {
        return;
      }

      yield { type: "round_start", iteration, round };

      for (
        let speakerIndex = 0;
        speakerIndex < assignments.length;
        speakerIndex += 1
      ) {
        if (options?.signal?.aborted) {
          return;
        }

        const assignment = assignments[speakerIndex];
        const modelInfo = modelCatalog.get(assignment.modelId);
        const isFirstTurnForSpeaker =
          transcript.findIndex(
            (message) =>
              message.iteration === iteration &&
              message.speakerIndex === speakerIndex,
          ) === -1;

        const promptOverrides = config.promptOverrides;
        const messages = isFirstTurnForSpeaker
          ? buildSeedMessages({
              contextBrief: config.contextBrief,
              documents: config.documents,
              stance: assignment.stance,
              templateOverride:
                assignment.stance === null
                  ? promptOverrides?.seedNeutral
                  : promptOverrides?.seedStance,
              systemTemplateOverride: promptOverrides?.systemContext,
            })
          : buildRebuttalMessages({
              contextBrief: config.contextBrief,
              documents: config.documents,
              stance: assignment.stance,
              messages: messagesSinceLastTurn(
                transcript,
                iteration,
                speakerIndex,
              ).map((message) => ({
                speaker: message.modelDisplayName,
                stance: message.stance,
                text: message.text,
              })),
              ownMessages:
                config.speakerMemory === false
                  ? []
                  : transcript
                      .filter(
                        (message) =>
                          message.iteration === iteration &&
                          message.speakerIndex === speakerIndex,
                      )
                      .map((message) => ({
                        round: message.round,
                        text: message.text,
                      })),
              templateOverride: promptOverrides?.rebuttal,
              systemTemplateOverride: promptOverrides?.systemContext,
            });

        try {
          let turnText = "";
          let turnStarted = false;

          for (let attempt = 1; attempt <= MAX_TURN_ATTEMPTS; attempt += 1) {
            if (attempt > 1) {
              yield {
                type: "activity",
                iteration,
                round,
                speakerIndex,
                message: "Retrying after a temporary error…",
              };
              await sleep(TURN_RETRY_DELAY_MS);
            }

            try {
              const turnGenerator = runDebateTurn({
                apiKey,
                assignment,
                modelInfo,
                reasoningEffort: config.reasoningEffort,
                messages,
                iteration,
                round,
                speakerIndex,
                signal: options?.signal,
                suppressTurnStart: turnStarted,
              });

              turnText = "";
              while (true) {
                const next = await turnGenerator.next();
                if (next.done) {
                  turnText = next.value.text;
                  break;
                }
                if (next.value.type === "turn_start") {
                  turnStarted = true;
                }
                yield next.value;
              }

              break;
            } catch (err) {
              if (err instanceof DOMException && err.name === "AbortError") {
                throw err;
              }

              if (isRetryableError(err) && attempt < MAX_TURN_ATTEMPTS) {
                continue;
              }

              throw err;
            }
          }

          transcript.push({
            iteration,
            round,
            speakerIndex,
            modelId: assignment.modelId,
            modelDisplayName: assignment.modelDisplayName,
            stance: stanceLabel(assignment.stance),
            text: turnText,
          });
        } catch (err) {
          if (err instanceof DOMException && err.name === "AbortError") {
            return;
          }

          const message =
            err instanceof Error ? err.message : "Unknown debate error";
          const retryable = isRetryableError(err);

          console.error(
            `[debate] turn error iteration=${iteration} round=${round} speaker=${speakerIndex} model=${assignment.modelId} retryable=${retryable} message=${message}`,
          );

          yield {
            type: "error",
            message: retryable
              ? `${message} You can press Start debate to try again.`
              : message,
            retryable,
          };
          return;
        }
      }

      yield { type: "round_end", iteration, round };
    }

    yield { type: "iteration_end", iteration };
  }

  yield { type: "debate_end" };
}
