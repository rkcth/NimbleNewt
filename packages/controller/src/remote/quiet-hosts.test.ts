import assert from "node:assert/strict";
import { after } from "node:test";
import { derivedId } from "../domain/ids.js";
import { DomainError } from "../domain/errors.js";
import { commitOperation } from "../storage/commit.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { QuietHostService, QUIET_HOST_KIND, type QuietHostNotice, type QuietHostOptions, type MoveWorkResult } from "./quiet-hosts.js";
import { QuietHostSettingsService } from "./quiet-host-settings.js";
import type { RelocationPolicyFor } from "./service.js";
import { READ, local, refuses, remoteSuite, type Ctx } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

after(stopServer);
const open: RelocationPolicyFor = async () => ({ dataHosts: ["host:r2", "host:r3"] });
const MIN = 60_000, HOUR = 3_600_000;
const live = (c: Ctx): Promise<{ attemptId: string; state: string }[]> => c.current.liveAttempts(c.dispatcherPrincipal);
const stateOf = (c: Ctx) => async (id: string): Promise<string | undefined> => (await c.current.get(c.owner, id))?.state;
/** The tests move the clock by hours between passes, which the pass would read as clock jumps; the tests of that set their own. */
const timed = (c: Ctx, o: Partial<{ maxGapMs: number; quietAfterMs: number }> = {}): QuietHostOptions => ({ ...c.options, maxGapMs: 400 * 24 * HOUR, ...o });

for (const backend of backends) {
  const suite = remoteSuite(backend);

  /** r1 runs an attempt that has made a call and sent a checkpoint; r2 is fresh and could take it. Real services on one storage; the notice port records what the owner would be told. */
  async function world(c: Ctx, o: { remote?: Partial<Pick<Ctx["remote"], "relocate">> } = {}) {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    r1.worker.requirements = () => ({ data: "local-only", harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"] });
    r2.worker.requirements = r1.worker.requirements;
    const s = await c.started(r1);
    assert.equal((await s.attempt.call(READ("c1"), local("one"))).state, "confirmed");
    await s.attempt.putCheckpoint(1, { turn: 1, said: "ordered" });
    r1.worker.silent = true; // a quiet host does not answer a request for a checkpoint
    const notices: QuietHostNotice[] = [];
    const settings = QuietHostSettingsService.withEpoch(c.storage, c.epoch, {}, c.options);
    const make = (override: Partial<Pick<Ctx["remote"], "relocate">> & { attemptState?: (id: string) => Promise<string | undefined>; options?: QuietHostOptions } = o.remote ?? {}): QuietHostService => QuietHostService.withEpoch(c.storage, c.epoch, {
      principal: c.dispatcherPrincipal, settings, hosts: c.hosts,
      remote: { placement: (b, id) => c.remote.placement(b, id), candidates: (b, q) => c.remote.candidates(b, q), relocate: override.relocate ?? ((b, m) => c.remote.relocate(b, m)) },
      liveAttempts: () => live(c), attemptState: override.attemptState ?? stateOf(c),
      notify: async (n) => { notices.push(n); },
    }, override.options ?? timed(c));
    return { r1, r2, ...s, notices, settings, make, quiet: make(), where: async () => (await c.remote.placement(c.owner, s.attemptId))! };
  }
  /** Time passes; the hosts named report (the quiet one does not). */
  const pass = async (c: Ctx, ms: number, fresh: RemoteHost[]): Promise<void> => { c.clock.advance(ms); for (const h of fresh) await h.beat(); };

  suite("a host quiet past the threshold gets one needs-you warning per episode; a second pass, another service instance (a restart) and a lower threshold do not warn again", async (c) => {
    const w = await world(c);
    await pass(c, 2 * MIN, [w.r2]);
    assert.deepEqual(await w.quiet.sweep(c.dispatcherPrincipal), { warned: 0, moved: 0, recovered: 0, blocked: 0 }, "stale, but not yet quiet past the threshold: no warning");
    assert.equal(w.notices.length, 0);
    await pass(c, 4 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1);
    assert.equal(w.notices.length, 1);
    assert.equal(w.notices[0]!.hostId, w.r1.id);
    assert.match(w.notices[0]!.detail, /holds 1 attempt/);
    assert.match(w.notices[0]!.detail, /moves after 12h/);
    assert.ok(w.notices.every((n) => n.detail.length <= 200), "within the notification limit");
    await pass(c, 10 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 0);
    const restarted = w.make();
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await restarted.sweep(c.dispatcherPrincipal)).warned, 0, "a restarted controller reads the record and warns no more");
    assert.equal(w.notices.length, 1);
    assert.equal((await w.where()).hostId, w.r1.id, "a warning moves nothing");
  }, { policy: open });

  suite("a notice that cannot be sent does not stop the pass or count as sent: the next pass sends it, once", async (c) => {
    const w = await world(c);
    let fail = true;
    const sent: string[] = [];
    const flaky = QuietHostService.withEpoch(c.storage, c.epoch, {
      principal: c.dispatcherPrincipal, settings: w.settings, hosts: c.hosts,
      remote: { placement: (b, id) => c.remote.placement(b, id), candidates: (b, q) => c.remote.candidates(b, q), relocate: (b, m) => c.remote.relocate(b, m) },
      liveAttempts: () => live(c), attemptState: stateOf(c), notify: async (n) => { if (fail) throw new Error("the notification service is down"); sent.push(n.commandId); },
    }, timed(c));
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await flaky.sweep(c.dispatcherPrincipal)).warned, 0);
    fail = false;
    assert.equal((await flaky.sweep(c.dispatcherPrincipal)).warned, 1);
    assert.equal((await flaky.sweep(c.dispatcherPrincipal)).warned, 0);
    assert.equal(sent.length, 1);
  }, { policy: open });

  suite("grace not elapsed: nothing moves; elapsed: the attempt is re-placed from its last stored checkpoint on another allowed host, once", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal); // warned
    await pass(c, 11 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 0, "11 hours after the warning is inside the 12-hour grace");
    assert.equal((await w.where()).hostId, w.r1.id);
    await pass(c, 61 * MIN, [w.r2]);
    const done = await w.quiet.sweep(c.dispatcherPrincipal);
    assert.equal(done.moved, 1);
    const b = await w.where();
    assert.deepEqual([b.hostId, b.state, b.relocations], [w.r2.id, "relocating", 1]);
    assert.match(b.history.at(-1)!.reason, /quiet since .* did not answer the warning within 12 hour/);
    assert.equal(b.checkpoint?.sequence, 1, "from the checkpoint the host last sent");
    assert.equal((await c.current.get(c.owner, w.attemptId))!.pinnedHost, w.r2.id, "the dispatcher restarts it on the new host");
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 0, "the next pass finds nothing left on the quiet host");
    assert.equal((await w.where()).relocations, 1);
    assert.equal(w.notices.length, 1);
  }, { policy: open });

  suite("the grace period is the owner's setting: shorter moves sooner, longer later", async (c) => {
    const w = await world(c);
    await w.settings.change(c.owner, { commandId: "g1", graceHours: 48 });
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 47 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 0);
    await pass(c, 2 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 1);
  }, { policy: open });

  suite("the owner asks to move the work: done at once, grace or no grace, replay-safe, owner only", async (c) => {
    const w = await world(c);
    for (const who of [c.dispatcherPrincipal, w.r2.principal]) await refuses("forbidden", () => w.quiet.moveWork(who, { commandId: "m0", hostId: w.r1.id }));
    await refuses("invalid_command", () => w.quiet.moveWork(c.owner, { commandId: "m0", hostId: "r1" }));
    await refuses("invalid_command", () => w.quiet.moveWork(c.owner, { commandId: "m0", hostId: w.r1.id, extra: 1 } as never));
    await refuses("not_found", () => w.quiet.moveWork(c.owner, { commandId: "m0", hostId: "host:nope" }));
    assert.equal((await w.where()).hostId, w.r1.id, "refused calls moved nothing");
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal); // warned a minute ago, 12 hours not elapsed
    const r = await w.quiet.moveWork(c.owner, { commandId: "m1", hostId: w.r1.id });
    assert.deepEqual([r.moved.map((m) => m.to), r.skipped, r.more], [[w.r2.id], [], false]);
    assert.equal((await w.where()).hostId, w.r2.id);
    const again = await w.quiet.moveWork(c.owner, { commandId: "m1", hostId: w.r1.id });
    assert.deepEqual([again.moved, again.skipped], [[], []], "the same command moves nothing twice");
    assert.equal((await w.where()).relocations, 1);
    await refuses("command_conflict", () => w.quiet.moveWork(c.owner, { commandId: "m1", hostId: w.r2.id }));
  }, { policy: open });

  suite("the owner's move works on a host that is not quiet at all, and says why when nothing can take the work", async (c) => {
    const w = await world(c);
    w.r1.worker.silent = false;
    // r2 is excluded by the placement policy: no allowed target.
    const noR2 = QuietHostService.withEpoch(c.storage, c.epoch, {
      principal: c.dispatcherPrincipal, settings: w.settings, hosts: c.hosts,
      remote: { placement: (b, id) => c.remote.placement(b, id), candidates: async (b, q) => ({ ...(await c.remote.candidates(b, q)), eligible: [] }), relocate: (b, m) => c.remote.relocate(b, m) },
      liveAttempts: () => live(c), attemptState: stateOf(c), notify: async () => undefined,
    }, timed(c));
    const none = await noR2.moveWork(c.owner, { commandId: "m2", hostId: w.r1.id });
    assert.deepEqual([none.moved, none.skipped.length], [[], 1]);
    assert.equal((await w.where()).hostId, w.r1.id);
    const r = await w.quiet.moveWork(c.owner, { commandId: "m3", hostId: w.r1.id });
    assert.equal(r.moved.length, 1, "a fresh host's work moves when the owner says so");
    assert.equal((await w.where()).hostId, w.r2.id);
  }, { policy: open });

  suite("automatic moves off: the warning still comes, the work never moves by itself (however long), and the owner can still move it; turning it on again moves it", async (c) => {
    const w = await world(c);
    await w.settings.change(c.owner, { commandId: "a0", autoMove: false });
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1);
    assert.match(w.notices[0]!.detail, /Automatic moves are off/);
    for (let i = 0; i < 3; i++) { await pass(c, 200 * HOUR, [w.r2]); assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 0); }
    assert.equal((await w.where()).hostId, w.r1.id);
    await w.settings.change(c.owner, { commandId: "a1", autoMove: true });
    await pass(c, MIN, [w.r2]);
    const rewarn = await w.quiet.sweep(c.dispatcherPrincipal);
    assert.deepEqual([rewarn.moved, rewarn.warned], [0, 1], "on again: the grace period starts from now, it is not already over, and the owner is told the timer");
    assert.equal(w.notices.length, 2);
    assert.match(w.notices[1]!.detail, /moves after 12h/);
    assert.equal((await w.where()).hostId, w.r1.id);
    await pass(c, 11 * HOUR, [w.r2]);
    assert.deepEqual([(await w.quiet.sweep(c.dispatcherPrincipal)).moved, w.notices.length], [0, 2], "inside the new grace period, and told once");
    await pass(c, 2 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 1, "after the new grace period it moves");
  }, { policy: open });

  suite("a damaged setting never moves work by itself (it fails closed) and the owner is told once", async (c) => {
    const w = await world(c);
    const told: number[] = [];
    const damaged = QuietHostSettingsService.withEpoch(c.storage, c.epoch, {}, { ...c.options, warn: async (d) => { told.push(d.revision); } });
    await w.settings.change(c.owner, { commandId: "d0", graceHours: 5 });
    const real = c.storage.getAggregate.bind(c.storage);
    c.storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "quiet-host-settings" && a !== undefined ? { ...a, body: { graceHours: 9999 } } as never : a; };
    try {
      assert.deepEqual(await damaged.effective(), { graceHours: 12, autoMove: false, recoverMinutes: 10, noticeHours: 6 });
      assert.deepEqual(told.length, 1);
      // Fixing the damaged setting by naming only the grace period must not turn automatic moves back on: autoMove has to be stated.
      await refuses("invalid_command", () => w.settings.change(c.owner, { commandId: "d1", graceHours: 6 }), (e) => assert.equal(e.field, "autoMove"));
      await refuses("invalid_command", () => w.settings.change(c.owner, { commandId: "d1b", graceHours: 6, autoMove: null }), (e) => assert.equal(e.field, "autoMove"));
      assert.equal((await w.settings.get(c.owner)).damaged, true);
    } finally { c.storage.getAggregate = real; }
    assert.deepEqual(await damaged.effective(), { graceHours: 5, autoMove: true, recoverMinutes: 10, noticeHours: 6 }, "repaired by the stored figure being valid again");
    // A damaged record that the owner restates is replaced, with the restated autoMove.
    c.storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "quiet-host-settings" && a !== undefined ? { ...a, body: { graceHours: 9999 } } as never : a; };
    try { await w.settings.change(c.owner, { commandId: "d2", graceHours: 6, autoMove: false }); } finally { c.storage.getAggregate = real; }
    assert.deepEqual(await damaged.effective(), { graceHours: 6, autoMove: false, recoverMinutes: 10, noticeHours: 6 }, "what the owner said stands, and automatic moves stay off");
  }, { policy: open });

  suite("a host that reports without a gap for the recovery period before the grace period cancels the pending move; going quiet again later is a new episode with a new warning", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 11 * HOUR, [w.r2, w.r1]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).recovered, 0, "one sighting of a fresh host is not a recovery");
    await pass(c, MIN, [w.r2, w.r1]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    for (let i = 0; i < 4; i++) { await pass(c, 2 * MIN, [w.r2, w.r1]); assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).recovered, 0, "reporting for under 10 minutes"); }
    await pass(c, 2 * MIN, [w.r2, w.r1]);
    const back = await w.quiet.sweep(c.dispatcherPrincipal);
    assert.deepEqual([back.recovered, back.moved], [1, 0]);
    const rec = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { state: string; episode: string };
    assert.equal(rec.state, "recovered");
    await pass(c, 2 * HOUR, [w.r2]); // past the old deadline; r1 is silent again since its last report
    const second = await w.quiet.sweep(c.dispatcherPrincipal);
    assert.deepEqual([second.warned, second.moved], [1, 0], "a new episode is warned, not moved");
    assert.equal(w.notices.length, 2);
    assert.notEqual(w.notices[0]!.commandId, w.notices[1]!.commandId, "the identity is per episode");
    assert.equal((await w.where()).hostId, w.r1.id);
  }, { policy: open });

  suite("a flapping host (reports for a moment every half hour) is one episode: one notice, and the grace period runs to its end so the work moves", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    const first = ((await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { episode: string }).episode;
    let moved = 0;
    for (let i = 0; i < 28 && moved === 0; i++) {
      await pass(c, 30 * MIN, [w.r2, w.r1]); // the host reports...
      await w.quiet.sweep(c.dispatcherPrincipal);
      await pass(c, 6 * MIN, [w.r2]); // ...and is silent again by the next pass
      moved += (await w.quiet.sweep(c.dispatcherPrincipal)).moved;
      assert.equal(w.notices.length, 1, `no second notice at round ${i}`);
    }
    assert.equal(moved, 1, "the grace period was not restarted by each report: the work moved");
    assert.equal((await w.where()).hostId, w.r2.id);
    const rec = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { episode: string };
    assert.equal(rec.episode, first, "one episode all along");
  }, { policy: open });

  suite("a host that recovers and drops out again within the notice interval is not announced a second time (the grace period still starts); after the interval it is", async (c) => {
    const w = await world(c);
    const recover = async (): Promise<void> => { for (let i = 0; i < 7; i++) { await pass(c, 2 * MIN, [w.r2, w.r1]); await w.quiet.sweep(c.dispatcherPrincipal); } };
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await recover();
    assert.equal(((await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { state: string }).state, "recovered");
    await pass(c, 7 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    const now = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { state: string; warnedAt?: string };
    assert.deepEqual([now.state, now.warnedAt !== undefined, w.notices.length], ["quiet", true, 1], "a second episode within 6 hours: the grace period runs, the owner is not told again");
    await recover();
    await pass(c, 7 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1, "past the interval the owner is told again");
    assert.equal(w.notices.length, 2);
  }, { policy: open });

  suite("the notice interval and the recovery period are the owner's settings", async (c) => {
    const w = await world(c);
    await w.settings.change(c.owner, { commandId: "n1", noticeHours: 1, recoverMinutes: 2 });
    assert.deepEqual(await w.settings.effective(), { graceHours: 12, autoMove: true, recoverMinutes: 2, noticeHours: 1 });
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    for (let i = 0; i < 4; i++) { await pass(c, MIN, [w.r2, w.r1]); await w.quiet.sweep(c.dispatcherPrincipal); }
    assert.equal(((await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { state: string }).state, "recovered", "recovered after 2 minutes of reporting");
    await pass(c, 70 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1, "told again after an hour");
  }, { policy: open });

  suite("after a controller restart or a clock jump no host is judged until the quiet threshold has passed; a host that reports in that time is never warned about", async (c) => {
    const w = await world(c);
    await pass(c, 3 * HOUR, [w.r2]); // the controller was down; r1 was last heard of 3 hours ago
    const restarted = w.make();
    assert.deepEqual(await restarted.sweep(c.dispatcherPrincipal), { warned: 0, moved: 0, recovered: 0, blocked: 0 });
    await pass(c, 2 * MIN, [w.r2, w.r1]);
    await restarted.sweep(c.dispatcherPrincipal);
    await pass(c, 4 * MIN, [w.r2, w.r1]);
    assert.equal((await restarted.sweep(c.dispatcherPrincipal)).warned, 0, "r1 reported again as the controller came up: nothing to warn about");
    assert.equal(w.notices.length, 0);
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await restarted.sweep(c.dispatcherPrincipal)).warned, 1, "silent for real: warned once the threshold had passed");
  }, { policy: open });

  suite("a clock that jumps forward is read like a restart: the hosts are given the quiet threshold to report before any is judged", async (c) => {
    const w = await world(c);
    const steady = w.make({ options: { ...c.options } }); // the product's default guard (10 minutes)
    for (let i = 0; i < 3; i++) { await pass(c, MIN, [w.r2]); await steady.sweep(c.dispatcherPrincipal); }
    c.clock.advance(3 * 24 * HOUR); // the clock jumps; no host has had the chance to report yet
    assert.equal((await steady.sweep(c.dispatcherPrincipal)).warned, 0);
    await pass(c, 2 * MIN, [w.r2, w.r1]);
    await steady.sweep(c.dispatcherPrincipal);
    await pass(c, 4 * MIN, [w.r2, w.r1]);
    assert.equal((await steady.sweep(c.dispatcherPrincipal)).warned, 0);
    assert.equal(w.notices.length, 0, "the hosts reported after the jump: nobody is told anything");
    // A clock that goes back is the same.
    c.clock.advance(-2 * HOUR);
    await pass(c, 0, [w.r2]);
    assert.equal((await steady.sweep(c.dispatcherPrincipal)).warned, 0);
  }, { policy: open });

  suite("a host that reports between the grace check and the move keeps its work", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 13 * HOUR, [w.r2]);
    let looks = 0;
    const racing = QuietHostService.withEpoch(c.storage, c.epoch, {
      principal: c.dispatcherPrincipal, settings: w.settings,
      hosts: { status: async (by, id) => { const s = await c.hosts.status(by, id); if (id === w.r1.id && ++looks === 2) await w.r1.beat(); return id === w.r1.id && looks >= 2 ? await c.hosts.status(by, id) : s; } },
      remote: { placement: (b, id) => c.remote.placement(b, id), candidates: (b, q) => c.remote.candidates(b, q), relocate: (b, m) => c.remote.relocate(b, m) },
      liveAttempts: () => live(c), attemptState: stateOf(c), notify: async () => undefined,
    }, timed(c));
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await racing.sweep(c.dispatcherPrincipal)).moved, 0);
    assert.equal((await w.where()).hostId, w.r1.id);
  }, { policy: open });

  suite("restart in the middle of a move: the record lists it and the next pass finishes it under the same command, once", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 13 * HOUR, [w.r2]);
    // The controller dies after the move was committed and told to the dispatcher, before it could note that.
    const crashing = w.make({ relocate: async (b, m) => { await c.remote.relocate(b, m); throw new Error("the controller stopped"); } });
    await pass(c, 6 * MIN, [w.r2]);
    const first = await crashing.sweep(c.dispatcherPrincipal);
    assert.deepEqual([first.moved, first.blocked], [0, 0], "a failed pass is not a blocked host");
    const rec = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { pending: unknown[] };
    assert.equal(rec.pending.length, 1);
    assert.equal((await w.where()).hostId, w.r2.id);
    const second = w.make();
    await pass(c, 6 * MIN, [w.r2]);
    await second.sweep(c.dispatcherPrincipal);
    const after = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { pending: unknown[] };
    assert.equal(after.pending.length, 0);
    assert.equal((await w.where()).relocations, 1, "finished, not moved a second time");
    assert.equal(w.notices.length, 1);
  }, { policy: open });

  suite("nothing can take the work: the owner is told once, the work stays, and it moves when a host can", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 13 * HOUR, []); // r2 is quiet as well
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).blocked, 1);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).blocked, 0);
    assert.equal(w.notices.length, 2, "the warning and the one blocked notice");
    assert.equal(w.notices.filter((n) => n.commandId.startsWith("quiet-host-blocked:")).length, 1);
    assert.equal((await w.where()).hostId, w.r1.id);
    await w.r2.beat();
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 1);
  }, { policy: open });

  suite("an attempt parked on a quiet host is warned about and, after the grace period, moved from the checkpoint it parked with", async (c) => {
    const w = await world(c);
    // What the dispatcher does when a turn ends with every call waiting for an approval: the placement ends with the run and the attempt parks, pinned to its host, with its checkpoint.
    const ref = { kind: "dispatch", id: derivedId("dpa", w.attemptId) };
    const found = (await c.storage.getAggregate(ref))!;
    await commitOperation(c.storage, { operationId: "cmd:park-fixture", epoch: c.epoch, actor: "fixture", correlationId: "park-fixture", at: c.clock.now(), changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...(found.body as object), state: "parked", pinnedHost: w.r1.id, resumeFrom: { parked: true } } as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] }, { attempts: 3, pause: async () => undefined });
    await c.remote.end(c.dispatcherPrincipal, w.attemptId, "parked", w.placement);
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1);
    await pass(c, 13 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 1);
    assert.equal((await w.where()).hostId, w.r2.id);
    const after = (await c.current.get(c.owner, w.attemptId))!;
    assert.deepEqual([after.state, after.pinnedHost], ["parked", w.r2.id]);
  }, { policy: open });

  suite("an old host that does not answer at all (the request for its checkpoint never returns) does not hold the move: it is fenced with the last stored checkpoint within the settle bound", async (c) => {
    const w = await world(c);
    w.r1.worker.hang = true;
    const done = await Promise.race([
      w.quiet.moveWork(c.owner, { commandId: "h1", hostId: w.r1.id }).then((r) => r),
      new Promise<"stalled">((r) => setTimeout(() => r("stalled"), 8000)),
    ]);
    assert.notEqual(done, "stalled", "the move waited for a host that never answers");
    assert.deepEqual((done as MoveWorkResult).moved.map((m) => m.to), [w.r2.id]);
    const b = await w.where();
    assert.deepEqual([b.hostId, b.checkpoint?.sequence], [w.r2.id, 1], "from the checkpoint the host last sent");
  }, { policy: open, settleMs: 100 });

  suite("an attempt that cannot move for another reason than missing hosts is not reported as 'no other allowed host'; one that has finished is skipped", async (c) => {
    const w = await world(c);
    const fenced = w.make({ relocate: async () => { throw new DomainError("fenced", "the placement changed while the move was prepared"); } });
    const r = await fenced.moveWork(c.owner, { commandId: "f1", hostId: w.r1.id });
    assert.equal(r.moved.length, 0);
    assert.match(r.skipped[0]!.reason, /placement changed/);
    assert.doesNotMatch(r.skipped[0]!.reason, /no other/);
    const gone = w.make({ relocate: async () => { throw new DomainError("not_found", "attempt has no remote placement"); } });
    assert.doesNotMatch((await gone.moveWork(c.owner, { commandId: "f2", hostId: w.r1.id })).skipped[0]!.reason, /no other/);
    let calls = 0;
    const over = w.make({ attemptState: async () => "finished", relocate: async (b, m) => { calls++; return c.remote.relocate(b, m); } });
    const o = await over.moveWork(c.owner, { commandId: "f3", hostId: w.r1.id });
    assert.deepEqual([o.moved.length, o.skipped.length, calls], [0, 1, 0]);
    assert.match(o.skipped[0]!.reason, /finished/);
    // In the pass: no blocked notice for an attempt that was fenced; and the owner is told when nothing can take it (as before).
    const quiet = w.make({ relocate: async () => { throw new DomainError("fenced", "the placement changed while the move was prepared"); } });
    await pass(c, 6 * MIN, [w.r2]);
    await quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 13 * HOUR, [w.r2]);
    await pass(c, 6 * MIN, [w.r2]);
    const done = await quiet.sweep(c.dispatcherPrincipal);
    assert.deepEqual([done.moved, done.blocked], [0, 0]);
    assert.equal(w.notices.filter((n) => n.commandId.startsWith("quiet-host-blocked:")).length, 0);
  }, { policy: open });

  suite("a move ends the old placement's task credential at once; the new placement gets a new one", async (c) => {
    const w = await world(c);
    const old = w.order.credential;
    await c.credentials.authenticate(old);
    const r = await w.quiet.moveWork(c.owner, { commandId: "cr1", hostId: w.r1.id });
    assert.equal(r.moved.length, 1);
    await refuses("unauthenticated", () => c.credentials.authenticate(old));
    await c.tick();
    const offer = (await w.r2.client.offers()).find((x) => x.order.attemptId === w.attemptId);
    assert.ok(offer, "the dispatcher restarted the attempt on the new host");
    await c.credentials.authenticate(offer.order.credential);
    assert.notEqual(offer.order.credential, old);
    await refuses("unauthenticated", () => c.credentials.authenticate(old));
  }, { policy: open });

  suite("bounded work with 150 hosts: every host is looked at in turn (none starves), at most 10 moves a pass, started moves are finished within the same budget, and old records are deleted", async (c) => {
    const N = 150;
    const names = Array.from({ length: N }, (_, i) => `host:h${String(i).padStart(3, "0")}`);
    const target = "host:target";
    const where = new Map<string, string>(names.map((h, i) => [`att-${i}`, h] as const));
    let relocations = 0, statusReads = 0;
    const notices: string[] = [];
    const stale = { freshness: "stale", lastSeenAt: new Date(Date.parse(c.clock.now()) - HOUR).toISOString() };
    const deps = {
      principal: c.dispatcherPrincipal, settings: await QuietHostSettingsService.withEpoch(c.storage, c.epoch, {}, c.options),
      hosts: { status: async (_by: unknown, id: string) => { statusReads++; return (id === target ? { freshness: "fresh", lastSeenAt: c.clock.now() } : stale) as never; } },
      remote: {
        placement: async (_by: unknown, id: string) => (where.has(id) ? { attemptId: id, hostId: where.get(id)!, state: "accepted", requirements: {}, taskId: "t", projectId: "p", agentId: "a" } as never : undefined),
        candidates: async () => ({ eligible: [target] }) as never,
        relocate: async (_by: unknown, m: { attemptId: string; toHostId: string }) => { relocations++; where.set(m.attemptId, m.toHostId); return {} as never; },
      },
      liveAttempts: async () => [...where.keys()].map((attemptId) => ({ attemptId, state: "running" })),
      attemptState: async () => "running",
      notify: async (n: QuietHostNotice) => { notices.push(n.hostId); },
    };
    const service = QuietHostService.withEpoch(c.storage, c.epoch, deps as never, timed(c));
    c.clock.advance(6 * MIN);
    const one = await service.sweep(c.dispatcherPrincipal);
    assert.equal(one.warned, 100, "a pass looks at 100 hosts");
    const two = await service.sweep(c.dispatcherPrincipal);
    assert.equal(two.warned, 50, "the next pass goes on from where the last stopped");
    assert.equal(new Set(notices).size, N, "no host starved");
    assert.equal((await service.sweep(c.dispatcherPrincipal)).warned, 0);
    // Past the grace period: at most 10 moves a pass.
    c.clock.advance(13 * HOUR);
    const moves: number[] = [];
    for (let i = 0; i < 40 && relocations < N; i++) { const before = relocations; await service.sweep(c.dispatcherPrincipal); moves.push(relocations - before); }
    assert.ok(moves.every((m) => m <= 10), JSON.stringify(moves));
    assert.equal(moves[0], 10);
    assert.equal(relocations, N, "everything moved over several passes");
    assert.ok(statusReads > 0);
  }, { policy: open });

  suite("moves that were started are finished within the pass's move budget, not all at once; records of hosts that recovered long ago are deleted, a few at a time", async (c) => {
    const N = 30;
    const names = Array.from({ length: N }, (_, i) => `host:p${String(i).padStart(2, "0")}`);
    const target = "host:target";
    const state = new Map<string, { host: string; state: string }>(names.map((h, i) => [`att-${i}`, { host: target, state: "relocating" }] as const));
    let calls = 0;
    const at = c.clock.now();
    const old = new Date(Date.parse(at) - 30 * 24 * HOUR).toISOString();
    const write = async (id: string, body: object): Promise<void> => { await commitOperation(c.storage, { operationId: `cmd:fx-${id}`, epoch: c.epoch, actor: "fixture", correlationId: `fx-${id}`, at, changes: [{ type: "create", ref: { kind: QUIET_HOST_KIND, id }, body: body as never }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] }, { attempts: 3, pause: async () => undefined }); };
    for (const [i, h] of names.entries()) await write(h, { hostId: h, episode: at, quietSince: at, state: "recovered", pending: [{ attemptId: `att-${i}`, to: target, commandId: `qhm:fx${i}`, at }], updatedAt: at });
    const recovered = Array.from({ length: 30 }, (_, i) => `host:r${String(i).padStart(2, "0")}`);
    for (const h of recovered) await write(h, { hostId: h, episode: old, quietSince: old, state: "recovered", pending: [], updatedAt: old });
    await write("host:recent", { hostId: "host:recent", episode: at, quietSince: at, state: "recovered", pending: [], updatedAt: at });
    const deps = {
      principal: c.dispatcherPrincipal, settings: QuietHostSettingsService.withEpoch(c.storage, c.epoch, {}, c.options),
      hosts: { status: async () => ({ freshness: "fresh", lastSeenAt: c.clock.now() }) as never },
      remote: {
        placement: async (_by: unknown, id: string) => { const x = state.get(id); return x === undefined ? undefined : { attemptId: id, hostId: x.host, state: x.state } as never; },
        candidates: async () => ({ eligible: [] }) as never,
        relocate: async (_by: unknown, m: { attemptId: string }) => { calls++; state.set(m.attemptId, { host: target, state: "accepted" }); return {} as never; },
      },
      liveAttempts: async () => [], attemptState: async () => "running", notify: async () => undefined,
    };
    const service = QuietHostService.withEpoch(c.storage, c.epoch, deps as never, timed(c));
    const counts: number[] = [];
    for (let i = 0; i < 5; i++) { const before = calls; await service.sweep(c.dispatcherPrincipal); counts.push(calls - before); }
    assert.deepEqual(counts, [10, 10, 10, 0, 0], "10 finished per pass");
    const remaining = async (): Promise<string[]> => (await service.episodes(c.owner)).map((r) => r.hostId);
    c.clock.advance(6 * MIN);
    await service.sweep(c.dispatcherPrincipal);
    const afterOne = (await remaining()).filter((h) => /^host:r\d\d$/.test(h)).length;
    assert.equal(afterOne, 30 - 20, "at most 20 old records are deleted a pass");
    await service.sweep(c.dispatcherPrincipal);
    const left = await remaining();
    assert.equal(left.filter((h) => /^host:r\d\d$/.test(h)).length, 0);
    assert.ok(left.includes("host:recent"), "a recent record stays");
    assert.equal(left.filter((h) => h.startsWith("host:p")).length, N, "records with a recent date stay (their pending entries are gone, they are recent)");
  }, { policy: open });

  suite("the quiet-host pass is the dispatcher's alone", async (c) => {
    const w = await world(c);
    for (const who of [c.owner, w.r2.principal]) await refuses("forbidden", () => w.quiet.sweep(who));
    await refuses("forbidden", () => w.quiet.episodes(w.r2.principal));
    assert.deepEqual(await w.quiet.episodes(c.owner), []);
  }, { policy: open });
}
