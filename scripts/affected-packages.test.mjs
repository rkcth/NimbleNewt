import assert from "node:assert/strict";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { affected, packageGraph } from "./affected-packages.mjs";
import { shardFiles } from "./shard.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const graph = new Map([["contracts", []], ["registry", []], ["controller", ["registry"]], ["worker", ["contracts"]], ["pi-adapter", ["contracts", "registry"]], ["integration", ["contracts", "controller", "pi-adapter", "worker"]], ["ui", []]]);

test("a change selects its package and every package that depends on it, directly or not", () => {
  assert.deepEqual(affected(["packages/ui/src/a.ts"], graph), ["ui"]);
  assert.deepEqual(affected(["packages/registry/src/a.ts"], graph), ["registry", "controller", "pi-adapter", "integration"]);
  assert.deepEqual(affected(["packages/worker/src/x.ts", "packages/ui/src/a.ts"], graph), ["worker", "integration", "ui"].sort((a, b) => [...graph.keys()].indexOf(a) - [...graph.keys()].indexOf(b)));
  assert.deepEqual(affected(["packages/integration/src/t.test.ts"], graph), ["integration"]);
});

test("a change outside the packages selects everything, documentation alone selects nothing", () => {
  for (const f of ["package.json", "package-lock.json", "tsconfig.base.json", "scripts/run-package-tests.mjs", ".github/workflows/ci.yml", "packages/unknown/src/a.ts"]) assert.equal(affected([f], graph), "all", f);
  assert.deepEqual(affected(["docs/nimblenewt/x.md", "README.md"], graph), []);
  assert.deepEqual(affected(["docs/nimblenewt/implementation-plan/task-plan.md"], graph), ["pi-adapter", "integration"], "pi-adapter's tests read the plan");
  assert.equal(affected(["docs/a.md", "package.json"], graph), "all");
  assert.equal(affected(["packages\\ui\\src\\a.ts"], graph).join(), "ui", "Windows separators");
});

test("the graph read from the repository has the product packages and no cycle", () => {
  const real = packageGraph(root);
  for (const name of ["contracts", "controller", "worker", "pi-adapter", "integration"]) assert.ok(real.has(name), name);
  assert.ok(real.get("integration").includes("controller"));
  assert.deepEqual(affected(["packages/contracts/src/a.ts"], real).includes("integration"), true);
});

test("shards partition the files, balanced by weight, the same way every time", () => {
  const files = ["dist/a.test.js", "dist/b/c.test.js", "dist/d.test.js", "dist/e.test.js", "dist/f.test.js"];
  const weights = { "a.test.js": 100, "b/c.test.js": 60, "d.test.js": 50, "e.test.js": 40 };
  const parts = [1, 2, 3].map((i) => shardFiles(files, weights, i, 3));
  assert.deepEqual(parts.flat().sort(), [...files].sort(), "every file once");
  assert.deepEqual(parts, [1, 2, 3].map((i) => shardFiles(files, weights, i, 3)), "deterministic");
  assert.deepEqual(parts[0], ["dist/a.test.js"], "the heaviest file has a shard to itself");
  assert.throws(() => shardFiles(files, weights, 4, 3), /invalid shard/);
});

test("the shards together run what npm test runs: shard 1 carries the root checks and every package, each shard a slice of the controller", async () => {
  const { shardSteps } = await import("./test-shard.mjs");
  const packages = [...packageGraph(root).keys()];
  const names = (steps) => steps.map((s) => (s.node === undefined ? s.join(" ") : `node ${s.node.join(" ")}`));
  const one = names(shardSteps(1, 3, packages));
  for (const must of ["run clean", "run build", "run check:deps", "run licenses:check", "run roadmap:check", "node --test scripts/*.test.mjs"]) assert.ok(one.includes(must), must);
  for (const p of packages.filter((n) => n !== "controller")) assert.ok(one.includes(`run test -w @nimblenewt/${p} --if-present`), p);
  assert.ok(one.includes("run test -w @nimblenewt/controller -- --shard=1/3"));
  for (const i of [2, 3]) assert.deepEqual(names(shardSteps(i, 3, packages)), ["run clean", "run build", `run test -w @nimblenewt/controller -- --shard=${i}/3`]);
  const rootScript = JSON.parse((await import("node:fs")).readFileSync(join(root, "package.json"), "utf8")).scripts.test;
  for (const part of ["clean", "build", "check:deps", "licenses:check", "roadmap:check", "scripts/*.test.mjs", "--workspaces"]) assert.ok(rootScript.includes(part), `npm test no longer runs ${part}; update scripts/test-shard.mjs`);
});
