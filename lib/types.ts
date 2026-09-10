export type DebateMode =
  | "conversation"
  | "assigned_stances"
  | "randomized_stances";

export type ReasoningEffort = "normal" | "high";

export interface LabeledDocument {
  label: string;
  content: string;
}

export interface PdfExtractionResult {
  label: string;
  text: string;
  pageCount: number;
  filename: string;
  warning?: string;
}

export interface UrlFetchResult {
  label: string;
  text: string;
  source: "wikipedia" | "web";
  warning?: string;
}

export interface Stance {
  label: string;
  instruction: string;
}

export type PromptOverrides = Partial<{
  seedNeutral: string;
  seedStance: string;
  rebuttal: string;
  summary: string;
}>;

export interface DebateConfig {
  contextBrief: string;
  documents: LabeledDocument[];
  modelIds: string[];
  mode: DebateMode;
  reasoningEffort: ReasoningEffort;
  rounds: number;
  iterations: number;
  stances: Stance[];
  summarize?: boolean;
  summaryModelId?: string;
  promptOverrides?: PromptOverrides;
}

export interface SummarizeRequest {
  contextBrief: string;
  documents: LabeledDocument[];
  transcript: TranscriptMessage[];
  modelId: string;
  reasoningEffort: ReasoningEffort;
  promptOverrides?: PromptOverrides;
  panel: Array<{ modelId?: string; modelDisplayName: string; stance: string | null }>;
}

export interface Takeaway {
  title: string; // short imperative or declarative headline
  detail: string; // one or two sentences, may reference documents
  kind: "action" | "finding";
  supporters: string[]; // model display names that made or backed this point
  dissenters: string[]; // model display names that argued against it
}

export interface Disagreement {
  topic: string;
  positions: Array<{ model: string; position: string }>;
}

export interface Takeaways {
  verdict: string; // 1-3 sentences: the single most important conclusion or recommendation
  confidence: "high" | "medium" | "low";
  takeaways: Takeaway[];
  disagreements: Disagreement[];
}

export interface ModelPricing {
  promptPerMillion: number;
  completionPerMillion: number;
}

export interface DebateModelInfo {
  id: string;
  displayName: string;
  description?: string;
  available: boolean;
  recommended: boolean;
  supportsReasoningEffort: boolean;
  supportsJsonResponse: boolean;
  provider: string;
  contextLength: number;
  pricing: ModelPricing;
  created?: number;
}

export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  cost: number | null;
}

export interface TranscriptMessage {
  iteration: number;
  round: number;
  speakerIndex: number;
  modelId: string;
  modelDisplayName: string;
  stance: string | null;
  text: string;
}

export type DebateStreamEvent =
  | { type: "debate_start"; totalIterations: number; rounds: number }
  | {
      type: "iteration_start";
      iteration: number;
      assignments: Array<{
        modelId: string;
        modelDisplayName: string;
        stance: string | null;
      }>;
    }
  | { type: "round_start"; iteration: number; round: number }
  | {
      type: "turn_start";
      iteration: number;
      round: number;
      speakerIndex: number;
      modelId: string;
      modelDisplayName: string;
      stance: string | null;
    }
  | {
      type: "token";
      iteration: number;
      round: number;
      speakerIndex: number;
      text: string;
    }
  | {
      type: "activity";
      iteration: number;
      round: number;
      speakerIndex: number;
      message: string;
    }
  | {
      type: "reasoning";
      iteration: number;
      round: number;
      speakerIndex: number;
      text: string;
    }
  | {
      type: "turn_end";
      iteration: number;
      round: number;
      speakerIndex: number;
      modelId: string;
      runId?: string;
      text: string;
      usage: TokenUsage | null;
    }
  | { type: "round_end"; iteration: number; round: number }
  | { type: "iteration_end"; iteration: number }
  | { type: "debate_end" }
  | { type: "summary_start"; modelId: string; modelDisplayName: string }
  | { type: "summary_token"; text: string }
  | {
      type: "summary_end";
      text: string;
      takeaways: Takeaways | null;
      usage: TokenUsage | null;
    }
  | { type: "summary_error"; message: string }
  | { type: "error"; message: string; retryable?: boolean };

export interface DebaterAssignment {
  modelId: string;
  modelDisplayName: string;
  stance: Stance | null;
}
