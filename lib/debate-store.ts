// Saved debates: one JSON file per debate under <data dir>/debates, shared by
// the web app and the MCP server. Every write is temp file + rename, and the
// runner saves after each turn, so a crash or a closed tab leaves a debate
// that can still be read and continued. Document text is stored once, by
// content hash, under debates/docs/; the debate keeps only references.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  emptyCost,
  formatDebateCost,
  isDebateId,
  MAX_TITLE_CHARS,
  USER_DISPLAY_NAME,
  USER_SPEAKER_INDEX,
  type DebateListItem,
  type DebateSource,
  type DebateStatus,
  type DocumentRef,
  type SavedDebate,
} from "./debate-record";
import type { DebateSettings } from "./debate-settings";
import { dataDir } from "./model-settings";
import type { LabeledDocument } from "./types";

// Server code imports everything saved-debate related from here.
export * from "./debate-record";

const SHA_PATTERN = /^[0-9a-f]{64}$/;

/** Sortable and unguessable enough: 20261116-142501-a1b2c3 (UTC). */
export function newDebateId(now = new Date()): string {
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${stamp}-${crypto.randomBytes(3).toString("hex")}`;
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** A "running" debate whose process is gone was interrupted (crash, restart). */
export function effectiveStatus(record: Pick<SavedDebate, "status" | "pid">): DebateStatus {
  if (record.status === "running" && (!record.pid || !isPidAlive(record.pid))) {
    return "stopped";
  }
  return record.status;
}

export function isRunningNow(record: Pick<SavedDebate, "status" | "pid">): boolean {
  return effectiveStatus(record) === "running";
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(3).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, text, "utf8");
  fs.renameSync(tmp, file);
}

export interface NewDebateInput {
  source: DebateSource;
  question: string;
  context?: string;
  documents: LabeledDocument[];
  preset?: string;
  modelIds: string[];
  settings: DebateSettings;
}

export class DebateStore {
  constructor(readonly dir: string) {}

  jsonPath(id: string): string {
    this.assertId(id);
    return path.join(this.dir, `${id}.json`);
  }

  /** Full transcript as markdown, rewritten on every save. */
  markdownPath(id: string): string {
    this.assertId(id);
    return path.join(this.dir, `${id}.md`);
  }

  private docPath(sha256: string): string {
    if (!SHA_PATTERN.test(sha256)) {
      throw new Error("Invalid document hash.");
    }
    return path.join(this.dir, "docs", `${sha256}.txt`);
  }

  private assertId(id: string): void {
    if (!isDebateId(id)) {
      throw new Error(`Invalid debate id: ${id}`);
    }
  }

  /** Store document text once by content hash; returns the reference. */
  putDocument(doc: LabeledDocument): DocumentRef {
    const sha256 = crypto.createHash("sha256").update(doc.content, "utf8").digest("hex");
    const file = this.docPath(sha256);
    if (!fs.existsSync(file)) {
      writeAtomic(file, doc.content);
    }
    return {
      label: doc.label,
      source: doc.source?.trim() || "pasted text",
      sha256,
      chars: doc.content.length,
    };
  }

  /** Documents back as the models see them (for continuing a debate). */
  loadDocuments(refs: DocumentRef[]): LabeledDocument[] {
    return refs.map((ref) => {
      let content: string;
      try {
        content = fs.readFileSync(this.docPath(ref.sha256), "utf8");
      } catch {
        throw new Error(`Saved document "${ref.label}" is missing from ${path.join(this.dir, "docs")}.`);
      }
      return { label: ref.label, content, source: ref.source };
    });
  }

  create(input: NewDebateInput, now = new Date()): SavedDebate {
    const id = newDebateId(now);
    const stamp = now.toISOString();
    const record: SavedDebate = {
      version: 1,
      id,
      title: input.question.trim().replace(/\s+/g, " ").slice(0, MAX_TITLE_CHARS) || "Untitled debate",
      createdAt: stamp,
      updatedAt: stamp,
      source: input.source,
      status: "running",
      pid: process.pid,
      question: input.question,
      ...(input.context?.trim() ? { context: input.context } : {}),
      documents: input.documents.map((doc) => this.putDocument(doc)),
      ...(input.preset ? { preset: input.preset } : {}),
      modelIds: input.modelIds,
      settings: input.settings,
      panel: [],
      turns: [],
      summary: null,
      cost: emptyCost(),
    };
    this.save(record, now);
    return record;
  }

  save(record: SavedDebate, now = new Date()): void {
    record.updatedAt = now.toISOString();
    writeAtomic(this.jsonPath(record.id), `${JSON.stringify(record, null, 2)}\n`);
    writeAtomic(this.markdownPath(record.id), debateToMarkdown(record));
  }

  load(id: string): SavedDebate | null {
    const file = this.jsonPath(id);
    let text: string;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      return null;
    }
    const record = JSON.parse(text) as SavedDebate;
    return { ...record, status: effectiveStatus(record) };
  }

  /** Newest activity first. */
  list(options: { limit?: number; offset?: number } = {}): { debates: DebateListItem[]; total: number } {
    let files: string[];
    try {
      files = fs.readdirSync(this.dir);
    } catch {
      return { debates: [], total: 0 };
    }
    const items: DebateListItem[] = [];
    for (const file of files) {
      const id = file.endsWith(".json") ? file.slice(0, -5) : "";
      if (!isDebateId(id)) {
        continue;
      }
      try {
        const record = this.load(id);
        if (record) {
          items.push({
            id,
            title: record.title,
            createdAt: record.createdAt,
            updatedAt: record.updatedAt,
            source: record.source,
            status: record.status,
            models: record.panel.length > 0 ? record.panel.map((m) => m.modelDisplayName) : record.modelIds,
            turnCount: record.turns.filter((turn) => turn.speakerIndex !== USER_SPEAKER_INDEX).length,
          });
        }
      } catch {
        // A corrupt file must not hide the rest of the history.
      }
    }
    items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id));
    const offset = Math.max(0, options.offset ?? 0);
    const limit = Math.max(1, options.limit ?? 50);
    return { debates: items.slice(offset, offset + limit), total: items.length };
  }

  rename(id: string, title: string): SavedDebate {
    const record = this.load(id);
    if (!record) {
      throw new Error("Debate not found.");
    }
    const clean = title.trim().replace(/\s+/g, " ");
    if (!clean || clean.length > MAX_TITLE_CHARS) {
      throw new Error(`Title must be 1–${MAX_TITLE_CHARS} characters.`);
    }
    record.title = clean;
    this.save(record);
    return record;
  }

  /** Removes the debate and any document no other debate references. */
  delete(id: string): boolean {
    const record = this.load(id);
    if (!record) {
      return false;
    }
    fs.rmSync(this.jsonPath(id), { force: true });
    fs.rmSync(this.markdownPath(id), { force: true });
    const stillUsed = new Set<string>();
    for (const file of fs.readdirSync(this.dir)) {
      const otherId = file.endsWith(".json") ? file.slice(0, -5) : "";
      if (!isDebateId(otherId)) {
        continue;
      }
      try {
        this.load(otherId)?.documents.forEach((doc) => stillUsed.add(doc.sha256));
      } catch {
        // Unreadable debate: keep every document to be safe.
        return true;
      }
    }
    for (const doc of record.documents) {
      if (!stillUsed.has(doc.sha256)) {
        fs.rmSync(this.docPath(doc.sha256), { force: true });
      }
    }
    return true;
  }
}

let defaultStore: DebateStore | undefined;

export function getDebateStore(): DebateStore {
  const dir = path.join(dataDir(), "debates");
  if (!defaultStore || defaultStore.dir !== dir) {
    defaultStore = new DebateStore(dir);
  }
  return defaultStore;
}

/** Human-readable full transcript (what the MCP tool links to). */
export function debateToMarkdown(record: SavedDebate): string {
  const lines: string[] = [];
  lines.push(`# ${record.title}`, "");
  lines.push(`- Debate id: ${record.id}`);
  lines.push(`- Started: ${record.createdAt} (${record.source}) · Status: ${effectiveStatus(record)}`);
  lines.push(`- Panel: ${(record.panel.length > 0 ? record.panel.map((m) => `${m.modelDisplayName}${m.stance ? ` [${m.stance}]` : ""}`) : record.modelIds).join(", ")}`);
  lines.push(`- Mode: ${record.settings.mode} · Reasoning effort: ${record.settings.reasoningEffort}`);
  lines.push(`- Cost: ${formatDebateCost(record.cost)}`);
  if (record.error) {
    lines.push(`- Error: ${record.error}`);
  }
  lines.push("", "## Question", "", record.question.trim());
  if (record.context?.trim()) {
    lines.push("", "## Context", "", record.context.trim());
  }
  if (record.documents.length > 0) {
    lines.push("", "## Documents", "");
    for (const doc of record.documents) {
      lines.push(`- ${doc.label} (${doc.source}, ${doc.chars.toLocaleString("en-US")} chars)`);
    }
  }
  const summary = record.summary;
  if (summary?.takeaways) {
    const t = summary.takeaways;
    lines.push("", "## Verdict", "", `${t.verdict} (confidence: ${t.confidence})`);
    if (t.takeaways.length > 0) {
      lines.push("", "## Takeaways", "");
      for (const item of t.takeaways) {
        lines.push(`- **${item.title}** (${item.kind}) — ${item.detail}`);
        lines.push(`  - Backed by: ${item.supporters.join(", ") || "—"}; against: ${item.dissenters.join(", ") || "—"}`);
      }
    }
    if (t.disagreements.length > 0) {
      lines.push("", "## Disagreements", "");
      for (const d of t.disagreements) {
        lines.push(`- **${d.topic}**`);
        for (const p of d.positions) {
          lines.push(`  - ${p.model}: ${p.position}`);
        }
      }
    }
  } else if (summary?.text) {
    lines.push("", "## Summary", "", summary.text.trim());
  } else if (summary?.error) {
    lines.push("", "## Summary", "", `(failed: ${summary.error})`);
  }
  lines.push("", "## Transcript");
  for (const turn of record.turns) {
    const who = turn.speakerIndex === USER_SPEAKER_INDEX ? USER_DISPLAY_NAME : turn.modelDisplayName;
    lines.push("", `### Iteration ${turn.iteration}, round ${turn.round} — ${who}${turn.stance ? ` [${turn.stance}]` : ""}`, "");
    lines.push(turn.error ? `_(${turn.error})_` : turn.text.trim());
  }
  lines.push("");
  return lines.join("\n");
}
