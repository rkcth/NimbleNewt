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
  readonly answer: "switch" | "trial" | "not-now" | "keep" | "extend" | "revert";
  readonly answeredAt: string;
  readonly answeredBy: string;
  /** When the profile was actually changed to derived because of a `switch` or `trial` answer (absent until it was). */
  readonly switchedAt?: string;
  /** When the profile was put back to strict because of a `revert` answer. */
  readonly revertedAt?: string;
  /** A trial of the derived profile: when it ends and the owner is asked again. Present after `trial` and `extend`, gone after `keep`, `revert` or a permanent switch. */
  readonly trial?: { readonly until: string };
}

export type SuggestionKind = "switch" | "trial-ended";
export type SuggestionAnswer = SuggestionBody["answer"];

export interface Suggestion {
  /** True when the owner should be asked: a strict installation after three owner approvals since it was last asked, or a trial of the derived profile that has ended. */
  readonly due: boolean;
  readonly kind?: SuggestionKind;
  /** What may be answered, the first being the default (permanent: `switch`, or `keep`). */
  readonly answers?: readonly SuggestionAnswer[];
  readonly approvalsSince: number;
  readonly every: number;
  /** In plain words, what the change would do. Present only when due. */
  readonly preview?: PolicyPreview;
  /** The revision to answer against (0 before the first answer). */
  readonly revision: number;
}

/** Provisional (decision record, 2026-10-22): the same count as standing-rule proposals, and a trial of seven days. */
export const SUGGESTION_EVERY = 3;
export const TRIAL_DAYS = 7;
const SCAN = 5000;
const WINDOW_DAYS = 90;
const ID = { kind: "profile-suggestion", id: "installation" } as const;
const ANSWERS: Readonly<Record<SuggestionKind, readonly SuggestionAnswer[]>> = { switch: ["switch", "trial", "not-now"], "trial-ended": ["keep", "extend", "revert"] };

/**
 * The strict-to-derived profile suggestion (card A07c). An installation in the strict profile asks the owner, after every third approval the owner gives, whether to move to the derived profile,
 * showing in plain words what would change. The answers are: switch permanently (the default), try it for seven days, or not now. A trial switches at once; when it ends the owner is asked again:
 * keep it permanently (the default), seven more days, or back to strict. Nothing is switched back by itself: a trial that is not answered stays derived. It never switches without the owner's
 * explicit answer, "not now" is not asked again until three further approvals, and nothing is suggested in the derived profile outside a trial (so the owner's own installation, which starts derived,
 * never sees it).
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
   * The owner's answer, accepted only while the suggestion is due and at the revision `check` reported, judged on one read of the record, and only one of the answers the suggestion offers.
   * `switch` moves to derived for good and `trial` moves to derived for seven days; `keep`, `extend` and `revert` answer a trial that has ended. A change that was recorded but not carried out
   * (it failed, or the profile was not as expected at that moment) is finished by repeating the answer. Returns whether the profile was changed to derived or back to strict because of the recorded answer.
   */
  async answer(owner: Principal, command: NoActor & { answer: SuggestionAnswer; expectedRevision: number }): Promise<{ switched: boolean; reverted: boolean }> {
    return this.#answer(owner, command, true);
  }

  /**
   * The same switch, offered from somewhere else (a standing-rule proposal can be answered by moving to the derived profile instead): `switch` or `trial` on a strict installation, whether or not the
   * suggestion is due. Owner only.
   */
  async switchNow(owner: Principal, command: NoActor & { answer: "switch" | "trial" }): Promise<{ switched: boolean }> {
    if (command.answer !== "switch" && command.answer !== "trial") throw new DomainError("invalid_command", "answer: must be switch or trial", { field: "answer" });
    const stored = await this.#runner.get(ID.kind, ID.id);
    const r = await this.#answer(owner, { commandId: command.commandId, answer: command.answer, expectedRevision: stored?.revision ?? 0 }, false);
    return { switched: r.switched };
  }

  /** Whether the installation is in the strict profile now (owner only). */
  async isStrict(owner: Principal): Promise<boolean> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    return (await this.#policy.effective(owner))?.profile === "strict";
  }

  async #answer(owner: Principal, command: NoActor & { answer: SuggestionAnswer; expectedRevision: number }, requireDue: boolean): Promise<{ switched: boolean; reverted: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner answers this`);
    onlyKnown(command, ["commandId", "answer", "expectedRevision"]);
    if (!["switch", "trial", "not-now", "keep", "extend", "revert"].includes(command.answer)) throw new DomainError("invalid_command", "answer: must be one of switch, trial, not-now, keep, extend, revert", { field: "answer" });
    const expected = command.expectedRevision === 0 ? 0 : checkRevision(command.expectedRevision);
    const meta = { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id };
    const stored = await this.#runner.get(ID.kind, ID.id);
    const last = stored?.body as unknown as SuggestionBody | undefined;
    const profile = (await this.#policy.effective(owner))?.profile;
    // Finishing an earlier answer that was recorded but not carried out: no new question is needed.
    if (stored !== undefined && last !== undefined && expected === stored.revision && command.answer === last.answer) {
      if ((last.answer === "switch" || last.answer === "trial") && last.switchedAt === undefined && profile === "strict") return { switched: await this.#carryOut(owner, stored.revision, "derived"), reverted: false };
      if (last.answer === "revert" && last.revertedAt === undefined && profile === "derived") return { switched: false, reverted: await this.#carryOut(owner, stored.revision, "strict") };
    }
    const done = await this.#runner.command("profile-suggestion.answer", meta, async () => ({
      payload: requireDue ? { answer: command.answer, expectedRevision: expected, requireDue } : { answer: command.answer, requireDue },
      build: async () => {
        const state = await this.#state(owner);
        if ((state.stored?.revision ?? 0) !== expected) throw new DomainError("stale_revision", `the suggestion is at revision ${state.stored?.revision ?? 0}, not ${expected}`, ...(state.stored === undefined ? [] : [{ currentRevision: state.stored.revision }]));
        if (requireDue) {
          if (!state.suggestion.due) throw new DomainError("invalid_command", "the suggestion is not due: it is made on a strict installation after three further owner approvals, and when a trial of the derived profile ends", { field: "answer" });
          if (!state.suggestion.answers!.includes(command.answer)) throw new DomainError("invalid_command", `answer: this question takes ${state.suggestion.answers!.join(", ")}`, { field: "answer" });
        } else if (state.profile !== "strict") throw new DomainError("invalid_command", "only a strict installation can be switched to the derived profile", { field: "answer" });
        const now = this.#runner.now();
        const trial = command.answer === "trial" || command.answer === "extend" ? { trial: { until: new Date(Date.parse(now) + TRIAL_DAYS * 86_400_000).toISOString() } } : {};
        const ref: AggregateRef = { kind: ID.kind, id: ID.id };
        const next: SuggestionBody = { answer: command.answer, answeredAt: now, answeredBy: owner.id, ...trial };
        return { ref, creates: state.stored === undefined, changes: [state.stored === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: state.stored.revision, body: next as unknown as JsonObject }], detail: { answer: command.answer }, contention: async () => new DomainError("stale_revision", "the suggestion was answered meanwhile") };
      },
    }));
    const record = (await this.#runner.get(ID.kind, ID.id))!;
    const body = record.body as unknown as SuggestionBody;
    // A replay of an answer whose change was already carried out (or that a later answer has superseded) changes nothing.
    if (record.revision !== done.revision || body.answer !== command.answer) return { switched: body.switchedAt !== undefined && (command.answer === "switch" || command.answer === "trial"), reverted: body.revertedAt !== undefined && command.answer === "revert" };
    if (command.answer === "switch" || command.answer === "trial") return { switched: body.switchedAt !== undefined || (await this.#carryOut(owner, record.revision, "derived")), reverted: false };
    if (command.answer === "revert") return { switched: false, reverted: body.revertedAt !== undefined || (await this.#carryOut(owner, record.revision, "strict")) };
    return { switched: false, reverted: false };
  }

  /** Moves the installation to the given profile if it is still on the other one, and records that it did. */
  async #carryOut(owner: Principal, revision: number, to: "derived" | "strict"): Promise<boolean> {
    const effective = await this.#policy.effective(owner);
    if (effective?.profile !== (to === "derived" ? "strict" : "derived")) return false;
    const installation = effective.revisions.installation;
    await this.#policy.set(owner, { commandId: `profile-suggestion-${to}-${revision}`, scope: "installation", profile: to, ...(installation > 0 ? { expectedRevision: installation } : {}) });
    const ref: AggregateRef = { kind: ID.kind, id: ID.id };
    await this.#runner.command("profile-suggestion.carried-out", { commandId: scopedCommandId(owner.id, `profile-suggestion-done-${to}-${revision}`), actor: owner.id }, async () => ({
      payload: { revision, to },
      build: async () => {
        const current = await this.#runner.existing(ID.kind, ID.id, revision);
        const at = this.#runner.now();
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...(current.body as unknown as SuggestionBody), ...(to === "derived" ? { switchedAt: at } : { revertedAt: at }) } as unknown as JsonObject }], detail: {} };
      },
    }));
    return true;
  }

  /** One read of the record, the policy and the approvals, and what they say. */
  async #state(owner: Principal): Promise<{ profile: string | undefined; stored: { revision: number; body: SuggestionBody } | undefined; suggestion: Suggestion }> {
    const found = await this.#runner.get(ID.kind, ID.id);
    const stored = found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as SuggestionBody };
    const revision = stored?.revision ?? 0;
    const effective = await this.#policy.effective(owner);
    const profile = effective?.profile;
    const now = this.#runner.now();
    // A trial of the derived profile that has ended: ask again.
    if (profile === "derived" && stored?.body.trial !== undefined && stored.body.trial.until <= now && (stored.body.answer === "trial" || stored.body.answer === "extend")) {
      return { profile, stored, suggestion: { due: true, kind: "trial-ended", answers: ANSWERS["trial-ended"], approvalsSince: 0, every: SUGGESTION_EVERY, revision, preview: await this.#policy.preview(owner, { scope: "installation", profile: "strict" }) } };
    }
    if (effective === undefined || profile !== "strict") return { profile, stored, suggestion: { due: false, approvalsSince: 0, every: SUGGESTION_EVERY, revision } };
    const floor = new Date(Date.parse(now) - WINDOW_DAYS * 86_400_000).toISOString();
    const since = stored !== undefined && stored.body.answeredAt > floor ? stored.body.answeredAt : floor;
    const approvalsSince = await this.#ownerApprovalsAfter(since);
    if (approvalsSince < SUGGESTION_EVERY) return { profile, stored, suggestion: { due: false, approvalsSince, every: SUGGESTION_EVERY, revision } };
    return { profile, stored, suggestion: { due: true, kind: "switch", answers: ANSWERS.switch, approvalsSince, every: SUGGESTION_EVERY, revision, preview: await this.#policy.preview(owner, { scope: "installation", profile: "derived" }) } };
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
