// W01 acceptance for card L02e (l02e-2): a Stop of an agent, a team or the installation reaches the swarm children of its tasks.
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Principal } from "../security/principals.js";
import { agentsUnder, dispatchStopPorts } from "./dispatch-ports.js";

const staff = { id: "service:dispatcher", kind: "service" } as unknown as Principal;

test("a Stop of an agent reaches the swarm children of its tasks: listed, ended, jobs asked; a child the asker may not control is named and left; Force Stop ends what it holds for the rest; a cut walk is unknown", async () => {
  const stopped: string[] = [];
  const dispatcher = {
    liveAttemptsOf: async (_by: Principal, s: { taskId?: string; agentId?: string }) => (s.agentId === "agent:a" ? ["att-a"] : s.taskId === "task-kid" ? ["att-kid"] : s.taskId === "task-theirs" ? ["att-theirs"] : []),
    get: async (_by: Principal, id: string) => ({ taskId: id === "att-a" ? "task-a" : id === "att-kid" ? "task-kid" : "task-theirs", agentId: "agent:a", state: stopped.includes(id) ? "finished" : "running" }) as never,
    operations: async () => [] as never, stop: async (_by: Principal, id: string) => { stopped.push(id); }, quiesce: async () => ({ checkpoint: { id: "cp" } }), release: async () => undefined,
  };
  const jobRow = (id: string) => ({ id, state: "running", kind: "process", background: false, resumability: "none" });
  const jobs: Record<string, { id: string; state: string; kind: string; background: boolean; resumability: string }[]> = { "task-a": [jobRow("job-a")], "task-kid": [jobRow("job-k")], "task-theirs": [jobRow("job-theirs")] };
  const cancelled: string[] = [];
  const rootsSeen: string[][] = [];
  let cut = false;
  const held = new Map<string, "uncooperative">([["att-kid", "uncooperative"], ["att-theirs", "uncooperative"]]);
  const ended: string[][] = [];
  const pidOf = (a: string): string => `pid of ${a}`;
  const local = {
    processes: async (attempts: readonly string[]) => attempts.filter((a) => held.has(a)).map((a) => ({ ref: pidOf(a), kind: "process" as const, state: held.get(a)! })),
    end: async (attempts: readonly string[]) => { ended.push([...attempts].sort()); for (const a of attempts) held.delete(a); },
  };
  const owner = { id: "owner:rob", kind: "owner" } as unknown as Principal;
  const manager = { id: "agent:mgr", kind: "agent" } as unknown as Principal;
  const ports = dispatchStopPorts(() => ({ dispatcher: dispatcher as never, principal: staff }), () => "pending", undefined, async (_by, taskId) => jobs[taskId] ?? [], local, undefined, {
    descendantsOf: async (roots) => { rootsSeen.push([...roots].sort()); return { ids: roots.includes("task-a") ? ["task-kid", "task-theirs"] : [], truncated: cut }; },
    mayControl: async (by, taskId) => by.kind === "owner" || taskId !== "task-theirs",
    cancelJob: async (_by, jobId) => { cancelled.push(jobId); },
  });
  const agent = { kind: "agent", id: "a" } as const;
  const listed = await ports.inventory(agent);
  assert.ok(rootsSeen.some((r) => r.includes("task-a")), `the walk is asked for the tasks the agent runs: ${JSON.stringify(rootsSeen)}`);
  assert.ok(listed.some((i) => i.kind === "child" && i.ref === "att-kid" && i.state === "running"), `the child's attempt is delegated work: ${JSON.stringify(listed)}`);
  assert.ok(listed.some((i) => i.kind === "job" && i.ref === "job-k") && listed.some((i) => i.kind === "job" && i.ref === "job-theirs"), `the children's jobs are listed: ${JSON.stringify(listed)}`);
  const graceful = await ports.terminate(agent, { force: false, by: owner });
  assert.deepEqual([...stopped].sort(), ["att-a", "att-kid", "att-theirs"], "the owner's Stop of the agent ends its tasks' children too");
  assert.deepEqual([...cancelled].sort(), ["job-a", "job-k", "job-theirs"]);
  assert.ok(graceful.unresolved.includes(pidOf("att-kid")) && graceful.unresolved.includes(pidOf("att-theirs")), JSON.stringify(graceful));
  assert.equal(ended.length, 0, "a graceful Stop asks, it does not kill");
  stopped.length = 0; cancelled.length = 0;
  held.set("att-kid", "uncooperative"); held.set("att-theirs", "uncooperative");
  const part = await ports.terminate(agent, { force: false, by: manager });
  assert.deepEqual([...stopped].sort(), ["att-a", "att-kid"], "the child the manager may not control is not stopped");
  assert.ok(!cancelled.includes("job-theirs") && cancelled.includes("job-k"), `its job is not asked either: ${cancelled.join(",")}`);
  assert.ok(part.unresolved.some((u) => /task-theirs.*may not control/.test(u)), JSON.stringify(part));
  const forced = await ports.terminate(agent, { force: true, by: manager });
  assert.ok(ended.length > 0, "Force Stop ends what the runtime holds");
  assert.ok(ended.at(-1)!.includes("att-kid") && !ended.at(-1)!.includes("att-theirs"), JSON.stringify(ended));
  assert.ok(!forced.unresolved.includes(pidOf("att-kid")) && forced.unresolved.includes(pidOf("att-theirs")), JSON.stringify(forced));
  cut = true;
  assert.ok((await ports.inventory(agent)).some((i) => i.kind === "child" && i.ref === "swarm:descendants-truncated" && i.state === "unknown"), "a cut walk is an unknown item for a wider scope too");
});

const teamStorage = () => {
  const rec = (id: string, body: object) => ({ id, body });
  const records: Record<string, { id: string; body: object }[]> = {
    team: [rec("team-a", {})],
    agent: [rec("agt-1", { teamId: "team-a" }), rec("agt-2", { teamId: "team-a" })],
  };
  return { listAggregates: async (kind: string, o: { afterId?: string; limit: number }) => (records[kind] ?? []).filter((r) => o.afterId === undefined || r.id > o.afterId).slice(0, o.limit) } as never;
};
const teamDispatcher = (stopped: string[]) => ({
  liveAttemptsOf: async (_by: Principal, s: { taskId?: string; agentId?: string }) => (s.agentId === "agent:agt-1" ? ["att-1"] : s.agentId === "agent:agt-2" ? ["att-2"] : s.taskId === "task-kid" ? ["att-kid"] : []),
  get: async (_by: Principal, id: string) => ({ taskId: id === "att-1" ? "task-1" : id === "att-2" ? "task-2" : "task-kid", agentId: "agent:agt-3", state: stopped.includes(id) ? "finished" : "running" }) as never,
  operations: async () => [] as never, stop: async (_by: Principal, id: string) => { stopped.push(id); }, quiesce: async () => ({ checkpoint: { id: "cp" } }), release: async () => undefined,
});

test("a Stop of a team or the installation walks the children of every task under it, all its tasks given to the hook together", async () => {
  const stopped: string[] = [];
  const storage = teamStorage();
  const roots: string[][] = [];
  const ports = dispatchStopPorts(() => ({ dispatcher: teamDispatcher(stopped) as never, principal: staff }), () => "pending", (scope) => agentsUnder(storage, scope), undefined, undefined, undefined, {
    descendantsOf: async (r) => { roots.push([...r].sort()); return { ids: r.includes("task-1") ? ["task-kid"] : [], truncated: false }; },
  });
  assert.ok((await ports.inventory({ kind: "team", id: "team-a" })).some((i) => i.kind === "child" && i.ref === "att-kid"), "a child of a task under the team is the team's work");
  assert.ok(roots.some((r) => r.includes("task-1") && r.includes("task-2")), `both tasks of the team in one call: ${JSON.stringify(roots)}`);
  await ports.terminate({ kind: "installation", id: "installation" }, { force: false, by: staff });
  assert.deepEqual([...stopped].sort(), ["att-1", "att-2", "att-kid"], "the installation reaches the same child");
});

test("without descendantsOf, a wider Stop walks each of its tasks with the single-task descendants hook and merges the results", async () => {
  const stopped: string[] = [];
  const storage = teamStorage();
  const ports = dispatchStopPorts(() => ({ dispatcher: teamDispatcher(stopped) as never, principal: staff }), () => "pending", (scope) => agentsUnder(storage, scope), undefined, undefined, undefined, {
    descendants: async (taskId) => ({ ids: taskId === "task-2" ? ["task-kid"] : [], truncated: false }),
  });
  assert.ok((await ports.inventory({ kind: "team", id: "team-a" })).some((i) => i.kind === "child" && i.ref === "att-kid"));
  await ports.terminate({ kind: "team", id: "team-a" }, { force: false, by: staff });
  assert.deepEqual([...stopped].sort(), ["att-1", "att-2", "att-kid"]);
});
