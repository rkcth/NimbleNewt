import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), patch = "c".repeat(40);

// Card Q02 (review policy) through the composed controller: the owner sets the policy in plain words (shown first, applied on the owner's yes) and reads it back; an agent cannot set it; the dispatcher's regular
// round (`qa.review.schedule`) creates the review of a new code submission for a reviewer that did not work on the task, while the contributor's attempt keeps running untouched.
test("the owner sets the review policy by chat, reads it back, and the controller's regular round starts the review without touching the contributor's running attempt (card Q02, Q04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-qapol-"));
  let now = Date.now();
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, clock: () => new Date(now).toISOString() }, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) as never } } as never);
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
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the gate" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const turn = async (messageId: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(O, { messageId, text })).outcomes as any[]; };
    const round = async (): Promise<any> => { const t = await c.dispatch!.dispatcher.tick(); const loop = t.loops.find((x: any) => x.name === "qa.review.schedule"); assert.ok(loop !== undefined, "the scheduler is one of the dispatcher's loops: " + t.loops.map((x: any) => x.name).join(",")); assert.equal(loop.ok, true, JSON.stringify(loop)); return loop; };
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });

    // Nothing is set: the view says so; an agent cannot set a policy; the owner can, through the state API too.
    const ask = async (text: string) => { const out = await turn(`m-${text.length}-${Math.random()}`, text, [{ kind: "status", request: { kind: "qa_policy" }, evidence: text, basis: "owner" }]); assert.equal(out[0].status, "answered", JSON.stringify(out)); return (out[0].lines as { text: string }[]).map((l) => l.text).join("\n"); };
    assert.match(await ask("what are the review rules?"), /No review policy is set/);
    assert.equal((await call(ann.token, "qa.review.policy.set", { projectId: project, onSubmission: true }, "x1")).error.code, "forbidden");
    assert.equal((await call(ann.token, "qa.review.policy.get", { projectId: project })).result.isDefault, true, "an agent that reads the project's tasks may read the policy");

    // The model cannot add a check name, an interval, a source count or gating the owner did not say (card Q02 reviews): each is refused and nothing is proposed.
    const loose = "have QA look at the code regularly";
    for (const [k, args] of [{ requiredChecks: ["security"] }, { periodicMinutes: 60 }, { independentSources: 2 }, { onSubmission: true, gatesCompletion: true }].entries()) {
      const out = await turn(`m-loose-${k}`, loose, [{ kind: "command", op: "qa.review.policy.set", args, evidence: loose, basis: "owner" }]);
      assert.equal(out[0].status, "refused", JSON.stringify(out));
      assert.equal(out[0].code, "unsupported_value", JSON.stringify(out));
    }
    // Said in the owner's own words, each is proposed: "every two hours", "the security check", "two independent sources".
    const own = "review the newest code every two hours, require the security check, and want two independent sources for each check";
    const ownOut = await turn("m-own", own, [{ kind: "command", op: "qa.review.policy.set", args: { periodicMinutes: 120, requiredChecks: ["security"], independentSources: 2 }, evidence: own, basis: "owner" }]);
    assert.equal(ownOut[0].status, "proposed", JSON.stringify(ownOut));
    const hourly = "review the code hourly";
    assert.equal((await turn("m-hourly", hourly, [{ kind: "command", op: "qa.review.policy.set", args: { periodicMinutes: 60 }, evidence: hourly, basis: "owner" }]))[0].status, "proposed");

    // The owner says it in plain words: the change is shown first and applied on the owner's yes.
    const words = "have independent QA review every code change here, and nothing lands without that review";
    const proposed = await turn("m-set", words, [{ kind: "command", op: "qa.review.policy.set", args: { onSubmission: true, gatesCompletion: true }, evidence: words, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.equal((await call(O, "qa.review.policy.get", { projectId: project })).result.isDefault, true, "nothing is applied before the owner agrees");
    const yes = `yes, do it ${proposed[0].proposalId}`;
    const applied = await turn("m-yes", yes, [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: yes, basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const got = (await call(O, "qa.review.policy.get", { projectId: project })).result;
    assert.deepEqual([got.item.triggers.onSubmission, got.item.gatesCompletion, got.item.updatedBy], [true, true, rob.id]);
    assert.match(await ask("what are the review rules now?"), /A review starts on each new code submission.*gates landing/s);

    // Requiring citations (card Q02 leftovers): the model cannot add it unless the owner spoke of citing; in the owner's words it is shown first, applied on the yes, shown on the policy view and enforced on reviews.
    assert.equal((await turn("m-cite-loose", loose, [{ kind: "command", op: "qa.review.policy.set", args: { requireVerdictCitations: true }, evidence: loose, basis: "owner" }]))[0].code, "unsupported_value");
    const citeWords = "reviewers must cite the criteria version they judged against in every verdict";
    const citeProposed = await turn("m-cite", citeWords, [{ kind: "command", op: "qa.review.policy.set", args: { requireVerdictCitations: true }, evidence: citeWords, basis: "owner" }]);
    assert.equal(citeProposed[0].status, "proposed", JSON.stringify(citeProposed));
    assert.equal((await call(O, "qa.review.policy.get", { projectId: project })).result.item.requireVerdictCitations, false, "nothing is applied before the owner agrees");
    const citeYes = `yes ${citeProposed[0].proposalId}`;
    assert.equal((await turn("m-cite-yes", citeYes, [{ kind: "apply_proposal", proposalId: citeProposed[0].proposalId, evidence: citeYes, basis: "owner" }]))[0].status, "applied");
    assert.equal((await call(O, "qa.review.policy.get", { projectId: project })).result.item.requireVerdictCitations, true);
    assert.match(await ask("what are the review rules now?"), /verdict must cite the criteria version/);

    // Ann's attempt is running and she submits code: the regular round makes the review for Rev, not for Ann.
    now += 60_000;
    const sub = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree: "b".repeat(40), patchId: patch }, "code-1");
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const uncited = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: sub.result.id, verdict: "approve" }, "rv-uncited");
    assert.equal(uncited.error?.code, "invalid_command", JSON.stringify(uncited));
    assert.match(uncited.error.message, /requires a verdict to cite/);
    const cited = await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: sub.result.id, verdict: "changes", criteriaRevision: 0 }, "rv-cited");
    assert.equal(cited.ok, true, JSON.stringify(cited));
    const asgBefore = await s.assignments.getAssignment(task);
    const attemptBefore = await s.assignments.getAttempt(asgBefore!.activeAttemptId!);
    await round();
    const reqs = (await call(O, "qa.review.requests", { projectId: project })).result;
    assert.deepEqual(reqs.items.map((r: any) => [r.submissionId, r.trigger, r.assignee]), [[sub.result.id, "submission", rev.id]]);
    assert.equal((await call(rev.token, "qa.review.requests", { projectId: project })).result.total, 1, "the reviewer sees the one assigned to it");
    assert.equal((await call(ann.token, "qa.review.requests", { projectId: project })).result.total, 0, "the contributor sees none");
    const asgAfter = await s.assignments.getAssignment(task);
    const attemptAfter = await s.assignments.getAttempt(asgAfter!.activeAttemptId!);
    assert.deepEqual([asgAfter!.revision, asgAfter!.state, attemptAfter!.revision, attemptAfter!.state], [asgBefore!.revision, asgBefore!.state, attemptBefore!.revision, attemptBefore!.state], "the contributor's attempt keeps running, untouched");
    assert.equal(attemptAfter!.state, "active", "still the live attempt");
    assert.match(await ask("which reviews are scheduled?"), /scheduled review\(s\) open[\s\S]*a new code submission, assigned to/);
    // A second round makes nothing again.
    assert.equal((await call(O, "qa.review.sweep", {}, "sw1")).result.created, 0);
    await round();
    assert.equal((await call(O, "qa.review.requests", { projectId: project })).result.total, 1);
    assert.equal((await call(ann.token, "qa.review.sweep", {}, "sw2")).error.code, "forbidden");

    // The policy gates the QA gate too: a check it requires is missing until someone passes it.
    assert.ok((await call(O, "qa.review.policy.set", { projectId: project, requiredChecks: ["security"] }, "set2")).ok);
    const gate = (await call(O, "qa.evidence.gate", { submissionId: sub.result.id })).result.item;
    assert.deepEqual([gate.verdict, gate.required, gate.reasons], ["failed", ["security"], ["no_evidence", "check_missing"]]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
