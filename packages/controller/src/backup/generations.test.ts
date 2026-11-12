import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../storage/index.js";
import { createBackup, generationReport, parseKeyring } from "./index.js";
import { runBackupCli } from "./cli.js";

const PASS = "correct horse battery staple";
const PASS2 = "a different long passcode 2";

test("old key generations are listed with how many backups use each, and removed only when none does and every backup folder could be read; the default key uses Argon2id (card K01b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-gen-"));
  try {
    const out: string[] = []; const say = (l: string): void => { out.push(l); };
    const w = (name: string, text: string): string => { const p = join(d, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
    const ring = join(d, "keyring.json");
    assert.equal(await runBackupCli(["encryption-setup", ring, "--passcode-file", w("p1", PASS), "--recovery-out", join(d, "rec1.json")], say), 0, out.join("\n"));
    assert.match(out.join("\n"), /secrets only.*lost.*everything.*cannot be read at all/s, "setup says plainly what losing every unlock method costs");
    const gen1 = parseKeyring(JSON.parse(readFileSync(ring, "utf8")));
    assert.equal((gen1.wrappers.find((x) => x.kind === "passcode") as { kdf: { name: string } }).kdf.name, "argon2id");
    const backups = join(d, "backups"); mkdirSync(backups);
    const s = new MemoryStorage(); await s.acquireEpoch({ holder: "c", at: "2026-11-01T00:00:00.000Z" });
    const old = await createBackup(s, { root: backups, kind: "manual", version: "t", now: () => new Date("2026-11-01T01:00:00.000Z"), encryption: gen1 });
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-rotate", ring, "--passcode-file", w("p1b", PASS), "--new-passcode-file", w("p2", PASS2), "--recovery-out", join(d, "rec2.json")], say), 0, out.join("\n"));
    const gen2 = parseKeyring(JSON.parse(readFileSync(ring, "utf8")));
    assert.equal(gen2.generation, 2);
    await createBackup(s, { root: backups, kind: "manual", version: "t", now: () => new Date("2026-11-02T01:00:00.000Z"), encryption: gen2 });
    const report = await generationReport(ring, backups);
    assert.deepEqual(report.generations.map((g) => [g.generation, g.keyId === gen1.keyId, g.backups, g.removable]), [[1, true, 1, false]]);
    // Still used: nothing is removed, and it says why.
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-generations", ring, "--backups", backups, "--remove", "yes"], say), 0);
    assert.match(out.join("\n"), /kept: 1 backup still use/);
    assert.ok(existsSync(`${ring}.generation-1`));
    // An unreadable backup folder blocks removal even when no readable backup uses the key.
    rmSync(old.path, { recursive: true });
    mkdirSync(join(backups, "backup-20261103T000000Z-manual")); // no manifest
    out.length = 0;
    await runBackupCli(["encryption-generations", ring, "--backups", backups, "--remove", "yes"], say);
    assert.ok(existsSync(`${ring}.generation-1`), "a guess is never enough to delete key material");
    assert.match(out.join("\n"), /could not be read/);
    rmSync(join(backups, "backup-20261103T000000Z-manual"), { recursive: true });
    // Last backup under generation 1 is gone: the archive goes, the live keyring stays, and the owner is told the old recovery file opens nothing.
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-generations", ring, "--backups", backups], say), 0);
    assert.match(out.join("\n"), /can be removed/);
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-generations", ring, "--backups", backups, "--remove", "yes"], say), 0);
    assert.match(out.join("\n"), /no backup left in this backups folder.*open only backups made under that key.*copy of such a backup anywhere else/s, "the owner is not told the old recovery file opens nothing: copies elsewhere still need it");
    assert.equal(existsSync(`${ring}.generation-1`), false);
    assert.equal(existsSync(ring), true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("K01b review: a mistyped, missing or never-encrypted backups folder makes no key archive removable (an empty folder would make every archive look unused)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-gen2-"));
  try {
    const out: string[] = []; const say = (l: string): void => { out.push(l); };
    const w = (name: string, text: string): string => { const p = join(d, name); writeFileSync(p, text, { mode: 0o600 }); return p; };
    const ring = join(d, "keyring.json");
    const pass = ["review", "passcode", "built", "at", "run", "time"].join(" ");
    assert.equal(await runBackupCli(["encryption-setup", ring, "--passcode-file", w("p1", pass), "--recovery-out", join(d, "rec1.json")], say), 0, out.join("\n"));
    assert.equal(await runBackupCli(["encryption-rotate", ring, "--passcode-file", w("p1b", pass), "--new-passcode-file", w("p2", `${pass} two`), "--recovery-out", join(d, "rec2.json")], say), 0, out.join("\n"));
    assert.ok(existsSync(`${ring}.generation-1`));
    // The folder does not exist (a typo).
    const missing = await generationReport(ring, join(d, "backupz"));
    assert.deepEqual(missing.generations.map((g) => g.removable), [false]);
    assert.match(missing.folderUnconfirmed ?? "", /cannot be listed/);
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-generations", ring, "--backups", join(d, "backupz"), "--remove", "yes"], say), 0);
    assert.ok(existsSync(`${ring}.generation-1`), "nothing removed on a folder that cannot be listed");
    assert.match(out.join("\n"), /kept.*cannot be listed/);
    // An empty folder that never held an encrypted backup (the wrong folder).
    const empty = join(d, "empty"); mkdirSync(empty);
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-generations", ring, "--backups", empty, "--remove", "yes"], say), 0);
    assert.ok(existsSync(`${ring}.generation-1`), "nothing removed on a folder with no encryption marker");
    assert.match(out.join("\n"), /never held an encrypted backup/);
    out.length = 0;
    assert.equal(await runBackupCli(["encryption-generations", ring, "--backups", empty], say), 0);
    assert.doesNotMatch(out.join("\n"), /can be removed/);
    // The real folder (it has held an encrypted backup) with no backup under generation 1: removable.
    const real = join(d, "backups"); mkdirSync(real);
    const s = new MemoryStorage(); await s.acquireEpoch({ holder: "c", at: "2026-11-01T00:00:00.000Z" });
    await createBackup(s, { root: real, kind: "manual", version: "t", now: () => new Date("2026-11-02T01:00:00.000Z"), encryption: parseKeyring(JSON.parse(readFileSync(ring, "utf8"))) });
    assert.deepEqual((await generationReport(ring, real)).generations.map((g) => g.removable), [true]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});
