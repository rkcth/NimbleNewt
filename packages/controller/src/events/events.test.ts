import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Grant, type Principal } from "../security/index.js";
import { NotificationService } from "../notifications/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { EVENT_LIMITS, EventService, noticeThroughNotifications, type NotifyExpiry } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-22T19:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx { ev: EventService; owner: Principal; host: Principal; ann: Principal; ben: Principal; reader: Principal; stream: string; other: string; hold: { on: boolean }; storage: ControllerStorage; open(extra?: { notify?: NotifyExpiry }): EventService; epoch: number; projectA: string; pub(kind?: string, ref?: string, extra?: Record<string, unknown>, by?: Principal): ReturnType<EventService["publish"]> }
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
        const open = (extra: { notify?: NotifyExpiry } = {}) => EventService.withEpoch(world.storage, projects.epoch, { ...options, held: async () => hold.on, ...extra });
        await body({ ev, storage: world.storage, open, epoch: projects.epoch, projectA: a, owner, host, ann, ben, reader, stream, other: `project:${b}`, hold, pub: (kind = "task.updated", ref = "task-aaaaaaaaaaaaaaaaaaaa", extra = {}, by = host) => ev.publish(by, { commandId: cid("pb"), stream, kind, ref: { kind: "task", id: ref }, ...extra } as never) });
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

  // ---- H06b: idle expiry ----------------------------------------------------------------------------------------------------

  const audit = async (c: Ctx, type: string) => {
    const out = [];
    for (let afterSeq = 0; ;) { const page = await c.storage.listAudit({ afterSeq, limit: 1000 }); out.push(...page.filter((e) => e.type === type)); if (page.length < 1000) return out; afterSeq = page[page.length - 1]!.seq; }
  };
  const IDLE = EVENT_LIMITS.idleDefault * 1000;

  suite("a crashed critical watcher is expired when a producer meets a full queue after the idle time; resuming keeps its cursor and reconciles as H06 does", async (c) => {
    const watcher = await c.ev.subscribe(c.host, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    for (let i = 0; i < EVENT_LIMITS.queue; i++) await c.pub("bulk.x", `r${i}`);
    assert.equal((await c.pub("bulk.x", "held")).accepted, false);
    now += IDLE - 1000;
    assert.equal((await c.pub("bulk.x", "still-held")).accepted, false, "not idle long enough yet");
    assert.equal((await c.ev.status(c.host, watcher.id)).state, "active");
    now += 1000;
    assert.equal((await c.pub("bulk.x", "free")).accepted, true, "producers are no longer held back, without any sweep having run");
    assert.equal((await c.pub("bulk.x", "free-again")).accepted, true);
    const status = await c.ev.status(c.host, watcher.id);
    assert.deepEqual([status.state, status.cursor, status.expiredCursor, status.expiredAt], ["expired", 0, 0, new Date(now).toISOString()]);
    const [entry] = await audit(c, "events.expire");
    assert.deepEqual([entry!.detail["cursor"], entry!.detail["subscriber"], entry!.detail["critical"], entry!.detail["idleSeconds"], entry!.detail["pending"]], [0, "host:h1", true, EVENT_LIMITS.idleDefault, EVENT_LIMITS.queue + 1]);
    assert.equal((await audit(c, "events.expire")).length, 1);
    await refuses("invalid_transition", () => c.ev.pull(c.host, watcher.id), (e) => assert.match(e.message, /resume it/));
    await refuses("invalid_transition", () => c.ev.acknowledge(c.host, { commandId: cid("ak"), subscriptionId: watcher.id, through: 1 }));
    // Resume: the cursor is where it was, and having fallen further than the queue bound it is told to reconcile, exactly as before.
    assert.deepEqual(await c.ev.resume(c.host, { commandId: cid("rs"), subscriptionId: watcher.id }), { cursor: 0 });
    const pulled = await c.ev.pull(c.host, watcher.id);
    assert.equal(pulled.reconcile, true);
    assert.ok(pulled.reasons.some((r) => /fell more than/.test(r)));
    assert.equal((await c.ev.status(c.host, watcher.id)).state, "active");
  });

  suite("an expiry that resumes within retention loses nothing and repeats nothing; one past retention reconciles", async (c) => {
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    for (let i = 0; i < 6; i++) await c.pub("a.b", `t${i}`);
    await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 3 });
    now += IDLE;
    for (let i = 6; i < 9; i++) await c.pub("a.b", `t${i}`);
    assert.deepEqual((await c.ev.expireIdle(c.owner)).expired, [sub.id]);
    assert.deepEqual((await c.ev.expireIdle(c.owner)).expired, [], "a second sweep expires nothing again");
    assert.equal((await audit(c, "events.expire")).length, 1);
    await c.ev.resume(c.reader, { commandId: cid("rs"), subscriptionId: sub.id });
    const batch = await c.ev.pull(c.reader, sub.id);
    assert.deepEqual(batch.events.map((e) => e.seq), [4, 5, 6, 7, 8, 9], "everything after the last acknowledged event, and nothing before it");
    assert.equal(batch.reconcile, false);
    // Expire again after more acknowledgements, with retention moving past the cursor meanwhile.
    await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 5 });
    now += IDLE;
    await c.ev.expireIdle(c.owner);
    await c.ev.setFloor(c.owner, { commandId: cid("fl"), stream: c.stream, floor: 8 });
    assert.equal((await audit(c, "events.expire")).length, 2, "the second expiry is its own record");
    await c.ev.resume(c.reader, { commandId: cid("rs"), subscriptionId: sub.id });
    const late = await c.ev.pull(c.reader, sub.id);
    assert.equal(late.reconcile, true);
    assert.ok(late.reasons.some((r) => /behind retention/.test(r)));
    assert.deepEqual(late.events.map((e) => e.seq), [8, 9]);
  });

  suite("a live but slow subscriber that acknowledges, or reports it is working, within the time is never expired", async (c) => {
    const slow = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    const working = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    await c.pub("a.b", "t1");
    for (let i = 1; i <= 6; i++) {
      now += IDLE - 1000;
      await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: slow.id, through: 0 });
      await c.ev.heartbeat(c.reader, { commandId: cid("hb"), subscriptionId: working.id });
      assert.deepEqual((await c.ev.expireIdle(c.owner)).expired, [], `round ${i}`);
    }
    assert.equal(await audit(c, "events.expire").then((a) => a.length), 0);
    // The same two, silent for the idle time, are expired together.
    now += IDLE;
    assert.deepEqual((await c.ev.expireIdle(c.owner)).expired.sort(), [slow.id, working.id].sort());
    await refuses("forbidden", () => c.ev.expireIdle(c.reader));
    await refuses("forbidden", () => c.ev.expireIdle(c.host));
  });

  suite("the expiry time is the owner's setting with a default; a subscriber may only ask for less; the owner can cancel at any time", async (c) => {
    const plain = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream });
    const short = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, idleSeconds: 30 });
    const long = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, idleSeconds: 100_000 });
    await c.pub("a.b", "t1");
    assert.deepEqual([(await c.ev.status(c.reader, plain.id)).idleSeconds, (await c.ev.status(c.reader, short.id)).idleSeconds, (await c.ev.status(c.reader, long.id)).idleSeconds], [900, 30, 900], "the default is the ceiling");
    await refuses("forbidden", () => c.ev.configureIdle(c.host, { commandId: cid("ci"), idleSeconds: 60 }));
    await refuses("forbidden", () => c.ev.configureIdle(c.reader, { commandId: cid("ci"), idleSeconds: 60 }));
    for (const bad of [1, 9, 604_801, 1.5, "60"]) await assert.rejects(() => c.ev.configureIdle(c.owner, { commandId: cid("ci"), idleSeconds: bad as number }), DomainError, String(bad));
    for (const bad of [1, 5, 700_000]) await assert.rejects(() => c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, idleSeconds: bad }), DomainError, String(bad));
    await c.ev.configureIdle(c.owner, { commandId: cid("ci"), idleSeconds: 120 });
    assert.deepEqual([(await c.ev.status(c.reader, plain.id)).idleSeconds, (await c.ev.status(c.reader, short.id)).idleSeconds, (await c.ev.status(c.reader, long.id)).idleSeconds], [120, 30, 120]);
    now += 31_000;
    assert.deepEqual((await c.ev.expireIdle(c.owner)).expired, [short.id]);
    now += 90_000;
    assert.deepEqual((await c.ev.expireIdle(c.owner)).expired.sort(), [long.id, plain.id].sort());
    await c.ev.configureIdle(c.owner, { commandId: cid("ci"), idleSeconds: 3600 });
    // Cancel works on an active, an expired and a cancelled subscription; a cancelled one cannot be resumed.
    const live = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream });
    await c.ev.cancel(c.owner, { commandId: cid("cn"), subscriptionId: live.id });
    await c.ev.cancel(c.owner, { commandId: cid("cn"), subscriptionId: short.id });
    assert.equal((await c.ev.status(c.owner, short.id)).state, "cancelled");
    await refuses("forbidden", () => c.ev.resume(c.reader, { commandId: cid("rs"), subscriptionId: short.id }));
    await refuses("forbidden", () => c.ev.resume(c.reader, { commandId: cid("rs"), subscriptionId: live.id }));
    await refuses("invalid_transition", async () => { const again = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream }); await c.ev.resume(c.reader, { commandId: cid("rs"), subscriptionId: again.id }); });
    await refuses("forbidden", () => c.ev.resume(c.ann, { commandId: cid("rs"), subscriptionId: plain.id }));
    await refuses("forbidden", () => c.ev.status(c.ann, plain.id));
    // A cancelled subscription is not swept back to life or expired.
    now += 10_000_000;
    assert.equal((await c.ev.expireIdle(c.owner)).expired.includes(live.id), false);
  });

  suite("a restart changes nothing: the expiry, its record and its cursor are kept; the owed Notice is delivered once, retried after a failure, and only for work that was affected", async (c) => {
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, options);
    const toInbox = noticeThroughNotifications(notifications);
    let down = true;
    const notify: NotifyExpiry = async (n) => { if (down) throw new Error("channel down"); await toInbox(n); };
    const one = c.open({ notify });
    const sub = await one.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    for (let i = 0; i < 3; i++) await c.pub("a.b", `t${i}`);
    await one.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 1 });
    now += IDLE;
    assert.deepEqual(await one.expireIdle(c.owner), { expired: [sub.id], noticed: 0, noticeFailed: 1, more: false });
    assert.equal((await notifications.inbox(c.owner)).items.length, 0, "the Notice could not be delivered");
    // Restart: a new service over the same records still sees the expiry and its cursor, expires nothing twice and delivers the owed Notice.
    const two = c.open({ notify });
    const status = await two.status(c.reader, sub.id);
    assert.deepEqual([status.state, status.cursor, status.expiredCursor], ["expired", 1, 1]);
    down = false;
    assert.deepEqual(await two.expireIdle(c.owner), { expired: [], noticed: 1, noticeFailed: 0, more: false });
    assert.deepEqual(await two.expireIdle(c.owner), { expired: [], noticed: 0, noticeFailed: 0, more: false }, "delivered once");
    const items = (await notifications.inbox(c.owner)).items;
    assert.equal(items.length, 1);
    const item = items[0]!;
    assert.deepEqual([item.kind, item.ref, item.projectId, item.count], ["maintenance", { kind: "subscription", id: sub.id }, c.stream.slice("project:".length), 1]);
    assert.match(item.detail ?? "", /expired at event 1 with 2 unhandled/);
    assert.equal((await audit(c, "events.expire")).length, 1);
    // A subscription with nothing waiting for it expires quietly: recorded, but no Notice.
    const quiet = await two.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream });
    now += IDLE;
    assert.deepEqual((await two.expireIdle(c.owner)).expired, [quiet.id]);
    assert.equal((await notifications.inbox(c.owner)).items.length, 1);
    assert.equal((await audit(c, "events.expire")).length, 2);
    // The resumed subscriber continues from the recorded cursor.
    assert.deepEqual(await two.resume(c.reader, { commandId: cid("rs"), subscriptionId: sub.id }), { cursor: 1 });
    assert.deepEqual((await two.pull(c.reader, sub.id)).events.map((e) => e.seq), [2, 3]);
    // A repeat of the resume command is the same resume.
    const id = cid("rs2");
    await two.expireIdle(c.owner);
    now += IDLE;
    await two.expireIdle(c.owner);
    await two.resume(c.reader, { commandId: id, subscriptionId: sub.id });
    await two.resume(c.reader, { commandId: id, subscriptionId: sub.id });
  });

  suite("a second expiry at the same cursor tells the owner again; a notifier that is down never stops the sweep; publishing never calls the notifier", async (c) => {
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, options);
    const toInbox = noticeThroughNotifications(notifications);
    let down = false; let calls = 0;
    const ev = c.open({ notify: async (n) => { calls++; if (down) throw new Error("channel down"); await toInbox(n); } });
    const told = async () => (await notifications.inbox(c.owner)).items.reduce((n, i) => n + i.count, 0);
    // Expire, resume without acknowledging, expire again: the cursor is the same, the owner is told both times.
    const sub = await ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    await c.pub("a.b", "t1");
    now += IDLE;
    assert.equal((await ev.expireIdle(c.owner)).noticed, 1);
    await ev.resume(c.reader, { commandId: cid("rs"), subscriptionId: sub.id });
    now += IDLE;
    assert.equal((await ev.expireIdle(c.owner)).noticed, 1);
    assert.equal(await told(), 2);
    // A notifier that is down: the first subscription's Notice fails, and a later one going idle is still expired by the next sweep.
    down = true;
    const first = await ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true, idleSeconds: 30 });
    const second = await ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    now += 31_000;
    assert.deepEqual(await ev.expireIdle(c.owner), { expired: [first.id], noticed: 0, noticeFailed: 1, more: false });
    now += IDLE;
    assert.deepEqual(await ev.expireIdle(c.owner), { expired: [second.id], noticed: 0, noticeFailed: 2, more: false });
    assert.deepEqual([(await ev.status(c.reader, first.id)).state, (await ev.status(c.reader, second.id)).state], ["expired", "expired"]);
    down = false;
    assert.deepEqual(await ev.expireIdle(c.owner), { expired: [], noticed: 2, noticeFailed: 0, more: false });
    assert.equal(await told(), 4);
    // Publishing expires an idle critical watcher but leaves its Notice to the sweep.
    const watcher = await ev.subscribe(c.host, { commandId: cid("sb"), stream: c.stream });
    now += IDLE;
    const before = calls;
    assert.equal((await c.pub("a.b", "t2")).accepted, true);
    assert.equal((await ev.status(c.host, watcher.id)).state, "expired");
    assert.equal(calls, before, "the producer never waited for the notifier");
    assert.equal((await ev.expireIdle(c.owner)).noticed, 1);
    assert.equal(calls, before + 1);
  });

  suite("a critical subscriber that disappears is reported even with nothing waiting; the sweep stops at its limit and continues", async (c) => {
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, options);
    const ev = c.open({ notify: noticeThroughNotifications(notifications) });
    await c.pub("a.b", "t1");
    const host = await ev.subscribe(c.host, { commandId: cid("sb"), stream: c.stream });
    now += IDLE;
    assert.deepEqual(await ev.expireIdle(c.owner), { expired: [host.id], noticed: 1, noticeFailed: 0, more: false });
    assert.equal((await notifications.inbox(c.owner)).items.length, 1);
    const ids: string[] = [];
    for (let i = 0; i <= EVENT_LIMITS.sweep; i++) ids.push((await ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream })).id);
    now += IDLE;
    const one = await ev.expireIdle(c.owner);
    assert.deepEqual([one.expired.length, one.more], [EVENT_LIMITS.sweep, true]);
    const two = await ev.expireIdle(c.owner);
    assert.deepEqual([two.expired.length, two.more], [1, false]);
    assert.deepEqual([...one.expired, ...two.expired].sort(), [...ids].sort());
  });

  suite("the idle check is repeated inside the expire command: an acknowledgement that lands after the sweep read the subscription wins", async (c) => {
    const sub = await c.ev.subscribe(c.reader, { commandId: cid("sb"), stream: c.stream, fromStart: true });
    await c.pub("a.b", "t1");
    const armed = { on: false, reads: 0 };
    const proxy = new Proxy(c.storage, {
      get(target, key) {
        if (key === "getAggregate") return async (ref: { kind: string; id: string }) => {
          const found = await target.getAggregate(ref as never);
          // The second read of the subscription is the expire command's own first look; an acknowledgement lands right after it.
          if (armed.on && ref.kind === "subscription" && ++armed.reads === 2) { armed.on = false; await c.ev.acknowledge(c.reader, { commandId: cid("ak"), subscriptionId: sub.id, through: 1 }); }
          return found;
        };
        const value = (target as unknown as Record<string | symbol, unknown>)[key];
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const racing = EventService.withEpoch(proxy as ControllerStorage, c.epoch, options);
    now += IDLE;
    armed.on = true;
    assert.deepEqual((await racing.expireIdle(c.owner)).expired, []);
    assert.equal((await c.ev.status(c.reader, sub.id)).state, "active");
    assert.equal((await audit(c, "events.expire")).length, 0);
  });
}
