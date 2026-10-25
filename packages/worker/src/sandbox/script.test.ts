import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { setTimeout as sleep } from "node:timers/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxError } from "./errors.js";
import { SandboxLauncher, type LaunchRecord, type LaunchRequest, type RunResult, type SandboxRun } from "./launcher.js";
import { scriptRunner, type ScriptRun } from "./script.js";

// Like the launcher's own tests, these start real confined processes: skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-script-")));
after(() => rmSync(root, { recursive: true, force: true }));
const base = join(root, "runs");
mkdirSync(base);

const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const interpreters = (name: string, version: string) => (name === "node" && version === process.versions.node ? { root: nodeRoot, executable: "bin/node" } : undefined);

const run = (source: string, extra: Partial<ScriptRun> = {}): ScriptRun => ({
  program: "node", interpreterVersion: process.versions.node, argv: ["bin/tool.js"], stdin: "{}", source, maxOutputBytes: 10_000, limits: { cpus: 1, memoryMb: 256, seconds: 20 }, env: {}, ...extra,
});

describe("script runner over the sandbox launcher", () => {
  const records: LaunchRecord[] = [];
  let launcher: SandboxLauncher;
  let usable = false;

  before(async () => {
    process.env["NN_TEST_SECRET"] = "must-not-reach-the-script";
    launcher = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
    usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
  });
  after(() => { delete process.env["NN_TEST_SECRET"]; });

  // The host may not be able to enforce cgroup limits (a CI container): the real runs ask for them not to be required, and the launch record shows what was done.
  const runner = () => scriptRunner({ launcher, interpreters, base, requireEnforced: false });
  const ifUsable = (name: string, fn: () => Promise<void>): void => { test(name, async (t) => { if (!usable) return t.skip(`bubblewrap or a node install it can mount is unusable: ${launcher.capacity.reason ?? nodeRoot}`); await fn(); }); };
  const signal = (): AbortSignal => new AbortController().signal;

  ifUsable("the model's input reaches the script on standard input only, and the run leaves nothing behind", async () => {
    const hostile = `"; rm -rf / #\n$(touch /work/pwned) \`id\``;
    const out = await runner().run(run(`let s=""; process.stdin.on("data",d=>s+=d).on("end",()=>{ const i=JSON.parse(s); process.stdout.write(JSON.stringify({ text: i.text, argv: process.argv.slice(2), cwd: process.cwd(), files: process.getBuiltinModule("fs").readdirSync("/work") })); });`, { stdin: JSON.stringify({ text: hostile }) }), signal());
    const seen = JSON.parse(out.text) as { text: string; argv: string[]; cwd: string; files: string[] };
    assert.equal(seen.text, hostile, "the text arrived as data, byte for byte");
    assert.deepEqual(seen.argv, [], "the model's text is not an argument");
    assert.equal(seen.cwd, "/work");
    assert.deepEqual(seen.files, ["bin"], "the directory holds the pinned source and nothing else (no pwned file)");
    assert.deepEqual(readdirSync(base), [], "the run's directory is removed");
    const last = records[records.length - 1]!;
    assert.ok(!last.commandDigest.includes("rm -rf"), "the audit record keeps a digest, not the line");
  });

  ifUsable("the environment is empty apart from what the launcher sets and what the run adds, and there is no network", async () => {
    // 192.0.2.1 is a documentation address: on a host with a network a connect attempt times out or is refused by a router, here the sandbox has no route at all.
    const out = await runner().run(run(`const net=process.getBuiltinModule("net"); const c=net.connect(80,"192.0.2.1"); c.on("error",e=>process.stdout.write(JSON.stringify({ env: Object.keys(process.env).sort(), net: e.code }))); c.on("connect",()=>process.stdout.write("connected"));`, { env: { KEEP: "yes" } }), signal());
    const seen = JSON.parse(out.text) as { env: string[]; net: string };
    assert.deepEqual(seen.env, ["HOME", "KEEP", "PATH", "PWD", "TMPDIR"], "nothing of the worker's or the controller's environment");
    assert.ok(!out.text.includes("must-not-reach"));
    assert.equal(seen.net, "ENETUNREACH");
  });

  ifUsable("the script runs the pinned bytes, from a file it cannot overwrite in place", async () => {
    const source = `const fs=process.getBuiltinModule("fs"); let w="ok"; try { fs.writeFileSync(__filename, "x"); } catch (e) { w=e.code; } process.stdout.write(JSON.stringify({ w, bytes: fs.readFileSync(__filename,"utf8").length }));`;
    const out = await runner().run(run(source), signal());
    const seen = JSON.parse(out.text) as { w: string; bytes: number };
    assert.equal(seen.w, "EACCES");
    assert.equal(seen.bytes, source.length, "the file holds exactly the pinned source");
  });

  ifUsable("output over the cap fails the run and says so", async () => {
    await assert.rejects(runner().run(run(`process.stdout.write("x".repeat(50000));`, { maxOutputBytes: 1000 }), signal()), /wrote more than 1000 bytes and was cut off/);
  });

  ifUsable("a script over its time limit is stopped and fails", async () => {
    const started = Date.now();
    await assert.rejects(runner().run(run(`setInterval(()=>{}, 1000); while(true){}`, { limits: { cpus: 1, memoryMb: 256, seconds: 1 } }), signal()), /longer than its limit of 1 seconds/);
    assert.ok(Date.now() - started < 10_000);
    assert.deepEqual(readdirSync(base), []);
  });

  ifUsable("an error exit fails with the script's own message, and an abort stops the run", async () => {
    await assert.rejects(runner().run(run(`console.error("bad input: n"); process.exit(3);`), signal()), /exited with code 3: bad input: n/);
    const controller = new AbortController();
    const pending = runner().run(run(`setInterval(()=>{}, 1000);`), controller.signal);
    setTimeout(() => controller.abort(), 700);
    await assert.rejects(pending, /stopped before it finished/);
  });

  ifUsable("the manifest's limits go to the launcher and are recorded with how each was enforced", async () => {
    const before = records.length;
    await runner().run(run(`process.stdout.write("{}")`, { limits: { cpus: 1, memoryMb: 300, seconds: 7 } }), signal());
    const record = records[before]!;
    assert.deepEqual(record.limits.map((l) => [l.limit, l.value]).sort(), [["cpus", 1], ["memoryMb", 300]]);
  });

  ifUsable("a script that takes away its own permissions cannot keep its directory or turn its result into a failure", async () => {
    const leftovers: string[] = [];
    const out = await scriptRunner({ launcher, interpreters, base, requireEnforced: false, onLeftover: (d, why) => leftovers.push(`${d}: ${why}`) }).run(run(`const fs=process.getBuiltinModule("fs"); fs.mkdirSync("/work/deep/er",{recursive:true}); fs.writeFileSync("/work/deep/er/f","x"); fs.chmodSync("/work/deep/er",0o555); fs.chmodSync("/work/deep",0o555); fs.chmodSync("/work/bin",0o555); process.stdout.write("{}");`), signal());
    assert.equal(out.text, "{}");
    assert.deepEqual(readdirSync(base), [], "the directory is removed after its permissions are restored");
    assert.deepEqual(leftovers, []);
  });

  ifUsable("an abort before the launch, or while the launch is being recorded, stops the script", async () => {
    const early = new AbortController();
    early.abort();
    await assert.rejects(runner().run(run("1"), early.signal), /cancelled before the script started/);
    // The audit sink is slow (an asynchronous write): the abort arrives during the launch, before the run exists to be stopped.
    const slow = await SandboxLauncher.create({ protectedPaths: [], audit: async () => { await sleep(500); } });
    try {
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 100);
      const started = Date.now();
      await assert.rejects(scriptRunner({ launcher: slow, interpreters, base, requireEnforced: false }).run(run(`setTimeout(()=>process.stdout.write("finished anyway"), 4000);`), controller.signal), /stopped before it finished/);
      assert.ok(Date.now() - started < 3500, "the script did not run to its end");
    } finally { await slow.stop(); }
    assert.deepEqual(readdirSync(base), []);
  });

  ifUsable("only a cut-off standard output fails the run: a noisy standard error does not, and the default refuses limits the host cannot enforce", async () => {
    const ok = await runner().run(run(`process.stdout.write("x".repeat(1000)); process.stderr.write("e".repeat(50000));`, { maxOutputBytes: 1000 }), signal());
    assert.equal(ok.text.length, 1000);
    // A launcher that reports it can enforce nothing: with the default `requireEnforced` the run is refused before it starts.
    const weak = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined, limitCapabilities: { platform: "linux", cgroupScope: false, escapeDollar: false, prlimit: false, taskset: false, passEnv: {} } });
    try { await assert.rejects(scriptRunner({ launcher: weak, interpreters, base }).run(run("1"), signal()), /cannot be fully enforced/); } finally { await weak.stop(); }
    assert.deepEqual(readdirSync(base), []);
  });

  test("the launch asks for exactly the manifest's limits, time and output cap, a private recipe and the data on standard input (stand-in launcher)", async () => {
    const seen: LaunchRequest[] = [];
    const finished: RunResult = { exitCode: 0, signal: null, timedOut: false, killed: false, stdout: "{\"a\":1}", stderr: "", truncated: false, stdoutTruncated: false, durationMs: 1 };
    const stand = { capacity: { available: true, backend: "bubblewrap", checkedAt: "" }, launch: async (r: LaunchRequest): Promise<SandboxRun> => { seen.push(r); return { runId: "r", mode: "sandboxed", recipeRevision: "x", guest: { workdir: "/work", home: "", scratch: "", tmp: "", inputs: [] }, kill: () => undefined, write: async () => undefined, endInput: () => undefined, result: Promise.resolve(finished) }; } };
    const out = await scriptRunner({ launcher: stand, interpreters, base }).run(run("1", { stdin: "{\"n\":2}", limits: { cpus: 2, memoryMb: 128, seconds: 3.5 }, maxOutputBytes: 777, env: { A: "b" } }), signal());
    assert.equal(out.text, "{\"a\":1}");
    const r = seen[0]!;
    assert.deepEqual(r.command, ["/opt/interpreter/bin/node", "bin/tool.js"]);
    assert.equal(r.stdin, "{\"n\":2}");
    assert.equal(r.timeoutMs, 3500);
    assert.equal(r.maxOutputBytes, 777);
    assert.deepEqual(r.limits, { cpus: 2, memoryMb: 128 });
    assert.equal(r.requireEnforced, true, "a limit the host cannot enforce refuses the run unless the owner relaxed it");
    assert.equal(r.recipe.network, "none");
    assert.deepEqual(r.recipe.env, { A: "b" });
    assert.deepEqual(r.recipe.readOnly, [{ host: nodeRoot, guest: "/opt/interpreter" }]);
  });

  test("a launch that could not start says so", async () => {
    const failed: RunResult = { exitCode: null, signal: null, timedOut: false, killed: false, stdout: "", stderr: "could not start: spawn bwrap ENOENT", truncated: false, stdoutTruncated: false, durationMs: 1 };
    const stand = { capacity: { available: true, backend: "bubblewrap", checkedAt: "" }, launch: async (): Promise<SandboxRun> => ({ runId: "r", mode: "sandboxed", recipeRevision: "x", guest: { workdir: "/work", home: "", scratch: "", tmp: "", inputs: [] }, kill: () => undefined, write: async () => undefined, endInput: () => undefined, result: Promise.resolve(failed) }) };
    await assert.rejects(scriptRunner({ launcher: stand, interpreters, base }).run(run("1"), signal()), /could not be started: spawn bwrap ENOENT/);
  });

  test("a refusal of the launcher, an unknown interpreter and a bad entry point fail before anything runs", async () => {
    const refusing = { capacity: { available: true, backend: "bubblewrap", checkedAt: "" }, launch: async (): Promise<SandboxRun> => { throw new SandboxError("unavailable", "these limits cannot be fully enforced on this host: memoryMb (no cgroup)"); } };
    await assert.rejects(scriptRunner({ launcher: refusing, interpreters, base }).run(run("1"), signal()), /cannot be fully enforced/);
    await assert.rejects(scriptRunner({ launcher: refusing, interpreters, base }).run(run("1", { program: "ruby" }), signal()), /no ruby /);
    for (const argv of [["../x.js"], ["/etc/passwd"], ["a/../../x"], ["-e"], [], ["a.js", "b"], [""], ["a//b.js"], ["a/"], ["a/./b"], ["a\\b.js"], ["C:x.js"]]) {
      await assert.rejects(scriptRunner({ launcher: refusing, interpreters, base }).run(run("1", { argv }), signal()), /argv: must be one entry point/, JSON.stringify(argv));
    }
    assert.deepEqual(readdirSync(base), [], "nothing is left behind by a refusal");
  });
});
