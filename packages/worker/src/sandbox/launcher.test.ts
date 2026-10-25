import assert from "node:assert/strict";
import { createServer, type Server } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import type { SandboxBackend } from "./backend.js";
import { SandboxError } from "./errors.js";
import { SandboxLauncher, type LaunchRecord, type RunResult } from "./launcher.js";
import type { SandboxRecipe } from "./recipe.js";
import { bubblewrapBackend } from "./linux.js";

// These tests start real confined processes. On a machine without bubblewrap they are skipped, unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in
// CI), where a missing or unusable sandbox is a failure: a green run must never mean "nothing was confined".
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";

const root = realpathSync(mkdtempSync(join(tmpdir(), "nn-sandbox-")));
after(() => rmSync(root, { recursive: true, force: true }));
const dir = (name: string): string => { const p = join(root, name); mkdirSync(p, { recursive: true }); return p; };

const secretDir = dir("controller-data");
const secretFile = join(secretDir, "controller.db");
writeFileSync(secretFile, "TOP-SECRET-CONTROLLER-DATABASE");
const fakeHome = dir("fake-home");
mkdirSync(join(fakeHome, ".ssh"));
writeFileSync(join(fakeHome, ".ssh", "id_nimblenewt_test"), "PRIVATE-KEY-MATERIAL");

let counter = 0;
function recipe(extra: Partial<SandboxRecipe> = {}): SandboxRecipe {
  const n = ++counter;
  return { mode: "sandboxed", workdir: dir(`work${n}`), home: dir(`home${n}`), scratch: dir(`scratch${n}`), readOnly: [], network: "none", env: {}, protectedSubpaths: [".git"], ...extra };
}

describe("sandbox launcher (bubblewrap)", () => {
  const records: LaunchRecord[] = [];
  let launcher: SandboxLauncher;
  let usable = false;
  const originalHome = process.env["HOME"];

  before(async () => {
    process.env["HOME"] = fakeHome; // the service user's credential places are looked up here
    process.env["NN_TEST_SECRET"] = "must-not-reach-the-agent";
    launcher = await SandboxLauncher.create({ protectedPaths: [secretDir], audit: (r) => { records.push(r); } });
    // This file's cases are written for the bubblewrap guest layout (/work, /home/agent); the macOS backend has its own file.
    usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap";
    if (!usable && required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`);
  });
  after(() => { if (originalHome === undefined) delete process.env["HOME"]; else process.env["HOME"] = originalHome; delete process.env["NN_TEST_SECRET"]; });

  const run = async (command: string[], r: SandboxRecipe = recipe(), limits: { timeoutMs?: number; maxOutputBytes?: number } = {}): Promise<RunResult> => {
    const started = await launcher.launch({ recipe: r, command, timeoutMs: limits.timeoutMs ?? 20_000, maxOutputBytes: limits.maxOutputBytes ?? 1_000_000 });
    return started.result;
  };
  const sh = (script: string, r?: SandboxRecipe, limits?: { timeoutMs?: number; maxOutputBytes?: number }): Promise<RunResult> => run(["/bin/sh", "-c", script], r, limits);
  const ifUsable = (name: string, fn: () => Promise<void>): void => { test(name, async (t) => { if (!usable) return t.skip(`bubblewrap unusable: ${launcher.capacity.reason}`); await fn(); }); };

  ifUsable("capacity is advertised only after a real confined start, and names the backend and version", async () => {
    assert.equal(launcher.capacity.available, true);
    assert.equal(launcher.capacity.backend, "bubblewrap");
    assert.match(launcher.capacity.version ?? "", /^\d+\.\d+/);
  });

  ifUsable("a command runs in /work with only the launcher's environment, and its writes land in the agent's own directories", async () => {
    const r = recipe({ env: { AGENT_NAME: "alice" } });
    const result = await sh("pwd; env | sort; echo hello > /work/out.txt; echo h > /home/agent/h.txt; echo s > /scratch/s.txt", r);
    assert.equal(result.exitCode, 0, result.stderr);
    const lines = result.stdout.trim().split("\n");
    assert.equal(lines[0], "/work");
    const env = lines.slice(1).filter((l) => /^[A-Z_]+=/.test(l)).map((l) => l.split("=")[0]);
    assert.deepEqual(env.filter((n) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(n!)), ["AGENT_NAME", "HOME", "PATH", "TMPDIR"]);
    assert.ok(!result.stdout.includes("must-not-reach-the-agent"));
    assert.equal(readFileSync(join(r.workdir, "out.txt"), "utf8"), "hello\n");
    assert.equal(readFileSync(join(r.home, "h.txt"), "utf8"), "h\n");
    assert.equal(readFileSync(join(r.scratch, "s.txt"), "utf8"), "s\n");
  });

  ifUsable("standard input carries the request's data and is then closed; without it the program reads end-of-file at once", async () => {
    const started = await launcher.launch({ recipe: recipe(), command: ["/bin/sh", "-c", "cat; echo; echo end"], timeoutMs: 20_000, maxOutputBytes: 1_000_000, stdin: "line one\n\"; echo INJECTED #\n" });
    const withInput = await started.result;
    assert.equal(withInput.stdout, "line one\n\"; echo INJECTED #\n\nend\n", "the text is data: nothing in it ran");
    const without = await run(["/bin/sh", "-c", "cat; echo end"]);
    assert.equal(without.stdout, "end\n");
    await assert.rejects(launcher.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 1000, stdin: "x".repeat(1024 * 1024 + 1) }), /stdin: text of at most 1 MiB/);
    // A program that never reads its input does not hang or fail the launcher.
    const ignoring = await launcher.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 20_000, maxOutputBytes: 1000, stdin: "y".repeat(500_000) });
    assert.equal((await ignoring.result).exitCode, 0);
  });

  ifUsable("writes outside the workspace are denied: system directories, the root, and paths that exist only on the host", async () => {
    const result = await sh(`for p in /usr/x /bin/x /etc/x /x /proc/x /dev/x /inputs/x ${secretDir}/x; do ( : > "$p" ) 2>/dev/null && echo "WROTE $p"; done; echo finished`);
    assert.equal(result.stdout.trim(), "finished");
    assert.equal(existsSync(join(secretDir, "x")), false);
  });

  ifUsable("host paths that were not mounted are invisible: the controller's data and the service user's credentials", async () => {
    // A decoy with the secret's name inside the agent's own scratch is the positive control: the search must find that one and nothing else.
    const r = recipe();
    writeFileSync(join(r.scratch, "controller.db"), "decoy");
    const result = await sh(`cat ${secretFile} 2>&1; ls ${secretDir} 2>&1; ls ${root} 2>&1; cat ${fakeHome}/.ssh/id_nimblenewt_test 2>&1; echo found:; find / \\( -path /proc -o -path /sys -o -path /usr -o -path /dev \\) -prune -o \\( -name 'id_nimblenewt_test' -o -name controller.db \\) -print 2>/dev/null; echo end`, r);
    assert.ok(!result.stdout.includes("TOP-SECRET") && !result.stdout.includes("PRIVATE-KEY"), result.stdout);
    assert.match(result.stdout, /No such file or directory/);
    assert.equal(result.stdout.split("found:\n")[1]?.trim(), "/scratch/controller.db\nend", result.stdout);
  });

  ifUsable("a symbolic link in the checkout cannot lead out of the sandbox", async () => {
    const r = recipe();
    symlinkSync(secretFile, join(r.workdir, "to-secret"));
    symlinkSync(secretDir, join(r.workdir, "to-dir"));
    symlinkSync("../../../../../../../etc", join(r.workdir, "to-etc"));
    symlinkSync("/proc/1/root", join(r.workdir, "to-proc-root"));
    const result = await sh(`cat /work/to-secret 2>&1; ls /work/to-dir 2>&1; ls /work/to-etc/shadow 2>&1; ls /work/to-proc-root/home 2>&1; echo end`, r);
    assert.ok(!result.stdout.includes("TOP-SECRET"), result.stdout);
    assert.ok(!result.stdout.includes("controller.db"), result.stdout);
    assert.ok(result.stdout.trim().endsWith("end"));
    // The agent cannot move a link target either: replacing the link inside /work touches only /work.
    const again = await sh(`rm /work/to-secret && echo gone > /work/to-secret`, r);
    assert.equal(again.exitCode, 0);
    assert.equal(readFileSync(secretFile, "utf8"), "TOP-SECRET-CONTROLLER-DATABASE");
    assert.equal(readlinkSync(join(r.workdir, "to-dir")), secretDir);
  });

  ifUsable("there is no network: the host's loopback server is unreachable and only the loopback device exists", async () => {
    const server: Server = createServer((socket) => { socket.end("HOST-SERVICE"); });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    try {
      const result = await sh(`tail -n +3 /proc/net/dev | cut -d: -f1 | tr -d ' '; (exec 3<>/dev/tcp/127.0.0.1/${port}; cat <&3) 2>&1 | head -c 100; echo; echo end`);
      assert.ok(!result.stdout.includes("HOST-SERVICE"), result.stdout);
      assert.equal(result.stdout.trim().split("\n")[0], "lo");
    } finally { await new Promise<void>((resolve) => server.close(() => resolve())); }
  });

  ifUsable("the agent sees only its own processes, and /tmp is private to each run", async () => {
    const result = await run(["/bin/sh", "-c", `[ ! -d /proc/${process.pid} ] && echo host-pid-hidden; ls /proc | grep -c '^[0-9]'; : > /tmp/left-behind`]);
    assert.match(result.stdout, /host-pid-hidden/);
    assert.ok(Number(result.stdout.trim().split("\n").pop()) <= 5, result.stdout);
    const next = await sh("test -e /tmp/left-behind && echo FOUND; echo end");
    assert.equal(next.stdout.trim(), "end");
  });

  ifUsable("the agent cannot create a nested user namespace", async () => {
    const result = await sh(`unshare -r /bin/true 2>&1 && echo NESTED; unshare -U /bin/true 2>&1 && echo NESTED2; echo end`);
    assert.ok(!result.stdout.includes("NESTED"), result.stdout);
    assert.ok(result.stdout.trim().endsWith("end"));
  });

  ifUsable("a protected name swapped for a link before the start is refused, not bound", async () => {
    const r = recipe();
    mkdirSync(join(r.workdir, ".git"));
    const { normalizeRecipe } = await import("./recipe.js");
    const normalized = normalizeRecipe(r, []);
    rmSync(join(r.workdir, ".git"), { recursive: true });
    symlinkSync(secretDir, join(r.workdir, ".git"));
    assert.throws(() => bubblewrapBackend().plan(normalized, ["/bin/true"]), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe" && /changed to point/.test(e.message));
  });

  ifUsable("a protected .git inside the checkout cannot be changed, removed or replaced", async () => {
    const r = recipe();
    mkdirSync(join(r.workdir, ".git"));
    writeFileSync(join(r.workdir, ".git", "config"), "original");
    const result = await sh(`for a in "echo x > /work/.git/config" "echo x > /work/.git/hooks" "rm -rf /work/.git" "mv /work/.git /work/.git2" "chmod 777 /work/.git" "ln -s /x /work/.git/link"; do sh -c "$a" 2>/dev/null && echo "DID $a"; done; echo end`, r);
    assert.equal(result.stdout.trim(), "end");
    assert.equal(readFileSync(join(r.workdir, ".git", "config"), "utf8"), "original");
    assert.equal(existsSync(join(r.workdir, ".git2")), false);
    // The rest of the checkout stays writable.
    assert.equal((await sh("echo ok > /work/file", r)).exitCode, 0);
  });

  ifUsable("read-only inputs can be read and not changed", async () => {
    const tools = dir("tools"); writeFileSync(join(tools, "tool.sh"), "#!/bin/sh\necho tool-ran\n");
    const r = recipe({ readOnly: [{ host: tools, guest: "/inputs/tools" }] });
    const result = await sh(`cat /inputs/tools/tool.sh; ( echo x > /inputs/tools/tool.sh ) 2>/dev/null && echo CHANGED; rm /inputs/tools/tool.sh 2>/dev/null && echo REMOVED; echo end`, r);
    assert.match(result.stdout, /tool-ran/);
    assert.ok(result.stdout.trim().endsWith("end") && !/CHANGED|REMOVED/.test(result.stdout));
    assert.match(readFileSync(join(tools, "tool.sh"), "utf8"), /tool-ran/);
  });

  const marker = (): string => `${3000 + Math.floor(Math.random() * 9000)}.${Math.floor(Math.random() * 1e9)}`;
  const survivors = (m: string): string[] => readdirSync("/proc").filter((p) => /^\d+$/.test(p)).filter((p) => { try { return readFileSync(`/proc/${p}/cmdline`, "utf8").includes(`sleep\0${m}`); } catch { return false; } });
  const gone = async (m: string): Promise<boolean> => { for (let i = 0; i < 50; i++) { if (survivors(m).length === 0) return true; await new Promise((r) => setTimeout(r, 100)); } return false; };

  ifUsable("a timeout kills the process and everything it started", async () => {
    const m = marker();
    const result = await sh(`sleep ${m} & sleep ${m} & sleep ${m}`, recipe(), { timeoutMs: 700 });
    assert.equal(result.timedOut, true);
    assert.equal(result.killed, false);
    assert.ok(await gone(m), `processes survived: ${survivors(m)}`);
  });

  ifUsable("kill() ends the whole tree and reports it as killed", async () => {
    const m = marker();
    const started = await launcher.launch({ recipe: recipe(), command: ["/bin/sh", "-c", `sleep ${m} & sleep ${m}; wait`], timeoutMs: 30_000, maxOutputBytes: 1000 });
    for (let i = 0; i < 50 && survivors(m).length < 2; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(survivors(m).length, 2, "the tree did not start");
    started.kill(); started.kill();
    const result = await started.result;
    assert.equal(result.killed, true);
    assert.equal(result.timedOut, false);
    assert.ok(await gone(m), `processes survived: ${survivors(m)}`);
  });

  ifUsable("output is bounded and reported as truncated", async () => {
    const result = await sh(`yes abcdefghij | head -c 100000; yes errerrerr | head -c 100000 >&2`, recipe(), { maxOutputBytes: 1000 });
    assert.equal(result.stdout.length, 1000);
    assert.equal(result.stderr.length, 1000);
    assert.equal(result.truncated, true);
    assert.equal((await sh("echo small")).truncated, false);
  });

  ifUsable("every launch is recorded before it starts: mode, backend, recipe revision and a command digest, not the command", async () => {
    const before = records.length;
    const r = recipe({ env: { K: "v" } });
    const started = await launcher.launch({ recipe: r, command: ["/bin/sh", "-c", "echo SECRET-ARGUMENT-IN-COMMAND"], timeoutMs: 5000, maxOutputBytes: 1000 });
    await started.result;
    const record = records[records.length - 1]!;
    assert.equal(records.length, before + 1);
    assert.equal(record.mode, "sandboxed");
    assert.equal(record.backend, "bubblewrap");
    assert.equal(record.recipeRevision, started.recipeRevision);
    assert.match(record.commandDigest, /^[0-9a-f]{64}$/);
    assert.equal(record.runId, started.runId);
    assert.ok(!JSON.stringify(record).includes("SECRET-ARGUMENT"));
    assert.deepEqual(record.unprotectedSubpaths, [".git"]);
    const again = await launcher.launch({ recipe: r, command: ["/bin/true"], timeoutMs: 5000, maxOutputBytes: 1000 });
    await again.result;
    assert.equal(again.recipeRevision, started.recipeRevision);
  });

  ifUsable("if the launch cannot be recorded it does not happen", async () => {
    const failing = await SandboxLauncher.create({ protectedPaths: [secretDir], audit: () => { throw new Error("audit store is down"); } });
    const r = recipe();
    await assert.rejects(failing.launch({ recipe: r, command: ["/bin/sh", "-c", "echo x > /work/ran"], timeoutMs: 5000, maxOutputBytes: 1000 }), (e: unknown) => e instanceof SandboxError && e.code === "audit_failed");
    assert.equal(existsSync(join(r.workdir, "ran")), false);
  });

  ifUsable("the supervisor's own files cannot be put inside anything the agent can write", async () => {
    const supervisor = realpathSync(new URL("../../", import.meta.url).pathname.replace(/\/$/, ""));
    for (const bad of [{ workdir: supervisor }, { home: join(supervisor, "dist") }, { scratch: realpathSync(join(supervisor, "..")) }]) {
      await assert.rejects(launcher.launch({ recipe: recipe(bad), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe");
    }
    await assert.rejects(launcher.launch({ recipe: recipe({ workdir: secretDir }), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe");
    await assert.rejects(launcher.launch({ recipe: recipe({ workdir: join(fakeHome, ".ssh") }), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe");
    await assert.rejects(launcher.launch({ recipe: recipe({ scratch: fakeHome }), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe");
  });

  ifUsable("a request is checked before anything starts", async () => {
    const bad = [
      { command: [], timeoutMs: 1000, maxOutputBytes: 100 }, { command: ["relative"], timeoutMs: 1000, maxOutputBytes: 100 },
      { command: ["/bin/true"], timeoutMs: 0, maxOutputBytes: 100 }, { command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 0 },
      { command: ["/bin/true"], timeoutMs: 1.5, maxOutputBytes: 100 }, { command: ["/bin/true", "a\0b"], timeoutMs: 1000, maxOutputBytes: 100 },
    ];
    for (const b of bad) await assert.rejects(launcher.launch({ recipe: recipe(), ...b }), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe");
  });

  ifUsable("trusted-host mode needs the owner's configured authority, is recorded as such, and is still checked like any recipe", async () => {
    const r = recipe({ mode: "trusted-host" });
    await assert.rejects(launcher.launch({ recipe: r, command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "not_authorized");
    const trusted: LaunchRecord[] = [];
    const host = await SandboxLauncher.create({ protectedPaths: [secretDir], trustedHost: { authority: "owner decision 2026-10-21" }, audit: (x) => { trusted.push(x); } });
    const started = await host.launch({ recipe: r, command: ["/bin/sh", "-c", "pwd; echo \"[$NN_TEST_SECRET]\"; cat " + secretFile], timeoutMs: 5000, maxOutputBytes: 1000 });
    const result = await started.result;
    assert.equal(trusted[0]!.mode, "trusted-host");
    assert.equal(trusted[0]!.backend, "trusted-host");
    assert.equal(trusted[0]!.authority, "owner decision 2026-10-21");
    // Unconfined, so the host file is readable — which is exactly why the mode is explicit and recorded — but the environment is still not inherited.
    assert.equal(result.stdout.split("\n")[0], r.workdir);
    assert.match(result.stdout, /\[\]/);
    assert.match(result.stdout, /TOP-SECRET/);
    await assert.rejects(host.launch({ recipe: recipe({ mode: "trusted-host", workdir: secretDir }), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "invalid_recipe");
    await assert.rejects(SandboxLauncher.create({ protectedPaths: [], trustedHost: { authority: " " }, audit: () => {} }).then((l) => l.launch({ recipe: r, command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 })), (e: unknown) => e instanceof SandboxError && e.code === "not_authorized");
  });

  ifUsable("stop() kills what is running and refuses new launches", async () => {
    const own = await SandboxLauncher.create({ protectedPaths: [secretDir], audit: () => {} });
    const started = await own.launch({ recipe: recipe(), command: ["/bin/sh", "-c", "sleep 300"], timeoutMs: 60_000, maxOutputBytes: 100 });
    await own.stop();
    assert.equal((await started.result).killed, true);
    await assert.rejects(own.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "unavailable");
  });
});

describe("failing closed", () => {
  const audited: LaunchRecord[] = [];
  const audit = (r: LaunchRecord): void => { audited.push(r); };

  test("without bubblewrap there is no capacity, the reason says what to do, and nothing runs unconfined instead", async () => {
    const launcher = await SandboxLauncher.create({ backend: bubblewrapBackend({ executable: "/nonexistent/bwrap" }), protectedPaths: [], audit });
    assert.equal(launcher.capacity.available, false);
    assert.match(launcher.capacity.reason ?? "", /not installed/);
    const r = recipe();
    await assert.rejects(launcher.launch({ recipe: r, command: ["/bin/sh", "-c", "echo x > /work/ran"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "unavailable");
    assert.equal(existsSync(join(r.workdir, "ran")), false);
    assert.equal(audited.length, 0);
  });

  test("an OS with no backend yet has no capacity; macOS has Seatbelt, which a machine without it cannot use", async () => {
    const windows = await SandboxLauncher.create({ platform: "win32", protectedPaths: [], audit });
    assert.equal(windows.capacity.available, false);
    assert.match(windows.capacity.reason ?? "", /no sandbox backend for win32/);
    await assert.rejects(windows.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 1000, maxOutputBytes: 100 }), (e: unknown) => e instanceof SandboxError && e.code === "unavailable");
    // Asking for the macOS backend on a machine that is not a Mac finds no sandbox-exec and so no capacity.
    if (process.platform !== "darwin") {
      const mac = await SandboxLauncher.create({ platform: "darwin", protectedPaths: [], audit });
      assert.deepEqual([mac.capacity.available, mac.capacity.backend], [false, "seatbelt"]);
      assert.match(mac.capacity.reason ?? "", /not found/);
    }
  });

  test("a remembered process is ended only if it is still the one that was seen: a reused process id is left alone", async () => {
    const { spawn } = await import("node:child_process");
    const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch { return false; } };
    // Stand-in "descendants": real, harmless, long-lived processes that the test starts itself (the same on every OS).
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    const sameOne = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" });
    try {
      for (const [process_, shown, expectKilled] of [[bystander, "some other start time", false], [sameOne, "seen at the start", true]] as const) {
        const backend: SandboxBackend = {
          name: "fake-tracking", health: async () => ({ healthy: true, backend: "fake-tracking" }),
          plan: () => ({ file: process.execPath, args: ["-e", "setTimeout(() => {}, 700)"], env: {} }),
          guestView: () => ({ workdir: "/w", home: "/h", scratch: "/s", tmp: "/t", inputs: [] }),
          descendants: async () => [{ pid: process_.pid!, started: "seen at the start" }],
          startTimes: async (pids) => new Map(pids.map((p) => [p, shown])),
        };
        const launcher = await SandboxLauncher.create({ backend, protectedPaths: [], audit });
        const result = await (await launcher.launch({ recipe: recipe(), command: ["/bin/true"], timeoutMs: 20_000, maxOutputBytes: 100 })).result;
        assert.equal(result.exitCode, 0);
        await new Promise((r) => setTimeout(r, 200));
        assert.equal(alive(process_.pid!), !expectKilled, `process ${process_.pid} killed=${!alive(process_.pid!)} expected ${expectKilled}`);
      }
    } finally { bystander.kill("SIGKILL"); sameOne.kill("SIGKILL"); }
  });

  test("a backend whose health check fails or throws gives no capacity, and recheck picks up recovery", async () => {
    let healthy = false;
    const backend: SandboxBackend = { name: "fake", health: async () => (healthy ? { healthy: true, backend: "fake" } : { healthy: false, backend: "fake", reason: "probe failed" }), plan: () => ({ file: "/bin/true", args: [], env: {} }), guestView: () => ({ workdir: "/w", home: "/h", scratch: "/s", tmp: "/t", inputs: [] }) };
    const launcher = await SandboxLauncher.create({ backend, protectedPaths: [], audit });
    assert.deepEqual([launcher.capacity.available, launcher.capacity.reason], [false, "probe failed"]);
    healthy = true;
    assert.equal((await launcher.recheck()).available, true);
    const throwing: SandboxBackend = { ...backend, health: async () => { throw new Error("boom"); } };
    const broken = await SandboxLauncher.create({ backend: throwing, protectedPaths: [], audit });
    assert.match(broken.capacity.reason ?? "", /boom/);
  });

  test("the bubblewrap plan unshares everything, clears the environment, binds the checkout before its protected names, and mounts nothing else of the host", () => {
    const r = recipe();
    mkdirSync(join(r.workdir, ".git"));
    const normalized = SandboxLauncherPlanHelper(r);
    const args = normalized.args;
    for (const flag of ["--unshare-all", "--die-with-parent", "--new-session", "--clearenv", "--remount-ro"]) assert.ok(args.includes(flag), flag);
    assert.ok(!args.includes("--share-net") && !args.includes("--unshare-all-try") && !args.includes("--dev-bind"));
    const binds: string[] = [];
    for (let i = 0; i < args.length; i++) if (args[i] === "--bind" || args[i] === "--ro-bind") binds.push(`${args[i]} ${args[i + 1]} ${args[i + 2]}`);
    const hostSources = binds.map((b) => b.split(" ")[1]!).filter((p) => !["/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32"].includes(p));
    assert.deepEqual(hostSources.sort(), [r.workdir, r.home, r.scratch, join(r.workdir, ".git")].sort());
    assert.ok(binds.indexOf(`--bind ${r.workdir} /work`) < binds.indexOf(`--ro-bind ${join(r.workdir, ".git")} /work/.git`));
    assert.deepEqual(normalized.env, {});
  });
});

function SandboxLauncherPlanHelper(r: SandboxRecipe): { args: readonly string[]; env: Readonly<Record<string, string>> } {
  // Plans through the same normalisation the launcher applies.
  const backend = bubblewrapBackend();
  return backend.plan(normalizeForPlan(r), ["/bin/true"]);
}
import { normalizeRecipe } from "./recipe.js";
const normalizeForPlan = (r: SandboxRecipe) => normalizeRecipe(r, []);
