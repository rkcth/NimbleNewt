import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelRelay } from "../dispatch/relay.js";
import { GenerationService } from "../generation/index.js";
import { WorkerRequestError } from "../remote/index.js";
import { FULL_ABILITIES } from "../remote/testing/suite.js";
import { world } from "./testing/remote-world.js";

// Card L05c through the composed controller: the worker is a real HTTP client of the controller's worker transport; its own model relay (the same ModelRelay class a worker host runs) records every reply through the protocol.
const enc = new TextEncoder();
const sse = (...events: unknown[]): string => events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("");
const chunk = (delta: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const callChunk = (id: string): object => chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: "task-get", arguments: "{}" } }] });
const request = { url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [["content-type", "application/json"]] as const, body: enc.encode(JSON.stringify({ model: "local", messages: [] })), signal: new AbortController().signal };
const gate = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };
type Piece = string | Promise<void>;
/** A model endpoint of the worker's own: each call plays the next script; a piece that is a promise is awaited before the next goes out. */
function endpoint(scripts: Piece[][]) {
  let calls = 0;
  const fetch: typeof globalThis.fetch = async () => {
    const script = scripts[Math.min(calls++, scripts.length - 1)]!;
    const body = new ReadableStream<Uint8Array>({ async start(controller) { for (const p of script) { if (typeof p === "string") controller.enqueue(enc.encode(p)); else await p; } controller.close(); } });
    return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  return fetch;
}
const drain = async (body: AsyncIterable<Uint8Array> | null): Promise<string> => { let out = ""; if (body !== null) for await (const p of body) out += Buffer.from(p).toString("utf8"); return out; };

test("a remote worker's model stream is recorded against the generation it began under; a late reply is held and a call of a corrected generation is refused at the bridge with the reason (card L05c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l05c-"));
  const w = await world(d, {} as never, { start: { tools: { runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => false } } });
  try {
    const r1 = await w.host("r1");
    const t = await w.task("Order seeds");
    assert.deepEqual((await w.tick()).started, [t.attemptId]);
    const offer = (await r1.client.offers())[0]!;
    const attempt = r1.client.attempt(t.attemptId, offer.placement);
    await attempt.accept();
    assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
    const gen = w.c.dispatch!.generation;
    const tools = w.c.tools!;
    const bridge = (callId: string, op = "tool.discover") => tools.handle(offer.order.credential, w.c.dispatch!.dispatcher.gateway(t.attemptId), { op, callId, args: {} });

    // Every piece is checked at once (the owner's batch settings at 0), so the cut is exact in this test; with batching a piece just after a correction may be recorded as late and still pass (see the L05b notes).
    const token = (await w.c.services.principals.issueCredential(w.rob, w.rob.id)).token;
    assert.ok((await w.c.api.handle(token, { v: 1, op: "generation.stream.change", commandId: "bt", args: { set: { batchMs: 0, batchChars: 0 } } } as never) as { ok: boolean }).ok);
    // First reply: a complete tool call reaches the worker, then the model goes on writing; the owner corrects the task meanwhile.
    const go = gate();
    const first = endpoint([[sse(chunk({ content: "Ordering " }), callChunk("call_a"), chunk({}, "tool_calls")), go.promise, sse(chunk({ content: "tomatoes" })) + "data: [DONE]\n\n"]]);
    const relay = new ModelRelay({ fetch: first, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap({ batchMs: 0 }) });
    const answer = await relay.relay(request as never);
    const seen: string[] = [];
    const reading = (async () => { try { for await (const p of answer.body!) seen.push(Buffer.from(p).toString("utf8")); return undefined; } catch (error) { return error as Error; } })();
    // The generation is on record, bound to the attempt's fence, while the reply streams.
    const run1 = GenerationService.runIdOf(t.taskId, 1);
    const until = async (ok: () => Promise<boolean>): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok())) { if (Date.now() > end) assert.fail("timed out"); await new Promise((r) => setTimeout(r, 25)); } };
    await until(async () => ((await gen.view(w.rob, run1))?.run.toolCalls ?? []).some((c) => c.id === "call_a" && c.state === "complete"));
    const before = (await gen.view(w.rob, run1))!.run;
    assert.deepEqual(before.fence, { generation: (await w.c.services.assignments.getAssignment(t.taskId))!.generation, attemptId: t.attemptId });
    assert.equal(before.contextRevision, 1);
    // While current, the bridge accepts the call.
    const okNow = await bridge("call_a");
    assert.equal(okNow.ok, true, JSON.stringify(okNow));

    assert.equal((await gen.correct(w.rob, { commandId: "fix", taskId: t.taskId, expectedContextRevision: 1, reason: "use beans, not tomatoes" })).contextRevision, 2);
    go.open();
    const failure = await reading;
    assert.match(failure?.message ?? "", /the model reply was held back: generation 1 of task .* was corrected by .*use beans/);
    assert.ok(!seen.join("").includes("tomatoes"), "the late text never reached the worker");
    const after = (await gen.view(w.rob, run1))!.run;
    assert.equal(after.interrupted?.kind, "corrected");
    assert.ok(after.late.some((l) => /tomatoes/.test(l.preview ?? "")), "the late reply is shown as late on the record");

    // The tool call of the corrected generation is refused at the bridge, with the reason, and nothing is run.
    const refused = await bridge("call_a");
    assert.ok(!refused.ok && refused.code === "generation_refused" && /corrected by .*use beans/.test(refused.message), JSON.stringify(refused));

    // The next call begins under the new revision and its tool call passes.
    const second = endpoint([[sse(callChunk("call_b"), chunk({}, "tool_calls")) + "data: [DONE]\n\n"]]);
    const relay2 = new ModelRelay({ fetch: second, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap({ batchMs: 0 }) });
    await drain((await relay2.relay(request as never)).body);
    const run2 = (await gen.view(w.rob, GenerationService.runIdOf(t.taskId, 2)))!.run;
    assert.equal(run2.contextRevision, 2);
    assert.equal(run2.state, "finished");
    assert.equal((await bridge("call_b")).ok, true);
    assert.equal((await bridge("call_a")).ok, false, "the earlier call stays refused");

    // A call no generation recorded passes by default (a worker whose stream is not recorded is not stopped) and is refused when the owner requires a recorded one.
    assert.equal((await bridge("call_unknown")).ok, true);
    const changed = await w.c.api.handle(token, { v: 1, op: "generation.stream.change", commandId: "rq", args: { enable: ["requireRecorded"] } } as never) as { ok: boolean };
    assert.ok(changed.ok, JSON.stringify(changed));
    const required = await bridge("call_unknown2", "task.get");
    assert.equal((await bridge("call_unknown3")).ok, true, "the extension's declaration reads (tool.discover) need no generation");
    assert.ok(!required.ok && /belongs to no recorded generation/.test(required.message), JSON.stringify(required));
    assert.ok(changed.ok && (await w.c.api.handle(token, { v: 1, op: "generation.stream.change", commandId: "ck", args: { disable: ["checkBridge", "requireRecorded"] } } as never) as { ok: boolean }).ok);
    assert.equal((await bridge("call_a")).ok, true, "with the check turned off the earlier call passes (the owner's choice)");

    // A message whose answer was lost is sent again: the start (same key) does not begin a second generation, the events (same number) are recorded once, and ending twice is harmless.
    const path = (a: string): string => `/worker/attempts/${t.attemptId}/${a}`;
    const post = async (a: string, body: Record<string, unknown>, key?: string) => (await r1.client.send("POST", path(a), { body: { placement: offer.placement, ...body } as never, session: true, ...(key === undefined ? {} : { key }) })).body as Record<string, unknown>;
    const s1 = await post("stream-start", { call: { requestChars: 5 } }, "k-start");
    const s2 = await post("stream-start", { call: { requestChars: 5 } }, "k-start");
    assert.equal(s1["streamId"], s2["streamId"]);
    const gens = (await gen.gate(w.rob, t.taskId))!.gate.runs;
    const evt = [{ kind: "text", text: "once" }];
    await post("stream-events", { streamId: s1["streamId"], n: 1, events: evt });
    await post("stream-events", { streamId: s1["streamId"], n: 1, events: evt });
    await assert.rejects(post("stream-events", { streamId: s1["streamId"], n: 3, events: evt }), (e: unknown) => e instanceof WorkerRequestError && e.code === "invalid_command");
    await post("stream-end", { streamId: s1["streamId"], ok: true });
    await post("stream-end", { streamId: s1["streamId"], ok: true });
    const dup = (await gen.view(w.rob, GenerationService.runIdOf(t.taskId, gens)))!.run;
    assert.equal(dup.text, "once");
    assert.equal(dup.state, "finished");
    // The protocol itself is fenced: a stale placement number or a stream that is not open is refused over the wire.
    const stale = r1.client.attempt(t.attemptId, offer.placement + 1).streamTap();
    await assert.rejects(stale.started({ requestChars: 1 }), /fenced/);
    await assert.rejects(r1.client.send("POST", `/worker/attempts/${t.attemptId}/stream-events`, { body: { placement: offer.placement, streamId: "rs-00000000-0000-0000-0000-000000000000", n: 1, events: [{ kind: "text", text: "x" }] }, session: true }), (e: unknown) => e instanceof WorkerRequestError && e.code === "not_found");
    await assert.rejects(r1.client.send("POST", `/worker/attempts/${t.attemptId}/stream-start`, { body: { placement: offer.placement, call: { requestChars: 1, taskId: "task-aaaaaaaaaaaaaaaaaaaa" } }, session: true }), (e: unknown) => e instanceof WorkerRequestError && e.code === "invalid_command");
  } finally { await w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

/** A controller with two remote hosts and one started attempt (an agent runs one at a time); `open` accepts it, confirming the contract or not. */
async function twoAttempts(d: string) {
  const w = await world(d, {} as never);
  const r1 = await w.host("r1");
  const r2 = await w.host("r2");
  const a = await w.task("A");
  const started = (await w.tick()).started;
  if (started.length !== 1) { const msg = JSON.stringify(started); await w.c.close(); assert.fail(msg); }
  const open = async (attemptId: string, confirm: boolean) => {
    const holder = (await w.c.dispatch!.remote!.placement(w.rob, attemptId))!.hostId === r1.id ? r1 : r2;
    const offer = (await holder.client.offers()).find((o) => o.order.attemptId === attemptId)!;
    const attempt = holder.client.attempt(attemptId, offer.placement);
    await attempt.accept();
    if (confirm) assert.deepEqual(await attempt.honorContract(offer.order, FULL_ABILITIES, w.now()), { ok: true });
    return { attempt, offer, holder, post: async (action: string, body: Record<string, unknown>, key?: string) => (await holder.client.send("POST", `/worker/attempts/${attemptId}/${action}`, { body: { placement: offer.placement, ...body } as never, session: true, ...(key === undefined ? {} : { key }) })).body as Record<string, unknown> };
  };
  return { w, r1, r2, a, open };
}
const rejectsWith = (code: string) => (e: unknown): boolean => e instanceof WorkerRequestError && e.code === code;

test("the worker's tap batches a fast token stream into few messages and splits large ones: 5000 single tokens, 2000 small events and a 3 MB text all arrive without a held reply (card L05c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l05c-"));
  const x = await twoAttempts(d);
  try {
    const A = await x.open(x.a.attemptId, true);
    const gen = x.w.c.dispatch!.generation;
    let posts = 0;
    const send = A.holder.client.send.bind(A.holder.client);
    A.holder.client.send = (async (method: string, path: string, call: never) => { if (path.endsWith("/stream-events")) posts++; return send(method, path, call); }) as never;
    const feed = async (events: (call: Awaited<ReturnType<ReturnType<typeof A.attempt.streamTap>["started"]>>) => Promise<void>): Promise<void> => {
      const call = await A.attempt.streamTap().started({ requestChars: 1 });
      assert.ok(call !== undefined);
      await events(call);
      await call.ended({ ok: true });
    };
    // 5000 single-token pieces, one awaited call each as the relay makes them: far more than the transport's per-minute allowance if each were a request.
    await feed(async (call) => { for (let i = 0; i < 5000; i++) assert.deepEqual(await call!.events([{ kind: "text", text: "t" }]), {}); });
    assert.ok(posts < 300, `5000 pieces went out in ${posts} messages`);
    const run1 = (await gen.view(x.w.rob, GenerationService.runIdOf(x.a.taskId, 1)))!.run;
    assert.equal(run1.text, "t".repeat(5000));
    assert.equal(run1.state, "finished");
    // 2000 small events that cannot be merged (notes) go out in messages of at most 400 events.
    posts = 0;
    await feed(async (call) => { assert.deepEqual(await call!.events(Array.from({ length: 2000 }, () => ({ kind: "note" as const, text: "n" }))), {}); });
    assert.ok(posts >= 5 && posts < 20, `${posts} messages`);
    assert.equal((await gen.view(x.w.rob, GenerationService.runIdOf(x.a.taskId, 2)))!.run.text, "[n]".repeat(2000).slice(0, 64 * 1024));
    // CJK text is three bytes a character in UTF-8: the byte cap, not the character count, bounds a message.
    posts = 0;
    await feed(async (call) => { assert.deepEqual(await call!.events([{ kind: "text", text: "漢字".repeat(250_000) }]), {}); });
    assert.ok(posts >= 3 && posts < 40, `${posts} messages for CJK`);
    // One 3 MB text arrives (the generation record keeps 64 KB of text and says where recording stopped; the reply is not held).
    posts = 0;
    await feed(async (call) => { assert.deepEqual(await call!.events([{ kind: "text", text: "é\"\n".repeat(750_000) }]), {}); });
    assert.ok(posts >= 5 && posts < 40, `${posts} messages`);
    const run3 = (await gen.view(x.w.rob, GenerationService.runIdOf(x.a.taskId, 4)))!.run;
    assert.equal(run3.state, "finished");
    assert.match(run3.text, /recording stopped here|^é/);
  } finally { await x.w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a worker's tap batches by the owner's figures from the controller's answer unless it was given its own; a zero is not taken as a message per piece (card L05d finish)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l05d-"));
  const x = await twoAttempts(d);
  try {
    const A = await x.open(x.a.attemptId, true);
    const token = (await x.w.c.services.principals.issueCredential(x.w.rob, x.w.rob.id)).token;
    const set = async (values: Record<string, number>): Promise<void> => { assert.ok((await x.w.c.api.handle(token, { v: 1, op: "generation.stream.change", commandId: `bt-${Math.random().toString(36).slice(2, 10)}`, args: { set: values } } as never) as { ok: boolean }).ok); };
    let posts = 0;
    const send = A.holder.client.send.bind(A.holder.client);
    A.holder.client.send = (async (method: string, path: string, call: never) => { if (path.endsWith("/stream-events")) posts++; return send(method, path, call); }) as never;
    // The clock stands still, so only the character figure (and the end of the reply) can send: the counts do not depend on the speed of the machine.
    const frozen = (): number => 0;
    const feed = async (options: Parameters<typeof A.attempt.streamTap>[0], pieces: number): Promise<number> => {
      posts = 0;
      const call = await A.attempt.streamTap({ now: frozen, ...options }).started({ requestChars: 1 });
      assert.ok(call !== undefined);
      for (let i = 0; i < pieces; i++) assert.deepEqual(await call.events([{ kind: "text", text: "t" }]), {});
      await call.ended({ ok: true });
      return posts;
    };
    // The owner's batchChars of 100 (and a long time): 1000 characters go out in about ten messages.
    await set({ batchChars: 100, batchMs: 60_000 });
    const owners = await feed({}, 1000);
    assert.ok(owners >= 9 && owners <= 12, `${owners} messages under the owner's 100 characters`);
    // The worker's own option wins over the owner's: 2000 characters in one message.
    assert.equal(await feed({ batchChars: 5000 }, 1000), 1);
    // The owner's zero (every piece, for the controller's own batching) is held to the worker's least gap: the worker does not send a message per token.
    await set({ batchChars: 65_536, batchMs: 0 });
    const zero = await feed({}, 1000);
    assert.ok(zero < 50, `${zero} messages under an owner's zero`);
  } finally { await x.w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("stream messages that overlap or repeat are recorded once; a repeated number with other content, another host's stream, the cap of 4 open calls and the end of the attempt (card L05c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l05c-"));
  const x = await twoAttempts(d);
  try {
    const gen = x.w.c.dispatch!.generation;
    const A = await x.open(x.a.attemptId, true);
    // Two copies of a start that overlap (a retry after a timeout) give one stream and one generation.
    const [s1, s2] = await Promise.all([A.post("stream-start", { call: { requestChars: 1 } }, "k1"), A.post("stream-start", { call: { requestChars: 1 } }, "k1")]);
    assert.equal(s1["streamId"], s2["streamId"]);
    assert.equal((await gen.gate(x.w.rob, x.a.taskId))!.gate.runs, 1, "one generation");
    // Two overlapping copies of the same message: recorded once. The same number with other content is refused.
    const evt = [{ kind: "text", text: "once" }];
    await Promise.all([A.post("stream-events", { streamId: s1["streamId"], n: 1, events: evt }), A.post("stream-events", { streamId: s1["streamId"], n: 1, events: evt })]);
    await assert.rejects(A.post("stream-events", { streamId: s1["streamId"], n: 1, events: [{ kind: "text", text: "other" }] }), rejectsWith("invalid_command"));
    await until(async () => (await gen.view(x.w.rob, GenerationService.runIdOf(x.a.taskId, 1)))!.run.text !== "");
    assert.equal((await gen.view(x.w.rob, GenerationService.runIdOf(x.a.taskId, 1)))!.run.text, "once", "recorded once");
    // A stream belongs to its attempt and its host: another host reads it as missing or fenced.
    const other = [x.r1, x.r2].find((h) => h.id !== A.holder.id)!;
    await assert.rejects(other.client.send("POST", `/worker/attempts/${x.a.attemptId}/stream-events`, { body: { placement: A.offer.placement, streamId: s1["streamId"], n: 2, events: evt } as never, session: true }), (e: unknown) => e instanceof WorkerRequestError && (e.code === "not_found" || e.code === "fenced"));
    // At most 4 calls stay open: opening a fifth ends the oldest as failed.
    const ids = [s1["streamId"] as string];
    for (let i = 2; i <= 5; i++) ids.push((await A.post("stream-start", { call: { requestChars: 1 } }, `k${i}`))["streamId"] as string);
    await assert.rejects(A.post("stream-events", { streamId: ids[0], n: 2, events: evt }), rejectsWith("not_found"));
    await A.post("stream-events", { streamId: ids[4], n: 1, events: evt });
    // The end of the attempt ends the calls still open: no generation stays streaming.
    await A.attempt.complete({ status: "completed" });
    const runs = (await gen.gate(x.w.rob, x.a.taskId))!.gate.runs;
    for (let n = 1; n <= runs; n++) await until(async () => (await gen.view(x.w.rob, GenerationService.runIdOf(x.a.taskId, n)))!.run.state !== "streaming");
  } finally { await x.w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
async function until(ok: () => Promise<boolean>): Promise<void> { const end = Date.now() + 20_000; while (!(await ok())) { if (Date.now() > end) assert.fail("timed out"); await new Promise((r) => setTimeout(r, 25)); } }

test("before the contract is confirmed no model call is recorded or allowed (card L05c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-l05c-"));
  const x = await twoAttempts(d);
  try {
    const A = await x.open(x.a.attemptId, false);
    await assert.rejects(A.post("stream-start", { call: { requestChars: 1 } }, "kb"), rejectsWith("invalid_transition"));
    assert.equal(await x.w.c.dispatch!.generation.gate(x.w.rob, x.a.taskId), undefined, "no generation began");
  } finally { await x.w.c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
