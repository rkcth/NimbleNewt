import assert from "node:assert/strict";
import { after } from "node:test";
import { derivedId } from "../domain/ids.js";
import { commitOperation } from "../storage/commit.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { QuietHostService, QUIET_HOST_KIND, type QuietHostNotice } from "./quiet-hosts.js";
import { QuietHostSettingsService } from "./quiet-host-settings.js";
import type { RelocationPolicyFor } from "./service.js";
import { READ, local, refuses, remoteSuite, type Ctx } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

after(stopServer);
const open: RelocationPolicyFor = async () => ({ dataHosts: ["host:r2", "host:r3"] });
const MIN = 60_000, HOUR = 3_600_000;
const live = async (c: Ctx): Promise<{ attemptId: string; state: string }[]> => { const out: { attemptId: string; state: string }[] = []; for (const id of await c.current.liveAttemptIds(c.dispatcherPrincipal)) { const x = await c.current.get(c.owner, id); if (x !== undefined) out.push({ attemptId: id, state: x.state }); } return out; };

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
    const make = (override: Partial<Pick<Ctx["remote"], "relocate">> = o.remote ?? {}): QuietHostService => QuietHostService.withEpoch(c.storage, c.epoch, {
      principal: c.dispatcherPrincipal, settings, hosts: c.hosts,
      remote: { placement: (b, id) => c.remote.placement(b, id), candidates: (b, q) => c.remote.candidates(b, q), relocate: override.relocate ?? ((b, m) => c.remote.relocate(b, m)) },
      liveAttempts: () => live(c),
      notify: async (n) => { notices.push(n); },
    }, c.options);
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
    assert.equal((await w.make().sweep(c.dispatcherPrincipal)).warned, 0, "a restarted controller reads the record and warns no more");
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
      liveAttempts: () => live(c), notify: async (n) => { if (fail) throw new Error("the notification service is down"); sent.push(n.commandId); },
    }, c.options);
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
      liveAttempts: () => live(c), notify: async () => undefined,
    }, c.options);
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
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 1, "on again: the grace period has long passed");
  }, { policy: open });

  suite("a damaged setting never moves work by itself (it fails closed) and the owner is told once", async (c) => {
    const w = await world(c);
    const told: number[] = [];
    const damaged = QuietHostSettingsService.withEpoch(c.storage, c.epoch, {}, { ...c.options, warn: async (d) => { told.push(d.revision); } });
    await w.settings.change(c.owner, { commandId: "d0", graceHours: 5 });
    const real = c.storage.getAggregate.bind(c.storage);
    c.storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "quiet-host-settings" && a !== undefined ? { ...a, body: { graceHours: 9999 } } as never : a; };
    try {
      assert.deepEqual(await damaged.effective(), { graceHours: 12, autoMove: false });
      assert.deepEqual(told.length, 1);
    } finally { c.storage.getAggregate = real; }
    assert.deepEqual(await damaged.effective(), { graceHours: 5, autoMove: true }, "repaired by the stored figure being valid again");
  }, { policy: open });

  suite("a host that comes back before the grace period cancels the pending move; going quiet again is a new episode with a new warning", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    await w.quiet.sweep(c.dispatcherPrincipal);
    await pass(c, 11 * HOUR, [w.r2, w.r1]);
    const back = await w.quiet.sweep(c.dispatcherPrincipal);
    assert.deepEqual([back.recovered, back.moved], [1, 0]);
    const rec = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { state: string };
    assert.equal(rec.state, "recovered");
    await pass(c, 2 * HOUR, [w.r2]); // past the old deadline; r1 is silent again since its last report
    const second = await w.quiet.sweep(c.dispatcherPrincipal);
    assert.deepEqual([second.warned, second.moved], [1, 0], "a new episode is warned, not moved");
    assert.equal(w.notices.length, 2);
    assert.notEqual(w.notices[0]!.commandId, w.notices[1]!.commandId, "the identity is per episode");
    assert.equal((await w.where()).hostId, w.r1.id);
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
      liveAttempts: () => live(c), notify: async () => undefined,
    }, c.options);
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
    const first = await crashing.sweep(c.dispatcherPrincipal);
    assert.deepEqual([first.moved, first.blocked], [0, 0], "a failed pass is not a blocked host");
    const rec = (await c.storage.getAggregate({ kind: QUIET_HOST_KIND, id: w.r1.id }))!.body as { pending: unknown[] };
    assert.equal(rec.pending.length, 1);
    assert.equal((await w.where()).hostId, w.r2.id);
    await w.make().sweep(c.dispatcherPrincipal);
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

  suite("the quiet-host pass is the dispatcher's alone", async (c) => {
    const w = await world(c);
    for (const who of [c.owner, w.r2.principal]) await refuses("forbidden", () => w.quiet.sweep(who));
    await refuses("forbidden", () => w.quiet.episodes(w.r2.principal));
    assert.deepEqual(await w.quiet.episodes(c.owner), []);
  }, { policy: open });
}
