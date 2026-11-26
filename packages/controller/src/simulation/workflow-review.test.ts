import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { scopedCommandId } from "../security/credentials.js";
import { GrantService, PrincipalService } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { SimulationService } from "./index.js";

// Card P07 (finish), first review: a run that cannot be kept ends with the step failed (never stuck running); grant command IDs never collide; two runs of one scope at once; a crash
// while a stand-in model answers is finished once.

after(stopServer);

let now = Date.parse("2026-11-26T12:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const LAYOUT = { billing: { db: { state: { size: 10 } }, api: { state: { mode: "on" } } }, shop: { cart: { state: { replicas: 1 } } } };

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
  await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
  await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "bea", grants: [] });
  const effects = EffectService.withEpoch(w.storage, projects.epoch, undefined, { ...options, holder: "simulation" });
  const grants = GrantService.withEpoch(w.storage, projects.epoch, options);
  const sims = SimulationService.withEpoch(w.storage, projects.epoch, { effects, grants }, options);
  return { w, projects, owner, project, task, effects, grants, sims };
}

test("a run script's field values are bounded like a scope's states", async () => {
  const { checkScript } = await import("./workflow.js");
  assert.throws(() => checkScript({ steps: [{ agent: "ann", service: "billing", resource: "db", fields: { blob: "x".repeat(9000) } }] }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  assert.throws(() => checkScript({ steps: Array.from({ length: 9 }, (_, i) => ({ agent: "ann", service: "billing", resource: "db", fields: { [`f${i}`]: "x".repeat(7_900) } })) }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command" && /in all/.test(e.message), "the whole script is bounded too");
  assert.throws(() => checkScript({ steps: [{ agent: "ann", service: "billing", resource: "db", action: { type: "set", params: { blob: "x".repeat(9000) } } }] }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
  assert.throws(() => checkScript({ steps: [{ event: "competing-edit", service: "billing", resource: "db", fields: { blob: "x".repeat(9000) } }, { agent: "ann", service: "billing", resource: "db", fields: { a: 1 } }] }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
});

for (const backend of backends) {
  test(`${backend.name}: a run whose change would not fit the scope's record ends with that step failed and nothing changed, never left running (review, card P07)`, async () => {
    const { w, owner, task, sims } = await world(backend);
    try {
      // A scope near the size of one record: 32 resources of 8,000 characters each (about 258,000 of the 261,120 bytes a scope's record may hold).
      const big: Record<string, Record<string, { state: Record<string, string> }>> = {};
      for (let s = 0; s < 4; s++) { big[`svc${s}`] = {}; for (let r = 0; r < 8; r++) big[`svc${s}`]![`r${r}`] = { state: { pad: "p".repeat(8_000) } }; }
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: big })).id;
      const before = (await sims.observe(owner, { scopeId, service: "svc0", resource: "r0" })).state;
      const steps = [
        { agent: "ann", service: "svc0", resource: "r1", fields: { more: "m".repeat(7_000) } },
        { agent: "ann", service: "svc0", resource: "r0", fields: { a: 1 } },
      ];
      // Each step's change is tried first; the one that would not fit is a failed step of a finished run (the owner sees why), and the later step still runs.
      const commandId = cid("run");
      const r = await sims.run(owner, { commandId, scopeId, steps });
      assert.equal(r.run.state, "finished", JSON.stringify(r.run.results));
      assert.equal(r.run.outcome, "completed-with-problems");
      assert.deepEqual(r.run.results.map((x) => x.outcome), ["failed", "done"]);
      assert.match(r.run.results[0]!.words, /would not fit/);
      assert.equal((await sims.observe(owner, { scopeId, service: "svc0", resource: "r1" })).state["more"], undefined, "nothing changed");
      assert.deepEqual({ ...(await sims.observe(owner, { scopeId, service: "svc0", resource: "r0" })).state, a: undefined }, { ...before, a: undefined });
      const again = await sims.run(owner, { commandId, scopeId, steps });
      assert.equal(again.replayed, true);
      assert.deepEqual(again.run.results, r.run.results);
    } finally { await w.close(); }
  });

  test(`${backend.name}: two grant commands whose IDs share their first 100 characters make their own grants (review, card P07)`, async () => {
    const { w, owner, task, sims } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      await sims.run(owner, { commandId: cid("run"), scopeId, steps: [{ agent: "ann", service: "billing", resource: "db", fields: { size: 20 } }] });
      const stem = "g".repeat(100);
      const a = await sims.grant(owner, { commandId: `${stem}-ann`, scopeId, grantee: "agent:ann", basis: "after the simulation" });
      const b = await sims.grant(owner, { commandId: `${stem}-bea`, scopeId, grantee: "agent:bea", basis: "after the simulation" });
      assert.equal(a.grants[0]!.replayed, false);
      assert.equal(b.grants[0]!.replayed, false, "a different command is not the same grant");
      assert.notEqual(a.grants[0]!.id, b.grants[0]!.id);
      // The same command again is the same grant.
      assert.equal((await sims.grant(owner, { commandId: `${stem}-ann`, scopeId, grantee: "agent:ann", basis: "after the simulation" })).grants[0]!.replayed, true);
    } finally { await w.close(); }
  });

  test(`${backend.name}: two runs of one scope at once each do their steps once, one after the other (review, card P07)`, async () => {
    const { w, owner, task, sims, effects } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      const one = [{ agent: "ann", service: "shop", resource: "cart", action: { type: "restart" } }, { agent: "ann", service: "billing", resource: "db", fields: { size: 11 } }];
      const two = [{ agent: "bea", service: "shop", resource: "cart", action: { type: "restart" } }, { agent: "bea", service: "billing", resource: "api", fields: { mode: "off" } }];
      const [x, y] = await Promise.all([sims.run(owner, { commandId: cid("r1"), scopeId, steps: one }), sims.run(owner, { commandId: cid("r2"), scopeId, steps: two })]);
      assert.deepEqual(x.run.results.map((r) => r.outcome), ["done", "done"]);
      assert.deepEqual(y.run.results.map((r) => r.outcome), ["done", "done"]);
      assert.equal((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).state["restarts"], 2, "each restart done once");
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).state["size"], 11);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "api" })).state["mode"], "off");
      for (const id of [...x.run.effects, ...y.run.effects]) assert.equal((await effects.get(id))!.simulation, scopeId);
    } finally { await w.close(); }
  });

  test(`${backend.name}: a crash while the stand-in model answers leaves the attempt started; the scope's bridge finishes it and the repeated run asks no model twice (review, card P07)`, async () => {
    const { w, projects, owner, task, sims, effects: sims0 } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      const commandId = cid("crash");
      const runId = derivedId("smr", scopedCommandId(owner.id, commandId));
      const attempt = derivedId("eff", `simrun:${runId}:s0:a1`);
      const dying = new Proxy(w.storage, {
        get(target, name, receiver) {
          const value = Reflect.get(target, name, receiver) as unknown;
          if (typeof value !== "function") return value;
          if (name === "applyOperation") return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => { if (input.settleEffects.some((s) => s.effectId === attempt)) throw Object.assign(new Error("died"), { kind: "unavailable", name: "StorageError" }); return target.applyOperation(input); };
          return value.bind(target);
        },
      });
      const doomed = SimulationService.withEpoch(w.storage, projects.epoch, { effects: EffectService.withEpoch(dying, projects.epoch, undefined, { ...options, holder: "dies" }) }, options);
      const steps = [{ agent: "ann", service: "billing", resource: "db", fields: { size: 30 } }];
      await assert.rejects(doomed.run(owner, { commandId, scopeId, steps }));
      const left = (await w.storage.getEffect(attempt))!;
      assert.equal(left.status, "intended");
      // After a restart: a real bridge is refused and the attempt is left as it is.
      const later = Date.parse("2026-12-26T10:00:00.000Z");
      const lateOptions = { clock: () => new Date(later).toISOString(), pause: async () => undefined };
      const restarted = await ProjectService.open(w.storage, { holder: "c9", ...lateOptions });
      const ledger = EffectService.withEpoch(w.storage, restarted.epoch, undefined, { ...lateOptions, holder: "recover" });
      let realCalls = 0;
      await refuses("forbidden", () => ledger.run(attempt, { idempotent: true, execute: async () => { realCalls++; return { real: true }; }, reconcile: async () => { realCalls++; return { state: "applied" }; } }));
      assert.equal(realCalls, 0);
      assert.equal((await w.storage.getEffect(attempt))!.status, "intended");
      // The scope's own bridge for it (as the start-up reconciler asks) is the stand-in provider.
      const body = (await sims0.get(attempt))! as never;
      assert.equal((await sims.bridgeFor(attempt, body))?.simulated, true);
      const fresh = SimulationService.withEpoch(w.storage, restarted.epoch, { effects: ledger }, lateOptions);
      const r = await fresh.run(owner, { commandId, scopeId, steps });
      assert.deepEqual(r.run.results.map((x) => x.outcome), ["done"]);
      assert.deepEqual(r.run.results[0]!.attempts!.map((a) => a.effectId), [attempt], "one model attempt, the one that started before the crash");
      assert.equal((await w.storage.getEffect(attempt))!.status, "confirmed");
      assert.equal((await fresh.observe(owner, { scopeId, service: "billing", resource: "db" })).state["size"], 30);
    } finally { await w.close(); }
  });
}
