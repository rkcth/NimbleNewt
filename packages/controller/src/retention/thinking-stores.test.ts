import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";
import { combineThinkingStores, localThinkingStores, type ThinkingPurgeStatus, type ThinkingStorePort } from "./thinking-stores.js";

after(stopServer);

const DAY = 86_400_000;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const on = { ...RETENTION_DEFAULTS, reserveBytes: 0 };

/** A port that records what it was asked and answers from a table (default: purged); `down` makes a place unable to answer. */
function fakePort(answers: Record<string, ThinkingPurgeStatus> = {}) {
  const asked: string[][] = [];
  const port: ThinkingStorePort = { purge: async (ids) => { asked.push([...ids]); return { status: Object.fromEntries(ids.map((id) => [id, answers[id] ?? "purged"])), blocks: ids.filter((id) => (answers[id] ?? "purged") === "purged").length * 2, problems: ids.filter((id) => answers[id] === "pending").map((id) => `attempt ${id} could not be cleaned`) }; } };
  return { port, asked, answers };
}

// Card K06c: stored model thinking is removed from the conversation stores of a finished task's attempts when its time has come, recorded, previewed, and retried for what could not be reached.
for (const backend of backends) {
  test(`${backend.name}: the model's own copy of its thinking is cleaned for finished tasks only, after thinkingDays, previewed and digest-confirmed, recorded per task, retried for what is pending, and never asked for a running task (card K06c)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const box = { at: real - 40 * DAY };
      const options = { clock: () => new Date(box.at).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const mk = async (title: string): Promise<string> => (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title })).id;
      const finish = async (task: string, to: "done" | "cancelled"): Promise<void> => {
        for (const step of to === "done" ? ["ready", "in_progress", "done"] : ["cancelled"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: step as never });
      };
      const done = await mk("finished"); const cancelled = await mk("dropped"); const live = await mk("running"); const noStore = await mk("no attempts");
      await finish(done, "done"); await finish(cancelled, "cancelled");
      await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: live, expectedRevision: 1, to: "ready" });
      const put = async (kind: string, id: string, body: object): Promise<void> => {
        await storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(box.at).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      for (const [task, attempts] of [[done, ["att-d1", "att-d2"]], [cancelled, ["att-c1"]], [live, ["att-l1"]]] as const) for (const a of attempts) await put("dispatch", `dsp-${a}`, { taskId: task, attemptId: a, state: "finished" });
      // A young finished task: finished today.
      box.at = real;
      const young = await mk("finished today"); await finish(young, "done");
      await put("dispatch", "dsp-att-y1", { taskId: young, attemptId: "att-y1", state: "finished" });

      const svc = (port: ThinkingStorePort | undefined, v = on, extra: object = {}) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => v }, now: () => real, ...(port === undefined ? {} : { thinkingStores: port }), ...extra } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });

      // Without a way to reach the stores nothing is offered (the controller's own copy is handled by its own rule).
      assert.deepEqual((await svc(undefined).run(owner, {})).candidates.filter((c) => c.kind === "pi-thinking"), []);

      const f = fakePort({ "att-d2": "pending" });
      const preview = await svc(f.port).run(owner, {});
      const mine = preview.candidates.filter((c) => c.kind === "pi-thinking");
      assert.deepEqual(mine.map((c) => c.id).sort(), [cancelled, done].sort(), "finished tasks with attempts and old enough; not the running one, the young one or one with no attempt");
      assert.ok(mine.every((c) => c.ageDays >= 39 && c.projectId === project));
      assert.equal(f.asked.length, 0, "a preview cleans nothing");
      await assert.rejects(svc(f.port).run(owner, { dryRun: false }), /confirm/i);

      // The run: d2 is pending (a host did not answer), the rest are cleaned.
      const run = await svc(f.port).run(owner, { dryRun: false, confirm: preview.digest! });
      assert.equal(run.removed, 2);
      assert.deepEqual(f.asked.map((a) => [...a].sort()).sort(), [["att-c1"], ["att-d1", "att-d2"]]);
      assert.ok(!f.asked.flat().includes("att-l1") && !f.asked.flat().includes("att-y1"), "a running or young task's store is never asked");
      const rec = (id: string) => storage.getAggregate({ kind: "thinking-purge", id }).then((a) => a?.body as { attempts: Record<string, string>; blocks: number } | undefined);
      assert.deepEqual((await rec(done))!.attempts, { "att-d1": "purged" }, "only what was settled is recorded");
      assert.deepEqual((await rec(cancelled))!.attempts, { "att-c1": "purged" });
      assert.equal(await rec(noStore), undefined);

      // The pending attempt is tried again, alone; once cleaned the task is done with.
      const next = await svc(f.port).run(owner, {});
      assert.deepEqual(next.candidates.filter((c) => c.kind === "pi-thinking").map((c) => c.id), [done], "only the task with a pending attempt is a candidate again");
      f.asked.length = 0;
      await svc(f.port).run(owner, { dryRun: false, confirm: next.digest! });
      assert.deepEqual(f.asked, [["att-d2"]], "the cleaned attempt is not asked again");
      f.answers["att-d2"] = "none"; // a host reports it keeps no store of it
      const third = await svc(f.port).run(owner, {});
      assert.equal(third.candidates.length, 1);
      await svc(f.port).run(owner, { dryRun: false, confirm: third.digest! });
      assert.deepEqual((await rec(done))!.attempts, { "att-d1": "purged", "att-d2": "none" });
      assert.equal((await svc(f.port).run(owner, {})).candidates.length, 0, "nothing left to do");

      // Recorded: the audit names the rule, task, project and counts; never text.
      const rules: Record<string, unknown>[] = []; let after = 0;
      for (;;) {
        const page = await storage.listAudit({ afterSeq: after, limit: 500 });
        for (const e of page) { after = e.seq; if (e.type === "retention.expire") rules.push(e.detail as Record<string, unknown>); }
        if (page.length < 500) break;
      }
      assert.ok(rules.length >= 3 && rules.every((r) => r["rule"] === "thinking-store-days"));
      assert.ok(rules.some((r) => r["purged"] === 1 && r["attempts"] === 1 && r["blocks"] === 2));
      assert.equal(rules.filter((r) => r["purged"] === 0).length, 1, "the attempt a host keeps no store of is recorded as settled, with nothing purged");

      // All pending: nothing is recorded and the task stays a candidate.
      const stuck = fakePort({ "att-y1": "pending" });
      const later = (port: ThinkingStorePort) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => on }, now: () => real + 40 * DAY, thinkingStores: port } as never, { clock: () => new Date(real + 40 * DAY).toISOString(), pause: async () => undefined });
      const p = await later(stuck.port).run(owner, {});
      assert.deepEqual(p.candidates.filter((c) => c.kind === "pi-thinking").map((c) => c.id), [young]);
      const r = await later(stuck.port).run(owner, { dryRun: false, confirm: p.digest! });
      assert.equal(r.removed, 0); assert.equal(await rec(young), undefined);
      assert.equal((await later(stuck.port).run(owner, {})).candidates.filter((c) => c.kind === "pi-thinking").length, 1, "still waiting");

      // The record changed since the preview (another run settled it): the stale one is skipped.
      const guard = fakePort();
      let moved = false;
      const racing = later(guard.port);
      const rp = await racing.run(owner, {});
      const sneaky = RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => on }, now: () => real + 40 * DAY, thinkingStores: guard.port, beforeBatch: async () => { if (moved) return; moved = true; await later(fakePort().port).run(owner, { dryRun: false, confirm: rp.digest! }); } } as never, { clock: () => new Date(real + 40 * DAY).toISOString(), pause: async () => undefined });
      const raced = await sneaky.run(owner, { dryRun: false, confirm: rp.digest! });
      assert.equal(raced.removed, 0, "what another run already did is not done twice");
      assert.deepEqual((await rec(young))!.attempts, { "att-y1": "purged" });
    } finally { await world.close(); }
  });

  test(`${backend.name}: the dispatcher removes stored thinking at its time even with autoRun off, unless the owner turned thinkingAuto off, and touches nothing else (owner decision 2026-10-22, card K06c)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 40 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "finished" })).id;
      for (const step of ["ready", "in_progress", "done"]) await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: step as never });
      const put = async (kind: string, id: string, body: object): Promise<void> => {
        await storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(real - 40 * DAY).toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      await put("dispatch", "dsp-1", { taskId: task, attemptId: "att-1", state: "finished" });
      await put("summary-record", "sum-old", { projectId: project, createdBy: "agent:ann", title: "old", text: "an old derived summary", sources: [] });
      const f = fakePort();
      const clock = { at: real };
      const svc = (v: typeof on) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => v }, now: () => clock.at, autoEveryMs: 1000, thinkingStores: f.port } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });

      // Off: nothing happens.
      assert.equal(await svc({ ...on, thinkingAuto: false }).sweep(owner), undefined);
      assert.equal(f.asked.length, 0);
      // On (the default) with autoRun off and another rule set: only the thinking rule acts.
      assert.equal(RETENTION_DEFAULTS.thinkingAuto, true, "on by default, as the owner decided");
      const s = svc({ ...on, derivedDays: 7, autoRun: false });
      const ran = await s.sweep(owner);
      assert.ok(ran !== undefined && ran.removed === 1, JSON.stringify(ran));
      assert.deepEqual(f.asked, [["att-1"]]);
      assert.ok(await storage.getAggregate({ kind: "summary-record", id: "sum-old" }), "the derived summary rule did not run: autoRun is off");
      // Rate-limited like the general pass.
      assert.equal(await s.sweep(owner), undefined);
      clock.at += 2000;
      assert.equal(await s.sweep(owner), undefined, "nothing left to clean: nothing is run or recorded");
      assert.equal(f.asked.length, 1, "the cleaned attempt is not asked again");
      // With autoRun on the general pass does it as before.
      const general = await svc({ ...on, derivedDays: 7, autoRun: true }).sweep(owner);
      assert.ok(general !== undefined);
    } finally { await world.close(); }
  });
}

test("the stores of this machine: a store is cleaned, one that is not kept is `none`, a running attempt's is left alone, a failing rewrite and an unlistable folder are pending with a plain reason and no path (card K06c)", async () => {
  const calls: string[] = [];
  const stores = [{ id: "att-a", dir: "/secret/path/a" }, { id: "att-b", dir: "/secret/path/b" }, { id: "att-busy", dir: "/secret/path/busy" }];
  let released = 0;
  const port = localThinkingStores({
    source: { list: async () => stores, release: async () => { released += 1; } },
    purge: async (dir) => { calls.push(dir); if (dir.endsWith("/b")) throw new Error(`cannot open ${dir}/main.jsonl`); return { blocks: 3 }; },
    busy: async () => ["att-busy"],
  });
  const answer = await port.purge(["att-a", "att-b", "att-busy", "att-gone"]);
  assert.deepEqual(answer.status, { "att-a": "purged", "att-b": "pending", "att-busy": "pending", "att-gone": "none" });
  assert.equal(answer.blocks, 3);
  assert.deepEqual(calls, ["/secret/path/a", "/secret/path/b"], "a running attempt's store is not opened");
  assert.ok(answer.problems.length === 2 && answer.problems.every((p) => !p.includes("/secret/path")), `no path in ${answer.problems.join(" | ")}`);
  assert.equal(released, 1);
  const broken = await localThinkingStores({ source: { list: async () => { throw new Error("cannot read /secret/path"); } }, purge: async () => ({ blocks: 0 }) }).purge(["att-a"]);
  assert.deepEqual(broken.status, { "att-a": "pending" });
  assert.ok(!broken.problems.join(" ").includes("/secret/path"));
});

test("several places combine strictly: purged where any purged it, none only when every place keeps none, pending when any place could not answer (card K06c)", async () => {
  const place = (status: Record<string, ThinkingPurgeStatus>, blocks = 1): ThinkingStorePort => ({ purge: async (ids) => ({ status: Object.fromEntries(ids.map((id) => [id, status[id] ?? "none"])), blocks, problems: [] }) });
  const both = combineThinkingStores(place({ a: "purged", b: "none", c: "none", d: "pending" }), place({ a: "none", b: "none", c: "purged", d: "purged" }))!;
  const answer = await both.purge(["a", "b", "c", "d"]);
  assert.deepEqual(answer.status, { a: "purged", b: "none", c: "purged", d: "pending" });
  assert.equal(answer.blocks, 2);
  const throwing = combineThinkingStores(place({ a: "purged" }), { purge: async () => { throw new Error("host table broke"); } })!;
  const t = await throwing.purge(["a"]);
  assert.deepEqual(t.status, { a: "pending" }, "a place that throws makes the attempt pending, never clean");
  assert.match(t.problems.join(" "), /did not answer/);
  assert.equal(combineThinkingStores(undefined, undefined), undefined);
  const single = place({});
  assert.equal(combineThinkingStores(undefined, single), single);
});

// Review (2026-11-13): an attempt whose record still says it runs is never cleaned (its process may still be writing the store), and an automatic pass that could clean nothing leaves no run record every hour.
for (const backend of backends) {
  test(`${backend.name}: a finished task's attempt that is still recorded as running is left alone until it ends, and an hourly thinking pass that cleans nothing records nothing (review, card K06c)`, async () => {
    const world = await backend.open();
    try {
      const storage: ControllerStorage = world.storage;
      const real = Date.now();
      const options = { clock: () => new Date(real - 40 * DAY).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(storage, epoch, options);
      const owner: Principal = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "cancelled while its attempt ran" })).id;
      await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task, expectedRevision: 1, to: "cancelled" });
      const write = async (type: "create" | "update", id: string, body: object, expectedRevision?: number): Promise<void> => {
        await storage.applyOperation({ operationId: cid("put"), epoch, actor: "test", correlationId: "put", at: new Date(real - 40 * DAY).toISOString(), changes: [{ type, ref: { kind: "dispatch", id }, body: body as never, ...(expectedRevision === undefined ? {} : { expectedRevision }) }], audit: [{ type: "test.put", subject: { kind: "dispatch", id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      };
      await write("create", "dsp-run", { taskId: task, attemptId: "att-run", state: "running" });
      const runs = async (): Promise<number> => (await storage.listAggregates("retention-run", { limit: 100 })).length;
      const f = fakePort();
      const svc = RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => on }, now: () => real, thinkingStores: f.port } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });
      assert.deepEqual((await svc.run(owner, {})).candidates.filter((c) => c.kind === "pi-thinking"), [], "a store still being written is not a candidate");
      assert.equal(await svc.sweep(owner), undefined);
      assert.deepEqual(f.asked, [], "the running attempt's store is never asked for");
      // Once the attempt has ended the store is cleaned.
      await write("update", "dsp-run", { taskId: task, attemptId: "att-run", state: "finished" }, 1);
      const ran = await svc.run(owner, {});
      await svc.run(owner, { dryRun: false, confirm: ran.digest! });
      assert.deepEqual(f.asked, [["att-run"]]);

      // A host that never answers: the hourly pass tries again each time and writes no run record while nothing is cleaned.
      const task2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "its host is gone" })).id;
      await projects.transitionTask({ commandId: cid("mv"), actor: owner.id, taskId: task2, expectedRevision: 1, to: "cancelled" });
      await write("create", "dsp-gone", { taskId: task2, attemptId: "att-gone", state: "finished" });
      const stuck = fakePort({ "att-gone": "pending" });
      const clock = { at: real };
      const hourly = RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => on }, now: () => clock.at, autoEveryMs: 1000, thinkingStores: stuck.port } as never, { clock: () => new Date(real).toISOString(), pause: async () => undefined });
      const before = await runs();
      for (let i = 0; i < 3; i++) { await hourly.sweep(owner); clock.at += 2000; }
      assert.equal(stuck.asked.length, 3, "it is tried again every time");
      assert.equal(await runs(), before, "and nothing is recorded while nothing is cleaned");
    } finally { await world.close(); }
  });
}
