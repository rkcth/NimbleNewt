import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { FakeDocument, type FakeElement } from "./fake-dom.js";
import { APP_JS, APP_CSS } from "./index.js";

// Card U07 (finish): the recorded conversation shown from the controller, live-update nudges, and the designed cost and blockers pages, run as served against a fake document and a fake controller.

const HOSTILE = `<img src=x onerror=alert(1)><script>alert(2)</script>"'\`${"$"}{alert(3)}</b>javascript:alert(4)`;

class Storage { readonly map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }
class FakeSource {
  static all: FakeSource[] = [];
  readyState = 1; closedByPage = false;
  readonly listeners = new Map<string, ((e: { data: string }) => void)[]>();
  constructor(readonly url: string) { FakeSource.all.push(this); }
  addEventListener(type: string, f: (e: { data: string }) => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), f]); }
  close(): void { this.readyState = 2; this.closedByPage = true; }
  send(type: string, data = "{}"): void { for (const f of this.listeners.get(type) ?? []) f({ data }); }
}
interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }
type Handler = (call: Call) => { status: number; body: unknown } | undefined;

function boot(o: { views?: Record<string, unknown>; handlers?: Handler[]; source?: boolean; intervals?: boolean; history?: () => unknown } = {}) {
  FakeSource.all = [];
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const intervals: { f: () => void; cleared: boolean }[] = [];
  let history: () => unknown = o.history ?? (() => ({ observedAt: "x", turns: [], complete: true }));
  const fetch = async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { method: init.method, path, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const out = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (path === "/web/session") return out(200, { authenticated: true, csrf: "csrf-1", owner: "rob", expiresAt: "x" });
    for (const h of o.handlers ?? []) { const r = h(call); if (r !== undefined) return out(r.status, r.body); }
    if (path.startsWith("/web/history")) return out(200, history());
    const m = /^\/web\/views\/([a-z-]+)$/.exec(path);
    if (m !== null && o.views?.[m[1]!] !== undefined) return out(200, { view: m[1], observedAt: "2026-11-11T00:00:00Z", parts: o.views[m[1]!] });
    return out(404, { error: { code: "not_found", message: "no" } });
  };
  const sandbox: Record<string, unknown> = { document: doc, fetch, localStorage: new Storage(), confirm: () => true, addEventListener() {}, setTimeout: () => 1, clearTimeout: () => undefined };
  if (o.source !== false) sandbox["EventSource"] = FakeSource;
  if (o.intervals === true) { sandbox["setInterval"] = (f: () => void) => { intervals.push({ f, cleared: false }); return intervals.length; }; sandbox["clearInterval"] = (id: number) => { intervals[id - 1]!.cleared = true; }; }
  runInNewContext(APP_JS, sandbox);
  return { doc, calls, intervals, setHistory: (h: () => unknown) => { history = h; } };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 30; i++) await new Promise((r) => setImmediate(r)); };
const tab = (doc: FakeDocument, name: string): FakeElement => doc.body.find((e) => e.getAttribute("data-tab") === name)[0]!;
const log = (doc: FakeDocument): string => doc.byId.get("log")!.textContent;
const turn = (n: number, extra: Record<string, unknown> = {}) => ({ turnId: `turn-${n}`, messageId: `srv-${n}`, text: `said ${n}`, status: "done", createdAt: `2026-11-10T10:0${n}:00.000Z`, completedAt: `2026-11-10T10:0${n}:01.000Z`, reply: [`did ${n}`], outcomes: [], ...extra });

test("turns the controller recorded show in time order, the older ones by a button, and an old question has no stale answer buttons", async () => {
  let pages = 0;
  const page = boot({ handlers: [(c) => { if (c.path.startsWith("/web/history?before=")) { pages++; return { status: 200, body: { observedAt: "x", turns: [turn(1)], complete: true } }; } return undefined; }], history: () => ({ observedAt: "x", complete: true, next: "2026-11-10T10:02:00.000Z|turn-" + "0".repeat(32), turns: [turn(3, { outcomes: [{ status: "asked", question: "Which one?", options: ["alpha", "beta"] }], reply: ["Which one? (alpha; beta)"] }), turn(2, { outcomes: [{ status: "asked", question: "Old question?", options: ["stale-a"] }], reply: ["Old question?"] })] }) });
  await settle();
  const text = log(page.doc);
  assert.ok(text.indexOf("said 2") < text.indexOf("said 3"), "oldest first");
  assert.match(text, /Which one/);
  const chips = page.doc.byId.get("log")!.buttons().map((b) => b.textContent);
  assert.ok(chips.includes("alpha") && chips.includes("beta"), "the newest question can be answered");
  assert.equal(chips.includes("stale-a"), false, "an older question is not answered by a stale button");
  const more = page.doc.byId.get("log")!.buttons().find((b) => b.textContent === "Show older messages")!;
  more.click(); await settle();
  assert.equal(pages, 1);
  assert.match(log(page.doc), /said 1/);
  assert.ok(log(page.doc).indexOf("said 1") < log(page.doc).indexOf("said 2"));
  assert.equal(page.doc.byId.get("log")!.buttons().some((b) => b.textContent === "Show older messages"), false, "no older page is left");
  assert.deepEqual(page.doc.violations, []);
});

test("a message sent from this phone is shown once from the outbox, not again from the controller's copy", async () => {
  const page = boot({ handlers: [(c) => (c.method === "POST" && c.path === "/web/chat" ? { status: 201, body: { turnId: "turn-x", replayed: false, reply: ["done it"], outcomes: [] } } : undefined)] });
  await settle();
  page.doc.byId.get("text")!.value = "hello there";
  page.doc.byId.get("composer")!.listeners.get("submit")![0]!({ preventDefault() {} });
  await settle();
  const sent = page.calls.find((c) => c.path === "/web/chat")!.body as { messageId: string };
  page.setHistory(() => ({ observedAt: "x", complete: true, turns: [turn(5, { messageId: sent.messageId, text: "hello there" })] }));
  FakeSource.all[0]!.send("changed", JSON.stringify({ views: ["chat"] }));
  await settle();
  assert.equal(log(page.doc).split("hello there").length - 1, 1, "once");
});

test("a proposal that was already applied or discarded elsewhere has no buttons; an open one has Apply and Discard", async () => {
  const proposed = (id: string, state: string) => ({ status: "proposed", proposalId: id, preview: [`change ${id}`], proposalState: state });
  const page = boot({ history: () => ({ observedAt: "x", complete: true, turns: [turn(1, { outcomes: [proposed("prop-a", "applied")] }), turn(2, { outcomes: [proposed("prop-b", "discarded")] }), turn(3, { outcomes: [proposed("prop-c", "open")] })] }) });
  await settle();
  const t = log(page.doc);
  assert.match(t, /Already applied/); assert.match(t, /Already discarded/);
  const names = page.doc.byId.get("log")!.buttons().map((b) => b.textContent);
  assert.deepEqual(names.filter((n) => n === "Apply" || n === "Discard"), ["Apply", "Discard"], "only the open proposal can be decided");
});

test("hostile text in a recorded turn is shown as text, never as markup", async () => {
  const page = boot({ history: () => ({ observedAt: "x", complete: true, turns: [turn(1, { text: HOSTILE, reply: [HOSTILE], outcomes: [{ status: "proposed", proposalId: "prop-z", preview: [HOSTILE], proposalState: "open" }] })] }) });
  await settle();
  assert.ok(log(page.doc).includes("<img src=x onerror=alert(1)>"));
  assert.deepEqual(page.doc.violations, []);
  assert.deepEqual([...page.doc.tags()].filter((t) => ["img", "script", "a", "iframe"].includes(t)), []);
});

test("a nudge reads again what the page shows: the chat's history, the open view; another view only gets a marker that selecting it clears", async () => {
  const page = boot({ views: { "needs-you": { needsYou: { lines: [{ text: "first" }] } }, cost: { usage: { item: { totals: { costMicros: 0, computeMs: 0 } } } } } });
  await settle();
  const src = FakeSource.all[0]!;
  assert.equal(src.url, "/web/events");
  assert.equal(page.calls.filter((c) => c.path.startsWith("/web/history")).length, 1, "ready reads the history");
  src.send("ready");
  await settle();
  const history = () => page.calls.filter((c) => c.path.startsWith("/web/history")).length;
  const before = history();
  src.send("changed", JSON.stringify({ views: ["chat"] })); await settle();
  assert.equal(history(), before + 1);
  tab(page.doc, "needs-you").click(); await settle();
  const reads = () => page.calls.filter((c) => c.path === "/web/views/needs-you").length;
  const r0 = reads();
  src.send("changed", JSON.stringify({ views: ["needs-you", "cost"] })); await settle();
  assert.equal(reads(), r0 + 1, "the open view is read again");
  assert.equal(tab(page.doc, "cost").getAttribute("data-changed"), "true");
  assert.match(tab(page.doc, "cost").getAttribute("aria-label")!, /Cost - updated/);
  assert.equal(page.calls.filter((c) => c.path === "/web/views/cost").length, 0, "a view that is not open is not read");
  tab(page.doc, "cost").click(); await settle();
  assert.equal(tab(page.doc, "cost").getAttribute("data-changed"), "false");
  // garbage in a nudge does nothing and breaks nothing
  src.send("changed", "not json"); await settle();
  assert.deepEqual(page.doc.violations, []);
});

test("the stream is closed when the controller says it ended or the browser is signed out, and a refused stream is not retried blindly", async () => {
  const page = boot();
  await settle();
  const src = FakeSource.all[0]!;
  src.send("ended"); await settle();
  assert.equal(src.closedByPage, true);
  const second = boot();
  await settle();
  const s2 = FakeSource.all[0]!;
  s2.readyState = 2; for (const f of s2.listeners.get("error") ?? []) f({ data: "" }); await settle();
  assert.equal(s2.closedByPage, true, "a stream the browser gave up on is closed by the page too");
  void page; void second;
});

test("without EventSource the history is asked every half minute while the page is in front, and not while it is hidden", async () => {
  const page = boot({ source: false, intervals: true });
  await settle();
  assert.equal(page.intervals.length, 1);
  const n = () => page.calls.filter((c) => c.path.startsWith("/web/history")).length;
  const before = n();
  page.intervals[0]!.f(); await settle();
  assert.equal(n(), before + 1);
  page.doc.visibilityState = "hidden";
  page.intervals[0]!.f(); await settle();
  assert.equal(n(), before + 1, "nothing while hidden");
});

const costParts = (fill: (s: string) => string = (s) => s) => ({
  usage: { item: { totals: { costMicros: 4_000_000, computeMs: 90_000 }, entries: 12, truncated: true, cache: { cachedTokens: 300, computedTokens: 100, writtenTokens: 0, calls: 5 },
    byProject: { [fill("proj-a")]: { costMicros: 3_000_000, computeMs: 60_000 }, [fill("proj-b")]: { costMicros: 1_000_000, computeMs: 30_000 } },
    byAgent: { [fill("agent:ann")]: { costMicros: 4_000_000, computeMs: 90_000 } }, byTask: {}, byCategory: { work: { costMicros: 4_000_000, computeMs: 90_000 } }, byActivity: { "model-call": { costMicros: 4_000_000, computeMs: 90_000 } },
    overheadRules: [fill("split evenly")] } },
  pending: { requests: [{ id: "r1", taskId: fill("task-1"), requestedBy: fill("agent:ann"), costMicros: 2_500_000, computeMs: 10_000, to: "owner", reason: fill("needs more room") }], truncated: false },
});

test("the cost page shows the total, a labelled table with a meter on every row, the cache, overhead rules and open requests, all as text", async () => {
  const page = boot({ views: { cost: costParts() } });
  await settle(); tab(page.doc, "cost").click(); await settle();
  const view = page.doc.byId.get("view")!;
  const t = view.textContent;
  assert.match(t, /4.0 cost units spent, 90 s of compute, over 12 records/);
  assert.match(t, /lower bound/);
  assert.match(t, /Cache: 300 of 400 input tokens/);
  assert.match(t, /proj-a/); assert.match(t, /75%/); assert.match(t, /25%/);
  assert.match(t, /split evenly/);
  assert.match(t, /2\.5 and 10 s/); assert.match(t, /needs more room/);
  const meters = view.find((e) => e.tag === "meter");
  assert.ok(meters.length >= 5);
  for (const m of meters) { assert.equal(m.getAttribute("min"), "0"); assert.equal(m.getAttribute("max"), "100"); assert.match(m.getAttribute("aria-label")!, /percent of the total/); }
  assert.deepEqual(meters.slice(0, 2).map((m) => m.getAttribute("value")), ["75", "25"], "the biggest first");
  for (const tb of view.find((e) => e.tag === "table")) { assert.equal(tb.find((e) => e.tag === "caption").length, 1); assert.ok(tb.find((e) => e.tag === "th" && e.getAttribute("scope") === "col").length >= 4); }
  for (const r of view.find((e) => e.tag === "section")) assert.equal(r.getAttribute("aria-labelledby"), r.find((e) => e.tag === "h3")[0]!.id);
  assert.deepEqual(page.doc.violations, []);
  assert.match(APP_CSS, /meter\{/); assert.match(APP_CSS, /data-changed=true/);
});

test("hostile names and reasons on the cost and blockers pages stay text, an empty or failed read says so, and nothing else is drawn", async () => {
  const page = boot({ views: {
    cost: costParts((s) => HOSTILE + s),
    blockers: { needsYou: { lines: [{ text: HOSTILE }] }, attention: { items: [{ kind: "unreachable_worker", title: HOSTILE, taskState: "running", at: "2026-11-10T00:00:00Z", summary: HOSTILE }], scanLimited: true } },
  } });
  await settle();
  for (const name of ["cost", "blockers"]) { tab(page.doc, name).click(); await settle(); assert.ok(page.doc.byId.get("view")!.textContent.includes("<img src=x onerror=alert(1)>"), name); }
  assert.deepEqual(page.doc.violations, []);
  assert.deepEqual([...page.doc.tags()].filter((t) => ["img", "script", "a", "iframe"].includes(t)), []);
  const bad = boot({ views: { cost: { usage: { error: { code: "forbidden", message: "no" } }, pending: { error: { code: "unavailable", message: "later" } } }, blockers: { needsYou: { error: { code: "unavailable", message: "later" } }, attention: { items: [] } } } });
  await settle(); tab(bad.doc, "cost").click(); await settle();
  assert.match(bad.doc.byId.get("view")!.textContent, /Could not load: no/); assert.match(bad.doc.byId.get("view")!.textContent, /Could not load: later/);
  tab(bad.doc, "blockers").click(); await settle();
  assert.match(bad.doc.byId.get("view")!.textContent, /Could not load: later/); assert.match(bad.doc.byId.get("view")!.textContent, /Nothing needs a closer look/);
  const empty = boot({ views: { cost: { usage: { item: {} }, pending: { requests: [] } } } });
  await settle(); tab(empty.doc, "cost").click(); await settle();
  assert.match(empty.doc.byId.get("view")!.textContent, /No spending is recorded yet/); assert.match(empty.doc.byId.get("view")!.textContent, /Nobody is waiting/);
});
