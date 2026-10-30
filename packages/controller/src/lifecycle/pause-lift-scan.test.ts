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

      assert.deepEqual(await pauses.liftDue(owner), [], "the first tick builds the index marker");
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

  test(`${backend.name}: an index entry follows its gate: resume, takeover and a stopped gate all retire it (card L06b)`, async () => {
    now = Date.parse("2026-10-22T10:00:00.000Z");
    const world = await backend.open();
    try {
      const gateReads: string[] = [];
      const storage = new Proxy(world.storage, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (prop === "getAggregate") return (ref: { kind: string; id: string }) => { if (ref.kind === "pause-gate") gateReads.push(ref.id); return value.call(target, ref); };
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
      const mk = async (): Promise<{ kind: "task"; id: string }> => {
        const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "x" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
        const scope = { kind: "task", id } as const;
        await pauses.pause(owner, { commandId: cid("pz"), scope, reason: "hold" });
        await pauses.setResumeCondition(owner, { commandId: cid("rc"), scope, at: new Date(now + 3_600_000).toISOString() });
        return scope;
      };
      const entryOf = async (scope: { kind: "task"; id: string }) => (await world.storage.getAggregate({ kind: "pause-timed", id: PauseService.gateIdOf(scope) }))?.body as unknown as { active: boolean };
      const resumed = await mk(), taken = await mk(), stopped = await mk();
      assert.equal((await entryOf(resumed)).active, true);

      await pauses.resume(owner, { commandId: cid("rs"), scope: resumed, reason: "back" });
      assert.equal((await entryOf(resumed)).active, false, "resume retires the entry in the same operation");

      await pauses.dropResumeCondition(owner, taken);
      assert.equal((await entryOf(taken)).active, false, "a takeover retires the entry");

      await pauses.observe(owner, { commandId: cid("ob"), scope: stopped, state: "stopped", evidence: "stopped" });
      assert.equal((await entryOf(stopped)).active, true, "an observation alone does not touch the index");
      now += 3_600_001;
      assert.deepEqual(await pauses.liftDue(owner), [], "a stopped gate is not lifted");
      assert.equal((await entryOf(stopped)).active, false, "and its entry is retired after one tick");
      gateReads.length = 0;
      assert.deepEqual(await pauses.liftDue(owner), []);
      assert.deepEqual(gateReads, [], "later ticks read nothing");
    } finally { await world.close(); }
  });

  test(`${backend.name}: a gate timed before the index existed is lifted by the first tick, which then marks the index complete (card L06b)`, async () => {
    now = Date.parse("2026-10-22T10:00:00.000Z");
    const world = await backend.open();
    try {
      let legacy = true;
      let gateLists = 0;
      const storage = new Proxy(world.storage, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          // Older code wrote no index entry: drop those changes while `legacy` is set.
          if (prop === "applyOperation") return (input: { changes: readonly { ref: { kind: string } }[] }) => value.call(target, legacy ? { ...input, changes: input.changes.filter((c) => c.ref.kind !== "pause-timed") } : input);
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
      const mk = async (): Promise<{ kind: "task"; id: string }> => {
        const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "x" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
        const scope = { kind: "task", id } as const;
        await pauses.pause(owner, { commandId: cid("pz"), scope, reason: "hold" });
        return scope;
      };
      const old = await mk(), other = await mk();
      await pauses.setResumeCondition(owner, { commandId: cid("rc"), scope: old, at: new Date(now + 3_600_000).toISOString() });
      await pauses.setResumeCondition(owner, { commandId: cid("rc"), scope: other, at: new Date(now + 99 * 3_600_000).toISOString() });
      legacy = false;
      assert.equal(await world.storage.getAggregate({ kind: "pause-timed", id: PauseService.gateIdOf(old) }), undefined, "no index entry, as an older version left it");
      assert.equal(await world.storage.getAggregate({ kind: "pause-index-state", id: "index-built" }), undefined);

      now += 3_600_001;
      assert.deepEqual(await pauses.liftDue(owner), [old], "the first tick finds and lifts it");
      assert.equal(await pauses.isPaused(old.id), false);
      assert.equal(await pauses.isPaused(other.id), true);
      assert.notEqual(await world.storage.getAggregate({ kind: "pause-index-state", id: "index-built" }), undefined, "the marker is set");
      assert.equal((await world.storage.getAggregate({ kind: "pause-timed", id: PauseService.gateIdOf(other) }))?.body["active"], true, "a later gate got its entry");
      gateLists = 0;
      assert.deepEqual(await pauses.liftDue(owner), []);
      assert.equal(gateLists, 0, "the second tick lists no gates");
    } finally { await world.close(); }
  });

  test(`${backend.name}: an index built twice at the same moment is harmless (card L06b)`, async () => {
    now = Date.parse("2026-10-22T10:00:00.000Z");
    const world = await backend.open();
    try {
      let legacy = true;
      const storage = new Proxy(world.storage, {
        get(target, prop, receiver) {
          const value = Reflect.get(target, prop, receiver);
          if (typeof value !== "function") return value;
          if (prop === "applyOperation") return (input: { changes: readonly { ref: { kind: string } }[] }) => value.call(target, legacy ? { ...input, changes: input.changes.filter((c) => c.ref.kind !== "pause-timed") } : input);
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
      const scopes: { kind: "task"; id: string }[] = [];
      for (let i = 0; i < 4; i++) {
        const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "x" })).id;
        await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
        const scope = { kind: "task", id } as const;
        await pauses.pause(owner, { commandId: cid("pz"), scope, reason: "hold" });
        await pauses.setResumeCondition(owner, { commandId: cid("rc"), scope, at: new Date(now + 3_600_000).toISOString() });
        scopes.push(scope);
      }
      legacy = false;
      now += 3_600_001;
      const results = await Promise.allSettled([pauses.liftDue(owner), pauses.liftDue(owner), pauses.liftDue(owner)]);
      for (const r of results) assert.equal(r.status, "fulfilled", r.status === "rejected" ? String(r.reason) : "");
      for (const s of scopes) assert.equal(await pauses.isPaused(s.id), false, "every gate is lifted");
      assert.notEqual(await world.storage.getAggregate({ kind: "pause-index-state", id: "index-built" }), undefined);
      assert.deepEqual(await pauses.liftDue(owner), []);
    } finally { await world.close(); }
  });
}
