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
    const relay = new ModelRelay({ fetch: first, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap() });
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
    const relay2 = new ModelRelay({ fetch: second, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({ route: "localp/small", model: "local", stream: attempt.streamTap() });
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
    const required = await bridge("call_unknown2");
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
