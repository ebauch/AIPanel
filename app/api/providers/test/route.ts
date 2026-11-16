import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/openrouter";
import { runProviderTest } from "@/lib/providers/test-call";
import { getRegistry } from "@/lib/providers/registry";

export const runtime = "nodejs";
export const maxDuration = 800;

/** Settings → "test": one tiny call through the provider. */
export async function POST(request: Request) {
  let body: { providerId?: unknown; modelId?: unknown };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.providerId !== "string") {
    return NextResponse.json({ error: "providerId is required" }, { status: 400 });
  }
  const result = await runProviderTest(getRegistry(), {
    providerId: body.providerId,
    modelId: typeof body.modelId === "string" ? body.modelId : undefined,
    ctx: { openRouterApiKey: resolveApiKey(request) },
    signal: request.signal,
  });
  return NextResponse.json(result, { status: result.ok ? 200 : 400 });
}
