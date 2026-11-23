import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { PI } from "../dispatch/testing/world.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const base = "a".repeat(40), patch = "c".repeat(40);

// Card Q02 second review, through the composed controller: an approval carried over to a later submission of the same claimed patch is queued to land only while the project's landing requires the `review`
// check (where the landing gate has the host prove the earlier submission's own patch). A project that lands on `tests` alone would otherwise land the later code on the submitter's word.
test("a carried approval is queued only while the project's landing checks the review (card Q02 second review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-q02c-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI] } as never);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const O = boot.token;
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const hire = async (name: string, roles: string[]) => {
      const made = await s.agents.create(rob, { commandId: `mk-${name}`, friendlyName: name, roles });
      const id = `agent:${made.id}`;
      await s.grants.grant(rob, { commandId: `g-${name}`, grantee: id, action: "task.read", project, source: "direct", basis: "test" } as never);
      return { id, token: (await s.principals.issueCredential(rob, id)).token };
    };
    const ann = await hire("Ann", ["author"]);
    const rev = await hire("Rev", ["reviewer"]);
    const task = (await s.projects.createTask({ commandId: "t-1", actor: rob.id, projectId: project, title: "One" })).id;
    await s.projects.transitionTask({ commandId: "r-1", actor: rob.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as-1", actor: rob.id, taskId: task, owner: { kind: "agent", id: ann.id } } as never);
    await s.assignments.admitAttempt({ commandId: "adm-1", actor: rob.id, taskId: task, expectedRevision: (await s.assignments.getAssignment(task))!.revision, generation: 1, owner: { kind: "agent", id: ann.id }, harness: "pi" } as never);
    const submit = async (tree: string, n: string): Promise<string> => {
      const made = await call(ann.token, "submission.record", { taskId: task, kind: "code", role: "author", base, tree, patchId: patch }, `code-${n}`);
      assert.equal(made.ok, true, JSON.stringify(made));
      return made.result.id as string;
    };
    // The first copy is reviewed and approved; the second claims the same patch with another tree and has no review of its own.
    const first = await submit("1".repeat(40), "1");
    assert.ok((await call(rev.token, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: first, verdict: "approve" }, "rev-1")).ok);
    const second = await submit("2".repeat(40), "2");
    assert.ok((await call(O, "project.branches.change", { project, landing: "main" }, "lb1")).ok);

    // Landing on tests alone: the carried approval is not an approval in the queue.
    assert.ok((await call(O, "integration.set", { project, requiredChecks: ["tests"] }, "is1")).ok);
    const refused = await call(ann.token, "landing.queue.add", { submissionId: second }, "qa1");
    assert.equal(refused.error?.code, "review_invalid", JSON.stringify(refused));
    assert.match(refused.error.message, /no review of its own/);
    assert.ok(String(refused.error.message).includes(first), "it names the earlier submission the approval came from (the approval carries by the claimed patch ID)");
    // The landing checks the review: queued (the gate proves the patch at landing).
    assert.ok((await call(O, "integration.set", { project, requiredChecks: ["tests", "review"] }, "is2")).ok);
    const added = await call(ann.token, "landing.queue.add", { submissionId: second }, "qa2");
    assert.equal(added.ok, true, JSON.stringify(added));
    assert.equal(added.result.entry.submissionId, second);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
