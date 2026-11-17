import { REMOTE_LIMITS, type RemoteWorkspaceAnswer, type WorkspaceAsk } from "./protocol.js";
import type { RemoteWorkerClient } from "./client.js";
import type { WorkspacePort } from "../workspace-ops/workspace-ops.js";
import type { DoneCheckReport, DoneCheckRequest } from "../dispatch/ports.js";
import type { JsonObject } from "../storage/types.js";
import type { Observation } from "../dependencies/dependencies.js";

/**
 * The remote worker's side of workspace requests (card H12m): takes the requests the poller read, hands each to the host's workspace port (the worker package's `WorkspaceHost.run`) in the background, and sends the answer back.
 * A request already being carried out here is not started twice (the poll lists it until it is answered); an answer that could not be sent is kept and sent again at the next listing, without running the request again. The
 * port itself carries a request ID out once (its journal), so a restart of this process between the work and the answer gives the same recorded answer, not a second run. Requests are run one after another.
 *
 * `busy` (card H12t) is required: the attempts with a call or model call in flight on this host (`LocalWorker.busyAttempts`). A responder without it is refused at construction, so a remote worker cannot start answering
 * workspace requests without saying which attempts are busy. Just before a request is handed to the port, the responder asks it: a request whose attempts to be quiet include a busy one is refused (nothing is run; the
 * controller asks again later), and a busy check that throws refuses it too (fail closed). The port's own busy check (`LocalWorkspaces`' `busy`) still applies after this one.
 */
/** How a host looks again at a task's recorded files (card L04e): what each is now, for the ones it could read. */
export type ResponderObserve = (scope: { readonly taskId: string; readonly projectId: string }, entries: readonly { readonly id: string; readonly kind: "file" | "directory"; readonly key: string }[], paths: readonly string[]) => Promise<Readonly<Record<string, Observation>>>;

export class WorkspaceResponder {
  readonly #client: Pick<RemoteWorkerClient, "answerWorkspace">;
  readonly #port: WorkspacePort;
  readonly #onError: ((error: unknown) => void) | undefined;
  readonly #running = new Set<string>();
  readonly #unsent = new Map<string, RemoteWorkspaceAnswer>();
  readonly #withdrawn = new Set<string>();
  readonly #now: () => number;
  readonly #busy: () => readonly string[] | Promise<readonly string[]>;
  readonly #verify: ((attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest) => Promise<DoneCheckReport>) | undefined;
  readonly #piState: { answer(ask: WorkspaceAsk): Promise<RemoteWorkspaceAnswer> } | undefined;
  readonly #observe: ResponderObserve | undefined;
  #tail: Promise<void> = Promise.resolve();

  constructor(options: { readonly client: Pick<RemoteWorkerClient, "answerWorkspace">; readonly port: WorkspacePort; readonly busy: () => readonly string[] | Promise<readonly string[]>; readonly onError?: (error: unknown) => void; readonly now?: () => number; /** The host's check of an attempt's done (card H12a): the worker package's `doneVerifier` over this host's checkouts and sandbox. Absent: a check is refused, so the controller does not count the done. */ readonly verify?: (attemptId: string, scope: { readonly taskId: string; readonly projectId: string }, request: DoneCheckRequest) => Promise<DoneCheckReport>; /** The host's answer to a request to send or put back its conversation stores (card K01i): a `PiStateHost`. Absent: such a request is refused, saying so. */ readonly piState?: { answer(ask: WorkspaceAsk): Promise<RemoteWorkspaceAnswer> }; /** The host's look at files and directories a task relied on (card L04e): `observeEntries` over the task's checkout on this host. Absent: the request is refused, saying so, and the controller reads the files as unknown. */ readonly observe?: ResponderObserve }) {
    if (typeof (options as { busy?: unknown }).busy !== "function") throw new TypeError("a workspace responder needs the host's busy check (which attempts have a call in flight here); without it no workspace request is answered");
    this.#busy = options.busy;
    this.#verify = options.verify;
    this.#piState = options.piState;
    this.#observe = options.observe;
    this.#now = options.now ?? Date.now;
    this.#client = options.client; this.#port = options.port; this.#onError = options.onError;
  }

  /** Starts the requests not already in hand and returns at once. */
  handle(requests: readonly WorkspaceAsk[], withdrawn: readonly string[] = []): void {
    // A request the controller gave up on is dropped if it has not started; one already running cannot be stopped here, and its answer is accepted and dropped there.
    for (const id of withdrawn) { this.#withdrawn.add(id); this.#unsent.delete(id); }
    if (this.#withdrawn.size > 500) this.#withdrawn.delete(this.#withdrawn.values().next().value as string);
    for (const ask of requests) {
      const unsent = this.#unsent.get(ask.requestId);
      if (unsent !== undefined) { void this.#send(ask.requestId, unsent); continue; }
      if (this.#running.has(ask.requestId) || this.#withdrawn.has(ask.requestId)) continue;
      this.#running.add(ask.requestId);
      this.#tail = this.#tail.then(() => this.#carryOut(ask), () => this.#carryOut(ask));
    }
  }

  /** Waits until everything handed in so far has been answered or has failed (for tests and for a clean stop). */
  async idle(): Promise<void> { await this.#tail; }

  async #carryOut(ask: WorkspaceAsk): Promise<void> {
    let answer: RemoteWorkspaceAnswer;
    // Waiting behind a long request is where a request goes stale: the controller may have stopped waiting and freed the agent meanwhile. The host checks the deadline again before it starts.
    if (this.#withdrawn.has(ask.requestId)) { this.#running.delete(ask.requestId); return; }
    if (ask.expiresAt !== undefined && this.#now() >= Date.parse(ask.expiresAt)) { this.#running.delete(ask.requestId); return; }
    // The check of an attempt's done (card H12a) changes nothing and is asked while the attempt is live at its end, so it is not held back by the busy check (the attempt asking is itself in a call); it runs checks only in that attempt's own sandbox.
    if (ask.operation === "verify") {
      await this.#send(ask.requestId, await this.#check(ask));
      this.#running.delete(ask.requestId);
      return;
    }
    // A look at a task's recorded files (card L04e) changes nothing and is asked before an attempt resumes, so it is not held back by the busy check either.
    if (ask.operation === "observe") {
      await this.#send(ask.requestId, await this.#look(ask));
      this.#running.delete(ask.requestId);
      return;
    }
    // The conversation stores (card K01i): copied and sent for a backup, or fetched and put back after a restore. The host's own `PiStateHost` judges it (a store whose agent is running is not replaced), so the quiet-attempts check below does not apply.
    if (ask.operation === "pi-state-send" || ask.operation === "pi-state-restore" || ask.operation === "pi-thinking-purge") {
      let answered: RemoteWorkspaceAnswer;
      try { answered = this.#piState === undefined ? { ok: false, reason: "this host keeps no conversation stores in backups (it was started without a Pi state handler), so nothing was done" } : await this.#piState.answer(ask); } catch (error) { answered = { ok: false, reason: `this host could not finish the request: ${String((error as Error)?.message ?? error).slice(0, 300)}`, failed: true }; }
      await this.#send(ask.requestId, answered);
      this.#running.delete(ask.requestId);
      return;
    }
    // Fail closed: a check that throws, or answers anything but a list of attempt IDs, refuses the request (and the request is still answered, so it is not left in hand here forever).
    let inFlight: readonly string[] | undefined;
    try {
      const busy: unknown = await this.#busy();
      const quiet: unknown = ask.quietAttempts;
      inFlight = Array.isArray(busy) && Array.isArray(quiet) ? (quiet as string[]).filter((id) => (busy as unknown[]).includes(id)) : undefined;
    } catch { inFlight = undefined; }
    if (inFlight === undefined || inFlight.length > 0) {
      await this.#send(ask.requestId, { ok: false, reason: inFlight === undefined ? "this host could not say which attempts have a call in flight, so the request was not carried out" : `an attempt of the task still has a call in flight on this host (${inFlight.slice(0, 3).join(", ")}), so the request was not carried out; ask again when it is quiet` });
      this.#running.delete(ask.requestId);
      return;
    }
    try { answer = await this.#port.run({ ...ask, operation: ask.operation, quietAttempts: [...ask.quietAttempts] }); } catch (error) {
      // The work may be half done: this is told as a failure (`failed`, recorded as such by the controller, never as a clean refusal), and the port's journal refuses to run the request again.
      answer = { ok: false, reason: `the host could not finish the request and may have done part of it: ${String((error as Error)?.message ?? error).slice(0, 300)}`, failed: true };
    }
    await this.#send(ask.requestId, answer);
    this.#running.delete(ask.requestId);
  }

  /**
   * The host's look at the files and directories a request names, as an answer: for each one it could read, what it is now (`exists`, a file's `hash`, a directory's `members`); one it could not read, or may not read (outside the checkout, beyond the
   * project's paths, too large), is left out. The answer is bounded: the entries that do not fit are named in `later` so the controller asks again for them. No content and no path of this host is in it, and a failure says only that the look
   * did not happen.
   */
  async #look(ask: WorkspaceAsk): Promise<RemoteWorkspaceAnswer> {
    const o = ask.observe;
    if (this.#observe === undefined) return { ok: false, reason: "this host cannot look at a task's files (it was started without one), so they were not looked at" };
    if (o === undefined || !Array.isArray(o.entries)) return { ok: false, reason: "the request named nothing to look at" };
    let seen: Readonly<Record<string, Observation>>;
    try { seen = await this.#observe({ taskId: ask.taskId, projectId: ask.projectId }, o.entries, o.paths ?? []); } catch (error) {
      return { ok: false, reason: `this host could not look at the files: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
    }
    const observed: Record<string, JsonObject> = {};
    const later: string[] = [];
    // Room is kept for naming every entry that does not fit, so the answer as a whole stays within the limit.
    let bytes = 100 + o.entries.reduce((n, e) => n + String(e.id).length + 4, 0);
    for (const e of [...o.entries].sort((a, b) => (a.id < b.id ? -1 : 1))) {
      const got = Object.hasOwn(seen, e.id) ? seen[e.id] : undefined;
      if (got === undefined || got === null || typeof got.exists !== "boolean") continue;
      const one: JsonObject = got.exists ? (e.kind === "file" ? (typeof got.hash === "string" ? { exists: true, hash: got.hash } : {}) : (Array.isArray(got.members) ? { exists: true, members: [...got.members].sort() } : {})) : { exists: false };
      if (Object.keys(one).length === 0) continue;
      const size = Buffer.byteLength(JSON.stringify({ [e.id]: one }), "utf8") + 2;
      if (bytes + size > REMOTE_LIMITS.workspaceDetailBytes) { later.push(e.id); continue; }
      bytes += size;
      observed[e.id] = one;
    }
    return { ok: true, summary: "looked", detail: { observed, ...(later.length === 0 ? {} : { later }) } };
  }

  /** The host's report of a done check as an answer: the report, cut to fit the answer's limit (a check's output is cut to its end, then dropped), or a refusal that says why. Never a pass the host did not find. */
  async #check(ask: WorkspaceAsk): Promise<RemoteWorkspaceAnswer> {
    const v = ask.verify;
    if (this.#verify === undefined) return { ok: false, reason: "this host cannot check work (it was started without a check of a done), so the work was not checked" };
    if (v === undefined) return { ok: false, reason: "the request named nothing to check" };
    let report: DoneCheckReport;
    try { report = await this.#verify(v.attemptId, { taskId: ask.taskId, projectId: ask.projectId }, { checks: v.checks, evidence: v.evidence, maxOutputBytes: v.maxOutputBytes }); } catch (error) {
      return { ok: false, reason: `this host could not check the work: ${String((error as Error)?.message ?? error).slice(0, 300)}` };
    }
    // A verifier that answers something that is not a report is a failed check, not a crash that leaves the request in hand (the controller reshapes and bounds the report again).
    try {
      if (report === null || typeof report !== "object" || !Array.isArray(report.checks)) throw new TypeError("the check gave no report");
      for (const keep of [600, 150, 0]) {
        const cut = { ...report, checks: report.checks.map((c) => ({ ...c, ...(typeof c.output === "string" ? { output: c.output.slice(Math.max(0, c.output.length - keep)) } : {}), ...(typeof c.reason === "string" ? { reason: c.reason.slice(0, 200) } : {}) })) };
        const detail = JSON.parse(JSON.stringify(cut)) as JsonObject;
        if (Buffer.byteLength(JSON.stringify(detail), "utf8") <= REMOTE_LIMITS.workspaceDetailBytes) return { ok: true, summary: "checked", detail };
      }
      // Last: only what the verdict is decided by (each check's state and exit, the tree's counts, each evidence path's presence). The names of uncommitted files, the reasons and the output are words for the agent, and a
      // large but honest report (long reasons, long file names) must still come back rather than leave a done that can never be checked.
      const bare = {
        checkout: report.checkout,
        ...(report.tree === undefined || report.tree === null ? {} : { tree: { ...report.tree, uncommitted: [] } }),
        ...(report.evidence === undefined ? {} : { evidence: report.evidence.map((e) => ({ path: e.path, present: e.present })) }),
        checks: report.checks.map((c) => ({ name: c.name, state: c.state, ...(c.exitCode === undefined ? {} : { exitCode: c.exitCode }), ...(c.timedOut === true ? { timedOut: true } : {}) })),
      };
      const detail = JSON.parse(JSON.stringify(bare)) as JsonObject;
      if (Buffer.byteLength(JSON.stringify(detail), "utf8") <= REMOTE_LIMITS.workspaceDetailBytes) return { ok: true, summary: "checked", detail };
    } catch (error) { return { ok: false, reason: `this host could not check the work: ${String((error as Error)?.message ?? error).slice(0, 300)}` }; }
    return { ok: false, reason: "the report of the check did not fit in an answer, so the work was not checked" };
  }

  async #send(requestId: string, answer: RemoteWorkspaceAnswer): Promise<void> {
    try { await this.#client.answerWorkspace(requestId, answer); this.#unsent.delete(requestId); } catch (error) {
      this.#unsent.set(requestId, answer);
      if (this.#unsent.size > 100) this.#unsent.delete(this.#unsent.keys().next().value as string);
      this.#onError?.(error);
    }
  }
}
