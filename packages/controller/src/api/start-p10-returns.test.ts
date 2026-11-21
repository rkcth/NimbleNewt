import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), tree = "b".repeat(40), patch = "c".repeat(40);

// Card P10, overlapping work returned to its author, through the composed controller: the return counts against the project's `review.repairCycles` (Q04's setting), the task's holder gets a notice in its inbox,
// at the limit the project's director and the owner are told, a holder that is no longer active is not told (the director and owner are, the owner as needs-you without a director), and the owner's chat view
// of the landing queue names the returns.
test("work returned to its author: the holder's inbox, the Q04 limit from the project's settings, the director and owner at the limit, an inactive holder, and the chat view (card P10)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-p10ret-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const hire = async (name: string, roles: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      for (const [i, action] of ["task.read", "message.receive"].entries()) await s.grants.grant(rob, { commandId: `g-${name}-${i}`, grantee: id, action, project, source: "direct", basis: "test" } as never);
      return { id, bare: made.id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    const submit = async (title: string, n: string) => {
      const task = (await s.projects.createTask({ commandId: `t-${n}`, actor: rob.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r-${n}`, actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as-${n}`, actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
      await s.assignments.admitAttempt({ commandId: `adm-${n}`, actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: made.result.id, verdict: "approve" }, `rev-${n}`)).ok);
      return { task, id: made.result.id as string };
    };
    const notices = async (who: string) => {
      const inbox = (await c.storage.getAggregate({ kind: "agent-inbox", id: who }))?.body as { pending?: { id: string }[] } | undefined;
      const out: { purpose: string; text: string; taskId: string }[] = [];
      for (const p of inbox?.pending ?? []) { const m = (await c.storage.getAggregate({ kind: "agent-message", id: p.id }))?.body as { purpose: string; text: string; taskId: string; kind: string } | undefined; if (m?.kind === "notice") out.push(m); }
      return out;
    };
    const ownerTold = async (taskId: string) => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob)).items.filter((i) => i.ref.kind === "task" && i.ref.id === taskId);

    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);
    await s.configuration.change(rob, { commandId: "cfg", layer: "project", scopeId: project, expectedRevision: 0, set: { "review.repairCycles": 2 } } as never);
    const one = await submit("Fix the gate", "1");
    const q = s.landingQueue;
    assert.deepEqual((await call(O, "landing.queue.list", { projectId: project })).result.items.map((e: any) => e.taskId), [one.task], "the approval queued it");
    // The first return: the holder (Ann) is told in its inbox; the limit is the project's review.repairCycles (2); nobody else is told yet.
    const r1 = await q.returned({ requestId: "wsr-aaaaaaaaaaaaaaaaaaaa", taskId: one.task, projectId: project, branch: "main", submissionId: one.id, paths: ["src/a.ts"], assignee: ann.id });
    assert.deepEqual(r1, { to: ann.id, cycles: 1, limit: 2, escalated: false });
    const annSaw = await notices(ann.id);
    assert.equal(annSaw.length, 1, JSON.stringify(annSaw));
    assert.match(annSaw[0]!.text, /returned to you.*work\.refresh.*conflict return 1 of 2/);
    assert.equal(annSaw[0]!.taskId, one.task);
    assert.equal((await ownerTold(one.task)).length, 0);
    // Not queued again; the list names the return.
    const listed = (await call(O, "landing.queue.list", { projectId: project })).result;
    assert.deepEqual([listed.items, listed.returns.map((x: any) => [x.taskId, x.count])], [[], [[one.task, 1]]]);
    // The chat view of the landing queue names the return in the owner's terms.
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    const q1 = "what is waiting to land?";
    say[q1] = [{ kind: "status", request: { kind: "landing_queue" }, evidence: q1, basis: "owner" }];
    const asked = (await c.chat!.submit(O, { messageId: "m1", text: q1 })).outcomes as any[];
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    assert.match((asked[0].lines as { text: string }[]).map((l) => l.text).join("\n"), /approved work was returned to its author 1 time\(s\) because it changed files that landed after it was approved.*review\.repairCycles/);
    // A refreshed submission is approved and queued again; it overlaps again: the second return reaches the limit, and the director-less project's owner is asked to decide (needs-you).
    const two = await call(ann.token, "submission.record", { taskId: one.task, kind: "code", role: "author", base, tree: "d".repeat(40), patchId: "e".repeat(40) }, "code-1b");
    assert.ok(two.ok, JSON.stringify(two));
    assert.ok((await call(rev.token, "submission.record", { taskId: one.task, kind: "review", role: "reviewer", subject: two.result.id, verdict: "approve" }, "rev-1b")).ok);
    const r2 = await q.returned({ requestId: "wsr-bbbbbbbbbbbbbbbbbbbb", taskId: one.task, projectId: project, branch: "main", submissionId: two.result.id, paths: ["src/a.ts"], assignee: ann.id });
    assert.deepEqual(r2, { to: ann.id, cycles: 2, limit: 2, escalated: true });
    const told = await ownerTold(one.task);
    assert.equal(told.length, 1, JSON.stringify(told));
    assert.equal(told[0]!.level, "needs-you");
    assert.match(told[0]!.detail ?? "", /waits on task .*overlapped landed files again, at the repair-cycle limit.*No director could be told/);
    // A director of the project is told (in its inbox) at the next return, and the owner gets a notice; an inactive holder is not told.
    const dee = await hire("Dee", ["director"]);
    const three = await call(ann.token, "submission.record", { taskId: one.task, kind: "code", role: "author", base, tree: "f".repeat(40), patchId: "1".repeat(40) }, "code-1c");
    assert.ok((await call(rev.token, "submission.record", { taskId: one.task, kind: "review", role: "reviewer", subject: three.result.id, verdict: "approve" }, "rev-1c")).ok);
    await s.principals.disable(rob, { commandId: "off-ann", principalId: ann.id, expectedRevision: (await s.principals.get(ann.id))!.revision });
    const r3 = await q.returned({ requestId: "wsr-cccccccccccccccccccc", taskId: one.task, projectId: project, branch: "main", submissionId: three.result.id, paths: ["src/a.ts"], assignee: ann.id });
    assert.deepEqual(r3, { cycles: 3, limit: 2, escalated: true }, "the inactive holder is not told");
    assert.equal((await notices(dee.id)).length, 1);
    const toldNow = await ownerTold(one.task);
    // The owner's notifications about one task are one item, counted; its newest text says the director was told.
    assert.deepEqual([toldNow.length, toldNow[0]!.count], [1, 2]);
    assert.match(toldNow[0]!.detail ?? "", /overlapped landed files again, at the repair-cycle limit\)\. The director was told\./);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
