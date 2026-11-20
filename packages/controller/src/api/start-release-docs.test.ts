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
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);
const manifest = (commit: string) => ({ sourceCommit: commit.repeat(40), suiteRevision: "suite-7", artifacts: { "garden.tgz": H1 }, dependencyLocks: { "package-lock.json": H2 }, matrix: [{ os: "linux", arch: "x64" }] });

test("a release candidate submitted with its project and version flags that project's documents by itself, through the state API and the owner's chat (card Q03, next slice)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-release-docs-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Fix the login" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const made = await s.agents.create(rob, { commandId: "mk-dora", friendlyName: "Dora", roles: ["docs"] });
    const dora = `agent:${made.id}`;
    await s.grants.grant(rob, { commandId: "g-dora", grantee: dora, action: "task.read", project, source: "direct", basis: "test" } as never);
    const rec = await call(boot.token, "doc.obligation.record", { projectId: project, title: "user guide", location: "docs/guide.md", audience: "user", owner: dora, applicableVersion: "1.0", implementationRefs: [task] }, "o1");
    assert.equal(rec.ok, true, JSON.stringify(rec));
    const guide = rec.result.id as string;
    const otherDoc = await call(boot.token, "doc.obligation.record", { projectId: other, title: "orchard notes", location: "notes.md", audience: "developer", owner: dora, applicableVersion: "1.0", implementationRefs: [(await s.projects.createTask({ commandId: "t2", actor: rob.id, projectId: other, title: "Prune" })).id] }, "o2");
    assert.equal(otherDoc.ok, false, "Dora may not read the other project, so she cannot keep its documents");

    // Submitted with the project and version: the candidate is recorded and the project's documents for another version are flagged, each with an update task assigned to its keeper.
    const sub = await call(boot.token, "release.submit", { manifest: manifest("a"), projectId: project, version: "2.0" }, "rs1");
    assert.equal(sub.ok, true, JSON.stringify(sub));
    assert.deepEqual([sub.result.docs.flagged, sub.result.docs.byAudience.user, sub.result.docs.tasks.length, sub.result.docs.tasks[0].assigned, sub.result.docs.replayed], [[guide], 1, 1, true, false]);
    const flagged = (await call(boot.token, "doc.obligation.get", { id: guide })).result.item;
    assert.deepEqual([flagged.state, flagged.releaseVersion, flagged.updates.length], ["unverified", "2.0", 1]);
    assert.equal((await s.assignments.getAssignment(flagged.updates[0].taskId))?.owner?.id, made.id);
    // The same command again, and the same candidate submitted again, run the same documentation check: nothing twice.
    const again = await call(boot.token, "release.submit", { manifest: manifest("a"), projectId: project, version: "2.0" }, "rs1");
    assert.deepEqual([again.result.replayed, again.result.docs.replayed, again.result.docs.flagged], [true, true, []]);
    const resubmitted = await call(boot.token, "release.submit", { manifest: manifest("a"), projectId: project, version: "2.0" }, "rs2");
    assert.deepEqual([resubmitted.result.candidateId, resubmitted.result.docs.replayed], [sub.result.candidateId, true]);
    assert.equal((await call(boot.token, "doc.obligation.get", { id: guide })).result.item.updates.length, 1);
    // A command ID used with another version is another command; without a project the candidate is submitted alone.
    assert.equal((await call(boot.token, "release.submit", { manifest: manifest("a"), projectId: project, version: "2.1" }, "rs1")).error.code, "command_conflict");
    const alone = await call(boot.token, "release.submit", { manifest: manifest("b") }, "rs3");
    assert.deepEqual([alone.ok, alone.result.docs], [true, undefined]);
    assert.equal((await call(boot.token, "release.submit", { manifest: manifest("c"), version: "2.0" }, "rs4")).error.code, "invalid_command");

    // By chat, in the owner's own words: the project by name and the version are shown first with the candidate, and applied only on the owner's word.
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: other });
    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes as any[]; };
    const words = `Get build ${"d".repeat(40)} tested, this is Garden 3.0: suite revision suite-7, artifact garden.tgz ${H1}, lock file package-lock.json ${H2}, on linux x64.`;
    const cmd = (args: Record<string, unknown>) => ({ kind: "command", op: "release.submit", args, evidence: words, basis: "owner" });
    const wrong = await turn("m1", words, [cmd({ manifest: manifest("d"), projectName: "Garden", version: "3.1" })]);
    assert.equal(wrong[0].status, "refused", JSON.stringify(wrong));
    const shown = await turn("m2", words, [cmd({ manifest: manifest("d"), projectName: "Garden", version: "3.0" })]);
    assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
    assert.match(JSON.stringify(shown[0]), /Garden/);
    assert.match(JSON.stringify(shown[0]), /3\.0/);
    assert.equal((await call(boot.token, "doc.obligation.get", { id: guide })).result.item.releaseVersion, "2.0", "nothing changes before the owner agrees");
    const applied = await turn("m3", "yes, go ahead", [{ kind: "apply_proposal", proposalId: shown[0].proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const after = (await call(boot.token, "doc.obligation.get", { id: guide })).result.item;
    assert.equal(after.releaseVersion, "3.0", "the newer release is what the document must now be verified for");
    assert.equal(after.updates.filter((u: any) => u.state === "open").length, 1, "one open update task per subject");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
