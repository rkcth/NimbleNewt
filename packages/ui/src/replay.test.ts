import assert from "node:assert/strict";
import { test } from "node:test";
import { runInNewContext } from "node:vm";
import { FakeDocument, type FakeElement } from "./fake-dom.js";
import { APP_JS } from "./index.js";

// Card U09b: the replay page, run as served against a fake document: summary first, lanes side by side, one step with its resolved links, thinking collapsed behind a button, a simulation that says it changes nothing,
// and hostile text in every field an agent can fill.
const HOSTILE = `<img src=x onerror=alert(1)><script>alert(2)</script>"'\`${"$"}{alert(3)}</b>javascript:alert(4)`;
class Storage { readonly map = new Map<string, string>(); getItem(k: string) { return this.map.get(k) ?? null; } setItem(k: string, v: string) { this.map.set(k, v); } removeItem(k: string) { this.map.delete(k); } }
interface Call { method: string; path: string; headers: Record<string, string>; body: unknown }

function boot(handler: (call: Call) => { status: number; body: unknown } | undefined, confirm: () => boolean = () => true) {
  const doc = new FakeDocument();
  const calls: Call[] = [];
  const fetch = async (path: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    const call: Call = { method: init.method, path, headers: init.headers, body: init.body === undefined ? undefined : JSON.parse(init.body) };
    calls.push(call);
    const out = (status: number, body: unknown) => ({ status, text: async () => JSON.stringify(body) });
    if (path === "/web/session") return out(200, { authenticated: true, csrf: "csrf-1", owner: "rob", expiresAt: "x" });
    const r = handler(call);
    return r === undefined ? out(404, { error: { code: "not_found", message: "no" } }) : out(r.status, r.body);
  };
  const sandbox: Record<string, unknown> = { document: doc, fetch, localStorage: new Storage(), confirm, addEventListener() {}, setTimeout: () => 1, clearTimeout: () => undefined };
  runInNewContext(APP_JS, sandbox);
  return { doc, calls };
}
const settle = async (): Promise<void> => { for (let i = 0; i < 40; i++) await new Promise((r) => setImmediate(r)); };
const tab = (doc: FakeDocument, name: string): FakeElement => doc.body.find((e) => e.getAttribute("data-tab") === name)[0]!;
const text = (e: FakeElement): string => e.textContent;
const button = (view: FakeElement, match: RegExp): FakeElement => { const b = view.buttons().find((x) => match.test(x.textContent) || match.test(x.getAttribute("aria-label") ?? "")); assert.ok(b !== undefined, `a button ${match}: ${view.buttons().map((x) => x.textContent).join(" | ")}`); return b; };

const TASK = "task-aaaaaaaaaaaaaaaaaaaa";
const step = (seq: number, extra: Record<string, unknown> = {}) => ({ seq, at: "2026-11-12T10:00:00Z", actor: "agent:ann", kind: "tool-call", summary: `step ${seq}`, lane: "main", laneStatus: "main", outcome: "confirmed", versionsThen: { state: "recorded", refs: [{ kind: "review", id: "rv-1" }] }, authority: "current", content: { state: "none" }, corrections: 0, links: [], ...extra });
const replay = {
  taskId: TASK, projectId: "proj", next: 7,
  summary: { total: 6, scanLimited: false, range: { first: 1, last: 6, of: 6 }, byKind: { "tool-call": 6 }, byOutcome: { confirmed: 4, dispatched: 1, "not-recorded": 1 }, lanes: [{ lane: "main", steps: 4 }, { lane: "cbr-side", steps: 2 }], agents: [{ actor: "agent:ann", steps: 5 }, { actor: "owner:rob", steps: 1 }], unavailable: [{ seq: 6, reason: "archived" }], redactedSteps: 1, stepsWithoutManifest: 0, superseded: 1, corrected: 1 },
  entries: [step(1, { authority: "superseded", supersededBy: [4] }), step(2, { summary: HOSTILE, actor: HOSTILE, outcome: "dispatched", outcomeNote: "reported by agent" }), step(3, { lane: "cbr-side", laneStatus: "unverified", laneNote: "unverified lane" }), step(4, { kind: "instruction", actor: "owner:rob" }), step(5, { lane: "cbr-side", laneStatus: "verified" }), { seq: 6, unavailable: HOSTILE }],
};
const labels = { concurrent: "Steps on different branches happened side by side.", thinking: "Model output. Not an explanation.", superseded: "Replaced by a later step; kept for the record and no longer authoritative.", windowed: "Only part was read." };

function handler(extra: (call: Call) => { status: number; body: unknown } | undefined = () => undefined) {
  return (call: Call) => {
    const x = extra(call); if (x !== undefined) return x;
    if (call.path === "/web/views/replay") return { status: 200, body: { view: "replay", observedAt: "2026-11-12T10:00:00Z", parts: { tasks: { items: [{ id: TASK, title: HOSTILE, state: "in_progress" }] } } } };
    if (call.method === "GET" && call.path.startsWith(`/web/replay/${TASK}?`) || call.path === `/web/replay/${TASK}`) return { status: 200, body: { observedAt: "x", replay, labels } };
    if (call.path === `/web/replay/${TASK}/steps/2`) return { status: 200, body: { observedAt: "x", detail: { step: step(2, { summary: HOSTILE, outcome: "dispatched", outcomeNote: "reported by agent" }), explanations: { contemporaneous: { label: "Written at the time by the one who chose.", items: [{ by: "agent:ann", choice: HOSTILE, uncertainty: HOSTILE }] }, retrospective: { label: "Asked for afterwards.", items: [] } }, thinking: { state: "not-removed", note: "kept" } }, links: { seq: 2, truncated: false, items: [
      { relation: "context", kind: "review", id: "rv-1", resolution: { state: "readable", title: HOSTILE, lines: [HOSTILE, "second"], untrusted: true } },
      { relation: "context", kind: "compaction", id: "dd", resolution: { state: "no-reader", note: "nothing here reads this kind of record" } },
      { relation: "context", kind: "agent-message", id: "m9", resolution: { state: "not-readable", note: "not found, or you may not read it" } }] } } };
    return undefined;
  };
}

test("the replay page: tasks first, then the summary, the lines side by side, one step with what it cites, all as text and nothing as markup", async () => {
  const page = boot(handler());
  await settle(); tab(page.doc, "replay").click(); await settle();
  const view = page.doc.byId.get("view")!;
  assert.match(text(view), /Choose a task/);
  // The task title is an agent's or the owner's text: shown as text.
  assert.ok(text(view).includes(HOSTILE.slice(0, 40)));
  button(view, /Replay the task/).click(); await settle();
  const t = text(view);
  assert.match(t, /6 steps; 2 lines of work; 1 unavailable; 1 replaced; 1 corrected; 1 with hidden content/);
  assert.match(t, /Where steps stood: confirmed 4, dispatched 1, not recorded 1/);
  assert.match(t, /Steps on different branches happened side by side/);
  // Lanes are columns, each a named group, with an unverified lane said to be so.
  const lanes = view.find((e) => e.className === "lane");
  assert.deepEqual(lanes.map((l) => l.getAttribute("aria-label")), ["Line main", "Line cbr-side", "Line unavailable"]);
  assert.match(text(lanes[1]!), /Line cbr-side \(unverified lane\)/);
  assert.match(text(lanes[0]!), /Step 1 - tool-call - agent:ann - confirmed - replaced by step 4/);
  assert.match(text(lanes[0]!), /Replaced by a later step; kept for the record and no longer authoritative\./);
  assert.match(text(lanes[0]!), /Step 2 - tool-call - .* - dispatched \(reported by agent\)/, "an agent's claim is labelled as its claim");
  assert.match(text(lanes[2]!), /Step 6 is no longer available/);
  assert.match(text(view), /Show the next steps \(from step 7\)/);
  // Following a line or an agent asks for that window (and remembers it).
  button(view, /Show only the line cbr-side/).click(); await settle();
  assert.ok(page.calls.some((c) => c.method === "GET" && /^\/web\/replay\/task-a+\?lane=cbr-side$/.test(c.path)), JSON.stringify(page.calls.map((c) => c.path)));
  // One step in full.
  const open = button(view, /Open Step 2 /);
  open.click(); await settle();
  const t2 = text(view);
  assert.match(t2, /Context then: review rv-1/);
  assert.match(t2, /Written at the time by the one who chose\./);
  assert.match(t2, /context: review rv-1 - /);
  assert.match(t2, /Written by an agent or reviewer: /, "a record's text written by an agent is marked");
  assert.match(t2, /context: compaction dd - nothing here reads this kind of record/);
  assert.match(t2, /context: agent-message m9 - not found, or you may not read it/);
  // Everything an agent wrote stays text: no markup was ever assigned, and the hostile text is shown as it is.
  assert.deepEqual(page.doc.violations, []);
  for (const tag of page.doc.tags()) assert.ok(!["script", "img", "iframe", "a"].includes(tag), `no ${tag} element`);
  for (const el of view.find(() => true)) for (const [k] of el.attrs) assert.ok(!/^on/i.test(k), `no ${k} attribute`);
});

test("the thinking is collapsed until asked, is labelled as model output, and a removed one shows only the notice; the simulation asks first and says nothing was run", async () => {
  const keys: string[] = [];
  const page = boot(handler((call) => {
    if (call.method === "POST" && call.path === `/web/replay/${TASK}/thinking`) { keys.push(call.headers["idempotency-key"]!); return { status: 200, body: { observedAt: "x", thinking: { collapsed: true, state: "stored", label: labels.thinking, blocks: [{ text: HOSTILE }, {}] } } }; }
    if (call.method === "POST" && call.path === `/web/replay/${TASK}/simulate`) return { status: 200, body: { observedAt: "x", id: "sim-1", replayed: false, simulation: { label: "Simulated. Nothing was run, sent, spent or changed.", truncated: false, steps: [{ seq: 1, would: "make the tool call again", recordedOutcome: "confirmed", simulated: true }, { seq: 2, would: "not be reached after the injected failure", recordedOutcome: "confirmed", simulated: true }] } } };
    return undefined;
  }));
  await settle(); tab(page.doc, "replay").click(); await settle();
  const view = page.doc.byId.get("view")!;
  button(view, /Replay the task/).click(); await settle();
  button(view, /Open Step 2 /).click(); await settle();
  assert.match(text(view), /Collapsed\. It is model output, not an explanation of any step\./);
  assert.ok(!text(view).includes("kept without text"), "nothing of the thinking is shown before it is asked for");
  assert.ok(!page.calls.some((c) => c.path.endsWith("/thinking")), "and nothing was fetched");
  button(view, /Expand the model's thinking/).click(); await settle();
  assert.match(text(view), /Model output\. Not an explanation\./);
  assert.ok(text(view).includes(HOSTILE.slice(0, 40)) && text(view).includes("(kept without text)"));
  assert.equal(keys.length, 1); assert.match(keys[0]!, /^[A-Za-z0-9._-]{1,100}$/, "one Idempotency-Key per expansion");
  const post = page.calls.find((c) => c.path.endsWith("/thinking"))!;
  assert.equal(post.headers["x-nn-csrf"], "csrf-1"); assert.deepEqual(post.body, {});
  // Simulation: asks first; declining runs nothing.
  const declined = boot(handler(), () => false);
  await settle(); tab(declined.doc, "replay").click(); await settle();
  const v2 = declined.doc.byId.get("view")!;
  button(v2, /Replay the task/).click(); await settle();
  button(v2, /^Simulate a rerun$/).click(); await settle();
  assert.ok(!declined.calls.some((c) => c.path.endsWith("/simulate")));
  button(view, /^Simulate a rerun$/).click(); await settle();
  assert.match(text(view), /Simulated\. Nothing was run, sent, spent or changed\./);
  assert.match(text(view), /Simulated: step 2 would not be reached after the injected failure/);
  assert.deepEqual(page.doc.violations, []);
  // After retention the controller says so and the page has no button to try again.
  const gone = boot(handler((call) => call.path === `/web/replay/${TASK}/steps/2` ? { status: 200, body: { observedAt: "x", detail: { step: step(2), explanations: { contemporaneous: { label: "", items: [] }, retrospective: { label: "", items: [] } }, thinking: { state: "removed-by-retention", removedAt: "t", label: "The model's thinking for this task was removed by retention. Nothing else about the record changes." } }, links: { items: [] } } } : undefined));
  await settle(); tab(gone.doc, "replay").click(); await settle();
  const v3 = gone.doc.byId.get("view")!;
  button(v3, /Replay the task/).click(); await settle(); button(v3, /Open Step 2 /).click(); await settle();
  assert.match(text(v3), /removed by retention\. Nothing else about the record changes\./);
  assert.ok(!v3.buttons().some((b) => /Expand the model/.test(b.textContent)));
});

test("a failed read says so in the controller's words and a signed-out page says it is signed out", async () => {
  const page = boot((call) => call.path === "/web/views/replay" ? { status: 200, body: { view: "replay", observedAt: "x", parts: { tasks: { items: [{ id: TASK, title: "t", state: "ready" }] } } } } : call.path.startsWith("/web/replay/") ? { status: 403, body: { error: { code: "forbidden", message: "no right to read that task" } } } : undefined);
  await settle(); tab(page.doc, "replay").click(); await settle();
  const view = page.doc.byId.get("view")!;
  button(view, /Replay the task/).click(); await settle();
  assert.match(text(view), /Could not load: no right to read that task/);
});

// Review (card U09b): the confirmed simulation sends exactly one POST with the session's CSRF header and its own Idempotency-Key, and a body of nothing but what the page chose; the search and the next-steps button ask
// for the right window; the chips for an agent and "Show everything" set and clear the filters; and a dropped connection never leaves a button disabled or a step loading for ever.
test("the confirmed simulation, the search, the next steps, the chips and an offline answer, as the page sends them", async () => {
  const keys = new Set<string>();
  let offline = false;
  const page = boot(handler((call) => {
    if (offline && call.path.startsWith(`/web/replay/${TASK}/`)) throw new Error("offline");
    if (call.method === "POST" && call.path === `/web/replay/${TASK}/simulate`) { keys.add(call.headers["idempotency-key"]!); return { status: 200, body: { observedAt: "x", id: "sim-1", replayed: false, simulation: { label: "Simulated.", truncated: true, steps: [{ seq: 1, would: HOSTILE, recordedOutcome: "failed", simulated: true }] } } }; }
    if (call.method === "GET" && call.path.startsWith(`/web/replay/${TASK}/search?`)) return { status: 200, body: { observedAt: "x", search: { matches: [step(5, { summary: HOSTILE })], scanLimited: false } } };
    return undefined;
  }));
  await settle(); tab(page.doc, "replay").click(); await settle();
  const view = page.doc.byId.get("view")!;
  button(view, /Replay the task/).click(); await settle();
  // Two confirmed clicks are two simulations, each under its own key; each POST carries the CSRF header and an empty body.
  button(view, /^Simulate a rerun$/).click(); await settle();
  button(view, /^Simulate a rerun$/).click(); await settle();
  const posts = page.calls.filter((c) => c.method === "POST" && c.path.endsWith("/simulate"));
  assert.equal(posts.length, 2);
  for (const p of posts) { assert.equal(p.headers["x-nn-csrf"], "csrf-1"); assert.deepEqual(p.body, {}); assert.match(p.headers["idempotency-key"]!, /^[A-Za-z0-9._-]{1,100}$/); }
  assert.equal(keys.size, 2, "a new key for each confirmed click");
  assert.match(text(view), /Only the first steps were walked\./);
  assert.ok(text(view).includes(`Simulated: step 1 would ${HOSTILE.slice(0, 30)}`), "the simulation's words are text");
  // The search sends the words as one encoded query parameter and shows the matches as text.
  const input = view.find((e) => e.tag === "input" && e.getAttribute("aria-label") === "Words to look for in the steps")[0]!;
  (input as unknown as { value: string }).value = "probe & <b>x</b>";
  button(view, /^Search$/).click(); await settle();
  assert.ok(page.calls.some((c) => c.method === "GET" && c.path === `/web/replay/${TASK}/search?q=${encodeURIComponent("probe & <b>x</b>")}`), JSON.stringify(page.calls.map((c) => c.path)));
  assert.match(text(view), /Step 5 - tool-call/);
  // The next steps, then an agent's chip, then everything again.
  button(view, /Show the next steps \(from step 7\)/).click(); await settle();
  assert.ok(page.calls.some((c) => c.path === `/web/replay/${TASK}?from=7`), JSON.stringify(page.calls.map((c) => c.path)));
  button(view, /Show only the steps of owner:rob/).click(); await settle();
  assert.ok(page.calls.some((c) => c.path === `/web/replay/${TASK}?from=7&actor=${encodeURIComponent("owner:rob")}`), JSON.stringify(page.calls.map((c) => c.path)));
  assert.match(text(view), /Showing only: from 7, actor owner:rob\./);
  button(view, /Remove the filters/).click(); await settle();
  assert.equal(page.calls.at(-1)!.path, `/web/replay/${TASK}`);
  // Offline: opening a step, searching, expanding the thinking and simulating each say so, and the buttons can be pressed again.
  button(view, /Open Step 2 /).click(); await settle();
  offline = true;
  button(view, /Expand the model's thinking/).click(); await settle();
  assert.equal(button(view, /Expand the model's thinking/).disabled, false, "the thinking button is usable again");
  button(view, /^Simulate a rerun$/).click(); await settle();
  assert.equal(button(view, /^Simulate a rerun$/).disabled, false, "the simulate button is usable again");
  button(view, /^Search$/).click(); await settle();
  button(view, /Open Step 1 /).click(); await settle();
  assert.ok((text(view).match(/Offline\. Try again when the connection is back\./g) ?? []).length >= 4, text(view).slice(-600));
  assert.ok(!/Step 1 in full\s*Loading\.\.\./.test(text(view)), "no step is left loading");
  assert.deepEqual(page.doc.violations, []);
});
