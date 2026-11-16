import { fetchUrlText, validateUrl } from "@/lib/extract";

export const runtime = "nodejs";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let body: { url?: string };

  try {
    body = (await request.json()) as { url?: string };
  } catch {
    return jsonError("Invalid JSON body.", 400);
  }

  if (!body.url || typeof body.url !== "string") {
    return jsonError("Missing url.", 400);
  }

  const validated = validateUrl(body.url);
  if ("error" in validated) {
    return jsonError(validated.error, 400);
  }

  try {
    return Response.json(await fetchUrlText(validated.url.toString()));
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch URL.";
    return jsonError(message, 422);
  }
}
