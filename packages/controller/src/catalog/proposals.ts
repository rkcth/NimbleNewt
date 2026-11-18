import { createHash } from "node:crypto";
import { parseName } from "@nimblenewt/registry";
import type { DeskService } from "../context/desks.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { checkManifest, chosenVersion, compareVersions, maintainsAnywhere, mayManage, mayReadCatalogEntry, personalNamespace, toolboxName, versionIdOf, type ArtifactKind, type Audience, type CatalogService, type EntryBody, type Manifest, type SourceRef, type VersionBody } from "./catalog.js";
import { noticeChange } from "./notices.js";

/**
 * Improvement and promotion proposals for the shared toolbox (card T08).
 *
 * An agent proposes a change to a shared tool it may read (`improvement`: against an exact shared version, written from its own accepted desk records or taken from its personal copy of the tool), or offers one of its own
 * personal tools to become a shared one (`promotion`). A proposal is a suggestion, not an instruction: it carries text and records, never an action. The maintainers whose `toolbox.manage` covers the tool (and the owner) decide:
 * accept (optionally publishing the new shared version in the same write), request changes, defer or reject, each with the author told in its toolbox inbox. The author may revise, rebase (move the proposal onto the version the
 * tool uses now, refused when both changed the same part) or withdraw it. An accepted proposal authorises nothing beyond the release the decider makes with its own authority: no grant, push, merge or deploy.
 *
 * Who sees a proposal: its author, the owner, and the maintainers who may decide it. To everyone else it does not exist (`not_found`), the same answer as for an ID that was never used.
 */
export type ProposalKind = "improvement" | "promotion";
export type ProposalState = "open" | "changes_requested" | "deferred" | "accepted" | "rejected" | "withdrawn";
export type ProposalDecision = "accept" | "request_changes" | "defer" | "reject" | "reopen";
export const PROPOSAL_STATES: readonly ProposalState[] = ["open", "changes_requested", "deferred", "accepted", "rejected", "withdrawn"];
export const PROPOSAL_DECISIONS: readonly ProposalDecision[] = ["accept", "request_changes", "defer", "reject", "reopen"];
/** States in which a proposal still waits for something (counted against its author's limit). */
const PENDING: readonly ProposalState[] = ["open", "changes_requested", "deferred"];
/** What a default listing shows: proposals that are available to work on. Deferred ones are set aside and are listed only when asked for by state. */
const AVAILABLE: readonly ProposalState[] = ["open", "changes_requested"];
export const PROPOSAL_LIMITS = { rationale: 2000, tests: 2000, reason: 500, pendingPerAuthor: 20, history: 50, page: 100, scan: 5000 } as const;
const PROPOSAL_ID = /^tpp-[a-z2-7]{20}$/;
const VERSION = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const words = (value: unknown, field: string, max: number): string => redactText(text(value, field, { min: 1, max, multiline: true }));
/** The one statement every acceptance carries (card T08, owner rule): a proposal is a suggestion, and accepting it lets nothing else happen. */
export const ACCEPTANCE_LIMIT = "Accepting a proposal authorises nothing beyond the toolbox release named here: no grant, push, merge or deploy.";

export interface ProposedContent { readonly kind: ArtifactKind; readonly manifest: Manifest; readonly instructional: SourceRef; readonly executable?: SourceRef; readonly digest: string }
export interface ProposalEvent { readonly at: string; readonly by: string; readonly event: "submitted" | "revised" | "rebased" | "withdrawn" | ProposalDecision; readonly reason?: string; readonly from?: string; readonly to?: string; readonly released?: string }
export interface ToolboxProposalBody {
  readonly kind: ProposalKind;
  /** The shared tool (`toolbox.<name>`): the one to change, or the name a promotion asks for. */
  readonly target: string;
  readonly author: string;
  /** An improvement: the exact shared version it is against. */
  readonly base?: { readonly version: string; readonly digest: string };
  /** The personal tool the content came from: the author's copy (an improvement) or its own tool (a promotion). */
  readonly from?: { readonly name: string; readonly version: string; readonly digest: string };
  /** The whole content proposed: each part is either the base version's own (unchanged) or one of the author's accepted, shared desk records. */
  readonly proposed: ProposedContent;
  readonly changes: { readonly instructions: boolean; readonly executable: boolean; readonly manifest: boolean };
  /** The access the proposed manifest asks for compared with the base's (asking grants nothing; a run still needs grants). */
  readonly permissionChanges: { readonly added: readonly string[]; readonly removed: readonly string[] };
  readonly rationale: string;
  readonly tests: string;
  /** A promotion: who the author suggests it is for (the decider chooses). */
  readonly audience?: Audience;
  /** The task the author was working on: a decision is also filed there as a notice when the author can be told about that task. */
  readonly taskId?: string;
  readonly state: ProposalState;
  /** 1 at submission, one more per revision. */
  readonly round: number;
  readonly history: readonly ProposalEvent[];
  readonly released?: { readonly version: string; readonly digest: string; readonly versionId: string };
  readonly submittedAt: string;
  readonly updatedAt: string;
}
interface AuthorIndex { readonly author: string; readonly pending: readonly string[] }

export interface ProposalSummary {
  readonly id: string; readonly revision: number; readonly kind: ProposalKind; readonly target: string; readonly author: string; readonly state: ProposalState; readonly round: number;
  readonly base?: { readonly version: string; readonly digest: string }; readonly from?: { readonly name: string; readonly version: string; readonly digest: string };
  readonly changes: ToolboxProposalBody["changes"]; readonly permissionChanges: ToolboxProposalBody["permissionChanges"];
  /** An improvement whose base is no longer the version the tool uses (it needs a rebase before it can be accepted). Absent when the reader may not see the tool now. */
  readonly stale?: boolean; readonly current?: string;
  readonly submittedAt: string; readonly updatedAt: string; readonly released?: NonNullable<ToolboxProposalBody["released"]>;
}

type Notify = (notice: { commandId: string; taskId: string; to: string; purpose: string; text: string }) => Promise<unknown>;

export class ToolboxProposalService {
  readonly #runner: CommandRunner;
  readonly #catalog: CatalogService;
  readonly #desks: DeskService;
  readonly #notify: Notify | undefined;

  private constructor(runner: CommandRunner, catalog: CatalogService, desks: DeskService, notify: Notify | undefined) { this.#runner = runner; this.#catalog = catalog; this.#desks = desks; this.#notify = notify; }

  /** `notify` files a decision as a notice against the task a proposal names (the messaging service's controller notice); without it the toolbox inbox is the only place the author is told. */
  static withEpoch(storage: ControllerStorage, epoch: number, catalog: CatalogService, desks: DeskService, options: RunnerOptions = {}, notify?: Notify): ToolboxProposalService {
    return new ToolboxProposalService(new CommandRunner(storage, epoch, options), catalog, desks, notify);
  }

  // ---- submitting ---------------------------------------------------------------------------------------------------------

  /**
   * An improvement of a shared tool. The patch is the whole new content: `instructionsRecordId` / `executableRecordId` name the author's own accepted, shared desk records and `manifest` a whole manifest; a part left out stays as
   * the base version has it. Or `fromCopy` takes the content from the author's personal copy of the tool (its newest version, or `fromVersion`), and the base is the shared version that copy was made from.
   */
  async propose(by: Principal, command: NoActor & { name: string; baseVersion?: string; fromCopy?: string; fromVersion?: string; instructionsRecordId?: string; executableRecordId?: string; manifest?: unknown; rationale: string; tests: string; taskId?: string }): Promise<{ proposalId: string; state: ProposalState; base: { version: string; digest: string }; changes: ToolboxProposalBody["changes"]; permissionChanges: ToolboxProposalBody["permissionChanges"] }> {
    onlyKnown(command, ["commandId", "name", "baseVersion", "fromCopy", "fromVersion", "instructionsRecordId", "executableRecordId", "manifest", "rationale", "tests", "taskId"]);
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} does not propose toolbox changes; agents do (the owner publishes directly)`);
    const target = toolboxName(command.name);
    const rationale = words(command.rationale, "rationale", PROPOSAL_LIMITS.rationale);
    const tests = words(command.tests, "tests", PROPOSAL_LIMITS.tests);
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    const entry = await this.#readableEntry(by, target);
    let content: { base: VersionBody & { id: string }; proposed: Omit<ProposedContent, "digest">; from?: { name: string; version: string; digest: string } };
    if (command.fromCopy !== undefined) {
      for (const f of ["baseVersion", "instructionsRecordId", "executableRecordId", "manifest"] as const) if (command[f] !== undefined) invalid(f, "fromCopy takes the whole patch from your copy; leave it out");
      content = await this.#fromCopy(by, target, entry, command.fromCopy, command.fromVersion);
    } else {
      if (command.fromVersion !== undefined) invalid("fromVersion", "is given only with fromCopy");
      const baseVersion = command.baseVersion ?? chosenVersion(entry) ?? invalid("name", `${target} has no version in use to improve`);
      const base = await this.#baseVersion(entry, baseVersion);
      content = { base, proposed: await this.#patch(by, base, command) };
    }
    const shaped = this.#shape(content.base, content.proposed);
    const id = derivedId("tpp", scopedCommandId(by.id, command.commandId));
    const now = this.#runner.now();
    const body: ToolboxProposalBody = {
      kind: "improvement", target, author: by.id, base: { version: content.base.version, digest: content.base.digest }, ...(content.from === undefined ? {} : { from: content.from }), ...shaped,
      rationale, tests, ...(taskId === undefined ? {} : { taskId }), state: "open", round: 1, history: [{ at: now, by: by.id, event: "submitted" }], submittedAt: now, updatedAt: now,
    };
    await this.#create(by, "toolbox.propose", command.commandId, id, body);
    return { proposalId: id, state: "open", base: body.base!, changes: body.changes, permissionChanges: body.permissionChanges };
  }

  /**
   * A promotion: the author offers one of its own personal tools (not a copy of a shared one) to become the shared tool `name`. Its sources must be the author's own accepted, shared desk records. `audience` is who the author
   * suggests it is for; the decider chooses. The shared name must be free.
   */
  async promote(by: Principal, command: NoActor & { name: string; from: string; fromVersion?: string; audience?: unknown; rationale: string; tests: string; taskId?: string }): Promise<{ proposalId: string; state: ProposalState; from: { name: string; version: string; digest: string } }> {
    onlyKnown(command, ["commandId", "name", "from", "fromVersion", "audience", "rationale", "tests", "taskId"]);
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} does not propose toolbox changes; agents do (the owner publishes directly)`);
    const target = toolboxName(command.name);
    const rationale = words(command.rationale, "rationale", PROPOSAL_LIMITS.rationale);
    const tests = words(command.tests, "tests", PROPOSAL_LIMITS.tests);
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    const audience = command.audience === undefined ? undefined : await this.#suggestedAudience(by, command.audience);
    const { version: v, name, entry: own } = await this.#ownTool(by, command.from, command.fromVersion, "from");
    // A personal tool that began as a copy of a shared one (any of its versions) is offered back as an improvement of that tool, never as a new shared tool.
    for (const x of own.versions) {
      const copied = (await this.#version(name, x))?.copiedFrom;
      if (copied !== undefined) invalid("from", `that tool is a copy of ${copied.name}; propose an improvement of ${copied.name} instead`);
    }
    for (const part of ["instructional", "executable"] as const) { const ref = v[part]; if (ref !== undefined) await this.#stillShared(ref, part === "instructional" ? "instructions" : "executable"); }
    // A name collision is answered whatever the caller may read: some answer is unavoidable when two tools want one name.
    if ((await this.#entry(target)) !== undefined) throw new DomainError("command_conflict", `the shared name ${target} is taken; choose another`);
    const proposed: Omit<ProposedContent, "digest"> = { kind: v.kind, manifest: v.manifest, instructional: v.instructional, ...(v.executable === undefined ? {} : { executable: v.executable }) };
    const id = derivedId("tpp", scopedCommandId(by.id, command.commandId));
    const now = this.#runner.now();
    const body: ToolboxProposalBody = {
      kind: "promotion", target, author: by.id, from: { name, version: v.version, digest: v.digest }, proposed: { ...proposed, digest: digestOf(target, proposed) }, changes: { instructions: true, executable: v.executable !== undefined, manifest: true },
      permissionChanges: { added: [...v.manifest.requestedAccess], removed: [] }, rationale, tests, ...(audience === undefined ? {} : { audience }), ...(taskId === undefined ? {} : { taskId }),
      state: "open", round: 1, history: [{ at: now, by: by.id, event: "submitted" }], submittedAt: now, updatedAt: now,
    };
    await this.#create(by, "toolbox.promote", command.commandId, id, body);
    return { proposalId: id, state: "open", from: body.from! };
  }

  // ---- the author's changes -----------------------------------------------------------------------------------------------

  /**
   * The author replaces its proposal's content (open, or after changes were requested; a deferred proposal waits for its decider). For an improvement the new patch is whole, as in `propose`, against the same base, or against the
   * version the tool uses now with `onLatest` (the author re-did the work on it). For a promotion, `fromVersion` names the version of its personal tool to offer now. The proposal is open again.
   */
  async revise(by: Principal, command: NoActor & { proposalId: string; expectedRevision?: number; instructionsRecordId?: string; executableRecordId?: string; manifest?: unknown; fromVersion?: string; onLatest?: boolean; rationale?: string; tests?: string }): Promise<{ proposalId: string; state: ProposalState; round: number }> {
    onlyKnown(command, ["commandId", "proposalId", "expectedRevision", "instructionsRecordId", "executableRecordId", "manifest", "fromVersion", "onLatest", "rationale", "tests"]);
    const found = await this.#visible(by, command.proposalId);
    const p = found.body;
    if (p.author !== by.id) throw new DomainError("forbidden", "only the author revises a proposal; a maintainer requests changes");
    if (command.onLatest !== undefined && typeof command.onLatest !== "boolean") invalid("onLatest", "must be true or false");
    const rationale = command.rationale === undefined ? p.rationale : words(command.rationale, "rationale", PROPOSAL_LIMITS.rationale);
    const tests = command.tests === undefined ? p.tests : words(command.tests, "tests", PROPOSAL_LIMITS.tests);
    let next: Pick<ToolboxProposalBody, "proposed" | "changes" | "permissionChanges"> & { base?: NonNullable<ToolboxProposalBody["base"]>; from?: NonNullable<ToolboxProposalBody["from"]> };
    if (p.kind === "promotion") {
      for (const f of ["instructionsRecordId", "executableRecordId", "manifest", "onLatest"] as const) if (command[f] !== undefined) invalid(f, "a promotion is revised by naming another version of your tool (fromVersion)");
      const { version: v, name } = await this.#ownTool(by, p.from!.name, command.fromVersion, "fromVersion");
      for (const part of ["instructional", "executable"] as const) { const ref = v[part]; if (ref !== undefined) await this.#stillShared(ref, part === "instructional" ? "instructions" : "executable"); }
      const proposed: Omit<ProposedContent, "digest"> = { kind: v.kind, manifest: v.manifest, instructional: v.instructional, ...(v.executable === undefined ? {} : { executable: v.executable }) };
      next = { from: { name, version: v.version, digest: v.digest }, proposed: { ...proposed, digest: digestOf(p.target, proposed) }, changes: { instructions: true, executable: v.executable !== undefined, manifest: true }, permissionChanges: { added: [...v.manifest.requestedAccess], removed: [] } };
    } else {
      if (command.fromVersion !== undefined) invalid("fromVersion", "is for promotions; an improvement is revised with a new patch");
      const entry = await this.#readableEntry(by, p.target);
      const baseVersion = command.onLatest === true ? chosenVersion(entry) ?? invalid("onLatest", `${p.target} has no version in use`) : p.base!.version;
      const base = await this.#baseVersion(entry, baseVersion);
      next = { base: { version: base.version, digest: base.digest }, ...this.#shape(base, await this.#patch(by, base, command)) };
    }
    const asked = { instructionsRecordId: command.instructionsRecordId ?? null, executableRecordId: command.executableRecordId ?? null, manifest: (command.manifest ?? null) as JsonObject | null, fromVersion: command.fromVersion ?? null, onLatest: command.onLatest ?? null, rationale: command.rationale ?? null, tests: command.tests ?? null } as unknown as JsonObject;
    const done = await this.#update(by, "toolbox.proposal.revise", command.commandId, found.id, command.expectedRevision, { kind: "revise", asked }, async (cur) => {
      if (cur.state !== "open" && cur.state !== "changes_requested") throw new DomainError("invalid_command", `the proposal is ${cur.state}; only an open proposal, or one with changes requested, is revised`, { field: "proposalId" });
      // A rebase in between moved the base without a new round: the patch was computed against the base as read, so it is refused rather than moving the proposal back.
      if (cur.round !== p.round || cur.base?.version !== p.base?.version) throw new DomainError("stale_revision", "the proposal changed at the same moment; read it again");
      const body: ToolboxProposalBody = { ...cur, ...next, rationale, tests, state: "open", round: cur.round + 1, history: event(cur, { at: this.#runner.now(), by: by.id, event: "revised" }), updatedAt: this.#runner.now() };
      return { body, changes: [] };
    });
    return { proposalId: found.id, state: "open", round: done.round };
  }

  /**
   * Moves an improvement onto the version the shared tool uses now and checks it again (card T08: a patch against an older base is rebased and rechecked). A part the proposal does not change follows the new base; a part it changes
   * stays the author's, which is refused when the new base changed that part too (the author revises the patch against it: `revise` with `onLatest`). The author's records are read back and must still be exactly as proposed.
   * The author or a maintainer who may decide it rebases; the author is told when a maintainer did.
   */
  async rebase(by: Principal, command: NoActor & { proposalId: string; expectedRevision?: number }): Promise<{ proposalId: string; from: string; to: string; permissionChanges: ToolboxProposalBody["permissionChanges"] }> {
    onlyKnown(command, ["commandId", "proposalId", "expectedRevision"]);
    const found = await this.#visible(by, command.proposalId);
    const p = found.body;
    if (p.kind !== "improvement") throw new DomainError("invalid_command", "a promotion has no base to move; the name is checked again when it is decided", { field: "proposalId" });
    if (p.author !== by.id && !(await this.#mayDecide(by, p))) throw new DomainError("forbidden", `${by.id} may not rebase that proposal`);
    const entry = p.author === by.id ? await this.#readableEntry(by, p.target) : await this.#entry(p.target) ?? (() => { throw new DomainError("not_found", `${p.target} is no longer a shared tool`); })();
    const latest = chosenVersion(entry) ?? (() => { throw new DomainError("invalid_command", `${p.target} has no version in use to rebase onto`, { field: "proposalId" }); })();
    if (latest === p.base!.version || !PENDING.includes(p.state)) {
      // Refused inside the write, so a repeat of a rebase that was carried out is answered from its record.
      await this.#update(by, "toolbox.proposal.rebase", command.commandId, found.id, command.expectedRevision, { kind: "rebase" }, async (cur) => {
        if (!PENDING.includes(cur.state)) throw new DomainError("invalid_command", `the proposal is ${cur.state}; only one still waiting is rebased`, { field: "proposalId" });
        throw new DomainError("invalid_command", `the proposal is already against ${latest}, the version in use`, { field: "proposalId" });
      });
      const last = [...p.history].reverse().find((e) => e.event === "rebased");
      return { proposalId: found.id, from: last?.from ?? latest, to: latest, permissionChanges: p.permissionChanges };
    }
    const old = await this.#version(p.target, p.base!.version);
    const now = await this.#baseVersion(entry, latest);
    const conflicts: string[] = [];
    if (p.changes.instructions && (old === undefined || old.instructional.digest !== now.instructional.digest)) conflicts.push("instructions");
    if (p.changes.executable && (old === undefined || old.executable?.digest !== now.executable?.digest)) conflicts.push("executable");
    if (p.changes.manifest && (old === undefined || canonicalJson(old.manifest as unknown as JsonObject) !== canonicalJson(now.manifest as unknown as JsonObject))) conflicts.push("manifest");
    if (conflicts.length > 0) throw new DomainError("command_conflict", `${p.target} ${latest} also changed the ${conflicts.join(" and ")} that the proposal changes; the author revises the patch against ${latest} (toolbox.proposal.revise with onLatest)`);
    // Rechecked: the author's own parts must still be exactly as proposed and still shared; the manifest is checked again against the rules in force.
    for (const part of ["instructional", "executable"] as const) { const ref = p.proposed[part]; const changed = part === "instructional" ? p.changes.instructions : p.changes.executable; if (ref !== undefined && changed) await this.#stillShared(ref, part === "instructional" ? "instructions" : "executable"); }
    const manifest = p.changes.manifest ? checkManifest(p.proposed.manifest, p.proposed.kind) : now.manifest;
    const proposed: Omit<ProposedContent, "digest"> = {
      kind: now.kind, manifest, instructional: p.changes.instructions ? p.proposed.instructional : now.instructional,
      ...((p.changes.executable ? p.proposed.executable : now.executable) === undefined ? {} : { executable: (p.changes.executable ? p.proposed.executable : now.executable)! }),
    };
    const shaped = this.#shape(now, proposed);
    await this.#update(by, "toolbox.proposal.rebase", command.commandId, found.id, command.expectedRevision, { kind: "rebase" }, async (cur) => {
      // The rebased content was computed from the proposal as read: a revision in between (same base, new content) must not be overwritten with the old content.
      if (cur.base?.version !== p.base!.version || !PENDING.includes(cur.state) || cur.round !== p.round || cur.proposed.digest !== p.proposed.digest) throw new DomainError("stale_revision", "the proposal changed at the same moment; read it again");
      const at = this.#runner.now();
      const body: ToolboxProposalBody = { ...cur, base: { version: now.version, digest: now.digest }, ...shaped, history: event(cur, { at, by: by.id, event: "rebased", from: p.base!.version, to: latest }), updatedAt: at };
      const told = by.id === cur.author ? undefined : await noticeChange(this.#runner, cur.author, { key: `proposal|${found.id}|rebased|${latest}`, kind: "proposal", name: cur.target, version: latest, proposalId: found.id, text: `${by.id} moved your proposal ${found.id} for ${cur.target} from ${p.base!.version} onto ${latest}, the version in use; your changes are unchanged and were checked again.` });
      return { body, changes: told === undefined ? [] : [told] };
    });
    return { proposalId: found.id, from: p.base!.version, to: latest, permissionChanges: shaped.permissionChanges };
  }

  /** The author takes its proposal back (any state that still waits). Final. */
  async withdraw(by: Principal, command: NoActor & { proposalId: string; reason?: string; expectedRevision?: number }): Promise<{ proposalId: string; state: ProposalState }> {
    onlyKnown(command, ["commandId", "proposalId", "reason", "expectedRevision"]);
    const found = await this.#visible(by, command.proposalId);
    if (found.body.author !== by.id) throw new DomainError("forbidden", "only the author withdraws a proposal; a maintainer rejects it");
    const reason = command.reason === undefined ? undefined : words(command.reason, "reason", PROPOSAL_LIMITS.reason);
    await this.#update(by, "toolbox.proposal.withdraw", command.commandId, found.id, command.expectedRevision, { kind: "withdraw" }, async (cur) => {
      if (!PENDING.includes(cur.state)) throw new DomainError("invalid_command", `the proposal is ${cur.state} already`, { field: "proposalId" });
      const at = this.#runner.now();
      return { body: { ...cur, state: "withdrawn", history: event(cur, { at, by: by.id, event: "withdrawn", ...(reason === undefined ? {} : { reason }) }), updatedAt: at }, changes: [], final: true };
    });
    return { proposalId: found.id, state: "withdrawn" };
  }

  // ---- decisions ----------------------------------------------------------------------------------------------------------

  /**
   * A maintainer's decision (the owner, or an agent whose `toolbox.manage` covers the tool; never the author). `accept` with `version` publishes the proposed content as that new shared version in the same write as the decision
   * (an improvement only while its base is still the version in use; a promotion only while the name is free; `audience` is the promotion's, defaulting to the author's suggestion). `accept` without `version` records the decision
   * and publishes nothing; a later `accept` with `version` releases it. `request_changes`, `defer` and `reject` need a reason; `reopen` brings a deferred proposal back. The author is told in its toolbox inbox (and on the task the
   * proposal names, when it can be told there). An acceptance authorises nothing else.
   */
  async decide(by: Principal, command: NoActor & { proposalId: string; decision: ProposalDecision; reason?: string; version?: string; audience?: unknown; expectedRevision?: number }): Promise<{ proposalId: string; state: ProposalState; released?: { name: string; version: string; digest: string; versionId: string }; authorizes: string }> {
    onlyKnown(command, ["commandId", "proposalId", "decision", "reason", "version", "audience", "expectedRevision"]);
    if (!PROPOSAL_DECISIONS.includes(command.decision)) invalid("decision", `must be one of ${PROPOSAL_DECISIONS.join(", ")}`);
    const found = await this.#visible(by, command.proposalId);
    const p = found.body;
    if (by.id === p.author) throw new DomainError("forbidden", "an author does not decide its own proposal");
    if (!(await this.#mayDecide(by, p))) throw new DomainError("not_found", "no such proposal");
    const decision = command.decision;
    const reason = command.reason === undefined ? undefined : words(command.reason, "reason", PROPOSAL_LIMITS.reason);
    if (reason === undefined && (decision === "request_changes" || decision === "defer" || decision === "reject")) invalid("reason", `a ${decision.replace("_", " ")} decision says why`);
    if (command.version !== undefined && decision !== "accept") invalid("version", "only an acceptance releases a version");
    if (command.audience !== undefined && !(decision === "accept" && p.kind === "promotion" && command.version !== undefined)) invalid("audience", "is given only when accepting a promotion with a release");
    if (command.version !== undefined && (typeof command.version !== "string" || !VERSION.test(command.version))) invalid("version", "must be major.minor.patch");
    const allowed: Record<ProposalDecision, readonly ProposalState[]> = { accept: ["open", "changes_requested", "deferred", "accepted"], request_changes: ["open", "deferred"], defer: ["open", "changes_requested"], reject: ["open", "changes_requested", "deferred"], reopen: ["deferred"] };
    const check = (cur: ToolboxProposalBody): void => {
      if (!allowed[decision].includes(cur.state)) throw new DomainError("invalid_command", `the proposal is ${cur.state}; it cannot be given ${decision.replace("_", " ")}`, { field: "decision" });
      if (decision === "accept" && cur.state === "accepted" && (command.version === undefined || cur.released !== undefined)) throw new DomainError("invalid_command", cur.released !== undefined ? `the proposal was accepted and released as ${cur.released.version}` : "the proposal is accepted already; give a version to release it", { field: "decision" });
    };
    // The state is judged inside the write (so a repeat of a decision that was carried out is answered from its record).
    const to: ProposalState = decision === "accept" ? "accepted" : decision === "request_changes" ? "changes_requested" : decision === "defer" ? "deferred" : decision === "reject" ? "rejected" : "open";
    const noticeText = (released?: string): string => `${by.kind === "owner" ? "The owner" : by.id} ${decision === "accept" ? `accepted your proposal ${found.id} for ${p.target}${released === undefined ? " (not released yet)" : ` and released it as ${released}`}. ${ACCEPTANCE_LIMIT}` : decision === "request_changes" ? `asked for changes to your proposal ${found.id} for ${p.target}: ${reason}. Revise it with toolbox.proposal.revise.` : decision === "defer" ? `deferred your proposal ${found.id} for ${p.target}: ${reason}. It is set aside and not listed as available until it is reopened.` : decision === "reject" ? `rejected your proposal ${found.id} for ${p.target}: ${reason}.` : `reopened your proposal ${found.id} for ${p.target}.`}`;
    // `revision` is the proposal record's revision this decision writes over: unique per write, so it keys the author's notice.
    const apply = async (cur: ToolboxProposalBody, revision: number, released?: { version: string; digest: string; versionId: string }): Promise<{ body: ToolboxProposalBody; changes: Change[] }> => {
      check(cur);
      const at = this.#runner.now();
      const body: ToolboxProposalBody = { ...cur, state: to, history: event(cur, { at, by: by.id, event: decision, ...(reason === undefined ? {} : { reason }), ...(released === undefined ? {} : { released: released.version }) }), ...(released === undefined ? {} : { released }), updatedAt: at };
      const told = await noticeChange(this.#runner, cur.author, { key: `proposal|${found.id}|r${revision}|${decision}`, kind: "proposal", name: cur.target, ...(released === undefined ? {} : { version: released.version }), proposalId: found.id, text: noticeText(released?.version) });
      return { body, changes: told === undefined ? [] : [told] };
    };
    let released: { name: string; version: string; digest: string; versionId: string } | undefined;
    if (decision === "accept" && command.version !== undefined) {
      const audience = p.kind === "promotion" ? (command.audience !== undefined ? await this.#catalog.audienceOf(command.audience) : p.audience) : undefined;
      const parts = {
        instructions: { ref: p.proposed.instructional, ...(p.changes.instructions || p.kind === "promotion" ? {} : { base: versionIdOf(p.target, p.base!.version) }) },
        ...(p.proposed.executable === undefined ? {} : { executable: { ref: p.proposed.executable, ...(p.changes.executable || p.kind === "promotion" ? {} : { base: versionIdOf(p.target, p.base!.version) }) } }),
      };
      const version = command.version;
      const made = await this.#catalog.releaseProposal(by, {
        commandId: command.commandId, name: p.target, kind: p.proposed.kind, version, manifest: p.proposed.manifest, parts, ...(audience === undefined ? {} : { audience }),
        expect: p.kind === "promotion" ? "absent" : { chosen: p.base!.version }, payload: { proposalId: found.id, decision, ...(reason === undefined ? {} : { reason }), expectedRevision: command.expectedRevision ?? null },
      }, async (_prior, made) => {
        const fresh = await this.#runner.get(PROPOSAL_KIND, found.id);
        if (fresh === undefined) throw new DomainError("not_found", "no such proposal");
        if (command.expectedRevision !== undefined && fresh.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the proposal is at revision ${fresh.revision}, not ${command.expectedRevision}`, { currentRevision: fresh.revision });
        const cur = fresh.body as unknown as ToolboxProposalBody;
        // The content released is the content that was read: a revision in between makes the decider look again.
        if (cur.proposed.digest !== p.proposed.digest || cur.round !== p.round) throw new DomainError("stale_revision", "the proposal was revised meanwhile; read it again before deciding");
        const out = await apply(cur, fresh.revision, { version, digest: made.digest, versionId: made.versionId });
        return [{ type: "update", ref: { kind: PROPOSAL_KIND, id: found.id }, expectedRevision: fresh.revision, body: out.body as unknown as JsonObject }, ...out.changes, ...(await this.#unindex(cur.author, found.id))];
      });
      released = { name: made.name, version, digest: made.digest, versionId: made.versionId };
      await this.#tellOnTask(p, found.id, decision, noticeText(version));
      return { proposalId: found.id, state: "accepted", released, authorizes: ACCEPTANCE_LIMIT };
    }
    await this.#update(by, "toolbox.proposal.decide", command.commandId, found.id, command.expectedRevision, { kind: "decide", decision, reason: reason ?? null }, async (cur, revision) => {
      if (decision === "accept" && (cur.proposed.digest !== p.proposed.digest || cur.round !== p.round)) throw new DomainError("stale_revision", "the proposal was revised meanwhile; read it again before deciding");
      // An improvement is accepted against the version in use: a stale one is rebased first (and so checked again).
      if (decision === "accept" && cur.kind === "improvement") {
        const entry = await this.#entry(cur.target);
        const chosen = entry === undefined ? undefined : chosenVersion(entry);
        if (chosen !== cur.base!.version) throw new DomainError("stale_revision", `${cur.target} is at ${chosen ?? "no version in use"}, not ${cur.base!.version}, which the proposal is against; rebase it first (toolbox.proposal.rebase)`);
      }
      const out = await apply(cur, revision);
      return { ...out, final: to === "rejected" || to === "accepted" };
    });
    await this.#tellOnTask(p, found.id, decision, noticeText());
    return { proposalId: found.id, state: to, authorizes: ACCEPTANCE_LIMIT };
  }

  /** Files a decision as a notice on the task the proposal names, when the author can be told about it there (best effort: the toolbox inbox already holds the notice). Keyed by the proposal and decision, so a repeat files it once. */
  async #tellOnTask(p: ToolboxProposalBody, id: string, decision: ProposalDecision, text: string): Promise<void> {
    if (p.taskId === undefined || this.#notify === undefined) return;
    // Keyed by the proposal record's revision after the decision (a repeat of the decision finds the same one, unless something has changed it since; then the notice may be filed twice, which tells nothing wrong).
    const n = (await this.#runner.get(PROPOSAL_KIND, id))?.revision ?? 0;
    try { await this.#notify({ commandId: `tpn-${sha(`${id}|${n}|${decision}`).slice(0, 40)}`, taskId: p.taskId, to: p.author, purpose: "A decision on your toolbox proposal", text: text.slice(0, 1000) }); } catch { /* the inbox holds it */ }
  }

  // ---- reading ------------------------------------------------------------------------------------------------------------

  /**
   * The proposals the reader may see: its own, and (the owner, or a maintainer) those it may decide. By default only those available to work on (open, or with changes requested): a deferred proposal is set aside and listed only
   * when `state` asks for it (`deferred`, another state, or `all`). `mine` lists only the reader's own. Newest record IDs are not implied: the order is by record ID; pass `next` back as `after`.
   */
  async list(by: Principal, query: { state?: string; name?: string; mine?: boolean; limit?: number; after?: string } = {}): Promise<{ items: ProposalSummary[]; next?: string; partial?: true }> {
    onlyKnown(query, ["state", "name", "mine", "limit", "after"]);
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PROPOSAL_LIMITS.page) invalid("limit", `must be 1 to ${PROPOSAL_LIMITS.page}`);
    const states: readonly ProposalState[] = query.state === undefined ? AVAILABLE : query.state === "all" ? PROPOSAL_STATES : PROPOSAL_STATES.includes(query.state as ProposalState) ? [query.state as ProposalState] : invalid("state", `must be one of ${PROPOSAL_STATES.join(", ")} or all`);
    const name = query.name === undefined ? undefined : toolboxName(query.name);
    if (query.mine !== undefined && typeof query.mine !== "boolean") invalid("mine", "must be true or false");
    if (query.after !== undefined && (typeof query.after !== "string" || !PROPOSAL_ID.test(query.after))) invalid("after", "must be the next of a previous answer");
    const entries = new Map<string, EntryBody | undefined>();
    const items: ProposalSummary[] = [];
    let scanned = 0;
    for (let after = query.after; ;) {
      const page = await this.#runner.list(PROPOSAL_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id; scanned += 1;
        const p = a.body as unknown as ToolboxProposalBody;
        if (!states.includes(p.state) || (name !== undefined && p.target !== name) || (query.mine === true && p.author !== by.id)) continue;
        if (!(await this.#canSee(by, p))) continue;
        if (!entries.has(p.target)) entries.set(p.target, await this.#entry(p.target));
        items.push(await this.#summary(by, a.id, a.revision, p, entries.get(p.target)));
        if (items.length >= limit) return { items, next: a.id };
      }
      if (page.length < 200) return { items };
      if (scanned >= PROPOSAL_LIMITS.scan) return { items, next: after!, partial: true };
    }
  }

  /** One proposal with its history and the text of each part it changes (read back from the author's records by digest; a part whose record is gone or changed is listed under `unavailable`). */
  async get(by: Principal, proposalId: string): Promise<ProposalSummary & { rationale: string; tests: string; audience?: Audience; taskId?: string; history: readonly ProposalEvent[]; manifest: Manifest; instructions?: string; executable?: string; unavailable?: string[] }> {
    const found = await this.#visible(by, proposalId);
    const p = found.body;
    const texts: { instructions?: string; executable?: string } = {};
    const unavailable: string[] = [];
    for (const [part, ref, changed] of [["instructions", p.proposed.instructional, p.changes.instructions], ["executable", p.proposed.executable, p.changes.executable]] as const) {
      if (ref === undefined || !changed) continue;
      const rec = (await this.#runner.get("desk-record", ref.recordId))?.body as unknown as { body?: unknown; deleted?: unknown } | undefined;
      if (rec === undefined || rec.deleted !== undefined || typeof rec.body !== "string" || sha(rec.body) !== ref.digest) unavailable.push(part);
      else texts[part] = rec.body;
    }
    return {
      ...(await this.#summary(by, found.id, found.revision, p, await this.#entry(p.target))), rationale: p.rationale, tests: p.tests, ...(p.audience === undefined ? {} : { audience: p.audience }), ...(p.taskId === undefined ? {} : { taskId: p.taskId }),
      history: p.history, manifest: p.proposed.manifest, ...texts, ...(unavailable.length === 0 ? {} : { unavailable }),
    };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------

  async #summary(by: Principal, id: string, revision: number, p: ToolboxProposalBody, entry: EntryBody | undefined): Promise<ProposalSummary> {
    // Whether the base is still the version in use is said only to a reader who may see the tool now (the author may since have left its audience).
    const sees = entry !== undefined && entry.layer === "toolbox" && (await mayReadCatalogEntry((kind, rid) => this.#runner.get(kind, rid), by, entry));
    const current = sees ? chosenVersion(entry!) : undefined;
    return {
      id, revision, kind: p.kind, target: p.target, author: p.author, state: p.state, round: p.round, ...(p.base === undefined ? {} : { base: p.base }), ...(p.from === undefined ? {} : { from: p.from }),
      changes: p.changes, permissionChanges: p.permissionChanges, ...(p.kind === "improvement" && sees ? { stale: current !== p.base!.version, ...(current === undefined ? {} : { current }) } : {}),
      submittedAt: p.submittedAt, updatedAt: p.updatedAt, ...(p.released === undefined ? {} : { released: p.released }),
    };
  }

  /** The proposal if `by` may see it; `not_found` otherwise (the same answer as for an ID never used). */
  async #visible(by: Principal, proposalId: string): Promise<{ id: string; revision: number; body: ToolboxProposalBody }> {
    if (typeof proposalId !== "string" || !PROPOSAL_ID.test(proposalId)) return invalid("proposalId", "is not a proposal ID");
    const found = await this.#runner.get(PROPOSAL_KIND, proposalId);
    const body = found?.body as unknown as ToolboxProposalBody | undefined;
    if (found === undefined || body === undefined || !(await this.#canSee(by, body))) throw new DomainError("not_found", "no such proposal");
    return { id: found.id, revision: found.revision, body };
  }

  async #canSee(by: Principal, p: ToolboxProposalBody): Promise<boolean> {
    return by.kind === "owner" || p.author === by.id || (await this.#mayDecide(by, p));
  }

  /** The owner; or an agent (never the author) whose `toolbox.manage` covers the tool's audience now (a promotion: the audience the author suggested; none suggested means all agents). */
  async #mayDecide(by: Principal, p: ToolboxProposalBody): Promise<boolean> {
    if (by.kind === "owner") return true;
    if (by.kind !== "agent" || by.id === p.author || !maintainsAnywhere(by)) return false;
    if (p.kind === "promotion") return mayManage(by, p.audience);
    const entry = await this.#entry(p.target);
    return entry !== undefined && entry.layer === "toolbox" && mayManage(by, entry.audience);
  }

  async #entry(name: string): Promise<EntryBody | undefined> {
    return (await this.#runner.get("catalog-entry", derivedId("cat", name)))?.body as unknown as EntryBody | undefined;
  }

  async #version(name: string, version: string): Promise<(VersionBody & { id: string }) | undefined> {
    const id = versionIdOf(name, version);
    const body = (await this.#runner.get("catalog-version", id))?.body as unknown as VersionBody | undefined;
    return body === undefined ? undefined : { ...body, id };
  }

  /** The shared entry, when `by` may read it (its audience, or a covering grant); `not_found` for one it may not, the same answer as for none. */
  async #readableEntry(by: Principal, target: string): Promise<EntryBody> {
    const entry = await this.#entry(target);
    if (entry === undefined || entry.layer !== "toolbox" || !(await mayReadCatalogEntry((kind, id) => this.#runner.get(kind, id), by, entry))) throw new DomainError("not_found", `no shared tool ${target} you may read`);
    return entry;
  }

  async #baseVersion(entry: EntryBody, version: string): Promise<VersionBody & { id: string }> {
    if (typeof version !== "string" || !VERSION.test(version)) invalid("baseVersion", "must be major.minor.patch");
    if (!entry.versions.includes(version)) throw new DomainError("not_found", `${entry.name} has no version ${version}`);
    if (entry.revoked.includes(version)) throw new DomainError("invalid_command", `${entry.name} ${version} was revoked; propose against a version that is not`, { field: "baseVersion" });
    return (await this.#version(entry.name, version)) ?? (() => { throw new DomainError("not_found", `${entry.name} has no version ${version}`); })();
  }

  /** The proposed content of an explicit patch: each given record is the author's own accepted, shared, original desk record; the rest is the base's. */
  async #patch(by: Principal, base: VersionBody, command: { instructionsRecordId?: string; executableRecordId?: string; manifest?: unknown }): Promise<Omit<ProposedContent, "digest">> {
    if (base.kind === "skill" && command.executableRecordId !== undefined) invalid("executableRecordId", "a skill has no executable");
    const instructional = command.instructionsRecordId === undefined ? base.instructional : await this.#authorPart(by, command.instructionsRecordId, "instructionsRecordId");
    const executable = command.executableRecordId === undefined ? base.executable : await this.#authorPart(by, command.executableRecordId, "executableRecordId");
    const manifest = command.manifest === undefined ? base.manifest : checkManifest(command.manifest, base.kind);
    return { kind: base.kind, manifest, instructional, ...(executable === undefined ? {} : { executable }) };
  }

  /** The content of the author's personal copy of `target` (its newest version, or `fromVersion`), and the shared version that copy was made from. */
  async #fromCopy(by: Principal, target: string, entry: EntryBody, fromCopy: string, fromVersion: string | undefined): Promise<{ base: VersionBody & { id: string }; proposed: Omit<ProposedContent, "digest">; from: { name: string; version: string; digest: string } }> {
    const { version: v, name, entry: copyEntry } = await this.#ownTool(by, fromCopy, fromVersion, "fromCopy");
    // The base is the shared version the newest copy at or below this version was made from.
    let baseVersion: string | undefined;
    for (const x of [...copyEntry.versions].filter((x) => compareVersions(x, v.version) <= 0).sort(compareVersions).reverse()) {
      const cv = await this.#version(name, x);
      if (cv?.copiedFrom !== undefined) { if (cv.copiedFrom.name === target) baseVersion = cv.copiedFrom.version; break; }
    }
    if (baseVersion === undefined) invalid("fromCopy", `that personal tool was not copied from ${target}`);
    const base = await this.#baseVersion(entry, baseVersion!);
    // A part equal to the base's is the base's own; a changed part must be the author's own accepted, shared, original record.
    const part = async (ref: SourceRef | undefined, baseRef: SourceRef | undefined, field: "instructions" | "executable"): Promise<SourceRef | undefined> => {
      if (ref === undefined) return undefined;
      if (baseRef !== undefined && ref.digest === baseRef.digest) return baseRef;
      if (ref.author !== by.id) invalid("fromCopy", `the ${field} of that copy is not your own desk record`);
      await this.#stillShared(ref, field);
      return ref;
    };
    const instructional = (await part(v.instructional, base.instructional, "instructions"))!;
    const executable = await part(v.executable, base.executable, "executable");
    return { base, proposed: { kind: v.kind, manifest: v.manifest, instructional, ...(executable === undefined ? {} : { executable }) }, from: { name, version: v.version, digest: v.digest } };
  }

  /** One of the caller's own personal tools (`a_<id>.<name>` or the short name), at `version` or its newest unrevoked one. Another agent's tool, or none, is `not_found`. */
  async #ownTool(by: Principal, name: unknown, version: string | undefined, field: string): Promise<{ version: VersionBody & { id: string }; name: string; entry: EntryBody }> {
    if (typeof name !== "string") return invalid(field, "must name one of your personal tools");
    const ns = personalNamespace(by.id);
    const full = name.startsWith("a_") ? name : `${ns}.${name}`;
    const parsed = parseName(full);
    if (parsed === null || parsed.layer !== "agent") return invalid(field, "must name one of your personal tools");
    const entry = await this.#entry(parsed.canonical);
    if (entry === undefined || entry.layer !== "agent" || entry.owner !== by.id) throw new DomainError("not_found", `you have no personal tool ${name.slice(0, 80)}`);
    const chosen = version ?? [...entry.versions].filter((x) => !entry.revoked.includes(x)).sort(compareVersions).reverse()[0];
    if (chosen === undefined || typeof chosen !== "string" || !VERSION.test(chosen) || !entry.versions.includes(chosen)) throw new DomainError("not_found", `${parsed.canonical} has no version ${String(chosen ?? "left")}`);
    if (entry.revoked.includes(chosen)) invalid(field, `${parsed.canonical} ${chosen} was revoked`);
    const v = await this.#version(parsed.canonical, chosen);
    if (v === undefined) throw new DomainError("not_found", `${parsed.canonical} has no version ${chosen}`);
    return { version: v, name: parsed.canonical, entry };
  }

  /**
   * A promotion's suggested audience (review of slice 2). Any agent may promote, so the suggestion must not tell it which teams or projects exist: it names only teams and projects the author itself belongs to (its own team; a
   * project it holds grants in), and a team or project that does not exist gets the same answer as one the author is not in. Roles are installation role names and are checked as for a release. The decider chooses the audience.
   */
  async #suggestedAudience(by: Principal, value: unknown): Promise<Audience> {
    const refuse = (field: string): never => invalid(field, "a suggestion names all agents, roles, or teams and projects you belong to (by ID or exact name)");
    let audience: Audience;
    try { audience = await this.#catalog.audienceOf(value); } catch (error) {
      if (error instanceof DomainError && (error.field === "audience.teams" || error.field === "audience.projects") && /does not exist|called|by name/.test(error.message)) refuse(error.field);
      throw error;
    }
    const get = (kind: string, id: string) => this.#runner.get(kind, id);
    for (const t of audience.teams ?? []) if (!(await mayReadCatalogEntry(get, by, { layer: "toolbox", audience: { teams: [t] } }))) refuse("audience.teams");
    for (const p of audience.projects ?? []) if (!(await mayReadCatalogEntry(get, by, { layer: "toolbox", audience: { projects: [p] } }))) refuse("audience.projects");
    return audience;
  }

  /** One of the author's own records for a patch: accepted, original (the desk's rule for a tool's source) and shared, so the maintainers who decide can read it. */
  async #authorPart(by: Principal, recordId: string, field: string): Promise<SourceRef> {
    const found = await this.#desks.executableSource(by, recordId);
    const ref: SourceRef = { recordId: found.id, revision: found.revision, digest: sha(found.body), author: by.id };
    await this.#stillShared(ref, field);
    return ref;
  }

  /** The record behind a part the author wrote must still be exactly as proposed, accepted, original and shared (never private scratch). */
  async #stillShared(ref: SourceRef, field: string): Promise<void> {
    const found = await this.#runner.get("desk-record", ref.recordId);
    const r = found?.body as unknown as { owner?: string; status?: string; visibility?: string; body?: unknown; origin?: unknown; copiedFrom?: unknown; archived?: unknown; deleted?: unknown } | undefined;
    if (found === undefined || r === undefined || r.owner !== ref.author || found.revision !== ref.revision || typeof r.body !== "string" || sha(r.body) !== ref.digest || r.deleted !== undefined || r.archived !== undefined) throw new DomainError("invalid_command", `${field}: the record is no longer as it was; write the work again`, { field });
    if (r.status !== "accepted" || r.origin !== undefined || r.copiedFrom !== undefined) throw new DomainError("invalid_command", `${field}: only an accepted record that is your own original work can be proposed`, { field });
    if (r.visibility === "private") throw new DomainError("invalid_command", `${field}: private scratch cannot be proposed; publish it to the desk as shared first so the maintainers can read it`, { field });
  }

  /** What a proposal changes against its base, the access it adds or drops, and its content digest. */
  #shape(base: VersionBody, proposed: Omit<ProposedContent, "digest">): Pick<ToolboxProposalBody, "proposed" | "changes" | "permissionChanges"> {
    const changes = { instructions: proposed.instructional.digest !== base.instructional.digest, executable: proposed.executable?.digest !== base.executable?.digest, manifest: canonicalJson(proposed.manifest as unknown as JsonObject) !== canonicalJson(base.manifest as unknown as JsonObject) };
    if (!changes.instructions && !changes.executable && !changes.manifest) throw new DomainError("invalid_command", `the proposal changes nothing in ${base.name} ${base.version}`, { field: "manifest" });
    const before = new Set(base.manifest.requestedAccess); const after = new Set(proposed.manifest.requestedAccess);
    return { proposed: { ...proposed, digest: digestOf(base.name, proposed) }, changes, permissionChanges: { added: [...after].filter((a) => !before.has(a)).sort(), removed: [...before].filter((a) => !after.has(a)).sort() } };
  }

  async #create(by: Principal, op: string, commandId: string, id: string, body: ToolboxProposalBody): Promise<void> {
    const ref: AggregateRef = { kind: PROPOSAL_KIND, id };
    const iref: AggregateRef = { kind: INDEX_KIND, id: derivedId("tpa", by.id) };
    await this.#runner.command(op, { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { target: body.target, kind: body.kind, digest: body.proposed.digest, base: (body.base ?? null) as unknown as JsonObject, from: (body.from ?? null) as unknown as JsonObject, rationale: body.rationale, tests: body.tests, taskId: body.taskId ?? null, audience: (body.audience ?? null) as unknown as JsonObject },
      build: async () => {
        const index = await this.#runner.get(iref.kind, iref.id);
        const pending = (index?.body as unknown as AuthorIndex | undefined)?.pending ?? [];
        if (pending.length >= PROPOSAL_LIMITS.pendingPerAuthor) throw new DomainError("unavailable", `you already have ${pending.length} proposals waiting for a decision; withdraw one or wait for decisions`);
        const nextIndex: AuthorIndex = { author: by.id, pending: [...pending, id] };
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: body as unknown as JsonObject }, index === undefined ? { type: "create", ref: iref, body: nextIndex as unknown as JsonObject } : { type: "update", ref: iref, expectedRevision: index.revision, body: nextIndex as unknown as JsonObject }],
          detail: { target: body.target, kind: body.kind }, contention: async () => new DomainError("stale_revision", "your proposals changed at the same moment; propose again"),
        };
      },
    }));
  }

  /** The change that takes a proposal off its author's list of proposals waiting (when it reached a final state). */
  async #unindex(author: string, id: string): Promise<Change[]> {
    const iref: AggregateRef = { kind: INDEX_KIND, id: derivedId("tpa", author) };
    const index = await this.#runner.get(iref.kind, iref.id);
    const pending = (index?.body as unknown as AuthorIndex | undefined)?.pending ?? [];
    if (index === undefined || !pending.includes(id)) return [];
    return [{ type: "update", ref: iref, expectedRevision: index.revision, body: { author, pending: pending.filter((x) => x !== id) } as unknown as JsonObject }];
  }

  async #update(by: Principal, op: string, commandId: string, id: string, expectedRevision: number | undefined, payload: JsonObject, mutate: (cur: ToolboxProposalBody, revision: number) => Promise<{ body: ToolboxProposalBody; changes: Change[]; final?: boolean }>): Promise<{ round: number }> {
    if (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1)) invalid("expectedRevision", "must be a whole number from 1");
    const ref: AggregateRef = { kind: PROPOSAL_KIND, id };
    let round = 0;
    await this.#runner.command(op, { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { proposalId: id, expectedRevision: expectedRevision ?? null, ...payload },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        if (found === undefined) throw new DomainError("not_found", "no such proposal");
        if (expectedRevision !== undefined && found.revision !== expectedRevision) throw new DomainError("stale_revision", `the proposal is at revision ${found.revision}, not ${expectedRevision}`, { currentRevision: found.revision });
        const out = await mutate(found.body as unknown as ToolboxProposalBody, found.revision);
        round = out.body.round;
        const unindex = out.final === true ? await this.#unindex(out.body.author, id) : [];
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: out.body as unknown as JsonObject }, ...out.changes, ...unindex], detail: { proposalId: id, state: out.body.state }, contention: async () => new DomainError("stale_revision", "the proposal changed at the same moment; read it again") };
      },
    }));
    return { round };
  }
}

export const PROPOSAL_KIND = "toolbox-proposal";
const INDEX_KIND = "toolbox-proposer";
const digestOf = (target: string, p: Omit<ProposedContent, "digest">): string => sha(canonicalJson({ target, kind: p.kind, manifest: p.manifest, instructional: p.instructional, ...(p.executable === undefined ? {} : { executable: p.executable }) } as unknown as JsonObject));
const event = (p: ToolboxProposalBody, e: ProposalEvent): ProposalEvent[] => [...p.history, e].slice(-PROPOSAL_LIMITS.history);
