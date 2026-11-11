import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { request } from "node:http";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { CHAT_OPS, ScriptedInterpreter, acceptedArgs } from "../chat/index.js";
import { startController, type Controller } from "../api/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { checkBinding, isLoopbackAddress, isPrivateAddress, remoteAllowed } from "./binding.js";
import { checkTrustedProxy, type TrustedProxy } from "./proxy.js";
import { WebSessionStore } from "./sessions.js";
import { deviceLabel, type WebAssets } from "./door.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const ASSETS: WebAssets = { "/": { type: "text/html; charset=utf-8", body: "<!doctype html><title>t</title>" }, "/app.js": { type: "text/javascript", body: "1" } };
const dirs: string[] = [];
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

// ---- the binding rules ----------------------------------------------------------------------------------------------------------

test("an address is private only when it is in a private range; a wildcard, a public address and a name never are", () => {
  for (const ok of ["10.1.2.3", "172.16.0.1", "172.31.255.255", "192.168.1.5", "100.64.0.1", "100.127.255.254", "169.254.1.1", "fd7a:115c:a1e0::1", "fc00::1", "fe80::1", "::ffff:10.0.0.1"]) assert.equal(isPrivateAddress(ok), true, ok);
  for (const no of ["0.0.0.0", "::", "8.8.8.8", "100.63.0.1", "100.128.0.1", "172.15.0.1", "172.32.0.1", "192.169.0.1", "1.1.1.1", "2001:db8::1", "example.org", "newt.ts.net", "10.0.0", "10.0.0.256", "::ffff:8.8.8.8", ""]) assert.equal(isPrivateAddress(no), false, no);
  for (const ok of ["127.0.0.1", "127.8.9.10", "::1", "localhost", "::ffff:127.0.0.1"]) assert.equal(isLoopbackAddress(ok), true, ok);
  for (const no of ["10.0.0.1", "0.0.0.0", "128.0.0.1", "::2", "localhost.evil.org"]) assert.equal(isLoopbackAddress(no), false, no);
  assert.equal(remoteAllowed("loopback", "127.0.0.1"), true);
  assert.equal(remoteAllowed("loopback", "100.64.0.9"), false, "a loopback listener serves no private-network client directly");
  assert.equal(remoteAllowed("private", "100.64.0.9"), true);
  assert.equal(remoteAllowed("private", "203.0.113.9"), false);
  assert.equal(remoteAllowed("private", undefined), false);
});

test("the binding must be stated and agree with the stated network; nothing public or wildcard is ever accepted", () => {
  const base = { host: "127.0.0.1", network: "loopback" as string, tls: false, behindTlsProxy: false, publicHosts: [] as string[] };
  checkBinding(base as never);
  checkBinding({ ...base, host: "::1" } as never);
  checkBinding({ ...base, publicHosts: ["newt.example.ts.net"], behindTlsProxy: true } as never);
  checkBinding({ host: "100.64.1.2", network: "private", tls: true, behindTlsProxy: false, publicHosts: ["newt.example.ts.net"] });
  const refused = (change: Partial<typeof base> & { network?: string | undefined }, field: string): void => assert.throws(() => checkBinding({ ...base, ...change } as never), (e: { field?: string }) => e.field === field, JSON.stringify(change));
  refused({ host: "0.0.0.0" }, "host");
  refused({ host: "::" }, "host");
  refused({ host: "0.0.0.0", network: "private", tls: true, publicHosts: ["a.b"] }, "host");
  refused({ host: "8.8.8.8", network: "private", tls: true, publicHosts: ["a.b"] }, "host");
  refused({ host: "newt.example.org", network: "private", tls: true, publicHosts: ["a.b"] }, "host");
  refused({ host: "10.0.0.5" }, "host");
  refused({ host: "" }, "host");
  refused({ network: "public" }, "network");
  refused({ network: undefined as never }, "network");
  refused({ host: "10.0.0.5", network: "private", publicHosts: ["a.b"] }, "tls");
  refused({ host: "10.0.0.5", network: "private", tls: true }, "publicHosts");
  refused({ publicHosts: ["newt.example.ts.net"] }, "behindTlsProxy");
  refused({ host: "10.0.0.5", network: "private", tls: true, publicHosts: ["a.b"], behindTlsProxy: true }, "behindTlsProxy");
  refused({ publicHosts: ["bad host!"], behindTlsProxy: true }, "publicHosts");
  // The resolver reads a leading zero as octal: 010.0.0.1 is 8.0.0.1, a public address, though the range check would read 10.0.0.1.
  refused({ host: "010.0.0.1", network: "private", tls: true, publicHosts: ["a.b"] }, "host");
  refused({ host: "127.000.000.001" }, "host");
  refused({ host: "0177.0.0.1" }, "host");
  checkBinding({ host: "fe80::1%lo", network: "private", tls: true, behindTlsProxy: false, publicHosts: ["a.b"] });
});

// ---- sessions ------------------------------------------------------------------------------------------------------------------

test("a session ends by idle time and by its absolute limit; the cookie value is not what is kept; the oldest goes when there are too many", () => {
  let t = 1_000_000;
  const s = new WebSessionStore({ idleMs: 1000, maxMs: 4000, sessions: 2, pairingMs: 1000 }, () => t);
  const a = s.create("owner:rob", "tok", "phone");
  assert.equal(s.lookup(a.cookie)?.handle, a.session.handle);
  t += 900; assert.ok(s.lookup(a.cookie), "a request slides the idle time");
  t += 900; assert.ok(s.lookup(a.cookie));
  t += 900; assert.ok(s.lookup(a.cookie));
  t += 900; assert.ok(s.lookup(a.cookie));
  t += 900; assert.equal(s.lookup(a.cookie), undefined, "past the absolute limit, however active");
  assert.equal(s.lookup("nonsense"), undefined);
  const b = s.create("owner:rob", "tok", "b"); t += 10;
  const c = s.create("owner:rob", "tok", "c"); t += 10;
  const d = s.create("owner:rob", "tok", "d");
  assert.equal(s.size, 2);
  assert.equal(s.lookup(b.cookie), undefined, "the least recently used went");
  assert.ok(s.lookup(c.cookie) && s.lookup(d.cookie));
  assert.equal(JSON.stringify(s.list("owner:rob")).includes(c.cookie), false, "a list never shows a cookie");
  assert.equal(s.revokeHandle("owner:other", c.session.handle), false, "another principal cannot end it");
  assert.equal(s.revokeHandle("owner:rob", c.session.handle), true);
  assert.equal(s.revokeAll("owner:rob", d.session.handle), 0);
  assert.equal(s.revokeAll("owner:rob"), 1);
});

test("a pairing code works once, only before it expires, and in any letter case", () => {
  let t = 0;
  const s = new WebSessionStore({ pairingMs: 1000 }, () => t);
  const p = s.pair("owner:rob", "tok");
  assert.match(p.code, /^[A-Z2-9]{10}$/);
  assert.equal(s.redeem(p.code.toLowerCase())?.principalId, "owner:rob");
  assert.equal(s.redeem(p.code), undefined, "used once");
  const q = s.pair("owner:rob", "tok"); t += 1001;
  assert.equal(s.redeem(q.code), undefined, "expired");
});

// ---- the door, over a real controller ------------------------------------------------------------------------------------------

interface Reply { status: number; headers: Record<string, string | string[] | undefined>; body: any; text: string }
interface World {
  c: Controller; url: string; token: string; ownerId: string; port: number; interpreter: ScriptedInterpreter; now: { t: number };
  call(method: string, path: string, o?: { cookie?: string; csrf?: string; body?: unknown; headers?: Record<string, string>; host?: string }): Promise<Reply>;
  signIn(credential?: Record<string, string>): Promise<{ cookie: string; csrf: string; reply: Reply }>;
}

async function world(extra: { behindTlsProxy?: boolean; publicHosts?: string[]; session?: object; limits?: object; trustedProxy?: TrustedProxy } = {}, interpreter: ScriptedInterpreter = new ScriptedInterpreter(() => [])): Promise<World> {
  const d = mkdtempSync(join(tmpdir(), "nn-web-")); dirs.push(d);
  const now = { t: Date.parse("2026-11-10T10:00:00Z") };
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "n.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter }, webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS, clock: () => now.t, ...extra },
  });
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const door = c.webChat!;
  const call: World["call"] = (method, path, o = {}) => new Promise((resolve, reject) => {
    const payload = o.body === undefined ? undefined : JSON.stringify(o.body);
    const headers: Record<string, string> = { host: o.host ?? `127.0.0.1:${door.port}`, ...(payload === undefined ? {} : { "content-type": "application/json", "content-length": String(Buffer.byteLength(payload)) }), ...(o.cookie === undefined ? {} : { cookie: o.cookie }), ...(o.csrf === undefined ? {} : { "x-nn-csrf": o.csrf }), ...(o.headers ?? {}) };
    const req = request({ host: "127.0.0.1", port: door.port, method, path, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (x: Buffer) => chunks.push(x));
      res.on("end", () => { const text = Buffer.concat(chunks).toString("utf8"); let body: unknown; try { body = JSON.parse(text); } catch { body = undefined; } resolve({ status: res.statusCode!, headers: res.headers, body, text }); });
    });
    req.on("error", reject);
    if (payload !== undefined) req.write(payload);
    req.end();
  });
  const cookieOf = (r: Reply): string => String([r.headers["set-cookie"]].flat()[0]).split(";")[0]!;
  const signIn: World["signIn"] = async (credential = { token: boot.token }) => {
    const reply = await call("POST", "/web/login", { body: credential });
    assert.equal(reply.status, 200, reply.text);
    return { cookie: cookieOf(reply), csrf: reply.body.csrf, reply };
  };
  return { c, url: door.url, token: boot.token, ownerId: "owner:rob", port: door.port, interpreter, now, call, signIn };
}

test("the page is served without a session under a strict policy; everything under /web needs one", async () => {
  const w = await world();
  try {
    const page = await w.call("GET", "/");
    assert.equal(page.status, 200);
    assert.match(String(page.headers["content-type"]), /text\/html/);
    assert.match(String(page.headers["content-security-policy"]), /default-src 'none'/);
    assert.match(String(page.headers["content-security-policy"]), /script-src 'self'/);
    assert.doesNotMatch(String(page.headers["content-security-policy"]), /unsafe-inline|unsafe-eval/);
    assert.equal(page.headers["x-frame-options"], "DENY");
    assert.equal(page.headers["strict-transport-security"], undefined, "plain loopback: no HSTS");
    assert.equal((await w.call("GET", "/nope")).status, 404);
    assert.equal((await w.call("POST", "/")).status, 405);
    for (const path of ["/web/session", "/web/sessions", "/web/views/status"]) assert.equal((await w.call("GET", path)).status, 401, path);
    assert.equal((await w.call("POST", "/web/chat", { body: { messageId: "m1", text: "hi" } })).status, 401);
  } finally { await w.c.close(); }
});

test("sign-in: a wrong credential is refused alike and counted per address; the right one sets an HttpOnly SameSite=Strict cookie; the credential is never sent back", async () => {
  const w = await world({ limits: { failedLoginsPerAddressPerMinute: 3 } });
  try {
    const wrong = await w.call("POST", "/web/login", { body: { token: "owner:rob.nottherightsecret000000000000000000" } });
    const unknown = await w.call("POST", "/web/login", { body: { token: "owner:ghost.nottherightsecret000000000000000000" } });
    assert.deepEqual([wrong.status, unknown.status], [401, 401]);
    assert.deepEqual(wrong.body, unknown.body, "one answer for both");
    assert.equal((await w.call("POST", "/web/login", { body: { code: "ABCDEFGHJK" } })).status, 401);
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token } })).status, 429, "three failures used the minute's allowance, even the right credential waits");
    w.now.t += 61_000;
    const { reply, csrf } = await w.signIn();
    const cookie = String([reply.headers["set-cookie"]].flat()[0]);
    assert.match(cookie, /^nn_session=[A-Za-z0-9_-]{40,}; /);
    assert.match(cookie, /HttpOnly/); assert.match(cookie, /SameSite=Strict/); assert.match(cookie, /Path=\//);
    assert.doesNotMatch(cookie, /Secure/, "plain loopback http: a Secure cookie would never come back");
    assert.ok(csrf.length >= 20);
    assert.equal(reply.text.includes(w.token) || reply.text.includes(w.token.split(".")[1]!), false, "the reply holds no credential");
    assert.equal((await w.call("POST", "/web/login", { body: { token: 5 } })).status, 400);
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token }, headers: { origin: "http://evil.example" } })).status, 403, "a sign-in from another origin");
  } finally { await w.c.close(); }
});

test("only the owner may sign in: an agent's credential is refused, gets no session or CSRF token, and counts as a failed attempt", async () => {
  const w = await world({ limits: { failedLoginsPerAddressPerMinute: 2 } });
  try {
    const owner = await w.c.services.principals.authenticate(w.token);
    await w.c.services.principals.enroll(owner, { commandId: "e1", kind: "agent", name: "ann", grants: [] });
    const issued = await w.c.services.principals.issueCredential(owner, "agent:ann");
    const r = await w.call("POST", "/web/login", { body: { token: issued.token } });
    assert.equal(r.status, 403, r.text);
    assert.equal(r.headers["set-cookie"], undefined, "no session cookie");
    assert.equal(r.text.includes("csrf"), false, "no CSRF token");
    assert.equal((await w.call("POST", "/web/login", { body: { token: issued.token } })).status, 403);
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token } })).status, 429, "the refused attempts were counted");
    assert.equal(w.c.webChat!.url.startsWith("http://127.0.0.1:"), true);
  } finally { await w.c.close(); }
});

test("failed sign-ins sent all at once cannot pass the per-address limit together; a success gives its attempt back", async () => {
  const w = await world({ limits: { failedLoginsPerAddressPerMinute: 3 } });
  try {
    const burst = await Promise.all(Array.from({ length: 12 }, (_, i) => w.call("POST", "/web/login", { body: { token: `owner:rob.wrongsecret${String(i).padStart(30, "0")}` } })));
    const statuses = burst.map((r) => r.status);
    assert.equal(statuses.filter((x) => x === 401).length, 3, statuses.join(","));
    assert.equal(statuses.filter((x) => x === 429).length, 9, statuses.join(","));
    w.now.t += 61_000;
    for (let i = 0; i < 5; i += 1) await w.signIn();
    assert.equal((await w.call("POST", "/web/login", { body: { token: "owner:rob.wrong" } })).status, 401, "five good sign-ins used none of the allowance");
  } finally { await w.c.close(); }
});

test("the session cookie lives until the session's absolute end, not only one idle period (the idle limit is the server's)", async () => {
  const w = await world({ session: { idleMs: 60_000, maxMs: 600_000 } });
  try {
    const { reply } = await w.signIn();
    assert.match(String([reply.headers["set-cookie"]].flat()[0]), /Max-Age=600(;|$)/);
  } finally { await w.c.close(); }
});

test("a change needs the session's CSRF header, JSON, and a same-origin Origin; a read does not", async () => {
  const w = await world();
  try {
    const { cookie, csrf } = await w.signIn();
    const body = { messageId: "m-csrf", text: "/nimblenewt.nothing" };
    assert.equal((await w.call("POST", "/web/chat", { cookie, body })).status, 403, "no CSRF header");
    assert.equal((await w.call("POST", "/web/chat", { cookie, csrf: "wrong", body })).status, 403);
    assert.equal((await w.call("POST", "/web/chat", { cookie, csrf, body, headers: { origin: "http://evil.example" } })).status, 403, "foreign Origin");
    assert.equal((await w.call("POST", "/web/chat", { cookie, csrf, body, headers: { "sec-fetch-site": "cross-site" } })).status, 403, "cross-site fetch");
    assert.equal((await w.call("POST", "/web/chat", { cookie, csrf, body, headers: { "content-type": "text/plain" } })).status, 415);
    assert.equal((await w.call("POST", "/web/chat", { cookie, csrf, body: { messageId: "bad id!", text: "x" } })).status, 400);
    assert.equal((await w.call("POST", "/web/chat", { cookie, csrf, body: { messageId: "ok", text: "x".repeat(20_000) } })).status, 413);
    const ok = await w.call("POST", "/web/chat", { cookie, csrf, body, headers: { origin: `http://127.0.0.1:${w.port}` } });
    assert.equal(ok.status, 201, ok.text);
    assert.equal((await w.call("GET", "/web/session", { cookie })).status, 200);
    assert.equal((await w.call("GET", "/web/session", { cookie, host: "evil.example" })).status, 421, "a foreign Host name (DNS rebinding)");
  } finally { await w.c.close(); }
});

test("a suspended connection resumes: the same message id sent again returns the first turn and runs nothing a second time, even when both arrive at once", async () => {
  const w = await world();
  try {
    const { cookie, csrf } = await w.signIn();
    let asked = 0;
    const interpreter = new ScriptedInterpreter(() => { asked += 1; return []; });
    (w.interpreter as unknown as { interpret: typeof interpreter.interpret }).interpret = interpreter.interpret.bind(interpreter);
    const send = (id: string, text: string) => w.call("POST", "/web/chat", { cookie, csrf, body: { messageId: id, text } });
    const first = await send("m-1", "do something vague");
    assert.equal(first.status, 201); assert.equal(first.body.replayed, false);
    assert.equal(asked, 1);
    const again = await send("m-1", "do something vague");
    assert.equal(again.status, 200); assert.equal(again.body.replayed, true);
    assert.equal(again.body.turnId, first.body.turnId);
    assert.deepEqual(again.body.reply, first.body.reply);
    assert.equal(asked, 1, "the assistant was not asked again");
    const both = await Promise.all([send("m-2", "something else vague"), send("m-2", "something else vague"), send("m-2", "something else vague")]);
    assert.equal(new Set(both.map((r) => r.body.turnId)).size, 1);
    assert.equal(asked, 2, "three arrivals at once, one run");
    // A browser that signed in again from another device sends the same id: still the same turn.
    const other = await w.signIn();
    const third = await w.call("POST", "/web/chat", { cookie: other.cookie, csrf: other.csrf, body: { messageId: "m-1", text: "do something vague" } });
    assert.equal(third.body.replayed, true);
    assert.equal(asked, 2);
  } finally { await w.c.close(); }
});

test("a typed recovery order runs without the assistant and a resend does not repeat it", async () => {
  const w = await world();
  try {
    const { cookie, csrf } = await w.signIn();
    w.interpreter.failWith = new Error("the model is down");
    const say = (id: string, text: string) => w.call("POST", "/web/chat", { cookie, csrf, body: { messageId: id, text } });
    const scope = JSON.stringify({ kind: "installation", id: "installation" });
    const pauseLine = `/nimblenewt.lifecycle-pause {"scope": ${scope}, "reason": "paused from the phone"}`;
    const paused = await say("p-1", pauseLine);
    assert.equal(paused.status, 201, paused.text);
    assert.equal(w.interpreter.calls.length, 0, "the assistant was never asked");
    assert.equal(paused.body.outcomes[0].status, "applied", paused.text);
    assert.equal(paused.body.outcomes[0].op, "nimblenewt.lifecycle-pause");
    const gates = async () => JSON.stringify(await w.c.api.handle(w.token, { v: 1, op: "lifecycle.status", args: { scope: JSON.parse(scope) } }));
    const before = await gates();
    assert.match(before, /"intent":"pause"/, "the installation is paused");
    const resent = await say("p-1", pauseLine);
    assert.equal(resent.body.replayed, true);
    assert.deepEqual(resent.body.outcomes, paused.body.outcomes);
    assert.equal(await gates(), before, "nothing changed on the resend");
    const resumed = await say("p-2", `/nimblenewt.lifecycle-resume {"scope": ${scope}, "reason": "back"}`);
    assert.equal(resumed.body.outcomes[0].status, "applied", resumed.text);
    assert.doesNotMatch(await gates(), /"intent":"pause"/);
  } finally { await w.c.close(); }
});

test("a revoked session is refused at once, from another browser or by rotating the credential; sign-out ends only its own", async () => {
  const w = await world();
  try {
    const phone = await w.signIn();
    const laptop = await w.signIn();
    const list = await w.call("GET", "/web/sessions", { cookie: laptop.cookie });
    assert.equal(list.body.sessions.length, 2);
    assert.equal(list.text.includes(phone.cookie.split("=")[1]!), false, "the list holds no cookie value");
    const phoneHandle = list.body.sessions.find((s: { current: boolean }) => !s.current).handle;
    assert.equal((await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { handle: phoneHandle } })).status, 200);
    const denied = await w.call("GET", "/web/session", { cookie: phone.cookie });
    assert.equal(denied.status, 401, "the revoked phone is refused on its very next request");
    assert.match(String([denied.headers["set-cookie"]].flat()[0]), /Max-Age=0/);
    assert.equal((await w.call("POST", "/web/chat", { cookie: phone.cookie, csrf: phone.csrf, body: { messageId: "x1", text: "hello" } })).status, 401);
    assert.equal((await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { handle: "ws-000000000000" } })).status, 404);
    // Sign-out of one browser leaves another.
    const tablet = await w.signIn();
    assert.equal((await w.call("POST", "/web/logout", { cookie: tablet.cookie, csrf: tablet.csrf, body: {} })).status, 200);
    assert.equal((await w.call("GET", "/web/session", { cookie: tablet.cookie })).status, 401);
    assert.equal((await w.call("GET", "/web/session", { cookie: laptop.cookie })).status, 200);
    // Revoking all others.
    const second = await w.signIn();
    assert.equal((await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { all: true } })).body.revoked, 1);
    assert.equal((await w.call("GET", "/web/session", { cookie: second.cookie })).status, 401);
    // Rotating the owner's credential ends every session on its next request.
    const owner = await w.c.services.principals.authenticate(w.token);
    await w.c.services.principals.issueCredential(owner, owner.id);
    assert.equal((await w.call("GET", "/web/session", { cookie: laptop.cookie })).status, 401, "the old credential no longer opens the session");
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token } })).status, 401);
    assert.equal(w.c.webChat!.revokeAll(owner.id), 0);
  } finally { await w.c.close(); }
});

test("a session ends by idle time, and a cookie older than its absolute limit is refused however active", async () => {
  const w = await world({ session: { idleMs: 60_000, maxMs: 150_000 } });
  try {
    const a = await w.signIn();
    w.now.t += 59_000; assert.equal((await w.call("GET", "/web/session", { cookie: a.cookie })).status, 200);
    w.now.t += 59_000; assert.equal((await w.call("GET", "/web/session", { cookie: a.cookie })).status, 200);
    w.now.t += 59_000; assert.equal((await w.call("GET", "/web/session", { cookie: a.cookie })).status, 401, "past the absolute limit");
    const b = await w.signIn();
    w.now.t += 61_000; assert.equal((await w.call("GET", "/web/session", { cookie: b.cookie })).status, 401, "idle too long");
  } finally { await w.c.close(); }
});

test("a pairing code signs in a second browser once; only a signed-in owner can make one", async () => {
  const w = await world();
  try {
    assert.equal((await w.call("POST", "/web/pairings", { body: {} })).status, 401);
    const laptop = await w.signIn();
    const made = await w.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} });
    assert.equal(made.status, 201);
    const phone = await w.signIn({ code: made.body.code.toLowerCase() });
    assert.equal((await w.call("GET", "/web/session", { cookie: phone.cookie })).status, 200);
    assert.equal((await w.call("POST", "/web/login", { body: { code: made.body.code } })).status, 401, "a code works once");
    const viaHost = await w.c.webChat!.createPairing(w.token);
    assert.match(viaHost.code, /^[A-Z2-9]{10}$/);
    await w.signIn({ code: viaHost.code });
    await assert.rejects(w.c.webChat!.createPairing("owner:rob.wrong0000000000000000000000000000"), /./);
  } finally { await w.c.close(); }
});

test("a pairing code ends with the session that made it and with sign-out of all other browsers", async () => {
  const w = await world();
  try {
    const laptop = await w.signIn();
    const thief = await w.signIn();
    const code = (await w.call("POST", "/web/pairings", { cookie: thief.cookie, csrf: thief.csrf, body: {} })).body.code as string;
    const kept = (await w.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} })).body.code as string;
    const handle = (await w.call("GET", "/web/sessions", { cookie: laptop.cookie })).body.sessions.find((s: { current: boolean }) => !s.current).handle;
    assert.equal((await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { handle } })).status, 200);
    assert.equal((await w.call("POST", "/web/login", { body: { code } })).status, 401, "the revoked browser's code is gone");
    const viaKept = await w.signIn({ code: kept });
    const later = (await w.call("POST", "/web/pairings", { cookie: viaKept.cookie, csrf: viaKept.csrf, body: {} })).body.code as string;
    const fromHost = (await w.c.webChat!.createPairing(w.token)).code;
    assert.equal((await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { all: true } })).status, 200);
    assert.equal((await w.call("POST", "/web/login", { body: { code: later } })).status, 401, "sign-out of all others ends every unused code");
    assert.equal((await w.call("POST", "/web/login", { body: { code: fromHost } })).status, 401);
    assert.equal((await w.call("GET", "/web/session", { cookie: laptop.cookie })).status, 200);
  } finally { await w.c.close(); }
});

test("the views read status, blockers, cost and recovery; an unknown view is refused; the door runs no other operation", async () => {
  const w = await world();
  try {
    const s = await w.signIn();
    assert.deepEqual(s.reply.body.views, ["status", "needs-you", "blockers", "cost", "recovery"]);
    for (const name of s.reply.body.views as string[]) {
      const r = await w.call("GET", `/web/views/${name}`, { cookie: s.cookie });
      assert.equal(r.status, 200, `${name}: ${r.text}`);
      assert.ok(Object.keys(r.body.parts).length >= 1, name);
      for (const part of Object.values(r.body.parts) as { error?: unknown }[]) assert.equal(part.error, undefined, `${name}: ${JSON.stringify(part)}`);
    }
    assert.equal((await w.call("GET", "/web/views/shutdown", { cookie: s.cookie })).status, 404);
    assert.equal((await w.call("GET", "/web/views/constructor", { cookie: s.cookie })).status, 404);
    assert.equal((await w.call("GET", "/web/views/status/extra", { cookie: s.cookie })).status, 404);
  } finally { await w.c.close(); }
});

test("a proposal is applied or discarded from the page once, however often the decision is sent", async () => {
  const w = await world();
  try {
    const s = await w.signIn();
    const owner = await w.c.services.principals.authenticate(w.token);
    const saved = await w.c.chat!.propose(owner, { commandId: "pp1", source: "chat", reason: "test", preview: ["Create team: core"], steps: [{ op: "team.create", args: { name: "core" } }] });
    const decide = (key: string | undefined) => w.call("POST", `/web/proposals/${saved.id}/apply`, { cookie: s.cookie, csrf: s.csrf, body: {}, headers: key === undefined ? {} : { "idempotency-key": key } });
    assert.equal((await decide(undefined)).status, 400, "a decision needs its key");
    const first = await decide("d-1");
    assert.equal(first.status, 200, first.text);
    assert.equal(first.body.applied, true);
    const second = await decide("d-1");
    assert.equal(second.body.replayed, true, "the same key is the same decision");
    const teams = await w.c.api.handle(w.token, { v: 1, op: "team.list", args: {} });
    assert.equal(JSON.stringify(teams).split("\"core\"").length - 1 >= 1, true);
    assert.equal(JSON.stringify(teams).split("\"name\":\"core\"").length - 1, 1, "one team");
    assert.equal((await w.call("POST", "/web/proposals/nope/discard", { cookie: s.cookie, csrf: s.csrf, body: {}, headers: { "idempotency-key": "d-2" } })).status, 404);
  } finally { await w.c.close(); }
});

test("behind a TLS proxy the cookie is Secure and __Host- prefixed, HSTS is sent and only the declared names are served", async () => {
  const w = await world({ behindTlsProxy: true, publicHosts: ["newt.example.ts.net"] });
  try {
    const host = "newt.example.ts.net";
    const login = await w.call("POST", "/web/login", { body: { token: w.token }, host, headers: { origin: "https://newt.example.ts.net" } });
    assert.equal(login.status, 200, login.text);
    const cookie = String([login.headers["set-cookie"]].flat()[0]);
    assert.match(cookie, /^__Host-nn_session=/); assert.match(cookie, /; Secure/); assert.match(cookie, /Path=\//); assert.doesNotMatch(cookie, /Domain=/);
    assert.match(String(login.headers["strict-transport-security"]), /max-age=/);
    assert.equal((await w.call("GET", "/", { host: "other.example.ts.net" })).status, 421);
    const ok = await w.call("GET", "/web/session", { host, cookie: cookie.split(";")[0]! });
    assert.equal(ok.status, 200);
    assert.equal((await w.call("POST", "/web/logout", { host, cookie: cookie.split(";")[0]!, csrf: login.body.csrf, body: {}, headers: { origin: "http://newt.example.ts.net" } })).status, 403, "an http origin for an https listener");
  } finally { await w.c.close(); }
});

test("the web chat needs the owner chat, and a listener that would be public is not started", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-web-")); dirs.push(d);
  const base = { storage: { kind: "sqlite" as const, path: join(d, "a.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 };
  await assert.rejects(startController({ ...base, webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS } }), /owner chat/);
  const d2 = mkdtempSync(join(tmpdir(), "nn-web-")); dirs.push(d2);
  await assert.rejects(startController({ ...base, storage: { kind: "sqlite", path: join(d2, "b.sqlite") }, chat: { interpreter: new ScriptedInterpreter({}) }, webChat: { host: "0.0.0.0", network: "private", assets: ASSETS } }), /every interface/);
  // A web chat that cannot open leaves no conversation transport listening behind the failed start.
  const port = await new Promise<number>((resolve) => { const s = createNetServer(); s.listen(0, "127.0.0.1", () => { const p = (s.address() as { port: number }).port; s.close(() => resolve(p)); }); });
  const d3 = mkdtempSync(join(tmpdir(), "nn-web-")); dirs.push(d3);
  await assert.rejects(startController({ ...base, storage: { kind: "sqlite", path: join(d3, "c.sqlite") }, chat: { interpreter: new ScriptedInterpreter({}) }, conversationTransport: { port }, webChat: { host: "0.0.0.0", network: "private", assets: ASSETS } }), /every interface/);
  await new Promise<void>((resolve, reject) => { const s = createNetServer(); s.once("error", reject); s.listen(port, "127.0.0.1", () => s.close(() => resolve())); });
});

// ---- U07b: trusted proxy, two-level limiter, revoked in-flight requests, settings, owner chat ------------------------------------

const XFF = (v: string) => ({ "x-forwarded-for": v });
const wrong = (i: number) => ({ token: `owner:rob.wrongsecret${String(i).padStart(30, "0")}` });
const proxyOn = { addresses: ["127.0.0.1"] };

test("behind a trusted proxy each client has its own allowance: a tailnet peer's flood cannot hold the owner's sign-in; without the option the forwarded header is never read", async () => {
  const on = await world({ trustedProxy: proxyOn, limits: { failedLoginsPerAddressPerMinute: 3 } });
  try {
    for (let i = 0; i < 3; i += 1) assert.equal((await on.call("POST", "/web/login", { body: wrong(i), headers: XFF("203.0.113.9") })).status, 401);
    assert.equal((await on.call("POST", "/web/login", { body: wrong(9), headers: XFF("203.0.113.9") })).status, 429, "the flooder is out of allowance");
    const owner = await on.call("POST", "/web/login", { body: { token: on.token }, headers: XFF("198.51.100.7") });
    assert.equal(owner.status, 200, "another client of the proxy still signs in");
    assert.equal((await on.call("POST", "/web/login", { body: { token: on.token }, headers: XFF("203.0.113.9") })).status, 429, "the flooder still waits");
    // The settings page shows what the door sees, so the owner can check the proxy header is arriving.
    const s = await on.call("GET", "/web/settings", { cookie: String([owner.headers["set-cookie"]].flat()[0]).split(";")[0]!, headers: XFF("198.51.100.7") });
    assert.equal(s.body.yourAddress, "198.51.100.7"); assert.equal(s.body.addressFromProxy, true);
  } finally { await on.c.close(); }
  const off = await world({ limits: { failedLoginsPerAddressPerMinute: 3 } });
  try {
    for (let i = 0; i < 3; i += 1) await off.call("POST", "/web/login", { body: wrong(i), headers: XFF("203.0.113.9") });
    assert.equal((await off.call("POST", "/web/login", { body: { token: off.token }, headers: XFF("198.51.100.7") })).status, 429, "off by default: the header is ignored and everyone is the proxy's one address");
  } finally { await off.c.close(); }
});

test("spoofing: a header from a peer that is not the proxy is ignored; entries to the left of the rightmost untrusted one cannot choose the address; a garbled or doubled header falls back to the proxy's own bucket", async () => {
  // The test connects from 127.0.0.1; naming only ::1 as the proxy makes this peer "someone else".
  const other = await world({ trustedProxy: { addresses: ["::1"] }, limits: { failedLoginsPerAddressPerMinute: 2 } });
  try {
    for (let i = 0; i < 2; i += 1) await other.call("POST", "/web/login", { body: wrong(i), headers: XFF(`10.0.0.${i + 1}`) });
    assert.equal((await other.call("POST", "/web/login", { body: wrong(5), headers: XFF("10.9.9.9") })).status, 429, "rotating the header gained nothing: the peer is not the proxy");
  } finally { await other.c.close(); }
  const w = await world({ trustedProxy: { addresses: ["127.0.0.1", "::1"] }, limits: { failedLoginsPerAddressPerMinute: 2 } });
  try {
    // An attacker writes junk on the left; the proxy appended the real address on the right: junk is ignored.
    await w.call("POST", "/web/login", { body: wrong(1), headers: XFF("1.1.1.1, 203.0.113.9") });
    await w.call("POST", "/web/login", { body: wrong(2), headers: XFF("2.2.2.2, 203.0.113.9") });
    assert.equal((await w.call("POST", "/web/login", { body: wrong(3), headers: XFF("3.3.3.3, 203.0.113.9") })).status, 429, "the left side cannot rotate the bucket");
    // Proxies of ours at the right end are skipped.
    assert.equal((await w.call("POST", "/web/login", { body: wrong(4), headers: XFF("3.3.3.3, 203.0.113.9, 127.0.0.1, ::1") })).status, 429, "trusted hops on the right are skipped");
    // Garbled: not an address, a port, a name, an empty hop: the proxy's own bucket (not a chosen one).
    for (const junk of ["not-an-ip", "203.0.113.9:4444", "evil.example", "203.0.113.9,", "999.1.1.1", "203.0.113.010"]) {
      const r = await w.call("POST", "/web/login", { body: wrong(7), headers: XFF(junk) });
      assert.ok(r.status === 401 || r.status === 429, junk);
    }
    // Two header lines are one list (node joins them): the rightmost still decides.
    const raw = (lines: string[]) => new Promise<number>((resolve, reject) => {
      const body = JSON.stringify(wrong(8));
      const req = request({ host: "127.0.0.1", port: w.port, method: "POST", path: "/web/login", headers: { host: `127.0.0.1:${w.port}`, "content-type": "application/json", "content-length": String(Buffer.byteLength(body)) } }, (res) => { res.resume(); res.on("end", () => resolve(res.statusCode!)); });
      req.on("error", reject);
      // Node's setHeader with an array sends two lines.
      req.setHeader("x-forwarded-for", lines); req.end(body);
    });
    assert.equal(await raw(["9.9.9.9", "203.0.113.9"]), 429, "two lines, the last one is the proxy's");
    assert.equal(await raw(["203.0.113.9", "8.8.8.8"]), 401, "the rightmost is another client with its own allowance");
  } finally { await w.c.close(); }
  // An IPv6 client is one bucket for its whole /64, so a prefix cannot be rotated.
  const v6 = await world({ trustedProxy: proxyOn, limits: { failedLoginsPerAddressPerMinute: 2 } });
  try {
    await v6.call("POST", "/web/login", { body: wrong(1), headers: XFF("2001:db8:1:2::1") });
    await v6.call("POST", "/web/login", { body: wrong(2), headers: XFF("2001:DB8:1:2:ffff::9") });
    assert.equal((await v6.call("POST", "/web/login", { body: wrong(3), headers: XFF("[2001:db8:1:2:abcd::1]") })).status, 429, "same /64, same bucket");
    assert.equal((await v6.call("POST", "/web/login", { body: wrong(3), headers: XFF("2001:db8:1:3::1") })).status, 401, "another /64");
  } finally { await v6.c.close(); }
  // x-real-ip is the only header read when it is the configured one.
  const real = await world({ trustedProxy: { addresses: ["127.0.0.1"], header: "x-real-ip" }, limits: { failedLoginsPerAddressPerMinute: 1 } });
  try {
    await real.call("POST", "/web/login", { body: wrong(1), headers: { "x-real-ip": "203.0.113.9", ...XFF("5.5.5.5") } });
    assert.equal((await real.call("POST", "/web/login", { body: wrong(2), headers: { "x-real-ip": "203.0.113.9", ...XFF("6.6.6.6") } })).status, 429, "x-forwarded-for is not the trusted header");
    assert.equal((await real.call("POST", "/web/login", { body: { token: real.token }, headers: { "x-real-ip": "198.51.100.1" } })).status, 200);
  } finally { await real.c.close(); }
});

test("a trusted proxy is validated at start: only IP literals on this machine or a private network, one known header, never a name, a range, a public or wildcard address", async () => {
  for (const bad of [{ addresses: [] }, { addresses: ["8.8.8.8"] }, { addresses: ["proxy.example"] }, { addresses: ["10.0.0.0/8"] }, { addresses: ["0.0.0.0"] }, { addresses: ["::"] }, { addresses: ["127.0.0.1:80"] }, { addresses: ["010.0.0.1"] }, { addresses: ["10.0.0.5"] }, { addresses: ["127.0.0.1"], header: "x-evil" }, { addresses: ["127.0.0.1", "8.8.4.4"] }, { addresses: Array.from({ length: 9 }, (_, i) => `127.0.0.${i + 1}`) }, "yes", null])
    await assert.rejects(world({ trustedProxy: bad as never }), (e: { field?: string }) => e.field === "trustedProxy", JSON.stringify(bad));
  assert.deepEqual(checkTrustedProxy({ addresses: ["127.0.0.1", "::ffff:127.0.0.1", "::1"] }, "loopback")?.addresses.size, 2, "the mapped spelling is the same address");
  assert.throws(() => checkTrustedProxy({ addresses: ["8.8.8.8"] }, "private"), (e: { field?: string }) => e.field === "trustedProxy", "a public address is never a proxy, on a private listener too");
  assert.throws(() => checkTrustedProxy({ addresses: ["100.64.1.1"] }, "loopback"), (e: { field?: string }) => e.field === "trustedProxy", "a private proxy cannot reach a loopback listener");
  assert.ok(checkTrustedProxy({ addresses: ["100.64.1.1", "fd7a:115c:a1e0::1"], header: "x-real-ip" }, "private"), "a private-network proxy for a private listener");
});

test("sign-in is limited per client AND over all addresses: a flood from many addresses stops at the ceiling, a valid pairing code still signs in, and the terminal chat is untouched", async () => {
  const w = await world({ trustedProxy: proxyOn, limits: { failedLoginsPerAddressPerMinute: 2, failedLoginsGlobalPerMinute: 6 } });
  try {
    const laptop = await w.signIn();
    const code = (await w.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} })).body.code as string;
    const code2 = (await w.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} })).body.code as string;
    for (let i = 0; i < 6; i += 1) assert.equal((await w.call("POST", "/web/login", { body: wrong(i), headers: XFF(`203.0.113.${i + 1}`) })).status, 401, `address ${i}`);
    const closed = await w.call("POST", "/web/login", { body: { token: w.token }, headers: XFF("198.51.100.7") });
    assert.equal(closed.status, 429, "the ceiling is reached: even a fresh address waits for its credential");
    assert.ok(Number(closed.headers["retry-after"]) >= 1);
    // The owner's pairing code is not a guess: it signs in whatever the counters say, for a flooded address too.
    assert.equal((await w.call("POST", "/web/login", { body: { code }, headers: XFF("198.51.100.7") })).status, 200);
    assert.equal((await w.call("POST", "/web/login", { body: { code: code2 }, headers: XFF("203.0.113.1") })).status, 200, "from a flooded address too");
    assert.equal((await w.call("POST", "/web/login", { body: { code: "ABCDEFGHJK" }, headers: XFF("198.51.100.8") })).status, 429, "a code that is not valid is a guess like any other");
    // The terminal chat is a different door.
    const turn = await w.c.chat!.submit(w.token, { messageId: "term-1", text: "/nimblenewt.nothing" });
    assert.ok(turn.turnId);
    w.now.t += 61_000;
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token }, headers: XFF("198.51.100.7") })).status, 200, "the minute passes and the ceiling lifts");
  } finally { await w.c.close(); }
  // Successful sign-ins give their attempt back at both levels.
  const ok = await world({ limits: { failedLoginsPerAddressPerMinute: 3, failedLoginsGlobalPerMinute: 3 } });
  try {
    for (let i = 0; i < 8; i += 1) await ok.signIn();
    assert.equal((await ok.call("POST", "/web/login", { body: wrong(1) })).status, 401);
  } finally { await ok.c.close(); }
});

test("a pairing code is tried only inside the limits: a client past its allowance, or code guesses past the code ceiling, gets no look at any code, so a right guess there signs nothing in and leaves the code usable", async () => {
  // Per client: the attacker's address is out of allowance; its next attempt, with the RIGHT code, is refused unseen and the code still works for the owner elsewhere.
  const w = await world({ trustedProxy: proxyOn, limits: { failedLoginsPerAddressPerMinute: 3, failedLoginsGlobalPerMinute: 100 } });
  try {
    const laptop = await w.signIn();
    const code = (await w.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} })).body.code as string;
    for (let i = 0; i < 3; i += 1) assert.equal((await w.call("POST", "/web/login", { body: { code: `WRONG${i}ABCD` }, headers: XFF("203.0.113.9") })).status, 401, `wrong code ${i} counts`);
    assert.equal((await w.call("POST", "/web/login", { body: { code }, headers: XFF("203.0.113.9") })).status, 429, "a client past its allowance has no code looked at, even the right one");
    assert.equal((await w.call("POST", "/web/login", { body: { code }, headers: XFF("198.51.100.7") })).status, 200, "the code was not used up by that refusal");
  } finally { await w.c.close(); }
  // Over all addresses: wrong codes from many addresses fill the code ceiling (10 x the failure ceiling); then no code is looked at from anywhere until the minute passes.
  const g = await world({ trustedProxy: proxyOn, limits: { failedLoginsPerAddressPerMinute: 50, failedLoginsGlobalPerMinute: 2 } });
  try {
    const laptop = await g.signIn();
    const code = (await g.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} })).body.code as string;
    const statuses: number[] = [];
    for (let i = 0; i < 20; i += 1) statuses.push((await g.call("POST", "/web/login", { body: { code: `WRONG${String(i).padStart(2, "0")}ABC` }, headers: XFF(`203.0.113.${i + 1}`) })).status);
    assert.equal(statuses.filter((s) => s === 401).length, 2, "wrong codes are failed sign-ins: the ordinary ceiling (2) answers the rest 429");
    assert.equal((await g.call("POST", "/web/login", { body: { code }, headers: XFF("198.51.100.7") })).status, 429, "20 code attempts in a minute: the code ceiling is full, the right code is not looked at");
    g.now.t += 61_000;
    assert.equal((await g.call("POST", "/web/login", { body: { code }, headers: XFF("198.51.100.7") })).status, 200, "the minute passes and the unused code still signs in");
  } finally { await g.c.close(); }
  // Below the code ceiling, a valid code still signs in after wrong credentials filled the ordinary ceiling (the owner's way in survives that flood).
  const f = await world({ trustedProxy: proxyOn, limits: { failedLoginsPerAddressPerMinute: 50, failedLoginsGlobalPerMinute: 2 } });
  try {
    const laptop = await f.signIn();
    const code = (await f.call("POST", "/web/pairings", { cookie: laptop.cookie, csrf: laptop.csrf, body: {} })).body.code as string;
    for (let i = 0; i < 5; i += 1) await f.call("POST", "/web/login", { body: wrong(i), headers: XFF(`203.0.113.${i + 1}`) });
    assert.equal((await f.call("POST", "/web/login", { body: { token: f.token }, headers: XFF("198.51.100.7") })).status, 429, "the ordinary ceiling is full");
    assert.equal((await f.call("POST", "/web/login", { body: { code }, headers: XFF("198.51.100.7") })).status, 200, "a valid code is not held by it");
  } finally { await f.c.close(); }
});

test("sign-in bodies are read a few at a time per address and overall, so a slow sender cannot hold every reader", async () => {
  const w = await world({ limits: { loginsReadingPerAddress: 2, loginsReadingGlobal: 3 } });
  try {
    const hung: ReturnType<typeof request>[] = [];
    const hang = () => new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port: w.port, method: "POST", path: "/web/login", headers: { host: `127.0.0.1:${w.port}`, "content-type": "application/json", "content-length": "400" } });
      req.on("error", () => undefined); req.write('{"token":"'); hung.push(req); setTimeout(resolve, 100);
    });
    await hang(); await hang();
    const third = await w.call("POST", "/web/login", { body: { token: w.token } });
    assert.equal(third.status, 429, "two readers from this address are busy");
    for (const r of hung) r.destroy();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token } })).status, 200, "readers free again");
  } finally { await w.c.close(); }
});

test("sign-in readers are also limited over all addresses", async () => {
  const w = await world({ trustedProxy: proxyOn, limits: { loginsReadingPerAddress: 2, loginsReadingGlobal: 3 } });
  try {
    const hung: ReturnType<typeof request>[] = [];
    const hang = (ip: string) => new Promise<void>((resolve) => {
      const req = request({ host: "127.0.0.1", port: w.port, method: "POST", path: "/web/login", headers: { host: `127.0.0.1:${w.port}`, "x-forwarded-for": ip, "content-type": "application/json", "content-length": "400" } });
      req.on("error", () => undefined); req.write('{"token":"'); hung.push(req); setTimeout(resolve, 100);
    });
    await hang("203.0.113.1"); await hang("203.0.113.2"); await hang("203.0.113.3");
    assert.equal((await w.call("POST", "/web/login", { body: { token: w.token }, headers: XFF("203.0.113.4") })).status, 429, "three readers are busy in all, though no one address has two");
    for (const r of hung) r.destroy();
  } finally { await w.c.close(); }
});

test("a message that applies a proposal ends with the session's error, not a refused outcome, and records nothing it did not do", async () => {
  const w = await world();
  try {
    const owner = await w.c.services.principals.authenticate(w.token);
    const saved = await w.c.chat!.propose(owner, { commandId: "pm1", source: "chat", reason: "test", preview: ["x"], steps: [{ op: "team.create", args: { name: "Amber" } }] });
    (w.interpreter as unknown as { interpret: unknown }).interpret = async (input: { text: string }) => [{ kind: "apply_proposal", proposalId: saved.id, evidence: input.text, basis: "owner" }];
    const ended = new Error("session ended");
    let looks = 0;
    await assert.rejects(w.c.chat!.submit(w.token, { messageId: "ap-1", text: "yes apply it" }, { stillAllowed: () => { looks += 1; if (looks === 3) throw ended; } }), (e: unknown) => e === ended);
    assert.doesNotMatch(JSON.stringify(await w.c.api.handle(w.token, { v: 1, op: "team.list", args: {} })), /Amber/);
    const ok = await w.c.chat!.submit(w.token, { messageId: "ap-1", text: "yes apply it" });
    assert.equal(ok.outcomes[0]!.status, "applied", JSON.stringify(ok));
  } finally { await w.c.close(); }
});

test("a request still running when its session is revoked applies nothing: the chat looks again before each state-changing step", async () => {
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void;
  const inside = new Promise<void>((r) => { entered = r; });
  const slow = new ScriptedInterpreter(() => []);
  const script = (text: string) => [{ kind: "command", op: "team.create", args: { name: "Blue" }, evidence: text, basis: "owner" }];
  (slow as unknown as { interpret: unknown }).interpret = async (input: { text: string }) => { entered(); await gate; return script(input.text); };
  const w = await world({}, slow);
  try {
    const phone = await w.signIn(); const laptop = await w.signIn();
    const teams = async () => JSON.stringify(await w.c.api.handle(w.token, { v: 1, op: "team.list", args: {} })).split("\"name\":\"Blue\"").length - 1;
    const pending = w.call("POST", "/web/chat", { cookie: phone.cookie, csrf: phone.csrf, body: { messageId: "slow-1", text: "make a team called Blue" } });
    await inside;
    const handle = (await w.call("GET", "/web/sessions", { cookie: laptop.cookie })).body.sessions.find((s: { current: boolean }) => !s.current).handle;
    assert.equal((await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { handle } })).status, 200);
    release();
    const r = await pending;
    assert.equal(r.status, 401, r.text);
    assert.match(String([r.headers["set-cookie"]].flat()[0]), /Max-Age=0/);
    assert.equal(await teams(), 0, "the revoked browser's request changed nothing");
    // The same message from a browser still signed in does apply (the guard stopped only the revoked one).
    const again = await w.call("POST", "/web/chat", { cookie: laptop.cookie, csrf: laptop.csrf, body: { messageId: "slow-2", text: "make a team called Blue" } });
    assert.equal(again.status, 201, again.text);
    assert.equal(await teams(), 1);
  } finally { release(); await w.c.close(); }
});

test("rotating the credential while a request runs also stops it before it changes anything", async () => {
  let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
  let entered!: () => void; const inside = new Promise<void>((r) => { entered = r; });
  const slow = new ScriptedInterpreter(() => []);
  (slow as unknown as { interpret: unknown }).interpret = async (input: { text: string }) => { entered(); await gate; return [{ kind: "command", op: "team.create", args: { name: "Green" }, evidence: input.text, basis: "owner" }]; };
  const w = await world({}, slow);
  try {
    const phone = await w.signIn();
    const pending = w.call("POST", "/web/chat", { cookie: phone.cookie, csrf: phone.csrf, body: { messageId: "rot-1", text: "make a team called Green" } });
    await inside;
    const owner = await w.c.services.principals.authenticate(w.token);
    await w.c.services.principals.issueCredential(owner, owner.id);
    release();
    assert.equal((await pending).status, 401);
  } finally { release(); await w.c.close(); }
});

test("applying a proposal re-checks before every step: a call that ends partway applies the steps before it and not the ones after, and applying again carries on", async () => {
  const w = await world();
  try {
    const owner = await w.c.services.principals.authenticate(w.token);
    const saved = await w.c.chat!.propose(owner, { commandId: "pg1", source: "chat", reason: "test", preview: ["two teams"], steps: [{ op: "team.create", args: { name: "Red" } }, { op: "team.create", args: { name: "Gold" } }] });
    let looks = 0;
    const ended = new Error("session ended");
    await assert.rejects(w.c.chat!.applyProposal(w.token, { commandId: "pa1", proposalId: saved.id }, { stillAllowed: () => { looks += 1; if (looks === 2) throw ended; } }), (e: unknown) => e === ended, "the guard's own error ends the call");
    const names = async () => JSON.stringify(await w.c.api.handle(w.token, { v: 1, op: "team.list", args: {} }));
    assert.match(await names(), /"Red"/); assert.doesNotMatch(await names(), /"Gold"/);
    const done = await w.c.chat!.applyProposal(w.token, { commandId: "pa1", proposalId: saved.id });
    assert.equal(done.applied, true);
    assert.match(await names(), /"Gold"/);
    assert.equal(JSON.stringify(await w.c.api.handle(w.token, { v: 1, op: "team.list", args: {} })).split("\"name\":\"Red\"").length - 1, 1, "Red was not made twice");
    // A discard looks too.
    const other = await w.c.chat!.propose(owner, { commandId: "pg2", source: "chat", reason: "test", preview: ["x"], steps: [{ op: "team.create", args: { name: "Pink" } }] });
    await assert.rejects(w.c.chat!.discardProposal(w.token, { commandId: "pd1", proposalId: other.id }, { stillAllowed: () => { throw ended; } }), (e: unknown) => e === ended);
    assert.equal((await w.c.chat!.discardProposal(w.token, { commandId: "pd1", proposalId: other.id })).replayed, false, "it was not discarded by the refused call");
  } finally { await w.c.close(); }
});

test("a proposal applied from a revoked browser is refused at the door", async () => {
  const w = await world();
  try {
    const phone = await w.signIn(); const laptop = await w.signIn();
    const owner = await w.c.services.principals.authenticate(w.token);
    const saved = await w.c.chat!.propose(owner, { commandId: "pr1", source: "chat", reason: "test", preview: ["x"], steps: [{ op: "team.create", args: { name: "Lilac" } }] });
    const handle = (await w.call("GET", "/web/sessions", { cookie: laptop.cookie })).body.sessions.find((s: { current: boolean }) => !s.current).handle;
    await w.call("POST", "/web/sessions/revoke", { cookie: laptop.cookie, csrf: laptop.csrf, body: { handle } });
    assert.equal((await w.call("POST", `/web/proposals/${saved.id}/apply`, { cookie: phone.cookie, csrf: phone.csrf, body: {}, headers: { "idempotency-key": "k1" } })).status, 401);
    assert.doesNotMatch(JSON.stringify(await w.c.api.handle(w.token, { v: 1, op: "team.list", args: {} })), /Lilac/);
  } finally { await w.c.close(); }
});

test("browsers are named by what they are, the settings page shows the binding, the proxy and the limits, and nothing secret", async () => {
  assert.equal(deviceLabel("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1"), "Safari on iPhone");
  assert.equal(deviceLabel("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0"), "Firefox on Windows");
  assert.equal(deviceLabel("Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 Edg/120.0"), "Edge on Linux");
  assert.equal(deviceLabel("curl/8"), "browser"); assert.equal(deviceLabel("\u0000\u0001<script>"), "browser");
  const w = await world({ trustedProxy: proxyOn });
  try {
    const s = await w.signIn();
    assert.equal((await w.call("GET", "/web/settings")).status, 401);
    const r = await w.call("GET", "/web/settings", { cookie: s.cookie });
    assert.equal(r.status, 200, r.text);
    assert.deepEqual([r.body.host, r.body.network, r.body.trustedProxy], ["127.0.0.1", "loopback", { enabled: true, addresses: ["127.0.0.1"], header: "x-forwarded-for" }]);
    assert.equal(r.body.limits.failedLoginsGlobalPerMinute, 100); assert.equal(r.body.browsers, 1);
    assert.equal(r.text.includes(w.token) || r.text.includes(s.cookie.split("=")[1]!) || r.text.includes(s.csrf), false, "no credential, cookie or CSRF token");
    assert.equal((await w.call("POST", "/web/settings", { cookie: s.cookie, csrf: s.csrf, body: {} })).status, 405, "read only");
  } finally { await w.c.close(); }
});

test("the owner signs browsers out by chat in free words: one by its name, all of them, ambiguity and no match are asked about, a repeat does nothing twice; the status kind lists them; an agent cannot", async () => {
  const script = new ScriptedInterpreter((input: { text: string }) => {
    if (/everything/.test(input.text)) return [{ kind: "command", op: "web.access.revoke", args: { all: true }, evidence: input.text, basis: "owner" }];
    if (/who is signed in/.test(input.text)) return [{ kind: "status", request: { kind: "web_access" }, evidence: input.text, basis: "owner" }];
    const word = /(iphone|windows|ipad|toaster)/i.exec(input.text)![1]!;
    return [{ kind: "command", op: "web.access.revoke", args: { browser: word }, evidence: input.text, basis: "owner" }];
  });
  const w = await world({}, script);
  try {
    const ua = (agent: string) => ({ "user-agent": agent });
    const mk = async (agent: string) => { const r = await w.call("POST", "/web/login", { body: { token: w.token }, headers: ua(agent) }); return { cookie: String([r.headers["set-cookie"]].flat()[0]).split(";")[0]!, csrf: r.body.csrf as string }; };
    const phone = await mk("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1");
    const pc1 = await mk("Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:120.0) Gecko/20100101 Firefox/120.0");
    const pc2 = await mk("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36");
    const say = (id: string, text: string, who = pc1) => w.call("POST", "/web/chat", { cookie: who.cookie, csrf: who.csrf, body: { messageId: id, text } });
    const listed = await say("c-0", "who is signed in to the web chat");
    assert.match(JSON.stringify(listed.body), /Safari on iPhone/); assert.match(JSON.stringify(listed.body), /3 browser\(s\) signed in/);
    assert.doesNotMatch(listed.text, new RegExp(phone.cookie.split("=")[1]!));
    const amb = await say("c-1", "sign my windows machine out");
    assert.equal(amb.body.outcomes[0].status, "refused", amb.text); assert.match(JSON.stringify(amb.body), /2 browsers match/);
    assert.equal((await w.call("GET", "/web/session", { cookie: pc2.cookie })).status, 200, "nothing was signed out by the ambiguous request");
    // The refusal names each match by its handle, and that handle signs out exactly that one (the owner cannot otherwise tell two "Windows" browsers apart).
    const named = /(ws-[0-9a-f]+) \(last used/.exec(String(amb.body.outcomes[0].message))?.[1];
    assert.ok(named !== undefined, amb.text);
    const pc2Handle = (await w.call("GET", "/web/session", { cookie: pc2.cookie })).body.handle as string;
    const pc2Named = String(amb.body.outcomes[0].message).includes(pc2Handle);
    assert.ok(pc2Named, "both matches are named by handle");
    assert.equal(w.c.webChat!.revokeBrowsers("owner:rob", { browser: pc2Handle }).revoked, 1);
    assert.equal((await w.call("GET", "/web/session", { cookie: pc2.cookie })).status, 401, "the one named by handle is out");
    assert.equal((await w.call("GET", "/web/session", { cookie: pc1.cookie })).status, 200, "the other Windows browser is not");
    const none = await say("c-2", "sign the toaster out");
    assert.equal(none.body.outcomes[0].status, "refused"); assert.match(JSON.stringify(none.body), /no signed-in browser matches/);
    const one = await say("c-3", "log my iphone out");
    assert.equal(one.body.outcomes[0].status, "applied", one.text);
    assert.equal((await w.call("GET", "/web/session", { cookie: phone.cookie })).status, 401, "the phone is out on its next request");
    assert.equal((await w.call("GET", "/web/session", { cookie: pc1.cookie })).status, 200);
    const again = await say("c-3", "log my iphone out");
    assert.equal(again.body.replayed, true);
    // The same command id again (the chat's own replay rule) does not sign out a browser that signed in since.
    const fresh = await mk("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1");
    const door = w.c.webChat!;
    assert.equal(door.revokeBrowsers("owner:rob", { browser: "ipad" }, undefined, "cmd-x").revoked, 1);
    const fresh2 = await mk("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) Version/17.0 Mobile Safari/604.1");
    assert.equal(door.revokeBrowsers("owner:rob", { browser: "ipad" }, undefined, "cmd-x").replayed, true);
    assert.equal((await w.call("GET", "/web/session", { cookie: fresh2.cookie })).status, 200, "a repeat of the command signs nobody else out");
    assert.throws(() => door.revokeBrowsers("owner:rob", { all: true }, undefined, "cmd-x"), (e: { code?: string }) => e.code === "command_conflict");
    void fresh;
    const all = await say("c-4", "sign everything out of the web chat");
    assert.equal(all.body.outcomes[0].status, "applied", all.text);
    assert.equal((await w.call("GET", "/web/session", { cookie: pc1.cookie })).status, 401);
    // The terminal chat still works, and an agent cannot do this.
    assert.ok((await w.c.chat!.submit(w.token, { messageId: "term-2", text: "/nimblenewt.nothing" })).turnId);
    const owner = await w.c.services.principals.authenticate(w.token);
    await w.c.services.principals.enroll(owner, { commandId: "e9", kind: "agent", name: "ann", grants: [] });
    const ann = (await w.c.services.principals.issueCredential(owner, "agent:ann")).token;
    for (const op of ["web.access.get", "web.access.revoke"]) {
      const r = await w.c.api.handle(ann, { v: 1, op, ...(op.endsWith("revoke") ? { commandId: "z1" } : {}), args: op.endsWith("revoke") ? { all: true } : {} });
      assert.equal(r.ok, false, op); assert.equal((r as { error: { code: string } }).error.code, "forbidden", op);
    }
    const read = await w.c.api.handle(w.token, { v: 1, op: "web.access.get", args: {} });
    assert.equal(read.ok, true); assert.doesNotMatch(JSON.stringify(read), /handle":"ws-[0-9a-f]+","label":"x"/);
  } finally { await w.c.close(); }
});

test("the chat's op table holds the web sign-out (applied at once, with the arguments the model is told); reading the settings is a status kind, not a command", () => {
  assert.equal(CHAT_OPS["web.access.revoke"]?.mode, "apply");
  for (const k of ["all", "browser"]) assert.ok(acceptedArgs("web.access.revoke")!.includes(k), k);
  assert.equal(CHAT_OPS["web.access.get"], undefined);
});
