import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SimulatedCrash } from "../release/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("release staging and activation end to end: the owner's word only, bound to digest and approval, switched on a real folder, interrupted switches resolve across restarts, chat proposes activation (card K02)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k02-"));
  const root = join(d, "rel");
  const say: Record<string, unknown[]> = {};
  let crashAt: string | undefined;
  const open = () => startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    releases: { root, switcher: "symlink", platform: { os: "linux", arch: "x64" }, hook: (p) => { if (p === crashAt) throw new SimulatedCrash(p); } },
  });
  const link = () => (existsSync(join(root, "current")) || (() => { try { lstatSync(join(root, "current")); return true; } catch { return false; } })() ? readlinkSync(join(root, "current")) : undefined);
  let c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e1", kind: "agent", name: "builder", grants: [{ action: "release.report", project: "*" }] });
    const builderToken = (await c.services.principals.issueCredential(rob, "agent:builder")).token;
    const builder = await c.services.principals.authenticate(builderToken);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const owner = (op: string, args: Record<string, unknown>, id?: string) => call(boot.token, op, args, id);
    assert.ok((await owner("release.host", { hostId: "lx", os: "linux", arch: "x64" }, "h1")).ok);

    /** A candidate with real artifacts in incoming/, tested and passed by the builder agent. */
    const candidate = async (tag: string, files: Record<string, string>) => {
      const artifacts = Object.fromEntries(Object.entries(files).map(([k, v]) => [k, sha(v)]));
      const manifest = { sourceCommit: "c".repeat(40), suiteRevision: "s1", artifacts, dependencyLocks: { lock: sha("lock") }, matrix: [{ os: "linux", arch: "x64" }] };
      const id = (await owner("release.submit", { manifest }, `sub-${tag}`)).result.candidateId as string;
      const att = (await owner("release.issue", { candidateId: id, cell: { os: "linux", arch: "x64" }, hostId: "lx", workerId: builder.id, timeoutSeconds: 600, memoryMb: 2048 }, `iss-${tag}`)).result.attemptId as string;
      const rep = await call(builderToken, "release.report", { attemptId: att, sourceCommit: "c".repeat(40), suiteRevision: "s1", artifactHashes: artifacts, dependencyLockHashes: { lock: sha("lock") }, environment: { os: "linux", arch: "x64" }, outcome: "pass", counts: { passed: 1, failed: 0, skipped: 0 }, logDigest: sha("log"), summary: "ok" }, `rep-${tag}`);
      assert.ok(rep.ok, JSON.stringify(rep));
      for (const [k, v] of Object.entries(files)) { const p = join(root, "incoming", id, k); mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, v); }
      return id;
    };
    const one = await candidate("1", { "nn.js": "v1" });
    const two = await candidate("2", { "nn.js": "v2", "lib/x.js": "x" });

    // Authority: the agent that built and reported the candidate cannot stage, activate, roll back or read; nothing changed.
    for (const [op, args] of [["release.stage", { candidateId: one }], ["release.activate", { candidateId: one, digest: sha("x") }], ["release.rollback", { releaseId: one }], ["release.staging.settings.set", { requireApproval: false }], ["release.approval.disable", {}]] as const)
      assert.equal((await call(builderToken, op, args, `b-${op}`)).error?.code, "forbidden", op);
    for (const op of ["release.status", "release.staging.settings.get"]) assert.equal((await call(builderToken, op, {})).error?.code, "forbidden", op);

    // Stage: digests checked against the manifest; the digest is returned; the same again is the same release.
    const st1 = (await owner("release.stage", { candidateId: one }, "st1")).result;
    const st2 = (await owner("release.stage", { candidateId: two }, "st2")).result;
    assert.equal((await owner("release.stage", { candidateId: one }, "st1b")).result.replayed, true);
    assert.equal(link(), undefined, "staging switches nothing");

    // Activation needs approval and the digest; the word is bound to both.
    assert.equal((await owner("release.activate", { candidateId: one, digest: st1.digest }, "a0")).error?.code, "invalid_transition");
    assert.ok((await owner("release.approve", { candidateId: one }, "ap1")).ok);
    assert.equal((await owner("release.activate", { candidateId: one, digest: st2.digest }, "a1")).error?.code, "invalid_command", "another release's digest");
    assert.equal((await owner("release.activate", { candidateId: one, digest: st1.digest, expectedRevision: 7 }, "a2")).error?.code, "stale_revision");
    const act = await owner("release.activate", { candidateId: one, digest: st1.digest, expectedRevision: 0 }, "a3");
    assert.ok(act.ok, JSON.stringify(act));
    assert.equal(link(), `releases/${one}`);

    // Chat: stage applies at once, activate is only proposed and switches on the owner's word; the approval requirement is turned off by a proposal and on at once.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const needsApproval = `activate release ${two} with digest ${st2.digest}`;
    assert.ok((await owner("release.approve", { candidateId: two }, "ap2")).ok);
    const shown = await turn("m1", needsApproval, [{ kind: "command", op: "release.activate", args: { candidateId: two, digest: st2.digest }, evidence: needsApproval, basis: "owner" }]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal(link(), `releases/${one}`, "a proposal switches nothing");
    const applied = await turn("m2", "yes, activate it", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "activate it", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.equal(link(), `releases/${two}`);
    const dropText = "do not require approval for activating releases";
    const drop = await turn("m3", dropText, [{ kind: "command", op: "release.approval.disable", args: {}, evidence: dropText, basis: "owner" }]);
    assert.equal(drop[0]!.status, "proposed", "widening is only proposed");
    assert.equal((await owner("release.staging.settings.get", {})).result.item.requireApproval, true);
    assert.ok((await owner("release.approval.disable", {}, "dis")).ok);
    const reqText = "require approval for activating releases";
    const req = await turn("m4", reqText, [{ kind: "command", op: "release.approval.enable", args: {}, evidence: reqText, basis: "owner" }]);
    assert.equal(req[0]!.status, "applied", JSON.stringify(req));
    assert.equal((await owner("release.staging.settings.get", {})).result.item.requireApproval, true, "narrowing applied at once");

    // A rollback interrupted right after the switch: the process dies; on the next start the record catches up to what the launcher already follows.
    let status = (await owner("release.status", {})).result.item;
    assert.deepEqual([status.current.id, status.previous.id, status.diverged], [two, one, false]);
    crashAt = "afterSwitch";
    const dying = await owner("release.rollback", { releaseId: one }, "rb1");
    assert.equal(dying.ok, false, "the process died during the switch");
    assert.equal(link(), `releases/${one}`, "the launcher already follows the old release");
    await c.close();
    crashAt = undefined;
    c = await open();
    status = (await owner("release.status", {})).result.item;
    assert.deepEqual([status.current.id, status.previous, status.journal, status.diverged, status.history.at(-1).kind], [one, undefined, undefined, false, "recovered"]);

    // A switch interrupted before the switch: the next start closes it as not done.
    crashAt = "afterVerify";
    assert.equal((await owner("release.activate", { candidateId: two, digest: st2.digest }, "a9")).ok, false);
    assert.equal((await owner("release.status", {})).result.item.journal.to.id, two);
    await c.close();
    crashAt = undefined;
    c = await open();
    status = (await owner("release.status", {})).result.item;
    assert.deepEqual([status.current.id, status.journal, link(), status.history.at(-1).kind], [one, undefined, `releases/${one}`, "aborted"]);

    // Tampering with a staged release after staging is caught at activation, with the old release still running.
    chmodSync(join(root, "releases", two, "nn.js"), 0o644);
    writeFileSync(join(root, "releases", two, "nn.js"), "EVIL");
    const tampered = await owner("release.activate", { candidateId: two, digest: st2.digest }, "a10");
    assert.equal(tampered.error?.code, "invalid_transition");
    assert.equal(link(), `releases/${one}`);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
