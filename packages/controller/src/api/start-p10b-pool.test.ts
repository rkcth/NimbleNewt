import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";
import { OPERATION_BY_NAME } from "./operations.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10b (first slice), through the composed controller: approved work queued in two projects; integrators of a pool ask the state API for the next project with queued work and get the landing branch's lease
// of the project whose work waited longest, one project at a time, only among the projects they may land on; an integrator with nothing it may take is told why.
test("the integrator pool through the state API: the next project with queued work, one at a time, only where the integrator may land (card P10b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10b-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter(() => []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const garden = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const orchard = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (name: string, roles: string[], grants: { action: string; project: string }[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, g] of grants.entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action: g.action, project: g.project, source: "direct", basis: "test" } as never);
      return { id, agentId: made.id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const both = [garden, orchard].flatMap((project) => [{ action: "task.read", project }]);
    const ann = await hire("Ann", ["author"], both);
    const rev = await hire("Rev", ["reviewer"], both);
    const ivy = await hire("Ivy", ["integrator"], [...both, { action: "integration.lease", project: garden }, { action: "integration.lease", project: orchard }]);
    const max = await hire("Max", ["integrator"], [...both, { action: "integration.lease", project: orchard }]);
    const jo = await hire("Jo", ["integrator"], [{ action: "integration.lease", project: orchard }]);
    for (const [i, project] of [garden, orchard].entries()) assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, `lb${i}`)).ok);
    let n = 0;
    const approved = async (projectId: string, title: string) => {
      n++;
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId, title })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      const reviewed = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`);
      assert.equal(reviewed.ok, true, JSON.stringify(reviewed));
      return { task, submissionId: made.result.id as string };
    };
    // Orchard's work is approved first, so it has waited longest.
    const ripe = await approved(orchard, "Pick the apples");
    await approved(garden, "Plant the beans");
    const next = (token: string, id: string, args: Record<string, unknown> = { ttlMs: 600_000 }) => call(token, "integrator.pool.next", args, id);

    const first = await next(ivy.token, "i1");
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.deepEqual([first.result.outcome, first.result.projectId, first.result.branch, first.result.taskId, first.result.submissionId, first.result.lease.holder, first.result.lease.live], ["taken", orchard, "main", ripe.task, ripe.submissionId, ivy.agentId, true]);
    // The lease it took is the project's lease, listed as P10 lists it.
    assert.deepEqual((await call(ivy.token, "integrator.lease.list", { projectId: orchard })).result.items.map((l: any) => [l.branch, l.holder, l.live]), [["main", ivy.agentId, true]]);
    // One project at a time; the same request again answers the same hold.
    for (const id of ["i1", "i2"]) assert.deepEqual([(await next(ivy.token, id)).result.outcome, (await next(ivy.token, id)).result.lease.leaseId], ["holding", first.result.lease.leaseId], id);
    // Max may land only on Orchard, which Ivy holds: nothing, and Garden is not counted for him.
    const maxs = await next(max.token, "m1");
    assert.deepEqual(maxs.result, { outcome: "none", reason: "nothing was taken: 1 branch is held by another integrator", heldByOthers: 1, awaitingWork: 0, unreadable: 0, partial: false });
    // Ivy lets Orchard go; Max takes it; Ivy then takes Garden.
    assert.ok((await call(ivy.token, "integrator.lease.release", { leaseId: first.result.lease.leaseId, fence: first.result.lease.fence }, "ir1")).ok);
    assert.equal((await next(max.token, "m2")).result.projectId, orchard);
    const second = await next(ivy.token, "i3");
    assert.deepEqual([second.result.outcome, second.result.projectId], ["taken", garden]);
    assert.equal((await next(jo.token, "j1")).result.heldByOthers, 1);

    // Refused: the owner (it names an agent with integrator.lease.acquire), unknown arguments, a bad hold time, no command ID.
    assert.equal((await next(O, "o1")).error?.code, "forbidden");
    assert.equal((await next(jo.token, "j2", { ttlMs: 600_000, projectId: garden })).error?.code, "invalid_command");
    assert.equal((await next(jo.token, "j3", { ttlMs: 10 })).error?.code, "invalid_command");
    assert.equal((await call(jo.token, "integrator.pool.next", { ttlMs: 600_000 })).error?.code, "invalid_command");
    // An agent-only command: in the operations list, and not a chat control (no interpreter text; the owner's way is integrator.lease.acquire).
    assert.equal(OPERATION_BY_NAME.get("integrator.pool.next")?.kind, "command");
    assert.equal(CHAT_OPS["integrator.pool.next"], undefined);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
