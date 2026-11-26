import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService, SIMULATED_EFFECT_LABEL, type EffectBridge } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { AssignmentService, BlockerService, InboxService, Reconciler } from "../domain/index.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { classifyProviderFailure } from "../routing/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { GrantService, PrincipalService } from "../security/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { SimulationService } from "./index.js";
import { PROVIDER_FAILURE_ANSWER, checkScript } from "./workflow.js";

// Card P07, the run part: a workflow runs end to end in a simulation scope (stand-in agents, stand-in providers decided by the real R02 fallback, the scope's stand-in services as tools,
// provider failures and competing edits as events), with every effect in the ledger marked with the scope; the owner's real grant is a separate step; a crash part-way is finished once.

after(stopServer);

let now = Date.parse("2026-11-26T10:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const LAYOUT = {
  billing: { db: { state: { size: 10 } }, api: { state: { mode: "on" } }, cache: { state: { ttl: 1 } } },
  shop: { cart: { state: { replicas: 1 } } },
};

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
  await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "effect.perform", project } as never] });
  const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
  const effects = EffectService.withEpoch(w.storage, projects.epoch, undefined, { ...options, holder: "simulation" });
  const grants = GrantService.withEpoch(w.storage, projects.epoch, options);
  const sims = SimulationService.withEpoch(w.storage, projects.epoch, { effects, grants }, options);
  const runner = new CommandRunner(w.storage, projects.epoch, options);
  const count = async (kind: string): Promise<number> => (await runner.list(kind, { limit: 500 })).length;
  const scope = async () => (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
  return { w, projects, principals, owner, ann, project, task, effects, grants, sims, runner, count, scope };
}

test("a stand-in provider's failure is worded so the R02 classifier sorts it as that kind", () => {
  for (const [kind, said] of Object.entries(PROVIDER_FAILURE_ANSWER)) assert.equal(classifyProviderFailure(said), kind);
});

test("the run script is checked: shapes, limits, routes, and a competing edit needs an agent step after it", () => {
  const ok = checkScript({ steps: [{ agent: "ann", service: "billing", resource: "db", fields: { a: 1 } }] });
  assert.deepEqual(ok.providers, ["sim-primary/model", "sim-backup/model"]);
  assert.deepEqual(ok.steps[0], { kind: "agent", agent: "ann", service: "billing", resource: "db", action: { type: "set", params: { fields: { a: 1 } } } });
  const bad: unknown[][] = [
    [], [{ event: "provider-failure", failure: "outage" }], [{ event: "competing-edit", service: "billing", resource: "db", fields: { a: 1 } }],
    [{ agent: "ann", service: "billing", resource: "db" }], [{ agent: "Ann!", service: "billing", resource: "db", fields: {} }], [{ event: "storm" }],
    [{ event: "provider-failure", failure: "melted" }, { agent: "ann", service: "billing", resource: "db", fields: {} }],
    [{ event: "provider-failure", failure: "outage", route: "real/route" }, { agent: "ann", service: "billing", resource: "db", fields: {} }],
    [{ event: "provider-failure", failure: "outage", times: 9 }, { agent: "ann", service: "billing", resource: "db", fields: {} }],
    Array.from({ length: 31 }, () => ({ agent: "ann", service: "billing", resource: "db", fields: {} })),
  ];
  for (const steps of bad) assert.throws(() => checkScript({ steps }), (e: unknown) => e instanceof DomainError && e.code === "invalid_command", JSON.stringify(steps).slice(0, 120));
  assert.throws(() => checkScript({ steps: [{ agent: "a", service: "s", resource: "r", fields: {} }], providers: ["a/b", "a/b"] }));
  assert.throws(() => checkScript({ steps: [{ agent: "a", service: "s", resource: "r", fields: {} }], providers: [] }));
});

for (const backend of backends) {
  test(`${backend.name}: a workflow runs end to end in a scope: stand-in agents, an outage moving to the fallback route, a competing edit read again and redone, one on the same fields left as a conflict; every effect is the scope's and the real task's spend is untouched (card P07)`, async () => {
    const { w, owner, ann, sims, effects, count, scope, task } = await world(backend);
    try {
      const scopeId = await scope();
      const steps = [
        { agent: "ann", service: "billing", resource: "db", fields: { size: 20 } },
        { event: "provider-failure", failure: "outage" },
        { agent: "bob", service: "shop", resource: "cart", action: { type: "restart" } },
        { event: "competing-edit", service: "billing", resource: "api", fields: { mode: "maintenance" } },
        { agent: "ann", service: "billing", resource: "api", fields: { owner: "ann" } },
        { event: "competing-edit", service: "billing", resource: "cache", fields: { ttl: 5 } },
        { agent: "bob", service: "billing", resource: "cache", fields: { ttl: 9 } },
      ];
      const commandId = cid("run");
      const r = await sims.run(owner, { commandId, scopeId, steps });
      assert.equal(r.replayed, false);
      const run = r.run;
      assert.equal(run.state, "finished");
      assert.equal(run.outcome, "completed-with-problems", "the conflict is a problem the owner sees");
      assert.deepEqual(run.results.map((x) => x.outcome), ["done", "armed", "done", "armed", "retried", "armed", "conflict"]);
      assert.equal(run.label, (await sims.get(owner, scopeId)).scope.label);
      assert.ok(run.results.every((x) => x.simulated === true));
      // The R02 fallback: the first agent asked the primary; after the injected outage the second moved to the backup route.
      assert.deepEqual(run.results[0]!.attempts!.map((a) => [a.route, a.outcome]), [["sim-primary/model", "answered"]]);
      assert.deepEqual(run.results[2]!.attempts!.map((a) => [a.route, a.outcome, a.failure ?? ""]), [["sim-primary/model", "failed", "outage"], ["sim-backup/model", "answered", ""]]);
      assert.equal(run.results[2]!.fallback, true);
      // The injected outage was one call: it is used up, so the next agents are answered by the primary again.
      assert.deepEqual(run.results[4]!.attempts!.map((a) => [a.route, a.outcome]), [["sim-primary/model", "answered"]]);
      assert.deepEqual(run.results[6]!.attempts!.map((a) => [a.route, a.outcome]), [["sim-primary/model", "answered"]]);
      assert.match(run.results[2]!.words, /fallback sim-backup\/model answered/);
      // The competing edit: the first write refused with nothing changed, read again, done on the newer version; both writers' fields are kept.
      const api = await sims.observe(owner, { scopeId, service: "billing", resource: "api" });
      assert.deepEqual(api.state, { mode: "maintenance", owner: "ann" });
      assert.equal((await effects.get(run.results[4]!.tool!.effectId))!.status, "failed");
      assert.match(JSON.stringify((await effects.get(run.results[4]!.tool!.effectId))!.evidence), /another writer changed billing\/api/);
      assert.equal(run.results[4]!.retry!.status, "confirmed");
      // On the same fields: nothing written over the other writer's change.
      assert.deepEqual((await sims.observe(owner, { scopeId, service: "billing", resource: "cache" })).state, { ttl: 5 });
      assert.match(run.results[6]!.words, /left for you to decide/);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).state["size"], 20);

      // The ledger: every effect of the run is the scope's (model calls and service operations), labelled; no effect without the scope exists at all.
      const kinds = new Set<string>();
      for (const id of run.effects) {
        const e = (await effects.get(id))!;
        assert.equal(e.simulation, scopeId, id);
        kinds.add(e.kind);
        if (e.status === "confirmed" || e.status === "failed") { assert.equal(e.evidence?.["simulated"], true); assert.equal(e.evidence?.["label"], SIMULATED_EFFECT_LABEL); }
      }
      assert.deepEqual([...kinds].sort(), ["model-call", "service-op"]);
      const all = await w.storage.listAggregates("effect", { limit: 500 });
      assert.ok(all.every((a) => typeof (a.body as { simulation?: string }).simulation === "string"), "no real effect was intended");
      // The provider stand-ins spent nothing, and the R02 state stayed on the run's own store: the real store holds no model call and no spend of the task.
      assert.equal(await count("model-call"), 0);
      assert.equal(await count(`msp-${task}`), 0);
      for (const id of run.effects) { const e = (await effects.get(id))!; if (e.kind === "model-call" && e.status === "confirmed") assert.deepEqual(e.evidence?.["usage"], { inputTokens: 0, outputTokens: 0, costMicros: 0 }); }

      // A repeat answers the run; nothing more is done. The same command with another script is a conflict.
      const before = (await w.storage.listAggregates("effect", { limit: 500 })).length;
      const again = await sims.run(owner, { commandId, scopeId, steps });
      assert.equal(again.replayed, true);
      assert.deepEqual(again.run.results, run.results);
      assert.equal((await w.storage.listAggregates("effect", { limit: 500 })).length, before);
      await refuses("command_conflict", () => sims.run(owner, { commandId, scopeId, steps: steps.slice(0, 1) }));
      // Owner only; a missing resource and a closed scope are refused before anything is recorded.
      await refuses("forbidden", () => sims.run(ann, { commandId: cid("run"), scopeId, steps }));
      await refuses("not_found", () => sims.run(owner, { commandId: cid("run"), scopeId, steps: [{ agent: "ann", service: "billing", resource: "nope", fields: { a: 1 } }] }));
      assert.deepEqual((await sims.get(owner, scopeId)).scope.runs, [r.id]);
      await sims.close(owner, { commandId: cid("c"), scopeId });
      await refuses("invalid_command", () => sims.run(owner, { commandId: cid("run"), scopeId, steps }), /closed/);
      assert.equal((await sims.getRun(owner, r.id)).run.outcome, "completed-with-problems");
      await refuses("not_found", () => sims.getRun(ann, r.id));
    } finally { await w.close(); }
  });

  test(`${backend.name}: with no stand-in provider left the run stops and the later steps are not reached; credit blocks a provider and a rate limit cools a route, as R02 decides (card P07)`, async () => {
    const { w, owner, sims, scope } = await world(backend);
    try {
      const scopeId = await scope();
      // Three routes; a rate limit twice on the first: the second answers both agents.
      const r1 = await sims.run(owner, { commandId: cid("run"), scopeId, providers: ["sim-a/m", "sim-b/m", "sim-c/m"], steps: [{ event: "provider-failure", failure: "rate-limit", times: 2 }, { agent: "ann", service: "billing", resource: "db", fields: { size: 1 } }, { agent: "bob", service: "billing", resource: "db", fields: { size: 2 } }] });
      assert.equal(r1.run.outcome, "completed");
      assert.deepEqual(r1.run.results.slice(1).map((x) => x.attempts!.map((a) => a.route)), [["sim-a/m", "sim-b/m"], ["sim-a/m", "sim-b/m"]]);
      // Credit on the first provider and an expired key on the second: none is left. The run stops; nothing was done on the stand-in.
      const db = await sims.observe(owner, { scopeId, service: "billing", resource: "db" });
      const r2 = await sims.run(owner, { commandId: cid("run"), scopeId, steps: [{ event: "provider-failure", failure: "credit" }, { event: "provider-failure", route: "sim-backup/model", failure: "auth" }, { agent: "ann", service: "billing", resource: "db", fields: { size: 99 } }, { agent: "bob", service: "shop", resource: "cart", fields: { replicas: 3 } }] });
      assert.equal(r2.run.outcome, "stopped");
      assert.deepEqual(r2.run.results.map((x) => x.outcome), ["armed", "armed", "stopped", "not-reached"]);
      assert.match(r2.run.results[2]!.words, /no answer from any stand-in provider/);
      assert.match(r2.run.results[2]!.words, /credit or authentication/);
      assert.equal(r2.run.results[2]!.tool, undefined, "no tool call was made");
      assert.deepEqual((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).systemVersion, db.systemVersion);
      assert.deepEqual((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).state, { replicas: 1 });
    } finally { await w.close(); }
  });

  test(`${backend.name}: real access is a separate owner step after a completed simulation, through the grant service; nothing else in a scope grants anything (card P07)`, async () => {
    const { w, owner, ann, sims, count, scope, project, grants } = await world(backend);
    try {
      const grants0 = await count("grant-record");
      const scopeId = await scope();
      const basis = "the simulation showed the resize works";
      await refuses("invalid_transition", () => sims.grant(owner, { commandId: cid("g"), scopeId, grantee: "agent:ann", basis }), /no run yet/);
      await sims.operate(owner, { commandId: cid("op"), scopeId, service: "billing", resource: "db", action: { type: "restart" } });
      const bad = await sims.run(owner, { commandId: cid("run"), scopeId, steps: [{ event: "competing-edit", service: "billing", resource: "cache", fields: { ttl: 5 } }, { agent: "ann", service: "billing", resource: "cache", fields: { ttl: 9 } }] });
      assert.equal(bad.run.outcome, "completed-with-problems");
      await refuses("invalid_transition", () => sims.grant(owner, { commandId: cid("g"), scopeId, grantee: "agent:ann", basis }), /completed-with-problems/);
      const good = await sims.run(owner, { commandId: cid("run"), scopeId, steps: [{ agent: "ann", service: "billing", resource: "db", fields: { size: 30 } }, { agent: "ann", service: "shop", resource: "cart", action: { type: "restart" } }] });
      assert.equal(good.run.outcome, "completed");
      // Opening, operating and running granted nothing.
      assert.equal(await count("grant-record"), grants0);
      await refuses("forbidden", () => sims.grant(ann, { commandId: cid("g"), scopeId, grantee: "agent:ann", basis }));
      await refuses("not_found", () => sims.grant(owner, { commandId: cid("g"), scopeId, grantee: "agent:ann", basis, runId: "smr-aaaaaaaaaaaaaaaaaaaa" }));
      const commandId = cid("g");
      const given = await sims.grant(owner, { commandId, scopeId, grantee: "agent:ann", basis });
      assert.equal(given.runId, good.id);
      assert.deepEqual(given.grants.map((g) => [g.action, g.project, g.resource]), [["effect.perform", project, "billing/db"], ["effect.perform", project, "shop/cart"]]);
      assert.equal(await count("grant-record"), grants0 + 2);
      for (const g of given.grants) {
        const rec = (await w.storage.getAggregate({ kind: "grant-record", id: g.id }))!.body as Record<string, unknown>;
        assert.deepEqual([rec["grantee"], rec["resource"], rec["basis"], rec["state"], rec["decidedBy"]], ["agent:ann", { kind: "service", id: g.resource }, basis, "active", owner.id]);
      }
      // Repeating grants once; the scope notes them; an earlier run that did not complete still grants nothing.
      const again = await sims.grant(owner, { commandId, scopeId, grantee: "agent:ann", basis });
      assert.deepEqual(again.grants.map((g) => g.id), given.grants.map((g) => g.id));
      assert.ok(again.grants.every((g) => g.replayed));
      assert.equal(await count("grant-record"), grants0 + 2);
      assert.deepEqual((await sims.get(owner, scopeId)).scope.grants!.map((g) => [g.grantee, g.resource, g.runId]), [["agent:ann", "billing/db", good.id], ["agent:ann", "shop/cart", good.id]]);
      await refuses("invalid_transition", () => sims.grant(owner, { commandId: cid("g"), scopeId, grantee: "agent:ann", basis, runId: bad.id }));
      // Without the grant service the step is unavailable (nothing else could grant).
      const bare = SimulationService.withEpoch(w.storage, (await ProjectService.open(w.storage, { holder: "c2", ...options })).epoch, { effects: EffectService.withEpoch(w.storage, 1, undefined, options) }, options);
      await refuses("unavailable", () => bare.grant(owner, { commandId: cid("g"), scopeId, grantee: "agent:ann", basis }));
      void grants;
      const listed = await sims.list(owner, {});
      assert.equal(listed.scopes[0]!.id, scopeId);
      assert.deepEqual(listed.scopes[0]!.runs.map((x) => x.id), [bad.id, good.id]);
      await refuses("not_found", () => sims.list(ann, {}));
    } finally { await w.close(); }
  });

  test(`${backend.name}: a run stopped part-way by a crash is finished by the start-up reconciler (a started effect of the scope) and by the repeated command, each step done once; a real bridge never settles it (card P07)`, async () => {
    const { w, projects, owner, sims, effects, scope } = await world(backend);
    try {
      const scopeId = await scope();
      const commandId = cid("run");
      const runId = derivedId("smr", scopedCommandId(owner.id, commandId));
      const toolId = derivedId("eff", `simrun:${runId}:s1:tool`);
      // A process that dies as it settles the second agent's tool call: the stand-in holds the change, the ledger does not know.
      const dying = new Proxy(w.storage, {
        get(target, name, receiver) {
          const value = Reflect.get(target, name, receiver) as unknown;
          if (typeof value !== "function") return value;
          if (name === "applyOperation") return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => { if (input.settleEffects.some((s) => s.effectId === toolId)) throw Object.assign(new Error("died"), { kind: "unavailable", name: "StorageError" }); return target.applyOperation(input); };
          return value.bind(target);
        },
      });
      const doomed = SimulationService.withEpoch(w.storage, projects.epoch, { effects: EffectService.withEpoch(dying, projects.epoch, undefined, { ...options, holder: "dies" }) }, options);
      const steps = [{ agent: "ann", service: "billing", resource: "db", fields: { size: 11 } }, { agent: "bob", service: "billing", resource: "cache", action: { type: "restart" } }, { agent: "cy", service: "shop", resource: "cart", fields: { replicas: 4 } }];
      await assert.rejects(doomed.run(owner, { commandId, scopeId, steps }));
      const stranded = (await effects.get(toolId))!;
      assert.equal(stranded.status, "intended");
      assert.equal(stranded.started, true);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "cache" })).state["restarts"], 1, "the stand-in holds the change");
      // A real bridge is refused and the effect is left as it is (it is not recorded as "nothing was done").
      let realCalls = 0;
      const real: EffectBridge = { idempotent: true, execute: async () => { realCalls++; return {}; }, reconcile: async () => { realCalls++; return { state: "applied" }; } };
      const later = Date.parse("2026-12-26T10:00:00.000Z");
      const fresh = await ProjectService.open(w.storage, { holder: "c9", clock: () => new Date(later).toISOString(), pause: async () => undefined });
      const lateOptions = { clock: () => new Date(later).toISOString(), pause: async () => undefined };
      const recovering = EffectService.withEpoch(w.storage, fresh.epoch, undefined, { ...lateOptions, holder: "recover" });
      await refuses("forbidden", () => recovering.run(toolId, real), /left for the scope to finish/);
      assert.equal(realCalls, 0);
      assert.equal((await effects.get(toolId))!.status, "intended");
      // The start-up reconciler without the scope's resolver leaves it unbridged; with it, it finishes it on the stand-in without doing it again.
      const assign = AssignmentService.withEpoch(w.storage, fresh.epoch, fresh, lateOptions);
      const deps = { projects: fresh, inbox: InboxService.withEpoch(w.storage, fresh.epoch, assign, lateOptions), effects: recovering, blockers: BlockerService.withEpoch(w.storage, fresh.epoch, lateOptions), destinations: [], bridges: { "service-op": real } };
      const plain = await new Reconciler(w.storage, fresh.epoch, deps, lateOptions).runPass();
      assert.equal(plain.effectsUnbridged, 1);
      assert.equal(realCalls, 0, "a real bridge registered for the kind is never offered an effect of a scope");
      const sims2 = SimulationService.withEpoch(w.storage, fresh.epoch, { effects: recovering }, lateOptions);
      const pass = await new Reconciler(w.storage, fresh.epoch, { ...deps, simulated: (id, body) => sims2.bridgeFor(id, body) }, lateOptions).runPass();
      assert.equal(pass.effectsRun, 1);
      const settled = (await effects.get(toolId))!;
      assert.equal(settled.status, "confirmed");
      assert.equal(settled.evidence?.["simulated"], true);
      // Review: it is settled by the scope's stand-in of the services, read back and verified, not by an answer that never looked at it.
      assert.equal(settled.evidence?.["verified"], true, JSON.stringify(settled.evidence));
      assert.equal(settled.evidence?.["target"], "billing/cache");
      assert.equal(settled.evidence?.["systemVersion"], (await sims.observe(owner, { scopeId, service: "billing", resource: "cache" })).systemVersion);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "cache" })).state["restarts"], 1, "not done twice");
      // The repeated command goes on from the step it had not recorded: the third agent runs, the first two are not done again.
      const done = await sims2.run(owner, { commandId, scopeId, steps });
      assert.equal(done.run.outcome, "completed");
      assert.deepEqual(done.run.results.map((x) => x.outcome), ["done", "done", "done"]);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "cache" })).state["restarts"], 1);
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).systemVersion, "v2", "the first agent's write once");
      assert.equal((await sims.observe(owner, { scopeId, service: "shop", resource: "cart" })).state["replicas"], 4);
      assert.equal(realCalls, 0);
    } finally { await w.close(); }
  });
}
