// The exhaustive tier, one shard of it (card X11): `node scripts/test-shard.mjs <i>/<n>`. Every shard builds; shard 1 also runs the root checks (package rules, licenses,
// roadmap, script tests) and every package except the controller; each shard runs its i-th slice of the controller's test files, balanced by recorded run time
// (scripts/test-weights.json). Together the n shards run exactly what `npm test` runs. All backends and the long qualification runs are included.
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageGraph } from "./affected-packages.mjs";

/** The steps of shard `index` of `count`: what `npm test` runs, with the controller's test files split. Shard 1 carries the root checks and every other package. */
export function shardSteps(index, count, packages) {
  const steps = [["run", "clean"], ["run", "build"]];
  if (index === 1) steps.push(["run", "check:deps"], ["run", "licenses:check"], ["run", "roadmap:check"], { node: ["--test", "scripts/*.test.mjs"] });
  for (const name of packages) {
    if (name === "controller") steps.push(["run", "test", "-w", "@nimblenewt/controller", "--", `--shard=${index}/${count}`]);
    else if (index === 1) steps.push(["run", "test", "-w", `@nimblenewt/${name}`, "--if-present"]);
  }
  return steps;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
const m = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
if (isMain && m === null) { console.error("usage: node scripts/test-shard.mjs <i>/<n>"); process.exit(2); }
const [index, count] = m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
/** How long a step may print nothing before it is reported as stuck and ended (a node test file prints only when it ends, so a file that never ends is otherwise a silent cancel at the job limit). */
export const QUIET_LIMIT_MS = 30 * 60_000;

/** The processes below `rootPid` that run test files, one line each ("pid command"), so a stuck run names the file it is in. Only the step's own descendants: another run on the same machine is never listed. */
export function runningTestProcesses(rootPid = process.pid, platform = process.platform, exec = spawnSync) {
  const r = platform === "win32"
    ? exec("powershell", ["-NoProfile", "-Command", "Get-CimInstance Win32_Process | ForEach-Object { \"$($_.ProcessId) $($_.ParentProcessId) $($_.CommandLine)\" }"], { encoding: "utf8" })
    : exec("ps", ["-axo", "pid=,ppid=,args="], { encoding: "utf8" });
  const rows = String(r.stdout ?? "").split(/\r?\n/).map((l) => /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(l)).filter((m) => m !== null).map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), cmd: m[3] }));
  const below = new Set([rootPid]);
  for (let grew = true; grew;) { grew = false; for (const row of rows) if (!below.has(row.pid) && below.has(row.ppid)) { below.add(row.pid); grew = true; } }
  return rows.filter((row) => row.pid !== rootPid && below.has(row.pid) && /\.test\.[cm]?[jt]s|--test\b|--shard=/.test(row.cmd) && !/powershell|\bps -axo/.test(row.cmd)).map((row) => `${row.pid} ${row.cmd}`);
}

/** Run one step, forwarding its output; if it prints nothing for `quietMs` it is reported (step, quiet time, the test files still running) and ended with status 124. Returns the exit status. */
export function runStep(command, args, { cwd, shell = false, quietMs = QUIET_LIMIT_MS, label = [command, ...args].join(" "), out = process.stdout, err = process.stderr, list = runningTestProcesses, kill = killTree } = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, shell, stdio: ["inherit", "pipe", "pipe"] });
    let timer;
    let stuck = false;
    const arm = () => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        stuck = true;
        let running = [];
        try { running = list(child.pid); } catch { /* the listing is only a help */ }
        err.write(`\nSTUCK: step "${label}" printed nothing for ${Math.round(quietMs / 1000)} s. Processes still running (a test file that has not ended is named here):\n${running.length === 0 ? "  (none found)\n" : running.map((l) => `  ${l}\n`).join("")}Ending the step.\n`);
        for (const l of running) { const pid = Number(l.split(/\s+/)[0]); if (Number.isInteger(pid) && pid !== process.pid) try { kill(pid); } catch { /* already gone */ } }
        try { kill(child.pid); } catch { /* already gone */ }
      }, quietMs);
    };
    arm();
    child.stdout.on("data", (d) => { arm(); out.write(d); });
    child.stderr.on("data", (d) => { arm(); err.write(d); });
    child.on("error", () => { clearTimeout(timer); resolve(1); });
    child.on("close", (code) => { clearTimeout(timer); resolve(stuck ? 124 : (code ?? 1)); });
  });
}

function killTree(pid) {
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
  else process.kill(pid, "SIGKILL");
}

const run = (step) => (step.node === undefined
  ? runStep(npm, step, { cwd: root, shell: process.platform === "win32", quietMs: Number(process.env.NN_SHARD_QUIET_MS) || QUIET_LIMIT_MS })
  : runStep(process.execPath, step.node, { cwd: root, quietMs: Number(process.env.NN_SHARD_QUIET_MS) || QUIET_LIMIT_MS, label: `node ${step.node.join(" ")}` }));
if (isMain) {
  const steps = shardSteps(index, count, [...packageGraph(root).keys()]);
  for (const step of steps) { const s = await run(step); if (s !== 0) process.exit(s); }
}
