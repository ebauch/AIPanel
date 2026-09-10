import { resolveApiKey } from "@/lib/openrouter";
import { runSummary } from "@/lib/summarize";
import type { SummarizeRequest } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 800;

function encodeSse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

export async function POST(request: Request) {
  let body: SummarizeRequest;

  try {
    body = (await request.json()) as SummarizeRequest;
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
        for await (const event of runSummary(body, {
          apiKey,
          signal: request.signal,
        })) {
          controller.enqueue(encodeSse(event));
        }
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Unexpected server error";
        controller.enqueue(encodeSse({ type: "summary_error", message }));
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
