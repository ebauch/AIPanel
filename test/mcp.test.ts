import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  DEFAULT_DEBATE_SETTINGS,
  resolveDebateSettings,
  SETTING_SCHEMAS,
  validateAgainstSchema,
  debateToolInputSchema,
} from "@/lib/debate-settings";
import { DEBATE_MODES, REASONING_EFFORTS } from "@/lib/types";
import { createAipanelServer, type McpDeps } from "@/mcp/tools";
import { makePanel, PANEL, starts } from "./panel-fixtures";

type Panel = ReturnType<typeof makePanel>;

async function connect(panel: Panel, extra: Partial<McpDeps> = {}) {
  const server = createAipanelServer({ store: panel.store, registry: panel.registry, ...extra });
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

async function call(
  client: Client,
  name: string,
  args: Record<string, unknown>,
  onprogress?: (p: { progress: number; total?: number; message?: string }) => void,
) {
  const result = await client.callTool({ name, arguments: args }, undefined, onprogress ? { onprogress } : undefined);
  const content = result.content as Array<{ type: string; text: string }>;
  return { text: content.map((c) => c.text).join("\n"), isError: Boolean(result.isError) };
}

describe("MCP server: tools", () => {
  it("lists debate, continue_debate, list_debates and list_models", async () => {
    const client = await connect(makePanel());
    const { tools } = await client.listTools();
    assert.deepEqual(
      tools.map((tool) => tool.name),
      ["debate", "continue_debate", "list_debates", "list_models"],
    );
    const debate = tools.find((tool) => tool.name === "debate")!;
    const properties = debate.inputSchema.properties as Record<string, { enum?: string[] }>;
    // Every web-form setting is a tool argument, with the form's allowed values.
    for (const key of Object.keys(SETTING_SCHEMAS)) {
      assert.ok(properties[key], `missing ${key}`);
    }
    for (const key of ["question", "context", "documents", "preset", "models"]) {
      assert.ok(properties[key], `missing ${key}`);
    }
    assert.deepEqual(properties.mode.enum, [...DEBATE_MODES]);
    assert.deepEqual(properties.reasoningEffort.enum, [...REASONING_EFFORTS]);
    assert.deepEqual(debate.inputSchema.required, ["question"]);
  });

  it("list_models returns enabled models, presets and the defaults", async () => {
    const client = await connect(makePanel());
    const { text, isError } = await call(client, "list_models", {});
    assert.equal(isError, false);
    const data = JSON.parse(text);
    assert.ok(data.models.some((m: { id: string; billing: string }) => m.id === PANEL[0] && m.billing === "subscription"));
    assert.deepEqual(data.presets.subscriptions, {
      description: "Opus 5.5 vs Astra (subscriptions)",
      models: PANEL,
      available: true,
    });
    assert.equal(data.presets.flagship.available, false, "no OpenRouter catalog in the test");
    assert.equal(data.defaultPreset, "subscriptions");
    assert.equal(data.defaults.rounds, DEFAULT_DEBATE_SETTINGS.rounds);
    assert.equal(data.defaults.mode, DEFAULT_DEBATE_SETTINGS.mode);
  });

  it("debate runs the default subscription preset and returns verdict, to-dos, disagreements, stances, cost and transcript", async () => {
    const panel = makePanel();
    const client = await connect(panel);
    const doc = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "aipanel-doc-")), "brief.md");
    fs.writeFileSync(doc, "The release notes say DOC_MARKER_42.");
    const progress: Array<{ progress: number; total?: number; message?: string }> = [];

    const { text, isError } = await call(
      client,
      "debate",
      { question: "Should we ship on Friday?", documents: [doc], rounds: 2 },
      (p) => progress.push(p),
    );
    assert.equal(isError, false, text);

    // Verdict first, then the sections the skill presents.
    assert.match(text, /^## Verdict\n\nShip on Monday, not Friday\. \(confidence: high\)/);
    const todos = text.slice(text.indexOf("## To-dos every model backed"), text.indexOf("## Open disagreements"));
    assert.match(todos, /Freeze merges Thursday/);
    assert.doesNotMatch(todos, /Add a canary/, "a to-do with a dissenter is not backed by every model");
    assert.match(text, /## Open disagreements\n\n- \*\*Rollback window\*\*\n {2}- Claude Opus 5\.5 \(Max\): One hour/);
    assert.match(text, /\*\*Claude Opus 5\.5 \(Max\)\*\* \[Pro\]: claude argues/);
    assert.match(text, /\*\*GPT-6 Astra \(ChatGPT\)\*\* \[Against\]: codex argues/);
    assert.match(text, /Cost: subscription \(5 subscription calls/);
    const transcriptPath = /Full transcript: (.+)/.exec(text)?.[1] ?? "";
    assert.ok(transcriptPath.startsWith(panel.store.dir));
    assert.match(fs.readFileSync(transcriptPath, "utf8"), /round 2 — GPT-6 Astra/);
    const id = /Debate id: (\S+)/.exec(text)?.[1] ?? "";

    // Saved like a web debate, from the preset, with the document as a reference.
    const record = panel.store.load(id)!;
    assert.equal(record.source, "mcp");
    assert.equal(record.preset, "subscriptions");
    assert.deepEqual(record.modelIds, PANEL);
    assert.deepEqual(record.settings, { ...DEFAULT_DEBATE_SETTINGS, rounds: 2 });
    assert.equal(record.documents[0].source, doc);
    assert.match(String(starts(panel.claude)[0].argv), /DOC_MARKER_42/);

    // Progress per round, then the summary; strictly increasing.
    assert.deepEqual(
      progress.map((p) => p.message),
      ["Round 1 done (1 of 2).", "Round 2 done (2 of 2).", "Summarizing with Claude Opus 5.5 (Max)…", "Summary done."],
    );
    assert.deepEqual(progress.map((p) => p.progress), [1, 2, 2, 3]);
    assert.ok(progress.every((p) => p.total === 3));
  });

  it("explicit arguments beat the preset, which beats the defaults", async () => {
    assert.deepEqual(resolveDebateSettings({ mode: "conversation", rounds: 1 }), {
      ...DEFAULT_DEBATE_SETTINGS,
      mode: "conversation",
      rounds: 1,
    });
    const panel = makePanel();
    const client = await connect(panel);
    const { text, isError } = await call(client, "debate", {
      question: "Q?",
      preset: "subscriptions",
      models: ["codex-cli:gpt-6-astra", "claude-cli:claude-fable-5-1"],
      mode: "conversation",
      rounds: 1,
      summarize: false,
      stances: [
        { label: "Cautious", instruction: "Be careful." },
        { label: "Bold", instruction: "Be bold." },
      ],
    });
    assert.equal(isError, false, text);
    assert.match(text, /No summary: debate status is done/);
    const record = panel.store.load(/Debate id: (\S+)/.exec(text)![1])!;
    assert.deepEqual(record.modelIds, ["codex-cli:gpt-6-astra", "claude-cli:claude-fable-5-1"]);
    assert.equal(record.preset, undefined);
    assert.equal(record.settings.mode, "conversation");
    assert.equal(record.settings.reasoningEffort, DEFAULT_DEBATE_SETTINGS.reasoningEffort);
    assert.equal(record.settings.stances[0].label, "Cautious");
    assert.ok((starts(panel.claude)[0].argv as string[]).includes("claude-fable-5-1"));
  });

  it("rejects invalid input before running anything", async () => {
    const panel = makePanel();
    const client = await connect(panel);
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ question: "   " }, /question must not be empty/],
      [{ question: "x".repeat(20_001) }, /question must be at most 20,000 characters/],
      [{ question: "Q", documents: ["/no/such/file.pdf"] }, /does not exist or is not readable/],
      [{ question: "Q", documents: ["file:///etc/hosts"] }, /Only http and https URLs/],
      [{ question: "Q", documents: ["ftp://example.com/x"] }, /Only http and https URLs/],
      [{ question: "Q", models: ["claude-cli:claude-opus-5-5", "codex-cli:gpt-9"] }, /Not enabled.*codex-cli:gpt-9/],
      [{ question: "Q", models: ["claude-cli:claude-opus-5-5"] }, /at least two/],
      [{ question: "Q", preset: "flagship" }, /Preset "flagship".*not available/],
      [{ question: "Q", mode: "shouting" }, /mode must be one of conversation, assigned_stances, randomized_stances/],
      [{ question: "Q", rounds: 11 }, /rounds must be between 1 and 10/],
      [{ question: "Q", stances: [{ label: "x" }] }, /stances\[0\]\.instruction is required/],
      [{ question: "Q", colour: "blue" }, /colour is not a known field/],
      [{ question: "Q", summaryModelId: "claude-cli:nope" }, /summaryModelId claude-cli:nope is not enabled/],
    ];
    for (const [args, pattern] of cases) {
      const { text, isError } = await call(client, "debate", args);
      assert.equal(isError, true, JSON.stringify(args).slice(0, 80));
      assert.match(text, pattern);
    }
    const missing = await call(client, "continue_debate", { id: "20261116-100000-abcdef" });
    assert.equal(missing.isError, true);
    assert.match(missing.text, /No saved debate/);
    assert.deepEqual(starts(panel.claude), [], "no model was called");
    assert.equal(panel.store.list().total, 0);
  });

  it("continue_debate appends to the same debate and list_debates shows it", async () => {
    const panel = makePanel();
    const client = await connect(panel);
    const first = await call(client, "debate", { question: "Should we ship on Friday?", rounds: 1 });
    const id = /Debate id: (\S+)/.exec(first.text)![1];

    const progress: string[] = [];
    const next = await call(
      client,
      "continue_debate",
      { id, followup: "And QUOTE_ME:mondays?", rounds: 1 },
      (p) => progress.push(p.message ?? ""),
    );
    assert.equal(next.isError, false, next.text);
    assert.match(next.text, new RegExp(`Debate id: ${id}`));
    assert.match(next.text, /claude argues \(heard mondays\?\)/);
    assert.equal(progress[0], "Round 2 done (1 of 1).");
    assert.equal(panel.store.load(id)!.turns.length, 5);

    const listed = JSON.parse((await call(client, "list_debates", { limit: 5 })).text);
    assert.equal(listed.total, 1);
    assert.equal(listed.debates[0].id, id);
    assert.equal(listed.debates[0].status, "done");
    assert.equal(listed.debates[0].title, "Should we ship on Friday?");
  });

  it("runs one debate at a time: a second call waits for the first", async () => {
    const panel = makePanel({ claudeScenario: "slow", codexScenario: "slow" });
    const client = await connect(panel);
    const messages: string[] = [];
    const [a, b] = await Promise.all([
      call(client, "debate", { question: "First?", rounds: 1 }, (p) => messages.push(`A ${p.message}`)),
      call(client, "debate", { question: "Second?", rounds: 1 }, (p) => messages.push(`B ${p.message}`)),
    ]);
    const first = panel.store.load(/Debate id: (\S+)/.exec(a.text)![1])!;
    const second = panel.store.load(/Debate id: (\S+)/.exec(b.text)![1])!;
    assert.ok(
      second.createdAt >= first.updatedAt,
      `second started ${second.createdAt} before the first finished ${first.updatedAt}`,
    );
    assert.deepEqual(
      messages.filter((m) => m.includes("Queued")),
      ["B Queued: another debate is running."],
    );
    // Model calls never interleaved: all of the first debate's, then the second's.
    const order = [...panel.claude.log(), ...panel.codex.log()]
      .filter((entry) => entry.event === "start")
      .sort((x, y) => Number(x.time) - Number(y.time))
      .map((entry) => (/First\?/.test(String(entry.stdin) + String(entry.argv)) ? "A" : "B"));
    assert.deepEqual(order, ["A", "A", "A", "B", "B", "B"]);
  });

  it("stops a debate at the overall timeout, saves it as stopped and says so", async () => {
    const panel = makePanel({ claudeScenario: "hang" });
    const client = await connect(panel, { timeoutMs: 400 });
    const { text, isError } = await call(client, "debate", { question: "Q?", rounds: 1 });
    assert.equal(isError, false);
    assert.match(text, /^> Stopped after the 0\.4-second limit; what ran so far is saved/);
    assert.match(text, /status stopped/);
    const record = panel.store.load(/Debate id: (\S+)/.exec(text)![1])!;
    assert.equal(record.status, "stopped");
    assert.equal(record.turns.length, 0);
    assert.equal(record.summary, null);
  });
});

describe("tool schema validation", () => {
  it("accepts a full, valid argument set", () => {
    assert.deepEqual(
      validateAgainstSchema(
        {
          question: "Q",
          context: "c",
          documents: ["https://example.com"],
          preset: "subscriptions",
          models: PANEL,
          mode: "randomized_stances",
          reasoningEffort: "normal",
          rounds: 2,
          iterations: 2,
          stances: [{ label: "A", instruction: "a" }],
          summarize: true,
          summaryModelId: PANEL[0],
          speakerMemory: false,
          promptOverrides: { rebuttal: "x {{messages}}" },
        },
        debateToolInputSchema(),
      ),
      [],
    );
  });
});
