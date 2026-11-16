// Stand-in for the real `claude` / `codex` CLIs in tests: no model is ever
// called. FAKE_CLI picks which one to imitate, FAKE_SCENARIO what it does,
// and every invocation appends a JSON line to FAKE_LOG so tests can assert
// argv, stdin, cwd and environment.
import { spawn } from "node:child_process";
import fs from "node:fs";

const cli = process.env.FAKE_CLI;
const scenario = process.env.FAKE_SCENARIO ?? "ok";
const argv = process.argv.slice(2);

function log(extra) {
  if (!process.env.FAKE_LOG) return;
  fs.appendFileSync(
    process.env.FAKE_LOG,
    `${JSON.stringify({
      cli,
      argv,
      cwd: process.cwd(),
      pid: process.pid,
      hasAnthropicKey: "ANTHROPIC_API_KEY" in process.env,
      hasClaudeCode: "CLAUDECODE" in process.env,
      hasOpenAIKey: "OPENAI_API_KEY" in process.env,
      rerouteVars: [
        "ANTHROPIC_BASE_URL",
        "CLAUDE_CODE_USE_BEDROCK",
        "CLAUDE_CODE_USE_VERTEX",
        "CLAUDE_CODE_USE_FOUNDRY",
        "OPENAI_BASE_URL",
      ].filter((key) => key in process.env),
      time: Date.now(),
      ...extra,
    })}\n`,
  );
}

function readStdin() {
  try {
    return fs.readFileSync(0, "utf8");
  } catch {
    return "";
  }
}

const out = (event) => process.stdout.write(`${JSON.stringify(event)}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function spawnGrandchild() {
  // Same process group as us, so killing the group must take it down too.
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  return child.pid;
}

async function hang() {
  await new Promise(() => setInterval(() => {}, 1000));
}

// A reply that proves which prompt the fake saw.
function replyFor(prompt) {
  // The takeaways prompt asks for JSON: answer with a canned summary if given.
  if (process.env.FAKE_SUMMARY_JSON && prompt.includes("## Output format")) {
    return process.env.FAKE_SUMMARY_JSON;
  }
  const match = /REPLY_AS:(\S+)/.exec(prompt);
  const name = match ? match[1] : cli;
  const quoted = /QUOTE_ME:(\S+)/.exec(prompt);
  return `${name} argues${quoted ? ` (heard ${quoted[1]})` : ""}`;
}

async function claude() {
  if (argv[0] === "auth") {
    if (scenario === "logged_out") {
      out({ loggedIn: false });
      process.exit(1);
    }
    if (scenario === "console_login") {
      out({ loggedIn: true, authMethod: "console", apiProvider: "firstParty" });
      return;
    }
    out({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
    return;
  }
  if (scenario === "hang" || scenario === "stream_then_hang") {
    // Spawn and log the grandchild first thing, so tests can wait for it.
    log({ grandchild: spawnGrandchild(), event: "grandchild" });
  }
  const stdin = readStdin();
  const sysIndex = argv.indexOf("--system-prompt");
  const system = sysIndex >= 0 ? argv[sysIndex + 1] : "";
  log({ stdin, event: "start" });

  if (scenario === "error_result") {
    out({ type: "system", subtype: "init" });
    out({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" });
    process.exit(1);
  }
  if (scenario === "exit_fail") {
    process.stderr.write("boom: upstream said Bearer abcdefghijklmnopqrstuv\n");
    process.exit(2);
  }
  if (scenario === "no_result") {
    out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "half" } } });
    return;
  }
  if (scenario === "hang" || scenario === "stream_then_hang") {
    if (scenario === "stream_then_hang") {
      out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: "partial" } } });
    }
    await hang();
  }
  if (scenario === "slow") {
    await sleep(150);
  }
  const text = replyFor(`${system}\n${stdin}`);
  const half = Math.ceil(text.length / 2);
  out({ type: "system", subtype: "init", model: argv[argv.indexOf("--model") + 1] });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "thinking_delta", thinking: "hmm" } } });
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(0, half) } } });
  process.stdout.write("not json, ignore me\n");
  out({ type: "stream_event", event: { type: "content_block_delta", delta: { type: "text_delta", text: text.slice(half) } } });
  out({ type: "assistant", message: { content: [{ type: "text", text }] } });
  out({
    type: "result",
    subtype: "success",
    is_error: false,
    result: text,
    total_cost_usd: 1.23,
    usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
  });
  log({ event: "end" });
}

async function codex() {
  if (argv[0] === "login") {
    if (scenario === "logged_out") {
      process.stderr.write("Not logged in\n");
      process.exit(1);
    }
    if (scenario === "login_apikey") {
      process.stderr.write("Logged in using an API key - sk-proj-***\n");
      return;
    }
    process.stderr.write("Logged in using ChatGPT\n");
    return;
  }
  if (scenario === "hang") {
    log({ grandchild: spawnGrandchild(), event: "grandchild" });
  }
  log({ stdin: readStdin(), event: "start" });
  const prompt = argv[argv.length - 1];
  if (scenario === "failed") {
    out({ type: "thread.started", thread_id: "t1" });
    out({ type: "turn.failed", error: { message: "usage limit reached" } });
    process.exit(1);
  }
  if (scenario === "no_json") {
    process.stdout.write("this is not the JSON you are looking for\n");
    return;
  }
  if (scenario === "hang") {
    await hang();
  }
  if (scenario === "slow") {
    await sleep(150);
  }
  out({ type: "thread.started", thread_id: "t1" });
  out({ type: "item.completed", item: { id: "i0", type: "reasoning", text: "thinking about it" } });
  out({ type: "item.completed", item: { id: "i1", type: "agent_message", text: "draft" } });
  out({ type: "item.completed", item: { id: "i2", type: "agent_message", text: replyFor(prompt) } });
  out({ type: "turn.completed", usage: { input_tokens: 300, cached_input_tokens: 200, output_tokens: 40 } });
  log({ event: "end" });
}

await (cli === "codex" ? codex() : claude());
