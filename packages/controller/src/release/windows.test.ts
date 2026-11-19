import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner, type Built } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ReleaseActivationService, ReleaseService, ReleaseWindowService, type WindowNotice, type WindowOptions } from "./index.js";

/**
 * Card K07 (first slice): maintenance windows for release updates, on every storage backend, with the real staging and activation service and real release folders. The clock the windows are
 * judged on is the test's (`now`), so a window can be opened, missed or closed without waiting.
 */
after(stopServer);
const options = { clock: () => "2026-11-18T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const unlockAll = (dir: string): void => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };
const linux = { os: "linux" as const, arch: "x64" as const };
const MIN = 60_000;
/** 2026-11-20 02:00 in London is 02:00 UTC (no summer time in November). */
const OPENS = Date.parse("2026-11-20T02:00:00.000Z");
const at = (date = "2026-11-20", time = "02:00", timeZone = "Europe/London") => ({ date, time, timeZone, durationMinutes: 60 });

interface W {
  owner: Principal; agent: Principal; act: ReleaseActivationService; root: string;
  clock: { t: number }; live: { n: number }; free: { b: number }; told: WindowNotice[];
  win: (o?: Partial<WindowOptions>) => ReleaseWindowService;
  /** A submitted, staged and approved candidate; returns its ID and staged digest. */
  ready: (content: string, approve?: boolean) => Promise<{ id: string; digest: string }>;
  pointer: () => string | undefined;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: W) => Promise<void>): void => {
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const root = mkdtempSync(join(tmpdir(), "nn-win-"));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "builder", grants: [{ action: "release.manage", project: "*" }] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:builder")).token);
        const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
        const act = ReleaseActivationService.withEpoch(world.storage, projects.epoch, { root, switcher: "pointer", platform: linux, runner: options });
        const runner = new CommandRunner(world.storage, projects.epoch, options);
        const clock = { t: OPENS - 3 * 60 * MIN };
        const live = { n: 0 };
        const free = { b: 10 * 1024 ** 3 };
        const told: WindowNotice[] = [];
        const win = (o: Partial<WindowOptions> = {}): ReleaseWindowService => ReleaseWindowService.withEpoch(world.storage, projects.epoch, { activation: act, root, now: () => clock.t, liveAttempts: async () => live.n, freeBytes: async () => free.b, notify: async (x) => { told.push(x); }, runner: options, ...o });
        const ready = async (content: string, approve = true): Promise<{ id: string; digest: string }> => {
          const { candidateId } = await rel.submit(owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { "controller.js": sha(content) }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] } });
          mkdirSync(join(root, "incoming", candidateId), { recursive: true });
          writeFileSync(join(root, "incoming", candidateId, "controller.js"), content);
          const s = await act.stage(owner, { commandId: cid("st"), candidateId });
          if (approve) await runner.command("test.approve", { commandId: cid("ap"), actor: owner.id }, async () => ({ payload: { candidateId }, build: async (): Promise<Built> => { const ref = { kind: "release-approval", id: candidateId }; return { ref, creates: true, changes: [{ type: "create", ref, body: { candidateId, by: owner.id, at: "x" } }], detail: {} }; } }));
          return { id: candidateId, digest: s.digest };
        };
        const pointer = (): string | undefined => existsSync(join(root, "current.json")) ? (JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { release: string }).release : undefined;
        await body({ owner, agent, act, root, clock, live, free, told, win, ready, pointer });
      } finally { await world.close(); unlockAll(join(root, "releases")); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };

  suite("a window is the owner's word for one exact staged release at a local time in a named zone; wrong digest, unstaged, past, unknown zone and a second open window are refused", async (c) => {
    const r = await c.ready("v1");
    const w = c.win();
    await refuses("forbidden", () => w.set(c.agent, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at() }));
    await refuses("invalid_command", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: sha("other"), ...at() }), /digest/);
    await refuses("not_found", () => w.set(c.owner, { commandId: cid("w"), candidateId: `rcn-${"0".repeat(24)}`, digest: r.digest, ...at() }));
    await refuses("invalid_command", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at("2026-11-17") }), /already be over/);
    await refuses("invalid_command", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at(undefined, undefined, "Mars/Olympus") }), /timeZone/);
    await refuses("invalid_command", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at(), scope: "host" }), /scope/);
    await refuses("invalid_command", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at(), durationMinutes: 5 }), /durationMinutes/);
    const id = cid("w");
    const set = await w.set(c.owner, { commandId: id, candidateId: r.id, digest: r.digest, ...at(undefined, "21:00", "America/New_York"), channel: "stable" });
    assert.equal(set.opensAt, "2026-11-21T02:00:00.000Z", "21:00 in New York in November is 02:00 UTC the next day");
    assert.equal(set.closesAt, "2026-11-21T03:00:00.000Z");
    assert.deepEqual(await w.set(c.owner, { commandId: id, candidateId: r.id, digest: r.digest, ...at(undefined, "21:00", "America/New_York"), channel: "stable" }), { ...set, replayed: true }, "a repeat is the same window");
    await refuses("command_conflict", () => w.set(c.owner, { commandId: id, candidateId: r.id, digest: r.digest, ...at(undefined, "22:00", "America/New_York") }));
    await refuses("invalid_transition", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at() }), /still open/);
    const got = await w.get(c.agent, set.windowId);
    assert.deepEqual([got.status, got.channel, got.scope, got.prepareLeadMinutes, got.authorizedBy, got.timeZone], ["scheduled", "stable", "installation", 60, c.owner.id, "America/New_York"]);
    assert.equal((await w.list(c.owner)).windows.length, 1);
  });

  suite("prepare starts only within the lead time, the window waits while work runs (nothing stopped), then activates and commits once the release confirmed its start; the owner is told once", async (c) => {
    const v1 = await c.ready("v1");
    await c.act.activate(c.owner, { commandId: cid("a"), candidateId: v1.id, digest: v1.digest });
    const v2 = await c.ready("v2");
    const w = c.win();
    const { windowId } = await w.set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at() });
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "scheduled", "three hours before: nothing yet");
    c.clock.t = OPENS - 30 * MIN;
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "prepared");
    await w.tick();
    assert.equal(c.pointer(), v1.id, "prepared but not open: nothing switched");
    c.clock.t = OPENS + MIN;
    c.live.n = 2;
    await w.tick();
    await w.tick();
    const waiting = await w.get(c.owner, windowId);
    assert.deepEqual([waiting.status, waiting.waiting], ["prepared", "2 agent attempt(s) running"]);
    assert.equal(waiting.history.filter((h) => h.event === "waiting").length, 1, "the same wait is written once");
    assert.equal(c.pointer(), v1.id, "running work holds the update back");
    c.live.n = 0;
    await w.tick();
    const activated = await w.get(c.owner, windowId);
    assert.deepEqual([activated.status, activated.from, activated.waiting], ["activated", v1.id, undefined]);
    assert.equal(c.pointer(), v2.id, "the switch went through the journalled activation");
    assert.equal(activated.rollback?.to, v1.id, "the way back is shown");
    assert.equal((await c.act.status(c.owner)).history.at(-1)?.by, "service:release-window", "the audit names the window's standing word");
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated", "waits for the release to confirm its start");
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: v2.id });
    await w.tick();
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "committed");
    assert.deepEqual(c.told.map((t) => [t.windowId, t.level]), [[windowId, "notice"]], "one notice, even after another sweep");
  });

  suite("a delayed window never deploys at an unrelated time: closed before it could start is missed, and work that never went quiet is deferred", async (c) => {
    const v1 = await c.ready("v1");
    const w = c.win();
    const missed = await w.set(c.owner, { commandId: cid("w"), candidateId: v1.id, digest: v1.digest, ...at() });
    c.clock.t = OPENS + 61 * MIN;
    await w.tick();
    const m = await w.get(c.owner, missed.windowId);
    assert.equal(m.status, "missed");
    assert.match(m.reason ?? "", /will not be activated later/);
    c.clock.t = OPENS + 2 * 24 * 60 * MIN;
    await w.tick();
    assert.equal(c.pointer(), undefined, "nothing was activated, then or later");
    assert.deepEqual(c.told.map((t) => [t.windowId, t.level]), [[missed.windowId, "needs-you"]]);

    c.clock.t = OPENS + 2 * 24 * 60 * MIN - 120 * MIN;
    const deferred = await w.set(c.owner, { commandId: cid("w"), candidateId: v1.id, digest: v1.digest, ...at("2026-11-22", "00:30") });
    c.live.n = 1;
    c.clock.t = Date.parse("2026-11-22T00:40:00.000Z");
    await w.tick();
    c.clock.t = Date.parse("2026-11-22T01:31:00.000Z");
    await w.tick();
    const d = await w.get(c.owner, deferred.windowId);
    assert.equal(d.status, "deferred");
    assert.match(d.reason ?? "", /nothing was stopped/);
    c.live.n = 0;
    await w.tick();
    assert.equal(c.pointer(), undefined);
  });

  suite("a changed release is quarantined at preparation and no later window can take it; too little space fails without quarantine; a refused activation fails the window", async (c) => {
    const v1 = await c.ready("v1");
    const w = c.win();
    c.free.b = 1000;
    const space = await w.set(c.owner, { commandId: cid("w"), candidateId: v1.id, digest: v1.digest, ...at() });
    c.clock.t = OPENS - 10 * MIN;
    await w.tick();
    const s = await w.get(c.owner, space.windowId);
    assert.equal(s.status, "failed");
    assert.match(s.reason ?? "", /bytes are free/);
    assert.equal((await w.list(c.owner)).quarantined.length, 0, "a full disk is not the release's fault");
    c.free.b = 10 * 1024 ** 3;

    const unapproved = await c.ready("v-unapproved", false);
    const refused = await w.set(c.owner, { commandId: cid("w"), candidateId: unapproved.id, digest: unapproved.digest, ...at() });
    c.clock.t = OPENS + MIN;
    await w.tick();
    const r = await w.get(c.owner, refused.windowId);
    assert.equal(r.status, "failed");
    assert.match(r.reason ?? "", /activation was refused: .*not approved/);

    const v2 = await c.ready("v2");
    const tampered = await w.set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at("2026-11-21") });
    const file = join(c.root, "releases", v2.id, "controller.js");
    chmodSync(join(c.root, "releases", v2.id), 0o700); chmodSync(file, 0o600); writeFileSync(file, "changed");
    c.clock.t = Date.parse("2026-11-21T01:30:00.000Z");
    await w.tick();
    const t = await w.get(c.owner, tampered.windowId);
    assert.equal(t.status, "failed");
    assert.match(t.reason ?? "", /do not match its manifest/);
    assert.deepEqual((await w.list(c.owner)).quarantined.map((q) => q.candidateId), [v2.id]);
    await refuses("invalid_transition", () => w.set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at("2026-11-22") }), /quarantined/);
    assert.equal(c.pointer(), undefined);
    assert.equal(c.told.length, 3, "each failure told once");
  });

  suite("a release that fails to start after the window activated it is reverted and quarantined; cancelling is the owner's and only before activation", async (c) => {
    const v1 = await c.ready("v1");
    const failing = { ...c.act, verify: c.act.verify.bind(c.act), activate: c.act.activate.bind(c.act), rollbackCheck: c.act.rollbackCheck.bind(c.act), status: async (by: Principal) => { const s = await c.act.status(by); return { ...s, failedStarts: [...s.failedStarts, { id: v1.id, at: "x", reason: "exited before confirming" }] }; } };
    const w = c.win({ activation: failing });
    const { windowId } = await w.set(c.owner, { commandId: cid("w"), candidateId: v1.id, digest: v1.digest, ...at() });
    c.clock.t = OPENS + MIN;
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated", "prepared and activated in the same sweep once open");
    await w.tick();
    const r = await w.get(c.owner, windowId);
    assert.equal(r.status, "reverted");
    assert.match(r.reason ?? "", /failed to start/);
    assert.deepEqual((await w.list(c.owner)).quarantined.map((q) => q.candidateId), [v1.id]);
    await refuses("invalid_transition", () => w.cancel(c.owner, { commandId: cid("x"), windowId }), /already ended/);

    const v2 = await c.ready("v2");
    const plain = c.win();
    const later = await plain.set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at("2026-11-21") });
    await refuses("forbidden", () => plain.cancel(c.agent, { commandId: cid("x"), windowId: later.windowId }));
    const x = cid("x");
    assert.deepEqual(await plain.cancel(c.owner, { commandId: x, windowId: later.windowId }), { windowId: later.windowId, status: "cancelled" });
    c.clock.t = Date.parse("2026-11-21T02:10:00.000Z");
    await plain.tick();
    assert.equal((await plain.get(c.owner, later.windowId)).status, "cancelled");
    assert.equal(c.pointer(), v1.id, "the cancelled window activated nothing");
  });

  suite("local times across summer-time changes: a skipped time happens just after the gap, a repeated one is the first; a holder of release.manage reads the list", async (c) => {
    const r = await c.ready("v1");
    const w = c.win();
    // New York springs forward on 2027-03-14: 02:30 does not exist and comes to 03:30 EDT (07:30 UTC).
    const spring = await w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at("2027-03-14", "02:30", "America/New_York") });
    assert.deepEqual([spring.opensAt, spring.closesAt], ["2027-03-14T07:30:00.000Z", "2027-03-14T08:30:00.000Z"]);
    await w.cancel(c.owner, { commandId: cid("x"), windowId: spring.windowId });
    // New York falls back on 2027-11-07: 01:30 happens twice; the first (EDT, 05:30 UTC) is the one.
    const fall = await w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at("2027-11-07", "01:30", "America/New_York") });
    assert.equal(fall.opensAt, "2027-11-07T05:30:00.000Z");
    await w.cancel(c.owner, { commandId: cid("x"), windowId: fall.windowId });
    // London in summer is an hour ahead of UTC.
    const summer = await w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at("2027-07-01", "02:00") });
    assert.equal(summer.opensAt, "2027-07-01T01:00:00.000Z");
    const listed = await w.list(c.agent);
    assert.deepEqual(listed.windows.map((x) => x.status), ["cancelled", "scheduled", "cancelled"], "newest opening first (November, July, March)");
    await refuses("invalid_command", () => w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at("2027-12-01") }), /within a year/);
  });

  /** The real activation, with a process that stops right after (`after`) or right before (`before`) the switch: the window's record of the activation is then never written by that sweep. */
  const crashing = (c: W, where: "before" | "after", failedStart?: () => string | undefined) => {
    const state = { armed: true };
    return { state, activation: {
      verify: c.act.verify.bind(c.act), rollbackCheck: c.act.rollbackCheck.bind(c.act),
      status: async (by: Principal) => { const s = await c.act.status(by); const f = failedStart?.(); return f === undefined ? s : { ...s, failedStarts: [...s.failedStarts, { id: f, at: "x", reason: "exited before confirming" }] }; },
      activate: async (by: Principal, command: Parameters<ReleaseActivationService["activate"]>[1]) => {
        if (state.armed && where === "before") { state.armed = false; throw new Error("the controller stopped"); }
        const r = await c.act.activate(by, command);
        if (state.armed) { state.armed = false; throw new Error("the controller stopped"); }
        return r;
      },
    } };
  };

  suite("a controller that stops right after the switch, before the window recorded it: the next sweep settles it as activated from the activation record, even after the window closed, and cancel is refused", async (c) => {
    const v1 = await c.ready("v1");
    await c.act.activate(c.owner, { commandId: cid("a"), candidateId: v1.id, digest: v1.digest });
    const v2 = await c.ready("v2");
    const first = crashing(c, "after");
    const { windowId } = await c.win({ activation: first.activation }).set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at() });
    c.clock.t = OPENS + MIN;
    await assert.rejects(() => c.win({ activation: first.activation }).tick(), /controller stopped/);
    assert.equal(c.pointer(), v2.id, "the switch happened");
    const restarted = c.win();
    const half = await restarted.get(c.owner, windowId);
    assert.equal(half.status, "prepared");
    assert.ok(half.activatingAt !== undefined, "the intent was saved before the switch");
    await refuses("invalid_transition", () => restarted.cancel(c.owner, { commandId: cid("x"), windowId }), /already switched/);
    c.clock.t = OPENS + 2 * 60 * MIN;
    await restarted.tick();
    const settled = await restarted.get(c.owner, windowId);
    assert.deepEqual([settled.status, settled.from], ["activated", v1.id], "not missed: the release did switch");
    assert.deepEqual(c.told, [], "nothing false was told");
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: v2.id });
    await restarted.tick();
    assert.equal((await restarted.get(c.owner, windowId)).status, "committed");
  });

  suite("a stop after the switch whose release then failed to start is reverted and quarantined, not failed; a stop before the switch, found after the close, is missed and switches nothing", async (c) => {
    const v1 = await c.ready("v1");
    const fell = { id: undefined as string | undefined };
    const first = crashing(c, "after", () => fell.id);
    const { windowId } = await c.win({ activation: first.activation }).set(c.owner, { commandId: cid("w"), candidateId: v1.id, digest: v1.digest, ...at() });
    c.clock.t = OPENS + MIN;
    await assert.rejects(() => c.win({ activation: first.activation }).tick(), /controller stopped/);
    fell.id = v1.id;
    // The controller comes back only after the window closed: the switch it made is still what is settled.
    c.clock.t = OPENS + 3 * 60 * MIN;
    const restarted = c.win({ activation: first.activation });
    await restarted.tick();
    assert.equal((await restarted.get(c.owner, windowId)).status, "activated");
    await restarted.tick();
    const r = await restarted.get(c.owner, windowId);
    assert.equal(r.status, "reverted", r.reason);
    assert.deepEqual((await restarted.list(c.owner)).quarantined.map((q) => q.candidateId), [v1.id]);
    assert.deepEqual(c.told.map((t) => t.level), ["needs-you"]);

    const v2 = await c.ready("v2");
    const early = crashing(c, "before");
    const second = await c.win({ activation: early.activation }).set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at("2026-11-21") });
    c.clock.t = Date.parse("2026-11-21T02:01:00.000Z");
    await assert.rejects(() => c.win({ activation: early.activation }).tick(), /controller stopped/);
    c.clock.t = Date.parse("2026-11-21T03:01:00.000Z");
    const again = c.win();
    await again.tick();
    const m = await again.get(c.owner, second.windowId);
    assert.equal(m.status, "missed", m.reason);
    assert.equal(c.pointer(), v1.id, "the late sweep switched nothing");
    await again.tick();
    assert.equal(c.pointer(), v1.id);
  });

  suite("a long wait whose count of running attempts goes up and down keeps saying what it waits for (no repeated step names after the history is full)", async (c) => {
    const r = await c.ready("v1");
    const w = c.win();
    const { windowId } = await w.set(c.owner, { commandId: cid("w"), candidateId: r.id, digest: r.digest, ...at(undefined, undefined, undefined), durationMinutes: 180 });
    c.clock.t = OPENS + MIN;
    for (let i = 0; i < 30; i++) { c.live.n = 1 + (i % 2); await w.tick(); }
    const got = await w.get(c.owner, windowId);
    assert.deepEqual([got.status, got.waiting], ["prepared", "2 agent attempt(s) running"]);
    c.live.n = 0;
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated");
  });
}
