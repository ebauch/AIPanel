"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Markdown } from "@/app/components/Markdown";
import { apiHeaders } from "@/lib/api-key-store";
import { ROUNDS_RANGE } from "@/lib/debate-settings";
import {
  formatDebateCost,
  USER_SPEAKER_INDEX,
  type SavedDebate,
  type SavedTurn,
} from "@/lib/debate-record";
import { isBackedByWholePanel } from "@/lib/summary-utils";
import type { DebateStreamEvent } from "@/lib/types";
import { formatWhen, StatusPill } from "../ui";

interface LiveTurn {
  key: string;
  round: number;
  speakerIndex: number;
  modelDisplayName: string;
  stance: string | null;
  text: string;
  error?: string;
  streaming: boolean;
}

function parseSse(buffer: string, onEvent: (event: DebateStreamEvent) => void): string {
  const parts = buffer.split("\n\n");
  const remainder = parts.pop() ?? "";
  for (const part of parts) {
    const line = part.split("\n").find((entry) => entry.startsWith("data: "));
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

function TurnView({ turn }: { turn: Pick<SavedTurn, "speakerIndex" | "modelDisplayName" | "stance" | "text" | "error"> & { streaming?: boolean } }) {
  const isUser = turn.speakerIndex === USER_SPEAKER_INDEX;
  return (
    <article
      className={`rounded-xl border border-l-4 p-4 ${
        isUser
          ? "border-zinc-200 border-l-zinc-900 bg-zinc-900/5 dark:border-zinc-800 dark:border-l-zinc-100 dark:bg-white/5"
          : "border-zinc-200 border-l-violet-500 bg-violet-500/5 dark:border-zinc-800"
      }`}
    >
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="text-sm font-semibold">{turn.modelDisplayName}</span>
        {turn.stance && (
          <span className="rounded-full bg-violet-500/10 px-2 py-0.5 text-xs font-medium text-violet-700 dark:text-violet-300">
            {turn.stance}
          </span>
        )}
        {turn.streaming && <span className="text-xs text-zinc-500">streaming…</span>}
      </div>
      {turn.error ? (
        <p className="text-xs text-red-700 dark:text-red-300">{turn.error}</p>
      ) : turn.text ? (
        <Markdown text={turn.text} className="max-w-[75ch] text-sm text-zinc-800 dark:text-zinc-200" />
      ) : (
        <p className="text-sm text-zinc-400">Waiting…</p>
      )}
    </article>
  );
}

export default function DebatePage() {
  const { id } = useParams<{ id: string }>();
  const router = useRouter();
  const [record, setRecord] = useState<SavedDebate | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [followup, setFollowup] = useState("");
  const [moreRounds, setMoreRounds] = useState(1);
  const [running, setRunning] = useState(false);
  const [liveTurns, setLiveTurns] = useState<LiveTurn[]>([]);
  const [liveStatus, setLiveStatus] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await fetch(`/api/debates/${id}`, { cache: "no-store" });
      const data = (await response.json()) as SavedDebate & { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? `Request failed (${response.status})`);
      }
      setRecord(data);
      setLoadError(null);
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "Could not load the debate.");
    }
  }, [id]);

  useEffect(() => {
    // Fetch-on-mount; the state updates happen after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const rounds = useMemo(() => {
    const groups = new Map<string, SavedTurn[]>();
    for (const turn of record?.turns ?? []) {
      const key = `${turn.iteration}-${turn.round}`;
      groups.set(key, [...(groups.get(key) ?? []), turn]);
    }
    return [...groups.entries()];
  }, [record]);

  const handleEvent = useCallback((event: DebateStreamEvent) => {
    switch (event.type) {
      case "turn_start":
        setLiveStatus(`Round ${event.round}: ${event.modelDisplayName} is answering…`);
        setLiveTurns((current) => [
          ...current,
          {
            key: `${event.iteration}-${event.round}-${event.speakerIndex}-${current.length}`,
            round: event.round,
            speakerIndex: event.speakerIndex,
            modelDisplayName: event.modelDisplayName,
            stance: event.stance,
            text: "",
            streaming: true,
          },
        ]);
        break;
      case "token":
        setLiveTurns((current) =>
          current.map((turn, index) =>
            index === current.length - 1 && turn.streaming ? { ...turn, text: turn.text + event.text } : turn,
          ),
        );
        break;
      case "turn_end":
        setLiveTurns((current) =>
          current.map((turn, index) =>
            index === current.length - 1
              ? { ...turn, text: event.text || turn.text, error: event.error, streaming: false }
              : turn,
          ),
        );
        break;
      case "summary_start":
        setLiveStatus(`Re-summarizing with ${event.modelDisplayName}…`);
        break;
      case "summary_error":
        setError(`Summary failed: ${event.message}`);
        break;
      case "error":
        setError(event.message);
        break;
      default:
        break;
    }
  }, []);

  const runContinue = async () => {
    setError(null);
    setLiveTurns([]);
    setLiveStatus("Starting…");
    setRunning(true);
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const response = await fetch(`/api/debates/${id}/continue`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...apiHeaders() },
        body: JSON.stringify({ followup: followup.trim() || undefined, rounds: moreRounds }),
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        const data = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(data.error ?? `Request failed (${response.status})`);
      }
      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        buffer = parseSse(buffer + decoder.decode(value, { stream: true }), handleEvent);
      }
      parseSse(`${buffer}${decoder.decode()}\n\n`, handleEvent);
      setFollowup("");
    } catch (err) {
      if (!(err instanceof DOMException && err.name === "AbortError")) {
        setError(err instanceof Error ? err.message : "Continue failed.");
      }
    } finally {
      abortRef.current = null;
      setRunning(false);
      setLiveStatus(null);
      await load();
      setLiveTurns([]);
    }
  };

  const rename = async () => {
    if (!record) {
      return;
    }
    const title = window.prompt("Rename debate", record.title);
    if (title === null || !title.trim()) {
      return;
    }
    const response = await fetch(`/api/debates/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = (await response.json()) as SavedDebate & { error?: string };
    if (!response.ok) {
      setError(data.error ?? "Rename failed.");
      return;
    }
    setRecord(data);
  };

  const remove = async () => {
    if (!record || !window.confirm(`Delete "${record.title}"? This cannot be undone.`)) {
      return;
    }
    const response = await fetch(`/api/debates/${id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Delete failed.");
      return;
    }
    router.push("/debates");
  };

  if (loadError) {
    return (
      <main className="mx-auto w-full max-w-5xl px-4 py-8 lg:px-8">
        <p className="text-sm text-red-700 dark:text-red-300">{loadError}</p>
        <Link href="/debates" className="mt-2 inline-block text-sm font-medium text-violet-600 hover:underline">
          ← Recent debates
        </Link>
      </main>
    );
  }
  if (!record) {
    return <main className="mx-auto w-full max-w-5xl px-4 py-8 text-sm text-zinc-500 lg:px-8">Loading…</main>;
  }

  const takeaways = record.summary?.takeaways ?? null;
  const agreedTodos = takeaways?.takeaways.filter(
    (item) => item.kind === "action" && isBackedByWholePanel(item, record.panel),
  );
  const busy = running || record.status === "running";

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 lg:px-8">
      <Link href="/debates" className="text-sm font-medium text-violet-600 hover:underline">
        ← Recent debates
      </Link>

      <header className="space-y-2">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h1 className="text-2xl font-semibold tracking-tight">{record.title}</h1>
          <div className="flex gap-3 text-sm">
            <button type="button" onClick={() => void rename()} className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
              Rename
            </button>
            <button type="button" onClick={() => void remove()} disabled={busy} className="text-red-600 hover:text-red-500 disabled:opacity-40">
              Delete
            </button>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
          <span>{formatWhen(record.createdAt)}</span>
          <StatusPill status={record.status} />
          <span>{record.source === "mcp" ? "from Claude Code" : "from the web form"}</span>
          <span>· {record.settings.mode.replace(/_/g, " ")}</span>
          <span>· {formatDebateCost(record.cost)}</span>
        </div>
        <p className="text-sm text-zinc-600 dark:text-zinc-400">
          Panel:{" "}
          {(record.panel.length > 0
            ? record.panel.map((m) => `${m.modelDisplayName}${m.stance ? ` (${m.stance})` : ""}`)
            : record.modelIds
          ).join(" vs ")}
        </p>
        {record.error && (
          <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
            {record.error}
          </p>
        )}
      </header>

      <section className="space-y-2 rounded-2xl bg-white p-5 ring-1 ring-black/5 dark:bg-zinc-950">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Question</h2>
        <Markdown text={record.question} className="text-sm" />
        {record.context && <Markdown text={record.context} className="text-sm text-zinc-600 dark:text-zinc-400" />}
        {record.documents.length > 0 && (
          <ul className="mt-2 space-y-1 text-xs text-zinc-500">
            {record.documents.map((doc) => (
              <li key={`${doc.sha256}-${doc.label}`}>
                {doc.label} — {doc.source} ({doc.chars.toLocaleString()} chars)
              </li>
            ))}
          </ul>
        )}
      </section>

      {record.summary && (
        <section className="space-y-4 rounded-2xl bg-white p-5 ring-1 ring-black/5 dark:bg-zinc-950">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">
            Verdict{record.summary.modelDisplayName ? ` · ${record.summary.modelDisplayName}` : ""}
          </h2>
          {takeaways ? (
            <>
              <p className="text-lg font-medium">
                {takeaways.verdict} <span className="text-sm text-zinc-500">({takeaways.confidence} confidence)</span>
              </p>
              {agreedTodos && agreedTodos.length > 0 && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold">To-dos every model backed</h3>
                  <ul className="list-disc space-y-1 pl-5 text-sm">
                    {agreedTodos.map((item) => (
                      <li key={item.title}>
                        <strong>{item.title}</strong> — {item.detail}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <div>
                <h3 className="mb-1 text-sm font-semibold">All takeaways</h3>
                <ul className="list-disc space-y-1 pl-5 text-sm">
                  {takeaways.takeaways.map((item) => (
                    <li key={item.title}>
                      <strong>{item.title}</strong> ({item.kind}) — {item.detail}{" "}
                      <span className="text-xs text-zinc-500">
                        backed by {item.supporters.join(", ") || "—"}
                        {item.dissenters.length > 0 ? `; against: ${item.dissenters.join(", ")}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              </div>
              {takeaways.disagreements.length > 0 && (
                <div>
                  <h3 className="mb-1 text-sm font-semibold">Open disagreements</h3>
                  <ul className="space-y-2 text-sm">
                    {takeaways.disagreements.map((d) => (
                      <li key={d.topic}>
                        <strong>{d.topic}</strong>
                        <ul className="list-disc pl-5">
                          {d.positions.map((p) => (
                            <li key={p.model}>
                              {p.model}: {p.position}
                            </li>
                          ))}
                        </ul>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          ) : record.summary.error ? (
            <p className="text-sm text-red-700 dark:text-red-300">Summary failed: {record.summary.error}</p>
          ) : (
            <Markdown text={record.summary.text} className="text-sm" />
          )}
        </section>
      )}

      <section className="space-y-4">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Transcript</h2>
        {rounds.length === 0 && <p className="text-sm text-zinc-500">No turns yet.</p>}
        {rounds.map(([key, turns]) => (
          <div key={key} className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">
              {record.settings.mode === "randomized_stances" ? `Iteration ${turns[0].iteration}, round` : "Round"}{" "}
              {turns[0].round}
            </h3>
            {turns.map((turn, index) => (
              <TurnView key={`${key}-${index}`} turn={turn} />
            ))}
          </div>
        ))}
        {liveTurns.length > 0 && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">Continuing…</h3>
            {liveTurns.map((turn) => (
              <TurnView key={turn.key} turn={turn} />
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3 rounded-2xl bg-white p-5 ring-1 ring-black/5 dark:bg-zinc-950">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-zinc-500">Continue this debate</h2>
        <p className="text-xs text-zinc-500">
          Same panel and settings; every model sees the full transcript so far. The takeaways are
          re-summarized at the end.
        </p>
        <textarea
          value={followup}
          onChange={(event) => setFollowup(event.target.value)}
          rows={3}
          disabled={busy}
          placeholder="Optional follow-up question or instruction for the panel…"
          className="w-full rounded-xl border border-zinc-300 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900"
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-sm">
            More rounds
            <input
              type="number"
              min={ROUNDS_RANGE.min}
              max={ROUNDS_RANGE.max}
              value={moreRounds}
              onChange={(event) => setMoreRounds(Number(event.target.value))}
              disabled={busy}
              className="w-20 rounded-lg border border-zinc-300 bg-white px-2 py-1 text-sm dark:border-zinc-700 dark:bg-zinc-900"
            />
          </label>
          {running ? (
            <button
              type="button"
              onClick={() => abortRef.current?.abort()}
              className="rounded-lg bg-zinc-200 px-3 py-1.5 text-sm font-semibold hover:bg-zinc-300 dark:bg-zinc-800 dark:hover:bg-zinc-700"
            >
              Stop
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void runContinue()}
              disabled={busy}
              className="rounded-lg bg-violet-600 px-3 py-1.5 text-sm font-semibold text-white hover:bg-violet-500 disabled:opacity-50"
            >
              Continue
            </button>
          )}
          {liveStatus && <span className="text-xs text-zinc-500">{liveStatus}</span>}
          {!running && record.status === "running" && (
            <span className="text-xs text-zinc-500">This debate is still running elsewhere.</span>
          )}
        </div>
        {error && <p className="text-sm text-red-700 dark:text-red-300">{error}</p>}
      </section>
    </main>
  );
}
