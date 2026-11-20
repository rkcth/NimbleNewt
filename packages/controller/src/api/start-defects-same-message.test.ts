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

test("chat: a repair and a judgement in one owner message (either order); a revision only the interpreter supplied is replaced, one the owner wrote is kept", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-q04-same-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], artifacts: { directory: join(d, "blobs") }, chat: { interpreter: new ScriptedInterpreter((input: { text: string }) => say[input.text] ?? []) } });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Write the guide" })).id;
    const hire = async (n: string, roles: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${n}`, friendlyName: n, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${n}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" });
      if (roles.includes("reviewer")) await s.grants.grant(rob, { commandId: `gr-${n}`, grantee: id, action: "review.decide", project, source: "direct", basis: "test" });
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<any> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args });
    const ann = await hire("Ann", ["author", "docs"]);
    const rev = await hire("Rev", ["reviewer"]);
    const artifacts = ArtifactService.withEpoch(c.storage, c.epoch, await FileBlobStore.open({ directory: join(d, "blobs") }));
    const art = (await artifacts.publish({ commandId: "a1", actor: rob.id, name: "guide", projectId: project, taskId: task, files: [{ path: "guide.txt", content: Buffer.from("step 1") }] })).id;
    const made = await call(ann.token, "deliverable.draft", { taskId: task, type: "document", title: "Install guide", artifacts: [{ artifactId: art }] }, "d1");
    const id = made.result.id;
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: made.result.revision, contractVersion: 0 }, "s1")).ok);
    const reported = await call(rev.token, "defect.report", { deliverableId: id, version: 1, finding: "typo", severity: "minor" }, "f1");
    assert.ok(reported.ok, JSON.stringify(reported));
    const defect = reported.result.id;
    const cur = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur.revision, artifacts: [{ artifactId: art }] }, "n2");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv.result.revision, contractVersion: 0 }, "s2")).ok);

    await c.chat!.setFocus(boot.token, { commandId: "fx", projectId: project });
    const turn = async (mid: string, text: string, intents: unknown[]): Promise<readonly any[]> => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: mid, text })).outcomes; };
    const words = "the new version repairs the typo and the fix works";
    const out = await turn("m1", words, [
      { kind: "command", op: "defect.repair", args: { id: defect, version: 2 }, evidence: words, basis: "owner" },
      { kind: "command", op: "defect.review", args: { id: defect, verdict: "fixed" }, evidence: words, basis: "owner" },
    ]);
    assert.deepEqual(out.map((o: any) => o.status), ["applied", "proposed"], JSON.stringify(out));
    const ok = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: out[1].proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(ok[0].status, "applied", JSON.stringify(ok));
    const now = (await call(boot.token, "defect.get", { id: defect })).result.item;
    assert.deepEqual([now.state, now.repairVersion, now.checks.map((x: any) => [x.version, x.verdict])], ["resolved", 2, [[2, "fixed"]]]);

    // Judgement first, repair after in one message: the judgement was shown before the repair, so it is stale.
    const r2 = await call(rev.token, "defect.report", { deliverableId: id, version: 2, finding: "another typo", severity: "minor" }, "f2");
    const d2 = r2.result.id;
    const cur3 = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv3 = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur3.revision, artifacts: [{ artifactId: art }] }, "n3");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv3.result.revision, contractVersion: 0 }, "s3")).ok);
    const w2 = "the other typo fix works and the newest version repairs it";
    const out2 = await turn("m3", w2, [
      { kind: "command", op: "defect.review", args: { id: d2, verdict: "fixed" }, evidence: w2, basis: "owner" },
      { kind: "command", op: "defect.repair", args: { id: d2, version: 3 }, evidence: w2, basis: "owner" },
    ]);
    assert.deepEqual(out2.map((o: any) => o.status), ["proposed", "applied"], JSON.stringify(out2));
    const st = await turn("m4", "yes, go", [{ kind: "apply_proposal", proposalId: out2[0].proposalId, evidence: "yes, go", basis: "owner" }]);
    assert.notEqual(st[0].status, "applied", JSON.stringify(st));

    // An invented revision on a judgement (not in the owner's words) is replaced: the controller pins the defect's real revision itself.
    const d3 = (await call(rev.token, "defect.report", { deliverableId: id, version: 3, finding: "third typo", severity: "minor" }, "f3")).result.id;
    const cur4 = (await call(ann.token, "deliverable.record.get", { id })).result.item;
    const nv4 = await call(ann.token, "deliverable.version.new", { id, expectedRevision: cur4.revision, artifacts: [{ artifactId: art }] }, "n4");
    assert.ok((await call(ann.token, "deliverable.submit", { id, expectedRevision: nv4.result.revision, contractVersion: 0 }, "s4")).ok);
    const seen = (await call(boot.token, "defect.get", { id: d3 })).result.item.revision as number;
    assert.ok((await call(ann.token, "defect.repair", { id: d3, version: 4 }, "rp4")).ok);
    // A revision the owner wrote themselves (the one they looked at, before the repair arrived) is kept: the judgement is stale and nothing is recorded.
    const wq = `as I saw it at revision ${seen}, the third typo is fixed`;
    const outq = await turn("m5q", wq, [{ kind: "command", op: "defect.review", args: { id: d3, verdict: "fixed", expectedRevision: seen }, evidence: wq, basis: "owner" }]);
    assert.equal(outq[0].status, "proposed", JSON.stringify(outq));
    const apq = await turn("m6q", "yes, record it", [{ kind: "apply_proposal", proposalId: outq[0].proposalId, evidence: "yes, record it", basis: "owner" }]);
    assert.notEqual(apq[0].status, "applied", JSON.stringify(apq));
    assert.deepEqual((await call(boot.token, "defect.get", { id: d3 })).result.item.checks, []);
    const w3 = "the third typo fix works";
    const out3 = await turn("m5", w3, [{ kind: "command", op: "defect.review", args: { id: d3, verdict: "fixed", expectedRevision: 9999 }, evidence: w3, basis: "owner" }]);
    assert.equal(out3[0].status, "proposed", JSON.stringify(out3));
    const ap3 = await turn("m6", "yes, go", [{ kind: "apply_proposal", proposalId: out3[0].proposalId, evidence: "yes, go", basis: "owner" }]);
    assert.equal(ap3[0].status, "applied", JSON.stringify(ap3));
  } finally {
    await c.close();
    rmSync(d, { recursive: true, force: true });
  }
});
