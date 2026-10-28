import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ProjectService } from "../domain/service.js";
import { CHARGE_RETRY_LIMITS, ChargeRetryService, type ChargeRequest } from "./retry.js";

after(stopServer);

for (const backend of backends) {
  const suite = (name: string, body: (c: { retry: ChargeRetryService; dispatcher: Principal; owner: Principal; calls: ChargeRequest[]; fail: { mode: "ok" | "down" | "wrong" }; clock: { now: number }; dropped: string[]; index: () => Promise<string[]> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const clock = { now: Date.parse("2026-10-27T10:00:00.000Z") };
        const options = { clock: () => new Date(clock.now).toISOString(), pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const dispatcher = owner; // the service only passes the principal on to the budget service
        const calls: ChargeRequest[] = [];
        const fail = { mode: "ok" as "ok" | "down" | "wrong" };
        const booked = new Set<string>();
        const budgets = { charge: async (_by: Principal, charge: ChargeRequest) => {
          calls.push(charge);
          if (fail.mode === "down") throw new DomainError("unavailable", "the ledger is down");
          if (fail.mode === "wrong") throw new DomainError("invalid_command", "taskId: no such task", { field: "taskId" });
          booked.add(charge.commandId);
          return { id: `e-${charge.commandId}`, replayed: false } as never;
        } };
        const dropped: string[] = [];
        const retry = ChargeRetryService.withEpoch(world.storage, projects.epoch, { budgets }, { ...options, onDropped: (e) => dropped.push(`${e.commandId}: ${e.reason}`) });
        const index = async (): Promise<string[]> => ((await world.storage.getAggregate({ kind: "charge-retry-index", id: "pending" }))?.body as { ids?: string[] } | undefined)?.ids ?? [];
        await body({ retry, dispatcher, owner, calls, fail, clock, dropped, index });
      } finally { await world.close(); }
    });

  const charge = (id: string): ChargeRequest => ({ commandId: id, activity: "review", taskId: "task-aaaaaaaaaaaaaaaaaaaa", computeMs: 1000 });

  suite("a charge that books at once is not kept (card R05g)", async (c) => {
    assert.deepEqual(await c.retry.submit(c.dispatcher, charge("ok-1")), { booked: true });
    assert.deepEqual(await c.retry.unsettled(c.owner), []);
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 0 });
  });

  suite("a charge the ledger cannot take is kept, tried again when due with a doubling delay, and booked once when the ledger is back (card R05g)", async (c) => {
    c.fail.mode = "down";
    assert.deepEqual(await c.retry.submit(c.dispatcher, charge("review-use:rev-1")), { booked: false });
    assert.deepEqual(await c.retry.submit(c.dispatcher, charge("review-use:rev-1")), { booked: false }, "the same charge failing again is not kept twice");
    const kept = await c.retry.unsettled(c.owner);
    assert.equal(kept.length, 1);
    assert.deepEqual([kept[0]!.body.state, kept[0]!.body.attempts], ["pending", 1]);
    // Not due yet: nothing is tried.
    const before = c.calls.length;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 0 });
    assert.equal(c.calls.length, before);
    // Due, ledger still down: tried, kept, and the next delay is longer.
    c.clock.now += CHARGE_RETRY_LIMITS.baseMs + 1;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 1, dropped: 0 });
    const second = (await c.retry.unsettled(c.owner))[0]!.body;
    assert.equal(second.attempts, 2);
    assert.equal(Date.parse(second.nextAt) - c.clock.now, CHARGE_RETRY_LIMITS.baseMs * 2, "the delay doubled");
    c.clock.now += CHARGE_RETRY_LIMITS.baseMs;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 0 }, "still not due");
    // The ledger returns: the next due try books it, with the original command ID so the ledger counts it once.
    c.fail.mode = "ok";
    c.clock.now += CHARGE_RETRY_LIMITS.baseMs * 2;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 1, later: 0, dropped: 0 });
    assert.equal(c.calls.at(-1)!.commandId, "review-use:rev-1");
    assert.deepEqual(await c.retry.unsettled(c.owner), []);
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 0 }, "a booked charge is not tried again");
  });

  suite("charges that fail together are all kept, and the index of waiting charges shrinks as they book or are given up (card R05g)", async (c) => {
    c.fail.mode = "down";
    const ids = Array.from({ length: 10 }, (_, i) => `meet-${i}`);
    await Promise.all(ids.map((id) => c.retry.submit(c.dispatcher, charge(id))));
    assert.deepEqual(c.dropped, [], "none was lost to the race for the index");
    assert.equal((await c.retry.unsettled(c.owner)).length, 10);
    assert.equal((await c.index()).length, 10);
    c.fail.mode = "ok";
    c.clock.now += CHARGE_RETRY_LIMITS.baseMs + 1;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 10, later: 0, dropped: 0 });
    assert.deepEqual(await c.index(), [], "booked charges leave the index");
    c.fail.mode = "wrong";
    c.fail.mode = "down";
    await c.retry.submit(c.dispatcher, charge("last"));
    assert.equal((await c.index()).length, 1);
    c.fail.mode = "wrong";
    c.clock.now += CHARGE_RETRY_LIMITS.baseMs + 1;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 1 });
    assert.deepEqual(await c.index(), [], "a charge given up on leaves it too");
  });

  suite("the delay stops growing at an hour and a charge that never books is given up on after twenty tries, and reported (card R05g)", async (c) => {
    c.fail.mode = "down";
    await c.retry.submit(c.dispatcher, charge("job-use:j-1"));
    let last = { booked: 0, later: 0, dropped: 0 };
    for (let i = 0; i < CHARGE_RETRY_LIMITS.attempts + 2 && last.dropped === 0; i++) {
      c.clock.now += CHARGE_RETRY_LIMITS.maxMs + 1;
      last = await c.retry.sweep(c.dispatcher);
      const rest = await c.retry.unsettled(c.owner);
      if (rest[0]?.body.state === "pending") assert.ok(Date.parse(rest[0].body.nextAt) - c.clock.now <= CHARGE_RETRY_LIMITS.maxMs);
    }
    assert.equal(last.dropped, 1);
    const [gone] = await c.retry.unsettled(c.owner);
    assert.equal(gone!.body.state, "dropped");
    assert.equal(gone!.body.attempts, CHARGE_RETRY_LIMITS.attempts - 1);
    assert.match(c.dropped[0]!, /job-use:j-1: .*ledger is down/);
    c.fail.mode = "ok";
    c.clock.now += CHARGE_RETRY_LIMITS.maxMs + 1;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 0 }, "a charge given up on is not tried again");
  });

  suite("a charge that is wrong in itself is not kept: the error reaches the caller as before (card R05g)", async (c) => {
    c.fail.mode = "wrong";
    await assert.rejects(() => c.retry.submit(c.dispatcher, charge("bad-1")), (e: unknown) => e instanceof DomainError && e.code === "invalid_command");
    assert.deepEqual(await c.retry.unsettled(c.owner), []);
    // One kept for a passing reason that turns out wrong when tried again is given up on at once.
    c.fail.mode = "down";
    await c.retry.submit(c.dispatcher, charge("bad-2"));
    c.fail.mode = "wrong";
    c.clock.now += CHARGE_RETRY_LIMITS.baseMs + 1;
    assert.deepEqual(await c.retry.sweep(c.dispatcher), { booked: 0, later: 0, dropped: 1 });
    assert.match(c.dropped[0]!, /bad-2: .*no such task/);
  });

  suite("only the owner and the dispatcher see the unsettled charges, and a charge that cannot even be kept is reported (card R05g)", async (c) => {
    c.fail.mode = "down";
    await c.retry.submit(c.dispatcher, charge("keep-1"));
    const other = { ...c.owner, id: "agent:ann", kind: "agent" } as Principal;
    assert.deepEqual(await c.retry.unsettled(other), []);
    assert.equal((await c.retry.unsettled(c.owner)).length, 1);
  });
}

test("a hundred failed charges are retried in bounded sweeps and each books once (card R05g)", async () => {
  const backend = backends[0]!;
  const world = await backend.open();
  try {
    let now = Date.parse("2026-10-27T10:00:00.000Z");
    const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    let up = false; const booked = new Map<string, number>();
    const retry = ChargeRetryService.withEpoch(world.storage, projects.epoch, { budgets: { charge: async (_b: Principal, ch: ChargeRequest) => { if (!up) throw new DomainError("unavailable", "down"); booked.set(ch.commandId, (booked.get(ch.commandId) ?? 0) + 1); return {} as never; } } }, options);
    for (let i = 0; i < 100; i++) await retry.submit(owner, { commandId: `c-${i}`, activity: "review", taskId: "task-aaaaaaaaaaaaaaaaaaaa", computeMs: 1 });
    up = true; now += CHARGE_RETRY_LIMITS.baseMs + 1;
    const first = await retry.sweep(owner);
    assert.equal(first.booked, CHARGE_RETRY_LIMITS.perSweep, "a sweep is bounded");
    const second = await retry.sweep(owner);
    assert.equal(first.booked + second.booked, 100);
    assert.equal(booked.size, 100);
    assert.ok([...booked.values()].every((n) => n === 1));
  } finally { await world.close(); }
});
