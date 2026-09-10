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

export function estimateDebateCost(
  options: EstimateDebateCostOptions,
): CostEstimateResult {
  const assumedOutputTokens = options.assumedOutputTokens ?? 1500;
  const briefAndDocsTokens =
    estimateTokens(options.contextBrief) +
    options.documents.reduce((sum, doc) => sum + estimateTokens(doc.content), 0);

  const totalIterations = options.mode === "randomized_stances" ? options.iterations : 1;
  const speakerCount = options.models.length;

  let totalUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  if (speakerCount > 0 && options.rounds > 0 && totalIterations > 0) {
    for (let iteration = 0; iteration < totalIterations; iteration += 1) {
      let turnsSoFarInIteration = 0;

      for (let round = 0; round < options.rounds; round += 1) {
        for (let speakerIndex = 0; speakerIndex < speakerCount; speakerIndex += 1) {
          const model = options.models[speakerIndex % options.models.length];
          const transcriptTokens = turnsSoFarInIteration * assumedOutputTokens;
          const turnInputTokens = briefAndDocsTokens + transcriptTokens;
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
