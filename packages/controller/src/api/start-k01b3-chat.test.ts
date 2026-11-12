import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyring } from "../backup/index.js";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SNAPSHOT_TABLES } from "../storage/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const PASS = "correct horse battery staple";

test("the owner switches backup encryption off and on by free wording through the chat interpreter: it is shown first, applies only on agreement, and the next backups follow it (card K01b3)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k3chat-"));
  // The stand-in for the model knows only what the prompts tell it: it acts only if the system prompt describes the operation and its arguments the way the chat accepts them, so removing the paragraph or renaming an
  // argument fails this test. Which way the owner meant is the test's own table, standing in for the model's reading of free wording.
  const meaning: Record<string, "off" | "on" | "agree" | "rotate"> = {};
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const meant = meaning[owner];
    if (meant === "agree") {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/g)];
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
    }
    const described = /backup\.encryption\.set\(([^)]*)\) - /.exec(r.system);
    if (described === null || !/use backup\.encryption\.set with enabled \(true or false\)/.test(r.system) || meant === undefined) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    const names = described[1]!.split(", ");
    if (!names.includes("enabled")) return JSON.stringify([{ kind: "none", reason: "no enabled argument" }]);
    return JSON.stringify([{ kind: "command", op: "backup.encryption.set", args: { enabled: meant === "on" }, evidence: owner, basis: "owner" }]);
  } };
  try {
    const { keyring, recoveryFile } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json"); const recoveryPath = join(d, "recovery.json");
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 }); writeFileSync(recoveryPath, JSON.stringify(recoveryFile), { mode: 0o600 });
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const dir = join(d, "backups");
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) }, backup: { directory: dir, now: () => new Date(clock), encryption: { keyringFile, recoveryFile: recoveryPath } } });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      let m = 0;
      const turn = async (text: string, meant: "off" | "on" | "agree") => { meaning[text] = meant; return (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as any[]; };
      const backupNow = async () => { clock += 86_400_000; const r = (await c.api.handle(boot.token, { v: 1, op: "backup.now", commandId: `b${m++}`, args: {} } as never)) as { ok: boolean }; assert.ok(r.ok); const name = readdirSync(dir).filter((n) => n.startsWith("backup-")).sort().at(-1)!; return JSON.parse(readFileSync(join(dir, name, "manifest.json"), "utf8")).encryption !== undefined; };
      assert.equal(await backupNow(), true);
      const shown = await turn("I do not want my backups scrambled any more, write them as ordinary files from now on.", "off");
      assert.equal(shown.length, 1, JSON.stringify(shown));
      assert.equal(shown[0].status, "proposed", `shown first, whatever the profile: ${JSON.stringify(shown)}`);
      assert.equal(await backupNow(), true, "nothing changed before the owner agreed");
      const done = await turn("Yes, do that.", "agree");
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      assert.equal(await backupNow(), false, "the next backup is plain");
      // Turning it back on first needs the recovery file proved, as at setup (card K01b; the refusal itself is tested through the API).
      const proof = (await c.api.handle(boot.token, { v: 1, op: "backup.encryption.verify", commandId: `v${m++}`, args: { method: "recovery" } } as never)) as { ok: boolean };
      assert.ok(proof.ok, JSON.stringify(proof));
      await turn("Actually, protect my backups again.", "on");
      assert.equal((await turn("Go ahead.", "agree"))[0].status, "applied");
      assert.equal(await backupNow(), true, "sealed again with the same key");
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("review: a value the model puts in backup.encryption.set that is not a switch or a scope (a passcode, say) is refused before any proposal holds it (card K01b3)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k3chat2-"));
  const model = { complete: async (): Promise<string> => JSON.stringify([{ kind: "command", op: "backup.encryption.set", args: { scope: PASS }, evidence: `My backup passcode is ${PASS}`, basis: "owner" }]) };
  try {
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json");
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) }, backup: { directory: join(d, "backups"), encryption: { keyringFile } } });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      // A value that is not in the owner's words is refused by the chat's general check ...
      const foreign = (await c.chat!.submit(boot.token, { messageId: "m0", text: "Please stop encrypting my backups." })).outcomes as any[];
      assert.notEqual(foreign[0]?.status, "proposed", JSON.stringify(foreign));
      // ... and one the owner did type (a passcode said in passing) is refused because it is no switch or scope: no proposal shows or keeps it.
      const out = (await c.chat!.submit(boot.token, { messageId: "m1", text: `My backup passcode is ${PASS} and I want to stop encrypting the backups.` })).outcomes as any[];
      assert.equal(out.length, 1);
      assert.deepEqual([out[0].status, out[0].code], ["refused", "invalid_command"], JSON.stringify(out));
      assert.ok(!JSON.stringify(out).includes(PASS));
      // No record other than the owner's own message holds it.
      const snapshot = await c.storage.snapshot();
      try { for (const t of SNAPSHOT_TABLES) { const page = (await snapshot.read(t, { limit: 1000 })).filter((row) => !(t === "aggregates" && String(row["kind"]).startsWith("chat-turn"))); assert.ok(!JSON.stringify(page).includes(PASS), `${t}: ${JSON.stringify(page).split(PASS)[0]!.slice(-300)}`); } } finally { await snapshot.close(); }
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
