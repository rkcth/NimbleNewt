// NimbleNewt experiment (not product code): the probe that runs INSIDE the AppContainer.
//   node probe.mjs <config.json>
// It attempts the ten containment cases of packages/worker/src/sandbox/containment.ts plus tool and network checks, against paths the harness
// wrote into the config, and prints ONE line: `NN-PROBE-REPORT:` followed by a JSON report. It uses Node's own modules only (the container cannot
// read the repository, so the harness copies this single file next to the config). Every created file is removed again where possible.
// The report holds outcomes and error codes, never file contents or environment values.
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import net from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROBE_SCHEMA = "nn-appc-probe-1";
export const REPORT_PREFIX = "NN-PROBE-REPORT:";
export const DENIED_CODES = ["EACCES", "EPERM"];
const BLOCKED_OTHER = ["ECONNREFUSED", "ETIMEDOUT", "TIMEOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "EADDRNOTAVAIL", "EAI_AGAIN", "ENOTFOUND"];
const STARTUP_DENIAL_PATTERN = /access is denied|access denied|EACCES|EPERM|permission denied|operation not permitted/i;

/** One attempt's outcome from the error it got: allowed (no error), denied (an access-denied code), blocked-other, missing (ENOENT) or error. */
export function classifyError(error) {
  if (error === undefined || error === null) return "allowed";
  const code = error.code ?? "";
  if (DENIED_CODES.includes(code)) return "denied";
  if (BLOCKED_OTHER.includes(code)) return "blocked-other";
  if (code === "ENOENT" || code === "ENOTDIR") return "missing";
  return "error";
}

/**
 * The summary of one probe: what was expected ("allowed" or "denied") and what the attempts show.
 *   expect allowed: actual "allowed" when every attempt was allowed, "denied" when any was refused, else "error".
 *   expect denied:  actual "allowed" when ANY attempt got through (a leak), "denied" when every attempt got an access-denied code,
 *                   "denied-weak" when nothing got through but some failed for another reason (missing, refused, timed out), "inconclusive" with no attempt.
 */
export function summarize(expect, attempts) {
  const outcomes = attempts.map((a) => a.outcome);
  if (outcomes.length === 0) return "inconclusive";
  if (expect === "allowed") {
    if (outcomes.every((o) => o === "allowed")) return "allowed";
    return outcomes.includes("denied") ? "denied" : "error";
  }
  if (outcomes.includes("allowed")) return "allowed";
  if (outcomes.every((o) => o === "denied")) return "denied";
  if (outcomes.every((o) => o === "skipped")) return "inconclusive";
  return "denied-weak";
}

const attemptSync = (name, fn) => {
  try { const value = fn(); return { name, outcome: "allowed", ...(value === undefined ? {} : { note: value }) }; }
  catch (error) { return { name, outcome: classifyError(error), code: error?.code ?? null }; }
};

const connectOnce = (name, host, port, timeoutMs) => new Promise((resolve) => {
  let settled = false;
  const done = (value) => { if (!settled) { settled = true; try { socket.destroy(); } catch { /* ignored */ } resolve({ name, ...value }); } };
  const socket = net.connect({ host, port });
  socket.setTimeout(timeoutMs, () => done({ outcome: classifyError({ code: "TIMEOUT" }), code: "TIMEOUT" }));
  socket.once("connect", () => done({ outcome: "allowed" }));
  socket.once("error", (error) => done({ outcome: classifyError(error), code: error?.code ?? null }));
});

const readsSecret = (file, secret) => {
  const text = readFileSync(file, "utf8");
  return text.includes(secret) ? "content-visible" : "readable-but-no-secret";
};

/** Runs a tool and returns {outcome, code, startupDenials}. `allowed` = it started and exited 0. */
function runTool(name, file, args, options, denials) {
  const result = spawnSync(file, args, { encoding: "utf8", timeout: options.timeoutMs ?? 120_000, windowsHide: true, cwd: options.cwd, env: options.env ?? process.env, shell: options.shell === true });
  const text = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  for (const line of text.split(/\r?\n/)) if (STARTUP_DENIAL_PATTERN.test(line)) denials.push({ tool: name, line: line.trim().slice(0, 240) });
  if (result.error) {
    if (result.error.code) denials.push({ tool: name, line: `spawn error ${result.error.code}` });
    return { name, outcome: classifyError(result.error), code: result.error.code ?? "SPAWN" };
  }
  if (result.status === 0) return { name, outcome: "allowed", note: `exit 0, ${(result.stdout ?? "").trim().split(/\r?\n/)[0]?.slice(0, 60) ?? ""}` };
  return { name, outcome: STARTUP_DENIAL_PATTERN.test(text) ? "denied" : "error", code: `exit ${result.status}${result.signal ? ` ${result.signal}` : ""}` };
}

/** Attempts everything the config lists and returns the report object. `deps` exists for tests (a clock). */
export async function runProbes(cfg) {
  const probes = [];
  const startupDenials = [];
  const add = (id, group, expect, attempts, extra = {}) => probes.push({ id, group, expect, attempts, actual: summarize(expect, attempts), ...extra });
  const skip = (name, why) => ({ name, outcome: "skipped", code: why });

  // 1. control: write the agent's own directories
  add("control-write-own-directories", "case", "allowed", [
    attemptSync("workspace", () => writeFileSync(join(cfg.workspace, "c-work"), "w")),
    attemptSync("home", () => writeFileSync(join(cfg.home, "c-home"), "h")),
    attemptSync("scratch", () => writeFileSync(join(cfg.scratch, "c-scratch"), "s")),
  ]);
  // 2. control: read the agent's own decoy
  add("control-read-own-decoy", "case", "allowed", [attemptSync("decoy", () => readsSecret(cfg.decoy.path, cfg.decoy.content))]);
  // 3. system directories (every file that did get created is removed again)
  add("deny-write-system", "case", "denied", cfg.systemPaths.map((p, i) => {
    const a = attemptSync(`system${i}`, () => writeFileSync(p, "x"));
    if (a.outcome === "allowed") { try { rmSync(p, { force: true }); } catch { /* the harness checks and removes too */ } }
    return a;
  }));
  // 4. host paths outside the workspace
  add("deny-write-host-path", "case", "denied", [
    attemptSync("outside-file", () => writeFileSync(cfg.hostWrite.file, "overwritten")),
    ...cfg.hostWrite.dirs.map((d, i) => attemptSync(`outside-dir${i}`, () => writeFileSync(join(d, "nn-created"), "x"))),
  ]);
  // 5. read through links in the workspace (planted by the harness; a link it could not plant is skipped, never a pass)
  add("deny-symlink-read", "case", "denied", cfg.links.read.map((l) => (l.planted
    ? attemptSync(l.name, () => (l.kind === "file" ? readsSecret(l.path, cfg.controller.secret) : `entries:${readdirSync(l.path).length}`))
    : skip(l.name, "link not planted"))));
  // 6. write through links
  add("deny-symlink-write", "case", "denied", cfg.links.write.map((l) => (l.planted
    ? attemptSync(l.name, () => writeFileSync(l.kind === "file" ? l.path : join(l.path, "nn-via-link"), "x"))
    : skip(l.name, "link not planted"))));
  // 7. credentials
  add("deny-credential-read", "case", "denied", [
    attemptSync("file", () => readsSecret(cfg.credential.file, cfg.credential.secret)),
    attemptSync("list", () => `entries:${readdirSync(cfg.credential.dir).length}`),
  ]);
  // 8. the controller's own data
  add("deny-controller-data-read", "case", "denied", [
    attemptSync("file", () => readsSecret(cfg.controller.file, cfg.controller.secret)),
    attemptSync("list", () => `entries:${readdirSync(cfg.controller.dir).length}`),
  ]);
  // 9. loopback network
  add("deny-network-loopback", "case", "denied", [await connectOnce("loopback", cfg.network.loopback.host, cfg.network.loopback.port, cfg.network.timeoutMs ?? 3000)]);
  // 10. protected names under the workspace
  add("deny-write-protected-name", "case", "denied", [
    attemptSync("edit", () => writeFileSync(cfg.protectedName.config, "changed")),
    attemptSync("create", () => writeFileSync(join(cfg.protectedName.dir, "nn-hook"), "x")),
    attemptSync("delete", () => rmSync(cfg.protectedName.config)),
  ]);

  // Extra probes
  add("extra-outbound-connect", "extra", "denied", [await connectOnce("outbound", cfg.network.outbound.host, cfg.network.outbound.port, cfg.network.timeoutMs ?? 3000)]);
  add("extra-read-owner-profile", "extra", "denied", [attemptSync("list", () => `entries:${readdirSync(cfg.ownerProfile).length}`)]);
  add("extra-write-system-folder", "extra", "denied", [(() => {
    const p = join(cfg.systemFolder, "nn-appc-extra");
    const a = attemptSync("write", () => writeFileSync(p, "x"));
    if (a.outcome === "allowed") { try { rmSync(p, { force: true }); } catch { /* checked by the harness */ } }
    return a;
  })()]);

  // Tools (all expected to work with the minimal grants)
  const toolEnv = process.env;
  const t = cfg.tools;
  add("tool-node-version", "tool", "allowed", [runTool("node", process.execPath, ["--version"], { env: toolEnv }, startupDenials)]);
  add("tool-git-version", "tool", "allowed", [runTool("git", t.git, ["--version"], { env: toolEnv }, startupDenials)]);
  const gw = t.gitWork;
  mkdirSync(gw, { recursive: true });
  const git = (label, args) => runTool(`git ${label}`, t.git, ["-c", "user.name=NN Experiment", "-c", "user.email=nn@example.invalid", "-c", "core.autocrlf=false", ...args], { cwd: gw, env: toolEnv }, startupDenials);
  const gitSteps = [git("init", ["init", "-q"])];
  if (gitSteps[0].outcome === "allowed") {
    writeFileSync(join(gw, "a.txt"), "hello\n");
    gitSteps.push(git("add", ["add", "a.txt"]), git("commit", ["commit", "-q", "-m", "experiment"]));
  }
  add("tool-git-init-commit", "tool", "allowed", gitSteps);
  const npmArgs = (args) => [t.npmCli, ...args];
  add("tool-npm-version", "tool", "allowed", [t.npmCli ? runTool("npm", process.execPath, npmArgs(["--version"]), { env: toolEnv }, startupDenials) : skip("npm", "npm-cli.js not found")]);
  add("tool-npm-ci-offline", "tool", "allowed", t.npmCli
    ? [runTool("npm ci", process.execPath, npmArgs(["ci", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"]), { cwd: t.npmProject, env: toolEnv, timeoutMs: 180_000 }, startupDenials),
      attemptSync("installed-file", () => { if (!existsSync(join(t.npmProject, "node_modules", "nn-tiny", "index.js"))) throw Object.assign(new Error("missing"), { code: "ENOENT" }); })]
    : [skip("npm ci", "npm-cli.js not found")]);
  // Tool startup denials are evidence, not a verdict.

  return {
    schema: PROBE_SCHEMA,
    node: process.version,
    platform: process.platform,
    pid: process.pid,
    probes,
    startupDenials: startupDenials.slice(0, 40),
  };
}

/** Whether this file is the entry point. Compared as paths, and without case on Windows (a drive letter or an 8.3 name in another case must not silence the probe). */
export function isEntryPoint(argv1, moduleUrl, platform = process.platform) {
  if (argv1 === undefined) return false;
  const a = resolve(argv1);
  const b = fileURLToPath(moduleUrl);
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}
const isMain = isEntryPoint(process.argv[1], import.meta.url);
if (isMain) {
  try {
    const cfg = JSON.parse(readFileSync(process.argv[2], "utf8"));
    const report = await runProbes(cfg);
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify(report)}\n`);
  } catch (error) {
    process.stdout.write(`${REPORT_PREFIX}${JSON.stringify({ schema: PROBE_SCHEMA, fatal: String(error?.code ?? error?.name ?? "error"), probes: [], startupDenials: [] })}\n`);
    process.exitCode = 2;
  }
}
