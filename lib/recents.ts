import type { DebateListItem, DebateStatus } from "./debate-record";

/** How many saved debates the home page shows in place of the examples. */
export const RECENTS_LIMIT = 6;

export interface RecentCard {
  id: string;
  href: string;
  title: string;
  /** "2 h ago · Opus 5.5, GPT-6 Astra · done" */
  subline: string;
}

/**
 * Newest saved debates for the home page, or null when the examples should show
 * instead (no saved debates, or the list call failed — the open version has no store).
 */
export function selectRecents(
  debates: DebateListItem[] | null | undefined,
  now: Date = new Date(),
  limit = RECENTS_LIMIT,
): RecentCard[] | null {
  if (!Array.isArray(debates) || debates.length === 0) {
    return null;
  }
  return [...debates]
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id))
    .slice(0, Math.max(1, limit))
    .map((item) => ({
      id: item.id,
      href: `/debates/${item.id}`,
      title: item.title,
      subline: [
        formatRelative(item.updatedAt, now),
        item.models.map(shortModelName).join(", "),
        statusLabel(item.status),
      ]
        .filter(Boolean)
        .join(" · "),
    }));
}

const STATUS_LABELS: Record<DebateStatus, string> = {
  running: "running",
  done: "done",
  error: "failed",
  stopped: "stopped",
};

export function statusLabel(status: DebateStatus): string {
  return STATUS_LABELS[status] ?? status;
}

/** "Anthropic: Claude Fable 5" → "Fable 5"; "Claude Opus 5.5 (CLI)" → "Opus 5.5". */
export function shortModelName(name: string): string {
  const short = name
    .replace(/^[^:]+:\s*/, "")
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/^Claude\s+/i, "")
    .trim();
  return short || name;
}

/** "just now", "5 min ago", "3 h ago", "yesterday", "4 days ago", then the date. */
export function formatRelative(iso: string, now: Date = new Date()): string {
  const then = new Date(iso);
  if (Number.isNaN(then.getTime())) {
    return "";
  }
  const minutes = Math.floor((now.getTime() - then.getTime()) / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes} min ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours} h ago`;
  }
  const days = Math.floor(hours / 24);
  if (days === 1) {
    return "yesterday";
  }
  if (days < 7) {
    return `${days} days ago`;
  }
  return then.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(then.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
}
