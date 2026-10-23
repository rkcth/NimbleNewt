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
