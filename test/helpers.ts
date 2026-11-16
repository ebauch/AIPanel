import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { StreamChunk } from "@/lib/providers/types";

const FAKE_CLI = path.join(__dirname, "fixtures", "fake-cli.mjs");

export interface FakeCli {
  bin: string;
  logFile: string;
  dir: string;
  env(scenario?: string, extra?: Record<string, string>): NodeJS.ProcessEnv;
  log(): Array<Record<string, unknown>>;
}

/**
 * A fake `claude` / `codex` binary: a tiny sh wrapper (so the provider spawns
 * an executable path, exactly like the real CLI) around fixtures/fake-cli.mjs.
 */
export function makeFakeCli(kind: "claude" | "codex"): FakeCli {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `aipanel-test-${kind}-`));
  const bin = path.join(dir, kind);
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CLI}" "$@"\n`, { mode: 0o755 });
  const logFile = path.join(dir, "calls.jsonl");
  return {
    bin,
    logFile,
    dir,
    env: (scenario = "ok", extra = {}) => ({
      NODE_ENV: "test",
      PATH: process.env.PATH,
      HOME: process.env.HOME,
      FAKE_CLI: kind,
      FAKE_SCENARIO: scenario,
      FAKE_LOG: logFile,
      ...extra,
    }),
    log: () =>
      fs.existsSync(logFile)
        ? fs
            .readFileSync(logFile, "utf8")
            .split("\n")
            .filter(Boolean)
            .map((line) => JSON.parse(line) as Record<string, unknown>)
        : [],
  };
}

export async function drain(chunks: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const chunk of chunks) {
    out.push(chunk);
  }
  return out;
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export async function waitFor(check: () => boolean, timeoutMs = 3000): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (check()) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return check();
}
