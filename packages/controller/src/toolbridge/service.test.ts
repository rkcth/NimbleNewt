import assert from "node:assert/strict";
import { after, test } from "node:test";
import { CatalogService, personalNamespace } from "../catalog/index.js";
import { DeskService } from "../context/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { DispatcherService } from "../dispatch/dispatcher.js";
import { buildWorld, workGrants, type DispatchWorld, type WorkerScript } from "../dispatch/testing/world.js";
import type { Grant } from "../security/index.js";
import type { JsonObject } from "../storage/types.js";
import { launchOf, ToolExecutionService, type BoundGateway, type BridgeResponse, type ScriptLaunch, type ScriptRunner } from "./service.js";
import { checkValue, schemaProblems } from "./schema.js";

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
        let failure: unknown;
        const behave: Ctx["behave"] = { run: async () => ({ text: '{"ok":true}', cpuMs: 5 }) };
        const runner: ScriptRunner = { run: async (launch, signal) => { runs.push(launch); return behave.run(launch, signal); } };
        const hostFacts = { os: "linux" as const, arch: "x64" as const, interpreters: { node: "22.19.0" }, packages: {}, cpus: 8, memoryMb: 16_384 };
        const serviceOver = (dispatcher: DispatcherService, facts?: false): ToolExecutionService =>
          new ToolExecutionService({ principal: w.dispatcherPrincipal, credentials: w.credentials, dispatch: dispatcher, assignments: w.assignments, catalog, hosts: w.hosts, admission: w.admission, runner, pauses: w.pauses, desks, revocationPolicy: () => { if (c.revocation.mode === "broken") throw new Error("setting unreadable"); return c.revocation.mode; }, ...(facts === false ? {} : { facts: async () => hostFacts }), isLocalHost: () => true });
        const svc = serviceOver({ get: (...a: Parameters<DispatcherService["get"]>) => c.dispatcher.get(...a), toolOperation: (...a: Parameters<DispatcherService["toolOperation"]>) => c.dispatcher.toolOperation(...a) } as never);
        const c: Ctx = Object.assign(w, {
          desks, catalog, svc, runs, behave, serviceOver, revocation: { mode: "finish" as "finish" | "cancel" | "broken" },
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
      state: { handle: async (token: unknown, raw: unknown) => { seen.state.push({ token, raw }); return { v: 1, op: "x", ok: true, result: { done: true } } as never; } },
      messages: { send: async (by: unknown, command: unknown) => { seen.messages.push({ by: (by as { id: string }).id, command }); return { id: "m", replayed: false } as never; } }, isLocalHost: () => true });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = async ({ order, gateway }) => {
      const send = (op: string, args: JsonObject, callId: string) => svc.handle(order.credential, gateway, { op, callId, args });
      out["update"] = await send("task.update", { expectedRevision: 1, title: "New title", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "u1");
      out["update2"] = await send("task.update", { expectedRevision: 1, title: "New title" }, "u1");
      out["transition"] = await send("task.transition", { expectedRevision: 2, to: "done" }, "t1");
      out["get"] = await send("task.get", {}, "g1");
      out["message"] = await send("message.send", { to: "agent:ben", class: "informational", purpose: "fyi", text: "hello", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }, "m1");
      out["message2"] = await send("message.send", { to: "agent:ben", class: "informational", purpose: "fyi", text: "hello" }, "m1");
      const w = good(await send("desk.write", { kind: "note", title: "mine", body: "text", visibility: "shared", status: "accepted" }, "w1"));
      const again = good(await send("desk.write", { kind: "note", title: "mine", body: "text", visibility: "shared", status: "accepted" }, "w1"));
      out["write-again"] = { ok: true, result: { same: w["id"] === again["id"], replayed: again["replayed"] as boolean } };
      out["read"] = await send("desk.read", { recordId: w["id"] as string }, "r1");
      return { status: "completed", text: "x" };
    };
    await c.tick();
    assert.equal(bad(out["update"]!).code, "invalid_command", "a task ID from the caller is not accepted");
    good(out["update2"]!); good(out["transition"]!); good(out["get"]!);
    assert.equal(bad(out["message"]!).code, "invalid_command");
    good(out["message2"]!);
    const calls = seen.state as { token: string; raw: { op: string; commandId?: string; args: { taskId: string } } }[];
    assert.deepEqual(calls.map((x) => [x.raw.op, x.raw.args.taskId]), [["task.update", taskId], ["task.transition", taskId], ["task.get", taskId]]);
    assert.ok(calls[0]!.raw.commandId!.startsWith("bridge:"), "the command ID derives from the attempt and call");
    assert.equal(calls[2]!.raw.commandId, undefined, "a query takes none");
    assert.deepEqual((seen.messages[0] as { by: string; command: { taskId: string; commandId: string } }).by, "agent:ann");
    assert.equal((seen.messages[0] as { command: { taskId: string } }).command.taskId, taskId);
    assert.deepEqual(good(out["write-again"]!), { same: true, replayed: true }, "asking again with the call ID is the same write");
    assert.equal((good(out["read"]!)["record"] as { title: string }).title, "mine");
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

  suite("a pause stops every write an agent makes through the bridge (desk, task, message, registration) and reads go on", async (c) => {
    const ann = await c.agentFor("ann");
    const { taskId } = await c.task("t", ann);
    const touched: string[] = [];
    const svc = new ToolExecutionService({
      principal: c.dispatcherPrincipal, credentials: c.credentials, dispatch: c.dispatcher, assignments: c.assignments, catalog: c.catalog, hosts: c.hosts, admission: c.admission, pauses: c.pauses, runner: { run: async () => ({ text: "{}" }) }, desks: c.desks,
      state: { handle: async (_t: unknown, raw: unknown) => { touched.push((raw as { op: string }).op); return { v: 1, op: "x", ok: true, result: {} } as never; } },
      messages: { send: async () => { touched.push("message.send"); return { id: "m", replayed: false } as never; } }, isLocalHost: () => true });
    const out: Record<string, BridgeResponse> = {};
    c.worker.script = c.session(async (s) => {
      const send = (op: string, args: JsonObject, callId: string) => svc.handle(s.token, s.gateway, { op, callId, args });
      const doc = good(await send("desk.write", { kind: "note", title: "n", body: "b", visibility: "shared", status: "accepted" }, "w0"));
      await c.pauses.pause(c.owner, { commandId: uid("p"), scope: { kind: "task", id: taskId }, reason: "hold" });
      out["desk.write"] = await send("desk.write", { kind: "note", title: "n", body: "b2", visibility: "shared", status: "accepted" }, "w1");
      out["task.update"] = await send("task.update", { expectedRevision: 1, title: "x" }, "w2");
      out["task.transition"] = await send("task.transition", { expectedRevision: 1, to: "done" }, "w3");
      out["message.send"] = await send("message.send", { to: "agent:ben", class: "informational", purpose: "p", text: "t" }, "w4");
      out["tool.register"] = await send("tool.register", { name: "x", kind: "skill", version: "1.0.0", manifest: JSON.parse(JSON.stringify(manifest({ entryPoint: undefined, interpreter: undefined }))), instructionsRecordId: doc["id"] as string }, "w5");
      out["desk.read"] = await send("desk.read", { recordId: doc["id"] as string }, "r1");
      out["task.get"] = await send("task.get", {}, "r2");
      out["discover"] = await send("tool.discover", {}, "r3");
      await c.pauses.resume(c.owner, { commandId: uid("rs"), scope: { kind: "task", id: taskId }, reason: "go" });
      out["after"] = await send("desk.write", { kind: "note", title: "n", body: "b3", visibility: "shared", status: "accepted" }, "w6");
    });
    await c.tick();
    for (const op of ["desk.write", "task.update", "task.transition", "message.send", "tool.register"]) assert.equal(bad(out[op]!).code, "paused", op);
    for (const op of ["desk.read", "task.get", "discover", "after"]) good(out[op]!);
    assert.deepEqual(touched, ["task.get"], "no write reached a service while paused");
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
