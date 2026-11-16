import { NextResponse } from "next/server";
import { getDebateStore, isDebateId, isRunningNow } from "@/lib/debate-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Context = { params: Promise<{ id: string }> };

function notFound() {
  return NextResponse.json({ error: "Debate not found." }, { status: 404 });
}

export async function GET(_request: Request, { params }: Context) {
  const { id } = await params;
  const record = isDebateId(id) ? getDebateStore().load(id) : null;
  return record ? NextResponse.json(record) : notFound();
}

/** Rename: { title }. */
export async function PATCH(request: Request, { params }: Context) {
  const { id } = await params;
  if (!isDebateId(id) || !getDebateStore().load(id)) {
    return notFound();
  }
  let body: { title?: unknown };
  try {
    body = (await request.json()) as { title?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  if (typeof body.title !== "string") {
    return NextResponse.json({ error: "Expected { title }." }, { status: 400 });
  }
  try {
    return NextResponse.json(getDebateStore().rename(id, body.title));
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Rename failed" }, { status: 400 });
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  const { id } = await params;
  const store = getDebateStore();
  const record = isDebateId(id) ? store.load(id) : null;
  if (!record) {
    return notFound();
  }
  if (isRunningNow(record)) {
    return NextResponse.json({ error: "This debate is still running; stop it first." }, { status: 409 });
  }
  store.delete(id);
  return NextResponse.json({ ok: true });
}
