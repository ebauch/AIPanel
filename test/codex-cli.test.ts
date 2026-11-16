import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildCodexArgs,
  codexUsageToTokenUsage,
  createCodexCliProvider,
  MAX_CODEX_PROMPT_BYTES,
} from "@/lib/providers/codex-cli";
import type { ChatMessage } from "@/lib/types";
import { drain, isAlive, makeFakeCli, waitFor } from "./helpers";

const messages = (user: string): ChatMessage[] => [
  { role: "system", content: "You are a debater." },
  { role: "user", content: user },
];

describe("buildCodexArgs", () => {
  it("builds the exec argv with the prompt after --", () => {
    assert.deepEqual(buildCodexArgs({ model: "gpt-6-astra", messages: messages("Argue for X.") }), [
      "exec",
      "--skip-git-repo-check",
      "--ephemeral",
      "--json",
      "--ignore-user-config",
      "--ignore-rules",
      "-s",
      "read-only",
      "-m",
      "gpt-6-astra",
      "-c",
      "model_reasoning_effort=medium",
      "-c",
      'approval_policy="never"',
      "--",
      "You are a debater.\n\n---\n\nArgue for X.",
    ]);
  });

  it("maps effort: explicit setting wins, else debate 'high', else medium", () => {
    const base = { model: "gpt-6-astra", messages: messages("x") };
    assert.ok(buildCodexArgs({ ...base, effort: "xhigh" }).includes("model_reasoning_effort=xhigh"));
    assert.ok(buildCodexArgs({ ...base, reasoningEffort: "high" }).includes("model_reasoning_effort=high"));
    assert.ok(buildCodexArgs({ ...base, effort: "high; rm" }).includes("model_reasoning_effort=medium"));
  });

  it("rejects flag-like model ids and prompts too large for argv", () => {
    assert.throws(() => buildCodexArgs({ model: "-c", messages: messages("x") }));
    assert.throws(
      () => buildCodexArgs({ model: "gpt-6-astra", messages: messages("x".repeat(MAX_CODEX_PROMPT_BYTES + 1)) }),
      /too large/,
    );
  });
});

describe("codexUsageToTokenUsage", () => {
  it("maps turn.completed usage and marks it as subscription", () => {
    assert.deepEqual(codexUsageToTokenUsage({ input_tokens: 300, cached_input_tokens: 200, output_tokens: 40 }), {
      promptTokens: 300,
      completionTokens: 40,
      cost: null,
      cachedTokens: 200,
      billing: "subscription",
    });
  });
});

describe("codex-cli provider (fake binary)", () => {
  it("returns the last agent message plus usage; stdin ignored, no shell, scrubbed env", async () => {
    const fake = makeFakeCli("codex");
    const marker = path.join(fake.dir, "pwned");
    const provider = createCodexCliProvider({
      bin: fake.bin,
      env: fake.env("ok", { OPENAI_API_KEY: "sk-should-not-leak", OPENAI_BASE_URL: "https://x" }),
    });
    const prompt = `REPLY_AS:Astra $(touch ${marker}); touch ${marker}`;
    const chunks = await drain(provider.stream({ model: "gpt-6-astra", messages: messages(prompt) }, {}));
    assert.deepEqual(
      chunks.map((chunk) => chunk.type),
      ["reasoning", "delta", "usage"],
    );
    assert.equal(chunks[1].type === "delta" && chunks[1].text, "Astra argues");
    assert.equal(chunks[2].type === "usage" && chunks[2].usage.billing, "subscription");

    const [call] = fake.log();
    assert.equal((call.argv as string[]).at(-1), `You are a debater.\n\n---\n\n${prompt}`);
    assert.equal(call.stdin, "", "stdin is ignored (codex would append it to the prompt)");
    assert.equal(call.hasOpenAIKey, false);
    assert.deepEqual(call.rerouteVars, []);
    assert.match(String(call.cwd), /aipanel-codex-/);
    assert.ok(!fs.existsSync(marker));
  });

  it("turns turn.failed into a non-retryable error", async () => {
    const fake = makeFakeCli("codex");
    const provider = createCodexCliProvider({ bin: fake.bin, env: fake.env("failed") });
    const chunks = await drain(provider.stream({ model: "gpt-6-astra", messages: messages("x") }, {}));
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, "error");
    if (chunks[0].type === "error") {
      assert.match(chunks[0].message, /usage limit reached/);
      assert.equal(chunks[0].retryable, false);
    }
  });

  it("exit 0 with no JSON on stdout fails the turn without a retry", async () => {
    const fake = makeFakeCli("codex");
    const provider = createCodexCliProvider({ bin: fake.bin, env: fake.env("no_json") });
    const [chunk] = await drain(provider.stream({ model: "gpt-6-astra", messages: messages("x") }, {}));
    assert.equal(chunk.type, "error");
    assert.match(chunk.type === "error" ? chunk.message : "", /no JSON events/);
    assert.equal(chunk.type === "error" && chunk.retryable, false);
  });

  it("an invalid model id fails without spawning", async () => {
    const fake = makeFakeCli("codex");
    const provider = createCodexCliProvider({ bin: fake.bin, env: fake.env("ok") });
    const chunks = await drain(provider.stream({ model: "--yolo", messages: messages("x") }, {}));
    assert.equal(chunks[0].type, "error");
    assert.equal(fake.log().length, 0);
  });

  it("kills the whole process group on timeout", async () => {
    const fake = makeFakeCli("codex");
    const provider = createCodexCliProvider({ bin: fake.bin, env: fake.env("hang"), timeoutMs: 4000 });
    const pending = drain(provider.stream({ model: "gpt-6-astra", messages: messages("x") }, {}));
    assert.ok(
      await waitFor(() => fake.log().some((entry) => entry.event === "grandchild"), 4000),
      "fake logged its grandchild before the timeout",
    );
    const chunks = await pending;
    assert.equal(chunks[0].type, "error");
    assert.match(chunks[0].type === "error" ? chunks[0].message : "", /timed out after 4s/);
    const grandchild = Number(fake.log().find((entry) => entry.event === "grandchild")?.grandchild);
    assert.ok(grandchild > 0);
    assert.ok(await waitFor(() => !isAlive(grandchild)));
  });

  it("serializes concurrent calls", async () => {
    const fake = makeFakeCli("codex");
    const provider = createCodexCliProvider({ bin: fake.bin, env: fake.env("slow") });
    await Promise.all([
      drain(provider.stream({ model: "gpt-6-astra", messages: messages("a") }, {})),
      drain(provider.stream({ model: "gpt-6-astra", messages: messages("b") }, {})),
    ]);
    assert.deepEqual(
      fake.log().map((entry) => entry.event),
      ["start", "end", "start", "end"],
    );
  });

  it("isConfigured: ChatGPT login ready, API-key login flagged, logged out missing", async () => {
    const fake = makeFakeCli("codex");
    const status = (scenario: string) =>
      createCodexCliProvider({ bin: fake.bin, env: fake.env(scenario) }).isConfigured({});
    assert.equal((await status("ok")).state, "ready");
    const apiKey = await status("login_apikey");
    assert.equal(apiKey.state, "error");
    assert.match(apiKey.detail, /per token/);
    assert.equal((await status("logged_out")).state, "missing");
  });
});
