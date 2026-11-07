import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import { agentsUnder, dispatchStopPorts, type LocalWork } from "./dispatch-ports.js";

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
  const cleaned = await ports.cleanup(task, { deadlineAt: new Date(Date.now() + 5000).toISOString(), backup: false, by: staff });
  assert.deepEqual(cleaned.remaining, [], "the call in flight settled");
  assert.deepEqual(await ports.checkpoint(task), { checkpointId: "task:task-x", durable: true, artifactsDurable: true });
  checkpoint = { id: "cp", artifactsDurable: false };
  assert.equal((await ports.checkpoint(task)).artifactsDurable, false);
  checkpoint = undefined;
  assert.equal((await ports.checkpoint(task)).durable, false, "no checkpoint from the hook is not a durable one");
  inflight = [{ callId: "c9", state: "uncertain" }];
  assert.deepEqual(await ports.terminate(task, { force: true, by: staff }), { ended: true, unresolved: ["att-1/c9"] });
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
  assert.deepEqual(await none.terminate(task, { force: false, by: staff }), { ended: true, unresolved: [] });
  assert.equal((await none.checkpoint(task)).durable, true);
  const pending = dispatchStopPorts(() => undefined, () => "pending");
  await assert.rejects(pending.inventory(task), /cannot be known/);
  await assert.rejects(pending.checkpoint(task), /cannot be known/);
  await assert.rejects(pending.terminate(task, { force: true, by: staff }), /cannot be known/);
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

  const live: Record<string, string[]> = { "agent:agt-1": ["att-1"], "agent:agt-2": ["att-2", "att-3"], "agent:agt-3": ["att-9"] };
  const stopped: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async (_b: Principal, s: { agentId?: string }) => live[s.agentId ?? ""] ?? [],
    quiesce: async () => ({ checkpoint: { id: "cp" } }), release: async () => undefined, operations: async () => [],
    stop: async (_b: Principal, id: string) => { stopped.push(id); },
  };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", (scope) => agentsUnder(storage, scope));
  assert.equal(ports.unsupported!({ kind: "team", id: "team-a" }), undefined);
  assert.deepEqual(await ports.terminate({ kind: "team", id: "team-a" }, { force: false, by: staff }), { ended: true, unresolved: [] });
  assert.deepEqual(stopped.sort(), ["att-1", "att-2", "att-3"], "every attempt under the team, none of another team's");
  stopped.length = 0;
  await ports.terminate({ kind: "installation", id: "installation" }, { force: true, by: staff });
  assert.equal(stopped.length, 4);
});

test("the stop inventory counts a task's running jobs, names one asked to stop as uncooperative and one with an unknown outcome as unknown, and terminate reports those as unresolved (card L02c)", async () => {
  let jobStates = [{ id: "job-a", state: "running" }, { id: "job-b", state: "cancellation_requested" }, { id: "job-c", state: "outcome_unknown" }, { id: "job-d", state: "completed" }];
  const dispatcher = {
    liveAttemptsOf: async () => ["att-1"],
    get: async () => ({ taskId: "task-x" }) as never,
    operations: async () => [] as never,
    stop: async () => undefined,
    quiesce: async () => ({}),
    release: async () => undefined,
  };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async (_by, taskId) => (taskId === "task-x" ? jobStates : []));
  const task = { kind: "task", id: "task-x" } as const;
  assert.deepEqual(await ports.inventory(task), [
    { kind: "job", ref: "job-a", state: "running" },
    { kind: "job", ref: "job-b", state: "uncooperative" },
    { kind: "job", ref: "job-c", state: "unknown" },
  ]);
  assert.deepEqual(await ports.terminate(task, { force: true, by: staff }), { ended: true, unresolved: ["job-b", "job-c"] });
  jobStates = [];
  assert.deepEqual(await ports.inventory(task), []);
});

test("a permitted remote background job the controller tracks is a named exception: it is not unsettled and a stop does not wait for it, while a local or untracked one still is (card L06)", async () => {
  const jobs = [
    { id: "job-remote", state: "running", kind: "remote", background: true, resumability: "remote_tracked" },
    { id: "job-remote-fg", state: "running", kind: "remote", background: false, resumability: "remote_tracked" },
    { id: "job-local", state: "running", kind: "process", background: true, resumability: "none" },
    { id: "job-remote-lost", state: "outcome_unknown", kind: "remote", background: true, resumability: "remote_tracked" },
  ];
  const dispatcher = { liveAttemptsOf: async () => ["att-1"], get: async () => ({ taskId: "task-x" }) as never, operations: async () => [] as never, stop: async () => undefined, quiesce: async () => ({}), release: async () => undefined };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async (_by, taskId) => (taskId === "task-x" ? jobs : []));
  const task = { kind: "task", id: "task-x" } as const;
  assert.deepEqual(await ports.inventory(task), [
    { kind: "job", ref: "job-remote", state: "tracked" },
    { kind: "job", ref: "job-remote-fg", state: "running" },
    { kind: "job", ref: "job-local", state: "running" },
    { kind: "job", ref: "job-remote-lost", state: "unknown" },
  ]);
});

test("the stop inventory lists the local processes and child work a runtime reports, an uncooperative or unknown one is unresolved, a runtime that cannot say is itself unknown, and the cleanup spend comes from the runtime (card L02d)", async () => {
  const dispatcher = { liveAttemptsOf: async () => ["att-1"], get: async () => ({ taskId: "task-x" }) as never, operations: async () => [] as never, stop: async () => undefined, quiesce: async () => ({}), release: async () => undefined };
  let report: Awaited<ReturnType<NonNullable<LocalWork["processes"]>>> | "down" = [{ ref: "pid-41", kind: "process", state: "running" }, { ref: "child-7", kind: "child", state: "uncooperative" }, { ref: "pid-42", kind: "process", state: "unknown" }];
  const asked: (readonly string[])[] = [];
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, {
    processes: async (attempts) => { asked.push(attempts); if (report === "down") throw new Error("worker unreachable"); return report; },
    spent: async () => 12,
  });
  const task = { kind: "task", id: "task-x" } as const;
  assert.deepEqual(await ports.inventory(task), [
    { kind: "process", ref: "pid-41", state: "running" }, { kind: "child", ref: "child-7", state: "uncooperative" }, { kind: "process", ref: "pid-42", state: "unknown" },
  ]);
  assert.deepEqual(asked, [["att-1"]], "asked about the scope's attempts only");
  assert.deepEqual(await ports.terminate(task, { force: true, by: staff }), { ended: true, unresolved: ["pid-41", "child-7", "pid-42"] }, "a process still running after the stop did not end");
  const cleaned = await ports.cleanup(task, { deadlineAt: new Date(Date.now() + 1000).toISOString(), backup: false, by: staff });
  assert.equal(cleaned.spent, 12);
  assert.equal(cleaned.remaining.length, 3);
  report = "down";
  assert.deepEqual(await ports.inventory(task), [{ kind: "process", ref: "runtime:processes", state: "unknown" }]);
  // An entry not shaped as promised is unknown, a command line is redacted, a bad figure is not charged, and an attempt that ended during preparation is still asked about.
  report = [{ ref: "run sk-live-ABCDEFGHIJKLMNOPQRSTUVWX1234", kind: "process", state: "running" }, { ref: 7 as never, kind: "process", state: "running" }];
  assert.deepEqual((await ports.inventory(task)).map((i) => i.ref), ["run [redacted]", "runtime:processes#1"]);
  const odd = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, { spent: async () => Number.NaN });
  assert.equal((await odd.cleanup(task, { deadlineAt: new Date(Date.now() + 1000).toISOString(), backup: false, by: staff })).spent, undefined);
  let live = ["att-1"];
  const asked2: (readonly string[])[] = [];
  const ending = { ...dispatcher, liveAttemptsOf: async () => live };
  const p2 = dispatchStopPorts(() => ({ dispatcher: ending as never, principal: staff }), () => "pending", undefined, undefined, { processes: async (a) => { asked2.push(a); return [{ ref: "pid-5", kind: "process", state: "uncooperative" }]; } });
  await p2.inventory(task);
  live = [];
  assert.deepEqual(await p2.terminate(task, { force: false, by: staff }), { ended: true, unresolved: ["pid-5"] });
  assert.deepEqual(asked2.at(-1), ["att-1"]);
  // A look-only inventory (a readiness check) remembers nothing: a later stop is not asked about attempts only a readiness check saw.
  let live2 = ["att-7"];
  const asked3: (readonly string[])[] = [];
  const looking = { ...dispatcher, liveAttemptsOf: async () => live2 };
  const p3 = dispatchStopPorts(() => ({ dispatcher: looking as never, principal: staff }), () => "pending", undefined, undefined, { processes: async (a) => { asked3.push(a); return []; } });
  await p3.inventory(task, { lookOnly: true });
  live2 = [];
  await p3.terminate(task, { force: false, by: staff });
  assert.deepEqual(asked3, [["att-7"]], "only the look itself asked; terminate had nothing remembered to ask about");
  // A restart empties the seen map; the attempts recorded on the stop request are given back, so a process of an attempt that ended before the restart is still asked about.
  const before = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, { processes: async () => [] });
  await before.inventory(task);
  assert.deepEqual(before.attempts!(task), ["att-1"]);
  const asked4: (readonly string[])[] = [];
  const restarted = dispatchStopPorts(() => ({ dispatcher: { ...dispatcher, liveAttemptsOf: async () => [] } as never, principal: staff }), () => "pending", undefined, undefined, { processes: async (a) => { asked4.push(a); return [{ ref: "pid-9", kind: "process", state: "running" }]; } });
  restarted.remember!(task, before.attempts!(task));
  assert.deepEqual(await restarted.terminate(task, { force: false, by: staff }), { ended: true, unresolved: ["pid-9"] });
  assert.deepEqual(asked4.at(-1), ["att-1"]);
  // Without the hook nothing is listed and nothing is charged.
  const bare = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending");
  assert.deepEqual(await bare.inventory(task), []);
  assert.equal((await bare.cleanup(task, { deadlineAt: new Date(Date.now() + 1000).toISOString(), backup: false, by: staff })).spent, undefined);
});

test("a stop goes on for the other attempts when one has ended meanwhile, and a begun stop drops the agent's ending at once (H12n review 2, 3b)", async () => {
  const stops: string[] = [];
  const dropped: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async () => ["att-1", "att-2"],
    stop: async (_by: Principal, id: string) => { if (id === "att-1") throw Object.assign(new DomainError("not_found", "finished meanwhile"), {}); stops.push(id); },
    operations: async () => [] as never,
    get: async () => undefined, quiesce: async () => ({}), release: async () => undefined,
  };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, undefined, { dropEnding: async (id, why) => { dropped.push(`${id}:${why}`); } });
  const task = { kind: "task", id: "task-x" } as const;
  await ports.begin!(task, { force: false, by: staff });
  assert.deepEqual(dropped, ["att-1:owner_stop", "att-2:owner_stop"]);
  assert.deepEqual(await ports.terminate(task, { force: false, by: staff }), { ended: true, unresolved: [] });
  assert.deepEqual(stops, ["att-2"]);
});

test("the cleanup lists a worker still coming up as a running process and goes on with the other attempts; any other quiesce failure still fails the cleanup (card H12q review)", async () => {
  const quiesced: string[] = [];
  let other: Error | undefined;
  const dispatcher = {
    liveAttemptsOf: async () => ["att-1", "att-2"], get: async () => undefined, operations: async () => [] as never, release: async () => undefined, stop: async () => undefined,
    quiesce: async (_by: Principal, id: string) => {
      if (other !== undefined) throw other;
      if (id === "att-1") throw new DomainError("unavailable", `the worker of attempt ${id} was still starting after 1 ms`, { field: "starting" });
      quiesced.push(id); return {};
    },
  };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }));
  const task = { kind: "task", id: "task-x" } as const;
  const cleaned = await ports.cleanup(task, { deadlineAt: new Date(Date.now() - 1000).toISOString(), backup: false, by: staff });
  assert.deepEqual(cleaned.remaining, [{ kind: "process", ref: "att-1/starting", state: "running" }]);
  assert.deepEqual(quiesced, ["att-2"], "the other attempt was still made quiet");
  other = new DomainError("unavailable", "the store is down");
  await assert.rejects(ports.cleanup(task, { deadlineAt: new Date(Date.now() + 1000).toISOString(), backup: false, by: staff }), /the store is down/);
});

test("terminate asks a task's jobs and its swarm children's jobs to stop (not a tracked remote one), Force Stop escalates one already asked, a job the asker may not control is unresolved, and the children's attempts are stopped and listed (card L02d)", async () => {
  const stopped: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { taskId?: string }) => (s.taskId === "task-x" ? ["att-1"] : s.taskId === "task-kid" ? ["att-2"] : []),
    get: async (_by: Principal, id: string) => ({ taskId: id === "att-1" ? "task-x" : "task-kid", agentId: "agent:a", state: stopped.includes(id) ? "finished" : "running" }) as never,
    operations: async () => [] as never, stop: async (_by: Principal, id: string) => { stopped.push(id); }, quiesce: async () => ({}), release: async () => undefined,
  };
  const jobs: Record<string, { id: string; state: string; kind: string; background: boolean; resumability: string }[]> = {
    "task-x": [{ id: "job-a", state: "running", kind: "process", background: true, resumability: "none" }, { id: "job-t", state: "running", kind: "remote", background: true, resumability: "remote_tracked" }, { id: "job-asked", state: "cancellation_requested", kind: "process", background: true, resumability: "none" }],
    "task-kid": [{ id: "job-k", state: "running", kind: "process", background: false, resumability: "none" }, { id: "job-nope", state: "running", kind: "process", background: false, resumability: "none" }],
  };
  const asked: string[] = [];
  const by = { id: "owner:rob", kind: "owner" } as unknown as Principal;
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async (_by, taskId) => jobs[taskId] ?? [], undefined, undefined, {
    descendants: async (taskId) => ({ ids: taskId === "task-x" ? ["task-kid"] : [], truncated: false }),
    cancelJob: async (who, jobId, o) => { assert.equal(who, by, "asked as whoever advances the stop"); if (jobId === "job-nope") throw new DomainError("forbidden", "no"); asked.push(`${jobId}${o.force ? " force" : ""}`); },
  });
  const task = { kind: "task", id: "task-x" } as const;
  const listed = await ports.inventory(task);
  assert.ok(listed.some((i) => i.kind === "child" && i.ref === "att-2" && i.state === "running"), JSON.stringify(listed));
  const graceful = await ports.terminate(task, { force: false, by });
  assert.deepEqual(stopped.sort(), ["att-1", "att-2"], "the child's attempt is stopped with the task's");
  assert.deepEqual(asked, ["job-a", "job-k"], "running jobs of the task and of its child, not the tracked remote one, not the one already asked");
  assert.ok(graceful.unresolved.includes("job-nope") && graceful.unresolved.includes("job-asked"), JSON.stringify(graceful));
  asked.length = 0;
  await ports.terminate(task, { force: true, by });
  assert.ok(asked.includes("job-asked force"), "Force Stop escalates a stop that was asked for");
  assert.ok(!asked.some((x) => x.startsWith("job-t")), "a tracked remote job is never cancelled");
  // A Stop of an agent scope or a Pause (no terminate) asks no job to stop.
});

test("the cleanup cost is read for every attempt seen, also one that ended, and charged to the attempt's task through the budget port (card L02d)", async () => {
  const dispatcher = { liveAttemptsOf: async () => ["att-1"], get: async (_by: Principal, id: string) => ({ taskId: id === "att-1" ? "task-x" : "task-y", agentId: "agent:a" }) as never, operations: async () => [] as never, stop: async () => undefined, quiesce: async () => ({}), release: async () => undefined };
  const charges: unknown[] = [];
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, { processes: async () => [], costs: async (a) => a.map((attemptId) => ({ attemptId, costMicros: 5 })) }, undefined, { charge: async (_by, c) => { charges.push(c); } });
  const task = { kind: "task", id: "task-x" } as const;
  ports.remember!(task, ["att-gone"]);
  await ports.inventory(task);
  const cleaned = await ports.cleanup(task, { deadlineAt: new Date(Date.now() + 1000).toISOString(), backup: false, by: staff });
  assert.deepEqual(cleaned.costs?.map((c) => c.attemptId).sort(), ["att-1", "att-gone"]);
  await ports.charge!({ commandId: "c1", attemptId: "att-gone", costMicros: 5, computeMs: 0 });
  assert.deepEqual(charges, [{ commandId: "c1", taskId: "task-y", agentId: "agent:a", costMicros: 5, computeMs: 0 }]);
});

test("a Stop of a task ends a swarm child's work only for someone who may control the child; the others are named as unresolved and left running (card L02d)", async () => {
  const stopped: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { taskId?: string }) => (s.taskId === "task-x" ? ["att-1"] : s.taskId === "task-mine" ? ["att-2"] : s.taskId === "task-theirs" ? ["att-3"] : []),
    get: async (_by: Principal, id: string) => ({ taskId: id === "att-1" ? "task-x" : id === "att-2" ? "task-mine" : "task-theirs", agentId: "agent:a", state: stopped.includes(id) ? "finished" : "running" }) as never,
    operations: async () => [] as never, stop: async (_by: Principal, id: string) => { stopped.push(id); }, quiesce: async () => ({}), release: async () => undefined,
  };
  const jobs: Record<string, { id: string; state: string; kind: string; background: boolean; resumability: string }[]> = { "task-theirs": [{ id: "job-theirs", state: "running", kind: "process", background: false, resumability: "none" }] };
  const cancelled: string[] = [];
  const manager = { id: "agent:mgr", kind: "agent" } as unknown as Principal;
  const owner = { id: "owner:rob", kind: "owner" } as unknown as Principal;
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async (_by, taskId) => jobs[taskId] ?? [], undefined, undefined, {
    descendants: async (taskId) => ({ ids: taskId === "task-x" ? ["task-mine", "task-theirs"] : [], truncated: false }),
    mayControl: async (by, taskId) => by.kind === "owner" || taskId === "task-mine",
    cancelJob: async (_by, jobId) => { cancelled.push(jobId); },
  });
  const task = { kind: "task", id: "task-x" } as const;
  const result = await ports.terminate(task, { force: false, by: manager });
  assert.deepEqual(stopped.sort(), ["att-1", "att-2"], "the child the manager controls is stopped, the other one is not");
  assert.ok(result.unresolved.some((u) => /task-theirs.*may not control/.test(u)), JSON.stringify(result));
  assert.ok(result.unresolved.includes("att-3"), "its attempt is still running, so it is named too");
  assert.ok(result.unresolved.some((u) => /job-theirs.*may not control/.test(u)) && cancelled.length === 0, "nor is its job asked to stop");
  // The owner may control every child.
  stopped.length = 0;
  const all = await ports.terminate(task, { force: false, by: owner });
  assert.deepEqual(stopped.sort(), ["att-1", "att-2", "att-3"]);
  assert.ok(!all.unresolved.some((u) => /may not control/.test(u)), JSON.stringify(all));
  assert.deepEqual(cancelled, ["job-theirs"]);
});

test("a Stop of an agent asks only that agent's jobs to stop (the owner of a job is the agent of its attempt), also on a task with no live attempt; a cut list is an unknown item (card L02d)", async () => {
  const owners: Record<string, string> = { "att-1": "agent:a", "att-other": "agent:b", "att-gone": "agent:a" };
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { agentId?: string }) => (s.agentId === "agent:a" ? ["att-1"] : []),
    get: async (_by: Principal, id: string) => ({ taskId: id === "att-gone" ? "task-idle" : "task-shared", agentId: owners[id], state: "running" }) as never,
    operations: async () => [] as never, stop: async () => undefined, quiesce: async () => ({}), release: async () => undefined,
  };
  const row = (id: string, taskId: string, attemptId?: string) => ({ id, taskId, state: "running", kind: "process", background: true, resumability: "none", ...(attemptId === undefined ? {} : { attemptId }) });
  let truncated = false;
  const cancelled: string[] = [];
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async () => [], undefined, undefined, {
    agentJobs: async () => ({ jobs: [row("job-mine", "task-shared", "att-1"), row("job-theirs", "task-shared", "att-other"), row("job-idle", "task-idle", "att-gone"), row("job-nobody", "task-shared")], truncated }),
    cancelJob: async (_by, jobId) => { cancelled.push(jobId); },
  });
  const agent = { kind: "agent", id: "a" } as const;
  assert.deepEqual((await ports.inventory(agent)).filter((i) => i.kind === "job").map((i) => i.ref).sort(), ["job-idle", "job-mine", "job-nobody"], "a job with no attempt on the agent's task is listed (its owner is not known)");
  const left = await ports.terminate(agent, { force: false, by: staff });
  assert.deepEqual(cancelled.sort(), ["job-idle", "job-mine"], "not the other agent's job on the same task, and a job with no known owner only at the owner's own stop");
  assert.ok(left.unresolved.some((u) => /job-nobody.*owner is not known/.test(u)), JSON.stringify(left));
  const ownerStop = { id: "owner:rob", kind: "owner" } as unknown as Principal;
  cancelled.length = 0;
  await ports.terminate(agent, { force: false, by: ownerStop });
  assert.ok(cancelled.includes("job-nobody"), "the owner's stop ends it too");
  truncated = true;
  assert.ok((await ports.inventory(agent)).some((i) => i.kind === "job" && i.ref === "jobs:truncated" && i.state === "unknown"));
});

test("more descendants than the walk returns is an unknown item in the inventory and a name in the unresolved list (card L02d)", async () => {
  const dispatcher = { liveAttemptsOf: async () => [], get: async () => undefined, operations: async () => [] as never, stop: async () => undefined, quiesce: async () => ({}), release: async () => undefined };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, undefined, undefined, { descendants: async () => ({ ids: [], truncated: true }) });
  const task = { kind: "task", id: "task-x" } as const;
  assert.deepEqual(await ports.inventory(task), [{ kind: "child", ref: "swarm:descendants-truncated", state: "unknown" }]);
  assert.deepEqual((await ports.terminate(task, { force: false, by: staff })).unresolved, ["swarm:descendants-truncated"]);
});

test("the swarm walk is read once per port call, not once per use (card L02d)", async () => {
  let walks = 0;
  const dispatcher = { liveAttemptsOf: async () => [], get: async () => undefined, operations: async () => [] as never, stop: async () => undefined, quiesce: async () => ({}), release: async () => undefined };
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async () => [], undefined, undefined, { descendants: async () => { walks++; return { ids: ["task-kid"], truncated: false }; } });
  await ports.inventory({ kind: "task", id: "task-x" });
  assert.equal(walks, 1);
});

test("a Stop asks the task's jobs to stop before the checkpoint is taken; a Suspend leaves them running while it checkpoints (card L02d)", async () => {
  const log: string[] = [];
  const dispatcher = { liveAttemptsOf: async () => ["att-1"], get: async () => ({ taskId: "task-x", agentId: "agent:a", state: "running" }) as never, operations: async () => [] as never, stop: async () => undefined, quiesce: async (_by: Principal, id: string, why: string) => { log.push(`quiesce ${why}`); return { checkpoint: { id: "cp" } }; }, release: async () => undefined };
  const jobs = [{ id: "job-a", state: "running", kind: "process", background: true, resumability: "none" }];
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async () => jobs, undefined, undefined, { cancelJob: async (_by, id) => { log.push(`ask ${id}`); } });
  const task = { kind: "task", id: "task-x" } as const;
  await ports.checkpoint(task, { by: staff, mode: "suspend" });
  assert.deepEqual(log, ["quiesce checkpoint before suspension"], "a Suspend does not touch the job");
  log.length = 0;
  await ports.checkpoint(task, { by: staff, mode: "stop" });
  assert.deepEqual(log, ["ask job-a", "quiesce checkpoint before suspension"], "a Stop asks first");
});

test("a checkpoint quiesces only the attempts the asker may control: a swarm child they may not touch is left alone (card L02d review)", async () => {
  const quiesced: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { taskId?: string }) => (s.taskId === "task-x" ? ["att-1"] : s.taskId === "task-mine" ? ["att-2"] : s.taskId === "task-theirs" ? ["att-3"] : []),
    get: async (_by: Principal, id: string) => ({ taskId: id === "att-1" ? "task-x" : id === "att-2" ? "task-mine" : "task-theirs", agentId: "agent:a", state: "running" }) as never,
    operations: async () => [] as never, stop: async () => undefined, release: async () => undefined,
    quiesce: async (_by: Principal, id: string) => { quiesced.push(id); return { checkpoint: { id: "cp" } }; },
  };
  const manager = { id: "agent:mgr", kind: "agent" } as unknown as Principal;
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, undefined, undefined, undefined, {
    descendants: async (taskId) => ({ ids: taskId === "task-x" ? ["task-mine", "task-theirs"] : [], truncated: false }),
    mayControl: async (by, taskId) => by.kind === "owner" || taskId === "task-mine",
  });
  const task = { kind: "task", id: "task-x" } as const;
  await ports.checkpoint(task, { by: manager, mode: "suspend" });
  assert.deepEqual(quiesced.sort(), ["att-1", "att-2"], "att-3 belongs to a child the manager may not control");
});
