import { NextResponse } from "next/server";
import {
  loadModelSettings,
  saveModelSettings,
  validateModelSettings,
} from "@/lib/model-settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const { settings, warning } = loadModelSettings();
  return NextResponse.json({ ...settings, ...(warning ? { warning } : {}) });
}

export async function PUT(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const result = validateModelSettings(body);
  if (!result.ok) {
    return NextResponse.json({ error: result.error }, { status: 400 });
  }
  try {
    saveModelSettings(result.value);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Could not save settings";
    return NextResponse.json({ error: message }, { status: 500 });
  }
  return NextResponse.json(result.value);
}
