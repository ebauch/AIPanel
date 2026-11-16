import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { runDebate } from "@/lib/debate";
import {
  continueSavedDebate,
  recordDebate,
  startSavedDebate,
} from "@/lib/debate-runner";
import { DEFAULT_DEBATE_SETTINGS, toDebateConfig } from "@/lib/debate-settings";
import { DebateStore, USER_SPEAKER_INDEX, type SavedDebate } from "@/lib/debate-store";
import type { DebateStreamEvent } from "@/lib/types";
import { deadPid, makePanel, PANEL, starts } from "./panel-fixtures";

const settings = { ...DEFAULT_DEBATE_SETTINGS, mode: "assigned_stances" as const, rounds: 1 };

function newInput(question = "Should we ship on Friday?") {
  return {
    source: "mcp" as const,
    question,
    documents: [{ label: "Notes", content: "release notes text", source: "/tmp/notes.md" }],
    modelIds: PANEL,
    settings,
  };
}

function readJson(store: DebateStore, id: string): SavedDebate {
  return JSON.parse(fs.readFileSync(store.jsonPath(id), "utf8")) as SavedDebate;
}

function tmpFiles(dir: string): string[] {
  return fs.readdirSync(dir, { recursive: true }).map(String).filter((file) => file.endsWith(".tmp"));
}

describe("debate store", () => {
  it("round-trips a debate, keeps documents once by hash, lists newest first, renames and deletes", () => {
    const { store } = makePanel();
    const first = store.create(newInput("First?"), new Date("2026-11-16T10:00:00Z"));
    const second = store.create(newInput("Second?"), new Date("2026-11-16T11:00:00Z"));

    const loaded = store.load(first.id);
    assert.deepEqual(loaded, { ...first, status: "running" });
    assert.equal(first.documents[0].source, "/tmp/notes.md");
    assert.equal(first.documents[0].chars, "release notes text".length);
    assert.match(first.documents[0].sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(store.loadDocuments(first.documents), [
      { label: "Notes", content: "release notes text", source: "/tmp/notes.md" },
    ]);
    // Same text in two debates: one blob, not two copies, and not inside the JSON.
    assert.equal(fs.readdirSync(path.join(store.dir, "docs")).length, 1);
    assert.ok(!fs.readFileSync(store.jsonPath(first.id), "utf8").includes("release notes text"));

    assert.deepEqual(store.list().debates.map((d) => d.id), [second.id, first.id]);
    assert.deepEqual(store.list({ limit: 1, offset: 1 }), {
      debates: [store.list().debates[1]],
      total: 2,
    });

    store.rename(first.id, "  Renamed   debate ");
    assert.equal(store.load(first.id)?.title, "Renamed debate");
    assert.throws(() => store.rename(first.id, "   "), /Title must be/);

    assert.equal(store.delete(second.id), true);
    assert.equal(fs.existsSync(store.jsonPath(second.id)), false);
    assert.equal(fs.existsSync(store.markdownPath(second.id)), false);
    assert.equal(fs.readdirSync(path.join(store.dir, "docs")).length, 1, "still used by the first debate");
    store.delete(first.id);
    assert.equal(fs.readdirSync(path.join(store.dir, "docs")).length, 0, "unreferenced document removed");
    assert.deepEqual(tmpFiles(store.dir), []);
  });

  it("rejects ids that could escape the store directory", () => {
    const { store } = makePanel();
    assert.equal(store.load("20261116-100000-abcdef"), null);
    assert.throws(() => store.load("../../etc/passwd"), /Invalid debate id/);
  });
});

describe("saved debates with fake subscription CLIs", () => {
  it("writes the record after every turn, atomically, and finishes with the summary", async () => {
    const { registry, store } = makePanel();
    const turnsOnDisk: number[] = [];
    let id = "";
    const record = await startSavedDebate(
      { ...newInput(), settings: { ...settings, rounds: 2 } },
      {
        store,
        registry,
        onEvent: (event) => {
          if (event.type === "debate_saved") {
            id = event.id;
          }
          if (event.type === "turn_end") {
            // Already on disk, and a complete JSON document, when the event is seen.
            turnsOnDisk.push(readJson(store, id).turns.length);
            assert.deepEqual(tmpFiles(store.dir), []);
          }
        },
      },
    );
    assert.deepEqual(turnsOnDisk, [1, 2, 3, 4]);
    assert.equal(record.id, id);
    assert.equal(record.status, "done");
    assert.equal(record.pid, undefined);
    assert.deepEqual(
      record.panel.map((m) => [m.modelDisplayName, m.stance]),
      [
        ["Claude Opus 5.5 (Max)", "Pro"],
        ["GPT-6 Astra (ChatGPT)", "Against"],
      ],
    );
    assert.equal(record.summary?.takeaways?.verdict, "Ship on Monday, not Friday.");
    assert.equal(record.cost.subscriptionCalls, 5, "4 turns + 1 summary");
    const markdown = fs.readFileSync(store.markdownPath(id), "utf8");
    assert.match(markdown, /## Verdict\n\nShip on Monday/);
    assert.match(markdown, /round 2 — GPT-6 Astra \(ChatGPT\) \[Against\]\n\ncodex argues/);
  });

  it("a debate rejected before it starts leaves no record", async () => {
    const { registry, store } = makePanel();
    await assert.rejects(
      startSavedDebate({ ...newInput(), modelIds: [PANEL[0]] }, { store, registry }),
      /at least two models/,
    );
    assert.equal(store.list().total, 0);
  });

  it("marks a debate stopped when it is aborted", async () => {
    const { registry, store } = makePanel({ codexScenario: "hang" });
    const controller = new AbortController();
    const record = await startSavedDebate(newInput(), {
      store,
      registry,
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "turn_start" && event.speakerIndex === 1) {
          setTimeout(() => controller.abort(), 50);
        }
      },
    });
    assert.equal(record.status, "stopped");
    assert.equal(record.turns.length, 1);
    assert.equal(record.summary, null);
  });

  it("resumes a debate whose process died mid-way (simulated crash)", async () => {
    const { claude, registry, store } = makePanel();
    const config = toDebateConfig({
      contextBrief: "Should we ship on Friday?",
      documents: [],
      modelIds: PANEL,
      settings: { ...settings, rounds: 3 },
    });
    let id = "";
    const events = recordDebate(store, runDebate(config, { registry }), {
      create: () => store.create({ ...newInput(), settings: { ...settings, rounds: 3 } }),
    });
    // Consume until round 1 is complete, then abandon the generator without
    // closing it: like a crash, no cleanup code runs.
    let turnEnds = 0;
    while (turnEnds < 2) {
      const next = (await events.next()).value as DebateStreamEvent;
      if (next.type === "debate_saved") {
        id = next.id;
      }
      if (next.type === "turn_end") {
        turnEnds += 1;
      }
    }
    const crashed = readJson(store, id);
    assert.equal(crashed.status, "running");
    assert.equal(crashed.turns.length, 2);
    // The process that was running it is gone.
    fs.writeFileSync(store.jsonPath(id), JSON.stringify({ ...crashed, pid: deadPid() }));
    assert.equal(store.load(id)?.status, "stopped");
    assert.equal(store.list().debates[0].status, "stopped");

    const claudeCallsBefore = starts(claude).length;
    const resumed = await continueSavedDebate(id, { rounds: 1 }, { store, registry });
    assert.equal(resumed.id, id);
    assert.equal(resumed.status, "done");
    assert.deepEqual(
      resumed.turns.map((t) => [t.round, t.speakerIndex, t.text]),
      [
        [1, 0, "claude argues"],
        [1, 1, "codex argues"],
        [2, 0, "claude argues"],
        [2, 1, "codex argues"],
      ],
    );
    // Opus's round-2 prompt carried Astra's round-1 turn and its own earlier turn.
    const resumedCall = starts(claude)[claudeCallsBefore];
    assert.match(String(resumedCall.stdin), /codex argues/);
    assert.match(String(resumedCall.stdin), /What you argued in your earlier turns[\s\S]*claude argues/);
  });

  it("continue appends a follow-up and more rounds to the same debate, then re-summarizes", async () => {
    const { claude, codex, registry, store } = makePanel();
    const first = await startSavedDebate(newInput(), { store, registry });
    assert.equal(first.turns.length, 2);
    const firstSummaryAt = first.summary?.at;

    const continued = await continueSavedDebate(
      first.id,
      { followup: "What about QUOTE_ME:pineapple now?", rounds: 2 },
      { store, registry },
    );
    assert.equal(continued.id, first.id);
    assert.equal(store.list().total, 1, "no new debate was created");
    assert.deepEqual(
      continued.turns.map((t) => [t.round, t.speakerIndex, t.text]),
      [
        [1, 0, "claude argues"],
        [1, 1, "codex argues"],
        [2, USER_SPEAKER_INDEX, "What about QUOTE_ME:pineapple now?"],
        [2, 0, "claude argues (heard pineapple)"],
        [2, 1, "codex argues (heard pineapple)"],
        [3, 0, "claude argues (heard pineapple)"],
        [3, 1, "codex argues (heard pineapple)"],
      ],
    );
    // Same panel, stances kept.
    assert.deepEqual(
      continued.turns.filter((t) => t.speakerIndex >= 0).map((t) => t.stance),
      ["Pro", "Against", "Pro", "Against", "Pro", "Against"],
    );
    assert.equal(starts(claude).length, 3 + 2, "1+2 rounds plus two summaries");
    assert.equal(starts(codex).length, 3);
    // Every continued turn had the whole earlier debate as context.
    const continuedCall = starts(codex)[1];
    assert.match(String((continuedCall.argv as string[]).at(-1)), /The debate so far[\s\S]*Round 1: Claude Opus 5.5 \(Max\) \[Pro\]\nclaude argues/);
    // The re-summary saw the follow-up and the new rounds.
    const summaryCall = starts(claude).at(-1)!;
    assert.match(String(summaryCall.stdin), /What about QUOTE_ME:pineapple now/);
    assert.match(String(summaryCall.stdin), /Round 3/);
    assert.notEqual(continued.summary?.at, firstSummaryAt);
    assert.equal(continued.status, "done");
  });

  it("a summary that fails before it starts still records which model it asked", async () => {
    const { registry, store } = makePanel();
    const record = await startSavedDebate(
      { ...newInput(), settings: { ...settings, summaryModelId: "anthropic/claude-fable-5" } },
      { store, registry },
    );
    assert.match(record.summary?.error ?? "", /No OpenRouter API key/);
    assert.equal(record.summary?.modelId, "anthropic/claude-fable-5");
  });

  it("refuses to continue a debate that is still running, and validates options", async () => {
    const { registry, store } = makePanel();
    const record = store.create(newInput());
    await assert.rejects(continueSavedDebate(record.id, {}, { store, registry }), /still running/);
    await assert.rejects(continueSavedDebate(record.id, { rounds: 0 }, { store, registry }), /between 1 and 10/);
    await assert.rejects(
      continueSavedDebate("20261116-100000-abcdef", {}, { store, registry }),
      /No saved debate/,
    );
  });
});
