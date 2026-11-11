import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { APP_CSS, APP_JS, INDEX_HTML, webChatAssets } from "./index.js";

// ---- the assets: what a phone browser and the controller's strict policy need ----------------------------------------------------

test("the page is a responsive, accessible shell with no inline code, which the controller's content security policy allows", () => {
  assert.match(INDEX_HTML, /<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/);
  assert.match(INDEX_HTML, /<html lang="en">/);
  assert.equal((INDEX_HTML.match(/<script\b[^>]*>/g) ?? []).every((t) => /\bsrc="\/app\.js"/.test(t)), true, "scripts are files");
  assert.doesNotMatch(INDEX_HTML.replace(/<script\b[^>]*><\/script>/g, ""), /<script/i, "no inline script");
  assert.doesNotMatch(INDEX_HTML, /<style|\sstyle=|\son[a-z]+=|javascript:/i, "no inline style, handler or javascript: URL");
  assert.doesNotMatch(INDEX_HTML, /https?:\/\//, "nothing is fetched from another origin");
  for (const id of ["gate", "app", "log", "composer", "text", "login", "secret", "tabs", "view", "net"]) assert.match(INDEX_HTML, new RegExp(`id="${id}"`), id);
  assert.match(INDEX_HTML, /<label for="text"/, "the message box has a label");
  assert.match(INDEX_HTML, /aria-live="polite"/);
  assert.match(INDEX_HTML, /type="password"[^>]*autocomplete="off"/, "the credential is not echoed and not remembered by the page");
});

test("the style is phone first: touch targets, no zoom on focus, safe areas, dynamic viewport height, dark mode and reduced motion", () => {
  assert.match(APP_CSS, /min-height:44px/);
  assert.match(APP_CSS, /input,select,textarea\{[^}]*font-size:16px/);
  assert.match(APP_CSS, /env\(safe-area-inset-bottom\)/);
  assert.match(APP_CSS, /100dvh/);
  assert.match(APP_CSS, /prefers-color-scheme:dark/);
  assert.match(APP_CSS, /prefers-reduced-motion/);
  assert.match(APP_CSS, /overflow-wrap:anywhere/, "a long word cannot widen the page");
  assert.doesNotMatch(APP_CSS, /@import|url\(\s*["']?https?:/, "no other origin");
  assert.doesNotMatch(APP_CSS, /width:\s*\d{4,}px/, "no fixed wide layout");
});

test("the script writes text only: no markup injection, no eval, no storage of the credential", () => {
  assert.doesNotMatch(APP_JS, /innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\(|new Function|setTimeout\(\s*["']/);
  assert.doesNotMatch(APP_JS, /localStorage\.setItem|sessionStorage|document\.cookie/, "the page never touches the cookie or keeps the credential");
  assert.doesNotMatch(APP_JS, /https?:\/\//, "every request is to the page's own origin");
});

test("the assets are what the controller serves: page, script, style and manifest, each with its type", () => {
  const a = webChatAssets();
  assert.deepEqual(Object.keys(a).sort(), ["/", "/app.css", "/app.js", "/manifest.webmanifest"]);
  assert.match(a["/"]!.type, /^text\/html/); assert.match(a["/app.js"]!.type, /javascript/); assert.match(a["/app.css"]!.type, /^text\/css/);
  for (const ref of [...INDEX_HTML.matchAll(/(?:src|href)="(\/[^"]*)"/g)].map((m) => m[1]!)) assert.ok(a[ref] !== undefined, `${ref} is served`);
  const manifest = JSON.parse(a["/manifest.webmanifest"]!.body);
  assert.equal(manifest.start_url, "/"); assert.equal(manifest.display, "standalone");
  assert.doesNotThrow(() => new Function(APP_JS), "the script parses");
});

// ---- the core: outbox and resume, against a stand-in for the controller ----------------------------------------------------------

interface Core {
  createOutbox(storage: unknown): any;
  createClient(deps: any): any;
  linesOf(value: unknown): string[];
}
const core = (): Core => {
  const sandbox: Record<string, unknown> = {}; runInNewContext(APP_JS, sandbox);
  const raw = (sandbox as { NNCore: Core }).NNCore;
  // Arrays made inside the script's own realm are copied into this one so they compare as plain arrays.
  return { createOutbox: raw.createOutbox, createClient: raw.createClient, linesOf: (v) => [...raw.linesOf(v)] };
};

class Storage { readonly map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }

/** What the controller does with the web chat, as far as the page can tell: a session with a CSRF header, a turn recorded under the message id, and failures on demand. */
class FakeController {
  signedIn = false; csrf = "csrf-1"; runs: string[] = []; turns = new Map<string, unknown>(); decisions = new Map<string, unknown>();
  down = false;           // the request never arrives
  loseReplies = 0;        // the request arrives and runs, but the answer is lost
  rejectWith: { status: number; code: string } | undefined;
  calls: string[] = [];
  fetch = async (path: string, init: { method: string; headers: Record<string, string>; body?: string }): Promise<{ status: number; text(): Promise<string> }> => {
    this.calls.push(`${init.method} ${path}`);
    if (this.down) throw new TypeError("network down");
    const out = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (path === "/web/login") { this.signedIn = true; return out(200, { authenticated: true, csrf: this.csrf, owner: "rob", expiresAt: "x" }); }
    if (path === "/web/session") return this.signedIn ? out(200, { authenticated: true, csrf: this.csrf, owner: "rob", expiresAt: "x" }) : out(401, { error: { code: "unauthenticated", message: "sign in first" } });
    if (!this.signedIn) return out(401, { error: { code: "unauthenticated", message: "sign in first" } });
    if (init.method !== "GET" && init.headers["x-nn-csrf"] !== this.csrf) return out(403, { error: { code: "csrf", message: "no csrf" } });
    if (this.rejectWith !== undefined) return out(this.rejectWith.status, { error: { code: this.rejectWith.code, message: "refused: " + this.rejectWith.code } });
    if (path === "/web/chat") {
      const { messageId, text } = JSON.parse(init.body!);
      const known = this.turns.get(messageId);
      const replayed = known !== undefined;
      if (!replayed) { this.runs.push(text); this.turns.set(messageId, { turnId: "turn-" + messageId, reply: ["done: " + text], outcomes: [] }); }
      if (this.loseReplies > 0) { this.loseReplies -= 1; throw new TypeError("connection lost"); }
      return out(replayed ? 200 : 201, { ...(this.turns.get(messageId) as object), replayed });
    }
    const m = /^\/web\/proposals\/([^/]+)\/(apply|discard)$/.exec(path);
    if (m !== null) {
      const key = init.headers["idempotency-key"]!;
      const replayed = this.decisions.has(key);
      if (!replayed) { this.runs.push(`${m[2]} ${m[1]}`); this.decisions.set(key, true); }
      return out(200, { proposalId: m[1], applied: m[2] === "apply", replayed, results: [] });
    }
    return out(404, { error: { code: "not_found", message: "no" } });
  };
}

const make = (server: FakeController, storage: Storage, extra: object = {}) => {
  const c = core();
  const timers: (() => void)[] = [];
  let n = 0;
  const client = c.createClient({ fetch: server.fetch, outbox: c.createOutbox(storage), newId: () => `id-${storage.map.size}-${n++}`, setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout: () => undefined, now: () => 1, ...extra });
  return { client, timers, c };
};
const settle = async (): Promise<void> => { for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r)); };

test("a message sent while the connection is down waits in the outbox and goes out, once, when it is back", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client, timers } = make(server, storage);
  await client.login({ token: "t" });
  server.down = true;
  client.say("pause the garden project");
  await settle();
  assert.equal(client.outbox.pending().length, 1, "kept");
  assert.equal(client.state.online, false);
  assert.equal(timers.length, 1, "a retry is scheduled");
  assert.equal(server.runs.length, 0);
  server.down = false;
  await client.resume();
  await settle();
  assert.deepEqual(server.runs, ["pause the garden project"]);
  assert.equal(client.outbox.pending().length, 0);
  assert.equal(client.outbox.items()[0].state, "done");
  assert.deepEqual([...client.outbox.items()[0].result.reply], ["done: pause the garden project"]);
});

test("a suspended connection that lost the ANSWER sends the same id again and nothing runs twice", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client, timers } = make(server, storage);
  await client.login({ token: "t" });
  server.loseReplies = 2;
  client.say("approve the budget");
  await settle();
  assert.deepEqual(server.runs, ["approve the budget"], "the first send reached the controller");
  assert.equal(client.outbox.pending().length, 1, "but the phone never heard, so it still holds the message");
  timers.shift()!(); await settle();
  assert.equal(client.outbox.pending().length, 1, "lost again");
  timers.shift()!(); await settle();
  assert.equal(client.outbox.pending().length, 0);
  assert.deepEqual(server.runs, ["approve the budget"], "three sends, one run");
  const ids = server.calls.filter((c) => c === "POST /web/chat").length;
  assert.equal(ids, 3);
  assert.equal(server.turns.size, 1);
});

test("a page closed and reopened mid-send resumes from the stored outbox with the same id", async () => {
  const server = new FakeController(); const storage = new Storage();
  const first = make(server, storage);
  await first.client.login({ token: "t" });
  server.loseReplies = 1;
  first.client.say("stop the night job");
  await settle();
  assert.equal(server.runs.length, 1);
  // The phone killed the page. A new page reads the same storage.
  const second = make(server, storage);
  assert.equal(second.client.outbox.pending().length, 1, "the unanswered message survived the reload");
  assert.equal(second.client.outbox.items()[0].state, "pending", "a send that was in flight is sent again, not lost");
  await second.client.session(); await second.client.flush(); await settle();
  assert.deepEqual(server.runs, ["stop the night job"]);
  assert.equal(second.client.outbox.items()[0].state, "done");
});

test("messages go out in the order they were written, one at a time, and the queue stops at the first one that cannot be answered", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client, timers } = make(server, storage);
  await client.login({ token: "t" });
  server.down = true;
  client.say("one"); client.say("two"); client.say("three");
  await settle();
  assert.equal(server.calls.filter((c) => c === "POST /web/chat").length, 1, "only the first was tried");
  server.down = false;
  timers.shift()!(); await settle();
  assert.deepEqual(server.runs, ["one", "two", "three"]);
});

test("a signed-out session keeps what was written and sends it, with the same ids, after the next sign-in", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client } = make(server, storage);
  await client.login({ token: "t" });
  server.signedIn = false; // revoked from another browser
  client.say("hello again");
  await settle();
  assert.equal(client.state.signedIn, false, "the page learns it is signed out");
  assert.equal(client.outbox.pending().length, 1);
  assert.equal(server.runs.length, 0);
  await client.login({ code: "ABCDEFGHJK" });
  await settle();
  assert.deepEqual(server.runs, ["hello again"]);
});

test("a CSRF refusal refreshes the session and tries again; a refusal that will not change is shown and never retried", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client } = make(server, storage);
  await client.login({ token: "t" });
  server.csrf = "csrf-2"; // the session's token was renewed behind the page's back
  client.say("after a renewal");
  await settle();
  assert.deepEqual(server.runs, ["after a renewal"]);
  server.rejectWith = { status: 400, code: "invalid_command" };
  client.say("the model refuses this"); client.say("and this too");
  await settle();
  const states = [...client.outbox.items().map((i: { state: string }) => i.state)];
  assert.deepEqual(states, ["done", "failed", "failed"]);
  assert.match(client.outbox.items()[1].error, /refused: invalid_command/);
  assert.equal(server.calls.filter((c) => c === "POST /web/chat").length, 4, "each failed message was tried once");
});

test("an approval is one decision under one key, however many times the phone sends it", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client, timers } = make(server, storage);
  await client.login({ token: "t" });
  server.down = true;
  client.decide("prop-1", "apply");
  await settle();
  server.down = false;
  timers.shift()!(); await settle();
  assert.deepEqual(server.runs, ["apply prop-1"]);
  const key = client.outbox.items()[0].id;
  assert.ok(server.decisions.has(key));
  assert.equal(client.outbox.items()[0].result.applied, true);
});

test("signing out forgets the outbox and the transcript on this phone", async () => {
  const server = new FakeController(); const storage = new Storage();
  const { client } = make(server, storage);
  await client.login({ token: "t" });
  client.say("something private"); await settle();
  assert.ok([...storage.map.values()].some((v) => v.includes("something private")));
  await client.logout();
  assert.equal(client.outbox.items().length, 0);
  assert.equal(storage.map.size, 0);
  assert.equal(client.state.signedIn, false);
});

test("the outbox survives unusable storage and keeps only the most recent answered items", () => {
  const c = core();
  const broken = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("full"); }, removeItem() { throw new Error("denied"); } };
  const o = c.createOutbox(broken);
  o.add({ id: "a", kind: "message", state: "pending", text: "x" });
  assert.equal(o.items().length, 1, "the page still works without storage");
  const s = new Storage(); const o2 = c.createOutbox(s);
  for (let i = 0; i < 130; i++) o2.add({ id: `m${i}`, kind: "message", state: "done", text: "x" });
  assert.equal(JSON.parse(s.map.get("nn.outbox.v1")!).length, 100);
  s.map.set("nn.outbox.v1", "{not json");
  assert.equal(c.createOutbox(s).items().length, 0, "a damaged store is ignored");
});

test("status results are shown as plain lines, and markup in them stays text", () => {
  const c = core();
  assert.deepEqual(c.linesOf({ lines: [{ text: "Task A is blocked", cites: [] }, "plain"] }), ["Task A is blocked", "plain"]);
  assert.deepEqual(c.linesOf({ items: [{ title: "T", summary: "waiting" }] }), ["items:", "  T: waiting"]);
  assert.deepEqual(c.linesOf({ note: "<img src=x onerror=alert(1)>" }), ["note: <img src=x onerror=alert(1)>"]);
  assert.deepEqual(c.linesOf(null), []);
});
