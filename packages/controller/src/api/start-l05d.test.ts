import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRelay } from "../dispatch/relay.js";
import { GENERATION_REUSE_MAX, GenerationRefused, GenerationService, reusedCallId } from "../generation/index.js";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { world } from "./testing/remote-world.js";

// Card L05d through the composed controller: the worker is a real HTTP client of the worker transport; its own model relay (the same ModelRelay class a worker host runs) records each reply through the protocol, and the controller's tool bridge
// binds the calls that follow to what the model wrote, admits a write as an effect of its generation and settles the effect with the operation's outcome.
const enc = new TextEncoder();
const sse = (...events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const chunk = (delta: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const callChunk = (index: number, id: string, name: string, args: string): object => chunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] });
const request = { url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [["content-type", "application/json"]] as const, body: enc.encode(JSON.stringify({ model: "local", messages: [] })), signal: new AbortController().signal };
const fetchOf = (body: string): typeof globalThis.fetch => async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const drain = async (body: AsyncIterable<Uint8Array> | null): Promise<void> => { if (body !== null) for await (const p of body) void p; };
const WRITE = { kind: "note", title: "Seeds", body: "beans", visibility: "shared" };

interface Call { readonly id: string; readonly name: string; readonly args: string }
/** The stuff each test needs: a started remote attempt, a way to make the model write a reply, and the bridge. */
async function rig(d: string, options: { local?: boolean } = {}) {
  const w = await world(d, {} as never, { grants: [{ action: "desk.write", project: "*" }, { action: "desk.read", project: "*" }], start: { tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => options.local === true } } });
  const r1 = await w.host("r1");
  const t = await w.task("Order seeds");
  assert.deepEqual((await w.tick()).started, [t.attemptId]);
  const offer = (await r1.client.offers())[0]!;
  const attempt = r1.client.attempt(t.attemptId, offer.placement);
  await attempt.accept();
  assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
  const gen = w.c.dispatch!.generation;
  const token = (await w.c.services.principals.issueCredential(w.rob, w.rob.id)).token;
  const api = async (op: string, args: Record<string, unknown>) => (await w.c.api.handle(token, { v: 1, op, commandId: `c-${op}-${Math.random().toString(36).slice(2, 10)}`, args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
  assert.ok((await api("generation.stream.change", { set: { batchMs: 0, batchChars: 0 } })).ok);
  /** The model writes a reply with these tool calls; the worker's relay records it through the protocol. */
  const reply = async (...calls: Call[]): Promise<number> => {
    const body = sse(chunk({ content: "Ordering" }), ...calls.map((c, i) => callChunk(i, c.id, c.name, c.args)), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const relay = new ModelRelay({ fetch: fetchOf(body), endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap({ batchMs: 0 }) });
    await drain((await relay.relay(request as never)).body);
    return (await gen.gate(w.rob, t.taskId))!.gate.current!;
  };
  const bridge = (callId: string, op: string, args: Record<string, unknown> = {}) => w.c.tools!.handle(offer.order.credential, w.c.dispatch!.dispatcher.gateway(t.attemptId), { op, callId, args: args as never });
  const run = (n: number) => gen.view(w.rob, GenerationService.runIdOf(t.taskId, n)).then((v) => v!.run);
  return { w, t, offer, attempt, gen, api, reply, bridge, run, close: async () => { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}
const dir = (): string => mkdtempSync(join(tmpdir(), "nn-l05d-"));
const desk = (title = "Seeds") => ({ ...WRITE, title });

test("a recorded call is bound to the operation it asks for by its name and arguments, and a write is admitted as an effect of its generation and settled with the outcome; asking again does not run it again (card L05d)", async () => {
  const x = await rig(dir());
  try {
    const n = await x.reply({ id: "call_w", name: "nimblenewt__desk-write", args: JSON.stringify(WRITE) });
    // Written as one operation, presented as another: refused, nothing runs.
    const wrongOp = await x.bridge("call_w", "task.update", { expectedRevision: 1, title: "x" });
    assert.ok(!wrongOp.ok && wrongOp.code === "generation_refused" && /written by the model as nimblenewt__desk-write, not as nimblenewt__task-update/.test(wrongOp.message) && /not run/.test(wrongOp.message), JSON.stringify(wrongOp));
    // The right operation with other arguments than the model wrote: refused.
    const wrongArgs = await x.bridge("call_w", "desk.write", { ...WRITE, body: "tomatoes" });
    assert.ok(!wrongArgs.ok && wrongArgs.code === "generation_refused" && /not those the model wrote/.test(wrongArgs.message), JSON.stringify(wrongArgs));
    assert.equal((await x.run(n)).toolCalls[0]!.state, "complete", "a refused call was not admitted");
    // The call as written: it runs, and is admitted as an effect of its generation and settled.
    const first = await x.bridge("call_w", "desk.write", WRITE);
    assert.ok(first.ok, JSON.stringify(first));
    const call = (await x.run(n)).toolCalls[0]!;
    assert.equal(call.state, "admitted");
    assert.ok(call.effectId !== undefined);
    const effect = await x.w.c.storage.getEffect(call.effectId!);
    assert.equal(effect?.status, "confirmed");
    // Asked again (a retry of the same call): answered from the ledger, the write is not run a second time (a second run would say replayed: true).
    const again = await x.bridge("call_w", "desk.write", WRITE);
    assert.ok(again.ok && (again.result as { replayed: boolean }).replayed === false, JSON.stringify(again));
    assert.deepEqual(again, first);
    // With the binding turned off by the owner's chat setting the same call goes through under other arguments (the owner's choice).
    const off = await x.api("generation.stream.change", { disable: ["bindCall"] });
    assert.ok(off.ok, JSON.stringify(off));
    const n2 = await x.reply({ id: "call_x", name: "nimblenewt__desk-write", args: JSON.stringify(desk("A")) });
    assert.ok((await x.bridge("call_x", "desk.write", desk("B"))).ok);
    assert.equal((await x.run(n2)).toolCalls[0]!.state, "admitted");
  } finally { await x.close(); }
});

test("a refused operation is a failed effect and says so again when asked again; a read is not admitted; turning admission off leaves the call as it was (card L05d)", async () => {
  const x = await rig(dir());
  try {
    const bad = { ...WRITE, visibility: "nobody" };
    const n = await x.reply({ id: "call_b", name: "nimblenewt__desk-write", args: JSON.stringify(bad) }, { id: "call_r", name: "nimblenewt__desk-read", args: JSON.stringify({ recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" }) });
    const refused = await x.bridge("call_b", "desk.write", bad);
    assert.ok(!refused.ok, JSON.stringify(refused));
    const call = (await x.run(n)).toolCalls.find((c) => c.id === "call_b")!;
    assert.equal(call.state, "admitted");
    assert.equal((await x.w.c.storage.getEffect(call.effectId!))?.status, "failed", "what did not happen is a failed effect, not an uncertain one");
    const again = await x.bridge("call_b", "desk.write", bad);
    assert.ok(!again.ok && again.code === refused.code && again.message === refused.message, JSON.stringify(again));
    // A read is no effect.
    await x.bridge("call_r", "desk.read", { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa" });
    assert.equal((await x.run(n)).toolCalls.find((c) => c.id === "call_r")!.state, "complete");
    // Admission off: the write runs as before and the call stays complete.
    assert.ok((await x.api("generation.stream.change", { disable: ["admitCall"] })).ok);
    const n2 = await x.reply({ id: "call_o", name: "nimblenewt__desk-write", args: JSON.stringify(desk("O")) });
    assert.ok((await x.bridge("call_o", "desk.write", desk("O"))).ok);
    assert.equal((await x.run(n2)).toolCalls[0]!.state, "complete");
  } finally { await x.close(); }
});

test("the generation service admits a bridge call only while it is complete in the current generation: partial, withdrawn and unrecorded calls cannot start an effect by that route (card L05d)", async () => {
  const x = await rig(dir());
  try {
    const owner = x.w.c.dispatch!.principal;
    const n = await x.reply({ id: "call_p", name: "nimblenewt__desk-write", args: '{"kind":"note"' }, { id: "call_c", name: "nimblenewt__desk-write", args: JSON.stringify(WRITE) });
    assert.equal((await x.run(n)).toolCalls.find((c) => c.id === "call_p")!.state, "dropped");
    // A call that was cut off is no call: checked and admitted alike it is refused.
    const partial = await x.bridge("call_p", "desk.write", { kind: "note" });
    assert.ok(!partial.ok && partial.code === "generation_refused", JSON.stringify(partial));
    await assert.rejects(x.gen.admitCall(owner, { commandId: "a-p", taskId: x.t.taskId, callId: "call_p", target: "desk.write" }), (e: unknown) => e instanceof GenerationRefused && e.reason === "incomplete");
    await assert.rejects(x.gen.admitCall(owner, { commandId: "a-u", taskId: x.t.taskId, callId: "call_none", target: "desk.write" }), (e: unknown) => e instanceof GenerationRefused);
    // The owner corrects the task between the check and the admission: the admission itself refuses.
    assert.equal((await x.gen.correct(x.w.rob, { commandId: "fix", taskId: x.t.taskId, expectedContextRevision: 1, reason: "use beans" })).contextRevision, 2);
    await assert.rejects(x.gen.admitCall(owner, { commandId: "a-c", taskId: x.t.taskId, callId: "call_c", target: "desk.write" }), (e: unknown) => e instanceof GenerationRefused && (e.reason === "interrupted" || e.reason === "stale"));
    assert.equal((await x.run(n)).toolCalls.find((c) => c.id === "call_c")!.effectId, undefined, "no effect was recorded for it");
    // Only the dispatcher and the owner may ask.
    await assert.rejects(x.gen.admitCall({ kind: "agent", id: "agent:ann" } as never, { commandId: "a-x", taskId: x.t.taskId, callId: "call_c", target: "x" }), /may not admit/);
  } finally { await x.close(); }
});

test("a call whose provider ID the bridge rewrote is matched to its recorded call: an unsafe or long ID by its alias, a repeated one by its number (card L05d)", async () => {
  const x = await rig(dir());
  try {
    const { bridgeCallIdOf } = await import("../dispatch/model-stream.js");
    // An ID with characters the recorder does not keep: recorded as call-0, with the ID the bridge will send as an alias.
    const raw = "call with spaces/и ? 1";
    const n = await x.reply({ id: raw, name: "nimblenewt__desk-write", args: JSON.stringify(WRITE) });
    const recorded = (await x.run(n)).toolCalls[0]!;
    assert.equal(recorded.id, "call-0");
    assert.deepEqual(recorded.aliases, [bridgeCallIdOf(raw)]);
    assert.match(bridgeCallIdOf(raw), /^h:[0-9a-f]{40}$/);
    const ok = await x.bridge(bridgeCallIdOf(raw), "desk.write", WRITE);
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal((await x.run(n)).toolCalls[0]!.state, "admitted");
    // An ID of 82 characters: too long to record (80), short enough for the bridge to send as it is.
    const long = "c".repeat(82);
    const n2 = await x.reply({ id: long, name: "nimblenewt__desk-write", args: JSON.stringify(desk("L")) });
    assert.equal((await x.run(n2)).toolCalls[0]!.id, "call-0");
    const longAnswer = await x.bridge(long, "desk.write", desk("L"));
    assert.ok(longAnswer.ok, JSON.stringify(longAnswer));
    // A provider that counts from zero in every reply: the second use of call_0 reaches the bridge as `d:...`, the third as another; each is the call of its own generation.
    const a = await x.reply({ id: "call_0", name: "nimblenewt__desk-write", args: JSON.stringify(desk("D1")) });
    const b = await x.reply({ id: "call_0", name: "nimblenewt__desk-write", args: JSON.stringify(desk("D2")) });
    const c = await x.reply({ id: "call_0", name: "nimblenewt__desk-write", args: JSON.stringify(desk("D3")) });
    // The extension numbers its uses of the ID: the first is `call_0`; the nth later one is the digest of the ID and n. The newest generation's call is the one a late use of the number it holds finds.
    const second = await x.bridge(reusedCallId("call_0", 2), "desk.write", desk("D2"));
    const third = await x.bridge(reusedCallId("call_0", 3), "desk.write", desk("D3"));
    // The call of the current generation (the third reply) passes, an earlier generation's is refused as no longer current.
    assert.ok(third.ok, JSON.stringify(third));
    assert.ok(!second.ok && second.code === "generation_refused", JSON.stringify(second));
    assert.equal((await x.run(c)).toolCalls[0]!.state, "admitted");
    assert.equal((await x.run(a)).toolCalls[0]!.state, "withdrawn", "a newer generation superseded it");
    assert.equal((await x.run(b)).toolCalls[0]!.state, "withdrawn");
    assert.ok(GENERATION_REUSE_MAX >= 100);
    // A number past what is looked for: unrecorded, so it passes by default and is refused under requireRecorded.
    assert.ok((await x.bridge(reusedCallId("call_0", GENERATION_REUSE_MAX + 5), "task.get")).ok);
  } finally { await x.close(); }
});

test("a remote worker that never opens a model stream is noticed: the owner's activity says so once, and the owner can have its calls refused (card L05d)", async () => {
  const d = dir();
  const w = await world(d, {} as never, { grants: [{ action: "desk.write", project: "*" }], start: { tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => false } } });
  try {
    const r1 = await w.host("r1");
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const attempt = r1.client.attempt(t.attemptId, offer.placement);
    await attempt.accept();
    assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
    const token = (await w.c.services.principals.issueCredential(w.rob, w.rob.id)).token;
    const api = async (op: string, args: Record<string, unknown>) => (await w.c.api.handle(token, { v: 1, op, commandId: `c-${Math.random().toString(36).slice(2, 10)}`, args } as never)) as { ok: boolean };
    const bridge = (callId: string, op: string, args: Record<string, unknown> = {}) => w.c.tools!.handle(offer.order.credential, w.c.dispatch!.dispatcher.gateway(t.attemptId), { op, callId, args: args as never });
    const steps = async (): Promise<string[]> => {
      const r = await w.c.api.handle(token, { v: 1, op: "activity.steps", args: { taskId: t.taskId } } as never) as { ok: boolean; result?: any };
      return JSON.stringify(r).match(/never reported a model stream/g) ?? [];
    };
    // Its tool calls are unrecorded; the declaration reads are not model calls and say nothing.
    assert.ok((await bridge("decl-1", "tool.discover")).ok);
    assert.equal((await steps()).length, 0);
    assert.ok((await bridge("call_1", "task.get")).ok, "by default the call goes on");
    assert.ok((await bridge("call_2", "task.get")).ok);
    assert.equal((await steps()).length, 1, "the owner is told once per attempt");
    // The owner requires a stream from remote workers: a call from a worker that never reported one is refused.
    assert.ok((await api("generation.stream.change", { enable: ["requireStream"] })).ok);
    const refused = await bridge("call_3", "task.get");
    assert.ok(!refused.ok && refused.code === "generation_refused" && /never reported a model stream/.test(refused.message), JSON.stringify(refused));
    assert.ok((await bridge("decl-2", "tool.discover")).ok, "declaration reads still pass");
    // Once the worker streams, its calls are checked and pass.
    const relay = new ModelRelay({ fetch: fetchOf(sse(chunk({ content: "x" }), callChunk(0, "call_4", "nimblenewt__task-get", "{}"), chunk({}, "tool_calls")) + "data: [DONE]\n\n"), endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap({ batchMs: 0 }) });
    await drain((await relay.relay(request as never)).body);
    assert.ok((await bridge("call_4", "task.get")).ok);
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a remote worker's model calls are reported to stall detection: the start, the first output, the output that keeps arriving, and the end of each call (card L05d)", async () => {
  const d = dir();
  const w = await world(d, {} as never, { monitorProgressMs: 0, start: { tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => false } } });
  try {
    const r1 = await w.host("r1");
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const attempt = r1.client.attempt(t.attemptId, offer.placement);
    await attempt.accept();
    assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
    const evidence = async () => (await w.c.storage.getAggregate({ kind: "stall-evidence", id: t.taskId }))?.body as { request?: { id: string; firstOutputAt?: string; outputTokens?: number }; lastRequestMs?: number } | undefined;
    const until = async (ok: () => Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };
    // The model's reply is held open after its first words.
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    let release2!: () => void;
    const held2 = new Promise<void>((r) => { release2 = r; });
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(enc.encode(sse(chunk({ content: "Ordering " })))); await held; c.enqueue(enc.encode(sse(chunk({ content: "beans ".repeat(20) })))); await held2; c.enqueue(enc.encode(sse(chunk({ content: "beans" }), chunk({}, "stop")) + "data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const relay = new ModelRelay({ fetch, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap({ batchMs: 0 }) });
    const answer = await relay.relay(request as never);
    const reading = drain(answer.body);
    await until(async () => (await evidence())?.request?.firstOutputAt !== undefined, "the open call, with its first output, was never reported to stall detection");
    assert.ok((await evidence())!.request!.id.startsWith(`${t.attemptId}:`));
    release();
    // More output while the reply still streams: reported as progress, so a long reply is not taken for silence.
    await until(async () => ((await evidence())?.request?.outputTokens ?? 0) > 0, "the output that kept arriving was never reported to stall detection");
    release2();
    await reading;
    await until(async () => (await evidence())?.request === undefined && (await evidence())?.lastRequestMs !== undefined, "the end of the call was never reported");
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
