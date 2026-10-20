import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import {
  AssignmentService, DomainError, EffectRejected, EffectService, type DomainErrorCode, type EffectBridge, type EffectRequest, type Fence, type Owner,
} from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer, type World } from "./testing/backends.js";

after(stopServer);

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const me = "rob";
const ann: Owner = { kind: "agent", id: "ann" };
const bob: Owner = { kind: "agent", id: "bob" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    check?.(error);
    return true;
  });
};

/** The outside world: every application of an effect, so "once" can be counted. */
class Outside {
  applications: string[] = [];
  executeCalls = 0;
  /** Fail the next `execute` calls with this before applying anything (a connection that never reached the target). */
  failBefore = 0;
  /** Apply, then fail (the answer was lost). */
  failAfter = 0;
  readonly has = (key: string): boolean => this.applications.includes(key);
  apply(key: string): JsonObject { this.applications.push(key); return { receipt: `r-${this.applications.length}`, key }; }
}

/** The target honours the key: executing again with a key already applied applies nothing. */
const keyed = (o: Outside): EffectBridge => ({
  idempotent: true,
  execute: async (r: EffectRequest) => {
    o.executeCalls++;
    if (o.failBefore > 0) { o.failBefore--; throw new Error("connection refused"); }
    const result = o.has(r.key) ? { receipt: "r-existing", key: r.key } : o.apply(r.key);
    if (o.failAfter > 0) { o.failAfter--; throw new Error("answer lost"); }
    return result;
  },
});
/** Not idempotent (it applies every time), but it can be asked. */
const askable = (o: Outside): EffectBridge => ({
  idempotent: false,
  execute: async (r: EffectRequest) => {
    o.executeCalls++;
    if (o.failBefore > 0) { o.failBefore--; throw new Error("connection refused"); }
    const result = o.apply(r.key);
    if (o.failAfter > 0) { o.failAfter--; throw new Error("answer lost"); }
    return result;
  },
  reconcile: async (r: EffectRequest) => ({ state: o.has(r.key) ? "applied" as const : "not_applied" as const, evidence: { asked: true } }),
});
/** Neither idempotent nor askable: an unsupported target. */
const opaque = (o: Outside): EffectBridge => ({
  idempotent: false,
  execute: async (r: EffectRequest) => {
    o.executeCalls++;
    if (o.failBefore > 0) { o.failBefore--; throw new Error("connection refused"); }
    const result = o.apply(r.key);
    if (o.failAfter > 0) { o.failAfter--; throw new Error("answer lost"); }
    return result;
  },
});

/** Storage whose first settlement commit fails before it happens: the effect was done outside but the result was not saved (a crash at that point). */
function losingFirstSettlement(storage: ControllerStorage, options: { dead?: boolean } = {}): ControllerStorage {
  let lost = false;
  return new Proxy(storage, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (name === "applyOperation") {
        return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
          // `dead`: the process is gone, so nothing it tries afterwards (such as giving its claim back) reaches the database either.
          if ((lost && options.dead === true) || (!lost && input.settleEffects.length > 0)) { lost = true; throw Object.assign(new Error("process died"), { kind: "unavailable", name: "StorageError" }); }
          return target.applyOperation(input);
        };
      }
      return value.bind(target);
    },
  });
}

/** Waits (polling, with a deadline) until a condition holds: never a fixed pause, which a slow machine can outrun. */
async function until(condition: () => boolean, what: string, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const deferred = <T>() => { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };

for (const backend of backends) {
  const suite = (name: string, body: (ctx: { effects: EffectService; make: (holder: string, storage?: ControllerStorage) => EffectService; projects: ProjectService; assign: AssignmentService; world: World; epoch: number; clock: { now: number } }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const clock = { now: T0 };
      const stamp = () => new Date(clock.now).toISOString();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", clock: stamp, pause: async () => undefined });
        const assign = AssignmentService.withEpoch(world.storage, projects.epoch, projects, { clock: stamp, pause: async () => undefined });
        const make = (holder: string, storage: ControllerStorage = world.storage) => EffectService.withEpoch(storage, projects.epoch, assign, { holder, clock: stamp, pause: async () => undefined });
        await body({ effects: make("exec-1"), make, projects, assign, world, epoch: projects.epoch, clock });
      } finally { await world.close(); }
    });
  const intent = (label: string, extra: Record<string, unknown> = {}) => ({ commandId: cid(label), actor: me, kind: "git-push", target: "repo:main", input: { ref: "main", commit: "abc" }, ...extra });
  const ownedTask = async (projects: ProjectService, assign: AssignmentService): Promise<{ taskId: string; fence: Fence }> => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "G" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "push" });
    await projects.transitionTask({ commandId: cid("r"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId: t.id, owner: ann });
    const att = await assign.admitAttempt({ commandId: cid("adm"), actor: me, taskId: t.id, expectedRevision: 1, generation: 1, owner: ann });
    return { taskId: t.id, fence: { generation: 1, attemptId: att.id } };
  };

  for (const [label, make] of [["idempotent", keyed], ["askable", askable], ["unsupported", opaque]] as const) {
    suite(`${label} target: an effect is recorded as intended first, done once, confirmed with evidence, and a repeat does nothing`, async ({ effects, world }) => {
      const outside = new Outside();
      const command = intent("e");
      const made = await effects.intend(command);
      const before = await world.storage.getEffect(made.id);
      assert.deepEqual([before?.status, before?.target, before?.reconciliationHandle], ["intended", "repo:main", made.id]);
      assert.equal(outside.applications.length, 0, "nothing has happened yet");
      const done = await effects.run(made.id, make(outside));
      assert.deepEqual([done.status, done.evidence?.["key"]], ["confirmed", made.id]);
      assert.deepEqual(outside.applications, [made.id]);
      const again = await effects.perform(command, make(outside));
      assert.equal(again.status, "confirmed");
      assert.equal(outside.applications.length, 1, "the repeated command applied nothing");
      assert.equal(outside.executeCalls, 1);
      const view = (await effects.get(made.id))!;
      assert.deepEqual([view.status, view.started, "claim" in view, view.key, view.inputDigest.length], ["confirmed", true, false, made.id, 64]);
    });
  }

  suite("a target that refuses the effect makes it failed, and it is not tried again", async ({ effects }) => {
    const outside = new Outside();
    const refusing: EffectBridge = { idempotent: true, execute: async () => { outside.executeCalls++; throw new EffectRejected("branch is protected", { code: 403 }); } };
    const r = await effects.perform(intent("e"), refusing);
    assert.deepEqual([r.status, r.evidence?.["code"], r.evidence?.["reason"]], ["failed", 403, "branch is protected"]);
    assert.equal((await effects.run(r.effectId, refusing)).status, "failed");
    assert.equal(outside.executeCalls, 1);
  });

  suite("killed after the outside success and before the result was saved: an idempotent target applies once", async ({ make, world }) => {
    const outside = new Outside();
    const crashing = make("exec-1", losingFirstSettlement(world.storage));
    const command = intent("e");
    await assert.rejects(crashing.perform(command, keyed(outside)));
    assert.deepEqual([outside.applications.length, (await world.storage.getEffect((await crashing.intend(command)).id))?.status], [1, "intended"], "applied outside, not recorded");
    const recovered = await crashing.perform(command, keyed(outside));
    assert.equal(recovered.status, "confirmed");
    assert.equal(outside.applications.length, 1, "the protected effect occurred once");
    assert.equal(outside.executeCalls, 2, "the same key was sent again");
  });

  suite("killed after the outside success and before the result was saved: an askable target is asked, not repeated", async ({ make, world }) => {
    const outside = new Outside();
    const crashing = make("exec-1", losingFirstSettlement(world.storage));
    const command = intent("e");
    await assert.rejects(crashing.perform(command, askable(outside)));
    const recovered = await crashing.perform(command, askable(outside));
    assert.deepEqual([recovered.status, recovered.evidence?.["recovered"], outside.applications.length, outside.executeCalls], ["confirmed", true, 1, 1]);
  });

  suite("killed after the outside success and before the result was saved: an unsupported target becomes uncertain and is never retried blindly", async ({ make, world }) => {
    const outside = new Outside();
    const crashing = make("exec-1", losingFirstSettlement(world.storage));
    const command = intent("e");
    await assert.rejects(crashing.perform(command, opaque(outside)));
    const first = await crashing.intend(command);
    const recovered = await crashing.run(first.id, opaque(outside)).catch((e: unknown) => e);
    // The recovery itself settles it as uncertain.
    assert.equal((await crashing.get(first.id))!.status, "uncertain", String(recovered));
    assert.equal(outside.applications.length, 1);
    for (let i = 0; i < 3; i++) await refuses("effect_uncertain", () => crashing.run(first.id, opaque(outside)));
    await refuses("effect_uncertain", () => crashing.perform(command, opaque(outside)));
    assert.equal(outside.executeCalls, 1, "nothing was sent again");
    // A person checks the target and decides.
    await refuses("invalid_command", () => crashing.resolve({ commandId: cid("res"), actor: "rob", effectId: first.id, outcome: "confirmed", evidence: {} }));
    await crashing.resolve({ commandId: cid("res"), actor: "rob", effectId: first.id, outcome: "confirmed", evidence: { checked: "the repository shows the commit" } });
    const resolved = await crashing.run(first.id, opaque(outside));
    assert.deepEqual([resolved.status, resolved.evidence?.["resolvedBy"]], ["confirmed", "rob"]);
    assert.equal(outside.applications.length, 1);
    await refuses("invalid_command", () => crashing.resolve({ commandId: cid("res2"), actor: "rob", effectId: first.id, outcome: "failed", evidence: { checked: "again" } }), (e) => assert.match(e.message, /only an uncertain effect/));
  });

  suite("an unsupported target whose answer is lost becomes uncertain at once", async ({ effects }) => {
    const outside = new Outside();
    outside.failAfter = 1;
    const r = await effects.perform(intent("e"), opaque(outside));
    assert.equal(r.status, "uncertain");
    assert.equal(outside.applications.length, 1);
    await refuses("effect_uncertain", () => effects.run(r.effectId, opaque(outside)));
  });

  suite("an idempotent target that cannot be reached leaves the effect pending and a retry uses the same key", async ({ effects }) => {
    const outside = new Outside();
    outside.failBefore = 2;
    const command = intent("e");
    const first = await effects.perform(command, keyed(outside));
    assert.deepEqual([first.status, outside.applications.length], ["pending", 0]);
    assert.match(first.note ?? "", /same key/);
    assert.equal((await effects.run(first.effectId, keyed(outside))).status, "pending");
    assert.equal((await effects.run(first.effectId, keyed(outside))).status, "confirmed");
    assert.deepEqual(outside.applications, [first.effectId]);
  });

  suite("an askable target that never received the request is asked, found untouched, and the effect is then executed once", async ({ effects }) => {
    const outside = new Outside();
    outside.failBefore = 1;
    const r = await effects.perform(intent("e"), askable(outside));
    assert.deepEqual([r.status, outside.applications.length, outside.executeCalls], ["confirmed", 1, 2]);
  });

  suite("an attempt that lost its generation before the effect started never starts it; one that lost it afterwards only asks", async ({ effects, make, projects, assign, world }) => {
    const { taskId, fence } = await ownedTask(projects, assign);
    const outside = new Outside();
    // 1. Intended under a current fence, then ownership moves before it starts.
    const early = await effects.intend(intent("early", { taskId, fence }));
    await assign.transferTask({ commandId: cid("tr"), actor: me, taskId, expectedRevision: 2, to: bob });
    const skipped = await effects.run(early.id, keyed(outside));
    assert.deepEqual([skipped.status, skipped.evidence?.["reason"]], ["failed", "superseded before it started"]);
    assert.equal(outside.executeCalls, 0);
    // The old fence cannot even record a new intent.
    await refuses("fenced", () => effects.intend(intent("late", { taskId, fence })));
    // 2. Started under a current fence (the result is lost), then ownership moves.
    const owner2 = await assign.admitAttempt({ commandId: cid("adm2"), actor: me, taskId, expectedRevision: 3, generation: 2, owner: bob });
    const fence2: Fence = { generation: 2, attemptId: owner2.id };
    for (const [bridge, expected] of [[keyed, "uncertain"], [askable, "confirmed"]] as const) {
      const o = new Outside();
      const started = await effects.intend(intent("started", { taskId, fence: fence2 }));
      const crashing = make("exec-x", losingFirstSettlement(world.storage));
      await assert.rejects(crashing.run(started.id, bridge(o)));
      assert.equal(o.applications.length, 1);
      const rev = (await assign.getAssignment(taskId))!.revision;
      await assign.releaseTask({ commandId: cid("rel"), actor: me, taskId, expectedRevision: rev });
      const recovered = await crashing.run(started.id, bridge(o));
      assert.equal(recovered.status, expected, `${expected} for ${o.applications.length} application(s)`);
      assert.equal(o.applications.length, 1, "recovery after losing the generation never applied it again");
      assert.equal(o.executeCalls, 1);
      // Put ownership back for the next round.
      const rev2 = (await assign.getAssignment(taskId))!.revision;
      await assign.assignTask({ commandId: cid("re"), actor: me, taskId, expectedRevision: rev2, owner: bob });
      const g = (await assign.getAssignment(taskId))!;
      const next = await assign.admitAttempt({ commandId: cid("adm3"), actor: me, taskId, expectedRevision: g.revision, generation: g.generation, owner: bob });
      fence2.attemptId === next.id || Object.assign(fence2, { generation: g.generation, attemptId: next.id });
    }
  });

  suite("two executors cannot both act on an effect; the one that lost waits for the lease, then recovers", async ({ make, world, clock }) => {
    const outside = new Outside();
    const a = make("exec-a", losingFirstSettlement(world.storage, { dead: true }));
    const b = make("exec-b");
    const made = await a.intend(intent("e"));
    await assert.rejects(a.run(made.id, askable(outside)));
    assert.equal(outside.applications.length, 1);
    await refuses("effect_busy", () => b.run(made.id, askable(outside)), (e) => assert.match(e.message, /exec-a/));
    clock.now += 6 * 60_000;
    const recovered = await b.run(made.id, askable(outside));
    assert.deepEqual([recovered.status, outside.applications.length, outside.executeCalls], ["confirmed", 1, 1]);
    // Run together from the start, only one of them acts.
    const c = make("exec-c");
    const d = make("exec-d");
    const fresh = await c.intend(intent("e2"));
    const o2 = new Outside();
    const results = await Promise.allSettled([c.run(fresh.id, opaque(o2)), d.run(fresh.id, opaque(o2))]);
    assert.equal(o2.applications.length, 1, "the protected effect occurred once");
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "effect_busy", String(r.reason));
    assert.ok(results.some((r) => r.status === "fulfilled"));
  });

  suite("a second run of an effect already running is refused, so a non-idempotent target is not applied twice", async ({ effects }) => {
    const outside = new Outside();
    const gate = deferred<void>();
    const slow: EffectBridge = { ...askable(outside), execute: async (r) => { outside.executeCalls++; await gate.promise; return outside.apply(r.key); } };
    const made = await effects.intend(intent("e"));
    const first = effects.run(made.id, slow);
    await until(() => outside.executeCalls === 1, "the first run to reach the target");
    await refuses("effect_busy", () => effects.run(made.id, slow), (e) => assert.match(e.message, /already being run/));
    gate.resolve();
    assert.equal((await first).status, "confirmed");
    assert.deepEqual([outside.applications.length, outside.executeCalls], [1, 1]);
    // And a restarted executor that reuses the same name is held off by the claim it left behind, until the lease ends.
  });

  suite("an executor that died holding a claim keeps its name out until the lease ends, even when the name is reused", async ({ make, world, clock }) => {
    const outside = new Outside();
    const dead = make("exec-fixed", losingFirstSettlement(world.storage, { dead: true }));
    const made = await dead.intend(intent("e"));
    await assert.rejects(dead.run(made.id, askable(outside)));
    const restarted = make("exec-fixed");
    await refuses("effect_busy", () => restarted.run(made.id, askable(outside)));
    clock.now += 6 * 60_000;
    assert.equal((await restarted.run(made.id, askable(outside))).status, "confirmed");
    assert.equal(outside.applications.length, 1);
  });

  suite("after a vanished executor a target that cannot be keyed is not executed again on a 'not applied' answer, but a keyed one is", async ({ make, world, clock }) => {
    for (const [name, idempotent, expected] of [["unkeyed", false, "uncertain"], ["keyed", true, "confirmed"]] as const) {
      const outside = new Outside();
      const hang = deferred<JsonObject>();
      const bridge = (): EffectBridge => ({ idempotent, reconcile: async (r) => ({ state: outside.has(r.key) ? "applied" : "not_applied" }), execute: async (r) => { outside.executeCalls++; if (outside.executeCalls === 1) return hang.promise; return outside.has(r.key) ? { receipt: "existing" } : outside.apply(r.key); } });
      const a = make(`exec-a-${name}`);
      const made = await a.intend(intent(`e-${name}`));
      void a.run(made.id, bridge()).catch(() => undefined);
      await until(() => outside.executeCalls === 1, "the first executor to reach the target");
      clock.now += 6 * 60_000;
      // The first executor is stuck in its request, which has not reached the target yet. A second one takes over after the lease.
      const b = make(`exec-b-${name}`);
      const r = await b.run(made.id, bridge());
      assert.equal(r.status, expected, name);
      assert.equal(outside.applications.length, expected === "confirmed" ? 1 : 0, name);
      hang.resolve({ receipt: "late" });
    }
  });

  suite("a result that arrives after the lease passed to someone else is not recorded over theirs", async ({ make, clock }) => {
    const outside = new Outside();
    const gateA = deferred<void>();
    const gateB = deferred<void>();
    let calls = 0;
    const bridge = (): EffectBridge => ({
      idempotent: true,
      reconcile: async (r) => ({ state: outside.has(r.key) ? "applied" : "not_applied" }),
      execute: async (r) => { const mine = ++calls; await (mine === 1 ? gateA : gateB).promise; return outside.has(r.key) ? { receipt: "existing" } : outside.apply(r.key); },
    });
    const a = make("exec-a");
    const b = make("exec-b");
    const made = await a.intend(intent("e"));
    const runA = a.run(made.id, bridge());
    await until(() => calls === 1, "executor A to reach the target");
    clock.now += 6 * 60_000;
    const runB = b.run(made.id, bridge());
    await until(() => calls === 2, "executor B to take the claim and reach the target");
    gateA.resolve();
    const late = await runA;
    assert.equal(late.status, "pending", "A's late result is not recorded while B holds the effect");
    assert.match(late.note ?? "", /passed to exec-b/);
    gateB.resolve();
    assert.equal((await runB).status, "confirmed");
    assert.equal(outside.applications.length, 1, "the keyed target applied it once");
    assert.equal((await a.get(made.id))!.status, "confirmed");
  });

  suite("validation, replay and conflicts", async ({ effects }) => {
    const command = intent("e");
    const one = await effects.intend(command);
    assert.deepEqual(await effects.intend(command), { ...one, replayed: true });
    await refuses("command_conflict", () => effects.intend({ ...command, target: "repo:other" }));
    await refuses("invalid_command", () => effects.intend(intent("bad", { kind: "Git Push" })));
    await refuses("invalid_command", () => effects.intend(intent("bad", { input: [] })));
    await refuses("invalid_command", () => effects.intend(intent("bad", { fence: { generation: 1, attemptId: "att-aaaaaaaaaaaaaaaaaaaa" } })), (e) => assert.equal(e.field, "taskId"));
    await refuses("invalid_command", () => effects.intend(intent("bad", { colour: "red" })));
    await refuses("not_found", () => effects.run("eff-aaaaaaaaaaaaaaaaaaaa", keyed(new Outside())));
    await refuses("invalid_command", () => effects.run("nope", keyed(new Outside())));
    assert.equal(await effects.get("eff-aaaaaaaaaaaaaaaaaaaa"), undefined);
  });
}
