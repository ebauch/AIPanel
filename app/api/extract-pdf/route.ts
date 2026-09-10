import { PDFParse } from "pdf-parse";
import type { PdfExtractionResult } from "@/lib/types";

export const runtime = "nodejs";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024;
const MIN_TEXT_CHARS = 50;
const MIN_CHARS_PER_PAGE = 30;

function sanitizePdfLabel(filename: string): string {
  const base = filename.replace(/\.pdf$/i, "").trim();
  const cleaned = base.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || "Untitled document";
}

function lowTextWarning(text: string, pageCount: number): string | undefined {
  const trimmedLength = text.trim().length;
  if (trimmedLength === 0) {
    return "No text could be extracted. The PDF may be scanned or image-only.";
  }
  if (trimmedLength < MIN_TEXT_CHARS) {
    return "Very little text was extracted. The PDF may be scanned or image-only.";
  }
  if (pageCount > 0 && trimmedLength / pageCount < MIN_CHARS_PER_PAGE) {
    return "Very little text was extracted per page. The PDF may be scanned or image-only.";
  }
  return undefined;
}

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

  if (file.size > MAX_FILE_SIZE_BYTES) {
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
  let parser: PDFParse | null = null;

  try {
    parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    const text = result.text.trim();
    const pageCount = result.total;
    const warning = lowTextWarning(text, pageCount);

    const payload: PdfExtractionResult = {
      label: sanitizePdfLabel(filename),
      text,
      pageCount,
      filename,
      ...(warning ? { warning } : {}),
    };

    return Response.json(payload);
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Failed to extract text from PDF.";
    return jsonError(message, 422);
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}
