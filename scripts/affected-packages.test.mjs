import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync, readFileSync } from "node:fs";
import { affected, packageGraph, ROOT_ONLY } from "./affected-packages.mjs";
import { shardFiles } from "./shard.mjs";
import { tierSteps } from "./test-changed.mjs";

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

test("files only the root checks look at select no package; the ones a package's tests run or read still select every package", () => {
  for (const f of ["scripts/windows-appcontainer-experiment.test.mjs", "scripts/affected-packages.test.mjs", "scripts/test-shard.mjs", "scripts/ci-annotate.mjs", "scripts/y02-checkpoint.mjs", "scripts/wsb-list-line.mjs", "CONTRIBUTING.md", "SECURITY.md", ".github/workflows/exhaustive.yml", ".github/workflows/windows-appcontainer-experiment.yml"]) assert.deepEqual(affected([f], graph), [], f);
  // what run-package-tests.mjs, the offline guard, the stores' hosts and the launcher scripts use, and the weights that decide the shards, stay "everything"
  for (const f of ["scripts/run-package-tests.mjs", "scripts/test-changed.mjs", "scripts/affected-packages.mjs", "scripts/offline-guard.mjs", "scripts/shard.mjs", "scripts/slow-tests.json", "scripts/test-weights.json", "scripts/clean-dist.mjs", "scripts/safe-error.mjs", "scripts/local-host.mjs", "scripts/nimblenewt.mjs", "scripts/new-helper.mjs", "scripts/fixtures/x.json", "experiments/experiments.js", ".github/workflows/ci.yml", "prototypes/meeting/a.mjs"]) assert.equal(affected([f], graph), "all", f);
  // the experiment's own folder is read by the worker's contract test
  assert.deepEqual(affected(["experiments/windows-appcontainer/ladder.mjs"], graph), ["worker", "integration"]);
  assert.deepEqual(affected(["native/nn-launcher/src/win.rs"], graph), ["worker", "integration"], "the worker's contract test reads the launcher crate");
  assert.equal(affected([".github/workflows/own-hardware.yml"], graph), "all");
  assert.deepEqual(affected(["scripts/test-shard.mjs", "packages/ui/src/a.ts"], graph), ["ui"], "a root-only file adds nothing to the packages that were touched");
  assert.equal(affected(["scripts\\test-shard.mjs"], graph).length, 0, "Windows separators");
});

test("the root-only list is honest: no package source and no other script runs, reads or imports a file on it", () => {
  const files = (dir, keep) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? (e.name === "node_modules" || e.name === "dist" ? [] : files(join(dir, e.name), keep)) : keep(e.name) ? [join(dir, e.name)] : []));
  const listed = [...files(join(root, "scripts"), () => true), ...files(join(root, ".github", "workflows"), () => true)].map((f) => f.slice(root.length).replaceAll("\\", "/").replace(/^\//, "")).filter((f) => ROOT_ONLY.some((p) => p.test(f)));
  assert.ok(listed.some((f) => f.startsWith(".github/workflows/")), "the workflow files are covered by the same check");
  assert.ok(listed.length > 25, `the list should match real files (${listed.length})`);
  const code = (f) => /\.(ts|tsx|mts|cts|mjs|cjs|js|json|sh|ps1|py)$/.test(f);
  // Every package folder (sources, tests, package.json, fixtures; not the build output), whatever packages exist, and every script that is not itself on the list.
  const readers = [
    ...readdirSync(join(root, "packages"), { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => files(join(root, "packages", e.name), code)),
    ...files(join(root, "scripts"), code).filter((f) => !ROOT_ONLY.some((p) => p.test("scripts/" + f.slice(join(root, "scripts").length + 1).replaceAll("\\", "/")))),
  ];
  assert.ok(readers.some((f) => f.replaceAll("\\", "/").endsWith("packages/controller/package.json")) && readers.some((f) => f.replaceAll("\\", "/").includes("packages/controller/src/")), "the package folders are read");
  const texts = readers.map((f) => [f.slice(root.length).replaceAll("\\", "/").replace(/^\//, ""), readFileSync(f, "utf8")]);
  for (const file of listed) {
    const name = file.split("/").pop();
    for (const [reader, text] of texts) assert.ok(!text.includes(name), `${reader} names ${name}: take it off ROOT_ONLY in scripts/affected-packages.mjs`);
  }
  // A reader need not name the file: listing scripts/ or the workflows, a glob over them, or a path built from a variable reaches files the names above do not show. Each such reader
  // must be checked by hand and listed here with what it reads; none may reach a file on ROOT_ONLY.
  const CHECKED = new Map([
    ["packages/integration/src/fixed-part-budget.test.ts", "join(repository, \"scripts\", file) over the literal list local-host.mjs and remote-host.mjs"],
    ["scripts/g05-owner-bundle.mjs", "join(repo, \"scripts\", s) over BUNDLE_SCRIPTS, the literal list containment-evidence.mjs, offline-guard.mjs and redact-log.mjs (none on ROOT_ONLY)"],
  ]);
  const dynamic = [
    /\b(?:readdir|opendir|glob)(?:Sync)?\s*\([^\n]*(?:["'`/]scripts\b|\.github|workflows)/,
    /\b(?:join|resolve)\s*\([^\n)]*["'`](?:scripts|\.github|workflows)["'`]\s*,\s*[^\s"'`]/,
    /(?:scripts|\.github\/workflows)\/\$\{/,
    /["'`](?:\.{1,2}\/)*(?:scripts|\.github\/workflows)\/?["'`]\s*,\s*import\.meta\.url/,
  ];
  for (const [reader, text] of texts) {
    const hit = dynamic.find((p) => p.test(text));
    assert.ok(hit === undefined || CHECKED.has(reader), `${reader} reaches scripts/ or the workflows by a computed path (${hit}): check that it reads nothing on ROOT_ONLY and add it to CHECKED here`);
  }
  for (const reader of CHECKED.keys()) assert.ok(texts.some(([f]) => f === reader), `${reader} is still there`);
});

const show = (steps) => steps.map((s) => (s.npm === undefined ? `node ${s.node.join(" ")}` : `npm ${s.npm.join(" ")}`));

test("the typical tier split into parts runs exactly what the unsharded tier runs: every package once, the controller in slices, the root checks in part 1", () => {
  const packages = [...graph.keys()];
  const whole = show(tierSteps("all", packages));
  assert.deepEqual(whole.slice(0, 2), ["npm run clean", "npm run build"]);
  assert.deepEqual(whole.slice(2, 6), ["npm run check:deps", "npm run licenses:check", "npm run roadmap:check", "node --test scripts/*.test.mjs"]);
  assert.ok(whole.includes("npm run test -w @nimblenewt/controller --if-present"), "unsharded: the whole controller in one step");
  for (const count of [2, 3, 5]) {
    const parts = Array.from({ length: count }, (_, i) => show(tierSteps("all", packages, i + 1, count)));
    const tests = parts.flat().filter((l) => l.startsWith("npm run test"));
    for (const p of packages.filter((n) => n !== "controller")) assert.equal(tests.filter((l) => l === `npm run test -w @nimblenewt/${p} --if-present`).length, 1, `${p} once (${count} parts)`);
    const slices = count - 1;
    for (let i = 1; i <= slices; i++) assert.equal(tests.filter((l) => l === `npm run test -w @nimblenewt/controller --if-present${slices > 1 ? ` -- --shard=${i}/${slices}` : ""}`).length, 1, `controller slice ${i}/${slices} (${count} parts)`);
    assert.equal(tests.length, packages.length - 1 + slices);
    assert.equal(parts.flat().filter((l) => l === "node --test scripts/*.test.mjs").length, 1, "the scripts' tests run once");
    assert.ok(parts[0].includes("npm run check:deps") && !parts.slice(1).some((p) => p.includes("npm run check:deps")), "root checks only in part 1");
    for (const part of parts) assert.deepEqual(part.slice(0, 2), ["npm run clean", "npm run build"], "every part with tests builds first");
    assert.ok(!parts[0].some((l) => /-w @nimblenewt\/(?!controller)/.test(l)), "part 1 carries the controller slice and the root checks, not the other packages");
    assert.ok(packages.filter((n) => n !== "controller").every((n) => parts[count - 1].includes(`npm run test -w @nimblenewt/${n} --if-present`)) && !parts[count - 1].some((l) => /controller/.test(l)), "the last part carries every other package and no controller slice");
  }
});

test("a selection without the controller is spread over the parts; a part with nothing to run builds nothing; documentation-only runs the root checks without a build", () => {
  const packages = [...graph.keys()];
  const parts = [1, 2, 3, 4].map((i) => show(tierSteps(["worker", "integration", "ui"], packages, i, 4)));
  assert.deepEqual(parts.flat().filter((l) => l.startsWith("npm run test")).sort(), ["npm run test -w @nimblenewt/integration --if-present", "npm run test -w @nimblenewt/ui --if-present", "npm run test -w @nimblenewt/worker --if-present"]);
  assert.deepEqual(parts[3], [], "a part with no tests does nothing at all");
  assert.deepEqual(show(tierSteps([], packages, 1, 4)), ["npm run check:deps", "npm run licenses:check", "npm run roadmap:check", "node --test scripts/*.test.mjs"]);
  assert.deepEqual(show(tierSteps([], packages, 2, 4)), []);
  assert.deepEqual(show(tierSteps(["ui"], packages)), ["npm run clean", "npm run build", "npm run check:deps", "npm run licenses:check", "npm run roadmap:check", "node --test scripts/*.test.mjs", "npm run test -w @nimblenewt/ui --if-present"]);
  assert.throws(() => tierSteps("all", packages, 5, 4), /invalid shard/);
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

test("the typical tier's controller slices cover the real weights' files and more: each file in exactly one slice, the same split on every run", () => {
  const weights = JSON.parse(readFileSync(join(root, "scripts", "test-weights.json"), "utf8")).seconds;
  // the recorded files plus as many unrecorded ones (median weight), in a shuffled order: the split must not depend on the order the directory listing gives
  const files = [...Object.keys(weights).map((k) => `dist/${k}`), ...Array.from({ length: 700 }, (_, i) => `dist/new/n${i}.test.js`)].sort((a, b) => (a.length * 7919) % 13 - (b.length * 7919) % 13 || (a < b ? 1 : -1));
  const slices = [...new Set(tierSteps("all", ["controller", "ui"], 1, 5).concat(...[2, 3, 4, 5].map((i) => tierSteps("all", ["controller", "ui"], i, 5))).map((s) => s.npm?.join(" ") ?? "").filter((l) => l.includes("controller")))];
  assert.equal(slices.length, 4);
  const runs = slices.map((l) => { const m = /--shard=(\d+)\/(\d+)$/.exec(l); assert.ok(m !== null, l); return shardFiles(files, weights, Number(m[1]), Number(m[2])); });
  const seen = runs.flat();
  assert.equal(seen.length, files.length, "no file dropped or run twice");
  assert.deepEqual([...seen].sort(), [...files].sort());
  assert.deepEqual(runs, slices.map((l) => { const m = /--shard=(\d+)\/(\d+)$/.exec(l); return shardFiles([...files].reverse(), weights, Number(m[1]), Number(m[2])); }), "the listing order does not change the split");
  for (const r of runs) assert.ok(r.length > 0);
});

test("run-package-tests: an empty slice passes, but a package with no compiled tests fails whether sharded or not", { timeout: 120000 }, async () => {
  const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const script = join(root, "scripts", "run-package-tests.mjs");
  const dir = mkdtempSync(join(tmpdir(), "rpt-"));
  try {
    const go = (...args) => new Promise((done) => { const c = spawn(process.execPath, [script, ...args], { cwd: dir, env: { ...process.env, NIMBLENEWT_FAST: "1" } }); let out = ""; c.stdout.on("data", (d) => { out += d; }); c.stderr.on("data", (d) => { out += d; }); c.on("close", (code) => done({ code, out })); });
    let r = await go("--shard=1/4");
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /no compiled test files/);
    mkdirSync(join(dir, "dist"));
    writeFileSync(join(dir, "dist", "one.test.js"), "import { test } from 'node:test';\ntest('one', () => {});\n");
    const owner = [1, 2, 3, 4].find((i) => shardFiles([join("dist", "one.test.js")], {}, i, 4).length === 1);
    r = await go(`--shard=${owner === 1 ? 2 : 1}/4`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /this shard has no test files in this package/);
    r = await go(`--shard=${owner}/4`);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /SHARD \d\/4: 1 of 1 test files/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
