import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "../security/principals.js";
import { dispatchStopPorts } from "./dispatch-ports.js";

const staff = { id: "service:dispatcher", kind: "service" } as unknown as Principal;

test("the dispatcher ports: live attempts of a task, calls in flight as inventory, a quiet checkpoint, a stop that reports uncertain calls (card L02)", async () => {
  const log: string[] = [];
  let inflight = [{ callId: "c1", state: "running" }, { callId: "c0", state: "confirmed" }];
  let checkpoint: Record<string, unknown> | undefined = { id: "cp" };
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { taskId?: string; agentId?: string }) => { log.push(`live ${s.taskId ?? s.agentId}`); return ["att-1"]; },
    quiesce: async (by: Principal, id: string) => { log.push(`quiesce ${id} as ${by.id}`); inflight = [{ callId: "c1", state: "cancelled" }, { callId: "c0", state: "confirmed" }]; return checkpoint === undefined ? {} : { checkpoint }; },
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
  assert.ok(log.every((l) => !l.includes("quiesce") || l.endsWith("as service:dispatcher")), "the runtime acts as the dispatcher, not as the asker");
  // A scope the runtime does not resolve is said so; with no dispatcher there is nothing to do.
  await assert.rejects(ports.inventory({ kind: "team", id: "team-x" }), /not resolved to attempts/);
  const none = dispatchStopPorts(() => undefined);
  assert.deepEqual(await none.inventory(task), []);
  assert.deepEqual(await none.terminate(task, { force: false }), { ended: true, unresolved: [] });
});
