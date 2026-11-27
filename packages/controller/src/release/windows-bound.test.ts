import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type Built } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { PauseService, type PauseScope } from "../lifecycle/index.js";
import { ReleaseActivationService, ReleaseService, ReleaseWindowService, type WindowNotice, type WindowOptions, type WindowQuiescePort } from "./index.js";

/**
 * Card K07 (bound slice): a maintenance window is bounded by its close. An activated window whose release this process is not running when the window closes (NimbleNewt was not restarted into it in
 * time) has its own switch undone with the journalled rollback, ends reverted (not quarantined) and gives back its pause and suspensions, so the release never starts at a later, unrelated time and the
 * maintenance never silently outlasts the window. Same world as windows-quiesce.test.ts: the real staging, activation and pause services on every storage backend, a fake dispatcher, the test's clock.
 */
after(stopServer);
const options = { clock: () => "2026-11-18T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const unlockAll = (dir: string): void => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };
const linux = { os: "linux" as const, arch: "x64" as const };
const MIN = 60_000;
/** 2026-11-20 02:00 in London is 02:00 UTC; the windows here last 60 minutes, so they close at 03:00 UTC. */
const OPENS = Date.parse("2026-11-20T02:00:00.000Z");
const CLOSES = OPENS + 60 * MIN;
const at = { date: "2026-11-20", time: "02:00", timeZone: "Europe/London", durationMinutes: 60 };
const INST: PauseScope = { kind: "installation", id: "installation" };

interface Att { attemptId: string; state: string; frozen: boolean; frozenReason?: string }
interface W {
  owner: Principal; act: ReleaseActivationService; clock: { t: number }; told: WindowNotice[]; att: Att[]; pauses: PauseService;
  win: (o?: Partial<WindowOptions>) => ReleaseWindowService;
  ready: (content: string) => Promise<{ id: string; digest: string }>;
  pointer: () => string | undefined;
  /** v1 current, a window for v2 set, prepared and opened; `o` are the window's options (runningRelease and the like). */
  open: (o?: Partial<WindowOptions>) => Promise<{ windowId: string; v1: string; v2: string; w: ReleaseWindowService }>;
}

for (const backend of backends) {
  const suite = (name: string, body: (c: W) => Promise<void>): void => {
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const root = mkdtempSync(join(tmpdir(), "nn-wb-"));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
        const act = ReleaseActivationService.withEpoch(world.storage, projects.epoch, { root, switcher: "pointer", platform: linux, runner: options });
        const runner = new CommandRunner(world.storage, projects.epoch, options);
        const clock = { t: OPENS - 3 * 60 * MIN };
        const told: WindowNotice[] = [];
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const pauses = PauseService.withEpoch(world.storage, projects.epoch, { waits: WaitService.withEpoch(world.storage, projects.epoch, assignments, options) }, options);
        const att: Att[] = [];
        const port: WindowQuiescePort = {
          pauses: { pause: (by, cmd) => pauses.pause(by, cmd), resumeOwnHold: (by, cmd) => pauses.resumeOwnHold(by, cmd), gateState: (s) => pauses.gateState(s), ownPause: (s, o) => pauses.ownPause(s, o) },
          attempts: async () => att.map((a) => ({ ...a })),
          freeze: async (id, reason) => { const a = att.find((x) => x.attemptId === id)!; if (!a.frozen) { a.frozen = true; a.frozenReason = reason; } },
          release: async (id) => { const a = att.find((x) => x.attemptId === id); if (a === undefined) throw new DomainError("not_found", "gone"); a.frozen = false; delete a.frozenReason; },
        };
        const win = (o: Partial<WindowOptions> = {}): ReleaseWindowService => ReleaseWindowService.withEpoch(world.storage, projects.epoch, {
          activation: act, root, now: () => clock.t, freeBytes: async () => 10 * 1024 ** 3, notify: async (x) => { told.push(x); }, runner: options, quiesce: port,
          checkpoint: async () => ({ name: "backup-1", digest: sha("backup-1"), verified: true }), ...o,
        });
        const ready = async (content: string): Promise<{ id: string; digest: string }> => {
          const { candidateId } = await rel.submit(owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { "controller.js": sha(content) }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] } });
          mkdirSync(join(root, "incoming", candidateId), { recursive: true });
          writeFileSync(join(root, "incoming", candidateId, "controller.js"), content);
          const s = await act.stage(owner, { commandId: cid("st"), candidateId });
          await runner.command("test.approve", { commandId: cid("ap"), actor: owner.id }, async () => ({ payload: { candidateId }, build: async (): Promise<Built> => { const ref = { kind: "release-approval", id: candidateId }; return { ref, creates: true, changes: [{ type: "create", ref, body: { candidateId, by: owner.id, at: "x" } }], detail: {} }; } }));
          return { id: candidateId, digest: s.digest };
        };
        const pointer = (): string | undefined => existsSync(join(root, "current.json")) ? (JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { release: string }).release : undefined;
        const open = async (o: Partial<WindowOptions> = {}) => {
          const v1 = await ready("v1");
          await act.activate(owner, { commandId: cid("a"), candidateId: v1.id, digest: v1.digest });
          const v2 = await ready("v2");
          const w = win({ runningRelease: v1.id, ...o });
          const { windowId } = await w.set(owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at });
          clock.t = OPENS - 30 * MIN;
          await w.tick();
          clock.t = OPENS + MIN;
          return { windowId, v1: v1.id, v2: v2.id, w };
        };
        await body({ owner, act, clock, told, att, pauses, win, ready, pointer, open });
      } finally { await world.close(); unlockAll(join(root, "releases")); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };

  suite("an activated window that NimbleNewt was not restarted into is undone at its close: back to the release before, reverted and not quarantined, its pause and suspensions given back, the owner told once", async (c) => {
    const { windowId, v1, v2, w } = await c.open();
    c.att.push({ attemptId: "att-r1", state: "running", frozen: false });
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated");
    assert.equal(c.pointer(), v2);
    await w.tick();
    const held = c.told.filter((t) => t.label === "A maintenance window waits for a restart");
    assert.equal(held.length, 1);
    assert.match(held[0]!.detail, /Restart by 2026-11-20 03:00 UTC or it is undone\.$/, "the owner is told by when, in the notice itself");
    assert.ok(held[0]!.detail.length <= 200);
    // One millisecond before the close: still the window's to finish.
    c.clock.t = CLOSES - 1;
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated");
    assert.equal(c.pointer(), v2);
    c.clock.t = CLOSES;
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "reverted");
    assert.match(g.reason ?? "", new RegExp(`its switch was undone \\(back to ${v1}\\); the release will not start at a later, unrelated time and is not quarantined`));
    assert.ok(g.undoingAt !== undefined);
    assert.equal(c.pointer(), v1, "the launcher's pointer names the release that runs now, so no later start brings v2 in");
    const s = await c.act.status(c.owner);
    assert.deepEqual([s.current?.id, s.history.at(-1)?.kind, s.history.at(-1)?.by], [v1, "rolled_back", "service:release-window"], "the undo is the journalled rollback, in the window's name");
    assert.equal((await w.list(c.owner)).quarantined.length, 0, "never started, so never quarantined");
    assert.equal((await c.pauses.gateState(INST))?.intent, "active", "the window's pause ended with it");
    assert.deepEqual(c.att.map((a) => a.frozen), [false], "and its suspension");
    const outcome = c.told.filter((t) => t.label === "A maintenance window was reverted");
    assert.deepEqual(outcome.map((t) => t.level), ["needs-you"]);
    // Later sweeps, days later: nothing more is done or said, and the pointer stays.
    const before = c.told.length;
    c.clock.t = CLOSES + 3 * 24 * 60 * MIN;
    await w.tick();
    await w.tick();
    assert.equal(c.told.length, before);
    assert.equal(c.pointer(), v1);
    assert.equal((await w.get(c.owner, windowId)).status, "reverted");
  });

  suite("the bound leaves alone a window whose release is the one running here (the launcher's startup watchdog judges it), and an embedder that does not say what runs keeps the first slice's wait", async (c) => {
    const { windowId, v2, w } = await c.open();
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "activated");
    // The same database seen by the process started from v2 after a restart inside the window.
    const restarted = c.win({ runningRelease: v2 });
    c.clock.t = CLOSES + 10 * MIN;
    await restarted.tick();
    assert.equal((await restarted.get(c.owner, windowId)).status, "activated", "running the release itself: not undone");
    assert.equal(c.pointer(), v2);
    // No runningRelease given (older embedders): not enforced, and the held notice keeps its first wording.
    const legacy = c.win();
    await legacy.tick();
    assert.equal((await legacy.get(c.owner, windowId)).status, "activated");
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: v2 });
    await restarted.tick();
    assert.equal((await restarted.get(c.owner, windowId)).status, "committed");
    assert.equal(c.pointer(), v2);
  });

  suite("a process not started from a release (runningRelease null) undoes the switch too", async (c) => {
    const { windowId, v1, w } = await c.open({ runningRelease: null });
    await w.tick();
    c.clock.t = CLOSES + MIN;
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "reverted");
    assert.equal(c.pointer(), v1);
  });

  suite("when the switch cannot be undone the window ends failed and says the release runs at the next start: no earlier release, no rollback port, a refused rollback (its host path hidden)", async (c) => {
    // No earlier release: the window is the first activation.
    const v1 = await c.ready("v1");
    const w = c.win({ runningRelease: null });
    const first = await w.set(c.owner, { commandId: cid("w"), candidateId: v1.id, digest: v1.digest, ...at });
    c.clock.t = OPENS + MIN;
    await w.tick();
    assert.equal((await w.get(c.owner, first.windowId)).status, "activated");
    c.clock.t = CLOSES;
    await w.tick();
    const f = await w.get(c.owner, first.windowId);
    assert.equal(f.status, "failed");
    assert.match(f.reason ?? "", /could not be undone \(there is no earlier release to go back to\); the release runs at NimbleNewt's next start unless you roll it back/);
    assert.equal(c.pointer(), v1.id);
    assert.deepEqual(c.told.filter((t) => t.windowId === first.windowId && t.label !== "A maintenance window waits for a restart").map((t) => t.level), ["needs-you"]);
    assert.equal((await c.pauses.gateState(INST))?.intent, "active", "the window still gives back its pause");
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: v1.id });

    // A refused rollback (the K03 guard, say), whose text names a host folder.
    const v2 = await c.ready("v2");
    const refusing = c.win({ runningRelease: v1.id, activation: { ...bound(c.act), rollback: async () => { throw new DomainError("invalid_transition", "the release to go back to is not a tested pair with this data: /srv/nn-state/releases/x is newer"); } } });
    c.clock.t = OPENS + 24 * 60 * MIN - 30 * MIN;
    const second = await refusing.set(c.owner, { commandId: cid("w"), candidateId: v2.id, digest: v2.digest, ...at, date: "2026-11-21" });
    c.clock.t = OPENS + 24 * 60 * MIN + MIN;
    await refusing.tick();
    assert.equal((await refusing.get(c.owner, second.windowId)).status, "activated");
    c.clock.t = CLOSES + 24 * 60 * MIN;
    await refusing.tick();
    const r = await refusing.get(c.owner, second.windowId);
    assert.equal(r.status, "failed");
    assert.match(r.reason ?? "", /could not be undone \(the release to go back to is not a tested pair with this data: <path> is newer\)/);
    assert.ok(!/nn-state|srv/.test(JSON.stringify(r)) && !/nn-state|srv/.test(JSON.stringify(c.told)), "no host path in the record or the notice");
    assert.equal(r.rollback?.to, v1.id, "the way back the owner can still take is shown");
    assert.equal(c.pointer(), v2.id);
    assert.equal((await refusing.list(c.owner)).quarantined.length, 0);

    // No rollback port at all.
    await c.act.confirm(c.owner, { commandId: cid("c"), releaseId: v2.id });
    const v3 = await c.ready("v3");
    const { rollback: _r, ...noRollback } = bound(c.act);
    const bare = c.win({ runningRelease: v2.id, activation: noRollback });
    c.clock.t = OPENS + 2 * 24 * 60 * MIN - 30 * MIN;
    const third = await bare.set(c.owner, { commandId: cid("w"), candidateId: v3.id, digest: v3.digest, ...at, date: "2026-11-22" });
    c.clock.t = OPENS + 2 * 24 * 60 * MIN + MIN;
    await bare.tick();
    c.clock.t = CLOSES + 2 * 24 * 60 * MIN;
    await bare.tick();
    const b = await bare.get(c.owner, third.windowId);
    assert.equal(b.status, "failed");
    assert.match(b.reason ?? "", /no way to roll back/);
  });

  suite("a crash around the undo is settled from the activation record: before the rollback it is tried again; after it the window is reverted with its own reason; a rollback still open waits", async (c) => {
    const { windowId, v1, v2, w } = await c.open();
    await w.tick();
    c.clock.t = CLOSES + MIN;
    // The controller stops just as the rollback is called (nothing switched).
    const dying = c.win({ runningRelease: v1, activation: { ...bound(c.act), rollback: async () => { throw new Error("the controller stopped"); } } });
    await assert.rejects(() => dying.tick(), /the controller stopped/);
    const mid = await w.get(c.owner, windowId);
    assert.deepEqual([mid.status, mid.undoingAt !== undefined, c.pointer()], ["activated", true, v2]);
    // A rollback that raises after its journal opened (the commit could not be written): the window waits for the record, and is never failed while the switch may still finish.
    let opened = false;
    const openJournal = { kind: "rollback" as const, from: { id: v2, digest: "0".repeat(64) }, to: { id: v1, digest: "0".repeat(64) }, by: "service:release-window", startedAt: "x" };
    const raising = c.win({ runningRelease: v1, activation: { ...bound(c.act), status: async (by) => ({ ...(await c.act.status(by)), ...(opened ? { journal: openJournal } : {}) }), rollback: async () => { opened = true; throw new DomainError("unavailable", "the switch's commit could not be written"); } } });
    await raising.tick();
    const raised = await w.get(c.owner, windowId);
    assert.deepEqual([raised.status, raised.reason], ["activated", mid.reason], "not failed while the rollback's journal is open");
    // A rollback shown as still open in the journal: the window waits and writes nothing.
    const journal = { kind: "rollback" as const, from: { id: v2, digest: "0".repeat(64) }, to: { id: v1, digest: "0".repeat(64) }, by: "service:release-window", startedAt: "x" };
    const pending = c.win({ runningRelease: v1, activation: { ...bound(c.act), status: async (by) => ({ ...(await c.act.status(by)), journal }) } });
    await pending.tick();
    assert.equal((await w.get(c.owner, windowId)).revision, mid.revision, "nothing written while the rollback is open");
    // The rollback runs and the controller stops before the window records it: the next sweep reads the record and says why (not "another release became current").
    const after = c.win({ runningRelease: v1, activation: { ...bound(c.act), rollback: async (by, cmd) => { await c.act.rollback(by, cmd); throw new Error("the controller stopped after the rollback"); } } });
    await assert.rejects(() => after.tick(), /stopped after the rollback/);
    assert.equal(c.pointer(), v1);
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "reverted");
    assert.match(g.reason ?? "", /its switch was undone/);
    assert.equal((await c.act.status(c.owner)).history.filter((h) => h.kind === "rolled_back").length, 1, "rolled back once");
  });

  suite("a switch already open in the journal at the close (another switch under way) is waited for: the window neither marks an undo nor calls the rollback", async (c) => {
    const { windowId, v1, v2, w } = await c.open();
    await w.tick();
    c.clock.t = CLOSES + MIN;
    const calls: string[] = [];
    const journal = { kind: "activate" as const, from: { id: v2, digest: "0".repeat(64) }, to: { id: v1, digest: "0".repeat(64) }, by: c.owner.id, startedAt: "x" };
    const busy = c.win({ runningRelease: v1, activation: { ...bound(c.act), status: async (by) => ({ ...(await c.act.status(by)), journal }), rollback: async (by, cmd) => { calls.push(cmd.releaseId); return c.act.rollback(by, cmd); } } });
    await busy.tick();
    const g = await w.get(c.owner, windowId);
    assert.deepEqual([g.status, g.undoingAt, calls], ["activated", undefined, []]);
    assert.equal(c.pointer(), v2);
    await w.tick();
    assert.equal((await w.get(c.owner, windowId)).status, "reverted", "once the switch is no longer open, the undo goes ahead");
  });

  suite("the owner's own rollback before the close is the owner's: the window is reverted as before and does not roll back again", async (c) => {
    const { windowId, v1, w } = await c.open();
    await w.tick();
    await c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: v1 });
    c.clock.t = CLOSES + MIN;
    await w.tick();
    const g = await w.get(c.owner, windowId);
    assert.equal(g.status, "reverted");
    assert.match(g.reason ?? "", /another release/);
    assert.equal(g.undoingAt, undefined);
    assert.equal((await c.act.status(c.owner)).history.filter((h) => h.kind === "rolled_back").length, 1);
  });
}

/** The activation service's methods the window uses, bound, so a test can replace one. */
function bound(act: ReleaseActivationService): WindowOptions["activation"] & { rollback: ReleaseActivationService["rollback"] } {
  return { verify: (b, cmd) => act.verify(b, cmd), activate: (b, cmd) => act.activate(b, cmd), status: (b) => act.status(b), rollbackCheck: (b, id) => act.rollbackCheck(b, id), rollback: (b, cmd) => act.rollback(b, cmd) };
}
