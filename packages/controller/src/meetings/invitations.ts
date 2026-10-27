import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { inTaskScope } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { Invitation, InvitationSink } from "./meetings.js";

const KIND = "meeting-inbox";
const AGENT = /^agent:[A-Za-z0-9_-]{1,80}$/;
/** An agent's inbox keeps the invitations most recently sent; older ones drop off the end. */
export const INVITATION_LIMITS = { kept: 50 } as const;

export type InvitationView = Invitation;

/**
 * The composed controller's invitation sink (card M01c): one inbox record per agent holding the 50 most recently sent invitations, latest first. An invitation is added once per `Invitation.key` (a repeat of the key,
 * from a delivery that is tried again, changes nothing). The agent reads its own through `meeting.invitations`; nothing wakes the agent. No lookup scans other agents' records.
 */
export class InvitationInbox implements InvitationSink {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): InvitationInbox {
    return new InvitationInbox(new CommandRunner(storage, epoch, options));
  }

  async invite(invitation: Invitation): Promise<void> {
    if (!AGENT.test(invitation.agent)) throw new DomainError("invalid_command", "agent must be an agent principal ID", { field: "agent" });
    const ref: AggregateRef = { kind: KIND, id: derivedId("mvi", invitation.agent) };
    // Two invitations for one agent at the same moment race on its inbox record: the loser reads again.
    for (let attempt = 0;; attempt++) {
      try {
        await this.#runner.command("meeting.invite", { commandId: `mvi:${invitation.key}`, actor: "service:dispatcher" }, async () => ({
          payload: { key: invitation.key },
          build: async () => {
            const found = await this.#runner.get(KIND, ref.id);
            const items = ((found?.body as unknown as { items?: Invitation[] } | undefined)?.items ?? []).filter((i) => i.key !== invitation.key);
            const body = { agent: invitation.agent, items: [{ ...invitation }, ...items].slice(0, INVITATION_LIMITS.kept) } as unknown as JsonObject;
            return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: found.revision, body }], detail: { occurrenceId: invitation.occurrenceId, agent: invitation.agent }, contention: async () => new DomainError("stale_revision", "the inbox changed at the same moment") };
          },
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= 5) throw error;
        // Another writer won this round: a short, uneven pause keeps writers from meeting again at the same moment.
        await new Promise((resolve) => setTimeout(resolve, 2 + Math.floor(Math.random() * 8 * (attempt + 1))));
      }
    }
  }

  /** The most recently sent invitations addressed to one agent, latest first (at most 50; meetings already held stay until pushed out). An agent reads its own; with a task credential only those of that task's project; the owner reads anyone's; anyone else gets nothing. */
  async forAgent(by: Principal, agent: string): Promise<InvitationView[]> {
    if (!AGENT.test(agent)) throw new DomainError("invalid_command", "agent must be an agent principal ID", { field: "agent" });
    if (!(by.kind === "owner" || (by.kind === "agent" && by.id === agent))) return [];
    const found = await this.#runner.get(KIND, derivedId("mvi", agent));
    const items = (found?.body as unknown as { items?: Invitation[] } | undefined)?.items ?? [];
    return by.taskScope === undefined ? items.map((i) => ({ ...i })) : items.filter((i) => inTaskScope(by, i.projectId)).map((i) => ({ ...i }));
  }
}
