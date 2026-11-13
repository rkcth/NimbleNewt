import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import { startTestServer, type TestServer } from "../storage/postgres/testing/server.js";
import { startController, type Controller as StartedController } from "./start.js";

after(stopServer);

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

type Storage = "sqlite" | { pg: TestServer };
type Choice = { kind: "sqlite"; path: string } | { kind: "postgres"; url: string; schema: string };
const choiceOf = (storage: Storage, d: string): Choice => storage === "sqlite" ? { kind: "sqlite", path: join(d, "c.sqlite") } : { kind: "postgres", url: storage.pg.url(), schema: `ad_${process.pid}_${Math.random().toString(36).slice(2, 8)}` };
const open = (choice: Choice, extra: Record<string, unknown>): Promise<StartedController> => startController({ storage: choice, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], ...extra,
  dispatch: { timer: new ManualTimer(), intervalMs: 1000, route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }) } } as never);
const ticks = async (c: StartedController, n = 4): Promise<void> => { for (let i = 0; i < n; i++) await c.dispatch!.dispatcher.tick(); };

// Card U14e: a task given to an agent starts by itself when the start asks for it (`admitAssigned`): the assignment's event reaches the inbox, which admits one attempt for the one harness the installation ships.
// Without the flag nothing admits an attempt (the controller is driven by hand, as before). The controller starts on SQLite or PostgreSQL; the delivery, inbox and admission records are the domain's, tested on every backend.
async function run(storage: Storage, extra: Record<string, unknown>, expectAttempts: number): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-admit-"));
  const c = await open(choiceOf(storage, d), extra);
  try {
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const rob = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ann = (await s.agents.create(rob, { commandId: "ag1", friendlyName: "Ann" })).id;
    const t = await s.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Say hello" });
    await s.projects.transitionTask({ commandId: "r1", actor: rob.id, taskId: t.id, expectedRevision: t.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: t.id, owner: { kind: "agent", id: ann } });
    // Several ticks: the same assignment is never admitted twice.
    await ticks(c);
    const a = (await s.assignments.getAssignment(t.id))!;
    assert.equal(a.attempts, expectAttempts, JSON.stringify(a));
    assert.equal(a.activeAttemptId !== undefined, expectAttempts === 1);
    if (expectAttempts === 1) assert.equal((await s.assignments.getAttempt(a.activeAttemptId!))!.owner.id, ann);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

/**
 * Review of U14e: only an assignment that is current and not held is admitted. A task given before it is ready waits and starts once it is ready; an agent the owner paused gets nothing until the pause is
 * lifted; a task moved to another agent before the pass is admitted once, for the new owner only; a released task gets nothing; and a restart on the same database admits nothing again.
 */
async function held(storage: Storage): Promise<void> {
  const d = mkdtempSync(join(tmpdir(), "nn-admit-"));
  const choice = choiceOf(storage, d);
  let c = await open(choice, { admitAssigned: true });
  try {
    const s = () => c.services;
    const boot = await s().principals.bootstrapOwner({ name: "rob" });
    const rob = await s().principals.authenticate(boot.token);
    const project = (await s().projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const ann = (await s().agents.create(rob, { commandId: "ag1", friendlyName: "Ann" })).id;
    const bob = (await s().agents.create(rob, { commandId: "ag2", friendlyName: "Bob" })).id;
    const task = async (n: string) => (await s().projects.createTask({ commandId: `t${n}`, actor: rob.id, projectId: project, title: `Task ${n}` }));
    const ready = async (t: { id: string; revision: number }, n: string) => s().projects.transitionTask({ commandId: `r${n}`, actor: rob.id, taskId: t.id, expectedRevision: t.revision, to: "ready" });
    const attempts = async (id: string) => (await s().assignments.getAssignment(id))?.attempts ?? 0;

    // Given before it is ready: nothing, then one attempt once it is ready.
    const early = await task("1");
    await s().assignments.assignTask({ commandId: "as1", actor: rob.id, taskId: early.id, owner: { kind: "agent", id: ann } });
    await ticks(c);
    assert.equal(await attempts(early.id), 0, "a task that is not ready is not started");
    await ready(early, "1");
    await ticks(c);
    assert.equal(await attempts(early.id), 1, "it starts once it is ready");

    // Bob is paused by the owner: his task is not admitted while the pause holds, and is admitted once after it is lifted.
    await s().pauses.pause(rob, { commandId: "pz", scope: { kind: "agent", id: bob }, reason: "the owner asked" });
    const paused = await task("2");
    await ready(paused, "2");
    await s().assignments.assignTask({ commandId: "as2", actor: rob.id, taskId: paused.id, owner: { kind: "agent", id: bob } });
    await ticks(c);
    assert.equal(await attempts(paused.id), 0, "nothing is admitted for a paused agent");
    await s().pauses.resume(rob, { commandId: "rs", scope: { kind: "agent", id: bob }, reason: "back" });
    await ticks(c);
    assert.equal(await attempts(paused.id), 1, "admitted after the pause is lifted");

    // Given to Ann, moved to Bob before any pass: one attempt, Bob's.
    const moved = await task("3");
    await ready(moved, "3");
    const given = await s().assignments.assignTask({ commandId: "as3", actor: rob.id, taskId: moved.id, owner: { kind: "agent", id: ann } });
    await s().assignments.transferTask({ commandId: "tr3", actor: rob.id, taskId: moved.id, expectedRevision: given.revision, to: { kind: "agent", id: bob } });
    await ticks(c);
    const m = (await s().assignments.getAssignment(moved.id))!;
    assert.equal(m.attempts, 1, JSON.stringify(m));
    assert.equal((await s().assignments.getAttempt(m.activeAttemptId!))!.owner.id, bob, "the attempt is the new owner's");

    // Given and released before any pass: nothing.
    const released = await task("4");
    await ready(released, "4");
    const g4 = await s().assignments.assignTask({ commandId: "as4", actor: rob.id, taskId: released.id, owner: { kind: "agent", id: ann } });
    await s().assignments.releaseTask({ commandId: "rl4", actor: rob.id, taskId: released.id, expectedRevision: g4.revision });
    await ticks(c);
    assert.equal(await attempts(released.id), 0, "a released task is not started");

    // A restart on the same database delivers and admits nothing a second time.
    await c.close();
    c = await open(choice, { admitAssigned: true });
    await ticks(c);
    assert.deepEqual([await attempts(early.id), await attempts(paused.id), await attempts(moved.id), await attempts(released.id)], [1, 1, 1, 0]);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("with admitAssigned a task given to an agent gets exactly one attempt from the controller itself; without it nothing admits one (card U14e)", async () => {
  await run("sqlite", { admitAssigned: true }, 1);
  await run("sqlite", {}, 0);
});

test("the same on PostgreSQL (card U14e)", async () => {
  const pg = await startTestServer();
  try { await run({ pg }, { admitAssigned: true }, 1); await run({ pg }, {}, 0); } finally { await pg.stop(); }
});

test("admitAssigned with no harness, or two, admits nothing: it needs exactly one harness to name (card U14e)", async () => {
  await run("sqlite", { admitAssigned: true, harnesses: [] }, 0);
  await run("sqlite", { admitAssigned: true, harnesses: [PI, { ...PI, harness: "other" }] }, 0);
});

test("admitAssigned admits only a current assignment that no pause holds, once, across a restart (SQLite; U14e review)", async () => { await held("sqlite"); });

test("the same on PostgreSQL (U14e review)", async () => {
  const pg = await startTestServer();
  try { await held({ pg }); } finally { await pg.stop(); }
});
