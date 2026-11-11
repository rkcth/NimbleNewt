import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { MAINTENANCE_SERVICE, type EnvironmentManifest, type EnvironmentService, type RevisionBody } from "../environments/index.js";
import type { PauseScope, PauseService, ObservedState, Boundary } from "../lifecycle/pause.js";
import type { StopService } from "../lifecycle/stop.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { ApplyOutcome, MaintenanceApplier, MaintenanceView, RevertOutcome } from "./maintenance.js";

/**
 * The real applier of reviewed environment changes (card A09). It carries an approved package or extension request through the sequence the card names: stage a new environment revision, try it in a disposable
 * environment, suspend the agent without releasing it (checkpoint), reload the worker on the new revision, activate the revision, validate it (session and compaction state intact), and put the agent's earlier
 * Pause or Suspend intent back as it was. A revision that does not load or validate is rolled back (a new revision made from the previous manifest, activated after the worker is reloaded on it), and the agent
 * goes back to what it was doing. When a safe suspension or a reload is not possible the answer is `unsupported`: nothing was changed and the request stays pending.
 *
 * What the host must provide is the `EnvironmentRuntime` port (it fetches and verifies the artifact, runs the disposable trial, reloads a worker on a manifest and checks it). The controller side (revisions,
 * pause gate, suspension, journal of progress) is real code here. The applier is idempotent by request ID: progress is journalled before each step, so a repeat after a crash resumes at the step reached
 * and the agent's prior intent is read from the journal, never from a gate this applier has already changed.
 */
export interface TrialInput {
  readonly requestId: string; readonly agentId: string; readonly kind: "package" | "extension";
  readonly artifact: { readonly name: string; readonly version: string; readonly digest: string; readonly source: string };
  /** The requester's claim. False: every install and lifecycle script is switched off. True: scripts run, inside the boundary only. */
  readonly installScripts: boolean;
  readonly candidate: EnvironmentManifest;
}
export type TrialResult =
  | { readonly ok: true; /** The fetched artifact's content matched `artifact.digest` before anything was installed. */ readonly digestVerified: boolean; /** The artifact declares install or lifecycle scripts. */ readonly scriptsDeclared: boolean; /** A script actually ran during the trial. */ readonly scriptsRan: boolean; readonly notes?: string }
  | { readonly ok: false; readonly reason: string };
export interface ReloadInput { readonly requestId: string; readonly agentId: string; readonly revision: number; readonly manifest: EnvironmentManifest; /** The checkpoint of the suspension, to restore the session from. */ readonly checkpointId: string }
export type ReloadResult = { readonly ok: true; /** The digest of each protected extension the worker found where it loads them (as `EnvironmentService.activate` takes them). */ readonly observed: Readonly<Record<string, string>> } | { readonly ok: false; readonly reason: string };
export interface ValidateInput extends ReloadInput { }
export type ValidateResult = { readonly ok: true; readonly sessionIntact: boolean; readonly compactionIntact: boolean } | { readonly ok: false; readonly reason: string };
export interface EnvironmentRuntime {
  trial(input: TrialInput): Promise<TrialResult>;
  reload(input: ReloadInput): Promise<ReloadResult>;
  validate(input: ValidateInput): Promise<ValidateResult>;
}

type Phase = "staged" | "suspended" | "activated" | "validated" | "restored" | "done" | "failed";
export interface JournalBody {
  readonly agentId: string; readonly previousRevision: number; readonly stagedRevision: number;
  /** What the agent's scope was before this applier touched it. */
  readonly prior: { readonly paused: boolean; readonly state?: ObservedState; readonly boundary?: Boundary };
  /** The pause request this applier made (absent when the agent was already paused: that hold is not ours to lift). */
  readonly ownHold?: string;
  readonly checkpointId?: string;
  /** Suspensions asked for and not finished (each try is a request of its own, so a repeat never replays a cancelled one). */
  readonly suspends?: number;
  readonly phase: Phase;
  /** Set when the change was rolled back: why, and the revision that is active again. */
  readonly failure?: { readonly reason: string; readonly activeRevision: number };
  readonly effect?: JsonObject;
}
export interface ApplierJournal { read(key: string): Promise<JournalBody | undefined>; write(key: string, body: JournalBody): Promise<void> }
export class MemoryJournal implements ApplierJournal {
  readonly entries = new Map<string, JournalBody>();
  async read(key: string): Promise<JournalBody | undefined> { return this.entries.get(key); }
  async write(key: string, body: JournalBody): Promise<void> { this.entries.set(key, body); }
}
/** The journal kept in the controller's storage (kind `maintenance-journal`), one record per request, written under a revision check. */
export class StorageJournal implements ApplierJournal {
  readonly #runner: CommandRunner;
  readonly #storage: ControllerStorage;
  constructor(storage: ControllerStorage, epoch: number, options: RunnerOptions) { this.#runner = new CommandRunner(storage, epoch, options); this.#storage = storage; }
  async read(key: string): Promise<JournalBody | undefined> { return (await this.#storage.getAggregate({ kind: "maintenance-journal", id: key }))?.body as unknown as JournalBody | undefined; }
  async write(key: string, body: JournalBody): Promise<void> {
    const ref = { kind: "maintenance-journal", id: key };
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
    await this.#runner.command("maintenance.journal", { commandId: `mnt-jrn:${key}:${digest}`, actor: MAINTENANCE_SERVICE }, async () => ({
      payload: { key, digest },
      build: async () => {
        const found = await this.#storage.getAggregate(ref);
        return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body: body as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { key, phase: body.phase } };
      },
    }));
  }
}

export interface EnvironmentApplierDeps {
  readonly environments: Pick<EnvironmentService, "get" | "change" | "activate" | "rollback">;
  readonly pauses: Pick<PauseService, "gate" | "resumeOwnHold" | "observe">;
  readonly stops: Pick<StopService, "request" | "advance">;
  readonly runtime: EnvironmentRuntime;
  readonly journal: ApplierJournal;
  /** The identity the changes are made as. Defaults to the maintenance service identity (with the right to control an agent's lifecycle). */
  readonly by?: Principal;
  /** The suspension deadline in milliseconds (default one minute). */
  readonly suspendMs?: number;
}
export const MAINTENANCE_PRINCIPAL: Principal = { id: MAINTENANCE_SERVICE, kind: "service", name: "maintenance", grants: [{ action: "agent.manage", project: "*" }], restrictions: [], asOf: "2026-11-11T00:00:00.000Z" };

const scopeOf = (agentId: string): PauseScope => ({ kind: "agent", id: agentId.replace(/^agent:/, "") });
const say = (e: unknown): string => redactText(e instanceof Error ? e.message : String(e)).slice(0, 300);
/** The marker a staged revision carries in its reason, so a repeat finds the revision it made (and a reader sees why it exists). */
const marker = (id: string): string => `maintenance ${id}:`;

export class EnvironmentChangeApplier implements MaintenanceApplier {
  readonly #d: EnvironmentApplierDeps;
  readonly #by: Principal;
  constructor(deps: EnvironmentApplierDeps) { this.#d = deps; this.#by = deps.by ?? MAINTENANCE_PRINCIPAL; }

  async apply(view: MaintenanceView): Promise<ApplyOutcome> {
    if (view.kind === "skill") return { outcome: "applied", effect: { recordedOnly: true, note: "a skill draft is recorded; it changes no environment until it is published through the catalog" } };
    if (view.kind !== "package" && view.kind !== "extension") return { outcome: "unsupported", reason: `${view.kind} changes are not part of an environment revision; they are applied by the sandbox policy and stay pending here` };
    const agentId = view.agentId;
    let j = await this.#d.journal.read(view.id);
    if (j?.phase === "done" && j.effect !== undefined) return { outcome: "applied", effect: j.effect };
    if (j?.phase === "failed" && j.failure !== undefined) return { outcome: "failed", reason: j.failure.reason, rollback: { activeRevision: j.failure.activeRevision, restored: true } };
    if (j === undefined) {
      const staged = await this.#stage(view);
      if ("outcome" in staged) return staged;
      j = staged.journal;
    }
    const rev = await this.#revision(agentId, j.stagedRevision);
    if (rev === undefined) throw new Error(`staged revision ${j.stagedRevision} of ${agentId} is missing`);
    const input = (checkpointId: string, revision: RevisionBody): ReloadInput => ({ requestId: view.id, agentId, revision: revision.revision, manifest: revision.manifest, checkpointId });

    // Suspend without release, with a checkpoint (or answer `unsupported` and change nothing).
    if (j.phase === "staged") {
      const s = await this.#suspend(view.id, agentId, j);
      if ("unsupported" in s) return { outcome: "unsupported", reason: s.unsupported };
      j = s.journal;
    }
    const checkpointId = j.checkpointId!;
    let problem: string | undefined;
    if (j.phase === "suspended") {
      const reloaded = await this.#d.runtime.reload(input(checkpointId, rev));
      if (!reloaded.ok) problem = `the worker could not be reloaded on revision ${rev.revision}: ${redactText(reloaded.reason).slice(0, 200)}`;
      else {
        try { await this.#d.environments.activate(this.#by, { commandId: `mnt:${view.id}:act`, agentId, revision: rev.revision, observed: reloaded.observed }); j = await this.#save(view.id, { ...j, phase: "activated" }); }
        catch (error) { if (error instanceof DomainError && error.code === "integrity") problem = error.message; else throw error; }
      }
    }
    if (problem === undefined && j.phase === "activated") {
      const checked = await this.#d.runtime.validate(input(checkpointId, rev));
      if (!checked.ok) problem = `validation failed: ${redactText(checked.reason).slice(0, 200)}`;
      else if (!checked.sessionIntact || !checked.compactionIntact) problem = `validation failed: ${!checked.sessionIntact ? "the session was not intact" : "the compaction state was not intact"} after the reload`;
      else j = await this.#save(view.id, { ...j, phase: "validated" });
    }
    if (problem !== undefined) return this.#rollBack(view, view.id, j, problem);

    const restored = j.phase === "restored" || j.phase === "done" ? "already restored" : await this.#restore(view.id, agentId, j);
    if (j.phase === "validated") j = await this.#save(view.id, { ...j, phase: "restored" });
    const effect: JsonObject = { environmentRevision: rev.revision, previousRevision: j.previousRevision, digest: rev.digest, checkpointId, restoredIntent: restored, trial: "passed" };
    await this.#save(view.id, { ...j, phase: "done", effect });
    return { outcome: "applied", effect };
  }

  /** Takes the change back: the agent's previous revision is made current again by the same sequence (suspend, reload, activate, validate, restore). */
  async revert(view: MaintenanceView, effect: JsonObject): Promise<RevertOutcome> {
    if (view.kind === "skill") return { outcome: "reverted", effect: { recordedOnly: true } };
    if (view.kind !== "package" && view.kind !== "extension") return { outcome: "unsupported", reason: `${view.kind} changes were never applied by this applier` };
    const j = await this.#d.journal.read(view.id);
    if (j === undefined) return { outcome: "reverted", effect: { nothingToUndo: true } };
    if (j.phase === "failed") return { outcome: "reverted", effect: { alreadyRolledBack: true, activeRevision: j.failure?.activeRevision ?? j.previousRevision } };
    if (j.phase === "staged") return { outcome: "reverted", effect: { nothingToUndo: true, note: "the staged revision was never activated and the worker was never touched" } };
    void effect;
    let target = j, key = view.id;
    if (j.phase === "restored" || j.phase === "done") {
      // The agent runs again: suspend it once more (its intent now is what it is to be given back), then undo.
      key = `${view.id}:revert`;
      let again = await this.#d.journal.read(key);
      if (again?.phase === "failed") return { outcome: "reverted", effect: { alreadyRolledBack: true, activeRevision: again.failure?.activeRevision ?? j.previousRevision } };
      if (again === undefined) {
        const gate = await this.#d.pauses.gate(this.#by, scopeOf(view.agentId));
        const prior: JournalBody["prior"] = { paused: gate?.intent === "pause", ...(gate?.observed?.state === undefined ? {} : { state: gate.observed.state }), ...(gate?.observed?.boundary === undefined ? {} : { boundary: gate.observed.boundary }) };
        again = await this.#save(key, { agentId: view.agentId, previousRevision: j.previousRevision, stagedRevision: j.stagedRevision, prior, phase: "staged" });
      }
      if (again.phase === "staged") { const s = await this.#suspend(key, view.agentId, again); if ("unsupported" in s) return { outcome: "unsupported", reason: s.unsupported }; again = s.journal; }
      target = again;
    }
    const out = await this.#rollBack(view, key, target, "the change was revoked", true);
    return out.outcome === "failed" ? { outcome: "reverted", effect: { activeRevision: out.rollback?.["activeRevision"] ?? j.previousRevision, restoredIntent: out.rollback?.["restoredIntent"] ?? null } } : { outcome: "unsupported", reason: (out as { reason: string }).reason };
  }

  // ---- steps ---------------------------------------------------------------------------------------------------------------

  async #revision(agentId: string, n: number): Promise<RevisionBody | undefined> { return (await this.#d.environments.get(this.#by, agentId, n))?.revision; }
  async #save(id: string, body: JournalBody): Promise<JournalBody> { await this.#d.journal.write(id, body); return body; }

  /** Builds the candidate manifest, tries it in the disposable environment and stages it as a new (inactive) revision. Nothing live is touched. */
  async #stage(view: MaintenanceView): Promise<{ journal: JournalBody } | ApplyOutcome> {
    const agentId = view.agentId;
    const env = await this.#d.environments.get(this.#by, agentId);
    if (env?.active === undefined) return { outcome: "unsupported", reason: `${agentId} has no active environment revision to change` };
    const spec = view.spec as { name: string; version: string; digest: string; source: string; installScripts: boolean };
    const base = env.active.manifest;
    // A repeat after a crash between staging and the journal write finds the revision it already made.
    let staged: number | undefined;
    for (let n = env.latest; n > Math.max(0, env.latest - 10); n--) { const r = await this.#revision(agentId, n); if (r !== undefined && r.reason.startsWith(marker(view.id))) { staged = n; break; } }
    const kept = base.packages.filter((p) => p.name !== spec.name);
    const same = base.packages.find((p) => p.name === spec.name && p.version === spec.version && p.digest === spec.digest);
    if (staged === undefined && same !== undefined) return { outcome: "applied", effect: { unchanged: true, environmentRevision: env.active.revision, note: "the environment already has exactly this package" } };
    const candidate: EnvironmentManifest = { ...base, packages: [...kept, { name: spec.name, version: spec.version, digest: spec.digest }] };
    if (staged === undefined) {
      let trial: TrialResult;
      try { trial = await this.#d.runtime.trial({ requestId: view.id, agentId, kind: view.kind as "package" | "extension", artifact: { name: spec.name, version: spec.version, digest: spec.digest, source: spec.source }, installScripts: spec.installScripts, candidate }); }
      catch (error) { return { outcome: "unsupported", reason: `the disposable trial environment is not available: ${say(error)}` }; }
      if (!trial.ok) return { outcome: "failed", reason: `the trial in a disposable environment failed: ${redactText(trial.reason).slice(0, 250)}`, rollback: { nothingChanged: true } };
      if (!trial.digestVerified) return { outcome: "failed", reason: "digest mismatch: the fetched artifact was not verified against the approved digest; nothing was installed", rollback: { nothingChanged: true } };
      if (!spec.installScripts && (trial.scriptsDeclared || trial.scriptsRan)) return { outcome: "failed", reason: "the artifact declares or runs install scripts but the request said it has none; the approval did not cover scripts and nothing was installed", rollback: { nothingChanged: true } };
      try {
        const made = await this.#d.environments.change(this.#by, { commandId: `mnt:${view.id}:stage`, agentId, manifest: candidate, reason: `${marker(view.id)} ${view.kind} ${spec.name}@${spec.version} (was revision ${env.active.revision})`, expectedRevision: env.latest });
        staged = made.revision;
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) throw error; // the environment moved: the claim is repeated and starts again
        return { outcome: "failed", reason: `the revision could not be staged: ${say(error)}`, rollback: { nothingChanged: true } };
      }
    }
    const gate = await this.#d.pauses.gate(this.#by, scopeOf(agentId));
    const prior: JournalBody["prior"] = { paused: gate?.intent === "pause", ...(gate?.observed?.state === undefined ? {} : { state: gate.observed.state }), ...(gate?.observed?.boundary === undefined ? {} : { boundary: gate.observed.boundary }) };
    const journal: JournalBody = { agentId, previousRevision: env.active.revision, stagedRevision: staged, prior, phase: "staged" };
    await this.#d.journal.write(view.id, journal);
    return { journal };
  }

  /** Suspends the agent (no release) and reads the checkpoint. A suspension that cannot be made safely changes nothing and leaves the change pending. */
  async #suspend(key: string, agentId: string, j: JournalBody): Promise<{ journal: JournalBody } | { unsupported: string }> {
    const scope = scopeOf(agentId);
    const tries = j.suspends ?? 0;
    let done;
    try {
      const asked = await this.#d.stops.request(this.#by, { commandId: `mnt:${key}:stop${tries}`, scope, mode: "suspend", reason: `maintenance ${key}: environment change`, deadlineMs: this.#d.suspendMs ?? 60_000 });
      done = await this.#d.stops.advance(this.#by, { intentId: asked.intentId });
    } catch (error) { await this.#save(key, { ...j, suspends: tries + 1 }); return { unsupported: `the agent could not be suspended safely: ${say(error)}` }; }
    const gate = await this.#d.pauses.gate(this.#by, scope);
    const ownHold = j.prior.paused ? undefined : gate?.requestId;
    if (done.phase !== "done" || done.outcome?.state !== "suspended" || done.prepared === undefined) {
      const why = done.blocked?.reason ?? `the suspension ended as ${done.outcome?.state ?? done.phase}`;
      if (ownHold !== undefined) { await this.#lift(key, agentId, ownHold, "the suspension for an environment change did not finish; nothing was changed"); await this.#d.stops.advance(this.#by, { intentId: done.id }).catch(() => undefined); }
      await this.#save(key, { ...j, suspends: tries + 1 });
      return { unsupported: `the agent could not be suspended safely (${redactText(why).slice(0, 200)}); nothing was changed` };
    }
    const journal = await this.#save(key, { ...j, phase: "suspended", checkpointId: done.prepared.checkpointId, ...(ownHold === undefined ? {} : { ownHold }) });
    return { journal };
  }

  async #lift(key: string, agentId: string, ownHold: string, reason: string): Promise<boolean> {
    try { await this.#d.pauses.resumeOwnHold(this.#by, { commandId: `mnt:${key}:resume:${ownHold}`, scope: scopeOf(agentId), reason, requestId: ownHold }); return true; }
    catch (error) {
      if (!(error instanceof DomainError && error.code === "invalid_command")) throw error;
      // Already lifted (a repeat) counts as lifted; a pause somebody made since is theirs and stays.
      return (await this.#d.pauses.gate(this.#by, scopeOf(agentId)))?.intent !== "pause";
    }
  }

  /** Puts the agent's earlier Pause or Suspend intent back: a hold this applier made is lifted, a hold somebody else had stays (with the state it was observed in). */
  async #restore(key: string, agentId: string, j: JournalBody): Promise<string> {
    const scope = scopeOf(agentId);
    if (!j.prior.paused) {
      const lifted = j.ownHold === undefined ? true : await this.#lift(key, agentId, j.ownHold, "the environment change is finished; the agent was running before it");
      return lifted ? "resumed" : "left-paused-by-another-request";
    }
    if (j.prior.state !== undefined) {
      try { await this.#d.pauses.observe(this.#by, { commandId: `mnt:${key}:observe`, scope, state: j.prior.state, ...(j.prior.state === "paused" ? { boundary: j.prior.boundary ?? "finished" } : {}), evidence: "state before the environment change" }); } catch (error) { if (!(error instanceof DomainError)) throw error; }
    }
    return `kept-${j.prior.state ?? "paused"}`;
  }

  /** Reloads the worker on the previous revision, makes it active again (a new revision from the old manifest when the new one was activated), and restores the agent's intent. */
  async #rollBack(view: MaintenanceView, key: string, j: JournalBody, reason: string, reverting = false): Promise<ApplyOutcome> {
    const agentId = view.agentId;
    if (j.checkpointId === undefined) return { outcome: "unsupported", reason: "the agent is not suspended; the change cannot be taken back safely now" };
    const prev = await this.#revision(agentId, j.previousRevision);
    if (prev === undefined) throw new Error(`revision ${j.previousRevision} of ${agentId} is missing`);
    const reloaded = await this.#d.runtime.reload({ requestId: view.id, agentId, revision: prev.revision, manifest: prev.manifest, checkpointId: j.checkpointId });
    if (!reloaded.ok) throw new Error(`the worker could not be reloaded on the previous revision ${prev.revision}: ${redactText(reloaded.reason).slice(0, 200)}`); // state unknown: the request becomes uncertain and is verified again
    const env = await this.#d.environments.get(this.#by, agentId);
    let active = env?.active?.revision ?? prev.revision;
    if (env?.active?.revision !== prev.revision) {
      const made = await this.#d.environments.rollback(this.#by, { commandId: `mnt:${key}:${reverting ? "revoke" : "back"}`, agentId, toRevision: prev.revision, reason: `${marker(view.id)} ${reason}`.slice(0, 480), observed: reloaded.observed, expectedRevision: env?.latest ?? j.stagedRevision });
      if (!made.activated) throw new Error(`the previous revision could not be activated: ${made.problem ?? "unknown"}`);
      active = made.revision;
    }
    const restored = await this.#restore(key, agentId, j);
    await this.#save(key, { ...j, phase: "failed", failure: { reason: reason.slice(0, 300), activeRevision: active } });
    return { outcome: "failed", reason: `${reason}; rolled back to revision ${prev.revision} (active as revision ${active}); the agent's earlier intent was restored (${restored})`, rollback: { previousRevision: prev.revision, activeRevision: active, restoredIntent: restored } };
  }
}
