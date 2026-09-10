const STORAGE_KEY = "ai-panel.openrouter-key";

export function readApiKey(): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = localStorage.getItem(STORAGE_KEY);
  return value && value.trim().length > 0 ? value : null;
}

export function writeApiKey(key: string): void {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.setItem(STORAGE_KEY, key.trim());
}

export function clearApiKey(): void {
  if (typeof window === "undefined") {
    return;
  }
  localStorage.removeItem(STORAGE_KEY);
}

/** Extra headers to attach to API requests so the server can forward the
 * caller's own OpenRouter key instead of the shared server-side one. */
export function apiHeaders(): Record<string, string> {
  const key = readApiKey();
  return key ? { "x-openrouter-key": key } : {};
}
