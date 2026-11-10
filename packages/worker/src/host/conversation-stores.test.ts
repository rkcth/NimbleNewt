import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalConversationStores } from "./conversation-stores.js";

// Card K01i: the local host's conversation stores, as the controller's backup lists them and a restore puts them back.

test("the stores are the pi folders of the homes made from the root; other entries, bad names and links are left out; a restore goes back to the same place", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "nn-homes-"));
  try {
    const stores = new LocalConversationStores({ root });
    assert.deepEqual(await new LocalConversationStores({ root: join(root, "missing") }).source.list(), [], "no homes yet: nothing to back up");
    for (const key of ["task-b", "task-a"]) { mkdirSync(join(stores.home(key), "pi"), { recursive: true }); writeFileSync(join(stores.home(key), "pi", "log.jsonl"), "{}\n"); }
    mkdirSync(stores.home("no-conversation"));
    writeFileSync(join(root, "a-file"), "x");
    mkdirSync(join(root, ".hidden", "pi"), { recursive: true });
    mkdirSync(join(root, "pi-is-a-file")); writeFileSync(join(root, "pi-is-a-file", "pi"), "x");
    const elsewhere = mkdtempSync(join(tmpdir(), "nn-homes-out-"));
    t.after(() => rmSync(elsewhere, { recursive: true, force: true }));
    mkdirSync(join(elsewhere, "pi"));
    if (process.platform !== "win32") {
      symlinkSync(elsewhere, join(root, "linked-home"));
      mkdirSync(join(root, "linked-pi")); symlinkSync(join(elsewhere, "pi"), join(root, "linked-pi", "pi"));
    }
    assert.deepEqual(await stores.source.list(), [{ id: "task-a", dir: join(root, "task-a", "pi") }, { id: "task-b", dir: join(root, "task-b", "pi") }]);
    assert.equal(stores.final("task-a"), join(root, "task-a", "pi"));
    assert.equal(stores.final("not-made-yet"), join(root, "not-made-yet", "pi"), "a home not made yet is restored to (the restore makes it)");
    assert.equal(stores.final("no-conversation"), join(root, "no-conversation", "pi"));
    // Review of K01i: a restore never follows a link an agent could have put in its home (it would move what the link names aside and write there).
    if (process.platform !== "win32") {
      assert.equal(stores.final("linked-home"), undefined, "a home that is a link is not restored to");
      assert.equal(stores.final("linked-pi"), undefined, "a pi folder that is a link is not restored to");
    }
    assert.equal(stores.final("pi-is-a-file"), undefined, "a pi that is a file is not restored over");
    assert.equal(stores.final("../x"), undefined);
    assert.equal(stores.final(".."), undefined);
    assert.throws(() => stores.home("../escape"), /home key/);
    assert.throws(() => stores.home("a/b"), /home key/);
    assert.throws(() => new LocalConversationStores({ root: "relative" }), /absolute/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
