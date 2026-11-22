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

test("through the running controller a defect reported by mistake is withdrawn by its reporter or by the owner in chat, and leaves the Needs-you list and the unfinished views (card Q04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-defect-withdraw-"));
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

    const wrong = (await call(rev.token, "defect.report", { deliverableId: id, version: 1, finding: "The guide skips the backup step.", severity: "major" }, "f1")).result.id as string;
    const typo = (await call(rev.token, "defect.report", { deliverableId: id, version: 1, finding: "A typo in step 1.", severity: "minor" }, "f2")).result.id as string;
    // The reporter takes its own report back through the state API; the responsible agent and another project's agent cannot.
    assert.equal((await call(ann.token, "defect.withdraw", { id: typo, reason: "not my call" }, "w0")).error.code, "forbidden");
    assert.equal((await call(far.token, "defect.withdraw", { id: typo, reason: "not mine" }, "w1")).error.code, "not_found");
    assert.ok((await call(rev.token, "defect.withdraw", { id: typo, reason: "I misread step 1; it is fine" }, "w2")).ok);
    assert.equal((await state(typo)).state, "withdrawn");
    assert.match((await risks())[0]!, /^1 unfinished defect\(s\)/);
    assert.equal((await call(boot.token, "defect.withdraw", { id: typo, reason: "again" }, "w3")).error.code, "invalid_transition");

    // The other one escalates: it waits on the Needs-you list.
    const cur = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur.revision, artifacts: [{ artifactId: art }] }, "n2");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv.result.revision, contractVersion: 0 }, "s2")).ok);
    assert.ok((await call(ann.token, "defect.repair", { id: wrong, version: 2 }, "rp1")).ok);
    assert.ok((await call(rev.token, "defect.review", { id: wrong, verdict: "not-fixed", reason: "still missing" }, "rv1")).ok);
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.count, 1);

    // The owner takes it back in their own words: shown first, an invented reason is refused, the revision cannot be supplied by the model.
    const words = "that backup step defect was a mistake, I looked at the wrong version, drop it";
    const invented = await turn("m-0", words, [{ kind: "command", op: "defect.withdraw", args: { id: wrong, reason: "the reporter was out of date" }, evidence: words, basis: "owner" }]);
    assert.notEqual(invented[0].status, "proposed", JSON.stringify(invented));
    assert.equal((await state(wrong)).state, "escalated");
    const proposed = await turn("m-1", words, [{ kind: "command", op: "defect.withdraw", args: { id: wrong, reason: "I looked at the wrong version" }, evidence: words, basis: "owner" }]);
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    assert.equal((await state(wrong)).state, "escalated", "nothing changed yet");
    const applied = await turn("m-2", "yes, do that", [{ kind: "apply_proposal", proposalId: proposed[0].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const gone = await state(wrong);
    assert.deepEqual([gone.state, gone.resolution.kind, gone.resolution.reason, gone.cycles, gone.checks.map((x: any) => x.verdict)], ["withdrawn", "withdrawn", "I looked at the wrong version", 1, ["not-fixed"]]);
    assert.equal((await call(boot.token, "status.ask", { request: { kind: "needs_you" } })).result.item.count, 0, "it left the Needs-you list");
    assert.match((await risks())[0]!, /^No unfinished defect/);
    const shown = (await call(boot.token, "status.ask", { request: { kind: "defects", taskId: task } })).result.item.lines.map((l: any) => l.text).join("\n");
    assert.match(shown, /withdrawn as mistaken/);
    assert.match(shown, /2 defect\(s\) found, 0 unresolved/);
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
