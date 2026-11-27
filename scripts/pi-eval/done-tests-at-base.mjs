#!/usr/bin/env node
// W09 second slice: shows that each bench task's `doneTests` (taskset.json) pass at the task's base and at its solution, model-free. Each checkout is prepared as the bench prepares an agent's (lib/runner.mjs prepareCheckout:
// the commit fetched alone, the dependencies copied), built with the task's setup command, and the done tests run from the checkout's root with this Node.js, as the done check runs them in the sandbox (cwd /work). No model,
// no network: run it under scripts/offline-guard.mjs and through the test slot.
//
//   node --import file://$PWD/scripts/offline-guard.mjs scripts/pi-eval/done-tests-at-base.mjs [--task <id>] [--at base|solution|both] [--work <dir>]
//
// Prints one line per task and commit, and a JSON summary last; exits 1 when any declared test does not pass.

import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCheckout } from "./lib/runner.mjs";
import { loadTaskset } from "./lib/taskset.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const arg = (name) => { const i = process.argv.indexOf(name); return i < 0 ? undefined : process.argv[i + 1]; };
const only = arg("--task");
const at = arg("--at") ?? "both";
if (!["base", "solution", "both"].includes(at)) throw new Error("--at must be base, solution or both");
const set = loadTaskset(join(here, "taskset.json"));

/** Runs a command, its output kept to the last 4,000 characters. */
const run = (argv, cwd, env = {}) => new Promise((done) => {
  const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  const keep = (b) => { out = (out + b.toString("utf8")).slice(-4000); };
  child.stdout.on("data", keep); child.stderr.on("data", keep);
  child.on("close", (code, signal) => done({ code, signal, out }));
});
const node = (argv) => (argv[0] === "node" ? [process.execPath, ...argv.slice(1)] : argv);

const work = arg("--work") ?? (await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "done-tests-")));
const results = [];
try {
  for (const task of set.tasks) {
    if (only !== undefined && task.id !== only) continue;
    const tests = task.doneTests ?? [];
    for (const which of at === "both" ? ["base", "solution"] : [at]) {
      const commit = task[which];
      const dir = join(work, `${task.id}-${which}`);
      const r = { task: task.id, at: which, commit: commit.slice(0, 12), tests: tests.length, built: false, passed: false };
      if (tests.length === 0) { results.push({ ...r, why: "no doneTests declared" }); console.log(`${task.id} ${which}: no doneTests declared`); continue; }
      await prepareCheckout({ repo: root, commit, dir, copy: task.copy, depsFrom: root });
      const b = await run(node(task.setup.argv), dir);
      r.built = b.code === 0;
      if (!r.built) { results.push({ ...r, why: `build exited ${b.code}: ${b.out.slice(-600)}` }); console.log(`${task.id} ${which}: BUILD FAILED`); await rm(dir, { recursive: true, force: true }); continue; }
      const t = await run([process.execPath, "--test", "--test-reporter=tap", ...tests], dir);
      r.passed = t.code === 0;
      const counts = /# pass (\d+)[\s\S]*?# fail (\d+)/.exec(t.out);
      results.push({ ...r, ...(r.passed ? {} : { why: t.out.slice(-800) }) });
      console.log(`${task.id} ${which} ${commit.slice(0, 12)}: ${r.passed ? "PASS" : `FAIL (exit ${t.code})`} ${tests.join(" ")}${counts ? ` (pass ${counts[1]}, fail ${counts[2]})` : ""}`);
      await rm(dir, { recursive: true, force: true });
    }
  }
} finally { if (arg("--work") === undefined) await rm(work, { recursive: true, force: true }); }
console.log(JSON.stringify({ at, results }, null, 1));
process.exit(results.every((x) => x.passed) ? 0 : 1);
