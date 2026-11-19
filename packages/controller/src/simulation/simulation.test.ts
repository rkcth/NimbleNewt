import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService, SIMULATED_EFFECT_LABEL, SIMULATION_REFUSAL, type EffectBridge } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { scopedCommandId } from "../security/credentials.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { ServiceOperations, SimulatedServices, operationBridge } from "../service-ops/index.js";
import type { JsonObject } from "../storage/types.js";
import { SIMULATION_SCOPE_LABEL, SimulationService } from "./index.js";

// Card P07 (first slice): a simulation scope where the effect ledger refuses any real write, send or spend, and every result is labelled simulated.

after(stopServer);

let now = Date.parse("2026-11-18T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, why?: string): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, why ?? (error as Error).message); return true; });
};
/** A bridge to the real world that counts every call: a refused effect must not reach it at all. */
const realBridge = (): EffectBridge & { calls: string[] } => {
  const calls: string[] = [];
  return { calls, idempotent: true, execute: async (r) => { calls.push(`execute:${r.kind}`); return { done: true }; }, reconcile: async (r) => { calls.push(`reconcile:${r.kind}`); return { state: "applied" }; } };
};
const LAYOUT = {
  billing: { db: { state: { size: 10 }, dependents: [{ service: "billing", resource: "api" }] }, api: { state: {} }, cache: { state: {} } },
  shop: { cart: { state: { replicas: 1 } } },
};

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const boot = await principals.bootstrapOwner({ name: "rob" });
  const owner = await principals.authenticate(boot.token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
  const task2 = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "two" })).id;
  await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "effect.perform", project } as never] });
  const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
  const effects = EffectService.withEpoch(w.storage, projects.epoch, undefined, { ...options, holder: "simulation" });
  const sims = SimulationService.withEpoch(w.storage, projects.epoch, { effects }, options);
  return { w, projects, principals, owner, ann, project, task, task2, effects, sims };
}

for (const backend of backends) {
  test(`${backend.name}: the ledger refuses any real write, send or spend for an effect of a simulation scope, and a simulated stand-in cannot settle a real effect (card P07)`, async () => {
    const { w, effects, owner, task } = await world(backend);
    try {
      const scope = "sms-aaaaaaaaaaaaaaaaaaaa";
      // A write (a push), a send (a message) and a spend (a model call): each is an effect of the scope offered to a real bridge.
      for (const kind of ["git-push", "message-send", "model-call"]) {
        const bridge = realBridge();
        const intent = await effects.intend({ commandId: cid(kind), actor: owner.id, kind, target: `real:${kind}`, input: { x: 1 }, taskId: task, simulation: scope });
        const out = await effects.run(intent.id, bridge);
        assert.equal(out.status, "failed", `${kind}: refused`);
        assert.deepEqual(bridge.calls, [], `${kind}: the real bridge was never called`);
        assert.equal(out.evidence?.["reason"], SIMULATION_REFUSAL);
        assert.equal(out.evidence?.["simulated"], true);
        assert.equal(out.evidence?.["simulation"], scope);
        assert.equal(out.evidence?.["label"], SIMULATED_EFFECT_LABEL);
        const stored = await effects.get(intent.id);
        assert.equal(stored?.status, "failed");
        assert.equal(stored?.simulation, scope);
        assert.equal(stored?.started, false, "it never started");
        // Asked again with the real bridge: the recorded refusal, still nothing done.
        assert.equal((await effects.run(intent.id, bridge)).status, "failed");
        assert.deepEqual(bridge.calls, []);
      }
      // A scope effect that already started under its simulated stand-in (the answer was lost) and is then offered to a real bridge (as a recovery pass after a restart would): refused, never reconciled for real.
      let tries = 0;
      const flaky: EffectBridge = { idempotent: true, simulated: true, execute: async () => { tries += 1; throw new Error("lost"); } };
      const started = await effects.intend({ commandId: cid("st"), actor: owner.id, kind: "service-op", target: "simulation:x", input: { y: 1 }, taskId: task, simulation: scope });
      assert.equal((await effects.run(started.id, flaky)).status, "pending");
      assert.ok(tries >= 1);
      assert.equal((await effects.get(started.id))?.started, true);
      const recovery = realBridge();
      const settled = await effects.run(started.id, recovery);
      assert.equal(settled.status, "failed");
      assert.deepEqual(recovery.calls, [], "the recovery never asked or touched the real target");
      // The other direction: a real effect cannot be done or settled by a stand-in.
      const real = await effects.intend({ commandId: cid("real"), actor: owner.id, kind: "git-push", target: "repo:main", input: { c: "abc" } });
      let standInCalls = 0;
      const standIn: EffectBridge = { idempotent: true, simulated: true, execute: async () => { standInCalls += 1; return {}; } };
      await refuses("forbidden", () => effects.run(real.id, standIn));
      assert.equal(standInCalls, 0);
      assert.equal((await effects.get(real.id))?.status, "intended", "the real effect is untouched");
      assert.equal((await effects.get(real.id))?.started, false);
      // A real effect through a real bridge carries no simulation label.
      const ok = await effects.run(real.id, realBridge());
      assert.equal(ok.status, "confirmed");
      assert.equal(ok.evidence?.["simulated"], undefined);
      // An odd scope ID is refused before anything is recorded.
      await refuses("invalid_command", () => effects.intend({ commandId: cid("bad"), actor: owner.id, kind: "git-push", target: "t", input: {}, simulation: "not-a-scope" }));
    } finally { await w.close(); }
  });

  test(`${backend.name}: a simulation scope runs operations on its own stand-in through the ledger, labelled simulated, with injected failures, and never on the real target (card P07)`, async () => {
    const { w, projects, owner, ann, task, task2, effects, sims } = await world(backend);
    try {
      const realTarget = new SimulatedServices(LAYOUT);
      const serviceOps = ServiceOperations.withEpoch(w.storage, projects.epoch, { effects, target: realTarget, fenceOf: async () => undefined }, options);

      await refuses("forbidden", () => sims.open(ann, { commandId: cid("o"), taskId: task, layout: LAYOUT }), "only the owner opens a scope");
      await refuses("invalid_command", () => sims.open(owner, { commandId: cid("o"), taskId: task, layout: {} }));
      await refuses("invalid_command", () => sims.open(owner, { commandId: cid("o"), taskId: task, layout: { a: { b: { dependents: [{ service: "x", resource: "y" }] } } } }), "a dependent outside the layout");
      await refuses("not_found", () => sims.open(owner, { commandId: cid("o"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", layout: LAYOUT }));
      const opened = await sims.open(owner, { commandId: "open-1", taskId: task, layout: LAYOUT, purpose: "try a restart" });
      assert.equal(opened.scope.state, "open");
      assert.equal(opened.scope.label, SIMULATION_SCOPE_LABEL);
      assert.deepEqual(opened.scope.isolation, { world: "stand-in", realServices: false, tools: false, providers: false, messages: false, grants: false });
      assert.equal((await sims.open(owner, { commandId: "open-1", taskId: task, layout: LAYOUT, purpose: "try a restart" })).replayed, true);
      const scopeId = opened.id;

      // A set: confirmed against the stand-in, labelled, the world kept in the scope's record.
      const set = await sims.operate(owner, { commandId: "op-1", scopeId, service: "billing", resource: "cache", action: { type: "set", params: { fields: { ttl: 60 } } } });
      assert.equal(set.status, "confirmed");
      assert.equal(set.simulated, true);
      assert.equal(set.label, SIMULATED_EFFECT_LABEL);
      assert.equal(set.evidence?.["simulated"], true);
      assert.equal(set.evidence?.["simulation"], scopeId);
      assert.equal(set.evidence?.["verified"], true);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "cache" })).state["ttl"], 60);
      // A fresh service on the same store (a restart) sees the same world, and the same command again does nothing new.
      const again = SimulationService.withEpoch(w.storage, projects.epoch, { effects }, options);
      assert.equal((await again.observe(owner, { scopeId, service: "billing", resource: "cache" })).systemVersion, "v2");
      const repeat = await again.operate(owner, { commandId: "op-1", scopeId, service: "billing", resource: "cache", action: { type: "set", params: { fields: { ttl: 60 } } } });
      assert.equal(repeat.effectId, set.effectId);
      assert.equal((await again.observe(owner, { scopeId, service: "billing", resource: "cache" })).systemVersion, "v2", "applied once");
      await refuses("command_conflict", () => sims.operate(owner, { commandId: "op-1", scopeId, service: "billing", resource: "cache", action: { type: "restart" } }));

      // A restart reaches its dependents; inside the scope that is the stand-in's business only.
      const restart = await sims.operate(owner, { commandId: cid("r"), scopeId, service: "billing", resource: "db", action: { type: "restart" } });
      assert.equal(restart.status, "confirmed");
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "api" })).state["restarts"], 1);

      // Injected failures: refused, a lost answer settled by asking, a wrong write and a leak caught, none confirmed.
      assert.equal((await sims.operate(owner, { commandId: cid("i"), scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 3 } } }, inject: "refuse" })).status, "failed");
      assert.equal((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).state["replicas"], 1, "a refusal changed nothing");
      const lost = await sims.operate(owner, { commandId: cid("i"), scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 2 } } }, inject: "lose-answer" });
      assert.equal(lost.status, "confirmed");
      assert.equal(lost.evidence?.["recovered"], true, "the ledger asked the stand-in instead of applying again");
      assert.equal((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).systemVersion, "v2", "applied once");
      const corrupt = await sims.operate(owner, { commandId: cid("i"), scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 4 } } }, inject: "corrupt" });
      assert.equal(corrupt.status, "uncertain");
      assert.equal(corrupt.evidence?.["simulated"], true);
      const leak = await sims.operate(owner, { commandId: cid("i"), scopeId, service: "billing", resource: "cache", action: { type: "set", params: { fields: { ttl: 5 } } }, inject: "leak" });
      assert.equal(leak.status, "uncertain");
      assert.ok(Array.isArray(leak.evidence?.["collateralMoved"]));
      await refuses("invalid_command", () => sims.operate(owner, { commandId: cid("i"), scopeId, service: "shop", resource: "cart", action: { type: "restart" }, inject: "explode" }));
      await refuses("not_found", () => sims.operate(owner, { commandId: cid("i"), scopeId, service: "shop", resource: "nope", action: { type: "restart" } }));

      // The real target was never reached by anything in the scope.
      assert.deepEqual(realTarget.calls, []);
      assert.equal(realTarget.stateOf({ service: "billing", resource: "cache" })?.["ttl"], undefined);
      // A simulated result can never be named as a real outcome.
      await assert.rejects(() => serviceOps.checkOutcome(task, { reference: set.effectId, systemVersion: String(set.evidence?.["systemVersion"]), observedAt: String(set.evidence?.["observedAt"]) }), /simulated/);
      // A real operation is still the real thing: it needs its own grant (the agent's), reaches the real target, and is not labelled.
      const realOp = await serviceOps.operate(owner, { commandId: cid("real"), taskId: task, service: "billing", resource: "cache", action: { type: "set", params: { fields: { ttl: 30 } } } });
      assert.equal(realOp.status, "confirmed");
      assert.equal(realOp.evidence?.["simulated"], undefined);
      assert.equal(realTarget.calls.length, 1);

      // The scope view lists its effects as the ledger has them, each simulated.
      const view = await sims.get(owner, scopeId);
      assert.equal(view.effects.length, 6);
      assert.ok(view.effects.every((e) => e.simulated === true && e.target?.startsWith(`simulation:${scopeId}/`)));
      for (const e of view.effects) assert.equal((await effects.get(e.effectId))?.simulation, scopeId);

      // Who may use it: the owner; an agent and an owner credential confined to another task may not.
      await refuses("forbidden", () => sims.operate(ann, { commandId: cid("a"), scopeId, service: "shop", resource: "cart", action: { type: "restart" } }));
      await refuses("not_found", () => sims.get(ann, scopeId));
      await refuses("not_found", () => sims.observe(ann, { scopeId, service: "shop", resource: "cart" }));
      const confined = { ...owner, taskScope: { taskId: task2, projectId: opened.scope.projectId } } as typeof owner;
      await refuses("forbidden", () => sims.operate(confined, { commandId: cid("c"), scopeId, service: "shop", resource: "cart", action: { type: "restart" } }));
      await refuses("not_found", () => sims.get(owner, "sms-bbbbbbbbbbbbbbbbbbbb"));

      // Closed: nothing more runs; what it recorded stays readable; closing again is harmless.
      assert.equal((await sims.close(owner, { commandId: "close-1", scopeId })).scope.state, "closed");
      assert.equal((await sims.close(owner, { commandId: "close-2", scopeId })).scope.state, "closed");
      await refuses("invalid_command", () => sims.operate(owner, { commandId: cid("late"), scopeId, service: "shop", resource: "cart", action: { type: "restart" } }));
      assert.equal((await sims.get(owner, scopeId)).effects.length, 6);
    } finally { await w.close(); }
  });

  test(`${backend.name}: an operation intended before a crash is finished once on the scope's stand-in, a closed scope runs nothing more, and a change the scope's record could not keep is refused before it is done (card P07, review)`, async () => {
    const { w, owner, task, effects, sims } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      // The process stopped after the intent was recorded and before it ran: the same command again runs it, once, on the stand-in.
      const intendOnly = async (commandId: string, fields: JsonObject): Promise<string> => {
        const input = { service: "shop", resource: "cart", action: { type: "set", params: { fields } }, allowed: [{ service: "shop", resource: "cart" }], before: {}, baseline: {} } as unknown as JsonObject;
        return (await effects.intend({ commandId: `simop:${scopeId}:${scopedCommandId(owner.id, commandId)}`, actor: owner.id, kind: "service-op", target: `simulation:${scopeId}/service:shop/cart`, input, taskId: task, simulation: scopeId })).id;
      };
      const crashed = await intendOnly("crash-1", { replicas: 5 });
      assert.equal(crashed, derivedId("eff", `simop:${scopeId}:${scopedCommandId(owner.id, "crash-1")}`));
      const resumed = await sims.operate(owner, { commandId: "crash-1", scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 5 } } } });
      assert.equal(resumed.effectId, crashed);
      assert.equal(resumed.status, "confirmed");
      assert.equal((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).state["replicas"], 5);
      assert.ok((await sims.get(owner, scopeId)).effects.some((e) => e.effectId === crashed), "listed in the scope");
      // Another left unrun, then the scope is closed: repeating its command reports it as recorded and runs nothing.
      const left = await intendOnly("crash-2", { replicas: 7 });
      await sims.close(owner, { commandId: cid("c"), scopeId });
      const late = await sims.operate(owner, { commandId: "crash-2", scopeId, service: "shop", resource: "cart", action: { type: "set", params: { fields: { replicas: 7 } } } });
      assert.equal(late.effectId, left);
      assert.equal(late.status, "intended");
      assert.match(String(late.note), /closed/);
      assert.equal((await effects.get(left))?.started, false, "never started");
      assert.equal((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).state["replicas"], 5, "the stand-in is unchanged");

      // The whole stand-in lives in one record: a layout or a change that would not fit is refused before anything is recorded or done.
      const big = "x".repeat(7000);
      const wide = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`r${i}`, { state: { a: big } }]));
      await refuses("invalid_command", () => sims.open(owner, { commandId: cid("o"), taskId: task, layout: { s: wide, t: wide } }));
      const roomy = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: { s: Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`r${i}`, { state: {} }])) } })).id;
      let refused = 0;
      for (let i = 0; i < 12; i++) {
        const before = (await sims.get(owner, roomy)).effects.length;
        try {
          const r = await sims.operate(owner, { commandId: cid("g"), scopeId: roomy, service: "s", resource: `r${i}`, action: { type: "set", params: { fields: { f: "y".repeat(30000) } } } });
          assert.equal(r.status, "confirmed");
          assert.equal((await sims.observe(owner, { scopeId: roomy, service: "s", resource: `r${i}` })).systemVersion, "v2", "what the ledger confirmed is what the record holds");
        } catch (error) {
          assert.ok(error instanceof DomainError && error.code === "invalid_command" && /would not fit/.test(error.message), String(error));
          refused += 1;
          assert.equal((await sims.get(owner, roomy)).effects.length, before, "nothing recorded");
          assert.equal((await sims.observe(owner, { scopeId: roomy, service: "s", resource: `r${i}` })).systemVersion, "v1", "nothing done");
        }
      }
      assert.ok(refused > 0, "the record's bound was reached");
      const view = await sims.get(owner, roomy);
      assert.ok(view.effects.every((e) => e.status === "confirmed"));
    } finally { await w.close(); }
  });

  test(`${backend.name}: a scope's effect offered to the real service bridge (as a recovery pass that picks bridges by kind would) is refused and leaves the real target untouched (card P07)`, async () => {
    const { w, owner, task, effects, sims } = await world(backend);
    try {
      const realTarget = new SimulatedServices(LAYOUT);
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      const done = await sims.operate(owner, { commandId: cid("op"), scopeId, service: "shop", resource: "cart", action: { type: "restart" } });
      // A second intent of the scope that has not run yet, offered to the real `service-op` bridge.
      const pending = await effects.intend({ commandId: cid("pend"), actor: owner.id, kind: "service-op", target: `simulation:${scopeId}/service:shop/cart`, input: { service: "shop", resource: "cart", action: { type: "restart" }, allowed: [{ service: "shop", resource: "cart" }], before: {}, baseline: {} } as JsonObject, taskId: task, simulation: scopeId });
      const out = await effects.run(pending.id, operationBridge(realTarget));
      assert.equal(out.status, "failed");
      assert.equal(out.evidence?.["reason"], SIMULATION_REFUSAL);
      // The confirmed one is only read back as recorded, labelled.
      const reread = await effects.run(done.effectId, operationBridge(realTarget));
      assert.equal(reread.status, "confirmed");
      assert.equal(reread.evidence?.["simulated"], true);
      assert.deepEqual(realTarget.calls, [], "the real target was never reached");
    } finally { await w.close(); }
  });
}
