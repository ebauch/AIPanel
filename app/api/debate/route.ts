import { runDebate } from "@/lib/debate";
import { recordDebate } from "@/lib/debate-runner";
import { settingsFromConfig } from "@/lib/debate-settings";
import { getDebateStore } from "@/lib/debate-store";
import { OpenRouterError, resolveApiKey } from "@/lib/openrouter";
import { ProviderError } from "@/lib/providers/types";
import type { DebateConfig } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800;

function encodeSse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  let config: DebateConfig;

  try {
    config = (await request.json()) as DebateConfig;
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  const apiKey = resolveApiKey(request);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const store = getDebateStore();
        // Saved server-side as it runs (created once the debate starts), so
        // it can be reopened and continued from Recent debates.
        const events = recordDebate(store, runDebate(config, { apiKey, signal: request.signal }), {
          create: () =>
            store.create({
              source: "web",
              question: config.contextBrief,
              documents: config.documents ?? [],
              modelIds: config.modelIds,
              settings: settingsFromConfig(config),
            }),
        });
        for await (const event of events) {
          controller.enqueue(encodeSse(event));
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unexpected server error";
        const retryable =
          err instanceof OpenRouterError || err instanceof ProviderError
            ? err.retryable
            : false;
        controller.enqueue(encodeSse({ type: "error", message, retryable }));
      } finally {
        controller.close();
      }
    },
    cancel() {
      // Client disconnected; upstream abort is wired through request.signal.
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
