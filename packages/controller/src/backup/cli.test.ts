import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FileBlobStore } from "../artifacts/index.js";
import { MemoryStorage } from "../storage/index.js";
import { createBackup } from "./index.js";
import { runBackupCli } from "./cli.js";

const AT = "2026-10-29T10:00:00.000Z";

test("the backup command line lists, verifies and restores a backup into a new database on a new machine, and refuses what it should (card K01f)", async () => {
  const root = mkdtempSync(join(tmpdir(), "nn-cli-")); const live = mkdtempSync(join(tmpdir(), "nn-cli-live-"));
  try {
    const store = new MemoryStorage();
    const { epoch } = await store.acquireEpoch({ holder: "c1", at: AT });
    await store.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "weed" } }], audit: [], outbox: [{ deliveryId: "dlv-1", destination: "inbox", priority: 5, aggregate: { kind: "task", id: "task-a" }, payload: {} }], effects: [{ effectId: "eff-1", target: "repo:main", inputDigest: "a".repeat(64) }], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
    const blobs = await FileBlobStore.open({ directory: live });
    await blobs.put(new TextEncoder().encode("the north bed plan"));
    const { path } = await createBackup(store, { root, kind: "manual", version: "t", now: () => new Date(AT), blobs });
    const out: string[] = [];
    const run = async (...argv: string[]): Promise<number> => { out.length = 0; return runBackupCli(argv, (l) => { out.push(l); }); };

    assert.equal(await run("list", root), 0);
    assert.match(out.join("\n"), /manual {2}schema 1/);
    assert.equal(await run("verify", path), 0);
    assert.match(out.join("\n"), /^ok: /);

    // A backup that was tampered with is not verified, and is not restored.
    const target = join(root, "restored.sqlite");
    assert.equal(await run("restore", path, "--sqlite", target, "--artifacts", join(root, "art")), 0, out.join("\n"));
    assert.match(out.join("\n"), /restored \d+ rows and 1 artifact files/);
    assert.match(out.join("\n"), /1 actions on the outside were only intended/);
    assert.match(out.join("\n"), /1 messages had not been delivered/);
    // Into the same, now used, database: refused plainly.
    assert.equal(await run("restore", path, "--sqlite", target, "--artifacts", join(root, "art2")), 1);
    assert.match(out.join("\n"), /not empty/);
    // Missing artifact folder for a backup that holds files: refused.
    assert.equal(await run("restore", path, "--sqlite", join(root, "second.sqlite")), 1);
    assert.match(out.join("\n"), /no artifact store was given/);
    // Arguments that are not understood print the usage and exit 2.
    assert.equal(await run("restore", path), 2);
    assert.equal(await run("restore", path, "--sqlite", "a", "--postgres", "b"), 2);
    assert.equal(await run("restore", path, "--bogus", "x"), 2);
    assert.equal(await run("frobnicate", path), 2);
    assert.equal(await run(), 2);
    // A damaged file is found by verify.
    const damaged = readdirSync(path).find((f) => f.endsWith(".jsonl"))!;
    writeFileSync(join(path, damaged), "{}\n");
    assert.equal(await run("verify", path), 1);
    assert.match(out.join("\n"), /problem: /);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(live, { recursive: true, force: true }); }
});
