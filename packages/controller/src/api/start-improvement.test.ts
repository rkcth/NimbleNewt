import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("an agent proposes an improvement through the state API, the owner groups, decides and brings it to the stand-up, and a stranger sees none of it (card M03c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-imp-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
    const token = async (name: string, grants: { action: string; project: string }[]) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants }); return (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; };
    const ann = await token("ann", [{ action: "task.read", project }, { action: "meeting.agenda", project }]);
    const bob = await token("bob", [{ action: "task.read", project }, { action: "meeting.agenda", project }]);
    const zed = await token("zed", [{ action: "task.read", project }]);

    assert.equal((await call(zed, "improvement.propose", { projectId: project, title: "Slow lint", observation: "lint takes ten minutes" }, "i0")).error.code, "forbidden");
    const first = await call(ann, "improvement.propose", { projectId: project, title: "Slow lint", observation: "lint takes ten minutes every run", possibleImprovement: "cache the results" }, "i1");
    assert.ok(first.ok, JSON.stringify(first));
    assert.equal((await call(ann, "improvement.propose", { projectId: project, title: "Slow lint", observation: "lint takes ten minutes every run", possibleImprovement: "cache the results" }, "i1")).result.replayed, true);
    const second = await call(bob, "improvement.propose", { projectId: project, title: "Lint is slow", observation: "waiting on lint again" }, "i2");
    assert.ok(second.ok, JSON.stringify(second));

    // Proposers read their own; a stranger reads nothing; the owner lists both.
    assert.equal((await call(ann, "improvement.get", { itemId: first.result.id })).result.item.title, "Slow lint");
    assert.equal((await call(zed, "improvement.get", { itemId: first.result.id })).error.code, "not_found");
    assert.equal((await call(boot.token, "improvement.list", { projectId: project })).result.item.items.length, 2);

    // Only a manager groups and decides.
    const one = (await call(boot.token, "improvement.get", { itemId: first.result.id })).result.item;
    const two = (await call(boot.token, "improvement.get", { itemId: second.result.id })).result.item;
    assert.equal((await call(ann, "improvement.decide", { itemId: first.result.id, expectedRevision: one.revision, to: "accepted" }, "d0")).error.code, "forbidden");
    const grouped = await call(boot.token, "improvement.group", { itemId: second.result.id, expectedRevision: two.revision, under: first.result.id, underRevision: one.revision }, "g1");
    assert.ok(grouped.ok, JSON.stringify(grouped));
    const regot = (await call(boot.token, "improvement.get", { itemId: first.result.id })).result.item;
    const brought = await call(boot.token, "improvement.bring", { itemId: first.result.id, expectedRevision: regot.revision }, "b1");
    assert.ok(brought.ok, JSON.stringify(brought));
    assert.match(brought.result.agendaItemId, /^agi-|^agn-|^[a-z]+-/);
    const afterBring = (await call(boot.token, "improvement.get", { itemId: first.result.id })).result.item;
    const decided = await call(boot.token, "improvement.decide", { itemId: first.result.id, expectedRevision: afterBring.revision, to: "accepted" }, "d1");
    assert.ok(decided.ok, JSON.stringify(decided));
    assert.equal((await call(boot.token, "improvement.get", { itemId: first.result.id })).result.item.disposition, "accepted");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
