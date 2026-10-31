import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyring, keyringFingerprint, unlockWithPasscode } from "../backup/index.js";
import { CHAT_OPS } from "../chat/commands.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PASS = "correct horse battery staple";

test("encrypted backups through the state API: unattended backups are sealed, the owner proves an unlock method from host files, an agent cannot, and no secret is in any answer (card K01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-bke-"));
  try {
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json"); const pf = join(d, "pass"); const rf = join(d, "recovery");
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 }); writeFileSync(pf, PASS, { mode: 0o600 }); writeFileSync(rf, JSON.stringify(recoveryFile), { mode: 0o600 });
    const otherRing = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const otherFile = join(d, "other-keyring.json");
    writeFileSync(otherFile, JSON.stringify(otherRing.keyring), { mode: 0o600 });
    const otherFp = keyringFingerprint(otherRing.keyring);
    let token: string | undefined;
    let clock = Date.parse("2026-10-29T10:00:00.000Z");
    const start = (extra: object) => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
      backup: { directory: join(d, "backups"), now: () => new Date(clock), ...extra } });
    // A keyring that cannot be read stops the controller: it never falls back to plain backups.
    await assert.rejects(start({ encryption: { keyringFile: join(d, "missing.json") } }), /no backup is made without it/);
    const c = await start({ encryption: { keyringFile, passcodeFile: pf, recoveryFile: rf } });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      token = boot.token;
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
      await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
      const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;

      assert.equal((await call(zed, "backup.encryption.status", {})).error.code, "forbidden");
      assert.equal((await call(zed, "backup.encryption.verify", { method: "passcode" }, "v0")).error.code, "forbidden");
      const status = await call(boot.token, "backup.encryption.status", {});
      assert.equal(status.result.item.enabled, true);
      assert.equal(status.result.item.keyId, keyring.keyId);
      assert.deepEqual(status.result.item.unlockMethods, { passcode: 1, recovery: 1 });

      // A backup made with no secret supplied at that moment is sealed.
      const made = await call(boot.token, "backup.now", {}, "b1");
      assert.ok(made.ok, JSON.stringify(made));
      const manifest = JSON.parse(readFileSync(join(d, "backups", readdirSync(join(d, "backups"))[0]!, "manifest.json"), "utf8"));
      assert.equal(manifest.encryption.keyId, keyring.keyId);
      assert.ok(readdirSync(join(d, "backups", manifest.name)).every((f) => f === "manifest.json" || f.endsWith(".enc")));
      await unlockWithPasscode(manifest.encryption.keyring, PASS);

      const ok = await call(boot.token, "backup.encryption.verify", { method: "passcode" }, "v1");
      assert.ok(ok.ok, JSON.stringify(ok));
      assert.equal(ok.result.method, "passcode");
      // The secret is not an argument: one sent is refused, and so is a path.
      assert.equal((await call(boot.token, "backup.encryption.verify", { method: "passcode", passcode: PASS }, "v2")).ok, false);
      assert.equal((await call(boot.token, "backup.encryption.verify", { method: "passcode", file: "/etc/passwd" }, "v3")).ok, false);
      // Proving again at once is refused (rate limit), not run.
      const again = await call(boot.token, "backup.encryption.verify", { method: "recovery" }, "v4");
      assert.equal(again.ok, false);
      assert.match(JSON.stringify(again), /wait a few seconds/);
      const after = await call(boot.token, "backup.encryption.status", {});
      assert.equal(after.result.item.lastProof.ok, true);
      const shown = JSON.stringify([status, made, ok, again, after, await call(boot.token, "backup.list", {})]);
      for (const secret of [PASS, recoveryFile.recoveryKey, (keyring.wrappers[0] as { wrapped: string }).wrapped]) assert.ok(!shown.includes(secret));
      // The key is pinned at the first start and its fingerprint is shown; only the owner may approve another; a recovery file beside the keyring is warned about.
      const fp = keyringFingerprint(keyring);
      assert.deepEqual([after.result.item.fingerprint, after.result.item.pinned.fingerprint], [fp, fp]);
      assert.match(JSON.stringify(after.result.item.warnings), /same folder as the keyring/);
      assert.equal((await call(zed, "backup.encryption.rekey", { fingerprint: otherFp }, "rk0")).error.code, "forbidden");
      assert.equal((await call(boot.token, "backup.encryption.rekey", { fingerprint: "nope" }, "rk1")).error.code, "invalid_command");
      assert.equal((await call(boot.token, "backup.encryption.rekey", { fingerprint: fp }, "rk2")).error.code, "invalid_command");
      assert.ok(CHAT_OPS["backup.encryption.rekey"] !== undefined && CHAT_OPS["backup.encryption.rekey"].mode === "propose", "the chat proposes it");
    } finally { await c.close(); }
    // A restart with another keyring file is refused (the pinned key is the one in use), the controller does not start, and no backup is made with it.
    await assert.rejects(start({ encryption: { keyringFile: otherFile } }), /backup\.encryption\.rekey/);
    // The owner approves the new fingerprint while the old key runs; the next start with the new keyring is accepted, once.
    const again = await start({ encryption: { keyringFile } });
    try {
      const rob = await again.services.principals.authenticate(token!);
      assert.equal(rob.kind, "owner");
      const approve = (await again.api.handle(token!, { v: 1, op: "backup.encryption.rekey", commandId: "rk3", args: { fingerprint: otherFp } } as never)) as any;
      assert.ok(approve.ok, JSON.stringify(approve));
      const status = (await again.api.handle(token!, { v: 1, op: "backup.encryption.status", args: {} } as never)) as any;
      assert.equal(status.result.item.approvedNext.fingerprint, otherFp);
      assert.equal(status.result.item.pinned.fingerprint, keyringFingerprint(keyring), "the approval alone changes nothing");
    } finally { await again.close(); }
    const moved = await start({ encryption: { keyringFile: otherFile } });
    try {
      const status = (await moved.api.handle(token!, { v: 1, op: "backup.encryption.status", args: {} } as never)) as any;
      assert.deepEqual([status.result.item.pinned.fingerprint, status.result.item.approvedNext], [otherFp, undefined]);
    } finally { await moved.close(); }
    await assert.rejects(start({ encryption: { keyringFile } }), /backup\.encryption\.rekey/, "the approval was used once; the old key is now the unapproved one");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
