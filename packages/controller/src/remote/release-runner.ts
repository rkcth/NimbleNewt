import { createHash } from "node:crypto";
import type { Json } from "../storage/types.js";
import type { RemoteWorkerClient } from "./client.js";
import { WorkerRequestError } from "./client.js";

/** What the test host itself measured about the build it tested. The controller refuses a report whose values are not the candidate's; the runner checks first so nothing is sent that could not count. */
export interface ReleaseTested {
  readonly sourceCommit: string;
  readonly suiteRevision: string;
  readonly artifactHashes: Readonly<Record<string, string>>;
  readonly dependencyLockHashes: Readonly<Record<string, string>>;
}

/** What the operator's suite returns. The host never takes any of it from the job payload. */
export interface ReleaseSuiteResult {
  readonly tested: ReleaseTested;
  readonly counts: { readonly passed: number; readonly failed: number; readonly skipped: number };
  /** The whole log, or its sha256 when the suite digested it itself. Only the digest leaves the host. */
  readonly log: string | Uint8Array | { readonly sha256: string };
  readonly summary: string;
  readonly osVersion?: string;
}

/** The job as the suite sees it: what to test, never how (the suite is the operator's, set up on this machine). */
export interface ReleaseSuiteJob {
  readonly attemptId: string;
  readonly candidateId: string;
  readonly sourceCommit: string;
  readonly suiteRevision: string;
  readonly artifacts: Readonly<Record<string, string>>;
  readonly dependencyLocks: Readonly<Record<string, string>>;
  readonly timeoutSeconds: number;
  readonly memoryMb: number;
}

export interface ReleaseHostRunnerOptions {
  readonly client: Pick<RemoteWorkerClient, "releaseWork" | "releasePickUp" | "releaseReport">;
  /**
   * The suite on this machine. It receives a signal that aborts when the controller ended the attempt (cancel, timeout, withdrawn authorization), when the job's own time limit passes, or when the runner stops. A thrown
   * error is a failed test, never a pass.
   */
  readonly suite: (job: ReleaseSuiteJob, signal: AbortSignal) => Promise<ReleaseSuiteResult>;
  /** The platform of this machine; a job for any other platform is left alone. Default: this process. */
  readonly platform?: { readonly os: "linux" | "darwin" | "win32"; readonly arch: "x64" | "arm64" };
  /** Tests run at once on this machine (default 1, at most 4): they are destructive and heavy. */
  readonly concurrency?: number;
  /** Told about anything that did not end a job in a report (a refused job, a report the controller would not take, a fetch that failed). */
  readonly onTrouble?: (attemptId: string | undefined, what: string, error?: unknown) => void;
  /** Report attempts for a transient failure (default 3, at most 6). */
  readonly reportTries?: number;
  /** Waits between report tries (default 1000 ms; injected for tests). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export const RELEASE_RUNNER_LIMITS = { concurrency: 4, summary: 500, tries: 6, cancelKeep: 256, seconds: 24 * 3600 } as const;
const SHA = /^[0-9a-f]{64}$/;
const WORD = /^[A-Za-z0-9._@/+-]{1,128}$/;
/** The controller's own rules for names in the hash maps, the suite revision and an OS version: a payload outside them is not a release job, and a value outside them would make the report refused. */
const NAME = /^[A-Za-z0-9][A-Za-z0-9._@/+-]{0,127}$/;
const REVISION = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const OS_VERSION = /^[A-Za-z0-9._-]{1,40}$/;
/** One line, no control characters, at most `max` UTF-16 units and never cut inside a surrogate pair (the controller counts UTF-16 units and refuses a lone surrogate). */
const clean = (s: string, max: number = RELEASE_RUNNER_LIMITS.summary): string => {
  let out = "";
  for (const c of s) {
    const n = c.codePointAt(0)!;
    if (n < 0x20 || n === 0x7f || (n >= 0x80 && n <= 0x9f) || n === 0x2028 || n === 0x2029 || (n >= 0xd800 && n <= 0xdfff)) continue;
    if (out.length + c.length > max) break;
    out += c;
  }
  return out;
};
/** A bounded setting: a missing, non-numeric or out-of-range value never lifts the bound. */
const bounded = (v: number | undefined, fallback: number, max: number): number => { const n = Math.trunc(Number(v ?? fallback)); return Number.isFinite(n) ? Math.max(1, Math.min(max, n)) : fallback; };
const same = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
const isMap = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, x]) => NAME.test(k) && typeof x === "string" && SHA.test(x)) && Object.keys(v).length <= 100;

/**
 * The release-test host's side (card X09b remainder): the runnable program the controller's job protocol was waiting for. Each `tick` fetches this machine's open jobs and the attempts the controller ended without a result,
 * picks up the ones it will run, runs the operator's suite and reports. What it will not do: run anything the payload names (the suite is configured here, the payload only says what to test), run a job for another
 * platform, report a build it did not measure as the candidate's, report twice for an attempt (deterministic request keys, and it remembers what it ran), report a job the controller already ended (a cancel stops the
 * suite and sends nothing), or turn a suite that threw, ran out of time or counted no passing test into a pass. A job picked up by an earlier run of this process (a restart) is not run again and not guessed at: it is
 * reported as a failed test with no counts so the platform is free for a retry (the host cannot know what the destructive test already changed). Only the log's digest leaves the machine.
 */
const pause = (ms: number, s: AbortSignal): Promise<void> => new Promise((r) => {
  if (s.aborted) { r(); return; }
  // The listener is removed when the wait ends, so a loop that runs for months does not pile listeners on its signal.
  const done = (): void => { clearTimeout(t); s.removeEventListener("abort", done); r(); };
  const t = setTimeout(done, ms);
  s.addEventListener("abort", done, { once: true });
});

export class ReleaseHostRunner {
  readonly #o: ReleaseHostRunnerOptions;
  readonly #running = new Map<string, AbortController>();
  readonly #done = new Set<string>();
  /** Attempts whose pick-up got no clear answer: the suite never started here, so a pick-up the controller did record is not a restart (it is picked up again, which changes nothing, and run). */
  readonly #unstarted = new Set<string>();
  /** Reports that met only transient errors: sent again, with the same key, while the controller still lists the job (a lost result must not turn into a timeout that hides a real failure). */
  readonly #unsent = new Map<string, { [k: string]: Json }>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #platform: { os: string; arch: string };
  #stopped = false;

  constructor(options: ReleaseHostRunnerOptions) {
    this.#o = options;
    this.#platform = options.platform ?? { os: process.platform, arch: process.arch };
  }

  get running(): readonly string[] { return [...this.#running.keys()]; }
  get #limit(): number { return bounded(this.#o.concurrency, 1, RELEASE_RUNNER_LIMITS.concurrency); }
  #trouble(id: string | undefined, what: string, error?: unknown): void { try { this.#o.onTrouble?.(id, what, error); } catch { /* a listener never stops the host */ } }

  /** One look at the controller. Starts what may run now and returns; `settled()` waits for the runs. */
  async tick(): Promise<void> {
    if (this.#stopped) return;
    let work: Awaited<ReturnType<ReleaseHostRunnerOptions["client"]["releaseWork"]>>;
    try { work = await this.#o.client.releaseWork(); } catch (e) { this.#trouble(undefined, "the job list could not be fetched", e); return; }
    for (const id of Array.isArray(work?.cancel) ? work.cancel.slice(0, RELEASE_RUNNER_LIMITS.cancelKeep) : []) { if (typeof id !== "string") continue; this.#running.get(id)?.abort(new Error("the controller ended this attempt")); this.#unsent.delete(id); }
    for (const job of Array.isArray(work?.jobs) ? work.jobs : []) {
      if (this.#stopped) return;
      const id = job?.attemptId;
      if (typeof id !== "string" || !WORD.test(id)) continue;
      const unsent = this.#unsent.get(id);
      if (unsent !== undefined && !this.#running.has(id)) { await this.#resend(id, unsent); continue; }
      if (this.#running.has(id) || this.#done.has(id)) continue;
      const p = job.payload;
      const suiteJob = typeof p === "object" && p !== null && !Array.isArray(p) ? this.#read(id, p as { [k: string]: Json }) : (this.#trouble(id, "the job is not shaped as a release test; left alone"), undefined);
      if (suiteJob === undefined) continue;
      if (job.pickedUpAt !== undefined && !this.#unstarted.has(id)) { this.#remember(id); await this.#lost(id, suiteJob); continue; }
      if (this.#running.size >= this.#limit) break;
      let picked = false;
      this.#running.set(id, new AbortController());
      try { await this.#o.client.releasePickUp(id, `release-pickup-${id}`); picked = true; } catch (e) { this.#trouble(id, "the pick-up was refused", e); }
      if (!picked) { this.#running.delete(id); this.#unstarted.add(id); if (this.#unstarted.size > 2000) this.#unstarted.delete(this.#unstarted.values().next().value as string); continue; }
      this.#unstarted.delete(id);
      const task = this.#run(id, suiteJob).finally(() => { this.#tasks.delete(task); });
      this.#tasks.add(task);
    }
  }

  /** Resolves when every run started so far has ended. */
  async settled(): Promise<void> { while (this.#tasks.size > 0) await Promise.all([...this.#tasks]); }

  /** Loops `tick` until the signal aborts; a stop aborts the running suites (their attempts end by the controller's timeout, never as a pass). */
  async serve(signal: AbortSignal, everyMs: number = 15_000, wait: (ms: number, s: AbortSignal) => Promise<void> = pause): Promise<void> {
    const every = Number.isFinite(everyMs) ? Math.max(1000, everyMs) : 15_000;
    while (!signal.aborted && !this.#stopped) {
      // A look that throws (a malformed answer, a bug) is told and the loop goes on after the usual wait: it neither ends the host nor spins.
      try { await this.tick(); } catch (e) { this.#trouble(undefined, "a look at the controller failed", e); }
      await wait(every, signal);
    }
    this.stop();
    await this.settled();
  }

  #remember(id: string): void { this.#done.add(id); if (this.#done.size > 2000) this.#done.delete(this.#done.values().next().value as string); }

  stop(): void { this.#stopped = true; for (const c of this.#running.values()) c.abort(new Error("the host is stopping")); }

  /** The payload, checked. A job that is not shaped as expected, or is for another platform, is left alone (never picked up). */
  #read(id: string, p: { [k: string]: Json }): ReleaseSuiteJob | undefined {
    const cell = p["cell"] as { os?: unknown; arch?: unknown } | undefined;
    const limits = p["limits"] as { timeoutSeconds?: unknown; memoryMb?: unknown } | undefined;
    const ok = p["capability"] === "release-test" && p["attemptId"] === id && typeof p["candidateId"] === "string" && typeof p["sourceCommit"] === "string" && /^[0-9a-f]{40}$/.test(p["sourceCommit"] as string)
      && typeof p["candidateId"] === "string" && WORD.test(p["candidateId"] as string) && typeof p["suiteRevision"] === "string" && REVISION.test(p["suiteRevision"] as string) && isMap(p["artifacts"]) && isMap(p["dependencyLocks"])
      && Number.isInteger(limits?.timeoutSeconds) && (limits!.timeoutSeconds as number) > 0 && (limits!.timeoutSeconds as number) <= RELEASE_RUNNER_LIMITS.seconds && Number.isInteger(limits?.memoryMb) && (limits!.memoryMb as number) > 0;
    if (!ok) { this.#trouble(id, "the job is not shaped as a release test; left alone"); return undefined; }
    if (cell?.os !== this.#platform.os || cell?.arch !== this.#platform.arch) { this.#trouble(id, `the job is for ${String(cell?.os)}/${String(cell?.arch)}, this machine is ${this.#platform.os}/${this.#platform.arch}; left alone`); return undefined; }
    return { attemptId: id, candidateId: p["candidateId"] as string, sourceCommit: p["sourceCommit"] as string, suiteRevision: p["suiteRevision"] as string, artifacts: p["artifacts"] as Record<string, string>, dependencyLocks: p["dependencyLocks"] as Record<string, string>, timeoutSeconds: limits!.timeoutSeconds as number, memoryMb: limits!.memoryMb as number };
  }

  async #run(id: string, job: ReleaseSuiteJob): Promise<void> {
    const control = this.#running.get(id)!;
    const timer = setTimeout(() => control.abort(new Error("the job's time limit passed on the host")), job.timeoutSeconds * 1000);
    let result: ReleaseSuiteResult | undefined;
    let failure: string | undefined;
    // Ended (cancel, stop) while the pick-up was answered: the destructive suite is not started at all.
    if (!control.signal.aborted) { try { result = await this.#o.suite(job, control.signal); } catch (e) { failure = `the suite stopped: ${e instanceof Error ? e.message : "unknown"}`; } }
    clearTimeout(timer);
    this.#remember(id);
    try {
      if (control.signal.aborted) {
        const why = control.signal.reason instanceof Error ? control.signal.reason.message : "aborted";
        if (why.includes("time limit")) { await this.#send(id, job, { passed: 0, failed: 0, skipped: 0 }, "fail", "time limit passed on the host", this.#digest("")); } else this.#trouble(id, `ended without a report: ${why}`);
        return;
      }
      if (result === undefined) { await this.#send(id, job, { passed: 0, failed: 0, skipped: 0 }, "fail", failure ?? "the suite gave no result", this.#digest("")); return; }
      const t = result.tested, k = result.counts;
      if (t?.sourceCommit !== job.sourceCommit || t.suiteRevision !== job.suiteRevision || !isMap(t.artifactHashes) || !same(t.artifactHashes, job.artifacts) || !isMap(t.dependencyLockHashes) || !same(t.dependencyLockHashes, job.dependencyLocks)) {
        this.#trouble(id, "what the suite measured is not the candidate's; nothing is reported (the attempt ends by cancel or timeout)");
        return;
      }
      if (![k?.passed, k?.failed, k?.skipped].every((n) => Number.isInteger(n) && (n as number) >= 0)) { this.#trouble(id, "the suite's counts are not whole numbers; nothing is reported"); return; }
      const digest = this.#digest(result.log);
      if (digest === undefined) { this.#trouble(id, "the suite's log digest is not a sha256; nothing is reported"); return; }
      const pass = k.failed === 0 && k.passed > 0;
      await this.#send(id, job, k, pass ? "pass" : "fail", result.summary, digest, result.osVersion);
    } catch (e) { this.#trouble(id, "the report was not accepted", e); } finally { this.#running.delete(id); }
  }

  /** A job a previous run of this process picked up: reported as failed with no counts, so the platform can be retried. */
  async #resend(id: string, body: { [k: string]: Json }): Promise<void> {
    this.#unsent.delete(id);
    try { await this.#post(id, body); } catch (e) { this.#trouble(id, "the report was not accepted", e); }
  }

  async #lost(id: string, job: ReleaseSuiteJob): Promise<void> {
    try { await this.#send(id, job, { passed: 0, failed: 0, skipped: 0 }, "fail", "the host restarted before the test finished; not run again", this.#digest("")); } catch (e) { this.#trouble(id, "the report was not accepted", e); }
  }

  #digest(log: string | Uint8Array | { readonly sha256: string } | undefined): string | undefined {
    if (typeof log === "object" && log !== null && !(log instanceof Uint8Array)) return typeof log.sha256 === "string" && SHA.test(log.sha256) ? log.sha256 : undefined;
    if (log === undefined) return undefined;
    return createHash("sha256").update(log).digest("hex");
  }

  async #send(id: string, job: ReleaseSuiteJob, counts: { passed: number; failed: number; skipped: number }, outcome: "pass" | "fail", summary: string, logDigest: string | undefined, osVersion?: string): Promise<void> {
    if (logDigest === undefined) return;
    const body: { [k: string]: Json } = {
      sourceCommit: job.sourceCommit, suiteRevision: job.suiteRevision, artifactHashes: { ...job.artifacts }, dependencyLockHashes: { ...job.dependencyLocks },
      environment: { os: this.#platform.os, arch: this.#platform.arch, ...(typeof osVersion === "string" && OS_VERSION.test(osVersion) ? { osVersion } : {}) },
      outcome, counts: { passed: counts.passed, failed: counts.failed, skipped: counts.skipped }, logDigest, summary: this.#summary(summary, outcome),
    };
    if (osVersion !== undefined && body["environment"] !== undefined && (body["environment"] as { osVersion?: string }).osVersion === undefined) this.#trouble(id, "the suite's OS version is not a version the controller takes; sent without it");
    await this.#post(id, body);
  }

  /** The controller needs a non-blank summary: an empty or unprintable one is replaced, so a real result is never refused for its wording. */
  #summary(summary: unknown, outcome: "pass" | "fail"): string {
    const s = clean(typeof summary === "string" ? summary : "");
    return s.trim().length > 0 ? s : outcome === "pass" ? "passed (the suite gave no summary)" : "failed (the suite gave no summary)";
  }

  async #post(id: string, body: { [k: string]: Json }): Promise<void> {
    const tries = bounded(this.#o.reportTries, 3, RELEASE_RUNNER_LIMITS.tries);
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let n = 1; ; n++) {
      try { await this.#o.client.releaseReport(id, body, `release-report-${id}`); this.#unsent.delete(id); return; } catch (e) {
        // A transient answer: the controller or the network is down, busy, or the attempt's records moved at the same moment (stale_revision: "report again"). The same key makes a repeat land once.
        const transient = !(e instanceof WorkerRequestError) || e.status >= 500 || e.status === 429 || e.code === "stale_revision";
        if (transient && n >= tries) { this.#unsent.set(id, body); if (this.#unsent.size > RELEASE_RUNNER_LIMITS.cancelKeep) this.#unsent.delete(this.#unsent.keys().next().value as string); }
        if (!transient || n >= tries) throw e;
        await sleep(Math.min(30_000, 1000 * 2 ** (n - 1)));
      }
    }
  }
}
