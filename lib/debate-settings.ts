// The debate form's settings in one place: the web form's initial values, the
// MCP `debate` tool's JSON schema, and the validation of its arguments are all
// derived from the declarations below, so a setting added to the form
// (DebateConfig) cannot be forgotten by the tool: SETTING_SCHEMAS is typed as
// a total map over DebateConfig's setting keys and stops compiling without it.
import { PROMPT_STAGES, type PromptStageKey } from "./prompt-templates";
import { PRESET_TIERS, PRESET_DESCRIPTIONS, type PresetName } from "./presets";
import { DEFAULT_STANCES } from "./stances";
import {
  DEBATE_MODES,
  REASONING_EFFORTS,
  type DebateConfig,
  type DebateMode,
  type PromptOverrides,
  type ReasoningEffort,
  type Stance,
} from "./types";

/** A small JSON Schema subset: enough for tool input schemas and their validation. */
export interface JsonSchema {
  type: "string" | "integer" | "number" | "boolean" | "array" | "object";
  description?: string;
  enum?: readonly string[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  maxItems?: number;
  items?: JsonSchema;
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: boolean;
  default?: unknown;
}

/** Everything in DebateConfig except the content (brief, documents) and the panel. */
export type DebateSettingKey = Exclude<keyof DebateConfig, "contextBrief" | "documents" | "modelIds">;

export interface DebateSettings {
  mode: DebateMode;
  reasoningEffort: ReasoningEffort;
  rounds: number;
  iterations: number;
  stances: Stance[];
  summarize: boolean;
  /** Empty = the app picks (pickDefaultSummaryModel). */
  summaryModelId?: string;
  speakerMemory: boolean;
  promptOverrides?: PromptOverrides;
}

export const ROUNDS_RANGE = { min: 1, max: 10 } as const;
export const ITERATIONS_RANGE = { min: 1, max: 10 } as const;
export const MAX_QUESTION_CHARS = 20_000;

/** The form's starting values (and the defaults the MCP tool falls back to). */
export const DEFAULT_DEBATE_SETTINGS: DebateSettings = {
  mode: "assigned_stances",
  reasoningEffort: "high",
  rounds: 3,
  iterations: 3,
  stances: DEFAULT_STANCES,
  summarize: true,
  speakerMemory: true,
};

/** The MCP tool's preset when none is given and no models are named. */
export const DEFAULT_TOOL_PRESET: PresetName = "subscriptions";

const MODE_HELP: Record<DebateMode, string> = {
  conversation: "no stances, every model answers honestly",
  assigned_stances: "each model gets the stance at its position in `stances` (cycled)",
  randomized_stances: "stances are shuffled across models for each of `iterations` runs",
};

const promptOverrideProperties = Object.fromEntries(
  (Object.keys(PROMPT_STAGES) as PromptStageKey[]).map((key) => [
    key,
    {
      type: "string",
      maxLength: 20_000,
      description: `${PROMPT_STAGES[key].title}. Template variables: ${
        PROMPT_STAGES[key].vars.map((name) => `{{${name}}}`).join(", ") || "none"
      }.`,
    } satisfies JsonSchema,
  ]),
) as Record<PromptStageKey, JsonSchema>;

export const SETTING_SCHEMAS: { [K in DebateSettingKey]-?: JsonSchema } = {
  mode: {
    type: "string",
    enum: DEBATE_MODES,
    default: DEFAULT_DEBATE_SETTINGS.mode,
    description: `Debate mode. ${DEBATE_MODES.map((mode) => `"${mode}": ${MODE_HELP[mode]}`).join("; ")}.`,
  },
  reasoningEffort: {
    type: "string",
    enum: REASONING_EFFORTS,
    default: DEFAULT_DEBATE_SETTINGS.reasoningEffort,
    description: "Reasoning effort for models that support it (subscription models also have a per-model effort in Settings).",
  },
  rounds: {
    type: "integer",
    minimum: ROUNDS_RANGE.min,
    maximum: ROUNDS_RANGE.max,
    default: DEFAULT_DEBATE_SETTINGS.rounds,
    description: "Rounds per iteration; every model speaks once per round.",
  },
  iterations: {
    type: "integer",
    minimum: ITERATIONS_RANGE.min,
    maximum: ITERATIONS_RANGE.max,
    default: DEFAULT_DEBATE_SETTINGS.iterations,
    description: 'Independent re-runs with reshuffled stances. Only used when mode is "randomized_stances".',
  },
  stances: {
    type: "array",
    maxItems: 10,
    description:
      "Stances (roles) assigned to the models in panel order, cycling when there are fewer stances than models. Needs at least two to take effect; otherwise the default Pro / Against / Balanced set is used.",
    items: {
      type: "object",
      required: ["label", "instruction"],
      additionalProperties: false,
      properties: {
        label: { type: "string", minLength: 1, maxLength: 100, description: "Short label, e.g. Pro." },
        instruction: { type: "string", minLength: 1, maxLength: 5_000, description: "Instruction injected into the model's prompts." },
      },
    },
    default: DEFAULT_DEBATE_SETTINGS.stances,
  },
  summarize: {
    type: "boolean",
    default: DEFAULT_DEBATE_SETTINGS.summarize,
    description: "Produce the verdict / takeaways summary after the debate.",
  },
  summaryModelId: {
    type: "string",
    maxLength: 300,
    description: "Model (provider:modelId) that writes the takeaways. Default: the app's pick (as on the web form).",
  },
  speakerMemory: {
    type: "boolean",
    default: DEFAULT_DEBATE_SETTINGS.speakerMemory,
    description: "Show each model its own earlier turns in its rebuttal prompts.",
  },
  promptOverrides: {
    type: "object",
    additionalProperties: false,
    properties: promptOverrideProperties,
    description: "Replace the built-in prompt templates (same stages as the Settings page).",
  },
};

/** JSON schema of the MCP `debate` tool's input. */
export function debateToolInputSchema(): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["question"],
    properties: {
      question: {
        type: "string",
        minLength: 1,
        maxLength: MAX_QUESTION_CHARS,
        description: "The debatable question or decision.",
      },
      context: {
        type: "string",
        maxLength: 200_000,
        description: "Background the panel should know (added to the brief after the question).",
      },
      documents: {
        type: "array",
        maxItems: 20,
        items: { type: "string", minLength: 1, maxLength: 4_000 },
        description:
          "Local file paths (PDF or text) or http(s) URLs. Text is extracted the same way as on the web form.",
      },
      preset: {
        type: "string",
        enum: PRESET_TIERS,
        description: `Panel preset: ${PRESET_TIERS.map((tier) => `"${tier}" = ${PRESET_DESCRIPTIONS[tier]}`).join("; ")}. Default "${DEFAULT_TOOL_PRESET}". Ignored when models is given.`,
      },
      models: {
        type: "array",
        maxItems: 8,
        items: { type: "string", minLength: 1, maxLength: 300 },
        description:
          "Panel as provider:modelId ids (see list_models), at least two; each must be enabled. Overrides preset.",
      },
      ...SETTING_SCHEMAS,
    },
  };
}

/** Validate a value against the schema subset; returns error messages (empty = valid). */
export function validateAgainstSchema(value: unknown, schema: JsonSchema, at = "input"): string[] {
  const errors: string[] = [];
  switch (schema.type) {
    case "string":
      if (typeof value !== "string") {
        return [`${at} must be a string.`];
      }
      if (schema.enum && !schema.enum.includes(value)) {
        errors.push(`${at} must be one of ${schema.enum.join(", ")}.`);
      }
      if (schema.minLength !== undefined && value.trim().length < schema.minLength) {
        errors.push(`${at} must not be empty.`);
      }
      if (schema.maxLength !== undefined && value.length > schema.maxLength) {
        errors.push(`${at} must be at most ${schema.maxLength.toLocaleString("en-US")} characters.`);
      }
      return errors;
    case "integer":
    case "number":
      if (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
        return [`${at} must be ${schema.type === "integer" ? "an integer" : "a number"}.`];
      }
      if ((schema.minimum !== undefined && value < schema.minimum) || (schema.maximum !== undefined && value > schema.maximum)) {
        errors.push(`${at} must be between ${schema.minimum} and ${schema.maximum}.`);
      }
      return errors;
    case "boolean":
      return typeof value === "boolean" ? [] : [`${at} must be true or false.`];
    case "array":
      if (!Array.isArray(value)) {
        return [`${at} must be an array.`];
      }
      if (schema.maxItems !== undefined && value.length > schema.maxItems) {
        errors.push(`${at} may have at most ${schema.maxItems} entries.`);
      }
      if (schema.items) {
        value.forEach((item, index) => errors.push(...validateAgainstSchema(item, schema.items!, `${at}[${index}]`)));
      }
      return errors;
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return [`${at} must be an object.`];
      }
      const record = value as Record<string, unknown>;
      const properties = schema.properties ?? {};
      for (const key of schema.required ?? []) {
        if (record[key] === undefined) {
          errors.push(`${at}.${key} is required.`);
        }
      }
      for (const [key, entry] of Object.entries(record)) {
        if (entry === undefined) {
          continue;
        }
        const propertySchema = properties[key];
        if (!propertySchema) {
          if (schema.additionalProperties === false) {
            errors.push(`${at}.${key} is not a known field.`);
          }
          continue;
        }
        errors.push(...validateAgainstSchema(entry, propertySchema, at === "input" ? key : `${at}.${key}`));
      }
      return errors;
    }
  }
}

/**
 * Explicit arguments win, then the preset (which only chooses the panel), then
 * the app's defaults. Arguments must already be schema-valid.
 */
export function resolveDebateSettings(args: Partial<Record<DebateSettingKey, unknown>>): DebateSettings {
  const pick = <K extends DebateSettingKey>(key: K): DebateSettings[K] | undefined =>
    args[key] === undefined ? undefined : (args[key] as DebateSettings[K]);
  return {
    mode: pick("mode") ?? DEFAULT_DEBATE_SETTINGS.mode,
    reasoningEffort: pick("reasoningEffort") ?? DEFAULT_DEBATE_SETTINGS.reasoningEffort,
    rounds: pick("rounds") ?? DEFAULT_DEBATE_SETTINGS.rounds,
    iterations: pick("iterations") ?? DEFAULT_DEBATE_SETTINGS.iterations,
    stances: (pick("stances") ?? DEFAULT_DEBATE_SETTINGS.stances).map((stance) => ({ ...stance })),
    summarize: pick("summarize") ?? DEFAULT_DEBATE_SETTINGS.summarize,
    speakerMemory: pick("speakerMemory") ?? DEFAULT_DEBATE_SETTINGS.speakerMemory,
    ...(pick("summaryModelId")?.trim() ? { summaryModelId: pick("summaryModelId")!.trim() } : {}),
    ...(pick("promptOverrides") ? { promptOverrides: pick("promptOverrides") } : {}),
  };
}

/** Settings + content + panel -> the config runDebate takes. */
export function toDebateConfig(options: {
  contextBrief: string;
  documents: DebateConfig["documents"];
  modelIds: string[];
  settings: DebateSettings;
}): DebateConfig {
  const { settings } = options;
  return {
    contextBrief: options.contextBrief,
    documents: options.documents,
    modelIds: options.modelIds,
    mode: settings.mode,
    reasoningEffort: settings.reasoningEffort,
    rounds: settings.rounds,
    iterations: settings.mode === "randomized_stances" ? settings.iterations : 1,
    stances: settings.stances,
    summarize: settings.summarize,
    summaryModelId: settings.summaryModelId,
    speakerMemory: settings.speakerMemory,
    promptOverrides: settings.promptOverrides,
  };
}

/** The settings part of a DebateConfig (what a saved debate keeps). */
export function settingsFromConfig(config: DebateConfig): DebateSettings {
  return {
    mode: config.mode,
    reasoningEffort: config.reasoningEffort,
    rounds: config.rounds,
    iterations: config.iterations,
    stances: config.stances ?? [],
    summarize: config.summarize ?? true,
    speakerMemory: config.speakerMemory ?? true,
    ...(config.summaryModelId ? { summaryModelId: config.summaryModelId } : {}),
    ...(config.promptOverrides && Object.keys(config.promptOverrides).length > 0
      ? { promptOverrides: config.promptOverrides }
      : {}),
  };
}

/** The brief the models see: the question, then any extra context. */
export function buildContextBrief(question: string, context?: string): string {
  const trimmedContext = context?.trim();
  return trimmedContext ? `${question.trim()}\n\n${trimmedContext}` : question.trim();
}
