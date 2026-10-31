import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { JsonObject } from "../storage/types.js";
import { LocalWorker, catalogFacts, type AttemptRuntime, type BoundCall, type RuntimeFactory, type SandboxPort } from "./local-worker.js";
import { operationKind, type ToolOperationBody } from "./model.js";
import type { RecipeSummary, ToolGateway, WorkOrder, WorkerHandle, WorkerHost } from "./ports.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";

after(stopServer);

const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: ["python@3.12", "pkg:numpy@2.1"], workspaces: [] };

for (const backend of backends) {
  const setup = async (o: { sandbox?: SandboxPort; runtime?: (order: WorkOrder, call: BoundCall, from: JsonObject | undefined, log: string[]) => AttemptRuntime; schedule?: (beat: () => Promise<void>) => () => void } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    const log: string[] = [];
    const sandbox: SandboxPort = o.sandbox ?? { open: async (recipe: RecipeSummary) => { log.push(`sandbox open ${recipe.revision}`); return { revision: recipe.revision, close: async () => { log.push(`sandbox close ${recipe.revision}`); } }; } };
    const runtimes: RuntimeFactory = {
      open: async (order, call, from) => {
        log.push(`runtime open${from === undefined ? "" : ` from ${JSON.stringify(from)}`}`);
        return (o.runtime ?? ((_o, c) => ({
          run: async () => { const r = await c({ callId: "c1", tool: { name: "read-file", version: "1" }, args: { path: "a" } }, { kind: "local", run: async () => ({ text: "contents" }) }); return { status: "completed", text: r.state }; },
          checkpoint: async () => ({ saved: true }), close: async () => { log.push("runtime close"); },
        })))(order, call, from, log);
      },
    };
    const local = new LocalWorker({ hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "local-2.0.0", sandbox, runtimes, capabilities: () => CAPS, ...(o.schedule === undefined ? {} : { schedule: o.schedule }) });
    await local.register(w.hosts, self);
    const d = w.restart({ workers: [local] });
    return { store, w, local, self, d, log };
  };
  const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => {
    await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); return true; });
  };
  const ops = async (w: DispatchWorld, attemptId: string) => (await w.storage.listAggregates(operationKind(attemptId), { limit: 50 })).map((a) => a.body as unknown as ToolOperationBody);

  test(`${backend.name}: the local worker reports what its sandboxes still hold for Stop, also after the attempt ended, and asks only about attempts it started; a sandbox that cannot say contributes nothing (card L02d)`, async () => {
    let closed = false;
    let fail = false;
    const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => ({ revision: recipe.revision, close: async () => { closed = true; }, work: async () => { if (fail) throw new Error("backend down"); return { processes: closed ? [{ ref: "pid-9 (left behind)", kind: "process" as const, state: "uncooperative" as const }] : [], costMicros: 250, computeMs: 40 }; } }) };
    const { store, w, local, d } = await setup({ sandbox });
    try {
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      const { attemptId } = await w.task("t", ann);
      await d.tick();
      await d.idle();
      assert.equal(closed, true, "the attempt ended and its sandbox was closed");
      assert.deepEqual(await local.localWork([attemptId!, "att-unknownunknownunkn"]), { processes: [{ attemptId: attemptId!, ref: "pid-9 (left behind)", kind: "process", state: "uncooperative" }], costs: [{ attemptId: attemptId!, costMicros: 250, computeMs: 40 }], known: [attemptId!] });
      // The dispatcher aggregates it for staff only, and a host that fails fails the look.
      const got = await d.localWorkOf(w.owner, [attemptId!]);
      assert.deepEqual(got.costs, [{ attemptId: attemptId!, costMicros: 250, computeMs: 40 }]);
      await assert.rejects(d.localWorkOf(await w.agent("bob", workGrants(w.project, ["read-file"])) as never, [attemptId!]), /may not ask/);
      fail = true;
      await assert.rejects(d.localWorkOf(w.owner, [attemptId!]), /backend down/);
    } finally { await store.close(); }
  });

  test(`${backend.name}: an attempt whose sandbox still holds a process counts as busy for a workspace operation, though no call is in flight, and a sandbox that cannot say makes the look fail (card H12q review)`, async () => {
    let closed = false;
    let fail = false;
    const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => ({ revision: recipe.revision, close: async () => { closed = true; }, work: async () => { if (fail) throw new Error("backend down"); return { processes: closed ? [{ ref: "pid-9 (writing)", kind: "process" as const, state: "running" as const }] : [] }; } }) };
    const { store, w, local, d } = await setup({ sandbox });
    try {
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      const { attemptId } = await w.task("t", ann);
      await d.tick();
      await d.idle();
      assert.deepEqual(await local.busyAttempts(), [attemptId!], "no call is in flight, but a process of the attempt is still running in its sandbox");
      fail = true;
      await assert.rejects(local.busyAttempts(), /backend down/);
    } finally { await store.close(); }
  });

  test(`${backend.name}: the local worker registers from its own facts, runs an attempt in a sandbox with every call through the gateway, and closes both`, async () => {
    const { store, w, local, self, d, log } = await setup();
    try {
      const status = (await w.hosts.status(w.owner, "host:local"))!;
      assert.deepEqual(status.capabilities, CAPS);
      assert.equal(status.freshness, "fresh");
      const other = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:w1")).token);
      await refuses("forbidden", () => local.register(w.hosts, other));
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      const { attemptId } = await w.task("t", ann);
      const report = await d.tick();
      await d.idle();
      assert.deepEqual(report.started, [attemptId]);
      assert.deepEqual(log, ["sandbox open r-" + attemptId!.slice(4, 16), "runtime open", "runtime close", "sandbox close r-" + attemptId!.slice(4, 16)]);
      assert.equal((await d.get(w.owner, attemptId!))!.workerVersion, "local-2.0.0");
      assert.deepEqual((await ops(w, attemptId!)).map((o) => o.state), ["confirmed"]);
      await local.beat(w.hosts, self);
    } finally { await store.close(); }
  });

  test(`${backend.name}: with no sandbox the attempt does not start unconfined: the start fails, the attempt ends failed and a blocker says so`, async () => {
    const { store, w, d } = await setup({ sandbox: { open: async () => { throw new DomainError("unavailable", "no confinement on this host"); } } });
    try {
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId } = await w.task("t", ann);
      const report = await d.tick();
      assert.equal(report.started.length, 0);
      assert.equal((await w.assignments.getAttempt(attemptId!))!.state, "failed");
      assert.match((await d.get(w.owner, attemptId!))!.outcome!.summary, /no confinement/);
    } finally { await store.close(); }
  });

  test(`${backend.name}: a scheduler the composer injects beats the lease while the turn runs; a recipe change restarts the sandbox and the runtime from the checkpoint`, async () => {
    let beat: (() => Promise<void>) | undefined;
    let stopped = 0;
    const turn: { release?: () => void } = {};
    const { store, w, d, log } = await setup({
      schedule: (b) => { beat = b; return () => { stopped++; }; },
      runtime: () => ({ run: () => new Promise((resolve) => { turn.release = () => resolve({ status: "completed", text: "x" }); }), checkpoint: async () => ({ context: "kept" }), close: async () => { log.push("runtime close"); } }),
    });
    try {
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId } = await w.task("t", ann);
      await d.tick();
      const before = (await d.get(w.owner, attemptId!))!;
      w.clock.advance(20_000);
      await beat!();
      const after1 = (await d.get(w.owner, attemptId!))!;
      assert.ok(after1.heartbeats > before.heartbeats && after1.lease!.until > before.lease!.until);
      await d.changeRecipe(w.owner, attemptId!, { kind: "narrow", recipe: { revision: "r-narrower", reach: [] } });
      assert.ok(log.includes("sandbox open r-narrower"));
      assert.ok(log.includes(`runtime open from ${JSON.stringify({ context: "kept" })}`), "the conversation continues from the checkpoint");
      turn.release?.();
      await d.idle();
      assert.equal(stopped, 1, "the scheduler is stopped when the turn ends");
    } finally { await store.close(); }
  });

  test(`${backend.name}: a replaced sandbox is still asked what it holds until it is empty, the costs of all the attempt's sandboxes add up, and a host that forgot an attempt that is live reads as unknown (card L02d)`, async () => {
    const held: Record<string, { processes: { ref: string; kind: "process"; state: "running" | "uncooperative" }[]; costMicros: number }> = {};
    const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => { held[recipe.revision] = { processes: [], costMicros: 0 }; held[recipe.revision]!.costMicros = recipe.revision === "r-narrower" ? 30 : 100; return { revision: recipe.revision, close: async () => undefined, work: async () => ({ processes: held[recipe.revision]!.processes, costMicros: held[recipe.revision]!.costMicros }) }; } };
    const turn: { release?: () => void } = {};
    const { store, w, local, d } = await setup({ sandbox, runtime: () => ({ run: () => new Promise((resolve) => { turn.release = () => resolve({ status: "completed", text: "x" }); }), checkpoint: async () => ({ kept: true }), close: async () => undefined }) });
    try {
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId } = await w.task("t", ann);
      await d.tick();
      const first = Object.keys(held)[0]!;
      held[first]!.processes.push({ ref: "pid-7 (old confinement)", kind: "process", state: "running" });
      await d.changeRecipe(w.owner, attemptId!, { kind: "narrow", recipe: { revision: "r-narrower", reach: [] } });
      held["r-narrower"]!.processes.push({ ref: "pid-8", kind: "process", state: "running" });
      // Both confinements are asked about, and their costs add up.
      const both = await local.localWork([attemptId!]);
      assert.deepEqual(both.processes.map((p) => p.ref).sort(), ["pid-7 (old confinement)", "pid-8"], "work in the replaced sandbox is not unseen");
      assert.deepEqual(both.costs, [{ attemptId: attemptId!, costMicros: 130, computeMs: 0 }]);
      assert.deepEqual(both.known, [attemptId!]);
      // The old confinement empties: it is folded into the attempt's cost and no longer asked.
      held[first]!.processes.length = 0;
      const later = await local.localWork([attemptId!]);
      assert.deepEqual(later.processes.map((p) => p.ref), ["pid-8"]);
      assert.deepEqual(later.costs, [{ attemptId: attemptId!, costMicros: 130, computeMs: 0 }]);
      held[first]!.costMicros = 0;
      assert.equal((await local.localWork([attemptId!])).costs![0]!.costMicros, 130, "what the old sandbox cost stays counted");
      // A host that lost its memory (a controller restart) while the attempt is live in the dispatcher's records: unknown, never clean.
      const forgot = new LocalWorker({ hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "local-2.0.0", sandbox, runtimes: { open: async () => { throw new Error("unused"); } }, capabilities: () => CAPS });
      const after = w.restart({ workers: [forgot] });
      const got = await after.localWorkOf(w.owner, [attemptId!]);
      assert.deepEqual(got.processes.map((p) => [p.ref, p.state]), [[`attempt:${attemptId!}`, "unknown"]]);
      // Processes of attempts that were not asked about are not part of the answer.
      const stranger: WorkerHost = { hostId: "host:other", resources: { cpus: 1, memoryMb: 1 }, start: async () => { throw new Error("unused"); }, localWork: async () => ({ processes: [{ attemptId: "att-not-asked", ref: "x", kind: "process", state: "running" }, { attemptId: attemptId!, ref: "mine", kind: "process", state: "running" }] }) };
      const filtered = await w.restart({ workers: [stranger] }).localWorkOf(w.owner, [attemptId!]);
      assert.deepEqual(filtered.processes.map((p) => p.ref), ["mine"]);
      turn.release?.();
      await d.idle();
    } finally { await store.close(); }
  });

  test(`${backend.name}: more than eight sandboxes of one attempt never drop one that still holds a process (card L02d review)`, async () => {
    const held: Record<string, { ref: string }[]> = {};
    const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => { held[recipe.revision] ??= []; return { revision: recipe.revision, close: async () => undefined, work: async () => ({ processes: (held[recipe.revision] ?? []).map((p) => ({ ref: p.ref, kind: "process" as const, state: "running" as const })) }) }; } };
    const turn: { release?: () => void } = {};
    const { store, w, local, d } = await setup({ sandbox, runtime: () => ({ run: () => new Promise((resolve) => { turn.release = () => resolve({ status: "completed", text: "x" }); }), checkpoint: async () => ({ kept: true }), close: async () => undefined }) });
    try {
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { attemptId } = await w.task("t", ann);
      await d.tick();
      const first = Object.keys(held)[0]!;
      held[first]!.push({ ref: "pid-first" });
      for (let i = 1; i <= 10; i++) { await d.changeRecipe(w.owner, attemptId!, { kind: "narrow", recipe: { revision: `r-n${i}`, reach: [] } }); }
      assert.ok(Object.keys(held).length >= 10, `sandboxes opened: ${Object.keys(held).length}`);
      const all = await local.localWork([attemptId!]);
      assert.ok(all.processes.some((p) => p.ref === "pid-first"), "the oldest sandbox still holds a process and is still asked about");
      turn.release?.();
      await d.idle();
    } finally { await store.close(); }
  });

  test(`${backend.name}: a remote worker keeps the same contract: the order and every result cross as plain JSON, and the split begin/report form records the same operations`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const wire = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
      const seen: WorkOrder[] = [];
      const remote: WorkerHost = {
        hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 },
        start: async (order): Promise<WorkerHandle> => {
          seen.push(wire(order));
          return {
            workerVersion: "remote-0.1",
            run: async (gateway: ToolGateway) => {
              // The remote side holds the executor; the controller only sees the request, then the report.
              const begun = wire(await gateway.begin(wire({ callId: "r1", tool: { name: "read-file", version: "1" }, args: { path: "x" } })));
              assert.equal(begun.run, true);
              const ended = wire(await gateway.report(begun.operationId, { state: "confirmed", text: "remote output", cpuMs: 5 }));
              assert.equal(ended.state, "confirmed");
              const again = wire(await gateway.begin(wire({ callId: "r1", tool: { name: "read-file", version: "1" }, args: { path: "x" } })));
              assert.equal(again.run, false, "the same call is answered from the record");
              await refusesLocal(() => gateway.begin({ callId: "r2", tool: { name: "git-push", version: "1" }, args: {} }).then((b) => (b.run ? "ran" : b.result.state)), "refused");
              return wire({ status: "completed" as const, text: "done" });
            },
            checkpoint: async () => ({}), restart: async () => undefined, stop: async () => undefined,
          };
        },
      };
      const refusesLocal = async (run: () => Promise<string>, expected: string): Promise<void> => { assert.equal(await run(), expected); };
      const ann = await w.agent("ann", workGrants(w.project, ["read-file", "git-push"]));
      const { attemptId } = await w.task("t", ann);
      const d = w.restart({ workers: [remote] });
      await d.tick();
      await d.idle();
      assert.equal(seen[0]!.attemptId, attemptId);
      const recorded = await ops(w, attemptId!);
      assert.deepEqual(recorded.map((o) => [o.callId, o.state]).sort(), [["r1", "confirmed"], ["r2", "refused"]]);
      assert.equal(recorded.find((o) => o.callId === "r1")!.usage?.cpuMs, 5);
      assert.equal((await d.get(w.owner, attemptId!))!.workerVersion, "remote-0.1");
    } finally { await store.close(); }
  });

  test(`${backend.name}: the facts given to the tool catalogue come from the host's own registration and the capacity the owner declared, never from the caller`, async () => {
    const { store, w } = await setup();
    try {
      const status = (await w.hosts.status(w.owner, "host:local"))!;
      const facts = catalogFacts(status.capabilities, { cpus: 4, memoryMb: 8192 })!;
      assert.deepEqual(facts, { os: "linux", arch: "x64", interpreters: { python: "3.12" }, packages: { numpy: "2.1" }, cpus: 4, memoryMb: 8192 });
      assert.equal(catalogFacts(undefined, { cpus: 1, memoryMb: 1 }), undefined, "a host that has not registered has no facts");
      assert.equal(catalogFacts({ ...CAPS, os: "plan9" }, { cpus: 1, memoryMb: 1 }), undefined);
    } finally { await store.close(); }
  });
  test(`${backend.name}: after a decision changes, the local worker puts the new context before the agent and acknowledges it, so the next call runs`, async () => {
    let refreshed = 0;
    const out: string[] = [];
    let world: DispatchWorld | undefined;
    const { store, w, d } = await setup({
      runtime: (_order, call) => ({
        run: async () => {
          await world!.decisions.record(world!.owner, { commandId: "d1", projectId: world!.project, category: "decision", topic: "db", statement: "use pg", wording: "We will use PostgreSQL here", source: { channel: "direct" }, basedOn: 0 } as never);
          const req = (id: string) => ({ callId: id, tool: { name: "read-file", version: "1" }, args: { path: "a" } });
          out.push((await call(req("a"), { kind: "local", run: async () => ({ text: "x" }) })).state);
          out.push((await call(req("b"), { kind: "local", run: async () => ({ text: "x" }) })).state);
          return { status: "completed", text: "x" };
        },
        checkpoint: async () => ({}), refreshContext: async () => { refreshed++; }, close: async () => undefined,
      }),
    });
    world = w;
    try {
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      await w.task("t", ann);
      await d.tick();
      await d.idle();
      assert.deepEqual(out, ["refused", "confirmed"]);
      assert.equal(refreshed, 1);
    } finally { await store.close(); }
  });

  test(`${backend.name}: a runtime that cannot refresh the agent's context leaves the calls refused: the decisions are not acknowledged`, async () => {
    const out: string[] = [];
    let world: DispatchWorld | undefined;
    const { store, w, d } = await setup({
      runtime: (_order, call) => ({
        run: async () => {
          await world!.decisions.record(world!.owner, { commandId: "d1", projectId: world!.project, category: "decision", topic: "db", statement: "use pg", wording: "We will use PostgreSQL here", source: { channel: "direct" }, basedOn: 0 } as never);
          for (const id of ["a", "b"]) out.push((await call({ callId: id, tool: { name: "read-file", version: "1" }, args: { path: "a" } }, { kind: "local", run: async () => ({ text: "x" }) })).state);
          return { status: "completed", text: "x" };
        },
        checkpoint: async () => ({}), close: async () => undefined,
      }),
    });
    world = w;
    try {
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      await w.task("t", ann);
      await d.tick();
      await d.idle();
      assert.deepEqual(out, ["refused", "refused"]);
    } finally { await store.close(); }
  });
}
