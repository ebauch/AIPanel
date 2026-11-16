// The I/O half shared by the subscription CLI providers (claude, codex):
// spawn with no shell, stream stdout line by line, and take the whole process
// group down on timeout or cancel. Approach copied from the home-server
// repo's reviewed codex bridge (ops/mcp/codex-bridge/src/run-codex.js).
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { AsyncQueue } from "../async-queue";
import type { ChatMessage, DebateModelInfo } from "../types";
import { abortError, type EnabledModelEntry, type StreamChunk } from "./types";

export const CLI_TIMEOUT_MS = 10 * 60 * 1000;
const KILL_GRACE_MS = 3_000;
const STDERR_KEEP_BYTES = 64 * 1024;

export interface CliRunResult {
  code: number | null;
  signal: NodeJS.Signals | null;
  stderr: string;
  timedOut: boolean;
  aborted: boolean;
  spawnError?: string;
  durationMs: number;
}

export interface CliRunOptions {
  bin: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Written to stdin then closed; undefined = stdin ignored. */
  stdin?: string;
  timeoutMs: number;
  signal?: AbortSignal;
  onLine: (line: string) => void;
}

// Process groups in flight, so a dev server that exits does not leave a CLI
// agent running unattended on Erik's subscription.
const live = new Set<number>();

function killGroup(pid: number | undefined, sig: NodeJS.Signals): void {
  if (!pid) {
    return;
  }
  try {
    process.kill(-pid, sig); // negative pid = the whole process group
  } catch {
    // already gone
  }
}

let exitHookInstalled = false;
function installExitHook(): void {
  if (exitHookInstalled) {
    return;
  }
  exitHookInstalled = true;
  process.on("exit", () => {
    for (const pid of live) {
      killGroup(pid, "SIGKILL");
    }
  });
}

/**
 * Run `bin args...` once. Resolves (never rejects). detached:true gives the
 * child its own process group so a timeout/cancel can signal the group: the
 * CLIs spawn helpers of their own, and killing only the top pid would orphan
 * them.
 */
export function runCli(options: CliRunOptions): Promise<CliRunResult> {
  installExitHook();
  return new Promise((resolve) => {
    const started = Date.now();
    let stderr = "";
    let stdoutBuffer = "";
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let hardTimer: NodeJS.Timeout | undefined;
    let child: ReturnType<typeof spawn> | undefined;

    const stop = () => {
      killGroup(child?.pid, "SIGTERM");
      hardTimer = setTimeout(() => killGroup(child?.pid, "SIGKILL"), KILL_GRACE_MS);
    };
    const onAbort = () => {
      aborted = true;
      stop();
    };
    const finish = (extra: Partial<CliRunResult>) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      clearTimeout(hardTimer);
      options.signal?.removeEventListener("abort", onAbort);
      if (child?.pid) {
        live.delete(child.pid);
      }
      if (stdoutBuffer.trim()) {
        options.onLine(stdoutBuffer);
        stdoutBuffer = "";
      }
      resolve({
        code: null,
        signal: null,
        stderr,
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        ...extra,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      stop();
    }, options.timeoutMs);

    if (options.signal?.aborted) {
      aborted = true;
      finish({});
      return;
    }

    try {
      child = spawn(options.bin, options.args, {
        cwd: options.cwd,
        env: options.env,
        stdio: [options.stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        detached: true,
        shell: false,
      });
    } catch (err) {
      finish({ spawnError: errorCode(err) });
      return;
    }

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (child.pid) {
      live.add(child.pid);
    }

    child.stdout!.setEncoding("utf8");
    child.stderr!.setEncoding("utf8");
    child.stdout!.on("data", (data: string) => {
      stdoutBuffer += data;
      const lines = stdoutBuffer.split("\n");
      stdoutBuffer = lines.pop() ?? "";
      for (const line of lines) {
        if (line.trim()) {
          options.onLine(line);
        }
      }
    });
    child.stderr!.on("data", (data: string) => {
      stderr += data;
      if (stderr.length > STDERR_KEEP_BYTES) {
        stderr = stderr.slice(-STDERR_KEEP_BYTES);
      }
    });
    if (options.stdin !== undefined && child.stdin) {
      // A CLI that exits before reading stdin gives EPIPE; the exit code
      // tells the real story, so the write error is ignored.
      child.stdin.on("error", () => {});
      child.stdin.end(options.stdin);
    }
    child.on("error", (err) => finish({ spawnError: errorCode(err) }));
    child.on("close", (code, sig) => {
      // The CLI itself is gone; sweep any stragglers left in its group.
      if (timedOut || aborted) {
        killGroup(child?.pid, "SIGKILL");
      }
      finish({ code, signal: sig });
    });
  });
}

function errorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err && typeof err.code === "string") {
    return err.code;
  }
  return err instanceof Error ? err.message : String(err);
}

/** Run async jobs strictly one after another; a failed job does not stall the queue. */
export function createSerialQueue(): <T>(job: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(job: () => Promise<T>) => {
    const result = tail.then(job);
    tail = result.catch(() => {});
    return result;
  };
}

/** An empty scratch dir per call, so the CLI never sees (or reads) the app's files. */
export function makeTempCwd(prefix: string): { dir: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aipanel-${prefix}-`));
  return {
    dir,
    cleanup: () => {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // best effort
      }
    },
  };
}

/** Copy of `base` without the named variables. */
export function scrubEnv(
  base: NodeJS.ProcessEnv,
  drop: readonly string[],
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of drop) {
    delete env[key];
  }
  return env;
}

export function binaryStatus(bin: string): { ok: boolean; detail: string } {
  try {
    fs.accessSync(bin, fs.constants.X_OK);
    return { ok: true, detail: `found at ${bin}` };
  } catch {
    return { ok: false, detail: `not found or not executable at ${bin}` };
  }
}

export function contentText(content: ChatMessage["content"]): string {
  if (typeof content === "string") {
    return content;
  }
  return content.map((part) => part.text).join("\n\n");
}

/**
 * Flatten chat messages for a CLI that takes one prompt: system messages
 * joined, and the rest as the prompt. A lone user message is passed as is;
 * a multi-turn history gets role headings so the model can follow it.
 */
export function renderForCli(messages: ChatMessage[]): {
  system: string;
  prompt: string;
} {
  const system = messages
    .filter((message) => message.role === "system")
    .map((message) => contentText(message.content).trim())
    .filter(Boolean)
    .join("\n\n");
  const rest = messages.filter((message) => message.role !== "system");
  const prompt =
    rest.length === 1 && rest[0].role === "user"
      ? contentText(rest[0].content).trim()
      : rest
          .map(
            (message) =>
              `## ${message.role === "user" ? "User" : "Assistant"}\n${contentText(message.content).trim()}`,
          )
          .join("\n\n");
  return { system, prompt };
}

export const STDERR_TAIL_LINES = 20;

export function tailLines(text: string, n = STDERR_TAIL_LINES): string {
  return String(text ?? "")
    .replace(/\s+$/, "")
    .split("\n")
    .slice(-n)
    .join("\n");
}

// Never echo credentials into the UI. The CLIs should not print them, but a
// debug log or an HTTP error dump could. Same patterns as the codex bridge.
const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/gi, "$1 [redacted]"],
  [/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g, "[redacted-jwt]"],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, "[redacted-key]"],
  [
    /("?(?:access_token|refresh_token|id_token|api_key|OPENAI_API_KEY|ANTHROPIC_API_KEY)"?\s*[:=]\s*"?)[^"\s,}]+/gi,
    "$1[redacted]",
  ],
];

export function redactSecrets(text: string): string {
  let out = String(text ?? "");
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

/** "headline — stderr: <last lines>" with secrets scrubbed. */
export function withStderr(headline: string, stderr: string): string {
  const tail = tailLines(stderr);
  return redactSecrets(tail ? `${headline} — stderr: ${tail}` : headline);
}

/** Turns CLI stdout lines (and the final exit) into stream chunks. */
export interface CliParser {
  push(line: string): StreamChunk[];
  finish(result: CliRunResult): StreamChunk[];
}

/**
 * Run one CLI call through the provider's serial queue and expose it as a
 * chunk stream. Cancelling (signal abort, or the consumer stopping early)
 * kills the process group; a call still waiting in the queue is dropped
 * without ever spawning.
 */
export async function* streamCliRun(params: {
  enqueue: <T>(job: () => Promise<T>) => Promise<T>;
  tempPrefix: string;
  signal?: AbortSignal;
  parser: CliParser;
  run: Omit<CliRunOptions, "cwd" | "signal" | "onLine">;
}): AsyncGenerator<StreamChunk> {
  if (params.signal?.aborted) {
    throw abortError();
  }
  const queue = new AsyncQueue<StreamChunk>();
  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    queue.fail(abortError());
  };
  params.signal?.addEventListener("abort", onAbort, { once: true });

  void params
    .enqueue(async () => {
      if (controller.signal.aborted) {
        return;
      }
      const temp = makeTempCwd(params.tempPrefix);
      try {
        const result = await runCli({
          ...params.run,
          cwd: temp.dir,
          signal: controller.signal,
          onLine: (line) => {
            for (const chunk of params.parser.push(line)) {
              queue.push(chunk);
            }
          },
        });
        if (!result.aborted) {
          for (const chunk of params.parser.finish(result)) {
            queue.push(chunk);
          }
        }
      } finally {
        temp.cleanup();
      }
    })
    .then(
      () => queue.close(),
      (err) => queue.fail(err),
    );

  try {
    while (true) {
      const next = await queue.next();
      if (next.done) {
        break;
      }
      yield next.value;
      if (next.value.type === "error") {
        break;
      }
    }
    if (params.signal?.aborted) {
      throw abortError();
    }
  } finally {
    // Consumer stopped early (or we are done): make sure nothing keeps running.
    controller.abort();
    params.signal?.removeEventListener("abort", onAbort);
  }
}

export function formatDuration(ms: number): string {
  return ms >= 60_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)}s`;
}

/** Picker entry for a model served by a subscription CLI: no $ pricing. */
export function subscriptionModelInfo(
  providerId: string,
  entry: EnabledModelEntry,
  available: boolean,
  contextLength: number,
): DebateModelInfo {
  return {
    id: `${providerId}:${entry.model}`,
    displayName: entry.label,
    available,
    recommended: false,
    supportsReasoningEffort: true,
    supportsJsonResponse: false,
    provider: providerId,
    providerId,
    billing: "subscription",
    effort: entry.effort,
    contextLength,
    pricing: { promptPerMillion: 0, completionPerMillion: 0 },
  };
}

/** A stream that fails before spawning anything (bad model id, oversized prompt). */
export async function* errorStream(message: string): AsyncGenerator<StreamChunk> {
  yield { type: "error", message, retryable: false };
}
