"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import type { DebateListItem } from "@/lib/debate-record";
import { formatWhen, StatusPill } from "./ui";

interface ListResponse {
  debates: DebateListItem[];
  total: number;
  nextOffset: number | null;
}

export default function DebatesPage() {
  const [debates, setDebates] = useState<DebateListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (offset: number) => {
    setLoading(true);
    try {
      const response = await fetch(`/api/debates?offset=${offset}`, { cache: "no-store" });
      const data = (await response.json()) as ListResponse & { error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? `Request failed (${response.status})`);
      }
      setDebates((current) => (offset === 0 ? data.debates : [...current, ...data.debates]));
      setTotal(data.total);
      setNextOffset(data.nextOffset);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load debates.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount; the state updates happen after the request resolves.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load(0);
  }, [load]);

  const rename = async (item: DebateListItem) => {
    const title = window.prompt("Rename debate", item.title);
    if (title === null || !title.trim() || title.trim() === item.title) {
      return;
    }
    const response = await fetch(`/api/debates/${item.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title }),
    });
    const data = (await response.json()) as { title?: string; error?: string };
    if (!response.ok) {
      setError(data.error ?? "Rename failed.");
      return;
    }
    setDebates((current) => current.map((d) => (d.id === item.id ? { ...d, title: data.title ?? title } : d)));
  };

  const remove = async (item: DebateListItem) => {
    if (!window.confirm(`Delete "${item.title}"? This cannot be undone.`)) {
      return;
    }
    const response = await fetch(`/api/debates/${item.id}`, { method: "DELETE" });
    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as { error?: string };
      setError(data.error ?? "Delete failed.");
      return;
    }
    setDebates((current) => current.filter((d) => d.id !== item.id));
    setTotal((current) => Math.max(0, current - 1));
    setNextOffset((current) => (current === null ? null : Math.max(0, current - 1)));
  };

  return (
    <main className="mx-auto flex w-full max-w-5xl flex-col gap-6 px-4 py-8 lg:px-8">
      <header className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Recent debates</h1>
        <p className="text-sm text-zinc-500">
          Every debate is saved as it runs, from the web form and from Claude Code
          (MCP). Open one to read it or continue it.
        </p>
      </header>

      {error && (
        <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {error}
        </p>
      )}

      {!loading && debates.length === 0 && !error && (
        <p className="text-sm text-zinc-500">
          No saved debates yet. <Link href="/" className="font-medium text-violet-600 hover:underline">Start one</Link>.
        </p>
      )}

      <ul className="divide-y divide-zinc-200 rounded-2xl bg-white ring-1 ring-black/5 dark:divide-zinc-800 dark:bg-zinc-950">
        {debates.map((item) => (
          <li key={item.id} className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:justify-between">
            <div className="min-w-0 space-y-1">
              <Link
                href={`/debates/${item.id}`}
                className="block truncate font-medium text-zinc-900 hover:text-violet-600 dark:text-zinc-50"
              >
                {item.title}
              </Link>
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-500">
                <span>{formatWhen(item.createdAt)}</span>
                <StatusPill status={item.status} />
                {item.source === "mcp" && (
                  <span className="rounded-full bg-zinc-900/5 px-2 py-0.5 dark:bg-white/10">Claude Code</span>
                )}
                <span className="truncate">{item.models.join(" vs ")}</span>
              </div>
            </div>
            <div className="flex shrink-0 gap-2 text-sm">
              <button type="button" onClick={() => void rename(item)} className="text-zinc-500 hover:text-zinc-900 dark:hover:text-zinc-100">
                Rename
              </button>
              <button
                type="button"
                onClick={() => void remove(item)}
                disabled={item.status === "running"}
                className="text-red-600 hover:text-red-500 disabled:opacity-40"
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between text-sm text-zinc-500">
        <span>
          {debates.length} of {total}
        </span>
        {nextOffset !== null && (
          <button
            type="button"
            onClick={() => void load(nextOffset)}
            disabled={loading}
            className="rounded-lg px-3 py-1.5 font-medium text-violet-600 hover:bg-violet-500/10 disabled:opacity-50"
          >
            {loading ? "Loading…" : "Load more"}
          </button>
        )}
      </div>
    </main>
  );
}
