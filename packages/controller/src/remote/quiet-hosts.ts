import { createHash, randomUUID } from "node:crypto";
import { DomainError, isDomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { HostService } from "../hosts/index.js";
import { scopedCommandId } from "../security/credentials.js";
import { DISPATCHER_PRINCIPAL } from "../security/task-credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { QuietHostSettingsService } from "./quiet-host-settings.js";
import type { PlacementBody, RemoteWorkerService } from "./service.js";

export const QUIET_HOST_KIND = "quiet-host";
const HOST = /^host:[a-z0-9][a-z0-9-]{0,39}$/;
const LIVE_STATES: ReadonlySet<string> = new Set(["offered", "accepted", "relocating"]);
const HOUR_MS = 3_600_000;

/** Work done in one pass or one call, so a large backlog is worked off over several passes and no pass runs for ever. */
export const QUIET_HOST_LIMITS = { liveAttempts: 2000, hosts: 100, records: 200, movesPerPass: 10, ownerMoves: 25, pending: 100, pendingAgeMs: 24 * HOUR_MS, targets: 5 } as const;
/** A host not heard from for this long while it holds work is quiet. Provisional: well past the 90 s freshness window, so a restart or a network blip is not an episode. */
export const DEFAULT_QUIET_AFTER_MS = 5 * 60_000;

interface Pending { readonly attemptId: string; readonly to: string; readonly commandId: string; readonly at: string }
export interface QuietHostBody {
  readonly hostId: string;
  /** The host's last-heard-from time when it went quiet: it names the episode (a host that comes back and goes quiet again has a new one). `owner` for a record only the owner's move wrote. */
  readonly episode: string;
  readonly quietSince: string;
  /** `quiet`: the host is quiet and its work may be moved. `recovered`: it reported again; nothing moves any more for this episode. */
  readonly state: "quiet" | "recovered";
  readonly warnedAt?: string;
  readonly blockedAt?: string;
  /** Moves started and not yet known to be finished (a restart in the middle finishes them). */
  readonly pending: readonly Pending[];
  readonly updatedAt: string;
}

export interface QuietHostNotice { readonly commandId: string; readonly hostId: string; readonly detail: string }
export interface QuietHostDeps {
  /** The dispatcher's own service principal: it reads host status and moves attempts. */
  readonly principal: Principal;
  readonly settings: Pick<QuietHostSettingsService, "effective">;
  readonly hosts: Pick<HostService, "status">;
  readonly remote: Pick<RemoteWorkerService, "placement" | "candidates" | "relocate">;
  /** The attempts the dispatcher holds (not finished), any host, with the dispatcher's state for each (`parked` ones wait with an ended placement and are moved from the checkpoint they parked with). */
  readonly liveAttempts: () => Promise<readonly { readonly attemptId: string; readonly state: string }[]>;
  /** A needs-you notification to the owner. The command ID is stable per episode, so a repeat is not a second notice. */
  readonly notify: (notice: QuietHostNotice) => Promise<void>;
}
export interface QuietHostOptions extends RunnerOptions { readonly quietAfterMs?: number }
export interface QuietHostPass { readonly warned: number; readonly moved: number; readonly recovered: number; readonly blocked: number }
export interface MoveWorkResult {
  readonly hostId: string;
  readonly moved: readonly { readonly attemptId: string; readonly to: string }[];
  readonly skipped: readonly { readonly attemptId: string; readonly reason: string }[];
  /** More attempts than one call moves: ask again. */
  readonly more: boolean;
}

const digest = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
const hostName = (hostId: string): string => hostId.slice("host:".length);

/**
 * What the controller does when a host stops reporting while it holds work (owner decision 2026-10-30), in this order:
 *
 * 1. **Warn.** A host that holds live or parked attempts and has not been heard from for `quietAfterMs` gets one needs-you notification per quiet episode (the identity is the host and the time it was last heard from, so
 *    a repeat, a second pass or a restart is not a second notice). The pass writes its record first-seen and the warning time after the notice; a notice sent and not recorded is sent again under the same identity.
 * 2. **Owner says move.** `moveWork` (owner only) re-places every live attempt of the host at once, with the placement and exclusion rules that apply to any placement; the relocation path (`RemoteWorkerService.relocate`)
 *    fences the old host, takes the last stored checkpoint when the host does not answer, and restarts the attempt on the new host from it.
 * 3. **Owner says nothing.** When the grace period has passed since the warning, and automatic moves are on, the pass moves the host's attempts the same way. Off (or a damaged setting) means never by itself.
 * 4. **The host comes back** (fresh again) before that: the episode is closed and nothing moves.
 *
 * The state is a record per host, so the pass is restart-safe (the warning time, the episode and the moves under way survive), replay-safe (every notice and every move has an ID derived from the episode and
 * the attempt) and bounded (`QUIET_HOST_LIMITS`). Only the dispatcher's own pass and the owner's call reach it; no worker or agent does.
 */
export class QuietHostService {
  readonly #runner: CommandRunner;
  readonly #deps: QuietHostDeps;
  readonly #quietAfterMs: number;

  private constructor(runner: CommandRunner, deps: QuietHostDeps, quietAfterMs: number) { this.#runner = runner; this.#deps = deps; this.#quietAfterMs = quietAfterMs; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: QuietHostDeps, options: QuietHostOptions = {}): QuietHostService {
    if (deps.principal.kind !== "service" || deps.principal.id !== DISPATCHER_PRINCIPAL || deps.principal.taskScope !== undefined) throw new DomainError("invalid_command", "principal: the quiet-host service acts as the dispatcher's service principal", { field: "principal" });
    const quietAfterMs = options.quietAfterMs ?? DEFAULT_QUIET_AFTER_MS;
    if (!Number.isSafeInteger(quietAfterMs) || quietAfterMs < 1000) throw new DomainError("invalid_command", "quietAfterMs: must be a whole number of at least 1000", { field: "quietAfterMs" });
    return new QuietHostService(new CommandRunner(storage, epoch, options), deps, quietAfterMs);
  }

  /** The records of hosts that are or were quiet, for the owner. */
  async episodes(by: Principal): Promise<QuietHostBody[]> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the quiet hosts`);
    return (await this.#records()).map((r) => r.body);
  }

  /** One pass, the dispatcher's only (never exposed through the API). */
  async sweep(by: Principal): Promise<QuietHostPass> {
    if (by.id !== DISPATCHER_PRINCIPAL || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not run the quiet-host pass`);
    const out = { warned: 0, moved: 0, recovered: 0, blocked: 0 };
    const figures = await this.#deps.settings.effective();
    const now = this.#runner.now();
    const live = await this.#liveByHost();
    const records = new Map((await this.#records()).map((r) => [r.body.hostId, r] as const));
    let budget: number = QUIET_HOST_LIMITS.movesPerPass;
    // Moves that were started and not finished (a restart or an error in the middle) come first.
    for (const r of records.values()) if (r.body.pending.length > 0 && budget > 0) budget -= await this.#finishPending(r.body.hostId);
    const hostIds = new Set<string>([...live.keys(), ...[...records.values()].filter((r) => r.body.state === "quiet").map((r) => r.body.hostId)]);
    let examined = 0;
    for (const hostId of [...hostIds].sort()) {
      if (examined++ >= QUIET_HOST_LIMITS.hosts) break;
      const status = await this.#deps.hosts.status(this.#deps.principal, hostId);
      if (status === undefined) continue;
      const record = (await this.#record(hostId)) ?? undefined;
      if (status.freshness === "fresh") {
        // It reported again: the episode is over and a move that was waiting does not happen.
        if (record !== undefined && record.body.state === "quiet") { await this.#write(hostId, (cur) => (cur !== undefined && cur.state === "quiet" ? { ...cur, state: "recovered", updatedAt: this.#runner.now() } : undefined), "recovered"); out.recovered++; }
        continue;
      }
      const attempts = live.get(hostId) ?? [];
      const heard = status.lastSeenAt === undefined ? undefined : Date.parse(status.lastSeenAt);
      const quiet = heard === undefined || Date.parse(now) - heard >= this.#quietAfterMs;
      if (!quiet || (attempts.length === 0 && record?.body.state !== "quiet")) continue;
      const episode = status.lastSeenAt ?? "never";
      let current = record?.body;
      if (current === undefined || current.episode !== episode) {
        current = await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode ? undefined : { hostId, episode, quietSince: now, state: "quiet", pending: cur?.pending ?? [], updatedAt: now }), "open") ?? current;
      }
      if (current === undefined || current.episode !== episode || current.state !== "quiet") continue;
      const warnId = `quiet-host:${hostName(hostId)}:${digest(hostId, episode)}`.slice(0, 120);
      if (current.warnedAt === undefined && attempts.length > 0) {
        // The notification text is at most 200 characters.
        const detail = (figures.autoMove
          ? `${hostId} stopped reporting and holds ${attempts.length} attempt(s). Say "move the work off ${hostId}" to move it now; otherwise it moves after ${figures.graceHours}h unless the host reports again.`
          : `${hostId} stopped reporting and holds ${attempts.length} attempt(s). Automatic moves are off. Say "move the work off ${hostId}" to move it.`).slice(0, 200);
        // A notice that cannot be sent leaves the record as it was: the next pass sends it again under the same identity, and the other hosts are not held up.
        try { await this.#deps.notify({ commandId: warnId, hostId, detail }); } catch { continue; }
        current = await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode && cur.warnedAt === undefined ? { ...cur, warnedAt: this.#runner.now(), updatedAt: this.#runner.now() } : undefined), "warned") ?? current;
        out.warned++;
        continue;
      }
      if (!figures.autoMove || current.warnedAt === undefined || attempts.length === 0) continue;
      if (Date.parse(now) < Date.parse(current.warnedAt) + figures.graceHours * HOUR_MS) continue;
      // The last look before moving: a host that reported in the meantime keeps its work.
      const again = await this.#deps.hosts.status(this.#deps.principal, hostId);
      if (again === undefined || again.freshness === "fresh") continue;
      let blocked = 0;
      for (const p of attempts) {
        if (budget <= 0) break;
        budget--;
        const r = await this.#moveOne(p, digest(hostId, episode), `${hostId} has been quiet since ${status.lastSeenAt ?? "start"} and the owner did not answer the warning within ${figures.graceHours} hour(s)`);
        if (r.ok) out.moved++; else if (r.transient !== true) blocked++;
      }
      if (blocked > 0 && current.blockedAt === undefined) {
        try { await this.#deps.notify({ commandId: `quiet-host-blocked:${hostName(hostId)}:${digest(hostId, episode)}`.slice(0, 120), hostId, detail: `${hostId} is still quiet past the grace period; ${blocked} attempt(s) cannot move: no other allowed host can take them now.`.slice(0, 200) }); } catch { continue; }
        await this.#write(hostId, (cur) => (cur !== undefined && cur.episode === episode && cur.blockedAt === undefined ? { ...cur, blockedAt: this.#runner.now(), updatedAt: this.#runner.now() } : undefined), "blocked");
        out.blocked++;
      }
    }
    return out;
  }

  /**
   * The owner asks to move the work off a host: done right away, whether or not the host is quiet and whatever the setting says. Owner only. Replay-safe: the command ID names the request, a repeat moves what is
   * left and the moves already made are answered, not made again.
   */
  async moveWork(owner: Principal, command: NoActor & { hostId: string }): Promise<MoveWorkResult> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not move work off a host`);
    const unknown = Object.keys(command).filter((k) => k !== "commandId" && k !== "hostId");
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (typeof command.hostId !== "string" || !HOST.test(command.hostId)) throw new DomainError("invalid_command", "hostId: must be a host principal ID (host:name)", { field: "hostId" });
    if (typeof command.commandId !== "string" || command.commandId.length === 0 || command.commandId.length > 120) throw new DomainError("invalid_command", "commandId: is required", { field: "commandId" });
    const hostId = command.hostId;
    if (await this.#deps.hosts.status(this.#deps.principal, hostId) === undefined) throw new DomainError("not_found", `${hostId} is not an enrolled host`);
    const scoped = scopedCommandId(owner.id, command.commandId);
    // The request is recorded first (one command, so a repeat with another host is a conflict and a repeat of the same is the same request).
    await this.#runner.command("host.move-work", { commandId: scoped, actor: owner.id }, async () => ({
      payload: { hostId },
      build: async () => {
        const current = await this.#runner.get(QUIET_HOST_KIND, hostId);
        const at = this.#runner.now();
        const ref = { kind: QUIET_HOST_KIND, id: hostId };
        // Nothing but the time changes in a record that exists: the request is in the audit trail under the owner's name.
        if (current !== undefined) return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: current.revision, body: { ...(current.body as unknown as QuietHostBody), updatedAt: at } as unknown as JsonObject }], detail: { hostId } };
        const body: QuietHostBody = { hostId, episode: "owner", quietSince: at, state: "recovered", pending: [], updatedAt: at };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: body as unknown as JsonObject }], detail: { hostId } };
      },
    }));
    const attempts = (await this.#liveByHost()).get(hostId) ?? [];
    const moved: { attemptId: string; to: string }[] = [];
    const skipped: { attemptId: string; reason: string }[] = [];
    for (const p of attempts.slice(0, QUIET_HOST_LIMITS.ownerMoves)) {
      const r = await this.#moveOne(p, digest("owner", scoped, hostId), `the owner asked to move the work off ${hostId}`);
      if (r.ok) moved.push({ attemptId: p.attemptId, to: r.to }); else skipped.push({ attemptId: p.attemptId, reason: r.reason });
    }
    await this.#finishPending(hostId);
    return { hostId, moved, skipped, more: attempts.length > QUIET_HOST_LIMITS.ownerMoves };
  }

  // ---- internals ---------------------------------------------------------------------------------------------------------------

  /** The placements of the work each host holds, by host (bounded). */
  async #liveByHost(): Promise<Map<string, PlacementBody[]>> {
    const out = new Map<string, PlacementBody[]>();
    for (const { attemptId, state } of (await this.#deps.liveAttempts()).slice(0, QUIET_HOST_LIMITS.liveAttempts)) {
      const p = await this.#deps.remote.placement(this.#deps.principal, attemptId).catch(() => undefined);
      // The work of a host: attempts with a live placement on it, and attempts parked on it (their placement ended with the run, and the dispatcher keeps them for the host).
      if (p === undefined || !(LIVE_STATES.has(p.state) || state === "parked")) continue;
      const list = out.get(p.hostId) ?? [];
      list.push(p);
      out.set(p.hostId, list);
    }
    return out;
  }

  /** Moves one attempt to the first host that may take it (the placement rules decide who may; the host itself is never a target). Records the move before making it. */
  async #moveOne(p: PlacementBody, seed: string, reason: string): Promise<{ ok: true; to: string } | { ok: false; reason: string; transient?: true }> {
    const by = this.#deps.principal;
    const found = await this.#deps.remote.candidates(by, { attemptId: p.attemptId, taskId: p.taskId, projectId: p.projectId, agentId: p.agentId, requirements: p.requirements });
    const targets = found.eligible.filter((h) => h !== p.hostId).slice(0, QUIET_HOST_LIMITS.targets);
    if (targets.length === 0) return { ok: false, reason: found.waiting ?? "no other host can take it" };
    const commandId = `qhm:${digest(seed, p.attemptId)}`;
    let why = "no other host can take it";
    for (const to of targets) {
      await this.#write(p.hostId, (cur) => {
        const base = cur ?? { hostId: p.hostId, episode: "owner", quietSince: this.#runner.now(), state: "recovered" as const, pending: [], updatedAt: this.#runner.now() };
        const pending = [...base.pending.filter((x) => x.attemptId !== p.attemptId), { attemptId: p.attemptId, to, commandId, at: this.#runner.now() }].slice(-QUIET_HOST_LIMITS.pending);
        return { ...base, pending, updatedAt: this.#runner.now() };
      }, "pending");
      try {
        await this.#deps.remote.relocate(by, { commandId, attemptId: p.attemptId, toHostId: to, reason: reason.slice(0, 300) });
        await this.#drop(p.hostId, p.attemptId);
        return { ok: true, to };
      } catch (error) {
        if (isDomainError(error, "invalid_transition") || isDomainError(error, "fenced") || isDomainError(error, "not_found")) {
          // Nothing moved (the target was refused, or the placement changed meanwhile): the entry goes and the next target is tried.
          await this.#drop(p.hostId, p.attemptId);
          why = error instanceof Error ? error.message : String(error);
          if (!isDomainError(error, "invalid_transition")) return { ok: false, reason: why };
          continue;
        }
        // Anything else (the store was down, the dispatcher failed after the commit): the entry stays, the next pass repeats the move under the same ID, and this pass goes on with the others.
        return { ok: false, reason: error instanceof Error ? error.message.slice(0, 300) : "the move failed", transient: true };
      }
    }
    return { ok: false, reason: why };
  }

  /** Finishes the moves a record still lists: one that stopped half way is finished by repeating it; one that is done, or never happened, is dropped. Returns how many it worked on. */
  async #finishPending(hostId: string): Promise<number> {
    const rec = await this.#record(hostId);
    if (rec === undefined) return 0;
    let worked = 0;
    for (const entry of rec.body.pending) {
      const p = await this.#deps.remote.placement(this.#deps.principal, entry.attemptId).catch(() => undefined);
      const stale = Date.parse(this.#runner.now()) - Date.parse(entry.at) > QUIET_HOST_LIMITS.pendingAgeMs;
      const halfway = p !== undefined && LIVE_STATES.has(p.state) && p.hostId === entry.to && p.state === "relocating";
      if (!halfway || stale) { await this.#drop(hostId, entry.attemptId); continue; }
      worked++;
      try {
        await this.#deps.remote.relocate(this.#deps.principal, { commandId: entry.commandId, attemptId: entry.attemptId, toHostId: entry.to, reason: "finishing a move that was started" });
        await this.#drop(hostId, entry.attemptId);
      } catch { /* kept: the next pass tries again, until it is stale */ }
    }
    return worked;
  }

  async #drop(hostId: string, attemptId: string): Promise<void> {
    await this.#write(hostId, (cur) => (cur === undefined || !cur.pending.some((x) => x.attemptId === attemptId) ? undefined : { ...cur, pending: cur.pending.filter((x) => x.attemptId !== attemptId), updatedAt: this.#runner.now() }), "drop");
  }

  async #record(hostId: string): Promise<{ body: QuietHostBody; revision: number } | undefined> {
    const found = await this.#runner.get(QUIET_HOST_KIND, hostId);
    return found === undefined ? undefined : { body: found.body as unknown as QuietHostBody, revision: found.revision };
  }

  async #records(): Promise<{ body: QuietHostBody; revision: number }[]> {
    const out: { body: QuietHostBody; revision: number }[] = [];
    for (let after: string | undefined; out.length < QUIET_HOST_LIMITS.records;) {
      const page = await this.#runner.list(QUIET_HOST_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const f of page) { after = f.id; out.push({ body: f.body as unknown as QuietHostBody, revision: f.revision }); }
      if (page.length < 100) break;
    }
    return out.slice(0, QUIET_HOST_LIMITS.records);
  }

  /** Rewrites a host's record from what is there now (a lost race reads again). `decide` returns the new body, or undefined for "nothing to do". Returns the body that stands afterwards. */
  async #write(hostId: string, decide: (current: QuietHostBody | undefined) => QuietHostBody | undefined, label: string): Promise<QuietHostBody | undefined> {
    for (let tries = 0; tries < 6; tries++) {
      const found = await this.#record(hostId);
      const next = decide(found?.body);
      if (next === undefined) return found?.body;
      const ref = { kind: QUIET_HOST_KIND, id: hostId };
      const change = found === undefined ? { type: "create" as const, ref, body: next as unknown as JsonObject } : { type: "update" as const, ref, expectedRevision: found.revision, body: next as unknown as JsonObject };
      try {
        await this.#runner.command(`quiet-host.${label}`, { commandId: `qh:${label}:${hostId}:${randomUUID().slice(0, 16)}`, actor: DISPATCHER_PRINCIPAL }, async () => ({
          payload: { hostId, revision: found?.revision ?? 0 },
          build: async () => ({ ref, creates: found === undefined, changes: [change], detail: { hostId, state: next.state, pending: next.pending.length } }),
        }));
        return next;
      } catch (error) {
        if (!(isDomainError(error, "stale_revision") || isDomainError(error, "command_conflict"))) throw error;
      }
    }
    return (await this.#record(hostId))?.body;
  }
}
