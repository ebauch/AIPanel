import { NextResponse } from "next/server";
import { getDebateStore } from "@/lib/debate-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const PAGE_SIZE = 50;

/** Saved debates, newest first: ?offset=N for "load more". */
export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const offset = Math.max(0, Number.parseInt(params.get("offset") ?? "0", 10) || 0);
  const limit = Math.min(PAGE_SIZE, Math.max(1, Number.parseInt(params.get("limit") ?? `${PAGE_SIZE}`, 10) || PAGE_SIZE));
  const { debates, total } = getDebateStore().list({ limit, offset });
  const next = offset + debates.length;
  return NextResponse.json({ debates, total, nextOffset: next < total ? next : null });
}
