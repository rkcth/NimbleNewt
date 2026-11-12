import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SIGNING_SECRET_NAME, createKeyring } from "../backup/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PASS = "correct horse battery staple";
const VALUE = "sk-test-value-CCCC-3333-not-real";

test("a started controller carries secret values only in encrypted backups, follows the owner's scope and on/off setting, and asks for a recovery proof before encryption is switched back on (card K01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-bks-"));
  try {
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json"); const rf = join(d, "recovery");
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 }); writeFileSync(rf, JSON.stringify(recoveryFile), { mode: 0o600 });
    const values = new Map([["models.providers.openai.credential", VALUE], [SIGNING_SECRET_NAME, "SIGNING-KEY-NEVER-CARRIED"]]);
    const store = { resolve: async (n: string) => values.get(n), set: async (n: string, v: string) => { values.set(n, v); } };
    let clock = Date.parse("2026-11-12T10:00:00.000Z");
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 },
      backup: { directory: join(d, "backups"), now: () => new Date(clock), encryption: { keyringFile, recoveryFile: rf }, secrets: { store, names: () => ["models.providers.openai.credential", SIGNING_SECRET_NAME] } } });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      const backup = async (id: string) => { clock += 60_000; const r = await call("backup.now", {}, id); assert.ok(r.ok, JSON.stringify(r)); const name = readdirSync(join(d, "backups")).filter((n) => n.startsWith("backup-")).sort().at(-1)!; const dir = join(d, "backups", name); return { dir, manifest: JSON.parse(readFileSync(join(dir, "manifest.json"), "utf8")), files: readdirSync(dir) }; };
      const hasValue = (dir: string, files: string[]) => files.some((f) => readFileSync(join(dir, f)).includes(VALUE) || readFileSync(join(dir, f)).includes("SIGNING-KEY-NEVER-CARRIED"));

      const all = await backup("b1");
      assert.equal(all.manifest.encryption.scope, "everything");
      assert.equal(all.manifest.secrets.count, 1, "the credential is carried, the signing key is not");
      assert.equal(hasValue(all.dir, all.files), false);

      const set1 = await call("backup.encryption.set", { scope: "secrets" }, "s1");
      assert.ok(set1.ok, JSON.stringify(set1));
      assert.match(set1.result.text, /secret values in a new backup are sealed.*rest of the backup stays plain/);
      const only = await backup("b2");
      assert.equal(only.manifest.encryption.scope, "secrets");
      assert.ok(only.files.includes("state.jsonl") && only.files.includes("secrets.jsonl.enc"), "tables plain, secrets sealed");
      assert.equal(hasValue(only.dir, only.files), false);

      assert.ok((await call("backup.encryption.set", { enabled: false }, "s2")).ok);
      const plain = await backup("b3");
      assert.equal(plain.manifest.encryption, undefined);
      assert.equal(plain.manifest.secrets, undefined, "encryption off: references only, no value in the backup");
      assert.equal(hasValue(plain.dir, plain.files), false);

      // Switching back on needs the recovery file proved first, as at setup.
      const refused = await call("backup.encryption.set", { enabled: true }, "s3");
      assert.equal(refused.ok, false);
      assert.match(JSON.stringify(refused), /recovery file still opens the backup key/);
      assert.ok((await call("backup.encryption.verify", { method: "recovery" }, "v1")).ok);
      assert.ok((await call("backup.encryption.set", { enabled: true }, "s4")).ok);
      assert.equal((await backup("b4")).manifest.encryption.scope, "secrets");
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true }); }
});
