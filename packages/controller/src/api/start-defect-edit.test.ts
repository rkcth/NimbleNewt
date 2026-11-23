import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { CommandRunner } from "../domain/runner.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("through the running controller an unfinished defect's finding and severity are corrected by its reporter through the state API or by the owner in chat, shown first, pinned to the revision, and visible in the defects view (card Q04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-defect-edit-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") }, chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const other = (await s.projects.createProject({ commandId: "p2", actor: rob.id, name: "Orchard" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Write the guide" })).id;
    const hire = async (n: string, roles: string[], inProject: string) => {
      const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: id, action: "task.read", project: inProject, source: "direct", basis: "test" } as never);
      if (roles.includes("reviewer")) await s.grants.grant(rob, { commandId: `gr-${n}`, grantee: id, action: "review.decide", project: inProject, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const ann = await hire("Ann", ["author", "docs"], project);
    const rev = await hire("Rev", ["reviewer"], project);
    const far = await hire("Far", ["reviewer"], other);
    const artifacts = ArtifactService.withEpoch(c.storage, c.epoch, await FileBlobStore.open({ directory: join(d, "blobs") }));
    const art = (await artifacts.publish({ commandId: "a1", actor: rob.id, name: "guide", projectId: project, taskId: task, files: [{ path: "guide.txt", content: Buffer.from("step 1") }] })).id;
    await s.configuration.change(rob, { commandId: "cfg", layer: "project", scopeId: project, expectedRevision: 0, set: { "review.repairCycles": 1 } } as never);

    const made = await call(ann.token, "deliverable.draft", { taskId: task, type: "document", title: "Install guide", artifacts: [{ artifactId: art }] }, "d1");
    const id = made.result.id as string;
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: made.result.revision, contractVersion: 0 }, "s1")).ok);
    assert.ok((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "r1")).ok);
    assert.ok((await call(rev.token, "deliverable.reject", { id, version: 1, reason: "the backup step is missing" }, "j1")).ok);

    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes as any[]; };
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
    const state = async (x: string) => (await call(boot.token, "defect.get", { id: x })).result.item;
    const risks = async () => (await call(boot.token, "status.ask", { request: { kind: "defect_risks", projectId: project } })).result.item.lines.map((l: any) => l.text) as string[];
    const report = async (finding: string, severity: string, commandId: string): Promise<string> => (await call(rev.token, "defect.report", { deliverableId: id, version: 1, finding, severity }, commandId)).result.id as string;
    const a = await report("The guide skips the backup step.", "major", "f1");
    const b = await report("A typo in step 1.", "minor", "f2");
    const lines = async (): Promise<string> => (await call(boot.token, "status.ask", { request: { kind: "defects", taskId: task } })).result.item.lines.map((l: any) => l.text).join("\n");
    assert.ok(!(await lines()).includes("Edited"), "an unedited defect says nothing about edits");

    // The state API: the reporter corrects its own report; the responsible agent, another project's agent and a client of no standing cannot, and a refused call changes nothing.
    assert.equal((await call(ann.token, "defect.edit", { id: a, severity: "minor" }, "e0")).error.code, "forbidden");
    assert.equal((await call(far.token, "defect.edit", { id: a, severity: "minor" }, "e1")).error.code, "not_found");
    assert.equal((await call(rev.token, "defect.edit", { id: a, extra: 1 }, "e2")).error.code, "invalid_command");
    assert.equal((await call(rev.token, "defect.edit", { id: a }, "e3")).error.code, "invalid_command");
    assert.equal((await state(a)).revision, 1);
    // Reading the views creates and changes nothing.
    await lines(); await risks(); await call(boot.token, "defect.list", { deliverableId: id });
    assert.equal((await state(a)).revision, 1);
    const done = await call(rev.token, "defect.edit", { id: a, finding: "The guide skips the restore step.", reason: "wrong step named", expectedRevision: 1 }, "e4");
    assert.ok(done.ok, JSON.stringify(done));
    assert.deepEqual([(await state(a)).revision, (await state(a)).finding.text, (await state(a)).edits.length], [2, "The guide skips the restore step.", 1]);
    assert.equal((await call(rev.token, "defect.edit", { id: a, finding: "The guide skips the restore step.", reason: "wrong step named", expectedRevision: 1 }, "e4")).result.replayed, true);
    assert.equal((await state(a)).edits.length, 1);
    // The owner sees it in the defects view: how many edits, by whom last, and the finding as now written.
    let shown = await lines();
    assert.ok(shown.includes(`Finding: "The guide skips the restore step.". Edited 1 time(s), last by ${rev.id}. No repair`), shown);

    // Chat: the owner corrects the severity in their own words. The stand-in hands over a severity the owner did say, the model's stale revision (1) is replaced by the one listed, and nothing applies before "yes".
    const sev = "the typo defect is not minor, it is major, change it";
    const sevTurn = await turn("m-0", sev, [{ kind: "command", op: "defect.edit", args: { id: b, severity: "major", expectedRevision: 9 }, evidence: sev, basis: "owner" }]);
    assert.equal(sevTurn[0].status, "proposed", JSON.stringify(sevTurn));
    assert.equal((await state(b)).severity, "minor", "nothing changed yet");
    // The reporter changes the same defect meanwhile: the owner's "yes" is stale and applies nothing to it.
    assert.ok((await call(rev.token, "defect.edit", { id: b, finding: "A typo in step 2." }, "e5")).ok);
    const late = await turn("m-1", "yes, do that", [{ kind: "apply_proposal", proposalId: sevTurn[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.notEqual(late[0].status, "applied", JSON.stringify(late));
    assert.deepEqual([(await state(b)).severity, (await state(b)).edits.length], ["minor", 1]);
    // Said again, shown again at the new revision, applied.
    const again = await turn("m-2", sev, [{ kind: "command", op: "defect.edit", args: { id: b, severity: "major" }, evidence: sev, basis: "owner" }]);
    assert.equal(again[0].status, "proposed", JSON.stringify(again));
    const yes = await turn("m-3", "yes, do that", [{ kind: "apply_proposal", proposalId: again[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(yes[0].status, "applied", JSON.stringify(yes));
    assert.deepEqual([(await state(b)).severity, (await state(b)).finding.text, (await state(b)).edits.map((e: any) => [e.by, e.previousSeverity ?? null, e.previousFinding ?? null])], ["major", "A typo in step 2.", [[rev.id, null, "A typo in step 1."], [rob.id, "minor", null]]]);

    // Chat: a finding the owner did not say is refused (the stand-in invents text), so is an invented reason; the owner's own words for both are proposed and applied.
    const words = "the backup defect should say: the guide never mentions the restore command; I looked again and the old text was wrong";
    const invented = await turn("m-4", words, [{ kind: "command", op: "defect.edit", args: { id: a, finding: "The guide is hopelessly wrong everywhere." }, evidence: words, basis: "owner" }]);
    assert.notEqual(invented[0].status, "proposed", JSON.stringify(invented));
    const inventedReason = await turn("m-5", words, [{ kind: "command", op: "defect.edit", args: { id: a, finding: "the guide never mentions the restore command", reason: "the author asked me to" }, evidence: words, basis: "owner" }]);
    assert.notEqual(inventedReason[0].status, "proposed", JSON.stringify(inventedReason));
    const unknown = await turn("m-6", words, [{ kind: "command", op: "defect.edit", args: { id: "dft-aaaaaaaaaaaaaaaaaaaa", finding: "the guide never mentions the restore command" }, evidence: words, basis: "owner" }]);
    assert.notEqual(unknown[0].status, "proposed", JSON.stringify(unknown));
    assert.equal((await state(a)).edits.length, 1, "none of the refused turns applied");
    const own = await turn("m-7", words, [{ kind: "command", op: "defect.edit", args: { id: a, finding: "the guide never mentions the restore command", reason: "I looked again and the old text was wrong" }, evidence: words, basis: "owner" }]);
    assert.equal(own[0].status, "proposed", JSON.stringify(own));
    assert.equal((await turn("m-8", "go ahead", [{ kind: "apply_proposal", proposalId: own[0].proposalId, evidence: "go ahead", basis: "owner" }]))[0].status, "applied");
    const owned = await state(a);
    assert.deepEqual([owned.finding.text, owned.edits.length, owned.edits[1].by, owned.edits[1].reason, owned.state, owned.cycles], ["the guide never mentions the restore command", 2, rob.id, "I looked again and the old text was wrong", "open", 0]);
    shown = await lines();
    assert.ok(shown.includes(`Finding: "the guide never mentions the restore command". Edited 2 time(s), last by ${rob.id}. No repair`), shown);
    assert.ok(shown.includes(`Defect ${b} (major, found in version 1): open, waiting for a repair; 0 of 1 repair and review cycles used. Finding: "A typo in step 2.". Edited 2 time(s), last by ${rob.id}; reported as minor.`), shown);

    // A defect that escalated waits for the owner; the reporter can no longer correct it, the owner can, in chat, and it stays escalated with its failed check.
    const cur = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur.revision, artifacts: [{ artifactId: art }] }, "n2");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv.result.revision, contractVersion: 0 }, "s2")).ok);
    assert.ok((await call(ann.token, "defect.repair", { id: a, version: 2 }, "rp1")).ok);
    assert.ok((await call(rev.token, "defect.review", { id: a, verdict: "not-fixed", reason: "still missing" }, "rv1")).ok);
    assert.equal((await state(a)).state, "escalated");
    assert.equal((await call(rev.token, "defect.edit", { id: a, severity: "minor" }, "e6")).error.code, "forbidden");
    const esc = "that backup defect is critical, make it critical";
    const escTurn = await turn("m-9", esc, [{ kind: "command", op: "defect.edit", args: { id: a, severity: "critical" }, evidence: esc, basis: "owner" }]);
    assert.equal(escTurn[0].status, "proposed", JSON.stringify(escTurn));
    // A "yes" inside a longer message is not the owner's agreement; a message that is only "Yes." is (the guide: say yes in any words). A message that is only "no" drops a proposal.
    const partial = await turn("m-9b", "yes, but first tell me who reported it", [{ kind: "apply_proposal", proposalId: escTurn[0].proposalId, evidence: "yes", basis: "owner" }]);
    assert.deepEqual([partial[0].status, partial[0].code], ["refused", "untrusted_authority"], JSON.stringify(partial));
    assert.equal((await state(a)).severity, "major", "nothing applied");
    const minorTurn = await turn("m-9c", "make the backup defect minor", [{ kind: "command", op: "defect.edit", args: { id: a, severity: "minor" }, evidence: "make the backup defect minor", basis: "owner" }]);
    assert.equal(minorTurn[0].status, "proposed", JSON.stringify(minorTurn));
    // A message that is only "no" or only "yes" names no proposal: while more than one is open (the stale one of m-0, the critical and the minor one) the owner is asked which, and nothing is done.
    const status = async (p: string) => (await c.chat!.getProposal(boot.token, p))?.status;
    assert.deepEqual([await status(sevTurn[0].proposalId), await status(escTurn[0].proposalId), await status(minorTurn[0].proposalId)], ["open", "open", "open"]);
    const unclearNo = await turn("m-9d", "No", [{ kind: "discard_proposal", proposalId: minorTurn[0].proposalId, evidence: "no", basis: "owner" }]);
    assert.equal(unclearNo[0].status, "asked", JSON.stringify(unclearNo));
    assert.ok(unclearNo[0].options.some((o: string) => o.startsWith(`${escTurn[0].proposalId}: `)) && unclearNo[0].options.some((o: string) => o.startsWith(`${minorTurn[0].proposalId}: `)), JSON.stringify(unclearNo));
    assert.equal(await status(minorTurn[0].proposalId), "open", "nothing dropped");
    const oldDropped = await turn("m-9e", "drop the old typo change", [{ kind: "discard_proposal", proposalId: sevTurn[0].proposalId, evidence: "drop the old typo change", basis: "owner" }]);
    assert.equal(oldDropped[0].status, "discarded", JSON.stringify(oldDropped));
    const unclearYes = await turn("m-9f", "Yes.", [{ kind: "apply_proposal", proposalId: escTurn[0].proposalId, evidence: "yes", basis: "owner" }]);
    assert.equal(unclearYes[0].status, "asked", JSON.stringify(unclearYes));
    assert.equal((await state(a)).severity, "major", "nothing applied while two are open");
    // A message that is wholly quoted material has no words of the owner's own and is not read at all.
    await assert.rejects(c.chat!.submit(boot.token, { messageId: "m-9q", text: "> yes" }), (e: any) => e.code === "invalid_command");
    const dropped = await turn("m-9g", "drop the minor change", [{ kind: "discard_proposal", proposalId: minorTurn[0].proposalId, evidence: "drop the minor change", basis: "owner" }]);
    assert.equal(dropped[0].status, "discarded", JSON.stringify(dropped));
    // With exactly one open, "Yes." agrees to it.
    const escYes = await turn("m-10", "Yes.", [{ kind: "apply_proposal", proposalId: escTurn[0].proposalId, evidence: "yes", basis: "owner" }]);
    assert.equal(escYes[0].status, "applied", JSON.stringify(escYes));
    const escalated = await state(a);
    assert.deepEqual([escalated.state, escalated.severity, escalated.cycles, escalated.checks.map((x: any) => x.verdict), escalated.edits.length], ["escalated", "critical", 1, ["not-fixed"], 3]);
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.count, 1, "still on the Needs-you list");
    // With exactly one open, a message that is only "no" drops it.
    const lower = await turn("m-10b", "make the backup defect minor", [{ kind: "command", op: "defect.edit", args: { id: a, severity: "minor" }, evidence: "make the backup defect minor", basis: "owner" }]);
    assert.equal(lower[0].status, "proposed", JSON.stringify(lower));
    const no = await turn("m-10c", "no!", [{ kind: "discard_proposal", proposalId: lower[0].proposalId, evidence: "No", basis: "owner" }]);
    assert.equal(no[0].status, "discarded", JSON.stringify(no));
    assert.equal((await state(a)).severity, "critical");
    // Once withdrawn it is finished and no longer corrected.
    assert.ok((await call(boot.token, "defect.withdraw", { id: a, reason: "a duplicate" }, "w1")).ok);
    assert.equal((await call(boot.token, "defect.edit", { id: a, severity: "minor" }, "e7")).error.code, "invalid_transition");
    const finished = await turn("m-11", esc, [{ kind: "command", op: "defect.edit", args: { id: a, severity: "critical" }, evidence: esc, basis: "owner" }]);
    assert.notEqual(finished[0].status, "applied", JSON.stringify(finished));
    assert.equal((await state(a)).state, "withdrawn");
    // A hand edit that puts entries other than records into the stored list: the defects view still answers and counts only the records.
    const bRef = { kind: "defect", id: b };
    const bAgg = (await c.storage.getAggregate(bRef))!;
    const kept = (bAgg.body as any).edits as unknown[];
    await new CommandRunner(c.storage, c.epoch, {}).command("test.plant", { commandId: "junk-edits", actor: "system" }, async () => ({ payload: { id: b }, build: async () => ({ ref: bRef, creates: false, changes: [{ type: "update", ref: bRef, expectedRevision: bAgg.revision, body: { ...bAgg.body, edits: [null, 7, "x", [], ...kept] } as never }], detail: {} }) }));
    shown = await lines();
    assert.ok(shown.includes(`Finding: "A typo in step 2.". Edited 2 time(s), last by ${rob.id}; reported as minor.`), shown);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
