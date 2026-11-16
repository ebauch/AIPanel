import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { formatSpend } from "@/lib/cost";
import {
  DEFAULT_MODEL_SETTINGS,
  loadModelSettings,
  saveModelSettings,
  validateModelSettings,
} from "@/lib/model-settings";
import { buildPresets, detectPreset, SUBSCRIPTION_PRESET } from "@/lib/presets";
import type { DebateModelInfo } from "@/lib/types";

describe("model settings validation", () => {
  it("accepts provider-prefixed ids, defaults the label, keeps a valid effort", () => {
    const result = validateModelSettings({
      models: [
        { id: "claude-cli:claude-opus-5-5", label: " Opus ", effort: "max" },
        { id: "codex-cli:gpt-6-astra", label: "" },
        { id: "openrouter:meta-llama/llama-4:free", label: "Llama" },
      ],
    });
    assert.deepEqual(result, {
      ok: true,
      value: {
        version: 1,
        models: [
          { id: "claude-cli:claude-opus-5-5", label: "Opus", effort: "max" },
          { id: "codex-cli:gpt-6-astra", label: "gpt-6-astra" },
          { id: "openrouter:meta-llama/llama-4:free", label: "Llama" },
        ],
      },
    });
  });

  for (const [name, models, pattern] of [
    ["unknown provider", [{ id: "bogus:x", label: "x" }], /unknown provider/],
    ["missing prefix", [{ id: "anthropic/claude", label: "x" }], /provider:model/],
    ["flag-like CLI model", [{ id: "claude-cli:--bare", label: "x" }], /invalid model id/],
    ["effort not valid for the provider", [{ id: "codex-cli:gpt-6-astra", label: "x", effort: "max" }], /effort must be one of/],
    ["effort on OpenRouter", [{ id: "openrouter:x/y", label: "x", effort: "high" }], /none for this provider/],
    ["duplicate", [{ id: "codex-cli:a", label: "a" }, { id: "codex-cli:a", label: "b" }], /duplicate/],
  ] as const) {
    it(`rejects ${name}`, () => {
      const result = validateModelSettings({ models });
      assert.equal(result.ok, false);
      assert.match(result.ok ? "" : result.error, pattern);
    });
  }

  it("rejects a body without a models array", () => {
    assert.equal(validateModelSettings({}).ok, false);
    assert.equal(validateModelSettings(null).ok, false);
  });
});

describe("model settings file", () => {
  it("defaults when missing, round-trips through save, and falls back with a warning when corrupt", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aipanel-settings-"));
    const file = path.join(dir, "nested", "model-settings.json");
    assert.deepEqual(loadModelSettings(file), { settings: DEFAULT_MODEL_SETTINGS });

    const settings = { version: 1 as const, models: [{ id: "codex-cli:gpt-6-astra", label: "Astra" }] };
    saveModelSettings(settings, file);
    assert.deepEqual(loadModelSettings(file), { settings });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ["model-settings.json"], "no temp file left behind");

    fs.writeFileSync(file, "{not json");
    const corrupt = loadModelSettings(file);
    assert.deepEqual(corrupt.settings, DEFAULT_MODEL_SETTINGS);
    assert.match(corrupt.warning ?? "", /not valid JSON/);
  });
});

const model = (id: string, extra: Partial<DebateModelInfo> = {}): DebateModelInfo => ({
  id,
  displayName: id,
  available: true,
  recommended: false,
  supportsReasoningEffort: true,
  supportsJsonResponse: false,
  provider: id.includes(":") ? id.split(":")[0] : id.split("/")[0],
  contextLength: 1,
  pricing: { promptPerMillion: 0, completionPerMillion: 0 },
  ...extra,
});

describe("Opus 5.5 vs Astra preset", () => {
  const subscriptionModels = [
    model("claude-cli:claude-opus-5-5", { billing: "subscription" }),
    model("codex-cli:gpt-6-astra", { billing: "subscription" }),
  ];

  it("is offered only when both subscription models are enabled and available", () => {
    assert.deepEqual(buildPresets(subscriptionModels).subscriptions, [...SUBSCRIPTION_PRESET.ids]);
    assert.deepEqual(buildPresets(subscriptionModels.slice(0, 1)).subscriptions, []);
    assert.deepEqual(
      buildPresets([subscriptionModels[0], { ...subscriptionModels[1], available: false }]).subscriptions,
      [],
    );
  });

  it("is detected from the selection, and subscription models never leak into the price tiers", () => {
    const presets = buildPresets(subscriptionModels);
    assert.equal(detectPreset(["codex-cli:gpt-6-astra", "claude-cli:claude-opus-5-5"], presets), "subscriptions");
    assert.deepEqual([presets.flagship, presets.balanced, presets.budget], [[], [], []]);
  });
});

describe("formatSpend", () => {
  it("counts subscription calls instead of showing $0.00", () => {
    assert.equal(formatSpend(1.5, 0), "$1.50");
    assert.equal(formatSpend(0, 3), "3 subscription calls");
    assert.equal(formatSpend(0.2, 1), "$0.20 + 1 subscription call");
  });
});
