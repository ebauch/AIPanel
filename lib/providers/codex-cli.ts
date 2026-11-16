// ChatGPT via the logged-in `codex` CLI, so turns are paid by Erik's ChatGPT
// Pro plan instead of per-token API billing. Argv and JSONL parsing follow the
// reviewed codex bridge in the home-server repo (ops/mcp/codex-bridge).
//
//   codex exec --skip-git-repo-check --ephemeral --json -s read-only -m <id>
//              -c model_reasoning_effort=<e> -c approval_policy="never" -- <prompt>
//
// `codex exec --json` prints JSONL events; the answer is the last
// `item.completed` agent_message, usage comes from `turn.completed`, and
// `turn.failed` / `error` carry failures. It does not stream tokens, so the
// answer arrives as one delta when the turn completes.
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
import type { CliProviderOptions } from "./claude-cli";

export const CODEX_CLI_PROVIDER_ID = "codex-cli";
export const DEFAULT_CODEX_BIN = "/usr/local/bin/codex";
export const CODEX_EFFORTS = ["minimal", "low", "medium", "high", "xhigh"] as const;

export const CODEX_OFFERED_MODELS: OfferedModel[] = [
  { id: "gpt-6-astra", displayName: "GPT-6 Astra" },
  { id: "gpt-6.1-sol", displayName: "GPT-6.1 Sol" },
];

// An API key in the app's environment would switch codex to per-token
// billing instead of the ChatGPT login.
const SCRUBBED_ENV = ["OPENAI_API_KEY", "CODEX_API_KEY"];

// The prompt travels in argv (stdin is ignored: `codex exec` would append it
// to the prompt). macOS caps argv+env at 1 MB, so refuse clearly before that.
export const MAX_CODEX_PROMPT_BYTES = 900_000;

export function codexEffort(req: Pick<StreamRequest, "effort" | "reasoningEffort">): string {
  if (req.effort && (CODEX_EFFORTS as readonly string[]).includes(req.effort)) {
    return req.effort;
  }
  return req.reasoningEffort === "high" ? "high" : "medium";
}

/**
 * The exact argv (after the binary). The prompt goes after `--`, so prompt
 * text can never be read as a flag, and spawn gets no shell.
 */
export function buildCodexArgs(req: StreamRequest): string[] {
  if (!CLI_MODEL_ID_PATTERN.test(req.model)) {
    throw new Error(`Invalid codex model id: ${JSON.stringify(req.model)}`);
  }
  const { system, prompt } = renderForCli(req.messages);
  const fullPrompt = system ? `${system}\n\n---\n\n${prompt}` : prompt;
  const bytes = Buffer.byteLength(fullPrompt, "utf8");
  if (bytes > MAX_CODEX_PROMPT_BYTES) {
    throw new Error(
      `Prompt is too large for the codex CLI (${bytes} bytes, limit ${MAX_CODEX_PROMPT_BYTES}); shorten the documents.`,
    );
  }
  return [
    "exec",
    "--skip-git-repo-check",
    "--ephemeral",
    "--json",
    "-s",
    "read-only",
    "-m",
    req.model,
    "-c",
    `model_reasoning_effort=${codexEffort(req)}`,
    "-c",
    'approval_policy="never"',
    "--",
    fullPrompt,
  ];
}

interface CodexUsage {
  input_tokens?: number;
  cached_input_tokens?: number;
  output_tokens?: number;
}

export function codexUsageToTokenUsage(usage: CodexUsage | undefined): TokenUsage {
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  const cached = num(usage?.cached_input_tokens);
  return {
    promptTokens: num(usage?.input_tokens), // already includes cached input
    completionTokens: num(usage?.output_tokens),
    cost: null,
    cachedTokens: cached || undefined,
    billing: "subscription",
  };
}

export function createCodexParser(bin: string, timeoutMs = CLI_TIMEOUT_MS): CliParser {
  let message: string | undefined;
  let usage: TokenUsage | undefined;
  let failure: string | undefined;
  let events = 0;

  return {
    push(line) {
      let event: Record<string, unknown>;
      try {
        event = JSON.parse(line);
      } catch {
        return []; // codex may print a stray warning line
      }
      if (!event || typeof event !== "object") {
        return [];
      }
      events += 1;
      const item = event.item as { type?: string; text?: string } | undefined;
      if (event.type === "item.completed" && item?.type === "agent_message" && typeof item.text === "string") {
        message = item.text;
      } else if (event.type === "item.completed" && item?.type === "reasoning" && typeof item.text === "string") {
        return [{ type: "reasoning", text: item.text }];
      } else if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
        usage = codexUsageToTokenUsage(event.usage as CodexUsage);
      } else if (event.type === "turn.failed") {
        const error = event.error as { message?: string } | undefined;
        failure = error?.message ?? "turn failed";
      } else if (event.type === "error") {
        failure = typeof event.message === "string" ? event.message : "error";
      }
      return [];
    },
    finish(result: CliRunResult): StreamChunk[] {
      const fail = (headline: string, retryable: boolean): StreamChunk[] => [
        { type: "error", message: withStderr(headline, result.stderr), retryable },
      ];
      if (result.spawnError) {
        return [
          { type: "error", message: `Could not start the codex CLI at ${bin}: ${result.spawnError}`, retryable: false },
        ];
      }
      if (result.timedOut) {
        return fail(`codex CLI timed out after ${formatDuration(timeoutMs)}; its process tree was killed`, false);
      }
      if (result.code !== 0) {
        const why = result.signal ? `killed by ${result.signal}` : `exit ${result.code}`;
        // A reported failure (login, plan limit, unknown model) won't fix itself on retry.
        return fail(`codex exec failed (${why})${failure ? `: ${failure}` : ""}`, !failure);
      }
      if (failure && message === undefined) {
        return fail(`codex reported a failure: ${failure}`, false);
      }
      if (events === 0) {
        return fail("could not parse codex output (no JSON events on stdout)", true);
      }
      if (message === undefined) {
        return fail("codex finished without a final agent message", true);
      }
      return [
        { type: "delta", text: message },
        { type: "usage", usage: usage ?? codexUsageToTokenUsage(undefined) },
      ];
    },
  };
}

/** Interpret `codex login status` (exit 0 = logged in; text names the method). */
export function parseCodexLoginStatus(result: CliRunResult, output: string, bin: string): ProviderStatus {
  if (result.spawnError) {
    return { state: "missing", detail: `could not run ${bin}: ${result.spawnError}` };
  }
  const text = output.trim();
  if (result.code !== 0) {
    return { state: "missing", detail: "codex CLI found but not logged in (run `codex login`)" };
  }
  if (/api key/i.test(text)) {
    return {
      state: "error",
      detail: "codex is logged in with an API key, which bills per token; log in with ChatGPT instead (`codex login`)",
    };
  }
  return { state: "ready", detail: `codex CLI found and logged in${text ? ` (${text.split("\n")[0]})` : ""}` };
}

export function createCodexCliProvider(options: CliProviderOptions = {}): ModelProvider {
  const bin = options.bin ?? process.env.AIPANEL_CODEX_BIN ?? DEFAULT_CODEX_BIN;
  const timeoutMs = options.timeoutMs ?? CLI_TIMEOUT_MS;
  const enqueue = createSerialQueue();
  const env = () => scrubEnv(options.env ?? process.env, SCRUBBED_ENV);

  return {
    id: CODEX_CLI_PROVIDER_ID,
    label: "ChatGPT (Pro subscription, codex CLI)",
    kind: "subscription",
    efforts: CODEX_EFFORTS,

    async isConfigured(): Promise<ProviderStatus> {
      const found = binaryStatus(bin);
      if (!found.ok) {
        return { state: "missing", detail: `codex CLI ${found.detail}` };
      }
      let stdout = "";
      const result = await runCli({
        bin,
        args: ["login", "status"],
        cwd: process.cwd(),
        env: env(),
        timeoutMs: 15_000,
        onLine: (line) => {
          stdout += `${line}\n`;
        },
      });
      return parseCodexLoginStatus(result, `${stdout}${result.stderr}`, bin);
    },

    async listOfferedModels() {
      return CODEX_OFFERED_MODELS;
    },

    async listModels(_ctx, enabled) {
      const available = binaryStatus(bin).ok;
      return {
        models: enabled.map((entry) => subscriptionModelInfo(CODEX_CLI_PROVIDER_ID, entry, available, 400_000)),
      };
    },

    stream(req) {
      let args: string[];
      try {
        args = buildCodexArgs(req);
      } catch (err) {
        return errorStream(err instanceof Error ? err.message : String(err));
      }
      return streamCliRun({
        enqueue,
        tempPrefix: "codex",
        signal: req.signal,
        parser: createCodexParser(bin, timeoutMs),
        run: { bin, args, env: env(), timeoutMs },
      });
    },
  };
}
