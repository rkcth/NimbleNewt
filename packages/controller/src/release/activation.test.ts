import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner, type Built } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { ReleaseActivationService, ReleaseService, SimulatedCrash, type ActivationOptions } from "./index.js";

after(stopServer);
const options = { clock: () => "2026-10-31T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
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
      } finally { await world.close(); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
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

  suite("a staging folder left by a dead run is swept at start, and a half-finished release directory without a record is replaced, not trusted", async (c) => {
    const a = await c.candidate({ "a.js": "A" });
    mkdirSync(join(c.root, "releases", ".tmp-old"), { recursive: true });
    mkdirSync(join(c.root, "releases", a), { recursive: true }); writeFileSync(join(c.root, "releases", a, "a.js"), "EVIL");
    await c.act.recover();
    assert.equal(existsSync(join(c.root, "releases", ".tmp-old")), false);
    const s = await c.act.stage(c.owner, { commandId: cid("st"), candidateId: a });
    assert.equal(readFileSync(join(c.root, "releases", a, "a.js"), "utf8"), "A");
    assert.equal(s.replayed, false);
  });
}
