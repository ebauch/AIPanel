import { continueSavedDebate, validateContinueOptions } from "@/lib/debate-runner";
import { getDebateStore, isDebateId, isRunningNow } from "@/lib/debate-store";
import { resolveApiKey } from "@/lib/openrouter";

export const runtime = "nodejs";
export const maxDuration = 800;

type Context = { params: Promise<{ id: string }> };

function encodeSse(event: unknown): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
}

/**
 * Continue a saved debate: { followup?, rounds? }. Streams the same events as
 * /api/debate, then the re-summary's events, over one SSE response.
 */
export async function POST(request: Request, { params }: Context) {
  const { id } = await params;
  const store = getDebateStore();
  const record = isDebateId(id) ? store.load(id) : null;
  if (!record) {
    return Response.json({ error: "Debate not found." }, { status: 404 });
  }
  if (isRunningNow(record)) {
    return Response.json({ error: "This debate is still running." }, { status: 409 });
  }

  let body: { followup?: string; rounds?: number };
  try {
    body = (await request.json()) as { followup?: string; rounds?: number };
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const options = { followup: body.followup, rounds: body.rounds };
  const problem = validateContinueOptions(options);
  if (problem) {
    return Response.json({ error: problem }, { status: 400 });
  }

  const apiKey = resolveApiKey(request);

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (event: unknown) => {
        try {
          controller.enqueue(encodeSse(event));
        } catch {
          // Client went away; the run still finishes or stops via request.signal.
        }
      };
      try {
        await continueSavedDebate(id, options, {
          store,
          apiKey,
          signal: request.signal,
          onEvent: send,
        });
      } catch (err) {
        send({ type: "error", message: err instanceof Error ? err.message : "Unexpected server error" });
      } finally {
        try {
          controller.close();
        } catch {
          // already closed
        }
      }
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
