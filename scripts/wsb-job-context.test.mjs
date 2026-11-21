// Card wsb-console: the own-hardware job-context diagnostic (scripts/wsb-job-context.mjs). The parsing and the words run on every OS from fixtures; what only Windows can show
// (the helper's C#, whoami, the real `wsb list`) is recorded by the next own-hardware run. Keys are built at run time from invented characters (push protection scans commits).
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { OVERALL_LIMIT_MS, PREFIX, PROBE_SCRIPT, PROBE_TIMEOUT_MS, SESSION_WAIT_MS, WHOAMI_TIMEOUT_MS, WSB_LIST_TIMEOUT_MS, chainLabel, csvFields, envNameLines, fromBounded, parseGroups, parseUser, probeLines, render, windowsLines, wsbListLine } from "./wsb-job-context.mjs";
import { usesSharedScanner } from "./safe-error.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const script = join(root, "scripts", "wsb-job-context.mjs");
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const KEY = "gh" + "p_" + Array.from({ length: 36 }, (_, i) => ALNUM[(i * 7 + 13 + (i % 5) * 11) % ALNUM.length]).join("");

const GROUPS_HIGH = [
  '"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"',
  '"NT AUTHORITY\\Local account and member of Administrators group","Well-known group","S-1-5-114","Mandatory group, Enabled by default, Enabled group"',
  '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"',
  '"BUILTIN\\Users","Alias","S-1-5-32-545","Mandatory group, Enabled by default, Enabled group"',
  '"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""',
].join("\r\n");
const GROUPS_MEDIUM = [
  '"BUILTIN\\Administrators","Alias","S-1-5-32-544","Group used for deny only"',
  '"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""',
].join("\r\n");

test("whoami CSV: quoted fields, doubled quotes, commas inside quotes", () => {
  assert.deepEqual(csvFields('"a","b, c","say ""hi""",""'), ["a", "b, c", 'say "hi"', ""]);
  assert.deepEqual(csvFields('"x"'), ["x"]);
});

test("whoami /groups: integrity by the label's SID, Administrators enabled or deny only; nothing read is unknown", () => {
  assert.deepEqual(parseGroups(GROUPS_HIGH), { integrity: "high", admin: "enabled" });
  assert.deepEqual(parseGroups(GROUPS_MEDIUM), { integrity: "medium", admin: "deny only" });
  // Translated names and attributes: the SID still gives the level; the attributes are not guessed.
  assert.deepEqual(parseGroups('"VORDEFINIERT\\Administratoren","Alias","S-1-5-32-544","Verbindliche Gruppe"\n"Verbindliche Beschriftung\\Hohe Verbindlichkeitsstufe","Bezeichnung","S-1-16-12288",""'), { integrity: "high", admin: "present (attributes not read)" });
  assert.deepEqual(parseGroups('"Mandatory Label\\System Mandatory Level","Label","S-1-16-16384",""'), { integrity: "system", admin: "absent" });
  for (const bad of ["", undefined, "ERROR: Access denied", "not,csv"]) assert.deepEqual(parseGroups(bad), { integrity: "unknown", admin: "unknown" });
});

test("whoami /user: the kind of account by SID, never the name or SID", () => {
  assert.equal(parseUser('"desktop-1\\robert","S-1-5-21-1111111111-2222222222-3333333333-1001"\r\n'), "a local or domain account");
  assert.equal(parseUser('"nt authority\\system","S-1-5-18"'), "local system");
  assert.equal(parseUser('"nt authority\\local service","S-1-5-19"'), "local service");
  assert.equal(parseUser('"nt authority\\network service","S-1-5-20"'), "network service");
  assert.equal(parseUser('"azuread\\janedoe","S-1-12-1-1-2-3-4"'), "an Azure AD account");
  assert.equal(parseUser('"nt service\\runner","S-1-5-80-1-2-3-4-5"'), "a virtual service account");
  assert.equal(parseUser(""), "unknown");
  assert.equal(parseUser("garbage"), "unknown");
});

test("environment: names only, sorted, case duplicates once, odd names only counted, a few per line", () => {
  const env = { PATH: "C:\\Windows", Path: "x", TEMP: "C:\\Users\\Jane\\AppData\\Local\\Temp", "ProgramFiles(x86)": "C:\\Program Files (x86)", GITHUB_TOKEN: KEY, "=C:": "C:\\", "bad name": "1", ACTIONS_RUNTIME_TOKEN: KEY, a: "1" };
  const lines = envNameLines(Object.keys(env), 3);
  assert.equal(lines[0], "environment: 6 variable names, 2 other names not shown (names only, never values)");
  assert.deepEqual(lines.slice(1), ["environment names: a ACTIONS_RUNTIME_TOKEN GITHUB_TOKEN", "environment names: PATH ProgramFiles(x86) TEMP"]);
  const all = lines.join("\n");
  for (const v of Object.values(env)) if (v.length > 2) assert.ok(!all.includes(v), v);
  assert.deepEqual(envNameLines([]), ["environment: 0 variable names (names only, never values)"]);
});

test("the helper's answer as fixed words: session, console, job, parents with services, window station and desktop", () => {
  const raw = {
    helperConsoleWindow: false, attachError: 6, processSession: 1, consoleSession: 1, inJob: true, jobLimitFlags: 0x2800, jobUiRestrictions: 0,
    windowStation: "WinSta0", desktop: "Default",
    chain: [{ name: "node.exe", service: false }, { name: "bash.exe", service: false }, { name: "Runner.Worker.exe", service: false }, { name: "Runner.Listener.exe", service: false }, { name: "RunnerService.exe", service: true }, { name: "services.exe", service: false }],
  };
  assert.deepEqual(probeLines(raw), [
    "session: this process 1, console session 1",
    "console: this process has a console no; the helper (started by this process with windowsHide) got a console window no",
    "job object: this process in a job yes, limit flags 0x00002800, UI restrictions 0x00000000 (read by the helper in the same job)",
    "parents (this process first): nodeExe < bashExe < RunnerWorkerExe < RunnerListenerExe < RunnerServiceExe(service) < servicesExe; under a Windows service yes",
    "window station WinSta0, desktop Default (the helper's, inherited from this process)",
  ]);
  const attached = probeLines({ ...raw, attachError: 0, inJob: false, chain: [{ name: "node.exe" }, { name: "pwsh.exe" }, { name: "explorer.exe" }], windowStation: "Service-0x0-3e7$" });
  assert.match(attached[1], /has a console yes;/);
  assert.equal(attached[2], "job object: this process in a job no");
  assert.match(attached[3], /nodeExe < pwshExe < explorerExe; under a Windows service no$/);
  assert.match(attached[4], /^window station Service-0x0-3e7\$,/);
});

test("the helper's answer: missing or odd values are unknown or other, never copied", () => {
  for (const raw of [null, undefined, "x", 7, []]) {
    const lines = probeLines(raw);
    assert.equal(lines[0], "session: this process unknown, console session unknown");
    assert.match(lines[1], /has a console unknown;.*window unknown$/);
    assert.equal(lines[2], "job object: this process in a job unknown");
    assert.equal(lines[3], "parents (this process first): unknown; under a Windows service unknown");
  }
  const odd = probeLines({ attachError: 5, processSession: -1, consoleSession: "1", inJob: true, jobLimitFlags: "C:\\Users\\Jane", windowStation: "C:\\Users\\Jane", desktop: "a b", chain: [{ name: "C:\\Users\\Jane\\evil.exe", service: "yes" }, { name: 5 }] });
  const text = odd.join("\n");
  assert.ok(!text.includes("Jane"), text);
  assert.match(text, /has a console unknown \(error 5\)/);
  assert.match(text, /this process unknown, console session unknown/);
  assert.match(text, /limit flags unknown/);
  assert.match(text, /parents \(this process first\): other < other; under a Windows service no/);
  assert.match(text, /window station other, desktop other/);
  assert.equal(chainLabel("NODE.EXE"), "nodeExe");
  assert.equal(chainLabel(undefined), "other");
});

test("wsb list once: each outcome in fixed words with its duration and markers; the error line is cleaned and cut", () => {
  assert.equal(wsbListLine({ status: 0, signal: null, stdout: "\r\n", stderr: "", durationMs: 812.4 }), `wsb list (once, limit ${WSB_LIST_TIMEOUT_MS} ms): answered (exit 0) after 812 ms; output lines 0; markers: none; first error line: none`);
  assert.match(wsbListLine({ status: 0, signal: null, stdout: "abc-1\r\ndef-2\r\n", stderr: "", durationMs: 5 }), /output lines 2;/);
  const grpc = "Grpc.Core.RpcException: Status(StatusCode=\"DeadlineExceeded\", Detail=\"failed to connect to localhost:80 (timed out)\")";
  const failed = wsbListLine({ status: 2148734208, signal: null, stdout: "", stderr: `${grpc}\r\nCancelled\r\n`, durationMs: 30_123 });
  assert.match(failed, /: failed \(exit 0x80131500\) after 30123 ms; output lines 0; markers: grpc, localhost:80, deadline, cancelled, timed out; first error line: Grpc\.Core\.RpcException/);
  assert.match(wsbListLine({ status: null, signal: "SIGTERM", error: Object.assign(new Error("spawnSync wsb ETIMEDOUT"), { code: "ETIMEDOUT" }), stdout: "", stderr: "", durationMs: 45_010 }), /: no answer within 45000 ms \(stopped\) after 45010 ms;/);
  assert.match(wsbListLine({ status: null, signal: null, error: Object.assign(new Error("spawnSync wsb ENOENT"), { code: "ENOENT" }), durationMs: 3 }), /: not found on PATH after 3 ms;/);
  assert.match(wsbListLine({ status: 1, signal: null, stdout: "", stderr: "Access is denied.", durationMs: 1 }), /markers: access denied;/);
  // A key in the error output is removed by the shared scanner; a long line is cut.
  const keyed = wsbListLine({ status: 1, signal: null, stdout: "", stderr: `token=${KEY} ${"x".repeat(400)}`, durationMs: 1 });
  assert.ok(!keyed.includes(KEY.slice(4)), keyed);
  assert.ok(keyed.length < 400, String(keyed.length));
  assert.match(wsbListLine({}), /: unknown after unknown ms;/);
});

test("rendered lines carry the prefix and pass the shared credential scanner unchanged when they hold no key", () => {
  assert.equal(usesSharedScanner(), true, "the contracts package is built (the test run builds first)");
  const lines = [
    "terminals: stdin no, stdout no, stderr no", "account: a local or domain account; is the console user yes; in the console session yes; someone signed in at the console yes; console locked no",
    "integrity level high (whoami /groups label); Administrators enabled",
    ...probeLines({ helperConsoleWindow: false, attachError: 6, processSession: 1, consoleSession: 1, inJob: true, jobLimitFlags: 0x2800, jobUiRestrictions: 0, windowStation: "WinSta0", desktop: "Default", chain: [{ name: "node.exe" }] }),
    wsbListLine({ status: 2148734208, signal: null, stdout: "", stderr: "Status(StatusCode=\"DeadlineExceeded\")\nCancelled", durationMs: 30_000 }),
    ...envNameLines(["PATH", "GITHUB_TOKEN", "ACTIONS_RUNTIME_TOKEN", "ACTIONS_ID_TOKEN_REQUEST_URL", "NIMBLENEWT_WSB_OUT", "ProgramFiles(x86)", "SESSIONNAME"]),
  ];
  assert.deepEqual(render(lines), lines.map((l) => `${PREFIX}${l}`));
  assert.ok(!render([`x ${KEY}`])[0].includes(KEY));
});

test("the helper script: fixed text, writes its answer only to the file in NN_OUT, reads only NN_PID and NN_OUT", () => {
  assert.doesNotMatch(PROBE_SCRIPT, /\$\{/);
  assert.doesNotMatch(PROBE_SCRIPT, /Write-(Output|Host)|\[Console\]::Write/);
  assert.match(PROBE_SCRIPT, /\[System\.IO\.File\]::WriteAllText\(\$env:NN_OUT,/);
  assert.deepEqual([...new Set([...PROBE_SCRIPT.matchAll(/\$env:([A-Za-z_]+)/g)].map((m) => m[1]))].sort(), ["NN_OUT", "NN_PID"]);
  // It leaves its own console before attaching to node's, and frees node's again.
  assert.ok(PROBE_SCRIPT.indexOf("FreeConsole();") < PROBE_SCRIPT.indexOf("AttachConsole(pid)"));
  assert.match(PROBE_SCRIPT, /if \(attachError == 0\) FreeConsole\(\);/);
});

test("run off Windows: says so, prints names never values, through redact-log nothing is withheld, exits 0", { skip: process.platform === "win32" ? "the off-Windows answer" : false }, () => {
  const env = { PATH: process.env.PATH, HOME: "/home/janedoe", NN_TEST_SECRET: KEY, COMPUTERNAME: "MYPC" };
  const r = spawnSync(process.execPath, [script], { encoding: "utf8", env });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.trimEnd().split("\n");
  assert.match(lines[0], /^wsb job context: not Windows; terminals: stdin (yes|no), stdout no, stderr no$/);
  for (const l of lines) assert.ok(l.startsWith(PREFIX), l);
  assert.match(r.stdout, /environment names: .*\bNN_TEST_SECRET\b/);
  assert.ok(!r.stdout.includes(KEY) && !r.stdout.includes("janedoe"), r.stdout);
  const red = spawnSync(process.execPath, [join(root, "scripts", "redact-log.mjs")], { input: r.stdout, encoding: "utf8", env: { ...process.env, COMPUTERNAME: "MYPC" } });
  assert.equal(red.status, 0, red.stderr);
  assert.equal(red.stdout, r.stdout, "fixed words pass the log redaction unchanged");
});

test("the helper's answer: no console session attached, an empty chain, and the array form of Windows PowerShell 5.1", () => {
  const base = { processSession: 2, consoleSession: 0xffffffff, chain: [] };
  const lines = probeLines(base);
  assert.equal(lines[0], "session: this process 2, console session none attached");
  assert.equal(lines[3], "parents (this process first): unknown; under a Windows service unknown");
  const wrapped = probeLines({ ...base, chain: { value: [{ name: "node.exe" }, { name: "services.exe", service: true }], Count: 2 } });
  assert.equal(wrapped[3], "parents (this process first): nodeExe < servicesExe(service); under a Windows service yes");
});

test("a bounded run's result: stopped, not found, exit codes; the runner's own stop text is not read as wsb's", () => {
  const stopped = wsbListLine(fromBounded({ code: null, stdout: "", stderr: "Cancelled\r\ntimed out after 45 s and was stopped", timedOut: true }, 45_100));
  assert.match(stopped, /: no answer within 45000 ms \(stopped\) after 45100 ms; output lines 0; markers: cancelled; first error line: Cancelled$/);
  assert.match(wsbListLine(fromBounded({ code: null, stdout: "", stderr: "timed out after 45 s and was stopped", timedOut: true }, 50_000)), /markers: none; first error line: none$/);
  assert.match(wsbListLine(fromBounded({ code: null, stdout: "", stderr: "spawn wsb ENOENT", timedOut: false }, 4)), /: not found on PATH after 4 ms;/);
  assert.match(wsbListLine(fromBounded({ code: 2147942405, stdout: "", stderr: "Access is denied.", timedOut: false }, 9)), /: failed \(exit 0x80070005\) after 9 ms; .*markers: access denied;/);
  assert.match(wsbListLine(fromBounded({ code: 0, stdout: "a\r\n", stderr: "", timedOut: false }, 9)), /: answered \(exit 0\) after 9 ms; output lines 1;/);
  assert.match(wsbListLine(fromBounded({ code: null, stdout: "", stderr: "stdout maxBuffer length exceeded", timedOut: false }, 9)), /: could not run after 9 ms;/);
});

test("the Windows facts through the backend's bounded runner: whoami, the helper with NN_PID and NN_OUT, the console user, then one wsb list", async () => {
  const calls = [];
  const host = {
    session: async () => ({ processIsConsoleUser: true, processInConsoleSession: true, consoleUser: "DESKTOP-1\\jane", locked: false }),
    run: async (file, args, options) => {
      calls.push({ file, args, options });
      if (/whoami\.exe$/.test(file)) return { code: 0, stdout: args[0] === "/user" ? '"desktop-1\\jane","S-1-5-21-1-2-3-1001"' : GROUPS_HIGH, stderr: "", timedOut: false };
      if (/powershell\.exe$/.test(file)) {
        writeFileSync(options.env.NN_OUT, JSON.stringify({ helperConsoleWindow: false, attachError: 6, processSession: 1, consoleSession: 1, inJob: false, windowStation: "WinSta0", desktop: "Default", chain: [{ name: "node.exe" }] }));
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      }
      return { code: null, stdout: "", stderr: "Grpc failed to connect to localhost:80\ntimed out after 45 s and was stopped", timedOut: true };
    },
  };
  const lines = [];
  const state = {};
  await windowsLines(lines, state, async () => host);
  assert.deepEqual(lines.slice(0, 2), ["account: a local or domain account", "integrity level high (whoami /groups label); Administrators enabled"]);
  assert.equal(lines[2], "session: this process 1, console session 1");
  assert.equal(lines[7], "console user: is the console user yes; in the console session yes; someone signed in at the console yes; console locked no");
  assert.match(lines[8], /^wsb list \(once, limit 45000 ms\): no answer within 45000 ms \(stopped\) after \d+ ms; output lines 0; markers: grpc, localhost:80; first error line: Grpc/);
  assert.equal(lines.length, 9);
  assert.ok(!lines.join("\n").includes("jane"), lines.join("\n"));
  assert.equal(state.console, undefined);
  // The helper gets this process's id and a file to write; wsb runs last, from PATH, with its own limit.
  const helper = calls.find((c) => /powershell\.exe$/.test(c.file));
  assert.equal(helper.options.env.NN_PID, String(process.pid));
  assert.equal(helper.options.timeoutMs, PROBE_TIMEOUT_MS);
  assert.deepEqual(helper.args.slice(0, 5), ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"]);
  assert.deepEqual(calls.at(-1), { file: "wsb", args: ["list"], options: { timeoutMs: WSB_LIST_TIMEOUT_MS } });
  assert.equal(calls.filter((c) => /whoami\.exe$/.test(c.file) && c.options.timeoutMs === WHOAMI_TIMEOUT_MS).length, 2);

  // No helper answer and an unreadable session: every fact unknown, the helper's end recorded, wsb still run.
  const quiet = { session: async () => { throw new Error("C:\\Users\\jane failed"); }, run: async (file) => ({ code: /powershell/.test(file) ? 1 : 0, stdout: "", stderr: "", timedOut: false }) };
  const l2 = [];
  await windowsLines(l2, {}, async () => quiet);
  assert.match(l2.join("\n"), /helper: no answer \(exit 0x00000001, \d+ ms\)/);
  assert.ok(l2.includes("console user: not readable"));
  assert.match(l2.at(-1), /: answered \(exit 0\)/);
  assert.ok(!l2.join("\n").includes("jane"));

  // No build: one line, nothing run.
  const l3 = [];
  await windowsLines(l3, {}, async () => { throw new Error("missing"); });
  assert.deepEqual(l3, ["not recorded: the worker build could not be loaded (run npm run build first)"]);
});

test("time: the slowest path (each limit reached, up to 20 s each to stop a tree) ends before the overall limit, which ends well before the step's 5 minutes", () => {
  const stop = 20_000;
  assert.ok(WHOAMI_TIMEOUT_MS + stop + PROBE_TIMEOUT_MS + stop + SESSION_WAIT_MS + WSB_LIST_TIMEOUT_MS + stop < OVERALL_LIMIT_MS);
  assert.ok(OVERALL_LIMIT_MS + 45_000 <= 5 * 60_000);
});
