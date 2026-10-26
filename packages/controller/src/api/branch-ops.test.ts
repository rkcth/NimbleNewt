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
    // One branch alone: suspend, restore, write to it, read it back, and resume it to its destination.
    const solo = result(await call("branch.open", { taskId: task, purpose: "which tools?" }, "b3"));
    const rev = async (id: string) => ((result(await call("branch.get", { branchId: id })) as { item: { branch: { revision: number } } }).item.branch.revision);
    result(await call("branch.suspend", { branchId: solo["id"], expectedRevision: await rev(solo["id"] as string), reason: "urgent task" }, "su2"));
    result(await call("branch.restore", { branchId: solo["id"], expectedRevision: await rev(solo["id"] as string) }, "re1"));
    const appended = result(await call("branch.append", { branchId: solo["id"], text: "the owner prefers hand tools" }, "ap1"));
    assert.equal(appended["seq"], 1);
    const history = result(await call("branch.history", { branchId: solo["id"], part: "branch" })) as { item: { entries?: unknown[]; items?: unknown[] } };
    assert.ok(JSON.stringify(history).includes("hand tools"), "the branch's own history holds what was written");
    const resumed = result(await call("branch.resume", { branchId: solo["id"], expectedRevision: await rev(solo["id"] as string) }, "rs1"));
    assert.ok(resumed["returnedTo"] !== undefined, "it goes back to its destination");
    // An agent that holds no right on the task may not open a branch on it.
    const agent = (await s.agents.create(owner, { commandId: "ag9", friendlyName: "Eve" })).id;
    const eve = (await s.principals.issueCredential(owner, `agent:${agent}`)).token;
    const refused = await c.api.handle(eve, { v: API_VERSION, op: "branch.open", commandId: "b9", args: { taskId: task, purpose: "snoop" } });
    assert.ok(!refused.ok && refused.error.code === "forbidden", JSON.stringify(refused));
    // Unknown branch reads like a missing one.
    const missing = await call("branch.get", { branchId: "branch-aaaaaaaaaaaaaaaaaaaa" });
    assert.ok(!missing.ok && missing.error.code === "not_found", JSON.stringify(missing));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
