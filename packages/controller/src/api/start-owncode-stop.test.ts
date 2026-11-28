import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService } from "../admission/service.js";
import type { DispatchBody } from "../dispatch/model.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI, ScriptedWorker, workGrants } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { HostService } from "../hosts/hosts.js";
import { NotificationService } from "../notifications/index.js";
import { derivedId } from "../domain/ids.js";
import { OWNCODE_OFF } from "../owncode/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { startController } from "./index.js";

// Card B06, second slice, through the composed controller with a local worker host whose agents run until they are stopped: an attempt already running in the NimbleNewt development project is stopped
// through L02's Stop of its task at the next dispatcher tick once the owner withdraws its approval or switches the feature off. The attempt ends abandoned with its records kept, the Stop and the pause carry
// the gate's reason, and the owner is told once. Work in another project keeps running. A repeated tick and a restart ask for nothing more.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };

/** A scripted local host whose agents run until they are stopped, and which holds nothing else. */
function runUntilStopped(): ScriptedWorker {
  const host = new ScriptedWorker("host:w1", async ({ worker }) => {
    await new Promise<void>((done) => { const stop = worker.stop.bind(worker); worker.stop = async () => { await stop(); done(); }; });
    return { status: "completed", text: "stopped" };
  });
  (host as unknown as WorkerHost).localWork = async () => ({ processes: [] });
  return host;
}
const open = (file: string, host: WorkerHost) => startController({
  storage: { kind: "sqlite", path: file }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
  dispatch: {
    timer: new ManualTimer(), manual: true,
    route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
    local: { acceptUnenforcedLimits: true, window: () => 8192, build: () => host },
  },
});
type C = Awaited<ReturnType<typeof open>>;
const call = async (c: C, token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
const dispatchOf = async (c: C, attemptId: string): Promise<DispatchBody> => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId)) as unknown as DispatchBody;
interface Intent { scope: { kind: string; id: string }; reason: string; phase: string; requestedBy: string; outcome?: { state: string } }
const intentsFor = async (c: C, taskId: string): Promise<Intent[]> => (await c.storage.listAggregates("stop-intent", { limit: 200 })).map((r) => r.body as unknown as Intent).filter((b) => b.scope.kind === "task" && b.scope.id === taskId);

test("work already running on NimbleNewt's own code is stopped through L02's Stop at the next tick once the owner withdraws the approval or switches the feature off; other work runs on (card B06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-b06s-"));
  const file = join(d, "c.sqlite");
  let c = await open(file, runUntilStopped());
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const devProject = (await c.services.projects.createProject({ commandId: "p-dev", actor: owner.id, name: "NimbleNewt development" })).id;
    const garden = (await c.services.projects.createProject({ commandId: "p-garden", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const hostP = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
    const hosts = HostService.withEpoch(c.storage, c.epoch, c.services.assignments);
    await hosts.announce(hostP, { commandId: "an1", capabilities: CAPS as never });
    await hosts.heartbeat(hostP, { commandId: "hb1", sequence: 1 });
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 32, memoryMb: 65_536 } });
    /** One agent per task (an agent runs one attempt at a time), each with the grants a worker needs in both projects. */
    const agent = async (name: string): Promise<string> => {
      const id = (await c.services.agents.create(owner, { commandId: `ag-${name}`, friendlyName: name })).id;
      for (const project of [devProject, garden]) for (const g of [{ action: "task.read" }, ...workGrants(project, ["read-file"])]) await c.services.grants.grant(owner, { commandId: `g-${name}-${project}-${g.action}`, grantee: `agent:${id}`, action: g.action, project, source: "direct", basis: "test" } as never);
      return id;
    };
    const ann = await agent("Ann");
    const annToken = (await c.services.principals.issueCredential(owner, `agent:${ann}`)).token;
    let n = 0;
    const start = async (taskId: string, who = ann): Promise<string> => {
      const s = c.services;
      const t = (await s.projects.getTask(taskId))!;
      if (t.state === "proposed") await s.projects.transitionTask({ commandId: `r${++n}`, actor: owner.id, taskId, expectedRevision: t.revision, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${++n}`, actor: owner.id, taskId, owner: { kind: "agent", id: who } });
      const a = (await s.assignments.getAssignment(taskId))!;
      return (await s.assignments.admitAttempt({ commandId: `ad${++n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: who }, harness: "pi" })).id;
    };
    const ask = { why: "owners miss them", effort: "two hours", cost: "a few cents" };

    assert.ok((await call(c, boot.token, "owncode.enable", { projectId: devProject }, "en-1")).ok);
    const r1 = (await call(c, annToken, "owncode.request", { ...ask, what: "list blocked tasks first in the brief" }, "ask-1")).result.id as string;
    const r2 = (await call(c, annToken, "owncode.request", { ...ask, what: "say who lands the queue" }, "ask-2")).result.id as string;
    const t1 = (await call(c, boot.token, "owncode.decide", { requestId: r1, expectedRevision: 1, decision: "approve" }, "d-1")).result.taskId as string;
    const t2 = (await call(c, boot.token, "owncode.decide", { requestId: r2, expectedRevision: 1, decision: "approve" }, "d-2")).result.taskId as string;
    const weed = (await c.services.projects.createTask({ commandId: "t-weed", actor: owner.id, projectId: garden, title: "weed" })).id;
    const bo = await agent("Bo");
    const a1 = await start(t1);
    const aw = await start(weed, await agent("Cy"));
    const first = await c.dispatch!.dispatcher.tick();
    assert.deepEqual([a1, aw].filter((x) => first.started.includes(x)).length, 2, JSON.stringify({ started: first.started, s: first.skipped, f: first.failures }));
    assert.equal(first.loops.find((l) => l.name === "owncode.stop")?.ok, true, JSON.stringify(first.loops.find((l) => l.name === "owncode.stop")));
    for (const a of [a1, aw]) assert.equal((await dispatchOf(c, a)).state, "running");
    // The dispatcher's bounded look: one of the two from the start, then two from where it stopped (wrapping round), so both are seen; only staff may look.
    const p0 = await c.dispatch!.dispatcher.runningAttempts(c.dispatch!.principal, { from: 0, limit: 1 });
    const p1 = await c.dispatch!.dispatcher.runningAttempts(c.dispatch!.principal, { from: p0.next, limit: 2 });
    assert.deepEqual([p0.items.length, p0.next, p1.items.length, p1.next], [1, 1, 2, 1]);
    assert.deepEqual(new Set([...p0.items, ...p1.items].map((x) => x.attemptId)), new Set([a1, aw]));
    const seenW = p0.items.concat(p1.items).find((x) => x.attemptId === aw)!;
    assert.deepEqual({ ...seenW, at: undefined }, { attemptId: aw, taskId: weed, projectId: garden, at: undefined });
    assert.deepEqual([p0.items.map((x) => x.at), p1.items.map((x) => x.at)], [[0], [1, 0]], "each item carries its position in the live list");
    const annP = await c.services.principals.authenticate(annToken);
    await assert.rejects(() => c.dispatch!.dispatcher.runningAttempts(annP, { from: 0, limit: 5 }), /may not list live attempts/);
    // Staff acting for one task (a task-scoped credential) may not either.
    await assert.rejects(() => c.dispatch!.dispatcher.runningAttempts({ ...c.dispatch!.principal, taskScope: { taskId: t1, projectId: devProject } } as never, { from: 0, limit: 5 }), /may not list live attempts/);
    // A start past the end of the list wraps round (the list shrank since the last look): position 3 of two is position 1.
    const p3 = await c.dispatch!.dispatcher.runningAttempts(c.dispatch!.principal, { from: 3, limit: 1 });
    assert.deepEqual([p3.items.map((x) => x.at), p3.next], [[1], 0]);
    assert.deepEqual(await intentsFor(c, t1), [], "approved work that runs is not stopped");

    // The owner withdraws the approval of the first request while its attempt runs: the next tick stops it through L02's Stop of its task.
    const got = (await call(c, boot.token, "owncode.get", { requestId: r1 })).result.item;
    assert.ok((await call(c, boot.token, "owncode.withdraw", { requestId: r1, expectedRevision: got.revision, reason: "not wanted now" }, "w-1")).ok);
    assert.equal((await dispatchOf(c, a1)).state, "running", "the withdrawal itself stops nothing; the tick does");
    const second = await c.dispatch!.dispatcher.tick();
    assert.equal(second.loops.find((l) => l.name === "owncode.stop")?.ok, true, JSON.stringify(second.loops.find((l) => l.name === "owncode.stop")));
    const ended = await dispatchOf(c, a1);
    assert.equal(ended.state, "finished", "the running attempt was ended");
    assert.equal((ended.outcome as unknown as { status: string }).status, "abandoned");
    const [stop1, ...more1] = await intentsFor(c, t1);
    assert.equal(more1.length, 0);
    assert.match(stop1!.reason, new RegExp(`^Stopped NimbleNewt development work: task ${t1}: its request ${r1} is withdrawn \\(the owner withdrew the approval\\), so no work starts$`));
    assert.equal(stop1!.outcome?.state, "stopped", JSON.stringify(stop1));
    const gate = (await c.services.pauses.gate(owner, { kind: "task", id: t1 }))!;
    assert.equal(gate.intent, "pause", "the task stays stopped until the owner resumes it");
    assert.match(gate.reason ?? "", /withdrew the approval/);
    assert.equal((await dispatchOf(c, aw)).state, "running", "other work is not touched");
    const notices = async (): Promise<{ ref: { id: string }; detail?: string; count?: number }[]> => (await NotificationService.withEpoch(c.storage, c.epoch).inbox(owner)).items.filter((i) => i.ref.kind === "task" && /^Attempt att-[a-z2-7]{20} was stopped/.test(i.detail ?? "")) as never;
    assert.deepEqual((await notices()).map((i) => i.ref.id), [t1]);
    // The gate's own words, whole (they fit the notice limit here).
    assert.equal((await notices())[0]!.detail, `Attempt ${a1} was stopped: task ${t1}: its request ${r1} is withdrawn (the owner withdrew the approval), so no work starts`);
    // Nothing more on the next tick, and no new attempt of the withdrawn task starts.
    await c.dispatch!.dispatcher.tick();
    assert.equal((await intentsFor(c, t1)).length, 1);
    assert.equal((await notices()).length, 1);
    await assert.rejects(() => start(t1));
    // The owner can resume the task the dispatcher's Stop paused (lifecycle.resume); a tick does not pause it again (its attempt is over), and its next start is still refused by the gate.
    assert.ok((await call(c, boot.token, "lifecycle.resume", { scope: { kind: "task", id: t1 }, reason: "looked at it" }, "rs-t1")).ok);
    await c.dispatch!.dispatcher.tick();
    assert.notEqual((await c.services.pauses.gate(owner, { kind: "task", id: t1 }))?.intent, "pause", "resumed, and not paused again");
    const asg = (await c.services.assignments.getAssignment(t1))!;
    await assert.rejects(() => c.services.assignments.admitAttempt({ commandId: "ad-again", actor: "inbox", taskId: t1, expectedRevision: asg.revision, generation: asg.generation, owner: asg.owner as never, harness: "pi" }), /withdrew the approval/);

    // The second approved request's attempt runs; the feature is switched off: it is stopped too, saying the owner can enable it; the garden runs on.
    const a2 = await start(t2, bo);
    assert.ok((await c.dispatch!.dispatcher.tick()).started.includes(a2));
    assert.equal((await dispatchOf(c, a2)).state, "running");
    assert.deepEqual(await intentsFor(c, t2), []);
    const s1 = (await call(c, boot.token, "owncode.settings", {})).result;
    assert.ok((await call(c, boot.token, "owncode.disable", { expectedRevision: s1.revision }, "dis-1")).ok);
    await c.dispatch!.dispatcher.tick();
    assert.equal((await dispatchOf(c, a2)).state, "finished");
    const [stop2] = await intentsFor(c, t2);
    assert.ok(stop2!.reason.endsWith(OWNCODE_OFF), stop2!.reason);
    // The look finds its own earlier request by the ID L02 derives from the asker and the command ID; this is that ID.
    const stop2Id = (await c.storage.listAggregates("stop-intent", { limit: 200 })).find((x) => (x.body as unknown as Intent).scope.id === t2)!.id;
    assert.equal(stop2Id, derivedId("stp", scopedCommandId(c.dispatch!.principal.id, `owncode-stop:${a2}`)));
    // Too long to fit whole, so the notice names the Stop that keeps the gate's words; never cut.
    const n2 = (await notices()).find((i) => i.ref.id === t2)!;
    assert.equal(n2.detail, `Attempt ${a2} was stopped: work on NimbleNewt's own code may not run now. The full reason is on Stop ${stop2Id}. The task stays paused until the owner resumes it.`);
    assert.equal((await dispatchOf(c, aw)).state, "running");
    assert.deepEqual((await notices()).map((i) => i.ref.id).sort(), [t1, t2].sort());

    // A restart: the Stops are kept, nothing is asked for again, and the owner is not told again.
    await c.close();
    c = await open(file, runUntilStopped());
    await c.dispatch!.dispatcher.tick();
    await c.dispatch!.dispatcher.tick();
    assert.deepEqual([(await intentsFor(c, t1)).length, (await intentsFor(c, t2)).length], [1, 1]);
    assert.equal((await notices()).length, 2);
    for (const a of [a1, a2]) assert.equal((await dispatchOf(c, a)).state, "finished");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
