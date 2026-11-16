// Settings → "test" button: the smallest real call a provider can make, to
// prove the key / CLI login works end to end.
import { pickerModelId } from "./model-id";
import type { ProviderRegistry } from "./registry";
import { collectStream, isAbortError, type ProviderContext } from "./types";

export interface ProviderTestResult {
  ok: boolean;
  providerId: string;
  model?: string;
  reply?: string;
  error?: string;
  durationMs: number;
}

export const TEST_PROMPT = "Reply with exactly the word OK and nothing else.";

export async function runProviderTest(
  registry: ProviderRegistry,
  options: { providerId: string; modelId?: string; ctx: ProviderContext; signal?: AbortSignal },
): Promise<ProviderTestResult> {
  const started = Date.now();
  const done = (rest: Omit<ProviderTestResult, "providerId" | "durationMs">): ProviderTestResult => ({
    providerId: options.providerId,
    durationMs: Date.now() - started,
    ...rest,
  });
  const provider = registry.get(options.providerId);
  if (!provider) {
    return done({ ok: false, error: `Unknown provider ${options.providerId}.` });
  }

  // Explicit model, else the first enabled one, else the first the provider offers.
  let model: string | undefined =
    options.modelId?.trim() || registry.enabledFor(provider.id)[0]?.model;
  if (!model) {
    try {
      model = (await provider.listOfferedModels(options.ctx))[0]?.id;
    } catch {
      model = undefined;
    }
  }
  if (!model) {
    return done({ ok: false, error: "No model to test with; add one under Models first." });
  }

  try {
    const { text } = await collectStream(
      registry.stream(
        pickerModelId(provider.id, model),
        { messages: [{ role: "user", content: TEST_PROMPT }], signal: options.signal },
        options.ctx,
      ),
    );
    return done({ ok: true, model, reply: text.trim().slice(0, 200) });
  } catch (err) {
    if (isAbortError(err)) {
      return done({ ok: false, model, error: "Cancelled." });
    }
    return done({ ok: false, model, error: err instanceof Error ? err.message : String(err) });
  }
}
