import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import {
  buildClaudeArgs,
  claudeUsageToTokenUsage,
  createClaudeCliProvider,
  MAX_SYSTEM_PROMPT_ARG_CHARS,
} from "@/lib/providers/claude-cli";
import { isAbortError } from "@/lib/providers/types";
import type { ChatMessage } from "@/lib/types";
import { drain, isAlive, makeFakeCli, waitFor } from "./helpers";

const messages = (user: string, system = "You are a debater."): ChatMessage[] => [
  { role: "system", content: [{ type: "text", text: system }, { type: "text", text: "## Source documents\n(none)" }] },
  { role: "user", content: user },
];

describe("buildClaudeArgs", () => {
  it("builds the print/stream-json argv with no tools and the prompt on stdin", () => {
    const { args, stdin } = buildClaudeArgs({ model: "claude-opus-5-5", messages: messages("Argue for X.") });
    assert.deepEqual(args.slice(0, 14), [
      "-p",
      "--model",
      "claude-opus-5-5",
      "--output-format",
      "stream-json",
      "--verbose",
      "--include-partial-messages",
      "--tools",
      "",
      "--strict-mcp-config",
      "--no-session-persistence",
      "--safe-mode",
      "--system-prompt",
      "You are a debater.\n\n## Source documents\n(none)",
    ]);
    assert.ok(!args.includes("--bare"), "--bare would force API-key (per-token) auth");
    assert.equal(stdin, "Argue for X.");
  });

  it("maps effort: explicit setting wins, else debate 'high', else none", () => {
    const base = { model: "claude-opus-5-5", messages: messages("x") };
    assert.deepEqual(buildClaudeArgs({ ...base, effort: "max" }).args.slice(12, 14), ["--effort", "max"]);
    assert.deepEqual(buildClaudeArgs({ ...base, reasoningEffort: "high" }).args.slice(12, 14), ["--effort", "high"]);
    assert.ok(!buildClaudeArgs({ ...base, reasoningEffort: "normal" }).args.includes("--effort"));
    assert.ok(!buildClaudeArgs({ ...base, effort: "bogus" }).args.includes("bogus"));
  });

  it("moves an oversized system prompt to stdin instead of argv", () => {
    const big = "D".repeat(MAX_SYSTEM_PROMPT_ARG_CHARS + 1);
    const { args, stdin } = buildClaudeArgs({ model: "claude-opus-5-5", messages: messages("Q", big) });
    assert.ok(args.every((arg) => arg.length < MAX_SYSTEM_PROMPT_ARG_CHARS));
    assert.ok(stdin.startsWith(big));
    assert.ok(stdin.endsWith("Q"));
  });

  it("rejects model ids that could be read as flags", () => {
    assert.throws(() => buildClaudeArgs({ model: "--dangerously-skip-permissions", messages: messages("x") }));
    assert.throws(() => buildClaudeArgs({ model: "a b", messages: messages("x") }));
  });
});

describe("claudeUsageToTokenUsage", () => {
  it("counts cache reads/writes as prompt tokens and never reports a $ cost", () => {
    assert.deepEqual(
      claudeUsageToTokenUsage({ input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 }),
      { promptTokens: 130, completionTokens: 5, cost: null, cachedTokens: 100, cacheWriteTokens: 20, billing: "subscription" },
    );
  });
});

describe("claude-cli provider (fake binary)", () => {
  it("streams deltas and reasoning, ends with subscription usage; no shell, scrubbed env, temp cwd", async () => {
    const fake = makeFakeCli("claude");
    const marker = path.join(fake.dir, "pwned");
    const provider = createClaudeCliProvider({
      bin: fake.bin,
      env: fake.env("ok", { ANTHROPIC_API_KEY: "sk-ant-should-not-leak", CLAUDECODE: "1" }),
    });
    const prompt = `REPLY_AS:Opus $(touch ${marker}) \`touch ${marker}\`; touch ${marker}`;
    const chunks = await drain(provider.stream({ model: "claude-opus-5-5", messages: messages(prompt) }, {}));

    const text = chunks.filter((c) => c.type === "delta").map((c) => (c as { text: string }).text).join("");
    assert.equal(text, "Opus argues");
    assert.ok(chunks.filter((c) => c.type === "delta").length >= 2, "text arrives as several deltas");
    assert.deepEqual(chunks.find((c) => c.type === "reasoning"), { type: "reasoning", text: "hmm" });
    const last = chunks.at(-1);
    assert.equal(last?.type, "usage");
    assert.equal(last?.type === "usage" && last.usage.billing, "subscription");
    assert.equal(last?.type === "usage" && last.usage.cost, null);

    const [call] = fake.log();
    assert.equal(call.stdin, prompt, "prompt reaches the CLI verbatim on stdin");
    assert.ok(!fs.existsSync(marker), "nothing was interpreted by a shell");
    assert.equal(call.hasAnthropicKey, false, "an API key in the env would switch to per-token billing");
    assert.equal(call.hasClaudeCode, false);
    assert.match(String(call.cwd), /aipanel-claude-/);
    assert.ok(String(call.cwd).startsWith(fs.realpathSync(os.tmpdir())));
    assert.ok(!fs.existsSync(String(call.cwd)), "temp cwd is removed afterwards");
  });

  it("turns an is_error result (e.g. logged out) into a non-retryable error", async () => {
    const fake = makeFakeCli("claude");
    const provider = createClaudeCliProvider({ bin: fake.bin, env: fake.env("error_result") });
    const chunks = await drain(provider.stream({ model: "claude-opus-5-5", messages: messages("x") }, {}));
    assert.equal(chunks.length, 1);
    const [chunk] = chunks;
    assert.equal(chunk.type, "error");
    assert.match(chunk.type === "error" ? chunk.message : "", /Not logged in/);
    assert.equal(chunk.type === "error" && chunk.retryable, false);
  });

  it("reports a failed exit with a redacted stderr tail, retryable", async () => {
    const fake = makeFakeCli("claude");
    const provider = createClaudeCliProvider({ bin: fake.bin, env: fake.env("exit_fail") });
    const [chunk] = await drain(provider.stream({ model: "claude-opus-5-5", messages: messages("x") }, {}));
    assert.equal(chunk.type, "error");
    if (chunk.type === "error") {
      assert.match(chunk.message, /exit 2/);
      assert.match(chunk.message, /Bearer \[redacted\]/);
      assert.doesNotMatch(chunk.message, /abcdefghijklmnop/);
      assert.equal(chunk.retryable, true);
    }
  });

  it("reports a missing binary as a non-retryable error", async () => {
    const provider = createClaudeCliProvider({ bin: "/nonexistent/claude" });
    const [chunk] = await drain(provider.stream({ model: "claude-opus-5-5", messages: messages("x") }, {}));
    assert.equal(chunk.type, "error");
    assert.match(chunk.type === "error" ? chunk.message : "", /Could not start the claude CLI/);
    assert.equal((await provider.isConfigured({})).state, "missing");
  });

  it("kills the whole process group on timeout", async () => {
    const fake = makeFakeCli("claude");
    // Generous timeout: under load the fake needs time to start and log its
    // grandchild before the timeout fires.
    const provider = createClaudeCliProvider({ bin: fake.bin, env: fake.env("hang"), timeoutMs: 4000 });
    const pending = drain(provider.stream({ model: "claude-opus-5-5", messages: messages("x") }, {}));
    assert.ok(
      await waitFor(() => fake.log().some((entry) => entry.event === "grandchild"), 4000),
      "fake logged its grandchild before the timeout",
    );
    const chunks = await pending;
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, "error");
    assert.match(chunks[0].type === "error" ? chunks[0].message : "", /timed out/);
    const grandchild = Number(fake.log().find((entry) => entry.event === "grandchild")?.grandchild);
    assert.ok(grandchild > 0);
    assert.ok(await waitFor(() => !isAlive(grandchild)), "grandchild in the group was killed too");
  });

  it("kills the process group when the caller aborts mid-stream", async () => {
    const fake = makeFakeCli("claude");
    const provider = createClaudeCliProvider({ bin: fake.bin, env: fake.env("stream_then_hang") });
    const controller = new AbortController();
    const seen: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const chunk of provider.stream(
          { model: "claude-opus-5-5", messages: messages("x"), signal: controller.signal },
          {},
        )) {
          if (chunk.type === "delta") {
            seen.push(chunk.text);
            controller.abort();
          }
        }
      })(),
      (err: unknown) => isAbortError(err),
    );
    assert.deepEqual(seen, ["partial"]);
    const entries = fake.log();
    const grandchild = Number(entries.find((entry) => entry.event === "grandchild")?.grandchild);
    const pid = Number(entries[0].pid);
    assert.ok(await waitFor(() => !isAlive(grandchild) && !isAlive(pid)), "CLI and its children are gone");
  });

  it("runs one call at a time per provider (queue), and drops a queued call that was cancelled", async () => {
    const fake = makeFakeCli("claude");
    const provider = createClaudeCliProvider({ bin: fake.bin, env: fake.env("slow") });
    const cancelled = new AbortController();
    const first = drain(provider.stream({ model: "claude-opus-5-5", messages: messages("REPLY_AS:one") }, {}));
    const second = drain(provider.stream({ model: "claude-opus-5-5", messages: messages("REPLY_AS:two") }, {}));
    const third = assert.rejects(
      drain(
        provider.stream({ model: "claude-opus-5-5", messages: messages("REPLY_AS:three"), signal: cancelled.signal }, {}),
      ),
      (err: unknown) => isAbortError(err),
    );
    cancelled.abort();
    const [a, b] = await Promise.all([first, second]);
    await third;
    assert.equal(a.at(-1)?.type, "usage");
    assert.equal(b.at(-1)?.type, "usage");

    const events = fake.log().map((entry) => `${entry.event}:${entry.pid}`);
    assert.equal(events.length, 4, "the cancelled call never spawned");
    const [s1, e1, s2, e2] = events;
    assert.equal(s1.split(":")[1], e1.split(":")[1], "first call finished before the second started");
    assert.equal(s2.split(":")[1], e2.split(":")[1]);
    assert.ok(s1.startsWith("start") && e1.startsWith("end") && s2.startsWith("start") && e2.startsWith("end"));
  });

  it("exit 0 without a result event fails the turn without a retry", async () => {
    const fake = makeFakeCli("claude");
    const provider = createClaudeCliProvider({ bin: fake.bin, env: fake.env("no_result") });
    const chunks = await drain(provider.stream({ model: "claude-opus-5-5", messages: messages("x") }, {}));
    const last = chunks.at(-1);
    assert.equal(last?.type, "error");
    assert.match(last?.type === "error" ? last.message : "", /without a result event/);
    assert.equal(last?.type === "error" && last.retryable, false);
  });

  it("scrubs the per-token reroute variables too", async () => {
    const fake = makeFakeCli("claude");
    const provider = createClaudeCliProvider({
      bin: fake.bin,
      env: fake.env("ok", { ANTHROPIC_BASE_URL: "https://x", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1" }),
    });
    await drain(provider.stream({ model: "claude-opus-5-5", messages: messages("x") }, {}));
    const [call] = fake.log();
    assert.deepEqual(call.rerouteVars, []);
  });

  it("isConfigured: a console (API-key) login is flagged as per-token, not ready", async () => {
    const fake = makeFakeCli("claude");
    const status = await createClaudeCliProvider({ bin: fake.bin, env: fake.env("console_login") }).isConfigured({});
    assert.equal(status.state, "error");
    assert.match(status.detail, /per token/);
  });

  it("isConfigured: CLI found and logged in / logged out", async () => {
    const fake = makeFakeCli("claude");
    const ok = await createClaudeCliProvider({ bin: fake.bin, env: fake.env("ok") }).isConfigured({});
    assert.equal(ok.state, "ready");
    assert.match(ok.detail, /logged in/);
    const out = await createClaudeCliProvider({ bin: fake.bin, env: fake.env("logged_out") }).isConfigured({});
    assert.equal(out.state, "missing");
  });
});
