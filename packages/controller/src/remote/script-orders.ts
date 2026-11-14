import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { redactText } from "../security/redact.js";
import { REMOTE_LIMITS, RUN_ID, type ControlMessage, type RunAck, type RunOrderWire, type RunOutcomeWire } from "./protocol.js";
import { stable } from "./contract-wire.js";

/**
 * The controller's side of a catalogue script run on a remote host (card T02d, protocol 2): the orders it has made and not seen the end of. In memory only. A run is the call of one attempt under one placement; the durable facts are the dispatcher's
 * operation record of the call and the running-call record the tool service writes, so a controller that restarts loses only the wait: the same call asked again makes the same run ID (same attempt, call and placement), and a host that still runs
 * that order reports into the new controller's wait. Nothing here keeps a credential, and no order or outcome text is written anywhere: the order is handed to the host that holds the placement, the outcome to the call that waits for it.
 */

export interface ScriptResult { readonly text: string; readonly cpuMs?: number; readonly memoryMb?: number }
/** The parts of a `ScriptLaunch` (card T06) an order carries; the environment is never carried. */
export interface ScriptOrderInput {
  readonly program: string;
  readonly argv: readonly string[];
  readonly stdin: string;
  readonly source: string;
  readonly tool: { readonly name: string; readonly version: string; readonly digest: string };
  readonly interpreterVersion: string;
  readonly maxOutputBytes: number;
  readonly limits: { readonly cpus: number; readonly memoryMb: number; readonly seconds: number };
}

type State = "ordered" | "fetched" | "aborting";
interface Run {
  readonly runId: string;
  readonly attemptId: string;
  readonly placement: number;
  readonly sessionId: string;
  readonly order: RunOrderWire;
  readonly digest: string;
  state: State;
  /** A revocation told the host already (it stops the run itself); the abort message is then not sent as well. */
  revoked: boolean;
  readonly settle: { resolve(r: ScriptResult): void; reject(e: Error): void };
  /** Settles when the run ends; every call that joined the run waits on it. */
  readonly result: Promise<ScriptResult>;
  readonly timer: ReturnType<typeof setTimeout>;
}

export interface ScriptOrdersOptions {
  /** Puts a control message on the placement's queue (fenced by the placement number). Rejects when the placement is gone. */
  readonly send: (attemptId: string, placement: number, message: ControlMessage) => Promise<unknown>;
  readonly onError?: (error: unknown) => void;
  /** Milliseconds beyond a run's own time limit that the controller waits for the host's word. Default `REMOTE_LIMITS.scriptGraceMs`. */
  readonly graceMs?: number;
}

/** The run ID for a call under a placement: the same call asked again under the same placement is the same run; another placement is another run. */
export const runIdOf = (attemptId: string, callId: string, placement: number): string => `run-${createHash("sha256").update(`${attemptId}\0${callId}\0${placement}`).digest("hex").slice(0, 24)}`;

/** The digest the `run` message carries and the host checks the fetched order against. */
export const orderDigest = (order: RunOrderWire): string => createHash("sha256").update(stable(order)).digest("hex");

export class ScriptOrders {
  readonly #o: ScriptOrdersOptions;
  /** By attempt, then run ID. */
  readonly #runs = new Map<string, Map<string, Run>>();
  #closed = false;

  constructor(options: ScriptOrdersOptions) { this.#o = options; }

  /** The runs of an attempt this controller still waits for (by state), for tests and for the owner's look. */
  open(attemptId: string): readonly { readonly runId: string; readonly state: State; readonly placement: number }[] {
    return [...(this.#runs.get(attemptId)?.values() ?? [])].map((r) => ({ runId: r.runId, state: r.state, placement: r.placement }));
  }

  /**
   * Orders a run and waits for its outcome. The same run (same attempt, call and placement) asked again while it is open joins it. The order is checked against the protocol's bounds here, before anything is sent. The returned promise rejects with
   * the reason when the host reports a failure, the host's word does not come in time, the placement ends or is replaced, or `signal` aborts (the host is then told to stop; the run stays open until the host acknowledges, or its time is up).
   * `onRevoke` is handed the function that tells the host a revocation (`revoke`, with the owner's recorded choice).
   */
  async run(call: { readonly attemptId: string; readonly callId: string; readonly placement: number; readonly sessionId: string }, input: ScriptOrderInput, signal: AbortSignal, onRevoke?: (tell: (choice: "finish" | "cancel" | "pause") => void) => void): Promise<ScriptResult> {
    if (this.#closed) throw new DomainError("unavailable", "the controller is closing; the script was not ordered");
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("the call ended before the script was ordered");
    if (Buffer.byteLength(input.source, "utf8") > REMOTE_LIMITS.scriptSourceBytes) throw new DomainError("invalid_command", `the tool's executable is larger than ${REMOTE_LIMITS.scriptSourceBytes} bytes, which the worker protocol carries to a host`, { field: "source" });
    if (Buffer.byteLength(input.stdin, "utf8") > REMOTE_LIMITS.scriptStdinBytes) throw new DomainError("invalid_command", `the arguments are larger than ${REMOTE_LIMITS.scriptStdinBytes} bytes, which the worker protocol carries to a host`, { field: "input" });
    if (input.maxOutputBytes > REMOTE_LIMITS.scriptOutputBytes) throw new DomainError("invalid_command", "the output limit is larger than the worker protocol carries", { field: "maxOutputBytes" });
    const runId = runIdOf(call.attemptId, call.callId, call.placement);
    const mine = this.#runs.get(call.attemptId) ?? new Map<string, Run>();
    this.#runs.set(call.attemptId, mine);
    let run = mine.get(runId);
    let fresh = false;
    if (run === undefined) {
      if ([...mine.values()].filter((r) => r.state !== "aborting").length >= REMOTE_LIMITS.scriptRuns) throw new DomainError("unavailable", `this attempt already has ${REMOTE_LIMITS.scriptRuns} scripts running on its host; try again when one has ended`);
      const order: RunOrderWire = { runId, program: input.program, argv: [...input.argv], stdin: input.stdin, source: input.source, tool: { ...input.tool }, interpreterVersion: input.interpreterVersion, maxOutputBytes: input.maxOutputBytes, limits: { ...input.limits }, env: {} };
      let settle!: Run["settle"];
      const done = new Promise<ScriptResult>((resolve, reject) => { settle = { resolve, reject }; });
      done.catch(() => undefined);
      const deadlineMs = Math.max(1, input.limits.seconds) * 1000 + (this.#o.graceMs ?? REMOTE_LIMITS.scriptGraceMs);
      const created: Run = {
        runId, attemptId: call.attemptId, placement: call.placement, sessionId: call.sessionId, order, digest: orderDigest(order), state: "ordered", revoked: false, settle, result: done,
        timer: setTimeout(() => this.#expire(created), deadlineMs),
      };
      created.timer.unref?.();
      run = created; fresh = true;
      mine.set(runId, run);
    }
    const current = run;
    const waiting = current.result;
    if (fresh) {
      try { await this.#o.send(call.attemptId, call.placement, { kind: "run", runId, digest: current.digest }); } catch (error) {
        this.#drop(current);
        throw error instanceof DomainError ? error : new DomainError("unavailable", "the order could not be sent to the host");
      }
    }
    return await new Promise<ScriptResult>((resolve, reject) => {
      const onAbort = (): void => {
        const reason = signal.reason instanceof Error ? signal.reason : new Error("the call ended");
        // Not told again when a revocation already told the host to stop it; the run stays open until the host says it has stopped.
        if (!current.revoked && current.state !== "aborting") this.#abort(current);
        reject(reason);
      };
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener("abort", onAbort, { once: true });
      onRevoke?.((choice) => this.#revoke(current, choice));
      waiting.then((r) => { signal.removeEventListener("abort", onAbort); resolve(r); }, (e: unknown) => { signal.removeEventListener("abort", onAbort); reject(e instanceof Error ? e : new Error(String(e))); });
    });
  }

  /** The order the host fetches. Only for the run's own placement and session, and only while the controller still wants the run. */
  fetch(attemptId: string, placement: number, sessionId: string, runId: unknown): RunOrderWire {
    const run = this.#find(attemptId, placement, sessionId, runId);
    if (run === undefined || run.state === "aborting") throw new DomainError("not_found", "no such run, or it is no longer wanted");
    run.state = "fetched";
    return run.order;
  }

  /** The host's word on a run. A report for a run that is not open (settled, dropped, never ordered here) is not kept. The text is bounded by the order's own limit and nothing of it is kept anywhere but in the answer of the waiting call. */
  done(attemptId: string, placement: number, sessionId: string, runId: unknown, raw: unknown): RunAck {
    const outcome = checkOutcome(raw, 0);
    const run = this.#find(attemptId, placement, sessionId, runId);
    if (run === undefined) return { kept: false };
    if (outcome.state === "done" && Buffer.byteLength(outcome.text, "utf8") > run.order.maxOutputBytes) {
      this.#end(run, new Error(`the host's script wrote more than ${run.order.maxOutputBytes} bytes`));
      return { kept: true };
    }
    // A run being stopped ends as stopped, whatever the host reports: a call that joined it and is still waiting must not take an empty answer (or output that came in after the stop) as the tool's result.
    if (run.state === "aborting") { this.#end(run, new Error("the run was stopped before it ended")); return { kept: true }; }
    if (outcome.state === "done") this.#end(run, undefined, { text: outcome.text, ...(outcome.cpuMs === undefined ? {} : { cpuMs: outcome.cpuMs }), ...(outcome.memoryMb === undefined ? {} : { memoryMb: outcome.memoryMb }) });
    else if (outcome.state === "failed") this.#end(run, new Error(redactText(outcome.error).slice(0, REMOTE_LIMITS.scriptErrorChars)));
    else this.#end(run, new Error("the host stopped the run"));
    return { kept: true };
  }

  /** The placement ended, completed or moved: every run of it is over for the call that waits (the host is fenced, and ends its processes itself). */
  end(attemptId: string, placement: number, reason: string): void {
    for (const run of [...(this.#runs.get(attemptId)?.values() ?? [])]) if (run.placement === placement) this.#end(run, new DomainError("unavailable", `the host's run was ended: ${reason.slice(0, 200) || "the placement ended"}`));
  }

  close(): void {
    this.#closed = true;
    for (const mine of [...this.#runs.values()]) for (const run of [...mine.values()]) this.#end(run, new DomainError("unavailable", "the controller is closing"));
  }

  #find(attemptId: string, placement: number, sessionId: string, runId: unknown): Run | undefined {
    if (typeof runId !== "string" || !RUN_ID.test(runId)) throw new DomainError("invalid_command", "runId: is not a run ID", { field: "runId" });
    const run = this.#runs.get(attemptId)?.get(runId);
    if (run === undefined) return undefined;
    // A run of another placement or session is not this holder's: it is not shown, and not settled by it.
    if (run.placement !== placement || run.sessionId !== sessionId) return undefined;
    return run;
  }

  #abort(run: Run): void {
    run.state = "aborting";
    void this.#o.send(run.attemptId, run.placement, { kind: "abort", runId: run.runId }).catch((error: unknown) => this.#error(error));
  }

  #revoke(run: Run, choice: "finish" | "cancel" | "pause"): void {
    if (choice !== "finish") { run.revoked = true; run.state = "aborting"; }
    void this.#o.send(run.attemptId, run.placement, { kind: "revoke", name: run.order.tool.name, version: run.order.tool.version, choice }).catch((error: unknown) => this.#error(error));
  }

  #expire(run: Run): void {
    // The host did not say in time (a partition, a host that went away): the call fails, and the owner's records say the stop was never confirmed.
    this.#error(new Error(`host did not report run ${run.runId} in time${run.state === "aborting" ? " (stop not confirmed)" : ""}`));
    if (run.state !== "aborting") this.#abort(run);
    this.#end(run, new DomainError("unavailable", "the host did not report the run in time"));
  }

  #error(error: unknown): void { try { this.#o.onError?.(error); } catch { /* ignored */ } }

  #drop(run: Run): void {
    clearTimeout(run.timer);
    const mine = this.#runs.get(run.attemptId);
    mine?.delete(run.runId);
    if (mine !== undefined && mine.size === 0) this.#runs.delete(run.attemptId);
  }

  #end(run: Run, error?: Error, result?: ScriptResult): void {
    this.#drop(run);
    if (error !== undefined) run.settle.reject(error); else run.settle.resolve(result ?? { text: "" });
  }
}

/** A run outcome as the host sent it, field by field; nothing is kept that was not asked for. `maxBytes` is not applied here (the order's own limit is, by the caller). */
export function checkOutcome(raw: unknown, maxBytes: number): RunOutcomeWire {
  void maxBytes;
  const bad = (m: string): never => { throw new DomainError("invalid_command", `outcome: ${m}`, { field: "outcome" }); };
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return bad("must be an object");
  const r = raw as Record<string, unknown>;
  const only = (known: readonly string[]): void => { for (const k of Object.keys(r)) if (!known.includes(k)) bad(`${k.slice(0, 30)} is not a field of an outcome`); };
  const figure = (v: unknown, name: string): number | undefined => (v === undefined ? undefined : typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= 1_000_000_000 ? v : bad(`${name} must be a whole number`));
  switch (r["state"]) {
    case "done": {
      only(["state", "text", "cpuMs", "memoryMb"]);
      if (typeof r["text"] !== "string" || r["text"].length > REMOTE_LIMITS.scriptBytes) return bad("text must be the script's standard output");
      const cpuMs = figure(r["cpuMs"], "cpuMs"), memoryMb = figure(r["memoryMb"], "memoryMb");
      return { state: "done", text: r["text"], ...(cpuMs === undefined ? {} : { cpuMs }), ...(memoryMb === undefined ? {} : { memoryMb }) };
    }
    case "failed": {
      only(["state", "error"]);
      if (typeof r["error"] !== "string" || r["error"].length < 1 || r["error"].length > 4000) return bad("error must be text of 1 to 4000 characters");
      return { state: "failed", error: r["error"] };
    }
    case "aborted": {
      only(["state", "choice"]);
      if (r["choice"] !== undefined && r["choice"] !== "cancel" && r["choice"] !== "pause") return bad("choice must be cancel or pause");
      return { state: "aborted", ...(r["choice"] === undefined ? {} : { choice: r["choice"] }) };
    }
    default: return bad("state must be done, failed or aborted");
  }
}
