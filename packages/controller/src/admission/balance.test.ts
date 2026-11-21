import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/configuration.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import type { Principal } from "../security/principals.js";
import { AdmissionService, BALANCE_LENT_SHOWN, DEFAULT_LIMITS, LENT_REASON, TURN_REASON, balanceFromSettings, balancePlaces, type BalanceReader, type RequestAdmission } from "./index.js";

after(stopServer);

// Card B01, first slice: production (P) and improvement (PC) work in admission. The class comes from the task's contract and is fixed on the request; the owner's allocation is the installation
// settings workClass.pcFloor and workClass.pcCeiling, read at every decision through the real configuration service on the same storage.
const options = { clock: () => "2026-11-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const BIG = { cpus: 64, memoryMb: 262_144 };

test("the allocation as places: the ceiling always leaves production one place, a floor above nothing keeps at least one, never more than the ceiling", () => {
  assert.deepEqual(balancePlaces(4, { floor: 0, ceiling: 100 }), { reserved: 0, ceiling: 3, protectedP: 1 });
  assert.deepEqual(balancePlaces(4, { floor: 25, ceiling: 50 }), { reserved: 1, ceiling: 2, protectedP: 2 });
  assert.deepEqual(balancePlaces(4, { floor: 10, ceiling: 50 }), { reserved: 1, ceiling: 2, protectedP: 2 }, "10% of 4 places rounds up to one");
  assert.deepEqual(balancePlaces(4, { floor: 100, ceiling: 100 }), { reserved: 3, ceiling: 3, protectedP: 1 });
  assert.deepEqual(balancePlaces(4, { floor: 0, ceiling: 0 }), { reserved: 0, ceiling: 0, protectedP: 4 });
  assert.deepEqual(balancePlaces(1, { floor: 50, ceiling: 100 }), { reserved: 1, ceiling: 1, protectedP: 0 }, "a single place: the two take turns");
  assert.deepEqual(balancePlaces(10, { floor: 20, ceiling: 30 }), { reserved: 2, ceiling: 3, protectedP: 7 });
  // A share the owner allows is never rounded down to none: a floor above 0 always gets its place, and a ceiling above 0% lets one attempt run (0% is how the owner says never).
  assert.deepEqual(balancePlaces(4, { floor: 10, ceiling: 20 }), { reserved: 1, ceiling: 1, protectedP: 3 }, "20% of 4 places is less than one: one place, so the 10% floor is kept");
  assert.deepEqual(balancePlaces(4, { floor: 0, ceiling: 20 }), { reserved: 0, ceiling: 1, protectedP: 3 });
  assert.deepEqual(balancePlaces(1, { floor: 10, ceiling: 50 }), { reserved: 1, ceiling: 1, protectedP: 0 }, "a single place with a floor: the two take turns, improvement work is not shut out");
  assert.deepEqual(balancePlaces(1, { floor: 0, ceiling: 0 }), { reserved: 0, ceiling: 0, protectedP: 1 });
  assert.deepEqual(balancePlaces(2, { floor: 100, ceiling: 100 }), { reserved: 1, ceiling: 1, protectedP: 1 }, "a floor above what the places allow keeps production its one place");
});

test("only figures the owner set count; a damaged figure or a floor above the ceiling is damage, not a guess", async () => {
  const of = (got: Record<string, { value: unknown; set: boolean }>) => balanceFromSettings(async () => got)();
  assert.equal(await of({ "workClass.pcFloor": { value: 0, set: false }, "workClass.pcCeiling": { value: 100, set: false } }), undefined, "built-in defaults are no allocation");
  assert.deepEqual(await of({ "workClass.pcFloor": { value: 20, set: true }, "workClass.pcCeiling": { value: 100, set: false } }), { floor: 20, ceiling: 100 });
  assert.deepEqual(await of({ "workClass.pcCeiling": { value: 40, set: true } }), { floor: 0, ceiling: 40 });
  await refuses("integrity", () => of({ "workClass.pcFloor": { value: 2.5, set: true } }));
  await refuses("integrity", () => of({ "workClass.pcFloor": { value: "20", set: true } }));
  await refuses("integrity", () => of({ "workClass.pcFloor": { value: 60, set: true }, "workClass.pcCeiling": { value: 40, set: true } }), (e) => assert.match(e.message, /floor \(60%\) is above its ceiling \(40%\)/));
});

for (const backend of backends) {
  interface Ctx {
    admission: AdmissionService; owner: Principal; agent: Principal;
    reopen(over?: { balance?: BalanceReader }): AdmissionService;
    allocate(set: Record<string, number>, remove?: string[]): Promise<void>;
    ask(workClass: "P" | "PC" | undefined, extra?: Partial<RequestAdmission>, on?: AdmissionService): Promise<{ id: string; state: string }>;
    release(id: string, on?: AdmissionService): Promise<void>;
    classes(): Promise<{ running: string[]; waiting: string[] }>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: P/PC admission (card B01): ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        for (const h of ["h1", "h2"]) await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: h, grants: [] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const configuration = ConfigurationService.withEpoch(world.storage, projects.epoch, options);
        const reopen = (over: { balance?: BalanceReader } = {}) => AdmissionService.withEpoch(world.storage, projects.epoch, { ...options, ...over });
        const admission = reopen();
        await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: BIG });
        await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h2", capacity: BIG });
        // Four places on one host, so only the P/PC rules decide.
        await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, perHost: 4 } });
        let layer = 0;
        const allocate = async (set: Record<string, number>, remove: string[] = []) => {
          const staged = await configuration.stage(owner, { commandId: cid("cfg"), layer: "installation", ...(layer === 0 ? {} : { expectedRevision: layer }), set, ...(remove.length === 0 ? {} : { remove }) });
          const applied = await configuration.apply(owner, { commandId: cid("cfa"), layer: "installation", expectedRevision: staged.revision });
          assert.ok(applied.applied, JSON.stringify(applied.problems));
          layer = applied.revision;
        };
        const ask = (workClass: "P" | "PC" | undefined, extra: Partial<RequestAdmission> = {}, on = admission) => on.request({ commandId: cid("r"), actor: "dispatcher", class: "productive", host: "host:h1", cpus: 1, memoryMb: 512, ...(workClass === undefined ? {} : { workClass }), ...extra } as RequestAdmission);
        const release = async (id: string, on = admission) => { await on.release({ commandId: cid("rel"), actor: "dispatcher", requestId: id, reason: "done" }); };
        const classes = async () => { const s = await admission.snapshot(); return { running: s.running.map((e) => e.workClass ?? "P").sort(), waiting: s.queue.map((e) => e.workClass ?? "P").sort() }; };
        await body({ admission, owner, agent, reopen, allocate, ask, release, classes });
      } finally { await world.close(); }
    });

  suite("with no allocation set the class changes nothing; the view says no allocation is set", async ({ admission, owner, ask, classes }) => {
    for (let i = 0; i < 4; i++) assert.equal((await ask("PC")).state, "running");
    assert.equal((await ask("P")).state, "waiting");
    assert.deepEqual(await classes(), { running: ["PC", "PC", "PC", "PC"], waiting: ["P"] });
    const view = await admission.balance(owner);
    assert.equal(view.allocation, undefined);
    assert.deepEqual([view.running, view.waiting, view.lentTotal, view.unmet], [{ P: 0, PC: 4 }, { P: 1, PC: 0 }, 0, undefined]);
  });

  suite("a reserved place is lent to production while no improvement work waits, comes back when that attempt ends, and production cannot take it while improvement work waits", async ({ admission, owner, allocate, ask, release }) => {
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const p = [await ask("P"), await ask("P"), await ask("P")];
    assert.deepEqual(p.map((x) => x.state), ["running", "running", "running"]);
    const lent = await ask("P");
    assert.equal(lent.state, "running", "no improvement work waits, so the reserved place is lent");
    const where = await admission.where(lent.id);
    assert.ok(where.state === "running" && where.entry.lent === LENT_REASON, JSON.stringify(where));
    for (const x of p) { const w = await admission.where(x.id); assert.ok(w.state === "running" && w.entry.lent === undefined, "places outside the reserve are not lent"); }
    // Improvement work arrives: every place is taken, nothing running is stopped, and the view says why the reserve is short.
    // On the other host, so that only the full lane (not a full host) holds it.
    const pc = await ask("PC", { host: "host:h2" });
    assert.equal(pc.state, "waiting");
    let view = await admission.balance(owner);
    assert.deepEqual([view.places, view.running, view.waiting, view.lentTotal], [{ productive: 4, reserved: 1, ceiling: 2, protectedP: 2 }, { P: 4, PC: 0 }, { P: 0, PC: 1 }, 1]);
    assert.equal(view.lent[0]!.requestId, lent.id);
    assert.equal(view.unmet?.short, 1);
    assert.match(view.unmet!.cause, /every productive place is taken \(4 production, 0 improvement\); 1 production attempt was lent a reserved place .* comes back as it ends; nothing running is stopped/);
    // A higher-priority production request does not take the next free place from the waiting improvement work.
    const urgent = await ask("P", { priority: 9, host: "host:h2" });
    assert.equal(urgent.state, "waiting");
    const full = await admission.where(urgent.id);
    assert.ok(full.state === "waiting" && full.balanceReason === undefined, `no place is free, so the lane holds it, not the reserve: ${JSON.stringify(full)}`);
    await release(p[0]!.id);
    assert.equal((await admission.where(pc.id)).state, "running", "the freed place went to the improvement work");
    const held = await admission.where(urgent.id);
    assert.ok(held.state === "waiting", JSON.stringify(held));
    assert.match(held.reason ?? "", /waiting for capacity: 4 productive attempts are already running/);
    // The reserve is met now, so the next place is production's again: the lent attempt ends and the urgent work takes its place (not lent: nothing is owed any more).
    await release(lent.id);
    const now = await admission.where(urgent.id);
    assert.ok(now.state === "running" && now.entry.lent === undefined, JSON.stringify(now));
    view = await admission.balance(owner);
    assert.deepEqual([view.running, view.lentTotal, view.unmet], [{ P: 3, PC: 1 }, 0, undefined]);
  });

  suite("a continuous production backlog cannot starve improvement work, and production waits with the reason in words", async ({ admission, allocate, ask, release }) => {
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const running = [await ask("P"), await ask("P"), await ask("P")].map((x) => x.id);
    const pc = await ask("PC");
    assert.equal(pc.state, "running", "the fourth place is kept for it");
    const backlog = await Promise.all(Array.from({ length: 6 }, () => ask("P", { priority: 9 })));
    assert.ok(backlog.every((x) => x.state === "waiting"));
    // Each time an improvement attempt ends while improvement work waits, its place goes to improvement work, however high production's priority.
    let current = pc.id;
    for (let round = 0; round < 3; round++) {
      const next = await ask("PC");
      assert.equal(next.state, "waiting");
      const why = await admission.where(next.id);
      assert.match(why.state === "waiting" ? why.reason ?? "" : "", /4 productive attempts are already running/);
      await release(current);
      assert.equal((await admission.where(next.id)).state, "running", `round ${round}: improvement work got its reserved place back`);
      current = next.id;
    }
    // Production in the backlog still gets every place outside the reserve.
    await release(running[0]!);
    assert.equal((await admission.snapshot()).running.filter((e) => (e.workClass ?? "P") === "P").length, 3);
  });

  suite("the ceiling caps improvement work and production keeps its protected share under a continuous improvement backlog", async ({ admission, owner, allocate, ask, release, classes }) => {
    await allocate({ "workClass.pcCeiling": 100 });
    const pcs = await Promise.all(Array.from({ length: 6 }, () => ask("PC")));
    assert.deepEqual(await classes(), { running: ["PC", "PC", "PC"], waiting: ["PC", "PC", "PC"] }, "a ceiling of 100% still leaves production one place");
    const waiting = pcs.find((x) => x.state === "waiting")!;
    const why = await admission.where(waiting.id);
    assert.ok(why.state === "waiting");
    assert.match(why.balanceReason ?? "", /3 improvement \(PC\) attempts are already running, the most the owner's P\/PC allocation allows \(workClass.pcCeiling 100% of 4 places, less one place always kept for production\)/);
    assert.equal(why.reason, why.balanceReason, "the allocation is what holds it, and the plain reason says so");
    assert.equal((await ask("P")).state, "running", "production is admitted at once into its protected place");
    // An allocation change is a revision for what is still pending: a lower ceiling stops nothing running, and the next decision counts it.
    await allocate({ "workClass.pcCeiling": 25 });
    assert.deepEqual((await classes()).running, ["P", "PC", "PC", "PC"], "nothing running was stopped");
    await release(pcs.find((x) => x.state === "running")!.id);
    assert.deepEqual((await classes()).running, ["P", "PC", "PC"], "the freed place is not given to improvement work over the new ceiling");
    const view = await admission.balance(owner);
    assert.deepEqual([view.allocation, view.places.ceiling, view.running.PC], [{ floor: 0, ceiling: 25 }, 1, 2]);
  });

  suite("a ceiling or floor smaller than one place still lets improvement work run: never shut out by rounding", async ({ admission, allocate, ask, release }) => {
    await allocate({ "workClass.pcFloor": 10, "workClass.pcCeiling": 20 });
    for (let i = 0; i < 3; i++) assert.equal((await ask("P")).state, "running");
    const pc = await ask("PC");
    assert.equal(pc.state, "running", "20% of 4 places still lets one improvement attempt run");
    const second = await ask("PC");
    assert.equal(second.state, "waiting");
    await release(pc.id);
    assert.equal((await admission.where(second.id)).state, "running", "the place kept for improvement work (10% of 4 rounds up to one) goes to it");
    const third = await ask("PC");
    const why = await admission.where(third.id);
    assert.ok(why.state === "waiting");
    assert.match(why.balanceReason ?? "", /1 improvement \(PC\) attempt is already running, the most the owner's P\/PC allocation allows \(workClass.pcCeiling 20% of 4 places, rounded up to one place so a ceiling above 0% lets improvement work run\)/);
  });

  suite("a reserved place is lent rather than left empty when the only improvement work that could use it is held back behind older work that has waited too long", async ({ admission, allocate, ask, release }) => {
    // One small host (h1, 4 CPUs) and a big one; four places, patience 1 so one skip makes a request first in line.
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 4, memoryMb: 65_536 } });
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, perHost: 4, patience: 1 } });
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const onH1 = await ask("P", { cpus: 2 });
    await ask("P", { host: "host:h2" }); await ask("P", { host: "host:h2" });
    const bigPC = await ask("PC", { cpus: 3 });
    assert.equal(bigPC.state, "waiting", "h1 has no room for 3 more CPUs");
    const smallPC = await ask("PC", { cpus: 1 });
    assert.equal(smallPC.state, "running", "the small one fits h1 and passes the big one, which is now first in line for h1");
    const smallPC2 = await ask("PC", { cpus: 1 });
    const p = await ask("P", { host: "host:h2" });
    assert.deepEqual([smallPC2.state, p.state], ["waiting", "waiting"]);
    // A place frees and is owed to improvement work, but the only improvement work that fits must let the big one go first on h1: production is lent the place instead of it standing empty.
    await release(smallPC.id);
    const lent = await admission.where(p.id);
    assert.ok(lent.state === "running" && lent.entry.lent === LENT_REASON, JSON.stringify(lent));
    assert.equal((await admission.where(smallPC2.id)).state, "waiting");
    // h1 frees: the big improvement request goes first, as its wait earned.
    await release(onH1.id);
    assert.equal((await admission.where(bigPC.id)).state, "running");
  });

  suite("with a single place the two kinds take turns, and production that takes it in turn is marked so", async ({ admission, allocate, ask, release }) => {
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, productive: 1, perHost: 1 } });
    await allocate({ "workClass.pcFloor": 100, "workClass.pcCeiling": 100 });
    const first = await ask("PC");
    const p = await ask("P");
    const pcs = [first.id];
    for (let i = 0; i < 8; i++) pcs.push((await ask("PC")).id);
    let runningId = first.id;
    let turn = -1;
    for (let round = 0; round < 8 && turn < 0; round++) {
      await release(runningId);
      const s = await admission.snapshot();
      runningId = s.running[0]!.id;
      if (runningId === p.id) turn = round;
    }
    assert.ok(turn >= 0 && turn <= DEFAULT_LIMITS.patience, `production got the place after ${turn} improvement attempts, within the patience of ${DEFAULT_LIMITS.patience}`);
    const w = await admission.where(p.id);
    assert.ok(w.state === "running" && w.entry.lent === TURN_REASON, JSON.stringify(w));
  });

  suite("inquiries and reviews are never counted: a class on them is refused, and they run whatever the allocation", async ({ allocate, ask, classes }) => {
    await allocate({ "workClass.pcFloor": 50, "workClass.pcCeiling": 50 });
    await refuses("invalid_command", () => ask("PC", { class: "review" }), (e) => assert.match(e.message, /inquiries and reviews are neither/));
    await refuses("invalid_command", () => ask("X" as never), (e) => assert.match(e.message, /workClass: must be P or PC/));
    for (let i = 0; i < 4; i++) await ask("P");
    assert.equal((await ask(undefined, { class: "review" })).state, "running", "a production review runs in the control lane");
    assert.equal((await ask(undefined, { class: "inquiry" })).state, "running");
    assert.deepEqual((await classes()).running.length, 6);
  });

  suite("an allocation that cannot be read admits nothing new; release still works and frees the place; the error text is fixed, never the reader's", async ({ admission, owner, reopen, ask, release }) => {
    const a = await ask("P");
    const b = await ask("PC");
    const broken = reopen({ balance: async () => { throw new Error("connection to postgres://admin:hunter2@db.example/x failed"); } });
    await refuses("integrity", () => ask("P", {}, broken), (e) => { assert.equal(e.message, "the P/PC allocation settings cannot be read"); assert.doesNotMatch(e.message, /hunter2/); });
    const waiting = await ask("P");
    await ask("P");
    assert.equal((await ask("P")).state, "waiting");
    await release(a.id, broken);
    assert.equal((await broken.where(a.id)).state, "absent", "the release went through");
    const still = (await admission.snapshot()).queue.length;
    assert.equal(still, 1, "nothing was admitted on a guess");
    const w = await broken.where(waiting.id);
    assert.ok(w.state === "running" || w.state === "waiting");
    await refuses("integrity", () => broken.balance(owner));
    // A damaged figure written by a reader is passed on only after the credential scan, cut to a short line.
    const damaged = reopen({ balance: async () => { throw new DomainError("integrity", `the P/PC allocation setting is damaged: sk-ant-api03-${"x".repeat(40)} ${"y".repeat(400)}`); } });
    await refuses("integrity", () => damaged.balance(owner), (e) => { assert.doesNotMatch(e.message, /sk-ant-api03-x{20}/); assert.ok(e.message.length <= 200); });
    await release(b.id, damaged);
  });

  suite("lent marks and the allocation survive a restart; a new service decides exactly as the old one would", async ({ owner, reopen, allocate, ask }) => {
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    for (let i = 0; i < 3; i++) await ask("P");
    const lent = await ask("P");
    const again = reopen();
    const view = await again.balance(owner);
    assert.deepEqual(view.lent.map((l) => [l.requestId, l.reason]), [[lent.id, LENT_REASON]]);
    const pc = await ask("PC", {}, again);
    assert.equal(pc.state, "waiting");
    const p = await ask("P", { priority: 9 }, again);
    await again.release({ commandId: cid("rel"), actor: "dispatcher", requestId: lent.id, reason: "done" });
    assert.equal((await again.where(pc.id)).state, "running", "the reclaimed place went to improvement work after the restart");
    assert.equal((await again.where(p.id)).state, "waiting");
  });

  suite("two controllers deciding at once never exceed the ceiling or give a reserved place to production", async ({ admission, owner, reopen, allocate, ask, classes }) => {
    await allocate({ "workClass.pcFloor": 25, "workClass.pcCeiling": 50 });
    const other = reopen();
    const asked = await Promise.all(Array.from({ length: 12 }, (_, i) => ask(i % 3 === 0 ? "P" : "PC", {}, i % 2 === 0 ? admission : other)));
    assert.equal(asked.length, 12);
    // Whatever order the twelve decisions landed in: four run, improvement work never over its ceiling, and the reserved place is either used by improvement work or lent with a reason.
    const now = await classes();
    assert.equal(now.running.length, 4);
    const pcRunning = now.running.filter((c) => c === "PC").length;
    assert.ok(pcRunning <= 2, `at most the ceiling of improvement work runs (${pcRunning})`);
    let view = await other.balance(owner);
    assert.ok(pcRunning >= 1 || view.lentTotal >= 1, JSON.stringify(view));
    // Every production attempt ends, from both controllers at once: improvement work gets exactly its ceiling, never more.
    const snapshot = await admission.snapshot();
    await Promise.all(snapshot.running.filter((e) => (e.workClass ?? "P") === "P").map((e, i) => (i % 2 === 0 ? admission : other).release({ commandId: cid("rel"), actor: "dispatcher", requestId: e.id, reason: "done" })));
    view = await admission.balance(owner);
    assert.equal(view.running.PC, 2, JSON.stringify(view));
    const pWaiting = snapshot.queue.filter((e) => (e.workClass ?? "P") === "P").length;
    assert.equal(view.running.P, Math.min(2, pWaiting), "production fills only its own places");
    assert.equal(view.unmet, undefined);
  });

  suite("only the owner reads the balance; the lent list is bounded", async ({ admission, owner, agent, allocate, ask }) => {
    await refuses("forbidden", () => admission.balance(agent));
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, productive: 30, perHost: 16 } });
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h2", capacity: BIG });
    await allocate({ "workClass.pcFloor": 100, "workClass.pcCeiling": 100 });
    for (let i = 0; i < 25; i++) assert.equal((await ask("P", { host: i < 15 ? "host:h1" : "host:h2" })).state, "running");
    const view = await admission.balance(owner);
    assert.equal(view.places.reserved, 29);
    assert.ok(view.lentTotal >= 20 && view.lent.length === Math.min(view.lentTotal, BALANCE_LENT_SHOWN), JSON.stringify([view.lentTotal, view.lent.length]));
  });
}
