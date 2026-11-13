import { createHash } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { MAINTENANCE_PRINCIPAL, MAINTENANCE_SERVICE, type EnvironmentManifest, type EnvironmentService, type RevisionBody } from "../environments/index.js";
import type { PauseScope, PauseService, ObservedState, Boundary } from "../lifecycle/pause.js";
import type { StopService } from "../lifecycle/stop.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { ApplyOutcome, MaintenanceApplier, MaintenanceView, RevertOutcome } from "./maintenance.js";

export { MAINTENANCE_PRINCIPAL };

/**
 * The real applier of reviewed environment changes (card A09). It carries an approved package or extension request through the sequence the card names: stage a new environment revision, try it in a disposable
 * environment, suspend the agent without releasing it (checkpoint), reload the worker on the new revision, activate the revision, validate it (session and compaction state intact), and put the agent's earlier
 * Pause or Suspend intent back as it was. A revision that does not load or validate is rolled back (a new revision made from the previous manifest, activated after the worker is reloaded on it), and the agent
 * goes back to what it was doing. When a safe suspension or a reload is not possible the answer is `unsupported`: nothing was changed and the request stays pending.
 *
 * What the host must provide is the `EnvironmentRuntime` port (it fetches and verifies the artifact, runs the disposable trial, reloads a worker on a manifest and checks it). The controller side (revisions,
 * pause gate, suspension, journal of progress) is real code here. The applier is idempotent by request ID: progress is journalled before each step, so a repeat after a crash resumes at the step reached.
 * The agent's prior intent is read again right before each suspension try (and journalled before the try), never from a gate this applier has already changed; the hold the applier lifts is only the pause its
 * own suspension made (`PauseService.ownPause`).
 *
 * A journal can be superseded (the agent's environment moved under a staged change, or the change was reverted): a later application of the same request then starts a new round (`<id>~<n>`) with a fresh trial,
 * so a retry after a revert never reports the old round's effect as applied.
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
/**
 * A worker reload on one revision's manifest. The runtime MUST install only artifacts whose content matches the manifest's digests (the exact artifact the trial verified, never a fresh fetch taken on trust), and
 * install scripts may run only for `change` and only when `change.installScripts` is true (inside the boundary). A reload without `change` (a rollback, a restore) runs no install script at all.
 */
export interface ReloadInput {
  readonly requestId: string; readonly agentId: string; readonly revision: number; readonly manifest: EnvironmentManifest; /** The checkpoint of the suspension, to restore the session from. */ readonly checkpointId: string;
  /** The approved artifact this reload brings in (absent on a rollback). */
  readonly change?: { readonly name: string; readonly version: string; readonly digest: string; readonly source: string; readonly installScripts: boolean };
}
export type ReloadResult = { readonly ok: true; /** The digest of each protected extension the worker found where it loads them (as `EnvironmentService.activate` takes them). */ readonly observed: Readonly<Record<string, string>> } | { readonly ok: false; readonly reason: string };
export interface ValidateInput extends ReloadInput { }
export type ValidateResult = { readonly ok: true; readonly sessionIntact: boolean; readonly compactionIntact: boolean } | { readonly ok: false; readonly reason: string };
export interface EnvironmentRuntime {
  trial(input: TrialInput): Promise<TrialResult>;
  reload(input: ReloadInput): Promise<ReloadResult>;
  validate(input: ValidateInput): Promise<ValidateResult>;
  /** Reads an artifact for the reviewer before approval (card A09 seventh slice): see `MaintenanceOptions.inspector`. Optional: a runtime without it leaves the reviewer with the requester's claims. */
  inspect?(artifact: { readonly name: string; readonly version: string; readonly digest: string; readonly source: string }, signal?: AbortSignal): Promise<import("./maintenance.js").ArtifactInspection>;
}

type Phase = "staged" | "suspended" | "activated" | "validated" | "restored" | "done" | "failed" | "superseded";
export interface JournalBody {
  readonly agentId: string; readonly previousRevision: number; readonly stagedRevision: number;
  /** What the agent's scope was right before the suspension try `priorTry` (read before that try, journalled before the stop request). */
  readonly prior: { readonly paused: boolean; readonly requestId?: string; readonly state?: ObservedState; readonly boundary?: Boundary };
  readonly priorTry?: number;
  /** The pause request this applier's suspension made (absent when the agent was already held: that hold is not ours to lift). */
  readonly ownHold?: string;
  readonly checkpointId?: string;
  /** Suspensions asked for (each try is a request of its own, so a repeat never replays an earlier, finished or cancelled one). */
  readonly suspends?: number;
  readonly phase: Phase;
  /** The environment's latest revision the rollback was asked against (kept so a repeat asks for the same new revision). */
  readonly rollbackFrom?: number;
  /** Which application round of the request this journal is (0 the first). */
  readonly round?: number;
  /** Why this round was superseded (phase `superseded`): the next application starts round `round + 1`. */
  readonly superseded?: string;
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
/** The journal kept in the controller's storage (kind `maintenance-journal`), one record per key, written under a revision check. */
export class StorageJournal implements ApplierJournal {
  readonly #runner: CommandRunner;
  readonly #storage: ControllerStorage;
  constructor(storage: ControllerStorage, epoch: number, options: RunnerOptions) { this.#runner = new CommandRunner(storage, epoch, options); this.#storage = storage; }
  async read(key: string): Promise<JournalBody | undefined> { return (await this.#storage.getAggregate({ kind: "maintenance-journal", id: key }))?.body as unknown as JournalBody | undefined; }
  async write(key: string, body: JournalBody): Promise<void> {
    const ref = { kind: "maintenance-journal", id: key };
    const digest = createHash("sha256").update(JSON.stringify(body)).digest("hex").slice(0, 24);
    // The record's revision is part of the command ID: a body written again after a different one (A, B, then A) is a new write, not a replay of the first.
    const at = (await this.#storage.getAggregate(ref))?.revision ?? 0;
    await this.#runner.command("maintenance.journal", { commandId: `mnt-jrn:${key}:${at}:${digest}`, actor: MAINTENANCE_SERVICE }, async () => ({
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
  readonly pauses: Pick<PauseService, "gate" | "resumeOwnHold" | "observe" | "ownPause">;
  readonly stops: Pick<StopService, "request" | "advance">;
  readonly runtime: EnvironmentRuntime;
  readonly journal: ApplierJournal;
  /** The identity the changes are made as. Defaults to `MAINTENANCE_PRINCIPAL` (the only service identity the environment service accepts). */
  readonly by?: Principal;
  /** The suspension deadline in milliseconds (default one minute). */
  readonly suspendMs?: number;
  /** How often a suspension still settling is looked at again (default 250 ms). */
  readonly pollMs?: number;
}

const scopeOf = (agentId: string): PauseScope => ({ kind: "agent", id: agentId.replace(/^agent:/, "") });
const say = (e: unknown): string => redactText(e instanceof Error ? e.message : String(e)).slice(0, 300);
/** The marker a staged revision carries in its reason, so a reader sees why it exists. A repeat finds its revision only by this marker AND its own identity AND the exact candidate manifest. */
const marker = (key: string): string => `maintenance ${key}:`;
const sameManifest = (a: EnvironmentManifest, b: EnvironmentManifest): boolean => canonicalJson(a as unknown as JsonObject) === canonicalJson(b as unknown as JsonObject);
type Gate = Awaited<ReturnType<PauseService["gate"]>>;
const priorOf = (gate: Gate): JournalBody["prior"] => ({ paused: gate?.intent === "pause", ...(gate?.intent === "pause" && gate.requestId !== undefined ? { requestId: gate.requestId } : {}), ...(gate?.observed?.state === undefined ? {} : { state: gate.observed.state }), ...(gate?.observed?.boundary === undefined ? {} : { boundary: gate.observed.boundary }) });

export class EnvironmentChangeApplier implements MaintenanceApplier {
  readonly #d: EnvironmentApplierDeps;
  readonly #by: Principal;
  /** Requests whose application or revert runs now in this controller (an application the maintenance service timed out may still be running: a revert or a second application must not race it). */
  readonly #running = new Set<string>();
  constructor(deps: EnvironmentApplierDeps) { this.#d = deps; this.#by = deps.by ?? MAINTENANCE_PRINCIPAL; }

  async apply(view: MaintenanceView): Promise<ApplyOutcome> {
    if (view.kind === "skill") return { outcome: "applied", effect: { recordedOnly: true, note: "a skill draft is recorded; it changes no environment until it is published through the catalog" } };
    if (view.kind !== "package" && view.kind !== "extension") return { outcome: "unsupported", reason: `${view.kind} changes are not part of an environment revision; they are applied by the sandbox policy and stay pending here` };
    if (this.#running.has(view.id)) return { outcome: "unsupported", reason: "an earlier application or revert of this request is still running; it is tried again when that one has ended" };
    this.#running.add(view.id);
    try { return await this.#apply(view); } finally { this.#running.delete(view.id); }
  }

  /** Takes the change back: the agent's previous revision is made current again by the same sequence (suspend, reload, activate, validate, restore). */
  async revert(view: MaintenanceView, effect: JsonObject): Promise<RevertOutcome> {
    void effect;
    if (view.kind === "skill") return { outcome: "reverted", effect: { recordedOnly: true } };
    // This applier never applies the other kinds (it answers `unsupported`), so there is never anything of theirs to undo here.
    if (view.kind !== "package" && view.kind !== "extension") return { outcome: "reverted", effect: { nothingToUndo: true, note: `${view.kind} changes are never applied by the environment applier` } };
    if (this.#running.has(view.id)) return { outcome: "unsupported", reason: "an application of this request is still running; the revert waits until it has ended" };
    this.#running.add(view.id);
    try { return await this.#revert(view); } finally { this.#running.delete(view.id); }
  }

  // ---- the sequence ---------------------------------------------------------------------------------------------------------

  async #apply(view: MaintenanceView): Promise<ApplyOutcome> {
    const agentId = view.agentId;
    let { key, j, round } = await this.#locate(view.id);
    if (j?.phase === "done" && j.effect !== undefined) return { outcome: "applied", effect: j.effect };
    if (j?.phase === "failed" && j.failure !== undefined) return { outcome: "failed", reason: j.failure.reason, rollback: { activeRevision: j.failure.activeRevision, restored: true } };
    if (j === undefined) {
      const staged = await this.#stage(view, key, round);
      if ("outcome" in staged) return staged;
      j = staged.journal;
    }
    const rev = await this.#revision(agentId, j.stagedRevision);
    if (rev === undefined) throw new Error(`staged revision ${j.stagedRevision} of ${agentId} is missing`);
    const spec = view.spec as { name: string; version: string; digest: string; source: string; installScripts: boolean };
    const input = (checkpointId: string, revision: RevisionBody): ReloadInput => ({ requestId: view.id, agentId, revision: revision.revision, manifest: revision.manifest, checkpointId, change: { name: spec.name, version: spec.version, digest: spec.digest, source: spec.source, installScripts: spec.installScripts } });

    // The change was built on the revision active when it was staged. If the agent's environment moved since (the owner changed it), activating the staged revision would undo that change: this round is
    // given up (the hold this applier took is lifted) and the next application stages the change again on what is active then.
    if (j.phase === "staged" || j.phase === "suspended") {
      const now = (await this.#d.environments.get(this.#by, agentId))?.active?.revision;
      if (now !== j.previousRevision) {
        const restored = j.phase === "suspended" ? await this.#restore(key, agentId, j) : "untouched";
        await this.#save(key, { ...j, phase: "superseded", superseded: `the environment moved from revision ${j.previousRevision} to ${now ?? "none"} before the change was activated` });
        return { outcome: "unsupported", reason: `the agent's environment changed (revision ${now ?? "none"} is active; the change was built on revision ${j.previousRevision}); nothing was activated, the agent was given back its intent (${restored}), and the change is staged again on the next try` };
      }
    }

    // Suspend without release, with a checkpoint (or answer `unsupported` and change nothing).
    if (j.phase === "staged") {
      const s = await this.#suspend(key, agentId, j);
      if ("unsupported" in s) return { outcome: "unsupported", reason: s.unsupported };
      j = s.journal;
    }
    // Somebody resumed the agent after the suspension (and before the reload): its worker may be running again, so it is not touched. The next try suspends it afresh.
    if (j.phase === "suspended" && !(await this.#held(agentId))) {
      const { checkpointId: _c, ownHold: _o, priorTry: _p, ...rest } = j;
      await this.#save(key, { ...rest, phase: "staged" });
      return { outcome: "unsupported", reason: "the agent was resumed before its worker could be reloaded; nothing was changed and the change waits" };
    }
    const checkpointId = j.checkpointId!;
    let problem: string | undefined;
    if (j.phase === "suspended") {
      const reloaded = await this.#d.runtime.reload(input(checkpointId, rev));
      if (!reloaded.ok) problem = `the worker could not be reloaded on revision ${rev.revision}: ${redactText(reloaded.reason).slice(0, 200)}`;
      else {
        try { await this.#d.environments.activate(this.#by, { commandId: `mnt:${key}:act`, agentId, revision: rev.revision, observed: reloaded.observed }); j = await this.#save(key, { ...j, phase: "activated" }); }
        catch (error) { if (error instanceof DomainError && error.code === "integrity") problem = error.message; else throw error; }
      }
    }
    if (problem === undefined && j.phase === "activated") {
      const checked = await this.#d.runtime.validate(input(checkpointId, rev));
      if (!checked.ok) problem = `validation failed: ${redactText(checked.reason).slice(0, 200)}`;
      else if (!checked.sessionIntact || !checked.compactionIntact) problem = `validation failed: ${!checked.sessionIntact ? "the session was not intact" : "the compaction state was not intact"} after the reload`;
      else j = await this.#save(key, { ...j, phase: "validated" });
    }
    if (problem !== undefined) return this.#rollBack(view, key, j, problem);

    const restored = j.phase === "restored" || j.phase === "done" ? "already restored" : await this.#restore(key, agentId, j);
    if (j.phase === "validated") j = await this.#save(key, { ...j, phase: "restored" });
    const effect: JsonObject = { environmentRevision: rev.revision, previousRevision: j.previousRevision, digest: rev.digest, checkpointId, restoredIntent: restored, trial: "passed", ...(round === 0 ? {} : { round }) };
    await this.#save(key, { ...j, phase: "done", effect });
    return { outcome: "applied", effect };
  }

  async #revert(view: MaintenanceView): Promise<RevertOutcome> {
    const { key, j } = await this.#locate(view.id);
    if (j === undefined) return { outcome: "reverted", effect: { nothingToUndo: true } };
    if (j.phase === "failed") return { outcome: "reverted", effect: { alreadyRolledBack: true, activeRevision: j.failure?.activeRevision ?? j.previousRevision } };
    if (j.phase === "staged") return { outcome: "reverted", effect: { nothingToUndo: true, note: "the staged revision was never activated and the worker was never touched" } };
    let target = j, tkey = key;
    // The agent runs again (the change finished, or somebody resumed it part way): it is suspended once more (its intent now is what it is to be given back) before its worker is touched.
    if (j.phase === "restored" || j.phase === "done" || !(await this.#held(view.agentId))) {
      tkey = `${key}:revert`;
      let again = await this.#d.journal.read(tkey);
      if (again?.phase === "failed") { await this.#supersede(key, j, "the change was taken back"); return { outcome: "reverted", effect: { alreadyRolledBack: true, activeRevision: again.failure?.activeRevision ?? j.previousRevision } }; }
      if (again === undefined) again = await this.#save(tkey, { agentId: view.agentId, previousRevision: j.previousRevision, stagedRevision: j.stagedRevision, prior: { paused: false }, phase: "staged" });
      if (again.phase === "staged") { const s = await this.#suspend(tkey, view.agentId, again); if ("unsupported" in s) return { outcome: "unsupported", reason: s.unsupported }; again = s.journal; }
      target = again;
    }
    const out = await this.#rollBack(view, tkey, target, "the change was revoked");
    if (out.outcome !== "failed") return { outcome: "unsupported", reason: (out as { reason: string }).reason };
    // A later application of the same request (after an unclear one was reverted) starts again with a fresh trial; it never reports this round's effect.
    await this.#supersede(key, (await this.#d.journal.read(key)) ?? j, "the change was taken back");
    return { outcome: "reverted", effect: { activeRevision: out.rollback?.["activeRevision"] ?? j.previousRevision, restoredIntent: out.rollback?.["restoredIntent"] ?? null } };
  }

  // ---- steps ---------------------------------------------------------------------------------------------------------------

  /** The journal of the request's current round: a superseded round points on to the next. */
  async #locate(id: string): Promise<{ key: string; j: JournalBody | undefined; round: number }> {
    let key = id, round = 0;
    let j = await this.#d.journal.read(key);
    for (let i = 0; i < 1000 && j?.phase === "superseded"; i++) { round = (j.round ?? round) + 1; key = `${id}~${round}`; j = await this.#d.journal.read(key); }
    return { key, j, round };
  }
  async #supersede(key: string, j: JournalBody, why: string): Promise<void> { await this.#save(key, { ...j, phase: "superseded", superseded: why }); }
  async #revision(agentId: string, n: number): Promise<RevisionBody | undefined> { return (await this.#d.environments.get(this.#by, agentId, n))?.revision; }
  async #save(id: string, body: JournalBody): Promise<JournalBody> { await this.#d.journal.write(id, body); return body; }
  async #held(agentId: string): Promise<boolean> { return (await this.#d.pauses.gate(this.#by, scopeOf(agentId)))?.intent === "pause"; }

  /** Builds the candidate manifest, tries it in the disposable environment and stages it as a new (inactive) revision. Nothing live is touched. */
  async #stage(view: MaintenanceView, key: string, round: number): Promise<{ journal: JournalBody } | ApplyOutcome> {
    const agentId = view.agentId;
    const env = await this.#d.environments.get(this.#by, agentId);
    if (env?.active === undefined) return { outcome: "unsupported", reason: `${agentId} has no active environment revision to change` };
    const spec = view.spec as { name: string; version: string; digest: string; source: string; installScripts: boolean };
    const base = env.active.manifest;
    const kept = base.packages.filter((p) => p.name !== spec.name);
    const candidate: EnvironmentManifest = { ...base, packages: [...kept, { name: spec.name, version: spec.version, digest: spec.digest }] };
    // A repeat after a crash between staging and the journal write finds the revision it already made: one this applier made (an agent may write its own revisions, with any reason it likes) for exactly this
    // candidate. Anything else is never taken for it, so no revision skips the trial.
    let staged: number | undefined;
    for (let n = env.latest; n > Math.max(0, env.latest - 10); n--) { const r = await this.#revision(agentId, n); if (r !== undefined && r.reason.startsWith(marker(key)) && r.createdBy === this.#by.id && r.rollbackOf === undefined && sameManifest(r.manifest, candidate)) { staged = n; break; } }
    const same = base.packages.find((p) => p.name === spec.name && p.version === spec.version && p.digest === spec.digest);
    if (staged === undefined && same !== undefined) return { outcome: "applied", effect: { unchanged: true, environmentRevision: env.active.revision, note: "the environment already has exactly this package" } };
    if (staged === undefined) {
      let trial: TrialResult;
      try { trial = await this.#d.runtime.trial({ requestId: view.id, agentId, kind: view.kind as "package" | "extension", artifact: { name: spec.name, version: spec.version, digest: spec.digest, source: spec.source }, installScripts: spec.installScripts, candidate }); }
      catch (error) { return { outcome: "unsupported", reason: `the disposable trial environment is not available: ${say(error)}` }; }
      if (!trial.ok) return { outcome: "failed", reason: `the trial in a disposable environment failed: ${redactText(trial.reason).slice(0, 250)}`, rollback: { nothingChanged: true } };
      if (trial.digestVerified !== true) return { outcome: "failed", reason: "digest mismatch: the fetched artifact was not verified against the approved digest; nothing was installed", rollback: { nothingChanged: true } };
      if (!spec.installScripts && (trial.scriptsDeclared !== false || trial.scriptsRan !== false)) return { outcome: "failed", reason: "the artifact declares or runs install scripts but the request said it has none; the approval did not cover scripts and nothing was installed", rollback: { nothingChanged: true } };
      try {
        const made = await this.#d.environments.change(this.#by, { commandId: `mnt:${key}:stage`, agentId, manifest: candidate, reason: `${marker(key)} ${view.kind} ${spec.name}@${spec.version} (was revision ${env.active.revision})`, expectedRevision: env.latest });
        staged = made.revision;
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) throw error; // the environment moved: the claim is repeated and starts again
        return { outcome: "failed", reason: `the revision could not be staged: ${say(error)}`, rollback: { nothingChanged: true } };
      }
    }
    const journal: JournalBody = { agentId, previousRevision: env.active.revision, stagedRevision: staged, prior: { paused: false }, phase: "staged", ...(round === 0 ? {} : { round }) };
    await this.#d.journal.write(key, journal);
    return { journal };
  }

  /** Suspends the agent (no release) and reads the checkpoint. A suspension that cannot be made safely changes nothing and leaves the change pending. */
  async #suspend(key: string, agentId: string, start: JournalBody): Promise<{ journal: JournalBody } | { unsupported: string }> {
    const scope = scopeOf(agentId);
    const tries = start.suspends ?? 0;
    const op = `mnt:${key}:stop${tries}`;
    // The intent to give back is the one right before this try (a pause someone set or lifted while the change waited counts), journalled before the stop request so a repeat never reads our own hold.
    let j = start;
    if (j.priorTry !== tries) j = await this.#save(key, { ...j, prior: priorOf(await this.#d.pauses.gate(this.#by, scope)), priorTry: tries });
    let done;
    try {
      const asked = await this.#d.stops.request(this.#by, { commandId: op, scope, mode: "suspend", reason: `maintenance ${key}: environment change`, deadlineMs: this.#d.suspendMs ?? 60_000 });
      done = await this.#d.stops.advance(this.#by, { intentId: asked.intentId });
      // Work still settling is looked at again until the stop's own deadline blocks it (bounded here too, by the wall clock).
      const until = Date.now() + (this.#d.suspendMs ?? 60_000) + 5_000;
      while ((done.phase === "preparing" || done.phase === "prepared") && Date.now() < until) { await sleep(this.#d.pollMs ?? 250); done = await this.#d.stops.advance(this.#by, { intentId: asked.intentId }); }
    } catch (error) { await this.#save(key, { ...j, suspends: tries + 1 }); return { unsupported: `the agent could not be suspended safely: ${say(error)}` }; }
    // Only the pause this very suspension made is ours to lift later.
    const ownHold = await this.#d.pauses.ownPause(scope, [{ operationId: `${op}-pause`, actor: this.#by.id }]);
    if (done.phase !== "done" || done.outcome?.state !== "suspended" || done.prepared === undefined) {
      const why = done.blocked?.reason ?? `the suspension ended as ${done.outcome?.state ?? done.phase}`;
      if (ownHold !== undefined) { await this.#lift(key, agentId, ownHold, "the suspension for an environment change did not finish; nothing was changed"); await this.#d.stops.advance(this.#by, { intentId: done.id }).catch(() => undefined); }
      await this.#save(key, { ...j, suspends: tries + 1 });
      return { unsupported: `the agent could not be suspended safely (${redactText(why).slice(0, 200)}); nothing was changed` };
    }
    const { ownHold: _old, ...rest } = j;
    const journal = await this.#save(key, { ...rest, phase: "suspended", suspends: tries + 1, checkpointId: done.prepared.checkpointId, ...(ownHold === undefined ? {} : { ownHold }) });
    return { journal };
  }

  async #lift(key: string, agentId: string, ownHold: string, reason: string): Promise<boolean> {
    try { await this.#d.pauses.resumeOwnHold(this.#by, { commandId: `mnt:${key}:resume:${ownHold}`, scope: scopeOf(agentId), reason, requestId: ownHold }); return true; }
    catch (error) {
      if (!(error instanceof DomainError && error.code === "invalid_command")) throw error;
      // Already lifted (a repeat) counts as lifted; a pause somebody made since is theirs and stays.
      return !(await this.#held(agentId));
    }
  }

  /** Puts the agent's earlier Pause or Suspend intent back: the hold this applier's suspension made is lifted, a hold somebody else had stays (with the state it was observed in). */
  async #restore(key: string, agentId: string, j: JournalBody): Promise<string> {
    const scope = scopeOf(agentId);
    if (j.ownHold !== undefined) return (await this.#lift(key, agentId, j.ownHold, "the environment change is finished; the agent was running before it")) ? "resumed" : "left-paused-by-another-request";
    const gate = await this.#d.pauses.gate(this.#by, scope);
    if (!j.prior.paused || gate?.intent !== "pause" || gate.requestId !== j.prior.requestId) return gate?.intent === "pause" ? "left-paused-by-another-request" : "resumed";
    if (j.prior.state !== undefined) {
      try { await this.#d.pauses.observe(this.#by, { commandId: `mnt:${key}:observe`, scope, state: j.prior.state, ...(j.prior.state === "paused" ? { boundary: j.prior.boundary ?? "finished" } : {}), evidence: "state before the environment change" }); } catch (error) { if (!(error instanceof DomainError)) throw error; }
    }
    return `kept-${j.prior.state ?? "paused"}`;
  }

  /**
   * Reloads the worker on what must be active and restores the agent's intent. When the staged revision is the active one, the previous revision is made current again (a new revision from the old manifest);
   * when it is not (nothing was activated, or somebody activated another revision since), the worker is reloaded on whatever is active and no revision is written.
   */
  async #rollBack(view: MaintenanceView, key: string, start: JournalBody, reason: string): Promise<ApplyOutcome> {
    const agentId = view.agentId;
    let j = start;
    if (j.checkpointId === undefined) return { outcome: "unsupported", reason: "the agent is not suspended; the change cannot be taken back safely now" };
    const env = await this.#d.environments.get(this.#by, agentId);
    const ours = env?.active === undefined || env.active.revision === j.stagedRevision;
    const back = ours ? await this.#revision(agentId, j.previousRevision) : env!.active!;
    if (back === undefined) throw new Error(`revision ${j.previousRevision} of ${agentId} is missing`);
    const reloaded = await this.#d.runtime.reload({ requestId: view.id, agentId, revision: back.revision, manifest: back.manifest, checkpointId: j.checkpointId });
    if (!reloaded.ok) throw new Error(`the worker could not be reloaded on revision ${back.revision}: ${redactText(reloaded.reason).slice(0, 200)}`); // state unknown: the request becomes uncertain and is verified again
    let active = back.revision;
    if (ours) {
      if (j.rollbackFrom === undefined) j = await this.#save(key, { ...j, rollbackFrom: env?.latest ?? j.stagedRevision });
      const made = await this.#d.environments.rollback(this.#by, { commandId: `mnt:${key}:back`, agentId, toRevision: back.revision, reason: `${marker(key)} ${reason}`.slice(0, 480), observed: reloaded.observed, expectedRevision: j.rollbackFrom! });
      if (!made.activated) throw new Error(`the previous revision could not be activated: ${made.problem ?? "unknown"}`);
      active = made.revision;
    }
    const restored = await this.#restore(key, agentId, j);
    await this.#save(key, { ...j, phase: "failed", failure: { reason: reason.slice(0, 300), activeRevision: active } });
    return { outcome: "failed", reason: `${reason}; ${ours ? `rolled back to revision ${back.revision} (active as revision ${active})` : `revision ${active} stays active`}; the agent's earlier intent was restored (${restored})`, rollback: { previousRevision: back.revision, activeRevision: active, restoredIntent: restored } };
  }
}
