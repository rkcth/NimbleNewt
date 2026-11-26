import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { safeText } from "@nimblenewt/contracts";
import type { SandboxLauncher } from "../sandbox/launcher.js";
import type { ResourceLimits } from "../sandbox/limits.js";
import type { SandboxRecipe } from "../sandbox/recipe.js";
import { removeTree } from "../sandbox/script.js";

/**
 * The agent's checkout tool on this host (card W09b). SECURITY-SENSITIVE: it lets an agent read and change its checkout and run commands in it. Every call runs in a sandbox of its own made from the attempt's recipe, as the done check
 * does (card W05): the checkout as /work, the read-only system folders and the attempt's read-only inputs, no network, the attempt's and the owner's limits, an empty home and scratch of its own (so nothing of the agent's conversation
 * store is in reach) and never the worker process or its credential. The sandbox is the boundary: the path checks below only make a path that leads out of the checkout a plain refusal instead of a read of the sandbox's system files.
 * The controller has already judged and recorded the call (the tool path) before the host is asked.
 */

export interface CheckoutCall { readonly action: "read" | "write" | "edit" | "run"; readonly path?: string; readonly text?: string; readonly old?: string; readonly command?: string }
export type CheckoutAnswer =
  | { readonly ok: true; readonly body: string; readonly facts: { readonly [key: string]: string | number | boolean | null } }
  | { readonly ok: false; readonly reason: string };

/**
 * The bounds of one call: its time (also cut by the owner's wall time), what each stream may write, what is handed back (the start and the end of a longer text), the processes a command may have at once, and the calls one attempt may make.
 * `diskReserveBytes` (first review): this host cannot cap what a sandbox writes in all (a file's size at most), and the checkout lies beside the controller's data, so a call is not started, and one running is stopped, when the
 * checkout's file system or the call's own has less than this free (looked at every `diskCheckMs`).
 */
export const CHECKOUT_TOOL_LIMITS = { timeoutMs: 600_000, streamBytes: 4 * 1024 * 1024, bodyChars: 16_000, headChars: 4_000, processes: 512, callsPerAttempt: 5_000, fileBytes: 4 * 1024 * 1024, diskReserveBytes: 2 * 1024 * 1024 * 1024, diskCheckMs: 1000 } as const;

/**
 * The program that reads, writes or edits one file inside the sandbox, given the request on standard input and answering one JSON line. Run by the sandbox's own Node.js (`node -e`); it is this fixed text, never the model's.
 * A path is relative to /work; one that resolves outside it, names `.git`, or reaches outside through a link is refused; a write or edit never follows a link at the file itself (O_NOFOLLOW).
 */
export const CHECKOUT_HELPER = `"use strict";
const fs = require("node:fs"), path = require("node:path");
const W = "/work", MAX = ${CHECKOUT_TOOL_LIMITS.fileBytes};
const no = (reason) => ({ ok: false, reason });
function inside(rel) {
  if (typeof rel !== "string" || rel === "" || rel.includes("\\0")) throw new Error("give path as a file of your checkout, relative to it");
  const abs = path.resolve(W, rel);
  if (abs !== W && !abs.startsWith(W + "/")) throw new Error(JSON.stringify(rel).slice(0, 200) + " is not inside your checkout");
  // Git's own name anywhere (a repository the host's git could look into, card W09b review), in any case.
  if (path.relative(W, abs).split("/").some((p) => p.toLowerCase() === ".git")) throw new Error(".git is not one of your checkout's files");
  return abs;
}
const realW = () => fs.realpathSync(W);
const isLink = (p) => { try { return fs.lstatSync(p).isSymbolicLink(); } catch { return false; } };
const lexists = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
function checkReal(abs, rel) {
  let r;
  // A link whose target this sandbox does not show at all leads outside the checkout too.
  try { r = fs.realpathSync(abs); } catch (e) { if (e.code === "ENOENT" && (isLink(abs) || isLink(path.dirname(abs)))) throw new Error(JSON.stringify(rel).slice(0, 200) + " leads outside your checkout through a link"); throw e; }
  const w = realW();
  if (r !== w && !r.startsWith(w + "/")) throw new Error(JSON.stringify(rel).slice(0, 200) + " leads outside your checkout through a link");
  return r;
}
function folderFor(abs, rel) {
  let d = path.dirname(abs);
  const missing = [];
  while (!lexists(d)) { missing.unshift(d); d = path.dirname(d); }
  checkReal(d, rel);
  for (const m of missing) fs.mkdirSync(m);
  checkReal(path.dirname(abs), rel);
}
// Opened without blocking, so a pipe or other special file is refused instead of waiting for a writer until the call's time is up.
const NB = fs.constants.O_NONBLOCK || 0;
// The text handed back is cut here already (its start and its end), so a long or escape-heavy file never overflows the stream the answer goes back on.
const HEADC = ${CHECKOUT_TOOL_LIMITS.headChars}, BODYC = ${CHECKOUT_TOOL_LIMITS.bodyChars};
const cut = (t) => (t.length <= BODYC ? { text: t, truncated: false } : { text: t.slice(0, HEADC) + "\\n[... " + (t.length - BODYC) + " characters left out ...]\\n" + t.slice(t.length - (BODYC - HEADC)), truncated: true });
function readNoLink(abs, rel) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | NB); } catch (e) { if (e.code === "ELOOP") throw new Error(JSON.stringify(rel).slice(0, 200) + " is a link; edit the file it points to"); throw e; }
  try { const st = fs.fstatSync(fd); if (!st.isFile()) throw new Error(JSON.stringify(rel).slice(0, 200) + " is not a file"); if (st.size > MAX) throw new Error(JSON.stringify(rel).slice(0, 200) + " is larger than " + MAX + " bytes"); const bytes = fs.readFileSync(fd); const text = bytes.toString("utf8"); return { text, utf8: Buffer.from(text, "utf8").equals(bytes) }; } finally { fs.closeSync(fd); }
}
function writeNoLink(abs, rel, text) {
  let fd;
  try { fd = fs.openSync(abs, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_TRUNC | fs.constants.O_NOFOLLOW | NB, 0o644); } catch (e) { if (e.code === "ELOOP") throw new Error(JSON.stringify(rel).slice(0, 200) + " is a link; write the file it points to"); throw e; }
  try { if (!fs.fstatSync(fd).isFile()) throw new Error(JSON.stringify(rel).slice(0, 200) + " is not a file"); fs.writeFileSync(fd, text, "utf8"); } finally { fs.closeSync(fd); }
}
const lines = (t) => (t === "" ? 0 : t.split("\\n").length - (t.endsWith("\\n") ? 1 : 0));
function act(q) {
  const rel = q.path, abs = inside(rel);
  if (q.action === "read") {
    if (!fs.existsSync(abs)) return no(JSON.stringify(rel).slice(0, 200) + " does not exist in your checkout");
    const real = checkReal(abs, rel);
    const st = fs.statSync(real);
    if (st.isDirectory()) { const names = fs.readdirSync(real, { withFileTypes: true }).filter((e) => e.name.toLowerCase() !== ".git").map((e) => e.name + (e.isDirectory() ? "/" : "")).sort(); const shown = cut(names.join("\\n")); return { ok: true, body: shown.text, facts: { path: rel, entries: names.length, ...(shown.truncated ? { truncated: true } : {}) } }; }
    const { text, utf8 } = readNoLink(real, rel);
    const shown = cut(text);
    return { ok: true, body: shown.text, facts: { path: rel, chars: text.length, lines: lines(text), ...(utf8 ? {} : { notText: true }), ...(shown.truncated ? { truncated: true } : {}) } };
  }
  if (abs === W && q.action !== "read") return no("give the path of a file in your checkout, such as src/index.js");
  if (q.action === "write") {
    if (typeof q.text !== "string") return no("write needs text");
    folderFor(abs, rel);
    const existed = fs.existsSync(abs);
    writeNoLink(abs, rel, q.text);
    return { ok: true, body: "", facts: { path: rel, chars: q.text.length, created: !existed } };
  }
  if (q.action === "edit") {
    if (typeof q.old !== "string" || q.old === "" || typeof q.text !== "string") return no("edit needs old (text that occurs once in the file) and text (what replaces it)");
    if (!fs.existsSync(abs)) return no(JSON.stringify(rel).slice(0, 200) + " does not exist in your checkout");
    checkReal(path.dirname(abs), rel);
    const read = readNoLink(abs, rel);
    if (!read.utf8) return no(JSON.stringify(rel).slice(0, 200) + " is not UTF-8 text; an edit would change its other bytes (change it with run)");
    const before = read.text;
    const at = before.indexOf(q.old);
    if (at < 0) return no("old does not occur in " + JSON.stringify(rel).slice(0, 200) + "; read the file again and copy the text exactly");
    if (before.indexOf(q.old, at + 1) >= 0) return no("old occurs more than once in " + JSON.stringify(rel).slice(0, 200) + "; give more of the text around it");
    const after = before.slice(0, at) + q.text + before.slice(at + q.old.length);
    writeNoLink(abs, rel, after);
    return { ok: true, body: "", facts: { path: rel, chars: after.length, line: before.slice(0, at).split("\\n").length } };
  }
  return no("unknown action");
}
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => { input += d; });
process.stdin.on("end", () => {
  let out;
  try { out = act(JSON.parse(input)); } catch (e) { out = no(String((e && e.code === "ENOENT") ? "no such file or folder" : (e && e.message) || e).slice(0, 300)); }
  process.stdout.write(JSON.stringify(out));
});
`;

/** A text cut to `max` characters: its start and its end, with how much was left out between (a build's first error and its last lines both matter). */
export function cutMiddle(text: string, max: number = CHECKOUT_TOOL_LIMITS.bodyChars, head: number = CHECKOUT_TOOL_LIMITS.headChars): { readonly text: string; readonly truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const tail = max - head;
  return { text: `${text.slice(0, head)}\n[... ${text.length - max} characters left out ...]\n${text.slice(text.length - tail)}`, truncated: true };
}

/** The error a host throws when a call that changes the checkout was stopped or ended without a clear answer: it may have changed files, so the controller keeps the call uncertain (card W09b, H12n). */
export const mayHaveActed = (message: string): Error => Object.assign(new Error(message), { mayHaveActed: true });

export interface CheckoutRunContext {
  readonly launcher: Pick<SandboxLauncher, "launch">;
  /** The attempt's own sandbox recipe (its checkout, inputs, environment, no network). Its home and scratch are replaced by empty ones for the call. */
  readonly recipe: SandboxRecipe;
  /** The limits the call runs under: the attempt's, the owner's and the contract's, the smallest of each (a command gets at most `CHECKOUT_TOOL_LIMITS.processes` processes besides). */
  readonly limits: ResourceLimits;
  readonly bestEffort: boolean;
  /** The sandbox's Node.js executable (`/opt/node/bin/node`). */
  readonly node: string;
  /** Where the call's empty home and scratch are made (removed afterwards). */
  readonly base?: string;
  /** Told the run once it started (so the sandbox's close can end it), and when it ended. */
  readonly track: (run: { kill(): void }, started: boolean) => void;
  /** Tests only: the free space under which a call is not started or is stopped (default `CHECKOUT_TOOL_LIMITS.diskReserveBytes`). */
  readonly diskReserveBytes?: number;
}

/** Whether one of the folders lies on a file system with less than `reserve` bytes free (a folder that cannot be looked at counts as full: the call is not made blind). */
async function diskLow(folders: readonly string[], reserve: number): Promise<boolean> {
  for (const folder of folders) {
    try { const s = await statfs(folder); if (s.bavail * s.bsize < reserve) return true; } catch { return true; }
  }
  return false;
}

/** One call, in a sandbox of its own. Answers the call's result, or throws: `mayHaveActed` for a call that changes the checkout and did not end cleanly, a plain error for one that could not start or only read. */
export async function runCheckoutCall(ctx: CheckoutRunContext, call: CheckoutCall, signal: AbortSignal): Promise<CheckoutAnswer> {
  const changes = call.action !== "read";
  if (signal.aborted) throw new Error("the call was stopped before it started");
  const { wallTimeMs, ...processLimits } = ctx.limits;
  const timeoutMs = Math.max(1000, Math.min(CHECKOUT_TOOL_LIMITS.timeoutMs, wallTimeMs ?? CHECKOUT_TOOL_LIMITS.timeoutMs));
  const limits: ResourceLimits = { ...processLimits, processes: Math.min(processLimits.processes ?? CHECKOUT_TOOL_LIMITS.processes, CHECKOUT_TOOL_LIMITS.processes) };
  const isRun = call.action === "run";
  if (isRun && (typeof call.command !== "string" || call.command.length === 0)) return { ok: false, reason: "run needs command" };
  const nodeBin = dirname(ctx.node);
  // A command runs in bash in /work with the sandbox's Node.js first on PATH; a file action runs the fixed helper above. Neither is ever a command line built outside the sandbox.
  const command = isRun ? ["/usr/bin/env", `PATH=${nodeBin}:/usr/bin:/bin`, "/bin/bash", "-c", call.command!] : [ctx.node, "-e", CHECKOUT_HELPER];
  const directory = realpathSync(mkdtempSync(join(ctx.base ?? tmpdir(), "nn-tool-")));
  try {
    const home = join(directory, "home"), scratch = join(directory, "scratch");
    mkdirSync(home); mkdirSync(scratch);
    const reserve = ctx.diskReserveBytes ?? CHECKOUT_TOOL_LIMITS.diskReserveBytes, watched = [ctx.recipe.workdir, directory];
    if (await diskLow(watched, reserve)) return { ok: false, reason: `the disk your checkout is on has less than ${Math.round(reserve / 1048576)} MB free; nothing was run (remove large files you made with run, such as build output)` };
    let run;
    try {
      run = await ctx.launcher.launch({ recipe: { ...ctx.recipe, home, scratch }, command, timeoutMs, maxOutputBytes: CHECKOUT_TOOL_LIMITS.streamBytes, ...(isRun ? {} : { stdin: JSON.stringify(call) }), limits, requireEnforced: !ctx.bestEffort });
    } catch (error) { throw new Error(`the sandbox refused the call: ${safeText(error, 300)}`); }
    ctx.track(run, true);
    const stop = (): void => run.kill();
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) run.kill();
    // The disk is looked at while the call runs; a call that brings it under the reserve is stopped (its end is then known, as at its time limit).
    let diskFull = false, looking = false;
    const watch = setInterval(() => { if (looking) return; looking = true; void diskLow(watched, reserve).then((low) => { if (low && !diskFull) { diskFull = true; run.kill(); } }).finally(() => { looking = false; }); }, CHECKOUT_TOOL_LIMITS.diskCheckMs);
    let result;
    try { result = await run.result; } finally { clearInterval(watch); signal.removeEventListener("abort", stop); ctx.track(run, false); }
    if (signal.aborted) { if (changes) throw mayHaveActed(`the ${call.action} was stopped while it ran; it may have changed the checkout`); throw new Error("the read was stopped"); }
    const started = !(result.exitCode === null && result.signal === null && !result.timedOut && !result.killed);
    if (!started) throw new Error(`the call could not be started: ${safeText(result.stderr.replace(/^could not start: /, ""), 300).trim()}`);
    if (isRun) {
      const streams = `${result.stdout}${result.stderr === "" ? "" : `${result.stdout === "" || result.stdout.endsWith("\n") ? "" : "\n"}[stderr]\n${result.stderr}`}`;
      const shown = cutMiddle(diskFull ? `${streams}\n[stopped: the disk your checkout is on fell under ${Math.round(reserve / 1048576)} MB free; remove what the command wrote]` : streams);
      return { ok: true, body: shown.text, facts: { exitCode: result.exitCode, signal: result.signal, timedOut: result.timedOut, ...(diskFull ? { diskFull: true } : {}), ms: result.durationMs, truncated: shown.truncated || result.truncated === true, ...(result.releaseProblem === undefined ? {} : { cleanup: safeText(result.releaseProblem, 200) }) } };
    }
    let answer: CheckoutAnswer | undefined;
    if (result.exitCode === 0 && !result.timedOut && !result.killed) { try { answer = JSON.parse(result.stdout) as CheckoutAnswer; } catch { answer = undefined; } }
    if (answer === undefined || typeof answer !== "object" || answer === null || typeof (answer as { ok?: unknown }).ok !== "boolean") {
      const why = `the ${call.action} did not end cleanly (${result.timedOut ? "it ran out of time" : result.signal !== null ? `signal ${result.signal}` : `exit ${result.exitCode}`}): ${safeText(result.stderr, 200)}`;
      if (changes) throw mayHaveActed(`${why}; it may have changed the checkout`);
      throw new Error(why);
    }
    if (!answer.ok) return { ok: false, reason: safeText(String(answer.reason), 300) };
    // The helper cut the text already (to the same bound, with its note of what was left out); this cut is only the host's own bound on what it hands on.
    const shown = cutMiddle(typeof answer.body === "string" ? answer.body : "", CHECKOUT_TOOL_LIMITS.bodyChars + 100);
    return { ok: true, body: shown.text, facts: { ...answer.facts, ...(shown.truncated ? { truncated: true } : {}) } };
  } finally { await removeTree(directory, undefined); }
}
