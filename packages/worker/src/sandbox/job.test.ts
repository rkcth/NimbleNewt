import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher } from "./launcher.js";
import { jobLauncher, linuxOrphans, type JobRun } from "./job.js";

// Card T07b. Like the launcher's own tests, the job runs start real confined processes: skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-job-")));
after(() => rmSync(root, { recursive: true, force: true }));
const base = join(root, "runs");
mkdirSync(base);
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const interpreters = (name: string, version: string) => (name === "node" && version === process.versions.node ? { root: nodeRoot, executable: "bin/node" } : undefined);
const job = (source: string, extra: Partial<JobRun> = {}): JobRun => ({ program: "node", interpreterVersion: process.versions.node, argv: ["bin/job.js"], stdin: "{\"n\":3}", source, maxOutputBytes: 10_000, limits: { cpus: 1, memoryMb: 256, seconds: 30 }, env: {}, ...extra });
/** The processes whose command line holds `marker`, found in /proc (the host's view: the sandbox's own processes too). */
const holding = (marker: string): number[] => {
  const found: number[] = [];
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try { if (readFileSync(join("/proc", name, "cmdline")).toString("utf8").includes(marker)) found.push(Number(name)); } catch { /* gone */ }
  }
  return found;
};

describe("job launcher over the sandbox launcher (card T07b)", () => {
  let launcher: SandboxLauncher;
  let usable = false;
  before(async () => {
    launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
  });
  const ifUsable = (name: string, fn: () => Promise<void>): void => { test(name, async (t) => { if (!usable) return t.skip(`bubblewrap or a node install it can mount is unusable: ${launcher.capacity.reason ?? nodeRoot}`); await fn(); }); };

  ifUsable("a job reads its input on standard input, streams its output as it comes, sees no environment of the controller and leaves nothing behind", async () => {
    process.env["NN_JOB_SECRET"] = "must-not-reach-the-job";
    try {
      const out: string[] = [];
      const proc = await jobLauncher({ launcher, interpreters, base, requireEnforced: false }).start(job(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const i=JSON.parse(s);process.stdout.write("n="+i.n+"\\n");setTimeout(()=>{process.stdout.write(JSON.stringify(Object.keys(process.env).sort())+"\\nh\\u00e9llo\\n");process.stderr.write("a warning");},300);});`), (t) => out.push(t));
      const end = await proc.ended;
      assert.deepEqual([end.exitCode, end.timedOut, end.stopped, end.orphans, end.problem], [0, false, false, [], undefined]);
      const text = out.join("");
      assert.ok(out.length >= 2, "the output came in more than one piece");
      assert.match(text, /^n=3\n/);
      assert.match(text, /héllo/);
      assert.match(text, /\[stderr\] a warning/);
      assert.equal(text.includes("NN_JOB_SECRET"), false);
      assert.deepEqual(JSON.parse(text.split("\n")[1]!).filter((k: string) => !["HOME", "PATH", "PWD", "TMPDIR"].includes(k)), []);
      assert.deepEqual(readdirSync(base), [], "the job's private directory is removed");
    } finally { delete process.env["NN_JOB_SECRET"]; }
  });

  ifUsable("a stop through the real launcher ends the whole process tree, children included, and a failed exit and a time limit are told apart", async () => {
    const marker = `nn-job-child-${process.pid}-${Date.now()}`;
    const out: string[] = [];
    const proc = await jobLauncher({ launcher, interpreters, base, requireEnforced: false }).start(job(`const c=require("node:child_process").spawn(process.execPath,["-e","setInterval(()=>{},1000)","${marker}"],{stdio:"ignore",detached:true});c.unref();process.stdout.write("child "+c.pid+"\\n");setInterval(()=>{},1000);`), (t) => out.push(t));
    for (let i = 0; i < 100 && holding(marker).length === 0; i++) await sleep(50);
    assert.ok(holding(marker).length > 0, "positive control: the grandchild is seen while the job runs");
    proc.stop(false);
    proc.stop(true);
    const end = await proc.ended;
    assert.deepEqual([end.stopped, end.orphans], [true, []]);
    for (let i = 0; i < 40 && holding(marker).length > 0; i++) await sleep(50);
    assert.deepEqual(holding(marker), [], "nothing of the job is left running");
    const failed = await (await jobLauncher({ launcher, interpreters, base, requireEnforced: false }).start(job(`process.exit(4)`), () => undefined)).ended;
    assert.deepEqual([failed.exitCode, failed.timedOut, failed.stopped], [4, false, false]);
    const slow = await (await jobLauncher({ launcher, interpreters, base, requireEnforced: false }).start(job(`setInterval(()=>{},1000)`, { limits: { cpus: 1, memoryMb: 256, seconds: 1 } }), () => undefined)).ended;
    assert.deepEqual([slow.timedOut, slow.stopped], [true, false]);
    assert.deepEqual(readdirSync(base), []);
  });

  ifUsable("a launch the host refuses throws and leaves no directory; an interpreter the host does not have is refused before anything starts", async () => {
    await assert.rejects(jobLauncher({ launcher, interpreters, base, requireEnforced: false }).start(job("1", { interpreterVersion: "0.0.1" }), () => undefined), /has no node 0\.0\.1/);
    await assert.rejects(jobLauncher({ launcher, interpreters, base, requireEnforced: false }).start(job("1", { argv: ["../escape.js"] }), () => undefined));
    assert.deepEqual(readdirSync(base), []);
  });
});

test("the orphan scan ends what still holds a job's directory and names only what it could not end, never its command line (card T07b)", async (t) => {
  if (process.platform !== "linux") return t.skip("/proc is Linux's");
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn-orphan-")));
  const spawnHolder = () => spawn(process.execPath, ["-e", "setInterval(()=>{},1000)", `${directory}/work`, "--token=abcdefghijklmnopqrstuvwxyz0123456789ABCD"], { stdio: "ignore" });
  const stuck = spawnHolder();
  try {
    for (let i = 0; i < 100 && holding(directory).length === 0; i++) await sleep(20);
    // A process that cannot be ended (the kill is refused) is reported by pid and name only.
    const named = await linuxOrphans(directory, { kill: () => { throw new Error("not permitted"); }, settleMs: 20 });
    // The name is the one the kernel gives the process: "node" on most Node builds, "MainThread" on others (Node 24 on the CI runners), so it is read from the process itself.
    const kernelName = readFileSync(`/proc/${stuck.pid}/comm`, "utf8").trim();
    assert.deepEqual(named, [`pid ${stuck.pid} (${kernelName})`]);
    // One that can be ended is ended and not reported.
    assert.deepEqual(await linuxOrphans(directory, { settleMs: 300 }), []);
    for (let i = 0; i < 50 && holding(directory).length > 0; i++) await sleep(20);
    assert.deepEqual(holding(directory), []);
    assert.deepEqual(await linuxOrphans(join(directory, "nothing-here")), []);
  } finally { stuck.kill("SIGKILL"); rmSync(directory, { recursive: true, force: true }); }
});

test("an orphan's name is reduced to printable ASCII: a process the job renamed to a terminal escape or a bidirectional override reaches no one as such (card T07b review)", async () => {
  // A /proc of our own making (it runs on every system): one process holds the job's directory and keeps its name, which the job's program chose.
  const proc = realpathSync(mkdtempSync(join(tmpdir(), "nn-fakeproc-")));
  try {
    const directory = "/runs/job-abc";
    mkdirSync(join(proc, "4242"));
    writeFileSync(join(proc, "4242", "cmdline"), `bwrap\0${directory}/work\0`);
    writeFileSync(join(proc, "4242", "comm"), "\u001b[2J‮evil\u0007\n");
    const named = await linuxOrphans(directory, { proc, kill: () => undefined, settleMs: 1 });
    assert.deepEqual(named, ["pid 4242 (?[2J?evil?)"]);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});

test("the orphan scan ends a process only while its ID still names the process the scan saw: an ID reused by another program after the scan is never killed nor reported (card T07b review 4)", async () => {
  const proc = realpathSync(mkdtempSync(join(tmpdir(), "nn-fakeproc-")));
  try {
    const directory = "/runs/job-def";
    const write = (pid: number, cmdline: string, started: number): void => {
      mkdirSync(join(proc, String(pid)), { recursive: true });
      writeFileSync(join(proc, String(pid), "cmdline"), cmdline);
      writeFileSync(join(proc, String(pid), "comm"), "node\n");
      // A name with a space and a parenthesis, as a program may choose: the start time is read after the last ")".
      writeFileSync(join(proc, String(pid), "stat"), `${pid} (no (de) S 1 ${pid} ${pid} 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 ${started} 1000 10 18446744073709551615\n`);
    };
    for (const pid of [5001, 5002, 5003]) write(pid, `bwrap\0${directory}/work\0`, 100 + pid);
    const killed: number[] = [];
    // While the first is being ended, the other two exit and their IDs are taken: one by a program started later that also names the directory, one by an unrelated program.
    const kill = (pid: number): void => {
      if (killed.length === 0) for (const other of [5001, 5002, 5003].filter((p) => p !== pid)) write(other, other % 2 === 0 ? `bwrap\0${directory}/work\0` : "/usr/bin/unrelated\0--serve\0", 9_000 + other);
      killed.push(pid);
    };
    const named = await linuxOrphans(directory, { proc, kill, settleMs: 1 });
    assert.equal(killed.length, 1, `only the process still known by its start time is ended: ${killed.join(", ")}`);
    // The first is still listed (the fake kill ended nothing) and is reported; the reused IDs are not reported as the job's.
    assert.deepEqual(named, [`pid ${killed[0]} (node)`]);
  } finally { rmSync(proc, { recursive: true, force: true }); }
});
