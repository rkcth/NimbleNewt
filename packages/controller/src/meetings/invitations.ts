import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage } from "../storage/types.js";
import type { Invitation, InvitationSink } from "./meetings.js";

const KIND = "meeting-invitation";
const AGENT = /^agent:[A-Za-z0-9_-]{1,80}$/;
export const INVITATION_LIMITS = { page: 50, scan: 5000 } as const;

export interface InvitationView extends Invitation { readonly id: string }

/**
 * The composed controller's invitation sink (card M01c): an invitation is a durable record addressed to the agent, written once per `Invitation.key`. The agent (or the owner for it) reads its invitations
 * through `meeting.invitations`; nothing wakes the agent. A repeat of a key changes nothing.
 */
export class InvitationInbox implements InvitationSink {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): InvitationInbox {
    return new InvitationInbox(new CommandRunner(storage, epoch, options));
  }

  async invite(invitation: Invitation): Promise<void> {
    const id = derivedId("mvi", invitation.key);
    const ref = { kind: KIND, id };
    await this.#runner.command("meeting.invite", { commandId: `mvi:${invitation.key}`, actor: "service:dispatcher" }, async () => ({
      payload: { key: invitation.key },
      build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: { ...invitation } as never }], detail: { occurrenceId: invitation.occurrenceId, agent: invitation.agent } }),
    }));
  }

  /** The invitations addressed to one agent, oldest meeting first. An agent reads its own; the owner reads anyone's; anyone else gets nothing. */
  async forAgent(by: Principal, agent: string): Promise<InvitationView[]> {
    if (!AGENT.test(agent)) throw new DomainError("invalid_command", "agent must be an agent principal ID", { field: "agent" });
    if (!(by.kind === "owner" || (by.id === agent && by.taskScope === undefined && by.kind === "agent"))) return [];
    const found: InvitationView[] = [];
    for (let after: string | undefined, seen = 0;;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of page) {
        after = a.id;
        const body = a.body as unknown as Invitation;
        if (body.agent === agent) found.push({ ...body, id: a.id });
      }
      seen += page.length;
      if (seen > INVITATION_LIMITS.scan) throw new DomainError("unavailable", "too many invitations to look through safely");
      if (page.length < 100) break;
    }
    return found.sort((x, y) => (x.startsAt < y.startsAt ? -1 : x.startsAt > y.startsAt ? 1 : 0)).slice(0, INVITATION_LIMITS.page);
  }
}
