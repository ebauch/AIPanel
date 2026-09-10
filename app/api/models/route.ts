import { NextResponse } from "next/server";
import { listDebateModels } from "@/lib/models";
import { resolveApiKey } from "@/lib/openrouter";

export const runtime = "nodejs";

export async function GET(request: Request) {
  const apiKey = resolveApiKey(request);
  const result = await listDebateModels(apiKey);

  return NextResponse.json(result);
}
