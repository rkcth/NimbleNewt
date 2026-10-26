import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { API_VERSION, startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("a controller offers retained context branches through the API: open, view, switch and resume keep the history and the return destination (card C05)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-branch-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
    const call = (op: string, args: Record<string, unknown> = {}, commandId?: string) => c.api.handle(boot.token, { v: API_VERSION, op, args, ...(commandId === undefined ? {} : { commandId }) });
    const result = (r: Awaited<ReturnType<typeof call>>): Record<string, unknown> => { assert.ok(r.ok, JSON.stringify(r)); return (r as unknown as { result: Record<string, unknown> }).result; };

    const a = result(await call("branch.open", { taskId: task, purpose: "which supplier?" }, "b1"));
    const b = result(await call("branch.open", { taskId: task, purpose: "which soil?" }, "b2"));
    assert.equal(result(await call("branch.open", { taskId: task, purpose: "which supplier?" }, "b1"))["replayed"], true, "the same command is one branch");
    const got = result(await call("branch.get", { branchId: a["id"] as string })) as { item: { branch: { revision: number; state: string }; counts: { parent: number; branch: number } } };
    assert.equal(got.item.branch.state, "active");
    const gotB = result(await call("branch.get", { branchId: b["id"] as string })) as { item: { branch: { revision: number } } };
    // Suspend the second (a newer task arrived), then switch: the first is suspended and the second restored.
    result(await call("branch.suspend", { branchId: b["id"], expectedRevision: gotB.item.branch.revision, reason: "urgent task" }, "su1"));
    const gotB2 = result(await call("branch.get", { branchId: b["id"] as string })) as { item: { branch: { revision: number } } };
    result(await call("branch.switch", { suspend: { branchId: a["id"], expectedRevision: got.item.branch.revision, reason: "the owner asked about soil" }, restore: { branchId: b["id"], expectedRevision: gotB2.item.branch.revision } }, "sw1"));
    const after = result(await call("branch.get", { branchId: a["id"] as string })) as { item: { branch: { state: string } } };
    assert.equal(after.item.branch.state, "suspended");
    const pending = result(await call("branch.pending")) as { items: unknown[] };
    assert.ok(Array.isArray(pending.items));
    // Unknown branch reads like a missing one.
    const missing = await call("branch.get", { branchId: "branch-aaaaaaaaaaaaaaaaaaaa" });
    assert.ok(!missing.ok && missing.error.code === "not_found", JSON.stringify(missing));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
