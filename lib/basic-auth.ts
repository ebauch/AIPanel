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

function isLoopbackAddress(addr: string): boolean {
  const a = addr.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return a === "::1" || /^127\.\d+\.\d+\.\d+$/.test(a) || /^::ffff:127\.\d+\.\d+\.\d+$/.test(a);
}

function isLoopbackHost(host: string | null): boolean {
  if (!host) return false;
  const name = host.trim().toLowerCase().replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return name === "localhost" || isLoopbackAddress(name);
}

/**
 * Is this request from the Mac itself? Next.js fills `x-forwarded-for` from
 * the socket's remote address when the client didn't send one; the proxy has
 * no other view of the peer. Every hop must be loopback, AND the Host must be
 * a loopback name: a LAN browser hitting home.local:PORT, or a DNS-rebinding
 * page, carries a non-loopback Host. A client that forges BOTH headers is not
 * stopped by this — the real guard on the LAN is AIPANEL_AUTH_FILE.
 */
export function isLocalRequest(headers: Headers): boolean {
  const xff = headers.get("x-forwarded-for");
  if (!xff) return false;
  const hops = xff.split(",").filter((h) => h.trim() !== "");
  return hops.length > 0 && hops.every(isLoopbackAddress) && isLoopbackHost(headers.get("host"));
}

/**
 * The whole decision for one request. `authFile` is AIPANEL_AUTH_FILE.
 * Never fails open: unset → loopback only; set but unusable → refuse all.
 */
export async function authorize(headers: Headers, authFile: string | undefined, path = ""): Promise<AuthDecision> {
  if (!authFile) {
    if (isLocalRequest(headers)) return { ok: true };
    return {
      ok: false,
      status: 401,
      message: "Login not configured: AIPANEL_AUTH_FILE is unset, so only localhost may use AI Panel.",
      log: `[auth] refused ${path || "request"} from ${headers.get("x-forwarded-for") ?? "unknown"}: AIPANEL_AUTH_FILE unset, non-localhost`,
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
  if (await verifyBasicAuth(header, creds)) return { ok: true };
  return { ok: false, status: 401, message: header ? "Invalid credentials" : "Authentication required" };
}

export function wwwAuthenticate(): string {
  return `Basic realm="${REALM}", charset="UTF-8"`;
}
