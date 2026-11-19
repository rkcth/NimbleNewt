import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { CHAT_OPS } from "../chat/commands.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("through the running controller a defect is linked to its version and finding, the project's cycle limit escalates it to the owner, and the owner's override by chat keeps the failed check (card Q04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-defects-"));
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

    // The owner gives this project one repair and review cycle per defect (the installation default is 3).
    await s.configuration.change(rob, { commandId: "cfg", layer: "project", scopeId: project, expectedRevision: 0, set: { "review.repairCycles": 1 } } as never);

    const made = await call(ann.token, "deliverable.draft", { taskId: task, type: "document", title: "Install guide", artifacts: [{ artifactId: art }] }, "d1");
    const id = made.result.id as string;
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: made.result.revision, contractVersion: 0 }, "s1")).ok);
    assert.ok((await call(rev.token, "deliverable.review.start", { id, version: 1 }, "r1")).ok);
    assert.ok((await call(rev.token, "deliverable.reject", { id, version: 1, reason: "the backup step is missing" }, "j1")).ok);

    // Reported by the reviewer, linked to version 1 and its rejection (event 4); the worker may not report on its own work; another project's agent cannot see it.
    const finding = { deliverableId: id, version: 1, finding: "The guide skips the backup step.", findingEvent: 4, severity: "major", evidence: [art] };
    assert.equal((await call(ann.token, "defect.report", finding, "f0")).error.code, "forbidden");
    assert.equal((await call(far.token, "defect.report", finding, "f0")).error.code, "not_found");
    assert.equal((await call(rev.token, "defect.report", finding)).error.code, "invalid_command", "a command ID is required");
    const reported = await call(rev.token, "defect.report", finding, "f1");
    assert.ok(reported.ok, JSON.stringify(reported));
    const defect = reported.result.id as string;
    assert.equal((await call(rev.token, "defect.report", finding, "f1")).result.replayed, true);
    assert.equal((await call(far.token, "defect.get", { id: defect })).error.code, "not_found");
    assert.deepEqual((await call(ann.token, "defect.list", { deliverableId: id })).result.items.map((x: any) => [x.id, x.state, x.limit]), [[defect, "open", 1]]);

    // The repair is version 2; one failed check reaches the project's limit and the owner is told.
    const cur = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur.revision, artifacts: [{ artifactId: art }] }, "n2");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv.result.revision, contractVersion: 0 }, "s2")).ok);
    const repaired = await call(ann.token, "defect.repair", { id: defect, version: 2 }, "rp1");
    assert.ok(repaired.ok, JSON.stringify(repaired));
    assert.equal((await call(ann.token, "defect.review", { id: defect, verdict: "fixed" }, "rv0")).error.code, "forbidden", "the worker does not judge its own repair");
    const checked = await call(rev.token, "defect.review", { id: defect, verdict: "not-fixed", reason: "the backup step is still missing" }, "rv1");
    assert.ok(checked.ok, JSON.stringify(checked));
    assert.deepEqual([checked.result.state, checked.result.cycles, checked.result.limit], ["escalated", 1, 1]);
    const inbox = await NotificationService.withEpoch(c.storage, c.epoch).inbox(rob);
    const told = inbox.items.filter((i) => i.ref.kind === "defect" && i.ref.id === defect);
    assert.equal(told.length, 1, JSON.stringify(inbox.items.map((i) => i.ref)));
    assert.equal(told[0]!.level, "needs-you");

    // The owner asks in chat by the task's title; the answer is the same as the state API's.
    await c.chat!.setFocus(boot.token, { commandId: "f1", projectId: project });
    const turn = async (mid: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes as any[]; };
    const q = "what is wrong with Write the guide?";
    const asked = await turn("m1", q, [{ kind: "status", request: { kind: "defects", taskTitle: "Write the guide" }, evidence: q, basis: "owner" }]);
    assert.equal(asked[0].status, "answered", JSON.stringify(asked));
    const lines = (asked[0].lines as { text: string }[]).map((l) => l.text);
    assert.match(lines[0]!, new RegExp(`^Deliverable ${id} "Install guide": version 2 is submitted; 1 defect\\(s\\) found, 1 unresolved\\.$`));
    assert.match(lines[1]!, new RegExp(`^Defect ${defect} \\(major, found in version 1, repair in version 2\\): escalated to you: it waits for your decision .*; 1 of 1 repair and review cycles used\\. Finding: "The guide skips the backup step\\."\\.$`));
    const viewed = await call(boot.token, "status.ask", { request: { kind: "defects", taskId: task } });
    assert.deepEqual(viewed.result.item.lines.map((l: any) => l.text), lines);
    assert.equal((await call(far.token, "status.ask", { request: { kind: "defects", taskId: task } })).error.code, "not_found");

    // The owner records a finding of their own by chat: the ID comes from the view, the finding must be the owner's words.
    const noticed = "version 2 of the install guide has a typo in step 1, minor";
    const invented = await turn("m1b", noticed, [{ kind: "command", op: "defect.report", args: { deliverableId: id, version: 2, finding: "the whole guide is wrong", severity: "minor" }, evidence: noticed, basis: "owner" }]);
    assert.equal(invented[0].status, "refused", JSON.stringify(invented));
    const own = await turn("m1c", noticed, [{ kind: "command", op: "defect.report", args: { deliverableId: id, version: 2, finding: "a typo in step 1", severity: "minor" }, evidence: noticed, basis: "owner" }]);
    assert.equal(own[0].status, "applied", JSON.stringify(own));
    const typo = (await call(boot.token, "defect.list", { deliverableId: id })).result.items.find((x: any) => x.id !== defect);
    assert.deepEqual([typo.version, typo.finding.text, typo.reportedBy, typo.state], [2, "a typo in step 1", rob.id, "open"]);

    // The owner decides in their own words: shown first, applied on their word; the failed check stays failed.
    const decide = "accept that guide defect as it is: ship it now and fix the backup step next release";
    const proposed = await turn("m2", decide, [{ kind: "command", op: "defect.override", args: { id: defect, outcome: "accept-as-is", reason: "ship it now and fix the backup step next release" }, evidence: decide, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.equal((await call(boot.token, "defect.get", { id: defect })).result.item.state, "escalated", "nothing changed yet");
    const applied = await turn("m3", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const item = (await call(boot.token, "defect.get", { id: defect })).result.item;
    assert.equal(item.state, "overridden");
    assert.deepEqual(item.checks.map((x: any) => [x.verdict, x.cycles, x.limit, x.escalated]), [["not-fixed", 1, 1, true]], "the failed check is kept as it was");
    assert.deepEqual(item.overrideRecords.map((o: any) => [o.outcome, o.reason, o.remaining.map((r: any) => [r.defectId, r.state, r.lastVerdict])]), [["accept-as-is", "ship it now and fix the backup step next release", [[defect, "escalated", "not-fixed"], [typo.id, "open", undefined]]]], "the decision names every finding still unresolved");
    assert.equal((await call(rev.token, "defect.override", { id: defect, outcome: "repair-again", reason: "no" }, "o9")).error.code, "forbidden", "only the owner overrides");

    // Every owner control of the card is a chat command.
    for (const op of ["defect.report", "defect.repair", "defect.review", "defect.override"]) assert.ok(CHAT_OPS[op], op);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
