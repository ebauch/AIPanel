// Document text extraction shared by the web routes (PDF upload, URL fetch)
// and the MCP debate tool (local paths and URLs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { LabeledDocument, PdfExtractionResult, UrlFetchResult } from "./types";

export const MAX_PDF_SIZE_BYTES = 20 * 1024 * 1024;
const MIN_PDF_TEXT_CHARS = 50;
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
  if (trimmedLength < MIN_PDF_TEXT_CHARS) {
    return "Very little text was extracted. The PDF may be scanned or image-only.";
  }
  if (pageCount > 0 && trimmedLength / pageCount < MIN_CHARS_PER_PAGE) {
    return "Very little text was extracted per page. The PDF may be scanned or image-only.";
  }
  return undefined;
}

/** Extract the text of a PDF; throws on a parse failure. */
export async function extractPdfText(bytes: Uint8Array, filename: string): Promise<PdfExtractionResult> {
  let parser: PDFParse | null = null;
  try {
    parser = new PDFParse({ data: bytes });
    const result = await parser.getText();
    const text = result.text.trim();
    const pageCount = result.total;
    const warning = lowTextWarning(text, pageCount);
    return {
      label: sanitizePdfLabel(filename),
      text,
      pageCount,
      filename,
      ...(warning ? { warning } : {}),
    };
  } finally {
    await parser?.destroy().catch(() => undefined);
  }
}

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MIN_TEXT_CHARS = 200;
const USER_AGENT = "AI-Panel/1.0 (open source debate tool)";

const IPV4_PRIVATE_PATTERNS = [
  /^10\./,
  /^127\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./,
];

function isPrivateOrLocalHostname(hostname: string): boolean {
  const lower = hostname.toLowerCase();

  if (lower === "localhost" || lower.endsWith(".localhost")) {
    return true;
  }
  if (lower.endsWith(".local")) {
    return true;
  }
  if (lower === "::1" || lower === "[::1]") {
    return true;
  }
  if (IPV4_PRIVATE_PATTERNS.some((pattern) => pattern.test(lower))) {
    return true;
  }
  return false;
}

export function validateUrl(rawUrl: string): { url: URL } | { error: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return { error: "Invalid URL." };
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { error: "Only http and https URLs are supported." };
  }

  if (isPrivateOrLocalHostname(url.hostname)) {
    return { error: "URLs pointing to local or private addresses are not allowed." };
  }

  return { url };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&apos;/gi, "'")
    .replace(/&mdash;/gi, "—")
    .replace(/&ndash;/gi, "–")
    .replace(/&rsquo;/gi, "’")
    .replace(/&lsquo;/gi, "‘")
    .replace(/&rdquo;/gi, "”")
    .replace(/&ldquo;/gi, "“")
    .replace(/&hellip;/gi, "…")
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function extractTitle(html: string): string | null {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  if (!match) {
    return null;
  }
  return decodeHtmlEntities(match[1]).replace(/\s+/g, " ").trim() || null;
}

function extractGenericText(html: string): string {
  let cleaned = html;
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, " ");
  cleaned = cleaned.replace(/<(script|style|nav|header|footer|noscript)[^>]*>[\s\S]*?<\/\1>/gi, " ");
  cleaned = cleaned.replace(/<[^>]+>/g, " ");
  cleaned = decodeHtmlEntities(cleaned);
  cleaned = cleaned.replace(/\s+/g, " ").trim();
  return cleaned;
}

async function fetchWithLimits(
  url: string,
  headers: Record<string, string>,
): Promise<{ body: string; contentType: string | null }> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers,
      signal: controller.signal,
      redirect: "follow",
    });

    if (!response.ok) {
      throw new Error(`Fetch failed with status ${response.status}`);
    }

    const contentType = response.headers.get("content-type");

    if (!response.body) {
      const text = await response.text();
      return { body: text, contentType };
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let received = 0;
    let text = "";

    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      if (received > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("Response exceeded the 5 MB size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();

    return { body: text, contentType };
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchWikipedia(url: URL): Promise<UrlFetchResult> {
  const langMatch = url.hostname.match(/^([a-z0-9-]+)\.wikipedia\.org$/i);
  const lang = langMatch ? langMatch[1] : "en";

  const pathMatch = url.pathname.match(/^\/wiki\/(.+)$/);
  if (!pathMatch) {
    throw new Error("Could not parse a Wikipedia article title from the URL.");
  }
  const title = decodeURIComponent(pathMatch[1]);

  const apiUrl = new URL(`https://${lang}.wikipedia.org/w/api.php`);
  apiUrl.searchParams.set("action", "query");
  apiUrl.searchParams.set("prop", "extracts");
  apiUrl.searchParams.set("explaintext", "1");
  apiUrl.searchParams.set("redirects", "1");
  apiUrl.searchParams.set("format", "json");
  apiUrl.searchParams.set("titles", title);

  const { body } = await fetchWithLimits(apiUrl.toString(), {
    "User-Agent": USER_AGENT,
  });

  const data = JSON.parse(body) as {
    query?: {
      pages?: Record<
        string,
        { title?: string; extract?: string; missing?: string }
      >;
    };
  };

  const pages = data.query?.pages ?? {};
  const page = Object.values(pages)[0];

  if (!page || page.missing !== undefined || !page.extract) {
    throw new Error("Wikipedia article not found.");
  }

  const text = page.extract.trim();
  const label = page.title ?? title.replace(/_/g, " ");
  const warning =
    text.length < MIN_TEXT_CHARS
      ? "Very little text was extracted from this page."
      : undefined;

  return { label, text, source: "wikipedia", ...(warning ? { warning } : {}) };
}

async function fetchGeneric(url: URL): Promise<UrlFetchResult> {
  const { body } = await fetchWithLimits(url.toString(), {
    "User-Agent": USER_AGENT,
  });

  const title = extractTitle(body);
  const text = extractGenericText(body);
  const label = title ?? url.hostname;
  const warning =
    text.length < MIN_TEXT_CHARS
      ? "Very little text was extracted from this page."
      : undefined;

  return { label, text, source: "web", ...(warning ? { warning } : {}) };
}

/** Fetch a public http(s) URL and extract its readable text (Wikipedia via its API). */
export async function fetchUrlText(rawUrl: string): Promise<UrlFetchResult> {
  const validated = validateUrl(rawUrl);
  if ("error" in validated) {
    throw new Error(validated.error);
  }
  const { url } = validated;
  const isWikipedia = /(^|\.)wikipedia\.org$/i.test(url.hostname);
  return isWikipedia ? fetchWikipedia(url) : fetchGeneric(url);
}

const URL_SCHEME_PATTERN = /^[a-z][a-z0-9+.-]*:/i;

function isUrlRef(ref: string): boolean {
  // Anything with a scheme (http:, file:, ...) is a URL; only http(s) passes validateUrl.
  return URL_SCHEME_PATTERN.test(ref);
}

function resolveLocalPath(ref: string, cwd: string): string {
  const expanded = ref === "~" || ref.startsWith("~/") ? path.join(os.homedir(), ref.slice(1)) : ref;
  return path.resolve(cwd, expanded);
}

/**
 * Local documents may only come from under `root` (the home dir by default)
 * and never from a dotfile or dot-directory (.env.local, .ssh, .aws,
 * .claude...): document text is sent to the panel's models, so a prompt-
 * injected session must not be able to ship secrets that way. Symlinks are
 * resolved first. Returns an error message, or null.
 */
function checkLocalPathAllowed(ref: string, file: string, root: string): string | null {
  let real: string;
  let realRoot: string;
  try {
    real = fs.realpathSync(file);
    realRoot = fs.realpathSync(root);
  } catch {
    return `${ref}: does not exist or is not readable.`;
  }
  const relative = path.relative(realRoot, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    return `${ref}: only files under ${root} can be attached.`;
  }
  if (relative.split(path.sep).some((part) => part.startsWith("."))) {
    return `${ref}: hidden files and folders (dotfiles such as .env or .ssh) cannot be attached.`;
  }
  return null;
}

/**
 * Check a document reference (local path or URL) before a debate is queued.
 * Returns an error message, or null when it looks usable.
 */
export function checkDocumentRef(ref: string, cwd = process.cwd(), root = os.homedir()): string | null {
  if (isUrlRef(ref)) {
    const validated = validateUrl(ref);
    return "error" in validated ? `${ref}: ${validated.error}` : null;
  }
  const file = resolveLocalPath(ref, cwd);
  const notAllowed = checkLocalPathAllowed(ref, file, root);
  if (notAllowed) {
    return notAllowed;
  }
  try {
    fs.accessSync(file, fs.constants.R_OK);
    const stat = fs.statSync(file);
    if (!stat.isFile()) {
      return `${ref}: not a file.`;
    }
    if (stat.size > MAX_PDF_SIZE_BYTES) {
      return `${ref}: larger than 20 MB.`;
    }
  } catch {
    return `${ref}: does not exist or is not readable.`;
  }
  return null;
}

/** Load a local file (PDF or text) or a URL as a labeled document. */
export async function loadDocumentRef(
  ref: string,
  cwd = process.cwd(),
  root = os.homedir(),
): Promise<LabeledDocument> {
  if (isUrlRef(ref)) {
    const result = await fetchUrlText(ref);
    return { label: result.label, content: result.text, source: ref };
  }
  const file = resolveLocalPath(ref, cwd);
  const notAllowed = checkLocalPathAllowed(ref, file, root);
  if (notAllowed) {
    throw new Error(notAllowed);
  }
  const bytes = fs.readFileSync(file);
  if (file.toLowerCase().endsWith(".pdf") || bytes.subarray(0, 5).toString("latin1") === "%PDF-") {
    const result = await extractPdfText(new Uint8Array(bytes), path.basename(file));
    return { label: result.label, content: result.text, source: file };
  }
  const text = bytes.toString("utf8");
  if (text.includes("\u0000")) {
    throw new Error(`${ref}: not a text or PDF file.`);
  }
  return { label: path.basename(file), content: text, source: file };
}
