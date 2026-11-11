import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher, type LaunchRecord } from "./launcher.js";
import { hostScriptBase, hostScriptRunner, ownNodeInstall } from "./host-runner.js";
import type { ScriptRun } from "./script.js";

// Card T02d: the production composition of the script runner. The real runs start confined processes: skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-hostrun-")));
after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const run = (source: string, extra: Partial<ScriptRun> = {}): ScriptRun => ({
  program: "node", interpreterVersion: process.versions.node, argv: ["bin/tool.js"], stdin: "{}", source, maxOutputBytes: 10_000, limits: { cpus: 1, memoryMb: 256, seconds: 20 }, env: {}, ...extra,
});
const fakeLauncher = (available: boolean) => ({ capacity: { available, ...(available ? { backend: "fake" } : { reason: "no bubblewrap here" }) }, launch: async () => { throw new Error("must not launch"); } }) as never;

describe("the host's script runner (card T02d)", () => {
  const records: LaunchRecord[] = [];
  let usable = false;
  before(async () => {
    const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && ownNodeInstall() !== undefined;
    await probe.stop();
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${probe.capacity.reason}`);
  });

  test("it makes its own launcher, runs a script confined and records the launch before it happens; the base is private and nothing is left behind", async (t) => {
    if (!usable) return t.skip("bubblewrap or a node install it can mount is unusable");
    const base = hostScriptBase(join(root, "data1"));
    const host = await hostScriptRunner({ base, audit: (r) => { records.push(r); }, requireEnforced: false });
    try {
      assert.equal(host.problem(), undefined);
      assert.equal(statSync(base).mode & 0o777, 0o700);
      assert.deepEqual(host.offered, [{ name: "node", version: process.versions.node }]);
      const facts = await host.facts();
      assert.equal(facts.interpreters["node"], process.versions.node);
      assert.ok(facts.cpus >= 1 && facts.memoryMb >= 1);
      const before = records.length;
      const out = await host.runner.run(run(`let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.stringify({got:JSON.parse(s).n,env:Object.keys(process.env).filter(k=>k.startsWith("NN_"))})));`, { stdin: '{"n":7}' }), new AbortController().signal);
      assert.deepEqual(JSON.parse(out.text), { got: 7, env: [] });
      assert.equal(records.length - before, 1);
      assert.equal(records.at(-1)!.mode, "sandboxed");
      assert.deepEqual(readdirSync(base), []);
    } finally { await host.stop(); }
  });

  test("an abort ends a running script at once", async (t) => {
    if (!usable) return t.skip("bubblewrap or a node install it can mount is unusable");
    const host = await hostScriptRunner({ base: join(root, "data2", "runs"), requireEnforced: false });
    try {
      const ctl = new AbortController();
      const started = Date.now();
      const pending = host.runner.run(run("setInterval(()=>{},1000)"), ctl.signal);
      setTimeout(() => ctl.abort(), 300);
      await assert.rejects(pending, /stopped before it finished|cancelled/);
      assert.ok(Date.now() - started < 10_000, "it did not wait for the script's 20 seconds");
      assert.deepEqual(readdirSync(join(root, "data2", "runs")), []);
    } finally { await host.stop(); }
  });

  test("a host with no confinement refuses every script and says why up front; it never runs one bare", async () => {
    const host = await hostScriptRunner({ launcher: fakeLauncher(false), base: join(root, "data3"), interpreters: [{ name: "node", version: "99.0.0", root: "/opt/node-99", executable: "bin/node" }] });
    assert.match(host.problem()!, /no sandbox: no bubblewrap here/);
    await assert.rejects(host.runner.run(run("1", { interpreterVersion: "99.0.0" }), new AbortController().signal), /cannot confine scripts.*no bubblewrap here/);
    await host.stop();
  });

  test("an interpreter the host does not have is refused by name and version; the owner's strictness is asked at every run and an unreadable one refuses the run", async () => {
    let strict: boolean | "throws" = true;
    const asked: boolean[] = [];
    const launcher = { capacity: { available: true, backend: "fake" }, launch: async (request: { requireEnforced?: boolean }) => { asked.push(request.requireEnforced === true); throw new Error("stop here"); } } as never;
    const host = await hostScriptRunner({ launcher, base: join(root, "data4"), interpreters: [{ name: "python3", version: "3.12.1", root: "/opt/py", executable: "bin/python3" }], requireEnforced: () => { if (strict === "throws") throw new Error("unreadable"); return strict; } });
    assert.equal(host.problem(), undefined);
    await assert.rejects(host.runner.run(run("1", { program: "ruby", interpreterVersion: "3.3.0" }), new AbortController().signal), /has no ruby 3.3.0/);
    await assert.rejects(host.runner.run(run("1", { program: "python3", interpreterVersion: "3.12.0" }), new AbortController().signal), /has no python3 3.12.0/);
    await assert.rejects(host.runner.run(run("1", { program: "python3", interpreterVersion: "3.12.1" }), new AbortController().signal), /stop here/);
    strict = false;
    await assert.rejects(host.runner.run(run("1", { program: "python3", interpreterVersion: "3.12.1" }), new AbortController().signal), /stop here/);
    assert.deepEqual(asked, [true, false], "the setting applies to the next script");
    strict = "throws";
    await assert.rejects(host.runner.run(run("1", { program: "python3", interpreterVersion: "3.12.1" }), new AbortController().signal), /could not be read, so the script was not started/);
    assert.equal(asked.length, 2, "nothing was launched when the setting could not be read");
    assert.deepEqual((await host.facts()).interpreters["python3"], "3.12.1");
  });

  test("bad setup is refused when the runner is made: a base that is a link or a relative path, an interpreter named like a command line", async () => {
    const real = join(root, "real"); const link = join(root, "link");
    await hostScriptRunner({ launcher: fakeLauncher(true), base: real });
    symlinkSync(real, link);
    await assert.rejects(hostScriptRunner({ launcher: fakeLauncher(true), base: link }), /not a link/);
    await assert.rejects(hostScriptRunner({ launcher: fakeLauncher(true), base: "relative/dir" }), /absolute path/);
    await assert.rejects(hostScriptRunner({ launcher: fakeLauncher(true), base: join(root, "ok"), interpreters: [{ name: "sh -c x", version: "1", root: "/opt/x", executable: "bin/x" }] }), /plain program name/);
    await assert.rejects(hostScriptRunner({ launcher: fakeLauncher(true), base: join(root, "ok2"), interpreters: [{ name: "node", version: "1", root: "relative", executable: "bin/x" }] }), /absolute install directory/);
    assert.equal(existsSync(join(root, "ok")), true);
  });

  test("a Node.js in a system directory is not offered (mounting /usr would show the whole system), and the host says it has no interpreter", async () => {
    // Stand in for process.execPath with a program whose install directory is a system one (the shell is in /usr/bin or /bin on every Linux and macOS host).
    const shellRoot = dirname(dirname(realpathSync("/bin/sh")));
    if (["/usr", "/bin", "/lib", "/sbin", "/"].includes(shellRoot)) assert.equal(ownNodeInstall("/bin/sh"), undefined);
    assert.ok(ownNodeInstall(process.execPath) === undefined || ownNodeInstall(process.execPath)!.executable === "bin/node");
    const host = await hostScriptRunner({ launcher: fakeLauncher(true), base: join(root, "data6"), interpreters: [] });
    if (ownNodeInstall() === undefined) assert.match(host.problem()!, /no interpreter is offered/);
  });
});
