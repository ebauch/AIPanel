import { extractPdfText, MAX_PDF_SIZE_BYTES } from "@/lib/extract";

export const runtime = "nodejs";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

export async function POST(request: Request) {
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError("Invalid form data.", 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return jsonError("Missing PDF file.", 400);
  }

  if (file.size === 0) {
    return jsonError("The uploaded file is empty.", 400);
  }

  if (file.size > MAX_PDF_SIZE_BYTES) {
    return jsonError("PDF must be 20 MB or smaller.", 413);
  }

  const mimeType = file.type.toLowerCase();
  const filename = file.name || "document.pdf";
  if (
    mimeType &&
    mimeType !== "application/pdf" &&
    !filename.toLowerCase().endsWith(".pdf")
  ) {
    return jsonError("Only PDF files are supported.", 400);
  }

  const bytes = new Uint8Array(await file.arrayBuffer());

  try {
    return Response.json(await extractPdfText(bytes, filename));
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to extract text from PDF.";
    return jsonError(message, 422);
  }
}
