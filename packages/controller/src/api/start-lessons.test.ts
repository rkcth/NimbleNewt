import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { lessonOutcomeLoops } from "../dispatch/index.js";
import type { Principal } from "../security/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

// Card B03 in the composed controller: an agent proposes a lesson from the observation of a failed review, the owner accepts it, a revision supersedes it and sends a lesson resting on it to review,
// the status view says so, and after a restart the lessons are as they were and a replayed proposal makes nothing new.
test("lessons through the running controller's API: evidence from an observation, acceptance, a revision superseding it, a stale premise, the status view and a restart (card B03)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lsn-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    // The dispatcher with no worker host: its loops run on each manual tick, the lessons' outcome loop among them.
    dispatch: { timer: new ManualTimer(), manual: true, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } });
  let c = await open();
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Write the login" })).id;
    const hire = async (n: string, roles: string[], extra: string[] = []) => {
      const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
      const id = `agent:${made.id}`;
      for (const action of ["task.read", ...(roles.includes("reviewer") ? ["review.decide"] : []), ...extra]) await s.grants.grant(rob, { commandId: `g-${n}-${action}`, grantee: id, action, project, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"], ["meeting.agenda", "review.request", "attempt.work"]);
    const rev = await hire("Rev", ["reviewer"]);
    const zed = await hire("Zed", ["author"]);
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const sbm = (await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base: "a".repeat(40), tree: "b".repeat(40), patchId: "c".repeat(40) }, "s1")).result.id as string;
    const reviewed = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: sbm, verdict: "changes" }, "rv1");
    assert.ok(reviewed.ok, JSON.stringify(reviewed));
    // Card U09b: the submissions' steps, read back from the owner's replay. A code submission is a proposal (its review decides), so it is proposed; a review that was recorded is confirmed.
    {
      const shown = ((await call(boot.token, "activity.replay.open", { taskId: task, limit: 50 })).result.entries as { kind?: string; summary?: string; outcome?: string }[]).filter((e) => e.kind === "submission");
      assert.deepEqual(shown.map((e) => [/\(author\)/.test(e.summary ?? "") ? "code" : /\(reviewer\)/.test(e.summary ?? "") ? "review" : e.summary, e.outcome]), [["code", "proposed"], ["review", "confirmed"]], JSON.stringify(shown));
    }
    // The failed review is an observation (B02); the author retells it, so it is a reporter and may cite it.
    const told = await call(ann.token, "observation.submit", { projectId: project, summary: "sent back for the error path", sources: [{ kind: "submission", id: reviewed.result.id }] }, "f1");
    const obs = told.result.id as string;

    const proposal = { projectId: project, title: "Error paths need tests", statement: "A handler without error-path tests is sent back.", applicability: "request handlers", evidence: [{ kind: "observation", id: obs }, { kind: "submission", id: reviewed.result.id }] };
    const made = await call(ann.token, "lesson.propose", proposal, "l1");
    assert.ok(made.ok, JSON.stringify(made));
    const lesson = made.result.id as string;
    const got = (await call(ann.token, "lesson.get", { lessonId: lesson })).result.item;
    assert.deepEqual([got.status, got.independentEvidence, got.evidence.map((e: { independence: string }) => e.independence), got.taskId], ["candidate", 1, ["independent", "derived"], task], "the same review told twice is one independent piece");
    assert.equal((await call(zed.token, "lesson.propose", proposal, "l1z")).error.code, "forbidden");
    assert.equal((await call(zed.token, "lesson.get", { lessonId: lesson })).error.code, "not_found");
    assert.equal((await call(ann.token, "lesson.decide", { lessonId: lesson, expectedRevision: 1, to: "accepted", finding: "x" }, "d0")).error.code, "forbidden");

    const acc = await call(boot.token, "lesson.decide", { lessonId: lesson, expectedRevision: 1, to: "accepted", finding: "three reviews said so" }, "d1");
    assert.ok(acc.ok, JSON.stringify(acc));
    const resting = (await call(boot.token, "lesson.propose", { projectId: project, title: "Write the error test first", statement: "Start a handler with its error test.", applicability: "request handlers", evidence: [{ kind: "submission", id: sbm }], dependsOn: [lesson] }, "l2")).result.id as string;
    await call(boot.token, "lesson.decide", { lessonId: resting, expectedRevision: 1, to: "accepted", finding: "it helped" }, "d2");
    const v2 = (await call(boot.token, "lesson.propose", { projectId: project, title: "Error and timeout paths need tests", statement: "Timeouts too.", applicability: "request handlers and jobs", evidence: [{ kind: "submission", id: sbm }], revises: lesson }, "l3")).result.id as string;
    const sup = await call(boot.token, "lesson.decide", { lessonId: v2, expectedRevision: 1, to: "accepted", finding: "a timeout slipped through" }, "d3");
    assert.deepEqual(sup.result.marked, [resting]);

    const view = await call(boot.token, "status.ask", { request: { kind: "lessons", projectId: project } });
    assert.ok(view.ok, JSON.stringify(view));
    const lines = (view.result.item.lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(lines, /needs-review, version 1: "Write the error test first".* Rests on lsn-[a-z2-7]{20}\. Stale premise: lsn-[a-z2-7]{20} superseded; it needs review before it is accepted again\./);
    assert.match(lines, /accepted, version 2: "Error and timeout paths need tests"/);
    assert.match(lines, /superseded, version 1: "Error paths need tests".* Superseded by lsn-.* Not yet told to agent:/, "the superseded one stays listed until its proposer is told the acceptance");

    // A restart: the records are as they were; the same proposal and decision sent again are answered with what was recorded.
    await c.close();
    c = await open();
    const again = await c.api.handle(ann.token, { v: 1, op: "lesson.propose", commandId: "l1", args: proposal } as never) as any;
    assert.deepEqual([again.ok, again.result.id, again.result.replayed], [true, lesson, true]);
    const list = (await c.api.handle(boot.token, { v: 1, op: "lesson.list", args: { projectId: project } } as never) as any).result.item;
    assert.deepEqual(list.items.map((l: { id: string; status: string }) => [l.id, l.status]), [[lesson, "superseded"], [resting, "needs-review"], [v2, "accepted"]]);

    // The composed dispatcher's loop tells Ann: the notice is filed on the lesson's task, the lesson is marked told and, being final, leaves the current list.
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const tick = await c.dispatch.dispatcher.tick();
    assert.ok(tick.loops.some((l) => l.name === "lessons.outcomes" && l.ok), JSON.stringify(tick.loops.filter((l) => l.name === "lessons.outcomes" || !l.ok)));
    const toldNow = (await c.api.handle(ann.token, { v: 1, op: "lesson.get", args: { lessonId: lesson } } as never) as any).result.item;
    assert.deepEqual([toldNow.outcomePending, typeof toldNow.outcomeToldAt], [false, "string"]);
    const after = (await c.api.handle(boot.token, { v: 1, op: "lesson.list", args: { projectId: project } } as never) as any).result.item;
    assert.deepEqual(after.items.map((l: { id: string }) => l.id), [resting, v2]);

    // The dispatcher's loop tells the proposers project by project, and one project's failure does not stop the others.
    const asked: string[] = [];
    const [loop] = lessonOutcomeLoops({ deliverOutcomes: async (_by, p) => { asked.push(p); if (p === "bad") throw new Error("storage away"); } }, async () => ["bad", project]);
    assert.equal(loop!.name, "lessons.outcomes");
    await assert.rejects(loop!.run({ id: "service:dispatcher", kind: "service" } as unknown as Principal), /lesson outcomes could not be delivered for 1 project\(s\): bad: storage away/);
    assert.deepEqual(asked, ["bad", project]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
