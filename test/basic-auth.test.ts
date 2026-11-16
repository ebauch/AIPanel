import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
import { authorize, hashPassword, makeCredentials, resetAuthState } from "@/lib/basic-auth";
import { config, proxy } from "@/proxy";

// Fixture credentials only — generated here, never the dashboard's real ones.
const USER = "fixture-user";
const PASS = "correct horse battery staple";

const basic = (user: string, pass: string) => "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");

function req(opts: { auth?: string; xff?: string; host?: string; path?: string } = {}): NextRequest {
  const headers = new Headers();
  if (opts.auth) headers.set("authorization", opts.auth);
  if (opts.xff) headers.set("x-forwarded-for", opts.xff);
  headers.set("host", opts.host ?? "home.local:3201");
  return new NextRequest(`http://${opts.host ?? "home.local:3201"}${opts.path ?? "/"}`, { headers });
}

let dir: string;
let authFile: string;
const savedEnv = process.env.AIPANEL_AUTH_FILE;
const savedDisabled = process.env.AIPANEL_AUTH_DISABLED;

async function writeCreds(user: string, pass: string, mtime?: Date) {
  // Dashboard layout: config/local.json with the creds under `auth`.
  const creds = await makeCredentials(user, pass);
  fs.writeFileSync(authFile, JSON.stringify({ port: 3100, auth: creds }));
  if (mtime) fs.utimesSync(authFile, mtime, mtime);
}

beforeEach(() => {
  resetAuthState();
  delete process.env.AIPANEL_AUTH_DISABLED;
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aipanel-auth-"));
  authFile = path.join(dir, "local.json");
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.AIPANEL_AUTH_FILE;
  else process.env.AIPANEL_AUTH_FILE = savedEnv;
  if (savedDisabled === undefined) delete process.env.AIPANEL_AUTH_DISABLED;
  else process.env.AIPANEL_AUTH_DISABLED = savedDisabled;
});

describe("hashPassword", () => {
  it("matches the dashboard's scrypt (salt as hex bytes, 64-byte key)", async () => {
    const salt = crypto.randomBytes(16).toString("hex");
    const expected = crypto.scryptSync(PASS, Buffer.from(salt, "hex"), 64).toString("hex");
    assert.equal(await hashPassword(PASS, salt), expected);
  });
});

describe("proxy with AIPANEL_AUTH_FILE set", () => {
  beforeEach(async () => {
    await writeCreds(USER, PASS);
    process.env.AIPANEL_AUTH_FILE = authFile;
  });

  it("lets correct credentials through (200)", async () => {
    const res = await proxy(req({ auth: basic(USER, PASS), path: "/api/debate" }));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get("x-middleware-next"), "1");
  });

  for (const [name, auth] of [
    ["missing header", undefined],
    ["wrong password", basic(USER, "nope")],
    ["wrong user", basic("someone", PASS)],
    ["not Basic", "Bearer abc"],
  ] as const) {
    it(`refuses ${name} with 401 + WWW-Authenticate`, async () => {
      const res = await proxy(req({ auth, path: "/" }));
      assert.equal(res.status, 401);
      assert.equal(res.headers.get("www-authenticate"), 'Basic realm="home studio", charset="UTF-8"');
    });
  }

  it("still requires the login from localhost", async () => {
    const res = await proxy(req({ xff: "127.0.0.1", host: "localhost:3000" }));
    assert.equal(res.status, 401);
  });

  it("refuses everything (fail closed) when the file is missing or has no creds", async () => {
    fs.writeFileSync(authFile, JSON.stringify({ port: 3100 }));
    const warn = mock.method(console, "warn", () => {});
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
    process.env.AIPANEL_AUTH_FILE = path.join(dir, "missing.json");
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
    assert.equal(warn.mock.callCount(), 2);
  });

  it("picks up a changed credentials file without a restart", async () => {
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 200);
    await writeCreds(USER, "rotated", new Date(Date.now() + 5_000));
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
    assert.equal((await proxy(req({ auth: basic(USER, "rotated") }))).status, 200);
  });

  it("decides the password with crypto.timingSafeEqual", async () => {
    const tse = mock.method(crypto, "timingSafeEqual");
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 200);
    assert.equal(tse.mock.callCount(), 1);
    // If the constant-time compare says no, the request is refused even with
    // the right password: nothing else (e.g. ===) decides. Covers the
    // memoised path too (it compares digests with timingSafeEqual).
    tse.mock.mockImplementation(() => false);
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
    resetAuthState();
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
  });

  it("memoises the last good login: one scrypt, not one per request", async () => {
    const scrypt = mock.method(crypto, "scrypt");
    for (let i = 0; i < 3; i++) assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 200);
    assert.equal(scrypt.mock.callCount(), 1);
    // A different (wrong) header is not covered by the memo.
    assert.equal((await proxy(req({ auth: basic(USER, "nope") }))).status, 401);
    assert.equal(scrypt.mock.callCount(), 2);
  });

  it("drops the memo when the credentials file changes", async () => {
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 200);
    await writeCreds(USER, "rotated", new Date(Date.now() + 5_000));
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
  });

  it("ignores AIPANEL_AUTH_DISABLED when the file is set (file wins)", async () => {
    process.env.AIPANEL_AUTH_DISABLED = "1";
    assert.equal((await proxy(req({ path: "/api/debate" }))).status, 401);
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 200);
  });

  it("runs scrypt even when the user is wrong (no username probing)", async () => {
    const scrypt = mock.method(crypto, "scrypt");
    await proxy(req({ auth: basic("someone", PASS) }));
    assert.equal(scrypt.mock.callCount(), 1);
  });
});

describe("proxy with AIPANEL_AUTH_FILE unset", () => {
  beforeEach(() => {
    delete process.env.AIPANEL_AUTH_FILE;
  });

  for (const [label, xff, host] of [
    ["forged loopback X-Forwarded-For + Host", "127.0.0.1", "localhost:3000"],
    ["IPv6 loopback", "::1", "[::1]:3000"],
    ["a LAN address", "192.168.68.42", "home.local:3201"],
    ["no peer address", undefined, "localhost:3000"],
  ] as const) {
    it(`refuses ${label} with 401 and a log line naming AIPANEL_AUTH_FILE`, async () => {
      const warn = mock.method(console, "warn", () => {});
      const res = await proxy(req({ xff, host, auth: basic(USER, PASS) }));
      assert.equal(res.status, 401);
      assert.ok(res.headers.get("www-authenticate"));
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /AIPANEL_AUTH_FILE is unset; set it/);
    });
  }

  it("only AIPANEL_AUTH_DISABLED=1 opens it, with a loud warning on the first request", async () => {
    const warn = mock.method(console, "warn", () => {});
    process.env.AIPANEL_AUTH_DISABLED = "true";
    assert.equal((await proxy(req({ xff: "192.168.68.42" }))).status, 401);
    process.env.AIPANEL_AUTH_DISABLED = "1";
    assert.equal((await proxy(req({ xff: "192.168.68.42" }))).status, 200);
    assert.equal((await proxy(req({}))).status, 200);
    const loud = warn.mock.calls.filter((c) => /WITHOUT a login/.test(String(c.arguments[0])));
    assert.equal(loud.length, 1);
  });
});

describe("authorize", () => {
  it("returns a log line only for refusals worth logging", async () => {
    await writeCreds(USER, PASS);
    const d = await authorize(new Headers({ authorization: basic(USER, "bad") }), { AIPANEL_AUTH_FILE: authFile });
    assert.equal(d.ok, false);
    assert.equal(!d.ok && d.log, undefined);
  });
});

describe("matcher", () => {
  it("covers pages and /api but skips only _next/static", () => {
    const re = new RegExp("^" + config.matcher[0] + "$");
    for (const p of ["/", "/settings", "/api/debate", "/favicon.ico", "/_next/image"]) assert.ok(re.test(p), p);
    assert.equal(re.test("/_next/static/chunks/app.js"), false);
  });
});
