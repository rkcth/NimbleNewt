import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("alerts on a responsibility are grouped into incidents through the state API, the observed state is unknown without a check, and others are refused (card P04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-inc-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    const project = (await call(boot.token, "project.create", { name: "Ops" }, "p1")).result.id as string;
    const duty = (await call(boot.token, "responsibility.create", { projectId: project, title: "Keep it up", objective: "Up", desiredCondition: "healthy", everyMinutes: 60 }, "r1"));
    assert.equal(duty.ok, true, JSON.stringify(duty));
    const rid = duty.result.id as string;
    assert.equal((await call(boot.token, "responsibility.observed", { responsibilityId: rid })).result.item.observed, "unknown");
    for (const [i, outcome] of ["attention", "failed", "attention"].entries()) assert.equal((await call(boot.token, "incident.report", { responsibilityId: rid, signature: "disk", summary: `step ${i}`, outcome }, `i${i}`)).ok, true);
    const list = (await call(boot.token, "responsibility.incidents", { projectId: project, open: true })).result.items;
    assert.deepEqual(list.map((i: any) => [i.signature, i.count, i.worst]), [["disk", 3, "failed"]]);
    assert.equal((await call(boot.token, "responsibility.observed", { responsibilityId: rid })).result.item.observed, "unknown", "no check yet: never healthy, and not failed on alerts alone without a recent check");
    assert.deepEqual((await call(boot.token, "responsibility.checks", { projectId: project })).result.items, []);
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "eve", grants: [{ action: "task.read", project: "*" }] });
    const eve = (await c.services.principals.issueCredential(rob, "agent:eve")).token;
    assert.equal((await call(eve, "incident.report", { responsibilityId: rid, signature: "x", summary: "y", outcome: "failed" }, "e-i")).ok, false);
    assert.equal((await call(boot.token, "incident.resolve", { incidentId: list[0].id, evidence: "disk cleaned" }, "v1")).ok, true);
    assert.deepEqual((await call(boot.token, "responsibility.incidents", { projectId: project, open: true })).result.items, []);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
