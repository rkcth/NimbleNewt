import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { StallService, type StallEvent } from "../health/index.js";
import { PrincipalService } from "../security/index.js";
import type { Aggregate, ControllerStorage } from "../storage/types.js";
import { RETENTION_DEFAULTS, RetentionService } from "./index.js";

after(stopServer);

const T0 = Date.parse("2026-10-22T08:00:00.000Z");
const DAY = 86_400_000;
let now = T0;
const at = (): string => new Date(now).toISOString();
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const values = { ...RETENTION_DEFAULTS, reserveBytes: 0, stallSpeedDays: 30 as number | null };

async function world(storage: ControllerStorage) {
  const options = { clock: at, pause: async () => undefined };
  const projects = await ProjectService.open(storage, { holder: "c1", ...options });
  const epoch = projects.epoch;
  const principals = PrincipalService.withEpoch(storage, epoch, options);
  const assignments = AssignmentService.withEpoch(storage, epoch, projects, options);
  const waits = WaitService.withEpoch(storage, epoch, assignments, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
  await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [{ action: "attempt.work", project }] });
  const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
  const stall = StallService.withEpoch(storage, epoch, assignments, waits, { ...options, hostStaleAfterMs: 60_000, declaredSpeed: () => ({ readTokensPerSecond: 7 }) });
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "work" })).id;
  await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
  await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: { kind: "agent", id: "ann" } });
  const a = (await assignments.getAssignment(task))!;
  await assignments.admitAttempt({ commandId: cid("ad"), actor: owner.id, taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: "ann" } });
  await projects.transitionTask({ commandId: cid("ip"), actor: owner.id, taskId: task, expectedRevision: (await projects.getTask(task))!.revision, to: "in_progress" });
  const send = (event: StallEvent) => stall.report(host, { commandId: cid("rep"), taskId: task, generation: 1, event });
  // One finished request on the route: 6,000 tokens read in 60 s (100 a second).
  const measure = async (): Promise<void> => {
    await send({ type: "request_started", requestId: "r1", promptTokens: 6000, route: "local/slow" } as StallEvent);
    now += 60_000; await send({ type: "first_output", requestId: "r1" });
    now += 30_000; await send({ type: "request_finished", requestId: "r1", outcome: "ok", inputTokens: 6000, outputTokens: 300 });
  };
  // The retention runner's clock runs 40 days after the test's: the speed is then older than 30 days.
  const retention = (v = values) => RetentionService.withEpoch(storage, epoch, { settings: { effective: async () => v } }, { clock: () => new Date(now + 40 * DAY).toISOString() });
  return { owner, host, stall, task, send, measure, retention, epoch };
}

for (const backend of backends) {
  test(`${backend.name}: a measured route speed that retention removed is measured again under the same ID, its revision continuing, so a second removal is a new removal and the stall scan keeps judging by it (card K06e review)`, async () => {
    now = T0;
    const w = await backend.open();
    try {
      const { owner, host, stall, task, send, measure, retention } = await world(w.storage);
      await measure();
      const ref = { kind: "stall-speed", id: "" };
      const first = (await w.storage.listAggregates("stall-speed", { limit: 10 }))[0]!;
      ref.id = first.id;
      assert.equal(first.revision, 1);
      // Removed by the rule once it is old.
      const p1 = await retention().run(owner, {});
      assert.deepEqual(p1.candidates.map((c) => `${c.kind}/${c.id}@${c.revision}`), [`stall-speed/${ref.id}@1`]);
      assert.equal((await retention().run(owner, { dryRun: false, confirm: p1.digest! })).removed, 1);
      assert.equal(await stall.speed(owner, "local/slow", host.id), undefined, "removed");
      // Until it is measured again the declared speed is used; a stuck reading request is still judged.
      await send({ type: "request_started", requestId: "r1", promptTokens: 120_000, route: "local/slow" } as StallEvent);
      assert.equal((await stall.assess(owner, task))!.signals.reading!.source, "declared");
      now += 60_000; await send({ type: "first_output", requestId: "r1" });
      now += 30_000; await send({ type: "request_finished", requestId: "r1", outcome: "ok", inputTokens: 6000, outputTokens: 300 });
      // Measured again: a fresh record (one sample), whose revision continues the removed one.
      const again = (await w.storage.getAggregate(ref))!;
      assert.equal(again.revision, 2, "a re-created record continues the removed revision");
      assert.equal((await stall.speed(owner, "local/slow", host.id))!.readSamples, 1, "measured afresh");
      await send({ type: "request_started", requestId: "r1", promptTokens: 120_000, route: "local/slow" } as StallEvent);
      const reading = (await stall.assess(owner, task))!.signals.reading!;
      assert.equal(reading.source, "measured", "the stall scan judges by the new measurement");
      // A request in flight on the route keeps its speed.
      assert.deepEqual((await retention().run(owner, {})).candidates, [], "the route has a request in flight");
      now += 60_000; await send({ type: "first_output", requestId: "r1" });
      now += 30_000; await send({ type: "request_finished", requestId: "r1", outcome: "ok", inputTokens: 6000, outputTokens: 300 });
      const rev = (await w.storage.getAggregate(ref))!.revision;
      // Removed a second time: a new removal (not the first answered again), then measured once more.
      const p2 = await retention().run(owner, {});
      assert.deepEqual(p2.candidates.map((c) => `${c.kind}/${c.id}@${c.revision}`), [`stall-speed/${ref.id}@${rev}`]);
      assert.equal((await retention().run(owner, { dryRun: false, confirm: p2.digest! })).removed, 1, "the second removal removes");
      assert.equal(await w.storage.getAggregate(ref), undefined);
      await measure();
      assert.equal((await w.storage.getAggregate(ref))!.revision, rev + 1);
      assert.equal((await stall.speed(owner, "local/slow", host.id))!.readSamples, 1);
      // And the stall scan still opens concerns on the task (a long silence).
      now += 3 * 60 * 60_000;
      assert.ok((await stall.scan(owner)).opened >= 1, "the stall scan still reports");
    } finally { await w.close(); }
  });
}

test("a measured speed is not removed when the scan of progress records was cut short: a request in flight in a record not read could name its route (card K06e review)", async () => {
  now = T0;
  const w = await backends[0]!.open();
  try {
    const { owner, measure, epoch } = await world(w.storage);
    await measure();
    // A store with more progress records than one run reads (the scan stops at its limit): the ones past it are never seen.
    const base = w.storage;
    const many = new Proxy(base, {
      get(target, prop, receiver) {
        if (prop === "listAggregates") return async (kind: string, page: { afterId?: string; limit: number }): Promise<Aggregate[]> => {
          if (kind !== "stall-evidence") return target.listAggregates(kind, page);
          const start = page.afterId === undefined ? 0 : Number(page.afterId.slice(5)) + 1;
          return Array.from({ length: page.limit }, (_, i) => ({ kind, id: `task-${String(start + i).padStart(8, "0")}`, revision: 1, body: { lastReportAt: at() }, createdAt: at(), updatedAt: at() }) as unknown as Aggregate);
        };
        const v = Reflect.get(target, prop, receiver) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      },
    });
    const svc = RetentionService.withEpoch(many, epoch, { settings: { effective: async () => values } }, { clock: () => new Date(now + 40 * DAY).toISOString() });
    const report = await svc.run(owner, {});
    assert.equal(report.partial, true);
    assert.deepEqual(report.candidates.filter((c) => c.kind === "stall-speed"), [], "no speed is removed on a partial view of the requests in flight");
    // With the whole view it is a candidate.
    const whole = RetentionService.withEpoch(base, epoch, { settings: { effective: async () => values } }, { clock: () => new Date(now + 40 * DAY).toISOString() });
    assert.equal((await whole.run(owner, {})).candidates.filter((c) => c.kind === "stall-speed").length, 1);
  } finally { await w.close(); }
});
