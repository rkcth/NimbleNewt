// The fast tier's list of left-out files must name real test files, so a rename cannot silently put a slow file back (or leave a dead entry).
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const list = JSON.parse(readFileSync(join(root, "scripts", "slow-tests.json"), "utf8")).files;

test("every file the fast tier leaves out exists as a test source", () => {
  assert.ok(list.length > 0);
  for (const name of list) {
    assert.ok(name.endsWith(".test.js"), `${name} is not a compiled test file name`);
    const source = name.replace(/\.js$/, ".ts");
    const found = ["controller", "pi-adapter", "config", "registry", "contracts", "integration"].some((p) => existsSync(join(root, "packages", p, "src", source)));
    assert.ok(found, `${name} has no source test file; fix scripts/slow-tests.json`);
  }
});
