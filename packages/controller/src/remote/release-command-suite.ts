import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReleaseSuiteJob, ReleaseSuiteResult } from "./release-runner.js";

/**
 * The operator's suite as a program on this machine (card X09b finish). The host's configuration names one executable and its arguments; the job payload never chooses or changes them. The program is told
 * what to test through environment variables and the job on its standard input, and answers by writing one JSON file at the path it is given in `NIMBLENEWT_RELEASE_RESULT`:
 * `{ "tested": { sourceCommit, suiteRevision, artifactHashes, dependencyLockHashes }, "counts": { passed, failed, skipped }, "summary": "...", "osVersion": "..." }`.
 * Everything it prints (output and errors, in the order they arrive) is digested as the log; only the digest leaves the machine, and a bounded tail is kept for the failure line. A program that exits with a failure
 * code, writes no answer, writes one that is not shaped as above, prints more than the limit or runs out of the job's time is a failed test: this adapter throws and the runner reports `fail`, never a pass.
 * No shell is involved (the command and arguments are passed as they are), the program gets only a small environment plus what the operator listed, and an abort (a cancel, the time limit, the host stopping) ends it.
 */
export interface CommandSuiteConfig {
  /** The executable (a path, or a name found on this machine's PATH). Not run through a shell. */
  readonly command: string;
  readonly args?: readonly string[];
  /** The folder the program runs in (default: the host's own). */
  readonly cwd?: string;
  /** Extra environment the operator sets (for example where the checkout is). Variables named `NIMBLENEWT_*` are the adapter's own and cannot be overridden. */
  readonly env?: Readonly<Record<string, string>>;
  /** Most bytes of output the program may print before it is ended as a failed test (default 64 MiB). */
  readonly maxOutputBytes?: number;
}

const DEFAULT_OUTPUT = 64 * 1024 * 1024;
const TAIL = 2000;
/** Variables a test program may need to find its tools. Nothing else of the host's environment is handed on (no credential of the host is ever among them). */
const INHERITED = ["PATH", "Path", "PATHEXT", "SYSTEMROOT", "SystemRoot", "COMSPEC", "ComSpec", "HOME", "USERPROFILE", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL"];
const isMap = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every((x) => typeof x === "string");
const count = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;

/** Reads what the program wrote; throws a plain error naming what is wrong. */
export function readSuiteAnswer(text: string): Omit<ReleaseSuiteResult, "log"> {
  let a: unknown;
  try { a = JSON.parse(text); } catch { throw new Error("the suite's result file is not JSON"); }
  const o = (a !== null && typeof a === "object" && !Array.isArray(a) ? a : {}) as Record<string, unknown>;
  const t = (o["tested"] !== null && typeof o["tested"] === "object" ? o["tested"] : {}) as Record<string, unknown>;
  const c = (o["counts"] !== null && typeof o["counts"] === "object" ? o["counts"] : {}) as Record<string, unknown>;
  if (typeof t["sourceCommit"] !== "string" || typeof t["suiteRevision"] !== "string" || !isMap(t["artifactHashes"]) || !isMap(t["dependencyLockHashes"])) throw new Error("the suite's result does not say what it tested (tested.sourceCommit, suiteRevision, artifactHashes, dependencyLockHashes)");
  if (!count(c["passed"]) || !count(c["failed"]) || !count(c["skipped"])) throw new Error("the suite's result has no whole-number counts (counts.passed, failed, skipped)");
  if (typeof o["summary"] !== "string") throw new Error("the suite's result has no summary");
  return {
    tested: { sourceCommit: t["sourceCommit"], suiteRevision: t["suiteRevision"], artifactHashes: t["artifactHashes"], dependencyLockHashes: t["dependencyLockHashes"] },
    counts: { passed: c["passed"], failed: c["failed"], skipped: c["skipped"] },
    summary: o["summary"],
    ...(typeof o["osVersion"] === "string" ? { osVersion: o["osVersion"] } : {}),
  };
}

/** Ends the program and what it started: its own process group on POSIX, `taskkill /T` on Windows. Never throws. */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  try {
    if (pid === undefined) { child.kill(); return; }
    if (process.platform === "win32") { const k = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" }); k.on("error", () => child.kill()); return; }
    try { process.kill(-pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
  } catch { /* already gone */ }
}

export function commandReleaseSuite(config: CommandSuiteConfig): (job: ReleaseSuiteJob, signal: AbortSignal) => Promise<ReleaseSuiteResult> {
  if (typeof config.command !== "string" || config.command.length === 0 || /[\0\r\n]/.test(config.command)) throw new Error("the suite needs a command");
  const limit = Number.isSafeInteger(config.maxOutputBytes) && (config.maxOutputBytes as number) > 0 ? (config.maxOutputBytes as number) : DEFAULT_OUTPUT;
  return async (job, signal) => {
    if (signal.aborted) throw new Error("the attempt was ended before the suite started");
    const dir = await mkdtemp(join(tmpdir(), "nn-release-"));
    const resultPath = join(dir, "result.json");
    try {
      const env: Record<string, string> = {};
      for (const k of INHERITED) { const v = process.env[k]; if (v !== undefined) env[k] = v; }
      for (const [k, v] of Object.entries(config.env ?? {})) if (!k.startsWith("NIMBLENEWT_")) env[k] = v;
      Object.assign(env, {
        NIMBLENEWT_RELEASE_RESULT: resultPath, NIMBLENEWT_RELEASE_ATTEMPT: job.attemptId, NIMBLENEWT_RELEASE_CANDIDATE: job.candidateId, NIMBLENEWT_RELEASE_COMMIT: job.sourceCommit,
        NIMBLENEWT_RELEASE_SUITE_REVISION: job.suiteRevision, NIMBLENEWT_RELEASE_TIMEOUT_SECONDS: String(job.timeoutSeconds), NIMBLENEWT_RELEASE_MEMORY_MB: String(job.memoryMb),
      });
      const hash = createHash("sha256");
      let bytes = 0;
      let tail = "";
      let tooMuch = false;
      const child = spawn(config.command, [...(config.args ?? [])], { cwd: config.cwd, env, shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
      const take = (d: Buffer): void => {
        bytes += d.length;
        if (bytes > limit) { if (!tooMuch) { tooMuch = true; killTree(child); } return; }
        hash.update(d);
        tail = (tail + d.toString("utf8")).slice(-TAIL);
      };
      child.stdout.on("data", take);
      child.stderr.on("data", take);
      const exit = new Promise<{ code: number | null; error?: Error }>((resolve) => {
        child.once("error", (error) => resolve({ code: null, error }));
        child.once("close", (code) => resolve({ code }));
      });
      const stop = (): void => { killTree(child); };
      signal.addEventListener("abort", stop, { once: true });
      // The program reads the job from standard input if it wants it; one that does not read it must not hang or crash the host.
      child.stdin.on("error", () => undefined);
      child.stdin.end(JSON.stringify({ attemptId: job.attemptId, candidateId: job.candidateId, sourceCommit: job.sourceCommit, suiteRevision: job.suiteRevision, artifacts: job.artifacts, dependencyLocks: job.dependencyLocks, timeoutSeconds: job.timeoutSeconds, memoryMb: job.memoryMb }));
      const ended = await exit;
      signal.removeEventListener("abort", stop);
      const last = tail.replace(/\s+/g, " ").trim().slice(-200);
      if (ended.error !== undefined) throw new Error(`the suite could not be started: ${ended.error.message.slice(0, 200)}`);
      if (signal.aborted) throw new Error("the attempt was ended while the suite ran");
      if (tooMuch) throw new Error(`the suite printed more than ${limit} bytes and was ended`);
      if (ended.code !== 0) throw new Error(`the suite exited with code ${String(ended.code)}${last === "" ? "" : `: ${last}`}`);
      let text: string;
      try { text = await readFile(resultPath, "utf8"); } catch { throw new Error("the suite wrote no result file"); }
      const answer = readSuiteAnswer(text);
      return { ...answer, log: { sha256: hash.digest("hex") } };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

