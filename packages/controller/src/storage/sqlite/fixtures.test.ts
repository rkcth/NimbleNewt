import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { FIXTURE_DIRECTORY } from "../qualification/fixtures.js";
import { registry } from "../qualification/migration-registry.js";
import { snapshotWorld } from "../qualification/boundaries.js";
import { LATEST_VERSION, SqliteStorage } from "./index.js";

const expected = JSON.parse(readFileSync(join(FIXTURE_DIRECTORY, "layout-1.snapshot.json"), "utf8")) as unknown;

test("the committed layout-1 database opens with this build, reports exactly its recorded state, and upgrades without losing any of it", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn sqlite-fixture-"));
  try {
    const path = join(dir, "controller.sqlite");
    copyFileSync(join(FIXTURE_DIRECTORY, "layout-1.sqlite"), path);
    // This build's own migrations: the journal in the fixture records migration 1's checksum, so editing migration 1 fails here.
    const current = await SqliteStorage.open({ path });
    assert.equal(current.settings().schemaVersion, LATEST_VERSION);
    assert.deepEqual(await snapshotWorld(current), expected);
    await current.close();
    // Later layouts (synthetic here: the real ones do not exist yet) must carry it forward intact.
    const upgraded = await SqliteStorage.open({ path, migrations: registry("sqlite", "v123") });
    assert.equal(upgraded.settings().schemaVersion, 3);
    assert.deepEqual(await snapshotWorld(upgraded), expected);
    await upgraded.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
