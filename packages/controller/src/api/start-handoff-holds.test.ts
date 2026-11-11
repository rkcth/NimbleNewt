import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./start.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("composed: a hand-off names the sender's integrator lease and the workspace operation on the checkout, leaves the operation's freeze to it, releases the lease when the task moves, and moves it only for the owner (card L03j)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-handoff-holds-"));
  let enter!: () => void; const entered = new Promise<void>((ok) => { enter = ok; });
  let release!: () => void; const gate = new Promise<void>((ok) => { release = ok; });
  let runs = 0;
  const host: WorkerHost = { hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, start: async () => { throw new Error("no attempt"); }, workspace: { run: async () => { runs++; enter(); await gate; return { ok: true, summary: "refreshed" }; } } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), intervalMs: 1000, workers: [host] } });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const task = (await call(boot.token, "task.create", { projectId: project, title: "land the beds", description: "Land the bed work." }, "t1")).result.id as string;
    const agent = async (n: string, actions: string[]) => { const id = (await c.services.agents.create(rob, { commandId: `ag-${n}`, friendlyName: n })).id; for (const action of actions) await c.services.grants.grant(rob, { commandId: `g-${n}-${action}`, grantee: `agent:${id}`, action, project, source: "direct", basis: "test" } as never); return id; };
    const a = await agent("A", ["attempt.work", "responsibility.read"]);
    const b = await agent("B", ["attempt.work", "responsibility.read"]);
    // A manager who may hand the task over but is not the owner.
    await c.services.principals.enroll(rob, { commandId: "e-mgr", kind: "agent", name: "mgr", grants: [{ action: "assignment.manage", project }, { action: "assignment.read", project }] });
    const mgr = (await c.services.principals.issueCredential(rob, "agent:mgr")).token;
    await call(boot.token, "task.transition", { taskId: task, to: "ready", expectedRevision: 1 }, "tr1");
    assert.ok((await call(boot.token, "task.assign", { taskId: task, owner: { kind: "agent", id: a } }, "as1")).ok);
    const leases = c.services.integratorLeases;
    const lease = await leases.acquire({ commandId: "lz1", projectId: project, branch: "integration", holder: a, taskId: task, ttlMs: 3_600_000 });

    // The owner starts a refresh of the checkout; the host holds it open.
    const pending = call(boot.token, "workspace.request", { operation: "refresh", taskId: task, reason: "base moved" }, "w1");
    await entered;
    const prepared = await call(mgr, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "A moves on" }, "h1");
    assert.ok(prepared.ok, JSON.stringify(prepared));
    const locks = prepared.result.item.package.sections.locks as string;
    assert.match(locks, new RegExp(`integrator lease on branch integration: held by ${a} \\(the sender, fence 1`), locks);
    assert.match(locks, /checkout of .*refresh in progress, started by owner:rob/, locks);
    assert.ok(!/not tracked/.test(locks), "no gap line for kinds of hold that are now read");

    // Only the owner may move the lease: the manager is refused and nothing moves.
    const refused = await call(mgr, "handoff.complete", { handoffId: prepared.result.item.id, acceptGaps: true, moveIntegratorLease: true }, "h2");
    assert.equal(refused.error?.code, "forbidden", JSON.stringify(refused));
    assert.equal(await leases.valid(lease.leaseId, 1), true);
    // Completed without moving it: the task moves, the lease is released once, the workspace operation is still the owner's and still running.
    const done = await call(mgr, "handoff.complete", { handoffId: prepared.result.item.id, acceptGaps: true }, "h3");
    assert.equal(done.result?.item.phase, "transferred", JSON.stringify(done));
    assert.deepEqual(done.result.item.leasesSettled.entries.map((e: { outcome: string }) => e.outcome), ["released"]);
    assert.equal((await leases.get(lease.leaseId))?.state, "released");
    assert.equal((await call(boot.token, "assignment.get", { taskId: task })).result.item.owner.id, b);
    const requestId = /request (wsr-[a-z2-7]{20})/.exec(locks)?.[1];
    const open = (await call(boot.token, "workspace.get", { requestId })).result?.item;
    assert.deepEqual([open?.state, open?.requestedBy, open?.assignee], ["started", "owner:rob", a], "the hand-off neither ended nor took over the workspace operation (still the owner's, recorded against the sender)");
    release();
    assert.equal((await pending).result.state, "done");
    assert.equal(runs, 1);
    assert.equal((await call(boot.token, "workspace.get", { requestId })).result?.item.state, "done", "ended by its own call, once");

    // Back to A: B takes a lease, and the owner moves it to A with the hand-off (a new fence; B's stops working).
    const bl = await leases.acquire({ commandId: "lz2", projectId: project, branch: "integration", holder: b, taskId: task, ttlMs: 3_600_000 });
    assert.equal(bl.fence, 2);
    const back = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: a }, reason: "back to A" }, "h4");
    assert.match(back.result.item.package.sections.locks, /integrator lease on branch integration: held by .* fence 2/);
    const moved = await call(boot.token, "handoff.complete", { handoffId: back.result.item.id, acceptGaps: true, moveIntegratorLease: true }, "h5");
    assert.equal(moved.result?.item.phase, "transferred", JSON.stringify(moved));
    const now = await leases.get(lease.leaseId);
    assert.deepEqual([now?.holder, now?.fence, now?.state], [a, 3, "held"]);
    assert.equal(await leases.valid(lease.leaseId, 2), false, "the sender's fence is dead");
    const steps = await call(boot.token, "activity.steps", { taskId: task });
    assert.ok(steps.result.steps.some((x: { kind: string; summary: string }) => x.kind === "ownership" && x.summary.includes("Integrator leases: moved to the recipient integration")), JSON.stringify(steps.result).slice(0, 2000));
    // Nothing held any more by the sender of a third hand-off: the section says none.
    await leases.release({ commandId: "lz3", leaseId: lease.leaseId, fence: 3 });
    const third = await call(boot.token, "handoff.prepare", { taskId: task, to: { kind: "agent", id: b }, reason: "again" }, "h6");
    assert.match(third.result.item.package.sections.locks, /^none: /);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
