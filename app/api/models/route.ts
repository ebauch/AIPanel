import { NextResponse } from "next/server";
import { resolveApiKey } from "@/lib/openrouter";
import { getRegistry } from "@/lib/providers/registry";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const apiKey = resolveApiKey(request);
  // Enabled subscription models first (grouped by provider), then the
  // OpenRouter catalog exactly as before.
  const result = await getRegistry().listModels({ openRouterApiKey: apiKey });

  return NextResponse.json(result);
}
