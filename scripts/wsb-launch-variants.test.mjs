// Card wsb-variants: the six other ways of launching `wsb list` (scripts/wsb-launch-variants.mjs). Everything runs on every OS with the launcher and the clock injected; what
// only Windows can show (the real launches, the scheduled task) is recorded by the next own-hardware run. Keys are built at run time from invented characters.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  CMD_NEW_CONSOLE, CMD_NUL_FILE, MIN_VARIANT_MS, NEW_CONSOLE_BATCH, ORDER, PREFIX, STOP_MS, TASK_CHECK_MS, TASK_OVERHEAD_MS, TASK_LEVELS, TASK_RESERVE_MS, TASK_SCRIPT, TASK_SCRIPT_HIGHEST, TOTAL_LIMIT_MS,
  VARIANT_TIMEOUT_MS, readCodeFile, realLaunch, render, runVariants, taskResult, taskVerdict, variantLine,
} from "./wsb-launch-variants.mjs";
import { OVERALL_LIMIT_MS, wsbListLine } from "./wsb-job-context.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY = "gh" + "p_" + Array.from({ length: 36 }, (_, i) => ALNUM[(i * 5 + 3 + (i % 7) * 13) % ALNUM.length]).join("");
const GRPC = "Grpc.Core.RpcException: Status(StatusCode=\"DeadlineExceeded\", Detail=\"failed to connect to localhost:80 (timed out)\")\r\nCancelled\r\n";
const tmp = () => { const d = join(process.env.TMPDIR ?? "/tmp", "wsbv-test"); mkdirSync(d, { recursive: true }); return d; };

/** A clock that only moves when a fake launch says so (no real time is read). */
function fakeClock() {
  let t = 1000;
  return { now: () => t, advance: (ms) => { t += ms; } };
}

/** A fake launcher: each call recorded; `answer(call)` gives the result (and may write the files a real program would). Each call takes `cost(call)` of the fake clock. */
function fakeLaunch(clock, answer, cost = () => 1000) {
  const calls = [];
  const launch = async (call) => {
    calls.push(call);
    clock.advance(cost(call));
    return answer(call);
  };
  return { calls, launch };
}

const ok = { status: 0, signal: null, stdout: "", stderr: "", durationMs: 50 };

test("all six variants run once each in the printed order, every one whatever the earlier gave, with the launch each asks for", async () => {
  const clock = fakeClock();
  const { calls, launch } = fakeLaunch(clock, (c) => {
    if (c.file === "wsb") return { status: null, signal: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: GRPC, durationMs: 45_010 };
    if (/cmd\.exe$/.test(c.file) && c.args[0] === CMD_NUL_FILE) { writeFileSync(c.env.NN_WSB_OUT, "sandbox-1\r\n"); return { ...ok, durationMs: 812 }; }
    if (/cmd\.exe$/.test(c.file)) { writeFileSync(c.env.NN_WSB_ERR, GRPC); return { status: 2148734208, signal: null, stdout: "", stderr: "", durationMs: 30_000 }; }
    if (/powershell\.exe$/.test(c.file) && c.args.at(-1) === "wsb list") return { status: 1, signal: null, stdout: "", stderr: GRPC, durationMs: 30_500 };
    if (/powershell\.exe$/.test(c.file)) {
      writeFileSync(c.env.NN_WSB_OUT, "a\r\nb\r\n");
      writeFileSync(c.env.NN_WSB_CODE, "0\r\n");
      writeFileSync(c.env.NN_OUT, JSON.stringify({ registered: true, started: true, finished: true, result: 0, elapsedMs: 1234, stopped: false, removed: true, error: null }));
      return ok;
    }
    if (/schtasks\.exe$/.test(c.file)) return { ...ok, status: 1 };
    throw new Error(`unexpected ${c.file}`);
  });
  const lines = await runVariants({ launch, now: clock.now, systemRoot: "C:\\Windows", tmp: tmp(), taskName: () => "NimbleNewtWsbProbe-0123456789ab" });
  assert.equal(lines[0], `order tried: 1 nodeDetached, 2 cmdNulFile, 3 powershellCommand, 4 newConsole, 5 scheduledTask, 6 scheduledTaskHighest (each once, limit ${VARIANT_TIMEOUT_MS} ms, all ${TOTAL_LIMIT_MS} ms)`);
  assert.deepEqual(ORDER, ["nodeDetached", "cmdNulFile", "powershellCommand", "newConsole", "scheduledTask", "scheduledTaskHighest"]);
  assert.match(lines[1], /^1\. nodeDetached \(node spawn detached, windowsHide false; limit 45000 ms\): no answer within 45000 ms \(stopped\) after 45010 ms; output text no \(lines 0\); error text yes; markers: grpc, localhost:80, deadline, cancelled, timed out; first error line: Grpc\.Core\.RpcException/);
  assert.match(lines[2], /^2\. cmdNulFile \(.*\): answered \(exit 0\) after 812 ms; output text yes \(lines 1\); error text no; markers: none; first error line: none$/);
  assert.match(lines[3], /^3\. powershellCommand \(.*\): failed \(exit 0x00000001\) after 30500 ms; .*error text yes; markers: grpc/);
  assert.match(lines[4], /^4\. newConsole \(.*\): failed \(exit 0x80131500\) after 30000 ms; output text no \(lines 0\); error text yes; markers: grpc, localhost:80/);
  assert.match(lines[5], /^5\. scheduledTask \(.*\): answered \(exit 0\) after 1234 ms; output text yes \(lines 2\); error text no; .*; task left behind no$/);
  // The second task variant is labelled as the comparison one and has the same exit-code-file verdict.
  assert.match(lines[5], /^5\. scheduledTask \(a one-shot scheduled task, run level Limited, verdict-bearing, removed afterwards; /);
  assert.match(lines[6], /^6\. scheduledTaskHighest \(a one-shot scheduled task, run level Highest, for comparison only, removed afterwards; .*verdict: SUCCESS, exit code 0 read from the code file/);
  assert.match(lines[7], /^all variants: \d+ ms$/);
  assert.equal(lines.length, 8);

  // The launches themselves.
  const [detached, nulFile, psCommand, newConsole, helper, ...afterwards] = calls;
  const checks = afterwards.slice(0, 1);
  const helperHighest = afterwards[1];
  assert.equal(helperHighest.args.at(-1), TASK_SCRIPT_HIGHEST);
  assert.notEqual(TASK_SCRIPT_HIGHEST, TASK_SCRIPT);
  assert.deepEqual(afterwards.slice(2).map((c) => c.args[0]), ["/Query"]);
  assert.deepEqual(detached, { file: "wsb", args: ["list"], detached: true, windowsHide: false, timeoutMs: VARIANT_TIMEOUT_MS });
  assert.equal(nulFile.file, "C:\\Windows\\System32\\cmd.exe");
  assert.deepEqual(nulFile.args, [CMD_NUL_FILE]);
  assert.equal(nulFile.verbatim, true);
  assert.deepEqual(Object.keys(nulFile.env).sort(), ["NN_WSB_ERR", "NN_WSB_OUT"]);
  assert.deepEqual(psCommand.args, ["-NoProfile", "-Command", "wsb list"]);
  assert.equal(psCommand.file, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.deepEqual(newConsole.args, [CMD_NEW_CONSOLE]);
  assert.equal(newConsole.windowsHide, false);
  assert.ok(newConsole.env.NN_WSB_BATCH.endsWith("new-console.cmd"));
  assert.equal(helper.args.at(-1), TASK_SCRIPT);
  assert.equal(helper.env.NN_TASK, "NimbleNewtWsbProbe-0123456789ab");
  assert.deepEqual(Object.keys(helper.env).sort(), ["NN_LIMIT_MS", "NN_OUT", "NN_TASK", "NN_WSB_BATCH", "NN_WSB_CODE", "NN_WSB_ERR", "NN_WSB_OUT"]);
  assert.equal(helper.env.NN_LIMIT_MS, String(VARIANT_TIMEOUT_MS));
  assert.equal(helper.timeoutMs, VARIANT_TIMEOUT_MS + TASK_OVERHEAD_MS);
  // Afterwards the task is looked for by its name (not found: exit 1), nothing more.
  assert.deepEqual(checks.map((c) => c.args), [["/Query", "/TN", "NimbleNewtWsbProbe-0123456789ab"]]);
  assert.ok(checks.concat(afterwards.slice(2)).every((c) => c.file === "C:\\Windows\\System32\\schtasks.exe" && c.timeoutMs === TASK_CHECK_MS));
});

test("the scheduled task: still there afterwards is deleted and looked for again; a helper with no answer, a task not registered or stopped at its limit", async () => {
  const run = async (helperAnswer, queries) => {
    const clock = fakeClock();
    let q = 0;
    const { calls, launch } = fakeLaunch(clock, (c) => {
      if (/powershell\.exe$/.test(c.file) && c.args.at(-1) === TASK_SCRIPT) { if (helperAnswer !== undefined) writeFileSync(c.env.NN_OUT, JSON.stringify(helperAnswer)); return helperAnswer === undefined ? { status: null, signal: null, error: { code: "ETIMEDOUT" }, durationMs: 70_000 } : ok; }
      if (/schtasks\.exe$/.test(c.file) && c.args[0] === "/Query") return { ...ok, status: queries[q++] };
      return ok;
    });
    const lines = await runVariants({ launch, now: clock.now, tmp: tmp(), taskName: () => "NimbleNewtWsbProbe-aaaaaaaaaaaa" });
    return { line: lines[5], // the first task variant's checks only (the comparison variant's come after)
    schtasks: calls.filter((c) => /schtasks/.test(c.file)).map((c) => c.args[0]).slice(0, 3) };
  };
  const stopped = await run({ registered: true, started: true, finished: false, result: null, elapsedMs: 45_001, stopped: true, removed: false, error: null }, [0, 1]);
  assert.match(stopped.line, /^5\. scheduledTask .*: no answer within 45000 ms \(stopped\) after 45001 ms; .*; task left behind no$/);
  assert.deepEqual(stopped.schtasks, ["/Query", "/Delete", "/Query"]);
  const silent = await run(undefined, [0, 0]);
  assert.match(silent.line, /: no answer from the helper \(exit none, stopped after its limit\); task left behind yes \(Task Scheduler deletes it when its trigger expires in ten minutes\)$/);
  const unreadable = await run({ registered: false, error: 2147942405 }, [null, null]);
  assert.match(unreadable.line, /: not run: the task could not be registered \(error 0x80070005\); task left behind unknown$/);
  const notStarted = await run({ registered: true, started: false, error: "C:\\Users\\jane" }, [1]);
  assert.match(notStarted.line, /: not run: the task was registered but could not be started \(error unknown\); task left behind no$/);
  assert.ok(!notStarted.line.includes("jane"));
});

test("the overall limit: a variant that no longer fits is not started; every task keeps time for its clean-up; all six fit when each runs to its limit; the run fits the step's 15 minutes", async () => {
  // Every launch uses its whole limit; the plain variants also take the longest stop. All six are still started and the whole stays inside the limit.
  const clock = fakeClock();
  const { calls, launch } = fakeLaunch(clock, (c) => ({ status: null, signal: null, error: { code: "ETIMEDOUT" }, stdout: "", stderr: "", durationMs: c.timeoutMs }), (c) => (/schtasks/.test(c.file) || c.args.includes("-NonInteractive") ? c.timeoutMs : c.timeoutMs + STOP_MS));
  const t0 = clock.now();
  const lines = await runVariants({ launch, now: clock.now, tmp: tmp(), taskName: () => "NimbleNewtWsbProbe-bbbbbbbbbbbb" });
  assert.ok(calls.filter((c) => c.timeoutMs === VARIANT_TIMEOUT_MS || c.timeoutMs === VARIANT_TIMEOUT_MS + TASK_OVERHEAD_MS).length >= 6);
  assert.ok(!lines.some((l) => /not started/.test(l)), lines.join("\n"));
  assert.ok(clock.now() - t0 <= TOTAL_LIMIT_MS, String(clock.now() - t0));
  // The arithmetic: four plain variants and two tasks at their worst fit under the limit, and the context script's limit plus this one fit the step's 15 minutes.
  assert.ok(4 * (VARIANT_TIMEOUT_MS + STOP_MS) + 2 * (VARIANT_TIMEOUT_MS + TASK_RESERVE_MS) <= TOTAL_LIMIT_MS);
  assert.ok(OVERALL_LIMIT_MS + TOTAL_LIMIT_MS + 60_000 <= 15 * 60_000);
  assert.deepEqual(TASK_LEVELS, { scheduledTask: "Limited", scheduledTaskHighest: "Highest" });
  // A slow start: later variants get a shorter limit, then none.
  const c2 = fakeClock();
  const f2 = fakeLaunch(c2, (c) => ({ ...ok, durationMs: c.timeoutMs }), (c) => (c.file === "wsb" ? 430_000 : c.timeoutMs));
  const l2 = await runVariants({ launch: f2.launch, now: c2.now, tmp: tmp() });
  assert.equal(f2.calls.length, 2);
  assert.equal(f2.calls[1].timeoutMs, TOTAL_LIMIT_MS - 430_000 - STOP_MS);
  assert.match(l2[3], /^3\. powershellCommand .*: not started/);
  assert.match(l2[6], /^6\. scheduledTaskHighest .*: not started, too little of the overall limit left$/);
  assert.equal(TASK_RESERVE_MS, TASK_OVERHEAD_MS + STOP_MS + 3 * TASK_CHECK_MS);
  assert.ok(MIN_VARIANT_MS < VARIANT_TIMEOUT_MS);
});

test("a variant that throws is recorded as not tried and the rest still run; a wrong task name is refused", async () => {
  const clock = fakeClock();
  const { calls, launch } = fakeLaunch(clock, (c) => { if (c.args[0] === CMD_NUL_FILE) throw new Error(`C:\\Users\\jane ${KEY}`); return ok; });
  const lines = await runVariants({ launch, now: clock.now, tmp: tmp(), taskName: () => "Evil & name" });
  assert.equal(lines[2], "2. cmdNulFile (cmd.exe /c, stdin NUL, output to files): could not be tried (an unexpected error, not shown)");
  assert.match(lines[5], /^5\. scheduledTask .*: not started, an unexpected task name$/);
  assert.match(lines[6], /^6\. scheduledTaskHighest .*: not started, an unexpected task name$/);
  assert.equal(calls.length, 4);
  assert.ok(!lines.join("\n").includes("jane") && !lines.join("\n").includes(KEY));
});

test("variant lines: the outcome in the job-context script's words; output and error text marked; a key in the error output removed, a long line cut", () => {
  const r = { status: 1, signal: null, stdout: "", stderr: `token=${KEY} ${"x".repeat(400)}`, durationMs: 7 };
  const line = variantLine(3, "powershellCommand", r, 45_000);
  assert.ok(!line.includes(KEY.slice(4)), line);
  assert.ok(line.length < 500, String(line.length));
  assert.match(line, /^3\. powershellCommand \(powershell\.exe -NoProfile -Command; limit 45000 ms\): failed \(exit 0x00000001\) after 7 ms; output text no \(lines 0\); error text yes;/);
  assert.match(variantLine(1, "nodeDetached", { status: null, error: { code: "ENOENT" }, durationMs: 2 }, 45_000), /: not found on PATH after 2 ms; output text no \(lines 0\); error text no;/);
  // The job-context script's own line is unchanged by the shared description.
  assert.equal(wsbListLine({ status: 0, signal: null, stdout: "\r\n", stderr: "", durationMs: 812.4 }), "wsb list (once, limit 45000 ms): answered (exit 0) after 812 ms; output lines 0; markers: none; first error line: none");
  assert.deepEqual(taskResult({ registered: true, started: true, finished: true, result: 3, elapsedMs: 9 }, { stdout: "", stderr: "", code: 3 }), { signal: null, stdout: "", stderr: "", durationMs: 9, status: 3, taskResult: 3 });
  assert.equal(taskResult({ registered: true, started: true, finished: true, result: -1 }, { stdout: "", stderr: "" }).error.code, "other");
  assert.deepEqual(render(["1. x"]), [`${PREFIX}1. x`]);
  assert.ok(!render([`x ${KEY}`])[0].includes(KEY));
});

test("the fixed command texts and the helper: no interpolation, file names only from the environment, the task always removed, answer only to NN_OUT", () => {
  assert.equal(CMD_NUL_FILE, '/d /v:off /s /c "wsb list <NUL >"%NN_WSB_OUT%" 2>"%NN_WSB_ERR%""');
  assert.equal(CMD_NEW_CONSOLE, '/d /v:off /s /c "start "" /wait "%NN_WSB_BATCH%""');
  assert.equal(NEW_CONSOLE_BATCH, '@wsb list <NUL >"%NN_WSB_OUT%" 2>"%NN_WSB_ERR%"\r\n@exit %ERRORLEVEL%\r\n');
  assert.doesNotMatch(TASK_SCRIPT, /\$\{/);
  assert.doesNotMatch(TASK_SCRIPT, /Write-(Output|Host)|\[Console\]::Write/);
  assert.deepEqual([...new Set([...TASK_SCRIPT.matchAll(/\$env:([A-Za-z_]+)/g)].map((m) => m[1]))].sort(), ["NN_LIMIT_MS", "NN_OUT", "NN_TASK", "NN_WSB_BATCH", "NN_WSB_CODE", "NN_WSB_ERR", "NN_WSB_OUT", "SystemRoot"]);
  assert.match(TASK_SCRIPT, /\} finally \{\n {2}if \(\$r\.registered\) \{ try \{ Unregister-ScheduledTask -TaskName \$name -Confirm:\$false; \$r\.removed = \$true \} catch \{ \} \}\n {2}\[System\.IO\.File\]::WriteAllText\(\$env:NN_OUT,/);
  // The safety net: the trigger is in the past (it never runs by itself) and expires, after which Task Scheduler deletes the task.
  assert.match(TASK_SCRIPT, /New-ScheduledTaskTrigger -Once -At \(Get-Date\)\.AddMinutes\(-1\)/);
  assert.match(TASK_SCRIPT, /\$trigger\.EndBoundary = \(Get-Date\)\.AddMinutes\(10\)/);
  assert.match(TASK_SCRIPT, /\$settings\.DeleteExpiredTaskAfter = 'PT0S'/);
  assert.match(TASK_SCRIPT, /if \(-not \$r\.finished\) \{ \$r\.stopped = \$true; Stop-ScheduledTask -TaskName \$name \}/);
});

test("run levels: the verdict-bearing helper registers at Limited, the comparison helper at Highest, and they differ in that one word only", () => {
  assert.match(TASK_SCRIPT, /-LogonType Interactive -RunLevel Limited\n/);
  assert.doesNotMatch(TASK_SCRIPT, /Highest/);
  assert.match(TASK_SCRIPT_HIGHEST, /-LogonType Interactive -RunLevel Highest\n/);
  assert.doesNotMatch(TASK_SCRIPT_HIGHEST, /Limited/);
  assert.equal(TASK_SCRIPT_HIGHEST, TASK_SCRIPT.replace("-RunLevel Limited", "-RunLevel Highest"));
  assert.equal((TASK_SCRIPT.match(/-RunLevel/g) ?? []).length, 1);
});

test("run off Windows: says so, tries nothing, passes the log redaction unchanged, exits 0", { skip: process.platform === "win32" ? "the off-Windows answer" : false }, () => {
  const r = spawnSync(process.execPath, [join(root, "scripts", "wsb-launch-variants.mjs")], { encoding: "utf8", env: { PATH: process.env.PATH, NN_TEST_SECRET: KEY } });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout, `${PREFIX}not Windows; nothing tried\n`);
  const red = spawnSync(process.execPath, [join(root, "scripts", "redact-log.mjs")], { input: r.stdout, encoding: "utf8" });
  assert.equal(red.status, 0, red.stderr);
  assert.equal(red.stdout, r.stdout);
});

test("the real launcher: exit code and both outputs, a program that does not end is stopped at its limit, a missing program is not found", async () => {
  const done = await realLaunch({ file: process.execPath, args: ["-e", "process.stdout.write('a'); process.stderr.write('b'); process.exitCode = 3"], timeoutMs: 120_000 });
  assert.equal(done.status, 3);
  assert.equal(done.stdout, "a");
  assert.equal(done.stderr, "b");
  assert.equal(done.error, undefined);
  const hung = await realLaunch({ file: process.execPath, args: ["-e", "process.stdout.write('x'); setInterval(() => {}, 1000)"], timeoutMs: 1_000 });
  assert.equal(hung.status, null);
  assert.equal(hung.error?.code, "ETIMEDOUT");
  assert.match(variantLine(1, "nodeDetached", hung, 1_000), /: no answer within 1000 ms \(stopped\) after/);
  const missing = await realLaunch({ file: "nn-no-such-program-wsbv", args: [], timeoutMs: 120_000 });
  // A PATH lookup reports ENOENT, or EACCES when a PATH directory is unreadable to this user (seen on the Mac runner); never success or another error.
  assert.ok(["ENOENT", "EACCES"].includes(missing.error?.code), `a missing program reports ENOENT or EACCES, got ${missing.error?.code}`);
  assert.notEqual(missing.status, 0);
  // Detached, as variant 1 runs it.
  const detached = await realLaunch({ file: process.execPath, args: ["-e", "process.exitCode = 0"], detached: true, windowsHide: false, timeoutMs: 120_000 });
  assert.equal(detached.status, 0);
});

test("the scheduled task's answer is unambiguous: only an exit code read from the task's own code file counts; no output with code 0 is the right empty list, no code file is not an answer", async () => {
  const lineFor = async (writeCode) => {
    const clock = fakeClock();
    const { launch } = fakeLaunch(clock, (c) => {
      if (/powershell\.exe$/.test(c.file) && c.args.at(-1) === TASK_SCRIPT) {
        if (writeCode !== undefined) writeFileSync(c.env.NN_WSB_CODE, writeCode);
        writeFileSync(c.env.NN_OUT, JSON.stringify({ registered: true, started: true, finished: true, result: 0, elapsedMs: 1000, stopped: false, removed: true, error: null }));
        return ok;
      }
      if (/schtasks\.exe$/.test(c.file)) return { ...ok, status: 1 };
      return { status: null, signal: null, error: { code: "ETIMEDOUT" }, durationMs: 1 };
    });
    return (await runVariants({ launch, now: clock.now, tmp: tmp(), taskName: () => "NimbleNewtWsbProbe-aaaaaaaaaaaa" }))[5];
  };
  assert.match(await lineFor("0\r\n"), /answered \(exit 0\) after 1000 ms; output text no \(lines 0\); error text no; .*verdict: SUCCESS, exit code 0 read from the code file \(the list is empty, which is the right answer when no sandbox is running\)/);
  assert.match(await lineFor("2148734208"), /failed \(exit 0x80131500\).*verdict: FAILED, exit code 0x80131500 read from the code file; the task's own result 0x00000000 differs/);
  assert.match(await lineFor(undefined), /verdict: NOT an answer \(the task ended but wrote no exit code\)/);
  assert.match(await lineFor("garbage"), /verdict: NOT an answer/);
  assert.match(taskVerdict({ status: null, error: { code: "ETIMEDOUT" } }), /verdict: no answer/);
  assert.match(taskVerdict({ status: 0, stdout: "id\r\n" }), /SUCCESS.*a list was printed/);
  const d = tmp();
  const f = join(d, "code.txt");
  writeFileSync(f, "\uFEFF 7 \r\n"); assert.equal(readCodeFile(f), 7);
  writeFileSync(f, "4294967296"); assert.equal(readCodeFile(f), undefined);
  writeFileSync(f, "-1"); assert.equal(readCodeFile(f), undefined);
  assert.equal(readCodeFile(join(d, "missing.txt")), undefined);
  // The batch the task runs writes wsb's own exit code, line by line (so %ERRORLEVEL% is wsb's), into the file the launcher reads.
  assert.match(TASK_SCRIPT, /'@>"' \+ \$env:NN_WSB_CODE \+ '" echo %ERRORLEVEL%'/);
  assert.match(TASK_SCRIPT, /'@wsb list <NUL >"' \+ \$env:NN_WSB_OUT/);
});
