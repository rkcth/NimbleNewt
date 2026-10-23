import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { AdmissionService, DEFAULT_LIMITS, type RequestAdmission } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const BIG = { cpus: 64, memoryMb: 262_144 };

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    admission: AdmissionService; reopen(): AdmissionService; disableHost(name: string): Promise<void>;
    ask(extra?: Partial<RequestAdmission>): Promise<{ id: string; state: string; replayed: boolean }>;
    kinds(): Promise<{ running: string[]; waiting: string[] }>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        for (const h of ["h1", "h2", "off"]) await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: h, grants: [] });
        const admission = AdmissionService.withEpoch(world.storage, projects.epoch, options);
        await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: BIG });
        await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h2", capacity: BIG });
        const ask = (extra: Partial<RequestAdmission> = {}) => admission.request({ commandId: cid("r"), actor: "controller", class: "productive", host: "host:h1", cpus: 1, memoryMb: 1024, ...extra } as RequestAdmission);
        const kinds = async () => { const s = await admission.snapshot(); return { running: s.running.map((e) => e.id), waiting: s.queue.map((e) => e.id) }; };
        await body({ disableHost: async (name) => { const stored = (await principals.get(`host:${name}`))!; await principals.disable(owner, { commandId: cid("d"), principalId: `host:${name}`, expectedRevision: stored.revision }); }, admission, reopen: () => AdmissionService.withEpoch(world.storage, projects.epoch, options), ask, kinds });
      } finally { await world.close(); }
    });
  const release = (a: AdmissionService, id: string) => a.release({ commandId: cid("rel"), actor: "controller", requestId: id, reason: "done" });

  suite("four productive attempts in total and two per host; the rest wait in order", async ({ ask, kinds, admission }) => {
    assert.deepEqual(DEFAULT_LIMITS, { productive: 4, perHost: 2, control: 2, queue: 100, depth: 3, children: 4, patience: 5 });
    const a = await ask({ host: "host:h1" });
    const b = await ask({ host: "host:h1" });
    const third = await ask({ host: "host:h1" });
    assert.deepEqual([a.state, b.state, third.state], ["running", "running", "waiting"], "the third on one host waits though the total is far from four");
    const c = await ask({ host: "host:h2" });
    const d = await ask({ host: "host:h2" });
    const fifth = await ask({ host: "host:h2" });
    assert.deepEqual([c.state, d.state, fifth.state], ["running", "running", "waiting"]);
    assert.equal((await kinds()).running.length, 4);
    await release(admission, a.id);
    const now = await kinds();
    assert.equal(now.running.length, 4, "the freed place went to the waiting request on the same host");
    assert.ok(now.running.includes(third.id));
    assert.deepEqual(now.waiting, [fifth.id]);
  });

  suite("inquiries and reviews have places productive work can never take, and cannot take productive places", async ({ ask, admission, kinds }) => {
    for (let i = 0; i < 4; i++) await ask({ host: i < 2 ? "host:h1" : "host:h2" });
    for (let i = 0; i < 5; i++) await ask({ host: "host:h1" });
    assert.equal((await kinds()).running.length, 4);
    const inquiry = await ask({ class: "inquiry", host: undefined as never });
    const review = await ask({ class: "review", host: undefined as never });
    assert.deepEqual([inquiry.state, review.state], ["running", "running"], "admitted at once although every productive place is taken");
    const third = await ask({ class: "inquiry", host: undefined as never });
    assert.equal(third.state, "waiting", "the reserve is two, not unlimited");
    const s = await admission.snapshot();
    assert.equal(s.running.filter((e) => e.class === "productive").length, 4);
    await release(admission, inquiry.id);
    assert.equal((await admission.where(third.id)).state, "running", "a freed reserved place goes to the next control request");
    // Freeing a control place does not let productive work in.
    assert.equal((await kinds()).waiting.length, 5);
  });

  suite("higher priority goes first, equal priority in arrival order, and nothing waits for ever", async ({ ask, admission, kinds }) => {
    const runners = [await ask({ host: "host:h1" }), await ask({ host: "host:h1" }), await ask({ host: "host:h2" }), await ask({ host: "host:h2" })];
    const low = await ask({ host: "host:h1", priority: 1 });
    const mid1 = await ask({ host: "host:h1", priority: 5 });
    const mid2 = await ask({ host: "host:h1", priority: 5 });
    const high = await ask({ host: "host:h1", priority: 9 });
    assert.equal((await admission.where(high.id)).state === "waiting" && (await admission.where(high.id) as { position: number }).position, 1);
    await release(admission, runners[0]!.id);
    assert.ok((await kinds()).running.includes(high.id), "highest priority first");
    await release(admission, runners[1]!.id);
    assert.ok((await kinds()).running.includes(mid1.id), "then arrival order among equals");
    void mid2;
  });

  suite("reprioritizing waiting requests reorders the queue at the next decision, leaves running ones alone, and keeps arrival order among equals", async ({ ask, admission, kinds }) => {
    const runners = [await ask({ host: "host:h1" }), await ask({ host: "host:h1" }), await ask({ host: "host:h2" }), await ask({ host: "host:h2" })];
    const a = await ask({ host: "host:h1", priority: 5 });
    const b = await ask({ host: "host:h1", priority: 5 });
    const c = await ask({ host: "host:h1", priority: 5 });
    const positions = async (): Promise<(number | undefined)[]> => Promise.all([a, b, c].map(async (r) => { const w = await admission.where(r.id); return w.state === "waiting" ? w.position : undefined; }));
    assert.deepEqual(await positions(), [1, 2, 3]);
    assert.equal((await kinds()).waiting.length, 3);
    const cmd = cid("rp");
    const first = await admission.reprioritize({ commandId: cmd, actor: "controller", changes: [{ requestId: c.id, priority: 9 }, { requestId: runners[0]!.id, priority: 0 }, { requestId: "req-aaaaaaaaaaaaaaaaaaaa", priority: 3 }] });
    assert.deepEqual(first, { changed: 1, unchanged: 1, missing: 1 });
    assert.deepEqual(await positions(), [2, 3, 1], "the raised request is served first; the others keep arrival order");
    assert.equal((await admission.snapshot()).running.find((e) => e.id === runners[0]!.id)!.priority, 5, "a running request is not touched");
    // Repeating the command changes nothing; the same priorities again are no change.
    await admission.reprioritize({ commandId: cmd, actor: "controller", changes: [{ requestId: c.id, priority: 9 }, { requestId: runners[0]!.id, priority: 0 }, { requestId: "req-aaaaaaaaaaaaaaaaaaaa", priority: 3 }] });
    assert.deepEqual(await admission.reprioritize({ commandId: cid("rp"), actor: "controller", changes: [{ requestId: c.id, priority: 9 }] }), { changed: 0, unchanged: 1, missing: 0 });
    await release(admission, runners[0]!.id);
    assert.equal((await admission.where(c.id)).state, "running", "the freed place went to the raised request");
    await refuses("invalid_command", () => admission.reprioritize({ commandId: cid("rp"), actor: "controller", changes: [{ requestId: a.id, priority: 10 }] }));
    await refuses("invalid_command", () => admission.reprioritize({ commandId: cid("rp"), actor: "controller", changes: [{ requestId: a.id, priority: 1 }, { requestId: a.id, priority: 2 }] }));
    await refuses("invalid_command", () => admission.reprioritize({ commandId: cid("rp"), actor: "controller", changes: [] }));
  });

  suite("a steady stream of higher-priority work cannot keep a low-priority request waiting for ever", async ({ ask, admission, kinds }) => {
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, productive: 1, perHost: 1, patience: 3 } });
    const current = await ask({ host: "host:h1" });
    const low = await ask({ host: "host:h1", priority: 1 });
    let rounds = 0;
    let running = current.id;
    while ((await admission.where(low.id)).state !== "running") {
      assert.ok(++rounds <= 6, "served within a bounded number of rounds");
      await ask({ host: "host:h1", priority: 8 });
      await release(admission, running);
      running = (await kinds()).running[0]!;
    }
    assert.ok(rounds >= 3, `higher priorities did go first until the low one had been passed over ${rounds} times`);
    assert.equal(running, low.id);
  });

  suite("CPUs and memory count: a request that does not fit its host waits, one that never could is refused", async ({ ask, admission, kinds }) => {
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 4, memoryMb: 8192 } });
    const a = await ask({ host: "host:h1", cpus: 3, memoryMb: 1000 });
    const b = await ask({ host: "host:h1", cpus: 2, memoryMb: 1000 });
    assert.deepEqual([a.state, b.state], ["running", "waiting"], "3 + 2 CPUs do not fit in 4");
    const c = await ask({ host: "host:h1", cpus: 1, memoryMb: 1000 });
    assert.equal(c.state, "running", "a smaller request that fits goes ahead (and the one it passed is counted)");
    assert.equal((await admission.snapshot()).queue[0]!.skipped, 1);
    const m = await ask({ host: "host:h2", cpus: 1, memoryMb: 200_000 });
    const m2 = await ask({ host: "host:h2", cpus: 1, memoryMb: 100_000 });
    assert.deepEqual([m.state, m2.state], ["running", "waiting"], "memory is counted too");
    await refuses("invalid_command", () => ask({ host: "host:h1", cpus: 5, memoryMb: 100 }), (e) => assert.match(e.message, /can never run/));
    await refuses("invalid_command", () => ask({ host: "host:h1", cpus: 1, memoryMb: 9000 }));
    await refuses("invalid_command", () => ask({ host: "host:off" }), (e) => assert.match(e.message, /no capacity has been declared/));
    await refuses("invalid_command", () => ask({ host: "host:ghost" }), (e) => assert.match(e.message, /not an active host/));
    await refuses("invalid_command", () => ask({ host: undefined as never }), (e) => assert.match(e.message, /required for productive/));
    void kinds;
  });

  suite("a starved request holds back later ones until it fits", async ({ ask, admission, kinds }) => {
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, patience: 2, perHost: 4 } });
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 4, memoryMb: 100_000 } });
    const first = await ask({ host: "host:h1", cpus: 2 });
    const second = await ask({ host: "host:h1", cpus: 1 });
    const big = await ask({ host: "host:h1", cpus: 4 });
    assert.equal(big.state, "waiting");
    // Smaller requests keep jumping past the big one until it has been passed over twice, then they must wait behind it.
    const jumpers: string[] = [];
    for (let i = 0; i < 4; i++) { const r = await ask({ host: "host:h1", cpus: 1 }); jumpers.push(r.state); }
    assert.deepEqual(jumpers.slice(0, 1), ["running"]);
    assert.ok(jumpers.includes("waiting"), `after being passed over twice the big request holds the rest back: ${jumpers.join()}`);
    let guard = 0;
    while ((await admission.where(big.id)).state !== "running") {
      assert.ok(++guard < 10, "the big request is served once the host drains");
      await release(admission, (await kinds()).running.find((id) => id !== big.id)!);
    }
    void first; void second;
  });

  suite("a starved request holds back only its own host: work for other hosts carries on", async ({ ask, admission }) => {
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, productive: 8, perHost: 8, patience: 1 } });
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 4, memoryMb: 100_000 } });
    const first = await ask({ host: "host:h1", cpus: 2 });
    const big = await ask({ host: "host:h1", cpus: 4 });
    assert.equal(big.state, "waiting");
    const jumper = await ask({ host: "host:h1", cpus: 1 });
    assert.equal(jumper.state, "running", "a small one on the same host goes ahead of the big one once");
    assert.equal((await admission.snapshot()).queue[0]!.skipped, 1, "and the big one is now starved (patience is 1)");
    const blocked = await ask({ host: "host:h1", cpus: 1 });
    assert.equal(blocked.state, "waiting", "later requests for h1 now wait behind it");
    // The idle host is unaffected, over and over.
    for (let i = 0; i < 6; i++) {
      const r = await ask({ host: "host:h2" });
      assert.equal(r.state, "running", `request ${i} for the other host runs at once`);
      await release(admission, r.id);
    }
    assert.equal((await admission.snapshot()).queue.find((e) => e.id === big.id)!.skipped, 1, "work on another host did not count as passing the big one over");
    // Once h1 drains, the big one runs, then the one that waited behind it.
    await release(admission, first.id);
    await release(admission, jumper.id);
    assert.equal((await admission.where(big.id)).state, "running");
    assert.equal((await admission.where(blocked.id)).state, "waiting");
    await release(admission, big.id);
    assert.equal((await admission.where(blocked.id)).state, "running");
  });

  suite("lowering a host's capacity or disabling it withdraws the waiting requests that can no longer run, with the reason, instead of leaving them for ever", async ({ ask, admission, kinds, disableHost }) => {
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 8, memoryMb: 100_000 } });
    const a = await ask({ host: "host:h1", cpus: 4 });
    const b = await ask({ host: "host:h1", cpus: 4 });
    const big = await ask({ host: "host:h1", cpus: 6 });
    const child = await ask({ host: "host:h2", cpus: 1 });
    assert.deepEqual([a.state, b.state, big.state], ["running", "running", "waiting"]);
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 5, memoryMb: 100_000 } });
    const gone = await admission.where(big.id);
    assert.equal(gone.state, "withdrawn");
    assert.match((gone as { reason: string }).reason, /can no longer hold 6 CPUs/);
    assert.deepEqual((await kinds()).running.sort(), [a.id, b.id, child.id].sort(), "running work is left alone");
    // A host that is disabled while requests wait for it.
    const w = await ask({ host: "host:h1", cpus: 1 });
    assert.equal(w.state, "waiting");
    await disableHost("h1");
    const swept = await admission.sweep({ commandId: cid("sw"), actor: "owner:rob" });
    assert.equal(swept.withdrawn, 1);
    assert.match(((await admission.where(w.id)) as { reason: string }).reason, /no longer an active host/);
    await release(admission, a.id);
    await release(admission, b.id);
    assert.equal((await kinds()).waiting.length, 0, "nothing was admitted onto the disabled host");
    // Without an explicit sweep, the next change of any kind does it too, before it admits anything.
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h2", capacity: { cpus: 1, memoryMb: 2048 } });
    await release(admission, child.id);
    const x = await ask({ host: "host:h2", cpus: 1 });
    const y = await ask({ host: "host:h2", cpus: 1 });
    assert.deepEqual([x.state, y.state], ["running", "running"].slice(0, 1).concat("waiting"), "h2 holds one at a time now");
    await disableHost("h2");
    await release(admission, x.id);
    assert.equal((await admission.where(y.id)).state, "withdrawn", "the request for a disabled host was withdrawn, not admitted when a place freed");
    assert.ok(!(await kinds()).running.includes(y.id));
  });

  suite("inquiries and reviews on a host that productive work has filled still run at once", async ({ ask, admission }) => {
    await admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host: "host:h1", capacity: { cpus: 8, memoryMb: 100_000 } });
    await ask({ host: "host:h1", cpus: 4 });
    await ask({ host: "host:h1", cpus: 4 });
    const review = await ask({ class: "review", host: "host:h1", cpus: 1 });
    const inquiry = await ask({ class: "inquiry", host: "host:h1", cpus: 2, memoryMb: 4096 });
    assert.deepEqual([review.state, inquiry.state], ["running", "running"], "host resources are not counted against the reserve");
    await refuses("invalid_command", () => ask({ class: "review", host: "host:ghost" }), (e) => assert.match(e.message, /not an active host/));
  });

  suite("reusing a command ID for a different request fails at once instead of being retried", async ({ ask }) => {
    await ask({ commandId: "fixed-id", host: "host:h1" });
    const started = Date.now();
    await refuses("command_conflict", () => ask({ commandId: "fixed-id", host: "host:h2", cpus: 2 }));
    assert.ok(Date.now() - started < 500, "no long run of retries");
  });

  suite("the queue is bounded, and a refusal leaves nothing behind", async ({ ask, admission }) => {
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, queue: 2 } });
    for (let i = 0; i < 4; i++) await ask({ host: i < 2 ? "host:h1" : "host:h2" });
    const w1 = await ask({ host: "host:h1" });
    const w2 = await ask({ host: "host:h1" });
    await refuses("unavailable", () => ask({ host: "host:h1" }), (e) => assert.match(e.message, /queue is full/));
    const s = await admission.snapshot();
    assert.deepEqual(s.queue.map((e) => e.id), [w1.id, w2.id]);
    assert.equal(s.queue.length, 2);
    // Inquiries still get in: they go to the reserve, not the full productive queue... but a control request that must wait counts against the same bound.
    assert.equal((await ask({ class: "inquiry", host: undefined as never })).state, "running");
  });

  suite("an attempt can start others only while it runs, to a depth and a number of live children; releasing it withdraws its waiting children", async ({ ask, admission, kinds }) => {
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, children: 2, depth: 2, productive: 8, perHost: 8 } });
    const root = await ask({});
    const c1 = await ask({ parent: root.id });
    const c2 = await ask({ parent: root.id });
    await refuses("invalid_command", () => ask({ parent: root.id }), (e) => assert.match(e.message, /already started 2/));
    const g1 = await ask({ parent: c1.id });
    await refuses("invalid_command", () => ask({ parent: g1.id }), (e) => assert.match(e.message, /chain of 3/));
    // A waiting request cannot start anything.
    await admission.setLimits({ commandId: cid("l2"), actor: "owner:rob", limits: { ...DEFAULT_LIMITS, productive: 3, perHost: 3, children: 4, depth: 3 } });
    const waiting = await ask({});
    assert.equal(waiting.state, "waiting");
    await refuses("invalid_command", () => ask({ parent: waiting.id }), (e) => assert.match(e.message, /is not running/));
    await refuses("invalid_command", () => ask({ parent: "req-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.match(e.message, /is not running/));
    // Releasing a parent withdraws its waiting children and leaves running ones.
    await release(admission, g1.id);
    const k = await ask({ parent: c2.id });
    assert.equal(k.state, "waiting");
    await release(admission, c2.id);
    const after = await kinds();
    assert.ok(!after.waiting.includes(k.id) && !after.running.includes(k.id), "its waiting child went with it");
    void root;
  });

  suite("stopping works however saturated the system is, and is safe to repeat", async ({ ask, admission, kinds }) => {
    const runners: string[] = [];
    for (let i = 0; i < 4; i++) runners.push((await ask({ host: i < 2 ? "host:h1" : "host:h2" })).id);
    for (let i = 0; i < 20; i++) await ask({ host: "host:h1" });
    const stop = { commandId: "stop-one", actor: "owner:rob", requestId: runners[0]!, reason: "owner pressed Stop" };
    assert.equal((await admission.release(stop)).replayed, false);
    assert.equal((await admission.release(stop)).replayed, true);
    await refuses("not_found", () => admission.release({ ...stop, commandId: cid("again") }), (e) => assert.match(e.message, /not running or waiting/));
    await refuses("invalid_command", () => admission.release({ commandId: cid("x"), actor: "owner:rob", requestId: "nope", reason: "x" }));
    await refuses("invalid_command", () => admission.release({ commandId: cid("x"), actor: "owner:rob", requestId: runners[1]!, reason: "" }));
    const s = await kinds();
    assert.equal(s.running.length, 4, "the stopped attempt's place was refilled from the queue");
    // Withdrawing a waiting request.
    await release(admission, s.waiting[0]!);
    assert.equal((await kinds()).waiting.length, 18);
  });

  suite("many requests at once never exceed the limits, and none is lost or doubled", async ({ ask, kinds }) => {
    const results = await Promise.all(Array.from({ length: 16 }, (_, i) => ask({ host: i % 2 === 0 ? "host:h1" : "host:h2" })));
    assert.equal(new Set(results.map((r) => r.id)).size, 16);
    const s = await kinds();
    assert.equal(s.running.length, 4);
    assert.equal(s.waiting.length, 12);
    assert.equal(new Set([...s.running, ...s.waiting]).size, 16);
  });

  suite("limits and capacities are validated; lowering a limit stops nothing running; a restart sees the same picture", async ({ ask, admission, kinds, reopen }) => {
    const ok = { ...DEFAULT_LIMITS };
    const bad = (limits: unknown) => refuses("invalid_command", () => admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: limits as never }));
    await bad({ ...ok, productive: 0 });
    await bad({ ...ok, productive: 65 });
    await bad({ ...ok, perHost: 9, productive: 4 });
    await bad({ ...ok, extra: 1 });
    await bad({ ...ok, queue: 1.5 });
    await bad("limits");
    const cap = (capacity: unknown, host = "host:h1") => refuses("invalid_command", () => admission.setCapacity({ commandId: cid("c"), actor: "owner:rob", host, capacity: capacity as never }));
    await cap({ cpus: 0, memoryMb: 100 });
    await cap({ cpus: 1, memoryMb: 0 });
    await cap({ cpus: 1, memoryMb: 100, gpu: 1 });
    await cap({ cpus: 1, memoryMb: 100 }, "host:ghost");
    await cap(null);
    const a = await ask({ host: "host:h1" });
    const b = await ask({ host: "host:h1" });
    await admission.setLimits({ commandId: cid("l"), actor: "owner:rob", limits: { ...ok, productive: 1, perHost: 1 } });
    assert.equal((await kinds()).running.length, 2, "running work is left alone");
    const c = await ask({ host: "host:h2" });
    assert.equal(c.state, "waiting", "but nothing new is admitted until the system is under the new limit");
    await release(admission, a.id);
    assert.equal((await kinds()).waiting.length, 1);
    await release(admission, b.id);
    assert.equal((await kinds()).running[0], c.id);
    const again = reopen();
    assert.deepEqual((await again.snapshot()).running.map((e) => e.id), [c.id], "a new service on the same storage sees the same state");
    const replay = await ask({ commandId: "same-request", host: "host:h2" });
    assert.equal((await ask({ commandId: "same-request", host: "host:h2" })).replayed, true);
    void replay;
    await refuses("invalid_command", () => ask({ class: "wizard" as never }));
    await refuses("invalid_command", () => ask({ priority: 10 }));
    await refuses("invalid_command", () => ask({ cpus: 0 }));
    await refuses("invalid_command", () => ask({ surprise: 1 } as never));
  });
}
