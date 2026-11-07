import assert from "node:assert/strict";
import { test } from "node:test";
import { versionIdOf } from "../catalog/index.js";
import { MemoryStorage } from "../storage/memory.js";
import type { OperationInput } from "../storage/types.js";
import { RetainedMaterial } from "./references.js";

let n = 0;
const op = (changes: OperationInput["changes"]): OperationInput => ({ operationId: `op-${++n}`, epoch: 1, actor: "a", correlationId: `c-${n}`, at: "2026-10-30T10:00:00.000Z", changes, audit: [{ type: "seed", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
const create = (kind: string, id: string, body: object) => ({ type: "create" as const, ref: { kind, id }, body: body as never });

test("a tool version that a resumable task has a call pinned to (parked, approved or running), an environment lists, or a dependency record names is held (card T02c fix)", async () => {
  const raw = new MemoryStorage(); await raw.acquireEpoch({ holder: "t", at: "2026-10-30T10:00:00.000Z" });
  const id = (name: string, version: string): string => versionIdOf(name, version);
  await raw.applyOperation(op([
    create("task", "task-live", { projectId: "proj-a", state: "in_progress" }), create("task", "task-done", { projectId: "proj-a", state: "done" }),
    create("dispatch", "att-live", { attemptId: "att-live", taskId: "task-live", state: "parked" }), create("dispatch", "att-done", { attemptId: "att-done", taskId: "task-done", state: "finished" }),
    // A parked call and an approved-but-not-started call pinned to versions (the tool path name has the underscore of a personal namespace written as a hyphen).
    create("tool-op-att-live", "op-1", { tool: { kind: "catalog", name: "toolbox.check", version: "1.0.0" }, state: "awaiting-approval" }),
    create("tool-op-att-live", "op-2", { tool: { kind: "catalog", name: "a-abcd.check", version: "2.0.0" }, state: "in-progress" }),
    create("tool-op-att-live", "op-3", { tool: { kind: "builtin", name: "read-file", version: "1" }, state: "in-progress" }),
    create("tool-op-att-done", "op-4", { tool: { kind: "catalog", name: "toolbox.old", version: "1.0.0" }, state: "awaiting-approval" }),
    // Environments: the active revision, and the revision an attempt of a live task is pinned to; not an older unpinned revision.
    create("environment", "env-1", { agentId: "agt-a", latest: 3, active: 3 }),
    create("environment-revision", "evr-1", { agentId: "agt-a", revision: 1, manifest: { skills: [id("toolbox.old-skill", "1.0.0")] } }),
    create("environment-revision", "evr-2", { agentId: "agt-a", revision: 2, manifest: { skills: [id("toolbox.pinned-skill", "1.0.0")] } }),
    create("environment-revision", "evr-3", { agentId: "agt-a", revision: 3, manifest: { skills: [id("toolbox.active-skill", "1.0.0")] } }),
    create("environment-pin", "pin-1", { attemptId: "att-live", agentId: "agt-a", kind: "attempt", revision: 2 }),
    // Dependency records.
    create("dependency-manifest", "dpm-1", { taskId: "task-live", entries: [{ kind: "tool-version", key: id("toolbox.dep", "1.0.0") }, { kind: "record", key: "dsk-x" }] }),
    create("dependency-manifest", "dpm-2", { taskId: "task-done", entries: [{ kind: "tool-version", key: id("toolbox.dep-done", "1.0.0") }] }),
  ] as never));
  const m = await RetainedMaterial.build(raw);
  assert.equal(m.complete, true);
  const held = (name: string, v: string): string[] | undefined => m.why("catalog-version", id(name, v));
  assert.match(String(held("toolbox.check", "1.0.0")?.[0]), /pinned to it by task task-live/, "parked for approval");
  assert.match(String(held("a_abcd.check", "2.0.0")?.[0]), /pinned/, "approved and in progress, named by its tool path");
  assert.ok(held("toolbox.pinned-skill", "1.0.0"), "the revision an attempt is pinned to");
  assert.ok(held("toolbox.active-skill", "1.0.0"), "the active environment");
  assert.ok(held("toolbox.dep", "1.0.0"), "a dependency record of a live task");
  assert.match(String(m.why("desk-record", "dsk-x")?.[0]), /dependency by task task-live/, "a desk record a live task's dependency manifest cites");
  for (const [name, v] of [["toolbox.old", "1.0.0"], ["toolbox.old-skill", "1.0.0"], ["toolbox.dep-done", "1.0.0"], ["read-file", "1"]] as const) assert.equal(held(name, v), undefined, `${name} ${v} is free`);
});
