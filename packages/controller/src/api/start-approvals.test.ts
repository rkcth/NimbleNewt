import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the running controller binds a standing-rule proposal to the owner setting grants.maxDays, and only the owner can accept one (card U08 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-u08-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "review.request", project }, { action: "attempt.work", project }] });
    const annToken = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const ann = await c.services.principals.authenticate(annToken);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message?: string } }>;

    // Three owner approvals of the same class for ann open one proposal.
    for (let i = 0; i < 3; i++) {
      const r = await c.services.reviews.request(ann, { commandId: `rq${i}`, taskId: task, operation: { name: "git-commit", args: { n: i } as never, target: { kind: "repository", id: "main" } }, context: { toolVersion: "1.0", authoritySource: "task grant", expectedEffects: ["commits"] } });
      await c.services.reviews.decide(rob, { commandId: `dc${i}`, requestId: r.id, expectedRevision: (await c.services.reviews.get(rob, r.id))!.revision, verdict: "allow", reason: "fine" });
    }
    assert.ok((await call(boot.token, "approval.proposals.check", {}, "chk")).ok);
    const open = (await call(boot.token, "approval.proposals", { state: "open" })).result.items as { id: string; revision: number }[];
    assert.equal(open.length, 1);

    // The owner sets the longest a grant may last.
    const staged = await c.services.configuration.stage(rob, { commandId: "cfg1", layer: "installation", set: { "grants.maxDays": 5 } });
    const applied = await c.services.configuration.apply(rob, { commandId: "cfg2", layer: "installation", expectedRevision: staged.revision });
    assert.ok(applied.applied, JSON.stringify(applied));

    // The agent the proposal is for cannot accept it for itself.
    assert.equal((await call(annToken, "approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision }, "a0")).error?.code, "forbidden");
    // A length the owner picks beyond the setting is refused; with nothing said, the shown length is cut to it.
    const tooLong = await call(boot.token, "approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision, days: 7 }, "a1");
    assert.equal(tooLong.error?.code, "invalid_command", JSON.stringify(tooLong));
    assert.match(tooLong.error?.message ?? "", /grants\.maxDays/);
    const ok = await call(boot.token, "approval.proposal.accept", { proposalId: open[0]!.id, expectedRevision: open[0]!.revision }, "a2");
    assert.ok(ok.ok, JSON.stringify(ok));
    assert.equal(ok.result.days, 5);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
