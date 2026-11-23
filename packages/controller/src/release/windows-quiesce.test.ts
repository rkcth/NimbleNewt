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
import type { ControllerStorage } from "../storage/types.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { PauseService, type PauseScope } from "../lifecycle/index.js";
import { ReleaseActivationService, ReleaseService, ReleaseWindowService, type WindowNotice, type WindowOptions, type WindowQuiescePort } from "./index.js";

/**
 * Card K07 (quiesce and checkpoint slice): a window pauses new work and suspends running work before it switches, takes a verified checkpoint, and puts back only what it set. Same world as windows.test.ts, with the real pause gate and a fake dispatcher. Card K07: maintenance windows for release updates, on every storage backend, with the real staging and activation service and real release folders. The clock the windows are
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
  storage: ControllerStorage; epoch: number;
  pauses: PauseService; att: Att[]; log: string[]; q: { freezeFails: Set<string>; releaseFails: Set<string>; pauseBoom: boolean };
  qwin: (o?: Partial<WindowOptions>) => ReleaseWindowService;
  /** A prepared window that is open now, on a world where v1 is current. */
  open: () => Promise<{ windowId: string; v1: string; v2: string; w: ReleaseWindowService }>;
}
interface Att { attemptId: string; state: string; frozen: boolean }
const INST: PauseScope = { kind: "installation", id: "installation" };

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
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const waits = WaitService.withEpoch(world.storage, projects.epoch, assignments, options);
        const pauses = PauseService.withEpoch(world.storage, projects.epoch, { waits }, options);
        const att: Att[] = [];
        const log: string[] = [];
        const q = { freezeFails: new Set<string>(), releaseFails: new Set<string>(), pauseBoom: false };
        const port: WindowQuiescePort = {
          pauses: {
            pause: async (by, cmd) => { if (q.pauseBoom) { q.pauseBoom = false; throw new Error("the controller stopped"); } log.push("pause"); return pauses.pause(by, cmd); },
            resumeOwnHold: async (by, cmd) => { log.push("resume"); return pauses.resumeOwnHold(by, cmd); },
            gateState: (s) => pauses.gateState(s), ownPause: (s, o) => pauses.ownPause(s, o),
          },
          attempts: async () => att.map((a) => ({ ...a })),
          freeze: async (id) => { log.push(`freeze ${id}`); if (q.freezeFails.has(id)) throw new DomainError("unavailable", "a call would not settle"); att.find((a) => a.attemptId === id)!.frozen = true; },
          release: async (id) => { log.push(`release ${id}`); if (q.releaseFails.has(id)) throw new DomainError("unavailable", "the dispatcher is busy"); const a = att.find((x) => x.attemptId === id); if (a === undefined) throw new DomainError("not_found", "gone"); a.frozen = false; },
        };
        const qwin = (o: Partial<WindowOptions> = {}): ReleaseWindowService => win({ quiesce: port, checkpoint: async () => { log.push("checkpoint"); return { name: "backup-1", digest: sha("backup-1"), verified: true }; }, ...o });
        const open = async () => {
          const v1 = await ready("v1");
          await act.activate(owner, { commandId: cid("a"), candidateId: v1.id, digest: v1.digest });
          const v2 = await ready("v2");
          const w = qwin();
          const { windowId } = await w.set(owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at() });
          clock.t = OPENS - 30 * MIN;
          await w.tick();
          clock.t = OPENS + MIN;
          return { windowId, v1: v1.id, v2: v2.id, w };
        };
        await body({ owner, agent, act, root, clock, live, free, told, win, ready, pointer, storage: world.storage, epoch: projects.epoch, pauses, att, log, q, qwin, open });
      } finally { await world.close(); unlockAll(join(root, "releases")); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };

  suite("quiesce: running attempts are suspended (not released), waiting and parked ones do not hold the window up, new work is held by the window's pause, the checkpoint follows, and everything is put back at the end", async (c) => {
    const { windowId, v2, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false }, { attemptId: "att-r2", state: "running", frozen: false }, { attemptId: "att-w", state: "waiting", frozen: false }, { attemptId: "att-p", state: "parked", frozen: false });
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "activated", "a waiting and a parked attempt do not hold it back; the running ones were made quiet");
    assert.equal(c.pointer(), v2);
    assert.deepEqual(c.log, ["pause", "freeze att-r1", "freeze att-r2", "checkpoint"], "paused first, running work suspended, then the snapshot; nothing was released or stopped");
    assert.deepEqual([c.att[0]!.frozen, c.att[1]!.frozen, c.att[2]!.frozen, c.att[3]!.frozen], [true, true, false, false], "only running attempts are frozen");
    assert.deepEqual([g.quiesce?.running, g.quiesce?.waiting, g.quiesce?.parked, g.quiesce?.prior], [2, 1, 1, "active"]);
    assert.equal((await c.pauses.gateState(INST))?.intent, "pause", "no waiting or parked attempt can start while the release switches");
    assert.deepEqual([g.checkpoint?.name, g.checkpoint?.digest], ["backup-1", sha("backup-1")]);
    await w.tick();
    assert.equal((await c.pauses.gateState(INST))?.intent, "pause", "still held while the release has not confirmed its start");
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: v2 });
    await w.tick();
    const done = await w.get(c.owner, windowId);
    assert.equal(done.status, "committed");
    assert.deepEqual(c.att.map((a) => a.frozen), [false, false, false, false], "the suspended attempts were released");
    assert.equal((await c.pauses.gateState(INST))?.intent, "active", "the window's own pause is lifted");
    assert.ok(done.quiesce?.restoredAt !== undefined);
    await w.tick();
    assert.deepEqual(c.log.filter((l) => l === "resume" || l.startsWith("release")), ["release att-r1", "release att-r2", "resume"], "put back once");
  });

  suite("a running attempt that cannot be made quiet holds the window (nothing is stopped); when it closes the window is deferred and everything it set is put back", async (c) => {
    const { windowId, v1, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false }, { attemptId: "att-r2", state: "running", frozen: false });
    c.q.freezeFails.add("att-r2");
    await w.tick();
    await w.tick();
    const waiting = await w.get(c.owner, windowId);
    assert.equal(waiting.status, "prepared");
    assert.match(waiting.waiting ?? "", /1 running attempt\(s\) could not be made quiet \(att-r2/);
    assert.equal(waiting.history.filter((h) => h.event === "waiting").length, 1, "the same wait is written once");
    assert.equal(c.pointer(), v1, "nothing switched");
    assert.ok(!c.log.includes("checkpoint"), "no snapshot before the installation is quiet");
    assert.ok(!c.log.some((l) => l.startsWith("release")), "never released while held");
    c.q.freezeFails.clear();
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated", "once it could be made quiet the window went on");
  });

  suite("closing while an attempt would not go quiet is deferred, and the freezes and the pause the window made are lifted", async (c) => {
    const { windowId, v1, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false }, { attemptId: "att-r2", state: "running", frozen: false });
    c.q.freezeFails.add("att-r2");
    await w.tick();
    c.clock.t = OPENS + 61 * MIN;
    await w.tick();
    const d = await w.get(c.owner, windowId);
    assert.equal(d.status, "deferred");
    assert.equal(c.pointer(), v1);
    assert.deepEqual(c.att.map((a) => a.frozen), [false, false]);
    assert.equal((await c.pauses.gateState(INST))?.intent, "active");
    assert.match(d.quiesce?.summary ?? "", /put back: 2 suspended attempt\(s\) released; the window's own pause was lifted/);
  });

  suite("cancel clears only the window's own gates: an owner's earlier pause stays, and a freeze somebody else set stays", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("op"), scope: INST, reason: "owner pause" });
    const { windowId, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false }, { attemptId: "att-r2", state: "running", frozen: true }, { attemptId: "att-r3", state: "running", frozen: false });
    c.q.freezeFails.add("att-r3");
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).quiesce?.prior, "paused");
    assert.ok(!c.log.includes("pause"), "the window did not pause what was already paused");
    assert.deepEqual(c.log.filter((l) => l.startsWith("freeze")), ["freeze att-r1", "freeze att-r3"], "a freeze somebody else set was not touched");
    await w.cancel(c.owner, { commandId: cid("x"), windowId });
    assert.equal((await w.get(c.owner, windowId)).status, "cancelled");
    assert.deepEqual(c.att.map((a) => a.frozen), [false, true, false], "its own freezes are lifted; the other freeze stays");
    assert.equal((await c.pauses.gateState(INST))?.intent, "pause", "the owner's own pause stays");
    assert.ok(!c.log.includes("resume"));
    assert.match((await w.get(c.owner, windowId)).quiesce?.summary ?? "", /was left as it was/);
  });

  suite("cancel lifts the pause the window made and nothing set after it", async (c) => {
    const { windowId, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false });
    c.q.freezeFails.add("att-r1");
    await w.tick();
    assert.equal((await c.pauses.gateState(INST))?.intent, "pause");
    await w.cancel(c.owner, { commandId: cid("x"), windowId });
    assert.equal((await c.pauses.gateState(INST))?.intent, "active");
    assert.equal(c.att[0]!.frozen, false);
    // The owner pauses again later: a repeat sweep never touches it.
    await c.pauses.pause(c.owner, { commandId: cid("op2"), scope: INST, reason: "later" });
    await w.tick();
    assert.equal((await c.pauses.gateState(INST))?.intent, "pause");
  });

  suite("the owner lifting the pause mid-window holds the switch back", async (c) => {
    const { windowId, v1, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false });
    c.q.freezeFails.add("att-r1");
    await w.tick();
    await c.pauses.resume(c.owner, { commandId: cid("or"), scope: INST, reason: "owner lifts it" });
    c.q.freezeFails.clear();
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "prepared");
    assert.match(g.waiting ?? "", /pause holding new work was lifted/);
    assert.equal(c.pointer(), v1);
    assert.equal(c.log.filter((l) => l === "pause").length, 1, "the window did not pause again against the owner");
    await c.pauses.pause(c.owner, { commandId: cid("op3"), scope: INST, reason: "owner pauses again" });
    c.clock.t = OPENS + 61 * MIN;
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "deferred");
    assert.equal((await c.pauses.gateState(INST))?.intent, "pause", "the owner's later pause outlives the window");
    assert.ok(!c.log.includes("resume"));
  });

  suite("a crash between the record and the pause is settled from the record: one pause, no second", async (c) => {
    const { windowId, w } = await c.open();
    c.q.pauseBoom = true;
    await assert.rejects(() => w.tick(), /controller stopped/);
    assert.equal((await c.pauses.gateState(INST))?.intent ?? "active", "active");
    assert.equal((await w.get(c.owner, windowId)).quiesce?.prior, "active");
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated");
    assert.equal(c.log.filter((l) => l === "pause").length, 1);
  });

  suite("a failed restore step is kept and tried again at the next sweep", async (c) => {
    const { windowId, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false });
    await w.tick();
    c.q.releaseFails.add("att-r1");
    // The window ends when the release confirms its start; the release of the suspended attempt fails then.
    const g0 = await w.get(c.owner, windowId);
    assert.equal(g0.status, "activated");
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: g0.candidateId });
    await w.tick();
    const g1 = await w.get(c.owner, windowId);
    assert.equal(g1.status, "committed");
    assert.match(g1.quiesce?.problem ?? "", /att-r1/);
    assert.equal(g1.quiesce?.restoredAt, undefined);
    c.q.releaseFails.clear();
    await w.tick();
    const g2 = await w.get(c.owner, windowId);
    assert.ok(g2.quiesce?.restoredAt !== undefined);
    assert.equal(g2.quiesce?.problem, undefined);
    assert.equal((await c.pauses.gateState(INST))?.intent, "active");
  });

  for (const kind of ["throws", "unverified"] as const) suite(`checkpoint (${kind}): a snapshot that cannot be taken or does not verify fails the window before anything switches, and the window puts everything back`, async (c) => {
    const { windowId, v1 } = await c.open();
    const w = c.qwin({ checkpoint: async () => { if (kind === "throws") throw new Error("the disk is full"); return { name: "backup-x", digest: sha("x"), verified: false, problems: ["a table file is missing"] }; } });
    c.att.push({ attemptId: "att-1", state: "running", frozen: false });
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "failed");
    assert.match(g.reason ?? "", kind === "throws" ? /disk is full/ : /did not verify \(a table file is missing/);
    assert.equal(c.pointer(), v1, "nothing switched");
    assert.equal(c.att[0]!.frozen, false, "suspended work is released");
    assert.equal((await c.pauses.gateState(INST))?.intent, "active");
    assert.equal(c.told.at(-1)?.level, "needs-you");
  });

  suite("a window with no checkpoint port or no quiesce port still behaves as the first slice did", async (c) => {
    const v1 = await c.ready("v1");
    await c.act.activate(c.owner, { commandId: cid("a"), candidateId: v1.id, digest: v1.digest });
    const v2 = await c.ready("v2");
    const w = c.win();
    const { windowId } = await w.set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at() });
    c.clock.t = OPENS + MIN;
    await w.tick();
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "activated");
    assert.deepEqual([g.quiesce, g.checkpoint], [undefined, undefined]);
    assert.equal((await c.pauses.gateState(INST))?.intent ?? "active", "active");
  });
}
