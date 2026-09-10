import type { UrlFetchResult } from "@/lib/types";

export const runtime = "nodejs";

const FETCH_TIMEOUT_MS = 15_000;
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
const MIN_TEXT_CHARS = 200;
const USER_AGENT = "AI-Panel/1.0 (open source debate tool)";

function jsonError(message: string, status: number): Response {
  return Response.json({ error: message }, { status });
}

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

function validateUrl(rawUrl: string): { url: URL } | { error: string } {
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

  const { url } = validated;

  try {
    const isWikipedia = /(^|\.)wikipedia\.org$/i.test(url.hostname);
    const result = isWikipedia ? await fetchWikipedia(url) : await fetchGeneric(url);
    return Response.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Failed to fetch URL.";
    return jsonError(message, 422);
  }
}
