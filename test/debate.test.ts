import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDebate } from "@/lib/debate";
import { DEFAULT_MODEL_SETTINGS } from "@/lib/model-settings";
import { createClaudeCliProvider } from "@/lib/providers/claude-cli";
import { createCodexCliProvider } from "@/lib/providers/codex-cli";
import { createOpenRouterProvider } from "@/lib/providers/openrouter";
import { createRegistry } from "@/lib/providers/registry";
import { runSummary } from "@/lib/summarize";
import type { DebateConfig, DebateStreamEvent } from "@/lib/types";
import { makeFakeCli } from "./helpers";

function setup() {
  const claude = makeFakeCli("claude");
  const codex = makeFakeCli("codex");
  let openRouterCalls = 0;
  const registry = createRegistry({
    providers: [
      createClaudeCliProvider({ bin: claude.bin, env: claude.env("ok") }),
      createCodexCliProvider({ bin: codex.bin, env: codex.env("ok") }),
      createOpenRouterProvider({
        listDebateModels: async () => {
          openRouterCalls += 1;
          return { models: [] };
        },
        streamChatCompletion: async () => {
          openRouterCalls += 1;
          return { text: "", usage: null };
        },
      }),
    ],
    loadSettings: () => DEFAULT_MODEL_SETTINGS,
  });
  return { claude, codex, registry, openRouterCalls: () => openRouterCalls };
}

const config: DebateConfig = {
  contextBrief: "Should we ship on Friday?",
  documents: [],
  modelIds: ["claude-cli:claude-opus-5-5", "codex-cli:gpt-6-astra"],
  mode: "conversation",
  reasoningEffort: "normal",
  rounds: 2,
  iterations: 1,
  stances: [],
};

async function collect(events: AsyncIterable<DebateStreamEvent>): Promise<DebateStreamEvent[]> {
  const out: DebateStreamEvent[] = [];
  for await (const event of events) {
    out.push(event);
  }
  return out;
}

describe("debate: Opus 5.5 (claude CLI) vs Astra (codex CLI), against fakes", () => {
  it("runs both rounds with no OpenRouter key and no OpenRouter call", async () => {
    const { claude, codex, registry, openRouterCalls } = setup();
    const events = await collect(runDebate(config, { registry }));

    assert.equal(events.find((event) => event.type === "error"), undefined);
    assert.equal(events.at(-1)?.type, "debate_end");
    const start = events.find((event) => event.type === "iteration_start");
    assert.deepEqual(
      start?.type === "iteration_start" && start.assignments.map((a) => a.modelDisplayName),
      ["Claude Opus 5.5 (Max)", "GPT-6 Astra (ChatGPT)"],
    );

    const turns = events.filter((event) => event.type === "turn_end");
    assert.deepEqual(
      turns.map((turn) => turn.type === "turn_end" && [turn.modelId, turn.text, turn.usage?.billing, turn.error]),
      [
        ["claude-cli:claude-opus-5-5", "claude argues", "subscription", undefined],
        ["codex-cli:gpt-6-astra", "codex argues", "subscription", undefined],
        ["claude-cli:claude-opus-5-5", "claude argues", "subscription", undefined],
        ["codex-cli:gpt-6-astra", "codex argues", "subscription", undefined],
      ],
    );
    assert.ok(events.some((event) => event.type === "token" && event.speakerIndex === 0));

    // Routing: each CLI got its own model, and the rebuttal carried the other side's turn.
    const claudeCalls = claude.log().filter((entry) => entry.event === "start");
    const codexCalls = codex.log().filter((entry) => entry.event === "start");
    assert.equal(claudeCalls.length, 2);
    assert.equal(codexCalls.length, 2);
    assert.ok((claudeCalls[0].argv as string[]).includes("claude-opus-5-5"));
    assert.ok((codexCalls[0].argv as string[]).includes("gpt-6-astra"));
    assert.match((codexCalls[1].argv as string[]).at(-1) ?? "", /claude argues/);
    assert.match(String(claudeCalls[1].stdin), /codex argues/);
    assert.equal(openRouterCalls(), 0);
  });

  it("still requires an OpenRouter key when an OpenRouter model is on the panel", async () => {
    const { registry } = setup();
    const events = await collect(
      runDebate({ ...config, modelIds: ["claude-cli:claude-opus-5-5", "anthropic/claude-opus-5"] }, { registry }),
    );
    assert.deepEqual(events, [
      {
        type: "error",
        message: "No OpenRouter API key. Add one on the Settings page or set OPENROUTER_API_KEY in .env.local.",
      },
    ]);
  });

  it("a CLI failure that cannot be retried ends the debate with its message", async () => {
    const claude = makeFakeCli("claude");
    const codex = makeFakeCli("codex");
    const registry = createRegistry({
      providers: [
        createClaudeCliProvider({ bin: claude.bin, env: claude.env("ok") }),
        createCodexCliProvider({ bin: codex.bin, env: codex.env("failed") }),
      ],
      loadSettings: () => DEFAULT_MODEL_SETTINGS,
    });
    const events = await collect(runDebate(config, { registry }));
    const last = events.at(-1);
    assert.equal(last?.type, "error");
    assert.match(last?.type === "error" ? last.message : "", /usage limit reached/);
  });

  it("summarizes through a subscription model", async () => {
    const { registry } = setup();
    const events = await collect(
      runSummary(
        {
          contextBrief: "b",
          documents: [],
          transcript: [
            { iteration: 1, round: 1, speakerIndex: 0, modelId: "x", modelDisplayName: "X", stance: null, text: "t" },
          ],
          modelId: "claude-cli:claude-fable-5-1",
          reasoningEffort: "normal",
          panel: [{ modelDisplayName: "X", stance: null }],
        },
        { registry },
      ),
    );
    assert.deepEqual(events[0], {
      type: "summary_start",
      modelId: "claude-cli:claude-fable-5-1",
      modelDisplayName: "Claude Fable 5.1 (Max)",
    });
    const end = events.at(-1);
    assert.equal(end?.type, "summary_end");
    assert.equal(end?.type === "summary_end" && end.text, "claude argues");
    assert.equal(end?.type === "summary_end" && end.usage?.billing, "subscription");
  });
});
