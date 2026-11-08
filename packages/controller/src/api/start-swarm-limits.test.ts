import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import { BudgetService } from "../budgets/budgets.js";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, workGrants } from "../dispatch/testing/world.js";
import { CommandRunner } from "../domain/runner.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { RemoteWorkerClient } from "../remote/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
// One agent has one native store, so the attempts here each use their own agent.
const AGENTS = "abcdefghijklmn".split("").map((ch) => `agt-${ch.repeat(20)}`);
const WANT = { expectedResult: "seeds ordered", acceptanceCriteria: ["the order number is recorded"] };

test("distributed capacity through the composed controller (card H10): the owner declares hosts and sets host and global quotas and swarm limits by API and in chat; exhausted slots and budgets block expansion; cancelling a swarm settles its children while the work is full; a child runs only on its own delegated allowance", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-h10-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    dispatch: {
      timer: new ManualTimer(), manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: false } }),
      remote: { blobDirectory: join(d, "blobs"), hosts: [{ hostId: "host:pc", checkpointWaitMs: 300, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
    },
  });
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined && c.dispatch.remote !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
    const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl, token: (await c.services.principals.issueCredential(rob, "host:pc")).token, workerVersion: "worker-9.1.0" });
    await client.connect({ ...CAPS } as never);
    await client.heartbeat(1);
    for (const a of AGENTS) await c.services.principals.enroll(rob, { commandId: `e-${a}`, kind: "agent", name: a, grants: workGrants(project, ["read-file"]) });
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const as = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => as(boot.token, op, args, commandId);
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    let n = 0;
    const work = async (taskId: string): Promise<string> => {
      const k = n++;
      const agent = AGENTS[k]!;
      const t = (await c.services.projects.getTask(taskId))!;
      if (t.state !== "ready") await c.services.projects.transitionTask({ commandId: `r${k}`, actor: rob.id, taskId, expectedRevision: t.revision, to: "ready" });
      await c.services.assignments.assignTask({ commandId: `as${k}`, actor: rob.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await c.services.assignments.getAssignment(taskId))!;
      return (await c.services.assignments.admitAttempt({ commandId: `ad${k}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    };
    const newTask = async (title: string): Promise<string> => (await c.services.projects.createTask({ commandId: `t-${title.replace(/ /g, "-")}`, actor: rob.id, projectId: project, title })).id;
    const tick = () => c.dispatch!.dispatcher.tick();

    // ---- Host and global quotas. A host whose CPUs and memory nobody declared runs nothing.
    const t0 = await work(await newTask("Order seeds"));
    assert.deepEqual((await tick()).started, [], "no declared capacity: nothing is placed on the host");
    assert.equal((await as(ann, "capacity.quotas.get", {})).error?.code, "forbidden");
    assert.equal((await as(ann, "capacity.quotas.change", { set: { perHost: 1 } }, "q0")).error?.code, "forbidden");
    assert.equal((await call("capacity.quotas.change", { set: { perHost: 99 } }, "q-bad")).error?.code, "invalid_command");
    assert.ok((await call("capacity.quotas.change", { hosts: { "host:pc": { cpus: 64, memoryMb: 262_144 } }, set: { productive: 2, perHost: 1 } }, "q1")).ok);
    const t0b = (await c.dispatch.dispatcher.get(c.dispatch.principal, t0))!;
    const first = t0b.state === "running" || t0b.requestId !== undefined ? await tick() : await tick();
    void first;
    // The withdrawn request is asked again on a later tick; within two ticks the attempt runs.
    const ran = new Set<string>([...first.started, ...(await tick()).started]);
    assert.ok(ran.has(t0), `the declared host now runs the attempt: ${JSON.stringify([...ran])}`);
    const t1 = await work(await newTask("Water seeds"));
    const full = await tick();
    assert.ok(!full.started.includes(t1) && full.waiting.includes(t1), `one attempt per host: ${JSON.stringify(full)}`);
    const quotas = (await call("capacity.quotas.get", {})).result.item;
    assert.deepEqual([quotas.limits, quotas.hosts, quotas.running.perHost], [{ productive: 2, perHost: 1, control: 2, queue: 100 }, { "host:pc": { cpus: 64, memoryMb: 262_144 } }, { "host:pc": 1 }]);
    // In chat, in the owner's own words: shown first, applied on the owner's word; the waiting attempt then starts.
    const text = "let a host run two things at once";
    const shown = await turn("m1", text, [{ kind: "command", op: "capacity.quotas.change", args: { set: { perHost: 2 } }, evidence: text, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.deepEqual((await tick()).started, [], "nothing changes while it waits for the owner");
    const applied = await turn("m2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.deepEqual((await tick()).started, [t1]);

    // ---- Swarm limits. The owner limits a parent to two live children in chat.
    const root = await newTask("Plant the garden");
    assert.ok((await call("budget.open", { taskId: root, currency: "USD", costMicros: 1_000_000, computeMs: 7_200_000 }, "b-root")).ok);
    const limitsText = "a task may have at most two children working at once";
    const proposal = await turn("m3", limitsText, [{ kind: "command", op: "swarm.limits.change", args: { set: { liveChildren: 2 } }, evidence: limitsText, basis: "owner" }]);
    assert.equal(proposal[0]!.status, "proposed", JSON.stringify(proposal));
    const limited = await turn("m4", "yes, do that one too", [{ kind: "apply_proposal", proposalId: proposal[0]!.proposalId, evidence: "do that one too", basis: "owner" }]);
    assert.equal(limited[0]!.status, "applied", JSON.stringify(limited));
    assert.deepEqual((await call("swarm.limits.get", {})).result.item.effective, { depth: 3, liveChildren: 2, totalChildren: 16 });
    assert.equal((await as(ann, "swarm.limits.change", { set: { depth: 8 } }, "sl-ann")).error?.code, "forbidden");
    const spawn = (title: string, extra: Record<string, unknown> = {}, id = `sp-${title}`) => call("swarm.spawn", { parentTaskId: root, title, ...WANT, costMicros: 100_000, computeMs: 1_800_000, ...extra }, id);
    // The parent assigns the outcome and acceptance criteria; a child without them is not made.
    assert.equal((await call("swarm.spawn", { parentTaskId: root, title: "Vague", costMicros: 1, computeMs: 1 }, "sp-vague")).error?.code, "invalid_command");
    // An allowance larger than what the parent has left blocks expansion (the budget), and so does a full set of live children (the slots).
    assert.match((await spawn("Greedy", { computeMs: 9_000_000 })).error?.message ?? "", /budget: the parent cannot give that/);
    const kidA = (await spawn("Dig")).result.taskId as string;
    const kidB = (await spawn("Rake")).result.taskId as string;
    const third = await spawn("Hoe");
    assert.match(third.error?.message ?? "", /at most 2 live children/, JSON.stringify(third));
    const contract = (await call("contract.get", { taskId: kidA })).result;
    assert.equal(JSON.stringify(contract).includes(WANT.acceptanceCriteria[0]!), true, "the child's contract carries what the parent assigned");

    // The children's attempts wait: the host's two places are taken.
    const aA = await work(kidA);
    const aB = await work(kidB);
    const busy = await tick();
    assert.ok(busy.waiting.includes(aA) && busy.waiting.includes(aB), JSON.stringify(busy));
    // Control traffic stays responsive while the work is full: a review is admitted on the reserved places at once, and cancelling the swarm settles both children.
    const review = await AdmissionService.withEpoch(c.storage, c.epoch).request({ commandId: "rv1", actor: "dispatcher", class: "review", cpus: 1, memoryMb: 128 });
    assert.equal(review.state, "running");
    // In one call: a child whose attempt never started has nothing to checkpoint, so its Stop does not block on one.
    const cancelled = await call("swarm.cancel", { parentTaskId: root, reason: "plans changed" }, "sc1");
    assert.ok(cancelled.ok, JSON.stringify(cancelled));
    assert.deepEqual([[...cancelled.result.settled].sort(), cancelled.result.pending], [[kidA, kidB].sort(), []], JSON.stringify((await c.storage.listAggregates("stop-intent", { limit: 50 })).map((x) => x.body)));
    for (const k of [kidA, kidB]) assert.equal((await c.services.projects.getTask(k))!.state, "cancelled");
    const budgets = BudgetService.withEpoch(c.storage, c.epoch);
    assert.deepEqual((await budgets.report(rob, root))!.delegatedToChildren, { costMicros: 0, computeMs: 0 }, "what the children were given came back");
    const after = await tick();
    assert.ok(!after.started.includes(aA) && !after.started.includes(aB), "a cancelled child's attempt never starts");

    // A spawned task with no allowance of its own (its spawn crashed before handing it over) does not run on no budget: the dispatcher blocks it.
    const orphan = await newTask("Orphan");
    const ref = { kind: "swarm-link", id: orphan };
    await new CommandRunner(c.storage, c.epoch, {}).command("swarm.test-link", { commandId: "orphan-link", actor: "system" }, async () => ({ payload: { orphan }, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { parentTaskId: root, projectId: project, createdBy: rob.id, createdAt: new Date().toISOString() } }], detail: {} }) }));
    const aO = await work(orphan);
    // Room for it, so only the missing allowance can hold it.
    assert.ok((await call("capacity.quotas.change", { set: { productive: 6, perHost: 6 } }, "q2")).ok);
    const blocked = await tick();
    const block = blocked.blocked.find((b) => b.attemptId === aO);
    assert.equal(block?.check, "budget", JSON.stringify(blocked));
    assert.ok(!blocked.started.includes(aO));

    // A spawned child that runs holds its compute on its own allowance only: the parent's own figure holds nothing.
    const kidC = (await spawn("Sow", {}, "sp-sow")).result.taskId as string;
    const aC = await work(kidC);
    const go = await tick();
    assert.ok(go.started.includes(aC), JSON.stringify(go));
    const kidReport = (await budgets.report(rob, kidC))!;
    const rootReport = (await budgets.report(rob, root))!;
    assert.ok(kidReport.reservedInFlight.computeMs > 0 && kidReport.reservedInFlight.computeMs <= 1_800_000, JSON.stringify(kidReport.reservedInFlight));
    assert.deepEqual(rootReport.reservedInFlight, { costMicros: 0, computeMs: 0 }, "nothing was held on the parent's own allowance");
    assert.equal(rootReport.delegatedToChildren.computeMs, 1_800_000);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
