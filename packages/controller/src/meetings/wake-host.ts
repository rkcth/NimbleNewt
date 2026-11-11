import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { Availability } from "../conversations/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { HostWakeRequest } from "./wake-sink.js";

/** What the host needs to know of the lifecycle; the controller supplies it from its stop and pause services. */
export interface WakeHostLifecycle {
  /** Whether the agent is at rest because a finished Suspend or Stop of its own or its team's is still the cause of its gate. */
  rest(agentId: string): Promise<{ readonly state: "suspended" | "stopped"; readonly scope: { readonly kind: string; readonly id: string } } | undefined>;
  /** The scopes whose pause holds the agent now. */
  holds(agentId: string): Promise<readonly { readonly scope: { readonly kind: string; readonly id: string } }[]>;
}

export const WAKE_LEASE_KIND = "meeting-wake-lease";
export const WAKE_LEASE_LIMIT = 20;
const AGENT = /^agent:(agt-[a-z2-7]{20})$/;

interface LeaseEntry { readonly occurrenceId: string; readonly projectId: string; readonly key: string; readonly at: string }
interface LeaseBody { readonly agent: string; readonly leases: readonly LeaseEntry[] }
interface RoomView { readonly state: string; readonly roster: readonly string[] }

/**
 * A host for the owner's meeting wake that the controller composes itself (card M04h). The agent's gate stays paused throughout, so its tasks stay held; what the wake changes is what the availability hook says: `available` while a
 * meeting room it was woken for is open (it can attend and answer there), and `stopped` or `suspended` again as soon as that room ends, with nothing to undo because nothing was lifted. The lease is a record per agent
 * naming the meetings it was woken for; the room, not a timer, decides whether it still counts. A repeated key is the same wake. A stop of the whole installation, or any pause besides the one that stopped the agent, is never
 * overridden: the agent keeps reporting what it reported before.
 */
export class MeetingWakeHost {
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
    if ((await this.#life.rest(agentId)) === undefined) throw new DomainError("unavailable", `${request.agent} is not at rest through a finished suspend or stop`);
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
        const next: LeaseBody = { agent: request.agent, leases: [...live, { occurrenceId: request.occurrenceId, projectId: request.projectId, key: request.key, at: this.#runner.now() }].slice(-WAKE_LEASE_LIMIT) };
        const ref = { kind: WAKE_LEASE_KIND, id: leaseId };
        const body = JSON.parse(JSON.stringify(next)) as JsonObject;
        return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: found.revision, body }], detail: { agent: request.agent, occurrenceId: request.occurrenceId, key: request.key } };
      },
    }));
  };

  /** What this host says about an agent a pause holds: undefined when it is not at rest by a stop (the pause's own answer stands). */
  availability = async (principalId: string): Promise<Availability | undefined> => {
    const agentId = AGENT.exec(typeof principalId === "string" ? principalId : "")?.[1];
    if (agentId === undefined) return undefined;
    const rest = await this.#life.rest(agentId);
    if (rest === undefined) return undefined;
    const holds = await this.#life.holds(agentId);
    // The whole installation paused is the emergency brake; a second pause by someone else is not the stop's to lift.
    if (holds.some((h) => h.scope.kind === "installation")) return undefined;
    if (holds.some((h) => h.scope.kind !== rest.scope.kind || h.scope.id !== rest.scope.id)) return rest.state;
    return (await this.#woken(principalId)) ? "available" : rest.state;
  };

  async #woken(agent: string): Promise<boolean> {
    const lease = (await this.#runner.get(WAKE_LEASE_KIND, derivedId("mwl", agent)))?.body as unknown as LeaseBody | undefined;
    for (const l of lease?.leases ?? []) if (await this.#open(l.occurrenceId, agent)) return true;
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
