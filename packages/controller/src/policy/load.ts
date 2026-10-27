import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { GrantService } from "../security/grants.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ReviewBody } from "../review/index.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { ActionCatalog, type ActionClass, type Environment } from "./catalog.js";
import type { Decision } from "./engine.js";
import type { PolicyBody } from "./policy.js";
import type { ProfileSuggestionService } from "./suggestion.js";

/** A suggestion to turn a run of the same approval into a standing rule (card A07b). It changes nothing until the owner accepts it. */
export interface ProposalBody {
  readonly requester: string;
  readonly projectId: string;
  readonly cls: ActionClass;
  readonly environment: Environment;
  /** The approvals it is drawn from, newest last (IDs and tools, so the owner can see exactly what it would have covered). */
  readonly covered: readonly { readonly reviewId: string; readonly tool: string; readonly at: string }[];
  readonly count: number;
  /** The grant that accepting it would make: an approval grant for the class, in this project and environment only, for a limited time. */
  readonly suggestion: { readonly action: string; readonly project: string; readonly environments: readonly string[]; readonly days: number };
  /** The lengths the owner can pick from, and the one the system chose for them with the reason, in plain words (card A07d). `suggestion.days` is the default. */
  readonly lengthOptions?: readonly number[];
  readonly defaultLength?: { readonly days: number; readonly why: string };
  /** What the owner's acceptance fixed: the length used and how it was chosen. The grant expires that many days after the acceptance. */
  readonly chosenLength?: { readonly days: number; readonly source: "owner" | "default"; readonly why: string };
  readonly state: "open" | "accepted" | "dismissed";
  readonly createdAt: string;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly reason?: string;
  readonly grantId?: string;
  /** How an accepted proposal was answered: by the suggested grant, or by switching the installation to the derived profile instead. */
  readonly via?: "grant" | "profile";
  /** After a dismissal, no new proposal for the same thing before this time. */
  readonly quietUntil?: string;
}

export interface CounterBody { readonly day: string; readonly cells: Readonly<Record<string, number>> }

/** Provisional numbers (decision record, 2026-10-20): adjustable. */
export const LOAD_LIMITS = { approvalsToPropose: 3, proposalDays: 30, quietDays: 30, scan: 5000, window: 90 } as const;
/** The fixed lengths a standing grant can be offered for, in days (provisional, card A07d). No derived length is longer than the last. */
export const GRANT_LENGTHS: readonly number[] = [1, 7, 30, 90];

export interface LengthInputs {
  /** Days from the first to the last of the approvals the proposal is drawn from. */
  readonly spanDays: number;
  /** Earlier standing grants of the same class that have ended: how long each was approved for and whether the owner revoked it before its end. */
  readonly earlier: readonly { readonly days: number; readonly revoked: boolean }[];
  /** A length the owner stated in words (days); it wins over everything derived. */
  readonly statedDays?: number;
  /** The work is marked as a one-off. */
  readonly oneOff?: boolean;
}

const dayWord = (n: number): string => `${n} day${n === 1 ? "" : "s"}`;
const optionAtLeast = (days: number): number => GRANT_LENGTHS.find((o) => o >= days) ?? GRANT_LENGTHS[GRANT_LENGTHS.length - 1]!;

/**
 * The length the system chooses for a standing grant, with the reason in plain words (card A07d). In order: a length the owner stated in words (used as stated, at most the longest option); a one-off piece of
 * work (the shortest option); what earlier grants of the class showed (one the owner revoked early: the next shorter option than the shortest such; ones that ran to their end: the next longer option than the longest);
 * the span of the approvals themselves (the shortest option that covers it); when none of these says anything, 30 days.
 */
export function chooseStandingLength(input: LengthInputs): { days: number; why: string } {
  const longest = GRANT_LENGTHS[GRANT_LENGTHS.length - 1]!;
  if (input.statedDays !== undefined) {
    const days = Math.min(longest, input.statedDays);
    return { days, why: `you asked for ${dayWord(input.statedDays)}${days === input.statedDays ? "" : `; the longest a standing rule runs is ${dayWord(longest)}`}` };
  }
  if (input.oneOff === true) return { days: GRANT_LENGTHS[0]!, why: `this is marked as one-off work, so ${dayWord(GRANT_LENGTHS[0]!)} is enough` };
  const early = input.earlier.filter((e) => e.revoked);
  if (early.length > 0) {
    const shortest = Math.min(...early.map((e) => e.days));
    const days = [...GRANT_LENGTHS].reverse().find((o) => o < shortest) ?? GRANT_LENGTHS[0]!;
    return { days, why: `an earlier standing rule of this kind was taken back before its ${dayWord(shortest)} were up, so ${dayWord(days)} this time` };
  }
  if (input.earlier.length > 0) {
    const longestRan = Math.max(...input.earlier.map((e) => e.days));
    const days = GRANT_LENGTHS.find((o) => o > longestRan) ?? longest;
    return { days, why: `an earlier standing rule of this kind ran its full ${dayWord(longestRan)} and you approved the same again, so ${dayWord(days)} this time` };
  }
  if (input.spanDays > 0) {
    const days = optionAtLeast(Math.ceil(input.spanDays));
    return { days, why: `you approved this over ${input.spanDays < 1 ? "less than a day" : dayWord(Math.ceil(input.spanDays))}, so ${dayWord(days)} covers the same pattern` };
  }
  return { days: LOAD_LIMITS.proposalDays, why: `there is nothing to go on yet, so the usual ${dayWord(LOAD_LIMITS.proposalDays)}` };
}

const COUNTER_SHARDS = 8;
/** Classes whose approvals never turn into a standing rule: they stay decisions or run code. */
const NEVER_PROPOSED = new Set<ActionClass>(["access-change", "spend", "install-executable"]);
const PROPOSABLE_ENVIRONMENTS = new Set<Environment>(["development", "testing"]);
const ACTION_ID = /^[A-Za-z0-9._:-]{1,100}$/;
const PROPOSAL_ID = /^spr-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const spanOf = (p: ProposalBody): number => (p.covered.length < 2 ? 0 : Math.max(0, (Date.parse(p.covered[p.covered.length - 1]!.at) - Date.parse(p.covered[0]!.at)) / 86_400_000));
const dayOf = (iso: string): string => iso.slice(0, 10);
const addDays = (iso: string, days: number): string => new Date(Date.parse(iso) + days * 86_400_000).toISOString();

export interface LoadFigures {
  readonly days: number;
  /** Per day: decisions the owner made, and the other deciders. */
  readonly perDay: readonly { day: string; ownerDecisions: number; agentDecisions: number }[];
  readonly ownerDecisions: number;
  readonly agentDecisions: number;
  /** Average time from the request being made (not from reaching the owner) to the owner's decision, in minutes; null when there are none. */
  readonly averageOwnerWaitMinutes: number | null;
  /** Of the actions the policy decided, how many ran by a rule or grant, went to an agent review, or went to the owner (from what the dispatcher recorded). */
  readonly decidedBy: { readonly rule: number; readonly grant: number; readonly agentReview: number; readonly owner: number; readonly denied: number };
  readonly pending: readonly { reviewId: string; requester: string; tool: string; projectId: string; waitingOn: "owner" | "agent-review"; waitingMinutes: number }[];
}

/**
 * Standing-rule proposals and the approval-load figures (card A07b). The owner's repeated approvals of the same class of action, for the same requester in the same project and environment,
 * produce one proposal to stand for them (an approval grant, scoped and expiring); it is never applied unasked, never proposed for a tool the project reserves for the owner or for an
 * unclassified action, and a dismissal keeps it quiet for a while. The figures (owner decisions per day, how long asks wait, how many were decided by rule, grant, agent review or owner, and
 * every ask still waiting with its age) are what the approval-load view and the real-agent trial read.
 */
export class ApprovalLoadService {
  readonly #runner: CommandRunner;
  readonly #grants: GrantService;
  readonly #catalog: ActionCatalog;

  readonly #profile: ProfileSuggestionService | undefined;

  private constructor(runner: CommandRunner, grants: GrantService, catalog: ActionCatalog, profile: ProfileSuggestionService | undefined) { this.#runner = runner; this.#grants = grants; this.#catalog = catalog; this.#profile = profile; }

  static withEpoch(storage: ControllerStorage, epoch: number, grants: GrantService, options: RunnerOptions & { catalog?: ActionCatalog; profile?: ProfileSuggestionService } = {}): ApprovalLoadService {
    return new ApprovalLoadService(new CommandRunner(storage, epoch, options), grants, options.catalog ?? ActionCatalog.default, options.profile);
  }

  /**
   * The dispatcher records what the policy decided for an action, so the figures can say how much ran by rule. The action's own ID names the record, so recording it twice counts once.
   * An internal call for the dispatcher: it must not be exposed through the state API.
   */
  async recordDecision(decision: Decision, context: { actionId: string }): Promise<void> {
    if (typeof context?.actionId !== "string" || !ACTION_ID.test(context.actionId)) invalid("actionId", "must be the dispatcher's ID for the action (letters, digits, . _ : -, up to 100)");
    const key = `${decision.cls}.${decision.tier}|${decision.mode}|${decision.via}`;
    for (let attempt = 1; ; attempt++) {
      try {
        const day = dayOf(this.#runner.now());
        // Counters are kept in a few shards a day, picked at random, so decisions recorded at the same moment seldom meet; readers add the shards up.
        const shard = `${day}.${Math.floor(Math.random() * COUNTER_SHARDS)}`;
        const found = await this.#runner.get("approval-counter", shard);
        const body = (found?.body as unknown as CounterBody | undefined) ?? { day, cells: {} };
        const next: CounterBody = { day, cells: { ...body.cells, [key]: (body.cells[key] ?? 0) + 1 } };
        const ref: AggregateRef = { kind: "approval-counter", id: shard };
        await this.#runner.command("approval.decision", { commandId: scopedCommandId("policy", `decision-${context.actionId}`), actor: "policy" }, async () => ({
          payload: { key },
          build: async () => ({ ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { key }, contention: async () => new DomainError("stale_revision", "another decision was recorded at the same moment") }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 12) throw error;
        await new Promise((resolve) => setTimeout(resolve, Math.round(Math.random() * 8 * attempt)));
      }
    }
  }

  /**
   * Looks through the owner's decisions and opens a proposal for each run of the same approval that has reached the threshold and has none open (owner only). Proposals are drawn from
   * reviews the owner allowed; a tool the project reserves for the owner and an unclassified tool never count. Repeating the call opens nothing twice.
   */
  async propose(owner: Principal, command: NoActor): Promise<{ opened: string[] }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner receives standing-rule proposals`);
    onlyKnown(command, ["commandId"]);
    const now = this.#runner.now();
    const runs = new Map<string, { requester: string; projectId: string; cls: ActionClass; environment: Environment; covered: { reviewId: string; tool: string; at: string }[] }>();
    const policies = new Map<string, { environment: Environment; reserved: readonly string[] }>();
    const since = addDays(now, -LOAD_LIMITS.window);
    for (const r of await this.#ownerDecided(since)) {
      const cls = this.#catalog.classify(r.body.operation.name, r.body.operation.target.kind);
      if (cls === "unknown" || NEVER_PROPOSED.has(cls)) continue;
      const projectId = r.body.binding.projectId;
      let project = policies.get(projectId);
      if (project === undefined) {
        const stored = (await this.#runner.get("approval-policy", projectId))?.body as unknown as PolicyBody | undefined;
        const reserved = ((await this.#runner.get("review-policy", projectId))?.body as unknown as { mandatoryHuman?: readonly string[] } | undefined)?.mandatoryHuman ?? [];
        project = { environment: stored?.environment ?? "development", reserved };
        policies.set(projectId, project);
      }
      // Only the free environments: the environment is the project's now, not recorded per approval, so an approval is never carried into a guarded or live one.
      if (project.reserved.includes(r.body.operation.name) || !PROPOSABLE_ENVIRONMENTS.has(project.environment)) continue;
      const key = `${r.body.binding.requester}|${projectId}|${cls}|${project.environment}`;
      const run = runs.get(key) ?? { requester: r.body.binding.requester, projectId, cls, environment: project.environment, covered: [] };
      run.covered.push({ reviewId: r.id, tool: r.body.operation.name, at: r.body.decidedAt ?? r.body.requestedAt });
      runs.set(key, run);
    }
    const opened: string[] = [];
    for (const [key, run] of runs) {
      if (run.covered.length < LOAD_LIMITS.approvalsToPropose) continue;
      const id = derivedId("spr", key);
      const ref: AggregateRef = { kind: "standing-proposal", id };
      const existing = await this.#runner.get("standing-proposal", id);
      const old = existing?.body as unknown as ProposalBody | undefined;
      if (old !== undefined) {
        const latest = run.covered[run.covered.length - 1]!.at;
        // An open proposal stands. A dismissed one stays quiet for a while and is offered again only after a newer approval; an accepted one only once its grant has ended and the owner has approved again since.
        if (old.state === "open") continue;
        if (old.state === "dismissed" && ((old.quietUntil ?? "") > now || latest <= (old.decidedAt ?? ""))) continue;
        if (old.state === "accepted" && ((await this.#grantLive(old.grantId, now)) || latest <= (old.decidedAt ?? ""))) continue;
      }
      const first = Date.parse(run.covered[0]!.at), last = Date.parse(run.covered[run.covered.length - 1]!.at);
      const chosen = chooseStandingLength({ spanDays: Math.max(0, (last - first) / 86_400_000), earlier: await this.#earlierGrants(run.cls, now) });
      const body: ProposalBody = {
        requester: run.requester, projectId: run.projectId, cls: run.cls, environment: run.environment, covered: run.covered.slice(-20), count: run.covered.length,
        suggestion: { action: `approve.class.${run.cls}`, project: run.projectId, environments: [run.environment], days: chosen.days }, lengthOptions: GRANT_LENGTHS, defaultLength: chosen, state: "open", createdAt: now,
      };
      await this.#runner.command("approval.propose", { commandId: scopedCommandId(owner.id, `${command.commandId}.${id}`), actor: owner.id }, async () => ({
        payload: { id, count: body.count },
        build: async () => ({ ref, creates: existing === undefined, changes: [existing === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject }], detail: { requester: run.requester, cls: run.cls, count: body.count } }),
      }));
      opened.push(id);
    }
    return { opened };
  }

  /** The owner's proposals, newest ID last, with what each would have covered. */
  async proposals(owner: Principal, state?: ProposalBody["state"]): Promise<View<ProposalBody>[]> {
    if (owner.kind !== "owner") return [];
    const out: View<ProposalBody>[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("standing-proposal", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const p of page) { after = p.id; if (state === undefined || (p.body as unknown as ProposalBody).state === state) out.push(view<ProposalBody>(p)); }
      if (page.length < 200) return out;
    }
  }

  /**
   * The owner accepts a proposal: the proposal is marked accepted, then the approval grant is made for the requester, scoped to the project and environment and expiring 30 days after the
   * acceptance. The grant's command ID and expiry come from the stored proposal, so a repeated call (or a retry after a failure between the steps) makes no second grant and finishes the link.
   */
  async accept(owner: Principal, command: NoActor & { proposalId: string; expectedRevision: number; days?: number; statedDays?: number; oneOff?: boolean }): Promise<{ grantId: string; days: number; why: string }> {
    this.#shape(owner, command, ["commandId", "proposalId", "expectedRevision", "days", "statedDays", "oneOff"]);
    const whole = (v: unknown, field: string): number | undefined => (v === undefined ? undefined : Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= 3650 ? (v as number) : invalid(field, "must be a whole number of days from 1 to 3650"));
    const days = whole(command.days, "days"), statedDays = whole(command.statedDays, "statedDays");
    if (command.oneOff !== undefined && typeof command.oneOff !== "boolean") invalid("oneOff", "must be true or false");
    if (days !== undefined && days > GRANT_LENGTHS[GRANT_LENGTHS.length - 1]!) invalid("days", `a standing rule runs at most ${dayWord(GRANT_LENGTHS[GRANT_LENGTHS.length - 1]!)}`);
    if (days !== undefined && (statedDays !== undefined || command.oneOff !== undefined)) invalid("days", "give a length, or what to derive it from, not both");
    const done = await this.#runner.command("approval.accept", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { proposalId: command.proposalId, expectedRevision: command.expectedRevision, days: days ?? null, statedDays: statedDays ?? null, oneOff: command.oneOff ?? null },
      build: async () => {
        const current = await this.#runner.existing("standing-proposal", command.proposalId, command.expectedRevision);
        const body = current.body as unknown as ProposalBody;
        if (body.state !== "open") throw new DomainError("invalid_command", `proposal ${current.id} is ${body.state}`, { field: "proposalId" });
        const ref: AggregateRef = { kind: "standing-proposal", id: current.id };
        const at = this.#runner.now();
        // The length is fixed in the same step that accepts, so a retry after a failure makes the same grant. The owner's own length is used exactly; otherwise it is derived again with what the owner said.
        const length = days !== undefined
          ? { days, source: "owner" as const, why: `you picked ${dayWord(days)}` }
          : statedDays === undefined && command.oneOff !== true && body.defaultLength !== undefined
            ? { days: body.defaultLength.days, source: "default" as const, why: body.defaultLength.why }
            : { ...chooseStandingLength({ spanDays: spanOf(body), earlier: await this.#earlierGrants(body.cls, at), ...(statedDays === undefined ? {} : { statedDays }), ...(command.oneOff === true ? { oneOff: true } : {}) }), source: "default" as const };
        const next: ProposalBody = { ...body, state: "accepted", decidedBy: owner.id, decidedAt: at, chosenLength: length, suggestion: { ...body.suggestion, days: length.days } };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { days: length.days } };
      },
    }));
    const found = (await this.#runner.get("standing-proposal", done.id))!;
    const p = found.body as unknown as ProposalBody;
    const grant = await this.#grants.grant(owner, {
      commandId: scopedCommandId(owner.id, `accept-grant-${found.id}-${done.revision}`), grantee: p.requester, action: p.suggestion.action, project: p.suggestion.project, source: "standing",
      basis: `accepted from standing-rule proposal ${found.id}: approved ${p.count} times; ${dayWord(p.suggestion.days)}: ${p.chosenLength?.why ?? "the usual length"}`.slice(0, 500), expiresAt: addDays(p.decidedAt!, p.suggestion.days), terms: { environments: p.suggestion.environments },
    });
    if (p.grantId === undefined) {
      await this.#runner.command("approval.link", { commandId: scopedCommandId(owner.id, `accept-link-${found.id}-${done.revision}`), actor: owner.id }, async () => ({
        payload: { proposalId: found.id, grantId: grant.id },
        build: async () => {
          const now = (await this.#runner.get("standing-proposal", found.id))!;
          const ref: AggregateRef = { kind: "standing-proposal", id: found.id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: now.revision, body: { ...(now.body as unknown as ProposalBody), grantId: grant.id } as unknown as JsonObject }], detail: { grantId: grant.id } };
        },
      }));
    }
    return { grantId: grant.id, days: p.suggestion.days, why: p.chosenLength?.why ?? "the usual length" };
  }

  /**
   * The other way to answer a proposal: instead of the suggested 30-day grant, switch the installation to the derived profile, for good (`permanent`, the default) or for a seven-day trial.
   * Needs a strict installation. The proposal is marked accepted by the profile and no grant is made.
   */
  async acceptBySwitching(owner: Principal, command: NoActor & { proposalId: string; expectedRevision: number; mode?: "permanent" | "trial" }): Promise<{ switched: boolean }> {
    this.#shape(owner, command, ["commandId", "proposalId", "expectedRevision", "mode"]);
    if (this.#profile === undefined) throw new DomainError("unavailable", "switching the profile is not available here");
    if (command.mode !== undefined && command.mode !== "permanent" && command.mode !== "trial") invalid("mode", "must be permanent or trial");
    // The proposal is marked first (judged inside the command, so a repeat is answered from the record); the switch follows and is itself idempotent, so a failure between the two is finished by repeating the call.
    await this.#runner.command("approval.accept-by-profile", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { proposalId: command.proposalId, expectedRevision: command.expectedRevision, mode: command.mode ?? "permanent" },
      build: async () => {
        const current = await this.#runner.existing("standing-proposal", command.proposalId, command.expectedRevision);
        const body = current.body as unknown as ProposalBody;
        if (body.state !== "open") throw new DomainError("invalid_command", `proposal ${current.id} is ${body.state}`, { field: "proposalId" });
        if (!(await this.#profile!.isStrict(owner))) throw new DomainError("invalid_command", "only a strict installation can be switched to the derived profile", { field: "proposalId" });
        const ref: AggregateRef = { kind: "standing-proposal", id: current.id };
        const next: ProposalBody = { ...body, state: "accepted", via: "profile", decidedBy: owner.id, decidedAt: this.#runner.now() };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { via: "profile" } };
      },
    }));
    const { switched } = await this.#profile.switchNow(owner, { commandId: `${command.commandId}.profile`, answer: command.mode === "trial" ? "trial" : "switch" });
    return { switched };
  }

  /** The owner turns a proposal down; the same one is not offered again for a while, and then only after a newer approval. */
  async dismiss(owner: Principal, command: NoActor & { proposalId: string; expectedRevision: number; reason: string }): Promise<void> {
    this.#shape(owner, command, ["commandId", "proposalId", "expectedRevision", "reason"]);
    const reason = text(command.reason, "reason", { min: 1, max: 500 });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key");
    await this.#runner.command("approval.dismiss", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { proposalId: command.proposalId, expectedRevision: command.expectedRevision, reason },
      build: async () => {
        const current = await this.#runner.existing("standing-proposal", command.proposalId, command.expectedRevision);
        const body = current.body as unknown as ProposalBody;
        if (body.state !== "open") throw new DomainError("invalid_command", `proposal ${current.id} is ${body.state}`, { field: "proposalId" });
        const ref: AggregateRef = { kind: "standing-proposal", id: current.id };
        const now = this.#runner.now();
        const next: ProposalBody = { ...body, state: "dismissed", decidedBy: owner.id, decidedAt: now, reason, quietUntil: addDays(now, LOAD_LIMITS.quietDays) };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: {} };
      },
    }));
  }

  /** The approval-load figures for the last `days` days (owner only), and every ask still waiting for the owner with its age. */
  async load(owner: Principal, days = 7): Promise<LoadFigures> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner reads the approval load`);
    if (!Number.isSafeInteger(days) || days < 1 || days > LOAD_LIMITS.window) invalid("days", `must be a whole number from 1 to ${LOAD_LIMITS.window}`);
    const now = this.#runner.now();
    const since = dayOf(addDays(now, -(days - 1)));
    const perDay = new Map<string, { ownerDecisions: number; agentDecisions: number }>();
    for (let i = 0; i < days; i++) perDay.set(dayOf(addDays(now, -i)), { ownerDecisions: 0, agentDecisions: 0 });
    let waits = 0; let waited = 0;
    const pending: LoadFigures["pending"][number][] = [];
    for await (const r of this.#reviews(addDays(now, -LOAD_LIMITS.window))) {
      const b = r.body;
      if (b.state === "owner-decision" || b.state === "pending" || b.state === "needs-context") {
        pending.push({ reviewId: r.id, requester: b.binding.requester, tool: b.operation.name, projectId: b.binding.projectId, waitingOn: b.state === "owner-decision" ? "owner" : "agent-review", waitingMinutes: Math.max(0, Math.round((Date.parse(now) - Date.parse(b.requestedAt)) / 60_000)) });
      }
      if (b.decidedAt === undefined || b.decidedBy === undefined) continue;
      const day = dayOf(b.decidedAt);
      const bucket = perDay.get(day);
      if (bucket === undefined || day < since) continue;
      if (b.decidedBy.startsWith("owner:")) { bucket.ownerDecisions += 1; waits += 1; waited += Math.max(0, Date.parse(b.decidedAt) - Date.parse(b.requestedAt)); } else bucket.agentDecisions += 1;
    }
    const decidedBy = { rule: 0, grant: 0, agentReview: 0, owner: 0, denied: 0 };
    for (const [day] of perDay) {
      for (const [key, n] of Object.entries(await this.#counterOf(day))) {
        const [, mode, via] = key.split("|") as [string, string, string];
        if (mode === "deny") decidedBy.denied += n; else if (mode === "owner") decidedBy.owner += n; else if (mode === "agent-review") decidedBy.agentReview += n; else if (via === "grant") decidedBy.grant += n; else decidedBy.rule += n;
      }
    }
    const rows = [...perDay].map(([day, v]) => ({ day, ...v })).sort((a, b) => (a.day < b.day ? -1 : 1));
    return {
      days, perDay: rows, ownerDecisions: rows.reduce((a, r) => a + r.ownerDecisions, 0), agentDecisions: rows.reduce((a, r) => a + r.agentDecisions, 0),
      averageOwnerWaitMinutes: waits === 0 ? null : Math.round(waited / waits / 60_000), decidedBy, pending: pending.sort((a, b) => b.waitingMinutes - a.waitingMinutes),
    };
  }

  /** How many actions the policy sent where, by cell, for the last `days` days: what each rule asked or let through (owner only). */
  async decisionsByCell(owner: Principal, days = 7): Promise<{ cell: string; mode: string; via: string; count: number }[]> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner`);
    if (!Number.isSafeInteger(days) || days < 1 || days > LOAD_LIMITS.window) invalid("days", `must be a whole number from 1 to ${LOAD_LIMITS.window}`);
    const totals = new Map<string, number>();
    for (let i = 0; i < days; i++) {
      for (const [key, n] of Object.entries(await this.#counterOf(dayOf(addDays(this.#runner.now(), -i))))) totals.set(key, (totals.get(key) ?? 0) + n);
    }
    return [...totals].map(([key, count]) => { const [cell, mode, via] = key.split("|") as [string, string, string]; return { cell, mode, via, count }; }).sort((a, b) => b.count - a.count || (a.cell < b.cell ? -1 : 1));
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  /** The standing grants earlier proposals of this class made that have ended, by how long each was approved for and whether the owner took it back early (card A07d). */
  async #earlierGrants(cls: ActionClass, now: string): Promise<{ days: number; revoked: boolean }[]> {
    const out: { days: number; revoked: boolean }[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("standing-proposal", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const row of page) {
        after = row.id;
        const b = row.body as unknown as ProposalBody;
        if (b.cls !== cls || b.state !== "accepted" || b.via === "profile" || b.grantId === undefined) continue;
        const grant = await this.#grants.getGrant(b.grantId);
        if (grant === undefined) continue;
        if (grant.state === "revoked") out.push({ days: b.suggestion.days, revoked: true });
        else if (grant.expiresAt !== undefined && grant.expiresAt <= now) out.push({ days: b.suggestion.days, revoked: false });
      }
      if (page.length < 200) return out;
    }
  }

  /** A day's counts, the shards added up. */
  async #counterOf(day: string): Promise<Record<string, number>> {
    const total: Record<string, number> = {};
    for (let shard = 0; shard < COUNTER_SHARDS; shard++) {
      const body = (await this.#runner.get("approval-counter", `${day}.${shard}`))?.body as unknown as CounterBody | undefined;
      for (const [key, n] of Object.entries(body?.cells ?? {})) total[key] = (total[key] ?? 0) + n;
    }
    return total;
  }

  #shape(owner: Principal, command: { proposalId: string; expectedRevision: number }, fields: string[]): void {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner decides on proposals`);
    onlyKnown(command, fields);
    if (typeof command.proposalId !== "string" || !PROPOSAL_ID.test(command.proposalId)) invalid("proposalId", "is not a proposal ID");
    checkRevision(command.expectedRevision);
  }

  async #grantLive(grantId: string | undefined, now: string): Promise<boolean> {
    if (grantId === undefined) return false;
    const grant = await this.#grants.getGrant(grantId);
    return grant !== undefined && grant.state === "active" && (grant.expiresAt === undefined || grant.expiresAt > now);
  }

  /** The reviews that matter now: those still waiting, and those settled within the window. Older settled ones are skipped without counting against the limit. */
  async *#reviews(since: string): AsyncGenerator<{ id: string; body: ReviewBody }> {
    let seen = 0;
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("review", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const r of page) {
        after = r.id;
        const body = r.body as unknown as ReviewBody;
        const waiting = body.state === "pending" || body.state === "needs-context" || body.state === "owner-decision";
        if (!waiting && (body.decidedAt ?? body.requestedAt) < since) continue;
        seen += 1;
        if (seen > LOAD_LIMITS.scan) throw new DomainError("unavailable", `there are more than ${LOAD_LIMITS.scan} recent reviews, too many to look through safely`);
        yield { id: r.id, body };
      }
      if (page.length < 500) return;
    }
  }

  async #ownerDecided(since: string): Promise<{ id: string; body: ReviewBody }[]> {
    const out: { id: string; body: ReviewBody }[] = [];
    for await (const r of this.#reviews(since)) if ((r.body.state === "approved" || r.body.state === "used") && (r.body.decidedBy ?? "").startsWith("owner:") && (r.body.decidedAt ?? "") >= since) out.push(r);
    return out.sort((a, b) => ((a.body.decidedAt ?? "") < (b.body.decidedAt ?? "") ? -1 : 1));
  }
}
