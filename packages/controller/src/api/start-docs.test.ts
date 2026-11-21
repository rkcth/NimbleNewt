import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { CHAT_OPS } from "../chat/commands.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { NotificationService } from "../notifications/index.js";
import { STATUS_KINDS } from "../status/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40);
const treeA = "b".repeat(40);
const treeB = "d".repeat(40);
const patch = "c".repeat(40);
const ran = "2026-11-18T09:00:00.000Z";

test("documentation obligations through the running controller and the owner's chat: a document change is verified only against code whose QA gate passes, a behaviour change and a release open update tasks assigned to the document's owner (card Q03)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-docs-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the login" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (n: string, roles: string[], inProject: string) => {
      const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: id, action: "task.read", project: inProject, source: "direct", basis: "test" } as never);
      return { id, bare: made.id as string, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"], project);
    const quinn = await hire("Quinn", ["qa"], project);
    const dora = await hire("Dora", ["docs"], project);
    const far = await hire("Far", ["docs"], other);
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const code = async (tree: string, cid: string): Promise<string> => {
      const r = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, cid);
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.result.id as string;
    };
    const tested = async (sub: string, cid: string): Promise<void> => {
      const r = await call(quinn.token, "qa.evidence.record", { submissionId: sub, criteriaRevision: 0, environment: "Linux 6.8", observedAt: ran, checks: [{ name: "login works", result: "passed" }] }, cid);
      assert.equal(r.ok, true, JSON.stringify(r));
    };

    // The docs agent records the landing page: a claim must name the task behind it; another project's docs agent sees nothing.
    const promo = { projectId: project, title: "Landing page", location: "site/index.html", audience: "promotional", owner: dora.id, applicableVersion: "1.0", implementationRefs: [task], claims: [{ text: "Sign in with a passkey", taskId: task }] };
    assert.equal((await call(far.token, "doc.obligation.record", promo, "o0")).error.code, "not_found");
    assert.equal((await call(dora.token, "doc.obligation.record", { ...promo, claims: [{ text: "Works offline", taskId: "task-aaaaaaaaaaaaaaaaaaaa" }] }, "o0")).error.code, "invalid_command", "a claim no task of the document implements is unsupported");
    const rec = await call(dora.token, "doc.obligation.record", promo, "o1");
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const obligation = rec.result.id as string;

    // The docs role submits the document change (card Q01b); it is verified only against code whose QA gate passes.
    const document = await call(dora.token, "submission.record", { taskId: task, kind: "document", role: "docs", artifactDigest: `sha256:${"e".repeat(64)}` }, "doc1");
    assert.equal(document.ok, true, JSON.stringify(document));
    const sub1 = await code(treeA, "s1");
    const verify = { obligationId: obligation, expectedRevision: 1, documentSubmissionId: document.result.id, evidence: [sub1] };
    const untested = await call(dora.token, "doc.obligation.verify", verify, "v0");
    assert.equal(untested.error.code, "invalid_command");
    assert.match(untested.error.message, /unsupported: "Sign in with a passkey"/);
    // Independent QA evidence checks the documents by itself (Q03 next slice): the unverified page is flagged for that code with an update task for Dora, so the document change made before the flag no longer answers it.
    await tested(sub1, "q1");
    const auto1 = (await call(boot.token, "doc.obligation.get", { id: obligation })).result.item;
    assert.deepEqual([auto1.state, auto1.reasons[0].kind, auto1.reasons[0].submissionId, auto1.updates.length, auto1.updates[0].requestedBy], ["unverified", "behavior_changed", sub1, 1, "service:doc-checks"]);
    assert.equal((await s.assignments.getAssignment(auto1.updates[0].taskId))?.owner?.id, dora.bare);
    const early = await call(dora.token, "doc.obligation.verify", { ...verify, expectedRevision: auto1.revision }, "v1a");
    assert.match(early.error?.message ?? "", /before the document was flagged/, JSON.stringify(early));
    const document1 = await call(dora.token, "submission.record", { taskId: task, kind: "document", role: "docs", artifactDigest: `sha256:${"9".repeat(64)}` }, "doc1b");
    assert.equal(document1.ok, true, JSON.stringify(document1));
    const v1 = await call(dora.token, "doc.obligation.verify", { ...verify, expectedRevision: auto1.revision, documentSubmissionId: document1.result.id }, "v1");
    assert.equal(v1.ok, true, JSON.stringify(v1));
    assert.equal(v1.result.settled.length, 1);
    assert.deepEqual((await call(boot.token, "doc.obligation.get", { id: obligation })).result.item.verification.evidence.map((e: any) => [e.submissionId, e.tree]), [[sub1, treeA]]);

    // New tested code of the task: the page goes stale by itself; the owner still asks by chat which documents it affects (shown first: it hands work to Dora), which finds nothing new.
    const sub2 = await code(treeB, "s2");
    await tested(sub2, "q2");
    assert.equal((await call(boot.token, "doc.obligation.get", { id: obligation })).result.item.state, "stale", "flagged by the QA evidence itself");
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes as any[]; };
    const ask = "Fix the login has landed, which docs need updating?";
    const proposed = await turn("m1", ask, [{ kind: "command", op: "doc.impact.check", args: { taskTitle: "Fix the login" }, evidence: ask, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const stale = (await call(boot.token, "doc.obligation.get", { id: obligation })).result.item;
    assert.deepEqual([stale.state, stale.reasons[0].kind, stale.reasons[0].submissionId, stale.updates.length, stale.updates.filter((u: any) => u.state === "open").length], ["stale", "behavior_changed", sub2, 2, 1], "asking again flags nothing twice");
    const updateTask = stale.updates.find((u: any) => u.state === "open").taskId as string;
    const assignment = await s.assignments.getAssignment(updateTask);
    assert.equal(assignment?.owner?.id, dora.bare, "the update task is assigned to the document's owner");
    assert.match((await call(boot.token, "task.get", { taskId: updateTask })).result.item.description, new RegExp(sub2), "the update task links the tested code");

    // The owner reads the documents by chat; the line flags the stale page and its assigned update task.
    const q = "which docs are out of date?";
    const asked = await turn("m3", q, [{ kind: "status", request: { kind: "docs" }, evidence: q, basis: "owner" }]);
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    const text = (asked[0].lines as { text: string }[]).map((l) => l.text).join("\n");
    assert.match(text, /1 flagged \(1 stale, 0 unverified\)/);
    assert.match(text, new RegExp(`Promotional document "Landing page" .*FLAGGED: stale: task ${task} has new tested code \\(submission ${sub2}.*Claims: "Sign in with a passkey".*Update tasks open: ${updateTask} \\(assigned`));
    assert.equal((await call(far.token, "status.ask", { request: { kind: "docs", projectId: project } })).error.code, "not_found");

    // A release by chat (shown first): the document is flagged for the release version, and a verification must name it.
    const ship = "we are shipping 2.0, flag the docs";
    const rel = await turn("m4", ship, [{ kind: "command", op: "doc.release.check", args: { version: "2.0" }, evidence: ship, basis: "owner" }]);
    assert.equal(rel[0].status, "proposed", JSON.stringify(rel));
    assert.equal((await turn("m5", "yes, do that", [{ kind: "apply_proposal", proposalId: rel[0].proposalId, evidence: "do that", basis: "owner" }]))[0].status, "applied");
    const flagged = (await call(boot.token, "doc.obligation.get", { id: obligation })).result.item;
    assert.deepEqual([flagged.releaseVersion, flagged.updates.length], ["2.0", 3]);
    const before = await call(dora.token, "doc.obligation.verify", { obligationId: obligation, expectedRevision: flagged.revision, documentSubmissionId: document.result.id, evidence: [sub2], applicableVersion: "2.0" }, "v2a");
    assert.equal(before.error?.code, "invalid_command", JSON.stringify(before));
    assert.match(before.error.message, /before the document was flagged/, "the document change made before the flag does not answer it");
    const updated = await call(dora.token, "submission.record", { taskId: task, kind: "document", role: "docs", artifactDigest: `sha256:${"f".repeat(64)}` }, "doc2");
    assert.equal(updated.ok, true, JSON.stringify(updated));
    const v2 = await call(dora.token, "doc.obligation.verify", { obligationId: obligation, expectedRevision: flagged.revision, documentSubmissionId: updated.result.id, evidence: [sub2], applicableVersion: "2.0" }, "v2");
    assert.equal(v2.ok, true, JSON.stringify(v2));
    assert.equal(v2.result.settled.length, 2);
    assert.equal((await call(boot.token, "doc.obligation.list", { projectId: project })).result.items[0].state, "verified");

    // The owner ties a document to the work by chat: shown first (it names the agent who will get its update tasks); the title, place and version are the owner's words.
    const tie = "the user guide in docs/guide.md describes Fix the login, Dora keeps it, it is for version 2.0";
    const guideArgs = { title: "user guide", location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "2.0", implementationRefs: [task] };
    assert.equal((await turn("m6", tie, [{ kind: "command", op: "doc.obligation.record", args: { ...guideArgs, applicableVersion: "3.0" }, evidence: tie, basis: "owner" }]))[0].status, "refused", "a version the owner did not say is not recorded");
    const tied = await turn("m7", tie, [{ kind: "command", op: "doc.obligation.record", args: guideArgs, evidence: tie, basis: "owner" }]);
    assert.equal(tied[0].status, "proposed", JSON.stringify(tied));
    assert.equal((await turn("m8", "yes, do that", [{ kind: "apply_proposal", proposalId: tied[0].proposalId, evidence: "do that", basis: "owner" }]))[0].status, "applied");
    const both = (await call(boot.token, "doc.obligation.list", { projectId: project })).result.items;
    assert.deepEqual(both.map((i: any) => [i.title, i.audience, i.state, i.recordedBy]), [["Landing page", "promotional", "verified", dora.id], ["user guide", "user", "unverified", rob.id]]);

    // Every owner control of the card is a chat command, and the view is a status kind of the project in focus.
    for (const op of ["doc.obligation.record", "doc.obligation.verify", "doc.impact.check", "doc.release.check"]) assert.ok(CHAT_OPS[op], op);
    assert.deepEqual(STATUS_KINDS["docs"]?.keys, ["projectId"]);

    // The task's acceptance criteria change: the QA check invalidates the evidence, and the verified page is flagged by itself as having lost it (Q03 next slice), with an update task for Dora.
    const set = await call(boot.token, "contract.set", { taskId: task, expectedVersion: 0, acceptanceCriteria: ["a user can log in with a passkey"] }, "c1");
    assert.equal(set.ok, true, JSON.stringify(set));
    const inval = await call(quinn.token, "qa.evidence.check", { taskId: task }, "k1");
    assert.equal(inval.ok, true, JSON.stringify(inval));
    assert.ok(inval.result.invalidated.length >= 1);
    const lost = (await call(boot.token, "doc.obligation.get", { id: obligation })).result.item;
    assert.deepEqual([lost.state, lost.reasons.map((r: any) => [r.kind, r.submissionId])], ["stale", [["evidence_lost", sub2]]]);
    const lostTask = lost.updates.find((u: any) => u.state === "open");
    assert.equal(lostTask.requestedBy, "service:doc-checks");
    assert.equal((await s.assignments.getAssignment(lostTask.taskId))?.owner?.id, dora.bare);

    // The owner is told by a notice (not a needs-you item) each time verified documents went stale on a check the owner did not run: new tested code, then lost evidence (Q03 leftover).
    const inbox = await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob);
    const told = inbox.items.filter((i) => i.ref.kind === "doc-obligation" && i.ref.id === obligation);
    assert.ok(told.length >= 1, JSON.stringify(inbox.items.map((i) => [i.ref, i.detail])));
    assert.ok(told.every((i) => i.level === "notice" && i.projectId === project), JSON.stringify(told));
    assert.ok(told.some((i) => /A verified document went stale: "Landing page"/.test(i.detail ?? "")), JSON.stringify(told.map((i) => i.detail)));

    // The owner takes the landing page away by chat (shown first, pinned to the revision shown; the reason in the owner's own words): it leaves the docs, and Dora's open update task is cancelled.
    assert.ok(CHAT_OPS["doc.obligation.retire"]);
    const drop = "we deleted the landing page, stop tracking it";
    assert.equal((await turn("m9", drop, [{ kind: "command", op: "doc.obligation.retire", args: { obligationId: obligation, reason: "replaced by the new site" }, evidence: drop, basis: "owner" }]))[0].status, "refused", "a reason the owner did not give is refused");
    const retiring = await turn("m10", drop, [{ kind: "command", op: "doc.obligation.retire", args: { obligationId: obligation, reason: "we deleted the landing page" }, evidence: drop, basis: "owner" }]);
    assert.equal(retiring[0].status, "proposed", JSON.stringify(retiring));
    // The proposal names the document by its title and place, not only by its ID, and says its open update task goes with it (first review).
    assert.ok((retiring[0].preview as string[]).some((l) => /Takes away "Landing page" \(dob-[a-z2-7]+\) at "site\/index.html", kept by agent:\S+; its 1 open update task is cancelled unless already started/.test(l)), JSON.stringify(retiring[0].preview));
    const retired = await turn("m11", "yes, do that", [{ kind: "apply_proposal", proposalId: retiring[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(retired[0].status, "applied", JSON.stringify(retired));
    const gone = (await call(boot.token, "doc.obligation.get", { id: obligation })).result.item;
    assert.deepEqual([gone.retired.by, gone.retired.reason, gone.updates.filter((u: any) => u.state === "open").length], [rob.id, "we deleted the landing page", 0]);
    assert.equal((await call(boot.token, "task.get", { taskId: lostTask.taskId })).result.item.state, "cancelled");
    assert.deepEqual((await call(boot.token, "doc.obligation.list", { projectId: project })).result.items.map((i: any) => i.title), ["user guide"]);
    // Asked again by chat: answered at once, nothing proposed.
    const twice = await turn("m13", drop, [{ kind: "command", op: "doc.obligation.retire", args: { obligationId: obligation, reason: "we deleted the landing page" }, evidence: drop, basis: "owner" }]);
    assert.equal(twice[0].status, "refused", JSON.stringify(twice));
    assert.match(String(twice[0].message ?? JSON.stringify(twice[0])), /already taken away/);
    const docsNow = await turn("m12", q, [{ kind: "status", request: { kind: "docs" }, evidence: q, basis: "owner" }]);
    assert.doesNotMatch((docsNow[0].lines as { text: string }[]).map((l) => l.text).join("\n"), /Landing page/);
    // Through the state API: a retired document is neither verified nor retired again; an agent outside the docs and director roles may not retire.
    assert.equal((await call(dora.token, "doc.obligation.verify", { obligationId: obligation, expectedRevision: gone.revision, documentSubmissionId: updated.result.id, evidence: [sub2] }, "v9")).error.code, "invalid_command");
    const guideId = both[1].id as string;
    assert.equal((await call(quinn.token, "doc.obligation.retire", { obligationId: guideId, expectedRevision: both[1].revision }, "x1")).error.code, "forbidden");
    // Not from a task credential, even one of a docs agent of the project.
    const { OPERATION_BY_NAME } = await import("./operations.js");
    const scoped = { principal: { id: dora.id, kind: "agent", name: "Dora", grants: [], taskScope: { taskId: task, projectId: project } }, docObligations: { retire: async () => assert.fail("a task credential reached the service") } } as never;
    await assert.rejects(() => OPERATION_BY_NAME.get("doc.obligation.retire")!.run(scoped, { obligationId: guideId, expectedRevision: both[1].revision }, "x0"), (e: any) => e.code === "forbidden" && /task credential/.test(e.message));
    const byDora = await call(dora.token, "doc.obligation.retire", { obligationId: guideId, expectedRevision: both[1].revision }, "x2");
    assert.equal(byDora.ok, true, JSON.stringify(byDora));
    assert.deepEqual((await call(boot.token, "doc.obligation.list", { projectId: project })).result.items, []);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
