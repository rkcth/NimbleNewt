import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "../security/principals.js";
import { agentsUnder, dispatchStopPorts } from "./dispatch-ports.js";

const staff = { id: "service:dispatcher", kind: "service" } as unknown as Principal;

test("the dispatcher ports: live attempts of a task, calls in flight as inventory, a quiet checkpoint, a stop that reports uncertain calls (card L02)", async () => {
  const log: string[] = [];
  let inflight = [{ callId: "c1", state: "running" }, { callId: "c0", state: "confirmed" }];
  let checkpoint: Record<string, unknown> | undefined = { id: "cp" };
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { taskId?: string; agentId?: string }) => { log.push(`live ${s.taskId ?? s.agentId}`); return ["att-1"]; },
    quiesce: async (by: Principal, id: string) => { log.push(`quiesce ${id} as ${by.id}`); inflight = [{ callId: "c1", state: "cancelled" }, { callId: "c0", state: "confirmed" }]; return checkpoint === undefined ? {} : { checkpoint }; },
    release: async (_by: Principal, id: string) => { log.push(`release ${id}`); },
    stop: async (_by: Principal, id: string, o: { emergency?: boolean }) => { log.push(`stop ${id}${o.emergency ? " emergency" : ""}`); },
    operations: async () => inflight.map((o) => ({ ...o })) as never,
  };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }));
  const task = { kind: "task", id: "task-x" } as const;
  assert.deepEqual(await ports.inventory(task), [{ kind: "foreground", ref: "att-1/c1", state: "running" }]);
  const cleaned = await ports.cleanup(task, { deadlineAt: new Date(Date.now() + 5000).toISOString(), backup: false });
  assert.deepEqual(cleaned.remaining, [], "the call in flight settled");
  assert.deepEqual(await ports.checkpoint(task), { checkpointId: "task:task-x", durable: true, artifactsDurable: true });
  checkpoint = { id: "cp", artifactsDurable: false };
  assert.equal((await ports.checkpoint(task)).artifactsDurable, false);
  checkpoint = undefined;
  assert.equal((await ports.checkpoint(task)).durable, false, "no checkpoint from the hook is not a durable one");
  inflight = [{ callId: "c9", state: "uncertain" }];
  assert.deepEqual(await ports.terminate(task, { force: true }), { ended: true, unresolved: ["att-1/c9"] });
  assert.ok(log.includes("stop att-1 emergency"));
  await ports.release!(task);
  assert.ok(log.includes("release att-1"), "what preparation froze can be let go");
  assert.ok(log.every((l) => !l.includes("quiesce") || l.endsWith("as service:dispatcher")), "the runtime acts as the dispatcher, not as the asker");
  // A scope the runtime does not resolve is said so; with no dispatcher there is nothing to do.
  await assert.rejects(ports.inventory({ kind: "team", id: "team-x" }), /not resolved to attempts/);
  assert.match(ports.unsupported!({ kind: "team", id: "team-x" }) ?? "", /not supported yet/);
  assert.equal(ports.unsupported!(task), undefined);
  // No dispatcher in this controller: nothing can be running. One that should exist but is not up: nothing is claimed.
  const none = dispatchStopPorts(() => undefined, () => "none");
  assert.deepEqual(await none.inventory(task), []);
  assert.deepEqual(await none.terminate(task, { force: false }), { ended: true, unresolved: [] });
  assert.equal((await none.checkpoint(task)).durable, true);
  const pending = dispatchStopPorts(() => undefined, () => "pending");
  await assert.rejects(pending.inventory(task), /cannot be known/);
  await assert.rejects(pending.checkpoint(task), /cannot be known/);
  await assert.rejects(pending.terminate(task, { force: true }), /cannot be known/);
});

test("a team or installation scope covers the agents whose team chain passes through it, and its attempts are every one of theirs (card L02b)", async () => {
  const rec = (id: string, body: object) => ({ id, body });
  const records: Record<string, { id: string; body: object }[]> = {
    team: [rec("team-a", {}), rec("team-b", { parentTeamId: "team-a" }), rec("team-c", {}), rec("team-loop1", { parentTeamId: "team-loop2" }), rec("team-loop2", { parentTeamId: "team-loop1" })],
    agent: [rec("agt-1", { teamId: "team-a" }), rec("agt-2", { teamId: "team-b" }), rec("agt-3", { teamId: "team-c" }), rec("agt-4", {}), rec("agt-5", { teamId: "team-loop1" })],
  };
  const storage = { listAggregates: async (kind: string, o: { afterId?: string; limit: number }) => (records[kind] ?? []).filter((r) => o.afterId === undefined || r.id > o.afterId).slice(0, o.limit) } as never;
  assert.deepEqual(await agentsUnder(storage, { kind: "team", id: "team-a" }), ["agt-1", "agt-2"], "a child team's agents are under the parent; a loop in the chain ends the walk");
  assert.deepEqual(await agentsUnder(storage, { kind: "team", id: "team-c" }), ["agt-3"]);
  assert.equal((await agentsUnder(storage, { kind: "installation", id: "installation" })).length, 5);

  const live: Record<string, string[]> = { "agt-1": ["att-1"], "agt-2": ["att-2", "att-3"], "agt-3": ["att-9"] };
  const stopped: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async (_b: Principal, s: { agentId?: string }) => live[s.agentId ?? ""] ?? [],
    quiesce: async () => ({ checkpoint: { id: "cp" } }), release: async () => undefined, operations: async () => [],
    stop: async (_b: Principal, id: string) => { stopped.push(id); },
  };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", (scope) => agentsUnder(storage, scope));
  assert.equal(ports.unsupported!({ kind: "team", id: "team-a" }), undefined);
  assert.deepEqual(await ports.terminate({ kind: "team", id: "team-a" }, { force: false }), { ended: true, unresolved: [] });
  assert.deepEqual(stopped.sort(), ["att-1", "att-2", "att-3"], "every attempt under the team, none of another team's");
  stopped.length = 0;
  await ports.terminate({ kind: "installation", id: "installation" }, { force: true });
  assert.equal(stopped.length, 4);
});
