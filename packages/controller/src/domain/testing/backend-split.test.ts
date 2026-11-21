import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { backendNames } from "./backends.js";

// A suite divided among test files by backend (one `define...Tests("<backend>")` file per backend, through backendsNamed) runs a backend nowhere if two
// files name the same one, and nothing else would fail. Every such suite must have exactly one file per backend, each file exactly one call.
test("each suite divided by backend has exactly one test file per backend", () => {
  const src = fileURLToPath(new URL("../../../src/", import.meta.url));
  const files = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".test.ts") ? [join(dir, e.name)] : []));
  const suites = new Map<string, string[]>();
  for (const file of files(src)) {
    const text = readFileSync(file, "utf8");
    // (written with a class for the quote, so that the package-boundary scan does not read this pattern as an import)
    const suite = /from\s["']\.\/([a-z0-9-]+-suite)\.js["']/.exec(text)?.[1];
    if (suite === undefined) continue;
    const calls = [...text.matchAll(/\bdefine[A-Za-z]+Tests\(\s*"([^"]+)"\s*\)/g)];
    if (calls.length === 0) continue; // a suite called with more arguments (slice: backend and a share of the points) is divided another way
    assert.equal(calls.length, 1, `${file}: one backend per file`);
    const key = `${file.slice(src.length).split(/[\\/]/).slice(0, -1).join("/")}/${suite}`;
    suites.set(key, [...(suites.get(key) ?? []), calls[0]![1]!]);
  }
  assert.ok(suites.has("remote/quiet-hosts-suite") && suites.has("dispatch/dispatcher-suite"), `the divided suites were found (${[...suites.keys()].join(", ")})`);
  for (const [suite, names] of suites) assert.deepEqual([...names].sort(), [...backendNames].sort(), `${suite}: one file for each backend`);
});
