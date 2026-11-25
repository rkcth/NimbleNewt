// NimbleNewt experiment (not product code), round 2: the "smoke ladder" and the "network cut by firewall" mini-experiment.
// Round 1 (hosted Windows run 45499098682) showed the launcher itself works (profile, attribute list, job, ACL grants) but Node never produced a report in any cell:
//   LPAC          -> exit 0x80000003 and `WSAStartup: (10107) A system call has failed.` (libuv starts Winsock at start-up),
//   plain AppContainer -> no end for 300 s, Win32k disabled -> 0xC0000142.
// The ladder asks, per variant of the container, how far a program gets: does ANY program start (cmd.exe), a tiny system program, node --version, node requiring `net`,
// node writing to its output, git --version. The variants differ in capabilities (internetClient, privateNetworkClientServer, the LPAC capabilities registryRead and lpacCom ...),
// in the policy attribute, in the working directory and TEMP, in the folders granted, in the job limits, in where the program is run from.
// The firewall mini-experiment asks whether the network can be cut another way: a capability that allows outbound connections is given, then an outbound BLOCK rule scoped to the
// container's package SID is added, and connections from inside the container (outbound and loopback) must fail while a process outside the container is unaffected.
// This file holds the pure logic (variants, steps, arguments, verdicts, markdown) and the two runners; they start nothing but the launcher and PowerShell through injectable functions.
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import { dirname, join, win32 } from "node:path";
import { aclReadBack, buildChildEnv, buildCommandLine, buildFixturePlan, parseLauncherLine, removeTree, stderrHead } from "./lib.mjs";

export const LADDER_SCHEMA = "nn-appc-ladder-1";
export const FIREWALL_SCHEMA = "nn-appc-firewall-1";
/** Per step (round 2): a hang costs this long, not five minutes. */
export const STEP_TIMEOUT_MS = 45_000;
/** After this many timed-out steps in one variant the rest of that variant is skipped (each costs a full timeout). */
export const MAX_TIMEOUTS_PER_VARIANT = 2;

// ---------------------------------------------------------------------------------------------------------------- capabilities

/** The capability names and SIDs used here. The three network capabilities have well-known SIDs (Microsoft docs, "Well-known SIDs"); the others are named
 *  capabilities whose SIDs the launcher derives with DeriveCapabilitySidsFromName. */
export const WELL_KNOWN_CAPABILITY_SIDS = { internetClient: "S-1-15-3-1", internetClientServer: "S-1-15-3-2", privateNetworkClientServer: "S-1-15-3-3" };
/** What an LPAC needs so that a console program can start: the smallest set first, the wide set last (all named capabilities of the LPAC documentation that a console program may touch). */
export const LPAC_MIN = ["registryRead"];
export const LPAC_COM = ["registryRead", "lpacCom"];
export const LPAC_WIDE = ["registryRead", "lpacCom", "lpacIdentityServices", "lpacPnpNotifications", "lpacCryptoServices", "lpacAppExperience"];

// ---------------------------------------------------------------------------------------------------------------- variants

const base = (o) => ({ aapPolicy: "none", capabilities: [], programGrants: true, wsEnv: false, limits: true, copyTools: false, nodeOptions: undefined, nodeFlags: [], ...o });

/**
 * The variants. `aapPolicy`: none (a plain AppContainer), optout (LPAC), optin. `programGrants`: grant read+execute on the node and git folders (soft).
 * `wsEnv`: TEMP, TMP and TMPDIR point at the workspace itself. `limits`: the job's memory, process and UI limits (as in round 1) or none.
 * `copyTools`: node.exe and git.exe are copied into the workspace and run from there. `nodeOptions`: the NODE_OPTIONS value (undefined: the variable is not set at all).
 */
export function ladderVariants() {
  return [
    base({ id: "ac-nocap", desc: "plain AppContainer, no capability (round 1's configuration, node options unset)" }),
    base({ id: "ac-nocap-bare", desc: "plain AppContainer, no capability, the node and git folders are NOT granted", programGrants: false }),
    base({ id: "ac-nocap-wsenv", desc: "plain AppContainer, no capability, TEMP/TMP and the working directory are the granted workspace", wsEnv: true }),
    base({ id: "ac-nocap-nolimits", desc: "plain AppContainer, no capability, no job memory/process/UI limits", limits: false }),
    base({ id: "ac-nocap-jitless", desc: "plain AppContainer, no capability, node --jitless (no executable memory)", nodeFlags: ["--jitless"] }),
    base({ id: "ac-nocap-nodeopts", desc: "plain AppContainer, no capability, NODE_OPTIONS=--preserve-symlinks --preserve-symlinks-main", nodeOptions: "--preserve-symlinks --preserve-symlinks-main" }),
    base({ id: "ac-nocap-copy", desc: "plain AppContainer, no capability, node.exe and git.exe copied into the workspace and run from there", copyTools: true }),
    base({ id: "ac-inet", desc: "plain AppContainer + internetClient", capabilities: ["internetClient"] }),
    base({ id: "ac-inet-private", desc: "plain AppContainer + internetClient + privateNetworkClientServer", capabilities: ["internetClient", "privateNetworkClientServer"] }),
    base({ id: "lpac-optout-nocap", desc: "LPAC (policy optout), no capability (round 1's LPAC)", aapPolicy: "optout" }),
    base({ id: "lpac-optout-reg", desc: "LPAC (optout) + registryRead", aapPolicy: "optout", capabilities: LPAC_MIN }),
    base({ id: "lpac-optout-reg-com", desc: "LPAC (optout) + registryRead + lpacCom", aapPolicy: "optout", capabilities: LPAC_COM }),
    base({ id: "lpac-optout-wide", desc: "LPAC (optout) + registryRead, lpacCom, lpacIdentityServices, lpacPnpNotifications, lpacCryptoServices, lpacAppExperience", aapPolicy: "optout", capabilities: LPAC_WIDE }),
    base({ id: "lpac-optin-reg", desc: "policy attribute present with the opt-in value + registryRead", aapPolicy: "optin", capabilities: LPAC_MIN }),
    base({ id: "lpac-optout-reg-com-inet", desc: "LPAC (optout) + registryRead + lpacCom + internetClient", aapPolicy: "optout", capabilities: [...LPAC_COM, "internetClient"] }),
    base({ id: "lpac-optout-reg-com-copy", desc: "LPAC (optout) + registryRead + lpacCom, node.exe and git.exe copied into the workspace", aapPolicy: "optout", capabilities: LPAC_COM, copyTools: true }),
  ];
}

export function selectVariants(spec, all = ladderVariants()) {
  if (spec === undefined || spec === "all") return all;
  const wanted = spec.split(",").map((s) => s.trim()).filter(Boolean);
  const unknown = wanted.filter((w) => !all.some((v) => v.id === w));
  if (unknown.length > 0) throw new Error(`unknown variant: ${unknown.join(", ")}`);
  return all.filter((v) => wanted.includes(v.id));
}

// ---------------------------------------------------------------------------------------------------------------- steps

/** The ladder, from "does anything start" to "does git start". `program` names the executable; `expect` judges the captured output (exit code 0 is always required). */
export const LADDER_STEPS = [
  { id: "cmd-echo", label: "cmd.exe /c echo hi", program: "cmd", args: () => ["/c", "echo", "hi"], expect: (out) => /\bhi\b/.test(out) },
  { id: "hostname", label: "hostname.exe", program: "hostname", args: () => [], expect: (out) => out.trim() !== "" },
  { id: "node-e0", label: 'node.exe -e "0"', program: "node", args: () => ["-e", "0"], expect: () => true },
  { id: "node-version", label: "node.exe --version", program: "node", args: () => ["--version"], expect: (out) => /^v\d+\.\d+\.\d+/.test(out.trim()) },
  { id: "node-require-net", label: "node -e require('net')", program: "node", args: () => ["-e", "require('net')"], expect: () => true },
  { id: "node-stdout", label: "node -e process.stdout.write('x')", program: "node", args: () => ["-e", "process.stdout.write('x')"], expect: (out) => out === "x" },
  { id: "node-write-file", label: "node -e write a file in the workspace", program: "node", args: () => ["-e", "require('fs').writeFileSync('nn-ladder.txt','x')"], expect: () => true },
  { id: "git-version", label: "git.exe --version", program: "git", args: () => ["--version"], expect: (out) => /^git version /.test(out.trim()) },
];

const MARK = { pass: "ok", odd: "odd output", fail: "fail", timeout: "TIMEOUT", "not-started": "not started", skipped: "skipped" };
const hex = (code) => (typeof code === "number" ? `0x${(code >>> 0).toString(16).toUpperCase()}` : "?");

/** The fixture plan of one variant: three granted folders and one for output. Nothing else is needed by the ladder. */
export function ladderPlan(root, pathApi = win32) {
  const plan = buildFixturePlan(root, pathApi);
  return { ...plan, binDir: pathApi.join(plan.workspace, "bin") };
}

/** The program a step runs: system programs from System32, node and git from their install (or from the workspace copy). */
export function stepExecutable(step, variant, plan, ctx) {
  const sys = ctx.systemRoot ?? "C:\\Windows";
  if (step.program === "cmd") return win32.join(sys, "System32", "cmd.exe");
  if (step.program === "hostname") return win32.join(sys, "System32", "hostname.exe");
  if (step.program === "node") return variant.copyTools ? join(plan.binDir, "node.exe") : ctx.nodeExe;
  return variant.copyTools ? join(plan.binDir, "git.exe") : (ctx.gitExe ?? "git.exe");
}

/** The child environment of a variant: the common one, TEMP in the workspace when asked, NODE_OPTIONS only when the variant names a value. */
export function ladderEnv(variant, plan, ctx, delimiter = ";") {
  const env = buildChildEnv(plan, ctx, delimiter);
  if (variant.wsEnv) { env.TEMP = plan.workspace; env.TMP = plan.workspace; env.TMPDIR = plan.workspace; }
  delete env.NODE_OPTIONS;
  if (variant.nodeOptions !== undefined) env.NODE_OPTIONS = variant.nodeOptions;
  return env;
}

/** The granted paths of a variant, in order (each: mode and path, soft or not). */
export function ladderGrants(variant, plan, ctx) {
  const g = [["modify", plan.workspace, false], ["modify", plan.home, false], ["modify", plan.scratch, false]];
  if (variant.programGrants) for (const d of ctx.programDirs ?? []) g.push(["rx", d, true]);
  return g;
}

/** The launcher's argument list for one step of one variant. Pure. */
export function buildStepArgs(variant, step, plan, ctx, timeoutMs = STEP_TIMEOUT_MS, outFiles) {
  const args = ["run", "--name", ctx.profileName];
  for (const [mode, path, soft] of ladderGrants(variant, plan, ctx)) args.push(soft ? "--grant-soft" : "--grant", `${mode}:${path}`);
  args.push("--aap-policy", variant.aapPolicy);
  for (const c of variant.capabilities) args.push("--capability", c);
  if (variant.limits) args.push("--memory-mb", "4096", "--active-processes", "64", "--ui-limits");
  args.push("--timeout-ms", String(timeoutMs));
  // Round 3: a step may name its own program (`exe`), working directory, extra environment (a null value removes a name) and launcher flags (stdin and output modes).
  args.push("--stdout", outFiles.stdout, "--stderr", outFiles.stderr, "--cwd", step.cwd ?? plan.workspace);
  const env = { ...ladderEnv(variant, plan, ctx) };
  for (const [k, v] of Object.entries(step.env ?? {})) { if (v === null) delete env[k]; else env[k] = v; }
  for (const [k, v] of Object.entries(env)) args.push("--env", `${k}=${v}`);
  args.push(...(step.launcherArgs ?? []));
  const exe = step.exe ?? stepExecutable(step, variant, plan, ctx);
  const flags = step.program === "node" ? variant.nodeFlags : [];
  args.push("--exe", exe, "--cmdline", buildCommandLine(exe, [...flags, ...step.args()]));
  return args;
}

/** One step's verdict from the launcher's line and the captured output. */
export function judgeStep(step, line, stdout, stderr) {
  const rec = { id: step.id, label: step.label };
  if (line === undefined) return { ...rec, status: "not-started", detail: "the launcher printed no JSON line" };
  if (line.childStarted !== true) return { ...rec, status: "not-started", detail: `${line.stage ?? "?"}: ${line.error ?? "no message"}`, stage: line.stage };
  const out = { ...rec, exitCode: line.childExitCode, exitHex: hex(line.childExitCode), elapsedMs: line.elapsedMs, timedOut: line.timedOut === true, leftoverProcesses: line.leftoverProcesses };
  out.stdoutHead = stderrHead(stdout, 3, 120);
  out.stderrHead = stderrHead(stderr, 4, 200);
  if (line.hang !== undefined) out.hang = line.hang;
  if (line.timedOut === true) return { ...out, status: "timeout" };
  if (line.childExitCode !== 0) return { ...out, status: "fail" };
  return { ...out, status: step.expect(stdout) ? "pass" : "odd" };
}

/** The ACL entries a launcher line says are still on granted paths after its own revoke (entriesLeft above 0, or a grant that is not revoked). */
export function launcherLeft(line) {
  return (line?.grants ?? []).filter((g) => g.applied && (g.revoked !== true || (typeof g.entriesLeft === "number" && g.entriesLeft > 0))).map((g) => ({ path: g.path, mode: g.mode, entriesLeft: g.entriesLeft ?? null, revoked: g.revoked === true }));
}

/** Sums up what a variant reached: the steps that passed, and the first that did not. */
export function summarizeVariant(steps) {
  const passed = steps.filter((s) => s.status === "pass").map((s) => s.id);
  const first = steps.find((s) => s.status !== "pass");
  return { passed, firstProblem: first ? { id: first.id, status: first.status, exitHex: first.exitHex } : undefined, nodeRuns: LADDER_STEPS.filter((s) => s.program === "node").every((s) => passed.includes(s.id)), gitRuns: passed.includes("git-version") };
}

// ---------------------------------------------------------------------------------------------------------------- the ladder runner

const safe = (fn) => { try { return fn(); } catch { return undefined; } };

/**
 * Runs every selected variant's steps. Everything it makes (folders, ACL entries) is removed in a finally path; after each variant the launcher is asked
 * to read the container's entries back from every granted path (`check`), and if any is left, to revoke them and read back again.
 */
export async function runLadder(opts) {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec;
  const profileName = opts.profileName ?? "NimbleNewtExperiment";
  const timeoutMs = opts.timeoutMs ?? STEP_TIMEOUT_MS;
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const copyFile = opts.copyFile ?? copyFileSync;
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? (() => new Date().toISOString()))();
  const variants = selectVariants(opts.variantSpec);
  const notes = [];
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  const info = parseLauncherLine(safe(() => exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), arch: os.arch(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  if (info === undefined || info.ok !== true) {
    notes.push(`the launcher could not create or find the container (${info?.stage ?? "no answer"}: ${info?.error ?? "no JSON line"}); nothing was started`);
    return { report: { schema: LADDER_SCHEMA, generatedAt: now, host, profile: { name: profileName, createdNow: false }, stepTimeoutMs: timeoutMs, variants: [], cleanup: { profileDeleted: false, foldersRemoved: 0, grantsLeft: 0 }, notes }, markdown: "", ranAtAll: false, names };
  }
  const profile = { name: profileName, createdNow: info.profile === "created" };
  const sysRoot = opts.systemRoot ?? (platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const tools = opts.tools;
  const pathApi = platform === "win32" ? win32 : { join, dirname, basename: (p) => p };
  const outVariants = [];
  let foldersRemoved = 0;
  let grantsLeft = 0;
  for (const variant of variants) {
    const root = mkdtempSync(join(tmpBase, "nn-appc-"));
    names.root = root;
    const plan = ladderPlan(root, pathApi);
    const steps = [];
    const left = [];
    let timeouts = 0;
    let firstReadBack = [];
    const granted = new Set();
    try {
      for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.binDir]) mkdirSync(d, { recursive: true });
      const copyNotes = [];
      if (variant.copyTools) {
        for (const [from, to] of [[tools.nodeExe, join(plan.binDir, "node.exe")], [tools.gitExe, join(plan.binDir, "git.exe")]]) {
          if (from === undefined) { copyNotes.push(`${to}: no source`); continue; }
          try { copyFile(from, to); } catch (error) { copyNotes.push(`${to}: copy failed (${error?.code ?? "error"})`); }
        }
      }
      const ctx = { profileName, nodeExe: tools.nodeExe, gitExe: tools.gitExe, programDirs: tools.programDirs, systemRoot: sysRoot, pathDirs: [variant.copyTools ? plan.binDir : undefined, ...(tools.nodeExe ? [pathApi.dirname(tools.nodeExe)] : []), tools.gitDir, ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])].filter(Boolean) };
      const grants = ladderGrants(variant, plan, ctx);
      for (const [, path] of grants) granted.add(path);
      // The copied tools live under the granted workspace; the PATH of a copy variant lists that folder first.
      for (const step of LADDER_STEPS) {
        const outFiles = { stdout: join(plan.outDir, `${step.id}.out.txt`), stderr: join(plan.outDir, `${step.id}.err.txt`) };
        if (timeouts >= MAX_TIMEOUTS_PER_VARIANT) { steps.push({ id: step.id, label: step.label, status: "skipped", detail: `${MAX_TIMEOUTS_PER_VARIANT} earlier steps of this variant timed out` }); continue; }
        if (opts.dryRun) { steps.push({ id: step.id, label: step.label, status: "not-started", detail: "dry run: the launcher was not started" }); continue; }
        const args = buildStepArgs(variant, step, plan, ctx, timeoutMs, outFiles);
        log(`variant ${variant.id}: ${step.id}`);
        const r = safe(() => exec(opts.launcherPath, args, { timeoutMs: timeoutMs + 60_000 }));
        const line = parseLauncherLine(r?.stdout ?? "");
        const result = judgeStep(step, line, safe(() => readFileSync(outFiles.stdout, "utf8")) ?? "", safe(() => readFileSync(outFiles.stderr, "utf8")) ?? "");
        if (line?.capabilities !== undefined) result.capabilities = line.capabilities.map((c) => c.name);
        const stillThere = launcherLeft(line);
        if (stillThere.length > 0) result.aclLeftAfterRun = stillThere;
        steps.push(result);
        if (result.status === "timeout") timeouts++;
        if (line !== undefined && line.allGrantsRevoked === false) left.push(...stillThere.map((s) => ({ ...s, step: step.id })));
      }
    } finally {
      // Read the container's entries back from every granted path; remove what is left and read again; then delete the folders.
      let finalLeft = [];
      if (!opts.dryRun && granted.size > 0) {
        const rb = aclReadBack(exec, opts.launcherPath, profileName, [...granted]);
        firstReadBack = rb.first;
        finalLeft = rb.final;
      }
      grantsLeft += finalLeft.length;
      try { removeTree(root); foldersRemoved++; } catch { notes.push("a fixture folder could not be removed"); }
      outVariants.push({
        id: variant.id, desc: variant.desc,
        settings: { aapPolicy: variant.aapPolicy, capabilities: variant.capabilities, programGrants: variant.programGrants, wsEnv: variant.wsEnv, jobLimits: variant.limits, copyTools: variant.copyTools, nodeOptions: variant.nodeOptions ?? "(unset)", nodeFlags: variant.nodeFlags },
        steps: [...steps], summary: summarizeVariant(steps), aclLeftDuringRun: left, aclFirstReadBack: firstReadBack, aclLeftFinal: finalLeft,
      });
    }
  }
  let profileDeleted = false;
  if (!opts.dryRun && profile.createdNow) profileDeleted = parseLauncherLine(safe(() => exec(opts.launcherPath, ["delete-profile", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  const report = { schema: LADDER_SCHEMA, generatedAt: now, host, profile, stepTimeoutMs: timeoutMs, variants: outVariants, cleanup: { profileDeleted, foldersRemoved, grantsLeft }, notes };
  const problems = validateLadder(report);
  if (problems.length > 0) report.notes.push(`report schema problems: ${problems.join(", ")}`);
  return { report, markdown: renderLadderMarkdown(report), ranAtAll: true, names };
}

export function validateLadder(r) {
  const p = [];
  const need = (c, m) => { if (!c) p.push(m); };
  need(r?.schema === LADDER_SCHEMA, "schema");
  need(typeof r?.generatedAt === "string", "generatedAt");
  need(r?.host && typeof r.host.platform === "string" && typeof r.host.elevated === "boolean", "host");
  need(Array.isArray(r?.variants) && r.variants.length > 0, "variants");
  need(r?.cleanup && typeof r.cleanup.profileDeleted === "boolean" && typeof r.cleanup.grantsLeft === "number", "cleanup");
  for (const v of r?.variants ?? []) {
    need(typeof v.id === "string" && v.settings && Array.isArray(v.settings.capabilities), `variant ${v.id}: settings`);
    need(Array.isArray(v.steps) && v.steps.length === LADDER_STEPS.length, `variant ${v.id}: steps`);
    for (const s of v.steps ?? []) need(Object.keys(MARK).includes(s.status), `variant ${v.id}/${s.id}: status`);
  }
  return p;
}

export function renderLadderMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 2: smoke ladder", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""} (node ${report.host.node ?? "?"}); session id ${report.host.sessionId}; elevated: ${report.host.elevated}. Timeout per step: ${report.stepTimeoutMs} ms.`, "");
  L.push("Each cell is one program started in the container of that variant: ok = exit 0 and the expected output; fail = a non-zero exit (the code is shown); TIMEOUT = still running when the timeout ended it; not started = the launcher refused; skipped = the variant already timed out twice.", "");
  L.push(`| variant | ${LADDER_STEPS.map((s) => s.label.replaceAll("|", "/")).join(" | ")} | node ok | git ok |`);
  L.push(`|${" --- |".repeat(LADDER_STEPS.length + 3)}`);
  for (const v of report.variants) {
    const cells = v.steps.map((s) => (s.status === "fail" ? `fail ${s.exitHex}` : MARK[s.status] ?? s.status));
    L.push(`| ${v.id} | ${cells.join(" | ")} | ${v.summary.nodeRuns ? "YES" : "no"} | ${v.summary.gitRuns ? "YES" : "no"} |`);
  }
  L.push("");
  const winners = report.variants.filter((v) => v.summary.nodeRuns);
  L.push(winners.length > 0 ? `Variants where every node step passed: ${winners.map((v) => v.id).join(", ")}.` : "No variant ran every node step.", "");
  for (const v of report.variants) {
    L.push(`## ${v.id}`, "", `- ${v.desc}.`);
    L.push(`- Settings: policy attribute ${v.settings.aapPolicy}; capabilities ${v.settings.capabilities.join(", ") || "none"}; program folders granted ${v.settings.programGrants}; TEMP in the workspace ${v.settings.wsEnv}; job limits ${v.settings.jobLimits}; tools copied into the workspace ${v.settings.copyTools}; NODE_OPTIONS ${v.settings.nodeOptions}; node flags ${v.settings.nodeFlags.join(" ") || "none"}.`);
    for (const s of v.steps.filter((x) => x.status !== "pass")) {
      const bits = [`${s.status}`];
      if (s.exitHex !== undefined) bits.push(`exit ${s.exitHex} after ${s.elapsedMs} ms`);
      if (s.detail) bits.push(s.detail);
      if ((s.stderrHead ?? []).length > 0) bits.push(`stderr: ${s.stderrHead.map((x) => `\`${x.replaceAll("`", "'")}\``).join(" | ")}`);
      if ((s.stdoutHead ?? []).length > 0 && s.status !== "timeout") bits.push(`stdout: ${s.stdoutHead.map((x) => `\`${x.replaceAll("`", "'")}\``).join(" | ")}`);
      L.push(`- ${s.id}: ${bits.join("; ")}`);
      if (s.hang) L.push(`  - hang diagnosis at the timeout: ${s.hang.stillActive ? "process still alive" : "process had ended"}; processes in the job ${s.hang.jobProcesses}; CPU kernel/user ${s.hang.processKernelMs ?? "?"}/${s.hang.processUserMs ?? "?"} ms; ${s.hang.threads} threads, ${s.hang.threadsBusyInOneSecond} used CPU during one second (0 means all are waiting); per-thread CPU: ${s.hang.threadCpu || "n/a"}.`);
    }
    if (v.aclLeftDuringRun.length > 0) L.push(`- ACL entries the launcher's own revoke left: ${v.aclLeftDuringRun.map((a) => `${a.step}: ${a.mode} ${a.path} (entries ${a.entriesLeft})`).join("; ")}.`);
    if (v.aclFirstReadBack.length > 0) L.push(`- Read-back after the variant found entries left on: ${v.aclFirstReadBack.map((a) => `${a.path} (${a.entriesLeft})`).join("; ")}; after a second revoke: ${v.aclLeftFinal.length === 0 ? "none left" : v.aclLeftFinal.map((a) => `${a.path} (${a.entriesLeft})`).join("; ")}.`);
    else L.push("- Read-back of every granted path after the variant: no ACL entry left.");
    L.push("");
  }
  L.push("## Clean-up", "", `- Profile deleted: ${report.cleanup.profileDeleted}; folders removed: ${report.cleanup.foldersRemoved}; granted paths with an ACL entry still left at the end: ${report.cleanup.grantsLeft}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

// ---------------------------------------------------------------------------------------------------------------- the firewall mini-experiment

/** The exact PowerShell commands (documented in the README). The package SID and the rule name are validated before they are put into a command. */
export const SID_PATTERN = /^S-1-15-2(?:-\d+){1,}$/;
export const RULE_PATTERN = /^nn-appc-block-[0-9a-f]{8}$/;

/** The loopback exemption of a package (CheckNetIsolation, administrator): an AppContainer cannot reach the host's own loopback addresses without one. */
export const PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
export function loopbackCommands(packageSid, packageName) {
  if (!SID_PATTERN.test(packageSid)) throw new Error("package SID has an unexpected form");
  if (packageName !== undefined && !PACKAGE_NAME_PATTERN.test(packageName)) throw new Error("package name has an unexpected form");
  return {
    // Round 3b: the same exemption given by the package's name (`-n=`, the "package family name" of the documentation; for a container made with CreateAppContainerProfile that is the profile name).
    // It is read back by the SID (`exists`), whichever way it was added, because `LoopbackExempt -s` lists the SIDs.
    ...(packageName === undefined ? {} : { addByName: `& CheckNetIsolation.exe LoopbackExempt -a -n=${packageName} | Out-Null; if ($LASTEXITCODE -ne 0) { throw "CheckNetIsolation add by name exit $LASTEXITCODE" }; 'added'` }),
    add: `& CheckNetIsolation.exe LoopbackExempt -a -p=${packageSid} | Out-Null; if ($LASTEXITCODE -ne 0) { throw "CheckNetIsolation add exit $LASTEXITCODE" }; 'added'`,
    exists: `@((& CheckNetIsolation.exe LoopbackExempt -s) | Select-String -SimpleMatch '${packageSid}').Count`,
    remove: `& CheckNetIsolation.exe LoopbackExempt -d -p=${packageSid} | Out-Null; 'removed'`,
  };
}

const psCount = (ps, script) => { const n = Number(String(safe(() => ps(script).stdout) ?? "NaN").trim()); return Number.isNaN(n) ? null : n; };

/**
 * Puts a cell's network conditions in place (an outbound BLOCK rule for the package SID, a loopback exemption) and reads each back. `ok` is false when something asked for is not
 * confirmed, and the cell is then not run (its results would not mean what its name says). Call `netTeardown` in a finally path whatever happens.
 */
export function netSetup(cell, { ps, packageSid, ruleName, profileName }) {
  const st = { wanted: { rule: cell.firewallBlock === true, exempt: cell.loopbackExempt === true || cell.loopbackExempt === "name", exemptBy: cell.loopbackExempt === "name" ? "name" : "sid" }, ruleName, packageSid, profileName, ruleAdded: false, exemptAdded: false, ok: true, errors: [] };
  if (!st.wanted.rule && !st.wanted.exempt) return { ...st, summary: "none needed" };
  if (typeof ps !== "function") return { ...st, ok: false, errors: ["no PowerShell available"], summary: "NOT put in place: no PowerShell available" };
  const fw = firewallCommands(ruleName, packageSid);
  const lb = loopbackCommands(packageSid, st.wanted.exemptBy === "name" ? profileName : undefined);
  if (st.wanted.exempt) {
    const r = safe(() => ps(st.wanted.exemptBy === "name" ? lb.addByName : lb.add));
    st.exemptAdded = r?.status === 0 && (psCount(ps, lb.exists) ?? 0) >= 1;
    if (!st.exemptAdded) { st.ok = false; st.errors.push(`loopback exemption: ${String(r?.stderr ?? "no answer").trim().split(/\r?\n/)[0]?.slice(0, 160)}`); }
  }
  if (st.wanted.rule) {
    const r = safe(() => ps(fw.add));
    st.ruleAdded = r?.status === 0 && (psCount(ps, fw.exists) ?? 0) >= 1;
    if (!st.ruleAdded) { st.ok = false; st.errors.push(`block rule: ${String(r?.stderr ?? "no answer").trim().split(/\r?\n/)[0]?.slice(0, 160)}`); }
  }
  st.summary = st.ok ? `in place and read back (block rule ${st.wanted.rule ? "yes" : "no"}, loopback exemption ${st.wanted.exempt ? `yes, by ${st.wanted.exemptBy}` : "no"})` : `NOT confirmed (${st.errors.join("; ")}); the cell was not run`;
  return st;
}

/** Removes what `netSetup` added and reads the absence back. Never throws. */
export function netTeardown(st, { ps }) {
  const out = { ruleGone: true, exemptGone: true };
  if (typeof ps !== "function" || (!st.wanted?.rule && !st.wanted?.exempt)) return out;
  const fw = firewallCommands(st.ruleName, st.packageSid);
  const lb = loopbackCommands(st.packageSid);
  if (st.wanted.rule) { safe(() => ps(fw.remove)); out.ruleGone = psCount(ps, fw.exists) === 0; }
  if (st.wanted.exempt) { safe(() => ps(lb.remove)); out.exemptGone = psCount(ps, lb.exists) === 0; }
  return out;
}

export function firewallCommands(ruleName, packageSid) {
  if (!RULE_PATTERN.test(ruleName)) throw new Error("rule name has an unexpected form");
  if (!SID_PATTERN.test(packageSid)) throw new Error("package SID has an unexpected form");
  return {
    profiles: "Get-NetFirewallProfile | ForEach-Object { \"$($_.Name)=$($_.Enabled)\" }",
    add: `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Outbound -Action Block -Package '${packageSid}' -Protocol Any -Profile Any -Enabled True | Out-Null; 'added'`,
    exists: `@(Get-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue).Count`,
    remove: `Remove-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue; 'removed'`,
  };
}

/** What the connect clients are: a program that tries both targets and ends. Judged by the host's listeners, not by anything the client says. */
export function clientCommand(client, targets, ctx, variant, plan) {
  const [loop, out] = targets;
  if (client === "curl") {
    const exe = win32.join(ctx.systemRoot ?? "C:\\Windows", "System32", "curl.exe");
    // One curl process per target would need two runs; --next lets one process try both URLs, each with a short connect timeout.
    return { exe, args: ["--silent", "--show-error", "--connect-timeout", "5", "--max-time", "8", `http://${loop.host}:${loop.port}/`, "--next", "--silent", "--show-error", "--connect-timeout", "5", "--max-time", "8", `http://${out.host}:${out.port}/`] };
  }
  const script = `const net=require('net');const t=${JSON.stringify([loop, out])};let n=0;for(const x of t){const s=net.connect({host:x.host,port:x.port,timeout:4000});s.on('connect',()=>{s.destroy()});s.on('error',(e)=>{process.stdout.write(x.host+':'+e.code+'\\n')});s.on('timeout',()=>{process.stdout.write(x.host+':timeout\\n');s.destroy()});s.on('close',()=>{if(++n===t.length)process.exit(0)})}`;
  return { exe: variant.copyTools ? join(plan.binDir, "node.exe") : ctx.nodeExe, args: ["-e", script] };
}

async function listen(host) {
  let count = 0;
  const server = net.createServer((socket) => { count++; socket.destroy(); });
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(0, host, () => resolveListen({ port: server.address().port, count: () => count, close: () => new Promise((r) => server.close(() => r())) }));
  });
}

/** A connect made from the harness itself (outside any container): the control that a firewall rule scoped to the container must not affect. */
function connectOutside(host, port, timeoutMs = 4000) {
  return new Promise((resolveConnect) => {
    const s = net.connect({ host, port, timeout: timeoutMs });
    s.on("connect", () => { s.destroy(); resolveConnect("connected"); });
    s.on("error", (e) => resolveConnect(`error:${e.code}`));
    s.on("timeout", () => { s.destroy(); resolveConnect("timeout"); });
  });
}

const waitFor = async (cond, { tries = 40, stepMs = 250 } = {}) => { for (let i = 0; i < tries; i++) { if (await cond()) return true; await new Promise((r) => setTimeout(r, stepMs)); } return false; };

/**
 * Phases: control (outside, no rule) -> inside without rule -> add the BLOCK rule for the package SID -> inside with rule -> control outside with rule -> remove the rule -> inside again.
 * Verdict: the rule is effective when the container could connect outbound before it, and neither the outbound nor the loopback target saw a connection while it existed,
 * while the outside control still reached both. The rule is removed in a finally path whatever happens; a failed removal is reported.
 */
export async function runFirewall(opts) {
  const platform = opts.platform ?? process.platform;
  const exec = opts.exec;
  const ps = opts.ps; // (script) => { status, stdout, stderr }
  const profileName = opts.profileName ?? "NimbleNewtExperiment";
  const timeoutMs = opts.timeoutMs ?? STEP_TIMEOUT_MS;
  const tmpBase = opts.tmpBase ?? os.tmpdir();
  const log = opts.log ?? (() => {});
  const now = (opts.now ?? (() => new Date().toISOString()))();
  // Round 2 ran this with the first variant of the list (no capability) because the command line's default "all" was passed through. The default is the variant the text names.
  const variant = selectVariants(opts.variantSpec === undefined || opts.variantSpec === "all" ? "ac-inet-private" : opts.variantSpec)[0];
  const names = { root: undefined, home: os.homedir(), tmp: tmpBase, user: safe(() => os.userInfo().username), host: os.hostname() };
  const notes = [];
  const info = parseLauncherLine(safe(() => exec(opts.launcherPath, ["info", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "");
  const host = { platform, release: os.release(), node: process.version, elevated: info?.elevated === true, sessionId: typeof info?.sessionId === "number" ? info.sessionId : -1 };
  const empty = (why) => ({ report: { schema: FIREWALL_SCHEMA, generatedAt: now, host, variant: variant.id, verdict: "inconclusive", why, phases: [], rule: undefined, notes }, markdown: "", ranAtAll: false, names });
  if (info === undefined || info.ok !== true) return empty(`the launcher could not create or find the container (${info?.stage ?? "no answer"})`);
  const profile = { name: profileName, createdNow: info.profile === "created" };
  const packageSid = info.containerSid;
  if (!SID_PATTERN.test(packageSid ?? "")) return empty("the launcher gave no usable container SID");
  const ruleName = `nn-appc-block-${(opts.randomHex ?? (() => Math.random().toString(16).slice(2, 10).padEnd(8, "0")))()}`;
  const cmds = firewallCommands(ruleName, packageSid);
  const sysRoot = opts.systemRoot ?? (platform === "win32" ? (process.env.SystemRoot ?? "C:\\Windows") : undefined);
  const tools = opts.tools;
  const outbound = opts.outbound;
  const loop = await listen("127.0.0.1");
  // A second listener that cannot be made (macOS has no 127.0.0.2 address) must not leave the first one open: an open listener keeps the process alive for ever.
  let wide;
  try { wide = outbound.local ? await listen(outbound.host) : { port: 9, count: () => 0, close: async () => {} }; } catch (error) { await loop.close(); throw error; }
  const root = mkdtempSync(join(tmpBase, "nn-appc-"));
  names.root = root;
  const plan = ladderPlan(root, platform === "win32" ? win32 : { join, dirname, basename: (p) => p });
  const phases = [];
  const lbCmds = opts.exemptByName === true ? loopbackCommands(packageSid, profileName) : undefined;
  const exemption = lbCmds ? { by: "name", commandAdd: lbCmds.addByName, commandRemove: lbCmds.remove, added: false, confirmed: false, removed: false, existsAfterRemoval: null } : undefined;
  const rule = { name: ruleName, packageScoped: true, commandAdd: cmds.add, commandRemove: cmds.remove, added: false, removed: false, existsAfterRemoval: null };
  let firewallProfiles = "unknown";
  try {
    for (const d of [plan.workspace, plan.home, plan.scratch, plan.outDir, plan.binDir]) mkdirSync(d, { recursive: true });
    if (variant.copyTools) {
      for (const [from, to] of [[tools.nodeExe, join(plan.binDir, "node.exe")]]) safe(() => (opts.copyFile ?? copyFileSync)(from, to));
    }
    const ctx = { profileName, nodeExe: tools.nodeExe, gitExe: tools.gitExe, programDirs: tools.programDirs, systemRoot: sysRoot, pathDirs: [...(tools.nodeExe ? [(platform === "win32" ? win32 : { dirname }).dirname(tools.nodeExe)] : []), ...(sysRoot ? [win32.join(sysRoot, "System32"), sysRoot] : [])] };
    const targets = [{ host: "127.0.0.1", port: loop.port, kind: "loopback" }, { host: outbound.host, port: wide.port, kind: "outbound" }];
    firewallProfiles = (safe(() => ps(cmds.profiles).stdout) ?? "unknown").trim().replace(/\s+/g, " ");

    const inside = async (label, client) => {
      log(`firewall: ${label} (${client})`);
      const before = [loop.count(), wide.count()];
      const cmd = clientCommand(client, targets, ctx, variant, plan);
      const fake = { id: `fw-${label}-${client}`, label: `${client} connect`, program: "x", args: () => cmd.args };
      const outFiles = { stdout: join(plan.outDir, `${fake.id}.out.txt`), stderr: join(plan.outDir, `${fake.id}.err.txt`) };
      const a = buildStepArgs(variant, { ...fake, program: "cmd" }, plan, ctx, Math.min(timeoutMs, 30_000), outFiles);
      // Replace the program: buildStepArgs names cmd.exe; this phase runs the connect client.
      const iExe = a.indexOf("--exe");
      a[iExe + 1] = cmd.exe;
      a[a.indexOf("--cmdline") + 1] = buildCommandLine(cmd.exe, cmd.args);
      const r = safe(() => exec(opts.launcherPath, a, { timeoutMs: 120_000 }));
      const line = parseLauncherLine(r?.stdout ?? "");
      // A client that was started is judged by the listeners; one that never started proves nothing about the network.
      await new Promise((res) => setTimeout(res, opts.settleMs ?? 300));
      return {
        phase: label, client, started: line?.childStarted === true, capabilitiesSeen: Array.isArray(line?.capabilities) ? line.capabilities.map((c) => c.name) : undefined, exitHex: line?.childStarted ? hex(line.childExitCode) : undefined, timedOut: line?.timedOut === true,
        loopbackConnections: loop.count() - before[0], outboundConnections: wide.count() - before[1], stderrHead: stderrHead(safe(() => readFileSync(outFiles.stderr, "utf8")) ?? "", 3, 160), stdoutHead: stderrHead(safe(() => readFileSync(outFiles.stdout, "utf8")) ?? "", 3, 160), launcherStage: line?.childStarted === true ? undefined : (line?.stage ?? "no-launcher-answer"),
      };
    };
    const outsideControl = async (label) => {
      const before = [loop.count(), wide.count()];
      const results = [await connectOutside("127.0.0.1", loop.port), await connectOutside(outbound.host, wide.port)];
      await new Promise((res) => setTimeout(res, opts.settleMs ?? 300));
      return { phase: label, client: "harness (outside the container)", started: true, loopbackConnections: loop.count() - before[0], outboundConnections: wide.count() - before[1], results };
    };
    const clients = opts.clients ?? ["curl", "node"];
    phases.push(await outsideControl("control-before-rule"));
    for (const c of clients) phases.push(await inside("inside-without-rule", c));
    // Round 3b: the loopback exemption added by the package's NAME (CheckNetIsolation LoopbackExempt -a -n=...), confirmed by asking for it back, then the same clients, then removed.
    if (exemption) {
      log("firewall: adding the loopback exemption by name");
      const ex = safe(() => ps(lbCmds.addByName));
      exemption.added = ex?.status === 0;
      exemption.confirmed = exemption.added && (psCount(ps, lbCmds.exists) ?? 0) >= 1;
      if (!exemption.added) exemption.addError = (ex?.stderr ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "no answer";
      if (exemption.confirmed) for (const c of clients) phases.push(await inside("inside-with-name-exemption", c));
      safe(() => ps(lbCmds.remove));
      exemption.removed = psCount(ps, lbCmds.exists) === 0;
    }
    // The rule: needs administrator rights. Its presence is confirmed by asking for it back before anything is concluded.
    log("firewall: adding the block rule");
    const added = safe(() => ps(cmds.add));
    rule.added = added?.status === 0 && Number((safe(() => ps(cmds.exists).stdout) ?? "0").trim()) >= 1;
    if (!rule.added) rule.addError = (added?.stderr ?? "").trim().split(/\r?\n/)[0]?.slice(0, 200) ?? "no answer";
    if (rule.added) {
      for (const c of clients) phases.push(await inside("inside-with-rule", c));
      phases.push(await outsideControl("control-with-rule"));
      // The rule goes now (the finally path removes it again if anything above threw), then the same connections once more: they show the rule was the cause.
      safe(() => ps(cmds.remove));
      for (const c of clients) phases.push(await inside("inside-after-removal", c));
    }
  } finally {
    // The exemption (if one was added) and the rule are deleted whatever happened; their absence is read back.
    if (exemption && !exemption.removed) { safe(() => ps(lbCmds.remove)); const n = psCount(ps, lbCmds.exists); exemption.removed = n === 0; exemption.existsAfterRemoval = n; }
    const removed = safe(() => ps(cmds.remove));
    rule.removed = removed?.status === 0;
    const exists = Number((safe(() => ps(cmds.exists).stdout) ?? "NaN").trim());
    rule.existsAfterRemoval = Number.isNaN(exists) ? null : exists;
    await loop.close();
    await wide.close();
    try { removeTree(root); } catch { notes.push("a fixture folder could not be removed"); }
  }
  let profileDeleted = false;
  if (!opts.dryRun && profile.createdNow) profileDeleted = parseLauncherLine(safe(() => exec(opts.launcherPath, ["delete-profile", "--name", profileName], { timeoutMs: 60_000 }).stdout) ?? "")?.ok === true;
  else if (!profile.createdNow) notes.push("the container profile existed before this run, so it was left in place");
  // The capabilities the launcher says it gave the container (round 2 ran with none although the variant named two): what the clients saw is only meaningful with them.
  const seen = phases.find((p) => p.capabilitiesSeen !== undefined)?.capabilitiesSeen ?? [];
  const missing = variant.capabilities.filter((c) => !seen.includes(c));
  let verdict = judgeFirewall(phases, rule);
  if (missing.length > 0 && phases.some((p) => p.started)) verdict = { verdict: "inconclusive", why: `the launcher did not apply the capabilities the variant names (missing: ${missing.join(", ")})` };
  if (exemption) {
    const byName = phases.filter((p) => p.phase === "inside-with-name-exemption" && p.started);
    exemption.loopbackReached = byName.length === 0 ? null : byName.some((p) => p.loopbackConnections > 0);
    exemption.outboundReached = byName.length === 0 ? null : byName.some((p) => p.outboundConnections > 0);
  }
  const report = { schema: FIREWALL_SCHEMA, generatedAt: now, host, variant: variant.id, capabilities: variant.capabilities, capabilitiesSeen: seen, firewallProfiles, rule, ...(exemption ? { exemption } : {}), phases, verdict: verdict.verdict, why: verdict.why, assumptions: verdict.assumptions ?? [], cleanup: { profileDeleted, ruleRemoved: rule.removed && rule.existsAfterRemoval === 0, ...(exemption ? { exemptionRemoved: exemption.removed && (exemption.existsAfterRemoval ?? 0) === 0 } : {}) }, notes };
  return { report, markdown: renderFirewallMarkdown(report), ranAtAll: true, names };
}

/**
 * The verdict from the phases. `effective`: before the rule at least one inside client reached the outbound listener, with the rule none reached either listener,
 * and the outside control reached both listeners with the rule in place. `loopback`: whether the container could ever reach the loopback listener.
 */
export function judgeFirewall(phases, rule) {
  const sel = (name) => phases.filter((p) => p.phase === name && p.started);
  const before = sel("inside-without-rule");
  const withRule = sel("inside-with-rule");
  const ctlAfter = phases.find((p) => p.phase === "control-with-rule");
  const reachedBefore = before.some((p) => p.outboundConnections > 0);
  const leakedWith = withRule.some((p) => p.outboundConnections > 0 || p.loopbackConnections > 0);
  const loopBefore = before.some((p) => p.loopbackConnections > 0);
  // The three assumptions the experiment rests on, each judged alone from the listeners' counts (holds | FAILS | not shown).
  const a1 = before.length === 0 ? { status: "not shown", evidence: "no connect client started inside the container without the rule" } : reachedBefore ? { status: "holds", evidence: "a client inside the container reached the outbound listener before the rule existed" } : { status: "FAILS", evidence: "no client inside the container reached the outbound listener even without the rule" };
  const a2 = !rule.added || withRule.length === 0 ? { status: "not shown", evidence: !rule.added ? "the rule was not added" : "no connect client started inside the container with the rule in place" } : !reachedBefore ? { status: "not shown", evidence: "nothing reached the listener before the rule, so a block cannot be told apart from the network being closed anyway" } : leakedWith ? { status: "FAILS", evidence: "a client inside the container reached a listener while the rule existed" } : { status: "holds", evidence: "nothing from inside the container reached either listener while the rule existed" };
  const a3 = !rule.added || ctlAfter === undefined ? { status: "not shown", evidence: "no control outside the container was run with the rule in place" } : ctlAfter.outboundConnections >= 1 && ctlAfter.loopbackConnections >= 1 ? { status: "holds", evidence: "the control outside the container still reached both listeners with the rule in place" } : { status: "FAILS", evidence: "the control outside the container could not reach both listeners with the rule in place" };
  const assumptions = [
    { n: 1, text: "the capabilities internetClient and privateNetworkClientServer open the network for the container", ...a1 },
    { n: 2, text: "an outbound block rule scoped to the container's package SID stops that connection", ...a2 },
    { n: 3, text: "the rule affects only that container (a process outside it is not blocked)", ...a3 },
  ];
  const result = (verdict, why) => ({ verdict, why, assumptions });
  if (!rule.added) return result("inconclusive", `the block rule could not be added${rule.addError ? ` (${rule.addError})` : ""}; administrator rights are needed`);
  if (withRule.length === 0 && before.length === 0) return result("inconclusive", "no connect client started inside the container");
  if (withRule.length === 0) return result("inconclusive", "no connect client started inside the container with the rule in place");
  if (!reachedBefore) return result("inconclusive", "the container could not reach the outbound listener even without the rule (the capability alone did not allow it), so the rule cannot be shown to add anything");
  if (leakedWith) return result("fail", "a connection from inside the container reached a listener while the block rule existed");
  if (!ctlAfter || ctlAfter.outboundConnections < 1 || ctlAfter.loopbackConnections < 1) return result("inconclusive", "the control outside the container did not reach both listeners with the rule in place, so the rule's scope is not shown");
  return result("pass", `the outbound connection worked before the rule, none reached a listener with the rule${loopBefore ? " (the loopback one worked before it as well)" : " (loopback was already refused for the container)"}, and the control outside the container was unaffected`);
}

export function renderFirewallMarkdown(report) {
  const L = ["# Windows AppContainer experiment, round 2: network cut by firewall", ""];
  L.push(`Generated ${report.generatedAt}. Host: ${report.host.platform} ${report.host.release ?? ""}; session id ${report.host.sessionId}; elevated: ${report.host.elevated}. Container variant: ${report.variant} (capabilities: ${(report.capabilities ?? []).join(", ") || "none"}). Firewall profiles: ${report.firewallProfiles}.`, "");
  L.push(`Verdict: **${report.verdict}**: ${report.why}.`, "");
  if ((report.assumptions ?? []).length > 0) {
    L.push("Assumptions, judged one by one:", "");
    for (const a of report.assumptions) L.push(`${a.n}. Assumption ${a.n} ${a.status === "FAILS" ? "**FAILS**" : a.status}: ${a.text}. Evidence: ${a.evidence}.`);
    const failing = report.assumptions.filter((a) => a.status === "FAILS");
    L.push("", failing.length > 0 ? `The assumption that fails: ${failing.map((a) => `number ${a.n} (${a.text})`).join("; ")}.` : report.assumptions.every((a) => a.status === "holds") ? "No assumption failed." : `No assumption was shown to fail; not shown: ${report.assumptions.filter((a) => a.status === "not shown").map((a) => `number ${a.n}`).join(", ")}.`, "");
  }
  if (report.exemption) {
    const e = report.exemption;
    L.push(`Loopback exemption added by name (\`${e.commandAdd}\`): added ${e.added}${e.addError ? ` (${e.addError})` : ""}; confirmed in the exemption list by the package SID: ${e.confirmed}; the container reached the loopback listener with it: ${e.loopbackReached === null ? "not run" : e.loopbackReached}; the outbound listener: ${e.outboundReached === null ? "not run" : e.outboundReached}; removed and gone: ${e.removed}.`, "");
  }
  L.push("Commands run (PowerShell, administrator):", "", "```", report.rule.commandAdd, report.rule.commandRemove, "```", "");
  L.push(`Rule added and confirmed: ${report.rule.added}; removed: ${report.rule.removed}; rules still named like it after removal: ${report.rule.existsAfterRemoval}.`, "");
  L.push("| phase | client | started | loopback listener connections | outbound listener connections | notes |", "| --- | --- | --- | --- | --- | --- |");
  for (const p of report.phases) L.push(`| ${p.phase} | ${p.client} | ${p.started}${p.exitHex ? ` (exit ${p.exitHex}${p.timedOut ? ", timed out" : ""})` : ""} | ${p.loopbackConnections} | ${p.outboundConnections} | ${[p.launcherStage ? `launcher: ${p.launcherStage}` : "", ...(p.stderrHead ?? []).map((x) => `\`${x.replaceAll("`", "'").replaceAll("|", "/")}\``), ...(p.stdoutHead ?? []).map((x) => `out: \`${x.replaceAll("`", "'").replaceAll("|", "/")}\``)].filter(Boolean).join(" ")} |`);
  L.push("", "Connections are what the host's own listeners counted, not what a client printed.", "");
  L.push(`- Container profile deleted: ${report.cleanup.profileDeleted}; rule removed and gone: ${report.cleanup.ruleRemoved}.`);
  for (const n of report.notes) L.push(`- ${n}`);
  return `${L.join("\n")}\n`;
}

