import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ModelRelay } from "../dispatch/relay.js";
import { AssignmentService } from "../domain/assignments.js";
import { EffectService } from "../domain/effects.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { GenerationService, streamTapFor } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-31T10:00:00.000Z", pause: async () => undefined };
const enc = new TextEncoder();
const sse = (...events: unknown[]): string => `${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}`;
const chunk = (delta: object, finish: string | null = null): object => ({ choices: [{ index: 0, delta, finish_reason: finish }] });
const deferred = (): { promise: Promise<void>; open: () => void } => { let open!: () => void; const promise = new Promise<void>((r) => { open = r; }); return { promise, open }; };

/** A model endpoint: each call plays the next script, a list of pieces; a piece that is a promise is awaited before the next one goes out. */
type Piece = string | Promise<void>;
function endpoint(scripts: Piece[][], contentType = "text/event-stream") {
  const state = { calls: 0 };
  const fetch: typeof globalThis.fetch = async () => {
    const script = scripts[Math.min(state.calls++, scripts.length - 1)]!;
    const body = new ReadableStream<Uint8Array>({
      async start(controller) {
        for (const p of script) { if (typeof p === "string") controller.enqueue(enc.encode(p)); else await p; }
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
  interface Ctx { owner: Principal; dispatcher: Principal; task: string; attemptId: string; gen: GenerationService; relayFor(e: ReturnType<typeof endpoint>, settings?: { record: boolean; cut: boolean }, errors?: unknown[]): ReturnType<ModelRelay["forAttempt"]> }
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
      const relayFor = (e: ReturnType<typeof endpoint>, settings = { record: true, cut: true }, errors: unknown[] = []) =>
        new ModelRelay({ fetch: e.fetch, endpoint: () => ({ url: "http://model.invalid/v1" }) }).forAttempt({
          route: "localp/small", model: "local",
          stream: streamTapFor({ generation: gen, principal: dispatcher, settings: async () => settings, onError: (x) => errors.push(x), nonce: () => `n${++taps}` }, { attemptId, taskId: task, generation: 1 }),
        });
      await body({ owner, dispatcher, task, attemptId, gen, relayFor });
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
    assert.ok(r1.late.some((l) => l.kind === "completion"), "the end of the late reply is recorded as late");
    // The next call is a new generation under the new revision.
    const next = await c.relayFor(e).relay(request as never);
    await drain(next.body);
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
    assert.equal(r.text, "");
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
}
