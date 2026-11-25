import assert from "node:assert/strict";
import { spawn } from "node:child_process";
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

test("a step that prints nothing for too long is reported with the step name and the test files still running, ended, and fails (not a silent job cancel)", async () => {
  const { runStep, runningTestProcesses } = await import("./test-shard.mjs");
  const sink = () => { const chunks = []; return { write: (d) => { chunks.push(String(d)); return true; }, text: () => chunks.join("") }; };
  // a step that ends by itself keeps its status and its output is passed on
  let out = sink(); let err = sink();
  assert.equal(await runStep(process.execPath, ["-e", "console.log('hello'); process.exit(3)"], { quietMs: 20_000, out, err }), 3);
  assert.match(out.text(), /hello/);
  assert.equal(err.text(), "");
  // a step that keeps printing is not stuck even when it runs longer than the quiet limit
  out = sink(); err = sink();
  assert.equal(await runStep(process.execPath, ["-e", "let n=0;const t=setInterval(()=>{console.log('tick');if(++n===6){clearInterval(t)}},600)"], { quietMs: 2500, out, err }), 0);
  assert.equal(err.text(), "");
  // a step that prints once and then never ends is reported, listed, killed
  out = sink(); err = sink();
  const killed = [];
  const t = Date.now();
  const status = await runStep(process.execPath, ["-e", "console.log('first file done'); setInterval(()=>{},1000)"], { quietMs: 700, label: "node --test scripts/*.test.mjs", out, err, list: (pid) => (pid > 0 ? ["4242 node --test windows-appcontainer-experiment.test.mjs"] : []), kill: (pid) => { killed.push(pid); if (pid !== 4242) process.kill(pid, "SIGKILL"); } });
  assert.equal(status, 124);
  assert.ok(Date.now() - t < 15_000);
  assert.match(err.text(), /STUCK: step "node --test scripts\/\*\.test\.mjs" printed nothing for 1 s/);
  assert.match(err.text(), /4242 node --test windows-appcontainer-experiment\.test\.mjs/);
  assert.ok(killed.includes(4242), "the listed test process is ended too");
  // the listing finds a test file's process by its name and does not list itself
  const ps = "  1     0 init\n 10     1 node scripts/test-shard.mjs 1/3\n 11    10 node --test scripts/a.test.mjs\n 12    11 ps -axo pid=,ppid=,args=\n 13    10 node b.test.mjs\n 99     1 node --test other-run.test.mjs\n";
  assert.deepEqual(runningTestProcesses(10, "linux", () => ({ stdout: ps })), ["11 node --test scripts/a.test.mjs", "13 node b.test.mjs"]);
  // the real listing (ps on Linux and macOS) finds a test file started below the given process
  if (process.platform !== "win32") {
    const holder = spawn(process.execPath, ["-e", "require('node:child_process').spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', 'x.test.mjs'], { stdio: 'ignore' }); setInterval(()=>{},1000)"], { stdio: "ignore" });
    try {
      let found = [];
      for (let i = 0; i < 100 && found.length === 0; i++) { await new Promise((r) => setTimeout(r, 100)); found = runningTestProcesses(holder.pid); }
      assert.equal(found.length, 1);
      assert.match(found[0], /x\.test\.mjs/);
      process.kill(Number(found[0].split(" ")[0]), "SIGKILL");
    } finally { holder.kill("SIGKILL"); }
  }
});
