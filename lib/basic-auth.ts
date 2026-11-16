import crypto from "node:crypto";
import fs from "node:fs/promises";

/**
 * HTTP Basic Auth for every AIPanel route, with the SAME credentials as the
 * home-studio dashboard (admin-dashboard/src/lib/basicAuth.js). The dashboard
 * stores `{ user, salt, hash }` under the `auth` key of its gitignored
 * config/local.json; AIPANEL_AUTH_FILE points at that file, so one password
 * (rotated with the dashboard's set-password script) unlocks both apps.
 *
 * Verification must stay byte-compatible with the dashboard:
 * scrypt(password, Buffer(salt-hex), 64 bytes) compared to the hex hash with
 * timingSafeEqual. `crypto` is used through the module object (not named
 * imports) so the test can confirm the constant-time compare is what decides.
 */

export const REALM = "home studio";
const HASH_LEN = 64; // must match admin-dashboard/src/lib/basicAuth.js

export interface Credentials {
  user: string;
  salt: string;
  hash: string;
}

export type AuthDecision =
  | { ok: true }
  | { ok: false; status: 401; message: string; log?: string };

export function hashPassword(password: string, saltHex: string): Promise<string> {
  // Async scrypt: it runs on the libuv pool instead of blocking the server's
  // event loop for every request (the dashboard is low-traffic and uses Sync).
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, Buffer.from(saltHex, "hex"), HASH_LEN, (err, key) =>
      err ? reject(err) : resolve(key.toString("hex")),
    );
  });
}

/** Test/setup helper; same shape the dashboard's makeCredentials returns. */
export async function makeCredentials(user: string, password: string): Promise<Credentials> {
  const salt = crypto.randomBytes(16).toString("hex");
  return { user, salt, hash: await hashPassword(password, salt) };
}

function safeEqualHex(aHex: string, bHex: string): boolean {
  const a = Buffer.from(aHex, "hex");
  const b = Buffer.from(bHex, "hex");
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function parseBasicAuth(header: string | null): { user: string; pass: string } | null {
  if (!header || !header.startsWith("Basic ")) return null;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
  const i = decoded.indexOf(":");
  if (i < 0) return null;
  return { user: decoded.slice(0, i), pass: decoded.slice(i + 1) };
}

export async function verifyBasicAuth(header: string | null, creds: Credentials): Promise<boolean> {
  const parsed = parseBasicAuth(header);
  if (!parsed) return false;
  // Always run the scrypt so user-mismatch and password-mismatch take the
  // same time (no username probing) — same as the dashboard.
  const candidate = await hashPassword(parsed.pass, creds.salt);
  const userOk = parsed.user === creds.user;
  const passOk = safeEqualHex(candidate, creds.hash);
  return userOk && passOk;
}

function isCredentials(v: unknown): v is Credentials {
  const c = v as Partial<Credentials> | null;
  return (
    !!c &&
    typeof c.user === "string" && c.user !== "" &&
    typeof c.salt === "string" && c.salt !== "" &&
    typeof c.hash === "string" && c.hash !== ""
  );
}

// Read once, re-read when the file's mtime/size changes (password rotation on
// the dashboard takes effect here without a restart). One stat per request.
let cache: { path: string; mtimeMs: number; size: number; creds: Credentials | null } | null = null;

/**
 * Credentials from the JSON file: the dashboard's `{ auth: {...} }` layout,
 * or a bare `{ user, salt, hash }`. Returns null if missing/unreadable/
 * incomplete — the caller then refuses everything (fail closed).
 */
export async function loadCredentials(filePath: string): Promise<Credentials | null> {
  let stat;
  try {
    stat = await fs.stat(filePath);
  } catch {
    cache = null;
    return null;
  }
  if (cache && cache.path === filePath && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
    return cache.creds;
  }
  let creds: Credentials | null = null;
  try {
    const json = JSON.parse(await fs.readFile(filePath, "utf8"));
    const candidate = json && typeof json === "object" && "auth" in json ? json.auth : json;
    creds = isCredentials(candidate) ? { user: candidate.user, salt: candidate.salt, hash: candidate.hash } : null;
  } catch {
    creds = null;
  }
  cache = { path: filePath, mtimeMs: stat.mtimeMs, size: stat.size, creds };
  return creds;
}

// Last Authorization header that passed scrypt, tied to the credentials
// object it was checked against (a reload makes a new object, dropping it).
// Stored as a SHA-256 digest and compared with timingSafeEqual, so repeat
// requests from a logged-in browser skip the ~50 ms scrypt without a
// timing-leaky string compare.
let verified: { creds: Credentials; digest: Buffer } | null = null;
const digestOf = (header: string) => crypto.createHash("sha256").update(header).digest();

function isMemoised(header: string | null, creds: Credentials): boolean {
  if (!header || !verified || verified.creds !== creds) return false;
  return crypto.timingSafeEqual(digestOf(header), verified.digest);
}

let warnedDisabled = false;

/**
 * The whole decision for one request. `env` carries AIPANEL_AUTH_FILE and
 * AIPANEL_AUTH_DISABLED. Never fails open by accident:
 * - file set → login required (AIPANEL_AUTH_DISABLED is ignored);
 * - file unset → every request refused, whoever sends it. Next.js keeps a
 *   client-sent X-Forwarded-For, so "is this localhost?" can't be answered
 *   safely here; the only way out is the explicit dev flag below.
 * - file unset + AIPANEL_AUTH_DISABLED=1 → open (dev on the Mac; `npm run dev`
 *   binds 127.0.0.1), with a loud warning on the first request.
 */
export async function authorize(
  headers: Headers,
  env: Record<string, string | undefined>,
  path = "",
): Promise<AuthDecision> {
  const authFile = env.AIPANEL_AUTH_FILE;
  if (!authFile) {
    if (env.AIPANEL_AUTH_DISABLED === "1") {
      if (!warnedDisabled) {
        warnedDisabled = true;
        console.warn(
          "[auth] WARNING: AIPANEL_AUTH_DISABLED=1 and AIPANEL_AUTH_FILE unset: AI Panel is serving WITHOUT a login. Dev only.",
        );
      }
      return { ok: true };
    }
    return {
      ok: false,
      status: 401,
      message: "Login not configured: set AIPANEL_AUTH_FILE.",
      log: `[auth] refused ${path || "request"}: AIPANEL_AUTH_FILE is unset; set it to the dashboard's config/local.json (or AIPANEL_AUTH_DISABLED=1 for local dev)`,
    };
  }
  const creds = await loadCredentials(authFile);
  if (!creds) {
    return {
      ok: false,
      status: 401,
      message: "Login not configured: credentials file missing or invalid.",
      log: `[auth] refused ${path || "request"}: AIPANEL_AUTH_FILE has no usable { user, salt, hash }`,
    };
  }
  const header = headers.get("authorization");
  if (isMemoised(header, creds)) return { ok: true };
  if (await verifyBasicAuth(header, creds)) {
    verified = { creds, digest: digestOf(header as string) };
    return { ok: true };
  }
  return { ok: false, status: 401, message: header ? "Invalid credentials" : "Authentication required" };
}

/** Tests only: forget the memoised login and the one-time warning. */
export function resetAuthState(): void {
  verified = null;
  warnedDisabled = false;
  cache = null;
}

export function wwwAuthenticate(): string {
  return `Basic realm="${REALM}", charset="UTF-8"`;
}
