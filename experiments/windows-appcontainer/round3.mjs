// NimbleNewt experiment (not product code), round 3: the git ladder, the junction/ACL-propagation check and the timing measurement.
// Round 2 (hosted Windows run 45504495155) showed: a plain AppContainer with no capability runs cmd, hostname and node; `git.exe --version` failed in EVERY variant with
//   fatal: could not open '/dev/null' for reading and writing: Permission denied    (exit 0x80)
// What the source says (git-for-windows/git, main):
//   * common-init.c `init_git()` calls `sanitize_stdfds()` on EVERY start of git ("Always open file descriptors 0/1/2 ..."),
//   * setup.c `sanitize_stdfds()` is `int fd = xopen("/dev/null", O_RDWR);` (it opens the device whether or not the standard handles are valid),
//   * wrapper.c `xopen()` dies with "could not open '%s' for reading and writing" when the open fails with O_RDWR,
//   * compat/mingw.c `mingw_open` maps the name "/dev/null" to the Windows device name L"nul" and opens it with the C runtime's `_wopen` (read AND write access).
// So git needs to open the NUL device with write access itself, whatever its standard handles are. Round 2's launcher gave the child a read-only NUL as standard input, which is not
// what git tests. The ladder below varies the things the brief names (standard handles as files, pipes or NUL read-write; environment; which git.exe; a copy; `cmd /c`; a git option),
// reads the DACL of the NUL device (is ALL APPLICATION PACKAGES, or the LPAC group ALL RESTRICTED APPLICATION PACKAGES, on it?) and has node open the device in every mode from inside the container, so
// the cause is shown by a measurement rather than assumed. This file is pure logic plus three runners that start only the launcher and PowerShell through injectable functions.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import { basename, dirname, join, win32 } from "node:path";
import { aclReadBack, buildFixturePlan, createFixtures, parseLauncherLine, removeTree, writeNpmProject } from "./lib.mjs";
import { STEP_TIMEOUT_MS, buildStepArgs, judgeStep, ladderGrants, ladderPlan, ladderVariants, launcherLeft } from "./ladder.mjs";

export const GIT_SCHEMA = "nn-appc-git-1";
export const LINKS_SCHEMA = "nn-appc-links-1";
export const TIMING_SCHEMA = "nn-appc-timing-1";

const safe = (fn) => { try { return fn(); } catch { return undefined; } };
const hexOf = (code) => (typeof code === "number" ? `0x${(code >>> 0).toString(16).toUpperCase()}` : "?");

// ---------------------------------------------------------------------------------------------------------------- the NUL device's DACL

/**
 * A fixed PowerShell script (no input is put into it): opens the NUL device for READ_CONTROL and prints its DACL and mandatory label as SDDL.
 * The call is made through P/Invoke because the device name is not a file-system path that Get-Acl accepts everywhere.
 */
export const NUL_ACL_SCRIPT = [
  "Add-Type -TypeDefinition @'",
  "using System;",
  "using System.Runtime.InteropServices;",
  "public static class NnNulAcl {",
  "  [DllImport(\"kernel32.dll\", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFileW(string n, uint a, uint s, IntPtr sa, uint d, uint f, IntPtr t);",
  "  [DllImport(\"kernel32.dll\")] static extern bool CloseHandle(IntPtr h);",
  "  [DllImport(\"advapi32.dll\")] static extern uint GetSecurityInfo(IntPtr h, int t, uint i, IntPtr o, IntPtr g, IntPtr d, IntPtr s, out IntPtr sd);",
  "  [DllImport(\"advapi32.dll\", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool ConvertSecurityDescriptorToStringSecurityDescriptorW(IntPtr sd, uint rev, uint info, out IntPtr str, IntPtr len);",
  "  [DllImport(\"kernel32.dll\")] static extern IntPtr LocalFree(IntPtr p);",
  "  public static string Sddl(string path) {",
  "    IntPtr h = CreateFileW(path, 0x20000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero);",
  "    if (h == (IntPtr)(-1)) return \"ERROR open \" + Marshal.GetLastWin32Error();",
  "    IntPtr sd; uint rc = GetSecurityInfo(h, 1, 0x14, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, IntPtr.Zero, out sd);",
  "    CloseHandle(h);",
  "    if (rc != 0) return \"ERROR GetSecurityInfo \" + rc;",
  "    IntPtr str; bool ok = ConvertSecurityDescriptorToStringSecurityDescriptorW(sd, 1, 0x14, out str, IntPtr.Zero);",
  "    string text = ok ? Marshal.PtrToStringUni(str) : \"ERROR convert \" + Marshal.GetLastWin32Error();",
  "    if (ok) LocalFree(str);",
  "    LocalFree(sd);",
  "    return text;",
  "  }",
  "}",
  "'@",
  "[NnNulAcl]::Sddl('\\\\.\\NUL')",
].join("\n");

const SID_ALIASES = {
  WD: "Everyone", SY: "SYSTEM", BA: "Administrators", AU: "Authenticated Users", BU: "Users", AC: "ALL APPLICATION PACKAGES (S-1-15-2-1)", "S-1-15-2-1": "ALL APPLICATION PACKAGES (S-1-15-2-1)",
  "S-1-15-2-2": "ALL RESTRICTED APPLICATION PACKAGES (S-1-15-2-2, the group an LPAC keeps)", LW: "Low integrity", ME: "Medium integrity", HI: "High integrity", RC: "RESTRICTED", IU: "Interactive", S1: "Service",
};

/** Reads an SDDL string: the entries (type, rights, who) and whether the two package groups, Everyone and a low-integrity label are present. Pure. */
export function analyzeSddl(sddl) {
  const text = String(sddl ?? "").trim();
  if (text === "" || /^ERROR/.test(text)) return { ok: false, error: text || "no answer", aces: [] };
  const aces = [];
  for (const m of text.matchAll(/\(([^()]*)\)/g)) {
    const f = m[1].split(";");
    if (f.length < 6) continue;
    aces.push({ type: f[0], flags: f[1], rights: f[2], sid: f[5], who: SID_ALIASES[f[5]] ?? f[5] });
  }
  const allows = (sids) => aces.some((a) => a.type === "A" && sids.includes(a.sid));
  const label = aces.find((a) => a.type === "ML");
  return {
    ok: true, sddl: text, aces,
    allAppPackagesAllowed: allows(["AC", "S-1-15-2-1"]),
    restrictedAppPackagesAllowed: allows(["S-1-15-2-2"]),
    everyoneAllowed: allows(["WD"]),
    allAppPackagesRights: aces.filter((a) => a.type === "A" && ["AC", "S-1-15-2-1"].includes(a.sid)).map((a) => a.rights),
    mandatoryLabel: label ? { rights: label.rights, level: label.who } : null,
  };
}

// ---------------------------------------------------------------------------------------------------------------- git variants

/** A node script that opens the NUL device in every mode and prints one JSON line (read before and after the git ladder to say what the container may open). */
export const NUL_OPEN_SCRIPT = "const fs=require('fs');const r={};for(const p of ['NUL','\\\\\\\\.\\\\NUL'])for(const m of ['r','w','r+']){try{fs.closeSync(fs.openSync(p,m));r[p+' '+m]='ok'}catch(e){r[p+' '+m]=e.code}}console.log(JSON.stringify(r))";

/**
 * The git variants. `container`: a ladder variant id (the container the git runs in). `stdin`: nul (the launcher's read-only NUL), nul-rw, file, pipe, pipe-open. `stdoutPipe`: output through anonymous pipes.
 * `exe`: cmd (Git\cmd\git.exe, the PATH entry), mingw64 (Git\mingw64\bin\git.exe, the real program the cmd one starts). `copy`: run a copy of that exe from the workspace. `wrap`: `cmd /c git ...`.
 * `env`: a function of the plan giving environment changes (a null value removes a name).
 */
export function gitVariants() {
  const g = (id, desc, o = {}) => ({ id, desc, container: "ac-nocap", stdin: "nul", stdoutPipe: false, exe: "cmd", copy: undefined, wrap: false, env: () => ({}), args: ["--version"], ...o });
  const lpac = "lpac-optout-reg-com";
  return [
    g("base", "Git\\cmd\\git.exe; standard input the launcher's read-only NUL; output to files"),
    g("stdin-nul-rw", "standard input is NUL opened for reading AND writing", { stdin: "nul-rw" }),
    g("stdin-file", "standard input is a real (empty) file in the workspace", { stdin: "file" }),
    g("stdin-pipe", "standard input is an anonymous pipe that is already at end of input", { stdin: "pipe" }),
    g("stdin-pipe-open", "standard input is an anonymous pipe whose write end stays open", { stdin: "pipe-open" }),
    g("out-pipes", "standard output and error are anonymous pipes (copied to files by the launcher)", { stdoutPipe: true }),
    g("all-pipes", "standard input, output and error are all anonymous pipes", { stdin: "pipe", stdoutPipe: true }),
    g("mingw64-direct", "Git\\mingw64\\bin\\git.exe started directly (no Git\\cmd wrapper)", { exe: "mingw64" }),
    g("env-msys", "environment MSYS=winsymlinks:nativestrict and MSYS2_ARG_CONV_EXCL=* (the MSYS runtime's own switches; a MinGW git should ignore them)", { env: () => ({ MSYS: "winsymlinks:nativestrict", MSYS2_ARG_CONV_EXCL: "*" }) }),
    g("env-no-git-vars", "none of the GIT_* variables of the harness (the system configuration may be read)", { env: () => ({ GIT_CONFIG_NOSYSTEM: null, GIT_CONFIG_GLOBAL: null, GIT_TERMINAL_PROMPT: null }) }),
    g("env-home-workspace", "HOME, USERPROFILE and GIT_CONFIG_GLOBAL point into the workspace", { env: (plan) => ({ HOME: plan.workspace, USERPROFILE: plan.workspace, GIT_CONFIG_GLOBAL: join(plan.workspace, ".gitconfig") }) }),
    g("cmd-c", "cmd.exe /c git --version", { wrap: true }),
    g("fsmonitor-off", "git -c core.fsmonitor=false --version", { args: ["-c", "core.fsmonitor=false", "--version"] }),
    g("copy-cmd-exe", "a copy of Git\\cmd\\git.exe run from the workspace", { copy: "cmd" }),
    g("copy-mingw64-exe", "a copy of Git\\mingw64\\bin\\git.exe run from the workspace", { copy: "mingw64" }),
    g("lpac-base", "LPAC (optout) + registryRead + lpacCom, otherwise as base", { container: lpac }),
    g("lpac-stdin-nul-rw", "LPAC + registryRead + lpacCom, standard input NUL read-write", { container: lpac, stdin: "nul-rw" }),
    g("lpac-mingw64-nul-rw", "LPAC + registryRead + lpacCom, mingw64 git.exe, standard input NUL read-write", { container: lpac, stdin: "nul-rw", exe: "mingw64" }),
  ];
}

export function selectGitVariants(spec, all = gitVariants()) {
  if (spec === undefined || spec === "all") return all;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((v) => v.id === w));
  if (unknown.length > 0) throw new Error(`unknown git variant: ${unknown.join(", ")}`);
  return all.filter((v) => wanted.includes(v.id));
}

/** The git program a variant runs: Git\cmd, Git\mingw64\bin, or the copy in the workspace's bin folder. */
export function gitProgram(variant, plan, ctx) {
  const root = ctx.gitRoot ?? (ctx.gitExe ? win32.dirname(win32.dirname(ctx.gitExe)) : "C:\\Program Files\\Git");
  const cmdExe = ctx.gitExe ?? win32.join(root, "cmd", "git.exe");
  const mingw = win32.join(root, "mingw64", "bin", "git.exe");
  const source = (variant.copy ?? variant.exe) === "mingw64" ? mingw : cmdExe;
  return { source, run: variant.copy ? join(plan.binDir, "git.exe") : source };
}

const GIT_STEPS = [
  { id: "git-version", label: "git --version", expect: (out) => /^git version /.test(out.trim()) },
  { id: "git-init", label: "git init", expect: () => true },
  { id: "git-add", label: "git add (a.txt)", expect: () => true },
  { id: "git-commit", label: "git commit", expect: () => true },
];
const GIT_ID = ["-c", "user.name=NN Experiment", "-c", "user.email=nn@example.invalid", "-c", "core.autocrlf=false"];

/** The launcher step (the shape `buildStepArgs` takes) for one git step of one variant. */
export function gitStepFor(variant, stepId, plan, ctx) {
  const prog = gitProgram(variant, plan, ctx);
  const sys = ctx.systemRoot ?? "C:\\Windows";
  const gitArgs = { "git-version": variant.args, "git-init": [...GIT_ID, "init", "-q"], "git-add": [...GIT_ID, "add", "a.txt"], "git-commit": [...GIT_ID, "commit", "-q", "-m", "experiment"] }[stepId];
  const def = GIT_STEPS.find((s) => s.id === stepId);
  const exe = variant.wrap ? win32.join(sys, "System32", "cmd.exe") : prog.run;
  const args = variant.wrap ? ["/c", prog.run, ...gitArgs] : gitArgs;
  const launcherArgs = [];
  if (variant.stdin === "file") launcherArgs.push("--stdin", `file:${join(plan.workspace, "stdin.txt")}`);
  else if (variant.stdin !== "nul") launcherArgs.push("--stdin", variant.stdin);
  if (variant.stdoutPipe) launcherArgs.push("--stdout-pipe", "--stderr-pipe");
  return { id: stepId, label: def.label, program: "git", exe, args: () => args, expect: def.expect, cwd: stepId === "git-version" ? plan.workspace : plan.gitWork, env: variant.env(plan), launcherArgs };
}

export const NUL_STEP = { id: "node-open-nul", label: "node opens the NUL device (r, w, r+; NUL and \\\\.\\NUL)", program: "node", args: () => ["-e", NUL_OPEN_SCRIPT], expect: (out) => out.trim().startsWith("{") };

/** The NUL-opening result of a step's output: { 'NUL r': 'ok' | 'EACCES' ... } or undefined. */
export function parseNulOpen(stdout) {
  try { const o = JSON.parse(String(stdout ?? "").trim().split(/\r?\n/).pop() ?? ""); return o && typeof o === "object" ? o : undefined; } catch { return undefined; }
}

// ---------------------------------------------------------------------------------------------------------------- shared start-up

const preamble = (opts, schemaName) => {
  const platform = opts.platform ?? process.platform;
  const profileName = opts.profileName ?? "NimbleNewtExperiment";
  const info = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  const ok = info !== undefined && info.ok === true;
  return { platform, profileName, info, host, ok, profile: { name: profileName, createdNow: info?.profile === "created" }, schema: schemaName };
};

const finishProfile = (opts, pre, notes) => {
  let profileDeleted = false;
  if (!opts.dryRun && pre.profile.createdNow) profileDeleted = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["delete-profile", "--name", pre.profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!pre.profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  return profileDeleted;
};

const unavailable = (pre, now, extra) => ({ report: { schema: pre.schema, generatedAt: now, host: pre.host, ...extra, notes: [`the launcher could not create or find the container (${pre.info?.stage ?? "no answer"}); nothing was started`] }, markdown: "", ranAtAll: false });

// ---------------------------------------------------------------------------------------------------------------- the git ladder runner

/**
 * For each git variant: `node-open-nul` (what the container may do to the device), `git --version`, and, only when that passes, init, add and commit. Variants are separate
 * launcher runs in a fresh folder each; the container's ACL entries are read back after each variant, as in the smoke ladder.
 */
export async function runGitLadder(opts) {
  const pre = preamble(opts, GIT_SCHEMA);
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const ps = opts.ps;
  const timeoutMs = opts.timeoutMs ?? STEP_TIMEOUT_MS;
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const log = opts.log ?? (() => {});
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  if (!pre.ok) return { ...unavailable(pre, now, { variants: [] }), names };
  const variants = selectGitVariants(opts.variantSpec);
  const containers = ladderVariants();
  const tools = opts.tools;
  const pathApi = pre.platform === "win32" ? win32 : { join, dirname, basename };
  const sysRoot = opts.systemRoot ?? (pre.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const notes = [];
  // The device's DACL (read once; the same for every variant).
  const sddlRun = safe(() => ps(NUL_ACL_SCRIPT));
  const nulAcl = analyzeSddl(sddlRun?.status === 0 ? sddlRun.stdout : `ERROR ${String(sddlRun?.stderr ?? "no answer").trim().split(/\r?\n/)[0]?.slice(0, 160)}`);
  const out = [];
  let foldersRemoved = 0;
  let grantsLeft = 0;
  for (const variant of variants) {
    const container = containers.find((c) => c.id === variant.container);
    const root = mkdtempSync(join(tmpBase, "nn-appc-"));
    names.root = root;
    const plan = ladderPlan(root, pathApi);
    plan.gitWork = pathApi.join(plan.scratch, "gitwork");
    const steps = [];
    const granted = new Set();
    let nulOpen;
    try {
      for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.binDir, plan.gitWork]) mkdirSync(d, { recursive: true });
      writeFileSync(join(plan.workspace, "stdin.txt"), "");
      const ctx = { profileName: pre.profileName, nodeExe: tools.nodeExe, gitExe: tools.gitExe, gitRoot: tools.gitRoot, programDirs: tools.programDirs, systemRoot: sysRoot, pathDirs: [variant.copy ? plan.binDir : undefined, ...(tools.nodeExe ? [pathApi.dirname(tools.nodeExe)] : []), tools.gitDir, ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])].filter(Boolean) };
      const copyNotes = [];
      if (variant.copy) {
        const prog = gitProgram(variant, plan, ctx);
        try { (opts.copyFile ?? copyFileSync)(prog.source, prog.run); } catch (error) { copyNotes.push(`copy failed (${error?.code ?? "error"})`); }
      }
      for (const [, path] of ladderGrants(container, plan, ctx)) granted.add(path);
      const runStep = (step, outId) => {
        const outFiles = { stdout: join(plan.outDir, `${outId}.out.txt`), stderr: join(plan.outDir, `${outId}.err.txt`) };
        if (opts.dryRun) return { id: step.id, label: step.label, status: "not-started", detail: "dry run: the launcher was not started" };
        const args = buildStepArgs(container, step, plan, ctx, timeoutMs, outFiles);
        log(`git variant ${variant.id}: ${step.id}`);
        const wall = Date.now();
        const r = safe(() => opts.exec(opts.launcherPath, args, { timeoutMs: timeoutMs + 60_000 }));
        const line = parseLauncherLine(r?.stdout ?? "");
        const stdout = safe(() => readFileSync(outFiles.stdout, "utf8")) ?? "";
        const result = judgeStep(step, line, stdout, safe(() => readFileSync(outFiles.stderr, "utf8")) ?? "");
        result.wallMs = Date.now() - wall;
        if (step.id === "node-open-nul") result.nulOpen = parseNulOpen(stdout);
        const left = launcherLeft(line);
        if (left.length > 0) result.aclLeftAfterRun = left;
        return result;
      };
      const nulStep = runStep(NUL_STEP, "nul");
      nulOpen = nulStep.nulOpen;
      steps.push(nulStep);
      const first = runStep(gitStepFor(variant, "git-version", plan, ctx), "git-version");
      steps.push(first);
      if (copyNotes.length > 0) first.copyNotes = copyNotes;
      if (first.status === "pass") {
        // The workload needs a file; node (which runs in every container tried) writes it.
        const make = runStep({ id: "make-file", label: "node writes a.txt", program: "node", args: () => ["-e", "require('fs').writeFileSync('a.txt','hello\\n')"], expect: () => true, cwd: plan.gitWork }, "make-file");
        let stillOk = make.status === "pass";
        if (!stillOk) steps.push(make);
        for (const id of ["git-init", "git-add", "git-commit"]) {
          if (!stillOk) { steps.push({ id, label: GIT_STEPS.find((s) => s.id === id).label, status: "skipped", detail: "an earlier step did not pass" }); continue; }
          const r = runStep(gitStepFor(variant, id, plan, ctx), id);
          steps.push(r);
          stillOk = r.status === "pass";
        }
      } else {
        for (const id of ["git-init", "git-add", "git-commit"]) steps.push({ id, label: GIT_STEPS.find((s) => s.id === id).label, status: "skipped", detail: "git --version did not pass" });
      }
    } finally {
      let finalLeft = [];
      let firstReadBack = [];
      if (!opts.dryRun && granted.size > 0) { const rb = aclReadBack(opts.exec, opts.launcherPath, pre.profileName, [...granted]); firstReadBack = rb.first; finalLeft = rb.final; }
      grantsLeft += finalLeft.length;
      try { removeTree(root); foldersRemoved++; } catch { notes.push("a fixture folder could not be removed"); }
      out.push({
        id: variant.id, desc: variant.desc, container: variant.container, settings: { stdin: variant.stdin, outputPipes: variant.stdoutPipe, program: variant.copy ? `copy of ${variant.copy}` : variant.exe, wrap: variant.wrap, args: variant.args.join(" ") },
        steps: [...steps], nulOpen, gitRuns: steps.find((s) => s.id === "git-version")?.status === "pass", commitRuns: steps.find((s) => s.id === "git-commit")?.status === "pass",
        aclFirstReadBack: firstReadBack, aclLeftFinal: finalLeft,
      });
    }
  }
  const profileDeleted = finishProfile(opts, pre, notes);
  const report = { schema: GIT_SCHEMA, generatedAt: now, host: pre.host, profile: pre.profile, nulAcl, stepTimeoutMs: timeoutMs, variants: out, cleanup: { profileDeleted, foldersRemoved, grantsLeft }, notes };
  return { report, markdown: renderGitMarkdown(report), ranAtAll: true, names };
}

const MARK = { pass: "ok", odd: "odd output", fail: "fail", timeout: "TIMEOUT", "not-started": "not started", skipped: "skipped" };
const cell = (s) => (s === undefined ? "-" : s.status === "fail" ? `fail ${s.exitHex}` : MARK[s.status] ?? s.status);
const code = (t) => `\`${String(t).replaceAll("`", "'").replaceAll("|", "/")}\``;

export function renderGitMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 3: the git ladder", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}; session id ${report.host.sessionId}; elevated: ${report.host.elevated}.`, "");
  L.push("Why git fails (git-for-windows/git, main): `common-init.c` calls `sanitize_stdfds()` at every start; `setup.c` implements it as `xopen(\"/dev/null\", O_RDWR)`; `wrapper.c` `xopen` dies with \"could not open '/dev/null' for reading and writing\"; `compat/mingw.c` `mingw_open` turns \"/dev/null\" into the device name `nul` and opens it with `_wopen`. Git therefore opens the NUL device for reading AND writing itself, whatever its standard handles are.", "");
  const a = report.nulAcl;
  L.push("## The NUL device's security descriptor", "");
  if (!a.ok) L.push(`Not read: ${a.error}.`, "");
  else {
    L.push(`- DACL entries: ${a.aces.filter((x) => x.type !== "ML").map((x) => `${x.type} ${x.rights} ${x.who}`).join("; ")}.`);
    L.push(`- ALL APPLICATION PACKAGES allowed: ${a.allAppPackagesAllowed}${a.allAppPackagesRights.length > 0 ? ` (rights ${a.allAppPackagesRights.join(", ")})` : ""}; ALL RESTRICTED APPLICATION PACKAGES (what an LPAC keeps) allowed: ${a.restrictedAppPackagesAllowed}; Everyone allowed: ${a.everyoneAllowed}; mandatory label: ${a.mandatoryLabel ? `${a.mandatoryLabel.level} ${a.mandatoryLabel.rights}` : "none read"}.`);
    L.push(`- SDDL: ${code(a.sddl)}`, "");
  }
  L.push("## Variants", "", "| variant | container | stdin | out/err pipes | program | NUL r | NUL w | NUL r+ | git --version | init | add | commit |", `|${" --- |".repeat(12)}`);
  for (const v of report.variants) {
    const n = v.nulOpen ?? {};
    const show = (k) => (n[k] === undefined ? "?" : n[k]);
    const by = (id) => cell(v.steps.find((s) => s.id === id));
    L.push(`| ${v.id} | ${v.container} | ${v.settings.stdin} | ${v.settings.outputPipes} | ${v.settings.program}${v.settings.wrap ? " via cmd /c" : ""} | ${show("NUL r")} | ${show("NUL w")} | ${show("NUL r+")} | ${by("git-version")} | ${by("git-init")} | ${by("git-add")} | ${by("git-commit")} |`);
  }
  L.push("");
  const works = report.variants.filter((v) => v.gitRuns);
  L.push(works.length > 0 ? `Variants where git --version passed: ${works.map((v) => v.id).join(", ")}; where init, add and commit all passed: ${report.variants.filter((v) => v.commitRuns).map((v) => v.id).join(", ") || "none"}.` : "No variant ran git.", "");
  for (const v of report.variants) {
    L.push(`## ${v.id}`, "", `- ${v.desc}. Container: ${v.container}; arguments: ${v.settings.args}.`);
    for (const s of v.steps.filter((x) => x.status !== "pass" && x.status !== "skipped")) {
      const bits = [s.status];
      if (s.exitHex !== undefined) bits.push(`exit ${s.exitHex} after ${s.elapsedMs} ms`);
      if (s.detail) bits.push(s.detail);
      if ((s.stderrHead ?? []).length > 0) bits.push(`stderr: ${s.stderrHead.map(code).join(" | ")}`);
      if ((s.stdoutHead ?? []).length > 0) bits.push(`stdout: ${s.stdoutHead.map(code).join(" | ")}`);
      L.push(`- ${s.id}: ${bits.join("; ")}`);
    }
    if (v.nulOpen) L.push(`- NUL device from inside: ${Object.entries(v.nulOpen).map(([k, x]) => `${k}=${x}`).join(", ")}.`);
    L.push(v.aclFirstReadBack.length > 0 ? `- Read-back found ACL entries left on: ${v.aclFirstReadBack.map((x) => `${x.path} (${x.entriesLeft})`).join("; ")}; after a second revoke: ${v.aclLeftFinal.length === 0 ? "none left" : v.aclLeftFinal.map((x) => `${x.path} (${x.entriesLeft})`).join("; ")}.` : "- Read-back of every granted path: no ACL entry left.");
    L.push("");
  }
  L.push("## Clean-up", "", `- Profile deleted: ${report.cleanup.profileDeleted}; folders removed: ${report.cleanup.foldersRemoved}; granted paths with an entry left at the end: ${report.cleanup.grantsLeft}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------- junctions and ACL propagation

/**
 * Does a grant on the workspace reach the target of a junction inside it? The launcher's `grant` command applies the three container grants and LEAVES them; `check` then reads the container's
 * explicit and inherited entries on each path (a file and a folder inside the workspace as controls: propagation must have happened there; the targets of the four junction/link fixtures;
 * the protected folder); `revoke` removes them and the read-back repeats. Nothing here runs inside the container: the in-container half is the probe's junction cases (`--mode cases`).
 */
export async function runLinks(opts) {
  const pre = preamble(opts, LINKS_SCHEMA);
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  if (!pre.ok) return { ...unavailable(pre, now, { targets: [] }), names };
  const pathApi = pre.platform === "win32" ? win32 : { join, dirname, basename };
  const root = mkdtempSync(join(tmpBase, "nn-appc-"));
  names.root = root;
  const plan = buildFixturePlan(root, pathApi);
  const notes = [];
  let granted = [];
  let targets = [];
  let revokedClean = null;
  let plantNotes = [];
  let planted = {};
  try {
    const fx = createFixtures(plan, { platform: pre.platform });
    plantNotes = fx.notes;
    planted = fx.planted;
    const grantArgs = [["modify", plan.workspace], ["modify", plan.home], ["modify", plan.scratch]].flatMap(([m, p]) => ["--grant", `${m}:${p}`]);
    const g = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["grant", "--name", pre.profileName, ...grantArgs], { timeoutMs: 120_000 }).stdout) ?? "");
    granted = (g?.grants ?? []).map((x) => ({ path: x.path, applied: x.applied === true, entriesLeft: x.entriesLeft, inheritedEntries: x.inheritedEntries }));
    const probeList = [
      ["control: the workspace folder itself (explicit entry expected)", plan.workspace],
      ["control: a file inside the workspace (inherited entry expected)", plan.decoy],
      ["control: the protected-name folder inside the workspace (inherited entry expected)", plan.protectedDir],
      ["target of the directory junction used for the read case (controller's folder)", plan.controllerDir],
      ["file inside that target", plan.controllerFile],
      ["target of the directory junction used for the write case (outside folder)", plan.linkTargetDir],
      ["target of the file link used for the write case (outside file)", plan.linkTargetFile],
      ["the outside folder that holds both link targets", plan.outsideDir],
      ["the credentials folder", plan.credentialDir],
      ["the fixture root (parent of every fixture folder)", plan.root],
    ];
    const chk = parseLauncherLine(safe(() => opts.exec(opts.launcherPath, ["check", "--name", pre.profileName, ...probeList.flatMap(([, p]) => ["--grant", `ro:${p}`])], { timeoutMs: 120_000 }).stdout) ?? "");
    targets = probeList.map(([label, path]) => {
      const e = (chk?.grants ?? []).find((x) => x.path === path);
      const explicit = typeof e?.entriesLeft === "number" ? e.entriesLeft : null;
      const inherited = typeof e?.inheritedEntries === "number" ? e.inheritedEntries : null;
      return { label, explicit, inherited, reached: explicit === null || inherited === null ? "unknown" : explicit > 0 || inherited > 0 ? "yes" : "no" };
    });
    if (chk === undefined) notes.push("the launcher's check answered nothing");
  } finally {
    // Whatever happened above: read back, revoke what is left, read again.
    const paths = [plan.workspace, plan.home, plan.scratch];
    // The grants are expected to be there, so the revoke is unconditional; the read-back after it must find nothing (and revokes again, then reads again, if it does).
    if (!opts.dryRun) {
      safe(() => opts.exec(opts.launcherPath, ["revoke", "--name", pre.profileName, ...paths.flatMap((p) => ["--grant", `ro:${p}`])], { timeoutMs: 120_000 }));
      const rb = aclReadBack(opts.exec, opts.launcherPath, pre.profileName, paths);
      revokedClean = rb.first.length === 0 && rb.final.length === 0;
    }
    try { removeTree(root); } catch { notes.push("a fixture folder could not be removed"); }
  }
  const profileDeleted = finishProfile(opts, pre, notes);
  const report = { schema: LINKS_SCHEMA, generatedAt: now, host: pre.host, profile: pre.profile, linksPlanted: planted, plantNotes, granted, targets, revokedClean, cleanup: { profileDeleted }, notes };
  return { report, markdown: renderLinksMarkdown(report), ranAtAll: true, names };
}

export function renderLinksMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 3: junction targets and ACL propagation", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}; elevated: ${report.host.elevated}.`, "");
  L.push("The launcher granted the container modify rights on the workspace, home and scratch folders (inheritable) and left them in place; then it read, for each path below, how many entries for the container are on it (explicit = put there by the grant, inherited = passed down from a parent). A junction's target counts as reached when it holds an entry.", "");
  L.push(`Links planted: ${Object.entries(report.linksPlanted).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}${report.plantNotes.length > 0 ? ` (${report.plantNotes.join("; ")})` : ""}.`, "");
  L.push("| path | explicit entries | inherited entries | reached by the grant |", "| --- | --- | --- | --- |");
  for (const t of report.targets) L.push(`| ${t.label} | ${t.explicit ?? "?"} | ${t.inherited ?? "?"} | ${t.reached} |`);
  L.push("", `After the revoke, the read-back of the three granted folders found nothing left: ${report.revokedClean}.`, "", `- Profile deleted: ${report.cleanup.profileDeleted}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------- timing

export const TIMING_FILES = 100;
export const TIMING_NPM_PACKAGES = 40;

/** The 100-file workload as a node script (the same text runs inside the container and outside as the baseline). */
export const MAKE_FILES_SCRIPT = `const fs=require('fs');for(let i=0;i<${TIMING_FILES};i++)fs.writeFileSync('f'+String(i).padStart(3,'0')+'.txt','file '+i+'\\n'.repeat(1)+'x'.repeat(200))`;

/**
 * How long things take: the container's start (a launcher call around `cmd /c exit 0` versus the same program started directly), node's start, writing 100 files, a git init + add + commit of
 * those files (only when git --version works in the container; the same commands are timed outside the container as the baseline), and an offline `npm ci` of 40 local packages, inside and outside.
 */
export async function runTiming(opts) {
  const pre = preamble(opts, TIMING_SCHEMA);
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const timeoutMs = opts.limits?.timeoutMs ?? 120_000;
  const log = opts.log ?? (() => {});
  const spawn = opts.spawn;
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  if (!pre.ok) return { ...unavailable(pre, now, { configurations: [] }), names };
  const tools = opts.tools;
  const pathApi = pre.platform === "win32" ? win32 : { join, dirname, basename };
  const sysRoot = opts.systemRoot ?? (pre.platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const containers = ladderVariants().filter((v) => ["ac-nocap", "lpac-optout-reg-com"].includes(v.id));
  const notes = [];
  const configurations = [];
  let grantsLeft = 0;
  const timeOutside = (exe, args, cwd, env) => {
    const t = Date.now();
    const r = safe(() => spawn(exe, args, { cwd, env, encoding: "utf8", timeout: timeoutMs, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
    return { ms: Date.now() - t, status: r?.status ?? null, error: r?.error?.code };
  };
  for (const container of containers) {
    const root = mkdtempSync(join(tmpBase, "nn-appc-"));
    names.root = root;
    const plan = ladderPlan(root, pathApi);
    plan.gitWork = pathApi.join(plan.scratch, "gitwork");
    plan.npmProject = pathApi.join(plan.scratch, "npmproj");
    plan.npmCache = pathApi.join(plan.scratch, "npmcache");
    const granted = new Set();
    const rows = [];
    try {
      for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.binDir, plan.gitWork, plan.npmCache]) mkdirSync(d, { recursive: true });
      writeNpmProject(plan.npmProject, TIMING_NPM_PACKAGES);
      const ctx = { profileName: pre.profileName, nodeExe: tools.nodeExe, gitExe: tools.gitExe, gitRoot: tools.gitRoot, programDirs: tools.programDirs, systemRoot: sysRoot, pathDirs: [...(tools.nodeExe ? [pathApi.dirname(tools.nodeExe)] : []), tools.gitDir, ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])].filter(Boolean) };
      for (const [, path] of ladderGrants(container, plan, ctx)) granted.add(path);
      const sys = (name) => win32.join(sysRoot ?? "C:\\Windows", "System32", name);
      const envOutside = { ...process.env };
      const inside = (id, label, step, repeat = 1) => {
        const samples = [];
        let last;
        for (let i = 0; i < repeat; i++) {
          const outFiles = { stdout: join(plan.outDir, `${id}-${i}.out.txt`), stderr: join(plan.outDir, `${id}-${i}.err.txt`) };
          if (opts.dryRun) { last = { status: "not-started", detail: "dry run" }; break; }
          const args = buildStepArgs(container, { id, label, program: "node", expect: () => true, ...step }, plan, ctx, timeoutMs, outFiles);
          const wall = Date.now();
          const r = safe(() => opts.exec(opts.launcherPath, args, { timeoutMs: timeoutMs + 60_000 }));
          const wallMs = Date.now() - wall;
          const line = parseLauncherLine(r?.stdout ?? "");
          last = judgeStep({ id, label, expect: () => true }, line, safe(() => readFileSync(outFiles.stdout, "utf8")) ?? "", safe(() => readFileSync(outFiles.stderr, "utf8")) ?? "");
          samples.push({ wallMs, childMs: line?.elapsedMs ?? null, status: last.status, exitHex: last.exitHex });
          if (last.status !== "pass") break;
        }
        return { id, label, samples, status: last?.status ?? "not-started", exitHex: last?.exitHex, detail: last?.detail, stderrHead: last?.stderrHead };
      };
      const med = (xs) => { const a = xs.filter((x) => typeof x === "number").sort((x, y) => x - y); return a.length === 0 ? null : a[Math.floor(a.length / 2)]; };
      const finish = (row, outside) => { rows.push({ ...row, insideWallMedianMs: med(row.samples.map((s) => s.wallMs)), insideChildMedianMs: med(row.samples.map((s) => s.childMs)), outside }); };
      log(`timing ${container.id}: start`);
      const cmdOutside = Array.from({ length: 5 }, () => timeOutside(sys("cmd.exe"), ["/c", "exit", "0"], plan.workspace, envOutside).ms);
      finish(inside("start-cmd", "container start: cmd /c exit 0 (5 runs)", { program: "cmd", exe: sys("cmd.exe"), args: () => ["/c", "exit", "0"] }, 5), { medianMs: med(cmdOutside), runs: cmdOutside.length });
      const nodeOutside = Array.from({ length: 3 }, () => timeOutside(tools.nodeExe, ["-e", "0"], plan.workspace, envOutside).ms);
      finish(inside("start-node", "node -e 0 (3 runs)", { args: () => ["-e", "0"] }, 3), { medianMs: med(nodeOutside), runs: nodeOutside.length });
      mkdirSync(join(plan.scratch, "outside-files"), { recursive: true });
      const filesOutside = timeOutside(tools.nodeExe, ["-e", MAKE_FILES_SCRIPT], join(plan.scratch, "outside-files"), envOutside);
      finish(inside("write-100-files", `node writes ${TIMING_FILES} files`, { args: () => ["-e", MAKE_FILES_SCRIPT], cwd: plan.gitWork }), { medianMs: filesOutside.ms, runs: 1 });
      // git: only where git --version works inside this container.
      const gitStep = (id, args, cwd) => ({ program: "git", exe: tools.gitExe, args: () => args, cwd });
      const ver = inside("git-version", "git --version", gitStep("git-version", ["--version"], plan.workspace));
      rows.push({ ...ver, insideWallMedianMs: med(ver.samples.map((s) => s.wallMs)), insideChildMedianMs: med(ver.samples.map((s) => s.childMs)), outside: null });
      const outGit = pathApi.join(plan.scratch, "outside-files");
      const gid = ["-c", "user.name=NN Experiment", "-c", "user.email=nn@example.invalid", "-c", "core.autocrlf=false"];
      const gitOutside = {
        init: timeOutside(tools.gitExe ?? "git", [...gid, "init", "-q"], outGit, envOutside).ms,
        add: timeOutside(tools.gitExe ?? "git", [...gid, "add", "-A"], outGit, envOutside).ms,
        commit: timeOutside(tools.gitExe ?? "git", [...gid, "commit", "-q", "-m", "baseline"], outGit, envOutside).ms,
      };
      if (ver.status === "pass") {
        for (const [id, args] of [["git-init", ["init", "-q"]], ["git-add-100", ["add", "-A"]], ["git-commit-100", ["commit", "-q", "-m", "experiment"]]]) {
          const r = inside(id, `git ${args[0]} (${TIMING_FILES} files)`, gitStep(id, [...gid, ...args], plan.gitWork));
          rows.push({ ...r, insideWallMedianMs: med(r.samples.map((s) => s.wallMs)), insideChildMedianMs: med(r.samples.map((s) => s.childMs)), outside: { medianMs: gitOutside[args[0]], runs: 1 } });
          if (r.status !== "pass") break;
        }
      } else rows.push({ id: "git-100-files", label: `git init + add + commit of ${TIMING_FILES} files`, samples: [], status: "skipped", detail: `git --version does not pass in this container (${ver.exitHex ?? ver.status}); baseline outside: init ${gitOutside.init} ms, add ${gitOutside.add} ms, commit ${gitOutside.commit} ms`, outside: gitOutside });
      // npm ci of 40 local packages (a copy of the project outside for the baseline).
      if (tools.npmCli) {
        const npmArgs = ["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"];
        const outProject = join(plan.scratch, "outside-npm");
        writeNpmProject(outProject, TIMING_NPM_PACKAGES);
        const envNpm = { ...envOutside, npm_config_cache: join(plan.scratch, "outside-npm-cache"), npm_config_offline: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_update_notifier: "false" };
        const npmOutside = timeOutside(tools.nodeExe, [tools.npmCli, ...npmArgs], outProject, envNpm);
        finish(inside("npm-ci-40", `npm ci --offline, ${TIMING_NPM_PACKAGES} local packages`, { args: () => [tools.npmCli, ...npmArgs], cwd: plan.npmProject }), { medianMs: npmOutside.ms, runs: 1, status: npmOutside.status });
      } else rows.push({ id: "npm-ci-40", label: "npm ci", samples: [], status: "skipped", detail: "npm-cli.js not found", outside: null });
    } finally {
      let finalLeft = [];
      if (!opts.dryRun && granted.size > 0) finalLeft = aclReadBack(opts.exec, opts.launcherPath, pre.profileName, [...granted]).final;
      grantsLeft += finalLeft.length;
      try { removeTree(root); } catch { notes.push("a fixture folder could not be removed"); }
      configurations.push({ id: container.id, desc: container.desc, rows, aclLeftFinal: finalLeft });
    }
  }
  const profileDeleted = finishProfile(opts, pre, notes);
  const report = { schema: TIMING_SCHEMA, generatedAt: now, host: pre.host, profile: pre.profile, files: TIMING_FILES, npmPackages: TIMING_NPM_PACKAGES, configurations, cleanup: { profileDeleted, grantsLeft }, notes };
  return { report, markdown: renderTimingMarkdown(report), ranAtAll: true, names };
}

export function renderTimingMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 3: timing", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}.`, "");
  L.push("Inside = a launcher call (container profile, ACL grants, job, process start, wait, revoke) around the program; `child` is the time the program itself ran, so the difference is the launcher's overhead. Outside = the same program started directly by the harness (a median of the runs shown; one run where `runs` is 1).", "");
  for (const c of report.configurations) {
    L.push(`## ${c.id}`, "", `- ${c.desc}.`, "", "| step | status | inside wall (ms) | inside child (ms) | outside (ms) | notes |", "| --- | --- | --- | --- | --- | --- |");
    for (const r of c.rows) {
      const outside = r.outside === null || r.outside === undefined ? "-" : r.outside.medianMs !== undefined ? `${r.outside.medianMs}${r.outside.runs > 1 ? ` (median of ${r.outside.runs})` : ""}` : `init ${r.outside.init} / add ${r.outside.add} / commit ${r.outside.commit}`;
      const notes = [r.exitHex && r.status !== "pass" ? `exit ${r.exitHex}` : "", r.detail ?? "", ...(r.stderrHead ?? []).slice(0, 2).map(code)].filter(Boolean).join("; ");
      L.push(`| ${r.label} | ${r.status} | ${r.insideWallMedianMs ?? "-"} | ${r.insideChildMedianMs ?? "-"} | ${outside} | ${notes} |`);
    }
    L.push("");
  }
  L.push("## Clean-up", "", `- Profile deleted: ${report.cleanup.profileDeleted}; granted paths with an entry left at the end: ${report.cleanup.grantsLeft}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}
