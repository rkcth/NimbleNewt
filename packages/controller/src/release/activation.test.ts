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
import { ReleaseActivationService, ReleaseService, SimulatedCrash, verifyReleaseDirectory, type ActivationOptions } from "./index.js";

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
    test(`${backend.name}, ${switcher}: ${name}`, async () => {
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

  suite("staging copies exactly the manifest's files into a read-only versioned directory with a digest manifest, and staging again is the same release", async (c) => {
    const id = await c.candidate({ "bin/nn.js": "console.log(1)", "lib.js": "x" });
    const s = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: id });
    assert.deepEqual([s.files, s.replayed], [2, false]);
    const dir = join(c.root, "releases", id);
    assert.deepEqual(readdirSync(dir).sort(), ["MANIFEST.json", "bin", "lib.js"]);
    assert.equal(sha(readFileSync(join(dir, "MANIFEST.json"), "utf8")), s.digest, "the digest is that of the manifest file");
    assert.equal(lstatSync(join(dir, "lib.js")).mode & 0o222, 0, "files are read-only");
    assert.equal((await c.act.stage(c.owner, { commandId: cid("st"), candidateId: id })).replayed, true);
    assert.equal((await c.act.status(c.owner)).staged.length, 1);
  });

  suite("a file whose digest differs from the manifest stages nothing and leaves no folder behind; unsafe names, links and missing files are refused", async (c) => {
    const bad = await c.candidate({ "a.js": "1", "b.js": "2" }, { lie: ["b.js"] });
    await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: bad }), /b\.js: its digest/);
    assert.deepEqual(existsSync(join(c.root, "releases")) ? readdirSync(join(c.root, "releases")) : [], [], "nothing left, not even a temporary folder");
    assert.equal((await c.act.status(c.owner)).staged.length, 0);
    for (const name of ["a/../../x", "a//b", "./x", "MANIFEST.json", "dir/MANIFEST.JSON"]) {
      const { candidateId } = await c.rel.submit(c.owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { [name]: sha("z") }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] } }).catch(() => ({ candidateId: "" }));
      if (candidateId === "") continue; // refused at submission already
      mkdirSync(join(c.root, "incoming", candidateId), { recursive: true });
      if (name !== "dir/MANIFEST.JSON") await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId }), /safe artifact name|reserved/);
    }
    const dup = await c.rel.submit(c.owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { "A.js": sha("1"), "a.js": sha("1") }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] } });
    mkdirSync(join(c.root, "incoming", dup.candidateId), { recursive: true });
    await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: dup.candidateId }), /collides/);
    const nested = await c.rel.submit(c.owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { "a": sha("1"), "a/b": sha("1") }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] } });
    mkdirSync(join(c.root, "incoming", nested.candidateId), { recursive: true });
    await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: nested.candidateId }), /both a file and a folder/);
    const missing = await c.candidate({ "m.js": "1" }); rmSync(join(c.root, "incoming", missing, "m.js"));
    await refuses("not_found", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: missing }));
    const linked = await c.candidate({ "l.js": "secret" });
    rmSync(join(c.root, "incoming", linked, "l.js")); writeFileSync(join(c.root, "outside.txt"), "secret"); symlinkSync(join(c.root, "outside.txt"), join(c.root, "incoming", linked, "l.js"));
    await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: linked }), /link is refused/);
    const folderLink = await c.candidate({ "d/f.js": "1" });
    const real = join(c.root, "elsewhere"); mkdirSync(real); writeFileSync(join(real, "f.js"), "1");
    rmSync(join(c.root, "incoming", folderLink, "d"), { recursive: true }); symlinkSync(real, join(c.root, "incoming", folderLink, "d"));
    await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: folderLink }), /link is refused/);
    await refuses("invalid_command", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: "../../etc" }));
  });

  suite("only the owner stages, activates, rolls back or reads the status; an agent and an owner-token confined to a task are refused", async (c) => {
    const id = await c.candidate({ "a.js": "1" });
    const confined = { ...c.owner, taskScope: { taskId: "t", projectId: "p" } } as Principal;
    for (const who of [c.agent, confined]) {
      await refuses("forbidden", () => c.act.stage(who, { commandId: cid("x"), candidateId: id }));
      await refuses("forbidden", () => c.act.activate(who, { commandId: cid("x"), candidateId: id, digest: "a".repeat(64) }));
      await refuses("forbidden", () => c.act.rollback(who, { commandId: cid("x"), releaseId: id }));
      await refuses("forbidden", () => c.act.status(who));
      await refuses("forbidden", () => c.act.setSettings(who, { commandId: cid("x"), requireApproval: false }));
    }
    assert.equal((await c.act.status(c.owner)).staged.length, 0, "nothing happened");
  });

  suite("activation is bound to the staged digest, the approval and this platform, then switches, and a second activation keeps the first as the previous one", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" });
    const sa = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }); const sb = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b });
    await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest }), /not approved/);
    await c.approve(a);
    await refuses("invalid_command", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sb.digest }), /not the digest/);
    await refuses("invalid_command", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: "zz" }));
    await refuses("not_found", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: "rcn-" + "0".repeat(24), digest: sa.digest }));
    assert.equal(pointer(c.root), undefined, "nothing switched by the refusals");
    const other = c.make({ platform: { os: "darwin", arch: "arm64" } });
    await refuses("invalid_transition", () => other.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest }), /platform/);
    const first = await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    assert.equal(pointer(c.root), a);
    await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest }), /already/);
    // Not approved and approval switched off by the owner: allowed, still digest-bound.
    await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), /not approved/);
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest, expectedRevision: first.revision });
    const st = await c.act.status(c.owner);
    assert.deepEqual([pointer(c.root), st.current?.id, st.previous?.id, st.diverged, st.journal], [b, b, a, false, undefined]);
    assert.deepEqual(st.history.map((h) => h.kind), ["activated", "activated"]);
  });

  suite("rollback returns to the previous release by its ID, verifies it first, and is refused for any other release", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const sa = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }); const sb = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b });
    await refuses("invalid_transition", () => c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /not the release before/);
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest });
    await refuses("invalid_transition", () => c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: b }), /not the release before/);
    // The previous release was tampered with on disk: the rollback is refused, nothing switched, the journal closed.
    const file = join(c.root, "releases", a, "a.js"); chmodSync(file, 0o644); writeFileSync(file, "EVIL");
    await refuses("invalid_transition", () => c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /different (size|digest)/);
    let st = await c.act.status(c.owner);
    assert.deepEqual([pointer(c.root), st.current?.id, st.journal, st.history.at(-1)?.kind], [b, b, undefined, "aborted"]);
    writeFileSync(file, "A"); chmodSync(file, 0o444);
    await c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: a });
    st = await c.act.status(c.owner);
    assert.deepEqual([pointer(c.root), st.current?.id, st.previous, st.history.at(-1)?.kind], [a, a, undefined, "rolled_back"]);
  });

  suite("verification before activation: a changed, added or removed file in a staged release refuses the switch and leaves the old release running", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B", "c.js": "C" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const sa = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }); const sb = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    const dir = join(c.root, "releases", b);
    if (process.platform !== "win32" && process.getuid?.() !== 0) assert.throws(() => writeFileSync(join(dir, "extra.sh"), "run me"), /EACCES|EPERM/, "a staged folder is read-only (0555)");
    unlockAll(dir);
    writeFileSync(join(dir, "extra.sh"), "run me");
    await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), /extra\.sh was added/);
    rmSync(join(dir, "extra.sh"));
    rmSync(join(dir, "c.js"));
    await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), /c\.js is missing/);
    writeFileSync(join(dir, "c.js"), "C");
    assert.equal(pointer(c.root), a, "the old release keeps running");
    assert.equal((await c.act.status(c.owner)).journal, undefined);
    chmodSync(join(dir, "c.js"), 0o444);
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest });
    assert.equal(pointer(c.root), b);
  });

  suite("a crash after the intent resolves to the old release, a crash after the switch to the new one, on the next start and never in between", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" }); const d = await c.candidate({ "d.js": "D" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const [sa, sb, sd] = [await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }), await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b }), await c.act.stage(c.owner, { commandId: cid("st"), candidateId: d })];
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    for (const point of ["afterBegin", "afterVerify"] as const) {
      const dying = c.make({ hook: (p) => { if (p === point) throw new SimulatedCrash(p); } });
      await assert.rejects(() => dying.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), SimulatedCrash);
      assert.equal(pointer(c.root), a);
      const mid = await c.act.status(c.owner);
      assert.equal(mid.journal?.to.id, b, "the open intent is visible");
      await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: d, digest: sd.digest }), /in progress or was interrupted/);
      await refuses("invalid_transition", () => c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /in progress|not the release before/);
      assert.deepEqual(await c.make().recover(), { resolved: "aborted" });
      const after = await c.act.status(c.owner);
      assert.deepEqual([pointer(c.root), after.current?.id, after.journal], [a, a, undefined], `${point}: old`);
      assert.deepEqual(await c.make().recover(), { resolved: "none" });
    }
    const dying = c.make({ hook: (p) => { if (p === "afterSwitch") throw new SimulatedCrash(p); } });
    await assert.rejects(() => dying.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), SimulatedCrash);
    assert.equal(pointer(c.root), b, "the launcher already points at the new release");
    assert.deepEqual(await c.make().recover(), { resolved: "committed" });
    const done = await c.act.status(c.owner);
    assert.deepEqual([done.current?.id, done.previous?.id, done.journal, done.history.at(-1)?.kind, done.diverged], [b, a, undefined, "recovered", false]);
  });

  suite("a journal whose pointer names neither release is left open and reported, never guessed", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" }); const d = await c.candidate({ "d.js": "D" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const [sa, sb] = [await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }), await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b })];
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    const dying = c.make({ hook: (p) => { if (p === "afterBegin") throw new SimulatedCrash(p); } });
    await assert.rejects(() => dying.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), SimulatedCrash);
    // Someone moved the pointer to a third release by hand.
    if (switcher === "symlink") { rmSync(join(c.root, "current")); symlinkSync(`releases/${d}`, join(c.root, "current")); } else writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: d }));
    assert.deepEqual(await c.make().recover(), { resolved: "unresolved" });
    const st = await c.act.status(c.owner);
    assert.deepEqual([st.journal?.to.id, st.pointer, st.current?.id], [b, d, a]);
  });

  suite("a pointer moved by hand outside any switch shows as diverged and is not changed", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const d = await c.candidate({ "d.js": "D" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const sa = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    if (switcher === "symlink") { rmSync(join(c.root, "current")); symlinkSync(`releases/${d}`, join(c.root, "current")); } else writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: d }));
    const st = await c.act.status(c.owner);
    assert.deepEqual([st.diverged, st.pointer], [true, d]);
    await c.make().recover();
    assert.equal(pointer(c.root), d, "recovery does not rewrite a pointer when no switch was open");
  });

  suite("two activations at once: one wins, the other is refused; a repeated command ID answers from its record", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const [sa, sb] = [await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }), await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b })];
    const rev = (await c.act.status(c.owner)).revision;
    const two = c.make();
    const results = await Promise.allSettled([
      c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest, expectedRevision: rev }),
      two.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest, expectedRevision: rev }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, JSON.stringify(results.map((r) => r.status)));
    const st = await c.act.status(c.owner);
    assert.equal(pointer(c.root), st.current?.id, "the pointer and the record agree");
    assert.equal(st.journal, undefined);
    const id = cid("same");
    const other = st.current!.id === a ? { c: b, d: sb.digest } : { c: a, d: sa.digest };
    const once = await c.act.activate(c.owner, { commandId: id, candidateId: other.c, digest: other.d });
    const again = await c.act.activate(c.owner, { commandId: id, candidateId: other.c, digest: other.d });
    assert.deepEqual([once.replayed, again.replayed, again.revision], [false, true, once.revision]);
    assert.equal(pointer(c.root), other.c);
  });

  suite("settings: approval is required by default, narrowing and widening are owner-only and revision guarded, a staged-size cap is off by default and enforced when set", async (c) => {
    const s0 = await c.act.settings(c.owner);
    assert.deepEqual([s0.requireApproval, s0.maxStagedBytes, s0.revision], [true, null, 0]);
    const set = await c.act.setSettings(c.owner, { commandId: cid("se"), maxStagedBytes: 5, expectedRevision: 0 });
    await refuses("stale_revision", () => c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false, expectedRevision: 0 }));
    await refuses("invalid_command", () => c.act.setSettings(c.owner, { commandId: cid("se"), maxStagedBytes: 0 }));
    await refuses("invalid_command", () => c.act.setSettings(c.owner, { commandId: cid("se") } as never));
    const big = await c.candidate({ "big.bin": "123456" });
    await refuses("invalid_transition", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: big }), /allowed for staged releases/);
    assert.equal(readdirSync(join(c.root, "releases")).length, 0);
    await c.act.setSettings(c.owner, { commandId: cid("se"), maxStagedBytes: null, expectedRevision: set.revision });
    await c.act.stage(c.owner, { commandId: cid("st"), candidateId: big });
    assert.equal((await c.act.settings(c.owner)).requireApproval, true, "unchanged fields stay");
  });

  suite("sweep: only .tmp folders of this process (not in use) or older than the staleness window are removed; a fresh folder of another process and one being filled are kept", async (c) => {
    const a = await c.candidate({ "a.js": "A" });
    const r = join(c.root, "releases");
    for (const n of [".tmp-old", `.tmp-mine-${process.pid}-x`, ".tmp-fresh-other"]) mkdirSync(join(r, n), { recursive: true });
    const old = new Date(Date.now() - 2 * 3_600_000);
    utimesSync(join(r, ".tmp-old"), old, old);
    mkdirSync(join(r, a), { recursive: true }); writeFileSync(join(r, a, "a.js"), "EVIL");
    await c.act.recover();
    assert.equal(existsSync(join(r, ".tmp-old")), false, "older than the window");
    assert.equal(existsSync(join(r, `.tmp-mine-${process.pid}-x`)), false, "left by this process");
    assert.equal(existsSync(join(r, ".tmp-fresh-other")), true, "fresh and not ours: kept (another process may be filling it)");
    const s = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a });
    assert.equal(readFileSync(join(r, a, "a.js"), "utf8"), "A");
    assert.equal(s.replayed, false);
  });

  suite("an unresolved switch is closed by the owner only, with the revision quoted: commit, abort and set-pointer verify, move the pointer, leave a history entry, and later activations work", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" }); const d = await c.candidate({ "d.js": "D" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const [sa, sb] = [await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }), await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b })];
    const sd0 = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: d });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    const strand = async (): Promise<number> => {
      const dying = c.make({ hook: (p) => { if (p === "afterBegin") throw new SimulatedCrash(p); } });
      await assert.rejects(() => dying.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), SimulatedCrash);
      if (switcher === "symlink") { rmSync(join(c.root, "current")); symlinkSync(`releases/${d}`, join(c.root, "current")); } else writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: d }));
      assert.deepEqual(await c.make().recover(), { resolved: "unresolved" });
      return (await c.act.status(c.owner)).revision;
    };
    let rev = await strand();
    await refuses("forbidden", () => c.act.resolve(c.agent, { commandId: cid("rs"), action: "abort", expectedRevision: rev }));
    await refuses("stale_revision", () => c.act.resolve(c.owner, { commandId: cid("rs"), action: "abort", expectedRevision: rev + 5 }));
    await refuses("invalid_command", () => c.act.resolve(c.owner, { commandId: cid("rs"), action: "set-pointer", releaseId: d, expectedRevision: rev }), /one end/);
    await refuses("invalid_command", () => c.act.resolve(c.owner, { commandId: cid("rs"), action: "nope", expectedRevision: rev } as never));
    await refuses("invalid_transition", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: d, digest: sd0.digest }), /in progress/);
    await c.act.resolve(c.owner, { commandId: cid("rs"), action: "abort", expectedRevision: rev });
    let st = await c.act.status(c.owner);
    assert.deepEqual([st.current?.id, st.journal, pointer(c.root), st.diverged, st.history.at(-1)?.kind, st.history.at(-1)?.by], [a, undefined, a, false, "resolved", c.owner.id]);
    await refuses("invalid_transition", () => c.act.resolve(c.owner, { commandId: cid("rs"), action: "commit", expectedRevision: st.revision }), /no open switch/);
    rev = await strand();
    await c.act.resolve(c.owner, { commandId: cid("rs"), action: "commit", expectedRevision: rev });
    st = await c.act.status(c.owner);
    assert.deepEqual([st.current?.id, st.previous?.id, st.journal, pointer(c.root), st.history.at(-1)?.kind], [b, a, undefined, b, "resolved"]);
    // set-pointer to the old end of a stranded rollback closes it as not done.
    const dsd = await c.act.status(c.owner);
    assert.equal(dsd.diverged, false);
    await c.act.rollback(c.owner, { commandId: cid("rb"), releaseId: a });
    assert.equal((await c.act.status(c.owner)).current?.id, a);
  });

  suite("a first activation stranded with the pointer on a stray release: abort removes the pointer", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const d = await c.candidate({ "d.js": "D" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const sa = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a });
    const dying = c.make({ hook: (p) => { if (p === "afterBegin") throw new SimulatedCrash(p); } });
    await assert.rejects(() => dying.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest }), SimulatedCrash);
    if (switcher === "symlink") symlinkSync(`releases/${d}`, join(c.root, "current")); else writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: d }));
    assert.deepEqual(await c.make().recover(), { resolved: "unresolved" });
    const rev = (await c.act.status(c.owner)).revision;
    await c.act.resolve(c.owner, { commandId: cid("rs"), action: "set-pointer", releaseId: a, expectedRevision: rev });
    const st = await c.act.status(c.owner);
    assert.deepEqual([st.current?.id, st.journal, pointer(c.root)], [a, undefined, a], "set-pointer to the new end closes it as done");
  });

  suite("a failed close of an interrupted switch is retried by the next recover (a plain error, not a crash, leaves the journal for it)", async (c) => {
    const a = await c.candidate({ "a.js": "A" }); const b = await c.candidate({ "b.js": "B" });
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const [sa, sb] = [await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }), await c.act.stage(c.owner, { commandId: cid("st"), candidateId: b })];
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: sa.digest });
    const flaky = c.make({ hook: (p) => { if (p === "afterVerify") throw new Error("disk hiccup"); } });
    await assert.rejects(() => flaky.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest }), /disk hiccup/);
    assert.ok((await c.act.status(c.owner)).journal !== undefined);
    assert.deepEqual(await c.make().recover(), { resolved: "aborted" });
    assert.deepEqual(await c.make().recover(), { resolved: "none" });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: b, digest: sb.digest });
    assert.equal(pointer(c.root), b);
  });

  suite("a staged release can be removed (record and files) unless it is current, previous or part of an open switch; keepStaged prunes the oldest on staging; owner only", async (c) => {
    const ids: string[] = [];
    for (const k of ["1", "2", "3", "4"]) ids.push(await c.candidate({ [`f${k}.js`]: k }));
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    const dig: string[] = [];
    for (const id of ids.slice(0, 3)) dig.push((await c.act.stage(c.owner, { commandId: cid("st"), candidateId: id })).digest);
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: ids[0]!, digest: dig[0]! });
    await c.act.activate(c.owner, { commandId: cid("ac"), candidateId: ids[1]!, digest: dig[1]! });
    await refuses("forbidden", () => c.act.remove(c.agent, { commandId: cid("rm"), candidateId: ids[2]! }));
    await refuses("invalid_transition", () => c.act.remove(c.owner, { commandId: cid("rm"), candidateId: ids[1]! }), /current/);
    await refuses("invalid_transition", () => c.act.remove(c.owner, { commandId: cid("rm"), candidateId: ids[0]! }), /rollback target/);
    await refuses("not_found", () => c.act.remove(c.owner, { commandId: cid("rm"), candidateId: ids[3]! }));
    assert.deepEqual(await c.act.remove(c.owner, { commandId: cid("rm"), candidateId: ids[2]! }), { candidateId: ids[2]!, removed: true });
    assert.equal(existsSync(join(c.root, "releases", ids[2]!)), false);
    assert.deepEqual((await c.act.status(c.owner)).staged.map((x) => x.candidateId).sort(), [ids[0]!, ids[1]!].sort());
    // Retention: keep the newest 2, never the live ones.
    await c.act.setSettings(c.owner, { commandId: cid("se"), keepStaged: 2 });
    assert.equal((await c.act.settings(c.owner)).keepStaged, 2);
    await c.act.stage(c.owner, { commandId: cid("st"), candidateId: ids[2]! });
    const left = (await c.act.status(c.owner)).staged.map((x) => x.candidateId).sort();
    assert.deepEqual(left, [ids[0]!, ids[1]!, ids[2]!].sort(), "the two live releases are never pruned, so three remain");
    await c.act.stage(c.owner, { commandId: cid("st"), candidateId: ids[3]! });
    const after = (await c.act.status(c.owner)).staged.map((x) => x.candidateId).sort();
    assert.deepEqual(after, [ids[0]!, ids[1]!, ids[3]!].sort(), "the oldest not-live release (ids[2]) went");
    await refuses("invalid_command", () => c.act.setSettings(c.owner, { commandId: cid("se"), keepStaged: 0 }));
    await c.act.setSettings(c.owner, { commandId: cid("se"), keepStaged: null });
    assert.equal((await c.act.settings(c.owner)).keepStaged, null);
  });

  suite("staging is refused when the launcher's pointer or the record names that release (a restored database); a missing candidate record is not_found at activation; the files are read-only folders on POSIX and verified at launch", async (c) => {
    const a = await c.candidate({ "a.js": "A" });
    // A restored database: the pointer names a release this database never staged.
    if (switcher === "symlink") symlinkSync(`releases/${a}`, join(c.root, "current")); else writeFileSync(join(c.root, "current.json"), JSON.stringify({ release: a }));
    await refuses("invalid_transition", () => c.act.stage(c.owner, { commandId: cid("st"), candidateId: a }), /already names/);
    if (switcher === "symlink") rmSync(join(c.root, "current")); else rmSync(join(c.root, "current.json"));
    const s = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a });
    if (process.platform !== "win32") assert.equal(lstatSync(join(c.root, "releases", a)).mode & 0o222, 0, "release folders are read-only");
    await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    // The candidate's record is gone: not_found, not a TypeError.
    const rec = await c.runner.get("release-candidate", a);
    assert.ok(rec);
    await c.runner.command("test.drop", { commandId: cid("dr"), actor: c.owner.id }, async () => ({ payload: { a }, build: async (): Promise<Built> => ({ ref: { kind: "release-candidate", id: a }, creates: false, changes: [{ type: "delete", ref: { kind: "release-candidate", id: a }, expectedRevision: rec.revision }], detail: {} }) }));
    await refuses("not_found", () => c.act.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: s.digest }), /candidate/);
  });

  suite("verify: the current release is checked against the manifest digest the record keeps (what the launcher checks at launch); a changed file is reported; incoming can live outside the release root", async (c) => {
    const alt = mkdtempSync(join(tmpdir(), "nn-inc-"));
    try {
      const own = c.make({ incoming: alt });
      const a = await c.candidate({ "a.js": "A" });
      mkdirSync(join(alt, a), { recursive: true }); writeFileSync(join(alt, a, "a.js"), "A");
      rmSync(join(c.root, "incoming"), { recursive: true, force: true });
      await c.act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
      const s = await own.stage(c.owner, { commandId: cid("st"), candidateId: a });
      assert.equal(existsSync(join(c.root, "incoming")), false, "the root's own incoming folder is not used when another is configured");
      await own.activate(c.owner, { commandId: cid("ac"), candidateId: a, digest: s.digest });
      const ok = await own.verify(c.owner);
      assert.deepEqual([ok.releaseId, ok.digest, ok.ok], [a, s.digest, true]);
      assert.deepEqual(await verifyReleaseDirectory(join(c.root, "releases", a), s.digest), []);
      chmodSync(join(c.root, "releases", a, "a.js"), 0o644);
      unlockAll(join(c.root, "releases", a));
      writeFileSync(join(c.root, "releases", a, "a.js"), "EVIL");
      const bad = await own.verify(c.owner);
      assert.equal(bad.ok, false);
      assert.match(bad.problems[0]!, /a\.js has a different (digest|size)/);
      await refuses("forbidden", () => own.verify(c.agent));
    } finally { rmSync(alt, { recursive: true, force: true }); }
  });
}
