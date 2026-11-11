import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ModelRelay, type RelayMonitor } from "../dispatch/relay.js";
import { AssignmentService } from "../domain/assignments.js";
import { EffectService } from "../domain/effects.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ModelStreamDecoder } from "../dispatch/model-stream.js";
import { GenerationService, streamTapFor } from "./index.js";
import { safeSlice } from "./stream-feed.js";

after(stopServer);

const options = { clock: () => "2026-10-31T10:00:00.000Z", pause: async () => undefined };
const enc = new TextEncoder();
const sse = (...events: unknown[]): string => `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}`;
const chunk = (delta: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
interface Extra { gen?: Pick<GenerationService, "begin" | "recordMany" | "complete" | "gate" | "view">; monitor?: RelayMonitor; attempt?: { attemptId: string; taskId: string; generation: number } }
const deferred = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };

/** A model endpoint: each call plays the next script, a list of pieces; a piece that is a promise is awaited before the next one goes out. */
type Piece = string | Promise<void> | Error;
function endpoint(scripts: Piece[][], contentType = "text/event-stream") {
  const state = { calls: 0, bodies: [] as string[] };
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    state.bodies.push(Buffer.from(init?.body as Uint8Array ?? new Uint8Array()).toString("utf8"));
    const script = scripts[Math.min(state.calls++, scripts.length - 1)]!;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const p of script) { if (typeof p === "string") controller.enqueue(enc.encode(p)); else if (p instanceof Error) { controller.error(p); return; } else await p; }
        controller.close();
      },
    });
    return new Response(body, { status: 200, headers: { "content-type": contentType } });
  };
  return { fetch, state };
}
const request = { url: "http://relay.invalid/m0/chat/completions", method: "POST", headers: [["content-type", "application/json"]] as const, body: enc.encode(JSON.stringify({ model: "local", messages: [] })), signal: new AbortController().signal };
const drain = async (body: AsyncIterable<Uint8Array> | null): Promise<string> => { let out = ""; if (body !== null) for await (const p of body) out += Buffer.from(p).toString("utf8"); return out; };

for (const backend of backends) {
  interface Ctx { owner: Principal; dispatcher: Principal; task: string; attemptId: string; gen: GenerationService; relayFor(e: ReturnType<typeof endpoint>, settings?: Record<string, unknown>, errors?: unknown[], extra?: Extra): ReturnType<ModelRelay["forAttempt"]>; projects: ProjectService; mk(deps: { pauses?: unknown; decisions?: unknown }): GenerationService }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const dispatcher = await principals.authenticate((await principals.provisionService("dispatcher")).token);
      const project = (await projects.createProject({ commandId: "pa", actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "the task" })).id;
      const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const effects = EffectService.withEpoch(world.storage, projects.epoch, assignments, { holder: "exec-1", ...options });
      await projects.transitionTask({ commandId: "rd", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
      await assignments.assignTask({ commandId: "as", actor: owner.id, taskId: task, owner: { kind: "agent", id: "ann" } });
      const asg = (await assignments.getAssignment(task))!;
      const attemptId = (await assignments.admitAttempt({ commandId: "ad", actor: owner.id, taskId: task, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: "ann" } })).id;
      const gen = GenerationService.withEpoch(world.storage, projects.epoch, { assignments, effects }, options);
      let taps = 0;
      const relayFor = (e: ReturnType<typeof endpoint>, settings: Record<string, unknown> = { record: true, cut: true, batchMs: 0, batchChars: 0 }, errors: unknown[] = [], extra: Extra = {}) =>
        new ModelRelay({ fetch: e.fetch, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({
          route: "localp/small", model: "local",
          ...(extra.monitor === undefined ? {} : { monitor: extra.monitor }),
          stream: streamTapFor({ generation: extra.gen ?? gen, principal: dispatcher, settings: async () => settings as never, onError: (x) => errors.push(x), nonce: () => `n${++taps}` }, extra.attempt ?? { attemptId, taskId: task, generation: 1 }),
        });
      await body({ owner, dispatcher, task, attemptId, gen, relayFor, projects, mk: (deps) => GenerationService.withEpoch(world.storage, projects.epoch, { assignments, effects, ...deps as object }, options) });
    } finally { await world.close(); }
  });
  const run = async (c: Ctx, n: number) => (await c.gen.view(c.owner, GenerationService.runIdOf(c.task, n)))!.run;

  suite("a streamed reply is recorded as a generation bound to the revision it began under, and reaches the worker unchanged", async (c) => {
    const reply = sse(chunk({ role: "assistant", content: "" }), chunk({ content: "Hello, " }), chunk({ content: "world" }),
      chunk({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "desk-read", arguments: "{\"recordId\":" } }] }),
      chunk({ tool_calls: [{ index: 0, function: { arguments: "\"dsk-1\"}" } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    // Cut into awkward pieces: the decoder must not depend on where the network splits the bytes.
    const pieces = [reply.slice(0, 37), reply.slice(37, 200), reply.slice(200, 201), reply.slice(201)];
    const e = endpoint([pieces]);
    const answer = await c.relayFor(e).relay(request as never);
    assert.equal(await drain(answer.body), reply, "the bytes the worker receives are the bytes the model sent");
    const r = await run(c, 1);
    assert.equal(r.state, "finished");
    assert.equal(r.contextRevision, 1);
    assert.equal(r.text, "Hello, world");
    assert.equal(r.owner, c.dispatcher.id);
    assert.deepEqual(r.fence, { generation: 1, attemptId: c.attemptId });
    assert.equal(r.toolCalls.length, 1);
    assert.equal(r.toolCalls[0]!.name, "desk-read");
    assert.equal(r.toolCalls[0]!.args, "{\"recordId\":\"dsk-1\"}");
    assert.equal(r.toolCalls[0]!.state, "complete");
    assert.equal(r.lateCount, 0);
  });

  suite("a tool call that was still being written when the stream broke is dropped for good and never complete", async (c) => {
    const half = sse(chunk({ content: "ok" }), chunk({ tool_calls: [{ index: 0, id: "call_9", type: "function", function: { name: "desk-write", arguments: "{\"body\":\"half" } }] }));
    const e = endpoint([[half]]);
    await drain((await c.relayFor(e).relay(request as never)).body);
    const r = await run(c, 1);
    assert.equal(r.toolCalls[0]!.state, "dropped");
    assert.match(r.toolCalls[0]!.reason ?? "", /stream ended before/);
    await assert.rejects(c.gen.admitEffect(c.owner, { commandId: "adm1", runId: r.id, toolCallId: "call_9", kind: "tool", target: "x" }), /dropped/);
  });

  suite("a correction mid-stream: the earlier reply is held with a visible reason, never reaches the worker, and the next call begins under the new revision", async (c) => {
    const second = deferred();
    const first = sse(chunk({ content: "Plant the " }));
    const late = sse(chunk({ content: "tomatoes" }), chunk({ tool_calls: [{ index: 0, id: "call_2", type: "function", function: { name: "desk-write", arguments: "{}" } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const e = endpoint([[first, second.promise, late], [sse(chunk({ content: "Plant the beans" }), chunk({}, "stop")) + "data: [DONE]\n\n"]]);
    const relay = c.relayFor(e);
    const answer = await relay.relay(request as never);
    const it = answer.body![Symbol.asyncIterator]();
    const got: string[] = [Buffer.from((await it.next()).value as Uint8Array).toString("utf8")];
    assert.equal(got[0], first);
    assert.equal((await run(c, 1)).text, "Plant the ");
    // The owner corrects the task while the model is still writing.
    assert.equal((await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "use beans, not tomatoes" })).contextRevision, 2);
    second.open();
    await assert.rejects(it.next(), (error: Error) => { assert.match(error.message, /held back/); assert.match(error.message, /corrected by owner:rob/); assert.match(error.message, /use beans, not tomatoes/); return true; });
    const r1 = await run(c, 1);
    assert.equal(r1.state, "interrupted");
    assert.equal(r1.interrupted?.kind, "corrected");
    assert.equal(r1.text, "Plant the ", "the late text was not applied");
    assert.ok(r1.lateCount >= 1, "the late reply is visible on the generation");
    assert.ok(r1.late.some((l) => l.kind === "text" && l.preview === "tomatoes"));
    assert.deepEqual(r1.toolCalls, [], "the late tool call was never applied");
    await until(async () => (await run(c, 1)).late.some((l) => l.kind === "completion"));
    assert.ok((await run(c, 1)).late.some((l) => l.kind === "completion"), "the end of the late reply is recorded as late");
    // The next call is a new generation under the new revision.
    // The retried request, unchanged, was built before the correction: it goes out carrying the correction, bound to the new revision.
    const next = await relay.relay(request as never);
    await drain(next.body);
    const sent = JSON.parse(e.state.bodies.at(-1)!) as { messages: { role: string; content: string }[] };
    assert.match(sent.messages.at(-1)!.content, /Correction by owner:rob at context revision 2: use beans, not tomatoes/, "the retry carries the correction");
    const r2 = await run(c, 2);
    assert.equal(r2.contextRevision, 2);
    assert.equal(r2.text, "Plant the beans");
    assert.equal(r2.state, "finished");
  });

  suite("a task that is held starts no generation: the call is refused before it is sent", async (c) => {
    await c.gen.interrupt(c.owner, { commandId: "hold", taskId: c.task, mode: "finish_and_hold", reason: "look at it" });
    const e = endpoint([[sse(chunk({ content: "x" }))]]);
    await assert.rejects(c.relayFor(e).relay(request as never), /refused the call: no generation begins for task .*held/);
    assert.equal(e.state.calls, 0, "nothing was sent to the model");
  });

  suite("with the cut off the late reply is still recorded as late but reaches the worker; with recording off nothing is recorded", async (c) => {
    const second = deferred();
    const e = endpoint([[sse(chunk({ content: "a" })), second.promise, sse(chunk({ content: "b" }), chunk({}, "stop")) + "data: [DONE]\n\n"]]);
    const answer = await c.relayFor(e, { record: true, cut: false }).relay(request as never);
    const it = answer.body![Symbol.asyncIterator]();
    await it.next();
    await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "changed my mind" });
    second.open();
    let rest = ""; for (let r = await it.next(); r.done !== true; r = await it.next()) rest += Buffer.from(r.value).toString("utf8");
    assert.match(rest, /"b"/, "the cut is off, so the late piece is delivered");
    assert.ok((await run(c, 1)).lateCount >= 1);
    // Recording off: no generation for the call.
    const before = (await c.gen.gate(c.owner, c.task))!.gate.runs;
    await drain((await c.relayFor(endpoint([[sse(chunk({ content: "z" }), chunk({}, "stop"))]]), { record: false, cut: true }).relay(request as never)).body);
    assert.equal((await c.gen.gate(c.owner, c.task))!.gate.runs, before);
  });

  suite("text that looks like a credential is not recorded, and the reply still reaches the worker", async (c) => {
    const errors: unknown[] = [];
    const reply = sse(chunk({ content: "the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFG" }), chunk({}, "stop")) + "data: [DONE]\n\n";
    const answer = await c.relayFor(endpoint([[reply]]), undefined, errors).relay(request as never);
    assert.equal(await drain(answer.body), reply);
    const r = await run(c, 1);
    assert.match(r.text, /^\[recording stopped here: .*credential/, "the gap is visible, the secret is not recorded");
    assert.equal(r.text.includes("sk-ant"), false);
    assert.equal(errors.length, 0);
  });

  suite("a reply that is not streamed is read whole and recorded before any of it is passed on; an Anthropic stream is read too", async (c) => {
    const whole = JSON.stringify({ choices: [{ message: { content: "all at once", tool_calls: [{ id: "call_5", function: { name: "desk-read", arguments: "{}" } }] } }] });
    assert.equal(await drain((await c.relayFor(endpoint([[whole]], "application/json")).relay(request as never)).body), whole);
    const r1 = await run(c, 1);
    assert.equal(r1.text, "all at once");
    assert.equal(r1.toolCalls[0]!.state, "complete");
    const ev = (type: string, o: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    const claude = ev("message_start", { message: {} }) + ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } }) + ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: "Hi" } }) + ev("content_block_stop", { index: 0 })
      + ev("content_block_start", { index: 1, content_block: { type: "tool_use", id: "toolu_1", name: "desk-read", input: {} } }) + ev("content_block_delta", { index: 1, delta: { type: "input_json_delta", partial_json: "{\"a\":1}" } }) + ev("content_block_stop", { index: 1 }) + ev("message_stop", {});
    await drain((await c.relayFor(endpoint([[claude]])).relay(request as never)).body);
    const r2 = await run(c, 2);
    assert.equal(r2.text, "Hi");
    assert.equal(r2.toolCalls[0]!.args, "{\"a\":1}");
    assert.equal(r2.toolCalls[0]!.state, "complete");
    assert.equal(r2.state, "finished");
  });

  suite("a reply that is not streamed and arrives after a correction is not passed on at all", async (c) => {
    const wait = deferred();
    const whole = JSON.stringify({ choices: [{ message: { content: "TOMATOES" } }] });
    const e = endpoint([[wait.promise, whole.slice(0, 20), whole.slice(20)]], "application/json");
    const answer = await c.relayFor(e).relay(request as never);
    const received: string[] = [];
    const reading = (async () => { for await (const p of answer.body!) received.push(Buffer.from(p).toString("utf8")); })();
    reading.catch(() => undefined);
    await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "no tomatoes" });
    wait.open();
    await assert.rejects(reading, /held back/);
    assert.deepEqual(received, [], "not a byte of the late reply reached the worker");
    assert.equal((await run(c, 1)).state, "interrupted");
  });

  const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
  const never = (): Promise<never> => new Promise(() => undefined);
  const wrap = (g: GenerationService, over: Record<string, unknown>) => new Proxy(g, { get: (t, k) => (typeof k === "string" && k in over ? over[k] : typeof (t as never)[k as never] === "function" ? ((t as never)[k as never] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k as never]) }) as unknown as NonNullable<Extra["gen"]>;
  const until = async (ok: () => Promise<boolean>): Promise<void> => { for (let i = 0; i < 200 && !(await ok()); i++) await sleep(25); };
  const big = (n: number): string => sse(chunk({ tool_calls: [{ index: 0, id: "call_big", type: "function", function: { name: "desk-write", arguments: `{"body":"${"x".repeat(n)}` } }] }));

  suite("a chunk the service refuses (a call over the argument limit) does not switch the hold-back off: a correction afterwards still cuts the late reply", async (c) => {
    const second = deferred();
    const e = endpoint([[big(20_000), second.promise, sse(chunk({ content: "tomatoes" }), chunk({}, "stop")) + "data: [DONE]\n\n"]]);
    const answer = await c.relayFor(e).relay(request as never);
    const it = answer.body![Symbol.asyncIterator]();
    await it.next();
    assert.match((await run(c, 1)).text, /recording stopped here/, "the gap is visible");
    await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "use beans" });
    second.open();
    await assert.rejects(it.next(), /held back.*corrected/);
  });

  suite("10,000 tiny pieces are written in a bounded number of commits, in order; a completed tool call is applied before it is passed on", async (c) => {
    let writes = 0;
    const counting = wrap(c.gen, { recordMany: (...a: Parameters<GenerationService["recordMany"]>) => { writes += 1; return c.gen.recordMany(...a); } });
    const pieces: string[] = [];
    for (let i = 0; i < 10_000; i++) pieces.push(sse(chunk({ content: String(i % 10) })));
    const tail = sse(chunk({ tool_calls: [{ index: 0, id: "call_t", type: "function", function: { name: "desk-read", arguments: "{}" } }] })) + sse(chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const answer = await c.relayFor(endpoint([[...pieces, tail]]), { record: true, cut: true }, [], { gen: counting }).relay(request as never);
    let seenApplied: string | undefined;
    for await (const p of answer.body!) { if (Buffer.from(p).toString("utf8").includes("finish_reason\":\"tool_calls")) seenApplied = (await run(c, 1)).toolCalls[0]?.state; }
    assert.equal(seenApplied, "complete", "the call was applied as complete before its end reached the worker");
    const r = await run(c, 1);
    assert.equal(r.text.length, 10_000);
    assert.equal(r.text.slice(0, 12), "012345678901", "order is kept");
    assert.ok(writes < 80, `${writes} commits for 10,000 pieces`);
  });

  suite("a store that does not answer: closed refuses the call before it is sent; open sends it unrecorded", async (c) => {
    const hung = wrap(c.gen, { begin: never });
    const e = endpoint([[sse(chunk({ content: "x" }), chunk({}, "stop"))]]);
    await assert.rejects(c.relayFor(e, { record: true, cut: true, storeTimeoutMs: 40 }, [], { gen: hung }).relay(request as never), /refused the call: .*could not be asked.*closed/);
    assert.equal(e.state.calls, 0);
    const errors: unknown[] = [];
    const answer = await c.relayFor(e, { record: true, cut: true, failClosed: false, storeTimeoutMs: 40 }, errors, { gen: hung }).relay(request as never);
    assert.match(await drain(answer.body), /"x"/);
    assert.equal(e.state.calls, 1);
    assert.ok(errors.length > 0, "the failure is reported");
  });

  suite("a store that stops answering mid-reply: closed cuts the reply with the reason; open lets it go on", async (c) => {
    // The store that answers must be given time to (a worker thread on a slow Windows runner took more than 40 ms for the first call); only the hung operations never answer.
    const hung = wrap(c.gen, { recordMany: never, gate: never });
    const reply = [sse(chunk({ content: "a" })), sse(chunk({ content: "b" }), chunk({}, "stop")) + "data: [DONE]\n\n"];
    await assert.rejects(drain((await c.relayFor(endpoint([reply]), { record: true, cut: true, storeTimeoutMs: 1500, batchMs: 0, batchChars: 0 }, [], { gen: wrap(c.gen, { recordMany: never }) }).relay(request as never)).body), /held back: .*could not be reached.*closed/);
    const answer = await c.relayFor(endpoint([reply]), { record: true, cut: true, failClosed: false, storeTimeoutMs: 1500, batchMs: 0, batchChars: 0 }, [], { gen: hung }).relay(request as never);
    assert.match(await drain(answer.body), /"b"/);
  });

  suite("ending a failed reply does not wait for the store: cancelling the read returns at once", async (c) => {
    const hung = wrap(c.gen, { complete: never });
    const second = deferred();
    const answer = await c.relayFor(endpoint([[sse(chunk({ content: "a" })), second.promise]]), { record: true, cut: true, storeTimeoutMs: 60_000 }, [], { gen: hung }).relay(request as never);
    const it = answer.body![Symbol.asyncIterator]();
    await it.next();
    const started = Date.now();
    await it.return!();
    assert.ok(Date.now() - started < 1000, "the cancel was not held up by the store");
    second.open();
  });

  suite("time waiting on the store is marked to the monitor, and a held reply's bytes are counted as output", async (c) => {
    const waits: boolean[] = []; let finished: { ok: boolean; outputTokens?: number } | undefined;
    const monitor: RelayMonitor = { started: () => ({ firstOutput: () => undefined, progress: () => undefined, waiting: (on) => { waits.push(on); }, finished: (f) => { finished = f; } }) };
    const slow = wrap(c.gen, { recordMany: async (...a: Parameters<GenerationService["recordMany"]>) => { await sleep(20); return c.gen.recordMany(...a); } });
    const second = deferred();
    const answer = await c.relayFor(endpoint([[sse(chunk({ content: "Plant the tomatoes in rows of four " })), second.promise, sse(chunk({ content: "late" }), chunk({}, "stop"))]]), { record: true, cut: true, batchMs: 0, batchChars: 0 }, [], { gen: slow, monitor }).relay(request as never);
    const it = answer.body![Symbol.asyncIterator]();
    await it.next();
    assert.deepEqual(waits.slice(0, 2), [true, false], "a wait on the store is marked, and ended");
    await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "no" });
    second.open();
    await assert.rejects(it.next(), /held back/);
    assert.equal(finished?.ok, false);
    assert.ok((finished?.outputTokens ?? 0) > 5, "what was received before the reply was held is counted for spend and speed");
  });

  suite("with recordPaused on, a model call begun while the task is paused is recorded, marked as begun paused, and nothing it produced can be admitted while the pause stands (card L05c)", async (c) => {
    const reply = sse(chunk({ content: "hm" }), chunk({ tool_calls: [{ index: 0, id: "call_p", type: "function", function: { name: "desk-read", arguments: "{}" } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const paused = c.mk({ pauses: { guard: async () => ({ blockedBy: [{ kind: "task", id: c.task }], changes: [] }) } });
    const e = endpoint([[reply]]);
    // Off (the default) the call is refused before it is sent and nothing is recorded.
    await assert.rejects(c.relayFor(e, undefined, [], { gen: paused }).relay(request as never), /refused the call: .*paused/);
    assert.equal(await c.gen.gate(c.owner, c.task), undefined, "nothing was recorded for the refused call");
    assert.equal(await drain((await c.relayFor(e, { record: true, cut: true, recordPaused: true, batchMs: 0, batchChars: 0 }, [], { gen: paused }).relay(request as never)).body), reply);
    const r = await run(c, 1);
    assert.equal(r.beganPaused, true);
    assert.equal(r.state, "finished");
    assert.equal(r.toolCalls[0]!.state, "complete");
    await assert.rejects(paused.admitEffect(c.owner, { commandId: "adm", runId: GenerationService.runIdOf(c.task, 1), toolCallId: "call_p", kind: "read", target: "x" }), /paused/);
    // A call that began unpaused is not marked.
    const free = endpoint([[reply]]);
    await drain((await c.relayFor(free).relay(request as never)).body);
    assert.equal((await run(c, 2)).beganPaused, undefined);
    // Only the dispatcher may ask for it.
    await assert.rejects(c.gen.begin(c.owner, { commandId: "bp", taskId: c.task, contextRevision: 1, whilePaused: true }), /may not record a generation of a paused task/);
  });

  suite("checkCall: a call is ok only in a complete, current, uninterrupted generation of the task; the reason is told otherwise (card L05c)", async (c) => {
    const reply = (id: string) => sse(chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: "desk-read", arguments: "{}" } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const ask = (callId: string) => c.gen.checkCall(c.dispatcher, { taskId: c.task, callId });
    assert.deepEqual(await ask("call_a"), { recorded: false }, "nothing recorded yet");
    await drain((await c.relayFor(endpoint([[reply("call_a")]])).relay(request as never)).body);
    const ok = await ask("call_a");
    assert.equal(ok.recorded && ok.ok, true, JSON.stringify(ok));
    assert.deepEqual(await ask("call_unknown"), { recorded: false });
    // A correction withdraws the calls of the generation that was current.
    await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "use beans" });
    const corrected = await ask("call_a");
    assert.ok(corrected.recorded && !corrected.ok && /corrected by .*use beans/.test(corrected.reason ?? ""), JSON.stringify(corrected));
    // The next generation (revision 2) holds a new call; the old one stays refused, now as superseded or corrected.
    await drain((await c.relayFor(endpoint([[reply("call_b")]])).relay(request as never)).body);
    const b = await ask("call_b");
    assert.equal(b.recorded && b.ok, true, JSON.stringify(b));
    assert.equal((await ask("call_a") as { ok: boolean }).ok, false);
    // A held task refuses even a complete call; releasing lifts it.
    await c.gen.interrupt(c.owner, { commandId: "hold", taskId: c.task, mode: "finish_and_hold", reason: "wait" });
    const held = await ask("call_b");
    assert.ok(held.recorded && !held.ok, JSON.stringify(held));
    // A partial call (the stream broke) is never ok.
    await c.gen.release(c.owner, { commandId: "rel", taskId: c.task, reason: "go on" });
    await drain((await c.relayFor(endpoint([[sse(chunk({ tool_calls: [{ index: 0, id: "call_c", type: "function", function: { name: "desk-write", arguments: "{\"body\":\"half" } }] }))]])).relay(request as never)).body);
    const half = await ask("call_c");
    assert.ok(half.recorded && !half.ok && /dropped/.test(half.reason ?? ""), JSON.stringify(half));
    // A held task is reported even for a call nothing recorded.
    await c.gen.interrupt(c.owner, { commandId: "hold2", taskId: c.task, mode: "finish_and_hold", reason: "wait again" });
    const unknownHeld = await ask("call_never_seen");
    assert.ok(!unknownHeld.recorded && /held/.test((unknownHeld as { held?: string }).held ?? ""), JSON.stringify(unknownHeld));
    // Other principals may not ask.
    await assert.rejects(c.gen.checkCall({ ...c.dispatcher, id: "agent:ann", kind: "agent" } as never, { taskId: c.task, callId: "call_b" }), /may not check/);
  });

  suite("a call withdrawn in an older generation (superseded, then the task corrected) is still refused (card L05c review)", async (c) => {
    const reply = (id: string) => sse(chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: "desk-read", arguments: "{}" } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    await drain((await c.relayFor(endpoint([[reply("call_x")]])).relay(request as never)).body);
    await drain((await c.relayFor(endpoint([[reply("call_y")]])).relay(request as never)).body);
    await c.gen.correct(c.owner, { commandId: "fix", taskId: c.task, expectedContextRevision: 1, reason: "use beans" });
    await drain((await c.relayFor(endpoint([[reply("call_z")]])).relay(request as never)).body);
    const x = await c.gen.checkCall(c.dispatcher, { taskId: c.task, callId: "call_x" });
    assert.ok(x.recorded && !x.ok, JSON.stringify(x));
    const z = await c.gen.checkCall(c.dispatcher, { taskId: c.task, callId: "call_z" });
    assert.ok(z.recorded && z.ok, JSON.stringify(z));
  });

  suite("a held task with no generation at all is reported held by checkCall (card L05c review)", async (c) => {
    await c.gen.interrupt(c.owner, { commandId: "h0", taskId: c.task, mode: "finish_and_hold", reason: "wait" });
    const r = await c.gen.checkCall(c.dispatcher, { taskId: c.task, callId: "call_q" });
    assert.ok(!r.recorded && /held/.test((r as { held?: string }).held ?? ""), JSON.stringify(r));
  });

  suite("a call is refused (not sent) for a fenced attempt, a paused task, a task waiting for a decision, and a done or cancelled task", async (c) => {
    const e = endpoint([[sse(chunk({ content: "x" }))]]);
    await assert.rejects(c.relayFor(e, undefined, [], { attempt: { attemptId: c.attemptId, taskId: c.task, generation: 99 } }).relay(request as never), /refused the call: no generation begins/, "fenced");
    const paused = c.mk({ pauses: { guard: async () => ({ blockedBy: [{ kind: "project", id: "p" }], changes: [] }) } });
    // A paused task's call is refused before it is sent unless the owner turned `recordPaused` on (card L05c; the default is L05b's behaviour).
    await assert.rejects(c.relayFor(e, undefined, [], { gen: paused }).relay(request as never), /refused the call: .*paused/, "paused");
    // The store answered: the refusal holds whatever the fail mode is (open only covers a store that cannot answer).
    await assert.rejects(c.relayFor(e, { record: true, cut: true, failClosed: false }, [], { gen: paused }).relay(request as never), /refused the call: .*paused/, "paused, fail mode open");
    const waiting = c.mk({ decisions: { guard: async () => ({ blockedBy: ["the owner has not decided"], changes: [] }) } });
    await assert.rejects(c.relayFor(e, undefined, [], { gen: waiting }).relay(request as never), /refused the call: .*not decided/, "decision");
    const t = (await c.projects.getTask(c.task))!;
    await c.projects.transitionTask({ commandId: "cx", actor: c.owner.id, taskId: c.task, expectedRevision: t.revision, to: "cancelled" });
    await assert.rejects(c.relayFor(e).relay(request as never), /refused the call: .*cancelled/, "cancelled");
    assert.equal(e.state.calls, 0, "nothing was sent to the model in any case");
  });

  suite("a body larger than the cap is passed on unrecorded with a note; a keep-alive comment is forwarded at once, before any data", async (c) => {
    const bigBody = JSON.stringify({ choices: [{ message: { content: "y".repeat(5000) } }] });
    const answer = await c.relayFor(endpoint([[bigBody.slice(0, 1000), bigBody.slice(1000, 3000), bigBody.slice(3000)]], "application/json"), { record: true, cut: true, heldBufferBytes: 1500 }).relay(request as never);
    assert.equal(await drain(answer.body), bigBody, "passed on whole");
    assert.match((await run(c, 1)).text, /larger than 1500 bytes.*not recorded/);
    const gate = deferred();
    const live = await c.relayFor(endpoint([[": keep-alive\n\n", gate.promise, sse(chunk({ content: "hi" }), chunk({}, "stop")) + "data: [DONE]\n\n"]], "application/json")).relay(request as never);
    const it = live.body![Symbol.asyncIterator]();
    const first = await Promise.race([it.next(), sleep(1500).then(() => "buffered")]);
    assert.notEqual(first, "buffered", "the keep-alive reached the worker before the model said anything");
    gate.open();
    for (let r = await it.next(); r.done !== true; r = await it.next()) { /* drain */ }
  });

  suite("a decoder that throws does not stop the reply: it is passed on, and the gap is noted", async (c) => {
    const original = ModelStreamDecoder.prototype.push;
    let calls = 0;
    ModelStreamDecoder.prototype.push = function (this: ModelStreamDecoder, bytes: Uint8Array) { if (++calls === 2) throw new Error("boom"); return original.call(this, bytes); };
    try {
      const pieces = [sse(chunk({ content: "one" })), sse(chunk({ content: "two" })), sse(chunk({ content: "three" }), chunk({}, "stop")) + "data: [DONE]\n\n"];
      assert.equal(await drain((await c.relayFor(endpoint([pieces])).relay(request as never)).body), pieces.join(""));
    } finally { ModelStreamDecoder.prototype.push = original; }
    assert.match((await run(c, 1)).text, /one\[the stream decoder gave up/);
  });

  suite("a reply that breaks off is recorded as failed, and a tool call it had completed is marked unused; an Anthropic call without arguments is {}", async (c) => {
    const done = sse(chunk({ tool_calls: [{ index: 0, id: "call_u", type: "function", function: { name: "desk-read", arguments: "{}" } }] })) + sse(chunk({}, "tool_calls"));
    await assert.rejects(drain((await c.relayFor(endpoint([[done, sleep(80), new Error("connection reset")]])).relay(request as never)).body));
    await until(async () => (await run(c, 1)).state !== "streaming");
    const r = await run(c, 1);
    assert.equal(r.state, "failed");
    assert.equal(r.toolCalls[0]!.state, "unused");
    await assert.rejects(c.gen.admitEffect(c.owner, { commandId: "ad", runId: r.id, toolCallId: "call_u", kind: "tool", target: "x" }), /unused/);
    const ev = (type: string, o: object): string => `event: ${type}\ndata: ${JSON.stringify({ type, ...o })}\n\n`;
    const claude = ev("content_block_start", { index: 0, content_block: { type: "tool_use", id: "toolu_e", name: "desk-list", input: {} } }) + ev("content_block_stop", { index: 0 }) + ev("message_stop", {});
    await drain((await c.relayFor(endpoint([[claude]])).relay(request as never)).body);
    // The recording of the second reply lands after the reply is read (a SQLite worker thread on a slow Windows runner took longer than the read).
    await until(async () => (await run(c, 2).catch(() => undefined))?.toolCalls[0]?.state === "complete");
    const r2 = await run(c, 2);
    assert.equal(r2.toolCalls[0]!.state, "complete");
    assert.equal(r2.toolCalls[0]!.args, "{}");
  });

  suite("card L05d: an alias is recorded for a provider ID the recorder cannot keep and checkCall finds the call by it, by a long ID and by the extension's number for a repeated ID; it reports the name and arguments; hasStreamed says which attempt streamed", async (c) => {
    const { bridgeCallIdOf } = await import("../dispatch/model-stream.js");
    const { reusedCallId } = await import("./index.js");
    const call = (id: string, args: string) => sse(chunk({ tool_calls: [{ index: 0, id, type: "function", function: { name: "nimblenewt__desk-write", arguments: args } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    const ask = (callId: string) => c.gen.checkCall(c.dispatcher, { taskId: c.task, callId });
    assert.equal(await c.gen.hasStreamed(c.dispatcher, { taskId: c.task, attemptId: c.attemptId }), false, "nothing streamed yet");
    const raw = "has spaces/☃";
    await drain((await c.relayFor(endpoint([[call(raw, "{\"a\":1}")]])).relay(request as never)).body);
    const r1 = await run(c, 1);
    assert.deepEqual([r1.toolCalls[0]!.id, r1.toolCalls[0]!.aliases], ["call-0", [bridgeCallIdOf(raw)]]);
    const found = await ask(bridgeCallIdOf(raw));
    assert.ok(found.recorded && found.ok && found.callId === "call-0" && found.name === "nimblenewt__desk-write" && found.args === "{\"a\":1}" && found.state === "complete", JSON.stringify(found));
    assert.deepEqual(await ask("call-0").then((v) => v.recorded && v.ok), true, "the recorded ID itself is found too");
    assert.equal(await c.gen.hasStreamed(c.dispatcher, { taskId: c.task, attemptId: c.attemptId }), true);
    assert.equal(await c.gen.hasStreamed(c.dispatcher, { taskId: c.task, attemptId: "att-someone-else" }), false);
    await assert.rejects(c.gen.hasStreamed({ ...c.dispatcher, id: "agent:ann", kind: "agent" } as never, { taskId: c.task, attemptId: c.attemptId }), /may not ask/);
    // The provider counts from zero in each reply: the extension sends call_0, then the digest for its second use, and so on.
    await drain((await c.relayFor(endpoint([[call("call_0", "{\"n\":1}")]])).relay(request as never)).body);
    await drain((await c.relayFor(endpoint([[call("call_0", "{\"n\":2}")]])).relay(request as never)).body);
    const second = await ask(reusedCallId("call_0", 2));
    assert.ok(second.recorded && second.ok && second.args === "{\"n\":2}" && second.number === 3, `the number the extension gave is the use in the window: ${JSON.stringify(second)}`);
    // The first use is read as call_0 itself and finds the newest generation holding it.
    const plain = await ask("call_0");
    assert.ok(plain.recorded && plain.number === 3);
    assert.deepEqual(await ask(reusedCallId("call_0", 5000)), { recorded: false });
    // A malformed ID is refused.
    await assert.rejects(ask("has space"), /is not a tool call ID/);
  });

  suite("card L05d review: a repeated provider ID is the newest generation's call even when an earlier use never reached the process (a reply that broke off), so the extension's number and the window's count differ", async (c) => {
    const { reusedCallId } = await import("./index.js");
    const ask = (callId: string) => c.gen.checkCall(c.dispatcher, { taskId: c.task, callId });
    // The first reply breaks off in the middle of call_0: the process never runs it, so the extension does not count it.
    const partial = sse(chunk({ tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "nimblenewt__desk-write", arguments: "{\"n\"" } }] }));
    await assert.rejects(drain((await c.relayFor(endpoint([[partial, sleep(50), new Error("connection reset")]])).relay(request as never)).body));
    await until(async () => (await run(c, 1)).state !== "streaming");
    assert.equal((await run(c, 1)).toolCalls[0]!.state, "dropped");
    const call = (args: string) => sse(chunk({ tool_calls: [{ index: 0, id: "call_0", type: "function", function: { name: "nimblenewt__desk-write", arguments: args } }] }), chunk({}, "tool_calls")) + "data: [DONE]\n\n";
    await drain((await c.relayFor(endpoint([[call("{\"n\":2}")]])).relay(request as never)).body);
    await drain((await c.relayFor(endpoint([[call("{\"n\":3}")]])).relay(request as never)).body);
    await until(async () => (await run(c, 3).catch(() => undefined))?.toolCalls[0]?.state === "complete");
    // The process ran call_0 of the second reply as `call_0` and now runs the third reply's as its second use.
    const v = await ask(reusedCallId("call_0", 2));
    assert.ok(v.recorded && v.ok && v.number === 3 && v.args === "{\"n\":3}", `the current generation's call, not the second generation's: ${JSON.stringify(v)}`);
  });

  suite("a generation is labelled sensitive", async (c) => {
    await drain((await c.relayFor(endpoint([[sse(chunk({ content: "x" }), chunk({}, "stop"))]])).relay(request as never)).body);
    assert.equal((await run(c, 1)).sensitive, true);
  });
}

test("text is cut without splitting a surrogate pair", () => {
  assert.equal(safeSlice("ab🌱cd", 3), "ab");
  assert.equal(safeSlice("ab🌱cd", 4), "ab🌱");
  assert.equal(safeSlice("abc", 10), "abc");
});
