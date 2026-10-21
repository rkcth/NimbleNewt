import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { SandboxLauncher, type LaunchRecord, type RunResult } from "./launcher.js";
import { normalizeRecipe, type SandboxRecipe } from "./recipe.js";
import { profileFor, seatbeltBackend } from "./seatbelt.js";

const onMac = process.platform === "darwin";
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-seatbelt-")));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };
let counter = 0;
const recipe = (extra: Partial<SandboxRecipe> = {}): SandboxRecipe => {
  const n = ++counter;
  return { mode: "sandboxed", workdir: dir(`work${n}`), home: dir(`home${n}`), scratch: dir(`scratch${n}`), readOnly: [], network: "none", env: {}, protectedSubpaths: [".git"], ...extra };
};

describe("the Seatbelt profile (any operating system)", () => {
  test("paths are parameters, never text in the profile, so no path can change the profile", () => {
    const evil = dir('evil") (allow default) ("x');
    const r = normalizeRecipe(recipe({ workdir: evil, readOnly: [{ host: dir("tools"), guest: "/inputs/tools" }] }), []);
    const profile = profileFor(r);
    assert.ok(!profile.includes("allow default"), profile);
    assert.ok(!profile.includes(evil) && !profile.includes(r.home) && !profile.includes(r.scratch));
    assert.match(profile, /^\(version 1\)\n\(deny default\)/);
    assert.ok(profile.includes("(deny network*)"));
    assert.ok(profile.includes('(subpath (param "RO0"))') && profile.includes('(deny file-write* (subpath (param "PROT0")))'));
    const plan = seatbeltBackend().plan(r, ["/bin/echo", "hi"]);
    const defined = plan.args.filter((_, i) => plan.args[i - 1] === "-D");
    assert.deepEqual(defined.map((d) => d.split("=")[0]), ["WORK", "HOME", "SCRATCH", "TMP", "RO0", "PROT0"]);
    assert.ok(defined.includes(`WORK=${evil}`));
    assert.deepEqual(plan.args.slice(-2), ["/bin/echo", "hi"]);
    assert.deepEqual(Object.keys(plan.env).sort(), ["HOME", "PATH", "TMPDIR"]);
    assert.equal(plan.cwd, evil);
    assert.equal(seatbeltBackend().guestView(r).workdir, evil);
  });

  test("a machine without sandbox-exec has no capacity and says why", async () => {
    const launcher = await SandboxLauncher.create({ backend: seatbeltBackend({ executable: "/nonexistent/sandbox-exec" }), protectedPaths: [], audit: () => undefined });
    assert.equal(launcher.capacity.available, false);
    assert.match(launcher.capacity.reason ?? "", /not found|could not run/);
    await assert.rejects(launcher.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), /no confined launch is possible/);
  });
});

describe("Seatbelt on macOS", { skip: onMac ? false : "macOS only" }, () => {
  const secretDir = dir("controller-data");
  const secretFile = join(secretDir, "controller.db");
  writeFileSync(secretFile, "TOP-SECRET-CONTROLLER-DATABASE");
  const fakeHome = dir("fake-home");
  mkdirSync(join(fakeHome, ".ssh"));
  writeFileSync(join(fakeHome, ".ssh", "id_nimblenewt_test"), "PRIVATE-KEY-MATERIAL");
  const records: LaunchRecord[] = [];
  let launcher: SandboxLauncher;
  let usable = false;
  const originalHome = process.env["HOME"];

  before(async () => {
    process.env["HOME"] = fakeHome;
    process.env["NN_TEST_SECRET"] = "must-not-reach-the-agent";
    launcher = await SandboxLauncher.create({ protectedPaths: [secretDir], audit: (r) => { records.push(r); } });
    usable = launcher.capacity.available && launcher.capacity.backend === "seatbelt";
    if (!usable && required) assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
  });
  after(() => { if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome; delete process.env["NN_TEST_SECRET"]; });

  const run = async (script: string, r: SandboxRecipe = recipe(), limits: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<RunResult> =>
    (await launcher.launch({ recipe: r, command: ["/bin/sh", "-c", script], timeoutMs: limits.timeoutMs ?? 30_000, maxOutputBytes: limits.maxOutputBytes ?? 1_000_000 })).result;
  const ifUsable = (name: string, fn: () => Promise<void>): void => { test(name, async (t) => { if (!usable) return t.skip(`Seatbelt unusable: ${launcher.capacity.reason}`); await fn(); }); };

  ifUsable("capacity is advertised after a real confined probe", async () => {
    assert.deepEqual([launcher.capacity.available, launcher.capacity.backend], [true, "seatbelt"]);
  });

  ifUsable("a command runs in the checkout with only the launcher's environment, and writes in the agent's own directories land on the host", async () => {
    const r = recipe({ env: { AGENT_NAME: "alice" } });
    const result = await run('pwd -P; /usr/bin/env; echo hello > "$PWD/out.txt"; echo h > "$HOME/h.txt"; echo s > "$TMPDIR/s.txt"', r);
    assert.equal(result.exitCode, 0, result.stderr + result.stdout);
    const lines = result.stdout.trim().split("\n");
    assert.equal(realpathSync(lines[0]!), r.workdir);
    const names = lines.slice(1).filter((l) => /^[A-Za-z_]+=/.test(l)).map((l) => l.split("=")[0]!).filter((n) => !["PWD", "SHLVL", "_", "OLDPWD", "__CF_USER_TEXT_ENCODING"].includes(n));
    assert.deepEqual(names.sort(), ["AGENT_NAME", "HOME", "PATH", "TMPDIR"]);
    assert.ok(!result.stdout.includes("must-not-reach-the-agent"));
    assert.equal(readFileSync(join(r.workdir, "out.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(r.home, "h.txt"), "utf8"), "h\n");
    assert.equal(readFileSync(join(r.scratch, ".tmp", "s.txt"), "utf8"), "s\n");
  });

  ifUsable("writes outside the agent's directories are denied, and the controller's data and the user's credentials cannot be read", async () => {
    const result = await run(`for p in /usr/x /etc/x /private/etc/x /tmp/x /private/tmp/x /Library/x ${secretDir}/x ${fakeHome}/x ${root}/x; do ( : > "$p" ) 2>/dev/null && echo "WROTE $p"; done; /bin/cat ${secretFile} 2>/dev/null; /bin/ls ${secretDir} 2>/dev/null; /bin/cat ${fakeHome}/.ssh/id_nimblenewt_test 2>/dev/null; /bin/ls ${fakeHome}/.ssh 2>/dev/null; echo finished`);
    assert.equal(result.stdout.trim(), "finished", result.stdout + result.stderr);
    assert.equal(existsSync(join(secretDir, "x")), false);
    assert.equal(existsSync(join(root, "x")), false);
  });

  ifUsable("a symbolic link in the checkout cannot lead to the controller's data", async () => {
    const r = recipe();
    symlinkSync(secretFile, join(r.workdir, "to-secret"));
    symlinkSync(secretDir, join(r.workdir, "to-dir"));
    const result = await run('/bin/cat "$PWD/to-secret" 2>/dev/null; /bin/ls "$PWD/to-dir" 2>/dev/null; ( echo overwritten > "$PWD/to-secret" ) 2>/dev/null; echo end', r);
    assert.equal(result.stdout.trim(), "end", result.stdout + result.stderr);
    assert.equal(readFileSync(secretFile, "utf8"), "TOP-SECRET-CONTROLLER-DATABASE");
  });

  ifUsable("a decoy in the agent's own scratch is readable (the control for the denials above)", async () => {
    const r = recipe();
    writeFileSync(join(r.scratch, "controller.db"), "decoy");
    const result = await run('/bin/cat "$HOME/../' + r.scratch.split("/").pop() + '/controller.db"', r);
    assert.equal(result.stdout, "decoy", result.stdout + result.stderr);
  });

  ifUsable("there is no network: the host's loopback server cannot be reached", async () => {
    const server: Server = createServer((socket) => { socket.end("HOST-SERVICE"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await run(`/usr/bin/nc -z -w 2 127.0.0.1 ${port} && echo CONNECTED; echo end`);
      assert.equal(result.stdout.trim(), "end", result.stdout + result.stderr);
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  ifUsable("a protected .git cannot be changed, removed or replaced, and the rest of the checkout stays writable", async () => {
    const r = recipe();
    mkdirSync(join(r.workdir, ".git"));
    writeFileSync(join(r.workdir, ".git", "config"), "original");
    const result = await run('for a in "echo x > .git/config" "echo x > .git/hooks" "rm -rf .git" "mv .git .git2" "echo x > .git/new"; do /bin/sh -c "$a" 2>/dev/null && echo "DID $a"; done; echo end', r);
    assert.equal(result.stdout.trim(), "end", result.stdout + result.stderr);
    assert.equal(readFileSync(join(r.workdir, ".git", "config"), "utf8"), "original");
    assert.equal(existsSync(join(r.workdir, ".git2")), false);
    assert.equal((await run('echo ok > "$PWD/file"', r)).exitCode, 0);
  });

  ifUsable("read-only inputs can be read and not changed", async () => {
    const tools = dir("tools"); writeFileSync(join(tools, "tool.txt"), "tool-text");
    const r = recipe({ readOnly: [{ host: tools, guest: "/inputs/tools" }] });
    const result = await run(`/bin/cat ${tools}/tool.txt; ( echo x > ${tools}/tool.txt ) 2>/dev/null && echo CHANGED; /bin/rm ${tools}/tool.txt 2>/dev/null && echo REMOVED; echo end`, r);
    assert.equal(result.stdout.trim(), "tool-text\nend", result.stdout + result.stderr);
    assert.equal(readFileSync(join(tools, "tool.txt"), "utf8"), "tool-text");
  });

  const marker = (): string => `${3000 + Math.floor(Math.random() * 9000)}.${Math.floor(Math.random() * 1e9)}`;
  ifUsable("a timeout ends the process and what it started, including a child that left the process group", async () => {
    const m = marker();
    const result = await run(`/bin/sleep ${m} & /usr/bin/perl -e 'use POSIX; POSIX::setsid(); exec "/bin/sleep", "${m}"' & wait`, recipe(), { timeoutMs: 1500 });
    assert.equal(result.timedOut, true);
    const { execFileSync } = await import("node:child_process");
    let left = "";
    for (let i = 0; i < 30; i++) { left = execFileSync("/bin/ps", ["-A", "-o", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`sleep ${m}`)).join("\n"); if (left === "") break; await new Promise((r) => setTimeout(r, 200)); }
    assert.equal(left, "", `processes survived:\n${left}`);
  });

  ifUsable("a process that left the run and whose parent then exited is found and ended when the run ends", async () => {
    const m = marker();
    // The parent starts the detached child, stays up long enough to be seen, and exits first.
    const result = await run(`/usr/bin/perl -e 'use POSIX; if (fork() == 0) { POSIX::setsid(); exec "/bin/sleep", "${m}" }' ; /bin/sleep 1.5`, recipe(), { timeoutMs: 20_000 });
    assert.equal(result.timedOut, false);
    const { execFileSync } = await import("node:child_process");
    let left = "";
    for (let i = 0; i < 30; i++) { left = execFileSync("/bin/ps", ["-A", "-o", "command="], { encoding: "utf8" }).split("\n").filter((l) => l.includes(`sleep ${m}`)).join("\n"); if (left === "") break; await new Promise((r) => setTimeout(r, 200)); }
    assert.equal(left, "", `processes survived:\n${left}`);
  });

  ifUsable("the agent's temporary directory must be a real directory, not a link someone left", async () => {
    const r = recipe();
    symlinkSync(secretDir, join(r.scratch, ".tmp"));
    await assert.rejects(launcher.launch({ recipe: r, command: ["/usr/bin/true"], timeoutMs: 5000, maxOutputBytes: 100 }), /not a plain directory/);
    assert.equal(existsSync(join(secretDir, "x")), false);
  });

  ifUsable("each launch is recorded as Seatbelt, and the agent is told where its directories are", async () => {
    const before = records.length;
    const r = recipe();
    const started = await launcher.launch({ recipe: r, command: ["/usr/bin/true"], timeoutMs: 5000, maxOutputBytes: 100 });
    await started.result;
    assert.equal(records.length, before + 1);
    assert.deepEqual([records.at(-1)!.mode, records.at(-1)!.backend], ["sandboxed", "seatbelt"]);
    assert.deepEqual([started.guest.workdir, started.guest.home, started.guest.scratch, started.guest.tmp], [r.workdir, r.home, r.scratch, join(r.scratch, ".tmp")]);
  });
});
