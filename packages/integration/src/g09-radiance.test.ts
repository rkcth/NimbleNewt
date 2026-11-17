import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";
import { stopServer } from "@nimblenewt/controller/testing";
import { assertNoKey, Budget, BudgetExceeded, idleOf, keyFrom, manifestOfBody, measuredFetch, observeBody, oneAtATime, pinnedServed, RadianceRefused, ServerGate, SseFacts, type CallRecord } from "./g09-radiance-gate.js";
import { fakeRadiance } from "./g09-radiance-fake.js";
import { runG09Proof } from "./g09-radiance-run.js";

// Card G09, the measured run against Radiance: its safety pieces and the whole scenario, offline, against the scripted server in g09-radiance-fake.ts. The real run is g09-radiance-bench.ts (by hand, never in CI).

after(stopServer);

const SECRET = "test-key-0123456789abcdef";
const key = keyFrom(SECRET, "http://radiance.invalid:8002/v1");
const here = dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): string => readFileSync(join(here, "..", "..", "controller", "test-fixtures", "g10-radiance", name), "utf8");

test("the key is only a header: scrubbed from any text, counted, and refused in what is written", () => {
  assert.deepEqual(key.header(), { authorization: `Bearer ${SECRET}` });
  assert.equal(key.scrub(`a ${SECRET} b ${SECRET}`), "a <key> b <key>");
  assert.equal(key.count(`x${SECRET}y${SECRET}`), 2);
  assert.throws(() => assertNoKey(`{"k":"${SECRET}"}`, key, "the evidence"), (e: Error) => !e.message.includes(SECRET));
  assert.doesNotThrow(() => assertNoKey("{}", key, "the evidence"));
  assert.ok(!JSON.stringify(key).includes(SECRET), "the key object holds no enumerable copy of the key");
  assert.throws(() => keyFrom("short", "http://x"));
});

test("the idle gate: idle only when in_flight, running and waiting are stated and 0; the pinned model must already be resident", () => {
  assert.equal(idleOf({ in_flight: 0, running: 0, waiting: 0 }).ok, true);
  assert.equal(idleOf({ in_flight: 1, running: 0, waiting: 0 }).ok, false);
  assert.equal(idleOf({ in_flight: 0, running: 0 }).ok, false, "a missing count is busy");
  assert.equal(idleOf({ in_flight: "0", running: 0, waiting: 0 }).ok, false, "a count that is not a number is busy");
  assert.equal(pinnedServed({ data: [{ id: "qwen3.8-flash-next-iq4r", state: "resident" }] }, "qwen3.8-flash-next-iq4r").ok, true);
  assert.equal(pinnedServed({ data: [{ id: "qwen3.8-flash-next-iq4r", state: "cold" }] }, "qwen3.8-flash-next-iq4r").ok, false, "a cold model would have to be loaded");
  assert.equal(pinnedServed({ data: [{ id: "other", state: "resident" }] }, "qwen3.8-flash-next-iq4r").ok, false);
  assert.equal(pinnedServed({}, "qwen3.8-flash-next-iq4r").ok, false);
});

test("the gate refuses a busy server and a model that is not served, with GET requests only", async () => {
  const busy = fakeRadiance({ key: SECRET, busy: true });
  await assert.rejects(new ServerGate({ root: key.baseUrl, key, fetch: busy.fetch, settleMs: 300 }).check(), RadianceRefused);
  const cold = fakeRadiance({ key: SECRET, modelState: "cold" });
  await assert.rejects(new ServerGate({ root: key.baseUrl, key, fetch: cold.fetch }).check(), (e: RadianceRefused) => /cold/.test(e.why));
  // A busy reading that turns idle within the settling time lets the call go; nothing is sent while it is busy.
  const settling = fakeRadiance({ key: SECRET, busy: true });
  setTimeout(() => { settling.state.inFlight = 0; }, 250);
  assert.equal((await new ServerGate({ root: key.baseUrl, key, fetch: settling.fetch, settleMs: 3000 }).check()).idle, true);
  assert.equal(settling.requests.filter((r) => r.method === "POST").length, 0);
  assert.ok([...busy.requests, ...cold.requests].every((r) => r.method === "GET" && r.auth));
  const ok = fakeRadiance({ key: SECRET });
  const reading = await new ServerGate({ root: key.baseUrl, key, fetch: ok.fetch }).check();
  assert.equal(reading.idle, true);
});

test("a gate request that fails with the key in its error text is refused without the key (the message and the reason are scrubbed)", async () => {
  const leaky: typeof globalThis.fetch = async () => { throw new Error(`connect failed for Bearer ${SECRET} at radiance.invalid`); };
  const error = await new ServerGate({ root: key.baseUrl, key, fetch: leaky }).check().then(() => undefined, (e: unknown) => e);
  assert.ok(error instanceof RadianceRefused);
  assert.ok(!error.message.includes(SECRET) && !error.why.includes(SECRET) && !String(error.stack).includes(SECRET), "the key is in no part of the refusal");
  assert.match(error.why, /<key>/);
});

test("a model call whose connection fails with the key in its error text is recorded without the key", async () => {
  const server = fakeRadiance({ key: SECRET });
  const leaky: typeof globalThis.fetch = async (input, init) => ((init?.method ?? "GET").toUpperCase() === "POST" ? Promise.reject(new Error(`socket closed; Bearer ${SECRET}`)) : server.fetch(input, init));
  const calls: CallRecord[] = [];
  const f = measuredFetch({ fetch: leaky, gate: new ServerGate({ root: key.baseUrl, key, fetch: server.fetch }), budget: new Budget(3, 256), key, phase: () => "p", calls });
  await assert.rejects(f("http://radiance.invalid:8002/v1/chat/completions", { method: "POST", headers: key.header(), body: JSON.stringify({ messages: [], max_tokens: 10 }) }));
  assert.equal(calls[0]?.ended, "error");
  assert.match(calls[0]?.detail ?? "", /<key>/);
  assert.equal(key.count(JSON.stringify(calls)), 0);
});

test("the budget refuses a call past the count or without a reply limit within the cap", () => {
  const b = new Budget(2, 256);
  b.take({ max_tokens: 256 });
  assert.throws(() => b.take({ max_tokens: 257 }), BudgetExceeded);
  assert.throws(() => b.take({}), BudgetExceeded);
  b.take({ max_tokens: 1 });
  assert.throws(() => b.take({ max_tokens: 10 }), /has made them all/);
  assert.equal(b.calls, 2);
});

test("one at a time: a second call waits until the first has ended", async () => {
  const queue = oneAtATime();
  const order: string[] = [];
  let endFirst!: () => void;
  const first = queue(async (done) => { order.push("a start"); await new Promise<void>((r) => { endFirst = r; }); order.push("a end"); done(); });
  const second = queue(async (done) => { order.push("b start"); done(); });
  await new Promise((r) => setTimeout(r, 20));
  assert.deepEqual(order, ["a start"]);
  endFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["a start", "a end", "b start"]);
});

test("a cancel of the observed body reaches the connection (no tee keeps reading)", async () => {
  let cancelled = false;
  let pulls = 0;
  const source = new ReadableStream<Uint8Array>({ pull(c) { pulls++; c.enqueue(new Uint8Array([1])); }, cancel() { cancelled = true; } }, { highWaterMark: 0 });
  const ends: string[] = [];
  const observed = observeBody(source, () => undefined, (how) => ends.push(how));
  const reader = observed.getReader();
  await reader.read(); await reader.read();
  await reader.cancel();
  assert.equal(cancelled, true);
  assert.deepEqual(ends, ["cancelled"]);
  const before = pulls;
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pulls, before, "nothing is read after the cancel");
});

test("the stream reader takes Radiance's usage and timings from G10's captured events", () => {
  const facts = new SseFacts();
  facts.push(new TextEncoder().encode(fixture("repeat.sse")));
  assert.deepEqual([facts.facts.promptTokens, facts.facts.cachedTokens, facts.facts.cacheN, facts.facts.promptN, facts.facts.completionTokens, facts.facts.finish], [13471, 12288, 12288, 1183, 7, "stop"]);
  const cold = new SseFacts();
  const text = fixture("cold.sse");
  // Fed in small pieces, as a network delivers it.
  for (let i = 0; i < text.length; i += 7) cold.push(new TextEncoder().encode(text.slice(i, i + 7)));
  assert.equal(cold.facts.cachedTokens, 0);
  assert.ok((cold.facts.promptTokens ?? 0) > 13000);
});

test("the manifest of a request is role and text per message, tool calls named", () => {
  assert.deepEqual(manifestOfBody({ messages: [{ role: "system", content: "" }, { role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: null, tool_calls: [{ function: { name: "record_note" } }] }] }), ["system: ", "user: hi", "assistant: <call record_note>"]);
});

test("the measured fetch refuses before sending anything when the server is busy, and records the refusal without the key", async () => {
  const server = fakeRadiance({ key: SECRET, busy: true });
  const calls: CallRecord[] = [];
  const f = measuredFetch({ fetch: server.fetch, gate: new ServerGate({ root: key.baseUrl, key, fetch: server.fetch, settleMs: 300 }), budget: new Budget(3, 256), key, phase: () => "p", calls });
  await assert.rejects(f("http://radiance.invalid:8002/v1/chat/completions", { method: "POST", headers: key.header(), body: JSON.stringify({ messages: [], max_tokens: 10 }) }), RadianceRefused);
  assert.equal(server.requests.filter((r) => r.method === "POST").length, 0);
  assert.equal(calls[0]?.ended, "refused");
  assert.ok(!JSON.stringify(calls).includes(SECRET));
});

test("the whole scenario against the scripted server: every check holds, within the budget, one call at a time, the gate before every call, no key in the evidence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-g09r-"));
  try {
    // The server keeps each connection open a moment after [DONE] (as the real one was seen to): Pi's SDK stops reading at the marker, and the run must not wait on a body nobody reads (the first real run hung there).
    const server = fakeRadiance({ key: SECRET, lingerMs: 300 });
    const evidence = await runG09Proof({ fetch: server.fetch, key, baseUrl: key.baseUrl, model: "qwen3.8-flash-next-iq4r", dir, budget: new Budget(14, 1024), briefLines: 120, cutAfterChars: 200, drainMaxMs: 5000 });
    const failed = evidence.phases.flatMap((p) => [...p.checks.filter((c) => !c.ok).map((c) => `${p.name}: ${c.name} (${c.seen})`), ...(p.error === undefined ? [] : [`${p.name}: ${p.error}`])]);
    assert.deepEqual(failed, [], JSON.stringify(evidence.phases.map((p) => [p.name, p.error, p.measured]), null, 1));
    assert.equal(evidence.stopped, undefined);
    assert.ok(evidence.phases.every((p) => p.ran), "every phase ran");
    const posts = server.requests.filter((r) => r.method === "POST");
    assert.equal(posts.length, evidence.summary!.calls);
    assert.ok(posts.length >= 9 && posts.length <= 14, `${posts.length} model calls`);
    assert.equal(server.state.maxInFlight, 1, "never more than one call in flight");
    assert.ok(posts.every((r) => { const m = (r.body as { max_tokens?: number }).max_tokens; return m !== undefined && m <= 1024; }), "every call carried a reply limit within the budget");
    assert.ok(posts.every((r) => (r.body as { chat_template_kwargs?: { enable_thinking?: boolean } }).chat_template_kwargs?.enable_thinking === false));
    // The gate read /stats before every model call.
    const order = server.requests.map((r) => r.path);
    for (let i = 0; i < order.length; i++) if (order[i] === "/v1/chat/completions") assert.equal(order[i - 1], "/v1/models", `call at ${i} was not gated`);
    assert.ok(server.state.aborted >= 1, "the cancelled answers were closed by this client");
    assertNoKey(JSON.stringify(evidence), key, "the evidence");
    // The partial-call path is the one the scripted server allows (its tool arguments arrive in pieces).
    assert.equal(evidence.phases.find((p) => p.name.startsWith("E."))!.measured["path"], "partial call cut");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("with a server that sends a tool call whole, the scenario takes the other path: the complete call is held before admission and refused", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-g09r-"));
  try {
    const server = fakeRadiance({ key: SECRET, wholeToolCalls: true });
    const evidence = await runG09Proof({ fetch: server.fetch, key, baseUrl: key.baseUrl, model: "qwen3.8-flash-next-iq4r", dir, budget: new Budget(14, 1024), briefLines: 120, cutAfterChars: 200, drainMaxMs: 5000 });
    const e = evidence.phases.find((p) => p.name.startsWith("E."))!;
    assert.equal(e.measured["path"], "complete call held before admission");
    assert.deepEqual(e.checks.filter((c) => !c.ok), [], JSON.stringify(e, null, 1));
    assert.equal(e.measured["admittedAfterCorrection"] !== undefined, true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a server that is busy at the start: the run stops before any model call, and says why", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-g09r-"));
  try {
    const server = fakeRadiance({ key: SECRET, busy: true });
    const evidence = await runG09Proof({ fetch: server.fetch, key, baseUrl: key.baseUrl, model: "qwen3.8-flash-next-iq4r", dir, budget: new Budget(14, 1024) });
    assert.match(evidence.stopped ?? "", /not idle/);
    assert.equal(server.requests.filter((r) => r.method === "POST").length, 0);
    assert.ok(evidence.phases.every((p) => !p.ran));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a budget smaller than the scenario stops the run at the first call past it, and the rest is recorded as not run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-g09r-"));
  try {
    const server = fakeRadiance({ key: SECRET });
    const evidence = await runG09Proof({ fetch: server.fetch, key, baseUrl: key.baseUrl, model: "qwen3.8-flash-next-iq4r", dir, budget: new Budget(2, 1024), briefLines: 60 });
    assert.equal(server.requests.filter((r) => r.method === "POST").length, 2);
    assert.match(evidence.stopped ?? "", /budget/);
    assert.ok(evidence.phases.some((p) => !p.ran));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
