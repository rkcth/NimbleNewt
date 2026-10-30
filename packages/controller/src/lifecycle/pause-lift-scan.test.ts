import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { WaitService } from "../domain/waits.js";
import { PrincipalService } from "../security/index.js";
import { PauseService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  test(`${backend.name}: the tick reads the index of timed gates, not every gate, and still lifts a due one (card L06b)`, async () => {
    now = Date.parse("2026-10-22T10:00:00.000Z");
    const world = await backend.open();
    try {
      // Count the reads of pause gates made through the storage the pause service uses.
      const gateReads: string[] = [];
      let gateLists = 0;
      const storage = new Proxy(world.storage, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (prop === "getAggregate") return (ref: { kind: string; id: string }) => { if (ref.kind === "pause-gate") gateReads.push(ref.id); return value.call(target, ref); };
          if (prop === "listAggregates") return (kind: string, page: unknown) => { if (kind === "pause-gate") gateLists++; return value.call(target, kind, page); };
          return value.bind(target);
        },
      }) as typeof world.storage;
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
      const pauses = PauseService.withEpoch(storage, epoch, { waits }, options);
      const tasks: string[] = [];
      for (let i = 0; i < 25; i++) {
        const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: `t${i}` })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
        await pauses.pause(owner, { commandId: cid("pz"), scope: { kind: "task", id }, reason: "hold" });
        tasks.push(id);
      }
      const due = { kind: "task", id: tasks[17]! } as const;
      const later = { kind: "task", id: tasks[3]! } as const;
      await pauses.setResumeCondition(owner, { commandId: cid("rc"), scope: due, at: new Date(now + 3_600_000).toISOString() });
      await pauses.setResumeCondition(owner, { commandId: cid("rc"), scope: later, at: new Date(now + 9 * 3_600_000).toISOString() });

      gateReads.length = 0; gateLists = 0;
      assert.deepEqual(await pauses.liftDue(owner), [], "nothing is due yet");
      assert.equal(gateLists, 0, "the tick does not list the gates");
      assert.deepEqual(gateReads, [], "no gate is read before a time has come");

      now += 3_600_001;
      gateReads.length = 0;
      assert.deepEqual(await pauses.liftDue(owner), [due], "the due gate among the many is lifted");
      assert.equal(gateLists, 0);
      assert.deepEqual([...new Set(gateReads)].filter((id) => id !== PauseService.gateIdOf(due)), [], "only the due gate was read, not the 24 others");
      assert.equal(await pauses.isPaused(due.id), false);
      assert.equal(await pauses.isPaused(later.id), true, "a gate whose time has not come stays paused");

      gateReads.length = 0;
      assert.deepEqual(await pauses.liftDue(owner), [], "a repeat lifts nothing");
      assert.deepEqual(gateReads, [], "a lifted gate leaves the work of the tick");

      // A gate resumed by hand and paused again without a time is not lifted when the old time comes.
      await pauses.resume(owner, { commandId: cid("rs"), scope: later, reason: "back" });
      await pauses.pause(owner, { commandId: cid("pz"), scope: later, reason: "again" });
      now += 9 * 3_600_000;
      assert.deepEqual(await pauses.liftDue(owner), []);
      assert.equal(await pauses.isPaused(later.id), true);
      assert.deepEqual(await pauses.liftDue(owner), [], "and the stale entry is retired, not retried forever");
    } finally { await world.close(); }
  });
}
