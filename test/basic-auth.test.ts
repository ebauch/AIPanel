import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, mock } from "node:test";
import { NextRequest } from "next/server";
import { authorize, hashPassword, isLocalRequest, makeCredentials } from "@/lib/basic-auth";
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

async function writeCreds(user: string, pass: string, mtime?: Date) {
  // Dashboard layout: config/local.json with the creds under `auth`.
  const creds = await makeCredentials(user, pass);
  fs.writeFileSync(authFile, JSON.stringify({ port: 3100, auth: creds }));
  if (mtime) fs.utimesSync(authFile, mtime, mtime);
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "aipanel-auth-"));
  authFile = path.join(dir, "local.json");
});

afterEach(() => {
  mock.restoreAll();
  fs.rmSync(dir, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.AIPANEL_AUTH_FILE;
  else process.env.AIPANEL_AUTH_FILE = savedEnv;
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
    // the right password: nothing else (e.g. ===) decides.
    tse.mock.mockImplementation(() => false);
    assert.equal((await proxy(req({ auth: basic(USER, PASS) }))).status, 401);
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

  for (const [xff, host] of [
    ["127.0.0.1", "localhost:3000"],
    ["::1", "[::1]:3000"],
    ["::ffff:127.0.0.1", "127.0.0.1:3000"],
  ]) {
    it(`allows localhost (${xff}, Host ${host})`, async () => {
      assert.equal((await proxy(req({ xff, host }))).status, 200);
    });
  }

  for (const [label, xff, host] of [
    ["a LAN address", "192.168.68.42", "home.local:3201"],
    ["a LAN address with a localhost Host", "192.168.68.42", "localhost:3000"],
    ["loopback peer with a LAN Host (DNS rebinding)", "127.0.0.1", "evil.example:3000"],
    ["a forwarded chain with a LAN hop", "192.168.68.42, 127.0.0.1", "localhost:3000"],
    ["no peer address", undefined, "localhost:3000"],
  ] as const) {
    it(`refuses ${label} with 401 and a log line`, async () => {
      const warn = mock.method(console, "warn", () => {});
      const res = await proxy(req({ xff, host, auth: basic(USER, PASS) }));
      assert.equal(res.status, 401);
      assert.ok(res.headers.get("www-authenticate"));
      assert.equal(warn.mock.callCount(), 1);
      assert.match(String(warn.mock.calls[0].arguments[0]), /AIPANEL_AUTH_FILE unset/);
    });
  }
});

describe("isLocalRequest / authorize", () => {
  it("treats the whole 127/8 block as loopback", () => {
    assert.equal(isLocalRequest(new Headers({ "x-forwarded-for": "127.0.0.2", host: "127.0.0.1" })), true);
    assert.equal(isLocalRequest(new Headers({ "x-forwarded-for": "10.0.0.1", host: "127.0.0.1" })), false);
  });

  it("returns a log line only for refusals worth logging", async () => {
    await writeCreds(USER, PASS);
    const d = await authorize(new Headers({ authorization: basic(USER, "bad") }), authFile);
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
