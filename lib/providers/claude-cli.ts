// Claude via the logged-in `claude` CLI (Claude Code), so turns are paid by
// Erik's Claude Max subscription instead of per-token API billing.
//
//   claude -p --model <id> --output-format stream-json --verbose
//          --include-partial-messages --tools "" ... (prompt on stdin)
//
// stream-json emits one JSON object per line: `stream_event` lines carry the
// token deltas (with --include-partial-messages), `assistant` lines the whole
// message, and a final `result` line the answer, error flag and usage.
import type { TokenUsage } from "../types";
import {
  CLI_TIMEOUT_MS,
  binaryStatus,
  createSerialQueue,
  errorStream,
  formatDuration,
  renderForCli,
  runCli,
  scrubEnv,
  streamCliRun,
  subscriptionModelInfo,
  withStderr,
  type CliParser,
  type CliRunResult,
} from "./cli-process";
import { CLI_MODEL_ID_PATTERN } from "./model-id";
import type {
  ModelProvider,
  OfferedModel,
  ProviderStatus,
  StreamChunk,
  StreamRequest,
} from "./types";

export const CLAUDE_CLI_PROVIDER_ID = "claude-cli";
export const DEFAULT_CLAUDE_BIN = "/usr/local/bin/claude";
export const CLAUDE_EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;

export const CLAUDE_OFFERED_MODELS: OfferedModel[] = [
  { id: "claude-opus-5-5", displayName: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", displayName: "Claude Sonnet 5.5" },
  { id: "claude-fable-5-1", displayName: "Claude Fable 5.1" },
];

// A key in the app's environment would make `claude -p` bill the API account
// per token instead of using the Max login; CLAUDECODE would make it refuse to
// run when the dev server was started from inside a Claude Code session.
const SCRUBBED_ENV = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDECODE"];

// Long system prompts (documents are part of the system message) go on stdin
// instead of argv: macOS caps the whole argv+env at 1 MB.
export const MAX_SYSTEM_PROMPT_ARG_CHARS = 64_000;
const STDIN_SYSTEM_FALLBACK =
  "You are taking part in a written panel discussion. Follow the instructions at the start of the user's message. Answer in Markdown; do not use tools.";

export function claudeEffort(req: Pick<StreamRequest, "effort" | "reasoningEffort">): string | undefined {
  if (req.effort && (CLAUDE_EFFORTS as readonly string[]).includes(req.effort)) {
    return req.effort;
  }
  return req.reasoningEffort === "high" ? "high" : undefined;
}

/**
 * The exact argv (after the binary) and stdin for one call. Pure, so the
 * tests can pin it. Passed to spawn as an array with no shell.
 *
 * Not --bare: that mode only accepts ANTHROPIC_API_KEY auth, i.e. per-token
 * billing, which is exactly what this provider exists to avoid.
 */
export function buildClaudeArgs(req: StreamRequest): { args: string[]; stdin: string } {
  if (!CLI_MODEL_ID_PATTERN.test(req.model)) {
    throw new Error(`Invalid Claude model id: ${JSON.stringify(req.model)}`);
  }
  const { system, prompt } = renderForCli(req.messages);
  const systemInArgs = system.length <= MAX_SYSTEM_PROMPT_ARG_CHARS;
  const args = [
    "-p",
    "--model",
    req.model,
    "--output-format",
    "stream-json",
    "--verbose",
    "--include-partial-messages",
    // No tools at all: a debater only writes text, and must not touch the
    // machine it runs on.
    "--tools",
    "",
    "--strict-mcp-config",
    "--no-session-persistence",
  ];
  const effort = claudeEffort(req);
  if (effort) {
    args.push("--effort", effort);
  }
  if (system) {
    args.push("--system-prompt", systemInArgs ? system : STDIN_SYSTEM_FALLBACK);
  }
  const stdin = system && !systemInArgs ? `${system}\n\n---\n\n${prompt}` : prompt;
  return { args, stdin };
}

interface ClaudeUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function claudeUsageToTokenUsage(usage: ClaudeUsage | undefined): TokenUsage {
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cacheRead = num(usage?.cache_read_input_tokens);
  const cacheWrite = num(usage?.cache_creation_input_tokens);
  return {
    // Anthropic's input_tokens excludes cache reads/writes; the app's
    // promptTokens (OpenRouter semantics) includes them.
    promptTokens: num(usage?.input_tokens) + cacheRead + cacheWrite,
    completionTokens: num(usage?.output_tokens),
    // total_cost_usd in the result is a notional API price, not what Erik
    // pays: the subscription covers it.
    cost: null,
    cachedTokens: cacheRead || undefined,
    cacheWriteTokens: cacheWrite || undefined,
    billing: "subscription",
  };
}

/** Stateful stream-json parser for one call. */
export function createClaudeParser(bin: string, timeoutMs = CLI_TIMEOUT_MS): CliParser {
  let streamedText = "";
  let sawResult = false;
  let resultError: string | undefined;
  let usage: TokenUsage | undefined;

  return {
    push(line) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return []; // a stray non-JSON line is not fatal
      }
      if (!event || typeof event !== "object") {
        return [];
      }
      const chunks: StreamChunk[] = [];
      if (event.type === "stream_event") {
        const inner = event.event as { type?: string; delta?: { type?: string; text?: string; thinking?: string } };
        if (inner?.type === "content_block_delta") {
          if (inner.delta?.type === "text_delta" && typeof inner.delta.text === "string") {
            streamedText += inner.delta.text;
            chunks.push({ type: "delta", text: inner.delta.text });
          } else if (inner.delta?.type === "thinking_delta" && typeof inner.delta.thinking === "string") {
            chunks.push({ type: "reasoning", text: inner.delta.thinking });
          }
        }
      } else if (event.type === "assistant") {
        // Without partial messages (older CLI) the whole text arrives here.
        const message = event.message as { content?: Array<{ type?: string; text?: string }> };
        const text = (message?.content ?? [])
          .filter((part) => part?.type === "text" && typeof part.text === "string")
          .map((part) => part.text)
          .join("");
        if (text && !streamedText) {
          streamedText = text;
          chunks.push({ type: "delta", text });
        }
      } else if (event.type === "result") {
        sawResult = true;
        const isError = event.is_error === true || (typeof event.subtype === "string" && event.subtype !== "success");
        if (isError) {
          const detail =
            typeof event.result === "string" && event.result.trim()
              ? event.result.trim()
              : Array.isArray(event.errors) && event.errors.length > 0
                ? event.errors.map(String).join("; ")
                : String(event.subtype ?? "error");
          resultError = `Claude CLI reported an error: ${detail}`;
        } else {
          if (typeof event.result === "string" && event.result && !streamedText) {
            streamedText = event.result;
            chunks.push({ type: "delta", text: event.result });
          }
          usage = claudeUsageToTokenUsage(event.usage as ClaudeUsage | undefined);
        }
      }
      return chunks;
    },
    finish(result: CliRunResult) {
      if (result.spawnError) {
        return [
          {
            type: "error",
            message: `Could not start the claude CLI at ${bin}: ${result.spawnError}`,
            retryable: false,
          },
        ];
      }
      if (result.timedOut) {
        return [
          {
            type: "error",
            message: withStderr(
              `claude CLI timed out after ${formatDuration(timeoutMs)}; its process tree was killed`,
              result.stderr,
            ),
            // Ten minutes already went by; retrying would double the wait.
            retryable: false,
          },
        ];
      }
      if (resultError) {
        // Login, usage-limit and refusal errors all land here; retrying won't help.
        return [{ type: "error", message: withStderr(resultError, result.stderr), retryable: false }];
      }
      if (result.code !== 0) {
        const why = result.signal ? `killed by ${result.signal}` : `exit ${result.code}`;
        return [{ type: "error", message: withStderr(`claude CLI failed (${why})`, result.stderr), retryable: true }];
      }
      if (!sawResult) {
        return [
          {
            type: "error",
            message: withStderr("claude CLI finished without a result event", result.stderr),
            retryable: true,
          },
        ];
      }
      return [{ type: "usage", usage: usage ?? claudeUsageToTokenUsage(undefined) }];
    },
  };
}

export interface CliProviderOptions {
  bin?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
}


export function createClaudeCliProvider(options: CliProviderOptions = {}): ModelProvider {
  const bin = options.bin ?? process.env.AIPANEL_CLAUDE_BIN ?? DEFAULT_CLAUDE_BIN;
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const enqueue = createSerialQueue();
  const env = () => scrubEnv(options.env ?? process.env, SCRUBBED_ENV);

  return {
    id: CLAUDE_CLI_PROVIDER_ID,
    label: "Claude (Max subscription, claude CLI)",
    kind: "subscription",
    efforts: CLAUDE_EFFORTS,

    async isConfigured(): Promise<ProviderStatus> {
      const found = binaryStatus(bin);
      if (!found.ok) {
        return { state: "missing", detail: `claude CLI ${found.detail}` };
      }
      // `claude auth status` reads the local login; it does not call a model.
      let stdout = "";
      const result = await runCli({
        bin,
        args: ["auth", "status", "--json"],
        cwd: process.cwd(),
        env: env(),
        timeoutMs: 15_000,
        onLine: (line) => {
          stdout += `${line}\n`;
        },
      });
      return parseClaudeAuthStatus(result, stdout, bin);
    },

    async listOfferedModels() {
      return CLAUDE_OFFERED_MODELS;
    },

    async listModels(_ctx, enabled) {
      const available = binaryStatus(bin).ok;
      return {
        models: enabled.map((entry) => subscriptionModelInfo(CLAUDE_CLI_PROVIDER_ID, entry, available, 200_000)),
      };
    },

    stream(req) {
      let built: { args: string[]; stdin: string };
      try {
        built = buildClaudeArgs(req);
      } catch (err) {
        return errorStream(err instanceof Error ? err.message : String(err));
      }
      const { args, stdin } = built;
      return streamCliRun({
        enqueue,
        tempPrefix: "claude",
        signal: req.signal,
        parser: createClaudeParser(bin, timeoutMs),
        run: { bin, args, env: env(), stdin, timeoutMs },
      });
    },
  };
}

/** Interpret `claude auth status --json`; tolerant of fields we don't know. */
export function parseClaudeAuthStatus(result: CliRunResult, stdout: string, bin: string): ProviderStatus {
  if (result.spawnError) {
    return { state: "missing", detail: `could not run ${bin}: ${result.spawnError}` };
  }
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    parsed = null;
  }
  const loggedIn = parsed && typeof parsed.loggedIn === "boolean" ? parsed.loggedIn : result.code === 0;
  if (!loggedIn) {
    return { state: "missing", detail: "claude CLI found but not logged in (run `claude` and /login)" };
  }
  const extras = ["subscriptionType", "authMethod"]
    .map((key) => (parsed && typeof parsed[key] === "string" ? `${key}: ${parsed[key]}` : null))
    .filter(Boolean)
    .join(", ");
  return { state: "ready", detail: `claude CLI found and logged in${extras ? ` (${extras})` : ""}` };
}
