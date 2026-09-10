import type { DebateMode, DebateModelInfo, LabeledDocument } from "./types";

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface CostEstimateResult {
  totalUsd: number;
  inputTokens: number;
  outputTokens: number;
}

interface EstimateDebateCostOptions {
  models: DebateModelInfo[];
  contextBrief: string;
  documents: LabeledDocument[];
  rounds: number;
  iterations: number;
  mode: DebateMode;
  assumedOutputTokens?: number;
  summarize?: boolean;
  summaryModel?: DebateModelInfo;
}

// Repeat turns from the same model within an iteration send a byte-identical
// documents block behind an Anthropic-style cache_control marker (see
// lib/prompts.ts). This roughly approximates a cache read across providers
// (Anthropic, Google, and OpenAI's automatic caching all discount cached
// input heavily) without modeling each provider's exact cache pricing.
const REPEAT_TURN_DOCUMENT_TOKEN_FACTOR = 0.25;

export function estimateDebateCost(
  options: EstimateDebateCostOptions,
): CostEstimateResult {
  const assumedOutputTokens = options.assumedOutputTokens ?? 1500;
  const briefTokens = estimateTokens(options.contextBrief);
  const docsTokens = options.documents.reduce(
    (sum, doc) => sum + estimateTokens(doc.content),
    0,
  );
  const briefAndDocsTokens = briefTokens + docsTokens;

  const totalIterations = options.mode === "randomized_stances" ? options.iterations : 1;
  const speakerCount = options.models.length;

  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  if (speakerCount > 0 && options.rounds > 0 && totalIterations > 0) {
    for (let iteration = 0; iteration < totalIterations; iteration += 1) {
      let turnsSoFarInIteration = 0;

      for (let round = 0; round < options.rounds; round += 1) {
        const isFirstRound = round === 0;

        for (let speakerIndex = 0; speakerIndex < speakerCount; speakerIndex += 1) {
          const model = options.models[speakerIndex % options.models.length];
          const transcriptTokens = turnsSoFarInIteration * assumedOutputTokens;
          const effectiveDocsTokens = isFirstRound
            ? docsTokens
            : docsTokens * REPEAT_TURN_DOCUMENT_TOKEN_FACTOR;
          const turnInputTokens = briefTokens + effectiveDocsTokens + transcriptTokens;
          const turnOutputTokens = assumedOutputTokens;

          inputTokens += turnInputTokens;
          outputTokens += turnOutputTokens;

          totalUsd +=
            (turnInputTokens / 1_000_000) * model.pricing.promptPerMillion +
            (turnOutputTokens / 1_000_000) * model.pricing.completionPerMillion;

          turnsSoFarInIteration += 1;
        }
      }
    }
  }

  if (options.summarize && options.summaryModel) {
    const summaryOutputTokens = 1200;
    const allTurnsTokens =
      totalIterations * options.rounds * speakerCount * assumedOutputTokens;
    const summaryInputTokens = briefAndDocsTokens + allTurnsTokens;

    inputTokens += summaryInputTokens;
    outputTokens += summaryOutputTokens;

    totalUsd +=
      (summaryInputTokens / 1_000_000) * options.summaryModel.pricing.promptPerMillion +
      (summaryOutputTokens / 1_000_000) * options.summaryModel.pricing.completionPerMillion;
  }

  return { totalUsd, inputTokens, outputTokens };
}

export function formatUsd(amount: number): string {
  if (amount < 0.01 && amount > 0) {
    return "< $0.01";
  }
  return `$${amount.toFixed(2)}`;
}

export function formatTokenCount(count: number): string {
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(1)}m`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}k`;
  }
  return `${count}`;
}
