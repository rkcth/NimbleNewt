import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

// Card P10 (sixth slice), through the composed controller: on a project with a landing branch an `integration` (the checkout's unreviewed work written into the shared tree) is made under the landing branch's
// integrator lease, by the owner only, and only while the branch's landing queue holds nothing. A project with no landing branch integrates as before. No host holds the checkout here, so an integration that passes
// the gate is answered "no host" (the gate's refusals come before anything is recorded).
test("an integration on a project with a landing branch is made under the integrator lease, by the owner, while the landing queue is empty (card P10, sixth slice)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10i-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const O = boot.token;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Plant the garden" })).id;
    const other = (await c.services.projects.createTask({ commandId: "t2", actor: rob.id, projectId: project, title: "Water the garden" })).id;
    const grants = [{ action: "integration.lease", project }, { action: "workspace.manage", project }];
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    const integrate = (token: string, id: string, extra: Record<string, unknown> = {}) => call(token, "workspace.request", { operation: "integration", taskId: task, reason: "share the work", ...extra }, id);

    // No landing branch: as before (no lease asked or recorded); the request reaches the point of asking a host.
    const plain = await integrate(O, "w0");
    assert.equal(plain.error, undefined, JSON.stringify(plain));
    assert.equal(plain.result.lease, undefined);
    assert.match(plain.result.summary, /no host/);

    // The owner names a landing branch: with no integrator holding it, nothing is integrated, and the refusal says why.
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    const unleased = await integrate(O, "w1");
    assert.equal(unleased.error?.code, "fenced", JSON.stringify(unleased));
    assert.match(unleased.error?.message ?? "", /an integration writes the shared tree of landing branch main, so it is made under that branch's integrator lease, as a landing is: no integrator holds the lease/);

    // An agent holding no lease is told that only the owner integrates here, not asked for a lease that would never let it.
    const noLease = await integrate(ann, "w1a");
    assert.equal(noLease.error?.code, "invalid_transition", JSON.stringify(noLease));
    assert.match(noLease.error?.message ?? "", /only the owner shares a task's unreviewed work/);
    const lease = (await call(ann, "integrator.lease.acquire", { taskId: task, branch: "main", ttlMs: 600_000 }, "a1")).result.item;
    // The integrator itself shares no unreviewed work (it lands only queued, approved submissions).
    const byAnn = await integrate(ann, "w2", { leaseId: lease.leaseId, fence: lease.fence });
    assert.equal(byAnn.error?.code, "invalid_transition", JSON.stringify(byAnn));
    assert.match(byAnn.error?.message ?? "", /only the owner shares a task's unreviewed work/);
    // The owner, leaving the lease out (as in chat): the live hold is used and recorded.
    const byOwner = await integrate(O, "w3");
    assert.equal(byOwner.error, undefined, JSON.stringify(byOwner));
    assert.deepEqual(byOwner.result.lease, { leaseId: lease.leaseId, fence: lease.fence });
    assert.match(byOwner.result.summary, /no host/);

    // A place in the landing queue (another task's author reached the refresh-round cap): the queue is not empty, so nothing is integrated until the owner takes it out.
    assert.equal(await c.services.landingQueue.afterRound({ taskId: other, projectId: project, round: 3 }), "reserved");
    const queued = await integrate(O, "w4");
    assert.equal(queued.error?.code, "invalid_transition", JSON.stringify(queued));
    assert.match(queued.error?.message ?? "", /landing queue of branch main is not empty/);
    assert.ok((await call(O, "landing.queue.remove", { taskId: other, reason: "let the integration go ahead" }, "rm1")).ok);
    assert.equal((await integrate(O, "w5")).error, undefined);

    // The landing settings cannot be read (P10 sixth-slice second review): the composed gate fails closed rather than taking it for "no landing branch". Readable again: the integration goes ahead.
    const configuration = c.services.configuration as unknown as { taskValues: (...a: unknown[]) => Promise<unknown> };
    const readValues = configuration.taskValues;
    configuration.taskValues = async () => { throw new Error("settings store offline"); };
    try {
      const unread = await integrate(O, "w5u");
      assert.equal(unread.error?.code, "unavailable", JSON.stringify(unread));
      assert.match(unread.error?.message ?? "", /landing settings could not be read.*nothing was written/);
      assert.equal((unread.error?.message ?? "").includes("offline"), false, "the store's own error text is not passed on");
    } finally { configuration.taskValues = readValues; }
    assert.equal((await integrate(O, "w5r")).error, undefined);

    // The holder gives the lease back: the owner's integration is refused again.
    assert.ok((await call(ann, "integrator.lease.release", { leaseId: lease.leaseId, fence: lease.fence }, "r1")).ok);
    assert.equal((await integrate(O, "w6")).error?.code, "fenced");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 5 }); }
});
