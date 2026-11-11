import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string } };

test("maintenance leases through the running controller: a rival is blocked visibly, a failed validation escalates an incident, and the lease survives a restart (card P04)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lease-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] } as never);
  let c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const grants = [{ action: "responsibility.read", project: "*" }, { action: "responsibility.write", project: "*" }];
    await c.services.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants });
    await c.services.principals.enroll(owner, { commandId: "e-bob", kind: "agent", name: "bob", grants });
    const ann = (await c.services.principals.issueCredential(owner, "agent:ann")).token;
    const bob = (await c.services.principals.issueCredential(owner, "agent:bob")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const project = (await call(boot.token, "project.create", { name: "Ops" }, "p1")).result.id as string;
    const res = (await call(boot.token, "resource.bind", { projectId: project, kind: "service", label: "Web", locator: "https://example.test" }, "b1")).result.id as string;
    const duty = (await call(boot.token, "responsibility.create", { projectId: project, title: "Keep web up", objective: "Up", everyMinutes: 60, managed: [res], escalation: { to: "owner" } }, "r1")).result.id as string;

    assert.equal((await call(ann, "lease.acquire", { resourceId: res, purpose: "upgrade" }, "a1")).result.status, "granted");
    const rival = await call(bob, "lease.acquire", { resourceId: res, purpose: "restart" }, "a2");
    assert.equal(rival.result.status, "blocked");
    assert.equal((await call(bob, "lease.acquire", { resourceId: res, purpose: "x", extra: 1 }, "a3")).error?.code, "invalid_command");
    assert.equal((await call(bob, "lease.release", { resourceId: res, validation: "passed", evidence: "mine" }, "x1")).error?.code, "forbidden");

    await c.close();
    c = await open();
    const seen = (await call(boot.token, "lease.list", { projectId: project })).result.items;
    assert.deepEqual(seen.map((l: any) => [l.holderId !== undefined, l.status, l.blockedCount]), [[true, "held", 1]]);

    const done = await call(ann, "lease.release", { resourceId: res, validation: "failed", evidence: "health 500", onFailure: "escalate" }, "x2");
    assert.equal(done.result.response, "escalate");
    const incidents = (await call(boot.token, "responsibility.incidents", { projectId: project, open: true })).result.items;
    assert.deepEqual(incidents.map((i: any) => [i.id === done.result.incidentId, i.escalatedTo]), [[true, "owner"]]);
    const history = (await call(boot.token, "responsibility.history", { responsibilityId: duty })).result.items;
    assert.equal(history.filter((h: any) => h.kind === "intervention").length, 1);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
