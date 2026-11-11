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
const clean = (s: string): string => [...s].filter((c) => { const n = c.codePointAt(0)!; return n >= 0x20 && n !== 0x7f && !(n >= 0x80 && n <= 0x9f) && n !== 0x2028 && n !== 0x2029; }).join("").slice(0, RELEASE_RUNNER_LIMITS.summary);
const same = (a: Readonly<Record<string, string>>, b: Readonly<Record<string, string>>): boolean => {
  const ka = Object.keys(a).sort(), kb = Object.keys(b).sort();
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k]);
};
const isMap = (v: unknown): v is Record<string, string> => typeof v === "object" && v !== null && !Array.isArray(v) && Object.entries(v).every(([k, x]) => k.length > 0 && k.length <= 256 && typeof x === "string" && SHA.test(x)) && Object.keys(v).length <= 100;

/**
 * The release-test host's side (card X09b remainder): the runnable program the controller's job protocol was waiting for. Each `tick` fetches this machine's open jobs and the attempts the controller ended without a result,
 * picks up the ones it will run, runs the operator's suite and reports. What it will not do: run anything the payload names (the suite is configured here, the payload only says what to test), run a job for another
 * platform, report a build it did not measure as the candidate's, report twice for an attempt (deterministic request keys, and it remembers what it ran), report a job the controller already ended (a cancel stops the
 * suite and sends nothing), or turn a suite that threw, ran out of time or counted no passing test into a pass. A job picked up by an earlier run of this process (a restart) is not run again and not guessed at: it is
 * reported as a failed test with no counts so the platform is free for a retry (the host cannot know what the destructive test already changed). Only the log's digest leaves the machine.
 */
export class ReleaseHostRunner {
  readonly #o: ReleaseHostRunnerOptions;
  readonly #running = new Map<string, AbortController>();
  readonly #done = new Set<string>();
  readonly #tasks = new Set<Promise<void>>();
  readonly #platform: { os: string; arch: string };
  #stopped = false;

  constructor(options: ReleaseHostRunnerOptions) {
    this.#o = options;
    this.#platform = options.platform ?? { os: process.platform, arch: process.arch };
  }

  get running(): readonly string[] { return [...this.#running.keys()]; }
  get #limit(): number { return Math.max(1, Math.min(RELEASE_RUNNER_LIMITS.concurrency, Math.trunc(this.#o.concurrency ?? 1))); }
  #trouble(id: string | undefined, what: string, error?: unknown): void { try { this.#o.onTrouble?.(id, what, error); } catch { /* a listener never stops the host */ } }

  /** One look at the controller. Starts what may run now and returns; `settled()` waits for the runs. */
  async tick(): Promise<void> {
    if (this.#stopped) return;
    let work: Awaited<ReturnType<ReleaseHostRunnerOptions["client"]["releaseWork"]>>;
    try { work = await this.#o.client.releaseWork(); } catch (e) { this.#trouble(undefined, "the job list could not be fetched", e); return; }
    for (const id of work.cancel.slice(0, RELEASE_RUNNER_LIMITS.cancelKeep)) this.#running.get(id)?.abort(new Error("the controller ended this attempt"));
    for (const job of work.jobs) {
      if (this.#stopped) return;
      const id = job.attemptId;
      if (typeof id !== "string" || !WORD.test(id) || this.#running.has(id) || this.#done.has(id)) continue;
      const p = job.payload as { [k: string]: Json };
      const suiteJob = this.#read(id, p);
      if (suiteJob === undefined) continue;
      if (job.pickedUpAt !== undefined) { this.#remember(id); await this.#lost(id, suiteJob); continue; }
      if (this.#running.size >= this.#limit) break;
      let picked = false;
      this.#running.set(id, new AbortController());
      try { await this.#o.client.releasePickUp(id, `release-pickup-${id}`); picked = true; } catch (e) { this.#trouble(id, "the pick-up was refused", e); }
      if (!picked) { this.#running.delete(id); continue; }
      const task = this.#run(id, suiteJob).finally(() => { this.#tasks.delete(task); });
      this.#tasks.add(task);
    }
  }

  /** Resolves when every run started so far has ended. */
  async settled(): Promise<void> { while (this.#tasks.size > 0) await Promise.all([...this.#tasks]); }

  /** Loops `tick` until the signal aborts; a stop aborts the running suites (their attempts end by the controller's timeout, never as a pass). */
  async serve(signal: AbortSignal, everyMs: number = 15_000, wait: (ms: number, s: AbortSignal) => Promise<void> = (ms, s) => new Promise((r) => { const t = setTimeout(r, ms); s.addEventListener("abort", () => { clearTimeout(t); r(); }, { once: true }); })): Promise<void> {
    while (!signal.aborted) { await this.tick(); await wait(Math.max(1000, everyMs), signal); }
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
      && typeof p["suiteRevision"] === "string" && isMap(p["artifacts"]) && isMap(p["dependencyLocks"])
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
    try { result = await this.#o.suite(job, control.signal); } catch (e) { failure = `the suite stopped: ${e instanceof Error ? e.message : "unknown"}`; }
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
      environment: { os: this.#platform.os, arch: this.#platform.arch, ...(typeof osVersion === "string" && osVersion.length > 0 && osVersion.length <= 64 ? { osVersion: clean(osVersion) } : {}) },
      outcome, counts: { passed: counts.passed, failed: counts.failed, skipped: counts.skipped }, logDigest, summary: clean(typeof summary === "string" ? summary : ""),
    };
    const tries = Math.max(1, Math.min(RELEASE_RUNNER_LIMITS.tries, Math.trunc(this.#o.reportTries ?? 3)));
    const sleep = this.#o.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let n = 1; ; n++) {
      try { await this.#o.client.releaseReport(id, body, `release-report-${id}`); return; } catch (e) {
        const transient = !(e instanceof WorkerRequestError) || e.status >= 500 || e.status === 429;
        if (!transient || n >= tries) throw e;
        await sleep(Math.min(30_000, 1000 * 2 ** (n - 1)));
      }
    }
  }
}
