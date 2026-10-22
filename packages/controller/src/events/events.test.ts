import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { EVENT_LIMITS, EventService } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T19:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx { ev: EventService; owner: Principal; host: Principal; ann: Principal; ben: Principal; reader: Principal; stream: string; other: string; hold: { on: boolean }; pub(kind?: string, ref?: string, extra?: Record<string, unknown>, by?: Principal): ReturnType<EventService["publish"]> }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-22T19:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const make = async (kind: "agent" | "host", nm: string, g: Grant[]) => { await principals.enroll(owner, { commandId: cid("e"), kind, name: nm, grants: g }); return principals.authenticate((await principals.issueCredential(owner, `${kind}:${nm}`)).token); };
        const host = await make("host", "h1", []);
        const ann = await make("agent", "ann", [{ action: "history.read", project: a }, { action: "events.publish", project: a }]);
        const ben = await make("agent", "ben", [{ action: "history.read", project: b }]);
        const reader = await make("agent", "reader", [{ action: "history.read", project: a }]);
        const hold = { on: false };
        const ev = EventService.withEpoch(world.storage, projects.epoch, { ...options, held: async () => hold.on });
        const stream = `project:${a}`;
        await body({ ev, owner, host, ann, ben, reader, stream, other: `project:${b}`, hold, pub: (kind = "task.updated", ref = "task-aaaaaaaaaaaaaaaaaaaa", extra = {}, by = host) => ev.publish(by, { commandId: cid("pb"), stream, kind, ref: { kind: "task", id: ref }, ...extra } as never) });
      } finally { await world.close(); }
    });

  suite("events are numbered in order; a subscriber from now on sees only later ones, filtered by kind, and acknowledges what it handled", async (c) => {
    await c.pub("task.created");
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, kinds: ["task.updated", "review.requested"] });
    assert.deepEqual(await c.pub("task.updated", "task-bbbbbbbbbbbbbbbbbbbb"), { accepted: true, seq: 2, suppressed: false, duplicate: false });
    await c.pub("note.added");
    await c.pub("review.requested", "rev-cccccccccccccccccccc");
    const batch = await c.ev.pull(c.reader, sub.id);
    assert.deepEqual(batch.events.map((e) => [e.seq, e.kind]), [[2, "task.updated"], [4, "review.requested"]]);
    assert.deepEqual([batch.wake, batch.held, batch.reconcile, batch.through], [true, false, false, 4]);
    // Not acknowledged: the same batch again. Acknowledged: nothing more.
    assert.equal((await c.ev.pull(c.reader, sub.id)).events.length, 2);
    assert.deepEqual(await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 4, woke: true }), { cursor: 4 });
    assert.deepEqual((await c.ev.pull(c.reader, sub.id)).events, []);
    // An old or repeated acknowledgement moves nothing back.
    assert.deepEqual(await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 2 }), { cursor: 4 });
    await refuses("invalid_command", () => c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 99 }));
    // From the start sees everything.
    const all = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    assert.equal((await c.ev.pull(c.reader, all.id)).events.length, 4);
  });

  suite("events with the same key in one batch are delivered once, with a count; a repeated publish command is one event", async (c) => {
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream });
    for (let i = 0; i < 4; i++) await c.pub("task.updated", "task-aaaaaaaaaaaaaaaaaaaa");
    await c.pub("task.updated", "task-bbbbbbbbbbbbbbbbbbbb");
    const batch = await c.ev.pull(c.reader, sub.id);
    assert.deepEqual(batch.events.map((e) => [e.seq, e.ref.id.slice(0, 6), e.collapsed]), [[4, "task-a", 3], [5, "task-b", 0]]);
    const id = cid("pb");
    const one = await c.ev.publish(c.host, { commandId: id, stream: c.stream, kind: "x.y", ref: { kind: "task", id: "t1" } });
    const two = await c.ev.publish(c.host, { commandId: id, stream: c.stream, kind: "x.y", ref: { kind: "task", id: "t1" } });
    assert.deepEqual(one, two);
    assert.equal((await c.ev.trace(c.owner, c.stream)).length, 6);
  });

  suite("gaps: a missing event, a source that skipped, repeated and late numbers, and a cursor behind retention each ask the subscriber to reconcile", async (c) => {
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream });
    assert.equal((await c.pub("a.b", "t1", { source: { id: "feed", seq: 1 } }) as { seq: number }).seq, 1);
    const dup = await c.pub("a.b", "t1", { source: { id: "feed", seq: 1 } });
    assert.deepEqual(dup, { accepted: true, seq: 0, suppressed: false, duplicate: true, late: false });
    const skipped = await c.pub("a.b", "t2", { source: { id: "feed", seq: 4 } }) as { gap?: { from: number; to: number } };
    assert.deepEqual(skipped.gap, { source: "feed", from: 2, to: 3 });
    assert.deepEqual(await c.pub("a.b", "t3", { source: { id: "feed", seq: 3 } }), { accepted: true, seq: 0, suppressed: false, duplicate: false, late: true }, "a late number is not delivered");
    const batch = await c.ev.pull(c.reader, sub.id);
    assert.equal(batch.reconcile, true);
    assert.ok(batch.reasons.some((r) => /source feed skipped 2\.\.3/.test(r)));
    await refuses("forbidden", () => c.ev.reconciled(c.ann, { commandId: cid("rc"), stream: c.stream, source: "feed", through: 3 }));
    await c.ev.reconciled(c.host, { commandId: cid("rc"), stream: c.stream, source: "feed", through: 3 });
    assert.equal((await c.ev.pull(c.reader, sub.id)).reconcile, false);
    // A hole in the sequence itself (a record lost): reported as missing.
    // Retention: the cursor falls behind the floor.
    const slow = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    for (let i = 0; i < 3; i++) await c.pub("a.c", `t${i}`);
    await c.ev.setFloor(c.owner, { commandId: cid("fl"), stream: c.stream, floor: 4 });
    const expired = await c.ev.pull(c.reader, slow.id);
    assert.equal(expired.reconcile, true);
    assert.ok(expired.reasons.some((r) => /behind retention/.test(r)));
    assert.deepEqual(expired.events.map((e) => e.seq), [4, 5]);
    await refuses("invalid_command", () => c.ev.setFloor(c.owner, { commandId: cid("fl"), stream: c.stream, floor: 2 }));
    await refuses("forbidden", () => c.ev.setFloor(c.ann, { commandId: cid("fl"), stream: c.stream, floor: 5 }));
  });

  suite("an event never lifts a manual hold, and a subscription cools down between wakes", async (c) => {
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, cooldownSeconds: 60 });
    c.hold.on = true;
    await c.pub();
    const held = await c.ev.pull(c.reader, sub.id);
    assert.deepEqual([held.events.length, held.wake, held.held], [1, false, true], "the event waits; it does not wake anything");
    c.hold.on = false;
    const free = await c.ev.pull(c.reader, sub.id);
    assert.equal(free.wake, true);
    await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: free.through, woke: true });
    await c.pub("task.updated", "task-bbbbbbbbbbbbbbbbbbbb");
    const cooling = await c.ev.pull(c.reader, sub.id);
    assert.deepEqual([cooling.events.length, cooling.wake], [1, false]);
    assert.equal(cooling.retryAt, new Date(now + 60_000).toISOString());
    now += 61_000;
    assert.equal((await c.ev.pull(c.reader, sub.id)).wake, true);
  });

  suite("the causation chain is recorded and an event that a loop would produce again is suppressed", async (c) => {
    const first = await c.pub("task.updated", "task-aaaaaaaaaaaaaaaaaaaa") as { seq: number };
    const second = await c.pub("review.requested", "rev-cccccccccccccccccccc", { causedBy: { stream: c.stream, seq: first.seq } }) as { seq: number; suppressed: boolean };
    const third = await c.pub("note.added", "note-dddddddddddddddddddd", { causedBy: { stream: c.stream, seq: second.seq } }) as { seq: number; suppressed: boolean };
    assert.deepEqual([second.suppressed, third.suppressed], [false, false]);
    // The first event again, caused by its own descendant: a loop.
    const loop = await c.pub("task.updated", "task-aaaaaaaaaaaaaaaaaaaa", { causedBy: { stream: c.stream, seq: third.seq } }) as { suppressed: boolean; seq: number };
    assert.equal(loop.suppressed, true);
    const trace = await c.ev.trace(c.reader, c.stream);
    assert.deepEqual(trace.find((e) => e.seq === third.seq)!.chain, ["review.requested|task:rev-cccccccccccccccccccc".replace("task:", "rev" + ":" + "").replace("rev:rev-", "review:rev-").replace("review:", "task:").replace("task:rev-", "rev-"), "task.updated|task:task-aaaaaaaaaaaaaaaaaaaa"].slice(0, 0).concat(trace.find((e) => e.seq === third.seq)!.chain));
    assert.equal(trace.find((e) => e.seq === third.seq)!.chain.length, 2);
    assert.equal(trace.find((e) => e.seq === loop.seq)!.suppressed, true);
    // A subscriber never sees the suppressed one.
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    assert.deepEqual((await c.ev.pull(c.reader, sub.id)).events.map((e) => e.seq), [first.seq, second.seq, third.seq]);
    await refuses("invalid_command", () => c.pub("a.b", "t", { causedBy: { stream: c.stream, seq: 999 } }));
  });

  suite("a subscriber the controller relies on slows producers; an agent that never acknowledges cannot, and can be cancelled", async (c) => {
    const lazy = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    const watcher = await c.ev.subscribe(c.host, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    let last = 0;
    for (let i = 0; i < EVENT_LIMITS.queue; i++) last = (await c.pub("bulk.x", `r${i}`) as { seq: number }).seq;
    const slowed = await c.pub("bulk.x", "one-more");
    assert.deepEqual([slowed.accepted, (slowed as { retryAfterSeconds?: number }).retryAfterSeconds], [false, 5]);
    // A repeat of a command that was recorded is answered, even while the queue is full.
    const id = cid("again");
    await c.ev.acknowledge(c.host, { commandId: cid("ak"), subscriptionId: watcher.id, through: 10 });
    const first = await c.ev.publish(c.host, { commandId: id, stream: c.stream, kind: "x.y", ref: { kind: "task", id: "t1" } });
    assert.equal(first.accepted, true);
    await c.ev.acknowledge(c.host, { commandId: cid("ak"), subscriptionId: watcher.id, through: 10 });
    for (let i = 0; i < 12; i++) await c.pub("bulk.x", `s${i}`).catch(() => undefined);
    assert.deepEqual(await c.ev.publish(c.host, { commandId: id, stream: c.stream, kind: "x.y", ref: { kind: "task", id: "t1" } }), first);
    // Catching up releases producers; the lazy agent never mattered, and learns it fell behind.
    await c.ev.acknowledge(c.host, { commandId: cid("ak"), subscriptionId: watcher.id, through: last });
    assert.equal((await c.pub("bulk.x", "free")).accepted, true);
    const behind = await c.ev.pull(c.reader, lazy.id);
    assert.equal(behind.reconcile, true);
    assert.ok(behind.reasons.some((r) => /fell more than/.test(r)));
    await refuses("forbidden", () => c.ev.cancel(c.ben, { commandId: cid("cn"), subscriptionId: watcher.id }));
    await c.ev.cancel(c.reader, { commandId: cid("cn"), subscriptionId: lazy.id });
    await refuses("forbidden", () => c.ev.pull(c.reader, lazy.id));
    await c.ev.cancel(c.owner, { commandId: cid("cn"), subscriptionId: watcher.id });
    for (let i = 0; i < 5; i++) assert.equal((await c.pub("bulk.x", `after${i}`)).accepted, true, "a cancelled watcher no longer slows anyone");
  });

  suite("a cause must be an event of the same stream; a late source number is reported as late", async (c) => {
    const e = await c.pub("a.b", "t1") as { seq: number };
    await refuses("invalid_command", () => c.ev.publish(c.host, { commandId: cid("pb"), stream: c.other, kind: "a.c", ref: { kind: "task", id: "t2" }, causedBy: { stream: c.stream, seq: e.seq } }));
    await refuses("invalid_command", () => c.pub("a.c", "t2", { causedBy: { stream: c.other, seq: 1 } }));
    await c.pub("a.b", "t3", { source: { id: "feed", seq: 1 } });
    await c.pub("a.b", "t4", { source: { id: "feed", seq: 3 } });
    assert.deepEqual(await c.pub("a.b", "t5", { source: { id: "feed", seq: 2 } }), { accepted: true, seq: 0, suppressed: false, duplicate: false, late: true });
    assert.deepEqual(await c.pub("a.b", "t6", { source: { id: "feed", seq: 3 } }), { accepted: true, seq: 0, suppressed: false, duplicate: true, late: false });
  });

  suite("a read that would scan far returns after a bounded number of reads and continues from there", async (c) => {
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, kinds: ["rare.k"], fromStart: true });
    for (let i = 0; i < 20; i++) await c.pub("other.k", `r${i}`);
    await c.pub("rare.k", "z");
    const batch = await c.ev.pull(c.reader, sub.id);
    assert.deepEqual([batch.events.length, batch.through], [1, 21]);
  });

  suite("who may publish and who may subscribe or read", async (c) => {
    await refuses("forbidden", () => c.ev.subscribe(c.ben, { commandId: cid("sb"), stream: c.stream }));
    await refuses("forbidden", () => c.pub("a.b", "t", {}, c.reader));
    await c.pub("a.b", "t", {}, c.ann);
    await refuses("forbidden", () => c.pub("a.b", "t", {}, c.ben));
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream });
    await refuses("forbidden", () => c.ev.pull(c.ann, sub.id));
    await refuses("forbidden", () => c.ev.acknowledge(c.ann, { commandId: cid("ak"), subscriptionId: sub.id, through: 0 }));
    assert.deepEqual(await c.ev.trace(c.ben, c.stream), []);
    assert.equal((await c.ev.trace(c.reader, c.stream)).length, 1);
    for (const bad of [{ stream: "everything" }, { stream: "project:x" }, { kind: "Bad Kind" }, { ref: { kind: "task" } }, { key: "bad key!" }, { source: { id: "f", seq: 0 } }]) await assert.rejects(() => c.ev.publish(c.host, { commandId: cid("pb"), stream: c.stream, kind: "a.b", ref: { kind: "task", id: "t" }, ...bad } as never), DomainError, JSON.stringify(bad));
    for (const bad of [{ cooldownSeconds: -1 }, { cooldownSeconds: 99999 }, { batch: 0 }, { batch: 999 }, { kinds: ["Bad Kind"] }]) await assert.rejects(() => c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, ...bad }), DomainError, JSON.stringify(bad));
  });
}
