"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  DebateConfig,
  DebateMode,
  DebateModelInfo,
  DebateStreamEvent,
  Disagreement,
  PdfExtractionResult,
  ReasoningEffort,
  Stance,
  Takeaway,
  Takeaways,
  TokenUsage,
  TranscriptMessage,
  UrlFetchResult,
} from "@/lib/types";
import { readPromptOverrides } from "@/lib/prompt-store";
import { pickDefaultSummaryModel } from "@/lib/summary-utils";
import { apiHeaders } from "@/lib/api-key-store";
import { DEFAULT_STANCES } from "@/lib/stances";
import { MAX_DOCUMENT_CHARS } from "@/lib/limits";
import {
  estimateDebateCost,
  formatTokenCount,
  formatUsd,
} from "@/lib/cost";
import type { DebateExample, ExamplesIndex } from "@/lib/examples";
import { Markdown } from "@/app/components/Markdown";

type SourceMeta =
  | { kind: "pdf"; filename: string; pageCount: number; warning?: string }
  | { kind: "url"; url: string; title: string; warning?: string }
  | null;

interface DocumentRow {
  id: string;
  label: string;
  content: string;
  sourceMeta: SourceMeta;
  loading?: boolean;
  showUrlInput?: boolean;
  urlDraft?: string;
  urlFetching?: boolean;
  urlError?: string;
}

interface TurnBlock {
  key: string;
  iteration: number;
  round: number;
  speakerIndex: number;
  modelId: string;
  modelDisplayName: string;
  stance: string | null;
  text: string;
  reasoning: string;
  activity: string | null;
  streaming: boolean;
  usage: TokenUsage | null;
}

interface PanelEntry {
  modelId: string;
  modelDisplayName: string;
  stance: string | null;
}

interface StanceColorClasses {
  border: string;
  bg: string;
  chip: string;
}

const SPEAKER_COLOR_CYCLE: StanceColorClasses[] = [
  {
    border: "border-l-violet-500",
    bg: "bg-violet-500/5",
    chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  {
    border: "border-l-sky-500",
    bg: "bg-sky-500/5",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  {
    border: "border-l-emerald-500",
    bg: "bg-emerald-500/5",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    border: "border-l-amber-500",
    bg: "bg-amber-500/5",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  {
    border: "border-l-rose-500",
    bg: "bg-rose-500/5",
    chip: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
  {
    border: "border-l-cyan-500",
    bg: "bg-cyan-500/5",
    chip: "bg-cyan-500/10 text-cyan-700 dark:text-cyan-300",
  },
];

const STANCE_FIXED_COLORS: Record<string, StanceColorClasses> = {
  pro: {
    border: "border-l-violet-500",
    bg: "bg-violet-500/5",
    chip: "bg-violet-500/10 text-violet-700 dark:text-violet-300",
  },
  against: {
    border: "border-l-amber-500",
    bg: "bg-amber-500/5",
    chip: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
  },
  balanced: {
    border: "border-l-zinc-500",
    bg: "bg-zinc-500/5",
    chip: "bg-zinc-500/10 text-zinc-700 dark:text-zinc-300",
  },
};

const CUSTOM_STANCE_CYCLE: StanceColorClasses[] = [
  {
    border: "border-l-sky-500",
    bg: "bg-sky-500/5",
    chip: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  },
  {
    border: "border-l-emerald-500",
    bg: "bg-emerald-500/5",
    chip: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  },
  {
    border: "border-l-rose-500",
    bg: "bg-rose-500/5",
    chip: "bg-rose-500/10 text-rose-700 dark:text-rose-300",
  },
];

const customStanceIndex = new Map<string, number>();

/** Color turn cards and chips by stance, not by speaker order. */
function stanceColor(stance: string | null, speakerIndex: number): StanceColorClasses {
  if (stance === null) {
    return SPEAKER_COLOR_CYCLE[speakerIndex % SPEAKER_COLOR_CYCLE.length];
  }
  const key = stance.trim().toLowerCase();
  if (STANCE_FIXED_COLORS[key]) {
    return STANCE_FIXED_COLORS[key];
  }
  if (!customStanceIndex.has(key)) {
    customStanceIndex.set(key, customStanceIndex.size);
  }
  const idx = customStanceIndex.get(key)! % CUSTOM_STANCE_CYCLE.length;
  return CUSTOM_STANCE_CYCLE[idx];
}

const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  "x-ai": "xAI",
  deepseek: "DeepSeek",
  moonshotai: "Moonshot AI",
  qwen: "Qwen",
  "meta-llama": "Meta",
  mistralai: "Mistral AI",
};

function formatProviderName(provider: string): string {
  if (PROVIDER_DISPLAY_NAMES[provider]) {
    return PROVIDER_DISPLAY_NAMES[provider];
  }
  return provider
    .split("-")
    .map((part) => (part ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function formatContextLength(length: number): string {
  if (length >= 1_000_000) {
    const value = length / 1_000_000;
    return `${Number.isInteger(value) ? value : value.toFixed(1)}m ctx`;
  }
  if (length >= 1_000) {
    return `${Math.round(length / 1000)}k ctx`;
  }
  return `${length} ctx`;
}

function trimNumber(value: number): string {
  if (value >= 10) {
    return value.toFixed(0);
  }
  const fixed = value.toFixed(2);
  return fixed.replace(/\.?0+$/, "") || "0";
}

function formatPricing(model: DebateModelInfo): string {
  return `$${trimNumber(model.pricing.promptPerMillion)} / $${trimNumber(
    model.pricing.completionPerMillion,
  )} per M tokens`;
}

function formatModeLabel(mode: DebateMode): string {
  switch (mode) {
    case "conversation":
      return "Conversation";
    case "assigned_stances":
      return "Assigned stances";
    case "randomized_stances":
      return "Randomized stances";
  }
}

function formatElapsed(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${pad2(s)}`;
}

const INITIAL_DOCUMENTS: DocumentRow[] = [
  { id: "doc-1", label: "", content: "", sourceMeta: null },
  { id: "doc-2", label: "", content: "", sourceMeta: null },
];

function newDocumentRow(): DocumentRow {
  return {
    id: crypto.randomUUID(),
    label: "",
    content: "",
    sourceMeta: null,
  };
}

function parseSseChunk(
  buffer: string,
  onEvent: (event: DebateStreamEvent) => void,
): string {
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";

  for (const part of parts) {
    const line = part
      .split("\n")
      .find((entry) => entry.startsWith("data: "));
    if (!line) {
      continue;
    }
    try {
      onEvent(JSON.parse(line.slice(6)) as DebateStreamEvent);
    } catch {
      // Ignore malformed chunks.
    }
  }

  return remainder;
}

function newStance(): Stance {
  return { label: "", instruction: "" };
}

function turnsToTranscript(turns: TurnBlock[]): TranscriptMessage[] {
  return turns
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

function sourceKindLabel(sourceMeta: SourceMeta): string {
  if (!sourceMeta) {
    return "pasted text";
  }
  if (sourceMeta.kind === "pdf") {
    return "PDF upload";
  }
  return "URL";
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

function exportFilename(): string {
  const now = new Date();
  const date = `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
  const time = `${pad2(now.getHours())}${pad2(now.getMinutes())}`;
  return `ai-panel-debate-${date}-${time}.md`;
}

function isFullyAgreed(takeaway: Takeaway, panel: PanelEntry[]): boolean {
  if (panel.length === 0) {
    return false;
  }
  return (
    panel.every((p) => takeaway.supporters.includes(p.modelDisplayName)) &&
    takeaway.dissenters.length === 0
  );
}

function PanelChip({ entry }: { entry: PanelEntry }) {
  const colors = stanceColor(entry.stance, 0);
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${colors.chip}`}
    >
      {entry.modelDisplayName}
      {entry.stance && <span className="opacity-70">· {entry.stance}</span>}
    </span>
  );
}

function ConfidencePill({ confidence }: { confidence: Takeaways["confidence"] }) {
  const styles: Record<Takeaways["confidence"], string> = {
    high: "bg-emerald-100 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-200",
    medium: "bg-amber-100 text-amber-800 dark:bg-amber-950/50 dark:text-amber-200",
    low: "bg-red-100 text-red-800 dark:bg-red-950/50 dark:text-red-200",
  };
  return (
    <span
      className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${styles[confidence]}`}
    >
      Panel confidence: {confidence}
    </span>
  );
}

function VoteStrip({ takeaway, panel }: { takeaway: Takeaway; panel: PanelEntry[] }) {
  const title = `Supporters: ${takeaway.supporters.join(", ") || "none"} · Dissenters: ${
    takeaway.dissenters.join(", ") || "none"
  }`;
  return (
    <div className="flex items-center gap-1" title={title}>
      {panel.map((p) => {
        const isSupporter = takeaway.supporters.includes(p.modelDisplayName);
        const isDissenter = takeaway.dissenters.includes(p.modelDisplayName);
        return (
          <span
            key={p.modelId}
            className={`inline-block h-2.5 w-2.5 shrink-0 rounded-full ${
              isSupporter
                ? "bg-emerald-500"
                : isDissenter
                  ? "border-2 border-red-500 bg-transparent"
                  : "border border-zinc-300 dark:border-zinc-700"
            }`}
          />
        );
      })}
    </div>
  );
}

function TakeawayRow({
  takeaway,
  panel,
  showVotesLine,
}: {
  takeaway: Takeaway;
  panel: PanelEntry[];
  showVotesLine: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <span className="mt-1 shrink-0">
        {takeaway.kind === "action" ? (
          <span className="block h-3 w-3 rounded-[3px] border-2 border-zinc-400 dark:border-zinc-500" />
        ) : (
          <span className="block h-2 w-2 rounded-full bg-zinc-400 dark:bg-zinc-500" />
        )}
      </span>
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
          {takeaway.title}
        </p>
        <div className="text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          <Markdown text={takeaway.detail} />
        </div>
        {showVotesLine && (
          <p className="text-xs text-zinc-500">
            For: {takeaway.supporters.join(", ") || "none"} · Against:{" "}
            {takeaway.dissenters.join(", ") || "none"}
          </p>
        )}
      </div>
      <VoteStrip takeaway={takeaway} panel={panel} />
    </div>
  );
}

function DisagreementCard({ disagreement }: { disagreement: Disagreement }) {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <p className="text-sm font-semibold text-zinc-900 dark:text-zinc-50">
        {disagreement.topic}
      </p>
      <ul className="mt-1 space-y-1">
        {disagreement.positions.map((pos, index) => (
          <li key={`${disagreement.topic}-${index}`} className="text-sm text-zinc-700 dark:text-zinc-300">
            <span className="font-medium">{pos.model}:</span> {pos.position}
          </li>
        ))}
      </ul>
    </div>
  );
}

function TurnCard({ turn }: { turn: TurnBlock }) {
  const colors = stanceColor(turn.stance, turn.speakerIndex);
  const hasContentStarted = turn.text.length > 0;
  // null = no manual override yet: auto-expanded while no content has
  // arrived, auto-collapsed once content starts streaming in.
  const [manualReasoningOpen, setManualReasoningOpen] = useState<boolean | null>(
    null,
  );
  const reasoningOpen =
    manualReasoningOpen !== null ? manualReasoningOpen : !hasContentStarted;
  const [showFull, setShowFull] = useState(false);

  const isCollapsed = !turn.streaming && !showFull;
  const looksLong = turn.text.length > 480 || turn.text.split("\n").length > 8;

  return (
    <article
      className={`rounded-xl border border-zinc-200 border-l-4 p-4 dark:border-zinc-800 ${colors.border} ${colors.bg}`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{turn.modelDisplayName}</span>
        <span className="rounded-full bg-zinc-900/5 px-2 py-0.5 font-mono text-[11px] font-medium text-zinc-600 dark:bg-white/10 dark:text-zinc-300">
          {turn.modelId}
        </span>
        {turn.stance && (
          <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${colors.chip}`}>
            {turn.stance}
          </span>
        )}
        {turn.streaming && (
          <span className="text-xs text-zinc-500">streaming…</span>
        )}
      </div>

      {turn.reasoning && (
        <details
          open={reasoningOpen}
          onToggle={(event) => setManualReasoningOpen(event.currentTarget.open)}
          className="mb-2"
        >
          <summary className="cursor-pointer select-none text-xs font-medium text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300">
            Thinking
          </summary>
          <div className="mt-1 max-h-40 overflow-y-auto whitespace-pre-wrap rounded-lg bg-zinc-900/5 p-2 text-xs leading-5 text-zinc-600 dark:bg-white/5 dark:text-zinc-400">
            {turn.reasoning}
          </div>
        </details>
      )}

      <div style={isCollapsed ? { maxHeight: "13em", overflow: "hidden" } : undefined}>
        {turn.text ? (
          <Markdown text={turn.text} className="max-w-[75ch] text-sm text-zinc-800 dark:text-zinc-200" />
        ) : turn.activity ? (
          <p className="text-sm text-zinc-500 italic">{turn.activity}</p>
        ) : (
          <p className="text-sm text-zinc-400">Waiting…</p>
        )}
      </div>
      {!turn.streaming && looksLong && (
        <button
          type="button"
          onClick={() => setShowFull((current) => !current)}
          className="mt-1 text-xs font-medium text-violet-600 hover:text-violet-500"
        >
          {showFull ? "Show less" : "Show more"}
        </button>
      )}

      {turn.usage && (
        <p className="mt-2 text-[11px] text-zinc-400">
          in {formatTokenCount(turn.usage.promptTokens)} / out{" "}
          {formatTokenCount(turn.usage.completionTokens)}
          {turn.usage.cost !== null ? ` · ${formatUsd(turn.usage.cost)}` : ""}
        </p>
      )}
    </article>
  );
}

export default function HomePage() {
  const [contextBrief, setContextBrief] = useState("");
  const [documents, setDocuments] =
    useState<DocumentRow[]>(INITIAL_DOCUMENTS);
  const [models, setModels] = useState<DebateModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [selectedModelIds, setSelectedModelIds] = useState<string[]>([]);
  const [mode, setMode] = useState<DebateMode>("assigned_stances");
  const [reasoningEffort, setReasoningEffort] =
    useState<ReasoningEffort>("high");
  const [rounds, setRounds] = useState(3);
  const [iterations, setIterations] = useState(3);
  const [stances, setStances] = useState<Stance[]>(
    DEFAULT_STANCES.map((stance) => ({ ...stance })),
  );
  const [summarizeEnabled, setSummarizeEnabled] = useState(true);
  const [summaryModelId, setSummaryModelId] = useState("");
  const [summaryText, setSummaryText] = useState("");
  const [takeaways, setTakeaways] = useState<Takeaways | null>(null);
  const [summaryStatus, setSummaryStatus] = useState<
    "idle" | "loading" | "streaming" | "done" | "error"
  >("idle");
  const [summaryError, setSummaryError] = useState<string | null>(null);
  const [summaryModelName, setSummaryModelName] = useState<string | null>(null);
  const [summaryUsage, setSummaryUsage] = useState<TokenUsage | null>(null);
  const [turns, setTurns] = useState<TurnBlock[]>([]);
  const [status, setStatus] = useState<
    "idle" | "loading" | "running" | "done" | "error"
  >("idle");
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorRetryable, setErrorRetryable] = useState(false);
  const [extractingPdfDocId, setExtractingPdfDocId] = useState<string | null>(
    null,
  );
  const [examples, setExamples] = useState<DebateExample[]>([]);
  const [loadingExampleId, setLoadingExampleId] = useState<string | null>(null);
  const [exportKind, setExportKind] = useState<
    "transcript" | "summary" | "both"
  >("both");
  const [costSoFar, setCostSoFar] = useState<{ usd: number; tokens: number }>({
    usd: 0,
    tokens: 0,
  });
  const [panelRoster, setPanelRoster] = useState<PanelEntry[]>([]);
  const [runRounds, setRunRounds] = useState(0);
  const [runTotalIterations, setRunTotalIterations] = useState(0);
  const [currentRound, setCurrentRound] = useState(0);
  const [currentIteration, setCurrentIteration] = useState(0);
  const [currentSpeakerName, setCurrentSpeakerName] = useState<string | null>(
    null,
  );
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showDebateInResults, setShowDebateInResults] = useState(false);
  const [verdictExpanded, setVerdictExpanded] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const summaryAbortRef = useRef<AbortController | null>(null);
  const turnsRef = useRef<TurnBlock[]>([]);
  const summarizeEnabledRef = useRef(summarizeEnabled);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const debateStartRef = useRef<number | null>(null);
  const panelRosterRef = useRef<PanelEntry[]>([]);

  const loadModels = useCallback(() => {
    void fetch("/api/models", { headers: apiHeaders() })
      .then((response) => response.json())
      .then((data: { models: DebateModelInfo[]; error?: string }) => {
        setModels(data.models ?? []);
        setModelsError(data.error ?? null);
        const recommendedIds = (data.models ?? [])
          .filter((model) => model.available && model.recommended)
          .map((model) => model.id);
        const fallbackIds = (data.models ?? [])
          .filter((model) => model.available)
          .map((model) => model.id);
        const defaultIds =
          recommendedIds.length > 0
            ? recommendedIds.slice(0, Math.min(3, recommendedIds.length))
            : fallbackIds.slice(0, Math.min(3, fallbackIds.length));
        setSelectedModelIds(defaultIds);
      })
      .catch(() => {
        setModelsError("Failed to load models.");
      });
  }, []);

  useEffect(() => {
    loadModels();
  }, [loadModels]);

  useEffect(() => {
    void fetch("/examples/index.json")
      .then((response) => response.json())
      .then((data: ExamplesIndex) => setExamples(data.examples ?? []))
      .catch(() => setExamples([]));
  }, []);

  useEffect(() => {
    turnsRef.current = turns;
  }, [turns]);

  useEffect(() => {
    summarizeEnabledRef.current = summarizeEnabled;
  }, [summarizeEnabled]);

  useEffect(() => {
    panelRosterRef.current = panelRoster;
  }, [panelRoster]);

  const effectiveSummaryModelId =
    summaryModelId || pickDefaultSummaryModel(models, selectedModelIds);

  const isRunning = status === "loading" || status === "running";
  const isSummaryRunning =
    summaryStatus === "loading" || summaryStatus === "streaming";

  // Elapsed time ticker while the debate is actively running.
  useEffect(() => {
    if (!isRunning) {
      return;
    }
    const id = setInterval(() => {
      setElapsedSeconds(
        debateStartRef.current
          ? Math.floor((Date.now() - debateStartRef.current) / 1000)
          : 0,
      );
    }, 1000);
    return () => clearInterval(id);
  }, [isRunning]);

  const viewState: "setup" | "running" | "results" = useMemo(() => {
    if (isRunning) {
      return "running";
    }
    if (status === "done") {
      return isSummaryRunning ? "running" : "results";
    }
    // idle or error
    return turns.length > 0 ? "running" : "setup";
  }, [isRunning, status, isSummaryRunning, turns.length]);

  const previousViewStateRef = useRef(viewState);
  useEffect(() => {
    if (viewState === "results" && previousViewStateRef.current !== "results") {
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
    previousViewStateRef.current = viewState;
  }, [viewState]);

  useEffect(() => {
    if (viewState !== "results") {
      transcriptRef.current?.scrollTo({
        top: transcriptRef.current.scrollHeight,
        behavior: "smooth",
      });
    }
  }, [turns, status, viewState]);

  const groupedTurns = useMemo(() => {
    const byIteration = new Map<number, Map<number, TurnBlock[]>>();

    for (const turn of turns) {
      if (!byIteration.has(turn.iteration)) {
        byIteration.set(turn.iteration, new Map());
      }
      const byRound = byIteration.get(turn.iteration)!;
      if (!byRound.has(turn.round)) {
        byRound.set(turn.round, []);
      }
      byRound.get(turn.round)!.push(turn);
    }

    return [...byIteration.entries()].sort(([a], [b]) => a - b);
  }, [turns]);

  const topModels = useMemo(
    () => models.filter((model) => model.recommended),
    [models],
  );
  const moreModels = useMemo(
    () => models.filter((model) => !model.recommended),
    [models],
  );
  const moreModelsByProvider = useMemo(() => {
    const groups = new Map<string, DebateModelInfo[]>();
    for (const model of moreModels) {
      if (!groups.has(model.provider)) {
        groups.set(model.provider, []);
      }
      groups.get(model.provider)!.push(model);
    }
    return [...groups.entries()];
  }, [moreModels]);

  const selectedModelsSupportReasoning = useMemo(
    () =>
      selectedModelIds.some((modelId) => {
        const model = models.find((entry) => entry.id === modelId);
        return model?.supportsReasoningEffort ?? false;
      }),
    [models, selectedModelIds],
  );

  const selectedModels = useMemo(
    () =>
      selectedModelIds
        .map((id) => models.find((model) => model.id === id))
        .filter((model): model is DebateModelInfo => Boolean(model)),
    [models, selectedModelIds],
  );

  const summaryModelInfo = useMemo(
    () => models.find((model) => model.id === effectiveSummaryModelId),
    [models, effectiveSummaryModelId],
  );

  const costEstimate = useMemo(() => {
    return estimateDebateCost({
      models: selectedModels,
      contextBrief,
      documents: documents.map((doc) => ({
        label: doc.label,
        content: doc.content,
      })),
      rounds,
      iterations: mode === "randomized_stances" ? iterations : 1,
      mode,
      summarize: summarizeEnabled,
      summaryModel: summaryModelInfo,
    });
  }, [
    selectedModels,
    contextBrief,
    documents,
    rounds,
    iterations,
    mode,
    summarizeEnabled,
    summaryModelInfo,
  ]);

  const estimatedTurnCount = useMemo(() => {
    const totalIterations = mode === "randomized_stances" ? iterations : 1;
    const base = totalIterations * rounds * selectedModelIds.length;
    return summarizeEnabled ? base + 1 : base;
  }, [mode, iterations, rounds, selectedModelIds.length, summarizeEnabled]);

  const toggleModel = useCallback((modelId: string, available: boolean) => {
    if (!available) {
      return;
    }
    setSelectedModelIds((current) =>
      current.includes(modelId)
        ? current.filter((id) => id !== modelId)
        : [...current, modelId],
    );
  }, []);

  const handlePdfUpload = useCallback(
    async (docId: string, file: File) => {
      setExtractingPdfDocId(docId);

      try {
        const formData = new FormData();
        formData.append("file", file);

        const response = await fetch("/api/extract-pdf", {
          method: "POST",
          body: formData,
        });

        const data = (await response.json()) as PdfExtractionResult & {
          error?: string;
        };

        if (!response.ok) {
          throw new Error(data.error ?? "PDF extraction failed.");
        }

        setDocuments((current) =>
          current.map((row) =>
            row.id === docId
              ? {
                  ...row,
                  label: row.label.trim() ? row.label : data.label,
                  content: data.text,
                  sourceMeta: {
                    kind: "pdf",
                    filename: data.filename,
                    pageCount: data.pageCount,
                    warning: data.warning,
                  },
                }
              : row,
          ),
        );
      } catch (err) {
        setStatus("error");
        setStatusMessage(
          err instanceof Error ? err.message : "PDF extraction failed.",
        );
      } finally {
        setExtractingPdfDocId(null);
      }
    },
    [],
  );

  const fetchUrlForDoc = useCallback(async (docId: string) => {
    let urlValue = "";
    setDocuments((current) =>
      current.map((row) => {
        if (row.id !== docId) {
          return row;
        }
        urlValue = row.urlDraft ?? "";
        return { ...row, urlFetching: true, urlError: undefined };
      }),
    );

    if (!urlValue.trim()) {
      setDocuments((current) =>
        current.map((row) =>
          row.id === docId
            ? { ...row, urlFetching: false, urlError: "Enter a URL first." }
            : row,
        ),
      );
      return;
    }

    try {
      const response = await fetch("/api/fetch-url", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders() },
        body: JSON.stringify({ url: urlValue.trim() }),
      });
      const data = (await response.json()) as UrlFetchResult & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(data.error ?? "Failed to fetch URL.");
      }

      setDocuments((current) =>
        current.map((row) =>
          row.id === docId
            ? {
                ...row,
                label: row.label.trim() ? row.label : data.label,
                content: data.text,
                sourceMeta: {
                  kind: "url",
                  url: urlValue.trim(),
                  title: data.label,
                  warning: data.warning,
                },
                urlFetching: false,
                showUrlInput: false,
                urlError: undefined,
              }
            : row,
        ),
      );
    } catch (err) {
      setDocuments((current) =>
        current.map((row) =>
          row.id === docId
            ? {
                ...row,
                urlFetching: false,
                urlError:
                  err instanceof Error ? err.message : "Failed to fetch URL.",
              }
            : row,
        ),
      );
    }
  }, []);

  const loadExample = useCallback(
    async (example: DebateExample) => {
      setLoadingExampleId(example.id);
      setContextBrief(example.contextBrief);
      setMode(example.mode);
      setStances(
        (example.stances ?? DEFAULT_STANCES).map((stance) => ({ ...stance })),
      );

      const rows: DocumentRow[] = example.documents.map(() => ({
        ...newDocumentRow(),
        loading: true,
      }));

      example.documents.forEach((doc, index) => {
        rows[index].label = doc.label;
      });

      setDocuments(rows);
      setTurns([]);
      setSummaryText("");
      setTakeaways(null);
      setSummaryStatus("idle");
      setStatus("idle");
      setStatusMessage(null);
      setPanelRoster([]);
      setShowDebateInResults(false);

      await Promise.all(
        example.documents.map(async (doc, index) => {
          const docId = rows[index].id;
          try {
            if (doc.source.kind === "text") {
              setDocuments((current) =>
                current.map((row) =>
                  row.id === docId
                    ? {
                        ...row,
                        content: doc.source.kind === "text" ? doc.source.content : "",
                        loading: false,
                      }
                    : row,
                ),
              );
              return;
            }

            if (doc.source.kind === "url") {
              const response = await fetch("/api/fetch-url", {
                method: "POST",
                headers: { "Content-Type": "application/json", ...apiHeaders() },
                body: JSON.stringify({ url: doc.source.url }),
              });
              const data = (await response.json()) as UrlFetchResult & {
                error?: string;
              };
              if (!response.ok) {
                throw new Error(data.error ?? "Failed to fetch URL.");
              }
              setDocuments((current) =>
                current.map((row) =>
                  row.id === docId
                    ? {
                        ...row,
                        content: data.text,
                        sourceMeta: {
                          kind: "url",
                          url: doc.source.kind === "url" ? doc.source.url : "",
                          title: data.label,
                          warning: data.warning,
                        },
                        loading: false,
                      }
                    : row,
                ),
              );
              return;
            }

            // pdf: fetch the static asset and run it through the same
            // extraction endpoint a manual upload would use.
            const pdfPath = doc.source.path;
            const blobResponse = await fetch(pdfPath);
            if (!blobResponse.ok) {
              throw new Error(`Failed to load example PDF: ${pdfPath}`);
            }
            const blob = await blobResponse.blob();
            const filename = pdfPath.split("/").pop() ?? "document.pdf";
            const formData = new FormData();
            formData.append("file", new File([blob], filename, { type: "application/pdf" }));

            const response = await fetch("/api/extract-pdf", {
              method: "POST",
              body: formData,
            });
            const data = (await response.json()) as PdfExtractionResult & {
              error?: string;
            };
            if (!response.ok) {
              throw new Error(data.error ?? "PDF extraction failed.");
            }

            setDocuments((current) =>
              current.map((row) =>
                row.id === docId
                  ? {
                      ...row,
                      content: data.text,
                      sourceMeta: {
                        kind: "pdf",
                        filename: data.filename,
                        pageCount: data.pageCount,
                        warning: data.warning,
                      },
                      loading: false,
                    }
                  : row,
              ),
            );
          } catch (err) {
            setDocuments((current) =>
              current.map((row) =>
                row.id === docId
                  ? {
                      ...row,
                      loading: false,
                      sourceMeta: null,
                      content: `[Failed to load: ${
                        err instanceof Error ? err.message : "unknown error"
                      }]`,
                    }
                  : row,
              ),
            );
          }
        }),
      );

      setLoadingExampleId(null);
    },
    [],
  );

  const handleSummaryStreamEvent = useCallback((event: DebateStreamEvent) => {
    switch (event.type) {
      case "summary_start":
        setSummaryStatus("streaming");
        setSummaryError(null);
        setSummaryText("");
        setTakeaways(null);
        setSummaryModelName(event.modelDisplayName);
        setVerdictExpanded(false);
        break;
      case "summary_token":
        setSummaryText((current) => current + event.text);
        break;
      case "summary_end":
        setSummaryText(event.text || "");
        setTakeaways(event.takeaways ?? null);
        setSummaryStatus("done");
        setSummaryUsage(event.usage ?? null);
        {
          const usage = event.usage;
          if (usage) {
            setCostSoFar((current) => ({
              usd: current.usd + (usage.cost ?? 0),
              tokens:
                current.tokens + usage.promptTokens + usage.completionTokens,
            }));
          }
        }
        break;
      case "summary_error":
        setSummaryStatus("error");
        setSummaryError(event.message);
        break;
      default:
        break;
    }
  }, []);

  const generateSummary = useCallback(
    async (sourceTurns?: TurnBlock[]) => {
      const transcriptTurns = sourceTurns ?? turnsRef.current;
      const transcript = turnsToTranscript(transcriptTurns);

      if (transcript.length === 0) {
        setSummaryStatus("error");
        setSummaryError("No debate transcript available to summarize.");
        return;
      }

      const modelId = effectiveSummaryModelId;

      if (!modelId) {
        setSummaryStatus("error");
        setSummaryError("Select a model for the takeaways.");
        return;
      }

      summaryAbortRef.current?.abort();
      const controller = new AbortController();
      summaryAbortRef.current = controller;

      setSummaryText("");
      setTakeaways(null);
      setSummaryError(null);
      setSummaryModelName(null);
      setSummaryUsage(null);
      setSummaryStatus("loading");

      const panel = panelRosterRef.current.map((entry) => ({
        modelId: entry.modelId,
        modelDisplayName: entry.modelDisplayName,
        stance: entry.stance,
      }));

      const body = {
        contextBrief,
        documents: documents
          .filter((doc) => doc.label.trim() || doc.content.trim())
          .map((doc) => ({
            label: doc.label.trim() || "Untitled document",
            content: doc.content,
          })),
        transcript,
        modelId,
        reasoningEffort,
        promptOverrides: readPromptOverrides(),
        panel,
      };

      try {
        const response = await fetch("/api/summarize", {
          method: "POST",
          headers: { "Content-Type": "application/json", ...apiHeaders() },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (!response.ok) {
          let message = `Takeaways request failed (${response.status})`;
          try {
            const data = (await response.json()) as { error?: string };
            if (data.error) {
              message = data.error;
            }
          } catch {
            // Response was not JSON; keep generic message.
          }
          throw new Error(message);
        }

        if (!response.body) {
          throw new Error("Takeaways stream unavailable.");
        }

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          buffer = parseSseChunk(buffer, handleSummaryStreamEvent);
        }

        buffer += decoder.decode();
        parseSseChunk(`${buffer}\n\n`, handleSummaryStreamEvent);

        setSummaryStatus((current) =>
          current === "loading" || current === "streaming" ? "done" : current,
        );
      } catch (err) {
        if (err instanceof DOMException && err.name === "AbortError") {
          setSummaryStatus("idle");
          setSummaryError(null);
          return;
        }
        setSummaryStatus("error");
        setSummaryError(
          err instanceof Error ? err.message : "Takeaways generation failed.",
        );
      } finally {
        summaryAbortRef.current = null;
      }
    },
    [
      contextBrief,
      documents,
      effectiveSummaryModelId,
      handleSummaryStreamEvent,
      reasoningEffort,
    ],
  );

  const handleStreamEvent = useCallback(
    (event: DebateStreamEvent) => {
      switch (event.type) {
      case "debate_start":
        setStatus("running");
        setStatusMessage(
          `Running ${event.totalIterations} iteration(s), ${event.rounds} round(s) each`,
        );
        setRunRounds(event.rounds);
        setRunTotalIterations(event.totalIterations);
        break;
      case "iteration_start":
        setCurrentIteration(event.iteration);
        setPanelRoster((current) =>
          current.length > 0
            ? current
            : event.assignments.map((assignment) => ({
                modelId: assignment.modelId,
                modelDisplayName: assignment.modelDisplayName,
                stance: assignment.stance,
              })),
        );
        break;
      case "turn_start":
        setCurrentRound(event.round);
        setCurrentSpeakerName(event.modelDisplayName);
        setTurns((current) => [
          ...current,
          {
            key: `${event.iteration}-${event.round}-${event.speakerIndex}-${current.length}`,
            iteration: event.iteration,
            round: event.round,
            speakerIndex: event.speakerIndex,
            modelId: event.modelId,
            modelDisplayName: event.modelDisplayName,
            stance: event.stance,
            text: "",
            reasoning: "",
            activity: "Starting…",
            streaming: true,
            usage: null,
          },
        ]);
        break;
      case "activity":
        setTurns((current) => {
          const next = [...current];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const turn = next[i];
            if (
              turn.iteration === event.iteration &&
              turn.round === event.round &&
              turn.speakerIndex === event.speakerIndex &&
              turn.streaming
            ) {
              next[i] = { ...turn, activity: event.message };
              break;
            }
          }
          return next;
        });
        break;
      case "reasoning":
        setTurns((current) => {
          const next = [...current];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const turn = next[i];
            if (
              turn.iteration === event.iteration &&
              turn.round === event.round &&
              turn.speakerIndex === event.speakerIndex &&
              turn.streaming
            ) {
              next[i] = { ...turn, reasoning: turn.reasoning + event.text };
              break;
            }
          }
          return next;
        });
        break;
      case "token":
        setTurns((current) => {
          const next = [...current];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const turn = next[i];
            if (
              turn.iteration === event.iteration &&
              turn.round === event.round &&
              turn.speakerIndex === event.speakerIndex &&
              turn.streaming
            ) {
              next[i] = { ...turn, text: turn.text + event.text };
              break;
            }
          }
          return next;
        });
        break;
      case "turn_end":
        setTurns((current) => {
          const next = [...current];
          for (let i = next.length - 1; i >= 0; i -= 1) {
            const turn = next[i];
            if (
              turn.iteration === event.iteration &&
              turn.round === event.round &&
              turn.speakerIndex === event.speakerIndex
            ) {
              next[i] = {
                ...turn,
                text: event.text || turn.text,
                activity: null,
                streaming: false,
                usage: event.usage ?? null,
              };
              break;
            }
          }
          turnsRef.current = next;
          return next;
        });
        {
          const usage = event.usage;
          if (usage) {
            setCostSoFar((current) => ({
              usd: current.usd + (usage.cost ?? 0),
              tokens:
                current.tokens + usage.promptTokens + usage.completionTokens,
            }));
          }
        }
        break;
      case "debate_end":
        setStatus("done");
        setStatusMessage("Debate complete.");
        if (summarizeEnabledRef.current) {
          void generateSummary(turnsRef.current);
        }
        break;
      case "error":
        setStatus("error");
        setStatusMessage(event.message);
        setErrorRetryable(event.retryable ?? false);
        setTurns((current) =>
          current.map((turn) =>
            turn.streaming ? { ...turn, streaming: false, activity: null } : turn,
          ),
        );
        break;
      default:
        break;
    }
  },
  [generateSummary],
  );

  const startDebate = async () => {
    if (selectedModelIds.length < 2) {
      setStatus("error");
      setStatusMessage("Select at least two models.");
      return;
    }

    if (!contextBrief.trim()) {
      setStatus("error");
      setStatusMessage("Add a context brief before starting.");
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setTurns([]);
    turnsRef.current = [];
    setSummaryText("");
    setTakeaways(null);
    setSummaryError(null);
    setSummaryModelName(null);
    setSummaryUsage(null);
    setSummaryStatus("idle");
    setStatus("loading");
    setStatusMessage("Starting debate…");
    setErrorRetryable(false);
    setCostSoFar({ usd: 0, tokens: 0 });
    setPanelRoster([]);
    setShowDebateInResults(false);
    setCurrentRound(0);
    setCurrentIteration(0);
    setCurrentSpeakerName(null);
    setElapsedSeconds(0);
    debateStartRef.current = Date.now();

    const config: DebateConfig = {
      contextBrief,
      documents: documents
        .filter((doc) => doc.label.trim() || doc.content.trim())
        .map((doc) => ({
          label: doc.label.trim() || "Untitled document",
          content: doc.content,
        })),
      modelIds: selectedModelIds,
      mode,
      reasoningEffort,
      rounds,
      iterations: mode === "randomized_stances" ? iterations : 1,
      stances,
      summarize: summarizeEnabled,
      summaryModelId: effectiveSummaryModelId,
      promptOverrides: readPromptOverrides(),
    };

    try {
      const response = await fetch("/api/debate", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders() },
        body: JSON.stringify(config),
        signal: controller.signal,
      });

      if (!response.ok) {
        let message = `Request failed (${response.status})`;
        try {
          const data = (await response.json()) as { error?: string };
          if (data.error) {
            message = data.error;
          }
        } catch {
          // Response was not JSON; keep generic message.
        }
        throw new Error(message);
      }

      if (!response.body) {
        throw new Error("Debate stream unavailable.");
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        buffer = parseSseChunk(buffer, handleStreamEvent);
      }

      buffer += decoder.decode();
      parseSseChunk(`${buffer}\n\n`, handleStreamEvent);

      setStatus((current) =>
        current === "running" || current === "loading" ? "done" : current,
      );
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") {
        setStatus("idle");
        setStatusMessage("Debate stopped.");
        return;
      }
      setStatus("error");
      setStatusMessage(err instanceof Error ? err.message : "Debate failed.");
    } finally {
      abortRef.current = null;
    }
  };

  const stopDebate = () => {
    abortRef.current?.abort();
    setStatus("idle");
    setStatusMessage("Debate stopped.");
  };

  const handleEditAndRunAgain = useCallback(() => {
    abortRef.current?.abort();
    summaryAbortRef.current?.abort();
    setTurns([]);
    turnsRef.current = [];
    setTakeaways(null);
    setSummaryText("");
    setSummaryStatus("idle");
    setSummaryError(null);
    setSummaryModelName(null);
    setSummaryUsage(null);
    setStatus("idle");
    setStatusMessage(null);
    setCostSoFar({ usd: 0, tokens: 0 });
    setPanelRoster([]);
    setShowDebateInResults(false);
    setElapsedSeconds(0);
    debateStartRef.current = null;
  }, []);

  const handleStartFresh = useCallback(() => {
    const hasFinishedDebate =
      viewState === "results" || (turns.length > 0 && !isRunning);
    if (
      hasFinishedDebate &&
      !window.confirm("Discard this debate and start fresh?")
    ) {
      return;
    }

    abortRef.current?.abort();
    summaryAbortRef.current?.abort();
    abortRef.current = null;
    summaryAbortRef.current = null;

    setContextBrief("");
    setDocuments(INITIAL_DOCUMENTS.map((doc) => ({ ...doc })));
    setStances(DEFAULT_STANCES.map((stance) => ({ ...stance })));
    setMode("assigned_stances");
    setReasoningEffort("high");
    setRounds(3);
    setIterations(3);
    setSummarizeEnabled(true);
    setSummaryModelId("");
    setTurns([]);
    turnsRef.current = [];
    setTakeaways(null);
    setSummaryText("");
    setSummaryError(null);
    setSummaryModelName(null);
    setSummaryUsage(null);
    setSummaryStatus("idle");
    setPanelRoster([]);
    panelRosterRef.current = [];
    setStatus("idle");
    setStatusMessage(null);
    setElapsedSeconds(0);
    debateStartRef.current = null;
    setCostSoFar({ usd: 0, tokens: 0 });
    setShowDebateInResults(false);
    setVerdictExpanded(false);
  }, [viewState, turns.length, isRunning]);

  const buildMarkdownExport = useCallback(() => {
    const lines: string[] = [];
    const now = new Date();

    lines.push("# AI Panel debate");
    lines.push("");
    lines.push(`Date: ${now.toISOString().slice(0, 10)}`);
    lines.push("");
    lines.push("## Context brief");
    lines.push(contextBrief.trim() || "(none)");
    lines.push("");

    lines.push("## Source documents");
    const activeDocs = documents.filter(
      (doc) => doc.label.trim() || doc.content.trim(),
    );
    if (activeDocs.length === 0) {
      lines.push("- (none)");
    } else {
      for (const doc of activeDocs) {
        lines.push(
          `- ${doc.label.trim() || "Untitled document"} (${sourceKindLabel(doc.sourceMeta)})`,
        );
      }
    }
    lines.push("");

    lines.push("## Panel");
    for (const modelId of selectedModelIds) {
      const model = models.find((entry) => entry.id === modelId);
      const displayName = model?.displayName ?? modelId;
      let stanceText = "none";
      if (mode === "assigned_stances") {
        const index = selectedModelIds.indexOf(modelId);
        const effectiveStances = stances.filter(
          (s) => s.label.trim() && s.instruction.trim(),
        );
        const pool = effectiveStances.length >= 2 ? effectiveStances : DEFAULT_STANCES;
        stanceText = pool[index % pool.length]?.label ?? "none";
      } else if (mode === "randomized_stances") {
        stanceText = "varies by iteration";
      }
      lines.push(`- ${displayName} (${modelId}) — ${stanceText}`);
    }
    lines.push("");

    lines.push("## Settings");
    lines.push(`- Mode: ${mode}`);
    lines.push(`- Rounds: ${rounds}`);
    lines.push(`- Iterations: ${mode === "randomized_stances" ? iterations : 1}`);
    lines.push(`- Reasoning effort: ${reasoningEffort}`);
    lines.push("");

    if (exportKind !== "summary") {
      lines.push("## Transcript");
      lines.push("");
      for (const [iteration, roundsMap] of groupedTurns) {
        lines.push(`### Iteration ${iteration}`);
        for (const [round, roundTurns] of [...roundsMap.entries()].sort(
          ([a], [b]) => a - b,
        )) {
          lines.push(`#### Round ${round}`);
          for (const turn of roundTurns) {
            const stanceSuffix = turn.stance ? ` (${turn.stance})` : "";
            lines.push(`**${turn.modelDisplayName}**${stanceSuffix}`);
            lines.push("");
            lines.push(turn.text.trim());
            lines.push("");
          }
        }
      }
    }

    if (exportKind !== "transcript") {
      if (takeaways) {
        lines.push("## Verdict");
        lines.push(
          `${takeaways.verdict.trim() || "(no verdict)"} _(Panel confidence: ${takeaways.confidence})_`,
        );
        lines.push("");

        const agreed = takeaways.takeaways.filter((t) =>
          isFullyAgreed(t, panelRoster),
        );
        const agreedSorted = [...agreed].sort((a, b) =>
          a.kind === b.kind ? 0 : a.kind === "action" ? -1 : 1,
        );
        lines.push("## Agreed by the whole panel");
        if (agreedSorted.length === 0) {
          lines.push("- (none)");
        } else {
          for (const t of agreedSorted) {
            const names = t.supporters.join(", ");
            lines.push(
              t.kind === "action"
                ? `- [ ] **${t.title}** — ${t.detail} _(${names})_`
                : `- **${t.title}** — ${t.detail} _(${names})_`,
            );
          }
        }
        lines.push("");

        const agreedTitles = new Set(agreedSorted.map((t) => t.title));
        const contested = takeaways.takeaways.filter((t) => !agreedTitles.has(t.title));
        const contestedSorted = [...contested].sort(
          (a, b) => b.supporters.length - a.supporters.length,
        );
        lines.push("## Contested");
        if (contestedSorted.length === 0) {
          lines.push("- (none)");
        } else {
          for (const t of contestedSorted) {
            lines.push(
              `- **${t.title}** — ${t.detail} _(for: ${
                t.supporters.join(", ") || "none"
              }; against: ${t.dissenters.join(", ") || "none"})_`,
            );
          }
        }
        lines.push("");

        if (takeaways.disagreements.length > 0) {
          lines.push("## Where they split");
          for (const d of takeaways.disagreements) {
            lines.push(`### ${d.topic}`);
            for (const pos of d.positions) {
              lines.push(`- **${pos.model}**: ${pos.position}`);
            }
          }
          lines.push("");
        }
      } else if (summaryText.trim()) {
        lines.push("## Summary");
        lines.push("");
        lines.push(summaryText.trim());
        lines.push("");
      }
    }

    if (costSoFar.usd > 0 || costSoFar.tokens > 0) {
      lines.push("## Cost");
      lines.push(
        `Total: ${formatUsd(costSoFar.usd)} · ${formatTokenCount(costSoFar.tokens)} tokens`,
      );
    }

    return lines.join("\n");
  }, [
    contextBrief,
    documents,
    selectedModelIds,
    models,
    mode,
    stances,
    rounds,
    iterations,
    reasoningEffort,
    exportKind,
    groupedTurns,
    summaryText,
    takeaways,
    panelRoster,
    costSoFar,
  ]);

  const handleExportDownload = useCallback(() => {
    const markdown = buildMarkdownExport();
    const blob = new Blob([markdown], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = exportFilename();
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
  }, [buildMarkdownExport]);

  const showStances = mode !== "conversation";
  const hasSummaryContent = takeaways !== null || summaryText.trim().length > 0;
  const canExport = turns.length > 0 && !isRunning;

  const progressText = (() => {
    if (status === "done" && isSummaryRunning) {
      return summaryModelName
        ? `Distilling takeaways with ${summaryModelName}…`
        : "Distilling takeaways…";
    }
    if (status === "error" && statusMessage) {
      return statusMessage;
    }
    if (status === "idle" && turns.length > 0) {
      return statusMessage ?? "Debate stopped.";
    }
    if (currentRound > 0 && runRounds > 0) {
      const iterationPrefix =
        runTotalIterations > 1 ? `Iteration ${currentIteration} · ` : "";
      return `${iterationPrefix}Round ${currentRound} of ${runRounds}${
        currentSpeakerName ? ` · ${currentSpeakerName} speaking` : ""
      }`;
    }
    return statusMessage ?? "Starting debate…";
  })();

  const renderModelCheckbox = (model: DebateModelInfo) => (
    <label
      key={model.id}
      className={`flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2 ${
        model.available
          ? "hover:bg-zinc-50 dark:hover:bg-zinc-900"
          : "cursor-not-allowed opacity-50"
      }`}
    >
      <input
        type="checkbox"
        checked={selectedModelIds.includes(model.id)}
        onChange={() => toggleModel(model.id, model.available)}
        disabled={!model.available || isRunning}
        className="mt-1"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-sm font-medium">{model.displayName}</span>
          {model.supportsReasoningEffort && (
            <span className="rounded-full bg-violet-500/10 px-1.5 py-0.5 text-[10px] font-medium text-violet-700 dark:text-violet-300">
              reasoning
            </span>
          )}
        </span>
        <span className="block font-mono text-[11px] text-zinc-500">
          {model.id}
        </span>
        <span className="block text-[11px] text-zinc-500">
          {formatContextLength(model.contextLength)} · {formatPricing(model)}
        </span>
      </span>
    </label>
  );

  const renderTranscript = () => (
    <div
      ref={transcriptRef}
      className="flex-1 space-y-6 overflow-y-auto px-5 py-4"
    >
      {groupedTurns.length === 0 && (
        <div className="rounded-xl border border-dashed border-zinc-300 px-4 py-10 text-center text-sm text-zinc-500 dark:border-zinc-700">
          Transcript will appear here as each model speaks.
        </div>
      )}

      {groupedTurns.map(([iteration, roundsMap]) => (
        <div key={`iteration-${iteration}`} className="space-y-4">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
            Iteration {iteration}
          </h3>
          {[...roundsMap.entries()]
            .sort(([a], [b]) => a - b)
            .map(([round, roundTurns]) => (
              <div key={`round-${iteration}-${round}`} className="space-y-3">
                <h4 className="text-sm font-medium text-zinc-700 dark:text-zinc-300">
                  Round {round}
                </h4>
                {roundTurns.map((turn) => (
                  <TurnCard key={turn.key} turn={turn} />
                ))}
              </div>
            ))}
        </div>
      ))}
    </div>
  );

  const agreedTakeaways = useMemo(() => {
    if (!takeaways) return [];
    const agreed = takeaways.takeaways.filter((t) => isFullyAgreed(t, panelRoster));
    return [...agreed].sort((a, b) => (a.kind === b.kind ? 0 : a.kind === "action" ? -1 : 1));
  }, [takeaways, panelRoster]);

  const contestedTakeaways = useMemo(() => {
    if (!takeaways) return [];
    const agreedTitles = new Set(agreedTakeaways.map((t) => t.title));
    const contested = takeaways.takeaways.filter((t) => !agreedTitles.has(t.title));
    return [...contested].sort((a, b) => b.supporters.length - a.supporters.length);
  }, [takeaways, agreedTakeaways]);

  return (
    <main className="mx-auto flex min-h-full w-full max-w-7xl flex-col gap-8 px-4 py-8 lg:px-8">
      <header className="space-y-2">
        <p className="text-sm font-medium uppercase tracking-wide text-zinc-500">
          Multi-model debate
        </p>
        <h1 className="text-3xl font-semibold tracking-tight text-zinc-900 dark:text-zinc-50">
          Put it to the panel. Walk away with what they agree on.
        </h1>
        <p className="max-w-3xl text-zinc-600 dark:text-zinc-400">
          Ask a question, attach the documents that matter, and let several AI
          models argue it out. When they finish you get a verdict, the
          to-dos every model backed, and the points they still fight over.
        </p>
      </header>

      {examples.length > 0 && (
        <section className="space-y-3">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Examples
          </h2>
          <div className="grid gap-3 sm:grid-cols-3">
            {examples.map((example) => (
              <button
                key={example.id}
                type="button"
                onClick={() => void loadExample(example)}
                disabled={isRunning || loadingExampleId !== null}
                className="rounded-xl border border-zinc-200 bg-white p-4 text-left text-sm hover:border-violet-300 hover:bg-violet-50/40 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-800 dark:bg-zinc-950 dark:hover:border-violet-800 dark:hover:bg-violet-950/20"
              >
                <span className="block font-medium text-zinc-900 dark:text-zinc-50">
                  {loadingExampleId === example.id
                    ? "Loading…"
                    : example.title}
                </span>
                <span className="mt-1 block text-xs text-zinc-500">
                  {example.description}
                </span>
              </button>
            ))}
          </div>
        </section>
      )}

      <div className="grid gap-8 lg:grid-cols-[420px_minmax(0,1fr)]">
        <section className="rounded-2xl bg-white ring-1 ring-black/5 dark:bg-zinc-950 lg:sticky lg:top-[4.5rem] lg:flex lg:max-h-[calc(100vh-5.5rem)] lg:flex-col lg:overflow-y-auto lg:overscroll-contain">
          <div className="sticky top-0 z-10 space-y-2 rounded-t-2xl border-b border-zinc-200/80 bg-white/95 px-5 py-4 backdrop-blur dark:border-zinc-800/80 dark:bg-zinc-950/95">
            <div className="flex items-center gap-3">
              <button
                type="button"
                onClick={() => void startDebate()}
                disabled={isRunning || isSummaryRunning}
                className={`flex-1 rounded-xl px-4 py-2.5 text-sm font-semibold text-white ${
                  isRunning || isSummaryRunning
                    ? "animate-pulse cursor-wait bg-violet-600"
                    : "bg-violet-600 hover:bg-violet-500 disabled:cursor-not-allowed disabled:opacity-60"
                }`}
              >
                {isRunning || isSummaryRunning ? (
                  <span className="inline-flex items-center justify-center gap-2">
                    <span
                      aria-hidden
                      className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-white/40 border-t-white"
                    />
                    {status === "loading"
                      ? "Starting…"
                      : isSummaryRunning
                        ? "Distilling…"
                        : "Running…"}
                  </span>
                ) : (
                  "Run debate"
                )}
              </button>
              <button
                type="button"
                onClick={stopDebate}
                disabled={!isRunning}
                className="rounded-xl border border-zinc-300 px-4 py-2.5 text-sm font-semibold hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
              >
                Stop
              </button>
              <span
                className="shrink-0 whitespace-nowrap rounded-full bg-zinc-100 px-2.5 py-1 text-xs font-medium text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
                title={`Rough estimate: ${formatTokenCount(costEstimate.inputTokens)} input tokens, ${formatTokenCount(costEstimate.outputTokens)} output tokens across ${estimatedTurnCount} turns. Actual cost depends on response length and reasoning.`}
              >
                Est. ~{formatUsd(costEstimate.totalUsd)}
              </span>
            </div>
            <button
              type="button"
              onClick={handleStartFresh}
              className="text-xs text-zinc-500 hover:text-violet-600 dark:text-zinc-500 dark:hover:text-violet-400"
            >
              Start fresh
            </button>
          </div>
          <div className="space-y-6 p-5">
            <div className="space-y-4">
              <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Input
              </h2>
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Context brief
            </label>
            <textarea
              value={contextBrief}
              onChange={(event) => setContextBrief(event.target.value)}
              rows={5}
              placeholder="Describe the situation, question, or decision under debate…"
              className="w-full rounded-xl border border-zinc-300 bg-zinc-50 px-3 py-2 text-sm outline-none ring-violet-500 focus:ring-2 dark:border-zinc-700 dark:bg-zinc-900"
              disabled={isRunning}
            />
          </div>

          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                Source documents
              </label>
              <button
                type="button"
                onClick={() => setDocuments((current) => [...current, newDocumentRow()])}
                disabled={isRunning}
                className="text-sm font-medium text-violet-600 hover:text-violet-500 disabled:opacity-50"
              >
                + Add document
              </button>
            </div>
            {documents.map((doc, index) => {
              const isExtracting = extractingPdfDocId === doc.id;
              const inputId = `pdf-upload-${doc.id}`;
              const overLimit = doc.content.length > MAX_DOCUMENT_CHARS;

              return (
              <div
                key={doc.id}
                className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    value={doc.label}
                    onChange={(event) =>
                      setDocuments((current) =>
                        current.map((row) =>
                          row.id === doc.id
                            ? { ...row, label: event.target.value }
                            : row,
                        ),
                      )
                    }
                    placeholder={`Document label ${index + 1}`}
                    className="min-w-[8rem] flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                    disabled={isRunning || isExtracting || doc.loading}
                  />
                  <label
                    htmlFor={inputId}
                    className={`shrink-0 cursor-pointer rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900 ${
                      isRunning || isExtracting || doc.loading
                        ? "pointer-events-none opacity-50"
                        : ""
                    }`}
                  >
                    {isExtracting ? "Extracting…" : "Upload PDF"}
                  </label>
                  <input
                    id={inputId}
                    type="file"
                    accept=".pdf,application/pdf"
                    className="sr-only"
                    disabled={isRunning || isExtracting || doc.loading}
                    onChange={(event) => {
                      const file = event.target.files?.[0];
                      if (file) {
                        void handlePdfUpload(doc.id, file);
                      }
                      event.target.value = "";
                    }}
                  />
                  <button
                    type="button"
                    onClick={() =>
                      setDocuments((current) =>
                        current.map((row) =>
                          row.id === doc.id
                            ? { ...row, showUrlInput: !row.showUrlInput }
                            : row,
                        ),
                      )
                    }
                    disabled={isRunning || isExtracting || doc.loading}
                    className="shrink-0 rounded-lg border border-zinc-300 px-3 py-2 text-sm font-medium text-zinc-700 hover:bg-zinc-50 disabled:opacity-50 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
                  >
                    Add URL
                  </button>
                  {documents.length > 1 && (
                    <button
                      type="button"
                      onClick={() =>
                        setDocuments((current) =>
                          current.filter((row) => row.id !== doc.id),
                        )
                      }
                      disabled={isRunning || isExtracting}
                      className="rounded-lg px-2 py-2 text-sm text-zinc-500 hover:bg-zinc-100 dark:hover:bg-zinc-900"
                    >
                      Remove
                    </button>
                  )}
                </div>

                {doc.showUrlInput && (
                  <div className="space-y-1">
                    <div className="flex items-center gap-2">
                      <input
                        value={doc.urlDraft ?? ""}
                        onChange={(event) =>
                          setDocuments((current) =>
                            current.map((row) =>
                              row.id === doc.id
                                ? { ...row, urlDraft: event.target.value }
                                : row,
                            ),
                          )
                        }
                        placeholder="https://en.wikipedia.org/wiki/…"
                        className="flex-1 rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                        disabled={doc.urlFetching}
                      />
                      <button
                        type="button"
                        onClick={() => void fetchUrlForDoc(doc.id)}
                        disabled={doc.urlFetching}
                        className="shrink-0 rounded-lg bg-violet-600 px-3 py-2 text-sm font-medium text-white hover:bg-violet-500 disabled:opacity-60"
                      >
                        {doc.urlFetching ? "Fetching…" : "Fetch"}
                      </button>
                    </div>
                    {doc.urlError && (
                      <p className="text-xs text-red-600 dark:text-red-400">
                        {doc.urlError}
                      </p>
                    )}
                  </div>
                )}

                {doc.loading && (
                  <p className="text-xs text-zinc-500 italic">Loading…</p>
                )}

                {doc.sourceMeta && (
                  <div className="space-y-1 text-xs text-zinc-500">
                    {doc.sourceMeta.kind === "pdf" ? (
                      <p>
                        {doc.sourceMeta.filename} · {doc.sourceMeta.pageCount}{" "}
                        {doc.sourceMeta.pageCount === 1 ? "page" : "pages"}
                      </p>
                    ) : (
                      <p className="truncate">Source: {doc.sourceMeta.url}</p>
                    )}
                    {doc.sourceMeta.warning && (
                      <p className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-amber-700 dark:text-amber-300">
                        {doc.sourceMeta.warning}
                      </p>
                    )}
                  </div>
                )}
                {overLimit && (
                  <p className="rounded-lg bg-amber-500/10 px-2 py-1.5 text-xs text-amber-700 dark:text-amber-300">
                    This document is over {MAX_DOCUMENT_CHARS.toLocaleString()}{" "}
                    characters and will be truncated when sent to the models.
                  </p>
                )}
                <p className="text-xs text-zinc-500">
                  Upload a PDF, fetch a URL, or paste text below
                </p>
                <textarea
                  value={doc.content}
                  onChange={(event) =>
                    setDocuments((current) =>
                      current.map((row) =>
                        row.id === doc.id
                          ? {
                              ...row,
                              content: event.target.value,
                              sourceMeta:
                                row.sourceMeta && row.sourceMeta.kind === "pdf"
                                  ? { ...row.sourceMeta, warning: undefined }
                                  : row.sourceMeta,
                            }
                          : row,
                      ),
                    )
                  }
                  rows={4}
                  placeholder="Paste document text here…"
                  className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  disabled={isRunning || isExtracting || doc.loading}
                />
              </div>
            );
            })}
          </div>
            </div>

            <div className="border-t border-zinc-200/80 pt-6 dark:border-zinc-800/80">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Debaters
              </h2>
          <div className="space-y-2">
            <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
              Debater models
            </label>
            {modelsError && (
              <p className="rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-700 dark:text-amber-300">
                {modelsError}
              </p>
            )}
            {models.length === 0 && !modelsError && (
              <p className="text-sm text-zinc-500">Loading models…</p>
            )}
            {topModels.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-zinc-500">Top models</p>
                <div className="space-y-1 rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
                  {topModels.map((model) => renderModelCheckbox(model))}
                </div>
              </div>
            )}
            {moreModelsByProvider.length > 0 && (
              <div className="space-y-2">
                <p className="text-xs font-medium text-zinc-500">More models</p>
                <div className="max-h-64 space-y-3 overflow-y-auto rounded-xl border border-zinc-200 p-2 dark:border-zinc-800">
                  {moreModelsByProvider.map(([provider, providerModels]) => (
                    <div key={provider} className="space-y-1">
                      <p className="px-2 text-[11px] font-semibold uppercase tracking-wide text-zinc-400">
                        {formatProviderName(provider)}
                      </p>
                      {providerModels.map((model) => renderModelCheckbox(model))}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
            </div>

            <div className="border-t border-zinc-200/80 pt-6 dark:border-zinc-800/80">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Format
              </h2>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label className="text-sm font-medium">Debate mode</label>
              <select
                value={mode}
                onChange={(event) => setMode(event.target.value as DebateMode)}
                disabled={isRunning}
                className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                <option value="conversation">Conversation</option>
                <option value="assigned_stances">Assigned stances</option>
                <option value="randomized_stances">Randomized stances</option>
              </select>
            </div>
            {selectedModelsSupportReasoning && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Reasoning effort</label>
                <select
                  value={reasoningEffort}
                  onChange={(event) =>
                    setReasoningEffort(event.target.value as ReasoningEffort)
                  }
                  disabled={isRunning}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                >
                  <option value="normal">Normal</option>
                  <option value="high">High</option>
                </select>
              </div>
            )}
            <div className="space-y-2">
              <label className="text-sm font-medium">Rounds</label>
              <input
                type="number"
                min={1}
                max={10}
                value={rounds}
                onChange={(event) => setRounds(Number(event.target.value))}
                disabled={isRunning}
                className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              />
            </div>
            {mode === "randomized_stances" && (
              <div className="space-y-2">
                <label className="text-sm font-medium">Iterations</label>
                <input
                  type="number"
                  min={1}
                  max={10}
                  value={iterations}
                  onChange={(event) => setIterations(Number(event.target.value))}
                  disabled={isRunning}
                  className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                />
              </div>
            )}
          </div>

          {showStances && (
            <div className="mt-4 space-y-3">
              <label className="text-sm font-medium">Stances</label>
              {stances.map((stance, index) => (
                <div
                  key={`stance-${index}`}
                  className="space-y-2 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800"
                >
                  <input
                    value={stance.label}
                    onChange={(event) =>
                      setStances((current) =>
                        current.map((row, i) =>
                          i === index
                            ? { ...row, label: event.target.value }
                            : row,
                        ),
                      )
                    }
                    placeholder="Short label (e.g. Pro)"
                    disabled={isRunning}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                  <textarea
                    value={stance.instruction}
                    onChange={(event) =>
                      setStances((current) =>
                        current.map((row, i) =>
                          i === index
                            ? { ...row, instruction: event.target.value }
                            : row,
                        ),
                      )
                    }
                    rows={3}
                    placeholder="Instruction injected into the opening prompt…"
                    disabled={isRunning}
                    className="w-full rounded-lg border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
                  />
                </div>
              ))}
              <button
                type="button"
                onClick={() => setStances((current) => [...current, newStance()])}
                disabled={isRunning}
                className="text-sm font-medium text-violet-600 hover:text-violet-500"
              >
                + Add stance
              </button>
            </div>
          )}
            </div>

            <div className="border-t border-zinc-200/80 pt-6 dark:border-zinc-800/80">
              <h2 className="mb-4 text-xs font-semibold uppercase tracking-wide text-zinc-500">
                Takeaways
              </h2>
          <div className="space-y-3 rounded-xl border border-zinc-200 p-3 dark:border-zinc-800">
            <label className="flex cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={summarizeEnabled}
                onChange={(event) => setSummarizeEnabled(event.target.checked)}
                disabled={isRunning}
                className="mt-1"
              />
              <span>
                <span className="block text-sm font-medium text-zinc-800 dark:text-zinc-200">
                  Distill takeaways when the debate ends
                </span>
                <span className="block text-xs text-zinc-500">
                  A verdict, the points the whole panel agreed on, and what
                  stayed contested.
                </span>
              </span>
            </label>
            <div className="space-y-2">
              <label className="text-sm font-medium text-zinc-800 dark:text-zinc-200">
                Takeaways model
              </label>
              <select
                value={effectiveSummaryModelId}
                onChange={(event) => setSummaryModelId(event.target.value)}
                disabled={isRunning}
                className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
              >
                {models
                  .filter((model) => model.available)
                  .map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.displayName}
                    </option>
                  ))}
              </select>
            </div>
          </div>
            </div>
          </div>
        </section>

        <section className="flex min-h-[640px] flex-col rounded-2xl bg-white ring-1 ring-black/5 dark:bg-zinc-950">
          {viewState === "results" ? (
            <div className="flex flex-1 flex-col">
              {hasSummaryContent ? (
                <div className="space-y-6 px-5 py-6">
                  {takeaways ? (
                    <>
                      {/* Verdict hero */}
                      <div className="space-y-3">
                        <p className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
                          Verdict
                        </p>
                        {(() => {
                          const verdictText =
                            takeaways.verdict ||
                            "The panel did not provide a clear verdict.";
                          const isLongVerdict = verdictText.length > 220;
                          const clamp = isLongVerdict && !verdictExpanded;
                          return (
                            <>
                              <p
                                className={`max-w-[60ch] text-lg font-medium leading-snug text-balance text-zinc-900 dark:text-zinc-50 lg:text-xl ${
                                  clamp ? "line-clamp-3" : ""
                                }`}
                              >
                                {verdictText}
                              </p>
                              {clamp && (
                                <button
                                  type="button"
                                  onClick={() => setVerdictExpanded(true)}
                                  className="text-xs font-medium text-violet-600 hover:text-violet-500"
                                >
                                  Show full verdict
                                </button>
                              )}
                            </>
                          );
                        })()}
                        <div className="flex flex-wrap items-center gap-2">
                          <ConfidencePill confidence={takeaways.confidence} />
                        </div>
                        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                          {panelRoster.map((entry) => (
                            <PanelChip key={entry.modelId} entry={entry} />
                          ))}
                        </div>
                        <p className="text-xs text-zinc-500">
                          {formatModeLabel(mode)} · {rounds} round(s) ·{" "}
                          {formatUsd(costSoFar.usd)} ·{" "}
                          {formatTokenCount(costSoFar.tokens)} tokens ·{" "}
                          {formatElapsed(elapsedSeconds)}
                          {summaryModelName && (
                            <>
                              {" "}
                              · takeaways by {summaryModelName}
                              {summaryUsage &&
                                ` (${formatTokenCount(
                                  summaryUsage.promptTokens + summaryUsage.completionTokens,
                                )} tokens)`}
                            </>
                          )}
                        </p>
                      </div>

                      {/* Agreed by the whole panel */}
                      <div className="space-y-3 rounded-2xl border-l-4 border-emerald-500 bg-emerald-50/60 p-4 dark:border-emerald-700 dark:bg-emerald-950/20">
                        <h3 className="text-sm font-semibold uppercase tracking-wide text-emerald-900 dark:text-emerald-200">
                          Agreed by the whole panel
                        </h3>
                        {agreedTakeaways.length === 0 ? (
                          <p className="text-sm text-zinc-500">
                            No point was fully backed by every model this time.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {agreedTakeaways.map((t, index) => (
                              <TakeawayRow
                                key={`agreed-${index}`}
                                takeaway={t}
                                panel={panelRoster}
                                showVotesLine={false}
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Contested */}
                      <div className="space-y-3 rounded-2xl border-l-4 border-amber-500 bg-amber-50/60 p-4 dark:border-amber-700 dark:bg-amber-950/20">
                        <h3 className="text-sm font-semibold uppercase tracking-wide text-amber-900 dark:text-amber-200">
                          Contested
                        </h3>
                        {contestedTakeaways.length === 0 ? (
                          <p className="text-sm text-zinc-500">
                            Nothing else came up as contested.
                          </p>
                        ) : (
                          <div className="space-y-2">
                            {contestedTakeaways.map((t, index) => (
                              <TakeawayRow
                                key={`contested-${index}`}
                                takeaway={t}
                                panel={panelRoster}
                                showVotesLine
                              />
                            ))}
                          </div>
                        )}
                      </div>

                      {/* Where they split */}
                      {takeaways.disagreements.length > 0 && (
                        <div className="space-y-3">
                          <h3 className="text-sm font-semibold uppercase tracking-wide text-zinc-500">
                            Where they split
                          </h3>
                          <div className="space-y-2">
                            {takeaways.disagreements.map((d, index) => (
                              <DisagreementCard key={`disagreement-${index}`} disagreement={d} />
                            ))}
                          </div>
                        </div>
                      )}
                    </>
                  ) : (
                    <div className="space-y-2">
                      <div className="rounded-2xl border-l-4 border-violet-500 bg-violet-50 p-4 dark:border-violet-700 dark:bg-violet-950/30">
                        <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide text-violet-900 dark:text-violet-200">
                          Summary
                        </h3>
                        <Markdown text={summaryText} />
                      </div>
                      <p className="text-xs text-zinc-500">
                        The summary model did not return structured takeaways.
                      </p>
                    </div>
                  )}

                  {summaryError && (
                    <div
                      role="alert"
                      className="rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                    >
                      {summaryError}
                    </div>
                  )}

                  {/* Actions row */}
                  <div className="flex flex-wrap items-center gap-2 border-t border-zinc-200 pt-4 dark:border-zinc-800">
                    <button
                      type="button"
                      onClick={() => setShowDebateInResults((current) => !current)}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      {showDebateInResults ? "Hide debate" : "Show debate"}
                    </button>
                    <select
                      value={exportKind}
                      onChange={(event) =>
                        setExportKind(
                          event.target.value as "transcript" | "summary" | "both",
                        )
                      }
                      className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="transcript">Transcript</option>
                      <option value="summary">Takeaways</option>
                      <option value="both">Transcript + takeaways</option>
                    </select>
                    <button
                      type="button"
                      onClick={handleExportDownload}
                      disabled={!canExport}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 disabled:cursor-not-allowed disabled:opacity-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Download .md
                    </button>
                    <button
                      type="button"
                      onClick={() => void generateSummary()}
                      disabled={isSummaryRunning}
                      className="rounded-lg border border-violet-300 bg-violet-50 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-100 disabled:cursor-not-allowed disabled:opacity-50 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300 dark:hover:bg-violet-950/60"
                    >
                      Regenerate takeaways
                    </button>
                    <div className="ml-auto flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleStartFresh}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      >
                        Start fresh
                      </button>
                      <button
                        type="button"
                        onClick={handleEditAndRunAgain}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      >
                        Edit and run again
                      </button>
                    </div>
                  </div>

                  {showDebateInResults && (
                    <div className="-mx-5 border-t border-zinc-200 dark:border-zinc-800">
                      {renderTranscript()}
                    </div>
                  )}
                </div>
              ) : (
                <>
                  <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <h2 className="text-lg font-semibold">Debate complete</h2>
                      <button
                        type="button"
                        onClick={() => void generateSummary()}
                        className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500"
                      >
                        Distill takeaways
                      </button>
                    </div>
                    <p className="mt-1 text-sm text-zinc-500">
                      Takeaways were skipped for this run. Distill a verdict,
                      the points the panel agreed on, and what stayed
                      contested.
                    </p>
                  </div>
                  {renderTranscript()}
                </>
              )}
            </div>
          ) : (
            <>
              <div className="border-b border-zinc-200 px-5 py-4 dark:border-zinc-800">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-lg font-semibold">Live debate</h2>
                  <div className="flex items-center gap-3">
                    {(costSoFar.usd > 0 || costSoFar.tokens > 0) && (
                      <span className="text-xs text-zinc-500">
                        {formatUsd(costSoFar.usd)} ·{" "}
                        {formatTokenCount(costSoFar.tokens)} tokens
                      </span>
                    )}
                    {isRunning && (
                      <span className="text-xs text-zinc-500">
                        {formatElapsed(elapsedSeconds)}
                      </span>
                    )}
                    {isRunning && (
                      <button
                        type="button"
                        onClick={stopDebate}
                        className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-semibold hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                      >
                        Stop
                      </button>
                    )}
                  </div>
                </div>

                {panelRoster.length > 0 && (
                  <div className="mt-2 flex flex-wrap items-center gap-1.5">
                    {panelRoster.map((entry) => (
                      <PanelChip key={entry.modelId} entry={entry} />
                    ))}
                  </div>
                )}

                <p className="mt-2 text-sm text-zinc-500">
                  {turns.length === 0 && status === "idle"
                    ? "Configure the debate and press Run debate to stream responses."
                    : progressText}
                </p>

                {status === "error" && statusMessage && (
                  <div
                    role="alert"
                    className="mt-3 rounded-xl border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200"
                  >
                    <p>{statusMessage}</p>
                    {errorRetryable && (
                      <p className="mt-2 text-red-700 dark:text-red-300">
                        This looks like a temporary network or provider issue.
                        Check your connection and OpenRouter status, then
                        press Run debate to retry.
                      </p>
                    )}
                  </div>
                )}

                {canExport && (
                  <div className="mt-3 flex flex-wrap items-center gap-2">
                    <select
                      value={exportKind}
                      onChange={(event) =>
                        setExportKind(
                          event.target.value as "transcript" | "summary" | "both",
                        )
                      }
                      className="rounded-lg border border-zinc-300 bg-white px-2 py-1.5 text-xs dark:border-zinc-700 dark:bg-zinc-900"
                    >
                      <option value="transcript">Transcript</option>
                      <option value="summary" disabled={!hasSummaryContent}>
                        Takeaways
                      </option>
                      <option value="both" disabled={!hasSummaryContent}>
                        Transcript + takeaways
                      </option>
                    </select>
                    <button
                      type="button"
                      onClick={handleExportDownload}
                      className="rounded-lg border border-zinc-300 px-3 py-1.5 text-xs font-medium hover:bg-zinc-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                    >
                      Download .md
                    </button>
                  </div>
                )}
              </div>

              {renderTranscript()}
            </>
          )}
        </section>
      </div>
    </main>
  );
}
