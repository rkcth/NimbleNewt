import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createTargetVersions } from "@nimblenewt/controller";
import { ABSENT, WorkspaceBridge } from "@nimblenewt/worker";

/**
 * The controller reads a workspace file's version with its own code (the controller package may not import the worker's); the workspace bridge (card A04) takes the same token as its expected version.
 * This test keeps the two in step: a token read by the controller is exactly the bridge's `read` version, and a write that names it is accepted while a stale one is kept for review.
 */
test("card A05b follow-up: the controller's file version is the workspace bridge's own version token, and the bridge's expected-version write accepts it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-a05b-"));
  const shared = join(dir, "shared");
  mkdirSync(join(shared, "src"), { recursive: true });
  try {
    const bridge = new WorkspaceBridge({ shared, state: join(dir, "state") });
    const read = createTargetVersions({ storage: { getAggregate: async () => undefined }, location: async () => ({ root: shared, paths: [] }) });
    const version = (path: string) => read({ kind: "file", id: path }, "tsk-aaaaaaaaaaaaaaaaaaaa");
    // Missing: the same word.
    assert.equal(await version("src/a.txt"), ABSENT);
    assert.equal((await bridge.read("src/a.txt")).version, ABSENT);
    // Created through the bridge at `absent` (the token the controller read), then the same digest both ways.
    const created = await bridge.write({ path: "src/a.txt", expectedVersion: (await version("src/a.txt"))!, content: Buffer.from("one"), author: "agent:ann", reason: "create" });
    assert.equal(created.status, "written");
    assert.equal(await version("src/a.txt"), (await bridge.read("src/a.txt")).version);
    // A write naming the controller's reading succeeds when the file is as read ...
    const token = (await version("src/a.txt"))!;
    const second = await bridge.write({ path: "src/a.txt", expectedVersion: token, content: Buffer.from("two"), author: "agent:ann", reason: "edit" });
    assert.equal(second.status, "written");
    assert.equal(await version("src/a.txt"), (second as { version: string }).version);
    // ... and a file that moved after the reading is kept for review, whole, not overwritten.
    writeFileSync(join(shared, "src", "a.txt"), "someone else");
    const stale = await bridge.write({ path: "src/a.txt", expectedVersion: token, content: Buffer.from("three"), author: "agent:ann", reason: "stale" });
    assert.equal(stale.status, "rejected");
    assert.equal((await bridge.read("src/a.txt")).content?.toString(), "someone else");
    // An empty file: the same token both ways too.
    writeFileSync(join(shared, "src", "empty"), "");
    assert.equal(await version("src/empty"), (await bridge.read("src/empty")).version);
    assert.equal(await version("src/empty"), "sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    // The paths the bridge refuses are refused by the controller's reading too.
    for (const bad of [".git/config", "../x", "src/../../x"]) {
      await assert.rejects(version(bad));
      await assert.rejects(bridge.read(bad));
    }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
