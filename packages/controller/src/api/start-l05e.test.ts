import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRelay } from "../dispatch/relay.js";
import { GenerationService } from "../generation/index.js";
import { FULL_ABILITIES, wireRefuses } from "../remote/testing/suite.js";
import { world } from "./testing/remote-world.js";

// Card L05e through the composed controller: a remote worker's tool request goes over the worker protocol to the controller's real tool bridge, bound to the attempt, and is admitted through the same generation check and effect ledger as a
// local worker's; the remote model call is reported to stall detection with its route and host.
const enc = new TextEncoder();
const sse = (...events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const chunk = (delta: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const callChunk = (index: number, id: string, name: string, args: string): object => chunk({ tool_calls: [{ index, id, type: "function", function: { name, arguments: args } }] });
const request = { url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [["content-type", "application/json"]] as const, body: enc.encode(JSON.stringify({ model: "local", messages: [] })), signal: new AbortController().signal };
const fetchOf = (body: string): typeof globalThis.fetch => async () => new Response(new ReadableStream<Uint8Array>({ start(c) { c.enqueue(enc.encode(body)); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
const drain = async (body: AsyncIterable<Uint8Array> | null): Promise<void> => { if (body !== null) for await (const p of body) void p; };
const WRITE = { kind: "note", title: "Seeds", body: "beans", visibility: "shared" };
const dir = (): string => mkdtempSync(join(tmpdir(), "nn-l05e-"));

async function rig(d: string) {
  const w = await world(d, {} as never, { grants: [{ action: "desk.write", project: "*" }, { action: "desk.read", project: "*" }], monitorProgressMs: 0, start: { tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => false } } });
  const r1 = await w.host("r1");
  const r2 = await w.host("r2");
  const t = await w.task("Order seeds");
  assert.deepEqual((await w.tick()).started, [t.attemptId]);
  const offer = (await r1.client.offers())[0]!;
  const attempt = r1.client.attempt(t.attemptId, offer.placement);
  await attempt.accept();
  assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
  const gen = w.c.dispatch!.generation;
  const token = (await w.c.services.principals.issueCredential(w.rob, w.rob.id)).token;
  const api = async (op: string, args: Record<string, unknown>) => (await w.c.api.handle(token, { v: 1, op, commandId: `c-${op}-${Math.random().toString(36).slice(2, 10)}`, args } as never)) as { ok: boolean };
  assert.ok((await api("generation.stream.change", { set: { batchMs: 0, batchChars: 0 } })).ok);
  const reply = async (callId: string, name: string, args: string): Promise<number> => {
    const body = sse(chunk({ content: "Ordering" }), callChunk(0, callId, name, args), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const relay = new ModelRelay({ fetch: fetchOf(body), endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap({ batchMs: 0 }) });
    await drain((await relay.relay(request as never)).body);
    return (await gen.gate(w.rob, t.taskId))!.gate.current!;
  };
  const credential = offer.order.credential;
  const over = (callId: string, op: string, args: Record<string, unknown> = {}) => attempt.toolBridge(credential, { op, callId, args: args as never });
  const inProcess = (callId: string, op: string, args: Record<string, unknown> = {}) => w.c.tools!.handle(credential, w.c.dispatch!.dispatcher.gateway(t.attemptId), { op, callId, args: args as never });
  const run = (n: number) => gen.view(w.rob, GenerationService.runIdOf(t.taskId, n)).then((v) => v!.run);
  return { w, t, r1, r2, offer, attempt, gen, api, reply, over, inProcess, run, credential, close: async () => { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); } };
}

test("a remote worker's write goes over the protocol to the real bridge: checked against the generation that recorded it, admitted as an effect, settled, and asked again it is answered from the ledger and does not run twice (card L05e)", async () => {
  const x = await rig(dir());
  try {
    const n = await x.reply("call_w", "nimblenewt__desk-write", JSON.stringify(WRITE));
    // The right operation with other arguments than the model wrote is refused, as for a local worker.
    const wrong = await x.over("call_w", "desk.write", { ...WRITE, body: "tomatoes" });
    assert.ok(!wrong.ok && wrong.code === "generation_refused" && /not those the model wrote/.test(wrong.message), JSON.stringify(wrong));
    assert.equal((await x.run(n)).toolCalls[0]!.state, "complete", "a refused call was not admitted");
    const first = await x.over("call_w", "desk.write", WRITE);
    assert.ok(first.ok, JSON.stringify(first));
    const call = (await x.run(n)).toolCalls[0]!;
    assert.equal(call.state, "admitted");
    assert.equal((await x.w.c.storage.getEffect(call.effectId!))?.status, "confirmed");
    // A lost answer: the worker asks again, by the protocol and by the in-process route; the ledger answers, the write is not run again.
    const again = await x.over("call_w", "desk.write", WRITE);
    assert.deepEqual(again, first);
    assert.deepEqual(await x.inProcess("call_w", "desk.write", WRITE), first, "the route and the in-process bridge are one bridge");
    assert.equal((first as unknown as { result: { replayed: boolean } }).result.replayed, false);
    // A read is not an effect and the route answers it as the bridge does.
    const read = await x.over("decl-1", "tool.discover", {});
    assert.deepEqual(read, await x.inProcess("decl-1", "tool.discover", {}));
  } finally { await x.close(); }
});

test("a remote worker's call of a corrected generation is refused by the real bridge over the protocol, with no effect; a placement that is no longer current is fenced before the bridge (card L05e)", async () => {
  const x = await rig(dir());
  try {
    const n = await x.reply("call_s", "nimblenewt__desk-write", JSON.stringify(WRITE));
    assert.equal((await x.gen.correct(x.w.rob, { commandId: "fix", taskId: x.t.taskId, expectedContextRevision: 1, reason: "use beans" })).contextRevision, 2);
    const refused = await x.over("call_s", "desk.write", WRITE);
    assert.ok(!refused.ok && refused.code === "generation_refused", JSON.stringify(refused));
    assert.equal((await x.run(n)).toolCalls[0]!.effectId, undefined, "no effect was recorded for it");
    // The same worker with the placement number of another holding: fenced at the route.
    await wireRefuses("fenced", () => x.r1.client.attempt(x.t.attemptId, x.offer.placement + 1).toolBridge(x.credential, { op: "task.get", callId: "late-1", args: {} }), 409);
    // The attempt completed: its requests are fenced.
    await x.attempt.complete({ status: "completed", text: "done" } as never);
    await wireRefuses("fenced", () => x.attempt.toolBridge(x.credential, { op: "task.get", callId: "late-2", args: {} }), 409);
  } finally { await x.close(); }
});

test("another host, and a credential that is not this attempt's, reach nothing; no answer or error carries the credential (card L05e)", async () => {
  const x = await rig(dir());
  try {
    const n = await x.reply("call_w", "nimblenewt__desk-write", JSON.stringify(WRITE));
    // Another enrolled host naming this host's attempt.
    await wireRefuses("not_found", () => x.r2.client.attempt(x.t.attemptId, x.offer.placement).toolBridge(x.credential, { op: "desk.write", callId: "call_w", args: WRITE }), 404, (e) => assert.equal(e.message.includes(x.credential), false));
    assert.equal((await x.run(n)).toolCalls[0]!.state, "complete", "nothing was admitted");
    // The owner's credential, a made-up one, and one of the right shape for nobody: the bridge does not accept them for this attempt, and says nothing of why.
    const ownerToken = (await x.w.c.services.principals.issueCredential(x.w.rob, x.w.rob.id)).token;
    for (const bad of [ownerToken, "nnt-not-a-credential", x.credential.slice(0, -2) + "xx"]) {
      const answer = await x.attempt.toolBridge(bad, { op: "desk.write", callId: "call_w", args: WRITE });
      assert.ok(!answer.ok && answer.code === "unauthenticated", JSON.stringify(answer));
      assert.equal(JSON.stringify(answer).includes(bad), false);
    }
    assert.equal((await x.run(n)).toolCalls[0]!.state, "complete");
    assert.equal((await x.over("call_w", "desk.write", WRITE)).ok, true, "the attempt's own credential still works");
  } finally { await x.close(); }
});

test("a remote worker's model call is reported to stall detection with the order's route and the host that runs it, so the route's speed on that host can be read (card L05e)", async () => {
  const x = await rig(dir());
  try {
    const evidence = async () => (await x.w.c.storage.getAggregate({ kind: "stall-evidence", id: x.t.taskId }))?.body as { request?: { id: string; route?: string; hostId?: string; firstOutputAt?: string } } | undefined;
    const until = async (ok: () => Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    const fetch: typeof globalThis.fetch = async () => new Response(new ReadableStream<Uint8Array>({ async start(c) { c.enqueue(enc.encode(sse(chunk({ content: "Ordering " })))); await held; c.enqueue(enc.encode(sse(chunk({ content: "beans" }), chunk({}, "stop")) + "data: [DONE]\n\n")); c.close(); } }), { status: 200, headers: { "content-type": "text/event-stream" } });
    const relay = new ModelRelay({ fetch, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: x.attempt.streamTap({ batchMs: 0 }) });
    const reading = drain((await relay.relay(request as never)).body);
    await until(async () => (await evidence())?.request?.firstOutputAt !== undefined, "the open call was never reported");
    const open = (await evidence())!.request!;
    assert.equal(open.route, "localp/small");
    assert.equal(open.hostId, "host:r1");
    release();
    await reading;
  } finally { await x.close(); }
});
