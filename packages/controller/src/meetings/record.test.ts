import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { budgetRaiseApplier, grantApplier, taskReassignApplier } from "./index.js";
import { defineRecordTests } from "./record-suite.js";

// The suites on every storage backend are in record-suite.ts, one file per backend (this one, record.sqlite.test.ts, record.worker.test.ts, record.postgres.test.ts).
defineRecordTests("reference store");

test("a reassignment decided in a meeting names one active agent and the assignment it observed, goes through the assignment service, and is repeatable (card M02e)", async () => {
  const calls: [string, Record<string, unknown>][] = [];
  let current: Record<string, unknown> | undefined;
  const log: { generation: number; owner: unknown; reason: unknown }[] = [];
  const assignments = {
    getAssignment: async () => current,
    history: async () => log,
    transferTask: async (c: Record<string, unknown>) => { calls.push(["transfer", c]); log.push({ generation: (current!["generation"] as number) + 1, owner: c["to"], reason: c["reason"] }); current = { ...current, owner: c["to"], generation: (current!["generation"] as number) + 1 }; return { revision: 50 }; },
    assignTask: async (c: Record<string, unknown>) => { calls.push(["assign", c]); log.push({ generation: ((current?.["generation"] as number | undefined) ?? 0) + 1, owner: c["owner"], reason: c["reason"] }); current = { state: "assigned", revision: 60, generation: ((current?.["generation"] as number | undefined) ?? 0) + 1, owner: c["owner"] }; return { revision: 60 }; },
  };
  const states: Record<string, string> = { "agent:ann": "active", "agent:bob": "active", "agent:old": "disabled" };
  const works = new Set(["agent:ann", "agent:bob"]);
  const warned: Record<string, unknown>[] = [];
  const applier = taskReassignApplier(assignments as never, { getTask: async (id: string) => (id === "task-a" ? { projectId: "proj-a" } : undefined) } as never, { get: async (id: string) => (states[id] === undefined ? undefined : { state: states[id]! }) }, async (id) => (works.has(id) ? [] : ["attempt.work"]), async (w) => { warned.push(w); });
  assert.deepEqual([applier.action, applier.widens], ["assignment.manage", undefined]);
  assert.equal(await applier.project({ kind: "task", id: "task-a" }), "proj-a");
  assert.equal(await applier.project({ kind: "project", id: "task-a" }), undefined);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "task", id: "task-a" }, expectedRevision: 1, agreedBy: "policy:none" };
  const never = { from: null };
  const refused = (patch: unknown, code = "invalid_command", b: object = base) => assert.rejects(() => applier.apply({ ...b, patch: patch as never } as never), (e: unknown) => e instanceof DomainError && e.code === code);
  for (const patch of [{}, { toAgent: "agent:ann" }, { toAgent: "ann", ...never }, { toAgent: "agent:ann", ...never, extra: 1 }, { toAgent: "agent:old", ...never }, { toAgent: "agent:nobody", ...never }, { toAgent: 7, ...never },
    { toAgent: "agent:ann", from: "ann", generation: 1, revision: 1 }, { toAgent: "agent:ann", from: null, generation: 0, revision: 1 }, { toAgent: "agent:ann", from: null, generation: 1 }, { toAgent: "agent:ann", from: null, revision: 1.5, generation: 1 }, { toAgent: "agent:ann", from: "agent:bob" }]) {
    await refused(patch);
  }
  await refused({ toAgent: "agent:ann", ...never }, "invalid_command", { ...base, target: { kind: "project", id: "p" } });
  assert.equal(calls.length, 0);
  await applier.apply({ ...base, patch: { toAgent: "agent:ann", ...never } });
  assert.deepEqual([calls[0]![0], calls[0]![1]["owner"], calls[0]![1]["expectedRevision"]], ["assign", { kind: "agent", id: "ann" }, undefined], "never assigned: a plain assignment");
  await applier.apply({ ...base, patch: { toAgent: "agent:ann", ...never } });
  assert.equal(calls.length, 1, "a replay finds the owner already in place at a later generation");
  // Assigned to ann at generation 1, revision 60: the decision observed that; the transfer carries the observed revision, not the live one.
  current = { ...current, revision: 99 };
  await applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 1, revision: 60 } });
  assert.deepEqual([calls[1]![0], calls[1]![1]["commandId"], calls[1]![1]["expectedRevision"], calls[1]![1]["to"]], ["transfer", "mtg:d1:c1", 60, { kind: "agent", id: "bob" }]);
  await applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 1, revision: 60 } });
  assert.equal(calls.length, 2, "a replay after the transfer does nothing");
  // The owner moved the task meanwhile: the decision does not override that.
  await refused({ toAgent: "agent:ann", from: "agent:old", generation: 2, revision: 70 }, "stale_revision");
  await refused({ toAgent: "agent:ann", from: "agent:bob", generation: 1, revision: 70 }, "stale_revision");
  current = { state: "released", revision: 7, generation: 2 };
  await refused({ toAgent: "agent:ann", from: "agent:bob", generation: 2, revision: 6 }, "stale_revision");
  await applier.apply({ ...base, patch: { toAgent: "agent:ann", from: null, generation: 2, revision: 7 } });
  assert.deepEqual([calls[2]![0], calls[2]![1]["expectedRevision"]], ["assign", 7], "released: assigned again at its observed revision");
  // A running attempt: use a hand-off. A target without the rights to work: refused.
  current = { state: "assigned", revision: 8, generation: 3, owner: { kind: "agent", id: "ann" }, activeAttemptId: "att-1" };
  await assert.rejects(() => applier.apply({ ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 3, revision: 8 } as never }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /hand-off/.test(e.message));
  current = { state: "assigned", revision: 8, generation: 3, owner: { kind: "agent", id: "ann" } };
  works.delete("agent:bob");
  assert.equal(warned.length, 0, "nothing warned so far: every holder so far had the rights");
  const move = { ...base, patch: { toAgent: "agent:bob", from: "agent:ann", generation: 3, revision: 8 } as never };
  await applier.apply(move);
  assert.equal(calls.length, 4, "a target without the rights still gets the task at once");
  assert.deepEqual(warned.map((w) => [w["commandId"], w["agent"], w["taskId"], w["projectId"], w["missing"]]), [["mtg:d1:c1", "agent:bob", "task-a", "proj-a", ["attempt.work"]]]);
  // A replay that finds this decision's own move done warns again (a crash may have cut the first warning off; the sink records it once under the change's own ID) and moves nothing.
  await applier.apply(move);
  assert.equal(calls.length, 4);
  assert.equal(warned.length, 2, "the replay of the decision's own move re-warns");
  // ... and succeeds although the new holder has meanwhile been disabled: a move that is done is not judged again.
  states["agent:bob"] = "disabled";
  await applier.apply(move);
  assert.equal(calls.length, 4, "a replay of a completed move succeeds for a holder that is no longer active");
  assert.equal(warned.length, 3);
  states["agent:bob"] = "active";
  // The owner later moved the task to bob by hand (a generation this decision did not make): the replay finds the holder and does not re-warn.
  log.length = 0;
  current = { state: "assigned", revision: 90, generation: 9, owner: { kind: "agent", id: "bob" } };
  log.push({ generation: 4, owner: { kind: "agent", id: "bob" }, reason: "the owner moved it by hand" });
  await applier.apply(move);
  assert.equal(warned.length, 3, "a hand move of the owner to the same agent is not this decision's: no warning");
});

test("a budget raise decided in a meeting widens spend, names a task and positive amounts only, and is carried out as the controller with who allowed it (card M02e)", async () => {
  const calls: Record<string, unknown>[] = [];
  const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
  const applier = budgetRaiseApplier({ raiseAgreed: async (_by: unknown, command: Record<string, unknown>) => { calls.push(command); } } as never, controller, { getTask: async (id: string) => (id === "task-a" ? { projectId: "proj-a" } : undefined) } as never);
  assert.deepEqual([applier.widens, applier.action], ["spend", "budget.manage"]);
  assert.equal(await applier.project({ kind: "task", id: "task-a" }), "proj-a");
  assert.equal(await applier.project({ kind: "agent", id: "task-a" }), undefined);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "task", id: "task-a" }, expectedRevision: 1 };
  await applier.apply({ ...base, patch: { costMicros: 500, computeMs: 60_000 }, agreedBy: "owner:agreed" });
  await applier.apply({ ...base, commandId: "mtg:d1:c2", patch: { costMicros: 5 }, agreedBy: "policy:spend" });
  assert.deepEqual(calls.map((c) => [c["taskId"], c["costMicros"], c["computeMs"], c["agreedBy"], c["decisionId"]]), [["task-a", 500, 60_000, "owner:agreed", "mtg:d1:c1"], ["task-a", 5, undefined, "policy:spend", "mtg:d1:c2"]]);
  for (const patch of [{}, { costMicros: -1 }, { costMicros: 1.5 }, { costMicros: 5, tokens: 9 }, { computeMs: "lots" }]) {
    await assert.rejects(() => applier.apply({ ...base, patch: patch as never, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  }
  await assert.rejects(() => applier.apply({ ...base, target: { kind: "agent", id: "x" }, patch: { costMicros: 1 }, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  assert.equal(calls.length, 2, "nothing refused reached the budget");
});

test("a grant decided in a meeting widens rights, is for the target project, one agent, one action and an end time, and is carried out as the controller with who allowed it (card M02e)", async () => {
  const calls: Record<string, unknown>[] = [];
  const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
  const applier = grantApplier({ grantAgreed: async (_by: unknown, command: Record<string, unknown>) => { calls.push(command); } } as never, controller);
  assert.deepEqual([applier.widens, applier.action], ["access-change", "principal.manage"]);
  assert.equal(await applier.project({ kind: "project", id: "proj-a" }), "proj-a");
  assert.equal(await applier.project({ kind: "task", id: "proj-a" }), undefined);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "project", id: "proj-a" }, expectedRevision: 1 };
  await applier.apply({ ...base, patch: { grantee: "agent:ann", action: "task.read", expiresAt: "2026-10-21T08:00:00Z", basis: "to read the plan" }, agreedBy: "policy:access-change" });
  assert.deepEqual(calls.map((c) => [c["grantee"], c["action"], c["project"], c["expiresAt"], c["agreedBy"], c["decisionId"], c["basis"]]), [["agent:ann", "task.read", "proj-a", "2026-10-21T08:00:00Z", "policy:access-change", "mtg:d1:c1", "to read the plan"]]);
  for (const patch of [{}, { grantee: "agent:ann", action: "task.read" }, { grantee: "agent:ann", action: "task.read", expiresAt: "2026-10-21T08:00:00Z", project: "*" }, { grantee: 5, action: "task.read", expiresAt: "x" }]) {
    await assert.rejects(() => applier.apply({ ...base, patch: patch as never, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  }
  await assert.rejects(() => applier.apply({ ...base, target: { kind: "task", id: "t" }, patch: { grantee: "agent:ann", action: "task.read", expiresAt: "2026-10-21T08:00:00Z" }, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError);
  assert.equal(calls.length, 1, "nothing refused reached the grants");
});

test("a grant decided in a meeting may name one task of the project, which becomes the grant's resource, and nothing else (card M02e)", async () => {
  const calls: Record<string, unknown>[] = [];
  const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as never;
  const tasks: Record<string, string> = { "task-a": "proj-a", "task-b": "proj-b" };
  const applier = grantApplier({ grantAgreed: async (_by: unknown, command: Record<string, unknown>) => { calls.push(command); } } as never, controller, { getTask: async (id: string) => (tasks[id] === undefined ? undefined : { projectId: tasks[id] }) } as never);
  const base = { commandId: "mtg:d1:c1", actor: "agent:x", target: { kind: "project", id: "proj-a" }, expectedRevision: 1 };
  const patch = { grantee: "agent:ann", action: "task.update", expiresAt: "2026-10-21T08:00:00Z" };
  await applier.apply({ ...base, patch: { ...patch, taskId: "task-a" }, agreedBy: "owner:agreed" });
  await applier.apply({ ...base, commandId: "mtg:d1:c2", patch, agreedBy: "owner:agreed" });
  assert.deepEqual(calls.map((c) => c["resource"]), [{ kind: "task", id: "task-a" }, undefined]);
  for (const bad of [{ taskId: "task-b" }, { taskId: "task-zzz" }, { taskId: 5 }, { taskId: "" }, { taskId: "task-a", resource: { kind: "project", id: "proj-a" } }]) {
    await assert.rejects(() => applier.apply({ ...base, patch: { ...patch, ...bad } as never, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  }
  const noProjects = grantApplier({ grantAgreed: async () => { calls.push({}); } } as never, controller);
  await assert.rejects(() => noProjects.apply({ ...base, patch: { ...patch, taskId: "task-a" }, agreedBy: "owner:agreed" }), (e: unknown) => e instanceof DomainError);
  assert.equal(calls.length, 2, "nothing refused reached the grants");
});
