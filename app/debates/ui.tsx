import type { DebateStatus } from "@/lib/debate-record";

const STATUS_STYLES: Record<DebateStatus, string> = {
  running: "bg-sky-500/10 text-sky-700 dark:text-sky-300",
  done: "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300",
  error: "bg-red-500/10 text-red-700 dark:text-red-300",
  stopped: "bg-amber-500/10 text-amber-700 dark:text-amber-300",
};

export function StatusPill({ status }: { status: DebateStatus }) {
  return (
    <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {status}
    </span>
  );
}

export function formatWhen(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}
