import { closeSync, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, symlinkSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { SandboxRecipe } from "./recipe.js";

/*
 * Card A03b, slice 2: the ten containment cases (card G05) for the native Windows backend.
 *
 * The container refuses `cmd.exe` starting other programs (measured: 4 of 4, "Access is denied"), so the cmd batch files of the older Windows dialect cannot run there. A node program runs fine inside the
 * container, so each case is a few attempts made by ONE plain-JavaScript runner (`WINDOWS_CASE_RUNNER`, run by the container's node with the preserve-symlink flags that every native run gets; standard
 * handles are files, no pipes, no child programs). The runner writes one JSON line per case into a file in its own scratch folder; the host reads that file after the run. Everything that decides a verdict is
 * on the host and in this file: the runner only reports what each attempt did.
 *
 * The rules (the same as the older dialects, written down once):
 *   - a control passes only if every attempt was allowed (and the host sees the files it should);
 *   - a denial passes only if (1) no attempt got through, (2) the host's own witness shows nothing changed (a file that must not change, a server that must not be reached), (3) every attempt that was made
 *     was refused for an access reason (or, for the network, failed to connect), and (4) the very same attempts are shown to work WITHOUT the sandbox (the pairing), so a probe that fails for an unrelated
 *     reason is inconclusive, never a pass. The system folders are not paired (an unprivileged process cannot write there without a sandbox either; the host is not asked to).
 *   - a case that did not finish, a link the host could not plant, a runner that never ran, or a result file that cannot be read is inconclusive, never a pass.
 * The result file is written by the confined program, so it is not trusted for what the host can see for itself: the witnesses are read on the host.
 */

export type Outcome = "allowed" | "denied" | "missing" | "blocked" | "error" | "skipped";
const OUTCOMES: readonly Outcome[] = ["allowed", "denied", "missing", "blocked", "error", "skipped"];

export interface RunnerAttempt {
  readonly name: string;
  readonly outcome: Outcome;
  readonly code?: string;
  /** Written by the runner for a step that only runs when an earlier one got through; informational only: the host ignores it and applies `CaseKind.skippable`. */
  readonly skippable?: boolean;
}
export interface RunnerCaseResult { readonly id: string; readonly attempts: readonly RunnerAttempt[] }

export interface LinkSpec { readonly name: string; readonly kind: "file" | "dir"; readonly path: string; readonly planted: boolean; readonly secret?: string; readonly entry?: string }

/** Everything the runner needs, as JSON. Paths are host paths (the native container sees the same paths). */
export interface WindowsCaseConfig {
  readonly resultFile: string;
  readonly workspace: string;
  readonly home: string;
  readonly scratch: string;
  readonly decoy: { readonly path: string; readonly content: string };
  readonly systemPaths: readonly string[];
  readonly hostWrite: { readonly file: string; readonly dirs: readonly string[]; readonly created: string };
  readonly links: { readonly read: readonly LinkSpec[]; readonly write: readonly LinkSpec[] };
  readonly credential: { readonly file: string; readonly secret: string; readonly dir: string; readonly entry: string };
  readonly controller: { readonly file: string; readonly secret: string; readonly dir: string; readonly entry: string };
  readonly network: { readonly host: string; readonly port: number; readonly timeoutMs: number };
  readonly protectedName: { readonly dir: string; readonly config: string; readonly hook: string; readonly scratchTarget: string };
}

export const RUNNER_FILE = "case-runner.mjs";
export const CONFIG_FILE = "case-config.json";
export const RESULT_NAME = "g05-results.jsonl";
export const END_MARKER = "g05-end";

/**
 * The program the container runs: plain JavaScript, node modules only, no child program and no pipe. `node case-runner.mjs case-config.json`. Each case is announced by its result line when it ends (a later
 * hang loses nothing already written); the last thing it prints is the end marker. Reads count as "allowed" only when the secret (or the listed name) was really seen, so a read of the wrong file is an
 * `error`, never a silent pass of the probe.
 */
export const WINDOWS_CASE_RUNNER = String.raw`import fs from "node:fs";
import net from "node:net";
import path from "node:path";
const cfg = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const BLOCKED = ["ECONNREFUSED", "ETIMEDOUT", "TIMEOUT", "ENETUNREACH", "EHOSTUNREACH", "ECONNRESET", "EADDRNOTAVAIL", "EAI_AGAIN", "ENOTFOUND"];
const outcomeOf = (e) => {
  const c = e && e.code;
  if (c === "EACCES" || c === "EPERM") return "denied";
  if (c === "ENOENT" || c === "ENOTDIR") return "missing";
  if (BLOCKED.includes(c)) return "blocked";
  return "error";
};
const codeOf = (e) => String((e && (e.code || e.name)) || "ERR").slice(0, 24);
const attempt = (name, fn, extra) => {
  try { fn(); return Object.assign({ name: name, outcome: "allowed" }, extra); }
  catch (e) { return Object.assign({ name: name, outcome: outcomeOf(e), code: codeOf(e) }, extra); }
};
const skipped = (name, why, extra) => Object.assign({ name: name, outcome: "skipped", code: why }, extra);
const emit = (id, attempts) => fs.appendFileSync(cfg.resultFile, JSON.stringify({ id: id, attempts: attempts }) + "\n");
const write = (p, text) => () => fs.writeFileSync(p, text);
const seesSecret = (file, secret) => () => {
  if (!fs.readFileSync(file, "utf8").includes(secret)) { const e = new Error("secret not seen"); e.code = "NOSECRET"; throw e; }
};
const seesEntry = (dir, entry) => () => {
  if (!fs.readdirSync(dir).includes(entry)) { const e = new Error("entry not seen"); e.code = "NOENTRY"; throw e; }
};
const connectOnce = (host, port, ms) => new Promise((resolve) => {
  let done = false;
  let socket;
  const finish = (o) => { if (done) return; done = true; clearTimeout(timer); try { if (socket) socket.destroy(); } catch (e) { /* ended */ } resolve(o); };
  const timer = setTimeout(() => finish({ name: "loopback", outcome: "blocked", code: "TIMEOUT" }), ms);
  try {
    socket = net.connect({ host: host, port: port });
    socket.once("connect", () => finish({ name: "loopback", outcome: "allowed" }));
    socket.once("error", (e) => finish({ name: "loopback", outcome: outcomeOf(e), code: codeOf(e) }));
  } catch (e) { finish({ name: "loopback", outcome: outcomeOf(e), code: codeOf(e) }); }
});
const reads = (links) => links.map((l) => (l.planted ? attempt(l.name, l.kind === "file" ? seesSecret(l.path, l.secret) : seesEntry(l.path, l.entry)) : skipped(l.name, "not-planted")));
const writes = (links) => links.map((l) => (l.planted ? attempt(l.name, write(l.kind === "file" ? l.path : path.join(l.path, "g05-via-link"), "overwritten")) : skipped(l.name, "not-planted")));

emit("control-write-own-directories", [
  attempt("workspace", write(path.join(cfg.workspace, "c-work"), "w")),
  attempt("home", write(path.join(cfg.home, "c-home"), "h")),
  attempt("scratch", write(path.join(cfg.scratch, "c-scratch"), "s")),
]);
emit("control-read-own-decoy", [attempt("decoy", seesSecret(cfg.decoy.path, cfg.decoy.content))]);
emit("deny-write-system", cfg.systemPaths.map((p, i) => {
  const a = attempt("system" + i, write(p, "x"));
  if (a.outcome === "allowed") { try { fs.rmSync(p, { force: true }); } catch (e) { /* the host checks and removes too */ } }
  return a;
}));
emit("deny-write-host-path", [
  attempt("outside-file", write(cfg.hostWrite.file, "overwritten")),
  ...cfg.hostWrite.dirs.map((d, i) => attempt("outside-dir" + i, write(path.join(d, cfg.hostWrite.created), "x"))),
]);
emit("deny-symlink-read", reads(cfg.links.read));
emit("deny-symlink-write", writes(cfg.links.write));
emit("deny-credential-read", [
  attempt("file", seesSecret(cfg.credential.file, cfg.credential.secret)),
  attempt("list", seesEntry(cfg.credential.dir, cfg.credential.entry)),
]);
emit("deny-controller-data-read", [
  attempt("file", seesSecret(cfg.controller.file, cfg.controller.secret)),
  attempt("list", seesEntry(cfg.controller.dir, cfg.controller.entry)),
]);
emit("deny-network-loopback", [await connectOnce(cfg.network.host, cfg.network.port, cfg.network.timeoutMs)]);
{
  const p = cfg.protectedName;
  const back = (from, to) => { try { fs.renameSync(from, to); } catch (e) { /* the host's witness reports a name that is gone */ } };
  const attempts = [
    attempt("edit", write(p.config, "changed")),
    attempt("create", write(p.hook, "x")),
    attempt("rename-file", () => { fs.renameSync(p.config, p.config + "-renamed"); back(p.config + "-renamed", p.config); }),
    attempt("delete", () => fs.rmSync(p.config)),
    attempt("rename-folder", () => { fs.renameSync(p.dir, p.dir + "-renamed"); back(p.dir + "-renamed", p.dir); }),
  ];
  const away = attempt("replace-move-away", () => fs.renameSync(p.dir, p.dir + "-away"));
  attempts.push(away);
  if (away.outcome === "allowed") {
    attempts.push(attempt("replace-with-junction", () => fs.symlinkSync(p.scratchTarget, p.dir, "junction"), { skippable: true }));
    try { fs.rmSync(p.dir, { recursive: true, force: true }); } catch (e) { /* undone below */ }
    back(p.dir + "-away", p.dir);
  } else attempts.push(skipped("replace-with-junction", "previous-step-refused", { skippable: true }));
  attempts.push(attempt("delete-folder", () => fs.rmSync(p.dir, { recursive: true })));
  emit("deny-write-protected-name", attempts);
}
process.stdout.write("g05-end\n");
`;

// ---------------------------------------------------------------------------------------------------------------- reading the runner's result file

export const MAX_RESULT_BYTES = 256 * 1024;
const printable = (s: string, max: number): string => s.slice(0, max).replace(/[^A-Za-z0-9_.:-]/g, "?");

/**
 * The result file as data: bounded, every field checked; a damaged line (the process ended mid-write) is skipped. A case reported on more than one line keeps the attempts of EVERY line (a later line
 * cannot hide an attempt that got through on an earlier one). The program's own `skippable` flag is dropped: which step may be skipped is the host's rule (`CaseKind.skippable`).
 */
export function parseRunnerResults(text: string, known: readonly string[]): Map<string, RunnerCaseResult> {
  const ids = new Set(known);
  const out = new Map<string, RunnerCaseResult>();
  if (Buffer.byteLength(text, "utf8") > MAX_RESULT_BYTES) return out;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    let v: unknown;
    try { v = JSON.parse(line); } catch { continue; }
    if (typeof v !== "object" || v === null) continue;
    const o = v as { id?: unknown; attempts?: unknown };
    if (typeof o.id !== "string" || !ids.has(o.id) || !Array.isArray(o.attempts) || o.attempts.length > 32) continue;
    const attempts: RunnerAttempt[] = [];
    let ok = true;
    for (const a of o.attempts as unknown[]) {
      if (typeof a !== "object" || a === null) { ok = false; break; }
      const r = a as { name?: unknown; outcome?: unknown; code?: unknown; skippable?: unknown };
      if (typeof r.name !== "string" || !OUTCOMES.includes(r.outcome as Outcome)) { ok = false; break; }
      attempts.push({ name: printable(r.name, 60), outcome: r.outcome as Outcome, ...(typeof r.code === "string" ? { code: printable(r.code, 24) } : {}) });
    }
    if (!ok) continue;
    const earlier = out.get(o.id);
    out.set(o.id, { id: o.id, attempts: earlier === undefined ? attempts : [...earlier.attempts, ...attempts] });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------- the host's witnesses

/** What the host can look at itself. A test hands in a fake. */
export interface HostProbe {
  exists(path: string): boolean;
  /** The file's text, or undefined when it is not there. */
  readText(path: string): string | undefined;
  /** A real folder (not a link or junction). */
  isRealFolder(path: string): boolean;
  /** How many connections the host's listener has accepted. */
  connections(): number;
}

export interface Originals { readonly outside: string; readonly git: string }

/** The files an attempt of the host-path case would create. */
const hostTargets = (cfg: WindowsCaseConfig): string[] => cfg.hostWrite.dirs.map((d) => join(d, cfg.hostWrite.created));
const viaLink = (cfg: WindowsCaseConfig): string[] => cfg.links.write.filter((l) => l.kind === "dir").map((l) => join(l.path, "g05-via-link"));

/** After the CONFINED run: what the host sees that must not have happened (a reason), or undefined. `before` is the listener's count before the run. */
export function confinedWitness(id: string, cfg: WindowsCaseConfig, originals: Originals, probe: HostProbe, before: number): string | undefined {
  const outsideSame = probe.readText(cfg.hostWrite.file) === originals.outside;
  switch (id) {
    case "control-write-own-directories":
      return probe.exists(join(cfg.workspace, "c-work")) && probe.exists(join(cfg.home, "c-home")) && probe.exists(join(cfg.scratch, "c-scratch")) ? undefined : "the agent could not write its own directories";
    case "deny-write-system":
      return cfg.systemPaths.some((p) => probe.exists(p)) ? "a file was created in a system directory of the host" : undefined;
    case "deny-write-host-path":
      if (!outsideSame) return "a host file outside the workspace was changed";
      return hostTargets(cfg).some((t) => probe.exists(t)) ? "a file was created in a host directory outside the workspace" : undefined;
    case "deny-symlink-write":
      return !outsideSame || viaLink(cfg).some((t) => probe.exists(t)) ? "a write through a link changed a host path outside the workspace" : undefined;
    case "deny-network-loopback":
      return probe.connections() === before ? undefined : "the host service received a connection from the confined program";
    case "deny-write-protected-name": {
      const p = cfg.protectedName;
      if (probe.readText(p.config) !== originals.git || probe.exists(p.hook)) return "a protected name under the checkout was changed";
      if (!probe.isRealFolder(p.dir) || probe.exists(`${p.dir}-renamed`) || probe.exists(`${p.dir}-away`)) return "the protected folder itself was renamed, deleted or replaced";
      return undefined;
    }
    default:
      return undefined;
  }
}

/** After the UNCONFINED run: what the host should show if the attempts really got through (a missing effect, as a reason), or undefined. Cases that read, and the controls, are shown by the attempts alone. */
export function freeProof(id: string, cfg: WindowsCaseConfig, originals: Originals, probe: HostProbe, before: number): string | undefined {
  const outsideChanged = probe.readText(cfg.hostWrite.file) !== originals.outside;
  switch (id) {
    case "deny-write-host-path":
      return !outsideChanged ? "the outside file was not changed" : hostTargets(cfg).find((t) => !probe.exists(t));
    case "deny-symlink-write":
      // The directory link first: when the host could not plant the file link, the file link's missing effect is expected, the directory link's never is.
      return viaLink(cfg).some((t) => !probe.exists(t)) ? "the write through the directory link" : !outsideChanged ? FILE_LINK_WRITE_UNPROVEN : undefined;
    case "deny-write-protected-name":
      // the last step of the case deletes the whole folder (and with it the hook), so the effect the host shows is a folder that is gone
      return probe.exists(cfg.protectedName.dir) ? "the protected folder was not deleted" : undefined;
    case "deny-network-loopback":
      return probe.connections() > before ? undefined : "the host service saw no connection";
    default:
      return undefined;
  }
}

// ---------------------------------------------------------------------------------------------------------------- the verdicts

export type CaseVerdict = "pass" | "fail" | "inconclusive";
export interface CaseKind {
  readonly id: string; readonly control: boolean; readonly paired: boolean; readonly network?: boolean;
  /** The host's rule for steps that run only when an earlier one got through: step name -> the step it depends on. Such a step may be `skipped` only when that earlier step was not allowed. */
  readonly skippable?: Readonly<Record<string, string>>;
}
export const WINDOWS_CASES: readonly CaseKind[] = [
  { id: "control-write-own-directories", control: true, paired: false },
  { id: "control-read-own-decoy", control: true, paired: false },
  { id: "deny-write-system", control: false, paired: false },
  { id: "deny-write-host-path", control: false, paired: true },
  { id: "deny-symlink-read", control: false, paired: true },
  { id: "deny-symlink-write", control: false, paired: true },
  { id: "deny-credential-read", control: false, paired: true },
  { id: "deny-controller-data-read", control: false, paired: true },
  { id: "deny-network-loopback", control: false, paired: true, network: true },
  { id: "deny-write-protected-name", control: false, paired: true, skippable: { "replace-with-junction": "replace-move-away" } },
];

export interface FreeRun {
  /** The unconfined run's result for the case: undefined when the case did not finish there. `"unavailable"`: there was no unconfined run at all. */
  readonly result: RunnerCaseResult | undefined | "unavailable";
  /** What the host should have shown after it (freeProof), or undefined. */
  readonly proofMissing: string | undefined;
}

/** The attempts that count: a `skipped` step is left out only when the host's rule for the case allows it (its earlier step was made and was not allowed). */
const required = (kind: CaseKind, a: readonly RunnerAttempt[]): RunnerAttempt[] => a.filter((x) => {
  const after = kind.skippable?.[x.name];
  if (after === undefined || x.outcome !== "skipped") return true;
  const prior = a.filter((y) => y.name === after);
  return !(prior.length > 0 && prior.every((y) => y.outcome !== "allowed" && y.outcome !== "skipped"));
});

/**
 * The FILE symbolic links each link case plants (`plant` below), the only links an account without SeCreateSymbolicLinkPrivilege cannot make. Directory junctions need no right and are not here.
 * The release gate (containment.ts) accepts a case inconclusive for one of these only, by this table.
 */
export const FILE_LINKS_BY_CASE: Readonly<Record<string, readonly string[]>> = Object.freeze({ "deny-symlink-read": Object.freeze(["link-abs-file", "link-rel-key"]), "deny-symlink-write": Object.freeze(["link-write"]) });
/** freeProof's reason when the write through the file link left no change (expected when that link was not planted). */
export const FILE_LINK_WRITE_UNPROVEN = "the write through the file link";
const isUnplantedFileLink = (caseId: string, a: RunnerAttempt): boolean => a.outcome === "skipped" && a.code === "not-planted" && (FILE_LINKS_BY_CASE[caseId]?.includes(a.name) ?? false);

/** judgeWindowsCase when only unplanted file links did not get through unconfined: the rest of the case is judged; `detail` (the not-planted wording) only when all of it held. */
function judgeAroundUnplanted(kind: CaseKind, confined: RunnerCaseResult | undefined, free: FreeRun, witness: string | undefined, confinedNote: string, unplanted: ReadonlySet<string>, detail: string): { verdict: CaseVerdict; detail: string } {
  if (witness !== undefined) return { verdict: "fail", detail: witness };
  const leaked = confined?.attempts.find((a) => a.outcome === "allowed");
  if (leaked !== undefined) return { verdict: "fail", detail: `an attempt got through in the sandbox (${leaked.name})` };
  if (free.proofMissing !== undefined && free.proofMissing !== FILE_LINK_WRITE_UNPROVEN) return { verdict: "inconclusive", detail: `without the sandbox the same attempt did not get through (${free.proofMissing}), so a refusal would prove nothing` };
  if (confined === undefined) return { verdict: "inconclusive", detail: confinedNote };
  const freeAttempts = typeof free.result === "object" ? free.result.attempts : [];
  const names = (a: readonly RunnerAttempt[]): string => [...new Set(a.map((x) => x.name))].sort().join(",");
  if (names(confined.attempts) !== names(freeAttempts)) return { verdict: "inconclusive", detail: "the confined run did not make the same attempts as the unconfined run, so the pairing does not cover it" };
  const judged = required(kind, confined.attempts).filter((a) => !unplanted.has(a.name));
  if (judged.length === 0) return { verdict: "inconclusive", detail: "the case made no attempt besides the links that were not planted" };
  const other = judged.find((a) => a.outcome !== "denied");
  if (other !== undefined) return { verdict: "inconclusive", detail: `the attempt could not be made (${other.name}: ${other.outcome}${other.code === undefined ? "" : ` ${other.code}`}), so it shows no refusal` };
  return { verdict: "inconclusive", detail };
}

/**
 * The verdict of one case from the confined and unconfined results and the host's witness. Pure. `inconclusive` is returned for everything that cannot be read as the boundary holding or not holding.
 */
export function judgeWindowsCase(kind: CaseKind, confined: RunnerCaseResult | undefined, free: FreeRun, witness: string | undefined, confinedNote = "the attempt did not finish"): { verdict: CaseVerdict; detail: string } {
  const inconclusive = (detail: string) => ({ verdict: "inconclusive" as const, detail });
  const fail = (detail: string) => ({ verdict: "fail" as const, detail });
  if (kind.control) {
    if (confined === undefined) return inconclusive(confinedNote);
    const bad = confined.attempts.find((a) => a.outcome !== "allowed");
    if (bad !== undefined) return fail(`the agent could not do what it is allowed to (${bad.name}: ${bad.outcome}${bad.code === undefined ? "" : ` ${bad.code}`})`);
    if (confined.attempts.length === 0) return inconclusive("the case made no attempt");
    return witness === undefined ? { verdict: "pass", detail: "held" } : fail(witness);
  }
  let paired = "";
  if (kind.paired && typeof free.result === "object") {
    // The unconfined run ran and shows the probe itself does not work: nothing the confined run shows can be read (the host's witness points at the same broken probe), inconclusive.
    // A FILE link the host could not plant (an account without the symbolic-link right) is named only when nothing else failed unconfined, so its wording never stands for another problem.
    const notThroughAll = required(kind, free.result.attempts).filter((a) => a.outcome !== "allowed");
    const notThrough = notThroughAll.find((a) => !isUnplantedFileLink(kind.id, a)) ?? notThroughAll[0];
    if (free.result.attempts.length === 0) return inconclusive("without the sandbox the case made no attempt, so a refusal would prove nothing");
    if (notThrough !== undefined) {
      const detail = `without the sandbox the same attempt did not get through (${notThrough.name}: ${notThrough.outcome}${notThrough.code === undefined ? "" : ` ${notThrough.code}`}), so a refusal would prove nothing`;
      if (!isUnplantedFileLink(kind.id, notThrough)) return inconclusive(detail);
      // Every attempt that did not get through unconfined is a file link that was not planted (card A03b: the release gate may accept this case as inconclusive). The case's other attempts
      // (its directory junctions, which need no right) were planted and are judged in full: a leak fails, and each must be shown refused, else the wording above is not used.
      return judgeAroundUnplanted(kind, confined, free, witness, confinedNote, new Set(notThroughAll.map((a) => a.name)), detail);
    }
    if (free.proofMissing !== undefined) return inconclusive(`without the sandbox the same attempt did not get through (${free.proofMissing}), so a refusal would prove nothing`);
    paired = "; the same attempt got through without the sandbox";
  }
  // A leak fails next, even when the unconfined run is missing or did not finish, and even when the runner left the case out: the host saw a change, or an attempt got through in the sandbox.
  if (witness !== undefined) return fail(witness);
  const leaked = confined?.attempts.find((a) => a.outcome === "allowed");
  if (leaked !== undefined) return fail(`an attempt got through in the sandbox (${leaked.name})`);
  if (kind.paired) {
    if (free.result === "unavailable") return inconclusive("the attempt could not be run without the sandbox to show that it works");
    if (free.result === undefined) return inconclusive("the attempt did not run to its end without the sandbox");
  }
  if (confined === undefined) return inconclusive(confinedNote);
  if (kind.paired && typeof free.result === "object") {
    // The pairing is per attempt: the confined run must have made exactly the attempts that were shown to work unconfined (a skipped skippable step keeps its name), else a refusal of one attempt
    // could stand for another that was never made. (A leak above fails whatever the attempts were.)
    const names = (a: readonly RunnerAttempt[]): string => [...new Set(a.map((x) => x.name))].sort().join(",");
    if (names(confined.attempts) !== names(free.result.attempts)) return inconclusive("the confined run did not make the same attempts as the unconfined run, so the pairing does not cover it");
  }
  const attempts = required(kind, confined.attempts);
  if (attempts.length === 0) return inconclusive("the case made no attempt");
  const refusedFor = (a: RunnerAttempt): boolean => a.outcome === "denied" || (kind.network === true && a.outcome === "blocked");
  const other = attempts.find((a) => !refusedFor(a));
  if (other !== undefined) return inconclusive(`the attempt could not be made (${other.name}: ${other.outcome}${other.code === undefined ? "" : ` ${other.code}`}), so it shows no refusal`);
  return { verdict: "pass", detail: `held${paired}` };
}

// ---------------------------------------------------------------------------------------------------------------- the run

export interface NodeSuiteFixture {
  readonly root: string;
  readonly controllerDir: string;
  readonly controllerFile: string;
  readonly home: string;
  readonly credentialFile: string;
  readonly outsideDir: string;
  readonly outsideFile: string;
  readonly port: number;
  connections(): number;
  reset(): void;
}
export interface NodeSuiteSecrets { readonly controller: string; readonly key: string; readonly outside: string; readonly git: string; readonly decoy: string }
export interface LaunchOutcome { readonly timedOut: boolean; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }

export interface NodeSuiteContext {
  readonly fixture: NodeSuiteFixture;
  readonly secrets: NodeSuiteSecrets;
  /** The program that runs the runner when confined, as the sandbox sees it, and the folder that holds it (read-only input). */
  readonly nodeGuestPath: string;
  readonly nodeHostFolder: string;
  readonly hostNode: string;
  /** Where a system-folder write is tried (host paths). */
  readonly systemPaths: readonly string[];
  /** Runs one launch: `sandboxed` through the backend under test, `trusted-host` without it (undefined: there is no way to run without the sandbox). */
  readonly launch: (mode: "sandboxed" | "trusted-host", recipe: SandboxRecipe, command: string[]) => Promise<LaunchOutcome>;
  readonly canRunFree: boolean;
  readonly probe?: HostProbe;
  readonly windows: boolean;
  readonly settle: () => Promise<void>;
}

const realProbe = (connections: () => number): HostProbe => ({
  exists: (p) => existsSync(p),
  readText: (p) => { try { return readFileSync(p, "utf8"); } catch { return undefined; } },
  isRealFolder: (p) => { try { const s = lstatSync(p); return s.isDirectory() && !s.isSymbolicLink(); } catch { return false; } },
  connections,
});

interface Planted { readonly recipe: SandboxRecipe; readonly cfg: WindowsCaseConfig; readonly command: string[] }

/** Plants one agent directory set and everything a run of the runner needs, and returns the recipe, config and command. */
function plant(ctx: NodeSuiteContext, n: number, free: boolean): Planted {
  const f = ctx.fixture;
  const base = mkdtempSync(join(f.root, `agent${n}-`));
  const d = (name: string): string => { const p = join(base, name); mkdirSync(p, { recursive: true }); return p; };
  const work = d("work");
  const home = d("home");
  const scratch = d("scratch");
  const tools = d("g05-case");
  writeFileSync(join(tools, RUNNER_FILE), WINDOWS_CASE_RUNNER);
  writeFileSync(join(work, "decoy.txt"), ctx.secrets.decoy);
  const gitDir = join(work, ".git");
  mkdirSync(gitDir);
  writeFileSync(join(gitDir, "config"), ctx.secrets.git);
  const dirType = ctx.windows ? "junction" : "dir";
  const link = (name: string, kind: "file" | "dir", target: string, secret?: string, entry?: string, relativeTarget = false): LinkSpec => {
    const path = join(work, name);
    let planted = true;
    // A host without the right to create the link makes the case inconclusive (the link is not planted), never a pass.
    try { symlinkSync(relativeTarget ? relative(work, target) : target, path, kind === "dir" ? dirType : "file"); } catch { planted = false; }
    return { name, kind, path, planted, ...(secret === undefined ? {} : { secret }), ...(entry === undefined ? {} : { entry }) };
  };
  const readLinks = [
    link("link-abs-file", "file", f.controllerFile, ctx.secrets.controller),
    link("link-abs-dir", "dir", f.controllerDir, undefined, "controller.db"),
    link("link-rel-key", "file", f.credentialFile, ctx.secrets.key, undefined, true),
  ];
  const writeLinks = [link("link-write", "file", f.outsideFile), link("link-dir", "dir", f.outsideDir)];
  const sshDir = join(f.home, ".ssh");
  const cfg: WindowsCaseConfig = {
    resultFile: join(scratch, RESULT_NAME),
    workspace: work, home, scratch,
    decoy: { path: join(work, "decoy.txt"), content: ctx.secrets.decoy },
    systemPaths: free ? [] : ctx.systemPaths,
    hostWrite: { file: f.outsideFile, dirs: [f.outsideDir, f.controllerDir, sshDir], created: "g05-created" },
    links: { read: readLinks, write: writeLinks },
    credential: { file: f.credentialFile, secret: ctx.secrets.key, dir: sshDir, entry: "id_g05_fixture" },
    controller: { file: f.controllerFile, secret: ctx.secrets.controller, dir: f.controllerDir, entry: "controller.db" },
    network: { host: "127.0.0.1", port: f.port, timeoutMs: 3000 },
    protectedName: { dir: gitDir, config: join(gitDir, "config"), hook: join(gitDir, "g05-hook"), scratchTarget: scratch },
  };
  const cfgFile = join(tools, CONFIG_FILE);
  writeFileSync(cfgFile, JSON.stringify(cfg));
  const recipe: SandboxRecipe = {
    mode: free ? "trusted-host" : "sandboxed", workdir: work, home, scratch, network: "none", env: {}, protectedSubpaths: [".git"],
    readOnly: free ? [] : [{ host: tools, guest: "/inputs/g05" }, { host: ctx.nodeHostFolder, guest: "/opt/node" }],
  };
  const command = free ? [ctx.hostNode, join(tools, RUNNER_FILE), cfgFile] : [ctx.nodeGuestPath, join(tools, RUNNER_FILE), cfgFile];
  return { recipe, cfg, command };
}

const clip = (s: string): string => (s.length > 200 ? `${s.slice(0, 200)}...` : s).replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/g, "?");

/**
 * The result file lies in a folder the confined program can change, so the host reads it only when it is a plain file with one name and within the bound (a link, a junction target, a hard link to
 * another file or a device is never followed), and reads at most the bound. Anything else is no result (every case inconclusive).
 */
export function readResultFile(file: string): string | undefined {
  let fd: number | undefined;
  try {
    const s = lstatSync(file);
    if (!s.isFile() || s.isSymbolicLink() || s.nlink > 1 || s.size > MAX_RESULT_BYTES) return undefined;
    fd = openSync(file, "r");
    // the name must still be the file that was looked at (not swapped for a link or another file between the look and the open)
    const o = fstatSync(fd);
    if (!o.isFile() || o.ino !== s.ino || o.dev !== s.dev || o.nlink > 1) return undefined;
    const buf = Buffer.alloc(MAX_RESULT_BYTES + 1);
    let got = 0;
    for (;;) { const n = readSync(fd, buf, got, buf.length - got, null); if (n <= 0) break; got += n; if (got > MAX_RESULT_BYTES) return undefined; }
    return buf.subarray(0, got).toString("utf8");
  } catch { return undefined; } finally { if (fd !== undefined) try { closeSync(fd); } catch { /* closed */ } }
}

function readResults(cfg: WindowsCaseConfig): Map<string, RunnerCaseResult> {
  const text = readResultFile(cfg.resultFile);
  return text === undefined ? new Map() : parseRunnerResults(text, WINDOWS_CASES.map((c) => c.id));
}

/**
 * Runs the ten cases through the node runner: once without the sandbox (the pairing, fresh directories) and once confined, then judges each case. Never throws: a launch that fails makes the cases
 * that did not finish inconclusive with the reason.
 */
export async function runWindowsNodeCases(ctx: NodeSuiteContext): Promise<{ id: string; verdict: CaseVerdict; detail: string }[]> {
  const f = ctx.fixture;
  const probe = ctx.probe ?? realProbe(() => f.connections());
  const originals: Originals = { outside: ctx.secrets.outside, git: ctx.secrets.git };
  const ids = WINDOWS_CASES.map((c) => c.id);
  let freeResults: Map<string, RunnerCaseResult> | "unavailable" = "unavailable";
  const proofs = new Map<string, string | undefined>();
  let freeNote = "";
  if (ctx.canRunFree) {
    try {
      f.reset();
      const free = plant(ctx, 1, true);
      const before = f.connections();
      const out = await ctx.launch("trusted-host", free.recipe, free.command);
      await ctx.settle();
      freeResults = readResults(free.cfg);
      freeNote = out.timedOut ? "timed out" : out.exitCode === 0 ? "" : `exit ${String(out.exitCode)}`;
      for (const id of ids) proofs.set(id, freeProof(id, free.cfg, originals, probe, before));
    } catch (error) { freeNote = clip((error as Error).message); freeResults = new Map(); }
  }
  const results = new Map<string, RunnerCaseResult>();
  let note = "the attempt did not finish";
  let cfg: WindowsCaseConfig | undefined;
  let before = 0;
  try {
    f.reset();
    const run = plant(ctx, 2, false);
    cfg = run.cfg;
    before = f.connections();
    const out = await ctx.launch("sandboxed", run.recipe, run.command);
    await ctx.settle();
    for (const [k, v] of readResults(run.cfg)) results.set(k, v);
    note = out.timedOut ? "the run timed out before this case finished"
      : results.size === 0 ? `the runner produced no result (exit ${String(out.exitCode)}${out.stderr.trim() === "" ? "" : `: ${clip(out.stderr.trim())}`})`
      : "the case did not finish in the run";
  } catch (error) { note = `the attempt could not be launched: ${clip((error as Error).message)}`; }
  return WINDOWS_CASES.map((kind) => {
    const freeRun: FreeRun = freeResults === "unavailable" ? { result: "unavailable", proofMissing: undefined } : { result: freeResults.get(kind.id), proofMissing: proofs.get(kind.id) };
    // A denial's witness is read even when the runner left the case out (a change the host sees fails the case whatever the runner wrote); a control's only when the case reported.
    const witness = cfg === undefined || (kind.control && !results.has(kind.id)) ? undefined : confinedWitness(kind.id, cfg, originals, probe, before);
    const verdict = judgeWindowsCase(kind, results.get(kind.id), freeRun, witness, note);
    return { id: kind.id, ...verdict, detail: freeRun.result === undefined && freeNote !== "" && verdict.verdict === "inconclusive" ? `${verdict.detail} (${freeNote})` : verdict.detail };
  });
}
