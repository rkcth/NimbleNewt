import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/configuration.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import { balanceWaitReason, blockers, type AdmissionState, type Entry } from "./policy.js";
import { AdmissionService, promote, BORROWS_KEPT, BORROW_MAX_HOURS, DEFAULT_LIMITS, LENT_REASON, borrowAt, borrowEnd, borrowRestUntil, type Borrow, type RequestAdmission } from "./index.js";

after(stopServer);

// Card B01, second slice: the owner's emergency borrow of the improvement reserve. Explicit direction with reason, scope, expiry and review date; repeated urgency cannot remove the floor; the borrow
// is kept in the admission record, so it survives a restart and expires by the clock. Every time here is a fixed value moved by hand: nothing depends on the machine's clock or time zone.
const H = 3_600_000;
const at = (base: string, hours: number): string => new Date(Date.parse(base) + hours * H).toISOString();
const T0 = "2026-11-27T15:00:00.000Z";
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, pattern?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (pattern !== undefined) assert.match(error.message, pattern); return true; });
};
const BIG = { cpus: 64, memoryMb: 262_144 };

test("a borrow is in force from its start until its expiry or early end; the floor then stands again for as long as it was lent", () => {
  const b: Borrow = { id: "brw-aaaaaaaaaaaaaaaaaaaa", reason: "r", places: 1, from: T0, until: at(T0, 10), reviewBy: at(T0, 24), by: "owner:rob" };
  assert.equal(borrowAt([b], at(T0, -1)), undefined, "not before it starts");
  assert.equal(borrowAt([b], T0)?.id, b.id);
  assert.equal(borrowAt([b], at(T0, 9.99))?.id, b.id);
  assert.equal(borrowAt([b], at(T0, 10)), undefined, "not at its expiry");
  assert.equal(borrowRestUntil([b]), at(T0, 20), "ten hours lent, ten hours standing again");
  const ended = { ...b, endedAt: at(T0, 2) };
  assert.equal(borrowEnd(ended), at(T0, 2));
  assert.equal(borrowAt([ended], at(T0, 3)), undefined, "an early end counts");
  assert.equal(borrowRestUntil([ended]), at(T0, 4), "the rest is as long as it really was lent");
  assert.equal(borrowEnd({ ...b, endedAt: at(T0, 12) }), b.until, "an end after the expiry changes nothing");
  assert.equal(borrowRestUntil([]), undefined);
  // Only the newest one counts: an older borrow is history.
  assert.equal(borrowAt([b, { ...b, id: "brw-bbbbbbbbbbbbbbbbbbbb", from: at(T0, 30), until: at(T0, 31) }], at(T0, 5)), undefined);
});

test("the wait reason says when a borrow does not cover the request, or when the places it lends are taken", () => {
  const entry = (id: string, seq: number, extra: Partial<Entry>): Entry => ({ id, class: "productive", priority: 5, host: "host:h1", cpus: 1, memoryMb: 1, depth: 0, seq, skipped: 0, at: T0, workClass: "P", project: "proj-garden", ...extra });
  const base = (running: Entry[], queue: Entry[], floor: number): AdmissionState => ({ limits: { ...DEFAULT_LIMITS, perHost: 4 }, capacity: { "host:h1": BIG }, running, queue, nextSeq: 99, withdrawn: [], balance: { floor, ceiling: 75 } });
  const three = [entry("r1", 1, {}), entry("r2", 2, {}), entry("r3", 3, {})];
  // One reserved place, lent to the garden only: orchard work is held for the waiting improvement work, garden work is not.
  const orchard = entry("q1", 10, { project: "proj-orchard" }), garden = entry("q2", 11, {}), pc = entry("q3", 12, { workClass: "PC" });
  const one = { ...base(three, [orchard, garden, pc], 25), borrow: { id: "brw-x", places: 1, project: "proj-garden", until: at(T0, 6) } };
  assert.deepEqual(blockers(one, orchard), ["reserved"]);
  assert.match(balanceWaitReason(one, orchard) ?? "", /keeps 1 of 4 places for it; your emergency borrow brw-x lends places only to project proj-garden\)$/);
  assert.deepEqual(blockers(one, garden), []);
  const promoted = promote(one);
  assert.deepEqual(promoted.admitted.map((e) => [e.id, e.borrowed]), [["q2", "brw-x"]], "the covered work is admitted, marked with the borrow; nothing more fits");
  // Two reserved places, one lent and already taken: garden work is held too, and told why.
  const two = { ...base([entry("r1", 1, {}), entry("r2", 2, {}), entry("r3", 3, { borrowed: "brw-x", lent: "x" })], [garden, pc], 50), borrow: { id: "brw-x", places: 1, until: at(T0, 6) } };
  assert.deepEqual(blockers(two, garden), ["reserved"]);
  assert.match(balanceWaitReason(two, garden) ?? "", /keeps 2 of 4 places for it; the 1 place\(s\) your emergency borrow brw-x lends are taken\)$/);
  // With no improvement work that could use it, the place is lent as before (not marked as borrowed).
  const idle = { ...base(three, [orchard], 25), borrow: { id: "brw-x", places: 1, until: at(T0, 6) } };
  const lent = promote(idle).admitted[0]!;
  assert.deepEqual([lent.id, lent.lent, lent.borrowed], ["q1", LENT_REASON, undefined]);
});

for (const backend of backends) {
  interface Ctx {
    admission: AdmissionService; owner: Principal; agent: Principal; garden: string; orchard: string;
    clock: { now: string };
    storage: ControllerStorage; epoch: number;
    reopen(): AdmissionService;
    allocate(set: Record<string, number>): Promise<void>;
    ask(workClass: "P" | "PC", extra?: Partial<RequestAdmission>, on?: AdmissionService): Promise<{ id: string; state: string }>;
    release(id: string, on?: AdmissionService): Promise<void>;
    lend(extra?: Record<string, unknown>, on?: AdmissionService, id?: string): Promise<Awaited<ReturnType<AdmissionService["borrow"]>>>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: emergency borrow (card B01): ${name}`, async () => {
      const world = await backend.open();
      try {
        const clock = { now: T0 };
        const options = { clock: () => clock.now, pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        for (const h of ["h1", "h2"]) await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: h, grants: [] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const garden = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Garden" })).id;
        const orchard = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Orchard" })).id;
        const configuration = ConfigurationService.withEpoch(world.storage, projects.epoch, options);
        const reopen = () => AdmissionService.withEpoch(world.storage, projects.epoch, options);
        const admission = reopen();
        await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: BIG });
        await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h2", capacity: BIG });
        await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, perHost: 4 } });
        let layer = 0;
        const allocate = async (set: Record<string, number>) => {
          const r = await configuration.change(owner, { commandId: cid("cfg"), layer: "installation", ...(layer === 0 ? {} : { expectedRevision: layer }), set });
          layer = r.revision;
        };
        const ask = (workClass: "P" | "PC", extra: Partial<RequestAdmission> = {}, on = admission) => on.request({ commandId: cid("r"), actor: "dispatcher", class: "productive", host: "host:h1", cpus: 1, memoryMb: 512, workClass, project: garden, ...extra } as RequestAdmission);
        const release = async (id: string, on = admission) => { await on.release({ commandId: cid("rel"), actor: "dispatcher", requestId: id, reason: "done" }); };
        const lend = (extra: Record<string, unknown> = {}, on = admission, id = cid("b")) => on.borrow(owner, { commandId: id, reason: "the release is due tonight", places: 1, until: at(clock.now, 6), reviewBy: at(clock.now, 30), ...extra });
        await body({ admission, owner, agent, garden, orchard, clock, storage: world.storage, epoch: projects.epoch, reopen, allocate, ask, release, lend });
      } finally { await world.close(); }
    });

  /** Four places, all taken by production (one of them lent from the one reserved place), improvement work and urgent production waiting on the other host. */
  const fill = async ({ allocate, ask }: Ctx, urgent: Partial<RequestAdmission> = {}) => {
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const p = [await ask("P"), await ask("P"), await ask("P"), await ask("P")];
    assert.deepEqual(p.map((x) => x.state), ["running", "running", "running", "running"]);
    const pc = await ask("PC", { host: "host:h2" });
    const hurry = await ask("P", { host: "host:h2", priority: 9, ...urgent });
    assert.deepEqual([pc.state, hurry.state], ["waiting", "waiting"]);
    return { p, pc, hurry };
  };

  suite("covered production takes the reserved place while improvement work waits, marked with the borrow; the ceiling stays; the view shows reason, scope, expiry, what it let in and the review date", async (c) => {
    const { admission, owner, release, clock } = c;
    const { p, pc, hurry } = await fill(c);
    const made = await c.lend();
    assert.equal(made.ended, false);
    assert.match(made.borrowId, /^brw-[a-z2-7]{20}$/);
    assert.deepEqual([made.until, made.reviewBy], [at(T0, 6), at(T0, 30)]);
    assert.equal(made.againFrom, at(T0, 12), "six hours lent, six standing again");
    // Nothing running was stopped; nothing was free, so nothing new ran yet.
    assert.equal((await admission.snapshot()).running.length, 4);
    // A place frees: without the borrow it would be kept for the waiting improvement work; with it the urgent production work takes it.
    await release(p[0]!.id);
    const w = await admission.where(hurry.id);
    assert.ok(w.state === "running" && w.entry.borrowed === made.borrowId && /emergency direction brw-/.test(w.entry.lent ?? ""), JSON.stringify(w));
    assert.equal((await admission.where(pc.id)).state, "waiting");
    const view = await admission.balance(owner);
    assert.ok(view.borrow !== undefined, JSON.stringify(view));
    assert.deepEqual({ ...view.borrow, id: "x" }, { id: "x", reason: "the release is due tonight", places: 1, from: T0, until: at(T0, 6), reviewBy: at(T0, 30), taken: 1, running: 1, lends: 1 });
    assert.equal(view.borrowedTotal, 1);
    assert.equal(view.lastBorrow, undefined);
    assert.equal(view.unmet?.short, 1, "the reserve is reported short, with its cause");
    assert.equal(view.places.ceiling, 2, "the ceiling is untouched by a borrow");
    // Improvement work still gets the next place that frees: a borrow lends, it does not shut improvement work out.
    await release(p[1]!.id);
    assert.equal((await admission.where(pc.id)).state, "running");
    assert.equal(clock.now, T0);
  });

  suite("a borrow for one project lends only to that project's production work; other production is still held for improvement work", async (c) => {
    const { admission, owner, release, allocate, ask } = c;
    // Two reserved places (50% of 4), at most three improvement attempts.
    await allocate({ "workClass.pcFloor": 50, "workClass.pcCeiling": 75 });
    const p = [await ask("P"), await ask("P"), await ask("P"), await ask("P")];
    const pc1 = await ask("PC", { host: "host:h2" }), pc2 = await ask("PC", { host: "host:h2" });
    const orchard = await ask("P", { host: "host:h2", priority: 9, project: c.orchard });
    const made = await c.lend({ projectId: c.garden });
    await release(p[0]!.id);
    assert.equal((await admission.where(pc1.id)).state, "running", "the orchard work is not covered: the place stays with improvement work");
    assert.equal((await admission.where(orchard.id)).state, "waiting");
    const garden = await ask("P", { host: "host:h2", priority: 9 });
    await release(p[1]!.id);
    const g = await admission.where(garden.id);
    assert.ok(g.state === "running" && g.entry.borrowed === made.borrowId, `the garden work is covered and takes the one borrowed place, ahead of the older orchard work: ${JSON.stringify(g)}`);
    assert.deepEqual([(await admission.where(orchard.id)).state, (await admission.where(pc2.id)).state], ["waiting", "waiting"]);
    // The borrow lends one place: with one improvement attempt and one borrowed place, the reserve of two is spoken for, so production may use the other two places and no more.
    const garden2 = await ask("P", { host: "host:h2", priority: 9 });
    await release(p[2]!.id);
    assert.deepEqual([(await admission.where(pc2.id)).state, (await admission.where(garden2.id)).state], ["waiting", "running"]);
    const garden3 = await ask("P", { host: "host:h2", priority: 9 });
    await release(pc1.id);
    assert.deepEqual([(await admission.where(pc2.id)).state, (await admission.where(garden3.id)).state], ["running", "waiting"], "three production attempts (two places plus the one lent) is the most: the freed place goes back to improvement work");
    const snap = await admission.snapshot();
    assert.deepEqual([snap.running.filter((e) => (e.workClass ?? "P") === "P").length, snap.running.filter((e) => e.workClass === "PC").length], [3, 1]);
    const view = await admission.balance(owner);
    assert.deepEqual([view.borrow?.project, view.borrow?.taken, view.borrow?.running, view.borrowedTotal], [c.garden, 2, 2, 2], "each admission the borrow made possible is counted");
  });

  suite("at its expiry the borrow stops counting by the clock with nothing written; a restarted service sees the same; borrowed work keeps running and its place goes back to improvement work", async (c) => {
    const { admission, owner, release, clock, reopen } = c;
    const { p, pc, hurry } = await fill(c);
    const made = await c.lend();
    await release(p[0]!.id);
    assert.equal((await admission.where(hurry.id)).state, "running");
    // Restart while it is in force: the new service reads the borrow from the record.
    const again = reopen();
    assert.equal((await again.balance(owner)).borrow?.id, made.borrowId);
    clock.now = at(T0, 6);
    const revision = (await admission.snapshot()).revision;
    const view = await again.balance(owner);
    assert.equal(view.borrow, undefined, "expired by the clock");
    assert.equal(view.lastBorrow?.id, made.borrowId);
    assert.deepEqual([view.lastBorrow?.ended, view.lastBorrow?.taken, view.lastBorrow?.running, view.lastBorrow?.againFrom, view.lastBorrow?.endedAt], [at(T0, 6), 1, 1, at(T0, 12), undefined]);
    assert.equal((await admission.snapshot()).revision, revision, "reading wrote nothing");
    assert.equal((await again.where(hurry.id)).state, "running", "nothing running is stopped at expiry");
    // Production arriving now is held for the waiting improvement work again.
    const late = await c.ask("P", { host: "host:h2", priority: 9 }, again);
    await release(hurry.id, again);
    assert.equal((await again.where(pc.id)).state, "running", "the borrowed place came back to improvement work when its attempt ended");
    assert.equal((await again.where(late.id)).state, "waiting");
  });

  suite("repeated urgency cannot remove the floor: one borrow at a time, never extended; after it ends the floor stands as long as it was lent; ending early counts the real length; each refusal names the way out", async (c) => {
    const { admission, clock, allocate } = c;
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const first = await c.lend();
    await refuses("invalid_command", () => c.lend(), /is in force until .*never extended or stacked.*lower workClass\.pcFloor itself/);
    clock.now = at(T0, 2);
    const ended = await c.lend({ ...{}, reason: undefined, places: undefined, until: undefined, reviewBy: undefined, end: true });
    assert.deepEqual([ended.borrowId, ended.ended, ended.until, ended.againFrom], [first.borrowId, true, at(T0, 2), at(T0, 4)]);
    await refuses("invalid_command", () => c.lend(), /lent from .* and stands again for as long, until 2026-11-27T19:00:00.000Z, so repeated urgency cannot remove it; .*lower workClass\.pcFloor itself/);
    clock.now = at(T0, 3.99);
    await refuses("invalid_command", () => c.lend());
    clock.now = at(T0, 4);
    const second = await c.lend({ until: at(T0, 4 + BORROW_MAX_HOURS), reviewBy: at(T0, 4 + BORROW_MAX_HOURS + 24) });
    assert.equal(second.againFrom, at(T0, 4 + 2 * BORROW_MAX_HOURS));
    const END = { end: true, reason: undefined, places: undefined, until: undefined, reviewBy: undefined };
    await c.lend(END);
    await refuses("invalid_command", () => c.lend(END), /nothing to end/);
    // The record keeps a bounded list.
    const kept = (await admission.snapshot()).borrows ?? [];
    assert.ok(kept.length === 2 && kept.length <= BORROWS_KEPT);
  });

  suite("the direction must be explicit and bounded: reason, places, expiry and review date checked; no reserve or more places than it keeps is refused; an unknown project is refused; only the owner", async (c) => {
    const { owner, agent, allocate, clock } = c;
    const L = (extra: Record<string, unknown>) => c.lend(extra);
    await refuses("invalid_command", () => L({}), /there is nothing to borrow: the improvement floor \(workClass\.pcFloor\) keeps no place/);
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    await refuses("invalid_command", () => L({ reason: "" }), /^reason:/);
    await refuses("invalid_command", () => L({ reason: "x".repeat(301) }), /^reason:/);
    await refuses("invalid_command", () => L({ reason: undefined }), /^reason:/);
    await refuses("invalid_command", () => L({ places: 0 }), /^places:/);
    await refuses("invalid_command", () => L({ places: 1.5 }), /^places:/);
    await refuses("invalid_command", () => L({ places: 2 }), /^places: the floor keeps 1 place\(s\) for improvement work; borrow at most that many, or lower workClass\.pcFloor/);
    await refuses("invalid_command", () => L({ until: "2026-11-28" }), /^until: must be a date and time with its time zone/);
    await refuses("invalid_command", () => L({ until: "2026-11-28T10:00:00" }), /^until: must be a date and time with its time zone/);
    await refuses("invalid_command", () => L({ until: T0 }), /^until: must be after now/);
    await refuses("invalid_command", () => L({ until: at(T0, BORROW_MAX_HOURS + 0.01), reviewBy: at(T0, 100) }), new RegExp(`^until: a borrow lasts at most ${BORROW_MAX_HOURS} hours \\(until ${at(T0, BORROW_MAX_HOURS)} at the latest\\)`));
    await refuses("invalid_command", () => L({ reviewBy: at(T0, 5) }), /^reviewBy: must be on or after until/);
    await refuses("invalid_command", () => L({ reviewBy: at(T0, 6 + 30 * 24 + 1) }), /^reviewBy: .*at most 30 days after it/);
    await refuses("invalid_command", () => L({ projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }), /^projectId: proj-a+ is not a project/);
    await refuses("invalid_command", () => L({ projectId: "Garden" }), /^projectId:/);
    await refuses("invalid_command", () => L({ end: false }), /^end:/);
    await refuses("invalid_command", () => L({ end: true }), /is not used when ending a borrow/);
    await refuses("invalid_command", () => L({ hours: 3 }));
    await refuses("forbidden", () => c.admission.borrow(agent, { commandId: cid("b"), reason: "r", places: 1, until: at(T0, 1), reviewBy: at(T0, 2) }));
    await refuses("forbidden", () => c.admission.borrow({ ...owner, taskScope: { taskId: "task-x", projectId: c.garden } }, { commandId: cid("b"), reason: "r", places: 1, until: at(T0, 1), reviewBy: at(T0, 2) }));
    // A time with an offset is the same instant in UTC.
    const ok = await L({ until: "2026-11-27T12:00:00-05:00", reviewBy: "2026-11-30T09:00:00-05:00" });
    assert.deepEqual([ok.until, ok.reviewBy], ["2026-11-27T17:00:00.000Z", "2026-11-30T14:00:00.000Z"]);
    assert.equal(clock.now, T0);
  });

  suite("exactly once: a repeated command ID answers with the same borrow and writes nothing; another direction under the same ID is a conflict; two controllers borrowing at once start only one", async (c) => {
    const { admission, allocate, reopen } = c;
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const first = await c.lend({}, admission, "same");
    const revision = (await admission.snapshot()).revision;
    const repeat = await c.lend({}, reopen(), "same");
    assert.deepEqual([repeat.borrowId, repeat.replayed, first.replayed], [first.borrowId, true, false]);
    assert.equal((await admission.snapshot()).revision, revision);
    await refuses("command_conflict", () => c.lend({ places: 1, reason: "something else" }, admission, "same"));
    await c.lend({ end: true, reason: undefined, places: undefined, until: undefined, reviewBy: undefined }, admission, "end-1");
    c.clock.now = at(T0, 1);
    const settled = await Promise.allSettled([c.lend({}, admission, "race-a"), c.lend({}, reopen(), "race-b")]);
    // The first borrow lasted no time at all (ended at T0), so the rest is over at once; exactly one of the two racing borrows starts.
    assert.equal(settled.filter((s) => s.status === "fulfilled").length, 1, JSON.stringify(settled.map((s) => s.status === "rejected" ? String(s.reason) : "ok")));
  });

  suite("damaged stored borrows admit nothing new and are never read as no borrow; release still frees the place; the view and the wait reason say so", async (c) => {
    const { admission, owner, release, allocate } = c;
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const running = await c.ask("P");
    await c.lend();
    // Damage the record the way only an outside writer could: a borrow with no reason.
    const stored = await admission.snapshot();
    const { revision: _r, ...body } = stored; void _r;
    const broken = { ...body, borrows: [{ ...stored.borrows![0]!, reason: 42 }] };
    await damage(c.storage, c.epoch, c.clock.now, broken, "borrow-reason");
    await refuses("integrity", () => c.ask("P"), /emergency borrows stored in the admission record are damaged/);
    const view = await admission.balance(owner);
    assert.match(view.borrowProblem ?? "", /cannot be read, so nothing new is admitted until they are repaired/);
    await release(running.id);
    assert.equal((await admission.snapshot()).running.length, 0, "release still works");
  });
}

/** Writes the admission record whole, as only an outside writer could (the way the damaged-record tests in chat/capacity.test.ts do it). */
async function damage(storage: ControllerStorage, epoch: number, at: string, body: object, tag: string): Promise<void> {
  const ref = { kind: "admission-state", id: "admission" };
  const found = await storage.getAggregate(ref);
  await storage.applyOperation({
    operationId: `dmg-${tag}`, epoch, actor: "owner:rob", correlationId: `dmg-${tag}`, at,
    changes: [found === undefined ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: found.revision, body }],
    audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  } as never);
}
