import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { FakeDocument, type FakeElement } from "./fake-dom.js";
import { APP_JS } from "./index.js";

// Card U08b: the approvals and models pages, run as served against a fake document, with hostile text in every field an agent or a setting can fill.

const HOSTILE = `<img src=x onerror=alert(1)><script>alert(2)</script>"'\`${"$"}{alert(3)}</b>javascript:alert(4)`;
const LEAK = "sk-LEAK-0123456789";

class Storage { readonly map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }

interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }
type Handler = (call: Call) => { status: number; body: unknown } | undefined;

/** The page, running its real script against a fake controller. */
function boot(views: Record<string, unknown>, handlers: Handler[] = [], confirm: () => boolean = () => true) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const storage = new Storage();
  const fetch = async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { method: init.method, path, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const out = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (path === "/web/session") return out(200, { authenticated: true, csrf: "csrf-1", owner: "rob", expiresAt: "x" });
    for (const h of handlers) { const r = h(call); if (r !== undefined) return out(r.status, r.body); }
    const m = /^\/web\/views\/([a-z-]+)$/.exec(path);
    if (m !== null && views[m[1]!] !== undefined) return out(200, { view: m[1], observedAt: "2026-11-11T00:00:00Z", parts: views[m[1]!] });
    return out(404, { error: { code: "not_found", message: "no" } });
  };
  const timers: (() => void)[] = [];
  const sandbox: Record<string, unknown> = { document: doc, fetch, localStorage: storage, confirm, addEventListener() {}, setTimeout: (f: () => void) => { timers.push(f); return timers.length; }, clearTimeout: () => undefined };
  runInNewContext(APP_JS, sandbox);
  return { doc, calls, storage, timers, confirmWith: (f: () => boolean) => { sandbox["confirm"] = f; } };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const tab = (doc: FakeDocument, name: string): FakeElement => doc.body.find((e) => e.getAttribute("data-tab") === name)[0]!;
async function open(page: ReturnType<typeof boot>, name: string): Promise<FakeElement> { await settle(); tab(page.doc, name).click(); await settle(); return page.doc.byId.get("view")!; }

const approvalParts = (fill: (s: string) => string = (s) => s) => ({
  load: { item: { days: 7, ownerDecisions: 5, agentDecisions: 2, averageOwnerWaitMinutes: 12, decidedBy: { rule: 3, grant: 1, agentReview: 2, owner: 5, denied: 1 }, perDay: [{ day: fill("2026-11-10"), ownerDecisions: 3, agentDecisions: 1 }], pending: [{ reviewId: "r1", requester: fill("agent:ann"), tool: fill("git-push"), projectId: fill("proj-1"), waitingOn: fill("owner"), waitingMinutes: 130 }], pendingCount: 1 } },
  proposals: { items: [{ id: "spr-aaaaaaaaaaaaaaaaaaaa", revision: 3, requester: fill("agent:ann"), projectId: fill("proj-1"), cls: fill("commit"), environment: fill("development"), count: 3, state: "open", covered: [{ reviewId: "r1", tool: fill("git-commit"), at: fill("2026-11-10T10:00:00Z") }], suggestion: { action: "approve.class.commit", project: "proj-1", environments: ["development"], days: 7 }, lengthOptions: [1, 7, 30, 90], defaultLength: { days: 7, why: fill("you approved it over a week") }, createdAt: "x" }] },
  suggestion: { item: { due: true, kind: "switch", answers: ["switch", "trial", "not-now"], approvalsSince: 3, every: 3, preview: [fill("Approvals would be decided by rule first."), "Nothing else changes."], revision: 1 } },
});

const text = (e: FakeElement): string => e.textContent;

test("the approvals page shows the load, what waits and each open proposal with its lengths, as accessible tables and regions", async () => {
  const page = boot({ approvals: approvalParts() });
  const view = await open(page, "approvals");
  const t = text(view);
  assert.match(t, /You decided 5 times; agents decided 2 times\. Average wait for you: 12 min/);
  assert.match(t, /Asks still waiting \(1\)/); assert.match(t, /git-push/); assert.match(t, /2 h/);
  assert.match(t, /commit for agent:ann in project proj-1 \(development\)/);
  assert.match(t, /Suggested length: 7 days - you approved it over a week/);
  assert.match(t, /Move to the derived profile\?/); assert.match(t, /tell the chat: switch, trial, not-now/);
  assert.deepEqual(view.buttons().map((b) => b.textContent), ["Accept for 1 day", "Accept for 7 days (suggested)", "Accept for 30 days", "Accept for 90 days", "Dismiss"]);
  for (const b of view.buttons()) { assert.equal(b.type, "button"); assert.ok(b.getAttribute("aria-label")!.length > 0); }
  for (const tb of view.find((e) => e.tag === "table")) { assert.ok(tb.find((e) => e.tag === "caption").length === 1, "a caption"); assert.ok(tb.find((e) => e.tag === "th" && e.getAttribute("scope") === "col").length >= 2); }
  const regions = view.find((e) => e.tag === "section");
  assert.ok(regions.length >= 4);
  for (const r of regions) { const h = r.find((e) => e.tag === "h3")[0]!; assert.equal(r.getAttribute("aria-labelledby"), h.id, "a region is named by its heading"); }
  assert.deepEqual(page.doc.violations, []);
});

test("hostile text from an agent or a setting stays text in every field of both pages: no element, no attribute, no markup assignment", async () => {
  const page = boot({
    approvals: approvalParts((s) => HOSTILE + s),
    models: {
      routes: { item: undefined, revision: 1, routes: [{ route: `${HOSTILE}prov/${HOSTILE}model`, contextTokens: 8000, maxTokens: 1000 }, { route: "local/x", contextTokens: 4000 }] },
      controls: { controls: { entries: [{ level: HOSTILE, name: HOSTILE, mode: HOSTILE, reason: HOSTILE, since: HOSTILE, credentialName: LEAK }], failback: { x: LEAK } } },
      state: { item: { lines: [{ text: HOSTILE }, HOSTILE] } },
      difficulty: { item: { profiles: { [HOSTILE]: { harness: HOSTILE, provider: HOSTILE, model: HOSTILE, routingProfile: HOSTILE, reasoning: { effort: HOSTILE }, apiKey: LEAK, credentialName: LEAK, secret: LEAK }, plain: { provider: "a", model: "b", token: LEAK } }, mapping: { [HOSTILE]: HOSTILE, easy: "plain" } } },
    },
  });
  for (const name of ["approvals", "models"]) {
    const view = await open(page, name);
    const drawn = view.find(() => true);
    assert.ok(text(view).includes("<img src=x onerror=alert(1)>"), `${name}: the hostile text is shown, as text`);
    assert.deepEqual([...new Set(drawn.map((e) => e.tag))].filter((t) => !["div", "section", "h2", "h3", "h4", "p", "table", "caption", "thead", "tbody", "tr", "th", "td", "button"].includes(t)), [], `${name}: only the known tags are drawn`);
    for (const e of drawn) for (const [k, v] of e.attrs) assert.ok(!v.includes("<") || k === "aria-label", `${name}: ${k} holds no markup-looking data except the accessible name text`);
    for (const e of drawn) for (const [k] of e.attrs) assert.ok(!/^on/i.test(k) && k !== "href" && k !== "src" && k !== "style", `${name}: attribute ${k}`);
    assert.doesNotMatch(text(view), new RegExp(LEAK), `${name}: nothing secret-looking from the records is drawn`);
  }
  assert.deepEqual(page.doc.violations, []);
});

test("long strings are cut, so one agent cannot fill the page", async () => {
  const long = "x".repeat(5000);
  const page = boot({ approvals: approvalParts((s) => s + long) });
  const view = await open(page, "approvals");
  assert.ok(text(view).length < 6000, String(text(view).length));
});

test("a part that could not be read shows the controller's words as text and the other parts still show", async () => {
  const parts = approvalParts();
  const page = boot({ approvals: { ...parts, load: { error: { code: "forbidden", message: `${HOSTILE} only the owner` } } } });
  const view = await open(page, "approvals");
  assert.match(text(view), /Could not load: .*only the owner/);
  assert.match(text(view), /Accept for 7 days/);
  assert.deepEqual(view.find((e) => e.tag === "img" || e.tag === "script"), []);
});

test("Accept sends one decision under one key with the session's CSRF header and shows the chat's confirmation, which is applied only by Apply", async () => {
  const turn = { turnId: "turn-1", replayed: false, text: "Accept standing-rule proposal spr-aaaaaaaaaaaaaaaaaaaa for 7 days", reply: ["Here is what would happen. Nothing has changed yet."], outcomes: [{ status: "proposed", proposalId: "p-1", preview: ["Accept a standing-rule proposal: commit for agent:ann in project proj-1 (development), approved 3 times, open, suggested 7 days"] }] };
  const page = boot({ approvals: approvalParts() }, [(c) => (c.path.startsWith("/web/approvals/") ? { status: 201, body: turn } : undefined)]);
  const view = await open(page, "approvals");
  view.buttons().find((b) => b.textContent.startsWith("Accept for 7 days"))!.click();
  await settle();
  const sent = page.calls.filter((c) => c.path.startsWith("/web/approvals/"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.method, "POST"); assert.equal(sent[0]!.path, "/web/approvals/spr-aaaaaaaaaaaaaaaaaaaa/accept");
  assert.deepEqual(sent[0]!.body, { days: 7 });
  assert.equal(sent[0]!.headers["x-nn-csrf"], "csrf-1");
  assert.match(sent[0]!.headers["idempotency-key"]!, /^m[0-9a-f]{24}$/);
  // The chat tab now shows the sentence, the chat's reply and the proposal with Apply and Discard (which the existing outbox sends under their own key).
  const log = page.doc.byId.get("log")!;
  assert.match(text(log), /Accept standing-rule proposal spr-aaaaaaaaaaaaaaaaaaaa for 7 days/);
  assert.match(text(log), /Nothing has changed yet\./); assert.match(text(log), /suggested 7 days/);
  assert.deepEqual(log.buttons().map((b) => b.textContent), ["Apply", "Discard"]);
  assert.equal(page.doc.byId.get("chat")!.hidden, false);
  // The outbox keeps the item with its id, so a lost answer sends the same key again, never a second decision.
  const stored = JSON.parse(page.storage.map.get("nn.outbox.v1")!);
  assert.equal(stored[0].kind, "approval"); assert.equal(stored[0].state, "done");
});

test("a lost answer sends the same key again and a refusal is shown, not retried", async () => {
  let lose = 1;
  const seen: string[] = [];
  const page = boot({ approvals: approvalParts() }, [(c) => {
    if (!c.path.startsWith("/web/approvals/")) return undefined;
    seen.push(c.headers["idempotency-key"]!);
    if (lose-- > 0) throw new TypeError("connection lost");
    return { status: 400, body: { error: { code: "invalid_command", message: "days must be 1, 7, 30 or 90" } } };
  }]);
  const view = await open(page, "approvals");
  view.buttons().find((b) => b.textContent === "Accept for 30 days")!.click();
  await settle();
  const stored = () => JSON.parse(page.storage.map.get("nn.outbox.v1")!);
  assert.equal(stored()[0].state, "pending", "kept for another try");
  assert.equal(seen.length, 1);
  page.timers.shift()!();
  await settle();
  assert.equal(seen.length, 2); assert.equal(seen[1], seen[0], "the same key, so the controller runs it once");
  assert.equal(stored()[0].state, "failed", "a refusal is final");
  assert.match(text(page.doc.byId.get("log")!), /Not sent: days must be 1, 7, 30 or 90/);
  assert.equal(page.timers.length, 0, "and not retried");
});

test("Dismiss asks first; declining sends nothing, agreeing sends one dismissal", async () => {
  const done = { turnId: "t", replayed: false, text: "Dismiss standing-rule proposal spr-aaaaaaaaaaaaaaaaaaaa. Reason: turned down from the web page", reply: ["Done."], outcomes: [{ status: "applied" }] };
  const page = boot({ approvals: approvalParts() }, [(c) => (c.path.startsWith("/web/approvals/") ? { status: 201, body: done } : undefined)], () => false);
  const view = await open(page, "approvals");
  view.buttons().find((b) => b.textContent === "Dismiss")!.click();
  await settle();
  assert.equal(page.calls.filter((c) => c.path.startsWith("/web/approvals/")).length, 0, "declined: nothing sent");
  page.confirmWith(() => true);
  view.buttons().find((b) => b.textContent === "Dismiss")!.click();
  await settle();
  const sent = page.calls.filter((c) => c.path.startsWith("/web/approvals/"));
  assert.equal(sent.length, 1); assert.equal(sent[0]!.path, "/web/approvals/spr-aaaaaaaaaaaaaaaaaaaa/dismiss"); assert.deepEqual(sent[0]!.body, {});
  assert.match(text(page.doc.byId.get("log")!), /Reason: turned down from the web page/);
});

test("a proposal that is not open gets no buttons, and the id of a proposal is never put in a path unescaped", async () => {
  const parts = approvalParts();
  (parts.proposals.items as any[]).push({ ...(parts.proposals.items[0] as object), id: "spr-closed", state: "accepted" }, { ...(parts.proposals.items[0] as object), id: "../x?y#z", state: "open" });
  const page = boot({ approvals: parts }, [(c) => (c.path.startsWith("/web/approvals/") ? { status: 201, body: { turnId: "t", replayed: false, text: "t", reply: [], outcomes: [] } } : undefined)]);
  const view = await open(page, "approvals");
  assert.equal(view.buttons().filter((b) => b.textContent === "Dismiss").length, 2, "two open, the accepted one has none");
  view.buttons().filter((b) => b.textContent === "Dismiss")[1]!.click();
  await settle();
  assert.equal(page.calls.find((c) => c.path.startsWith("/web/approvals/"))!.path, "/web/approvals/..%2Fx%3Fy%23z/dismiss");
});

test("the models page shows each route with its effective values and where each comes from, what is switched off, and the profiles", async () => {
  const page = boot({ models: {
    routes: { revision: 2, routes: [{ route: "cloud/big", contextTokens: 200000, maxTokens: 8000, reasoningTokens: 2000 }, { route: "local/small", contextTokens: 8192 }] },
    controls: { controls: { entries: [{ level: "provider", name: "cloud", mode: "disabled", reason: "too costly", since: "2026-11-10" }], failback: {} } },
    state: { item: { lines: [{ text: "cloud is disabled since 2026-11-10" }] } },
    difficulty: { item: { profiles: { fast: { harness: "pi", provider: "local", model: "small", reasoning: { effort: "low" }, contextTokens: 8000, spendLimitMicros: 0 } }, mapping: { easy: "fast", unrated: "fast" } } },
  } });
  const view = await open(page, "models");
  const t = text(view);
  assert.match(t, /Providers and routes \(2\)/);
  assert.match(t, /8000 tokens \(set by you\)/); assert.match(t, /2000 tokens \(set by you\)/);
  assert.match(t, /not set: the agent's runtime decides/);
  assert.match(t, /200000 tokens \(from the routing table\)/);
  assert.match(t, /cloud.*disabled.*too costly/s); assert.match(t, /cloud is disabled since/);
  assert.match(t, /Every value was set by you|Profiles\. Every value was set by you/);
  assert.match(t, /no paid route/);
  assert.deepEqual(view.buttons(), [], "read only: nothing here changes anything");
  assert.ok(page.calls.every((c) => c.method === "GET"), "the page only read");
});

test("no routing table and no profiles are states, not failures", async () => {
  const page = boot({ models: { routes: { revision: 0, routes: [] }, controls: { controls: { entries: [] } }, state: { item: { lines: [] } }, difficulty: { error: { code: "not_found", message: "no such difficulty profiles" } } } });
  const view = await open(page, "models");
  assert.match(text(view), /No routing table has been set up yet/); assert.match(text(view), /Every route is in service/); assert.match(text(view), /No difficulty profiles are set/);
  assert.doesNotMatch(text(view), /Could not load/);
});

test("the tabs name the new pages and the page offers no control the chat lacks: the only changes it sends are decisions on standing-rule proposals", async () => {
  const page = boot({});
  await settle();
  const names = page.doc.body.find((e) => e.getAttribute("role") === "tab").map((e) => e.textContent);
  assert.deepEqual(names, ["Chat", "Status", "Needs you", "Approvals", "Models", "Blockers", "Cost", "Recovery", "Settings"]);
  // Each POST route the script uses; the new one is the approvals route, and its two actions are chat commands of the same names.
  const posts = [...APP_JS.matchAll(/call\('POST', '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(posts)].sort(), ["/web/approvals/", "/web/chat", "/web/login", "/web/logout", "/web/pairings", "/web/proposals/", "/web/sessions/revoke"]);
});

test("only the lengths the controller accepts become buttons, whatever a record says", async () => {
  const parts = approvalParts();
  (parts.proposals.items[0] as any).lengthOptions = [3650, 0, "7", 7, -1, 1.5, 30, null];
  const view = await open(boot({ approvals: parts }), "approvals");
  assert.deepEqual(view.buttons().map((b) => b.textContent), ["Accept for 7 days (suggested)", "Accept for 30 days", "Dismiss"]);
});
