import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner, type Built } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";

import { Launcher, LAUNCHER_FILE, PointerSwitcher, ReleaseActivationService, ReleaseService, SimulatedCrash, SymlinkSwitcher, parseCompat, type ActivationOptions } from "./index.js";

after(stopServer);
const options = { clock: () => "2026-10-31T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
/** Staged folders are read-only on POSIX: they are made writable again so that a test folder can be removed. */
const unlockAll = (dir: string): void => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };
const linux = { os: "linux" as const, arch: "x64" as const };

for (const backend of backends.slice(0, 2)) for (const switcher of ["symlink", "pointer"] as const) {
  const suite = (name: string, body: (c: W) => Promise<void>): void => {
    // On Windows the production default is the pointer file: a rename cannot replace a directory symlink there (EPERM), so the symlink switcher is not offered and not tested.
    test(`${backend.name}, ${switcher}: ${name}`, { skip: switcher === "symlink" && process.platform === "win32" ? "the symlink switcher is POSIX-only; Windows uses the pointer file" : false }, async () => {
      const world = await backend.open();
      const root = mkdtempSync(join(tmpdir(), "nn-act-"));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "builder", grants: [{ action: "release.report", project: "*" }] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:builder")).token);
        const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
        const make = (extra: Partial<ActivationOptions> = {}): ReleaseActivationService => ReleaseActivationService.withEpoch(world.storage, projects.epoch, { root, switcher, platform: linux, runner: options, ...extra });
        const runner = new CommandRunner(world.storage, projects.epoch, options);
        /** Submits a candidate whose artifacts are written to incoming/, and returns its ID. `files` maps name to content; `lie` names files whose manifest digest is wrong. */
        const candidate = async (files: Record<string, string>, opts: { lie?: string[]; matrix?: object[] } = {}): Promise<string> => {
          const artifacts = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, opts.lie?.includes(k) ? sha("other") : sha(v)]));
          const { candidateId } = await rel.submit(owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts, dependencyLocks: { lock: sha("lock") }, matrix: opts.matrix ?? [linux] } });
          for (const [k, v] of Object.entries(files)) { const p = join(root, "incoming", candidateId, ...k.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, v); }
          return candidateId;
        };
        const approve = async (id: string): Promise<void> => {
          await runner.command("test.approve", { commandId: cid("ap"), actor: owner.id }, async () => ({ payload: { id }, build: async (): Promise<Built> => { const ref = { kind: "release-approval", id }; return { ref, creates: true, changes: [{ type: "create", ref, body: { candidateId: id, by: owner.id, at: "x" } }], detail: {} }; } }));
        };
        await body({ act: make(), make, owner, agent, candidate, approve, rel, root, runner, storage: world.storage });
      } finally { await world.close(); unlockAll(join(root, "releases")); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };
  interface W { act: ReleaseActivationService; make: (o?: Partial<ActivationOptions>) => ReleaseActivationService; owner: Principal; agent: Principal; candidate: (f: Record<string, string>, o?: { lie?: string[]; matrix?: object[] }) => Promise<string>; approve: (id: string) => Promise<void>; rel: ReleaseService; root: string; runner: CommandRunner; storage: unknown }
  const pointer = (root: string): string | undefined => {
    if (switcher === "symlink") return existsSync(join(root, "current")) || lstatOk(join(root, "current")) ? readlinkSync(join(root, "current")).replace(/^releases\//, "") : undefined;
    return existsSync(join(root, "current.json")) ? (JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { release: string }).release : undefined;
  };
  const lstatOk = (p: string): boolean => { try { lstatSync(p); return true; } catch { return false; } };

  const compat = (min: number, max = min): string => JSON.stringify({ protocol: { min, max } });
  /** A candidate whose artifacts include a compat.json. */
  const release = (c: W, tag: string, min = 1, max = min): Promise<string> => c.candidate({ "nn.js": `release ${tag}`, "compat.json": compat(min, max) });
  const staged = async (c: W, act: ReleaseActivationService, tag: string, min = 1, max = min): Promise<{ id: string; digest: string }> => {
    const id = await release(c, tag, min, max);
    const s = await act.stage(c.owner, { commandId: cid("st"), candidateId: id });
    await c.approve(id);
    return { id, digest: s.digest };
  };
  const activate = (c: W, act: ReleaseActivationService, r: { id: string; digest: string }) => act.activate(c.owner, { commandId: cid("a"), candidateId: r.id, digest: r.digest });
  const workers = (min: number, max = min) => ({ workers: { min, max }, required: true });

  suite("staging reads the release's compat.json, requires one when the installation does, refuses a damaged one, and refuses artifacts under the launcher's and updater's names", async (c) => {
    const act = c.make({ compat: workers(1) });
    const ok = await release(c, "a");
    await act.stage(c.owner, { commandId: cid("st"), candidateId: ok });
    const none = await c.candidate({ "nn.js": "no compat" });
    await refuses("invalid_command", () => act.stage(c.owner, { commandId: cid("st"), candidateId: none }), /compat\.json/);
    for (const text of ["not json", "[]", '{"protocol":{"min":2,"max":1}}', '{"protocol":{"min":1,"max":1},"extra":1}', '{"protocol":{"min":1,"max":1,"x":1}}', "{}"]) {
      const bad = await c.candidate({ "nn.js": `bad ${text}`, "compat.json": text });
      await refuses("invalid_command", () => act.stage(c.owner, { commandId: cid("st"), candidateId: bad }), /compat\.json/);
    }
    for (const name of ["launcher", "launcher/run.js", "updater.js", "Updater/x", "LAUNCHER.exe", "launcher.tar.gz", "updater..", "Launcher.d.ts"]) {
      const id = await c.candidate({ [name]: "replacement", "compat.json": compat(1) });
      await refuses("invalid_command", () => act.stage(c.owner, { commandId: cid("st"), candidateId: id }), /launcher and the updater/);
    }
    assert.deepEqual(existsSync(join(c.root, "releases")) ? readdirSync(join(c.root, "releases")) : [], [ok], "only the good release is on disk");
    // Without the requirement, a release without compat.json stages (the check is the installation's choice) and declares no range.
    const lax = c.make();
    await lax.stage(c.owner, { commandId: cid("st"), candidateId: none });
  });

  suite("activation and rollback are refused for a release whose controller shares no protocol version with the workers, and a rollback target is checked against the workers as they are now (mixed versions)", async (c) => {
    const act = c.make({ compat: workers(1, 2) });
    const old = await staged(c, act, "old", 1);
    const newer = await staged(c, act, "newer", 2);
    const future = await staged(c, act, "future", 3);
    await refuses("invalid_transition", () => activate(c, act, future), /cannot work with this installation's workers/);
    assert.equal(pointer(c.root), undefined, "nothing switched");
    await activate(c, act, old);
    await activate(c, act, newer);
    assert.equal(pointer(c.root), newer.id);
    // The workers have been upgraded to protocol 2 only: the previous release (protocol 1 only) can no longer talk to them, so the rollback is refused.
    const upgraded = c.make({ compat: workers(2) });
    await refuses("invalid_transition", () => upgraded.rollback(c.owner, { commandId: cid("rb"), releaseId: old.id }), /cannot work with this installation's workers: .*too old/);
    assert.equal(pointer(c.root), newer.id, "the refused rollback moved nothing");
    // With workers that still speak 1 and 2, the same rollback is fine.
    await act.rollback(c.owner, { commandId: cid("rb"), releaseId: old.id });
    assert.equal(pointer(c.root), old.id);
    // A release staged without the requirement declares nothing: a strict installation does not switch to it.
    const lax = c.make();
    const bare = await c.candidate({ "nn.js": "bare" });
    const bs = await lax.stage(c.owner, { commandId: cid("st"), candidateId: bare });
    await c.approve(bare);
    await refuses("invalid_transition", () => activate(c, act, { id: bare, digest: bs.digest }), /declares no worker protocol range/);
  });

  suite("a start is confirmed only by the release the process runs as, only when the record names it current; the confirmed release becomes the last known good and survives later switches", async (c) => {
    const a = await staged(c, c.make({ compat: workers(1) }), "a");
    const b = await staged(c, c.make({ compat: workers(1) }), "b");
    const plain = c.make({ compat: workers(1) });
    await activate(c, plain, a);
    assert.deepEqual((await plain.confirmStartup()), { confirmed: false, reason: "this process was not started by the launcher" });
    let st = await plain.status(c.owner);
    assert.deepEqual([st.confirmed, st.lastKnownGood], [false, undefined]);
    // The launcher starts a; the process runs as b (wrong release): nothing is confirmed.
    assert.equal((await plain.launcher.prepare()).action, "run");
    const wrong = c.make({ compat: workers(1), runningRelease: b.id });
    assert.equal((await wrong.confirmStartup()).confirmed, false);
    const right = c.make({ compat: workers(1), runningRelease: a.id });
    assert.deepEqual(await right.confirmStartup(), { confirmed: true });
    assert.deepEqual(await right.confirmStartup(), { confirmed: true }, "repeating changes nothing");
    st = await right.status(c.owner);
    assert.deepEqual([st.confirmed, st.lastKnownGood?.id, st.lastKnownGood?.via, st.history.filter((h) => h.kind === "confirmed").length], [true, a.id, "startup", 1]);
    // Switching to b leaves a as the last known good until b reports; a stays protected from removal.
    await activate(c, right, b);
    st = await right.status(c.owner);
    assert.deepEqual([st.current?.id, st.confirmed, st.lastKnownGood?.id], [b.id, false, a.id]);
    await refuses("invalid_transition", () => right.remove(c.owner, { commandId: cid("rm"), candidateId: a.id }), /cannot be removed/);
    // A start of b under the launcher then confirms it.
    assert.equal((await right.launcher.prepare()).action, "run");
    assert.equal((await c.make({ compat: workers(1), runningRelease: b.id }).confirmStartup()).confirmed, true);
    assert.equal((await right.status(c.owner)).lastKnownGood?.id, b.id);
    // Two more switches without a confirmed start: b is neither current nor previous any more, only the last known good, and still cannot be removed or pruned.
    const d = await staged(c, right, "d");
    const e = await staged(c, right, "e");
    await activate(c, right, d);
    await activate(c, right, e);
    st = await right.status(c.owner);
    assert.deepEqual([st.current?.id, st.previous?.id, st.lastKnownGood?.id], [e.id, d.id, b.id]);
    await refuses("invalid_transition", () => right.remove(c.owner, { commandId: cid("rm"), candidateId: b.id }), /cannot be removed/);
    await right.setSettings(c.owner, { commandId: cid("set"), keepStaged: 1 });
    await staged(c, right, "f");
    assert.ok(existsSync(join(c.root, "releases", b.id)), "pruning spares the last known good");
  });

  suite("a release that fails to start is quarantined and the launcher falls back to the last known good; the record catches up on the next start and the failed release cannot be activated again", async (c) => {
    const act = c.make({ compat: workers(1) });
    const good = await staged(c, act, "good");
    const bad = await staged(c, act, "bad");
    await activate(c, act, good);
    assert.equal((await act.launcher.prepare()).action, "run");
    await c.make({ compat: workers(1), runningRelease: good.id }).confirmStartup();
    await activate(c, act, bad);
    const first = await act.launcher.prepare();
    assert.deepEqual([first.action, (first as { releaseId?: string }).releaseId], ["run", bad.id], "the new release is tried");
    // It never reports healthy (it crashed): the next launch finds the unconfirmed start.
    const second = await act.launcher.prepare();
    assert.equal(second.action, "run");
    assert.equal((second as { releaseId: string }).releaseId, good.id);
    assert.match((second as { fellBack: { reason: string } }).fellBack.reason, /never confirmed/);
    assert.equal(pointer(c.root), good.id, "the pointer went back to the release that is known to start");
    // The controller starts from the good release: its record catches up.
    const later = c.make({ compat: workers(1), runningRelease: good.id });
    assert.equal((await later.recover()).resolved, "fell_back");
    const st = await later.status(c.owner);
    assert.deepEqual([st.current?.id, st.previous, st.diverged, st.confirmed, st.lastKnownGood?.id, st.history.at(-1)?.kind, st.failedStarts.map((f) => f.id)], [good.id, undefined, false, true, good.id, "fell_back", [bad.id]]);
    assert.equal((await later.recover()).resolved, "none", "recovery is done once");
    await refuses("invalid_transition", () => activate(c, later, bad), /failed to start on this installation/);
    // The launcher keeps running the good release; the quarantined one is never run even if the pointer is put back by hand.
    assert.equal((await later.launcher.prepare()).action, "run");
    const hand = switcher === "symlink" ? () => { rmSync(join(c.root, "current")); symlinkSync(`releases/${bad.id}`, join(c.root, "current")); } : () => writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: bad.id }));
    hand();
    const again = await later.launcher.prepare();
    assert.deepEqual([again.action, (again as { releaseId: string }).releaseId, pointer(c.root)], ["run", good.id, good.id], "the quarantined release is not run even when the pointer is put back by hand")
  });

  suite("with no last known good, a failed start blocks and leaves the pointer alone; a damaged launcher record, a pointer nobody announced and a tampered release all block instead of running", async (c) => {
    const act = c.make({ compat: workers(1) });
    const only = await staged(c, act, "only");
    await activate(c, act, only);
    assert.equal((await act.launcher.prepare()).action, "run");
    const blocked = await act.launcher.prepare();
    assert.equal(blocked.action, "blocked");
    assert.match((blocked as { reason: string }).reason, /never confirmed.*no last known good/);
    assert.equal(pointer(c.root), only.id, "nothing is guessed: the pointer is where it was");
    assert.equal((await act.launcher.prepare()).action, "blocked", "and it stays blocked");

    // A damaged record.
    writeFileSync(join(c.root, LAUNCHER_FILE), "{ not json");
    const damaged = await act.launcher.prepare();
    assert.deepEqual([damaged.action, /damaged/.test((damaged as { reason: string }).reason)], ["blocked", true]);
    writeFileSync(join(c.root, LAUNCHER_FILE), JSON.stringify({ v: 1, failed: [{ id: "../../x", at: "t", reason: "r" }], log: [] }));
    assert.equal((await act.launcher.prepare()).action, "blocked", "a record with a foreign release name is refused");
    rmSync(join(c.root, LAUNCHER_FILE));
    // Without a record the pointer's release was never announced to the launcher.
    const unannounced = await act.launcher.prepare();
    assert.deepEqual([unannounced.action, /never announced/.test((unannounced as { reason: string }).reason)], ["blocked", true]);
  });

  suite("the fall-back is only taken when the last known good still verifies and still speaks to the workers; otherwise it blocks", async (c) => {
    const act = c.make({ compat: workers(1) });
    const good = await staged(c, act, "good", 1);
    const bad = await staged(c, act, "bad", 1);
    await activate(c, act, good);
    await act.launcher.prepare();
    await c.make({ compat: workers(1), runningRelease: good.id }).confirmStartup();
    await activate(c, act, bad);
    await act.launcher.prepare();
    // The workers moved on to protocol 2 meanwhile: the old release cannot talk to them, so it is no fall-back.
    const upgraded = c.make({ compat: workers(2) });
    const refused = await upgraded.launcher.prepare();
    assert.equal(refused.action, "blocked");
    assert.match((refused as { reason: string }).reason, /not compatible with the workers/);
    assert.equal(pointer(c.root), bad.id, "the pointer was not moved to an incompatible release");
    // A last known good whose files were changed after it was confirmed is no fall-back either.
    const again = c.make({ compat: workers(1) });
    unlockAll(join(c.root, "releases", good.id));
    chmodSync(join(c.root, "releases", good.id, "nn.js"), 0o644);
    writeFileSync(join(c.root, "releases", good.id, "nn.js"), "EVIL");
    const tampered = await again.launcher.prepare();
    assert.equal(tampered.action, "blocked");
    assert.match((tampered as { reason: string }).reason, /no longer verifies/);
    assert.equal(pointer(c.root), bad.id);
  });

  suite("a switch interrupted right after the pointer moved resolves to the new release, and the launcher runs it because it was announced first; a pointer put somewhere by hand is not run", async (c) => {
    let crash = false;
    const act = c.make({ compat: workers(1), hook: (p) => { if (crash && p === "afterSwitch") throw new SimulatedCrash(p); } });
    const a = await staged(c, act, "a");
    const b = await staged(c, act, "b");
    await activate(c, act, a);
    await act.launcher.prepare();
    await c.make({ compat: workers(1), runningRelease: a.id }).confirmStartup();
    crash = true;
    await assert.rejects(() => activate(c, act, b), SimulatedCrash);
    crash = false;
    const next = c.make({ compat: workers(1), runningRelease: b.id });
    assert.equal((await next.recover()).resolved, "committed");
    const run = await next.launcher.prepare();
    assert.deepEqual([run.action, (run as { releaseId: string }).releaseId], ["run", b.id]);
    assert.deepEqual(await next.confirmStartup(), { confirmed: true });
    assert.equal((await next.status(c.owner)).lastKnownGood?.id, b.id);
    // A crash before the switch leaves the old release running (the announcement is made only just before the pointer moves).
    const c2 = await staged(c, next, "c");
    const dying = c.make({ compat: workers(1), hook: (p) => { if (p === "afterVerify") throw new SimulatedCrash(p); } });
    await assert.rejects(() => activate(c, dying, c2), SimulatedCrash);
    assert.equal(pointer(c.root), b.id);
    // The pointer is moved by hand to a staged release nobody announced: not run, and nothing is changed by the launcher.
    const sw = pointer(c.root);
    const hand = switcher === "symlink" ? () => { rmSync(join(c.root, "current")); symlinkSync(`releases/${c2.id}`, join(c.root, "current")); } : () => writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: c2.id }));
    hand();
    const run2 = await next.launcher.prepare();
    assert.equal(sw, b.id);
    assert.equal(run2.action, "run", "the launcher falls back to the last known good rather than run an unannounced release");
    assert.equal((run2 as { releaseId: string }).releaseId, b.id);
  });

  suite("a switch interrupted between the announcement and the pointer write leaves the old release runnable even with no last known good; the last known good is never quarantined for files that do not verify; a crash right after a fall-back moved the pointer still leaves the failed release quarantined", async (c) => {
    const act = c.make({ compat: workers(1) });
    const a = await staged(c, act, "a");
    const b = await staged(c, act, "b");
    const d = await staged(c, act, "d");
    await activate(c, act, a);
    // a was never started by the launcher, so nothing is known good yet. The switch to b dies after b was announced, before the pointer moved.
    await assert.rejects(() => activate(c, c.make({ compat: workers(1), hook: (p) => { if (p === "afterAnnounce") throw new SimulatedCrash(p); } }), b), SimulatedCrash);
    assert.equal(pointer(c.root), a.id);
    const first = await act.launcher.prepare();
    assert.deepEqual([first.action, (first as { releaseId?: string }).releaseId], ["run", a.id], "the release the pointer still names was announced before; it is run, not refused as unannounced");
    const back = c.make({ compat: workers(1), runningRelease: a.id });
    assert.equal((await back.recover()).resolved, "aborted");
    assert.deepEqual(await back.confirmStartup(), { confirmed: true });
    // The last known good's files stop verifying (here: changed; it could be a passing read error): it is not run, but not quarantined either, and it runs again once its files are right.
    const file = join(c.root, "releases", a.id, "nn.js");
    unlockAll(join(c.root, "releases", a.id));
    chmodSync(file, 0o644);
    writeFileSync(file, "EVIL");
    const blocked = await act.launcher.prepare();
    assert.equal(blocked.action, "blocked");
    assert.match((blocked as { reason: string }).reason, /last known good itself/);
    writeFileSync(file, "release a");
    const again = await act.launcher.prepare();
    assert.deepEqual([again.action, (again as { releaseId?: string }).releaseId], ["run", a.id], "a restored last known good runs again");
    assert.deepEqual((await act.launcher.read()).failed, []);
    // d is activated and fails to start; the launcher moves the pointer back to a and dies before it records anything more.
    await activate(c, back, d);
    assert.equal((await act.launcher.prepare()).action, "run");
    const real = switcher === "symlink" ? new SymlinkSwitcher(c.root) : new PointerSwitcher(c.root);
    const state = join(c.root, LAUNCHER_FILE);
    let saved = "";
    const dying = new Launcher({ root: c.root, workers: { min: 1, max: 1 }, switcher: { read: () => real.read(), clear: () => real.clear(), write: async (id) => { await real.write(id); saved = readFileSync(state, "utf8"); rmSync(state); mkdirSync(join(state, "x"), { recursive: true }); } } });
    await assert.rejects(() => dying.prepare());
    rmSync(state, { recursive: true }); writeFileSync(state, saved);
    assert.equal(pointer(c.root), a.id);
    assert.deepEqual((await act.launcher.read()).failed.map((f) => f.id), [d.id], "the quarantine was written before the pointer moved");
    const next = await act.launcher.prepare();
    assert.deepEqual([next.action, (next as { releaseId?: string }).releaseId], ["run", a.id]);
    const later = c.make({ compat: workers(1), runningRelease: a.id });
    assert.equal((await later.recover()).resolved, "fell_back", "the record catches up");
    await refuses("invalid_transition", () => activate(c, later, d), /failed to start on this installation/);
  });

  suite("the owner confirms the current release by hand: verified first, only the owner, only the current release, with the revision guarded", async (c) => {
    const act = c.make({ compat: workers(1) });
    const a = await staged(c, act, "a");
    const b = await staged(c, act, "b");
    await activate(c, act, a);
    const rev = (await act.status(c.owner)).revision;
    await refuses("forbidden", () => act.confirm(c.agent, { commandId: cid("c"), releaseId: a.id }));
    await refuses("invalid_transition", () => act.confirm(c.owner, { commandId: cid("c"), releaseId: b.id }), /only the current release/);
    await refuses("stale_revision", () => act.confirm(c.owner, { commandId: cid("c"), releaseId: a.id, expectedRevision: rev + 5 }));
    unlockAll(join(c.root, "releases", a.id));
    chmodSync(join(c.root, "releases", a.id, "nn.js"), 0o644);
    writeFileSync(join(c.root, "releases", a.id, "nn.js"), "EVIL");
    await refuses("invalid_transition", () => act.confirm(c.owner, { commandId: cid("c"), releaseId: a.id }), /does not verify/);
    assert.equal((await act.status(c.owner)).lastKnownGood, undefined);
    writeFileSync(join(c.root, "releases", a.id, "nn.js"), "release a");
    await act.confirm(c.owner, { commandId: cid("c"), releaseId: a.id, expectedRevision: rev });
    const st = await act.status(c.owner);
    assert.deepEqual([st.confirmed, st.lastKnownGood?.id, st.lastKnownGood?.via], [true, a.id, "owner"]);
    // The launcher now treats a as a fall-back for a failed b.
    await activate(c, act, b);
    await act.launcher.prepare();
    const back = await act.launcher.prepare();
    assert.equal((back as { releaseId?: string }).releaseId, a.id);
  });
}

test("the launcher record: compat.json is strict; nothing but the controller's own announcements, confirmations and the launcher's decisions change it, and no temporary file is left behind", async () => {
  assert.deepEqual(parseCompat('{"protocol":{"min":1,"max":3}}'), { protocol: { min: 1, max: 3 } });
  for (const bad of ["", "null", '{"protocol":1}', '{"protocol":{"min":0,"max":1}}', '{"protocol":{"min":1.5,"max":2}}', '{"protocol":{"min":1,"max":1},"a":1}']) assert.throws(() => parseCompat(bad), /compat\.json/, bad);
  const root = mkdtempSync(join(tmpdir(), "nn-launch-"));
  try {
    const sw = { read: async () => undefined as string | undefined | "invalid", write: async () => undefined, clear: async () => undefined };
    const l = new Launcher({ root, switcher: sw });
    assert.deepEqual(await l.prepare(), { action: "none", reason: "no release is active" });
    await l.expect({ id: `rcn-${"a".repeat(24)}`, digest: sha("m") });
    assert.equal(await l.confirm(`rcn-${"a".repeat(24)}`), false, "there is no open start to confirm");
    assert.deepEqual(readdirSync(root), [LAUNCHER_FILE], "one file, replaced atomically");
    sw.read = async () => "invalid";
    assert.equal((await l.prepare()).action, "blocked");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
