import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10b (fourth clause), through the composed controller: when no integrator can land a project's queue, the owner's landing_queue view (in chat and through status.ask) says why the approved work waits; when
// one is free or holds the branch, it says that. Read-only and owner only: an integrator reading the same queue sees no such line. No new chat control and no interpreter text.
test("the owner's landing_queue view says who lands the queue or why approved work waits with no capacity left (card P10b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10b-cap-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
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
    const both = [garden, orchard].map((project) => ({ action: "task.read", project }));
    const ann = await hire("Ann", ["author"], both);
    const rev = await hire("Rev", ["reviewer"], both);
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
      assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`)).ok);
      return task;
    };
    await approved(garden, "Plant the beans");
    await approved(orchard, "Pick the apples");
    const view = async (token: string, projectId: string): Promise<string> => {
      const got = await call(token, "status.ask", { request: { kind: "landing_queue", projectId } });
      assert.equal(got.ok, true, JSON.stringify(got));
      return (got.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    };

    // Nobody may land on Garden yet: the owner is told no capacity exists and what adds it.
    assert.match(await view(O, garden), /No capacity is left to land this queue: no active agent has the right integration\.lease on this project, so the approved work waits until an agent is given that right/);
    // In chat, in the owner's own words (the existing status view; nothing new for the interpreter).
    await c.chat!.setFocus(O, { commandId: "f1", projectId: garden });
    const q1 = "why is nothing landing?";
    say[q1] = [{ kind: "status", request: { kind: "landing_queue" }, evidence: q1, basis: "owner" }];
    const asked = (await c.chat!.submit(O, { messageId: "m1", text: q1 })).outcomes as any[];
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.match((asked[0].lines as { text: string }[]).map((l) => l.text).join("\n"), /No capacity is left to land this queue: no active agent has the right integration\.lease/);

    // Ivy may land on both: free for both.
    const ivy = await hire("Ivy", ["integrator"], [...both, { action: "integration.lease", project: garden }, { action: "integration.lease", project: orchard }]);
    assert.match(await view(O, orchard), /No integrator holds this branch's lease now; 1 integrator that may land on this project holds no lease, so one of them takes this queue when it asks the pool \(integrator\.pool\.next\)/);
    // She takes Garden (approved first): Garden is hers until her lease ends; Orchard has no capacity left.
    const took = await call(ivy.token, "integrator.pool.next", { ttlMs: 600_000 }, "i1");
    assert.deepEqual([took.result.outcome, took.result.projectId], ["taken", garden]);
    assert.match(await view(O, garden), new RegExp(`Integrator ${ivy.agentId} holds the integrator lease of this branch until ${took.result.lease.expiresAt.replace(/[.]/g, "\\.")} and lands its queue\\.`));
    assert.match(await view(O, orchard), /No capacity is left to land this queue: the one integrator that may land on this project already holds an integrator lease \(one project at a time\), so the approved work waits until one releases its lease or the lease runs out/);
    // Ivy reads Orchard's queue (her right lets her): the queue, but no line about who else is busy where.
    const hers = await view(ivy.token, orchard);
    assert.match(hers, /holds 1 approved submission/);
    assert.doesNotMatch(hers, /capacity|this branch's lease|lands its queue/);
    // Max joins for Orchard: capacity again, with Ivy counted as busy.
    await hire("Max", ["integrator"], [{ action: "integration.lease", project: orchard }]);
    assert.match(await view(O, orchard), /1 integrator that may land on this project holds no lease, .*; 1 other is busy with a lease already\./);
    // Ivy disabled while she holds Garden: her live hold is not capacity in use, and Max may not land on Garden: nobody.
    await s.principals.disable(rob, { commandId: "d-ivy", principalId: ivy.id, expectedRevision: (await s.principals.get(ivy.id))!.revision });
    assert.match(await view(O, garden), /No capacity is left to land this queue: no active agent has the right integration\.lease on this project/);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
