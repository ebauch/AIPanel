// A subscription panel (Opus 5.5 via the fake claude CLI, Astra via the fake
// codex CLI) plus an empty OpenRouter catalog, and a temp debate store.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DebateStore } from "@/lib/debate-store";
import { DEFAULT_MODEL_SETTINGS } from "@/lib/model-settings";
import { createClaudeCliProvider } from "@/lib/providers/claude-cli";
import { createCodexCliProvider } from "@/lib/providers/codex-cli";
import { createOpenRouterProvider } from "@/lib/providers/openrouter";
import { createRegistry } from "@/lib/providers/registry";
import type { DebateModelInfo } from "@/lib/types";
import { makeFakeCli } from "./helpers";

/** A per-token OpenRouter model that the old default summary pick preferred. */
export const PER_TOKEN_FABLE: DebateModelInfo = {
  id: "anthropic/claude-fable-5",
  displayName: "Anthropic: Claude Fable 5",
  available: true,
  recommended: true,
  supportsReasoningEffort: true,
  supportsJsonResponse: false,
  provider: "anthropic",
  contextLength: 200_000,
  pricing: { promptPerMillion: 15, completionPerMillion: 75 },
  created: Math.floor(Date.now() / 1000),
};

export const SUMMARY_JSON = JSON.stringify({
  verdict: "Ship on Monday, not Friday.",
  confidence: "high",
  takeaways: [
    {
      title: "Freeze merges Thursday",
      detail: "Both agreed a freeze avoids surprises.",
      kind: "action",
      supporters: ["Claude Opus 5.5", "GPT-6 Astra"],
      dissenters: [],
    },
    {
      title: "Add a canary",
      detail: "Only Opus wanted it.",
      kind: "action",
      supporters: ["Claude Opus 5.5"],
      dissenters: ["GPT-6 Astra"],
    },
  ],
  disagreements: [
    {
      topic: "Rollback window",
      positions: [
        { model: "Claude Opus 5.5", position: "One hour" },
        { model: "GPT-6 Astra", position: "One day" },
      ],
    },
  ],
});

export function makePanel(options: { claudeScenario?: string; codexScenario?: string } = {}) {
  const claude = makeFakeCli("claude");
  const codex = makeFakeCli("codex");
  const extra = { FAKE_SUMMARY_JSON: SUMMARY_JSON };
  const registry = createRegistry({
    providers: [
      createClaudeCliProvider({ bin: claude.bin, env: claude.env(options.claudeScenario ?? "ok", extra) }),
      createCodexCliProvider({ bin: codex.bin, env: codex.env(options.codexScenario ?? "ok", extra) }),
      createOpenRouterProvider({
        // Listed even without a key, as the real catalog is.
        listDebateModels: async () => ({ models: [PER_TOKEN_FABLE] }),
        streamChatCompletion: async () => {
          throw new Error("OpenRouter must not be called in these tests");
        },
      }),
    ],
    loadSettings: () => DEFAULT_MODEL_SETTINGS,
  });
  const store = new DebateStore(fs.mkdtempSync(path.join(os.tmpdir(), "aipanel-debates-")));
  return { claude, codex, registry, store };
}

export const PANEL = ["claude-cli:claude-opus-5-5", "codex-cli:gpt-6-astra"];

/** A pid that certainly belonged to a process that has exited. */
export function deadPid(): number {
  const result = spawnSync(process.execPath, ["-e", "0"]);
  return result.pid ?? 999_999;
}

export function starts(fake: ReturnType<typeof makeFakeCli>) {
  return fake.log().filter((entry) => entry.event === "start");
}
