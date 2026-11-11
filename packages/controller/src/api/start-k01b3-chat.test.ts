import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createKeyring } from "../backup/index.js";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
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
    const { keyring } = await createKeyring({ passcode: PASS, scrypt: { N: 2 ** 16, r: 8, p: 1 } });
    const keyringFile = join(d, "keyring.json");
    writeFileSync(keyringFile, JSON.stringify(keyring), { mode: 0o600 });
    let clock = Date.parse("2026-11-01T10:00:00.000Z");
    const dir = join(d, "backups");
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) }, backup: { directory: dir, now: () => new Date(clock), encryption: { keyringFile } } });
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
      await turn("Actually, protect my backups again.", "on");
      assert.equal((await turn("Go ahead.", "agree"))[0].status, "applied");
      assert.equal(await backupNow(), true, "sealed again with the same key");
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
