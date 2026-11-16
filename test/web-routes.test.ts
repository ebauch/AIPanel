// The web side of saved debates, through the real route handlers and the
// app's own registry, pointed at the fake CLIs and a temp data dir.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import type { SavedDebate } from "@/lib/debate-store";
import type { DebateConfig, DebateStreamEvent } from "@/lib/types";
import { SUMMARY_JSON } from "./panel-fixtures";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "aipanel-web-"));
const FAKE = path.join(__dirname, "fixtures", "fake-cli.mjs");
for (const kind of ["claude", "codex"]) {
  fs.writeFileSync(path.join(tmp, kind), `#!/bin/sh\nFAKE_CLI=${kind} exec "${process.execPath}" "${FAKE}" "$@"\n`, {
    mode: 0o755,
  });
}
Object.assign(process.env, {
  AIPANEL_DATA_DIR: path.join(tmp, "data"),
  AIPANEL_CLAUDE_BIN: path.join(tmp, "claude"),
  AIPANEL_CODEX_BIN: path.join(tmp, "codex"),
  FAKE_SCENARIO: "ok",
  FAKE_LOG: path.join(tmp, "calls.jsonl"),
  FAKE_SUMMARY_JSON: SUMMARY_JSON,
});
delete process.env.OPENROUTER_API_KEY;

async function sseEvents(response: Response): Promise<DebateStreamEvent[]> {
  const text = await response.text();
  return text
    .split("\n\n")
    .filter((chunk) => chunk.startsWith("data: "))
    .map((chunk) => JSON.parse(chunk.slice(6)) as DebateStreamEvent);
}

const json = (body: unknown, method = "POST") =>
  ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as RequestInit;

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

describe("web routes save debates, and list / open / rename / continue / delete them", () => {
  it("covers the whole lifecycle", async () => {
    const debateRoute = await import("@/app/api/debate/route");
    const summarizeRoute = await import("@/app/api/summarize/route");
    const listRoute = await import("@/app/api/debates/route");
    const itemRoute = await import("@/app/api/debates/[id]/route");
    const continueRoute = await import("@/app/api/debates/[id]/continue/route");

    const config: DebateConfig = {
      contextBrief: "Should we ship on Friday?",
      documents: [{ label: "Spec", content: "spec text", source: "PDF: spec.pdf" }],
      modelIds: ["claude-cli:claude-opus-5-5", "codex-cli:gpt-6-astra"],
      mode: "assigned_stances",
      reasoningEffort: "high",
      rounds: 1,
      iterations: 1,
      stances: [],
      summarize: true,
      summaryModelId: "claude-cli:claude-opus-5-5",
      speakerMemory: true,
    };
    const events = await sseEvents(await debateRoute.POST(new Request("http://x/api/debate", json(config))));
    assert.equal(events[0].type, "debate_saved");
    const id = events[0].type === "debate_saved" ? events[0].id : "";
    assert.equal(events.at(-1)?.type, "debate_end");

    const saved = (await (await itemRoute.GET(new Request("http://x"), ctx(id))).json()) as SavedDebate;
    assert.equal(saved.source, "web");
    assert.equal(saved.status, "done");
    assert.equal(saved.question, "Should we ship on Friday?");
    assert.deepEqual(saved.documents.map((d) => [d.label, d.source]), [["Spec", "PDF: spec.pdf"]]);
    assert.equal(saved.turns.length, 2);
    assert.equal(saved.settings.summaryModelId, "claude-cli:claude-opus-5-5");

    // The page's separate summary request attaches its result to the record.
    await sseEvents(
      await summarizeRoute.POST(
        new Request(
          "http://x/api/summarize",
          json({
            contextBrief: config.contextBrief,
            documents: config.documents,
            transcript: saved.turns,
            modelId: "claude-cli:claude-opus-5-5",
            reasoningEffort: "high",
            panel: saved.panel,
            debateId: id,
          }),
        ),
      ),
    );
    const listed = await (await listRoute.GET(new Request("http://x/api/debates"))).json();
    assert.equal(listed.total, 1);
    assert.equal(listed.nextOffset, null);
    assert.equal(listed.debates[0].id, id);
    assert.deepEqual(listed.debates[0].models, ["Claude Opus 5.5 (Max)", "GPT-6 Astra (ChatGPT)"]);

    const renamed = await itemRoute.PATCH(new Request("http://x", json({ title: "Friday ship?" }, "PATCH")), ctx(id));
    assert.equal(((await renamed.json()) as SavedDebate).title, "Friday ship?");

    const continued = await sseEvents(
      await continueRoute.POST(new Request("http://x", json({ followup: "What about QUOTE_ME:weekends?", rounds: 1 })), ctx(id)),
    );
    const turnTexts = continued.flatMap((e) => (e.type === "turn_end" ? [e.text] : []));
    assert.deepEqual(turnTexts, ["claude argues (heard weekends?)", "codex argues (heard weekends?)"]);
    assert.equal(continued.at(-1)?.type, "summary_end");

    const after = (await (await itemRoute.GET(new Request("http://x"), ctx(id))).json()) as SavedDebate;
    assert.equal(after.title, "Friday ship?");
    assert.equal(after.turns.length, 5);
    assert.equal(after.summary?.takeaways?.verdict, "Ship on Monday, not Friday.");

    const bad = await continueRoute.POST(new Request("http://x", json({ rounds: 99 })), ctx(id));
    assert.equal(bad.status, 400);

    assert.equal((await itemRoute.DELETE(new Request("http://x"), ctx(id))).status, 200);
    assert.equal((await itemRoute.GET(new Request("http://x"), ctx(id))).status, 404);
    assert.equal((await itemRoute.GET(new Request("http://x"), ctx("../../etc"))).status, 404);
  });
});
