import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyring } from "../backup/index.js";
import type { SigningSecretStore } from "../backup/index.js";
import { acceptedArgs, CHAT_OPS } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PASS = "correct horse battery staple";
const DAY = 86_400_000;

type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
function memoryStore(): SigningSecretStore & { values: Map<string, string>; locked: boolean } {
  const values = new Map<string, string>();
  const s = { values, locked: false, async resolve(n: string) { if (s.locked) throw new Error("locked"); return values.get(n); }, async set(n: string, v: string) { if (s.locked) throw new Error("locked"); values.set(n, v); } };
  return s;
}
const manifestOf = (dir: string, name: string): any => JSON.parse(readFileSync(join(dir, name, "manifest.json"), "utf8"));
const newest = (dir: string): string => readdirSync(dir).filter((n) => n.startsWith("backup-") && !n.endsWith(".partial")).sort().at(-1)!;

test("the owner switches backup encryption off, on and narrows its scope by chat or API; it is owner only, revision-checked, recorded, announced, and removing the keyring option cannot quietly make plain backups (card K01b3)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k3a-"));
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json");
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const start = (extra: object) => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, backup: { directory: join(d, "backups"), now: () => new Date(clock), ...extra } });
    const dir = join(d, "backups");
    let c = await start({ encryption: { keyringFile } });
    let token = "";
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      token = boot.token;
      const rob = await c.services.principals.authenticate(boot.token);
      const call = async (tok: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => (await c.api.handle(tok, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as Reply;
      const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
      await c.services.principals.enroll(rob!, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
      const zed = (await c.services.principals.issueCredential(rob!, "agent:zed")).token;
      const inbox = async () => (await NotificationService.withEpoch(c.storage, c.epoch, { clock: () => new Date(clock).toISOString() }).inbox((await c.services.principals.authenticate(boot.token))!)).items.filter((i) => i.ref.kind === "backup-encryption");

      // Owner only, on every route.
      assert.equal((await call(zed, "backup.encryption.set", { enabled: false }, "z1")).error?.code, "forbidden");
      assert.equal((await call(zed, "backup.signing.rotate", {}, "z2")).error?.code, "forbidden");
      assert.equal((await call(zed, "backup.signing.status", {})).error?.code, "forbidden");
      // The status shows the setting and what it means.
      const status = (await call(boot.token, "backup.encryption.status", {})).result.item;
      assert.deepEqual([status.setting.enabled, status.setting.scope, status.setting.revision], [true, "everything", 0]);
      assert.match(status.setting.text, /every file of a new backup is sealed/);
      // Bad asks.
      for (const [args, id] of [[{}, "i0"], [{ enabled: "no" }, "i1"], [{ scope: "all" }, "i2"], [{ enabled: false, passcode: PASS }, "i3"], [{ enabled: true }, "i4"]] as const) {
        const r = await call(boot.token, "backup.encryption.set", { ...args }, id);
        assert.equal(r.error?.code, "invalid_command", `${JSON.stringify(args)}: ${JSON.stringify(r)}`);
      }
      assert.equal((await call(boot.token, "backup.encryption.set", { enabled: false, expectedRevision: 5 }, "i5")).error?.code, "stale_revision");

      await call(boot.token, "backup.now", {}, "b1");
      assert.ok(manifestOf(dir, newest(dir)).encryption !== undefined, "sealed by default");

      // Off: the next backup is plain, the change is said back, announced, and kept in the setting.
      clock += 61_000;
      const off = await call(boot.token, "backup.encryption.set", { enabled: false, expectedRevision: 0 }, "s1");
      assert.ok(off.ok, JSON.stringify(off));
      assert.deepEqual([off.result.enabled, off.result.weaker, off.result.changed], [false, true, true]);
      assert.match(off.result.text, /new backups are written in plain/);
      clock += 61_000; await call(boot.token, "backup.now", {}, "b2");
      assert.equal(manifestOf(dir, newest(dir)).encryption, undefined, "the next backup is plain");
      const told = await inbox();
      assert.equal(told.length, 1);
      assert.match(told[0]!.label, /made weaker/);
      assert.equal((await call(boot.token, "backup.encryption.set", { enabled: false }, "s2")).error?.code, "invalid_command", "already off");
      const after = (await call(boot.token, "backup.encryption.status", {})).result.item;
      assert.deepEqual([after.setting.enabled, after.setting.revision, after.setting.changedBy], [false, 1, "owner:rob"]);

      // On again: the key was never touched, so no new key is needed; the next backup is sealed for the same key.
      clock += 61_000;
      assert.ok((await call(boot.token, "backup.encryption.set", { enabled: true }, "s3")).ok);
      clock += 61_000; await call(boot.token, "backup.now", {}, "b3");
      assert.equal(manifestOf(dir, newest(dir)).encryption.keyId, keyring.keyId);

      // Narrowing to secrets only: no secret values are in a backup, so it writes plain, and says so.
      const narrow = await call(boot.token, "backup.encryption.set", { scope: "secrets" }, "s4");
      assert.ok(narrow.ok, JSON.stringify(narrow));
      assert.deepEqual([narrow.result.weaker, narrow.result.scope], [true, "secrets"]);
      assert.match(narrow.result.text, /No secret values are in a backup today/);
      clock += 61_000; await call(boot.token, "backup.now", {}, "b4");
      assert.equal(manifestOf(dir, newest(dir)).encryption, undefined);
      // Widening again is not "weaker" and is announced as a strengthening.
      const wide = await call(boot.token, "backup.encryption.set", { scope: "everything" }, "s5");
      assert.equal(wide.result.weaker, false);
      assert.ok((await inbox()).some((i) => /strengthened/.test(i.label)));

      // The chat reaches it: shown first, with its arguments named for the interpreter.
      assert.equal(CHAT_OPS["backup.encryption.set"]?.mode, "propose");
      for (const k of ["enabled", "scope", "expectedRevision"]) assert.ok(acceptedArgs("backup.encryption.set")!.includes(k), k);
      assert.equal(CHAT_OPS["backup.signing.rotate"]?.mode, "propose");
    } finally { await c.close(); }

    // Dropping the keyring option from the configuration is refused while encryption is on (an installation that sealed backups does not go plain by omission) ...
    await assert.rejects(start({}), /no longer names a keyring file/);
    // ... and allowed once the owner has switched it off, by a recorded setting.
    c = await start({ encryption: { keyringFile } });
    try {
      const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as Reply;
      const st = (await call("backup.encryption.status", {})).result.item;
      assert.equal(st.setting.enabled, true, "the setting survives a restart");
      assert.ok((await call("backup.encryption.set", { enabled: false }, "s6")).ok);
    } finally { await c.close(); }
    c = await start({});
    try {
      clock += 61_000;
      assert.ok(((await c.api.handle(token, { v: 1, op: "backup.now", commandId: "b5", args: {} } as never)) as Reply).ok);
      assert.equal(manifestOf(dir, newest(dir)).encryption, undefined);
    } finally { await c.close(); }
    assert.ok(existsSync(join(dir, "encryption-set-up")));
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("backups are signed with a key held in the secret store; the controller's restore requires a valid signature of a recorded key; the owner rotates the key; no private key is in any answer, record or backup (card K01b3)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k3b-"));
  try {
    const store = memoryStore();
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const printed: string[] = [];
    const start = (signing: { store: SigningSecretStore } | undefined) => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: (l) => printed.push(l), facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, backup: { directory: join(d, "backups"), now: () => new Date(clock), ...(signing === undefined ? {} : { signing }) } });
    store.locked = true;
    await assert.rejects(start({ store }), /secret store cannot be read/);
    store.locked = false;
    const c = await start({ store });
    const dir = join(d, "backups");
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as Reply;
      const privateKey = store.values.get("backup-signing-key")!;
      assert.ok(privateKey && printed.some((l) => /Backups are signed; the signing key/.test(l)));
      assert.ok(!printed.join("\n").includes(privateKey));
      const status = (await call("backup.signing.status", {})).result.item;
      assert.equal(status.keys.length, 1);
      assert.equal(status.since, new Date(clock).toISOString());
      clock += DAY;
      assert.ok((await call("backup.now", {}, "b1")).ok);
      const first = newest(dir);
      assert.ok(existsSync(join(dir, first, "signature.json")));
      assert.equal(JSON.parse(readFileSync(join(dir, first, "signature.json"), "utf8")).keyId, status.keys[0].keyId);

      // The restore preview names what the signature shows, and what it does not.
      const preview = await call("backup.restore.preview", { name: first });
      assert.ok(preview.ok, JSON.stringify(preview));
      assert.ok(preview.result.item.warnings.some((w: string) => /Signature valid .*only as strong as the running server/.test(w)), JSON.stringify(preview.result.item.warnings));

      // A backup whose signature is gone, or whose manifest was changed, is not offered for restore.
      clock += DAY; assert.ok((await call("backup.now", {}, "b2")).ok);
      const second = newest(dir);
      const sig = readFileSync(join(dir, second, "signature.json"), "utf8");
      rmSync(join(dir, second, "signature.json"));
      const unsigned = await call("backup.restore.preview", { name: second });
      assert.equal(unsigned.ok, false);
      assert.match(JSON.stringify(unsigned), /not signed/);
      writeFileSync(join(dir, second, "signature.json"), sig);
      const m = readFileSync(join(dir, second, "manifest.json"), "utf8");
      writeFileSync(join(dir, second, "manifest.json"), m.replace('"kind": "manual"', '"kind": "scheduled"'));
      assert.match(JSON.stringify(await call("backup.restore.preview", { name: second })), /changed or forged/);
      writeFileSync(join(dir, second, "manifest.json"), m);

      // Rotation: stale revision refused, then a new key signs; the old key's backups still restore.
      assert.equal((await call("backup.signing.rotate", { expectedRevision: 99 }, "r0")).error?.code, "stale_revision");
      const rotated = await call("backup.signing.rotate", { expectedRevision: status.revision }, "r1");
      assert.ok(rotated.ok, JSON.stringify(rotated));
      assert.equal(rotated.result.generation, 2);
      const status2 = (await call("backup.signing.status", {})).result.item;
      assert.equal(status2.keys.length, 2);
      assert.ok(status2.keys[0].retiredAt !== undefined && status2.keys[1].retiredAt === undefined);
      clock += DAY; assert.ok((await call("backup.now", {}, "b3")).ok);
      assert.equal(JSON.parse(readFileSync(join(dir, newest(dir), "signature.json"), "utf8")).keyId, rotated.result.keyId);
      { const again = await call("backup.restore.preview", { name: first }); assert.ok(again.ok, `the older backup still verifies: ${JSON.stringify(again)}`); }
      const owner = (await c.services.principals.authenticate(boot.token))!;
      const told = (await NotificationService.withEpoch(c.storage, c.epoch, { clock: () => new Date(clock).toISOString() }).inbox(owner)).items.filter((i) => i.ref.kind === "backup-signing");
      assert.equal(told.length, 1);
      assert.match(told[0]!.label, /new backup signing key/);

      // A locked secret store fails the backup (none is written unsigned) and the failure is the usual one.
      store.locked = true; clock += DAY;
      const before = readdirSync(dir).length;
      assert.equal((await call("backup.now", {}, "b4")).ok, false);
      assert.equal(readdirSync(dir).length, before, "no unsigned backup was written");
      store.locked = false;
      // No private key anywhere that can be read back: not in an answer, not in a backup, not in the database dump.
      const everything = JSON.stringify([status, status2, rotated, preview, await call("backup.list", {})]);
      for (const k of store.values.values()) assert.ok(!everything.includes(k));
      for (const name of readdirSync(dir).filter((n) => n.startsWith("backup-"))) for (const f of readdirSync(join(dir, name))) for (const k of [privateKey, ...store.values.values()]) assert.ok(!readFileSync(join(dir, name, f), "utf8").includes(k), `${name}/${f}`);
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the quarterly proof is a Needs-you notification, becomes Urgent when it stays overdue, and closes when the owner proves an unlock method (card K01b3)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k3c-"));
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json"); const pf = join(d, "pass");
    writeFileSync(keyringFile, JSON.stringify({ ...keyring, createdAt: "2026-11-01T10:00:00.000Z" }), { mode: 0o600 }); writeFileSync(pf, PASS, { mode: 0o600 });
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const sent: { text: string }[] = [];
    const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI], dispatch: { timer: new ManualTimer(), manual: true, intervalMs: 1000 }, backup: { directory: join(d, "backups"), now: () => new Date(clock), encryption: { keyringFile, passcodeFile: pf }, everyMs: 1000 * DAY }, notifications: { channels, clock: () => new Date(clock).toISOString() } });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const call = async (op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as Reply;
      const owner = (await c.services.principals.authenticate(boot.token))!;
      const open = async () => (await NotificationService.withEpoch(c.storage, c.epoch, { channels, clock: () => new Date(clock).toISOString() }).inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled" && i.ref.kind === "backup-proof");
      const tick = async () => { clock += 301_000; const t = await c.dispatch!.dispatcher.tick(); assert.ok(t.loops.some((l) => l.name === "backup.proof-reminder" && l.ok), JSON.stringify(t.loops.filter((l) => !l.ok))); };
      const settings = await call("notifications.settings", {});
      assert.ok((await call("notifications.configure", { channel: "external", channelName: "chat", expectedRevision: settings.result.item.revision }, "n1")).ok);
      await tick();
      assert.equal((await open()).length, 0, "not due yet");
      clock += 91 * DAY; await tick();
      assert.equal((await open()).length, 0, "92 days is the limit");
      clock += 2 * DAY; await tick();
      let items = await open();
      assert.equal(items.length, 1, JSON.stringify(items));
      assert.deepEqual([items[0]!.ref.id, items[0]!.level], ["due", "needs-you"]);
      assert.match(items[0]!.label, /backup passcode or recovery file/);
      await tick();
      assert.equal((await open()).length, 1, "reported once, not again on every tick");
      clock += 15 * DAY; await tick();
      items = await open();
      assert.deepEqual(items.map((i) => [i.ref.id, i.level]).sort(), [["due", "needs-you"], ["overdue", "urgent"]]);
      assert.ok(sent.some((m) => /Urgent: backup passcode or recovery file not proved/.test(m.text)), JSON.stringify(sent));
      await call("backup.encryption.verify", { method: "passcode" }, "v1");
      await tick();
      assert.equal((await open()).length, 0, "a successful proof closes both");
      assert.equal((await call("backup.encryption.status", {})).result.item.proofDue, false);
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
