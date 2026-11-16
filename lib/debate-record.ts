// Saved-debate record types and pure helpers. No node: imports, so client
// pages can use them; the file store itself is lib/debate-store.ts.
import { formatSpend } from "./cost";
import type { DebateSettings } from "./debate-settings";
import type { TokenUsage, Takeaways, TranscriptMessage } from "./types";

export type DebateStatus = "running" | "done" | "error" | "stopped";
export type DebateSource = "web" | "mcp";

/** speakerIndex of a follow-up message the user added when continuing. */
export const USER_SPEAKER_INDEX = -1;
export const USER_MODEL_ID = "user";
export const USER_DISPLAY_NAME = "User follow-up";

export interface DocumentRef {
  label: string;
  /** File path, URL, PDF filename, or "pasted text". */
  source: string;
  sha256: string;
  chars: number;
}

export interface SavedTurn extends TranscriptMessage {
  usage?: TokenUsage | null;
  error?: string;
  at: string;
}

export interface PanelMember {
  modelId: string;
  modelDisplayName: string;
  stance: string | null;
}

export interface SavedSummary {
  modelId: string;
  modelDisplayName: string;
  text: string;
  takeaways: Takeaways | null;
  usage: TokenUsage | null;
  error?: string;
  at: string;
}

export interface DebateCost {
  usd: number;
  subscriptionCalls: number;
  promptTokens: number;
  completionTokens: number;
}

export interface SavedDebate {
  version: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: DebateSource;
  status: DebateStatus;
  error?: string;
  /** Process that is running the debate; a dead pid means it was interrupted. */
  pid?: number;
  question: string;
  context?: string;
  documents: DocumentRef[];
  preset?: string;
  modelIds: string[];
  settings: DebateSettings;
  panel: PanelMember[];
  turns: SavedTurn[];
  summary: SavedSummary | null;
  cost: DebateCost;
}

export interface DebateListItem {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  source: DebateSource;
  status: DebateStatus;
  models: string[];
  turnCount: number;
}

const ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{6}$/;
export const MAX_TITLE_CHARS = 200;

export function isDebateId(id: string): boolean {
  return ID_PATTERN.test(id);
}

export function emptyCost(): DebateCost {
  return { usd: 0, subscriptionCalls: 0, promptTokens: 0, completionTokens: 0 };
}

export function addUsage(cost: DebateCost, usage: TokenUsage | null | undefined): DebateCost {
  if (!usage) {
    return cost;
  }
  return {
    usd: cost.usd + (usage.cost ?? 0),
    subscriptionCalls: cost.subscriptionCalls + (usage.billing === "subscription" ? 1 : 0),
    promptTokens: cost.promptTokens + usage.promptTokens,
    completionTokens: cost.completionTokens + usage.completionTokens,
  };
}

export function formatDebateCost(cost: DebateCost): string {
  if (cost.usd === 0 && cost.subscriptionCalls > 0) {
    return `subscription (${formatSpend(0, cost.subscriptionCalls)}, no per-token $)`;
  }
  return formatSpend(cost.usd, cost.subscriptionCalls);
}

/** The text the models saw: turns that produced text, follow-ups included. */
export function transcriptOf(record: Pick<SavedDebate, "turns">): TranscriptMessage[] {
  return record.turns
    .filter((turn) => turn.text.trim().length > 0)
    .map((turn) => ({
      iteration: turn.iteration,
      round: turn.round,
      speakerIndex: turn.speakerIndex,
      modelId: turn.modelId,
      modelDisplayName: turn.modelDisplayName,
      stance: turn.stance,
      text: turn.text,
    }));
}
