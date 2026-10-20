import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { ArtifactService, FileBlobStore } from "./index.js";

const child = fileURLToPath(new URL("./testing/child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../scripts/offline-guard.mjs", import.meta.url))).href;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const T = "2026-10-20T10:00:00.000Z";
const command = { commandId: "crash-publish", actor: "child", name: "crash test", files: [{ path: "one.txt", content: Buffer.from("first file") }, { path: "two.txt", content: Buffer.from("second file") }] };

function run(mode: string, directory: string): Promise<{ killed: boolean; out: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, mode, directory], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ killed: signal !== null || code !== 0, out }));
  });
}

async function afterCrash(mode: string, expectArtifact: boolean, expectBlobs: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "nn art-crash-"));
  try {
    // A database with an epoch, as a controller would have.
    const seed = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    await seed.acquireEpoch({ holder: "seed", at: T });
    await seed.close();
    const crashed = await run(mode, dir);
    assert.equal(crashed.killed, true, `the child should have been killed at ${mode}`);
    assert.equal(crashed.out.includes("published"), false);

    const storage = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    const blobs = await FileBlobStore.open({ directory: join(dir, "blobs") });
    const artifacts = ArtifactService.withEpoch(storage, await storage.currentEpoch(), blobs, { clock: () => T });
    try {
      // What survived the kill.
      assert.deepEqual((await blobs.list()).map((b) => b.digest).sort(), expectBlobs.map(sha).sort(), `blobs after ${mode}`);
      const accepted = await artifacts.list({ limit: 10 });
      assert.equal(accepted.length, expectArtifact ? 1 : 0, `artifacts after ${mode}`);
      // Whatever is accepted verifies completely: there is never a record whose bytes are missing.
      for (const a of accepted) assert.ok((await artifacts.verify(a.id)).ok, "an accepted artifact must be complete");

      // Cleanup is safe in every case: it removes what nothing refers to and nothing a record needs.
      const swept = await artifacts.collectOrphans({ olderThanMs: 0, now: Date.now() + 1000 });
      for (const a of accepted) assert.ok((await artifacts.verify(a.id)).ok, "cleanup did not damage an accepted artifact");
      assert.equal(swept.orphans.length, expectArtifact ? 0 : expectBlobs.length);
      assert.deepEqual(readdirSync(join(dir, "blobs", "tmp")), [], "no stray temporary file survives cleanup");

      // Sending the same command again finishes the job exactly once, whatever happened before.
      const result = await artifacts.publish(command);
      assert.equal(result.replayed, expectArtifact);
      assert.ok((await artifacts.verify(result.id)).ok);
      assert.equal((await artifacts.list({ limit: 10 })).length, 1);
      assert.equal(Buffer.from(await artifacts.readFile(result.id, "two.txt")).toString(), "second file");
      assert.equal((await storage.listAudit({ afterSeq: 0, limit: 10 })).filter((r) => r.type === "artifact.publish").length, 1, "the manifest was recorded once");
    } finally {
      await storage.close();
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

test("killed with a blob written but not yet named: no blob is visible, no artifact, and the retry completes", () => afterCrash("after-temp-write", false, []));
test("killed after the first blob is named: that blob is an orphan, there is no artifact, cleanup reclaims it and the retry completes", () => afterCrash("after-first-rename", false, ["first file"]));
test("killed after every blob is stored and before the manifest: all blobs are orphans, no artifact is accepted, and the retry completes", () => afterCrash("before-manifest", false, ["first file", "second file"]));
test("killed after the manifest committed: the artifact is complete and verifies, cleanup keeps its blobs, and the retry returns the recorded result", () => afterCrash("after-manifest", true, ["first file", "second file"]));
