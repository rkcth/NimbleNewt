import { createHash } from "node:crypto";
import { redactText } from "../security/redact.js";
import { stable } from "./contract-wire.js";
import type { RemoteAttempt } from "./client.js";
import { WorkerRequestError } from "./client.js";
import { REMOTE_LIMITS, type ControlMessage, type RunOrderWire, type RunOutcomeWire } from "./protocol.js";

/**
 * The remote host's side of a catalogue script run (card T02d, protocol 2). The controller's `run` control message names a run and the digest of its order; this fetches the order, checks it against the digest and the protocol's bounds, runs it in the
 * host's own sandbox (the `runner`: the worker package's `hostScriptRunner`, never a bare process) with an EMPTY environment whatever the order says, and reports the outcome. `abort` stops one run; `revoke` carries the owner's recorded choice for a
 * version: `cancel` and `pause` stop its runs on this host (and refuse any later order of it for the attempt), `finish` lets them end. A stop is acknowledged (`aborted`) only when the run's own promise has settled, that is when the sandbox
 * has ended the process. The host holds no credential for the task and keeps nothing of an order or an output once reported (bounded memory of the last outcomes, for a repeated order).
 */

/** What the host's sandbox runs: the order, minus its run ID, with an empty environment. */
export interface HostScriptLaunch {
  readonly program: string;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly source: string;
  readonly tool: { readonly name: string; readonly version: string; readonly digest: string };
  readonly interpreterVersion: string;
  readonly maxOutputBytes: number;
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly seconds: number };
  readonly env: Readonly<Record<string, string>>;
}
export interface HostScriptRunner { run(launch: HostScriptLaunch, signal: AbortSignal): Promise<{ readonly text: string; readonly cpuMs?: number; readonly memoryMb?: number }> }
type ScriptAttempt = Pick<RemoteAttempt, "fetchRun" | "finishRun">;

export interface RemoteScriptRunsOptions {
  /** This host's script sandbox. Absent: the host says so to the controller for every order, and runs nothing. */
  readonly runner?: HostScriptRunner;
  /** Told about a trouble that does not end the attempt (an outcome that could not be sent). */
  readonly onTrouble?: (attemptId: string, what: string, error: unknown) => void;
  /** Wait between tries to send an outcome, in ms (default 500). */
  readonly retryMs?: number;
}

const PROGRAM = /^[a-z][a-z0-9._-]{0,63}$/;
interface HostRun { readonly runId: string; readonly ctl: AbortController; name?: string; version?: string; why?: "abort" | "cancel" | "pause" | "end"; ended: Promise<void> }
interface AttemptState { readonly runs: Map<string, HostRun>; readonly revoked: Set<string>; readonly finished: Map<string, RunOutcomeWire> }
const FINISHED = 32;
const REVOKED = 64;

export class RemoteScriptRuns {
  readonly #o: RemoteScriptRunsOptions;
  readonly #attempts = new Map<string, AttemptState>();

  constructor(options: RemoteScriptRunsOptions = {}) { this.#o = options; }

  /** The runs this host has going for an attempt. */
  running(attemptId: string): readonly string[] { return [...(this.#attempts.get(attemptId)?.runs.keys() ?? [])]; }

  /** Acts on one control message of the script kinds (`run`, `abort`, `revoke`); any other kind is ignored. Never throws for a run's own trouble. */
  async handle(attempt: ScriptAttempt, attemptId: string, message: ControlMessage): Promise<void> {
    if (message.kind !== "run" && message.kind !== "abort" && message.kind !== "revoke") return;
    const state = this.#state(attemptId);
    if (message.kind === "run") {
      // The same order again (the controller asked twice): what is going is left alone; what ended is reported again, so a controller that lost the first report is answered.
      if (state.runs.has(message.runId)) return;
      const earlier = state.finished.get(message.runId);
      if (earlier !== undefined) { await this.#report(attempt, attemptId, message.runId, earlier); return; }
      if (this.#o.runner === undefined) { await this.#report(attempt, attemptId, message.runId, { state: "failed", error: "this host has no script sandbox, so it runs no catalogue tool" }); return; }
      if (state.runs.size >= REMOTE_LIMITS.scriptRuns) { await this.#report(attempt, attemptId, message.runId, { state: "failed", error: `this host already runs ${REMOTE_LIMITS.scriptRuns} scripts for the attempt` }); return; }
      const run: HostRun = { runId: message.runId, ctl: new AbortController(), ended: Promise.resolve() };
      state.runs.set(message.runId, run);
      run.ended = this.#execute(attempt, attemptId, state, run, message.digest).catch((error: unknown) => this.#trouble(attemptId, "script run", error));
      return;
    }
    if (message.kind === "abort") { const run = state.runs.get(message.runId); if (run !== undefined) { run.why ??= "abort"; run.ctl.abort(new Error("the controller stopped the run")); } return; }
    // revoke
    if (message.choice === "finish") return;
    this.#remember(state.revoked, `${message.name}|${message.version}`);
    for (const run of state.runs.values()) if (run.name === message.name && run.version === message.version) { run.why ??= message.choice; run.ctl.abort(new Error(`${message.name} ${message.version} was revoked`)); }
  }

  /** The attempt ended or was fenced: every run of it is stopped and waited for (the sandbox ends the processes), and nothing is reported (the controller no longer accepts it). */
  async endAttempt(attemptId: string): Promise<void> {
    const state = this.#attempts.get(attemptId);
    if (state === undefined) return;
    for (const run of state.runs.values()) { run.why ??= "end"; run.ctl.abort(new Error("the attempt ended")); }
    await Promise.allSettled([...state.runs.values()].map((r) => r.ended));
    this.#attempts.delete(attemptId);
  }

  #state(attemptId: string): AttemptState {
    let s = this.#attempts.get(attemptId);
    if (s === undefined) { s = { runs: new Map(), revoked: new Set(), finished: new Map() }; this.#attempts.set(attemptId, s); }
    return s;
  }

  #remember(set: Set<string>, key: string): void { set.delete(key); set.add(key); while (set.size > REVOKED) set.delete(set.values().next().value as string); }

  #trouble(attemptId: string, what: string, error: unknown): void { try { this.#o.onTrouble?.(attemptId, what, error); } catch { /* ignored */ } }

  async #execute(attempt: ScriptAttempt, attemptId: string, state: AttemptState, run: HostRun, digest: string): Promise<void> {
    let outcome: RunOutcomeWire | undefined;
    try {
      let order: RunOrderWire;
      try { order = await attempt.fetchRun(run.runId); } catch (error) {
        // Not wanted any more (`not_found`) or fenced: nothing to run and nothing to report. Any other failure is reported to the controller, which then does not wait out the run's time.
        if (error instanceof WorkerRequestError && (error.fenced || error.code === "not_found")) return;
        outcome = { state: "failed", error: `the order could not be fetched: ${String((error as Error)?.message ?? error)}`.slice(0, 300) };
        return;
      }
      const problem = orderProblem(order, run.runId, digest);
      if (problem !== undefined) { outcome = { state: "failed", error: problem }; return; }
      run.name = order.tool.name; run.version = order.tool.version;
      // A revocation that arrived before the order did stops it from starting.
      if (state.revoked.has(`${order.tool.name}|${order.tool.version}`)) run.why ??= "cancel";
      if (run.ctl.signal.aborted || run.why !== undefined) { outcome = { state: "aborted", ...(run.why === "cancel" || run.why === "pause" ? { choice: run.why } : {}) }; return; }
      // An empty environment, whatever the order says; the order's run ID is the controller's bookkeeping, not the script's.
      const launch: HostScriptLaunch = { program: order.program, argv: [...order.argv], stdin: order.stdin, source: order.source, tool: { ...order.tool }, interpreterVersion: order.interpreterVersion, maxOutputBytes: order.maxOutputBytes, limits: { ...order.limits }, env: {} };
      try {
        const out = await this.#o.runner!.run(launch, run.ctl.signal);
        if (run.ctl.signal.aborted) outcome = { state: "aborted", ...(run.why === "cancel" || run.why === "pause" ? { choice: run.why } : {}) };
        else if (Buffer.byteLength(out.text, "utf8") > order.maxOutputBytes) outcome = { state: "failed", error: `the script wrote more than ${order.maxOutputBytes} bytes` };
        else outcome = { state: "done", text: out.text, ...(out.cpuMs === undefined || !Number.isSafeInteger(out.cpuMs) || out.cpuMs < 0 ? {} : { cpuMs: out.cpuMs }), ...(out.memoryMb === undefined || !Number.isSafeInteger(out.memoryMb) || out.memoryMb < 0 ? {} : { memoryMb: out.memoryMb }) };
      } catch (error) {
        if (run.ctl.signal.aborted) outcome = { state: "aborted", ...(run.why === "cancel" || run.why === "pause" ? { choice: run.why } : {}) };
        else outcome = { state: "failed", error: redactText(String((error as Error)?.message ?? error)).slice(0, REMOTE_LIMITS.scriptErrorChars) || "the script failed" };
      }
    } finally {
      // The run is over here (its process is gone) before it is reported: the acknowledgement of a stop means it.
      state.runs.delete(run.runId);
      if (outcome !== undefined && run.why !== "end") {
        state.finished.delete(run.runId); state.finished.set(run.runId, outcome);
        while (state.finished.size > FINISHED) state.finished.delete(state.finished.keys().next().value as string);
        await this.#report(attempt, attemptId, run.runId, outcome);
      }
    }
  }

  async #report(attempt: ScriptAttempt, attemptId: string, runId: string, outcome: RunOutcomeWire): Promise<void> {
    for (let tries = 1; ; tries += 1) {
      try { await attempt.finishRun(runId, outcome); return; } catch (error) {
        if (error instanceof WorkerRequestError && (error.fenced || (error.status >= 400 && error.status < 500))) { if (!error.fenced) this.#trouble(attemptId, "run outcome", error); return; }
        if (tries >= 3) { this.#trouble(attemptId, "run outcome", error); return; }
        await new Promise((r) => setTimeout(r, this.#o.retryMs ?? 500));
      }
    }
  }
}

/** Why an order a host fetched is not taken: it is not the order the controller announced, or it is outside the protocol's bounds. */
export function orderProblem(order: unknown, runId: string, digest: string): string | undefined {
  if (order === null || typeof order !== "object" || Array.isArray(order)) return "the order is not an object";
  const o = order as Partial<RunOrderWire>;
  if (o.runId !== runId) return "the order is for another run";
  if (createHash("sha256").update(stable(order)).digest("hex") !== digest) return "the order does not match the digest the controller announced";
  if (typeof o.program !== "string" || !PROGRAM.test(o.program)) return "the program is not a plain program name";
  if (!Array.isArray(o.argv) || o.argv.length < 1 || o.argv.length > 8 || o.argv.some((a) => typeof a !== "string" || a.length > 300)) return "the arguments are not a short list of strings";
  if (typeof o.stdin !== "string" || Buffer.byteLength(o.stdin, "utf8") > REMOTE_LIMITS.scriptStdinBytes) return "the standard input is too large";
  if (typeof o.source !== "string" || Buffer.byteLength(o.source, "utf8") > REMOTE_LIMITS.scriptSourceBytes) return "the executable is too large";
  if (o.tool === undefined || typeof o.tool.name !== "string" || typeof o.tool.version !== "string" || typeof o.tool.digest !== "string" || typeof o.interpreterVersion !== "string") return "the tool or interpreter is not named";
  if (typeof o.maxOutputBytes !== "number" || !Number.isSafeInteger(o.maxOutputBytes) || o.maxOutputBytes < 1 || o.maxOutputBytes > REMOTE_LIMITS.scriptOutputBytes) return "the output limit is outside what the protocol carries";
  const l = o.limits;
  if (l === undefined || ![l.cpus, l.memoryMb, l.seconds].every((n) => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= 4_194_304)) return "the limits are not whole numbers";
  return undefined;
}
