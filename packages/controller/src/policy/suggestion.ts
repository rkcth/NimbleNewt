import { DomainError } from "../domain/errors.js";
import { onlyKnown, revision as checkRevision } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ReviewBody } from "../review/index.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { PolicyPreview, PolicyService } from "./policy.js";

/** What the owner last said to the suggestion. Approvals are counted from `answeredAt`. */
export interface SuggestionBody {
  readonly answer: "switch" | "not-now";
  readonly answeredAt: string;
  readonly answeredBy: string;
  /** When the profile was actually changed because of a `switch` answer (absent until it was). */
  readonly switchedAt?: string;
}

export interface Suggestion {
  /** True when a strict installation has seen three owner approvals since it was last asked (or since the start). */
  readonly due: boolean;
  readonly approvalsSince: number;
  readonly every: number;
  /** In plain words, what moving to the derived profile would change. Present only when due. */
  readonly preview?: PolicyPreview;
  /** The revision to answer against (0 before the first answer). */
  readonly revision: number;
}

/** Provisional (decision record, 2026-10-22): the same count as standing-rule proposals. */
export const SUGGESTION_EVERY = 3;
const SCAN = 5000;
const WINDOW_DAYS = 90;
const ID = { kind: "profile-suggestion", id: "installation" } as const;

/**
 * The strict-to-derived profile suggestion (card A07c). An installation in the strict profile asks the owner, after every third approval the owner gives, whether to move to the derived
 * profile, showing in plain words what would change. It never switches by itself: only the owner's explicit answer does. "Not now" is not asked again until three further approvals. Nothing
 * is suggested in the derived or autonomous profile (so the owner's own installation, which starts derived, never sees it).
 */
export class ProfileSuggestionService {
  readonly #runner: CommandRunner;
  readonly #policy: PolicyService;

  private constructor(runner: CommandRunner, policy: PolicyService) { this.#runner = runner; this.#policy = policy; }

  static withEpoch(storage: ControllerStorage, epoch: number, policy: PolicyService, options: RunnerOptions = {}): ProfileSuggestionService {
    return new ProfileSuggestionService(new CommandRunner(storage, epoch, options), policy);
  }

  /** Whether the suggestion is due now (owner only). */
  async check(owner: Principal): Promise<Suggestion> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner receives this suggestion`);
    return (await this.#state(owner)).suggestion;
  }

  /**
   * The owner's answer. `switch` changes the installation to the derived profile (and nothing else); `not-now` leaves it as it is. Either way the question is not asked again until three further
   * approvals. The answer is accepted only while the suggestion is due and at the revision `check` reported, judged on one read of the record. A `switch` whose change did not happen (the change
   * failed, or the profile was not strict at that moment) can be finished by repeating the answer. Returns whether the profile was changed because of the recorded answer.
   */
  async answer(owner: Principal, command: NoActor & { answer: "switch" | "not-now"; expectedRevision: number }): Promise<{ switched: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner answers this`);
    onlyKnown(command, ["commandId", "answer", "expectedRevision"]);
    if (command.answer !== "switch" && command.answer !== "not-now") throw new DomainError("invalid_command", "answer: must be switch or not-now", { field: "answer" });
    const expected = command.expectedRevision === 0 ? 0 : checkRevision(command.expectedRevision);
    const meta = { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id };
    const stored = await this.#runner.get(ID.kind, ID.id);
    const last = stored?.body as unknown as SuggestionBody | undefined;
    // Finishing an earlier "switch" that was recorded but not carried out: no new question is needed.
    if (command.answer === "switch" && last?.answer === "switch" && last.switchedAt === undefined && stored !== undefined && expected === stored.revision && (await this.#policy.effective(owner))?.profile === "strict") {
      return { switched: await this.#carryOut(owner, stored.revision) };
    }
    const done = await this.#runner.command("profile-suggestion.answer", meta, async () => ({
      payload: { answer: command.answer, expectedRevision: expected },
      build: async () => {
        const state = await this.#state(owner);
        if ((state.stored?.revision ?? 0) !== expected) throw new DomainError("stale_revision", `the suggestion is at revision ${state.stored?.revision ?? 0}, not ${expected}`, ...(state.stored === undefined ? [] : [{ currentRevision: state.stored.revision }]));
        if (!state.suggestion.due) throw new DomainError("invalid_command", "the suggestion is not due: it is made only on a strict installation after three further owner approvals", { field: "answer" });
        const ref: AggregateRef = { kind: ID.kind, id: ID.id };
        const next: SuggestionBody = { answer: command.answer, answeredAt: this.#runner.now(), answeredBy: owner.id };
        return { ref, creates: state.stored === undefined, changes: [state.stored === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: state.stored.revision, body: next as unknown as JsonObject }], detail: { answer: command.answer }, contention: async () => new DomainError("stale_revision", "the suggestion was answered meanwhile") };
      },
    }));
    if (command.answer !== "switch") return { switched: false };
    const record = (await this.#runner.get(ID.kind, ID.id))!;
    const body = record.body as unknown as SuggestionBody;
    // A replay of an answer whose change was already carried out (or that has been superseded by a later answer) changes nothing.
    if (body.switchedAt !== undefined) return { switched: true };
    if (record.revision !== done.revision || body.answer !== "switch") return { switched: false };
    return { switched: await this.#carryOut(owner, record.revision) };
  }

  /** Moves the installation to derived if it is still strict, and records that it did. */
  async #carryOut(owner: Principal, revision: number): Promise<boolean> {
    const effective = await this.#policy.effective(owner);
    if (effective?.profile !== "strict") return false;
    const installation = effective.revisions.installation;
    await this.#policy.set(owner, { commandId: `profile-suggestion-switch-${revision}`, scope: "installation", profile: "derived", ...(installation > 0 ? { expectedRevision: installation } : {}) });
    const ref: AggregateRef = { kind: ID.kind, id: ID.id };
    await this.#runner.command("profile-suggestion.switched", { commandId: scopedCommandId(owner.id, `profile-suggestion-switched-${revision}`), actor: owner.id }, async () => ({
      payload: { revision },
      build: async () => {
        const current = await this.#runner.existing(ID.kind, ID.id, revision);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as SuggestionBody), switchedAt: this.#runner.now() } as unknown as JsonObject }], detail: {} };
      },
    }));
    return true;
  }

  /** One read of the record, the policy and the approvals, and what they say. */
  async #state(owner: Principal): Promise<{ stored: { revision: number; body: SuggestionBody } | undefined; suggestion: Suggestion }> {
    const found = await this.#runner.get(ID.kind, ID.id);
    const stored = found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as SuggestionBody };
    const revision = stored?.revision ?? 0;
    const effective = await this.#policy.effective(owner);
    if (effective === undefined || effective.profile !== "strict") return { stored, suggestion: { due: false, approvalsSince: 0, every: SUGGESTION_EVERY, revision } };
    const now = this.#runner.now();
    const floor = new Date(Date.parse(now) - WINDOW_DAYS * 86_400_000).toISOString();
    const since = stored !== undefined && stored.body.answeredAt > floor ? stored.body.answeredAt : floor;
    const approvalsSince = await this.#ownerApprovalsAfter(since);
    if (approvalsSince < SUGGESTION_EVERY) return { stored, suggestion: { due: false, approvalsSince, every: SUGGESTION_EVERY, revision } };
    return { stored, suggestion: { due: true, approvalsSince, every: SUGGESTION_EVERY, revision, preview: await this.#policy.preview(owner, { scope: "installation", profile: "derived" }) } };
  }

  async #ownerApprovalsAfter(since: string): Promise<number> {
    let count = 0; let seen = 0;
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("review", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as ReviewBody;
        if ((b.decidedAt ?? "") <= since) continue;
        seen += 1;
        if (seen > SCAN) throw new DomainError("unavailable", `there are more than ${SCAN} recent reviews, too many to look through safely`);
        if ((b.state === "approved" || b.state === "used") && (b.decidedBy ?? "").startsWith("owner:")) count += 1;
      }
      if (page.length < 500) return count;
    }
  }
}
