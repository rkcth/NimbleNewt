// NimbleNewt experiment (not product code), round 5: why every program that needs user32 ends with 0xC0000142 inside the container when the launcher runs as a Windows SERVICE (session 0).
// Own-hardware run 45634597880 (the owner's Windows PC, build 26200, runner as a service, session id 0, elevated): `info` worked (the profile is created), but every program started inside the
// container ended with -1073741502 (0xC0000142, STATUS_DLL_INIT_FAILED) at once, except cmd.exe, which started (it printed "Access is denied." when it tried to run hostname.exe). The same
// launchers pass ten cases on the hosted runner (interactive session 2, build 26100). Sources and the ranked explanations are in implementation-notes.md ("Windows AppContainer experiment, round 5")
// and windows-isolation-plan.md; this file measures them, one thing at a time.
//
// Every step is one launcher run of its own (limit 15 s), with a line BEFORE (`ATTEMPT`) and one AFTER (`RESULT`) it in the progress stream and in `session0.progress`, and the results so far are
// rewritten to `session0.partial.json` after every step, so a hang or a kill loses at most the step it happened in. The dimensions, each varied alone from the baseline
// (desktop `inherit`, creation `no-window`, the program's folder granted):
//   A. the program: cmd.exe, hostname.exe, whoami.exe, a GUI-subsystem program (wscript.exe), powershell.exe, node.exe in its install folder, a COPY of node.exe and of cmd.exe in a folder the
//      container was granted (separates "the ACL of the program's folder" from "which program"), cmd.exe running node and hostname, node without any grant on its folder;
//   B. the window station and desktop (the launcher's `--desktop`): lpDesktop NULL / empty / "WinSta0\Default"; an entry for the container on the launcher's own station and desktop (read level,
//      full level, only the station, only the desktop); a desktop made for the run in the current station; a window station and desktop made for the run;
//   C. the creation flag (the launcher's `--creation`): CREATE_NO_WINDOW (baseline), DETACHED_PROCESS, none, CREATE_NEW_CONSOLE, each with the baseline desktop and with the full entry;
// plus the context the launcher runs in (`context`: window station and desktop names and their DACLs, session, integrity, OS build; the programs' import tables; security software; code-integrity
// events). Nothing here changes the machine for longer than a run: the entries on the launcher's window objects are removed again and read back (`desktop-revoke` also runs at the start and the end).
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, appendFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { aclReadBack, buildChildEnv, buildCommandLine, buildFixturePlan, parseLauncherLine, removeTree, stderrHead } from "./lib.mjs";

export const SESSION0_SCHEMA = "nn-appc-session0-1";
/** The desktop modes that write a DACL of the launcher's own window station or desktop: after such a step that did not report everything reverted, `desktop-revoke` runs at once. */
export const WRITING_DESKTOP_MODES = ["grant-read", "grant-full", "grant-station", "grant-desktop", "new-desktop"];
/** The limit of one step. */
export const SESSION0_STEP_TIMEOUT_MS = 15_000;
/** The longest the clean-up after the last step can take by its own limits: desktop-revoke (60 s), the folder ACL read-back (check, revoke, check: 3 x 120 s), the events script (120 s)
 * and the profile deletion (60 s). */
export const SESSION0_CLEANUP_WORST_MS = 60_000 + 3 * 120_000 + 120_000 + 60_000;
/** The workflow step's own limit (timeout-minutes: 25), which kills the harness. */
export const SESSION0_WORKFLOW_STEP_MS = 25 * 60_000;
/** No step is STARTED when it could end after this much time since the start (its own limit, the harness's margin of 60 s, and for a step that writes a DACL the desktop-revoke
 * after it, 60 s), so the whole clean-up fits before the workflow step's limit even when every call takes its full limit (second review: 19 min plus a 10-minute clean-up did not).
 * The steps not started are reported as `not-started`. */
export const SESSION0_BUDGET_MS = SESSION0_WORKFLOW_STEP_MS - SESSION0_CLEANUP_WORST_MS;
export const DLL_INIT_FAILED = -1073741502; // 0xC0000142 as the signed exit code the launcher reports

export const DESKTOP_MODES = ["inherit", "empty", "winsta0", "grant-read", "grant-full", "grant-station", "grant-desktop", "new-desktop", "new-station"];
export const CREATION_MODES = ["no-window", "detached", "none", "new-console"];
export const PROGRAMS = ["cmd-exit", "hostname", "whoami", "gui-wscript", "powershell", "node-installed", "node-copy", "cmd-copy", "cmd-runs-node", "cmd-runs-hostname", "node-nogrant"];

const safe = (fn) => { try { return fn(); } catch { return undefined; } };
export const hex32 = (n) => (Number.isInteger(n) ? `0x${(n >>> 0).toString(16).toUpperCase().padStart(8, "0")}` : "?");

// ---------------------------------------------------------------------------------------------------------------- the steps

/** One-line words for what each dimension value does (used in the report's table). */
export const DESKTOP_WORDS = {
  inherit: "lpDesktop NULL (the product's behaviour: the child takes the launcher's window station and desktop)",
  empty: "lpDesktop is an empty string",
  winsta0: "lpDesktop is WinSta0\\Default (the interactive station; expected to be refused or empty in session 0)",
  "grant-read": "an entry (read level) for the container on the launcher's window station and desktop",
  "grant-full": "an entry (full level) for the container on the launcher's window station and desktop",
  "grant-station": "an entry (full) on the launcher's window station only",
  "grant-desktop": "an entry (full) on the launcher's desktop only",
  "new-desktop": "a desktop made for the run in the launcher's window station (station entry too), lpDesktop names it",
  "new-station": "a window station and desktop made for the run, both with an entry for the container, lpDesktop names them",
};
export const CREATION_WORDS = { "no-window": "CREATE_NO_WINDOW (the product)", detached: "DETACHED_PROCESS", none: "no console flag", "new-console": "CREATE_NEW_CONSOLE" };

/** The steps in the order they run: A programs, B desktops, C creation flags, D the folder entry. Ids are unique and name their dimension values. */
export function session0Steps() {
  const out = [];
  const add = (group, program, desktop = "inherit", creation = "no-window") => out.push({ id: `${group}-${program}-${desktop}-${creation}`, group, program, desktop, creation });
  for (const program of PROGRAMS.filter((p) => p !== "node-nogrant")) add("A", program);
  const desktopPrograms = ["node-installed", "cmd-runs-node", "powershell", "gui-wscript", "hostname", "node-copy"];
  for (const desktop of DESKTOP_MODES.filter((d) => d !== "inherit")) for (const program of desktopPrograms) add("B", program, desktop);
  for (const creation of CREATION_MODES.filter((c) => c !== "no-window")) for (const program of ["node-installed", "cmd-runs-node", "hostname"]) for (const desktop of ["inherit", "grant-full"]) add("C", program, desktop, creation);
  for (const desktop of ["inherit", "grant-full"]) add("D", "node-nogrant", desktop);
  return out;
}

export function selectSession0Steps(spec, all = session0Steps()) {
  if (spec === undefined || spec === "all") return all;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((s) => s.id === w));
  if (unknown.length > 0) throw new Error(`unknown session0 step: ${unknown.join(", ")}`);
  return all.filter((s) => wanted.includes(s.id));
}

/** Program and arguments of a step (pure). `plan.binDir` holds the copies; `ctx.systemRoot` and `ctx.nodeExe` come from the machine. */
export function programCommand(program, plan, ctx, files) {
  const sys = ctx.systemRoot ?? "C:\\Windows";
  const s32 = (...p) => win32.join(sys, "System32", ...p);
  const marker = `require('fs').writeFileSync(${JSON.stringify(files.marker)},'ran')`;
  switch (program) {
    case "cmd-exit": return { exe: s32("cmd.exe"), args: ["/c", "exit", "0"] };
    case "hostname": return { exe: s32("hostname.exe"), args: [] };
    case "whoami": return { exe: s32("whoami.exe"), args: [] };
    case "gui-wscript": return { exe: s32("wscript.exe"), args: ["//B", "//Nologo", win32.join(plan.probeDir, "quit.js")] };
    case "powershell": return { exe: s32("WindowsPowerShell", "v1.0", "powershell.exe"), args: ["-NoProfile", "-NonInteractive", "-Command", "exit 0"] };
    case "node-installed": case "node-nogrant": return { exe: ctx.nodeExe, args: ["-e", marker], marker: true };
    case "node-copy": return { exe: win32.join(plan.binDir, "node.exe"), args: ["-e", marker], marker: true };
    case "cmd-copy": return { exe: win32.join(plan.binDir, "cmd.exe"), args: ["/c", "exit", "0"] };
    case "cmd-runs-node": return { exe: s32("cmd.exe"), args: ["/c", ctx.nodeExe, "-e", "0"] };
    case "cmd-runs-hostname": return { exe: s32("cmd.exe"), args: ["/c", s32("hostname.exe")] };
    default: return undefined;
  }
}

export function stepFiles(step, plan) {
  const base = join(plan.scratch, `s0-${step.id}`);
  return { marker: `${base}.marker`, stdout: join(plan.outDir, `${step.id}.out.txt`), stderr: join(plan.outDir, `${step.id}.err.txt`) };
}

/** The launcher's argument list for one step (pure). Job limits are the product's (memory, active processes, UI limits). */
export function buildSession0Args(step, plan, ctx, files, timeoutMs = SESSION0_STEP_TIMEOUT_MS) {
  const cmd = programCommand(step.program, plan, ctx, files);
  const args = ["run", "--name", ctx.profileName];
  for (const [mode, path] of [["modify", plan.workspace], ["modify", plan.home], ["modify", plan.scratch], ["ro", plan.probeDir]]) args.push("--grant", `${mode}:${path}`);
  // The program folders (node, git) are granted unless the step is the one that leaves node's folder out.
  if (step.program !== "node-nogrant") for (const d of ctx.programDirs ?? []) args.push("--grant-soft", `rx:${d}`);
  args.push("--aap-policy", "none", "--memory-mb", "4096", "--active-processes", "64", "--ui-limits", "--timeout-ms", String(timeoutMs));
  args.push("--desktop", step.desktop, "--creation", step.creation);
  args.push("--stdout", files.stdout, "--stderr", files.stderr, "--cwd", plan.workspace);
  for (const [k, v] of Object.entries(buildChildEnv(plan, ctx))) args.push("--env", `${k}=${v}`);
  args.push("--exe", cmd.exe, "--cmdline", buildCommandLine(cmd.exe, cmd.args));
  return args;
}

// ---------------------------------------------------------------------------------------------------------------- judging

/** A step's outcome in words: works; dll-init-failed (0xC0000142); exit-N (0x...); hang; launcher-refused; desktop-setup-failed; ran-no-marker. */
export function judgeSession0(step, line, markerExists) {
  const rec = { id: step.id, group: step.group, program: step.program, desktop: step.desktop, creation: step.creation };
  if (line === undefined) return { ...rec, outcome: "launcher-refused", detail: "the launcher printed no JSON line" };
  const desktop = line.desktop && typeof line.desktop === "object" ? line.desktop : undefined;
  if (line.childStarted !== true) {
    const stage = String(line.stage ?? "?");
    // The launcher reports a window-object set-up failure under its `grant` stage (an entry on a window object is a grant; the product's stage list stays as it is): the message starts with "window objects:".
    const desktopSetup = /^window objects:/.test(String(line.error ?? ""));
    return { ...rec, outcome: desktopSetup ? "desktop-setup-failed" : "launcher-refused", detail: `${stage}: ${line.error ?? "no message"}`, desktopObjects: desktop };
  }
  const base = { ...rec, elapsedMs: line.elapsedMs, exitCode: line.childExitCode, exitHex: hex32(line.childExitCode), marker: markerExists, desktopObjects: desktop, lpDesktop: desktop?.lpDesktop };
  if (line.timedOut === true) return { ...base, outcome: "hang" };
  if (line.childExitCode === 0) return { ...base, outcome: markerExists === false ? "ran-no-marker" : "works" };
  if (line.childExitCode === DLL_INIT_FAILED) return { ...base, outcome: "dll-init-failed" };
  return { ...base, outcome: `exit-${line.childExitCode} (${hex32(line.childExitCode)})` };
}

const works = (r) => r.outcome === "works";
const failedInit = (r) => r.outcome === "dll-init-failed";

/** Counts by dimension value, and the baseline. */
export function summarizeSession0(results) {
  const tally = (key) => Object.fromEntries([...new Set(results.map((r) => r[key]))].map((v) => [String(v), { works: results.filter((r) => r[key] === v && works(r)).length, total: results.filter((r) => r[key] === v).length }]));
  const outcomes = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return { byProgram: tally("program"), byDesktop: tally("desktop"), byCreation: tally("creation"), outcomes, interpretation: interpretSession0(results) };
}

/**
 * What the outcomes point to (pointers for the next decision, not proofs; the labels are the ranked explanations of the notes):
 *   H1 the container has no access to the service's non-interactive window station and desktop (user32 fails to initialise);
 *   H2 which desktop the child is attached to matters beyond the access (lpDesktop semantics);
 *   H3 the console flag (conhost) matters;
 *   H4 the access control of the program's own folder matters;
 *   H5 security software or code integrity stops something in the child, whatever the desktop;
 *   H6 something specific to this Windows build.
 */
export function interpretSession0(results) {
  const find = (program, desktop = "inherit", creation = "no-window") => results.find((r) => r.program === program && r.desktop === desktop && r.creation === creation);
  const out = [];
  const base = find("node-installed");
  if (base === undefined) return ["the baseline step (node-installed, inherit, no-window) did not run: nothing to compare"];
  if (works(base)) {
    out.push("NOT reproduced: node.exe started inside the container with the baseline settings in this run, so the 0xC0000142 failure did not occur here (compare the context: session, window station, build)");
    return out;
  }
  if (!failedInit(base)) out.push(`the baseline node.exe step ended differently from 0xC0000142: ${base.outcome}${base.detail ? ` (${base.detail})` : ""}`);
  const fixes = (desktop) => results.filter((r) => r.desktop === desktop && r.group === "B" && works(r)).map((r) => r.program);
  const grantModes = ["grant-read", "grant-full", "grant-station", "grant-desktop", "new-desktop", "new-station"];
  const fixedBy = grantModes.filter((d) => fixes(d).includes("node-installed"));
  if (fixedBy.length > 0) {
    out.push(`H1 supported: node.exe starts once the container is given access to a window station and desktop (${fixedBy.join(", ")}); with the baseline it fails`);
    const needsBoth = fixedBy.includes("grant-full") && !fixedBy.includes("grant-station") && !fixedBy.includes("grant-desktop");
    if (needsBoth) out.push("both objects are needed: an entry on the window station alone or the desktop alone is not enough");
    else if (fixedBy.includes("grant-station") && !fixedBy.includes("grant-desktop")) out.push("the window station entry alone is enough; the desktop entry alone is not");
    else if (fixedBy.includes("grant-desktop") && !fixedBy.includes("grant-station")) out.push("the desktop entry alone is enough; the window station entry alone is not");
    if (fixedBy.includes("grant-full") && !fixedBy.includes("grant-read")) out.push("the read level (documented GENERIC_READ mapping) is not enough; the full level is");
    if (fixedBy.includes("grant-read")) out.push("the read level is enough (the smallest entry measured)");
    if (fixedBy.includes("new-station") || fixedBy.includes("new-desktop")) out.push(`objects made for the run work (${["new-desktop", "new-station"].filter((d) => fixedBy.includes(d)).join(", ")}): a product fix need not touch the service's own window objects`);
  } else {
    out.push("no window station or desktop variant made node.exe start: H1 is not supported by this run (or the access needed is wider than the entries tried)");
  }
  const other = ["empty", "winsta0"].filter((d) => fixes(d).includes("node-installed"));
  if (other.length > 0) out.push(`H2: node.exe starts with lpDesktop ${other.join(" / ")} without any entry: which desktop the child is attached to decides, not only the access`);
  const creationFix = results.filter((r) => r.group === "C" && r.program === "node-installed" && r.desktop === "inherit" && works(r)).map((r) => r.creation);
  if (creationFix.length > 0) out.push(`H3: node.exe starts with the creation flag ${creationFix.join(" / ")} and the baseline desktop: the console flag decides`);
  const copy = find("node-copy");
  if (copy && works(copy) && failedInit(base)) out.push("H4 pointer: a copy of node.exe in a granted folder starts but the installed one does not: the access control of node's install folder matters");
  else if (copy && failedInit(copy) && failedInit(base)) out.push("H4 weakened: a copy of node.exe in a folder the container was granted fails the same way, so the folder's access control is not the difference");
  const cmd = find("cmd-exit");
  const user32Fails = results.filter((r) => ["gui-wscript", "powershell"].includes(r.program) && r.desktop === "inherit" && r.creation === "no-window" && failedInit(r));
  if (cmd && works(cmd) && user32Fails.length > 0) out.push("the split matches the user32 explanation: cmd.exe starts, programs that use windows or the desktop heap (gui-wscript, powershell, node) fail; the import tables in the context say which programs load user32");
  const nogrant = find("node-nogrant");
  if (nogrant && base && nogrant.outcome === base.outcome) out.push("no grant on node's folder gives the same outcome as with the grant: the grant on the node folder is not what the failure depends on");
  if (fixedBy.length === 0 && other.length === 0 && creationFix.length === 0) out.push("H5/H6 remain: nothing varied here changes the outcome; read the context's security software and code-integrity events, and the OS build, before the next round");
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- the machine's context

/** Where a PE file's import tables say it links (DLL names, lower case): the normal and the delay-load tables. Pure; returns undefined for anything that is not a PE file. */
export function peImports(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 0x40 || buf.readUInt16LE(0) !== 0x5a4d) return undefined;
  const pe = buf.readUInt32LE(0x3c);
  if (pe + 24 > buf.length || buf.readUInt32LE(pe) !== 0x4550) return undefined;
  const sections = buf.readUInt16LE(pe + 6);
  const optSize = buf.readUInt16LE(pe + 20);
  const opt = pe + 24;
  const magic = buf.readUInt16LE(opt);
  const dirs = opt + (magic === 0x20b ? 112 : magic === 0x10b ? 96 : -1);
  if (dirs < opt) return undefined;
  const table = opt + optSize;
  const secs = [];
  for (let i = 0; i < sections; i++) {
    const o = table + i * 40;
    if (o + 40 > buf.length) return undefined;
    secs.push({ va: buf.readUInt32LE(o + 12), vsize: buf.readUInt32LE(o + 8), raw: buf.readUInt32LE(o + 20), rawSize: buf.readUInt32LE(o + 16) });
  }
  const off = (rva) => { const s = secs.find((x) => rva >= x.va && rva < x.va + Math.max(x.vsize, x.rawSize)); return s === undefined ? -1 : s.raw + (rva - s.va); };
  const cstr = (o) => { if (o < 0 || o >= buf.length) return undefined; let e = o; while (e < buf.length && buf[e] !== 0 && e - o < 256) e++; return buf.toString("latin1", o, e).toLowerCase(); };
  const names = { normal: [], delay: [] };
  const walk = (index, size, nameAt, key) => {
    if (dirs + (index + 1) * 8 > buf.length) return;
    const rva = buf.readUInt32LE(dirs + index * 8);
    if (rva === 0) return;
    let o = off(rva);
    for (let guard = 0; o >= 0 && o + size <= buf.length && guard < 512; guard++, o += size) {
      if (buf.readUInt32LE(o + nameAt) === 0) break;
      const n = cstr(off(buf.readUInt32LE(o + nameAt)));
      if (n !== undefined) names[key].push(n);
    }
  };
  walk(1, 20, 12, "normal"); // IMAGE_DIRECTORY_ENTRY_IMPORT: descriptors of 20 bytes, the name RVA at offset 12
  walk(13, 32, 4, "delay"); // IMAGE_DIRECTORY_ENTRY_DELAY_IMPORT: descriptors of 32 bytes, the name RVA at offset 4
  return names;
}

/** A fixed, read-only PowerShell script: security software and the state of Smart App Control. No input is put into it. */
export const FACTS_SCRIPT = `$ErrorActionPreference = 'Stop'
$o = [ordered]@{}
try { $o.antivirus = @(Get-CimInstance -Namespace root/SecurityCenter2 -ClassName AntiVirusProduct | ForEach-Object { $_.displayName }) } catch { $o.antivirusError = $_.Exception.GetType().Name }
try { $o.smartAppControlState = (Get-ItemProperty -LiteralPath 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\CI\\Policy').VerifiedAndReputablePolicyState } catch { $o.smartAppControlError = $_.Exception.GetType().Name }
try { $o.edition = (Get-CimInstance Win32_OperatingSystem).Caption } catch { $o.editionError = $_.Exception.GetType().Name }
$o | ConvertTo-Json -Compress`;

/** The read-only script for code-integrity and AppLocker events since a time (digits and punctuation of an ISO date only; anything else is refused by the caller). */
export function eventsScript(sinceIso) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/.test(sinceIso)) throw new Error("not an ISO time");
  return `$ErrorActionPreference = 'Stop'
$since = [DateTime]::Parse('${sinceIso}').ToUniversalTime()
$o = [ordered]@{}
foreach ($log in @('Microsoft-Windows-CodeIntegrity/Operational', 'Microsoft-Windows-AppLocker/EXE and DLL')) {
  try {
    $ev = @(Get-WinEvent -FilterHashtable @{ LogName = $log; StartTime = $since } -MaxEvents 40 -ErrorAction Stop)
    $o[$log] = @($ev | ForEach-Object { [ordered]@{ id = $_.Id; level = $_.LevelDisplayName; text = ($_.Message -replace '\\s+', ' ').Substring(0, [Math]::Min(180, $_.Message.Length)) } })
  } catch { $o[$log] = @{ error = $_.Exception.GetType().Name } }
}
$o | ConvertTo-Json -Compress -Depth 5`;
}

const parseJson = (text) => safe(() => JSON.parse(String(text ?? "").trim().split(/\r?\n/).filter(Boolean).at(-1)));

/** The window objects, session, integrity and build as the launcher sees them, plus the machine facts. `exec` runs the launcher; `ps` runs a PowerShell script. */
export function collectContext({ exec, launcherPath, ps, tools, sysRoot, readFile = (p) => readFileSync(p), since }) {
  const line = parseLauncherLine(safe(() => exec(launcherPath, ["context"], { timeoutMs: 30_000 }).stdout) ?? "");
  const launcher = line === undefined ? { ok: false, note: "the launcher gave no context line" } : {
    ok: line.ok === true, elevated: line.elevated, sessionId: line.sessionId, windowStation: line.windowStation, windowStationFlags: line.windowStationFlags, desktop: line.desktop,
    windowStationSddl: line.windowStationSddl, desktopSddl: line.desktopSddl, integrityRid: line.integrityRid, osMajor: line.osMajor, osMinor: line.osMinor, osBuild: line.osBuild,
  };
  launcher.serviceStation = typeof launcher.windowStation === "string" && /^Service-0x[0-9a-f]+-/i.test(launcher.windowStation);
  launcher.interactiveStation = typeof launcher.windowStationFlags === "number" && (launcher.windowStationFlags & 1) === 1;
  const imports = {};
  const s32 = sysRoot ? (n) => win32.join(sysRoot, "System32", n) : undefined;
  const programs = { "node.exe": tools?.nodeExe, ...(s32 ? { "cmd.exe": s32("cmd.exe"), "hostname.exe": s32("hostname.exe"), "whoami.exe": s32("whoami.exe"), "wscript.exe": s32("wscript.exe"), "powershell.exe": win32.join(sysRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe") } : {}) };
  for (const [name, path] of Object.entries(programs)) {
    if (!path) continue;
    const table = safe(() => peImports(readFile(path)));
    imports[name] = table === undefined ? { error: "not readable as a PE file" } : { user32: [...table.normal, ...table.delay].includes("user32.dll"), win32u: [...table.normal, ...table.delay].includes("win32u.dll"), normal: table.normal, delay: table.delay };
  }
  const facts = ps === undefined ? undefined : boundFacts(parseJson(safe(() => ps(FACTS_SCRIPT).stdout)));
  return { launcher, imports, facts: facts ?? { note: "machine facts were not read" }, startedAt: since };
}

/** The events script's result, after the steps (code-integrity and AppLocker events since the start). */
export function collectEvents({ ps, since }) {
  if (ps === undefined) return { note: "events were not read" };
  const r = parseJson(safe(() => ps(eventsScript(since)).stdout));
  return r === undefined ? { note: "events were not read" } : boundEvents(r);
}

/** Folder names under a user profile in event and product text become `<account>` (the event messages of code integrity name the files they are about, which can lie in ANY account's
 * profile, including the signed-in owner's, which the harness's own names do not cover). At most 40 entries per log and 180 characters per text; product names at most 8 of 80 characters. */
export function scrubUserPaths(text) {
  // A profile folder name may hold spaces: everything up to the next separator, quote or line end goes (more than the name at worst, never less).
  return String(text).replace(/([\\/]Users[\\/])[^\\/"'\r\n]+/gi, "$1<account>").replace(/([\\/]home[\\/])[^\\/"'\r\n]+/g, "$1<account>");
}

export function boundEvents(r) {
  if (r === null || typeof r !== "object") return { note: "events were not read" };
  const out = {};
  for (const [log, list] of Object.entries(r).slice(0, 4)) {
    out[log] = Array.isArray(list)
      ? list.slice(0, 40).map((e) => ({ id: Number.isInteger(e?.id) ? e.id : null, level: String(e?.level ?? "").slice(0, 20), text: scrubUserPaths(String(e?.text ?? "")).slice(0, 180) }))
      : { error: String(list?.error ?? "unreadable").slice(0, 80) };
  }
  return out;
}

export function boundFacts(f) {
  if (f === null || typeof f !== "object") return undefined;
  const out = { ...f };
  if (Array.isArray(f.antivirus)) out.antivirus = f.antivirus.slice(0, 8).map((n) => scrubUserPaths(String(n)).slice(0, 80));
  else if (f.antivirus !== undefined) out.antivirus = [scrubUserPaths(String(f.antivirus)).slice(0, 80)];
  if (f.edition !== undefined) out.edition = String(f.edition).slice(0, 80);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- the runner

export async function runSession0(opts) {
  const platform = opts.platform ?? process.platform;
  const pathApi = platform === "win32" ? win32 : { join, dirname, basename };
  const profileName = opts.profileName ?? "NimbleNewtExperiment";
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const timeoutMs = opts.timeoutMs ?? SESSION0_STEP_TIMEOUT_MS;
  const budgetMs = opts.budgetMs ?? SESSION0_BUDGET_MS;
  const clock = opts.clock ?? (() => Date.now());
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const progress = opts.progress ?? (() => {});
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  const t0 = clock();
  const say = (m) => progress(`${clock() - t0} ms ${m}`);
  const notes = [];
  // The container must exist for the grants; `info` creates it (and tells session and elevation).
  const info = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  if (info === undefined || info.ok !== true) {
    notes.push(`the launcher could not create or find the container (${info?.stage ?? "no answer"}); nothing was started`);
    return { report: { schema: SESSION0_SCHEMA, generatedAt: now, host, steps: [], notes }, markdown: "", ranAtAll: false, names };
  }
  const profile = { name: profileName, createdNow: info.profile === "created" };
  const sysRoot = opts.systemRoot ?? (platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const tools = opts.tools ?? {};
  const startedAt = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  say("ATTEMPT context");
  const context = collectContext({ exec: opts.exec, launcherPath: opts.launcherPath, ps: opts.dryRun ? undefined : opts.ps, tools, sysRoot, readFile: opts.readFile, since: startedAt });
  say(`RESULT context station=${context.launcher.windowStation ?? "?"} desktop=${context.launcher.desktop ?? "?"} session=${context.launcher.sessionId ?? "?"} build=${context.launcher.osBuild ?? "?"}`);
  const revoke = () => parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["desktop-revoke", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const leftoverBefore = opts.dryRun ? undefined : revoke();
  const results = [];
  const root = mkdtempSync(join(tmpBase, "nn-appc-"));
  names.root = root;
  const plan = { ...buildFixturePlan(root, pathApi), binDir: pathApi.join(root, "ws", "bin") };
  const ctx = { profileName, nodeExe: tools.nodeExe, programDirs: tools.programDirs ?? [], systemRoot: sysRoot, pathDirs: [...(tools.nodeExe ? [pathApi.dirname(tools.nodeExe)] : []), ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])] };
  const granted = new Set([plan.workspace, plan.home, plan.scratch, plan.probeDir, ...(ctx.programDirs ?? [])]);
  const partial = (done) => { try { opts.writePartial?.({ schema: SESSION0_SCHEMA, generatedAt: now, host, context, steps: results, done }); } catch { /* a failed progress write must not stop the run */ } };
  let finalLeft = [];
  let aclFirst = [];
  let desktopAfter;
  try {
    for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.probeDir, plan.binDir, plan.npmCache]) mkdirSync(d, { recursive: true });
    writeFileSync(join(plan.probeDir, "quit.js"), "WScript.Quit(0);\n");
    if (!opts.dryRun) {
      const copy = opts.copyFile ?? copyFileSync;
      for (const [from, to] of [[tools.nodeExe, "node.exe"], [sysRoot ? win32.join(sysRoot, "System32", "cmd.exe") : undefined, "cmd.exe"]]) {
        if (!from) continue;
        try { copy(from, join(plan.binDir, to)); } catch { notes.push(`${to} could not be copied into the workspace: the copy steps run a missing program`); }
      }
    }
    for (const step of selectSession0Steps(opts.stepSpec)) {
      const files = stepFiles(step, plan);
      // The time budget: a step that could end after it is not started (the clean-up below must run before the workflow's limit).
      if (!opts.dryRun && clock() - t0 + timeoutMs + 60_000 + (WRITING_DESKTOP_MODES.includes(step.desktop) ? 60_000 : 0) > budgetMs) {
        results.push({ id: step.id, group: step.group, program: step.program, desktop: step.desktop, creation: step.creation, outcome: "not-started", detail: `time budget: ${Math.round(budgetMs / 60_000)} min reached before this step` });
        continue;
      }
      say(`ATTEMPT step ${step.id}`);
      let rec;
      if (opts.dryRun) rec = { id: step.id, group: step.group, program: step.program, desktop: step.desktop, creation: step.creation, outcome: "not-started", detail: "dry run: the launcher was not started" };
      else {
        const wall = Date.now();
        const r = safe(() => opts.exec(opts.launcherPath, buildSession0Args(step, plan, ctx, files, timeoutMs), { timeoutMs: timeoutMs + 60_000 }));
        const line = parseLauncherLine(r?.stdout ?? "");
        const cmd = programCommand(step.program, plan, ctx, files);
        rec = { ...judgeSession0(step, line, cmd?.marker === true ? existsSync(files.marker) : undefined), wallMs: Date.now() - wall };
        if (rec.outcome !== "works") {
          rec.stderrHead = stderrHead(safe(() => readFileSync(files.stderr, "utf8")) ?? "", 3, 160);
          rec.stdoutHead = stderrHead(safe(() => readFileSync(files.stdout, "utf8")) ?? "", 2, 120);
        }
        const launcherLog = String(r?.stderr ?? "").split(/\r?\n/).filter((l) => l.startsWith("nn-desktop:"));
        if (launcherLog.length > 0 && step.desktop !== "inherit") rec.desktopLog = launcherLog.slice(0, 12);
        const left = (line?.grants ?? []).filter((g) => g.applied && (g.revoked !== true || (typeof g.entriesLeft === "number" && g.entriesLeft > 0)));
        if (left.length > 0) rec.aclLeftAfterRun = left.map((g) => ({ path: g.path, mode: g.mode, entriesLeft: g.entriesLeft ?? null }));
        if (line?.desktop && line.desktop.allReverted === false) rec.desktopNotReverted = true;
        // A step that wrote a DACL of the launcher's own objects and did not report everything reverted (no line: the launcher was killed or crashed) is cleaned up at once, so the next
        // step does not run with its entry still in place.
        if (WRITING_DESKTOP_MODES.includes(step.desktop) && line?.desktop?.allReverted !== true) {
          const after = revoke();
          rec.revokeAfterStep = after === undefined ? { ok: false, note: "desktop-revoke gave no line" } : { ok: after.ok === true, windowStation: after.windowStation?.entriesLeft ?? null, desktop: after.desktop?.entriesLeft ?? null };
          if (rec.revokeAfterStep.ok !== true) notes.push(`desktop-revoke after step ${step.id} did not report success`);
        }
      }
      results.push(rec);
      say(`RESULT step ${step.id} ${rec.outcome}${rec.exitHex && rec.outcome !== "works" ? ` ${rec.exitHex}` : ""}`);
      partial(false);
    }
    const skipped = results.filter((r) => r.outcome === "not-started" && /^time budget/.test(r.detail ?? "")).length;
    if (skipped > 0) { notes.push(`${skipped} steps were not started: the time budget (${Math.round(budgetMs / 60_000)} min) was reached`); say(`RESULT budget ${skipped} steps not started`); }
  } finally {
    if (!opts.dryRun) {
      desktopAfter = revoke();
      const rb = aclReadBack(opts.exec, opts.launcherPath, profileName, [...granted]);
      aclFirst = rb.first;
      finalLeft = rb.final;
    }
    try { removeTree(root); } catch { notes.push("a fixture folder could not be removed"); }
  }
  const events = opts.dryRun ? { note: "dry run" } : collectEvents({ ps: opts.ps, since: startedAt });
  let profileDeleted = false;
  if (!opts.dryRun && profile.createdNow) profileDeleted = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["delete-profile", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  const entriesLeft = (o) => (o === undefined ? null : { windowStation: o.windowStation?.entriesLeft ?? null, desktop: o.desktop?.entriesLeft ?? null });
  const report = {
    schema: SESSION0_SCHEMA, generatedAt: now, host, profile, stepTimeoutMs: timeoutMs, context, events,
    steps: results, summary: summarizeSession0(results),
    cleanup: { profileDeleted, grantsLeft: finalLeft.length, aclFirstReadBack: aclFirst, desktopEntriesLeftBefore: entriesLeft(leftoverBefore), desktopEntriesLeftAfter: entriesLeft(desktopAfter) },
    notes,
  };
  partial(true);
  return { report, markdown: renderSession0Markdown(report), ranAtAll: true, names };
}

const code = (t) => `\`${String(t).replaceAll("`", "'").replaceAll("|", "/")}\``;

/** What each outcome would mean (printed in every report so the reader of a run does not need the notes). */
export const OUTCOME_MEANINGS = [
  "H1 (most likely): the container's SID has no access to the service's non-interactive window station and desktop, so user32 cannot initialise. Outcome that supports it: node, powershell and the GUI program start with `grant-full` (and the made desktops), fail with `inherit`; cmd.exe starts either way.",
  "H2: the access is not the point, the attachment is. Outcome: `empty` or `winsta0` make the programs start with no entry on anything.",
  "H3: the console flag. Outcome: only a flag other than CREATE_NO_WINDOW lets console programs (node, hostname) start; the GUI program is unaffected.",
  "H4: access control of the program's folder. Outcome: the copy of node.exe in the granted folder starts while the installed one fails, or node without the folder grant behaves differently from node with it.",
  "H5: security software or code integrity. Outcome: nothing changes any cell; the context lists security products or events with a block in the run's time window.",
  "H6: this Windows build. Outcome: nothing changes any cell and no event or product explains it; the build is compared with the hosted runner's (26100) in the next step.",
];

export function renderSession0Markdown(report) {
  const L = ["# Windows AppContainer experiment, round 5: session 0 (the service context)", ""];
  const c = report.context?.launcher ?? {};
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}; elevated: ${report.host.elevated}; session id: ${report.host.sessionId}.`, "");
  L.push("## Context (read by the launcher itself, outside the container)", "");
  L.push(`- Window station ${code(c.windowStation ?? "?")} (visible/interactive: ${c.interactiveStation}; a service's non-interactive station: ${c.serviceStation}); desktop ${code(c.desktop ?? "?")}; integrity RID ${c.integrityRid ?? "?"}; OS ${c.osMajor ?? "?"}.${c.osMinor ?? "?"} build ${c.osBuild ?? "?"}.`);
  L.push(`- Window station DACL: ${code(c.windowStationSddl ?? "?")}`, `- Desktop DACL: ${code(c.desktopSddl ?? "?")}`);
  for (const [name, i] of Object.entries(report.context?.imports ?? {})) L.push(`- ${name}: ${i.error ? i.error : `user32 ${i.user32 ? "yes" : "no"}; imports ${[...i.normal, ...i.delay.map((d) => `${d} (delay)`)].join(", ")}`}`);
  L.push(`- Machine facts: ${code(JSON.stringify(report.context?.facts ?? {}))}`);
  L.push(`- Code-integrity and AppLocker events since the start: ${code(JSON.stringify(report.events ?? {}).slice(0, 600))}`, "");
  L.push(`## Steps (each a launcher run of its own, limit ${(report.stepTimeoutMs ?? SESSION0_STEP_TIMEOUT_MS) / 1000} s)`, "");
  L.push("| step | group | program | desktop | creation | outcome | exit | grandchild marker | ms |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  for (const r of report.steps) L.push(`| ${r.id} | ${r.group} | ${r.program} | ${r.desktop} | ${r.creation} | ${r.outcome} | ${r.exitHex ?? "-"} | ${r.marker === undefined ? "-" : r.marker} | ${r.wallMs ?? "-"} |`);
  L.push("");
  const s = report.summary ?? {};
  if (s.byProgram) {
    L.push("## What worked", "");
    for (const [label, key] of [["program", "byProgram"], ["desktop mode", "byDesktop"], ["creation flag", "byCreation"]]) L.push(`- By ${label}: ${Object.entries(s[key] ?? {}).map(([k, x]) => `${k} ${x.works}/${x.total}`).join(", ")}.`);
    L.push(`- Outcomes: ${Object.entries(s.outcomes ?? {}).map(([k, n]) => `${k} ${n}`).join(", ")}.`, "");
    L.push("## What the outcomes point to (pointers for the next decision, not proofs)", "");
    for (const t of s.interpretation ?? []) L.push(`- ${t}`);
    L.push("", "## What each outcome would mean", "");
    for (const t of OUTCOME_MEANINGS) L.push(`- ${t}`);
    L.push("");
  }
  const odd = report.steps.filter((r) => r.outcome !== "works");
  if (odd.length > 0) {
    L.push("## Steps that did not work", "");
    for (const r of odd) L.push(`- ${r.id}: ${r.outcome}${r.detail ? ` (${r.detail})` : ""}${r.lpDesktop ? `; lpDesktop ${code(r.lpDesktop)}` : ""}${(r.stderrHead ?? []).length > 0 ? `; stderr ${r.stderrHead.map(code).join(" | ")}` : ""}${(r.desktopLog ?? []).length > 0 ? `; launcher ${r.desktopLog.map(code).join(" | ")}` : ""}`);
    L.push("");
  }
  const cl = report.cleanup ?? {};
  L.push("## Clean-up", "", `- Profile deleted: ${cl.profileDeleted}; granted paths with an entry left: ${cl.grantsLeft}; entries for the container left on the launcher's window station and desktop: before the run ${code(JSON.stringify(cl.desktopEntriesLeftBefore))}, after ${code(JSON.stringify(cl.desktopEntriesLeftAfter))}.`);
  for (const n of report.notes ?? []) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

/** A progress sink for the command line: prints each line and appends it to a file, so a hang or a kill leaves the lines written so far. */
export function fileProgress(path, print = (m) => console.log(m)) {
  return (line) => { print(line); try { appendFileSync(path, `${line}\n`); } catch { /* the console line is still there */ } };
}
