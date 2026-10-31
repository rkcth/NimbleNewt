import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { BudgetService, type AggregateNotice } from "./index.js";

after(stopServer);

const pause = async () => undefined;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  interface Ctx { owner: Principal; host: Principal; svc: BudgetService; at(now: string): BudgetService; notices: AggregateNotice[]; a: string; b: string; t1: string; t2: string; tb: string; reserve(svc: BudgetService, task: string, cost: number, agent?: string): Promise<{ id: string }> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", clock: () => "2026-10-22T21:00:00.000Z", pause });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, { clock: () => "2026-10-22T21:00:00.000Z", pause });
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
        const host = await principals.authenticate((await principals.issueCredential(owner, "host:h1")).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const mk = async (p: string) => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "t" })).id;
        const [t1, t2, tb] = [await mk(a), await mk(a), await mk(b)];
        const notices: AggregateNotice[] = [];
        const at = (now: string) => BudgetService.withEpoch(world.storage, projects.epoch, { clock: () => now, pause, notifyAggregate: async (x) => { notices.push(x); } });
        const reserve = (svc: BudgetService, task: string, cost: number, agent = "agent:ben") => svc.reserve(host, { commandId: cid("r"), taskId: task, costMicros: cost, agentId: agent, purpose: "a call" });
        await body({ owner, host, svc: at("2026-10-22T21:00:00.000Z"), at, notices, a, b, t1, t2, tb, reserve });
      } finally { await world.close(); }
    });
  const open = (c: Ctx, task: string, cost = 1000) => c.svc.open(c.owner, { commandId: cid("o"), taskId: task, currency: "USD", costMicros: cost, computeMs: 0 });
  const cap = (c: Ctx, f: Record<string, unknown>, svc = c.svc) => svc.setAggregate(c.owner, { commandId: cid("g"), ...f } as never);

  suite("unset: no cap, no effect; a cap set then turned off lets everything through again, and the figures are kept", async (c) => {
    await open(c, c.t1, 1000000);
    assert.deepEqual(await c.svc.aggregate(c.owner), { revision: 0, enabled: false });
    await c.reserve(c.svc, c.t1, 99000);
    await c.svc.release(c.host, { commandId: cid("x"), reservationId: (await c.reserve(c.svc, c.t1, 500)).id });
    const set = await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100000 });
    assert.equal(set.revision, 1);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 2000), /aggregate cap is reached/);
    await cap(c, { enabled: false });
    assert.deepEqual(await c.svc.aggregate(c.owner), { revision: 2, enabled: false, scope: "installation", period: "none", amountMicros: 100000 });
    await c.reserve(c.svc, c.t1, 1100);
    await cap(c, { enabled: true });
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /aggregate cap/);
  });

  suite("set: money held by reservations and spent in the ledger counts across trees, a refusal says why and tells the owner once", async (c) => {
    await open(c, c.t1); await open(c, c.tb);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    const r1 = await c.reserve(c.svc, c.t1, 60);
    await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 41), /used 60 of 100 millionths/);
    await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 41), /aggregate cap/);
    assert.equal(c.notices.length, 1, "the owner is told once for the same cap and window");
    assert.match(c.notices[0]!.text, /aggregate cap/);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r1.id, costMicros: 70 });
    await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 31), /used 70 of 100/);
    await c.reserve(c.svc, c.tb, 30);
    await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 1));
    assert.equal(c.notices.length, 1, "the same window and setting: still once");
    await cap(c, { amountMicros: 150 });
    await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 51));
    assert.equal(c.notices.length, 2, "a changed setting is told again");
    await c.reserve(c.svc, c.tb, 50);
    // A compute-only reservation is never a money matter.
    await c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.t1, computeMs: 0, costMicros: 0 } as never).then(() => assert.fail("empty reservation must be refused"), () => undefined);
  });

  suite("scope project and agent: the amount applies to each, and an unattributed call is its own bucket", async (c) => {
    await open(c, c.t1); await open(c, c.tb);
    await cap(c, { enabled: true, scope: "project", period: "none", amountMicros: 100 });
    await c.reserve(c.svc, c.t1, 100);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /project proj-/);
    await c.reserve(c.svc, c.tb, 100);
    await cap(c, { scope: "agent" });
    await c.reserve(c.svc, c.tb, 0 + 1, "agent:ann").then(() => assert.fail("agent:ann starts at 0 but project B holds ben's 100"), () => undefined).catch(() => undefined);
    await cap(c, { amountMicros: 150 });
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 51, "agent:ben"), /agent agent:ben has used 200 of 150/);
    await c.reserve(c.svc, c.t1, 100, "agent:ann");
    await refuses("invalid_command", () => c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.t1, costMicros: 151, purpose: "no agent" }), /agent unattributed has used 0 of 150/);
    await c.svc.reserve(c.host, { commandId: cid("r"), taskId: c.t1, costMicros: 150, purpose: "no agent" });
  });

  suite("period: a day or month cap counts only the entries of the current UTC day or month", async (c) => {
    await open(c, c.t1, 10000);
    const yesterday = c.at("2026-10-21T10:00:00.000Z");
    const r = await c.reserve(yesterday, c.t1, 100);
    await yesterday.settle(c.host, { commandId: cid("s"), reservationId: r.id, costMicros: 100 });
    await cap(c, { enabled: true, scope: "installation", period: "day", amountMicros: 100 });
    await c.reserve(c.svc, c.t1, 100);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /this day/);
    const nextMonth = c.at("2026-11-02T10:00:00.000Z");
    await c.svc.aggregate(c.owner);
    await cap(c, { period: "month", amountMicros: 150 });
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 51), /this month/);
    await cap(c, { period: "none" });
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 51), /used 200 of 150/);
    await cap(c, { period: "month" });
    await c.reserve(nextMonth, c.t1, 50);
  });

  suite("setting rules: owner only, needs scope, period and amount to turn on, validated, optional expectedRevision", async (c) => {
    await refuses("forbidden", () => c.svc.setAggregate(c.host, { commandId: cid("g"), enabled: false } as never));
    await refuses("forbidden", () => c.svc.aggregate(c.host));
    await refuses("invalid_command", () => cap(c, { enabled: true, scope: "installation" }), /needs a scope/);
    for (const bad of [{}, { scope: "team" }, { period: "week" }, { amountMicros: -1 }, { amountMicros: 1.5 }, { enabled: "yes" }, { extra: 1 }]) await refuses("invalid_command", () => cap(c, bad), undefined);
    await cap(c, { enabled: true, scope: "agent", period: "month", amountMicros: 0 });
    await refuses("stale_revision", () => cap(c, { amountMicros: 5, expectedRevision: 0 }));
    await cap(c, { amountMicros: 5, expectedRevision: 1 });
    assert.equal((await c.svc.aggregate(c.owner)).amountMicros, 5);
  });

  suite("close: owner only, only the root, refused while calls hold allowance, then nothing more can be reserved or added; closing again changes nothing; closed trees do not count against the cap", async (c) => {
    await open(c, c.t1);
    await c.svc.delegate(c.owner, { commandId: cid("d"), parentTaskId: c.t1, childTaskId: c.t2, costMicros: 10 });
    await refuses("invalid_command", () => c.svc.close(c.owner, { commandId: cid("c"), taskId: c.t2 }), /larger budget/);
    await refuses("forbidden", () => c.svc.close(c.host, { commandId: cid("c"), taskId: c.t1 }));
    await refuses("not_found", () => c.svc.close(c.owner, { commandId: cid("c"), taskId: c.tb }));
    const held = await c.reserve(c.svc, c.t1, 100);
    await refuses("invalid_command", () => c.svc.close(c.owner, { commandId: cid("c"), taskId: c.t1 }), /still holding/);
    await c.svc.release(c.host, { commandId: cid("x"), reservationId: held.id });
    const id = cid("c");
    await c.svc.close(c.owner, { commandId: id, taskId: c.t1 });
    await c.svc.close(c.owner, { commandId: id, taskId: c.t1 });
    await c.svc.close(c.owner, { commandId: cid("c"), taskId: c.t1 });
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /closed/);
    await refuses("invalid_command", () => c.svc.raise(c.owner, { commandId: cid("r"), taskId: c.t1, costMicros: 5 }), /closed/);
    await refuses("invalid_command", () => c.svc.requestMore(c.owner, { commandId: cid("q"), taskId: c.t2, costMicros: 5, reason: "more" }).catch((e) => { throw e; }), undefined);
    await refuses("invalid_command", () => c.svc.delegate(c.owner, { commandId: cid("d"), parentTaskId: c.t1, childTaskId: c.tb, costMicros: 1 }));
  });
}
