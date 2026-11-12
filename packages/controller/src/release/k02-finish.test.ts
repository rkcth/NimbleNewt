import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import { chmodSync, existsSync, symlinkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner, type Built } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { LAUNCHER_FILE, Launcher, ReleaseActivationService, ReleaseService, checkManifest, parseCompat, signedText, type ActivationOptions } from "./index.js";

after(stopServer);
const options = { clock: () => "2026-11-12T12:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const unlockAll = (dir: string): void => { try { chmodSync(dir, 0o700); for (const e of readdirSync(dir, { withFileTypes: true })) if (e.isDirectory()) unlockAll(join(dir, e.name)); } catch { /* gone */ } };
const linux = { os: "linux" as const, arch: "x64" as const };
const keypair = (): { publicKey: string; sign: (id: string) => string; key: KeyObject } => {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return { key: publicKey, publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), sign: (id) => sign(null, signedText(id), privateKey).toString("base64") };
};
const compat = (schema?: { min: number; max: number }): string => JSON.stringify({ protocol: { min: 1, max: 1 }, ...(schema === undefined ? {} : { schema }) });

interface W {
  make: (o?: Partial<ActivationOptions>) => ReleaseActivationService; owner: Principal; manager: Principal; plain: Principal; root: string; runner: CommandRunner; principals: PrincipalService; rel: ReleaseService;
  candidate: (files: Record<string, string>, extra?: { migrationPlan?: string; targets?: string[]; compatText?: string }) => Promise<string>;
  approve: (id: string) => Promise<void>;
  go: (act: ReleaseActivationService, by: Principal, id: string, extra?: { migrationPlan?: string }) => Promise<{ digest: string }>;
}
for (const backend of backends) {
  const suite = (name: string, body: (c: W) => Promise<void>): void => {
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const root = mkdtempSync(join(tmpdir(), "nn-k02f-"));
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "manager", grants: [{ action: "release.manage", project: "*" }] });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "plain", grants: [{ action: "*", project: "*" }] });
        const manager = await principals.authenticate((await principals.issueCredential(owner, "agent:manager")).token);
        const plain = await principals.authenticate((await principals.issueCredential(owner, "agent:plain")).token);
        const rel = ReleaseService.withEpoch(world.storage, projects.epoch, options);
        const runner = new CommandRunner(world.storage, projects.epoch, options);
        const make = (extra: Partial<ActivationOptions> = {}): ReleaseActivationService => ReleaseActivationService.withEpoch(world.storage, projects.epoch, { root, switcher: "pointer", platform: linux, runner: options, ...extra });
        const candidate: W["candidate"] = async (files, extra = {}) => {
          const all = { "compat.json": extra.compatText ?? compat(), ...files };
          const artifacts = Object.fromEntries(Object.entries(all).map(([k, v]) => [k, sha(v)]));
          const { candidateId } = await rel.submit(owner, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts, dependencyLocks: { lock: sha("lock") }, matrix: [linux], ...(extra.migrationPlan === undefined ? {} : { migrationPlan: extra.migrationPlan }), ...(extra.targets === undefined ? {} : { targets: extra.targets }) } });
          for (const [k, v] of Object.entries(all)) { const p = join(root, "incoming", candidateId, ...k.split("/")); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, v); }
          return candidateId;
        };
        const approve: W["approve"] = async (id) => {
          await runner.command("test.approve", { commandId: cid("ap"), actor: owner.id }, async () => ({ payload: { id }, build: async (): Promise<Built> => { const ref = { kind: "release-approval", id }; return { ref, creates: true, changes: [{ type: "create", ref, body: { candidateId: id, by: owner.id, at: "x" } }], detail: {} }; } }));
        };
        const go: W["go"] = async (act, by, id, extra = {}) => {
          const s = await act.stage(by, { commandId: cid("st"), candidateId: id });
          await act.activate(by, { commandId: cid("a"), candidateId: id, digest: s.digest, ...extra });
          return { digest: s.digest };
        };
        await body({ make, owner, manager, plain, root, runner, principals, rel, candidate, approve, go });
      } finally { await world.close(); unlockAll(join(root, "releases")); rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
    });
  };
  const pointerOf = (root: string): string | undefined => (existsSync(join(root, "current.json")) ? (JSON.parse(readFileSync(join(root, "current.json"), "utf8")) as { release: string }).release : undefined);

  // ---- K02b: signed artifact sets ------------------------------------------------------------------------------------------------------------------------------------------

  suite("signing: without a trusted key digests alone are enough; once a key is trusted staging, activation and rollback need a valid signature, and a removed key withdraws its signatures", async (c) => {
    const act = c.make();
    const first = await c.candidate({ "nn.js": "first" });
    await go0(c, act, first); // no key: as before
    const k = keypair();
    const other = keypair();
    const r1 = await act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: k.publicKey, label: "build machine" });
    assert.equal((await act.trust(c.owner)).required, true, "trusting a key makes a signature needed");
    const second = await c.candidate({ "nn.js": "second" });
    await refuses("invalid_transition", () => act.stage(c.owner, { commandId: cid("st"), candidateId: second }), /not signed/);
    assert.deepEqual(existsSync(join(c.root, "releases")) ? readdirSync(join(c.root, "releases")).filter((x) => x !== first) : [], [], "nothing was staged");
    // A signature by an untrusted key, over another candidate, damaged or of the wrong size is refused and kept nowhere.
    await refuses("invalid_command", () => act.attachSignature(c.owner, { commandId: cid("g"), candidateId: second, signature: other.sign(second) }), /trusted key/);
    await refuses("invalid_command", () => act.attachSignature(c.owner, { commandId: cid("g"), candidateId: second, signature: k.sign(first) }), /trusted key/);
    await refuses("invalid_command", () => act.attachSignature(c.owner, { commandId: cid("g"), candidateId: second, signature: "AAAA" }), /trusted key/);
    await refuses("invalid_command", () => act.attachSignature(c.owner, { commandId: cid("g"), candidateId: second, signature: 5 }), /signature/);
    await refuses("invalid_transition", () => act.stage(c.owner, { commandId: cid("st"), candidateId: second }), /not signed/);
    // The signature is attached by the holder of release.manage as well; the same again is a no-op.
    const att = await act.attachSignature(c.manager, { commandId: cid("g"), candidateId: second, signature: k.sign(second) });
    assert.equal(att.keyId, r1.keyId);
    assert.equal((await act.attachSignature(c.owner, { commandId: cid("g"), candidateId: second, signature: k.sign(second) })).replayed, false, "a new command; the record already held it");
    const st = await act.stage(c.owner, { commandId: cid("st"), candidateId: second });
    await c.approve(second);
    // Staged while signed; the signing key is withdrawn before the switch (another key keeps the requirement): the activation checks again and refuses, and the key coming back restores the signature on record.
    await act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: other.publicKey });
    await act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: r1.keyId });
    await refuses("invalid_transition", () => act.activate(c.owner, { commandId: cid("a"), candidateId: second, digest: st.digest }), /not signed/);
    await act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: k.publicKey, label: "restored" });
    await act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: (await act.trust(c.owner)).keys.find((x) => x.label !== "restored")!.keyId });
    await act.activate(c.owner, { commandId: cid("a"), candidateId: second, digest: st.digest });
    assert.equal(pointerOf(c.root), second);
    assert.equal((await act.verify(c.owner, { releaseId: second })).signedBy, r1.keyId);
    // The first release was staged before any key was trusted: a rollback to it is refused until it is signed too.
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: first }), /not signed/);
    await act.attachSignature(c.owner, { commandId: cid("g"), candidateId: first, signature: k.sign(first) });
    // The key is withdrawn: what only it signed stops counting at once, for the staged copy and the rollback alike.
    await act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: other.publicKey });
    await act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: r1.keyId });
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: first }), /not signed/);
    assert.equal((await act.verify(c.owner, { releaseId: second })).signedBy, null);
    // The owner's explicit word that digests are enough, and the opposite, with no key at all.
    await act.requireSignature(c.owner, { commandId: cid("t"), required: true });
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: first }), /not signed/);
    await act.requireSignature(c.owner, { commandId: cid("t"), required: null });
    // Following the root, with the last key gone, is the owner's explicit step back to digests alone.
    await act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: (await act.trust(c.owner)).keys[0]!.keyId });
    await act.rollback(c.owner, { commandId: cid("rb"), releaseId: first });
    assert.equal(pointerOf(c.root), first);
    const t = await act.trust(c.owner);
    assert.deepEqual([t.keys.length, t.require, t.required], [0, null, false]);
  });
  const go0 = async (c: W, act: ReleaseActivationService, id: string): Promise<void> => { const s = await act.stage(c.owner, { commandId: cid("st"), candidateId: id }); await c.approve(id); await act.activate(c.owner, { commandId: cid("a"), candidateId: id, digest: s.digest }); };

  suite("signing: a forged signature record does not count (checked again at every use), the key list is bounded and strict, and only the owner changes the trust root", async (c) => {
    const act = c.make();
    const k = keypair();
    const added = await act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: k.publicKey });
    const id = await c.candidate({ "nn.js": "x" });
    // A record written straight into the store with a signature that does not verify (a damaged or tampered record) is not a signature.
    const ref = { kind: "release-signature", id: `sig-${sha(`${id}|${added.keyId}`).slice(0, 24)}` };
    await c.runner.command("test.forge", { commandId: cid("fg"), actor: c.owner.id }, async () => ({ payload: {}, build: async (): Promise<Built> => ({ ref, creates: true, changes: [{ type: "create", ref, body: { candidateId: id, keyId: added.keyId, signature: Buffer.alloc(64).toString("base64"), by: "x", at: "x" } }], detail: {} }) }));
    await refuses("invalid_transition", () => act.stage(c.owner, { commandId: cid("st"), candidateId: id }), /not signed/);
    // Strict key input.
    const rsa = generateKeyPairSync("rsa", { modulusLength: 2048 }).publicKey.export({ format: "der", type: "spki" }).toString("base64");
    for (const bad of [rsa, "not base64!", "", 5, k.publicKey.slice(0, 20), "A".repeat(300)]) await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: bad as never }), /publicKey/);
    await refuses("invalid_transition", () => act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: k.publicKey }), /already trusted/);
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: keypair().publicKey, label: "bad\nlabel" }), /label/);
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: keypair().publicKey, extra: 1 } as never), /extra/);
    await refuses("not_found", () => act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: "0".repeat(16) }), /not trusted/);
    await refuses("invalid_command", () => act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: "zz" }), /keyId/);
    await refuses("invalid_command", () => act.requireSignature(c.owner, { commandId: cid("t"), required: "yes" }), /required/);
    for (let i = 0; i < 19; i++) await act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: keypair().publicKey });
    await refuses("invalid_transition", () => act.addTrustedKey(c.owner, { commandId: cid("t"), publicKey: keypair().publicKey }), /20 keys/);
    // Stale revision.
    await refuses("stale_revision", () => act.removeTrustedKey(c.owner, { commandId: cid("t"), keyId: added.keyId, expectedRevision: 1 }));
    // Authority: neither an agent with a broad grant nor the release manager changes the trust root; attaching needs release.manage.
    for (const who of [c.plain, c.manager]) {
      await refuses("forbidden", () => act.addTrustedKey(who, { commandId: cid("t"), publicKey: keypair().publicKey }));
      await refuses("forbidden", () => act.removeTrustedKey(who, { commandId: cid("t"), keyId: added.keyId }));
      await refuses("forbidden", () => act.requireSignature(who, { commandId: cid("t"), required: false }));
    }
    await refuses("forbidden", () => act.attachSignature(c.plain, { commandId: cid("g"), candidateId: id, signature: k.sign(id) }));
    await refuses("forbidden", () => act.trust(c.plain));
    assert.equal((await act.trust(c.manager)).keys.length, 20);
  });

  // ---- K02c: the grantable release-management permission --------------------------------------------------------------------------------------------------------------------

  suite("release.manage: only the exact grant counts (not '*'), a holder stages, activates what the owner approved, rolls back and reads, and nothing else; a task credential never", async (c) => {
    const act = c.make();
    const a = await c.candidate({ "nn.js": "a" });
    // An agent with '*' (every action) and an agent with no grant reach nothing; so does a grant for one project only.
    for (const who of [c.plain]) {
      await refuses("forbidden", () => act.stage(who, { commandId: cid("st"), candidateId: a }));
      await refuses("forbidden", () => act.status(who));
      await refuses("forbidden", () => act.verify(who));
      await refuses("forbidden", () => act.remove(who, { commandId: cid("rm"), candidateId: a }));
    }
    const stA = await act.stage(c.manager, { commandId: cid("st"), candidateId: a });
    // The holder cannot activate what the owner has not approved, even when the owner switched the requirement off for the owner's own activations.
    await act.setSettings(c.owner, { commandId: cid("se"), requireApproval: false });
    await refuses("invalid_transition", () => act.activate(c.manager, { commandId: cid("a"), candidateId: a, digest: stA.digest }), /needs the owner's approval/);
    await c.approve(a);
    await act.activate(c.manager, { commandId: cid("a"), candidateId: a, digest: stA.digest });
    assert.equal(pointerOf(c.root), a);
    const b = await c.candidate({ "nn.js": "b" });
    await c.approve(b);
    const stB = await act.stage(c.manager, { commandId: cid("st"), candidateId: b });
    await act.activate(c.manager, { commandId: cid("a"), candidateId: b, digest: stB.digest });
    assert.equal((await act.status(c.manager)).current?.id, b);
    assert.equal((await act.verify(c.manager)).ok, true);
    await act.rollback(c.manager, { commandId: cid("rb"), releaseId: a });
    assert.equal(pointerOf(c.root), a);
    // Everything that decides policy stays the owner's.
    const rev = (await act.status(c.manager)).revision;
    await refuses("forbidden", () => act.setSettings(c.manager, { commandId: cid("se"), requireApproval: true }));
    await refuses("forbidden", () => act.settings(c.manager));
    await refuses("forbidden", () => act.confirm(c.manager, { commandId: cid("cf"), releaseId: a }));
    await refuses("forbidden", () => act.resolve(c.manager, { commandId: cid("rs"), action: "abort", expectedRevision: rev }));
    await refuses("forbidden", () => act.acknowledgeStart(c.manager, { commandId: cid("ak"), releaseId: a } as never));
    await refuses("forbidden", () => c.rel.approve(c.manager, { commandId: cid("ap"), candidateId: b }));
    await refuses("forbidden", () => c.rel.submit(c.manager, { commandId: cid("s"), manifest: { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { x: sha("x") }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] } }));
    // A holder's stage of the very release it removes is fine; removing a live release is refused for everyone.
    await refuses("invalid_transition", () => act.remove(c.manager, { commandId: cid("rm"), candidateId: a }), /current one/);
    // A task credential never counts, whatever it holds.
    const scoped: Principal = { ...c.manager, taskScope: { taskId: "tsk-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa" } as never };
    await refuses("forbidden", () => act.status(scoped));
    await refuses("forbidden", () => act.rollback(scoped, { commandId: cid("rb"), releaseId: a }));
    // A grant for one project is not the installation-wide action.
    const narrow: Principal = { ...c.manager, grants: [{ action: "release.manage", project: "proj-aaaaaaaaaaaaaaaaaaaa" }] };
    await refuses("forbidden", () => act.status(narrow));
    // A prefix grant is not the exact action either.
    const prefix: Principal = { ...c.manager, grants: [{ action: "release.*", project: "*" }] };
    await refuses("forbidden", () => act.status(prefix));
    // Only the owner makes grants: an agent cannot give itself the permission.
    await refuses("forbidden", () => c.principals.enroll(c.plain, { commandId: cid("e"), kind: "agent", name: "sneaky", grants: [{ action: "release.manage", project: "*" }] }));
  });

  // ---- K02: authorization bound to migration plan and target installations ------------------------------------------------------------------------------------------------------

  suite("a candidate's migration plan and target installations: the manifest carries them strictly, an activation quotes the plan, and a release is used only on a named installation", async (c) => {
    // Manifest strictness and the ID: absent fields leave the ID alone, present ones are part of it.
    const base = { sourceCommit: "a".repeat(40), suiteRevision: "s1", artifacts: { x: sha("x") }, dependencyLocks: { lock: sha("lock") }, matrix: [linux] };
    for (const bad of [{ migrationPlan: "nope" }, { migrationPlan: 5 }, { targets: [] }, { targets: ["A"] }, { targets: "main" }, { targets: ["a", "a"] }, { targets: Array.from({ length: 21 }, (_, i) => `i${i}`) }]) assert.throws(() => checkManifest({ ...base, ...bad }), DomainError);
    assert.deepEqual(checkManifest({ ...base, targets: ["b", "a"] }).targets, ["a", "b"], "sorted");
    const plan = sha("alter table accounts add column tier text");
    const act = c.make({ installationId: "home" });
    const plain = await c.candidate({ "nn.js": "p" });
    const planned = await c.candidate({ "nn.js": "p" }, { migrationPlan: plan });
    assert.notEqual(plain, planned);
    for (const id of [plain, planned]) await c.approve(id);
    const sp = await act.stage(c.owner, { commandId: cid("st"), candidateId: planned });
    await refuses("invalid_command", () => act.activate(c.owner, { commandId: cid("a"), candidateId: planned, digest: sp.digest }), /carries a migration plan/);
    await refuses("invalid_command", () => act.activate(c.owner, { commandId: cid("a"), candidateId: planned, digest: sp.digest, migrationPlan: sha("another plan") }), /carries a migration plan/);
    await refuses("invalid_command", () => act.activate(c.owner, { commandId: cid("a"), candidateId: planned, digest: sp.digest, migrationPlan: "xyz" }), /migrationPlan/);
    assert.equal(pointerOf(c.root), undefined);
    assert.equal((await act.verify(c.owner, { releaseId: planned })).migrationPlan, plan, "the plan is shown from the record");
    const sPlain = await act.stage(c.owner, { commandId: cid("st"), candidateId: plain });
    await refuses("invalid_command", () => act.activate(c.owner, { commandId: cid("a"), candidateId: plain, digest: sPlain.digest, migrationPlan: plan }), /carries no migration plan/);
    await act.activate(c.owner, { commandId: cid("a"), candidateId: planned, digest: sp.digest, migrationPlan: plan });
    assert.equal(pointerOf(c.root), planned);
    // Targets.
    const mine = await c.candidate({ "nn.js": "t1" }, { targets: ["home", "office"] });
    const theirs = await c.candidate({ "nn.js": "t2" }, { targets: ["office"] });
    await refuses("invalid_transition", () => act.stage(c.owner, { commandId: cid("st"), candidateId: theirs }), /for office, not for this installation \(home\)/);
    await act.stage(c.owner, { commandId: cid("st"), candidateId: mine });
    const nameless = c.make();
    await refuses("invalid_transition", () => nameless.stage(c.owner, { commandId: cid("st"), candidateId: theirs }), /no name configured/);
    await c.approve(mine);
    await nameless.stage(c.owner, { commandId: cid("st"), candidateId: await c.candidate({ "nn.js": "free" }) }); // no targets: any installation
    const mineDigest = (await act.verify(c.owner, { releaseId: mine })).digest!;
    await refuses("invalid_transition", () => nameless.activate(c.owner, { commandId: cid("a"), candidateId: mine, digest: mineDigest }), /no name configured/);
    const other = c.make({ installationId: "office" });
    await other.activate(c.owner, { commandId: cid("a"), candidateId: mine, digest: mineDigest });
    assert.equal(pointerOf(c.root), mine);
    // The installation that the release is not for refuses it at activation even when it was staged (for example the database was copied between installations).
    const stray = c.make({ installationId: "elsewhere" });
    const free = await c.candidate({ "nn.js": "later" }, { targets: ["home"] });
    await c.approve(free);
    await act.stage(c.owner, { commandId: cid("st"), candidateId: free });
    const freeDigest = (await act.verify(c.owner, { releaseId: free })).digest!;
    await refuses("invalid_transition", () => stray.activate(c.owner, { commandId: cid("a"), candidateId: free, digest: freeDigest }), /for home, not for this installation \(elsewhere\)/);
  });

  // ---- K02d: database schema compatibility of the fall-back and of a rollback --------------------------------------------------------------------------------------------------------

  suite("database schema: a start that took the data past what the last known good understands blocks the fall-back (and says a restore is needed); unstated ranges and lower versions fall back as before", async (c) => {
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true } });
    const a = await c.candidate({ "nn.js": "a" }, { compatText: compat({ min: 1, max: 1 }) });
    const b = await c.candidate({ "nn.js": "b" }, { compatText: compat({ min: 1, max: 2 }) });
    await go0(c, act, a);
    const L = act.launcher;
    assert.equal((await L.prepare()).action, "run");
    await L.confirm(a);
    await go0(c, act, b);
    assert.equal(pointerOf(c.root), b);
    // The database is at schema 1: B fails to start, the fall-back to A is fine.
    await L.noteDatabase(1, b);
    const run = await L.prepare();
    assert.equal(run.action, "run");
    // Time passes, B never confirmed; the next launch quarantines it and falls back to A, whose range covers schema 1.
    const fell = await L.prepare();
    assert.deepEqual([fell.action, (fell as { releaseId?: string }).releaseId], ["run", a]);
    assert.equal(pointerOf(c.root), a);
  });

  suite("database schema: B migrated the database to version 2, A understands only 1: no fall-back, nothing guessed, the owner's notice says a snapshot must be restored; a rollback to A is refused too", async (c) => {
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true } });
    const a = await c.candidate({ "nn.js": "a" }, { compatText: compat({ min: 1, max: 1 }) });
    const b = await c.candidate({ "nn.js": "b" }, { compatText: compat({ min: 1, max: 2 }) });
    await go0(c, act, a);
    const L = act.launcher;
    await L.prepare(); await L.confirm(a);
    await go0(c, act, b);
    assert.equal((await L.prepare()).action, "run", "B starts");
    await L.noteDatabase(2, b); // B's controller migrated the data and then never confirmed
    const blocked = await L.prepare();
    assert.equal(blocked.action, "blocked");
    assert.match((blocked as { reason: string }).reason, /schema version 2.*up to 1.*snapshot/);
    assert.equal(pointerOf(c.root), b, "the pointer was not moved to a release that cannot start");
    const state = await L.read();
    assert.equal(state.known?.id, a);
    assert.match(state.notices?.[0]?.reason ?? "", /schema version 2/);
    // The service refuses the same in a rollback and shows how far the data has gone.
    await refuses("invalid_transition", () => act.rollback(c.owner, { commandId: cid("rb"), releaseId: a }), /schema versions up to 1.*this database is at 2/);
    assert.equal((await act.status(c.owner)).databaseSchema, 2);
    // A release that declares it does not understand the data is not activated either.
    const old = await c.candidate({ "nn.js": "old" }, { compatText: compat({ min: 1, max: 1 }) });
    await c.approve(old);
    const s = await act.stage(c.owner, { commandId: cid("st"), candidateId: old });
    await refuses("invalid_transition", () => act.activate(c.owner, { commandId: cid("a"), candidateId: old, digest: s.digest }), /up to 1.*at 2/);
  });

  suite("database schema: a last known good that states no range still falls back (not checked); the version is only ever raised; the controller records it through the option and an unreadable one never throws", async (c) => {
    const act = c.make({ compat: { workers: { min: 1, max: 1 }, required: true }, schemaVersion: async () => 3 });
    const a = await c.candidate({ "nn.js": "a" });
    const b = await c.candidate({ "nn.js": "b" });
    await go0(c, act, a);
    const L = act.launcher;
    await L.prepare(); await L.confirm(a);
    await go0(c, act, b);
    await L.prepare();
    assert.equal(await act.noteDatabase(), 3);
    await L.noteDatabase(2, "older");
    assert.equal((await L.read()).db?.version, 3, "never lowered");
    assert.equal((await L.read()).db?.by, "controller");
    assert.deepEqual([(await L.prepare()).action, pointerOf(c.root)], ["run", a], "no range stated: the fall-back goes ahead as before");
    assert.equal(await c.make({ schemaVersion: async () => { throw new Error("boom"); } }).noteDatabase(), undefined);
    assert.equal(await c.make().noteDatabase(), undefined);
    await assert.rejects(() => L.noteDatabase(-1, "x"), /whole number/);
    // A damaged db entry is dropped, not a damaged record: the launcher still reads and decides.
    const file = join(c.root, LAUNCHER_FILE);
    const j = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    writeFileSync(file, JSON.stringify({ ...j, db: { version: "x" } }));
    assert.equal((await new Launcher({ root: c.root, switcher: { read: async () => a, write: async () => undefined } as never }).read()).db, undefined);
  });

  suite("compat.json's schema range is read strictly and reaches the staged record; a bad one is refused at staging", async (c) => {
    assert.deepEqual(parseCompat(compat({ min: 1, max: 4 })), { protocol: { min: 1, max: 1 }, schema: { min: 1, max: 4 } });
    for (const t of ['{"schema":{"min":1,"max":1}}', '{"protocol":{"min":1,"max":1},"schema":{"min":3,"max":1}}', '{"protocol":{"min":1,"max":1},"schema":5}', '{"protocol":{"min":1,"max":1},"other":1}']) assert.throws(() => parseCompat(t), /compat\.json/);
    const act = c.make();
    const bad = await c.candidate({ "nn.js": "bad" }, { compatText: '{"protocol":{"min":1,"max":1},"schema":{"min":3,"max":1}}' });
    await refuses("invalid_command", () => act.stage(c.owner, { commandId: cid("st"), candidateId: bad }), /compat\.json/);
    const good = await c.candidate({ "nn.js": "good" }, { compatText: compat({ min: 1, max: 7 }) });
    await act.stage(c.owner, { commandId: cid("st"), candidateId: good });
    assert.deepEqual((await act.status(c.owner)).staged[0]!.schema, { min: 1, max: 7 });
  });
  suite("a key or signature may be named as a file in the trust folder (the chat cannot carry one): one plain name, a regular file, small; links, paths and both-or-neither are refused", async (c) => {
    const act = c.make();
    const k = keypair();
    const dir = join(c.root, "trust");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "build.pub"), `${k.publicKey}\n`);
    const id = await c.candidate({ "nn.js": "x" });
    await act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "build.pub", label: "from a file" });
    assert.equal((await act.trust(c.owner)).keys[0]!.label, "from a file");
    writeFileSync(join(dir, "x.sig"), k.sign(id));
    assert.equal((await act.attachSignature(c.manager, { commandId: cid("g"), candidateId: id, signatureFile: "x.sig" })).replayed, false);
    await act.stage(c.owner, { commandId: cid("st"), candidateId: id });
    for (const bad of ["../trust/build.pub", "a/b", "/etc/passwd", ".hidden", "", "x".repeat(65), "a..b", 5]) await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: bad as never }), /keyFile/);
    await refuses("not_found", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "missing.pub" }), /no such file/);
    writeFileSync(join(dir, "big.pub"), "A".repeat(600));
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "big.pub" }), /512 bytes/);
    mkdirSync(join(dir, "folder.pub"));
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "folder.pub" }), /plain file/);
    if (process.platform !== "win32") {
      symlinkSync(join(dir, "build.pub"), join(dir, "link.pub"));
      await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "link.pub" }), /plain file/);
    }
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "build.pub", publicKey: k.publicKey }), /exactly one/);
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t") }), /exactly one/);
    await refuses("invalid_command", () => act.attachSignature(c.owner, { commandId: cid("g"), candidateId: id }), /exactly one/);
    await refuses("invalid_command", () => act.attachSignature(c.owner, { commandId: cid("g"), candidateId: id, signature: "A", signatureFile: "x.sig" }), /exactly one/);
    writeFileSync(join(dir, "junk.pub"), "not a key");
    await refuses("invalid_command", () => act.addTrustedKey(c.owner, { commandId: cid("t"), keyFile: "junk.pub" }), /publicKey/);
  });
}
