import { runDebate } from "@/lib/debate";
import { OpenRouterError, resolveApiKey } from "@/lib/openrouter";
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
        for await (const event of runDebate(config, {
          apiKey,
          signal: request.signal,
        })) {
          controller.enqueue(encodeSse(event));
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unexpected server error";
        const retryable = err instanceof OpenRouterError ? err.retryable : false;
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
