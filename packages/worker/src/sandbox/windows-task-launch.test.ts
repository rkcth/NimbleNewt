// Card wsb-repair: the scheduled-task launch of every `wsb` command, the child the task runs, and the runner's own group in the G05 base-folder access check. Everything runs on every OS
// with the launcher injected (the helper is played by a fake that does what the real one does: it runs the real child on the request); what only Windows can show (the task itself, the
// real `wsb`) is recorded by the next own-hardware run.
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, test } from "node:test";
import type { ProcessResult, WindowsHost } from "./windows-host.js";
import { runWsbCommand, withRun } from "./windows-host.js";
import { listSandboxes } from "./windows-list.js";
import { main as childMain, readRequest } from "./windows-task-child.js";
import { CHECK_MS, CHILD_MARGIN_MS, HELPER_OVERHEAD_MS, MAX_REQUEST_MS, wsbTaskBase, HELPER_SCRIPT, START_GRACE_MS, launchWsb, parseMode, runViaScheduledTask, type TaskLaunchDeps, type TaskOutcome } from "./windows-task-launch.js";
import { recordDirProblem, redactedWriters } from "./windows-records.js";

const root = mkdtempSync(join(process.env["TMPDIR"] ?? tmpdir(), "nn-tl-"));
after(() => { rmSync(root, { recursive: true, force: true }); });
let n = 0;
const fresh = (): string => { const d = join(root, `t${String(++n)}`); mkdirSync(d); return d; };
const NODE = process.execPath;
const direct = (code = 0): ProcessResult => ({ code, stdout: "direct", stderr: "", timedOut: false });

interface Calls { private: string[]; run: { file: string; args: readonly string[]; timeoutMs: number; env?: Record<string, string> }[] }
interface FakeOptions {
  /** What the helper does: `child` runs the real child (a task that began), the others stand for the failures. */
  helper?: "child" | "ended-unclaimed" | "no-register" | "no-start" | "no-begin" | "crash" | "hang" | "hang-claimed" | "claimed-not-begun" | "stopped-after-begin" | "no-code" | "late-begin";
  request?: { file: string; args: string[] };
  privateProblem?: string;
  /** Only the base folder has the problem (the call folder is fine). */
  privateBaseOnly?: boolean;
  taskStillThere?: boolean;
}

/** Deps on a real temporary folder, with the helper played by a fake that does what the real one does (it runs the real child on the request). */
function realDeps(opt: FakeOptions = {}): { deps: TaskLaunchDeps; calls: Calls; base: string; written: Record<string, unknown>[] } {
  const base = fresh();
  const written: Record<string, unknown>[] = [];
  const calls: Calls = { private: [], run: [] };
  const sep = process.platform === "win32" ? "\\" : "/";
  const deps: TaskLaunchDeps = {
    sysRoot: "C:\\Windows", nodePath: NODE, childScript: "C:\\app\\windows-task-child.js", baseDir: base,
    randomHex: () => "0123456789ab",
    mkdirp: (d) => { mkdirSync(d.replaceAll("\\", sep), { recursive: true }); },
    exists: (f) => existsSync(f.replaceAll("\\", sep)),
    readText: (f) => { try { return readFileSync(f.replaceAll("\\", sep), "utf8"); } catch { return undefined; } },
    writeText: (f, text) => { writeFileSync(f.replaceAll("\\", sep), text); },
    remove: (d) => { rmSync(d.replaceAll("\\", sep), { recursive: true, force: true }); },
    rename: (a, b) => { renameSync(a.replaceAll("\\", sep), b.replaceAll("\\", sep)); },
    privateProblem: async (d) => { calls.private.push(d); return opt.privateProblem !== undefined && (opt.privateBaseOnly !== true || d === base) ? opt.privateProblem : undefined; },
    run: async (file, args, o) => {
      calls.run.push({ file, args, timeoutMs: o.timeoutMs, ...(o.env === undefined ? {} : { env: o.env }) });
      if (/powershell\.exe$/.test(file)) {
        const dir = o.env!["NN_DIR"]!.replaceAll("\\", sep);
        const w = (name: string, text: string): void => { writeFileSync(join(dir, name), text); };
        const answer = (a: object): void => w("task.json", JSON.stringify({ registered: true, started: true, began: false, finished: false, ended: false, stopped: false, removed: true, elapsedMs: 5, error: null, ...a }));
        switch (opt.helper ?? "child") {
          case "no-register": answer({ registered: false, started: false, error: 2147942402 }); break;
          case "no-start": answer({ started: false, error: 2147750687 }); break;
          case "no-begin": answer({ stopped: true }); break;
          // The task ran and ended (the child exited at once, for example its claim failed) without claiming the request: nothing began.
          case "ended-unclaimed": answer({ ended: true }); break;
          case "crash": break;
          case "hang": return { code: null, stdout: "", stderr: "", timedOut: true };
          // The child claimed the request (renamed in.json) but had not yet written started.txt when the helper gave up or hung: it may run, so it counts as begun.
          case "hang-claimed": renameSync(join(dir, "in.json"), join(dir, "claimed.json")); return { code: null, stdout: "", stderr: "", timedOut: true };
          case "claimed-not-begun": renameSync(join(dir, "in.json"), join(dir, "claimed.json")); answer({ began: false, stopped: true }); break;
          case "stopped-after-begin": w("started.txt", "1"); w("out.txt", "partial"); answer({ began: true, stopped: true }); break;
          // The helper gave up waiting and said the task never began, but the child wrote its marker just after: it began, so no direct call may follow.
          case "late-begin": w("started.txt", "1"); answer({ began: false, stopped: true }); break;
          case "no-code": w("started.txt", "1"); answer({ began: true, ended: true }); break;
          default: {
            // What the launcher wrote is kept for the tests; the program is swapped for one that exists here (the real `wsb` does not), the rest of the request is the launcher's.
            written.push(JSON.parse(readFileSync(join(dir, "in.json"), "utf8")) as Record<string, unknown>);
            const req = opt.request ?? { file: NODE, args: ["-e", "process.stdout.write('hello');process.stderr.write('warn');process.exit(0)"] };
            w("in.json", JSON.stringify({ ...req, timeoutMs: 20_000 }));
            assert.equal(await childMain(dir), 0);
            answer({ began: true, finished: true });
          }
        }
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      if (/schtasks\.exe$/.test(file)) return { code: args[0] === "/Query" ? (opt.taskStillThere === true ? 0 : 1) : 0, stdout: "", stderr: "", timedOut: false };
      throw new Error(`unexpected ${file}`);
    },
  };
  return { deps, calls, base, written };
}

const REQ = { file: "C:\\wsb.exe", args: ["list", "--raw"], cwd: "C:\\inst", timeoutMs: 30_000 };
const done = (o: TaskOutcome): ProcessResult => { assert.equal(o.kind, "done", JSON.stringify(o)); return (o as { result: ProcessResult }).result; };
const why = (o: TaskOutcome): string => { assert.equal(o.kind, "unavailable"); return (o as { why: string }).why; };

describe("the scheduled-task launch", () => {
  test("a command that answers: the real child runs the request and its exit code, output and error text come back; the folder and task are gone; one helper call, no retry", async () => {
    const { deps, calls, base, written } = realDeps();
    // The fake helper runs the real child with a stand-in program for `wsb` (the request's own program does not exist off Windows).
    const r = done(await runViaScheduledTask(deps, REQ));
    assert.deepEqual(written, [{ file: "C:\\wsb.exe", args: ["list", "--raw"], cwd: "C:\\inst", timeoutMs: 30_000 }], "the request the launcher wrote: program, argument list, folder and limit, as data");
    assert.deepEqual([r.code, r.stdout, r.stderr, r.timedOut], [0, "hello", "warn", false]);
    assert.match(r.via ?? "", /one-shot scheduled task in the signed-in session/);
    assert.equal(calls.run.filter((c) => /powershell\.exe$/.test(c.file)).length, 1, "the helper (which registers and starts the task) is run once");
    assert.deepEqual(readdirSync(base), [], "the private call folder is removed");
    assert.deepEqual(calls.run.filter((c) => /schtasks/.test(c.file)).map((c) => c.args[0]), ["/Query"], "the task is gone: queried once, not deleted again");
  });

  test("the exit code is the command's whole 32-bit code (2148734208 is not a signed number), and a failing command is a failure with its text", async () => {
    const { deps } = realDeps({ request: { file: NODE, args: ["-e", "process.stderr.write('Grpc deadline');process.exit(3)"] } });
    const r = done(await runViaScheduledTask(deps, REQ));
    assert.deepEqual([r.code, r.stderr, r.timedOut], [3, "Grpc deadline", false]);
    // The child writes the unsigned form of any code.
    assert.equal(String(2148734208 >>> 0), "2148734208");
    assert.equal(String(-2146233088 >>> 0), "2148734208");
  });

  test("the helper's text is fixed and it gets its names only through the environment (nothing is spliced into it)", async () => {
    const { deps, calls } = realDeps();
    await runViaScheduledTask(deps, { ...REQ, args: ["start", "--config", "<Configuration>\"%x%\" & | ^</Configuration>"] });
    const helper = calls.run.find((c) => /powershell/.test(c.file))!;
    assert.deepEqual(helper.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
    assert.equal(helper.args[5], HELPER_SCRIPT);
    assert.deepEqual(Object.keys(helper.env!).sort(), ["NN_CHILD", "NN_DIR", "NN_LIMIT_MS", "NN_MARGIN_MS", "NN_NODE", "NN_OUT", "NN_START_MS", "NN_TASK"]);
    assert.match(helper.env!["NN_TASK"]!, /^NimbleNewtWsb-[0-9a-f]{12}$/);
  });

  test("the request is written exactly as given (quotes, percent signs and XML survive: the child uses an argument list)", async () => {
    const args = ["start", "--config", "<C a=\"1\">%PATH% & | ^ \"q\"</C>"];
    const { deps, written } = realDeps({ request: { file: NODE, args: ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args] } });
    const r = done(await runViaScheduledTask(deps, { ...REQ, args }));
    assert.deepEqual((written[0] as { args: string[] }).args, args);
    assert.deepEqual(JSON.parse(r.stdout), args);
  });

  test("the task could not be registered or started: nothing ran, so a direct call is allowed, with the reason", async () => {
    for (const [helper, text] of [["no-register", /could not be registered \(error 0x80070002\)/], ["no-start", /registered but could not be started \(error 0x8004131f\)/], ["no-begin", /did not begin within 20 s/], ["ended-unclaimed", /the task ended before the command began/], ["crash", /helper could not run/], ["hang", new RegExp(`helper did not report within ${String((30_000 + HELPER_OVERHEAD_MS) / 1000)} s and was stopped before the command began`)]] as const) {
      const { deps, base } = realDeps({ helper });
      const o = await runViaScheduledTask(deps, REQ);
      assert.match(why(o), text, helper);
      assert.deepEqual(readdirSync(base), [], `${helper}: the folder is removed`);
    }
  });

  test("once the command began, there is never a direct call: not when the task was stopped, not when it ended with no exit code, not when the helper hung", async () => {
    for (const helper of ["stopped-after-begin", "no-code", "hang-claimed", "late-begin", "claimed-not-begun"] as const) {
      const { deps } = realDeps({ helper });
      let directCalls = 0;
      const r = await launchWsb("auto", () => runViaScheduledTask(deps, REQ), async () => { directCalls++; return direct(); });
      assert.equal(directCalls, 0, helper);
      assert.equal(r.code, null, helper);
      assert.ok(/did not end within|ended without reporting|cannot be said whether the command ran/.test(r.stderr), `${helper}: ${r.stderr}`);
      assert.doesNotMatch(r.stderr, /[A-Za-z]:\\|call-0123|NimbleNewtWsb-/, helper);
    }
  });

  test("a stopped command is a timeout with its partial output; the text is plain and holds no path, folder or account", async () => {
    const { deps } = realDeps({ helper: "stopped-after-begin" });
    const r = done(await runViaScheduledTask(deps, { ...REQ, cwd: "C:\\Users\\someone\\inst" }));
    assert.equal(r.timedOut, true);
    assert.match(r.stderr, /did not end within 30 s and was stopped/);
    assert.equal(r.stdout, "partial");
    for (const text of [r.stderr, r.via ?? ""]) assert.doesNotMatch(text, /[A-Za-z]:\\|someone|call-0123|NimbleNewtWsb-/);
  });

  test("the folder is checked before anything is run: a folder that is not believed private (or a name the task cannot take) means no helper at all", async () => {
    const a = realDeps({ privateProblem: "another account can change it" });
    assert.match(why(await runViaScheduledTask(a.deps, REQ)), /not believed private \(another account can change it\)/);
    assert.equal(a.calls.run.length, 0);
    const b = realDeps();
    assert.match(why(await runViaScheduledTask({ ...b.deps, nodePath: 'C:\\x"y\\node.exe' }, REQ)), /could not take safely/);
    assert.match(why(await runViaScheduledTask({ ...b.deps, randomHex: () => "zz" }, REQ)), /unexpected call name/);
    assert.equal(b.calls.run.length, 0);
  });

  test("a task that is still there afterwards is deleted; schtasks is asked once to look and once to delete, never more, and the helper is never run twice", async () => {
    const { deps, calls } = realDeps({ taskStillThere: true });
    done(await runViaScheduledTask(deps, REQ));
    assert.deepEqual(calls.run.filter((c) => /schtasks/.test(c.file)).map((c) => c.args[0]), ["/Query", "/End", "/Delete"]);
    assert.equal(calls.run.filter((c) => /powershell/.test(c.file)).length, 1);
    assert.ok(calls.run.filter((c) => /schtasks/.test(c.file)).every((c) => c.timeoutMs === CHECK_MS));
  });

  test("hard limits: the helper's own limit is the command's plus a fixed overhead; the helper text stops the task at its limit and when it never begins, and always removes it in finally", async () => {
    const { deps, calls } = realDeps();
    done(await runViaScheduledTask(deps, REQ));
    assert.equal(calls.run.find((c) => /powershell/.test(c.file))!.timeoutMs, 30_000 + HELPER_OVERHEAD_MS);
    assert.equal(calls.run.find((c) => /powershell/.test(c.file))!.env!["NN_START_MS"], String(START_GRACE_MS));
    assert.match(HELPER_SCRIPT, /finally \{\n  if \(\$r\.registered\) \{ try \{ Unregister-ScheduledTask/);
    assert.match(HELPER_SCRIPT, /Stop-ScheduledTask -TaskName \$name/);
    // Run level: measured on the owner's PC, an elevated-level task never answered while a Limited one did; the minimum level is the only one used.
    assert.match(HELPER_SCRIPT, /-LogonType Interactive -RunLevel Limited/);
    assert.equal((HELPER_SCRIPT.match(/-RunLevel/g) ?? []).length, 1);
    assert.doesNotMatch(HELPER_SCRIPT, /Highest/i);
    assert.match(HELPER_SCRIPT, /DeleteExpiredTaskAfter = 'PT0S'/);
    // The automatic deletion never comes before the command's own limit (exec runs for hours), and a failed look at the task does not end the wait.
    assert.match(HELPER_SCRIPT, /EndBoundary = \(Get-Date\)\.AddMilliseconds\(\$limit \+ 600000\)/);
    assert.match(HELPER_SCRIPT, /\$over = \$false\n    try \{\n[^]*?\} catch \{ \}\n    if \(\$over\) \{ \$r\.ended = \$true; break \}/);
    assert.match(HELPER_SCRIPT, /\$sw\.ElapsedMilliseconds -ge \$grace/);
    assert.doesNotMatch(HELPER_SCRIPT, /\$\{|\bInvoke-Expression\b|\biex\b/);
  });

  test("an unexpected error while the command may have run is reported as such, with no direct call", async () => {
    const real = realDeps();
    const deps = { ...real.deps, run: async (): Promise<ProcessResult> => { throw new Error("boom with C:\\secret\\path"); } };
    // The helper could not run at all: nothing began, so this is the "unavailable" case; a thrown error after the folder was removed must not leak its text either.
    const o = await runViaScheduledTask(deps, REQ);
    assert.equal(o.kind, "unavailable");
    assert.doesNotMatch(JSON.stringify(o), /secret/);
  });
});

describe("the scheduled-task launch: claim, withdrawal and long commands", () => {
  test("a request the launcher withdrew is never run by a child that begins later; the withdrawal is what allows the direct call", async () => {
    const { deps, base } = realDeps({ helper: "no-begin" });
    let seenDir = "";
    const r = await runViaScheduledTask({ ...deps, remove: (d) => { seenDir = d; } }, REQ);
    assert.match(why(r), /did not begin within 20 s/);
    const dir = seenDir.replaceAll("\\", process.platform === "win32" ? "\\" : "/");
    assert.deepEqual(readdirSync(dir).sort(), ["task.json", "withdrawn.json"], "the request was withdrawn");
    assert.equal(await childMain(dir), 2, "a late child finds nothing to claim");
    assert.deepEqual(readdirSync(dir).sort(), ["task.json", "withdrawn.json"], "and runs nothing (no started.txt)");
    rmSync(dir, { recursive: true, force: true });
    assert.deepEqual(readdirSync(base), []);
  });

  test("a call folder that already exists is never used (it could have been made by someone else)", async () => {
    const { deps, calls, base } = realDeps();
    mkdirSync(join(base, "call-0123456789ab"));
    assert.match(why(await runViaScheduledTask({ ...deps, baseDir: base }, REQ)), /already existed/);
    assert.equal(calls.run.length, 0);
    assert.deepEqual(readdirSync(base), ["call-0123456789ab"], "and it is left as found, not removed");
  });

  test("exec's limit (24 hours) is accepted by the child, so exec runs through the task and is not turned away to the direct call", async () => {
    const day = 24 * 60 * 60 * 1000;
    assert.deepEqual(readRequest(JSON.stringify({ file: "C:\\wsb.exe", args: ["exec"], timeoutMs: day })), { file: "C:\\wsb.exe", args: ["exec"], timeoutMs: day });
    const { deps, written } = realDeps();
    done(await runViaScheduledTask(deps, { ...REQ, args: ["exec", "--id", "x"], timeoutMs: day }));
    assert.equal((written[0] as { timeoutMs: number }).timeoutMs, day);
  });
});

describe("the scheduled-task launch: second review", () => {
  test("the helper runs on Windows PowerShell 5.1: no parameter it lacks (New-TimeSpan has no -Milliseconds there), the time limit built from .NET", () => {
    assert.doesNotMatch(HELPER_SCRIPT, /New-TimeSpan[^\n]*-Milli/);
    assert.match(HELPER_SCRIPT, /-ExecutionTimeLimit \(\[TimeSpan\]::FromMilliseconds\(\$limit \+ 60000\)\)/);
    // Every cmdlet the helper uses exists in 5.1 with the parameters given; the list is fixed here so a new one is looked at on purpose.
    const cmdlets = [...new Set(HELPER_SCRIPT.match(/\b[A-Z][A-Za-z]+-[A-Z][A-Za-z]+\b/g))].sort();
    assert.deepEqual(cmdlets, ["ConvertTo-Json", "Get-Date", "Get-ScheduledTask", "Get-ScheduledTaskInfo", "Join-Path", "New-ScheduledTaskAction", "New-ScheduledTaskPrincipal", "New-ScheduledTaskSettingsSet", "New-ScheduledTaskTrigger", "Out-Null", "Register-ScheduledTask", "Start-ScheduledTask", "Start-Sleep", "Stop-ScheduledTask", "Test-Path", "Unregister-ScheduledTask"]);
  });

  test("the helper waits past the command's limit by a margin, so the child stops the command's whole tree and writes its output before the task is stopped; the helper's own limit covers that", async () => {
    assert.match(HELPER_SCRIPT, /\$wait = \$limit \+ \[int64\]\$env:NN_MARGIN_MS/);
    assert.match(HELPER_SCRIPT, /if \(\$sw\.ElapsedMilliseconds -ge \$wait\) \{ break \}/);
    assert.doesNotMatch(HELPER_SCRIPT, /-ge \$limit\)/);
    const { deps, calls } = realDeps();
    done(await runViaScheduledTask(deps, REQ));
    const helper = calls.run.find((c) => /powershell/.test(c.file))!;
    assert.equal(helper.env!["NN_MARGIN_MS"], String(CHILD_MARGIN_MS));
    assert.ok(CHILD_MARGIN_MS >= START_GRACE_MS + 5_000, "a child that began as late as the grace allows still reaches its own limit before the helper stops the task");
    assert.ok(HELPER_OVERHEAD_MS >= CHILD_MARGIN_MS + 30_000, "registering, the margin, stopping and removing all fit in the helper's own limit");
    assert.ok(60_000 > START_GRACE_MS + 5_000, "the task's own execution limit (the command's + 60 s from the task's start) lies beyond the child's own end");
  });

  test("the base folder is checked as well as the call folder; a base another account could change means no helper, and the call folder is removed", async () => {
    const ok = realDeps();
    done(await runViaScheduledTask(ok.deps, REQ));
    assert.deepEqual(ok.calls.private, [ok.base, `${ok.base}\\call-0123456789ab`]);
    const b = realDeps({ privateProblem: "another account can change it", privateBaseOnly: true });
    assert.match(why(await runViaScheduledTask(b.deps, REQ)), /the folder for the private call folders was not believed private \(another account can change it\)/);
    assert.equal(b.calls.run.length, 0);
    assert.deepEqual(readdirSync(b.base), []);
  });

  test("a limit above the child's maximum is turned away before anything is made (the child would refuse it after claiming it, which reads as 'cannot be said')", async () => {
    const { deps, calls, base } = realDeps();
    assert.match(why(await runViaScheduledTask(deps, { ...REQ, timeoutMs: MAX_REQUEST_MS + 1 })), /a limit longer than the scheduled-task launch takes/);
    assert.equal(calls.run.length, 0);
    assert.deepEqual(readdirSync(base), []);
    done(await runViaScheduledTask(realDeps().deps, { ...REQ, timeoutMs: MAX_REQUEST_MS }));
  });

  test("the base folder: the variable when set and not empty, else under LOCALAPPDATA, else none", () => {
    const env = (m: Record<string, string>) => (n: string): string | undefined => m[n];
    assert.equal(wsbTaskBase(env({ NIMBLENEWT_WSB_TASK_DIR: "D:\\t", LOCALAPPDATA: "C:\\L" })), "D:\\t");
    assert.equal(wsbTaskBase(env({ NIMBLENEWT_WSB_TASK_DIR: "", LOCALAPPDATA: "C:\\L" })), "C:\\L\\NimbleNewt\\wsb-task");
    assert.equal(wsbTaskBase(env({})), undefined);
  });

  test("the base folder is normalised like the shared folders (so admit compares like with like), and only a folder below a drive's root or a UNC share is taken", () => {
    const base = (v: string): string | undefined => wsbTaskBase((n) => (n === "NIMBLENEWT_WSB_TASK_DIR" ? v : undefined));
    for (const v of ["D:/nn/task", "D:\\nn\\.\\task", "D:\\nn\\task\\", "D:\\nn\\x\\..\\task", "D:\\nn\\\\task"]) assert.equal(base(v), "D:\\nn\\task", v);
    assert.equal(base("\\\\srv\\share\\nn"), "\\\\srv\\share\\nn");
    assert.equal(wsbTaskBase((n) => (n === "LOCALAPPDATA" ? "C:/Users/u/AppData/Local/" : undefined)), "C:\\Users\\u\\AppData\\Local\\NimbleNewt\\wsb-task");
    for (const v of ["D:\\", "D:", "D:/", "nn\\task", "\\nn\\task", "\\\\srv\\share", "\\\\?\\D:\\nn", "\\\\.\\D:\\nn", "D:\\nn\0x"]) assert.equal(base(v), undefined, JSON.stringify(v));
  });
});

describe("the strategy: when each launch is chosen", () => {
  const unavailable = async (): Promise<TaskOutcome> => ({ kind: "unavailable", why: "the task could not be registered (error 0x80070002)" });
  const answered = async (): Promise<TaskOutcome> => ({ kind: "done", result: { code: 0, stdout: "x", stderr: "", timedOut: false, via: "through a one-shot scheduled task in the signed-in session" } });

  test("auto (the default): the task first; the direct call only when nothing was started, and the result says why", async () => {
    let d = 0;
    const r1 = await launchWsb("auto", answered, async () => { d++; return direct(); });
    assert.deepEqual([r1.code, d], [0, 0]);
    const r2 = await launchWsb("auto", unavailable, async () => { d++; return direct(5); });
    assert.deepEqual([r2.code, d], [5, 1]);
    assert.equal(r2.via, "scheduled task not available (the task could not be registered (error 0x80070002)); direct call used");
  });

  test("direct: the task is never tried; task: the direct call is never made and the failure says so plainly", async () => {
    let t = 0, d = 0;
    await launchWsb("direct", async () => { t++; return answered(); }, async () => { d++; return direct(); });
    assert.deepEqual([t, d], [0, 1]);
    const r = await launchWsb("task", unavailable, async () => { d++; return direct(); });
    assert.equal(d, 1, "not called again");
    assert.equal(r.code, null);
    assert.match(r.stderr, /^the Windows Sandbox command was not run: the scheduled-task launch is not available \(the task could not be registered \(error 0x80070002\)\) and the direct call is switched off$/);
  });

  test("the mode comes from one variable; anything unknown is auto", () => {
    assert.equal(parseMode(undefined), "auto");
    assert.equal(parseMode(" Direct "), "direct");
    assert.equal(parseMode("TASK"), "task");
    assert.equal(parseMode("both"), "auto");
    assert.equal(parseMode(""), "auto");
  });

  test("runWsbCommand uses the host's strategy when it has one and its plain run otherwise", async () => {
    const calls: string[] = [];
    const base = { run: async () => { calls.push("run"); return direct(); } } as unknown as WindowsHost;
    await runWsbCommand(base, "wsb", ["list"], { timeoutMs: 1 });
    await runWsbCommand({ ...base, runWsb: async () => { calls.push("runWsb"); return direct(); } } as unknown as WindowsHost, "wsb", ["list"], { timeoutMs: 1 });
    assert.deepEqual(calls, ["run", "runWsb"]);
  });

  test("a host copy made with withRun sends wsb commands to the replaced run, never to the original's scheduled-task launch (the 7c9d6c75 Windows CI failure)", async () => {
    const calls: string[] = [];
    const real = { run: async () => { calls.push("real run"); return direct(); }, runWsb: async () => { calls.push("real task launch"); throw new Error("the real launch must not be reached"); } } as unknown as WindowsHost;
    const fake = withRun(real, async (_f, a) => { calls.push(`fake ${String(a[0])}`); return direct(); });
    await runWsbCommand(fake, "wsb", ["start"], { timeoutMs: 1 });
    await runWsbCommand(fake, "wsb", ["exec"], { timeoutMs: 1 });
    assert.deepEqual(calls, ["fake start", "fake exec"]);
    // The plain spread this replaces keeps the real launch: the failure being guarded against.
    const spread = { ...real, run: async () => { calls.push("spread run"); return direct(); } } as unknown as WindowsHost;
    await assert.rejects(runWsbCommand(spread, "wsb", ["start"], { timeoutMs: 1 }), /must not be reached/);
  });

  test("no test builds a stand-in from the real Windows host with a plain spread and a replaced run (it would keep the real scheduled-task launch)", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url).href).replace(/[\\/]dist([\\/])/, "$1src$1");
    const offenders = readdirSync(dir).filter((f) => f.endsWith(".test.ts") || f.endsWith(".test.js")).filter((f) => {
      const text = readFileSync(join(dir, f), "utf8");
      return text.includes("windowsRealHost(") && /\.\.\.host,[^;]{0,1200}?\brun:/s.test(text);
    });
    assert.deepEqual(offenders, []);
  });

  test("wsb list may be called again by its caller (up to three calls, each through the strategy); the via note is kept in the record", async () => {
    const seen: string[] = [];
    const host = {
      platform: "win32", pid: 1, env: () => undefined, pidAlive: () => false,
      run: async () => { throw new Error("the plain run must not be used"); },
      runWsb: async (_f: string, a: readonly string[]) => { seen.push(String(a[0])); return { code: seen.length < 3 ? 2148734208 : 0, stdout: seen.length < 3 ? "" : "id", stderr: "", timedOut: false, via: "through a one-shot scheduled task in the signed-in session" } as ProcessResult; },
    } as unknown as WindowsHost;
    const r = await listSandboxes(host, { wsb: "C:\\wsb.exe", cwd: "C:\\" }, { pauseMs: 0 });
    assert.deepEqual(seen, ["list", "list", "list"]);
    assert.equal(r.ok, true);
    assert.match(r.detail, /call 1: exit 2148734208 \(through a one-shot scheduled task in the signed-in session\)/);
  });
});

describe("the child the task runs", () => {
  test("the request is read only in the expected form", () => {
    assert.deepEqual(readRequest('{"file":"a","args":["x"],"timeoutMs":5000,"cwd":"c"}'), { file: "a", args: ["x"], timeoutMs: 5000, cwd: "c" });
    for (const bad of ["{", "[]", '{"file":"","args":[],"timeoutMs":5000}', '{"file":"a","args":[1],"timeoutMs":5000}', '{"file":"a","args":[],"timeoutMs":10}', '{"file":"a","args":[],"timeoutMs":999999999}', '{"file":"a","args":[],"timeoutMs":5000,"cwd":3}']) assert.equal(readRequest(bad), undefined, bad);
  });

  test("it writes started first, the exit code last, and nothing when the folder or request is gone (it then runs nothing)", async () => {
    const d = fresh();
    assert.equal(await childMain(join(d, "missing")), 2);
    assert.equal(await childMain(undefined), 2);
    writeFileSync(join(d, "in.json"), "{");
    assert.equal(await childMain(d), 2);
    assert.deepEqual(readdirSync(d), ["claimed.json"], "a request it cannot read is claimed and not run");
    writeFileSync(join(d, "in.json"), JSON.stringify({ file: NODE, args: ["-e", "process.exit(7)"], timeoutMs: 20_000 }));
    assert.equal(await childMain(d), 0);
    assert.deepEqual(readdirSync(d).sort(), ["claimed.json", "code.txt", "err.txt", "out.txt", "started.txt"]);
    assert.equal(readFileSync(join(d, "code.txt"), "utf8"), "7");
  });

  test("a command that cannot be run, or that passes its limit, leaves no exit code (the launcher then says so; it never invents a 0)", async () => {
    const d = fresh();
    writeFileSync(join(d, "in.json"), JSON.stringify({ file: join(d, "no-such-program"), args: [], timeoutMs: 20_000 }));
    assert.equal(await childMain(d), 0);
    assert.equal(existsSync(join(d, "code.txt")), false);
    assert.equal(existsSync(join(d, "started.txt")), true);
    const e = fresh();
    writeFileSync(join(e, "in.json"), JSON.stringify({ file: NODE, args: ["-e", "setTimeout(()=>{},60000)"], timeoutMs: 1500 }));
    assert.equal(await childMain(e), 0);
    assert.equal(existsSync(join(e, "code.txt")), false);
    assert.match(readFileSync(join(e, "err.txt"), "utf8"), /timed out after \d+ s and was stopped/);
  });
});

describe("the G05 base folder's access check and the runner's own group", () => {
  const host = (writers: string[], members: Record<string, readonly string[] | undefined>, env: Record<string, string> = { USERNAME: "runner1", USERDOMAIN: "BOX", COMPUTERNAME: "BOX" }, asked: string[] = []): WindowsHost => ({
    env: (k: string) => env[k], isLinkOrJunction: () => false, writableBy: async () => writers,
    localGroupMembers: async (g: string) => { asked.push(g); return members[g]; },
  }) as unknown as WindowsHost;
  const G = "BOX\\GITHUB_ActionsRunner_G17fda";

  test("the runner's group of this machine whose only member is the running account is not another account; the evidence lists names redacted", async () => {
    const notes: string[] = [];
    assert.equal(await recordDirProblem(host(["BOX\\runner1", G], { GITHUB_ActionsRunner_G17fda: ["BOX\\runner1"] }), "D:\\t\\g05", "the G05 test base folder", notes), undefined);
    assert.deepEqual(notes, [
      "GITHUB_ActionsRunner_G17fda is the runner's own group of this machine whose members are only the account running the cleanup: not counted as another account",
      "accounts that can change the G05 test base folder: the account running the cleanup, GITHUB_ActionsRunner_G17fda (the runner's group)",
    ]);
  });

  test("an empty runner group is recognised (nobody can use it); a group that also holds another account, an unreadable one, a foreign machine's or a lookalike name is not", async () => {
    assert.equal(await recordDirProblem(host([G], { GITHUB_ActionsRunner_G17fda: [] }), "D:\\x"), undefined);
    for (const [name, members] of [[G, { GITHUB_ActionsRunner_G17fda: ["BOX\\runner1", "BOX\\someone"] }], [G, { GITHUB_ActionsRunner_G17fda: undefined }], ["OTHERPC\\GITHUB_ActionsRunner_G17fda", { GITHUB_ActionsRunner_G17fda: [] }], ["BOX\\GITHUB_ActionsRunnerX", {}], ["BOX\\xGITHUB_ActionsRunner_G1", {}], ["GITHUB_ActionsRunner_G17fda", { GITHUB_ActionsRunner_G17fda: [] }], ["BOX\\GITHUB_ActionsRunner_a b", {}]] as const) {
      assert.match(String(await recordDirProblem(host([name], { ...(members as Record<string, readonly string[] | undefined>) }), "D:\\x")), /can be changed by an account other than the one running the cleanup/, name);
    }
  });

  test("another account still blocks, next to the recognised group; a host that cannot read groups keeps the old rule; the group is looked up by its bare name only", async () => {
    const asked: string[] = [];
    const notes: string[] = [];
    assert.match(String(await recordDirProblem(host([G, "BOX\\erin"], { GITHUB_ActionsRunner_G17fda: [] }, undefined, asked), "D:\\x", "the base", notes)), /other than/);
    assert.deepEqual(asked, ["GITHUB_ActionsRunner_G17fda"]);
    assert.match(notes.at(-1)!, /^accounts that can change the base: GITHUB_ActionsRunner_G17fda \(the runner's group\), account 1$/);
    const noGroups = { env: (k: string) => ({ USERNAME: "runner1", USERDOMAIN: "BOX", COMPUTERNAME: "BOX" } as Record<string, string>)[k], isLinkOrJunction: () => false, writableBy: async () => [G] } as unknown as WindowsHost;
    assert.match(String(await recordDirProblem(noGroups, "D:\\x")), /other than/);
  });

  test("redacted names: well-known system accounts and the runner's group by name, everyone else numbered, the running account never named", () => {
    assert.equal(redactedWriters(["BOX\\runner1", "NT AUTHORITY\\Authenticated Users", "BUILTIN\\Users", "BOX\\erin", "BOX\\jo", G], "BOX\\runner1"),
      "the account running the cleanup, NT AUTHORITY\\Authenticated Users, BUILTIN\\Users, account 1, account 2, GITHUB_ActionsRunner_G17fda (the runner's group)");
    assert.doesNotMatch(redactedWriters(["BOX\\erin"], undefined), /erin/);
    assert.equal(redactedWriters(["Everyone", "CREATOR OWNER", "BOX\\Everyone2"], undefined), "Everyone, CREATOR OWNER, account 1");
  });
});
