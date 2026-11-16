// Server-side store for the models enabled in Settings. A JSON file under the
// app's data dir (gitignored), not localStorage, so the picker is the same on
// every device that opens the app.
import fs from "node:fs";
import path from "node:path";
import { CLAUDE_CLI_PROVIDER_ID, CLAUDE_EFFORTS } from "./providers/claude-cli";
import { CODEX_CLI_PROVIDER_ID, CODEX_EFFORTS } from "./providers/codex-cli";
import {
  CLI_MODEL_ID_PATTERN,
  KNOWN_PROVIDER_IDS,
  OPENROUTER_PROVIDER_ID,
  parseModelId,
} from "./providers/model-id";

export interface EnabledModel {
  /** Full id, always prefixed: `claude-cli:claude-opus-5-5`, `openrouter:anthropic/claude-opus-5`. */
  id: string;
  label: string;
  effort?: string;
}

export interface ModelSettings {
  version: 1;
  models: EnabledModel[];
}

export const DEFAULT_MODEL_SETTINGS: ModelSettings = {
  version: 1,
  models: [
    { id: "claude-cli:claude-opus-5-5", label: "Claude Opus 5.5 (Max)" },
    { id: "claude-cli:claude-sonnet-5-5", label: "Claude Sonnet 5.5 (Max)" },
    { id: "claude-cli:claude-fable-5-1", label: "Claude Fable 5.1 (Max)" },
    { id: "codex-cli:gpt-6-astra", label: "GPT-6 Astra (ChatGPT)" },
    { id: "codex-cli:gpt-6.1-sol", label: "GPT-6.1 Sol (ChatGPT)" },
  ],
};

const EFFORTS_BY_PROVIDER: Record<string, readonly string[]> = {
  [CLAUDE_CLI_PROVIDER_ID]: CLAUDE_EFFORTS,
  [CODEX_CLI_PROVIDER_ID]: CODEX_EFFORTS,
  [OPENROUTER_PROVIDER_ID]: [],
};

const OPENROUTER_MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._\-/:]{0,199}$/;
const MAX_MODELS = 100;

/** Validate untrusted input (a PUT body or the file on disk). */
export function validateModelSettings(
  input: unknown,
): { ok: true; value: ModelSettings } | { ok: false; error: string } {
  if (!input || typeof input !== "object" || !Array.isArray((input as { models?: unknown }).models)) {
    return { ok: false, error: "Expected { models: [...] }." };
  }
  const raw = (input as { models: unknown[] }).models;
  if (raw.length > MAX_MODELS) {
    return { ok: false, error: `At most ${MAX_MODELS} models.` };
  }
  const seen = new Set<string>();
  const models: EnabledModel[] = [];
  for (const [index, entry] of raw.entries()) {
    const where = `Model ${index + 1}`;
    if (!entry || typeof entry !== "object") {
      return { ok: false, error: `${where}: not an object.` };
    }
    const { id, label, effort } = entry as Record<string, unknown>;
    if (typeof id !== "string" || !id.includes(":")) {
      return { ok: false, error: `${where}: id must be "provider:model".` };
    }
    const prefix = id.slice(0, id.indexOf(":"));
    if (!(KNOWN_PROVIDER_IDS as readonly string[]).includes(prefix)) {
      return { ok: false, error: `${where}: unknown provider "${prefix}".` };
    }
    const parsed = parseModelId(id);
    const pattern = parsed.providerId === OPENROUTER_PROVIDER_ID ? OPENROUTER_MODEL_ID_PATTERN : CLI_MODEL_ID_PATTERN;
    if (!pattern.test(parsed.model)) {
      return { ok: false, error: `${where}: invalid model id "${parsed.model}".` };
    }
    if (seen.has(id)) {
      return { ok: false, error: `${where}: duplicate id ${id}.` };
    }
    seen.add(id);
    const cleanLabel = typeof label === "string" ? label.trim() : "";
    if (cleanLabel.length > 100) {
      return { ok: false, error: `${where}: label is longer than 100 characters.` };
    }
    let cleanEffort: string | undefined;
    if (effort !== undefined && effort !== null && effort !== "") {
      const allowed = EFFORTS_BY_PROVIDER[parsed.providerId] ?? [];
      if (typeof effort !== "string" || !allowed.includes(effort)) {
        return {
          ok: false,
          error: `${where}: effort must be one of ${allowed.length ? allowed.join(", ") : "(none for this provider)"}.`,
        };
      }
      cleanEffort = effort;
    }
    models.push({ id, label: cleanLabel || parsed.model, ...(cleanEffort ? { effort: cleanEffort } : {}) });
  }
  return { ok: true, value: { version: 1, models } };
}

export function dataDir(): string {
  return process.env.AIPANEL_DATA_DIR?.trim() || path.join(process.cwd(), "data");
}

export function settingsPath(dir = dataDir()): string {
  return path.join(dir, "model-settings.json");
}

/** Missing file = defaults. A corrupt file also falls back, but says so. */
export function loadModelSettings(file = settingsPath()): { settings: ModelSettings; warning?: string } {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return { settings: DEFAULT_MODEL_SETTINGS };
  }
  try {
    const result = validateModelSettings(JSON.parse(text));
    if (result.ok) {
      return { settings: result.value };
    }
    return { settings: DEFAULT_MODEL_SETTINGS, warning: `Ignoring ${file}: ${result.error}` };
  } catch {
    return { settings: DEFAULT_MODEL_SETTINGS, warning: `Ignoring ${file}: not valid JSON.` };
  }
}

/** Write via a temp file + rename so a crash never leaves half a file. */
export function saveModelSettings(settings: ModelSettings, file = settingsPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
}
