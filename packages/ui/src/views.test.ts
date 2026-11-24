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

test("the tabs name the new pages and the page offers no control the chat lacks: the only changes it sends are decisions on standing-rule proposals and the thinking switch", async () => {
  const page = boot({});
  await settle();
  const names = page.doc.body.find((e) => e.getAttribute("role") === "tab").map((e) => e.textContent);
  assert.deepEqual(names, ["Chat", "Status", "Needs you", "Approvals", "Models", "Blockers", "Cost", "Recovery", "Replay", "Setup", "Administration", "Settings"]);
  // Each POST route the script uses; the new one is the approvals route, and its two actions are chat commands of the same names.
  const posts = [...APP_JS.matchAll(/call\('POST', '([^']+)'/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(posts)].sort(), ["/web/admin/", "/web/approvals/", "/web/chat", "/web/login", "/web/logout", "/web/pairings", "/web/proposals/", "/web/replay/", "/web/sessions/revoke", "/web/thinking/collection"]);
  // The one other change the page sends is the write-only secret (card U08), by PUT to one named secret.
  assert.deepEqual([...APP_JS.matchAll(/call\('(PUT|DELETE|PATCH)', '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`), ["PUT /web/secrets/"]);
});

test("only the lengths the controller accepts become buttons, whatever a record says", async () => {
  const parts = approvalParts();
  (parts.proposals.items[0] as any).lengthOptions = [3650, 0, "7", 7, -1, 1.5, 30, null];
  const view = await open(boot({ approvals: parts }), "approvals");
  assert.deepEqual(view.buttons().map((b) => b.textContent), ["Accept for 7 days (suggested)", "Accept for 30 days", "Dismiss"]);
});

test("provider names that are also names of an object's own fields are counted as names (review)", async () => {
  const page = boot({ models: { routes: { revision: 1, routes: [{ route: "constructor/a" }, { route: "constructor/b" }, { route: "__proto__/c" }, { route: "toString/d" }] }, controls: { controls: { entries: [] } }, state: { item: { lines: [] } }, difficulty: { error: { code: "not_found", message: "none" } } } });
  const view = await open(page, "models");
  const providers = view.find((e) => e.tag === "table")[0]!;
  const rows = providers.find((e) => e.tag === "tr").slice(1).map((r) => r.children.map((c) => c.textContent));
  assert.deepEqual(rows, [["__proto__", "1"], ["constructor", "2"], ["toString", "1"]]);
  assert.doesNotMatch(text(view), /native code/);
});

test("a bidirectional override or an invisible character in a record is shown as its code, so it cannot turn the rest of a line around (review)", async () => {
  const page = boot({ approvals: approvalParts((s) => (s === "commit" ? "commit‮" : s === "git-commit" ? "git​-commit⁦" : s)) });
  const view = await open(page, "approvals");
  const t = text(view);
  assert.match(t, /commit\\u202e for agent:ann in project proj-1/);
  assert.match(t, /git\\u200b-commit\\u2066/);
  assert.doesNotMatch(t, /[‪-‮⁦-⁩​]/);
  for (const b of view.buttons()) assert.doesNotMatch(b.getAttribute("aria-label")!, /[‪-‮⁦-⁩]/);
});

test("the thinking switch shows the setting, asks first, and sends one fixed decision under one key; an unwired store is a state, not a button (card U09b)", async () => {
  const done = { turnId: "t", replayed: false, text: "Turn collecting the model's thinking off", reply: ["Done."], outcomes: [{ status: "applied" }] };
  const base = { routes: { revision: 1, routes: [] }, controls: { controls: { entries: [] } }, state: { item: { lines: [] } }, difficulty: { error: { code: "not_found", message: "none" } } };
  const page = boot({ models: { ...base, thinking: { item: { enabled: true, revision: 2 } } } }, [(c) => (c.path === "/web/thinking/collection" ? { status: 201, body: done } : undefined)], () => false);
  const view = await open(page, "models");
  assert.match(text(view), /Collected: the thinking of agents that work is kept/);
  const button = () => view.buttons().find((b) => b.textContent === "Stop collecting the thinking")!;
  assert.equal(button().type, "button"); assert.ok(button().getAttribute("aria-label")!.length > 0);
  button().click(); await settle();
  assert.equal(page.calls.filter((c) => c.method === "POST").length, 0, "declined: nothing sent");
  page.confirmWith(() => true);
  button().click(); await settle();
  const sent = page.calls.filter((c) => c.method === "POST");
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.path, "/web/thinking/collection"); assert.deepEqual(sent[0]!.body, { enabled: false });
  assert.match(sent[0]!.headers["idempotency-key"]!, /^m[0-9a-f]{24}$/); assert.equal(sent[0]!.headers["x-nn-csrf"], "csrf-1");
  assert.match(text(page.doc.byId.get("log")!), /Turn collecting the model's thinking off/);
  const offPage = boot({ models: { ...base, thinking: { item: { enabled: false, revision: 3 } } } });
  assert.ok((await open(offPage, "models")).buttons().some((b) => b.textContent === "Collect the thinking again"));
  const unwired = boot({ models: { ...base, thinking: { error: { code: "unavailable", message: "collected thinking is unavailable" } } } });
  const uv = await open(unwired, "models");
  assert.match(text(uv), /runs without the store/); assert.deepEqual(uv.buttons(), []); assert.doesNotMatch(text(uv), /Could not load/);
});

// ---- the settings and administration pages (card U08) -------------------------------------------------------------------------------

const LEAKED = "sk-LEAK-0123456789abcdef";
const sandboxFixture = (warn: boolean) => ({ item: { local: warn ? { os: "darwin", mechanism: "Seatbelt", boundary: "weaker", warn: true, limits: ["Seatbelt confines by what a process may touch; it is process-level and has weaker limits than Linux's bubblewrap."] } : { os: "linux", mechanism: "bubblewrap", boundary: "strong", warn: false, limits: ["Each agent gets its own view."] }, hosts: [{ hostId: "host:odd", os: "plan9", mechanism: "unknown", boundary: "unproven", warn: true, limits: ["unproven"], freshness: "fresh", identity: "active" }], warn: true, truncated: false } });
const settingsFixture = (fill: (s: string) => string = (s) => s) => ({ settings: { item: { scope: { layer: "installation", id: "installation" }, truncated: false, problems: [fill("the checkpoint is longer than the attempt")], items: [
  { key: "grants.maxDays", description: fill("The longest a standing grant may go unused."), kind: "default", effect: "next-request", installationOnly: false, value: 9, state: "set", source: { layer: "installation", id: "installation" }, editable: true },
  { key: "budget.paidAllowed", description: "Whether paid routes may be chosen.", kind: "restriction", effect: "next-request", installationOnly: false, value: true, state: "default", source: { layer: "default", id: "default" }, editable: true, note: "A restriction: a narrower layer can only tighten it, never widen it." },
  { key: "time.checkpointMinutes", description: "How often a checkpoint is written.", kind: "default", effect: "after-current-operation", installationOnly: false, value: 30, state: "locked", source: { layer: "installation", id: "installation" }, lockedBy: { layer: "installation", id: "installation" }, editable: true, note: "Locked by the installation layer: layers below it cannot change it." },
  { key: "workClass.pcFloor", description: "The least PC share.", kind: "default", effect: "next-request", installationOnly: false, state: "inherited", source: { layer: "team", id: "team.x" }, value: 20, editable: false },
] } } });
const sent = (page: ReturnType<typeof boot>) => page.calls.filter((c) => c.method !== "GET" && c.path !== "/web/session");
const inputOf = (view: FakeElement, label: string): FakeElement => { const l = view.find((e) => e.tag === "label" && e.textContent === label)[0]; assert.ok(l, `a label ${label}`); const id = l.getAttribute("for")!; const i = view.find((e) => e.id === id && e.tag !== "label")[0]; assert.ok(i, `an input for ${label}`); return i; };
const chip = (view: FakeElement, text: string): FakeElement => { const b = view.buttons().find((x) => x.textContent === text); assert.ok(b, `a button ${text}`); return b; };
async function admin(page: ReturnType<typeof boot>, section: string, label: string): Promise<FakeElement> {
  await settle(); tab(page.doc, "admin").click(); await settle();
  const view = page.doc.byId.get("view")!;
  if (section !== "setup") { chip(view, label).click(); await settle(); }
  return page.doc.byId.get("view")!;
}
const NAV = ["First run", "Settings", "Providers", "Secrets", "Agents and teams", "Policy", "API access", "Operations", "Sandbox", "Migration"];

test("the Administration tab has the ten sections, one at a time, each a named page reached from the same row of buttons (card U08)", async () => {
  const views: Record<string, unknown> = {
    "admin-setup": { readiness: { item: { ready: false, items: [] } }, suggestion: { item: { due: false } }, sandbox: sandboxFixture(false) },
    "admin-settings": settingsFixture(), "admin-providers": { providers: { item: { items: [], truncated: false } } }, "admin-secrets": { secrets: { item: { writable: false, items: [], truncated: false } } },
    "admin-team": { agents: { items: [] }, teams: { items: [] } }, "admin-policy": { readiness: { item: { items: [] } }, grants: { items: [] }, settings: { item: { items: [] } } },
    "admin-access": { web: { item: null }, local: { item: { enabled: false } }, sandbox: sandboxFixture(false) }, "admin-operations": { lifecycle: { item: { intent: "active" } }, sandbox: sandboxFixture(false) }, "admin-sandbox": { sandbox: sandboxFixture(true) }, "admin-migration": { migration: { item: { schemaVersion: 3, latestKnown: 3, migrations: [], upgrades: [], testedPairs: [] } }, policy: { item: {} } },
  };
  const page = boot(views);
  await settle(); tab(page.doc, "admin").click(); await settle();
  const view = page.doc.byId.get("view")!;
  assert.deepEqual(view.find((e) => e.tag === "nav")[0]!.buttons().map((b) => b.textContent), NAV);
  assert.match(text(view), /First run/);
  for (const [i, name] of ["admin-settings", "admin-providers", "admin-secrets", "admin-team", "admin-policy", "admin-access", "admin-operations", "admin-sandbox", "admin-migration"].entries()) {
    chip(page.doc.byId.get("view")!, NAV[i + 1]!).click(); await settle();
    const v = page.doc.byId.get("view")!;
    assert.equal(page.calls.at(-1)!.path, `/web/views/${name}`);
    assert.equal(v.find((e) => e.tag === "h2")[0]!.textContent.length > 0, true, name);
    assert.equal(v.find((e) => e.tag === "nav")[0]!.buttons().filter((b) => b.getAttribute("aria-pressed") === "true").map((b) => b.textContent).join(), NAV[i + 1], "the section in view is marked");
    for (const b of v.buttons()) assert.ok(b.type === "button" && b.getAttribute("aria-label") !== null || b.textContent.length > 0);
  }
  assert.deepEqual(page.doc.violations, []);
});

test("settings show the value, whether it is the default, set by you, inherited or locked, the layer it comes from, and when it counts, with hostile text drawn as text (card U08)", async () => {
  const page = boot({ "admin-settings": settingsFixture((s) => HOSTILE + s) });
  const view = await admin(page, "settings", "Settings");
  const t = text(view);
  assert.match(t, /Value: 9 - set by you \(from installation\); counts next request\./);
  assert.match(t, /Value: not set|Value: true - the default \(from default\)/);
  assert.match(t, /Value: 30 - locked \(from installation\)/); assert.match(t, /Locked by the installation layer/);
  assert.match(t, /Value: 20 - inherited \(from team\)/); assert.match(t, /Read here as an agent or project sees it/);
  assert.match(t, /after current operation/);
  assert.match(t, /These values do not fit together: .*the checkpoint is longer/);
  assert.match(t, /<script>alert\(2\)<\/script>/, "markup is shown as text");
  assert.deepEqual(page.doc.violations, []); assert.ok(![...page.doc.tags()].some((x) => /^(script|img|iframe|a)$/.test(x)), [...page.doc.tags()].join());
  // The filter narrows the list without a request.
  const before = page.calls.length;
  const f = inputOf(view, "Filter"); f.value = "budget"; f.listeners.get("input")![0]!({});
  assert.match(text(view), /budget\.paidAllowed/); assert.doesNotMatch(text(view), /grants\.maxDays/);
  assert.equal(page.calls.length, before, "filtering is local");
  f.value = "nothing-like-this"; f.listeners.get("input")![0]!({});
  assert.match(text(view), /No setting matches/);
});

test("a value the setting refuses is shown on the page with the error that names the setting: Apply comes back refused and the chat says which setting and why, and a refusal at the door says the same (card U08)", async () => {
  const sentence = "Set the setting grants.maxDays to 0 for the whole installation";
  const done = { turnId: "t", replayed: false, text: sentence, reply: ["Proposal"], outcomes: [{ status: "proposed", proposalId: "pedit-bad", preview: ["Set grants.maxDays to 0 for the whole installation."] }] };
  const failure = { step: 0, code: "invalid_command", message: "set.grants.maxDays: must be a whole number from 1 to 36500" };
  const page = boot({ "admin-settings": settingsFixture() }, [
    (c) => (c.path === "/web/admin/setting" ? { status: 201, body: done } : undefined),
    (c) => (c.path === "/web/proposals/pedit-bad/apply" ? { status: 200, body: { proposalId: "pedit-bad", applied: false, replayed: false, results: [], failure } } : undefined),
  ]);
  const view = await admin(page, "settings", "Settings");
  const card = view.find((e) => e.className === "card" && e.textContent.startsWith("grants.maxDays"))[0]!;
  card.find((e) => e.tag === "input")[0]!.value = "0";
  chip(card, "Change").click(); await settle();
  const log = page.doc.byId.get("log")!;
  log.buttons().find((b) => b.textContent === "Apply")!.click(); await settle();
  assert.match(text(log), /Apply proposal: failed - set\.grants\.maxDays: must be a whole number from 1 to 36500/);
  // A refusal the controller gives before anything is proposed (HTTP 400) is shown the same way: the error's own words, which name the setting.
  const page2 = boot({ "admin-settings": settingsFixture() }, [(c) => (c.path === "/web/admin/setting" ? { status: 400, body: { error: { code: "invalid_command", message: "grants.nope is not a setting this system has" } } } : undefined)]);
  const v2 = await admin(page2, "settings", "Settings");
  const c2 = v2.find((e) => e.className === "card" && e.textContent.startsWith("grants.maxDays"))[0]!;
  c2.find((e) => e.tag === "input")[0]!.value = "3";
  chip(c2, "Change").click(); await settle();
  assert.match(text(page2.doc.byId.get("log")!), /grants\.nope is not a setting this system has/);
});

test("a setting is changed from the page as one outbox item under one key, the chat shows it first, and 'back to default' asks first (card U08)", async () => {
  const done = { turnId: "t", replayed: false, text: "Set the setting grants.maxDays to 12 for the whole installation", reply: ["Proposal"], outcomes: [{ status: "proposed", proposalId: "pedit-aaaa", preview: ["Set grants.maxDays to 12 for the whole installation."] }] };
  const page = boot({ "admin-settings": settingsFixture() }, [(c) => (c.path === "/web/admin/setting" ? { status: 201, body: done } : undefined)], () => false);
  const view = await admin(page, "settings", "Settings");
  const card = view.find((e) => e.className === "card" && e.textContent.startsWith("grants.maxDays"))[0]!;
  const input = card.find((e) => e.tag === "input")[0]!;
  assert.equal(input.value, "9"); assert.match(input.getAttribute("aria-label")!, /New value of grants\.maxDays/);
  input.value = "12";
  chip(card, "Change").click(); await settle();
  const posts = sent(page);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0]!.method, posts[0]!.path, posts[0]!.body], ["POST", "/web/admin/setting", { key: "grants.maxDays", value: 12 }]);
  assert.match(posts[0]!.headers["idempotency-key"]!, /^m[0-9a-f]{24}$/); assert.equal(posts[0]!.headers["x-nn-csrf"], "csrf-1");
  assert.match(text(page.doc.byId.get("log")!), /Set the setting grants\.maxDays to 12 for the whole installation/, "the chat shows what was said and its preview");
  // Text that is not JSON is a string; nothing is sent for an empty field; a locked or default card has no reset.
  await open(page, "admin");
  const again = page.doc.byId.get("view")!;
  const c2 = again.find((e) => e.className === "card" && e.textContent.startsWith("grants.maxDays"))[0]!;
  c2.find((e) => e.tag === "input")[0]!.value = "";
  chip(c2, "Change").click(); await settle();
  assert.match(text(again), /Type the new value first/); assert.equal(sent(page).length, 1);
  chip(c2, "Back to default").click(); await settle();
  assert.equal(sent(page).length, 1, "declined: nothing sent");
  page.confirmWith(() => true);
  chip(c2, "Back to default").click(); await settle();
  assert.deepEqual(sent(page)[1]!.body, { key: "grants.maxDays", remove: true });
  const budget = again.find((e) => e.className === "card" && e.textContent.startsWith("budget.paidAllowed"))[0]!;
  assert.deepEqual(budget.buttons().map((b) => b.textContent), ["Change"], "a default value has nothing to put back");
});

test("providers show where each runs, its address, the NAME of its secret and whether it is set, never a key; one can be switched off, and one added with the secret's name only (card U08)", async () => {
  const fill = (s: string) => s;
  const providers = { providers: { item: { secretsWritable: true, truncated: false, items: [
    { name: fill("cloud-b"), location: "cloud", enabled: true, paid: true, endpoint: "https://api.example.test/v1", kind: "openai", credentialName: "cloud-b-key", secret: "not set", models: [{ route: "cloud-b/big", contextTokens: 65536 }] },
    { name: "local-a", location: "local", enabled: false, paid: false, endpoint: "http://127.0.0.1:8002/v1", secret: "none needed", models: [{ route: "local-a/m", contextTokens: 32768 }] },
  ] } }, secrets: { item: { writable: true, items: [{ name: "cloud-b-key", state: "not set", usedBy: ["provider cloud-b"] }] } } };
  const page = boot({ "admin-providers": providers });
  const view = await admin(page, "providers", "Providers");
  const t = text(view);
  assert.match(t, /cloud-b - on/); assert.match(t, /Runs cloud; costs money; address https:\/\/api\.example\.test\/v1 \(openai\)/); assert.match(t, /Secret cloud-b-key: not set/);
  assert.match(t, /local-a - off/); assert.match(t, /No secret needed\./); assert.match(t, /cloud-b\/big - 65536 tokens of context/);
  assert.doesNotMatch(t, new RegExp(LEAKED));
  chip(view, "Switch off").click(); await settle();
  assert.deepEqual([sent(page)[0]!.path, sent(page)[0]!.body], ["/web/admin/setting", { key: "provider.cloud-b.enabled", value: false }]);
  await open(page, "admin");
  const v2 = page.doc.byId.get("view")!;
  assert.ok(v2.buttons().some((b) => b.textContent === "Switch on"), "an off provider offers switching on");
  // The form: nothing is sent until the fields are filled; the body carries the NAME of the secret, never a value.
  chip(v2, "Add the provider").click(); await settle();
  assert.match(text(v2), /Fill in the name, the address/); assert.equal(sent(page).length, 1);
  inputOf(v2, "Name").value = "new-p"; inputOf(v2, "Where it runs").value = "cloud";
  inputOf(v2, "Server address (starts with http or https, for example a loopback address and port)").value = "https://x.example.test/v1";
  inputOf(v2, "Model names, separated by commas").value = "a, b";
  inputOf(v2, "The model's real context window, in tokens").value = "32768";
  inputOf(v2, "What the server is").value = "vllm"; inputOf(v2, "Cost").value = "paid";
  inputOf(v2, "Name of its secret (leave empty if none is needed)").value = "new-p-key";
  chip(v2, "Add the provider").click(); await settle();
  assert.deepEqual(sent(page)[1]!.body, { name: "new-p", location: "cloud", endpoint: "https://x.example.test/v1", models: ["a", "b"], contextTokens: 32768, kind: "vllm", paid: true, credentialName: "new-p-key" });
  assert.equal(sent(page)[1]!.path, "/web/admin/provider");
});

test("the Secrets form is write only: the value is sent once, the field is emptied before the request leaves, it is never kept in the browser, and an answer never shows it (card U08)", async () => {
  const secrets = { secrets: { item: { writable: true, truncated: false, items: [{ name: "cloud-b-key", state: "not set", usedBy: ["provider cloud-b"] }, { name: "other", state: "set", usedBy: ["provider x"] }] } } };
  let answer: { status: number; body: unknown } = { status: 200, body: { name: "cloud-b-key", set: true, replaced: false } };
  const page = boot({ "admin-secrets": secrets }, [(c) => (c.path === "/web/secrets/cloud-b-key" ? answer : undefined)]);
  const view = await admin(page, "secrets", "Secrets");
  assert.match(text(view), /cloud-b-key.*not set.*provider cloud-b/s); assert.match(text(view), /write-only/);
  const value = inputOf(view, "The secret (it is not shown again)");
  assert.equal(value.type, "password"); assert.equal(value.getAttribute("autocomplete"), "off");
  chip(view, "cloud-b-key").click();
  assert.equal(inputOf(view, "Name of the secret").value, "cloud-b-key", "an unset name fills in the name field");
  assert.ok(!view.buttons().some((b) => b.textContent === "other"), "only names that are not set are offered");
  chip(view, "Save the secret").click(); await settle();
  assert.match(text(view), /Give the name and the secret/); assert.equal(sent(page).length, 0);
  value.value = LEAKED;
  chip(view, "Save the secret").click();
  assert.equal(value.value, "", "the field is empty before the request is even answered");
  await settle();
  const put = sent(page);
  assert.equal(put.length, 1);
  assert.deepEqual([put[0]!.method, put[0]!.path, put[0]!.body], ["PUT", "/web/secrets/cloud-b-key", { value: LEAKED }]);
  assert.equal(put[0]!.headers["x-nn-csrf"], "csrf-1");
  assert.match(text(page.doc.byId.get("view")!), /Saved cloud-b-key\. The value is not shown again\./);
  const live = page.doc.byId.get("view")!.find((e) => e.getAttribute("role") === "status" && e.getAttribute("aria-live") === "polite");
  assert.ok(live.some((e) => /Saved cloud-b-key/.test(text(e))), "the outcome is in a live region, so a screen reader announces it");
  // Never kept: not in the outbox, not in storage, not on the page, not in the chat log.
  assert.ok(![...page.storage.map.values()].some((v) => v.includes(LEAKED)), "the browser keeps no copy");
  assert.doesNotMatch(text(page.doc.body), new RegExp(LEAKED));
  assert.equal(page.storage.map.get("nn.outbox.v1") === undefined || !page.storage.map.get("nn.outbox.v1")!.includes("PUT"), true);
  // A refusal is shown in the controller's words and the value is gone.
  answer = { status: 503, body: { error: { code: "unavailable", message: "the secret store did not take it" } } };
  const v2 = page.doc.byId.get("view")!;
  inputOf(v2, "Name of the secret").value = "cloud-b-key"; const field2 = inputOf(v2, "The secret (it is not shown again)"); field2.value = LEAKED;
  chip(v2, "Save the secret").click(); await settle();
  assert.match(text(v2), /Not saved: the secret store did not take it/); assert.equal(field2.value, "");
  assert.doesNotMatch(text(page.doc.body), new RegExp(LEAKED));
  // No store connected: no form, and the words say where a secret goes instead.
  const bare = boot({ "admin-secrets": { secrets: { item: { writable: false, items: [], truncated: false } } } });
  const bv = await admin(bare, "secrets", "Secrets");
  assert.match(text(bv), /secret store on the computer\. Never type it in chat/); assert.ok(!bv.buttons().some((b) => b.textContent === "Save the secret"));
});

// The model route item's detail at the length the setup readiness keeps it within (240 characters): routes too small to start a task, named and counted.
const MODEL_ROUTE_DETAIL = `2 enabled provider(s), 5 usable route(s); no task can start on any of them: ${"q".repeat(57)}... (65,536 tokens with a reply limit of 40,000; needs 74,752) and 4 more`.padEnd(240, "x");

test("the first-run page lists what is set up, explains the profiles in plain words, recommends derived for testing and development, and asks once (card U08)", async () => {
  const readiness = (profile: string) => ({ item: { ready: false, next: { id: "model-route", label: "A model route", how: "Add a provider on the Providers section." }, items: [
    { id: "owner", label: "Owner identity and credential", state: "done", required: true, detail: "rob" },
    { id: "project", label: "A project", state: "done", required: true, detail: "y".repeat(241) },
    { id: "profile", label: "Approval profile", state: profile === "strict" ? "default" : "done", required: false, detail: profile },
    { id: "model-route", label: "A model route", state: "missing", required: true, detail: MODEL_ROUTE_DETAIL } ] } });
  const page = boot({ "admin-setup": { readiness: readiness("strict (the default for a new installation)"), suggestion: { item: { due: true, preview: ["Approvals would be decided by rule first."] } }, sandbox: sandboxFixture(true) } });
  const view = await admin(page, "setup", "First run");
  const t = text(view);
  // A detail is shown whole up to the 240 characters the setup status kind shows too (the model route item's list of routes too small to start a task is kept within that); a longer one is cut.
  const cells = view.find((e) => e.tag === "td").map((c) => c.textContent);
  assert.ok(cells.includes(MODEL_ROUTE_DETAIL), cells.join(" | "));
  assert.ok(cells.includes(`${"y".repeat(237)}...`), "a detail over 240 characters is cut");
  assert.match(t, /Owner identity and credential.*done/s); assert.match(t, /Next: A model route\. Add a provider/);
  assert.match(t, /Strict asks at every consequential step\. Derived lets what you say authorize what it reasonably needs/);
  assert.match(t, /For testing and development work the derived profile is recommended/);
  assert.match(t, /Weaker sandbox: Seatbelt on darwin \(this computer\); unknown on plan9 \(host host:odd\)/);
  assert.match(t, /The system suggests the derived profile.*Approvals would be decided by rule first/s);
  assert.match(t, /Without a browser, the chat asks the same question/);
  assert.deepEqual(view.buttons().filter((b) => /profile|strict/i.test(b.textContent)).map((b) => b.textContent), ["Use the derived profile (recommended for testing and development)"], "strict is in force, so only the change is offered");
  chip(view, "Use the derived profile (recommended for testing and development)").click(); await settle();
  assert.deepEqual([sent(page)[0]!.path, sent(page)[0]!.body], ["/web/admin/profile", { to: "derived" }]);
  const derived = boot({ "admin-setup": { readiness: readiness("derived"), suggestion: { item: { due: false } }, sandbox: sandboxFixture(false) } });
  const dv = await admin(derived, "setup", "First run");
  assert.deepEqual(dv.buttons().filter((b) => /profile|strict/i.test(b.textContent)).map((b) => b.textContent), ["Stay strict"], "the profile in force is not offered again");
  assert.match(text(dv), /Weaker sandbox: unknown on plan9 \(host host:odd\)/, "the unproven host is warned about even when this computer is strong");
});

test("the sandbox section names each mechanism and warns about a weaker or unproven boundary; the warning is also on every page where the owner chooses where work runs (card U08, G01)", async () => {
  const page = boot({ "admin-sandbox": { sandbox: sandboxFixture(true) } });
  const view = await admin(page, "sandbox", "Sandbox");
  const rows = view.find((e) => e.tag === "tr").slice(1).map((r) => r.children.map((c) => c.textContent));
  assert.deepEqual(rows.map((r) => r.slice(0, 4)), [["This computer", "Seatbelt", "darwin", "weaker"], ["Host host:odd", "unknown", "plan9", "unproven"]]);
  assert.match(rows[0]![4]!, /process-level and has weaker limits than Linux/);
  assert.match(text(view), /Weaker sandbox: Seatbelt on darwin \(this computer\); unknown on plan9/);
  const strong = { item: { local: { os: "linux", mechanism: "bubblewrap", boundary: "strong", warn: false, limits: ["x"] }, hosts: [], warn: false, truncated: false } };
  const quiet = await admin(boot({ "admin-sandbox": { sandbox: strong } }), "sandbox", "Sandbox");
  assert.doesNotMatch(text(quiet), /Weaker sandbox/); assert.match(text(quiet), /bubblewrap/);
  const none = await admin(boot({ "admin-sandbox": { sandbox: { item: { hosts: [], warn: false, truncated: false } } } }), "sandbox", "Sandbox");
  assert.match(text(none), /no sandbox is in use yet/);
  for (const [name, label, fixture] of [["admin-access", "API access", { web: { item: null }, local: { item: { enabled: true } } }], ["admin-operations", "Operations", { lifecycle: { item: { intent: "active" } } }]] as const) {
    const p = boot({ [name]: { ...fixture, sandbox: sandboxFixture(true) } });
    assert.match(text(await admin(p, name, label)), /Weaker sandbox: Seatbelt on darwin/, `${name} warns`);
  }
});

test("agents and teams, policy, API access, operations and migration are drawn from their records as tables and plain lines, and a hostile value is only text (card U08)", async () => {
  const H = HOSTILE;
  const page = boot({
    "admin-team": { agents: { items: [{ id: "agt-a", friendlyName: H, roles: ["author", "reviewer"], teamId: "team-t", state: "active", defaultProfile: "default", coordinator: { state: "running" } }] }, teams: { items: [{ id: "team-t", name: "builders", parentTeamId: undefined }] } },
    "admin-policy": { readiness: { item: { items: [{ id: "profile", detail: "derived" }] } }, grants: { items: [{ grantee: "agent:ann", action: "approve.class.commit", project: "proj-1", state: "active", basis: H }] }, settings: { item: { items: settingsFixture().settings.item.items.slice(0, 1) } } },
    "admin-access": { web: { item: { settings: { host: "127.0.0.1", port: 8443, network: "loopback", tls: false, behindTlsProxy: true, publicHosts: ["newt.example.ts.net"], trustedProxy: { enabled: false } }, browsers: [{ label: H, createdAt: "2026-11-10", lastSeen: "2026-11-11" }] } }, local: { item: { enabled: true } } },
    "admin-operations": { lifecycle: { item: { intent: "paused", reason: H } }, workers: { item: { effective: { cpus: 2 } } }, capacity: { item: { x: 1 } } },
    "admin-migration": { migration: { item: { schemaVersion: 3, latestKnown: 4, rollbackPeriod: { days: 7, open: true, until: "2026-11-20" }, contract: { waiting: true, refusals: ["rollback period still open"] }, migrations: [{ version: 4, name: H, kind: "destructive", state: "deferred" }], upgrades: [{ at: "2026-11-01", from: 2, to: 3, additiveOnly: true }], testedPairs: [{ release: "1.4.0", schema: 3, at: "2026-11-02" }] } }, policy: { item: { rollbackPeriodDays: 7, probationMinutes: 60, maxReleaseFailures: 2, hostRetries: 3 } },
      compat: { item: { status: "attention", runtime: { node: { running: "22.19.0", minimum: "22.19.0", supported: true }, protocol: { min: 1, max: 2 } }, hosts: [
        { hostId: "host:old", state: "older", protocol: 1, workerVersion: H, note: "It speaks worker protocol 1.", agents: ["Ann (agent:a1)", H], agentsMore: 3, operations: ["running a catalogue tool on the host (script run)"], operationsMore: 1 },
        { hostId: "host:ok", state: "current", protocol: 2, note: "newest", agents: [], agentsMore: 0, operations: [], operationsMore: 0 }],
        migration: { schemaVersion: 3, latestKnown: 4, note: "1 migration waits.", pending: [{ version: 4, name: "drop_b", kind: "destructive", state: "deferred" }], agents: ["Ann (agent:a1)"], agentsMore: 0, operations: ["attempt att-0 of Ann"], operationsMore: 0 }, problems: ["the hosts: unavailable"] } } },
  });
  const team = await admin(page, "team", "Agents and teams");
  assert.match(text(team), /<script>alert\(2\)<\/script>.*author, reviewer.*team-t.*active.*running/s); assert.match(text(team), /builders/);
  const policy = await admin(page, "policy", "Policy");
  assert.match(text(policy), /In force: derived\./); assert.deepEqual(policy.buttons().filter((b) => /profile|strict/i.test(b.textContent)).map((b) => b.textContent), ["Stay strict"]);
  assert.match(text(policy), /agent:ann.*approve\.class\.commit.*proj-1.*active/s); assert.match(text(policy), /grants\.maxDays/);
  const access = await admin(page, "access", "API access");
  assert.match(text(access), /Listens on 127\.0\.0\.1:8443, reachable from this machine only/); assert.match(text(access), /Behind a TLS proxy/); assert.match(text(access), /newt\.example\.ts\.net/);
  assert.match(text(access), /It is turned on: agents run on this computer/);
  const ops = await admin(page, "operations", "Operations");
  assert.match(text(ops), /Running or paused/); assert.match(text(ops), /intent: paused/); assert.match(text(ops), /cpus: 2/);
  const mig = await admin(page, "migration", "Migration");
  assert.match(text(mig), /schema 3; this version knows 4/); assert.match(text(mig), /Rollback period: 7 days, open until 2026-11-20/); assert.match(text(mig), /Destructive migrations are waiting for your approval/);
  assert.match(text(mig), /rollback period still open/); assert.match(text(mig), /Tested pairs/); assert.match(text(mig), /Rollout policy/); assert.match(text(mig), /Failures before going back: 2/);
  assert.match(text(mig), /Something is not current/); assert.match(text(mig), /Node\.js 22\.19\.0 is running; this version needs 22\.19\.0 or newer: met\./); assert.match(text(mig), /worker protocol 1 to 2/);
  assert.match(text(mig), /host:old.*older.*It speaks worker protocol 1/s); assert.match(text(mig), /Affected by host host:old/); assert.doesNotMatch(text(mig), /Affected by host host:ok/);
  assert.match(text(mig), /Agents affected: Ann \(agent:a1\); .*alert\(2\).* and 3 more\./); assert.match(text(mig), /Operations affected: running a catalogue tool on the host \(script run\) and 1 more\./);
  assert.match(text(mig), /Schema 3 of 4\. 1 migration waits\./); assert.match(text(mig), /Affected by the waiting migrations/); assert.match(text(mig), /Operations affected: attempt att-0 of Ann\./);
  assert.match(text(mig), /Not read: the hosts: unavailable/);
  assert.deepEqual(page.doc.violations, []);
  assert.ok(![...page.doc.tags()].some((x) => /^(script|img|iframe|a)$/.test(x)));
  for (const tb of mig.find((e) => e.tag === "table")) assert.equal(tb.find((e) => e.tag === "caption").length, 1, "every table has a caption");
});

test("an error on a part of an administration page is the controller's plain words and does not hide the rest (card U08)", async () => {
  const page = boot({ "admin-providers": { providers: { error: { code: "forbidden", message: "only the owner does" } }, secrets: { item: { writable: false, items: [] } } }, "admin-settings": { settings: { error: { code: "unavailable", message: "the administration views are not available" } } } });
  const prov = await admin(page, "providers", "Providers");
  assert.match(text(prov), /Could not load: only the owner does/);
  chip(prov, "Settings").click(); await settle();
  assert.match(text(page.doc.byId.get("view")!), /Could not load: the administration views are not available/);
});

// Follow-up to card U08: the agents and the standing rights can be edited and taken back from the Administration page, through the same outbox and the chat's own preview.
const AGT = "agt-" + "a".repeat(20), AGT2 = "agt-" + "c".repeat(20), GRT = "grt-" + "b".repeat(20), GRT2 = "grt-" + "d".repeat(20);
const ownerEditViews = () => ({
  "admin-team": { agents: { items: [{ id: AGT, friendlyName: "Ann", roles: ["author"], state: "active" }, { id: AGT2, friendlyName: "Old Bob", roles: ["qa"], state: "retired" }] }, teams: { items: [] } },
  "admin-policy": { readiness: { item: { items: [{ id: "profile", detail: "derived" }] } }, grants: { items: [{ id: GRT, grantee: "agent:ann", action: "task.update", project: "proj-1", state: "active", basis: HOSTILE }, { id: GRT2, grantee: "agent:old", action: "task.create", state: "revoked", basis: "x" }] }, settings: { item: { items: [] } } },
});
const queuedWith = (text: string) => ({ turnId: "t", replayed: false, text, reply: ["Proposal"], outcomes: [{ status: "proposed", proposalId: "prop-1", preview: ["It would change."] }] });
const live = (view: FakeElement): FakeElement => { const r = view.find((e) => e.getAttribute("role") === "status" && e.getAttribute("aria-live") === "polite"); assert.equal(r.length, 1, "one live region"); return r[0]!; };

test("an agent is renamed or given other roles from the page: one outbox item under one key, exact body, a clear refusal when nothing differs or a role is not a name, and a retired agent has no form (card U08 follow-up)", async () => {
  const page = boot(ownerEditViews(), [(c) => (c.path === "/web/admin/agent" ? { status: 201, body: queuedWith("Change the agent Ann to be called Annie with the roles author, reviewer") } : undefined)]);
  const team = await admin(page, "team", "Agents and teams");
  const cards = team.find((e) => e.className === "card" && e.textContent.startsWith("Edit "));
  assert.deepEqual(cards.map((c) => c.find((e) => e.tag === "h4")[0]!.textContent), ["Edit Ann"], "only the active agent is editable");
  const form = cards[0]!;
  assert.equal((inputOf(form, "Name of Ann") as FakeElement).value, "Ann"); assert.equal(inputOf(form, "Roles of Ann (separated by commas)").value, "author");
  assert.equal(chip(form, "Change agent").getAttribute("aria-label"), "Change the name or roles of Ann");
  chip(form, "Change agent").click(); await settle();
  assert.match(text(live(team)), /Nothing is different/); assert.equal(sent(page).length, 0);
  inputOf(form, "Roles of Ann (separated by commas)").value = "author, Not A Name";
  chip(form, "Change agent").click(); await settle();
  assert.match(text(live(team)), /Roles are 1 to 20 different names/); assert.equal(sent(page).length, 0);
  inputOf(form, "Roles of Ann (separated by commas)").value = "author, author";
  chip(form, "Change agent").click(); await settle();
  assert.match(text(live(team)), /different names/); assert.equal(sent(page).length, 0);
  // Review: an emptied role list is refused, never sent as no roles or quietly dropped; an emptied name is refused, never left out without a word.
  inputOf(form, "Roles of Ann (separated by commas)").value = " , ";
  chip(form, "Change agent").click(); await settle();
  assert.match(text(live(team)), /Roles are 1 to 20 different names/); assert.equal(sent(page).length, 0);
  inputOf(form, "Roles of Ann (separated by commas)").value = "author, reviewer";
  inputOf(form, "Name of Ann").value = "  ";
  chip(form, "Change agent").click(); await settle();
  assert.match(text(live(team)), /needs a name/); assert.equal(sent(page).length, 0);
  inputOf(form, "Name of Ann").value = 'Ann "the" best';
  inputOf(form, "Roles of Ann (separated by commas)").value = "author";
  chip(form, "Change agent").click(); await settle();
  assert.match(text(live(team)), /quote or a backslash/); assert.equal(sent(page).length, 0);
  inputOf(form, "Name of Ann").value = "Annie";
  inputOf(form, "Roles of Ann (separated by commas)").value = "author, reviewer";
  chip(form, "Change agent").click(); await settle();
  const posts = sent(page);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0]!.method, posts[0]!.path, posts[0]!.body], ["POST", "/web/admin/agent", { agentId: AGT, friendlyName: "Annie", roles: ["author", "reviewer"] }]);
  assert.match(posts[0]!.headers["idempotency-key"]!, /^m[0-9a-f]{24}$/); assert.equal(posts[0]!.headers["x-nn-csrf"], "csrf-1");
  assert.match(text(page.doc.byId.get("log")!), /Change the agent Ann to be called Annie with the roles author, reviewer/, "the chat shows what was asked");
  // Only what differs is sent.
  await open(page, "admin");
  const again = page.doc.byId.get("view")!.find((e) => e.className === "card" && e.textContent.startsWith("Edit "))[0]!;
  inputOf(again, "Roles of Ann (separated by commas)").value = "author, qa";
  chip(again, "Change agent").click(); await settle();
  assert.deepEqual(sent(page)[1]!.body, { agentId: AGT, roles: ["author", "qa"] });
  assert.notEqual(sent(page)[0]!.headers["idempotency-key"], sent(page)[1]!.headers["idempotency-key"], "each edit has its own key");
  // Review: a rename alone sends no roles, so the agent's role list is left exactly as it is.
  await open(page, "admin");
  const third = page.doc.byId.get("view")!.find((e) => e.className === "card" && e.textContent.startsWith("Edit "))[0]!;
  inputOf(third, "Name of Ann").value = " Anne ";
  chip(third, "Change agent").click(); await settle();
  assert.deepEqual(sent(page)[2]!.body, { agentId: AGT, friendlyName: "Anne" });
  assert.deepEqual(page.doc.violations, []);
});

test("a standing right is taken back from the page with the owner's reason, after a question, as one outbox item; a revoked right has no button (card U08 follow-up)", async () => {
  const page = boot(ownerEditViews(), [(c) => (c.path === "/web/admin/grant-revoke" ? { status: 201, body: queuedWith("Take back the right task.update for agent:ann") } : undefined)], () => false);
  const policy = await admin(page, "policy", "Policy");
  const cards = policy.find((e) => e.className === "card" && e.textContent.startsWith("Take back: "));
  assert.deepEqual(cards.map((c) => c.find((e) => e.tag === "h4")[0]!.textContent), ["Take back: task.update for agent:ann in proj-1"], "the revoked right has no button");
  const form = cards[0]!;
  const why = inputOf(form, "Why take back task.update for agent:ann in proj-1?");
  assert.equal(why.getAttribute("maxlength"), "300");
  chip(form, "Take back").click(); await settle();
  assert.match(text(live(policy)), /Say why first/); assert.equal(sent(page).length, 0);
  why.value = "the project is finished";
  chip(form, "Take back").click(); await settle();
  assert.equal(sent(page).length, 0, "declined: nothing sent");
  // Second review: the reason may not hold invisible or text-direction characters, and the question names the project and the right's ID.
  why.value = "finished\u202e";
  chip(form, "Take back").click(); await settle();
  assert.match(text(live(policy)), /invisible or text-direction/); assert.equal(sent(page).length, 0);
  why.value = "the project is finished";
  const asked: string[] = [];
  page.confirmWith(((q: string) => { asked.push(q); return true; }) as never);
  chip(form, "Take back").click(); await settle();
  assert.equal(asked.length, 1);
  assert.match(asked[0]!, new RegExp(`^Take back task\\.update for agent:ann in proj-1 \\(${GRT}\\)\\? Which running work relies on this right could not be checked just now\\. Work that relies on it may stop`));
  const posts = sent(page);
  assert.equal(posts.length, 1);
  assert.deepEqual([posts[0]!.method, posts[0]!.path, posts[0]!.body], ["POST", "/web/admin/grant-revoke", { grantId: GRT, reason: "the project is finished" }]);
  assert.match(posts[0]!.headers["idempotency-key"]!, /^m[0-9a-f]{24}$/); assert.equal(posts[0]!.headers["x-nn-csrf"], "csrf-1");
  assert.match(text(page.doc.byId.get("log")!), /Take back the right task\.update for agent:ann/);
  assert.ok(![...page.doc.tags()].some((x) => /^(script|img|iframe|a)$/.test(x)));
  assert.deepEqual(page.doc.violations, []);
});

// Follow-up to card T7: the running work that may rely on a right is shown on its take-back card and in the question asked before it is sent.
const work = (n: number) => Array.from({ length: n }, (_, i) => ({ agentId: "ann", taskId: "task-" + String(i).padStart(20, "a"), title: i === 0 ? HOSTILE : "Chore " + i, projectId: "proj-1", attemptId: "att-" + i, attemptNumber: i + 1 }));
const relyViews = (reliance: unknown) => { const v = ownerEditViews(); (v["admin-policy"] as Record<string, unknown>)["reliance"] = reliance; return v; };
const takeBack = async (reliance: unknown) => {
  const asked: string[] = [];
  const page = boot(relyViews(reliance), [(c) => (c.path === "/web/admin/grant-revoke" ? { status: 201, body: queuedWith("Take back") } : undefined)], () => true);
  const policy = await admin(page, "policy", "Policy");
  const form = policy.find((e) => e.className === "card" && e.textContent.startsWith("Take back: "))[0]!;
  inputOf(form, "Why take back task.update for agent:ann in proj-1?").value = "all done";
  page.confirmWith(((q: string) => { asked.push(q); return true; }) as never);
  chip(form, "Take back").click(); await settle();
  return { page, form, asked, shown: form.find((e) => e.className === "card-line").map((e) => e.textContent) };
};

test("the take-back card lists the running work that may rely on the right, ten at most with the rest counted, and the question repeats it (follow-up to card T7)", async () => {
  const got = await takeBack({ items: [{ grantId: GRT, total: 12, complete: true, items: work(10) }, { grantId: "grt-" + "e".repeat(20), total: 0, complete: true, items: [] }] });
  assert.equal(got.shown[0], "Running work that relies on it");
  assert.equal(got.shown[1], "12 running tasks may rely on it:");
  assert.equal(got.shown.filter((l) => /^".*" \(task task-a+\d, agent ann, attempt \d+\)$/.test(l)).length, 10);
  assert.equal(got.shown[12], "2 more not listed.");
  assert.match(got.shown[2]!, /^"/);
  assert.equal(got.asked.length, 1);
  assert.match(got.asked[0]!, /\? 12 running tasks may rely on it: "[^]*" \(task task-a+\d, agent ann, attempt 1\)[^]* Work that relies on it may stop/s);
  assert.doesNotMatch(got.asked[0]!, /Chore 3/, "the question names the first few, the card the ten");
  assert.equal(sent(got.page).length, 1);
  assert.deepEqual(got.page.doc.violations, []);
  assert.ok(![...got.page.doc.tags()].some((x) => /^(script|img|iframe|a)$/.test(x)), "a title is only text");
});

test("the take-back card says so when nothing runs, when not every record could be read, when the right is not in the read and when the read failed (follow-up to card T7)", async () => {
  const none = await takeBack({ items: [{ grantId: GRT, total: 0, complete: true, items: [] }] });
  assert.deepEqual(none.shown.slice(0, 2), ["Running work that relies on it", "No running work relies on it."]);
  assert.match(none.asked[0]!, /^Take back [^?]*\? Work that relies on it may stop/, "nothing is added to the question when nothing runs");
  const part = await takeBack({ items: [{ grantId: GRT, total: 1, complete: false, items: work(1) }] });
  assert.equal(part.shown[1], "1 or more running tasks may rely on it:");
  const empty = await takeBack({ items: [{ grantId: GRT, total: 0, complete: false, items: [] }] });
  assert.match(empty.shown[1]!, /^No running work relies on it, but not every record could be read, so some may not be listed\.$/);
  const missing = await takeBack({ items: [] });
  assert.match(missing.shown[1]!, /is not known/);
  assert.match(missing.asked[0]!, /is not known/);
  // T7b review: a right that gives nothing now (ended, lapsed, not started) is said so, and a title cut at an emoji never keeps half of it.
  const off = await takeBack({ items: [{ grantId: GRT, total: 0, complete: true, inForce: false, items: [] }] });
  assert.match(off.shown[1]!, /^It is not in force now \(it ended, lapsed or has not started\), so no running work relies on it now\.$/);
  const cut = await takeBack({ items: [{ grantId: GRT, total: 1, complete: true, items: [{ ...work(1)[0]!, title: "x".repeat(56) + "\u{1F600}" + "y".repeat(20) }] }] });
  assert.equal(cut.shown[2], '"' + "x".repeat(56) + '..." (task task-aaaaaaaaaaaaaaaaaaa0, agent ann, attempt 1)');
  assert.ok(!/[\ud800-\udfff]/.test(cut.asked[0]!), "the question keeps no half of a character");
  const bad = await takeBack({ error: { code: "unavailable", message: "no" } });
  assert.match(bad.shown[1]!, /could not be checked just now/);
  assert.match(bad.asked[0]!, /could not be checked just now/);
});

test("the edit forms keep nothing but what the owner typed in the outbox, and a hostile name or right is only text (card U08 follow-up)", async () => {
  const views = ownerEditViews();
  (views["admin-team"].agents.items[0] as { friendlyName: string }).friendlyName = HOSTILE.slice(0, 80);
  const page = boot(views, [(c) => (c.path.startsWith("/web/admin/") ? { status: 201, body: queuedWith("x") } : undefined)]);
  const team = await admin(page, "team", "Agents and teams");
  assert.ok(team.find((e) => e.tag === "h4" && e.textContent.startsWith("Edit <img")).length === 1, "shown as text");
  assert.ok(![...page.doc.tags()].some((x) => /^(script|img|iframe|a)$/.test(x)));
  assert.doesNotMatch(JSON.stringify([...page.storage.map.values()]), /sk-|password/i);
  assert.deepEqual(page.doc.violations, []);
});

test("two agents with one name and one right held in two projects are told apart on every form, button and question; a name with a direction mark is refused (second review, card U08 follow-up)", async () => {
  const AGT3 = "agt-" + "e".repeat(20), GRT3 = "grt-" + "f".repeat(20);
  const views = ownerEditViews();
  views["admin-team"].agents.items.push({ id: AGT3, friendlyName: "Ann", roles: ["qa"], state: "active" });
  (views["admin-policy"].grants.items as Record<string, unknown>[]).push({ id: GRT3, grantee: "agent:ann", action: "task.update", project: "*", state: "active", basis: "x" });
  const page = boot(views, [(c) => (c.path.startsWith("/web/admin/") ? { status: 201, body: queuedWith("x") } : undefined)]);
  const team = await admin(page, "team", "Agents and teams");
  const cards = team.find((e) => e.className === "card" && e.textContent.startsWith("Edit "));
  assert.deepEqual(cards.map((c) => c.find((e) => e.tag === "h4")[0]!.textContent), [`Edit Ann (${AGT})`, `Edit Ann (${AGT3})`]);
  const labels = cards.map((c) => chip(c, "Change agent").getAttribute("aria-label"));
  assert.equal(new Set(labels).size, 2, "two buttons, two names");
  const second = cards[1]!;
  inputOf(second, `Name of Ann (${AGT3})`).value = "Ann\u202eeinnA";
  chip(second, "Change agent").click(); await settle();
  assert.match(text(live(team)), /invisible or text-direction/); assert.equal(sent(page).length, 0);
  inputOf(second, `Name of Ann (${AGT3})`).value = "Ann Two";
  chip(second, "Change agent").click(); await settle();
  assert.deepEqual(sent(page)[0]!.body, { agentId: AGT3, friendlyName: "Ann Two" }, "the form edits its own agent");
  const policy = await admin(page, "policy", "Policy");
  const takes = policy.find((e) => e.className === "card" && e.textContent.startsWith("Take back: ")).map((c) => c.find((e) => e.tag === "h4")[0]!.textContent);
  assert.deepEqual(takes, ["Take back: task.update for agent:ann in proj-1", "Take back: task.update for agent:ann in every project"]);
  assert.deepEqual(page.doc.violations, []);
});

test("second review: the page's clip is unchanged for text without a pair and never keeps half of one, at every length and cut position and for every limit the page uses", () => {
  // The page's own clip, taken from the script as served (the T7b change to it touches every clipped field on the page).
  const lines = APP_JS.split("\n");
  const src = ["UNSEEN = ", "function unseen(", "function clip("].map((k) => lines.find((l) => l.includes(k))!.trim()).join("\n");
  const clip = runInNewContext(`${src}\nclip`) as (v: unknown, n: number) => string;
  const before = (v: string, n: number) => (v.length > n ? v.slice(0, n - 3) + "..." : v);
  const E = "\u{1F600}";
  const half = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;
  const limits = [...new Set((APP_JS.match(/clip\([^()]*, (\d+)\)/g) ?? []).map((m) => Number(/(\d+)\)$/.exec(m)![1])))];
  assert.ok(limits.length >= 10 && limits.every((n) => n >= 4), `the limits the page uses: ${limits}`);
  for (const n of limits) for (let len = 0; len <= n + 3; len++) {
    const plain = "a".repeat(len);
    assert.equal(clip(plain, n), before(plain, n), `plain ${len} at ${n}`);
    for (let at = 0; at + 2 <= len; at++) {
      const s = "a".repeat(at) + E + "a".repeat(len - at - 2);
      const got = clip(s, n);
      if (len <= n) assert.equal(got, s, "text that fits is kept whole");
      else {
        assert.ok(!half.test(got) && got.endsWith("...") && got.length <= n && got.length >= n - 4, `${n} ${len} ${at}: ${JSON.stringify(got)}`);
        assert.equal(got, at + 2 <= n - 3 ? s.slice(0, n - 3) + "..." : s.slice(0, Math.min(at, n - 3)) + "...", "only an emoji that would be cut is left out");
      }
    }
  }
  assert.deepEqual([clip(null, 10), clip(undefined, 10), clip(0, 10), clip("", 10), clip("a", 10)], ["", "", "0", "", "a"]);
});

// Card W08 (browser side): the Status page draws the lines of an `attempt_endings` status answer as plain text, as the chat and status.ask give them.
// The lines below are the controller's own wording (packages/controller/src/dispatch/attempt-endings.test.ts and api/start-attempt-endings.test.ts).
const ATTEMPT_ID = "att-0123456789abcdef";
const endingLines = (blockerLast: string): { text: string; cites: { kind: string; id: string }[] }[] => [
  "2 attempt(s) of Fix the parser on record, newest first.",
  `Attempt 2 (${ATTEMPT_ID}), agent agt-ann on route local/model as coder: started 2026-11-10T09:00:00.000Z; it ended stopped early: the agent kept stopping before it said its work was done`,
  "Its last turn: it ended with prose and no work.end (40 visible characters).",
  "Nudges to go on: 9 (3 in its last turn).",
  "Plan: 1 of 3 step(s) checked.",
  "It stopped before saying its work was done 3 time(s) (the model ran out of length; it announced a step but made no call; it ended with prose and no work.end).",
  "Attempt 1 (att-aaaaaaaaaaaaaaaa), agent agt-bob on route local/model as coder: started 2026-11-09T09:00:00.000Z; it ended normally.",
  `Open blocker agent_stopped_early since 2026-11-10T10:00:00.000Z: The agent stopped before it said its work was done, 3 time(s) in a row. Last visible text (quoted): "${blockerLast}" The way out: the lead looks at it.`,
].map((t) => ({ text: t, cites: [{ kind: "task", id: "tsk-1" }] }));

test("the Status page shows every line of an attempt-endings answer as its own plain line, in order, and a quoted last text with markup stays text (card W08)", async () => {
  const last = `<b onclick="x()">Now I will run & the tests</b> <script>alert(1)</script> ${"$"}{a} 'q' "z"`;
  const lines = endingLines(last);
  const page = boot({ status: { attempts: { item: { observedAt: "2026-11-10T10:00:00Z", lines } } } });
  const view = await open(page, "status");
  const shown = view.find((e) => e.className === "card-line").map((e) => e.textContent);
  assert.deepEqual(shown, ["item:", ...lines.map((l) => "  " + l.text)], "one line per controller line, none merged, none dropped, none reordered");
  assert.ok(shown.some((s) => s.includes(`Last visible text (quoted): "${last}"`)), "the blocker's quoted text is shown whole, markup characters and all, as text");
  assert.ok(shown.some((s) => /^ {2}Attempt 2 \(att-0123456789abcdef\).*stopped early/.test(s)) && shown.some((s) => /^ {2}Attempt 1 /.test(s)), "several attempts each have their line");
  assert.ok(shown.some((s) => s === "  Nudges to go on: 9 (3 in its last turn).") && shown.some((s) => s === "  Plan: 1 of 3 step(s) checked."));
  const drawn = view.find(() => true);
  assert.deepEqual([...new Set(drawn.map((e) => e.tag))].filter((t) => !["div", "section", "h2", "h3", "p", "button"].includes(t)), [], "only plain tags are drawn: no b, no script");
  for (const e of drawn) for (const [k, v] of e.attrs) assert.ok(!/^on/i.test(k) && !v.includes("onclick"), `attribute ${k}`);
  assert.deepEqual(page.doc.violations, []);
});

test("an attempt-endings answer for a task with no attempt shows the controller's one line; an empty answer is 'Nothing to show' (card W08)", async () => {
  const none = [{ text: "No attempt of Fix the parser is on record yet.", cites: [{ kind: "task", id: "tsk-1" }] }];
  const one = await open(boot({ status: { attempts: { item: { observedAt: "x", lines: none } } } }), "status");
  assert.deepEqual(one.find((e) => e.className === "card-line").map((e) => e.textContent), ["item:", "  No attempt of Fix the parser is on record yet."]);
  const empty = await open(boot({ status: { attempts: { item: { observedAt: "x", lines: [] } } } }), "status");
  assert.match(text(empty), /Nothing to show/);
  assert.equal(empty.find((e) => e.className === "card").length, 0, "no empty card is drawn");
});

test("the chat shows an attempt-endings answer line by line as text (card W08)", async () => {
  const last = `<img src=x onerror=alert(1)> "q"`;
  const reply = endingLines(last).map((l) => l.text);
  const turn = { turnId: "turn-2", replayed: false, text: "why did the last attempt stop", reply, outcomes: [{ status: "answered" }] };
  // The chat's answer is carried here by the approvals route (the page draws any finished turn the same way, whichever control sent it).
  const page = boot({ approvals: approvalParts() }, [(c) => (c.path.startsWith("/web/approvals/") ? { status: 201, body: turn } : undefined)]);
  const view = await open(page, "approvals");
  view.buttons().find((b) => b.textContent.startsWith("Accept for 7 days"))!.click();
  await settle();
  const log = page.doc.byId.get("log")!;
  const bot = log.find((e) => e.className === "msg bot").map((e) => e.textContent);
  assert.deepEqual(bot, reply, "each controller line is its own chat line, equal to what status.ask gives");
  assert.ok(bot.some((l) => l.includes(`"${last}"`)));
  assert.deepEqual([...new Set(log.find(() => true).map((e) => e.tag))].filter((t) => !["div", "section", "p", "button", "h2", "h3"].includes(t)), []);
  assert.deepEqual(page.doc.violations, []);
});
