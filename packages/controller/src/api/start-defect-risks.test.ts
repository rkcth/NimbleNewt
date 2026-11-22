import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("through the running controller the team-wide defect risks are answered in chat and an escalated defect waits on the Needs-you list until the owner answers it there (card Q04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-defect-risks-"));
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
    const ask = "what defects are still open across the project?";
    const risks = () => turn(`m-${Math.random()}`, ask, [{ kind: "status", request: { kind: "defect_risks" }, evidence: ask, basis: "owner" }]);
    const none = await risks();
    assert.equal(none[0].status, "answered", JSON.stringify(none));
    assert.match(none[0].lines[0].text, /^No unfinished defect of this project that you may read was found/);
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.count, 0);

    const minor = (await call(rev.token, "defect.report", { deliverableId: id, version: 1, finding: "A typo in step 1.", severity: "minor" }, "f1")).result.id as string;
    const major = (await call(rev.token, "defect.report", { deliverableId: id, version: 1, finding: "The guide skips the backup step.", severity: "major" }, "f2")).result.id as string;
    const cur = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur.revision, artifacts: [{ artifactId: art }] }, "n2");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv.result.revision, contractVersion: 0 }, "s2")).ok);
    assert.ok((await call(ann.token, "defect.repair", { id: major, version: 2 }, "rp1")).ok);

    // Repaired and waiting for a check, and open: not on the Needs-you list yet.
    let seen = await risks();
    let lines = (seen[0].lines as { text: string }[]).map((l) => l.text);
    assert.match(lines[0]!, /^2 unfinished defect\(s\): 0 escalated to you \(they wait for your decision\), 1 repaired and waiting for a check, 1 open and waiting for a repair\./);
    assert.match(lines[1]!, new RegExp(`^Defect ${major} \\(major\\) in task ${task}, deliverable ${id} version 1: repaired, waiting for a check; 0 of 1 repair and review cycles used;`));
    assert.match(lines[2]!, new RegExp(`^Defect ${minor} \\(minor\\)`));
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.count, 0);

    // The check fails and reaches the limit: the defect escalates, comes first, and waits on the Needs-you list.
    assert.ok((await call(rev.token, "defect.review", { id: major, verdict: "not-fixed", reason: "the backup step is still missing" }, "rv1")).ok);
    seen = await risks();
    lines = (seen[0].lines as { text: string }[]).map((l) => l.text);
    assert.match(lines[0]!, /^2 unfinished defect\(s\): 1 escalated to you/);
    assert.match(lines[1]!, new RegExp(`^Defect ${major} \\(major\\).*escalated to you: accept it as is, or let the repair go on; 1 of 1 repair`));
    const viaApi = await call(boot.token, "status.ask", { request: { kind: "defect_risks", projectId: project } });
    assert.deepEqual(viaApi.result.item.lines.map((l: any) => l.text), lines);
    assert.ok(viaApi.result.item.lines[1].cites.some((x: any) => x.kind === "defect" && x.id === major), "the line cites the defect");
    // Another project's agent is told nothing of it; an agent of this project reads it.
    assert.equal((await call(far.token, "status.ask", { request: { kind: "defect_risks", projectId: project } })).result.item.lines[0].text.slice(0, 20), "No unfinished defect");
    assert.match((await call(rev.token, "status.ask", { request: { kind: "defect_risks", projectId: project } })).result.item.lines[0].text, /^2 unfinished/);

    const needs = (await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item;
    assert.equal(needs.count, 1, JSON.stringify(needs));
    assert.deepEqual([needs.items[0].kind, needs.items[0].id, needs.items[0].taskId, needs.items[0].projectId, needs.items[0].answer.choices], ["defect", major, task, project, ["accept-as-is", "repair-again"]]);
    assert.match(needs.lines[0].text, /failed 1 repair check\(s\), the limit of 1: "The guide skips the backup step\." \(accept it as is, or repair again\)/);
    // An agent has no Needs-you list, and may not answer an item of it.
    assert.equal((await call(rev.token, "needs-you.answer", { kind: "defect", id: major, answer: "accept-as-is" }, "na0")).error.code, "forbidden");
    assert.equal((await call(boot.token, "defect.get", { id: major })).result.item.state, "escalated", "nothing was decided by the agent");

    // The owner answers in their own words: shown first, applied on their word; the failed check is kept.
    const words = "let them try the backup step again, one more time";
    const proposed = await turn("m-a", words, [{ kind: "command", op: "needs-you.answer", args: { itemTopic: "backup step", answer: "repair-again" }, evidence: words, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.equal((await call(boot.token, "defect.get", { id: major })).result.item.state, "escalated", "nothing changed yet");
    const applied = await turn("m-b", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const item = (await call(boot.token, "defect.get", { id: major })).result.item;
    assert.deepEqual([item.state, item.cycles, item.checks.map((x: any) => x.verdict), item.overrideRecords.map((o: any) => [o.outcome, o.reason])], ["open", 1, ["not-fixed"], [["repair-again", "answered from the Needs-you list"]]]);
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.count, 0, "no longer waiting");
    // Another answer to an item that no longer waits is refused, and so is an answer the item does not offer.
    assert.equal((await call(boot.token, "needs-you.answer", { kind: "defect", id: major, answer: "accept-as-is" }, "na2")).error.code, "invalid_transition");
    assert.equal((await call(boot.token, "needs-you.answer", { kind: "defect", id: major, answer: "maybe" }, "na3")).error.code, "invalid_command");
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
