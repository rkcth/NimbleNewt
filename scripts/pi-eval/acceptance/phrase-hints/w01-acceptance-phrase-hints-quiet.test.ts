import assert from "node:assert/strict";
import { after } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { QuietHostService, type QuietHostNotice, type QuietHostOptions } from "./quiet-hosts.js";
import { QuietHostSettingsService } from "./quiet-host-settings.js";
import type { RelocationPolicyFor } from "./service.js";
import { READ, local, refuses, remoteSuite, type Ctx } from "./testing/suite.js";
import type { RemoteHost } from "./testing/world.js";

// W01 acceptance for phrase-hints: the quiet-host notice states the situation with no sentence to copy, and the
// damaged-setting refusal asks instead of dictating.

after(stopServer);
const open: RelocationPolicyFor = async () => ({ dataHosts: ["host:r2", "host:r3"] });
const MIN = 60_000, HOUR = 3_600_000;
const live = (c: Ctx): Promise<{ attemptId: string; state: string }[]> => c.current.liveAttempts(c.dispatcherPrincipal);
const stateOf = (c: Ctx) => async (id: string): Promise<string | undefined> => (await c.current.get(c.owner, id))?.state;
const timed = (c: Ctx): QuietHostOptions => ({ ...c.options, maxGapMs: 400 * 24 * HOUR });
/** A sentence for the owner to copy: an instruction to say something, an example, or a quoted phrase. */
const DICTATES = /\bsay\b|\bfor example\b|\byour own words\b|["“]/i;

for (const backend of backends) {
  const suite = remoteSuite(backend);

  async function world(c: Ctx) {
    const r1 = await c.host("r1");
    const r2 = await c.host("r2");
    r1.worker.requirements = () => ({ data: "local-only", harness: "pi", isolation: ["bubblewrap"], workspaces: ["garden"] });
    r2.worker.requirements = r1.worker.requirements;
    const s = await c.started(r1);
    assert.equal((await s.attempt.call(READ("c1"), local("one"))).state, "confirmed");
    await s.attempt.putCheckpoint(1, { turn: 1, said: "ordered" });
    r1.worker.silent = true;
    const notices: QuietHostNotice[] = [];
    const settings = QuietHostSettingsService.withEpoch(c.storage, c.epoch, {}, c.options);
    const quiet = QuietHostService.withEpoch(c.storage, c.epoch, {
      principal: c.dispatcherPrincipal, settings, hosts: c.hosts,
      remote: { placement: (b, id) => c.remote.placement(b, id), candidates: (b, q) => c.remote.candidates(b, q), relocate: (b, m) => c.remote.relocate(b, m) },
      liveAttempts: () => live(c), attemptState: stateOf(c),
      notify: async (n) => { notices.push(n); },
    }, timed(c));
    return { r1, r2, ...s, notices, settings, quiet, where: async () => (await c.remote.placement(c.owner, s.attemptId))! };
  }
  const pass = async (c: Ctx, ms: number, fresh: RemoteHost[]): Promise<void> => { c.clock.advance(ms); for (const h of fresh) await h.beat(); };

  suite("the quiet-host notice states the situation, with no sentence to copy, whether automatic moves are on or off", async (c) => {
    const w = await world(c);
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1);
    assert.equal(w.notices.length, 1);
    assert.equal(w.notices[0]!.hostId, w.r1.id);
    assert.match(w.notices[0]!.detail, /holds 1 attempt/);
    assert.match(w.notices[0]!.detail, /12\s*h/, "the timer is told");
    assert.doesNotMatch(w.notices[0]!.detail, DICTATES, w.notices[0]!.detail);
    assert.equal((await w.where()).hostId, w.r1.id, "a warning moves nothing");
  }, { policy: open });

  suite("with automatic moves off the notice says so and gives no sentence to copy", async (c) => {
    const w = await world(c);
    await w.settings.change(c.owner, { commandId: "q-off", autoMove: false });
    await pass(c, 6 * MIN, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).warned, 1);
    assert.match(w.notices[0]!.detail, /holds 1 attempt/);
    assert.match(w.notices[0]!.detail, /automatic moves are off/i);
    assert.doesNotMatch(w.notices[0]!.detail, DICTATES, w.notices[0]!.detail);
    assert.ok(w.notices.every((n) => n.detail.length <= 200), "within the notification limit");
    await pass(c, 200 * HOUR, [w.r2]);
    assert.equal((await w.quiet.sweep(c.dispatcherPrincipal)).moved, 0, "nothing moves by itself");
  }, { policy: open });

  suite("a damaged setting changed without autoMove is refused with a question, not a form of words", async (c) => {
    const w = await world(c);
    await w.settings.change(c.owner, { commandId: "d0", graceHours: 5 });
    const real = c.storage.getAggregate.bind(c.storage);
    c.storage.getAggregate = async (ref) => { const a = await real(ref); return ref.kind === "quiet-host-settings" && a !== undefined ? { ...a, body: { graceHours: 9999 } } as never : a; };
    try {
      await refuses("invalid_command", () => w.settings.change(c.owner, { commandId: "d1", graceHours: 6 }), (e) => {
        assert.equal(e.field, "autoMove");
        assert.match(e.message, /\?\s*$/, e.message);
        assert.doesNotMatch(e.message, /\bsay\b|autoMove (true|false)/i, e.message);
      });
      assert.equal((await w.settings.get(c.owner)).damaged, true);
    } finally { c.storage.getAggregate = real; }
  }, { policy: open });
}
