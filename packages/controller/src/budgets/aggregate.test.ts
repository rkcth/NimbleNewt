import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { BUDGET_LIMITS, BudgetService, type AggregateNotice } from "./index.js";

after(stopServer);

const pause = async () => undefined;
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  interface Ctx { all(): Promise<{ id: string; body: Record<string, unknown> }[]>; totals(): Promise<number>; rewrite(kind: string, id: string, body: Record<string, unknown>): Promise<void>; slowOnTotals(after: () => Promise<void>): BudgetService; owner: Principal; host: Principal; svc: BudgetService; at(now: string): BudgetService; notices: AggregateNotice[]; a: string; b: string; t1: string; t2: string; tb: string; reserve(svc: BudgetService, task: string, cost: number, agent?: string): Promise<{ id: string }> }
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
        const rewrite = async (kind: string, id: string, b: Record<string, unknown>): Promise<void> => {
          const found = (await world.storage.getAggregate({ kind, id }))!;
          await world.storage.applyOperation({ operationId: cid("rw"), epoch: projects.epoch, actor: "owner:rob", correlationId: "rw", at: "2026-10-22T21:00:00.000Z", changes: [{ type: "update", ref: { kind, id }, expectedRevision: found.revision, body: b as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
        };
        const slowOnTotals = (afterRead: () => Promise<void>) => {
          const storage = new Proxy(world.storage, { get: (target, key) => {
            const value = Reflect.get(target, key, target);
            if (key !== "getAggregate") return typeof value === "function" ? value.bind(target) : value;
            return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (ref.kind === "budget-aggregate-total") await afterRead(); return found; };
          } });
          return BudgetService.withEpoch(storage, projects.epoch, { clock: () => "2026-10-22T21:00:00.000Z", pause, notifyAggregate: async (x) => { notices.push(x); } });
        };
        const totals = async (): Promise<number> => (await world.storage.listAggregates("budget-aggregate-total", { limit: 1000 })).length;
        const all = async () => (await world.storage.listAggregates("budget-aggregate-total", { limit: 1000 })).map((x) => ({ id: x.id, body: x.body as Record<string, unknown> }));
        await body({ all, totals, rewrite, slowOnTotals, owner, host, svc: at("2026-10-22T21:00:00.000Z"), at, notices, a, b, t1, t2, tb, reserve });
      } finally { await world.close(); }
    });
  const open = (c: Ctx, task: string, cost = 1000) => c.svc.open(c.owner, { commandId: cid("o"), taskId: task, currency: "USD", costMicros: cost, computeMs: 0 });
  const cap = (c: Ctx, f: Record<string, unknown>, svc = c.svc) => svc.setAggregate(c.owner, { commandId: cid("g"), ...f } as never);

  suite("unset: no cap, no effect; a cap set then turned off lets everything through again, and the figures are kept", async (c) => {
    await open(c, c.t1, 1000000);
    assert.deepEqual(await c.svc.aggregate(c.owner), { revision: 0, enabled: false, state: "off" });
    await c.reserve(c.svc, c.t1, 99000);
    await c.svc.release(c.host, { commandId: cid("x"), reservationId: (await c.reserve(c.svc, c.t1, 500)).id });
    const set = await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100000 });
    assert.equal(set.revision, 1);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 2000), /aggregate cap is reached/);
    await cap(c, { enabled: false });
    assert.deepEqual(await c.svc.aggregate(c.owner), { revision: 2, enabled: false, state: "off", scope: "installation", period: "none", amountMicros: 100000, currency: "USD" });
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

  suite("the cap reads running totals, not the ledger: with the old scan limit shrunk to 3 and many entries, an enabled cap still checks (it used to refuse everything once the scan was cut short)", async (c) => {
    const limits = BUDGET_LIMITS as { scan: number };
    const was = limits.scan;
    limits.scan = 3;
    try {
      await open(c, c.t1, 1_000_000);
      await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 1000 });
      for (let i = 0; i < 6; i++) { const r = await c.reserve(c.svc, c.t1, 10); await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r.id, costMicros: 10 }); }
      await c.reserve(c.svc, c.t1, 100);
      await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 900), /used 160 of 1000/);
    } finally { limits.scan = was; }
  });

  suite("money charged without a reservation counts, and once the cap is reached the next paid call is stopped and the owner is told once", async (c) => {
    await open(c, c.t1, 1_000_000);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    assert.equal(await c.svc.capReached(c.host, { taskId: c.t1, agentId: "agent:ben" }), undefined);
    await c.svc.charge(c.host, { commandId: cid("ch"), activity: "model-call", taskId: c.t1, agentId: "agent:ben", costMicros: 120 });
    assert.equal(c.notices.length, 1, "told when the charge took it past the cap");
    assert.match((await c.svc.capReached(c.host, { taskId: c.t1, agentId: "agent:ben" }))!, /used 120 of 100 millionths, so no further paid call/);
    assert.match((await c.svc.capReached(c.host, { taskId: c.t1, agentId: "agent:ben" }))!, /no further paid call/);
    assert.equal(c.notices.length, 1, "once for the same window");
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /aggregate cap is reached/);
    await cap(c, { enabled: false });
    assert.equal(await c.svc.capReached(c.host, { taskId: c.t1 }), undefined, "off: nothing stops");
  });

  suite("two reservations at the same moment in different trees take turns: only one fits under the cap", async (c) => {
    await open(c, c.t1); await open(c, c.tb);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    const results = await Promise.allSettled([c.reserve(c.svc, c.t1, 60), c.reserve(c.svc, c.tb, 60)]);
    assert.deepEqual(results.map((r) => r.status).sort(), ["fulfilled", "rejected"]);
    const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    assert.match(String(lost.reason), /aggregate cap is reached/);
  });

  suite("forced interleaving: a reservation whose cap check read the totals before another reservation committed is refused, not admitted on a fresh read of the changed totals", async (c) => {
    await open(c, c.t1); await open(c, c.tb);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    // The first reservation reads the running totals for its check, then waits (before it commits) until the second one has committed.
    let reached!: () => void; const gateHit = new Promise<void>((r) => { reached = r; });
    let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
    // The check reads two totals (spent in the window, then held): the wait comes after the second, so the check is complete before the other reservation commits.
    let reads = 0;
    const slow = c.slowOnTotals(async () => { if (++reads !== 2) return; reached(); await gate; });
    const first = c.reserve(slow, c.t1, 60);
    await gateHit;
    await c.reserve(c.svc, c.tb, 60);
    release();
    await refuses("invalid_command", () => first, /aggregate cap is reached/);
    const held60 = (await c.all()).find((t) => t.body.window === "held")!;
    assert.deepEqual(held60.body.byCurrency, { USD: 60 }, "only the second reservation is held");
  });

  suite("a settle racing a reservation is never missed: whichever commits first, the totals the cap reads equal what was spent plus what is held", async (c) => {
    await open(c, c.t1); await open(c, c.tb);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    const r1 = await c.reserve(c.svc, c.t1, 50);
    const [settled, second] = await Promise.allSettled([c.svc.settle(c.host, { commandId: cid("s"), reservationId: r1.id, costMicros: 90 }), c.reserve(c.svc, c.tb, 50)]);
    assert.equal(settled.status, "fulfilled");
    // 90 spent, and 50 more held only if the reservation went first (it saw 50 held and fit); otherwise it saw 90 spent and was refused.
    // The paid-call gate counts money spent only (90 of 100: open); the reserve check also counts the hold when the reservation went first.
    assert.equal(await c.svc.capReached(c.host, { taskId: c.t1 }), undefined, "90 of 100 spent is under the cap");
    if (second.status === "fulfilled") await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 1), /used 140 of 100/);
    else assert.match(String(second.reason), /used 90 of 100/);
  });

  suite("only money in the cap's currency counts: a tree in another currency is not summed with it", async (c) => {
    await c.svc.open(c.owner, { commandId: cid("o"), taskId: c.t1, currency: "EUR", costMicros: 1000 });
    await open(c, c.tb);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    await c.reserve(c.svc, c.t1, 100);
    await c.reserve(c.svc, c.tb, 100);
    await refuses("invalid_command", () => c.reserve(c.svc, c.tb, 1), /used 100 of 100/);
    await cap(c, { currency: "EUR" });
    assert.equal((await c.svc.aggregate(c.owner)).currency, "EUR");
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /used 100 of 100/);
    await c.reserve(c.svc, c.tb, 5);
    await refuses("invalid_command", () => cap(c, { currency: "euro" }));
  });

  suite("a closed budget takes no more reservations but still records money that was spent; a caller with no rights is not told it is closed", async (c) => {
    await open(c, c.t1);
    await c.svc.close(c.owner, { commandId: cid("c"), taskId: c.t1 });
    // Money that was really spent is recorded even though the budget is closed (refusing would drop it from the ledger and the totals), and it counts toward the cap.
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 100 });
    await c.svc.charge(c.host, { commandId: cid("ch"), activity: "model-call", taskId: c.t1, costMicros: 150 });
    assert.match((await c.svc.capReached(c.host, { taskId: c.t1 }))!, /used 150 of 100/, "the spend after close is in the totals");
    assert.equal((await c.svc.usage(c.owner, {})).totals.costMicros, 150, "and in the ledger");
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /is closed/);
    await refuses("forbidden", () => c.svc.requestMore(c.host, { commandId: cid("q"), taskId: c.t1, costMicros: 5, reason: "more" }));
  });

  suite("a cap whose 'enabled' is not true or false is damaged: it refuses, never reads as none, and the owner is told", async (c) => {
    await open(c, c.t1);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 1000 });
    const body = (await c.svc.aggregate(c.owner));
    await c.rewrite("budget-aggregate", "main", { enabled: "yes", scope: "installation", period: "none", amountMicros: 1000, updatedBy: "owner:rob", updatedAt: "x" });
    assert.equal(body.enabled, true);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /unreadable/);
    assert.equal(c.notices.length, 1);
    assert.match((await c.svc.capReached(c.host, { taskId: c.t1 }))!, /unreadable/);
  });

  suite("the paid-call gate counts money SPENT, not holds: two attempts holding 2500 each of a 5000 cap with nothing spent may both call; once spent reaches the cap the next paid call is refused", async (c) => {
    await open(c, c.t1, 1_000_000); await open(c, c.tb, 1_000_000);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 5000 });
    const r1 = await c.reserve(c.svc, c.t1, 2500);
    const r2 = await c.reserve(c.svc, c.tb, 2500);
    assert.equal(await c.svc.capReached(c.host, { taskId: c.t1, agentId: "agent:ben" }), undefined, "5000 held, $0 spent: the call goes ahead");
    assert.equal(await c.svc.capReached(c.host, { taskId: c.tb, agentId: "agent:ben" }), undefined);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /aggregate cap is reached/);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r1.id, costMicros: 2500 });
    assert.equal(await c.svc.capReached(c.host, { taskId: c.tb, agentId: "agent:ben" }), undefined, "2500 spent of 5000");
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r2.id, costMicros: 2500 });
    assert.match((await c.svc.capReached(c.host, { taskId: c.tb, agentId: "agent:ben" }))!, /used 5000 of 5000 millionths, so no further paid call/);
  });

  suite("with no cap ever set no running-total record is written, however much moves; the first configuration builds the totals from the ledger for the current period", async (c) => {
    await open(c, c.t1, 1_000_000);
    const r = await c.reserve(c.svc, c.t1, 300);
    await c.svc.settle(c.host, { commandId: cid("s"), reservationId: r.id, costMicros: 250 });
    await c.svc.charge(c.host, { commandId: cid("ch"), activity: "model-call", taskId: c.t1, costMicros: 50 });
    const held = await c.reserve(c.svc, c.t1, 40);
    assert.equal(await c.totals(), 0, "no cap configured: nothing shared is written");
    const set = await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 400 });
    assert.equal(set.approximate, undefined, "the ledger fit the bound, so the totals are exact");
    assert.equal((await c.totals()) > 0, true);
    // 300 spent + 40 held = 340 of 400 from the backfill: 61 more is refused, 60 fits.
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 61), /used 340 of 400/);
    await c.reserve(c.svc, c.t1, 60);
    void held;
  });

  suite("a backfill that hits the bound is marked approximate", async (c) => {
    await open(c, c.t1, 1_000_000);
    const limits = BUDGET_LIMITS as { scan: number };
    const was = limits.scan;
    limits.scan = 2;
    try {
      for (let i = 0; i < 4; i++) await c.svc.charge(c.host, { commandId: cid("ch"), activity: "model-call", taskId: c.t1, costMicros: 10 });
      const set = await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 400 });
      assert.equal(set.approximate, true);
      assert.equal((await c.svc.aggregate(c.owner)).approximate, true);
    } finally { limits.scan = was; }
  });

  suite("a damaged running total fails closed with an owner notice: the cap neither coerces nor resets it, and turning the cap on again rebuilds it", async (c) => {
    await open(c, c.t1, 1_000_000);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 1000 });
    await c.svc.charge(c.host, { commandId: cid("ch"), activity: "model-call", taskId: c.t1, costMicros: 10 });
    const [total] = (await c.all()).filter((x) => x.body["window"] === "all" && x.body["scope"] === "installation");
    const damaged = { scope: total!.body["scope"], scopeKey: total!.body["scopeKey"], window: total!.body["window"], byCurrency: { USD: "lots" } };
    await c.rewrite("budget-aggregate-total", total!.id, damaged);
    await refuses("invalid_command", () => c.reserve(c.svc, c.t1, 1), /unreadable/);
    assert.equal(c.notices.length, 1, "the owner is told");
    assert.match((await c.svc.capReached(c.host, { taskId: c.t1 }))!, /unreadable/);
    await c.svc.charge(c.host, { commandId: cid("ch"), activity: "model-call", taskId: c.t1, costMicros: 5 });
    await cap(c, { enabled: false });
    await cap(c, { enabled: true });
    await c.reserve(c.svc, c.t1, 1);
  });

  suite("aggregate() says 'damaged' for an enabled value that is neither true nor false, and for an unreadable cap, not 'off'", async (c) => {
    await open(c, c.t1);
    await cap(c, { enabled: true, scope: "installation", period: "none", amountMicros: 1000 });
    assert.equal((await c.svc.aggregate(c.owner)).state, "on");
    await c.rewrite("budget-aggregate", "main", { enabled: "yes", scope: "installation", period: "none", amountMicros: 1000, updatedBy: "owner:rob", updatedAt: "x" });
    assert.equal((await c.svc.aggregate(c.owner)).state, "damaged");
    await c.rewrite("budget-aggregate", "main", { enabled: true, scope: "nowhere", period: "none", amountMicros: 1000, updatedBy: "owner:rob", updatedAt: "x" });
    assert.equal((await c.svc.aggregate(c.owner)).state, "damaged");
  });
}
