import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CatalogService, personalNamespace } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { buildWorld, workGrants, type DispatchWorld, type WorkerScript } from "../dispatch/testing/world.js";
import type { Grant } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { JobService } from "../jobs/index.js";
import { RecallService } from "../context/recall-service.js";
import { bridgeCommandId, launchOf, ToolExecutionService, type BoundGateway, type BuiltinTool, type BridgeResponse, type ScriptLaunch, type ScriptRunner } from "./service.js";
import { checkValue, schemaProblems } from "./schema.js";
import { RUNNING_CALL_KIND, RunningCallStore } from "./running-store.js";

after(stopServer);

let n = 0;
const uid = (label: string): string => `${label}-${n++}`;
const manifest = (extra: Record<string, unknown> = {}) => ({
  purpose: "check a page", input: { type: "object", properties: { url: { type: "string", maxLength: 200 }, depth: { type: "integer", minimum: 0, maximum: 5 } }, required: ["url"], additionalProperties: false },
  output: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] }, entryPoint: "bin/check.js", interpreter: { name: "node", version: "22.19.0" },
  os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 128, seconds: 30 }, cancellation: "cooperative", recovery: "none", ...extra,
});
const bad = (r: BridgeResponse): { code: string; message: string } => { assert.equal(r.ok, false, JSON.stringify(r)); return r as never; };
const good = (r: BridgeResponse): JsonObject => { assert.equal(r.ok, true, JSON.stringify(r)); return (r as { result: JsonObject }).result; };
const deferred = <T = void>() => { let resolve!: (v: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

for (const backend of backends) {
  interface Ctx extends DispatchWorld {
    desks: DeskService;
    catalog: CatalogService;
    svc: ToolExecutionService;
    runs: ScriptLaunch[];
    /** What the script runner does; the default answers `{"ok":true}`. */
    behave: { run: (launch: ScriptLaunch, signal: AbortSignal) => Promise<{ text: string; cpuMs?: number }> };
    /** A service over another dispatcher (a restart of the controller process). */
    serviceOver(dispatcher: DispatcherService, facts?: false): ToolExecutionService;
    /** An agent with everything the bridge needs, including the standing grant for its own tool namespace. */
    agentFor(name: string, extra?: Grant[]): Promise<{ id: string; aid: string }>;
    /** Runs a worker script as the attempt's worker with the bridge: `send` is bound to the credential and gateway of the attempt. */
    session(body: (s: Session) => Promise<void>): WorkerScript;
    /** Registers a script tool through the bridge as the given session and returns its canonical name. */
    install(s: Session, name: string, version: string, extra?: Record<string, unknown>, source?: string): Promise<string>;
    /** The controller's own tools (card H12i); a test pushes one here and the service sees it at once. */
    builtins: BuiltinTool[];
    tick(): Promise<void>;
    /** What a revocation does to a call already running (T02b); the service reads it at the moment of revocation. */
    revocation: { mode: "finish" | "cancel" | "broken" };
    /** An unclassified tool is never allowed unasked: the first ask is parked for review, the owner approves it, and the same call is made again. Returns the answer of the call that ran. */
    invoke(s: Session, args: JsonObject, callId?: string): Promise<BridgeResponse>;
    /** The ask and the approval only; the call itself is left to the caller (so it can be held while something else happens). */
    clear(s: Session, args: JsonObject, callId: string): Promise<void>;
  }
  interface Session { readonly token: string; readonly gateway: BoundGateway; readonly attemptId: string; send(op: string, args?: JsonObject, callId?: string): Promise<BridgeResponse> }

  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const store = await backend.open();
      try {
        const w = await buildWorld(store.storage);
        const desks = DeskService.withEpoch(w.storage, w.epoch, w.options);
        const catalog = CatalogService.withEpoch(w.storage, w.epoch, desks, w.options);
        const runs: ScriptLaunch[] = [];
        const builtins: BuiltinTool[] = [];
        let failure: unknown;
        const behave: Ctx["behave"] = { run: async () => ({ text: '{"ok":true}', cpuMs: 5 }) };
        const runner: ScriptRunner = { run: async (launch, signal) => { runs.push(launch); return behave.run(launch, signal); } };
        const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
        const serviceOver = (dispatcher: DispatcherService, facts?: false): ToolExecutionService =>
          new ToolExecutionService({ principal: w.dispatcherPrincipal, credentials: w.credentials, dispatch: dispatcher, assignments: w.assignments, catalog, hosts: w.hosts, admission: w.admission, runner, pauses: w.pauses, desks, builtins, revocationPolicy: () => { if (c.revocation.mode === "broken") throw new Error("setting unreadable"); return c.revocation.mode; }, ...(facts === false ? {} : { facts: async () => hostFacts }), isLocalHost: () => true });
        const svc = serviceOver({ get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) } as never);
        const c: Ctx = Object.assign(w, {
          desks, catalog, svc, runs, behave, builtins, serviceOver, revocation: { mode: "finish" as "finish" | "cancel" | "broken" },
          agentFor: async (nm: string, extra: Grant[] = []) => {
            const p = `agent:${nm}`;
            return w.agent(nm, [...workGrants(w.project), { action: "desk.write", project: w.project }, { action: "desk.read", project: w.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" },
              { action: `tool.${personalNamespace(p).replace(/^a_/, "a-")}.*`, project: w.project }, ...extra]);
          },
          session: (body: (s: Session) => Promise<void>): WorkerScript => async ({ order, gateway }) => {
            const send = (op: string, args: JsonObject = {}, callId: string = uid("call")) => c.svc.handle(order.credential, gateway, { op, callId, args });
            try { await body({ token: order.credential, gateway, attemptId: order.attemptId, send }); } catch (error) { failure = error; throw error; }
            return { status: "completed", text: "done" };
          },
          install: async (s: Session, nm: string, version: string, extra: Record<string, unknown> = {}, source = "console.log('{\"ok\":true}')") => {
            const doc = good(await s.send("desk.write", { kind: "note", title: `${nm} notes`, body: `how to use ${nm}`, visibility: "shared", status: "accepted" }));
            const code = good(await s.send("desk.write", { kind: "note", title: `${nm} code`, body: source, visibility: "shared", status: "accepted" }));
            const made = good(await s.send("tool.register", { name: nm, kind: "tool", version, manifest: manifest(extra), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string }));
            return made["name"] as string;
          },
          clear: async (s: Session, args: JsonObject, callId: string) => {
            const first = good(await s.send("tool.invoke", args, callId));
            assert.equal(first["state"], "awaiting-approval", JSON.stringify(first));
            const review = (await w.reviews.get(w.owner, first["reviewId"] as string))!;
            await w.reviews.decide(w.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
          },
          invoke: async (s: Session, args: JsonObject, callId: string = uid("call")) => { await c.clear(s, args, callId); return s.send("tool.invoke", args, callId); },
          tick: async () => { await c.dispatcher.tick(); await c.dispatcher.idle(); if (failure !== undefined) throw failure; },
        });
        // The dispatcher asks the catalogue, as the agent, whether a call may be run again (the manifest decides, never the worker).
        c.dispatcher = c.restart({ replaySafe: svc.replaySafe });
        await c.policy.set(c.owner, { scope: "installation", commandId: uid("pol"), profile: "autonomous" });
        await body(c);
      } finally { await store.close(); }
    });

  suite("a script tool is created, registered, discovered, described and used in one conversation without a worker reload; descriptions are fetched on demand", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("ship it", ann);
    let seen: { before: JsonObject; after: JsonObject; described: JsonObject; used: JsonObject } | undefined;
    c.worker.script = c.session(async (s) => {
      const before = good(await s.send("tool.discover"));
      const name = await c.install(s, "check", "1.0.0");
      const after = good(await s.send("tool.discover"));
      const described = good(await s.send("tool.describe", { tool: name }));
      const parkedFirst = good(await s.send("tool.invoke", { tool: name, input: { url: "https://example.org", depth: 2 } }, "first-use"));
      assert.equal(parkedFirst["state"], "awaiting-approval", "a tool nobody has classified is never allowed unasked");
      assert.equal(c.runs.length, 0);
      const used = good(await c.invoke(s, { tool: name, input: { url: "https://example.org", depth: 2 } }));
      seen = { before, after, described, used };
    });
    await c.tick();
    assert.equal(c.worker.starts.length, 1, "one worker start: no reload");
    const { before, after, described, used } = seen!;
    assert.deepEqual(before["tools"], []);
    assert.notEqual(before["revision"], after["revision"], "the visible set changed, and the revision says so");
    const listed = (after["tools"] as { name: string; version: string }[])[0]!;
    assert.deepEqual(Object.keys(listed).sort(), ["kind", "layer", "name", "version"], "the list carries names and versions only, no description or schema");
    assert.equal(described["purpose"], "check a page");
    assert.ok(described["input"] !== undefined && typeof described["instructions"] === "string");
    assert.equal(used["state"], "confirmed");
    assert.equal(used["version"], "1.0.0");
    assert.equal(c.runs.length, 1);
    // The use is recorded on the catalogue and the call is a durable operation of the attempt.
    const usage = await c.catalog.usage(c.owner, { projectId: c.project });
    assert.equal(usage.items.length, 1);
    const ops = await c.storage.listAggregates(`tool-op-${c.worker.starts[0]!.attemptId}`, { limit: 10 });
    assert.equal(ops.length, 2, "the parked ask and the call that ran are two calls of the attempt");
  });

  suite("H12i: a tool the controller itself runs is listed, described and invoked like a catalogue tool, through the tool grant, the arguments check and the durable call record", async (c) => {
    const calls: Array<{ taskId: string; input: JsonObject }> = [];
    c.builtins.push({
      name: "nimblenewt.web-fetch", version: "1.0.0", purpose: "read a web page",
      input: { type: "object", properties: { url: { type: "string", maxLength: 200 } }, required: ["url"], additionalProperties: false },
      output: { type: "object", properties: { status: { type: "integer" }, text: { type: "string" } }, required: ["status", "text"] },
      run: async (call, input) => { calls.push({ taskId: call.taskId, input }); if (input["url"] === "http://boom.example.com/") throw new Error("the page could not be fetched"); return input["url"] === "http://wrong.example.com/" ? { status: "x" } : { status: 200, text: `page ${String(input["url"])}` }; },
    });
    const ann = await c.agentFor("ann", [{ action: "tool.nimblenewt.web-fetch", project: c.project }]);
    const ben = await c.agentFor("ben");
    await c.task("research", ann);
    let seen: { listed: JsonObject; described: JsonObject; used: JsonObject; unknown: { code: string; message: string }; mismatch: { code: string; message: string }; wrong: JsonObject; failed: JsonObject } | undefined;
    c.worker.script = c.session(async (s) => {
      const listed = good(await s.send("tool.discover"));
      const described = good(await s.send("tool.describe", { tool: "nimblenewt.web-fetch" }));
      const used = good(await s.send("tool.invoke", { tool: "nimblenewt.web-fetch", input: { url: "http://docs.example.com/" } }));
      const unknown = bad(await s.send("tool.describe", { tool: "nimblenewt.web-fetch", version: "9.9.9" }));
      const mismatch = bad(await s.send("tool.invoke", { tool: "nimblenewt.web-fetch", input: { url: 5, extra: true } }));
      const wrong = await s.send("tool.invoke", { tool: "nimblenewt.web-fetch", input: { url: "http://wrong.example.com/" } });
      const failed = await s.send("tool.invoke", { tool: "nimblenewt.web-fetch", input: { url: "http://boom.example.com/" } });
      seen = { listed, described, used, unknown, mismatch, wrong: wrong as never, failed: failed as never };
    });
    await c.tick();
    const { listed, described, used, unknown, mismatch, wrong, failed } = seen!;
    const entry = (listed["tools"] as { name: string; layer: string }[]).find((t) => t.name === "nimblenewt.web-fetch");
    assert.ok(entry !== undefined && entry.layer === "protected");
    assert.equal(described["purpose"], "read a web page"); assert.deepEqual(Object.keys(described["input"] as object).includes("properties"), true);
    assert.equal(used["state"], "confirmed", JSON.stringify(used));
    assert.deepEqual(calls.map((x) => x.input["url"]), ["http://docs.example.com/", "http://wrong.example.com/", "http://boom.example.com/"], "the arguments that did not match the schema never reached the tool");
    assert.ok(unknown.code.length > 0); assert.ok(mismatch.code.length > 0);
    // A result that does not match the tool's own output schema, and a refusal thrown by the tool, are failed calls; neither is a result.
    assert.deepEqual([(wrong["result"] as JsonObject)["state"], (failed["result"] as JsonObject)["state"]], ["failed", "failed"]);
    assert.match(String((wrong["result"] as JsonObject)["reason"]), /does not match its manifest/);
    assert.equal((failed["result"] as JsonObject)["reason"], "the page could not be fetched");
    void ben;
  });

  suite("model-supplied text never reaches a command line: it travels as data on standard input, and the argument vector is the manifest's entry point alone", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const hostile = "https://x.test/'; rm -rf / #$(whoami)`id`\n&& curl evil";
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      good(await c.invoke(s, { tool: name, input: { url: hostile } }));
    });
    await c.tick();
    const run = c.runs[0]!;
    assert.deepEqual(run.argv, ["bin/check.js"]);
    assert.equal(run.program, "node");
    assert.deepEqual(run.env, {});
    assert.equal(JSON.parse(run.stdin).url, hostile);
    for (const part of [run.program, ...run.argv]) assert.ok(!part.includes("rm -rf"), "nothing of the model's text is in the command");
    // A manifest cannot smuggle a shell line through the interpreter name either.
    assert.throws(() => launchOf({ name: "toolbox.x", version: "1.0.0", digest: "d", manifest: manifest({ interpreter: { name: "sh -c 'x'", version: "1" } }) as never }, "", {}), /plain program name/);
    assert.throws(() => launchOf({ name: "toolbox.x", version: "1.0.0", digest: "d", manifest: manifest({ interpreter: undefined }) as never }, "", {}), /entry point and interpreter/);
  });

  suite("arguments are validated against the manifest before anything runs", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const out: BridgeResponse[] = [];
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      for (const input of [{}, { url: 5 }, { url: "x", depth: 9 }, { url: "x", extra: true }, { url: "x".repeat(300) }]) out.push(await s.send("tool.invoke", { tool: name, input }));
      out.push(await s.send("tool.invoke", { tool: name, input: "nope" as never }));
      out.push(await s.send("tool.invoke", { tool: name, input: { url: "ok" }, replaySafe: true } as never));
    });
    await c.tick();
    for (const r of out.slice(0, 5)) { const b = bad(r); assert.equal(b.code, "invalid_command"); assert.match(b.message, /do not match/); }
    assert.equal(bad(out[5]!).code, "invalid_command");
    assert.match(bad(out[6]!).message, /replaySafe/, "a flag from the caller is refused, not honoured");
    assert.equal(c.runs.length, 0, "the script never started");
  });

  suite("a tool that asks for more than the worker holds is denied, and so is a tool the worker holds no grant to run; a tool schema the controller cannot enforce is refused at registration", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const results: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const greedy = await c.install(s, "greedy", "1.0.0", { requestedAccess: ["network.fetch", "effect.perform"] });
      results["greedy"] = await s.send("tool.invoke", { tool: greedy, input: { url: "u" } });
      // A schema using a pattern cannot be enforced here; it is refused when registered.
      const doc = good(await s.send("desk.write", { kind: "note", title: "d", body: "d", visibility: "shared", status: "accepted" }));
      const code = good(await s.send("desk.write", { kind: "note", title: "c", body: "c", visibility: "shared", status: "accepted" }));
      results["pattern"] = await s.send("tool.register", { name: "pat", kind: "tool", version: "1.0.0", manifest: manifest({ input: { type: "object", properties: { a: { type: "string", pattern: "(a+)+$" } } } }), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string });
    });
    await c.tick();
    const greedy = bad(results["greedy"]!);
    assert.equal(greedy.code, "forbidden");
    assert.match(greedy.message, /network\.fetch/);
    assert.equal(bad(results["pattern"]!).code, "invalid_command");
    assert.match(bad(results["pattern"]!).message, /cannot enforce/);
    assert.equal(c.runs.length, 0);
  });

  suite("a tool's output must be JSON that matches its manifest and be bounded; anything else is a failed call, not a result", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const outputs = ["not json", '{"ok":"yes"}', JSON.stringify({ ok: true, pad: "x".repeat(70_000) }), '{"ok":true}'];
    const results: JsonObject[] = [];
    let i = 0;
    c.behave.run = async () => ({ text: outputs[i++]! });
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      for (let k = 0; k < outputs.length; k++) results.push(good(await c.invoke(s, { tool: name, input: { url: `u${k}` } })));
    });
    await c.tick();
    assert.deepEqual(results.map((r) => r["state"]), ["failed", "failed", "failed", "confirmed"]);
  });

  suite("platform compatibility: a host that cannot satisfy the manifest gets every reason back and nothing runs; the facts are the host's own, never the request's", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const results: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0", { os: ["darwin"] });
      // The world's host announced no interpreters, and the manifest wants node and a darwin machine.
      const real = c.serviceOver(c.dispatcher, false);
      results["announced"] = await real.handle(s.token, s.gateway, { op: "tool.invoke", callId: uid("c"), args: { tool: name, input: { url: "u" } } });
      results["claimed"] = await real.handle(s.token, s.gateway, { op: "tool.invoke", callId: uid("c"), args: { tool: name, input: { url: "u" }, host: { os: "darwin", arch: "x64" } } });
    });
    await c.tick();
    assert.equal(bad(results["announced"]!).code, "forbidden");
    assert.match(bad(results["announced"]!).message, /cannot run on this host/);
    assert.match(bad(results["announced"]!).message, /linux|node/);
    assert.equal(bad(results["claimed"]!).code, "invalid_command", "a host description from the caller is not accepted");
    assert.equal(c.runs.length, 0);
  });

  suite("a call ID stands for one request in an attempt: asking again is the same call, a different request under it is refused, a refused one frees the ID; a tool call from a host that is not this machine is refused", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const seen: unknown[] = [];
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { seen.push(raw); return { v: 1, op: "x", ok: true, result: { done: true } } as never; } },
      isLocalHost: () => false,
    });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = async ({ order, gateway }) => {
      const send = (op: string, args: JsonObject, callId: string) => svc.handle(order.credential, gateway, { op, callId, args });
      out["first"] = await send("task.update", { expectedRevision: 1, title: "A" }, "call_0");
      out["same"] = await send("task.update", { expectedRevision: 1, title: "A" }, "call_0");
      out["other"] = await send("task.update", { expectedRevision: 1, title: "B" }, "call_0");
      out["bad"] = await send("task.update", { expectedRevision: 1, title: "C", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "call_1");
      out["fixed"] = await send("task.update", { expectedRevision: 1, title: "C" }, "call_1");
      out["remote"] = await send("tool.invoke", { tool: "a_aaaaaaaaaaaaaaaa.x", input: {} }, "call_2");
      return { status: "completed", text: "x" };
    };
    await c.tick();
    good(out["first"]!); good(out["same"]!);
    assert.equal(bad(out["other"]!).code, "invalid_command");
    assert.match(bad(out["other"]!).message, /already used in this attempt for a different request/);
    bad(out["bad"]!);
    good(out["fixed"]!);
    assert.equal(bad(out["remote"]!).code, "unavailable");
    assert.match(bad(out["remote"]!).message, /not this machine/);
  });

  suite("a call that does not belong to a complete, current generation of the task is refused with the reason and nothing runs; the owner's switches decide the rest (card L05c)", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const seen: unknown[] = [];
    const verdicts: Record<string, unknown> = {
      call_ok: { recorded: true, ok: true, runId: "r", number: 1 },
      call_old: { recorded: true, ok: false, runId: "r", number: 1, reason: "generation 1 of task T was corrected by owner:rob (use beans); its tool calls are withdrawn" },
      call_none: { recorded: false },
      call_heldnone: { recorded: false, held: "task T is held (finish_and_hold: wait)" },
    };
    let broken = false;
    // The binding and the admission of card L05d have their own tests below; the stub verdicts here carry no name or arguments.
    let mode: { check: boolean; require: boolean; bind?: boolean; admit?: boolean } = { check: true, require: false, bind: false, admit: false };
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { seen.push(raw); return { v: 1, op: "x", ok: true, result: { done: true } } as never; } },
      isLocalHost: () => true,
      generations: { checkCall: async (_p: unknown, cmd: { callId: string }) => { if (broken) throw new Error("store down"); return (verdicts[cmd.callId] ?? { recorded: false }) as never; } },
      callCheck: async () => mode,
    });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = async ({ order, gateway }) => {
      const send = (callId: string, op = "task.update") => svc.handle(order.credential, gateway, { op, callId, args: { expectedRevision: 1, title: callId } });
      out["ok"] = await send("call_ok");
      out["old"] = await send("call_old");
      out["oldRead"] = await send("call_old", "task.get");
      out["none"] = await send("call_none");
      out["heldNone"] = await send("call_heldnone");
      mode = { check: true, require: true, bind: false, admit: false };
      out["noneRequired"] = await send("call_none");
      out["declare"] = await svc.handle(order.credential, gateway, { op: "tool.discover", callId: "h:0123456789abcdef0123456789abcdef01234567", args: {} });
      // Card W04: the worker's own continuation question is no model call either; a held task refuses it.
      out["continue"] = await svc.handle(order.credential, gateway, { op: "turn.continue", callId: "nudge:0123:1", args: { n: 1, max: 3 } });
      out["continueHeld"] = await svc.handle(order.credential, gateway, { op: "turn.continue", callId: "call_heldnone", args: { n: 1, max: 3 } });
      mode = { check: false, require: false, bind: false, admit: false };
      out["oldUnchecked"] = await send("call_old");
      mode = { check: true, require: false, bind: false, admit: false };
      broken = true;
      out["broken"] = await send("call_ok");
      return { status: "completed", text: "x" };
    };
    await c.tick();
    good(out["ok"]!);
    assert.equal(bad(out["old"]!).code, "generation_refused");
    assert.match(bad(out["old"]!).message, /corrected by owner:rob \(use beans\).*it was not run/);
    assert.equal(bad(out["oldRead"]!).code, "generation_refused", "reads of a withdrawn call are refused too");
    good(out["none"]!);
    assert.match(bad(out["heldNone"]!).message, /is held.*not run/, "a held task runs no call, recorded or not");
    assert.match(bad(out["noneRequired"]!).message, /belongs to no recorded generation/);
    assert.notEqual((out["declare"] as { code?: string }).code, "generation_refused", "the extension's own declaration reads are not a model call");
    good(out["continue"]!);
    assert.match(bad(out["continueHeld"]!).message, /is held.*not run/, "a held task's turn is not continued");
    good(out["oldUnchecked"]!);
    assert.equal(bad(out["broken"]!).code, "unavailable");
    // Only the calls that passed reached the state API: ok, none, oldUnchecked.
    assert.deepEqual(seen.map((r) => (r as { args: { title: string } }).args.title), ["call_ok", "call_none", "call_old"]);
  });

  suite("card L05d finish: a call ID of 118 characters (the longest the bridge takes) runs a write once and is answered from the ledger when asked again; the operation's command ID stays within 120 characters", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const seen: { commandId: string }[] = [];
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { seen.push(raw as never); return { v: 1, op: "x", ok: true, result: { done: true } } as never; } },
      isLocalHost: () => false,
    });
    const out: Record<string, BridgeResponse> = {};
    const long = "L".repeat(118);
    const long2 = "L".repeat(117) + "M";
    const { createHash } = await import("node:crypto");
    const digest = createHash("sha256").update(long).digest("hex").slice(0, 40);
    let attemptId = "";
    c.worker.script = async ({ order, gateway }) => {
      attemptId = order.attemptId;
      const send = (op: string, args: JsonObject, callId: string) => svc.handle(order.credential, gateway, { op, callId, args });
      out["first"] = await send("task.update", { expectedRevision: 1, title: "A" }, long);
      out["same"] = await send("task.update", { expectedRevision: 1, title: "A" }, long);
      out["other"] = await send("task.update", { expectedRevision: 1, title: "A" }, long2);
      // Short call IDs that spell the digest of the long one in every way a hashed form could be written: none may be keyed as the long call is (a different operation would be taken for its replay).
      for (const [i, id] of [`h-${digest}`, `h:${digest}`, digest, `${attemptId}:h-${digest}`].entries()) out[`short${i}`] = await send("task.update", { expectedRevision: 1, title: `S${i}` }, id);
      return { status: "completed", text: "x" };
    };
    await c.tick();
    good(out["first"]!); good(out["same"]!); good(out["other"]!);
    for (let i = 0; i < 4; i++) good(out[`short${i}`]!);
    assert.equal(seen.length, 7);
    for (const r of seen) assert.ok(r.commandId.length <= 120 && /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(r.commandId), r.commandId);
    assert.equal(seen[0]!.commandId, seen[1]!.commandId, "the same call has the same key");
    assert.notEqual(seen[0]!.commandId, seen[2]!.commandId, "calls that differ in their last character have different keys");
    assert.ok(!seen[0]!.commandId.includes(long));
    // The short IDs keep the readable form byte for byte and none equals the long call's key (nor any other).
    const shortIds = [`h-${digest}`, `h:${digest}`, digest, `${attemptId}:h-${digest}`];
    for (const [i, id] of shortIds.entries()) assert.equal(seen[3 + i]!.commandId, `bridge:${attemptId}:${id}`);
    assert.equal(new Set(seen.map((r) => r.commandId)).size, 6, "six different calls (one repeat) have six keys");
  });

  suite("card L05d finish: a short call ID keeps its readable command ID", async () => {
    assert.equal(bridgeCommandId("bridge", "att-aaaaaaaaaaaaaaaaaaaa", "call_0"), "bridge:att-aaaaaaaaaaaaaaaaaaaa:call_0");
    const a = bridgeCommandId("bridge-run", "att-aaaaaaaaaaaaaaaaaaaa", "x".repeat(120));
    assert.ok(a.length <= 120 && a.startsWith("bridge-run-h:att-aaaaaaaaaaaaaaaaaaaa:"));
    assert.equal(bridgeCommandId("bridge", "att-aaaaaaaaaaaaaaaaaaaa", "x".repeat(88)).length, 120, "88 characters still fit as they are");
    // The threshold follows the real length of the attempt ID: a longer attempt ID moves it, and the form never exceeds 120.
    for (const attempt of ["att-aaaaaaaaaaaaaaaaaaaa", "a".repeat(40)]) for (const prefix of ["bridge", "bridge-run"]) for (let len = 1; len <= 120; len++) {
      const id = bridgeCommandId(prefix, attempt, "z".repeat(len));
      assert.ok(id.length <= 120);
      assert.equal(id === `${prefix}:${attempt}:${"z".repeat(len)}`, `${prefix}:${attempt}:${"z".repeat(len)}`.length <= 120);
    }
    // A digest form never equals a readable one: the readable form has a colon right after the prefix, the digest form a "-h".
    const hashed = bridgeCommandId("bridge", "att-aaaaaaaaaaaaaaaaaaaa", "y".repeat(120));
    assert.ok(hashed.startsWith("bridge-h:") && !hashed.startsWith("bridge:"));
    assert.ok(bridgeCommandId("bridge-run", "att-aaaaaaaaaaaaaaaaaaaa", "y".repeat(120)).startsWith("bridge-run-h:"));
  });

  suite("card L05d: a recorded write is admitted as an effect and settled with the outcome; a generation still streaming is waited for; a refusal fails the effect and a crash leaves it uncertain; a repeat is answered from the ledger; reads and unrecorded calls are not admitted", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const seen: unknown[] = [];
    const ledger = new Map<string, { status: "confirmed" | "failed" | "uncertain"; evidence: JsonObject }>();
    const admitted: string[] = [];
    let streamingFor = 0;
    const verdict = (name: string, args: object) => ({ recorded: true, ok: true, runId: "grun-x", number: 1, callId: "c", name, args: JSON.stringify(args), state: "complete" });
    const calls: Record<string, ReturnType<typeof verdict> | { recorded: false }> = {
      w1: verdict("nimblenewt__task-update", { expectedRevision: 1, title: "A" }),
      w2: verdict("nimblenewt__task-update", { expectedRevision: 1, title: "B" }),
      w3: verdict("nimblenewt__task-update", { expectedRevision: 1, title: "C" }),
      r1: verdict("nimblenewt__task-get", {}),
      u1: { recorded: false },
      big: verdict("nimblenewt__task-update", { expectedRevision: 1, title: "D" }),
    };
    const { GenerationRefused } = await import("../generation/index.js");
    const { EffectRejected } = await import("../domain/effects.js");
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { seen.push(raw); const title = (raw as { args: { title?: string } }).args.title; if (title === "B") return { v: 1, op: "x", ok: false, error: { code: "stale_revision", message: "the task changed" } } as never; if (title === "C") throw new Error("the state API fell over"); if (title === "D") return { v: 1, op: "x", ok: true, result: { big: "x".repeat(30_000) } } as never; return { v: 1, op: "x", ok: true, result: { done: title ?? true } } as never; } },
      isLocalHost: () => true,
      generations: {
        checkCall: async (_p: unknown, cmd: { callId: string }) => (calls[cmd.callId] ?? { recorded: false }) as never,
        admitCall: async (_p: unknown, cmd: { callId: string; target: string; commandId: string }) => {
          if (streamingFor > 0) { streamingFor--; throw new GenerationRefused("streaming", "generation grun-x is still streaming"); }
          if (cmd.callId === "gone") throw new GenerationRefused("interrupted", "generation 1 was interrupted (corrected); nothing from it is applied");
          const again = admitted.includes(`${cmd.callId}:${cmd.target}`);
          if (!again) admitted.push(`${cmd.callId}:${cmd.target}`);
          return { effectId: `eff-${cmd.callId}`, runId: "grun-x", toolCallId: cmd.callId, replayed: again };
        },
        executeCall: async (_p: unknown, cmd: { toolCallId: string }, bridge: { execute(r: never): Promise<JsonObject> }) => {
          const kept = ledger.get(cmd.toolCallId);
          if (kept !== undefined) return { effectId: `eff-${cmd.toolCallId}`, ...kept } as never;
          try { const evidence = await bridge.execute({} as never); ledger.set(cmd.toolCallId, { status: "confirmed", evidence }); } catch (error) {
            ledger.set(cmd.toolCallId, error instanceof EffectRejected ? { status: "failed", evidence: error.evidence } : { status: "uncertain", evidence: {} });
          }
          return { effectId: `eff-${cmd.toolCallId}`, ...ledger.get(cmd.toolCallId)! } as never;
        },
      },
      callCheck: async () => ({ check: true, require: false }),
    });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = async ({ order, gateway }) => {
      const send = (callId: string, op: string, args: JsonObject) => svc.handle(order.credential, gateway, { op, callId, args });
      out["w1"] = await send("w1", "task.update", { expectedRevision: 1, title: "A" });
      out["w1again"] = await send("w1", "task.update", { expectedRevision: 1, title: "A" });
      streamingFor = 2;
      calls["w1b"] = verdict("nimblenewt__task-update", { expectedRevision: 1, title: "A2" });
      out["streaming"] = await send("w1b", "task.update", { expectedRevision: 1, title: "A2" });
      out["w2"] = await send("w2", "task.update", { expectedRevision: 1, title: "B" });
      out["w2again"] = await send("w2", "task.update", { expectedRevision: 1, title: "B" });
      out["w3"] = await send("w3", "task.update", { expectedRevision: 1, title: "C" });
      out["w3again"] = await send("w3", "task.update", { expectedRevision: 1, title: "C" });
      out["r1"] = await send("r1", "task.get", {});
      out["u1"] = await send("u1", "task.update", { expectedRevision: 1, title: "U" });
      out["big"] = await send("big", "task.update", { expectedRevision: 1, title: "D" });
      out["bigAgain"] = await send("big", "task.update", { expectedRevision: 1, title: "D" });
      calls["gone"] = verdict("nimblenewt__task-update", { expectedRevision: 1, title: "G" });
      out["gone"] = await send("gone", "task.update", { expectedRevision: 1, title: "G" });
      streamingFor = 1000;
      calls["slow"] = verdict("nimblenewt__task-update", { expectedRevision: 1, title: "S" });
      out["slow"] = await send("slow", "task.update", { expectedRevision: 1, title: "S" });
      return { status: "completed", text: "x" };
    };
    await c.tick();
    good(out["w1"]!); assert.deepEqual(out["w1again"], out["w1"], "answered from the ledger");
    good(out["streaming"]!);
    assert.deepEqual(admitted.filter((a) => a.startsWith("w1")), ["w1:task.update", "w1b:task.update"], "each call is admitted once");
    assert.equal(seen.filter((r) => (r as { args: { title?: string } }).args.title === "A").length, 1, "the repeat did not run again");
    // A refusal of the operation's own service did not happen: the effect fails, the answer is that refusal, and the same call says the same again without running.
    const w2 = bad(out["w2"]!);
    assert.deepEqual([w2.code, w2.message], ["stale_revision", "the task changed"]);
    assert.deepEqual(out["w2again"], out["w2"]);
    assert.equal(ledger.get("w2")!.status, "failed");
    // A crash leaves the outcome unknown: the effect is uncertain, the first answer is the usual internal one, and a repeat is not run again.
    assert.equal(bad(out["w3"]!).code, "internal");
    assert.equal(ledger.get("w3")!.status, "uncertain");
    assert.equal(bad(out["w3again"]!).code, "unavailable");
    assert.match(bad(out["w3again"]!).message, /may or may not have happened/);
    assert.equal(seen.filter((r) => (r as { args: { title?: string } }).args.title === "C").length, 1);
    // A read, and a write that no generation recorded, are not admitted.
    good(out["r1"]!); good(out["u1"]!);
    assert.equal(admitted.some((a) => a.startsWith("r1") || a.startsWith("u1")), false);
    // A result too large to keep is answered once, and a repeat says it already ran.
    assert.equal(good(out["big"]!)["big"]?.toString().length, 30_000);
    assert.equal(good(out["bigAgain"]!)["replayed"], true);
    // A generation interrupted between the check and the admission, and one that never stops streaming: refused, not run.
    assert.equal(bad(out["gone"]!).code, "generation_refused");
    assert.match(bad(out["gone"]!).message, /interrupted.*it was not run/);
    assert.equal(bad(out["slow"]!).code, "generation_refused");
    assert.match(bad(out["slow"]!).message, /still streaming/);
    assert.equal(seen.some((r) => (r as { args: { title?: string } }).args.title === "G" || (r as { args: { title?: string } }).args.title === "S"), false);
  });

  suite("card L05d: a recorded call is bound to the operation it is presented for (name and arguments); the owner can turn that off", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const seen: unknown[] = [];
    let mode: { check: boolean; require: boolean; bind?: boolean; admit?: boolean } = { check: true, require: false, bind: true, admit: false };
    const rec = (name: string, args: string) => ({ recorded: true, ok: true, runId: "r", number: 1, callId: "c", name, args, state: "complete" });
    const verdicts: Record<string, unknown> = {
      good: rec("nimblenewt__task-update", '{"expectedRevision":1,"title":"A"}'),
      other: rec("nimblenewt__desk-write", '{"expectedRevision":1,"title":"A"}'),
      args: rec("nimblenewt__task-update", '{"expectedRevision":1,"title":"Z"}'),
      coerced: rec("nimblenewt__task-update", '{"expectedRevision":"1","title":"A"}'),
      nested: rec("nimblenewt__tool-invoke", '{"tool":"t.x","input":{"a":[1,{"b":true}]}}'),
      broken: rec("nimblenewt__task-update", "not json"),
      extra: rec("nimblenewt__task-update", '{"expectedRevision":1,"title":"A"}'),
      // Card L05e: a `__proto__` member is an own member of what JSON.parse reads; one side having it and the other not is a difference (it was compared with the other side's prototype and equal).
      protoWritten: rec("nimblenewt__task-update", '{"expectedRevision":1,"title":"A","__proto__":{}}'),
      protoSent: rec("nimblenewt__task-update", '{"expectedRevision":1,"title":"A"}'),
      protoBoth: rec("nimblenewt__task-update", '{"expectedRevision":1,"title":"A","__proto__":{"x":1}}'),
    };
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { seen.push(raw); return { v: 1, op: "x", ok: true, result: { done: true } } as never; } },
      isLocalHost: () => true,
      generations: { checkCall: async (_p: unknown, cmd: { callId: string }) => (verdicts[cmd.callId] ?? { recorded: false }) as never },
      callCheck: async () => mode,
    });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = async ({ order, gateway }) => {
      const send = (callId: string, op: string, args: JsonObject) => svc.handle(order.credential, gateway, { op, callId, args });
      out["good"] = await send("good", "task.update", { expectedRevision: 1, title: "A" });
      out["other"] = await send("other", "task.update", { expectedRevision: 1, title: "A" });
      out["args"] = await send("args", "task.update", { expectedRevision: 1, title: "A" });
      out["extra"] = await send("extra", "task.update", { expectedRevision: 1, title: "A", description: "more" });
      out["coerced"] = await send("coerced", "task.update", { expectedRevision: 1, title: "A" });
      out["nested"] = await send("nested", "tool.invoke", { tool: "t.x", input: { a: [1, { b: true }] } });
      out["broken"] = await send("broken", "task.update", { expectedRevision: 1, title: "A" });
      out["declaration"] = await send("good", "tool.discover", {});
      out["protoWritten"] = await send("protoWritten", "task.update", { expectedRevision: 1, title: "A" });
      out["protoSent"] = await send("protoSent", "task.update", JSON.parse('{"expectedRevision":1,"title":"A","__proto__":{}}') as JsonObject);
      out["protoBoth"] = await send("protoBoth", "task.update", JSON.parse('{"expectedRevision":1,"title":"A","__proto__":{"x":1}}') as JsonObject);
      mode = { check: true, require: false, bind: false, admit: false };
      out["unbound"] = await send("other", "task.update", { expectedRevision: 1, title: "Q" });
      return { status: "completed", text: "x" };
    };
    await c.tick();
    good(out["good"]!);
    assert.match(bad(out["other"]!).message, /written by the model as nimblenewt__desk-write, not as nimblenewt__task-update.*not run/);
    assert.match(bad(out["args"]!).message, /not those the model wrote/);
    assert.match(bad(out["extra"]!).message, /not those the model wrote/, "an argument the model did not write is not run");
    good(out["coerced"]!);
    assert.notEqual((out["nested"] as { code?: string }).code, "generation_refused", "nested values are compared member by member");
    assert.match(bad(out["broken"]!).message, /not readable as recorded/);
    assert.notEqual((out["declaration"] as { code?: string }).code, "generation_refused", "the extension's declaration reads are not a model call");
    assert.match(bad(out["protoWritten"]!).message, /not those the model wrote/, "a __proto__ member the model wrote and the request lacks is a difference");
    assert.match(bad(out["protoSent"]!).message, /not those the model wrote/, "a __proto__ member the request has and the model did not write is a difference");
    assert.notEqual((out["protoBoth"] as { code?: string }).code, "generation_refused", "the same __proto__ member on both sides is equal");
    good(out["unbound"]!);
    assert.deepEqual(seen.map((r) => (r as { args: { title: string } }).args.title).slice(0, 2), ["A", "A"]);
    assert.equal(seen.length >= 3, true);
  });

  suite("card L05d review: an admitted tool.invoke parked for review is not settled by its first answer: asked again with the same call ID after the approval it runs, once, through the real generation and effect ledger", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
    c.svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, isLocalHost: () => true, facts: async () => hostFacts,
      runner: { run: async (launch) => { c.runs.push(launch); return { text: '{"ok":true}', cpuMs: 5 }; } }, generations: c.generation,
    });
    const answers: JsonObject[] = [];
    let effectId: string | undefined;
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      const args = { tool: name, input: { url: "u" } };
      // The model's reply holds the call; it is recorded as a complete call of the task's current generation.
      const d = c.dispatcherPrincipal;
      const run = await c.generation.begin(d, { commandId: "b1", taskId, contextRevision: 1 });
      await c.generation.record(d, { commandId: "r1", runId: run.id, seq: 1, toolCall: { id: "inv-1", name: "nimblenewt__tool-invoke", argumentsDelta: JSON.stringify(args), done: true } });
      await c.generation.complete(d, { commandId: "c1", runId: run.id });
      answers.push(good(await s.send("tool.invoke", args, "inv-1")));
      const review = (await c.reviews.get(c.owner, answers[0]!["reviewId"] as string))!;
      await c.reviews.decide(c.owner, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
      answers.push(good(await s.send("tool.invoke", args, "inv-1")));
      answers.push(good(await s.send("tool.invoke", args, "inv-1")));
      effectId = (await c.generation.view(c.owner, run.id))!.run.toolCalls[0]!.effectId;
    });
    await c.tick();
    assert.deepEqual(answers.map((a) => a["state"]), ["awaiting-approval", "confirmed", "confirmed"], JSON.stringify(answers));
    assert.equal(c.runs.length, 1, "the approved call ran once, and the repeat was not run again");
    assert.ok(effectId !== undefined, "the call was admitted as an effect of its generation");
    assert.equal((await c.storage.getEffect(effectId!))?.status, "confirmed");
  });

  suite("an agent holds the grant for its own tool namespace from enrolment, so the tool path asks for approval instead of refusing the call; nothing runs before it", async (c) => {
    // Ann is enrolled with no grant for her own namespace given: she holds it all the same.
    const ann = await c.agent("ann", [...workGrants(c.project), { action: "desk.write", project: c.project }, { action: "desk.read", project: c.project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }]);
    const { attemptId } = await c.task("t", ann);
    let result: JsonObject | undefined;
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      result = good(await s.send("tool.invoke", { tool: name, input: { url: "u" } }, "no-grant"));
    });
    await c.tick();
    assert.equal(result!["state"], "awaiting-approval");
    assert.doesNotMatch(String(result!["reason"] ?? ""), /holds no grant/);
    assert.equal(c.runs.length, 0);
    const ops = (await c.storage.listAggregates(`tool-op-${attemptId}`, { limit: 10 })).map((a) => a.body as unknown as { state: string });
    assert.deepEqual(ops.map((o) => o.state), ["awaiting-approval"], "the parked call is a durable operation");
  });

  suite("an active call finishes on its version while the next call uses the newly registered one", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const gate = deferred();
    const started = deferred();
    c.behave.run = async (launch) => { if (launch.tool.version === "1.0.0") { started.resolve(); await gate.promise; } return { text: '{"ok":true}' }; };
    const done: Record<string, JsonObject> = {};
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0", {}, "// version one");
      await c.clear(s, { tool: name, input: { url: "u" } }, "long-call");
      const first = s.send("tool.invoke", { tool: name, input: { url: "u" } }, "long-call");
      await started.promise;
      const doc = good(await s.send("desk.write", { kind: "note", title: "n", body: "v2 notes", visibility: "shared", status: "accepted" }));
      const code = good(await s.send("desk.write", { kind: "note", title: "c", body: "// version two", visibility: "shared", status: "accepted" }));
      good(await s.send("tool.register", { name: "check", kind: "tool", version: "1.1.0", manifest: manifest(), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string }));
      done["second"] = good(await c.invoke(s, { tool: name, input: { url: "u" } }));
      gate.resolve();
      done["first"] = good(await first);
    });
    await c.tick();
    assert.equal(done["first"]!["version"], "1.0.0");
    assert.equal(done["second"]!["version"], "1.1.0");
    assert.deepEqual(c.runs.map((r) => [r.tool.version, r.source]), [["1.0.0", "// version one"], ["1.1.0", "// version two"]]);
  });

  suite("a revoked version is refused at invocation even though the agent still has it in an old list; the latest live one is used when no version is named; a revocation between the check and the start stops the run", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      const stale = good(await s.send("tool.discover"));
      // Version 1.1.0 is registered and then revoked by the owner; the agent's list is stale.
      const doc = good(await s.send("desk.write", { kind: "note", title: "n", body: "n", visibility: "shared", status: "accepted" }));
      const code = good(await s.send("desk.write", { kind: "note", title: "c", body: "c2", visibility: "shared", status: "accepted" }));
      good(await s.send("tool.register", { name: "check", kind: "tool", version: "1.1.0", manifest: manifest(), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string }));
      await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.1.0", reason: "found a bug" });
      void stale;
      out["named"] = await s.send("tool.invoke", { tool: name, version: "1.1.0", input: { url: "u" } });
      out["latest"] = await c.invoke(s, { tool: name, input: { url: "u" } });
      out["described"] = await s.send("tool.describe", { tool: name, version: "1.1.0" });
      // A revocation that lands after the check and before the start: the run asks again and does not start.
      await c.clear(s, { tool: name, version: "1.0.0", input: { url: "u" } }, "raced-call");
      const real = c.catalog.content.bind(c.catalog);
      let once = false;
      (c.catalog as { content: unknown }).content = async (...a: Parameters<typeof real>) => { const r = await real(...a); if (!once) { once = true; await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "late" }); } return r; };
      out["raced"] = await s.send("tool.invoke", { tool: name, version: "1.0.0", input: { url: "u" } }, "raced-call");
      (c.catalog as { content: unknown }).content = real;
    });
    await c.tick();
    assert.equal(bad(out["named"]!).code, "forbidden");
    assert.match(bad(out["named"]!).message, /revoked/);
    assert.equal(good(out["latest"]!)["version"], "1.0.0", "revoking 1.1.0 falls back to the latest live version");
    assert.equal(good(out["described"]!)["version"], "1.1.0");
    assert.ok(good(out["described"]!)["revoked"] !== undefined, "describe says it was revoked");
    const raced = good(out["raced"]!);
    assert.equal(raced["state"], "failed");
    assert.equal(c.runs.length, 1, "only the call before the race ran");
  });


  for (const mode of ["finish", "cancel", "broken"] as const) {
    suite(`T02b: revoking a version while a call of it runs: policy ${mode} ${mode === "finish" ? "lets it end on the bytes it started with" : "aborts it and the call ends as failed"}; a later call is refused either way`, async (c) => {
      c.revocation.mode = mode;
      const ann = await c.agentFor("ann");
      await c.task("t", ann);
      const out: Record<string, BridgeResponse> = {};
      let aborted = false;
      let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      c.behave.run = async (_l, signal) => {
        started();
        await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { aborted = true; resolve(); }); void gate.then(resolve); });
        return { text: '{"ok":true}', cpuMs: 1 };
      };
      c.worker.script = c.session(async (s) => {
        const name = await c.install(s, "slow", "1.0.0");
        await c.clear(s, { tool: name, version: "1.0.0", input: { url: "u" } }, "long-call");
        const running = s.send("tool.invoke", { tool: name, version: "1.0.0", input: { url: "u" } }, "long-call");
        await hasStarted;
        await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad" });
        // A repeat of the same revoke (a replay) does not change anything.
        await c.catalog.revoke(c.owner, { commandId: uid("rv2"), name, version: "1.0.0", reason: "bad" }).catch(() => undefined);
        await new Promise((r) => setTimeout(r, 30));
        out["aborted-before-release"] = { ok: true, result: { aborted } };
        release();
        out["running"] = await running;
        out["later"] = await s.send("tool.invoke", { tool: name, version: "1.0.0", input: { url: "u" } }, "another-call");
      });
      await c.tick();
      assert.equal(good(out["aborted-before-release"]!)["aborted"], mode !== "finish");
      const ran = good(out["running"]!);
      assert.equal(ran["state"], mode === "finish" ? "confirmed" : "failed", JSON.stringify(ran));
      assert.equal(bad(out["later"]!).code, "forbidden");
    });
  }

  // Card T02d: a revocation taken by ANOTHER process. `other` stands for a second controller process on the same store: its catalogue view has no `onRevoked` (the listener lives in the process that took the command), so the only
  // way it can hear is the store check. The owner's choice is read from the revocation record.
  for (const choice of ["finish", "cancel", "pause", "none-policy-cancel", "none-policy-finish"] as const) {
    suite(`T02d: a revoke taken by another process reaches a call running here (choice ${choice})`, async (c) => {
      const ann = await c.agentFor("ann");
      const t = await c.task("t", ann);
      let aborted = false;
      let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      const paused: string[] = [];
      const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
      const view = { get: c.catalog.get.bind(c.catalog), list: c.catalog.list.bind(c.catalog), register: c.catalog.register.bind(c.catalog), content: c.catalog.content.bind(c.catalog), authorizeRun: c.catalog.authorizeRun.bind(c.catalog), revocationOf: c.catalog.revocationOf.bind(c.catalog) };
      const other = new ToolExecutionService({
        principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) }, assignments: c.assignments,
        catalog: view, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, facts: async () => hostFacts, isLocalHost: () => true, revocationWatchMs: 15,
        runner: { run: async (_l, signal) => { started(); await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { aborted = true; resolve(); }); void gate.then(resolve); }); return { text: '{"ok":true}', cpuMs: 1 }; } },
        revocationPolicy: () => (choice === "none-policy-cancel" ? "cancel" : "finish"),
        revocationOwner: async (id) => (id === c.owner.id ? c.owner : undefined),
        pauseTask: async (owner, taskId, reason, commandId) => { assert.equal(owner.id, c.owner.id); paused.push(taskId); return c.pauses.pause(owner, { commandId, scope: { kind: "task", id: taskId }, reason }); },
      });
      const out: Record<string, BridgeResponse> = {};
      try {
        c.worker.script = c.session(async (s) => {
          const name = await c.install(s, "slow", "1.0.0");
          const args = { tool: name, version: "1.0.0", input: { url: "u" } };
          await c.clear(s, args, "long-call");
          const running = other.handle(s.token, s.gateway, { op: "tool.invoke", callId: "long-call", args });
          await hasStarted;
          assert.equal(other.runningTotal(name, "1.0.0"), 1);
          // The process that takes the command is not the one that runs the call: nothing is aborted by a listener.
          await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad", ...(choice === "finish" || choice === "cancel" || choice === "pause" ? { runningCalls: choice } : {}) });
          const deadline = Date.now() + 3000;
          while (Date.now() < deadline && (choice === "finish" || choice === "none-policy-finish" ? false : !aborted)) await new Promise((r) => setTimeout(r, 10));
          // Give a finishing call a few rounds of the check to prove it is left alone.
          if (choice === "finish" || choice === "none-policy-finish") await new Promise((r) => setTimeout(r, 120));
          out["aborted-before-release"] = { ok: true, result: { aborted } };
          release();
          out["running"] = await running;
        });
        await c.tick();
        const cancels = choice === "cancel" || choice === "pause" || choice === "none-policy-cancel";
        assert.equal(good(out["aborted-before-release"]!)["aborted"], cancels);
        assert.equal(good(out["running"]!)["state"], cancels ? "failed" : "confirmed");
        assert.deepEqual(paused, choice === "pause" ? [t.taskId] : [], "only the pause choice pauses the task");
        if (choice === "pause") assert.ok((await c.pauses.guard(t.taskId)).blockedBy.some((b) => b.kind === "task" && b.id === t.taskId));
      } finally { other.dispose(); }
    });
  }

  suite("T02d: the store check never cancels on a failed read, applies each revocation once, acts on an explicit check, and stops its timer when nothing runs or the service is disposed", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    let reads = 0;
    let broken = true;
    let aborted = 0;
    let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
    const view = { get: c.catalog.get.bind(c.catalog), list: c.catalog.list.bind(c.catalog), register: c.catalog.register.bind(c.catalog), content: c.catalog.content.bind(c.catalog), authorizeRun: c.catalog.authorizeRun.bind(c.catalog), revocationOf: async (n: string, v: string) => { reads++; if (broken) throw new Error("store unavailable"); return c.catalog.revocationOf(n, v); } };
    const other = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) }, assignments: c.assignments,
      catalog: view, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, facts: async () => hostFacts, isLocalHost: () => true, revocationWatchMs: 0,
      runner: { run: async (_l, signal) => { started(); await new Promise<void>((resolve) => { signal.addEventListener("abort", () => { aborted++; resolve(); }); void gate.then(resolve); }); return { text: '{"ok":true}', cpuMs: 1 }; } },
      revocationPolicy: () => "cancel",
    });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "slow", "1.0.0");
      const args = { tool: name, version: "1.0.0", input: { url: "u" } };
      await c.clear(s, args, "long-call");
      const running = other.handle(s.token, s.gateway, { op: "tool.invoke", callId: "long-call", args });
      await hasStarted;
      // Nothing revoked: nothing acted on (and a store that cannot answer is not a revocation).
      assert.deepEqual(await other.checkRevocations(), []);
      await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad" });
      assert.deepEqual(await other.checkRevocations(), [], "the store could not be read: nothing is cancelled");
      assert.equal(aborted, 0);
      broken = false;
      assert.deepEqual(await other.checkRevocations(), [`${name}|1.0.0`]);
      assert.equal(aborted, 1);
      const before = reads;
      assert.deepEqual(await other.checkRevocations(), [], "a revocation is applied once");
      assert.equal(reads, before, "and its version is not asked about again");
      release();
      out["running"] = await running;
      assert.equal(other.runningTotal(name, "1.0.0"), 0);
    });
    await c.tick();
    assert.equal(good(out["running"]!)["state"], "failed");
    other.dispose();
  });

  suite("T02d: the store check's timer asks only while a call runs: it stops when the last call ends and when the service is disposed", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    let reads = 0;
    const gates: (() => void)[] = [];
    let startedCount = 0;
    const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
    const view = { get: c.catalog.get.bind(c.catalog), list: c.catalog.list.bind(c.catalog), register: c.catalog.register.bind(c.catalog), content: c.catalog.content.bind(c.catalog), authorizeRun: c.catalog.authorizeRun.bind(c.catalog), revocationOf: async (n: string, v: string) => { reads++; return c.catalog.revocationOf(n, v); } };
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) }, assignments: c.assignments,
      catalog: view, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, facts: async () => hostFacts, isLocalHost: () => true, revocationWatchMs: 10,
      runner: { run: async () => { startedCount++; await new Promise<void>((r) => { gates.push(r); }); return { text: '{"ok":true}', cpuMs: 1 }; } },
    });
    const settle = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const until = async (cond: () => boolean) => { const end = Date.now() + 5000; while (!cond() && Date.now() < end) await settle(5); assert.ok(cond()); };
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "slow", "1.0.0");
      const args = { tool: name, version: "1.0.0", input: { url: "u" } };
      await c.clear(s, args, "watch-call-a");
      const first = svc.handle(s.token, s.gateway, { op: "tool.invoke", callId: "watch-call-a", args });
      await until(() => startedCount === 1);
      await until(() => reads >= 2);
      gates.shift()!();
      out["first"] = await first;
      await settle(30);
      const idle = reads;
      await settle(80);
      assert.equal(reads, idle, "no call runs: the store is not asked");
      await c.clear(s, args, "watch-call-b");
      const second = svc.handle(s.token, s.gateway, { op: "tool.invoke", callId: "watch-call-b", args });
      await until(() => startedCount === 2);
      await until(() => reads > idle);
      svc.dispose();
      await settle(30);
      const disposed = reads;
      await settle(80);
      assert.equal(reads, disposed, "disposed: the store is not asked, even with a call still running");
      gates.shift()!();
      out["second"] = await second;
    });
    await c.tick();
    assert.equal(good(out["first"]!)["state"], "confirmed");
    assert.equal(good(out["second"]!)["state"], "confirmed");
  });

  suite("T02d: a revocation the store check already applied is not applied again when the in-process listener fires after it (or a replayed revoke calls it again)", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    let policyReads = 0;
    let notices = 0;
    let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const listeners: ((name: string, version: string, runningCalls: "finish" | "cancel" | "pause" | undefined, owner: typeof c.owner) => void)[] = [];
    const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
    const view = { get: c.catalog.get.bind(c.catalog), list: c.catalog.list.bind(c.catalog), register: c.catalog.register.bind(c.catalog), content: c.catalog.content.bind(c.catalog), authorizeRun: c.catalog.authorizeRun.bind(c.catalog), revocationOf: c.catalog.revocationOf.bind(c.catalog), onRevoked: (l: (typeof listeners)[number]) => { listeners.push(l); return () => undefined; } };
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) }, assignments: c.assignments,
      catalog: view, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, facts: async () => hostFacts, isLocalHost: () => true, revocationWatchMs: 0,
      // The call outlives the abort (a script slow to die), so a second application would find it still running and act on it again.
      runner: { run: async () => { started(); await gate; return { text: '{"ok":true}', cpuMs: 1 }; } },
      revocationPolicy: () => { policyReads++; return "pause"; },
      notice: async () => { notices++; },
    });
    const out: Record<string, BridgeResponse> = {};
    try {
      c.worker.script = c.session(async (s) => {
        const name = await c.install(s, "slow", "1.0.0");
        const args = { tool: name, version: "1.0.0", input: { url: "u" } };
        await c.clear(s, args, "long-call");
        const running = svc.handle(s.token, s.gateway, { op: "tool.invoke", callId: "long-call", args });
        await hasStarted;
        await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad" });
        assert.deepEqual(await svc.checkRevocations(), [`${name}|1.0.0`]);
        assert.equal(policyReads, 1);
        assert.equal(notices, 1, "no owner could be had for the pause: the owner is told once");
        assert.equal(svc.runningTotal(name, "1.0.0"), 1, "still running");
        for (const l of listeners) l(name, "1.0.0", undefined, c.owner);
        await new Promise((r) => setTimeout(r, 50));
        assert.equal(policyReads, 1, "the listener did not apply it a second time");
        assert.equal(notices, 1);
        release();
        out["running"] = await running;
      });
      await c.tick();
      assert.equal(good(out["running"]!)["state"], "failed");
    } finally { svc.dispose(); }
  });

  suite("T02d close-out: a call running in one service is listed by another service on the same store (elsewhere), once, without its input; the record goes when the call ends; a record that cannot be written or read never stops the call", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    let started!: () => void; const hasStarted = new Promise<void>((r) => { started = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
    const deps = (runRecords: ConstructorParameters<typeof ToolExecutionService>[0]["runRecords"], run: ScriptRunner["run"]) => new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) }, assignments: c.assignments,
      catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, facts: async () => hostFacts, isLocalHost: () => true, revocationWatchMs: 0, ...(runRecords === undefined ? {} : { runRecords }), runner: { run },
    });
    const here = deps(RunningCallStore.withEpoch(c.storage, c.epoch), async () => { started(); await gate; return { text: '{"ok":true}', cpuMs: 1 }; });
    const there = deps(RunningCallStore.withEpoch(c.storage, c.epoch), async () => ({ text: '{"ok":true}' }));
    const broken = { begin: async () => { throw new Error("store down"); }, end: async () => { throw new Error("store down"); }, elsewhere: async () => { throw new Error("store down"); }, sweep: async () => { throw new Error("store down"); } };
    const fragile = deps(broken as never, async () => ({ text: '{"ok":true}', cpuMs: 1 }));
    const seen: Record<string, unknown> = {};
    const out: Record<string, BridgeResponse> = {};
    const until = async (ok: () => Promise<boolean>) => { const end = Date.now() + 3000; while (Date.now() < end && !(await ok())) await new Promise((r) => setTimeout(r, 10)); };
    try {
      c.worker.script = c.session(async (s) => {
        const name = await c.install(s, "slow", "1.0.0");
        const args = { tool: name, version: "1.0.0", input: { url: "u" } };
        await c.clear(s, args, "long-call");
        const running = here.handle(s.token, s.gateway, { op: "tool.invoke", callId: "long-call", args });
        await hasStarted;
        await until(async () => (await there.runningEverywhere(name, "1.0.0")).total === 1);
        seen["there"] = await there.runningEverywhere(name, "1.0.0");
        seen["here"] = await here.runningEverywhere(name, "1.0.0");
        seen["thereLocal"] = there.runningTotal(name, "1.0.0");
        // The record of this very call rewritten by another writer (a leftover replaced meanwhile): the service running it still lists it once, as its own.
        const ghost = RunningCallStore.withEpoch(c.storage, c.epoch);
        const ghostId = await ghost.begin({ name, version: "1.0.0", attemptId: s.attemptId, callId: "long-call", taskId: "tsk-x", agentId: ann.id, seconds: 30 });
        seen["hereWithGhost"] = (await here.runningEverywhere(name, "1.0.0")).total;
        release();
        out["running"] = await running;
        await ghost.end(ghostId!);
        await until(async () => (await there.runningEverywhere(name, "1.0.0")).total === 0);
        seen["thereAfter"] = (await there.runningEverywhere(name, "1.0.0")).total;
        seen["records"] = (await c.storage.listAggregates(RUNNING_CALL_KIND, { limit: 10 })).length;
        // A record that cannot be written or read: the call runs and answers as ever; the listing says the other processes could not be checked.
        await c.clear(s, args, "fragile-call");
        out["fragile"] = await fragile.handle(s.token, s.gateway, { op: "tool.invoke", callId: "fragile-call", args });
        seen["fragileList"] = await fragile.runningEverywhere(name, "1.0.0");
        seen["swept"] = await fragile.sweepRunRecords().catch(() => "threw");
        // Review: a record larger than one bounded look: what was read is listed and the rest is said to be unknown, never presented as everything.
        const away = { name, version: "1.0.0", attemptId: "att-away", callId: "call-away", taskId: "tsk-away", agentId: ann.id, startedAt: "2026-11-11T10:00:00.000Z", until: "2099-01-01T00:00:00.000Z" };
        const cutRecords = { begin: async () => undefined, end: async () => undefined, elsewhere: async () => ({ calls: [away], total: 1, incomplete: true as const }), sweep: async () => 0 };
        const cut = deps(cutRecords, async () => ({ text: '{"ok":true}' }));
        try { seen["cutList"] = await cut.runningEverywhere(name, "1.0.0"); } finally { cut.dispose(); }
        // Finish: a starting call also sweeps leftovers, at most once per interval, never waited for; off at 0 and at the default interval within a fresh service.
        let sweeps = 0;
        const counting = { begin: async () => undefined, end: async () => undefined, elsewhere: async () => ({ calls: [], total: 0 }), sweep: async () => { sweeps += 1; return 0; } };
        const swept = (ms: number | undefined) => new ToolExecutionService({
          principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: { get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) }, assignments: c.assignments,
          catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, desks: c.desks, facts: async () => hostFacts, isLocalHost: () => true, revocationWatchMs: 0, runRecords: counting, ...(ms === undefined ? {} : { runRecordSweepMs: ms }), runner: { run: async () => ({ text: '{"ok":true}' }) },
        });
        const callWith = async (svc: ToolExecutionService, id: string) => { await c.clear(s, args, id); return svc.handle(s.token, s.gateway, { op: "tool.invoke", callId: id, args }); };
        const def = swept(undefined), off = swept(0), often = swept(1);
        try {
          await callWith(def, "sw-default"); await callWith(off, "sw-off");
          seen["sweepsDefaultOff"] = sweeps;
          await new Promise((r) => setTimeout(r, 15));
          await callWith(often, "sw-1"); await until(async () => sweeps >= 1);
          seen["sweepsOften"] = sweeps;
          const before = sweeps;
          await callWith(often, "sw-2");
          await new Promise((r) => setTimeout(r, 15));
          await callWith(often, "sw-3"); await until(async () => sweeps > before);
          seen["sweepsAgain"] = sweeps > before;
          // Review: NaN and a negative interval turn it off (NaN used to sweep on every call).
          const nan = swept(Number.NaN), neg = swept(-5);
          try {
            const atBad = sweeps;
            await callWith(nan, "sw-nan-1"); await callWith(neg, "sw-neg-1");
            await new Promise((r) => setTimeout(r, 15));
            await callWith(nan, "sw-nan-2"); await callWith(neg, "sw-neg-2");
            await new Promise((r) => setTimeout(r, 15));
            seen["sweepsBad"] = sweeps - atBad;
          } finally { nan.dispose(); neg.dispose(); }
          // Review: a clock set back (the service was built while the clock read 30 minutes later) does not stop the sweep until the clock catches up again.
          const realNow = Date.now;
          let ahead: ToolExecutionService;
          Date.now = () => realNow() + 1_800_000;
          try { ahead = swept(600_000); } finally { Date.now = realNow; }
          try {
            const atBack = sweeps;
            await callWith(ahead, "sw-back"); await until(async () => sweeps > atBack);
            seen["sweepsClockBack"] = sweeps - atBack;
          } finally { ahead.dispose(); }
        } finally { def.dispose(); off.dispose(); often.dispose(); }
      });
      await c.tick();
      const there1 = seen["there"] as { calls: Record<string, unknown>[]; total: number };
      assert.equal(there1.total, 1, JSON.stringify(seen));
      assert.deepEqual(there1.calls[0], { attemptId: there1.calls[0]!["attemptId"], callId: "long-call", taskId: there1.calls[0]!["taskId"], agentId: ann.id, elsewhere: true }, "named by attempt, call, task and agent, never by its input");
      assert.equal(seen["thereLocal"], 0, "the other service runs nothing itself");
      const here1 = seen["here"] as { calls: Record<string, unknown>[]; total: number };
      assert.equal(here1.total, 1, "the service that runs it lists it once, as its own");
      assert.equal(here1.calls[0]!["elsewhere"], undefined);
      assert.equal(seen["hereWithGhost"], 1, "a record of a call running here, whoever wrote it, is not counted again");
      assert.equal(good(out["running"]!)["state"], "confirmed");
      assert.equal(seen["thereAfter"], 0, "the record goes when the call ends");
      assert.equal(seen["records"], 0);
      assert.equal(good(out["fragile"]!)["state"], "confirmed", "a record that cannot be written does not stop the call");
      assert.deepEqual(seen["fragileList"], { calls: [], total: 0, elsewhereUnknown: true });
      assert.equal(seen["sweepsDefaultOff"], 0, "the default interval (10 minutes) has not passed for a fresh service, and 0 turns the sweep off");
      assert.equal(seen["sweepsOften"], 1, "a call that starts after the interval sweeps once");
      assert.equal(seen["sweepsAgain"], true, "and again after the interval has passed again");
      assert.equal(seen["sweepsBad"], 0, "NaN and a negative interval turn the sweep off");
      assert.equal(seen["sweepsClockBack"], 1, "a clock set back counts as due: one sweep, not none until the clock catches up");
      assert.equal(seen["swept"], 0, "a sweep that cannot reach the store answers 0, never throws");
      assert.deepEqual(seen["cutList"], { calls: [{ attemptId: "att-away", callId: "call-away", taskId: "tsk-away", agentId: ann.id, elsewhere: true }], total: 1, elsewhereUnknown: true }, "a cut record is listed as far as it was read and said to be incomplete");
    } finally { here.dispose(); there.dispose(); fragile.dispose(); }
  });

  suite("the credential decides who is asking: another agent's, a wrong, an ended or another attempt's credential is refused; a caller cannot name a principal, actor, project or task", async (c) => {
    const ann = await c.agentFor("ann");
    const ben = await c.agentFor("ben");
    const t1 = await c.task("one", ann);
    await c.task("two", ben);
    const results: Record<string, BridgeResponse> = {};
    const tokens: Record<string, string> = {};
    const gateways: Record<string, BoundGateway> = {};
    // Both attempts are held until the second has started, so both credentials are live while the requests are made.
    const hold = deferred();
    c.worker.script = async ({ order, gateway }) => {
      tokens[order.agentId] = order.credential; gateways[order.agentId] = gateway;
      if (Object.keys(tokens).length === 2) {
        const call = (token: string, gw: BoundGateway, extra: Record<string, unknown> = {}) => c.svc.handle(token, gw, { op: "tool.discover", callId: uid("c"), args: {}, ...extra } as never);
        results["own"] = await call(tokens["agent:ann"]!, gateways["agent:ann"]!);
        results["others-token"] = await call(tokens["agent:ben"]!, gateways["agent:ann"]!);
        results["garbage"] = await call("tcr-nonsense.secret", gateways["agent:ann"]!);
        results["non-string"] = await call(undefined as never, gateways["agent:ann"]!);
        results["principal"] = await call(tokens["agent:ann"]!, gateways["agent:ann"]!, { principal: "owner:rob" });
        results["actor"] = await call(tokens["agent:ann"]!, gateways["agent:ann"]!, { actor: "owner:rob" });
        results["args-project"] = await c.svc.handle(tokens["agent:ann"]!, gateways["agent:ann"]!, { op: "desk.write", callId: uid("c"), args: { kind: "note", title: "x", body: "y", visibility: "shared", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } });
        results["unknown-op"] = await call(tokens["agent:ann"]!, gateways["agent:ann"]!, { op: "catalog.revoke" });
        results["admin"] = await call(tokens["agent:ann"]!, gateways["agent:ann"]!, { op: "grant.add" });
        hold.resolve();
      }
      await hold.promise;
      return { status: "completed", text: "x" };
    };
    await c.tick();
    assert.equal(good(results["own"]!)["revision"] !== undefined, true);
    for (const k of ["others-token", "garbage", "non-string"]) assert.equal(bad(results[k]!).code, "unauthenticated", k);
    for (const k of ["principal", "actor", "args-project", "unknown-op", "admin"]) assert.equal(bad(results[k]!).code, "invalid_command", k);
    void t1;
    // After the attempt ended its credential and gateway are worth nothing.
    const after = await c.svc.handle(tokens["agent:ann"]!, gateways["agent:ann"]!, { op: "tool.discover", callId: "late", args: {} });
    assert.ok(["unauthenticated", "fenced"].includes(bad(after).code));
  });

  suite("desk, task and message requests act as the credential's agent in the attempt's own project and task, with a command ID derived from the call", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const seen: { state: unknown[]; messages: unknown[] } = { state: [], messages: [] };
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (token: unknown, raw: unknown) => { if ((raw as { args: { title?: string } }).args.title === "refused") return { v: 1, op: "x", ok: false, error: { code: "stale_revision", message: "x" } } as never; if ((raw as { args: { note?: string } }).args.note === "long") return { v: 1, op: "x", ok: false, error: { code: "invalid_command", message: `work.end done was not accepted: the controller checked your work against the task contract and 1 item(s) did not pass.\n1. ${"y".repeat(1500)} END` } } as never; if ((raw as { args: { note?: string } }).args.note === "noreport") return { v: 1, op: "x", ok: false, error: { code: "invalid_command", message: `work.end needs a report: every ending carries a report.\nYour notes so far:\n${"n".repeat(1500)} END` } } as never; if ((raw as { args: { note?: string } }).args.note === "other") return { v: 1, op: "x", ok: false, error: { code: "invalid_command", message: `${"z".repeat(1500)} END` } } as never; seen.state.push({ token, raw }); return { v: 1, op: "x", ok: true, result: { done: true } } as never; } },
      messages: { send: async (by: unknown, command: unknown) => { seen.messages.push({ by: (by as { id: string }).id, command }); return { id: "m", replayed: false } as never; } }, isLocalHost: () => true,
      activity: async (step) => { steps.push(step); } });
    const steps: { commandId: string; taskId: string; kind: string; summary: string; refs: readonly { kind: string; id: string }[] }[] = [];
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = async ({ order, gateway }) => {
      const send = (op: string, args: JsonObject, callId: string) => svc.handle(order.credential, gateway, { op, callId, args });
      out["update"] = await send("task.update", { expectedRevision: 1, title: "New title", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "u1");
      out["update2"] = await send("task.update", { expectedRevision: 1, title: "New title" }, "u1");
      out["update-refused"] = await send("task.update", { expectedRevision: 9, title: "refused" }, "u9");
      out["transition"] = await send("task.transition", { expectedRevision: 2, to: "done" }, "t1");
      out["get"] = await send("task.get", {}, "g1");
      out["message"] = await send("message.send", { to: "agent:ben", class: "informational", purpose: "fyi", text: "hello", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "m1");
      out["message2"] = await send("message.send", { to: "agent:ben", class: "informational", purpose: "fyi", text: "hello" }, "m1");
      out["artifact"] = await send("artifact.publish", { name: "Findings", files: [{ path: "notes.md", text: "# n" }], taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "a1");
      out["artifact2"] = await send("artifact.publish", { name: "Findings", files: [{ path: "notes.md", text: "# n" }] }, "a1");
      const w = good(await send("desk.write", { kind: "note", title: "mine", body: "text", visibility: "shared", status: "accepted" }, "w1"));
      const again = good(await send("desk.write", { kind: "note", title: "mine", body: "text", visibility: "shared", status: "accepted" }, "w1"));
      out["write-again"] = { ok: true, result: { same: w["id"] === again["id"], replayed: again["replayed"] as boolean } };
      out["read"] = await send("desk.read", { recordId: w["id"] as string }, "r1");
      // Card W02: the agent ends its attempt through the bridge; the attempt is the one the request came through, never one it names.
      out["workend-named"] = await send("work.end", { attemptId: "att-other", result: "done" }, "we0");
      out["workend"] = await send("work.end", { result: "partial", note: "two beds left" }, "we1");
      // Card W05: a refused done carries the whole list of what failed; any other refusal is cut as before.
      out["workend-long"] = await send("work.end", { result: "done", note: "long", evidence: [{ item: "test log", path: "logs/t.txt" }] }, "we2");
      out["workend-other"] = await send("work.end", { result: "done", note: "other" }, "we3");
      // Card W10: an ending without a report is refused whole (it carries the agent's notes); notes and answers go through the API for the attempt the request came through.
      out["workend-noreport"] = await send("work.end", { result: "done", note: "noreport" }, "we4");
      out["note-named"] = await send("work.note", { kind: "did", text: "x", attemptId: "att-other" }, "wn0");
      out["note"] = await send("work.note", { kind: "did", text: "watered" }, "wn1");
      out["answer"] = await send("work.answer", { answers: ["north and south"] }, "wa1");
      // Card H12p: the agent's own refresh takes no argument; the attempt is the one the request came through, never one it names.
      out["refresh-named"] = await send("work.refresh", { attemptId: "att-other" }, "wr0");
      out["refresh"] = await send("work.refresh", {}, "wr1");
      // The step is best effort: an activity record that fails never changes the answer of the write.
      const failing = new ToolExecutionService({ principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks, isLocalHost: () => true, activity: async () => { throw new Error("activity down"); } });
      out["failing"] = await failing.handle(order.credential, gateway, { op: "desk.write", callId: "w9", args: { kind: "note", title: "still", body: "written", visibility: "shared", status: "accepted" } });
      failing.dispose();
      return { status: "completed", text: "x" };
    };
    await c.tick();
    assert.equal(typeof good(out["failing"]!)["id"], "string", "a failing activity record does not change the answer");
    assert.equal(bad(out["update"]!).code, "invalid_command", "a task ID from the caller is not accepted");
    good(out["update2"]!); good(out["transition"]!); good(out["get"]!);
    assert.equal(bad(out["update-refused"]!).code, "stale_revision", "a refusal answered by the API is passed on (and, below, is not a step)");
    assert.equal(bad(out["message"]!).code, "invalid_command");
    good(out["message2"]!);
    assert.equal(bad(out["artifact"]!).code, "invalid_command", "an artifact for a task the caller names is not accepted (the attempt's task is the one)");
    good(out["artifact2"]!);
    const calls = seen.state as { token: string; raw: { op: string; commandId?: string; args: { taskId: string; name?: string; files?: unknown } } }[];
    assert.deepEqual(calls.slice(0, 4).map((x) => [x.raw.op, x.raw.args.taskId]), [["task.update", taskId], ["task.transition", taskId], ["task.get", taskId], ["artifact.publish", taskId]]);
    assert.equal(bad(out["workend-named"]!).code, "invalid_command", "work.end names no attempt: it ends the one the request came through");
    good(out["workend"]!);
    assert.match(bad(out["workend-long"]!).message, / END$/, "a refused done is given whole");
    assert.equal(bad(out["workend-other"]!).message.length, 600, "another refusal is cut as before");
    assert.match(bad(out["workend-noreport"]!).message, / END$/, "an ending without a report is refused whole, with the notes");
    assert.equal(bad(out["note-named"]!).code, "invalid_command", "a note names no attempt");
    good(out["note"]!); good(out["answer"]!);
    assert.equal(bad(out["refresh-named"]!).code, "invalid_command", "work.refresh names no attempt");
    good(out["refresh"]!);
    const refreshing = calls.filter((x) => x.raw.op === "work.refresh");
    assert.equal(refreshing.length, 1, "only the call without a named attempt reached the API");
    assert.deepEqual(Object.keys(refreshing[0]!.raw.args as object), ["attemptId"], "nothing but the attempt the request came through");
    assert.match(refreshing[0]!.raw.commandId!, /^bridge:[^:]+:wr1$/);
    assert.equal(refreshing[0]!.token, calls[0]!.token, "with the attempt's own credential");
    const w10 = calls.filter((x) => x.raw.op === "work.note" || x.raw.op === "work.answer").map((x) => [x.raw.op, x.raw.commandId?.replace(/^bridge:[^:]+:/, "bridge:A:"), JSON.stringify({ ...x.raw.args, attemptId: "A" }), x.token === calls[0]!.token]);
    assert.deepEqual(w10, [["work.note", "bridge:A:wn1", JSON.stringify({ kind: "did", text: "watered", attemptId: "A" }), true], ["work.answer", "bridge:A:wa1", JSON.stringify({ answers: ["north and south"], attemptId: "A" }), true]]);
    const ending = calls.filter((x) => x.raw.op === "work.end");
    assert.equal(ending.length, 1);
    assert.deepEqual(ending[0]!.raw, { v: 1, op: "work.end", commandId: ending[0]!.raw.commandId, args: { result: "partial", note: "two beds left", attemptId: (ending[0]!.raw.args as unknown as { attemptId: string }).attemptId } });
    assert.match((ending[0]!.raw.args as unknown as { attemptId: string }).attemptId, /\S/);
    assert.match(ending[0]!.raw.commandId!, /^bridge:[^:]+:we1$/);
    assert.equal(ending[0]!.token, calls[0]!.token, "with the worker's own task credential");
    assert.deepEqual(calls[3]!.raw, { v: 1, op: "artifact.publish", commandId: calls[3]!.raw.commandId, args: { name: "Findings", files: [{ path: "notes.md", text: "# n" }], taskId } }, "the publication goes through the API as the worker's credential, for the attempt's own task");
    assert.match(calls[3]!.raw.commandId!, /^bridge:[^:]+:a1$/, "its command ID derives from the attempt and call, so asking again publishes once");
    assert.equal((calls[3] as { token: string }).token, calls[0]!.token, "with the worker's own task credential");
    assert.ok(calls[0]!.raw.commandId!.startsWith("bridge:"), "the command ID derives from the attempt and call");
    assert.equal(calls[2]!.raw.commandId, undefined, "a query takes none");
    assert.deepEqual((seen.messages[0] as { by: string; command: { taskId: string; commandId: string } }).by, "agent:ann");
    assert.equal((seen.messages[0] as { command: { taskId: string } }).command.taskId, taskId);
    assert.deepEqual(good(out["write-again"]!), { same: true, replayed: true }, "asking again with the call ID is the same write");
    assert.equal((good(out["read"]!)["record"] as { title: string }).title, "mine");
    // Card C09h: each write is a step of the task's activity, keyed by the attempt and call (the repeated desk write has the same key); refused requests, reads, and what other services record
    // (the artifact, the message) are not recorded here.
    const record = (good(out["read"]!)["record"] as { id: string }).id;
    assert.deepEqual(steps.map((s) => [s.kind, s.taskId, s.summary, s.refs]), [
      ["tool-call", taskId, `agent:ann changed the task's title or description through the bridge.`, [{ kind: "task", id: taskId }]],
      ["tool-call", taskId, `agent:ann moved the task through the bridge.`, [{ kind: "task", id: taskId }]],
      ["tool-call", taskId, `agent:ann wrote desk record ${record} through the bridge.`, [{ kind: "desk-record", id: record }]],
      ["tool-call", taskId, `agent:ann wrote desk record ${record} through the bridge.`, [{ kind: "desk-record", id: record }]],
    ]);
    assert.equal(steps[2]!.commandId, steps[3]!.commandId, "asking again is the same step");
    assert.equal(new Set(steps.map((s) => s.commandId)).size, 3);
  });

  suite("restart recovery: a call asked again after a controller restart keeps its version; a manifest that approves a restart runs it again, one that does not leaves it uncertain and never runs it twice; the worker cannot claim the flag", async (c) => {
    const ann = await c.agentFor("ann");
    const { attemptId } = await c.task("t", ann);
    const never = new Promise<never>(() => undefined);
    const started = deferred();
    let installed: { safe: string; unsafe: string } | undefined;
    const token = deferred<string>();
    const both = deferred();
    let open = 0;
    c.behave.run = async () => { started.resolve(); if (++open === 2) both.resolve(); return never; };
    c.worker.script = c.session(async (s) => {
      installed = { safe: await c.install(s, "safe", "1.0.0", { recovery: "restart" }, "// safe v1"), unsafe: await c.install(s, "risky", "1.0.0", { recovery: "none" }, "// risky v1") };
      token.resolve(s.token);
      // The turn hangs on the call: the controller process is restarted underneath it.
      await c.clear(s, { tool: installed.safe, input: { url: "a" } }, "call-safe");
      await c.clear(s, { tool: installed.unsafe, input: { url: "b" } }, "call-risky");
      void s.send("tool.invoke", { tool: installed.safe, input: { url: "a" } }, "call-safe");
      await started.promise;
      void s.send("tool.invoke", { tool: installed.unsafe, input: { url: "b" } }, "call-risky");
      await never;
    });
    await c.dispatcher.tick();
    await token.promise;
    await both.promise;
    assert.equal(c.runs.length, 2, "both calls started");
    // A newer version of the safe tool is published while the first process is gone.
    const second = c.restart({ replaySafe: c.svc.replaySafe });
    const svc2 = c.serviceOver(second);
    const gateway = second.gateway(attemptId!);
    c.behave.run = async () => ({ text: '{"ok":true}' });
    const doc = good(await svc2.handle(await token.promise, gateway, { op: "desk.write", callId: "w-doc", args: { kind: "note", title: "n", body: "n", visibility: "shared", status: "accepted" } }));
    const code = good(await svc2.handle(await token.promise, gateway, { op: "desk.write", callId: "w-code", args: { kind: "note", title: "c", body: "// safe v2", visibility: "shared", status: "accepted" } }));
    good(await svc2.handle(await token.promise, gateway, { op: "tool.register", callId: "r2", args: { name: "safe", kind: "tool", version: "1.1.0", manifest: manifest({ recovery: "restart" }), instructionsRecordId: doc["id"] as string, executableRecordId: code["id"] as string } }));
    const before = c.runs.length;
    const safe = good(await svc2.handle(await token.promise, gateway, { op: "tool.invoke", callId: "call-safe", args: { tool: installed!.safe, input: { url: "a" } } }));
    assert.equal(safe["state"], "confirmed");
    assert.equal(safe["version"], "1.0.0", "the call keeps the version it began with, not the 1.1.0 published since");
    assert.deepEqual(c.runs.slice(before).map((r) => r.source), ["// safe v1"]);
    const risky = good(await svc2.handle(await token.promise, gateway, { op: "tool.invoke", callId: "call-risky", args: { tool: installed!.unsafe, input: { url: "b" } } }));
    assert.equal(risky["state"], "uncertain", "a tool whose manifest does not approve a restart is not run again");
    assert.equal(c.runs.length, before + 1);
    // The flag is on the record, and it came from the manifest.
    const ops = (await c.storage.listAggregates(`tool-op-${attemptId}`, { limit: 10 })).map((a) => a.body as unknown as { callId: string; replaySafe?: boolean });
    assert.deepEqual(ops.map((o) => [o.callId, o.replaySafe === true]).sort(), [["call-risky", false], ["call-safe", true]]);
  });

  suite("the tool path refuses the same call ID with another version of the tool", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    let error: unknown;
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      const path = name.replace(/^a_/, "a-");
      await s.gateway.call({ callId: "same", tool: { name: path, version: "1.0.0" }, args: { url: "u" } }, { kind: "local", run: async () => ({ text: "x" }) }).catch(() => undefined);
      try { await s.gateway.call({ callId: "same", tool: { name: path, version: "1.1.0" }, args: { url: "u" } }, { kind: "local", run: async () => ({ text: "x" }) }); } catch (e) { error = e; }
    });
    await c.tick();
    assert.equal((error as { code?: string } | undefined)?.code, "command_conflict");
  });

  suite("W04: the worker may continue a turn only within the bound, only for its own running attempt, and each nudge is a step of the task's activity", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const steps: { summary: string; refs: readonly { kind: string; id: string }[] }[] = [];
    const svc = new ToolExecutionService({ principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks, isLocalHost: () => true, activity: async (step) => { steps.push(step); } });
    const out: Record<string, BridgeResponse> = {};
    let held: { token: string; gateway: Parameters<ToolExecutionService["handle"]>[1] } | undefined;
    c.worker.script = c.session(async (s) => {
      held = { token: s.token, gateway: s.gateway };
      const send = (args: JsonObject, callId: string) => svc.handle(s.token, s.gateway, { op: "turn.continue", callId, args });
      out["one"] = await send({ n: 1, max: 3, endKind: "empty-visible-text" }, "nudge:a:1");
      out["three"] = await send({ n: 3, max: 3, endKind: "length" }, "nudge:a:3");
      out["over"] = await send({ n: 4, max: 3 }, "nudge:a:4");
      out["bigMax"] = await send({ n: 1, max: 11 }, "nudge:b:1");
      out["zero"] = await send({ n: 0, max: 3 }, "nudge:b:0");
      out["normal"] = await send({ n: 1, max: 3, endKind: "normal" }, "nudge:c:1");
      out["extra"] = await send({ n: 1, max: 3, attemptId: "att-other" }, "nudge:d:1");
    });
    await c.tick();
    assert.deepEqual(good(out["one"]!), { go: true, n: 1, max: 3, endKind: "empty-visible-text" });
    good(out["three"]!);
    for (const k of ["over", "bigMax", "zero", "normal", "extra"]) assert.equal(bad(out[k]!).code, "invalid_command", k);
    assert.equal(steps.length, 2, "one step per nudge given, none for a refused one");
    assert.match(steps[0]!.summary, /^The turn of agent:ann.* was continued \(nudge 1 of 3\): it had ended as empty-visible-text, without a tool call or work\.end\.$/);
    assert.deepEqual(steps[0]!.refs, [{ kind: "task", id: taskId }]);
    // Once the attempt has ended, its worker cannot continue a turn.
    const after = await svc.handle(held!.token, held!.gateway, { op: "turn.continue", callId: "nudge:e:1", args: { n: 1, max: 3 } });
    assert.ok(["fenced", "unauthenticated"].includes(bad(after).code), JSON.stringify(after));
  });

  suite("W04 review: a turn that yields while a call of its attempt waits for an approval is not continued (it parks); once the call is decided and made, it may be", async (c) => {
    const ann = await c.agentFor("ann");
    await c.task("t", ann);
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      const input = { tool: name, input: { url: "https://example.org", depth: 2 } };
      assert.equal(good(await s.send("tool.invoke", input, "first-use"))["state"], "awaiting-approval");
      out["parked"] = await s.send("turn.continue", { n: 1, max: 3, endKind: "no-work-end" }, "nudge:p:1");
      await c.invoke(s, input, "first-use");
      out["after"] = await s.send("turn.continue", { n: 1, max: 3, endKind: "no-work-end" }, "nudge:p:1");
    });
    await c.tick();
    assert.equal(bad(out["parked"]!).code, "awaiting_approval");
    assert.deepEqual(good(out["after"]!), { go: true, n: 1, max: 3, endKind: "no-work-end" }, "the refused call ID may be asked again");
  });

  suite("W11: a turn that yields while a job of its task runs is not continued (it ends, and the task is woken when the job ends); once no job of the task runs, it may be", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const running = new Map<string, number>([[taskId, 1]]);
    const svc = new ToolExecutionService({ principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks, isLocalHost: () => true,
      jobs: { admit: async () => ({ id: "job-x", replayed: false }), get: async () => undefined, requestCancel: async () => ({ id: "job-x", operation: "stop_tool", replayed: false }) },
      jobRuns: { room: () => undefined, start: async () => undefined, ended: async () => undefined, runningFor: (t) => running.get(t) ?? 0 } });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const send = (args: JsonObject, callId: string) => svc.handle(s.token, s.gateway, { op: "turn.continue", callId, args });
      out["running"] = await send({ n: 1, max: 3, endKind: "no-work-end" }, "nudge:j:1");
      running.delete(taskId);
      out["ended"] = await send({ n: 1, max: 3, endKind: "no-work-end" }, "nudge:j:2");
    });
    await c.tick();
    const refusedJob = bad(out["running"]!);
    assert.equal(refusedJob.code, "awaiting_job");
    assert.match(refusedJob.message, /1 job\(s\) of this task are running; the turn ends, and the task is woken when a job ends/);
    assert.deepEqual(good(out["ended"]!), { go: true, n: 1, max: 3, endKind: "no-work-end" });
  });

  suite("a pause stops every write an agent makes through the bridge (desk, task, message, registration) and reads go on", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const touched: string[] = [];
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { touched.push((raw as { op: string }).op); return { v: 1, op: "x", ok: true, result: {} } as never; } },
      messages: { send: async () => { touched.push("message.send"); return { id: "m", replayed: false } as never; } }, isLocalHost: () => true,
      jobs: { admit: async () => { touched.push("job.admit"); return { id: "job-x", replayed: false }; }, get: async () => { touched.push("job.get"); return undefined; }, requestCancel: async () => { touched.push("job.cancel"); return { id: "job-x", operation: "stop_tool", replayed: false }; } }, jobRuns: { room: () => undefined, start: async () => { touched.push("job.run"); }, ended: async () => undefined } });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const send = (op: string, args: JsonObject, callId: string) => svc.handle(s.token, s.gateway, { op, callId, args });
      const doc = good(await send("desk.write", { kind: "note", title: "n", body: "b", visibility: "shared", status: "accepted" }, "w0"));
      await c.pauses.pause(c.owner, { commandId: uid("p"), scope: { kind: "task", id: taskId }, reason: "hold" });
      out["desk.write"] = await send("desk.write", { kind: "note", title: "n", body: "b2", visibility: "shared", status: "accepted" }, "w1");
      out["task.update"] = await send("task.update", { expectedRevision: 1, title: "x" }, "w2");
      out["task.transition"] = await send("task.transition", { expectedRevision: 1, to: "done" }, "w3");
      out["message.send"] = await send("message.send", { to: "agent:ben", class: "informational", purpose: "p", text: "t" }, "w4");
      out["artifact.publish"] = await send("artifact.publish", { name: "n", files: [{ path: "a.md", text: "a" }] }, "w7");
      out["tool.register"] = await send("tool.register", { name: "x", kind: "skill", version: "1.0.0", manifest: JSON.parse(JSON.stringify(manifest({ entryPoint: undefined, interpreter: undefined }))), instructionsRecordId: doc["id"] as string }, "w5");
      out["job.start"] = await send("job.start", { tool: "toolbox.build", input: {} }, "w8");
      out["maintenance.request"] = await send("maintenance.request", { kind: "skill", spec: { name: "notes", digest: `sha256:${"a".repeat(64)}` }, reason: "keep notes" }, "w10");
      // Card W04: a paused task's turn is not continued.
      out["turn.continue"] = await send("turn.continue", { n: 1, max: 3, endKind: "empty-visible-text" }, "nudge:1");
      // Card W10: nor are its notes and answers written.
      out["work.note"] = await send("work.note", { kind: "did", text: "x" }, "w11");
      out["work.answer"] = await send("work.answer", { answers: ["x"] }, "w12");
      // Card H12p: nor is the agent's own refresh made (it rewrites files of the checkout).
      out["work.refresh"] = await send("work.refresh", {}, "w13");
      // Reading a job and stopping one are not refused for a pause (here the job does not exist).
      out["job.status"] = await send("job.status", { jobId: "job-aaaaaaaaaaaaaaaaaaaa" }, "r4");
      out["desk.read"] = await send("desk.read", { recordId: doc["id"] as string }, "r1");
      out["task.get"] = await send("task.get", {}, "r2");
      out["discover"] = await send("tool.discover", {}, "r3");
      await c.pauses.resume(c.owner, { commandId: uid("rs"), scope: { kind: "task", id: taskId }, reason: "go" });
      out["after"] = await send("desk.write", { kind: "note", title: "n", body: "b3", visibility: "shared", status: "accepted" }, "w6");
      out["continue-after"] = await send("turn.continue", { n: 1, max: 3, endKind: "empty-visible-text" }, "nudge:1");
    });
    await c.tick();
    for (const op of ["desk.write", "task.update", "task.transition", "message.send", "artifact.publish", "tool.register", "job.start", "maintenance.request", "turn.continue", "work.note", "work.answer", "work.refresh"]) assert.equal(bad(out[op]!).code, "paused", op);
    for (const op of ["desk.read", "task.get", "discover", "after", "continue-after"]) good(out[op]!);
    assert.equal(bad(out["job.status"]!).code, "not_found");
    assert.deepEqual(touched, ["job.get", "task.get"], "no write reached a service while paused");
  });

  suite("task.recall (card W13): the attempt and so the task come from the credential, a named task is refused, a call is a read that a pause does not stop, the cap refuses with a clear text, an answered call is answered again for free, and the owner sees a counts-only step", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const reads: string[] = [];
    const steps: { commandId: string; taskId: string; summary: string }[] = [];
    let cap = 3, on = true;
    const anchor = { taskId, projectId: c.project, attemptId: "x", title: "Recall me" };
    const recall = new RecallService({
      settings: async () => ({ recall: on, recallCalls: cap }),
      read: async (attemptId) => { reads.push(attemptId); return { taskId, attemptId, anchor: { ...anchor, attemptId }, attempts: [], handoffs: [], archives: [], archive: async () => undefined }; },
    });
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      recall, isLocalHost: () => true, activity: async (step) => { steps.push(step); },
    });
    const bare = new ToolExecutionService({ principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, isLocalHost: () => true });
    const out: Record<string, BridgeResponse> = {};
    let attemptId = "";
    c.worker.script = c.session(async (s) => {
      attemptId = s.gateway.attemptId;
      const send = (args: JsonObject, callId: string) => svc.handle(s.token, s.gateway, { op: "task.recall", callId, args });
      out["first"] = await send({ part: "anchor" }, "rc1");
      out["again"] = await send({ part: "anchor" }, "rc1");
      for (const k of ["taskId", "projectId", "agentId", "attemptId"]) out[`named-${k}`] = await send({ part: "anchor", [k]: "tsk-zzzzzzzzzzzzzzzzzzzz" }, `rn-${k}`);
      out["forged"] = await svc.handle("nn_forged_credential", s.gateway, { op: "task.recall", callId: "rf", args: {} });
      out["bare"] = await bare.handle(s.token, s.gateway, { op: "task.recall", callId: "rb", args: {} });
      out["second"] = await send({ part: "activity" }, "rc2");
      // A pause refuses writes, not this read.
      await c.pauses.pause(c.owner, { commandId: uid("p"), scope: { kind: "task", id: taskId }, reason: "hold" });
      out["paused"] = await send({ part: "decisions" }, "rc3");
      out["limit"] = await send({ part: "anchor" }, "rc4");
      out["answered-after-cap"] = await send({ part: "decisions" }, "rc3");
      await c.pauses.resume(c.owner, { commandId: uid("rs"), scope: { kind: "task", id: taskId }, reason: "go" });
      on = false;
      out["off"] = await send({ part: "anchor" }, "rc5");
    });
    await c.tick();
    const first = good(out["first"]!);
    assert.equal(first["part"], "anchor");
    assert.match(first["text"] as string, /Goal: "Recall me"/);
    assert.deepEqual(good(out["again"]!), first, "the same call again gives the same answer");
    for (const k of ["taskId", "projectId", "agentId", "attemptId"]) assert.equal(bad(out[`named-${k}`]!).code, "invalid_command", k);
    assert.equal(bad(out["forged"]!).code, "unauthenticated");
    assert.equal(bad(out["bare"]!).code, "unavailable", "a controller without the tool says so");
    good(out["second"]!); good(out["paused"]!);
    const refused = bad(out["limit"]!);
    assert.equal(refused.code, "recall_limit");
    assert.match(refused.message, /used its 3 calls/);
    good(out["answered-after-cap"]!);
    assert.equal(bad(out["off"]!).code, "recall_off");
    assert.ok(reads.length > 0 && reads.every((r) => r === attemptId), "the attempt read is the one the credential is bound to");
    // The owner sees that it was used, by counts only: one step per answered call (not per repeat), none for a refusal, and no content.
    const recalls = steps.filter((x) => /task\.recall/.test(x.summary));
    // A repeat of a call has the same command ID, which the activity record keeps once.
    assert.equal(new Set(recalls.map((x) => x.commandId)).size, 3, JSON.stringify(recalls));
    assert.ok(recalls.every((x) => x.taskId === taskId && !/Recall me/.test(x.summary) && /\d+ characters/.test(x.summary)), JSON.stringify(recalls));
    svc.dispose(); bare.dispose();
  });

  suite("job-start under a used call ID answers the same job only for the same request, also after a restart that forgot the call IDs; job output, status and labels carry no control or invisible format characters (card T07b review)", async (c) => {
    const ann = await c.agentFor("ann", [{ action: "job.write", project: c.project }]);
    await c.task("t", ann);
    const host = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as never;
    const jobs = JobService.withEpoch(c.storage, c.epoch, { pauses: c.pauses }, { ...c.options, host: "service:dispatcher" });
    const started: string[] = [];
    // A service as a fresh controller builds it: same records, no memory of the call IDs used before.
    const fresh = (): ToolExecutionService => new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }), isLocalHost: () => true,
      jobs, jobRuns: { room: () => undefined, start: async (jobId: string) => { started.push(jobId); }, ended: async () => undefined } });
    let handle = "";
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      c.svc = fresh();
      const name = await c.install(s, "check", "1.0.0");
      const args = { tool: name, version: "1.0.0", input: { url: "https://a.test" }, label: "check a" };
      const first = good(await s.send("job.start", args, "j1"));
      assert.equal(first["state"], "awaiting-approval");
      const review = (await c.reviews.get(c.owner, first["reviewId"] as string))!;
      await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
      handle = good(await s.send("job.start", args, "j1"))["jobId"] as string;
      assert.match(handle, /^job-/);
      // The controller restarts: the same request under the same call ID is the same job, started once.
      c.svc = fresh();
      assert.equal(good(await s.send("job.start", args, "j1"))["jobId"], handle);
      // Another request under that call ID is refused after a restart too (different input, tool version left out but input changed, another label, background).
      for (const [key, other] of [["input", { ...args, input: { url: "https://b.test" } }], ["input-noversion", { tool: name, input: { url: "https://b.test" }, label: "check a" }], ["label", { ...args, label: "check b" }], ["background", { ...args, background: true }]] as const) {
        c.svc = fresh();
        out[key] = await s.send("job.start", other as JsonObject, "j1");
      }
      // A label with an invisible bidirectional override, a C1 control or a line separator is refused.
      for (const [i, label] of ["evil‮txt", "a\u0085b", "a b", "a​b"].entries()) out[`label-${i}`] = await s.send("job.start", { ...args, label }, `bad-label-${i}`);
      // The program writes invisible format characters, C1 controls and separators; it renames a process it leaves behind.
      await jobs.report(host, { commandId: uid("d"), jobId: handle, state: "dispatched" });
      await jobs.report(host, { commandId: uid("r"), jobId: handle, state: "running" });
      await jobs.report(host, { commandId: uid("o"), jobId: handle, output: "ok‮⁦gnp.exe⁩ \u0085next line​﻿ done\n" });
      out["output"] = await s.send("job.output", { jobId: handle }, "o1");
      await jobs.finish(host, { commandId: uid("f"), jobId: handle, outcome: "failed", exit: { reason: "it ended ‮badly" }, orphans: ["pid 9 (‮evil)"] });
      out["status"] = await s.send("job.status", { jobId: handle }, "st1");
    });
    await c.tick();
    assert.deepEqual(started, [handle], "one start for one job");
    for (const key of ["input", "input-noversion", "label", "background"]) { const b = bad(out[key]!); assert.equal(b.code, "invalid_command", key); assert.match(b.message, /different request/, key); }
    for (let i = 0; i < 4; i++) assert.equal(bad(out[`label-${i}`]!).code, "invalid_command");
    const text = JSON.parse(good(out["output"]!)["output"] as string) as string;
    assert.equal(text, "okgnp.exe nextline done\n");
    const status = good(out["status"]!);
    assert.deepEqual([(status["exit"] as JsonObject)["reason"], status["orphans"]], ["it ended badly", ["pid 9 (evil)"]]);
  });

  for (const mode of ["finish", "cancel"] as const) {
    suite(`a job of a tool version is one of its running calls until it ends: a revocation with policy ${mode} ${mode === "finish" ? "lists it and lets it run" : "lists it and stops it (a recorded Stop by the job host)"} (card T07b review 3)`, async (c) => {
      c.revocation.mode = mode;
      const ann = await c.agentFor("ann", [{ action: "job.write", project: c.project }]);
      await c.task("t", ann);
      const host = { id: "service:dispatcher", kind: "service", name: "dispatcher", grants: [] } as never;
      const jobs = JobService.withEpoch(c.storage, c.epoch, { pauses: c.pauses }, { ...c.options, host: "service:dispatcher" });
      const ends = new Map<string, () => void>();
      const svc = new ToolExecutionService({
        principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
        facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }), isLocalHost: () => true, revocationPolicy: () => (mode === "finish" ? "finish" : "cancel"),
        jobs, jobRuns: { room: () => undefined, start: async (jobId: string) => { await jobs.report(host, { commandId: uid("d"), jobId, state: "dispatched" }); await jobs.report(host, { commandId: uid("r"), jobId, state: "running" }); }, ended: (jobId: string) => new Promise<void>((resolve) => { ends.set(jobId, resolve); }) } });
      let handle = "", name = "";
      const listed: number[] = [];
      c.worker.script = c.session(async (s) => {
        c.svc = svc;
        name = await c.install(s, "slow", "1.0.0");
        const args = { tool: name, version: "1.0.0", input: { url: "https://a.test" } };
        const first = good(await s.send("job.start", args, "j1"));
        assert.equal(first["state"], "awaiting-approval");
        const review = (await c.reviews.get(c.owner, first["reviewId"] as string))!;
        await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
        handle = good(await s.send("job.start", args, "j1"))["jobId"] as string;
        listed.push(svc.runningTotal(name, "1.0.0"));
        await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad" });
        await new Promise((r) => setTimeout(r, 50));
        // The job's end is recorded: it is no longer a running call of the version.
        ends.get(handle)!();
        await new Promise((r) => setTimeout(r, 10));
        listed.push(svc.runningTotal(name, "1.0.0"));
      });
      await c.tick();
      assert.match(handle, /^job-/);
      assert.deepEqual(listed, [1, 0], "listed while it runs, forgotten once it has ended");
      const job = (await jobs.get(c.owner, handle))!;
      if (mode === "finish") assert.equal(job.state, "running", "a revocation that lets running calls finish leaves the job alone");
      else assert.deepEqual([job.state, job.cancel?.requestedBy, job.cancel?.reason], ["cancellation_requested", "service:dispatcher", `${name} 1.0.0 was revoked while the job ran`]);
    });
  }

  suite("job-start is refused for a version revoked before it, and for one revoked between the owner's approval and the start (nothing is admitted or started); an attempt that has ended can neither start nor stop a job (card T07b review 4)", async (c) => {
    const ann = await c.agentFor("ann", [{ action: "job.write", project: c.project }]);
    await c.task("t", ann);
    const jobs = JobService.withEpoch(c.storage, c.epoch, { pauses: c.pauses }, { ...c.options, host: "service:dispatcher" });
    const started: string[] = [];
    const admitted: string[] = [];
    c.svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      facts: async () => ({ os: "linux", arch: "x64", interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 }), isLocalHost: () => true,
      jobs: { admit: async (...a: Parameters<JobService["admit"]>) => { const j = await jobs.admit(...a); admitted.push(j.id); return j; }, get: (...a: Parameters<JobService["get"]>) => jobs.get(...a), requestCancel: (...a: Parameters<JobService["requestCancel"]>) => jobs.requestCancel(...a) },
      jobRuns: { room: () => undefined, start: async (jobId: string) => { started.push(jobId); }, ended: async () => undefined } });
    const out: Record<string, BridgeResponse> = {};
    let late: { token: string; gateway: BoundGateway } | undefined;
    let running = "";
    c.worker.script = c.session(async (s) => {
      late = { token: s.token, gateway: s.gateway };
      // Revoked before the start is asked.
      const gone = await c.install(s, "gone", "1.0.0");
      await c.catalog.revoke(c.owner, { commandId: uid("rv"), name: gone, version: "1.0.0", reason: "bad" });
      out["revoked-before"] = await s.send("job.start", { tool: gone, version: "1.0.0", input: { url: "https://a.test" } }, "j-gone");
      // Approved, then revoked before the agent asks again: the start is refused (a choice about running calls is not about one that has not started).
      const late1 = await c.install(s, "late", "1.0.0");
      const args = { tool: late1, version: "1.0.0", input: { url: "https://a.test" } };
      const first = good(await s.send("job.start", args, "j-late"));
      assert.equal(first["state"], "awaiting-approval");
      const review = (await c.reviews.get(c.owner, first["reviewId"] as string))!;
      await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "fine" });
      await c.catalog.revoke(c.owner, { commandId: uid("rv"), name: late1, version: "1.0.0", reason: "bad" });
      out["revoked-after-approval"] = await s.send("job.start", args, "j-late");
      // One job that does start, for the ended attempt to try to stop.
      const ok = await c.install(s, "fine", "1.0.0");
      const okArgs = { tool: ok, version: "1.0.0", input: { url: "https://a.test" } };
      const asked = good(await s.send("job.start", okArgs, "j-ok"));
      const okReview = (await c.reviews.get(c.owner, asked["reviewId"] as string))!;
      await c.reviews.decide(c.owner, { commandId: uid("dec"), requestId: okReview.id, expectedRevision: okReview.revision, verdict: "allow", reason: "fine" });
      running = good(await s.send("job.start", okArgs, "j-ok"))["jobId"] as string;
    });
    await c.tick();
    assert.equal(bad(out["revoked-before"]!).code, "forbidden");
    assert.match(bad(out["revoked-before"]!).message, /revoked/);
    const refused = out["revoked-after-approval"]!;
    // Refused either before the dispatcher's tool path or by the run's own check at the start: in both cases nothing is admitted or started.
    assert.ok(!refused.ok || (refused.result["state"] !== "confirmed" && refused.result["jobId"] === undefined), JSON.stringify(refused));
    assert.match(running, /^job-/);
    assert.deepEqual([admitted, started], [[running], [running]], "only the job of the live version was admitted and started");
    // The attempt has ended: its credential and gateway start and stop nothing.
    const afterStart = await c.svc.handle(late!.token, late!.gateway, { op: "job.start", callId: "after-end", args: { tool: "anything", input: {} } });
    const afterStop = await c.svc.handle(late!.token, late!.gateway, { op: "job.cancel", callId: "after-end-stop", args: { jobId: running } });
    for (const r of [afterStart, afterStop]) assert.ok(["unauthenticated", "fenced"].includes(bad(r).code), JSON.stringify(r));
    assert.deepEqual([admitted.length, started.length, (await jobs.get(c.owner, running))!.state], [1, 1, "admitted"]);
  });

  suite("registering a tool under a contract that restricts tools is allowed, but running it is still governed by the contract's ceiling", async (c) => {
    const ann = await c.agentFor("ann", [{ action: "tool.read-file", project: c.project }]);
    const { taskId } = await c.task("t", ann);
    await c.contracts.setContract(c.owner, { commandId: uid("ct"), taskId, expectedVersion: 0, permissions: ["tool.read-file"] });
    let first: JsonObject | undefined;
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0");
      first = good(await s.send("tool.invoke", { tool: name, input: { url: "u" } }, "beyond"));
    });
    await c.tick();
    assert.equal(first!["state"], "awaiting-approval");
    assert.match(first!["reason"] as string, /beyond the task contract's permission ceiling/);
    assert.equal(c.runs.length, 0);
  });

  suite("the replay-safe flag is given only to calls the bridge made: a direct gateway call naming a catalogue tool gets none; an ended call is answered from its record after the version is revoked", async (c) => {
    const ann = await c.agentFor("ann");
    const { attemptId } = await c.task("t", ann);
    let again: JsonObject | undefined;
    c.worker.script = c.session(async (s) => {
      const name = await c.install(s, "check", "1.0.0", { recovery: "restart" });
      const path = name.replace(/^a_/, "a-");
      await s.gateway.call({ callId: "direct", tool: { name: path, version: "1.0.0", kind: "catalog" }, args: { url: "u" } }, { kind: "local", run: async () => ({ text: "{}" }) });
      const viaBridge = await c.invoke(s, { tool: name, input: { url: "u" } }, "bridge-call");
      assert.equal(good(viaBridge)["state"], "confirmed");
      await c.catalog.revoke(c.owner, { commandId: uid("rv"), name, version: "1.0.0", reason: "bad" });
      again = good(await s.send("tool.invoke", { tool: name, input: { url: "u" } }, "bridge-call"));
    });
    await c.tick();
    const ops = (await c.storage.listAggregates(`tool-op-${attemptId}`, { limit: 10 })).map((a) => a.body as unknown as { callId: string; replaySafe?: boolean });
    assert.equal(ops.find((o) => o.callId === "direct")!.replaySafe, undefined);
    assert.equal(ops.find((o) => o.callId === "bridge-call")!.replaySafe, true);
    assert.equal(again!["state"], "confirmed", "what was done stays recorded as done");
    assert.equal(c.runs.length, 1);
    assert.equal(c.runs[0]!.maxOutputBytes, 64 * 1024);
  });

  suite("discover pages without losing names and filters by query; describe is refused for a tool the agent may not see", async (c) => {
    const ann = await c.agentFor("ann");
    const ben = await c.agentFor("ben");
    await c.task("one", ann);
    await c.task("two", ben);
    const seen: Record<string, BridgeResponse | JsonObject[]> = {};
    const names: string[] = [];
    const hold = deferred();
    const sessions: Session[] = [];
    c.worker.script = c.session(async (s) => {
      sessions.push(s);
      if (s === sessions[0]) {
        for (const nm of ["alpha", "beta", "gamma"]) names.push(await c.install(s, nm, "1.0.0"));
        hold.resolve();
        const pages: JsonObject[] = [];
        for (let after: string | undefined; ;) {
          const page = good(await s.send("tool.discover", { limit: 1, ...(after === undefined ? {} : { after }) }));
          pages.push(page);
          after = page["next"] as string | undefined;
          if (after === undefined) break;
        }
        seen["pages"] = pages;
        seen["query"] = await s.send("tool.discover", { query: "gam" });
        seen["too-many"] = await s.send("tool.discover", { limit: 1000 });
      } else {
        // The second agent sees none of the first one's personal tools.
        await hold.promise;
        seen["ben"] = await s.send("tool.discover");
        seen["ben-describe"] = await s.send("tool.describe", { tool: names[0]! });
      }
    });
    await c.tick();
    const pages = seen["pages"] as JsonObject[];
    assert.deepEqual(pages.map((p) => (p["tools"] as { name: string }[])[0]!.name), [...names].sort());
    assert.equal(pages[pages.length - 1]!["next"], undefined);
    assert.deepEqual((good(seen["query"] as BridgeResponse)["tools"] as { name: string }[]).map((t) => t.name), [names[2]]);
    assert.equal(bad(seen["too-many"] as BridgeResponse).code, "invalid_command");
    assert.deepEqual(good(seen["ben"] as BridgeResponse)["tools"], []);
    assert.equal(bad(seen["ben-describe"] as BridgeResponse).code, "not_found");
  });
}

test("the schema checker enforces the keywords a tool needs and refuses a schema it cannot enforce", () => {
  const schema = { type: "object", properties: { a: { type: "integer", minimum: 1 }, b: { enum: ["x", "y"] }, c: { type: "array", items: { type: "string" }, maxItems: 2 }, d: { anyOf: [{ type: "string" }, { type: "null" }] }, e: { $ref: "#/$defs/e" } }, required: ["a"], additionalProperties: false, $defs: { e: { type: "boolean" } } };
  assert.deepEqual(checkValue(schema, { a: 2, b: "x", c: ["q"], d: null, e: true }), []);
  for (const [value, text] of [[{}, /missing "a"/], [{ a: 0 }, /at least 1/], [{ a: 1.5 }, /integer/], [{ a: 1, b: "z" }, /allowed values/], [{ a: 1, c: [1] }, /string/], [{ a: 1, c: ["a", "b", "c"] }, /at most 2/], [{ a: 1, d: 3 }, /none of the allowed/], [{ a: 1, e: "no" }, /boolean/], [{ a: 1, z: 1 }, /does not take/], ["str", /object/]] as const) {
    const problems = checkValue(schema as never, value);
    assert.ok(problems.some((p) => text.test(p)), `${JSON.stringify(value)}: ${problems.join("; ")}`);
  }
  assert.ok(schemaProblems({ type: "string", pattern: "x" }).length > 0);
  assert.ok(schemaProblems({ $ref: "https://elsewhere/x" }).length > 0);
  assert.ok(schemaProblems({ type: "banana" }).length > 0);
  assert.ok(checkValue({ $ref: "#" } as never, 1).some((p) => /too large/.test(p)), "a self-reference ends with a problem, not a hang");
  assert.ok(checkValue({ allOf: [{ $ref: "#" }] } as never, 1).length > 0, "a loop through a reference is bounded, not followed forever");
});

test("the schema checker never fails open: an exhausted check is a refusal inside not/oneOf too, and a schema whose keyword values or references are not schemas is refused", () => {
  const big = Array.from({ length: 25_000 }, (_, i) => i);
  const not = { type: "object", not: { properties: { a: { items: { type: "integer" } } } } };
  assert.ok(checkValue(not as never, { a: [1, 2] }).length > 0, "the forbidden shape is refused");
  assert.ok(checkValue(not as never, { a: big }).length > 0, "a value too large to check is refused, not taken as not matching");
  const one = { type: "object", oneOf: [{ properties: { a: { items: { type: "string" } } } }, { required: ["zzz"] }] };
  assert.ok(checkValue(one as never, { a: big }).some((p) => /too large/.test(p)));
  assert.ok(checkValue({ type: "object", properties: { a: { items: { type: "integer" } } } } as never, { a: big }).some((p) => /too large/.test(p)));
  for (const schema of [
    { $ref: "#/properties/x/type", properties: { x: { type: "string" } } }, { $ref: "#/properties/constructor" }, { $ref: "#/__proto__" }, { $ref: "#/enum/5", enum: [1] },
    { required: "a" }, { required: [1] }, { additionalProperties: "false" }, { items: 5 }, { items: [{ type: "string" }] }, { properties: [] }, { enum: "a" }, { minItems: -1 }, { maxLength: 1.5 }, { minimum: "1" },
    { multipleOf: 0 }, { anyOf: [] }, { anyOf: "x" }, { oneOf: [1] }, { not: 3 }, { $defs: [] },
  ]) assert.ok(schemaProblems(schema as never).length > 0, JSON.stringify(schema));
  assert.deepEqual(schemaProblems({ type: "object", properties: { x: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } } as never), []);
  assert.ok(checkValue({ type: "object", properties: { x: { $ref: "#/$defs/n" } }, $defs: { n: { type: "integer" } } } as never, { x: "no" }).length > 0);
  // A refusal always says something.
  assert.ok(checkValue({ not: {} } as never, 1).length > 0);
});
