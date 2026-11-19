import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40);
const treeA = "b".repeat(40);
const treeB = "d".repeat(40);
const patch = "c".repeat(40);
const ran = "2026-11-18T09:00:00.000Z";
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

test("the owner's chat verifies a document (card Q03b): the docs view lists the document changes made since the flag, \"verify the user guide\" proposes the one shown, asks when several fit and says so when none does", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-docs-verify-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the login" })).id;
    const elsewhere = (await s.projects.createTask({ commandId: "t2", actor: rob.id, projectId: other, title: "Prune" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (n: string, roles: string[], inProjects: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
      const id = `agent:${made.id}`;
      for (const p of inProjects) await s.grants.grant(rob, { commandId: `g-${n}-${p}`, grantee: id, action: "task.read", project: p, source: "direct", basis: "test" } as never);
      return { id, bare: made.id as string, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"], [project]);
    const quinn = await hire("Quinn", ["qa"], [project]);
    const dora = await hire("Dora", ["docs"], [project, other]);
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
    // Record times are whole milliseconds: a short pause keeps "made since the flag" about real order.
    const docChange = async (taskId: string, c: string, cid: string): Promise<string> => {
      await wait(5);
      const r = await call(dora.token, "submission.record", { taskId, kind: "document", role: "docs", artifactDigest: `sha256:${c.repeat(64)}` }, cid);
      assert.equal(r.ok, true, JSON.stringify(r));
      await wait(5);
      return r.result.id as string;
    };

    // The user guide is tied to the login task and verified once against tested code (by the docs agent, through the state API).
    const rec = await call(dora.token, "doc.obligation.record", { projectId: project, title: "user guide", location: "docs/guide.md", audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: [task] }, "o1");
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const guide = rec.result.id as string;
    const old = await docChange(task, "e", "doc0");
    const sub1 = await code(treeA, "s1");
    await tested(sub1, "q1");
    assert.equal((await call(dora.token, "doc.obligation.verify", { obligationId: guide, expectedRevision: 1, documentSubmissionId: old, evidence: [sub1] }, "v1")).ok, true);
    // A document change in another project is never offered for this one.
    await docChange(elsewhere, "9", "docX");

    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })) as any; };
    const docsView = async (mid: string): Promise<string> => {
      const q = "how are the docs?";
      const asked = (await turn(mid, q, [{ kind: "status", request: { kind: "docs" }, evidence: q, basis: "owner" }])).outcomes;
      assert.equal(asked[0].status, "answered", JSON.stringify(asked));
      return (asked[0].lines as { text: string }[]).map((l) => l.text).join("\n");
    };
    const verifyText = "verify the user guide";
    const verifyIntent = [{ kind: "command", op: "doc.obligation.verify", args: { obligationId: guide }, evidence: verifyText, basis: "owner" }];

    // Verified and not flagged: nothing to verify, and the view lists no document changes for it.
    assert.doesNotMatch(await docsView("m0"), /To verify:/);
    const nothing = (await turn("m1", verifyText, verifyIntent)).outcomes;
    assert.equal(nothing[0].status, "refused", JSON.stringify(nothing));
    assert.match(nothing[0].message, /already verified/);

    // New tested code flags the guide (the owner asks by chat; shown first, then applied).
    const sub2 = await code(treeB, "s2");
    await tested(sub2, "q2");
    await wait(5);
    const ask = "Fix the login has landed, which docs need updating?";
    const proposed = (await turn("m2", ask, [{ kind: "command", op: "doc.impact.check", args: { taskTitle: "Fix the login" }, evidence: ask, basis: "owner" }])).outcomes;
    assert.equal((await turn("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "do that", basis: "owner" }])).outcomes[0].status, "applied");
    const flaggedAt = (await call(boot.token, "doc.obligation.get", { id: guide })).result.item.flaggedAt as string;
    assert.ok(typeof flaggedAt === "string");

    // None made since the flag: the view says the keeper must submit the updated document, and the chat says so instead of proposing.
    const none = await docsView("m4");
    assert.match(none, new RegExp(`User document "user guide".*FLAGGED: stale.*To verify: no document change of this project since it was flagged at ${flaggedAt.replace(/\./g, "\\.")} that you may read.*code ${sub2} \\(${task}\\)`));
    assert.doesNotMatch(none.slice(none.indexOf("To verify:")), new RegExp(old), "the change made before the flag is not offered");
    const told = (await turn("m5", verifyText, verifyIntent)).outcomes;
    assert.equal(told[0].status, "refused", JSON.stringify(told));
    assert.match(told[0].message, new RegExp(`No document change of this project made since it was flagged.*${dora.id}.*submits the updated document first`));
    // An ID the view did not list and the owner did not write is refused before anything is shown.
    const made = (await turn("m6", verifyText, [{ kind: "command", op: "doc.obligation.verify", args: { obligationId: guide, documentSubmissionId: old }, evidence: verifyText, basis: "owner" }])).outcomes;
    assert.equal(made[0].status, "refused", JSON.stringify(made));
    assert.match(made[0].message, /is not a document change the docs view lists/);

    // One made since the flag: the view lists it, and "verify the user guide" proposes it (with the flagged code), shown first; applied, the guide is verified.
    const fresh = await docChange(task, "f", "doc1");
    const one = await docsView("m7");
    assert.match(one, new RegExp(`To verify: one document change of this project since it was flagged at [^:]+:\\d\\d:\\d\\d\\.\\d+Z, newest first: ${fresh} \\(task ${task}, by ${dora.id.replace(/[.:]/g, "\\$&")}`));
    const verify = (await turn("m8", verifyText, verifyIntent)).outcomes;
    assert.equal(verify[0].status, "proposed", JSON.stringify(verify));
    const preview = (verify[0].preview as string[]).join("\n");
    assert.match(preview, new RegExp(`Document change ${fresh}`));
    assert.match(preview, new RegExp(`code ${sub2} of ${task}`));
    assert.equal((await call(boot.token, "doc.obligation.get", { id: guide })).result.item.state, "stale", "nothing is verified before the owner says yes");
    const applied = (await turn("m9", "yes, do that", [{ kind: "apply_proposal", proposalId: verify[0].proposalId, evidence: "do that", basis: "owner" }])).outcomes;
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const after1 = (await call(boot.token, "doc.obligation.get", { id: guide })).result.item;
    assert.deepEqual([after1.state, after1.verification.documentSubmissionId, after1.verification.evidence[0].submissionId], ["verified", fresh, sub2]);

    // A release flags it again; two document changes since: the chat asks which, and the owner's answer carries the verification on (with the release's version filled in).
    const ship = "we are shipping 2.0, flag the docs";
    const rel = (await turn("m10", ship, [{ kind: "command", op: "doc.release.check", args: { version: "2.0" }, evidence: ship, basis: "owner" }])).outcomes;
    assert.equal((await turn("m11", "yes, do that", [{ kind: "apply_proposal", proposalId: rel[0].proposalId, evidence: "do that", basis: "owner" }])).outcomes[0].status, "applied");
    const draft = await docChange(task, "1", "doc2");
    const final = await docChange(task, "2", "doc3");
    const two = await docsView("m12");
    assert.match(two, new RegExp(`To verify: 2 document changes of this project since it was flagged at [^,]+, newest first: ${final} .*; ${draft} .*code ${sub2} \\(${task}\\), for version "2\\.0"`));
    const which = await turn("m13", verifyText, verifyIntent);
    assert.equal(which.outcomes[0].status, "asked", JSON.stringify(which.outcomes));
    assert.match(which.outcomes[0].question, /2 document changes of this project made since it was flagged .* could verify "user guide"/);
    assert.deepEqual((which.outcomes[0].options as string[]).map((o) => o.split(":")[0]), [final, draft]);
    const answer = "the newer one";
    const picked = (await turn("m14", answer, [{ kind: "answer", turnId: which.turnId, choice: final, evidence: answer, basis: "owner" }])).outcomes;
    const shown = picked.find((o: any) => o.status === "proposed");
    assert.ok(shown, JSON.stringify(picked));
    assert.match((shown.preview as string[]).join("\n"), /For version "2\.0": the release that flagged it/);
    assert.equal((await turn("m15", "yes, do that", [{ kind: "apply_proposal", proposalId: shown.proposalId, evidence: "do that", basis: "owner" }])).outcomes[0].status, "applied");
    const after2 = (await call(boot.token, "doc.obligation.get", { id: guide })).result.item;
    assert.deepEqual([after2.state, after2.applicableVersion, after2.verification.documentSubmissionId], ["verified", "2.0", final]);

    // The same list through the state API: newest first, this project only, and an agent sees only its own.
    const listed = await call(boot.token, "submission.documents", { projectId: project });
    assert.equal(listed.ok, true, JSON.stringify(listed));
    assert.deepEqual(listed.result.items.map((x: any) => x.id), [final, draft, fresh, old]);
    assert.deepEqual((await call(boot.token, "submission.documents", { projectId: project, since: flaggedAt })).result.items.map((x: any) => x.id), [final, draft, fresh]);
    assert.deepEqual((await call(ann.token, "submission.documents", { projectId: project })).result.items, [], "an author reads no one else's document changes");
    assert.equal((await call(quinn.token, "submission.documents", { projectId: other })).error.code, "not_found");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
