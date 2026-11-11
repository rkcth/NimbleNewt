import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { LocalWorker, type RuntimeFactory, type SandboxPort } from "./local-worker.js";
import type { RecipeSummary } from "./ports.js";
import { buildWorld, workGrants } from "./testing/world.js";

after(stopServer);

const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: ["python@3.12", "pkg:numpy@2.1"], workspaces: [] };

for (const backend of backends) {
  const setup = async (sandbox: SandboxPort) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    const runtimes: RuntimeFactory = { open: async (_order, call) => ({ run: async () => { const r = await call({ callId: "c1", tool: { name: "read-file", version: "1" }, args: { path: "a" } }, { kind: "local", run: async () => ({ text: "x" }) }); return { status: "completed", endKind: "normal", text: r.state }; }, checkpoint: async () => ({}), close: async () => undefined }) };
    const local = new LocalWorker({ hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "local-2.0.0", sandbox, runtimes, capabilities: () => CAPS });
    await local.register(w.hosts, self);
    return { store, w, local, d: w.restart({ workers: [local] }) };
  };
  const flag = async (d: { get: (...a: never[]) => Promise<unknown> }, by: unknown, id: string) => ((await (d.get as (b: unknown, i: string) => Promise<unknown>)(by, id)) as { workerStopped?: boolean }).workerStopped;

  test(`${backend.name}: a local worker whose close could not end its process is confirmed stopped once a later look finds its sandbox empty, and until then a Stop of its task still finds it (card L02e)`, async () => {
    let alive = true;
    const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => ({ revision: recipe.revision, close: async () => { throw new Error("the worker process did not end"); }, work: async () => ({ processes: alive ? [{ ref: "pid-7 (left)", kind: "process" as const, state: "uncooperative" as const }] : [] }) }) };
    const { store, w, local, d } = await setup(sandbox);
    try {
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      const { attemptId, taskId } = await w.task("t", ann);
      await d.tick();
      await d.idle();
      assert.equal(await flag(d as never, w.owner, attemptId!), false, "the close failed, so the worker is not confirmed");
      assert.deepEqual(await d.unconfirmedAttemptsOf(w.owner, { taskId: taskId! }), [attemptId!], "the finished attempt is remembered for a later Stop");
      assert.deepEqual(await d.unconfirmedAttemptsOf(w.owner, { agentId: ann.id }), [attemptId!]);
      assert.deepEqual(await d.unconfirmedAttemptsOf(w.owner, { taskId: "task-none" }), []);
      await assert.rejects(d.unconfirmedAttemptsOf(ann as never, { taskId: taskId! }), /may not list/);
      // A process is still listed: not confirmed, and nothing is killed by asking.
      assert.equal(await d.confirmStopped(w.owner, attemptId!), false);
      assert.deepEqual(await d.unconfirmedAttemptsOf(w.owner, { taskId: taskId! }), [attemptId!]);
      await assert.rejects(local.release(attemptId!, "x"), /still runs/);
      // The process is gone: the next look confirms, records it, and the attempt is no longer remembered.
      alive = false;
      assert.equal(await d.confirmStopped(w.owner, attemptId!), true);
      assert.equal(await flag(d as never, w.owner, attemptId!), true);
      assert.deepEqual(await d.unconfirmedAttemptsOf(w.owner, { taskId: taskId! }), []);
      // Taken off the stored list itself in the same commit (not only hidden when read), so a confirmed attempt never takes one of the list's places.
      const stored = await store.storage.getAggregate({ kind: "dispatch-unconfirmed", id: "unconfirmed" });
      assert.deepEqual((stored?.body as unknown as { ids: string[] } | undefined)?.ids, []);
    } finally { await store.close(); }
  });

  test(`${backend.name}: a sandbox that cannot say what it holds, or an attempt this process has no record of, is never confirmed stopped (card L02e)`, async () => {
    const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => ({ revision: recipe.revision, close: async () => { throw new Error("the worker process did not end"); } }) };
    const { store, w, local, d } = await setup(sandbox);
    try {
      const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
      const { attemptId } = await w.task("t", ann);
      await d.tick();
      await d.idle();
      assert.equal(await d.confirmStopped(w.owner, attemptId!), false, "no way to look: not confirmed");
      await assert.rejects(local.release("att-unknownunknownunkn", "x"), /no record/);
      await assert.rejects(local.release(attemptId!, "x"), /cannot say/);
      assert.equal(await flag(d as never, w.owner, attemptId!), false);
    } finally { await store.close(); }
  });
}

test("a local worker still starting, or whose handle was not stopped, is never confirmed stopped, though its sandbox lists nothing (review of L02e)", async () => {
  let opened!: () => void;
  const sandboxOpen = new Promise<void>((r) => { opened = r; });
  let letRuntimeOpen!: () => void;
  const runtimeGate = new Promise<void>((r) => { letRuntimeOpen = r; });
  // A running worker process is the attempt itself and is not listed, so the sandbox lists nothing the whole time.
  const sandbox: SandboxPort = { open: async (recipe: RecipeSummary) => { opened(); return { revision: recipe.revision, close: async () => undefined, work: async () => ({ processes: [] }) }; } };
  const runtimes: RuntimeFactory = { open: async () => { await runtimeGate; return { run: async () => ({ status: "completed", endKind: "normal", text: "" }), checkpoint: async () => ({}), close: async () => undefined }; } };
  const local = new LocalWorker({ hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "local-2.0.0", sandbox, runtimes, capabilities: () => CAPS });
  const attemptId = "att-startingstartingstar";
  const starting = local.start({ attemptId, taskId: "task-x", projectId: "prj-x", agentId: "agent:agt-1", generation: 1, route: "r", credential: "c", recipe: { revision: "rev-1" }, content: "x", requestId: "q" } as never);
  await sandboxOpen;
  await assert.rejects(local.release(attemptId, "x"), /starting or has not been stopped/, "an end that runs while the start has not answered is not confirmed");
  letRuntimeOpen();
  const handle = await starting;
  await assert.rejects(local.release(attemptId, "x"), /starting or has not been stopped/, "a handle not yet stopped is not confirmed");
  await handle.stop();
  await local.release(attemptId, "x");
  // A start that fails takes its count off too.
  const failing = new LocalWorker({ hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "local-2.0.0", sandbox, runtimes: { open: async () => { throw new Error("no runtime"); } }, capabilities: () => CAPS });
  await assert.rejects(failing.start({ attemptId, recipe: { revision: "rev-1" }, content: "x" } as never), /no runtime/);
  await failing.release(attemptId, "x");
});
