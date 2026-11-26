import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { EffectService } from "../domain/effects.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService } from "../security/index.js";
import { StatusService } from "../status/status.js";
import type { ControllerStorage } from "../storage/types.js";
import { SimulationService } from "./index.js";

// Card P07 (finish), second review: a run is never recorded `completed` (which the grant step rests on) after a crash at a step boundary; the owner's view puts the grants and the newest run first.

after(stopServer);

let now = Date.parse("2026-11-26T12:00:00.000Z");
const options = { clock: () => new Date((now += 1000)).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as Error).message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const LAYOUT = { billing: { db: { state: { size: 10 } }, api: { state: { mode: "on" } } } };

/** A storage that stops (as a process would) once, on the first write `stops` picks; every other call goes through. */
function stopping(inner: ControllerStorage, stops: (input: Parameters<ControllerStorage["applyOperation"]>[0]) => boolean): { storage: ControllerStorage; stopped: () => boolean } {
  let done = false;
  const storage = new Proxy(inner, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (name === "applyOperation") return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => { if (!done && stops(input)) { done = true; throw Object.assign(new Error("the process stopped"), { kind: "unavailable", name: "StorageError" }); } return target.applyOperation(input); };
      return (value as (...a: unknown[]) => unknown).bind(target);
    },
  });
  return { storage, stopped: () => done };
}

async function world(backend: (typeof backends)[number]) {
  const w = await backend.open();
  const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
  const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "A" })).id;
  const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
  const ann = (await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] })).id;
  const effects = EffectService.withEpoch(w.storage, projects.epoch, undefined, { ...options, holder: "simulation" });
  const grants = GrantService.withEpoch(w.storage, projects.epoch, options);
  const sims = SimulationService.withEpoch(w.storage, projects.epoch, { effects, grants }, options);
  return { w, projects, owner, task, ann, effects, grants, sims };
}

const grantCount = async (storage: ControllerStorage): Promise<number> => (await storage.listAggregates("grant-record", { limit: 200 })).length;

for (const backend of backends) {
  test(`${backend.name}: a crash after the competing edit and before the agent's tool call is recorded: the resend still judges the agent's write against what it read, so the edit is a conflict and nothing is granted (second review, card P07)`, async () => {
    const { w, projects, owner, task, ann, grants, sims } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      const steps = [{ event: "competing-edit", service: "billing", resource: "db", fields: { size: 99 } }, { agent: "ann", service: "billing", resource: "db", fields: { size: 20 } }];
      const commandId = cid("run");
      // The process stops on the write that records the agent's tool call (a service operation by ann), after the other writer's change was confirmed on the stand-in.
      const dying = stopping(w.storage, (input) => input.changes.some((c) => c.type === "create" && (c.body as { kind?: unknown; createdBy?: unknown }).kind === "service-op" && (c.body as { createdBy?: unknown }).createdBy === "simulation:ann"));
      const doomed = SimulationService.withEpoch(w.storage, projects.epoch, { effects: EffectService.withEpoch(dying.storage, projects.epoch, undefined, { ...options, holder: "simulation" }), grants }, options);
      await assert.rejects(doomed.run(owner, { commandId, scopeId, steps }));
      assert.ok(dying.stopped(), "the process stopped where the test meant it to");
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).state["size"], 99, "the other writer's change was made before the stop");
      const r = await sims.run(owner, { commandId, scopeId, steps });
      assert.deepEqual(r.run.results.map((x) => x.outcome), ["armed", "conflict"], JSON.stringify(r.run.results));
      assert.equal(r.run.outcome, "completed-with-problems");
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).state["size"], 99, "nothing was written over the other writer's change");
      const before = await grantCount(w.storage);
      await refuses("invalid_transition", () => sims.grant(owner, { commandId: cid("g"), scopeId, grantee: ann, basis: "the simulation went well" }));
      assert.equal(await grantCount(w.storage), before);
    } finally { await w.close(); }
  });

  test(`${backend.name}: a crash after a step stopped the run and before the later steps were recorded not reached: the resend runs none of them, the run ends stopped and nothing is granted (second review, card P07)`, async () => {
    const { w, projects, owner, task, ann, grants, sims } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      const steps = [
        { event: "provider-failure", failure: "credit", route: "sim-primary/model" }, { event: "provider-failure", failure: "auth", route: "sim-backup/model" },
        { agent: "ann", service: "billing", resource: "db", fields: { size: 20 } }, { agent: "bea", service: "billing", resource: "db", fields: { size: 30 } }, { agent: "cy", service: "billing", resource: "api", fields: { mode: "off" } },
      ];
      const commandId = cid("run");
      const dying = stopping(w.storage, (input) => input.audit.some((a) => a.type === "simulation.run.step" && JSON.stringify(a.detail ?? {}).includes("\"index\":3")));
      const doomed = SimulationService.withEpoch(dying.storage, projects.epoch, { effects: EffectService.withEpoch(w.storage, projects.epoch, undefined, { ...options, holder: "simulation" }), grants }, options);
      await assert.rejects(doomed.run(owner, { commandId, scopeId, steps }));
      assert.ok(dying.stopped());
      const r = await sims.run(owner, { commandId, scopeId, steps });
      assert.deepEqual(r.run.results.map((x) => x.outcome), ["armed", "armed", "stopped", "not-reached", "not-reached"], JSON.stringify(r.run.results));
      assert.equal(r.run.outcome, "stopped");
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "db" })).state["size"], 10, "no later agent changed anything");
      assert.equal((await sims.observe(owner, { scopeId, service: "billing", resource: "api" })).state["mode"], "on");
      const before = await grantCount(w.storage);
      await refuses("invalid_transition", () => sims.grant(owner, { commandId: cid("g"), scopeId, grantee: ann, basis: "the simulation went well" }), /stopped/);
      assert.equal(await grantCount(w.storage), before);
    } finally { await w.close(); }
  });

  test(`${backend.name}: the owner's view of a scope puts the real access granted and the newest run first, with the newest run's steps; earlier runs are one line each (second review, card P07)`, async () => {
    const { w, projects, owner, task, ann, sims } = await world(backend);
    try {
      const scopeId = (await sims.open(owner, { commandId: cid("o"), taskId: task, layout: LAYOUT })).id;
      const old = await sims.run(owner, { commandId: cid("run"), scopeId, steps: Array.from({ length: 12 }, (_, i) => ({ agent: "ann", service: "billing", resource: "db", fields: { size: i } })) });
      const newest = await sims.run(owner, { commandId: cid("run"), scopeId, steps: [{ event: "provider-failure", route: "sim-primary/model" }, { agent: "bea", service: "billing", resource: "api", fields: { mode: "off" } }] });
      await sims.grant(owner, { commandId: cid("g"), scopeId, grantee: ann, basis: "the simulation went well", runId: newest.id });
      const status = StatusService.withEpoch(w.storage, projects.epoch, { simulations: sims } as never, options);
      const lines = (await status.ask(owner, { kind: "simulations", taskId: task }))!.lines.map((l) => l.text);
      // The chat shows the first 30 lines of a view: what matters most is within them.
      const first = lines.slice(0, 30).join("\n");
      assert.match(first, /Real access you granted after run/);
      assert.match(first, new RegExp(`Newest run ${newest.id} completed`));
      assert.match(first, /the fallback sim-backup\/model answered/);
      assert.match(first, new RegExp(`Earlier run ${old.id} completed`));
      assert.ok(lines.findIndex((l) => l.includes("Real access you granted")) < lines.findIndex((l) => l.startsWith(`Newest run ${newest.id}`)), lines.join("\n"));
      assert.equal(lines.filter((l) => /^ {2}Step /.test(l)).length, 2, "only the newest run's steps are listed");
    } finally { await w.close(); }
  });
}

test("the list of scopes takes a whole number from 1 to 20 (second review, card P07)", async () => {
  const { w, owner, sims } = await world(backends[0]!);
  try {
    for (const limit of ["10", 0, 21, 2.5]) await refuses("invalid_command", () => sims.list(owner, { limit } as never), /limit/);
    assert.deepEqual((await sims.list(owner, { limit: 20 })).scopes, []);
  } finally { await w.close(); }
});
