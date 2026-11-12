import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { Availability } from "../conversations/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { Principal } from "../security/principals.js";
import type { WakeControl, WakeView } from "./attendance.js";
import type { HostWakeRequest } from "./wake-sink.js";

/** What the host needs to know of the lifecycle; the controller supplies it from its stop and pause services. */
export interface WakeHostLifecycle {
  /** Whether the agent is at rest because a finished Suspend or Stop of its own or its team's is still the cause of its gate. */
  rest(agentId: string): Promise<{ readonly state: "suspended" | "stopped"; readonly intentId: string; readonly scope: { readonly kind: string; readonly id: string } } | undefined>;
  /** The scopes whose pause holds the agent now. */
  holds(agentId: string): Promise<readonly { readonly scope: { readonly kind: string; readonly id: string } }[]>;
}

export const WAKE_LEASE_KIND = "meeting-wake-lease";
export const WAKE_LEASE_LIMIT = 20;
/** Bounds on what the host does for woken agents (card M04h). */
export const WAKE_LIMITS = {
  /** Woken agents the host brings into rooms in one pass of the loop. */
  perPass: 3,
  /** Woken agents attending at once across the installation; the rest wait for a place (they are listed as waiting). */
  active: 5,
  /** Passes that may fail to bring one wake in before the host gives up on it and says why. */
  tries: 3,
  /** Lease records read in one pass or one listing. */
  scan: 200,
  /** Wakes the owner is shown. */
  shown: 50,
  reason: 200,
} as const;
const AGENT = /^agent:(agt-[a-z2-7]{20})$/;

/** `intentId` is the stop the agent was woken from: a later stop (the owner resumed it and stopped it again) is not lifted by this lease. */
interface LeaseEntry {
  readonly occurrenceId: string; readonly projectId: string; readonly key: string; readonly at: string; readonly intentId?: string;
  /** Passes that failed to bring the agent into the room. */
  readonly tries?: number;
  readonly lastError?: string;
  readonly gaveUpAt?: string;
  readonly attendedAt?: string;
  readonly meetingTaskId?: string;
  /** The owner ended the wake; the agent reports at rest again from then on. */
  readonly stoppedAt?: string;
  readonly stoppedBy?: string;
  /** The room has been made to agree with the stop (the agent left or its seat says why it is not coming). */
  readonly settledAt?: string;
  /** Why an attended wake ended before its room did and without the owner's stop of the wake (the agent left the room, or the owner stopped, suspended or paused it again). */
  readonly endedReason?: string;
}
interface LeaseBody { readonly agent: string; readonly leases: readonly LeaseEntry[] }
interface RoomView { readonly state: string; readonly roster: readonly string[] }

/** What the host asks of the attendance service to bring a woken agent into the room; every call goes through the service's own checks (the bounded meeting task, the pause permission, the budget at the claim). */
export interface WakeAttender {
  prepare(by: Principal, command: { commandId: string; occurrenceId: string; agent: string; interrupted: readonly string[] }): Promise<unknown>;
  join(by: Principal, command: { commandId: string; occurrenceId: string; agent: string }): Promise<{ readonly joined: boolean; readonly state: string; readonly meetingTaskId?: string; readonly reason?: string }>;
  endWake(by: Principal, occurrenceId: string, agent: string): Promise<void>;
  /** Where the agent's seat stands, so a pass that was cut off after the join does not prepare an agent that is already in. */
  seat(by: Principal, occurrenceId: string, agent: string): Promise<{ readonly state: string; readonly meetingTaskId?: string; readonly left?: boolean } | undefined>;
  /** Ends the live attempt of the meeting task through the dispatcher's own stop (a graceful one: settle, checkpoint, end); nothing live is nothing to do. */
  endAttempt(by: Principal, taskId: string, reason: string): Promise<void>;
  /** Asks for an attempt on the agent's meeting task through the assignment's own admission, which the dispatcher then claims with all its checks. Repeatable: a task with an attempt already is left alone. */
  admit(by: Principal, request: { readonly commandId: string; readonly taskId: string; readonly agent: string }): Promise<void>;
}

export interface WakePass { readonly attended: number; readonly waiting: number; readonly gaveUp: number; readonly settled: number }

const digestOf = (text: string): string => createHash("sha256").update(text).digest("hex").slice(0, 40);

/**
 * A host for the owner's meeting wake that the controller composes itself (card M04h). The agent's gate stays paused throughout, so its tasks stay held; what the wake changes is what the availability hook says: `available` while a
 * meeting room it was woken for is open (it can attend and answer there), and `stopped` or `suspended` again as soon as that room ends, with nothing to undo because nothing was lifted. The lease is a record per agent
 * naming the meetings it was woken for; the room, not a timer, decides whether it still counts. A repeated key is the same wake. A stop of the whole installation, or any pause besides the one that stopped the agent, is never
 * overridden: the agent keeps reporting what it reported before.
 */
export class MeetingWakeHost implements WakeControl {
  readonly #runner: CommandRunner;
  readonly #life: WakeHostLifecycle;

  private constructor(runner: CommandRunner, life: WakeHostLifecycle) { this.#runner = runner; this.#life = life; }

  static withEpoch(storage: ControllerStorage, epoch: number, life: WakeHostLifecycle, options: RunnerOptions = {}): MeetingWakeHost {
    return new MeetingWakeHost(new CommandRunner(storage, epoch, options), life);
  }

  /** The `recover` the wake sink calls: records the lease for this meeting. Refused when the agent is not at rest, the meeting is not open or the agent is not on its roster. */
  recover = async (request: HostWakeRequest): Promise<void> => {
    const agentId = AGENT.exec(request.agent)?.[1];
    if (agentId === undefined) throw new DomainError("invalid_command", "the agent is not an agent principal");
    const rest = await this.#life.rest(agentId);
    if (rest === undefined) throw new DomainError("unavailable", `${request.agent} is not at rest through a finished suspend or stop`);
    // A wake that could not make the agent available is refused rather than accepted with no effect: the installation's brake, or another pause besides the stop's own, keeps holding it.
    if ((await this.#life.holds(agentId)).some((h) => h.scope.kind === "installation" || h.scope.kind !== rest.scope.kind || h.scope.id !== rest.scope.id)) throw new DomainError("unavailable", `${request.agent} is also held by another pause`);
    const room = await this.#room(request.occurrenceId);
    if (room === undefined || room.state === "ended" || !room.roster.includes(request.agent)) throw new DomainError("unavailable", "the meeting is not open for that agent");
    const leaseId = derivedId("mwl", request.agent);
    const digest = createHash("sha256").update(request.key).digest("hex").slice(0, 40);
    await this.#runner.command("meeting.host.wake", { commandId: `mwl-${digest}`, actor: "system" }, async () => ({
      payload: { key: request.key, agent: request.agent, occurrenceId: request.occurrenceId },
      build: async () => {
        const found = await this.#runner.get(WAKE_LEASE_KIND, leaseId);
        const old = (found?.body as unknown as LeaseBody | undefined)?.leases ?? [];
        const live: LeaseEntry[] = [];
        for (const l of old) if (l.occurrenceId !== request.occurrenceId && (await this.#open(l.occurrenceId, request.agent))) live.push(l);
        const next: LeaseBody = { agent: request.agent, leases: [...live, { occurrenceId: request.occurrenceId, projectId: request.projectId, key: request.key, at: this.#runner.now(), intentId: rest.intentId }].slice(-WAKE_LEASE_LIMIT) };
        const ref = { kind: WAKE_LEASE_KIND, id: leaseId };
        const body = JSON.parse(JSON.stringify(next)) as JsonObject;
        return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: found.revision, body }], detail: { agent: request.agent, occurrenceId: request.occurrenceId, key: request.key } };
      },
    }));
  };

  /** What this host says about an agent a pause holds: undefined when it is not at rest by a stop (the pause's own answer stands). With `meetingWake: false` the wake is not counted (new work, such as choosing a reviewer, must not go to a stopped agent that is only up for a meeting). */
  availability = async (principalId: string, options?: { readonly meetingWake?: boolean }): Promise<Availability | undefined> => {
    const agentId = AGENT.exec(typeof principalId === "string" ? principalId : "")?.[1];
    if (agentId === undefined) return undefined;
    const rest = await this.#life.rest(agentId);
    if (rest === undefined) return undefined;
    const holds = await this.#life.holds(agentId);
    // The whole installation paused is the emergency brake; a second pause by someone else is not the stop's to lift.
    if (holds.some((h) => h.scope.kind === "installation")) return undefined;
    if (holds.some((h) => h.scope.kind !== rest.scope.kind || h.scope.id !== rest.scope.id)) return rest.state;
    return options?.meetingWake !== false && (await this.#woken(principalId, rest.intentId)) ? "available" : rest.state;
  };

  /** Every wake of the host with where it stands, for the owner (rooms already over are left out). */
  list = async (): Promise<readonly WakeView[]> => {
    const out: WakeView[] = [];
    for (const lease of await this.#leases()) {
      for (const e of lease.body.leases) {
        if (out.length >= WAKE_LIMITS.shown) return out;
        if (!(await this.#open(e.occurrenceId, lease.body.agent))) continue;
        const state = e.stoppedAt !== undefined ? "stopped" : e.gaveUpAt !== undefined ? "gave-up" : e.endedReason !== undefined ? "ended" : e.attendedAt !== undefined ? "attending" : "waiting";
        const reason = state === "ended" ? e.endedReason : e.lastError;
        out.push({ agent: lease.body.agent, occurrenceId: e.occurrenceId, projectId: e.projectId, at: e.at, state, ...(e.meetingTaskId === undefined ? {} : { meetingTaskId: e.meetingTaskId }), tries: e.tries ?? 0, ...(reason === undefined ? {} : { reason }), leaseId: lease.id, leaseRevision: lease.revision });
      }
    }
    return out;
  };

  /** The owner ends one wake: from now on the agent reports at rest again and nothing more is started for it. Repeating it is the same stop. */
  stop = async (request: { readonly occurrenceId: string; readonly agent: string; readonly by: string }): Promise<{ readonly found: boolean; readonly attended: boolean }> => {
    const lease = (await this.#runner.get(WAKE_LEASE_KIND, derivedId("mwl", request.agent)))?.body as unknown as LeaseBody | undefined;
    const entry = lease?.leases.find((l) => l.occurrenceId === request.occurrenceId);
    if (entry === undefined) return { found: false, attended: false };
    if (entry.stoppedAt === undefined) await this.#amend(request.agent, request.occurrenceId, `mwl-stop-${digestOf(entry.key)}`, "stop", (e) => e.stoppedAt === undefined ? { ...e, stoppedAt: this.#runner.now(), stoppedBy: request.by } : e);
    return { found: true, attended: entry.attendedAt !== undefined };
  };

  /**
   * One pass of the host's loop (card M04h). For each wake of an open room that has not been brought in: the agent is prepared (it has nothing to leave) and joined through the attendance service, which creates the bounded meeting task and the
   * permission that lets only that task run past the stop; the dispatcher then claims the task through its ordinary checks (pause, route, budget, grant, host, lease). A pass brings at most `perPass` agents in, never more than `active`
   * attend at once, and after `tries` failed passes a wake is given up with the reason. A wake the owner stopped is finished here when a crash cut the stop off (the agent leaves its room). Every step is repeatable: a crash anywhere leaves a state the next pass completes.
   */
  attend = async (by: Principal, attender: WakeAttender): Promise<WakePass> => {
    let attended = 0, waiting = 0, gaveUp = 0, settled = 0, active = 0;
    const todo: { agent: string; entry: LeaseEntry }[] = [];
    for (const lease of await this.#leases()) {
      const agent = lease.body.agent;
      for (const e of lease.body.leases) {
        if (e.settledAt !== undefined) continue;
        const open = await this.#open(e.occurrenceId, agent);
        // A wake the owner stopped is made final (the agent leaves, its attempt ends), whatever state the room is in; so is one whose agent left or whose room is over.
        if (e.stoppedAt !== undefined || e.attendedAt !== undefined) {
          try {
            const seat = await attender.seat(by, e.occurrenceId, agent);
            // The owner's later Stop, Suspend or pause of the agent ends the wake too: the stop it was woken from is no longer what holds it (a resumed agent, which reads as not at rest, simply attends on).
            const again = e.stoppedAt === undefined && open && seat?.left !== true && (await this.#heldAgain(agent));
            const over = e.stoppedAt !== undefined || !open || seat?.left === true || again;
            if (!over) { active++; continue; }
            if (e.stoppedAt !== undefined || again) await attender.endWake(by, e.occurrenceId, agent);
            const taskId = e.meetingTaskId ?? seat?.meetingTaskId;
            const why = e.stoppedAt !== undefined ? "the owner stopped the wake of this agent" : again ? "the owner stopped, suspended or paused this agent again after the wake" : !open ? "the meeting this agent was woken for is over" : "the agent left the meeting room";
            // The wake is over as soon as the room agrees (said at once, so the owner is not told it is attending while its attempt is being stopped); it is settled only once the dispatcher has stopped the attempt too.
            if (e.stoppedAt === undefined && e.endedReason === undefined) await this.#amend(agent, e.occurrenceId, `mwl-end-${digestOf(e.key)}`, "end", (x) => x.endedReason === undefined && x.stoppedAt === undefined ? { ...x, endedReason: why } : x);
            if (taskId !== undefined) await attender.endAttempt(by, taskId, why);
            await this.#amend(agent, e.occurrenceId, `mwl-settle-${digestOf(e.key)}`, "settle", (x) => x.settledAt === undefined ? { ...x, settledAt: this.#runner.now() } : x);
            settled++;
          } catch { /* tried again on the next pass */ }
          continue;
        }
        if (!open || e.gaveUpAt !== undefined) continue;
        todo.push({ agent, entry: e });
      }
    }
    for (const { agent, entry } of todo) {
      if (attended >= WAKE_LIMITS.perPass || active >= WAKE_LIMITS.active) { waiting++; continue; }
      // A wake whose stop was replaced (the owner stopped, suspended or paused the agent again) no longer counts: it is given up with that reason, so the owner is not told it is waiting. A resumed agent (not at rest) needs no wake and is left as it is.
      if ((await this.availability(agent)) !== "available") {
        if (await this.#heldAgain(agent)) {
          await this.#amend(agent, entry.occurrenceId, `mwl-again-${digestOf(entry.key)}`, "failed", (e) => e.attendedAt !== undefined || e.stoppedAt !== undefined || e.gaveUpAt !== undefined ? e : { ...e, lastError: "the agent was stopped, suspended or paused again after the wake; wake it again if it should attend", gaveUpAt: this.#runner.now() });
          gaveUp++;
        } else waiting++;
        continue;
      }
      const tag = digestOf(entry.key);
      const tries = entry.tries ?? 0;
      let problem: string | undefined;
      let taskId: string | undefined;
      try {
        const seated = await attender.seat(by, entry.occurrenceId, agent);
        if (seated?.state === "present" && seated.meetingTaskId !== undefined) taskId = seated.meetingTaskId;
        else {
          await attender.prepare(by, { commandId: `mwl-prep-${tag}`, occurrenceId: entry.occurrenceId, agent, interrupted: [] });
          const joined = await attender.join(by, { commandId: `mwl-join-${tag}`, occurrenceId: entry.occurrenceId, agent });
          if (joined.joined) taskId = joined.meetingTaskId;
          else problem = (joined.reason ?? `the room says ${joined.state}`).slice(0, WAKE_LIMITS.reason);
        }
        if (problem === undefined && taskId === undefined) problem = "the room did not name a meeting task";
        if (problem === undefined) await attender.admit(by, { commandId: `mwl-att-${tag}`, taskId: taskId!, agent });
      } catch (error) {
        // Only the controller's own refusals are passed on; anything else is said in fixed words.
        problem = (error instanceof DomainError ? error.message : "the attendance could not be started").slice(0, WAKE_LIMITS.reason);
      }
      if (problem === undefined) {
        await this.#amend(agent, entry.occurrenceId, `mwl-in-${tag}`, "attended", (e) => e.attendedAt === undefined && e.stoppedAt === undefined ? { ...e, attendedAt: this.#runner.now(), ...(taskId === undefined ? {} : { meetingTaskId: taskId }) } : e);
        attended++; active++;
      } else {
        const giveUp = tries + 1 >= WAKE_LIMITS.tries;
        await this.#amend(agent, entry.occurrenceId, `mwl-try-${tag}-${tries + 1}`, "failed", (e) => e.attendedAt !== undefined || e.stoppedAt !== undefined || (e.tries ?? 0) > tries ? e : { ...e, tries: tries + 1, lastError: problem!, ...(giveUp ? { gaveUpAt: this.#runner.now() } : {}) });
        if (giveUp) gaveUp++; else waiting++;
      }
    }
    return { attended, waiting, gaveUp, settled };
  };

  async #leases(): Promise<{ id: string; revision: number; body: LeaseBody }[]> {
    const found = await this.#runner.list(WAKE_LEASE_KIND, { limit: WAKE_LIMITS.scan });
    return found.map((a) => ({ id: a.id, revision: a.revision, body: a.body as unknown as LeaseBody }));
  }

  /** One change to one entry of an agent's lease as its own command (the ID names the step, so a repeat after a crash is the same change); a race with another change is read again. */
  async #amend(agent: string, occurrenceId: string, commandId: string, step: string, change: (e: LeaseEntry) => LeaseEntry): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#runner.command(`meeting.host.wake-${step}`, { commandId, actor: "system" }, async () => ({
          payload: { agent, occurrenceId, step },
          build: async () => {
            const found = await this.#runner.get(WAKE_LEASE_KIND, derivedId("mwl", agent));
            if (found === undefined) throw new DomainError("not_found", "the wake does not exist");
            const lease = found.body as unknown as LeaseBody;
            const ref = { kind: WAKE_LEASE_KIND, id: found.id };
            let changed = false;
            const next: LeaseBody = { ...lease, leases: lease.leases.map((e) => { if (e.occurrenceId !== occurrenceId) return e; const n = change(e); if (n !== e) changed = true; return n; }) };
            if (!changed) return { ref, creates: false, changes: [{ type: "check" as const, ref, expectedRevision: found.revision }], detail: { agent, occurrenceId, step, unchanged: true } };
            return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: found.revision, body: JSON.parse(JSON.stringify(next)) as JsonObject }], detail: { agent, occurrenceId, step } };
          },
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }

  /** Whether a pause still holds the agent and the wake no longer makes it available: the owner stopped, suspended or paused it again (a stop still under way reads as paused). False for an agent no pause holds (it was resumed and needs no wake). */
  async #heldAgain(agent: string): Promise<boolean> {
    const agentId = AGENT.exec(agent)?.[1];
    if (agentId === undefined) return true;
    if ((await this.#life.holds(agentId)).length === 0) return false;
    return (await this.availability(agent)) !== "available";
  }

  async #woken(agent: string, intentId: string): Promise<boolean> {
    const lease = (await this.#runner.get(WAKE_LEASE_KIND, derivedId("mwl", agent)))?.body as unknown as LeaseBody | undefined;
    for (const l of lease?.leases ?? []) if (l.intentId === intentId && l.stoppedAt === undefined && l.gaveUpAt === undefined && (await this.#open(l.occurrenceId, agent))) return true;
    return false;
  }

  async #open(occurrenceId: string, agent: string): Promise<boolean> {
    const room = await this.#room(occurrenceId);
    return room !== undefined && room.state !== "ended" && room.roster.includes(agent);
  }

  async #room(occurrenceId: string): Promise<RoomView | undefined> {
    const body = (await this.#runner.get("meeting-room", derivedId("mrm", occurrenceId)))?.body as unknown as { state?: string; roster?: string[] } | undefined;
    return body === undefined || typeof body.state !== "string" ? undefined : { state: body.state, roster: body.roster ?? [] };
  }
}
