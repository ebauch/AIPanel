import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_MODEL_SETTINGS, type ModelSettings } from "@/lib/model-settings";
import { parseModelId, pickerModelId } from "@/lib/providers/model-id";
import { createOpenRouterProvider } from "@/lib/providers/openrouter";
import { createRegistry } from "@/lib/providers/registry";
import { OpenRouterError } from "@/lib/openrouter";
import type { ModelProvider, StreamRequest } from "@/lib/providers/types";
import type { DebateModelInfo } from "@/lib/types";
import { drain } from "./helpers";

function fakeProvider(id: string, calls: StreamRequest[] = []): ModelProvider {
  return {
    id,
    label: id,
    kind: "subscription",
    efforts: ["low", "high"],
    isConfigured: async () => ({ state: "ready", detail: "fake" }),
    listOfferedModels: async () => [{ id: "m1", displayName: "M1" }],
    listModels: async (_ctx, enabled) => ({
      models: enabled.map((entry) => ({
        id: `${id}:${entry.model}`,
        displayName: entry.label,
        available: true,
        recommended: false,
        supportsReasoningEffort: true,
        supportsJsonResponse: false,
        provider: id,
        providerId: id,
        billing: "subscription",
        contextLength: 1,
        pricing: { promptPerMillion: 0, completionPerMillion: 0 },
      })),
    }),
    async *stream(req) {
      calls.push(req);
      yield { type: "delta", text: `${id}/${req.model}` };
    },
  };
}

const catalogModel = (id: string): DebateModelInfo => ({
  id,
  displayName: id,
  available: true,
  recommended: false,
  supportsReasoningEffort: false,
  supportsJsonResponse: false,
  provider: id.split("/")[0],
  contextLength: 1000,
  pricing: { promptPerMillion: 1, completionPerMillion: 2 },
});

describe("model ids", () => {
  it("routes by a known provider prefix; bare and unknown-prefix ids stay OpenRouter", () => {
    assert.deepEqual(parseModelId("claude-cli:claude-opus-5-5"), { providerId: "claude-cli", model: "claude-opus-5-5" });
    assert.deepEqual(parseModelId("codex-cli:gpt-6-astra"), { providerId: "codex-cli", model: "gpt-6-astra" });
    assert.deepEqual(parseModelId("anthropic/claude-opus-5"), { providerId: "openrouter", model: "anthropic/claude-opus-5" });
    assert.deepEqual(parseModelId("openrouter:x/y"), { providerId: "openrouter", model: "x/y" });
    // OpenRouter's own ids can contain colons.
    assert.deepEqual(parseModelId("meta-llama/llama-4:free"), { providerId: "openrouter", model: "meta-llama/llama-4:free" });
    assert.equal(pickerModelId("openrouter", "x/y"), "x/y");
    assert.equal(pickerModelId("claude-cli", "claude-opus-5-5"), "claude-cli:claude-opus-5-5");
  });
});

describe("registry", () => {
  const settings: ModelSettings = {
    version: 1,
    models: [
      { id: "a:m1", label: "A one", effort: "high" },
      { id: "b:m2", label: "B two" },
      { id: "openrouter:x/renamed", label: "Renamed X" },
    ],
  };

  it("streams through the provider named by the id prefix, with the stored effort", async () => {
    const callsA: StreamRequest[] = [];
    const registry = createRegistry({
      providers: [fakeProvider("a", callsA), fakeProvider("b")],
      loadSettings: () => settings,
    });
    const chunks = await drain(registry.stream("a:m1", { messages: [] }, {}));
    assert.deepEqual(chunks, [{ type: "delta", text: "a/m1" }]);
    assert.equal(callsA[0].model, "m1");
    assert.equal(callsA[0].effort, "high");
    assert.deepEqual(await drain(registry.stream("b:m2", { messages: [] }, {})), [{ type: "delta", text: "b/m2" }]);
  });

  it("an unknown provider is an error chunk, not a crash", async () => {
    const registry = createRegistry({ providers: [fakeProvider("a")], loadSettings: () => settings });
    const [chunk] = await drain(registry.stream("x/y", { messages: [] }, {}));
    assert.equal(chunk.type, "error");
  });

  it("lists enabled models per provider in registry order and keeps the full OpenRouter catalog", async () => {
    const openrouter = createOpenRouterProvider({
      listDebateModels: async () => ({ models: [catalogModel("x/renamed"), catalogModel("y/other")] }),
      streamChatCompletion: async () => ({ text: "", usage: null }),
    });
    const registry = createRegistry({
      providers: [fakeProvider("a"), fakeProvider("b"), openrouter],
      loadSettings: () => settings,
    });
    const { models, error } = await registry.listModels({});
    assert.equal(error, undefined);
    assert.deepEqual(
      models.map((model) => [model.id, model.displayName]),
      [
        ["a:m1", "A one"],
        ["b:m2", "B two"],
        ["x/renamed", "Renamed X"],
        ["y/other", "y/other"],
      ],
    );
    assert.deepEqual(registry.providerIdsFor(["a:m1", "x/renamed", "y/other"]), ["a", "openrouter"]);
    const onlyA = await registry.listModels({}, { providerIds: ["a"] });
    assert.deepEqual(onlyA.models.map((model) => model.id), ["a:m1"]);
  });

  it("collects a provider's listing failure as an error without dropping the others", async () => {
    const broken: ModelProvider = { ...fakeProvider("b"), listModels: async () => { throw new Error("nope"); } };
    const registry = createRegistry({ providers: [fakeProvider("a"), broken], loadSettings: () => settings });
    const { models, error } = await registry.listModels({});
    assert.deepEqual(models.map((model) => model.id), ["a:m1"]);
    assert.match(error ?? "", /nope/);
  });

  it("defaults enable the five subscription models", () => {
    assert.deepEqual(
      DEFAULT_MODEL_SETTINGS.models.map((model) => model.id),
      [
        "claude-cli:claude-opus-5-5",
        "claude-cli:claude-sonnet-5-5",
        "claude-cli:claude-fable-5-1",
        "codex-cli:gpt-6-astra",
        "codex-cli:gpt-6.1-sol",
      ],
    );
  });
});

describe("openrouter provider adapter", () => {
  it("maps streamChatCompletion callbacks to chunks with the same retry wording", async () => {
    let seenKey = "";
    const provider = createOpenRouterProvider({
      listDebateModels: async () => ({ models: [] }),
      streamChatCompletion: async (options) => {
        seenKey = options.apiKey;
        assert.equal(options.model, "anthropic/claude-opus-5");
        assert.equal(options.supportsReasoningEffort, true);
        options.onRetry?.({ attempt: 1, maxAttempts: 5, delayMs: 10_000, rateLimited: true, message: "429" });
        options.onReasoning?.("r");
        options.onToken?.("Hel");
        options.onToken?.("lo");
        return { text: "Hello", usage: { promptTokens: 1, completionTokens: 2, cost: 0.5 } };
      },
    });
    const chunks = await drain(
      provider.stream(
        { model: "anthropic/claude-opus-5", messages: [], modelInfo: { ...catalogModel("anthropic/claude-opus-5"), supportsReasoningEffort: true } },
        { openRouterApiKey: "k" },
      ),
    );
    assert.equal(seenKey, "k");
    assert.deepEqual(chunks, [
      { type: "activity", message: "Rate limited by the provider, retrying in 10s (attempt 1 of 5)…" },
      { type: "reasoning", text: "r" },
      { type: "delta", text: "Hel" },
      { type: "delta", text: "lo" },
      { type: "usage", usage: { promptTokens: 1, completionTokens: 2, cost: 0.5 } },
    ]);
  });

  it("keeps OpenRouterError's retryable flag and needs a key", async () => {
    const provider = createOpenRouterProvider({
      listDebateModels: async () => ({ models: [] }),
      streamChatCompletion: async () => {
        throw new OpenRouterError("overloaded", { retryable: true, status: 503 });
      },
    });
    assert.deepEqual(await drain(provider.stream({ model: "x/y", messages: [] }, { openRouterApiKey: "k" })), [
      { type: "error", message: "overloaded", retryable: true },
    ]);
    const [missing] = await drain(provider.stream({ model: "x/y", messages: [] }, {}));
    assert.equal(missing.type, "error");
    assert.match(missing.type === "error" ? missing.message : "", /No OpenRouter API key/);
  });
});
