import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { ControllerStorage } from "../storage/index.js";
import { RestoreRefused, SIGNING_SECRET_NAME, UnlockFailed, createBackup, createKeyring, restoreBackup, restoreSecrets, secretsSourceOf, unlockWithPasscode, unlockWithRecovery, verifyBackup } from "./index.js";
import { runBackupCli } from "./cli.js";

after(stopServer);

const AT = "2026-10-29T10:00:00.000Z";
const PASS = "correct horse battery staple";
const FAST = { N: 2 ** 16, r: 8, p: 1 } as const;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-sec-"));
const TITLE = "plain-title-visible-in-secrets-scope-4471";
const VALUES = { "models.providers.openai.credential": "sk-test-value-AAAA-1111-not-real", "chat.whatsapp.token": "wa-test-value-BBBB-2222-not-real" };

async function populate(storage: ControllerStorage): Promise<void> {
  const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
  await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: TITLE } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
}
const allBytes = (dir: string): Buffer => Buffer.concat(readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => readFileSync(join(e.parentPath, e.name))));
/** A secret store in memory that also holds the backup-signing key (which must never be carried). */
function store(initial: Record<string, string> = { ...VALUES, [SIGNING_SECRET_NAME]: "SIGNING-PRIVATE-KEY-MUST-NOT-LEAVE" }) {
  const values = new Map(Object.entries(initial));
  let locked = false;
  return { values, lock: () => { locked = true; }, get: async (n: string) => values.get(n), resolve: async (n: string) => { if (locked) throw new Error("the store is locked"); return values.get(n); }, set: async (n: string, v: string) => { values.set(n, v); } };
}
const NAMES = [...Object.keys(VALUES), SIGNING_SECRET_NAME, "not.set.anywhere"];

for (const backend of backends) {
  test(`${backend.name}: scope "secrets" seals only the secret values: the tables stay plain and restore with no key, the values open only with the passcode or the recovery file (card K01b)`, async () => {
    const a = await backend.open(); const b = await backend.open(); const c = await backend.open(); const d = await backend.open(); const root = tmp();
    try {
      await populate(a.storage);
      const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: FAST });
      const src = store();
      const { path, manifest } = await createBackup(a.storage, { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, scope: "secrets", secrets: secretsSourceOf(src, () => NAMES, [SIGNING_SECRET_NAME]) });
      assert.equal(manifest.encryption?.scope, "secrets");
      assert.deepEqual([manifest.secrets?.count, manifest.secrets?.missing], [2, 1], "two values carried; the unset name is counted, not named; the signing key is not carried");
      const bytes = allBytes(path);
      for (const v of [...Object.values(VALUES), "SIGNING-PRIVATE-KEY-MUST-NOT-LEAVE"]) assert.equal(bytes.includes(v), false, "no secret value is readable in the folder");
      for (const n of Object.keys(VALUES)) assert.equal(bytes.includes(n), false, "not even a secret's name is in the folder");
      assert.equal(bytes.includes(TITLE), true, "the rest of the backup is plain in this scope");
      assert.ok(readdirSync(path).includes("secrets.jsonl.enc"));
      assert.match(manifest.notes.join(" "), /sealed under the backup key/);

      // Without a key: the plain part checks out, with a plain statement that the sealed part was not looked at.
      const bare = await verifyBackup(path);
      assert.equal(bare.ok, true);
      assert.match((bare.notes ?? []).join(" "), /without the passcode or recovery file/);
      // A key makes the check complete (manifest seal and the secrets file).
      const keyed = await verifyBackup(path, { unlock: await unlockWithPasscode(keyring, PASS) });
      assert.deepEqual([keyed.ok, keyed.notes], [true, undefined]);
      // Encryption required, and nothing to check the sealed part with: refused.
      assert.equal((await verifyBackup(path, { requireEncrypted: true })).ok, false);

      // Restore with the passcode: the rows and the values come back.
      const sink = store({});
      const r1 = await restoreBackup(path, b.storage, { unlock: await unlockWithPasscode(keyring, PASS), secrets: sink });
      assert.deepEqual(r1.secrets, { restored: 2, same: 0, keptDifferent: 0, overwritten: 0 });
      assert.deepEqual([...sink.values.entries()].sort(), Object.entries(VALUES).sort());
      assert.equal(sink.values.has(SIGNING_SECRET_NAME), false);
      assert.equal((await b.storage.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], TITLE);
      // The recovery file opens them as well.
      const sink2 = store({});
      await restoreBackup(path, c.storage, { unlock: unlockWithRecovery(keyring, recoveryFile), secrets: sink2 });
      assert.deepEqual([...sink2.values.entries()].sort(), Object.entries(VALUES).sort());
      // Nothing opens without a key, and the rest still restores ("secrets only: the secrets are lost, the rest restores").
      const r3 = await restoreBackup(path, d.storage);
      assert.equal(r3.secrets, undefined);
      assert.match(r3.secretsLeftOut ?? "", /no passcode or recovery file/);
      assert.equal((await d.storage.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], TITLE);
    } finally { await a.close(); await b.close(); await c.close(); await d.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${backend.name}: scope "everything" seals the secret values with the rest, and a restore with the passcode brings both back (card K01b)`, async () => {
    const a = await backend.open(); const b = await backend.open(); const root = tmp();
    try {
      await populate(a.storage);
      const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
      const { path, manifest } = await createBackup(a.storage, { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, secrets: secretsSourceOf(store(), () => NAMES, [SIGNING_SECRET_NAME]) });
      assert.equal(manifest.encryption?.scope, "everything");
      const bytes = allBytes(path);
      assert.equal(bytes.includes(TITLE), false);
      for (const v of Object.values(VALUES)) assert.equal(bytes.includes(v), false);
      // Everything sealed: no key, no restore.
      assert.equal((await verifyBackup(path)).ok, false);
      const sink = store({});
      const r = await restoreBackup(path, b.storage, { unlock: await unlockWithPasscode(keyring, PASS), secrets: sink });
      assert.equal(r.secrets?.restored, 2);
      assert.equal((await b.storage.getAggregate({ kind: "task", id: "task-a" }))?.body["title"], TITLE);
    } finally { await a.close(); await b.close(); rmSync(root, { recursive: true, force: true }); }
  });

  test(`${backend.name}: a backup without encryption carries references only, a locked secret store fails the backup and leaves no folder, and a value that was changed is caught (card K01b)`, async () => {
    const a = await backend.open(); const root = tmp();
    try {
      await populate(a.storage);
      // No encryption: the source is not read, no secrets file, the note says so.
      let read = 0;
      const spy = { read: async () => { read += 1; return []; } };
      const plain = await createBackup(a.storage, { root, kind: "manual", version: "t", now: () => new Date(AT), secrets: spy });
      assert.equal(read, 0);
      assert.equal(plain.manifest.secrets, undefined);
      assert.match(plain.manifest.notes.join(" "), /are not in this backup/);
      rmSync(plain.path, { recursive: true, force: true });
      const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
      const locked = store(); locked.lock();
      await assert.rejects(createBackup(a.storage, { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, scope: "secrets", secrets: secretsSourceOf(locked, () => NAMES) }), /locked/);
      assert.deepEqual(readdirSync(root).filter((f) => f.startsWith("backup-")), [], "no partial or half-made backup is left");
      // A changed sealed file, a removed one and a manifest changed field-wise are each refused when the key is given.
      const good = await createBackup(a.storage, { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, scope: "secrets", secrets: secretsSourceOf(store(), () => NAMES, [SIGNING_SECRET_NAME]) });
      const key = await unlockWithPasscode(keyring, PASS);
      const file = join(good.path, "secrets.jsonl.enc");
      const orig = readFileSync(file);
      const flipped = Buffer.from(orig); flipped[flipped.length - 20] = flipped[flipped.length - 20]! ^ 1; writeFileSync(file, flipped);
      assert.match((await verifyBackup(good.path, { unlock: key })).problems.join(" "), /secrets/);
      rmSync(file);
      assert.match((await verifyBackup(good.path, { unlock: key })).problems.join(" "), /secrets/);
      writeFileSync(file, orig);
      const mpath = join(good.path, "manifest.json");
      const m = JSON.parse(readFileSync(mpath, "utf8")); m.secrets.missing = 0; writeFileSync(mpath, JSON.stringify(m));
      assert.match((await verifyBackup(good.path, { unlock: key })).problems.join(" "), /manifest was changed/);
      // A restore that was given a key but nowhere to put the values is refused before anything is written.
      writeFileSync(mpath, JSON.stringify({ ...m, secrets: { ...m.secrets, missing: 1 } }));
      const e = await backend.open();
      try { await assert.rejects(restoreBackup(good.path, e.storage, { unlock: key }), (x: unknown) => x instanceof RestoreRefused && /nowhere was given/.test(x.message)); assert.equal(await e.storage.currentEpoch(), 0); } finally { await e.close(); }
      // A wrong key is the one plain failure.
      const other = await createKeyring({ passcode: PASS, scrypt: FAST });
      await assert.rejects(unlockWithPasscode(other.keyring, "not the right passcode!!").then((k) => verifyBackup(good.path, { unlock: k })), UnlockFailed);
    } finally { await a.close(); rmSync(root, { recursive: true, force: true }); }
  });
}

test("a value already in the store is kept when it differs (a rotated secret is not rolled back) and is taken only when the owner asks; names and values are checked (card K01b)", async () => {
  const sink = store({ "a.key": "new-rotated-value", "b.key": "same-value" });
  const got = await restoreSecrets([{ name: "a.key", value: "old-backup-value" }, { name: "b.key", value: "same-value" }, { name: "c.key", value: "fresh" }], sink);
  assert.deepEqual(got, { restored: 1, same: 1, keptDifferent: 1, overwritten: 0 });
  assert.equal(sink.values.get("a.key"), "new-rotated-value");
  const over = await restoreSecrets([{ name: "a.key", value: "old-backup-value" }], sink, { overwrite: true });
  assert.equal(over.overwritten, 1);
  assert.equal(sink.values.get("a.key"), "old-backup-value");
  // The source skips names that are not valid secret names (a name from a damaged list is never a path).
  const names = await secretsSourceOf(store({ "good.name": "v" }), () => ["good.name", "../escape", "bad__name", ""]).read();
  assert.deepEqual((names as unknown as { entries: { name: string }[] }).entries.map((e) => e.name), ["good.name"]);
});

test("command line: verify says the sealed part was not checked without a key; restore of a secrets-only backup needs nowhere for the values only when a key is given, writes them to a new mode-600 file, and never overwrites one (card K01b)", async () => {
  const [a] = await Promise.all([backends[0]!.open()]);
  const root = tmp(); const out = tmp();
  try {
    await populate(a.storage);
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: FAST });
    const { path } = await createBackup(a.storage, { root, kind: "manual", version: "t", now: () => new Date(AT), encryption: keyring, scope: "secrets", secrets: secretsSourceOf(store(), () => NAMES, [SIGNING_SECRET_NAME]) });
    const pf = join(out, "pass"); writeFileSync(pf, PASS, { mode: 0o600 });
    const lines: string[] = [];
    assert.equal(await runBackupCli(["verify", path], (l) => lines.push(l)), 0);
    assert.match(lines.join("\n"), /without the passcode or recovery file/);
    lines.length = 0;
    assert.equal(await runBackupCli(["verify", path, "--passcode-file", pf], (l) => lines.push(l)), 0);
    assert.doesNotMatch(lines.join("\n"), /were not checked/);
    // A key and no place for the values: refused before the database is made.
    lines.length = 0;
    assert.equal(await runBackupCli(["restore", path, "--passcode-file", pf, "--sqlite", join(out, "r0.sqlite")], (l) => lines.push(l)), 1);
    assert.match(lines.join("\n"), /nowhere was given to put them/);
    // With a place: the values go to a new file, mode 600; a second restore may not overwrite it.
    const sec = join(out, "secrets.json");
    lines.length = 0;
    assert.equal(await runBackupCli(["restore", path, "--passcode-file", pf, "--secrets-out", sec, "--sqlite", join(out, "r1.sqlite")], (l) => lines.push(l)), 0, lines.join("\n"));
    assert.deepEqual(JSON.parse(readFileSync(sec, "utf8")), VALUES);
    assert.doesNotMatch(lines.join("\n"), /sk-test-value|wa-test-value/);
    if (process.platform !== "win32") assert.equal(readFileSync(sec).length > 0 && (await import("node:fs")).statSync(sec).mode & 0o077, 0);
    lines.length = 0;
    assert.equal(await runBackupCli(["restore", path, "--passcode-file", pf, "--secrets-out", sec, "--sqlite", join(out, "r2.sqlite")], (l) => lines.push(l)), 1);
    assert.match(lines.join("\n"), /never overwritten/);
    // No key at all: the rest restores and the output says the values were left out.
    lines.length = 0;
    assert.equal(await runBackupCli(["restore", path, "--sqlite", join(out, "r3.sqlite")], (l) => lines.push(l)), 0, lines.join("\n"));
    assert.match(lines.join("\n"), /secret values were left out/);
  } finally { await a.close(); rmSync(root, { recursive: true, force: true }); rmSync(out, { recursive: true, force: true }); }
});
