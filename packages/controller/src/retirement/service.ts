import { createHash } from "node:crypto";
import type { AgentService, AgentBody } from "../agents/agents.js";
import { DomainError } from "../domain/errors.js";
import { derivedId, operationIdOf } from "../domain/ids.js";
import { onlyKnown, text, type ProjectBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { IntegratorLeaseBody, IntegratorLeaseService } from "../landing/integrator-lease.js";
import { noCredential } from "../projects/common.js";
import type { LeaseBody, MaintenanceLeaseService } from "../projects/leases.js";
import type { ProjectResourceService, ResourceBody } from "../projects/resources.js";
import type { ResponsibilityBody, ResponsibilityService } from "../projects/responsibilities.js";
import { scopedCommandId } from "../security/credentials.js";
import type { GrantRecordBody, GrantService } from "../security/grants.js";
import type { Principal, PrincipalService } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { bareAgentId, liveAssignments, planAgent, planProject, type Blocker, type Plan, type ReleaseLists } from "./gather.js";

export const RETIREMENT = "retirement";
/** One record per agent or project (kind `retirement-claim`, prefix `rtc`): which retirement of it is under way, so two at once cannot both run (the second carries on the first, or is refused if it is a different action). */
export const RETIREMENT_CLAIM = "retirement-claim";
interface ClaimBody { readonly subjectKind: "agent" | "project"; readonly subjectId: string; readonly recordId: string; readonly state: "open" | "closed" }
export type RetirementAction = "retire-agent" | "archive-project" | "restore-project";

/**
 * One ledger record of a retirement (kind `retirement`, never removed by any retention rule): who asked, why, what was shown and confirmed (`digest`), and exactly what was released or revoked.
 * It is written first as `started` and finished as `done`, so a retirement that stopped halfway is visible and the same command carries on from where it stopped.
 */
export interface RetirementBody {
  readonly action: RetirementAction;
  readonly subjectKind: "agent" | "project";
  readonly subjectId: string;
  readonly subjectName: string;
  readonly status: "started" | "done";
  readonly requestedBy: string;
  readonly reason: string;
  readonly digest?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly released: ReleaseLists;
  /** For a restore: what stays released (grants, credentials, resources and responsibilities are not brought back by themselves). */
  readonly note?: string;
}

export interface RetirementPorts {
  readonly agents: Pick<AgentService, "retire">;
  readonly projects: Pick<ProjectService, "updateProject">;
  readonly duties: Pick<ResponsibilityService, "update">;
  readonly resources: Pick<ProjectResourceService, "unbindResource">;
  readonly leases: Pick<MaintenanceLeaseService, "release">;
  readonly integrator: Pick<IntegratorLeaseService, "release">;
  readonly grants: Pick<GrantService, "revoke">;
  readonly principals: Pick<PrincipalService, "revokeCredential">;
}

export interface RetirementResult {
  readonly id: string;
  readonly status: "done";
  readonly replayed: boolean;
  readonly record: View<RetirementBody>;
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 32);
const empty: ReleaseLists = { maintenanceLeases: [], integratorLeases: [], grants: [], resources: [], responsibilities: [], credential: false };
const claimIdOf = (kind: "agent" | "project", id: string): string => derivedId("rtc", `retirement-claim:${kind}:${id}`);
/** A blocker that stops a retirement at any point (a list that is merely long only stops one that has not started). */
const hardBlocker = (b: Blocker): boolean => b.kind !== "too-many";
const merge = (a: readonly string[], b: readonly string[]): string[] => [...new Set([...a, ...b])].sort();
const union = (a: ReleaseLists, b: ReleaseLists): ReleaseLists => ({ maintenanceLeases: merge(a.maintenanceLeases, b.maintenanceLeases), integratorLeases: merge(a.integratorLeases, b.integratorLeases), grants: merge(a.grants, b.grants), resources: merge(a.resources, b.resources), responsibilities: merge(a.responsibilities, b.responsibilities), credential: a.credential || b.credential, ...((a.fencedGrants ?? []).length + (b.fencedGrants ?? []).length === 0 ? {} : { fencedGrants: merge(a.fencedGrants ?? [], b.fencedGrants ?? []) }) });
/** What a look made after the releases still finds held: taken or given while the retirement ran. The same command again releases it. */
const stillHeld = (p: Plan): Blocker[] => {
  const r = p.release;
  const n = r.maintenanceLeases.length + r.integratorLeases.length + r.grants.length + r.resources.length + r.responsibilities.length + (r.credential ? 1 : 0);
  return n === 0 ? [] : [{ kind: "held", id: p.id, why: `${n} lease(s), grant(s), binding(s), duties or a credential were taken or given while the retirement ran; send the same command again to release them too` }];
};

/** The one-line account of a plan, for the owner (chat and API). */
export function describePlan(p: Plan): string {
  const r = p.release;
  const what = p.kind === "agent"
    ? `${r.maintenanceLeases.length} maintenance lease(s) and ${r.integratorLeases.length} integrator lease(s) it holds are released, ${r.grants.length} grant(s) revoked${r.credential ? ", its credential taken away" : ""}, its identity disabled`
    : `${r.responsibilities.length} responsibility(ies) retired, ${r.maintenanceLeases.length} maintenance lease(s) and ${r.integratorLeases.length} integrator lease(s) released, ${r.resources.length} resource binding(s) unbound, ${r.grants.length} execution grant(s) made for this project revoked${(r.fencedGrants ?? []).length === 0 ? "" : `, ${(r.fencedGrants ?? []).length} grant(s) written on agents' own records stop working for as long as it is archived (they work again on restore)`} (read-only grants stay, so who could read it still can)`;
  if (p.blockers.length > 0) return `${p.kind === "agent" ? "Agent" : "Project"} ${p.name}: cannot be ${p.kind === "agent" ? "retired" : "archived"} yet. ${p.blockers.slice(0, 5).map((b) => `${b.kind} ${b.id}: ${b.why}`).join("; ")}${p.blockers.length > 5 ? `; and ${p.blockers.length - 5} more` : ""}.`;
  return `${p.kind === "agent" ? "Retiring agent" : "Archiving project"} ${p.name} would: ${what}. Its records stay and stay searchable${p.kind === "agent" ? "; its ID is never reused" : "; the project can be restored (grants, bindings and retired responsibilities are not brought back by themselves)"}. Confirm with digest ${p.digest}.`;
}

/**
 * Retirement of agents and archiving of projects (card P06). One owner-only, confirmed, ledgered operation: it refuses while live assignments remain, releases what the subject holds (leases, resource bindings, responsibilities),
 * revokes execution access (grants and the agent's credential) and then retires or archives the record itself. Nothing is deleted: records stay, searchable under the same access rules, and a project can be restored.
 */
export class RetirementService {
  readonly #runner: CommandRunner;
  readonly #ports: RetirementPorts;
  private constructor(runner: CommandRunner, ports: RetirementPorts) { this.#runner = runner; this.#ports = ports; }
  static withEpoch(storage: ControllerStorage, epoch: number, ports: RetirementPorts, options: RunnerOptions = {}): RetirementService { return new RetirementService(new CommandRunner(storage, epoch, options), ports); }

  #owner(by: Principal, what: string): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not ${what}`); }

  /** What retiring an agent or archiving a project would do, read now, with the digest that confirms it. Changes nothing. */
  async preview(by: Principal, query: { kind: "agent" | "project"; id: string }): Promise<Plan> {
    this.#owner(by, "preview a retirement");
    onlyKnown(query, ["kind", "id"]);
    if (query.kind !== "agent" && query.kind !== "project") invalid("kind", "must be agent or project");
    const id = text(query.id, "id", { min: 1, max: 100 });
    const plan = query.kind === "agent" ? await planAgent(this.#runner, id) : await planProject(this.#runner, id);
    if (plan === undefined) throw new DomainError("not_found", `${query.kind} ${id} does not exist`);
    return plan;
  }

  /** Retires an agent: refused while it holds live assignments or active responsibilities or active agents report to it; otherwise releases what it holds, revokes its grants and credential, disables its identity and keeps the record. */
  retireAgent(by: Principal, command: { commandId: string; agentId: string; reason: string; confirm: string }): Promise<RetirementResult> {
    onlyKnown(command, ["commandId", "agentId", "reason", "confirm"]);
    return this.#retire(by, "retire-agent", "agent", text(command.agentId, "agentId", { min: 1, max: 100 }), command);
  }

  /** Archives a project: refused while any of its tasks is assigned and unfinished; otherwise retires its responsibilities, releases its leases and resource bindings, revokes the grants made for it and archives the record. Everything stays readable. */
  archiveProject(by: Principal, command: { commandId: string; projectId: string; reason: string; confirm: string }): Promise<RetirementResult> {
    onlyKnown(command, ["commandId", "projectId", "reason", "confirm"]);
    return this.#retire(by, "archive-project", "project", text(command.projectId, "projectId", { min: 1, max: 100 }), command);
  }

  /** Brings an archived project back to active. What the archiving released stays released: the ledger record says what to bind, grant and restart. */
  async restoreProject(by: Principal, command: { commandId: string; projectId: string; reason?: string }): Promise<RetirementResult> {
    this.#owner(by, "restore a project");
    onlyKnown(command, ["commandId", "projectId", "reason"]);
    const projectId = text(command.projectId, "projectId", { min: 1, max: 100 });
    const reason = command.reason === undefined ? "restored" : noCredential(text(command.reason, "reason", { min: 1, max: 500, multiline: true }), "reason");
    const cid = scopedCommandId(by.id, command.commandId);
    const recordId = derivedId("rtm", cid);
    const found = await this.#runner.get("project", projectId);
    if (found === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
    const project = found.body as unknown as ProjectBody;
    const existing = (await this.#runner.get(RETIREMENT, recordId)) ?? (await this.#runner.storage.getOperation(operationIdOf(cid)));
    if (existing === undefined && project.state !== "archived") invalid("projectId", "the project is not archived");
    // The archiving this undoes, named in the record: the latest finished one for the project.
    const earlier = (await this.list(by, { subjectId: projectId, limit: 200 })).items.filter((r) => r.action === "archive-project" && r.status === "done").sort((a, b) => (a.finishedAt ?? "") < (b.finishedAt ?? "") ? 1 : -1)[0];
    const note = earlier === undefined ? "The project was archived without a ledger record (it was archived by a plain project change); nothing was released then, so nothing needs restoring." : `Archived ${earlier.finishedAt ?? ""}: its ${earlier.released.responsibilities.length} responsibility(ies) stay retired, its ${earlier.released.resources.length} resource binding(s) stay unbound and its ${earlier.released.grants.length} execution grant(s) stay revoked (read-only grants were never revoked)${(earlier.released.fencedGrants ?? []).length === 0 ? "" : `; the ${(earlier.released.fencedGrants ?? []).length} grant(s) written on principals' own records (${(earlier.released.fencedGrants ?? []).slice(0, 5).join(", ")}) were only suspended and work again now`}. Bind, grant and create again what the project needs.`;
    const started = await this.#start(by, cid, recordId, { action: "restore-project", subjectKind: "project", subjectId: projectId, subjectName: project.name, requestedBy: by.id, reason, startedAt: this.#runner.now(), released: empty, note }, { action: "restore-project", subjectId: projectId, reason });
    const now = await this.#runner.get("project", projectId);
    if (now !== undefined && (now.body as unknown as ProjectBody).state === "archived") {
      await this.#retry(async () => { const cur = (await this.#runner.get("project", projectId))!; await this.#ports.projects.updateProject({ commandId: `rtm-${hash(started.id, "project")}`, actor: by.id, projectId, expectedRevision: cur.revision, state: "active" } as never); });
    }
    return this.#finish(by, started.id);
  }

  /** The retirement ledger: newest first, optionally for one subject. */
  async list(by: Principal, query: { subjectId?: string; afterId?: string; limit?: number } = {}): Promise<{ items: View<RetirementBody>[]; next?: string }> {
    this.#owner(by, "read the retirement ledger");
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("limit", "must be a whole number from 1 to 200");
    const out: View<RetirementBody>[] = [];
    let after: string | undefined; let pages = 0;
    for (;;) {
      const page = await this.#runner.list(RETIREMENT, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const r of page) { const v = view<RetirementBody>(r); if (query.subjectId === undefined || v.subjectId === query.subjectId) out.push(v); }
      if (page.length < 200 || ++pages >= 50) break;
      after = page[page.length - 1]!.id;
    }
    out.sort((a, b) => (a.startedAt === b.startedAt ? (a.id < b.id ? 1 : -1) : a.startedAt < b.startedAt ? 1 : -1));
    const from = query.afterId === undefined ? 0 : Math.max(0, out.findIndex((r) => r.id === query.afterId) + 1);
    const items = out.slice(from, from + limit);
    return { items, ...(from + limit < out.length ? { next: items[items.length - 1]!.id } : {}) };
  }

  // ---- the shared run -------------------------------------------------------------------------------------------------------

  async #retire(by: Principal, action: "retire-agent" | "archive-project", kind: "agent" | "project", id: string, command: { commandId: string; reason: string; confirm: string }): Promise<RetirementResult> {
    this.#owner(by, kind === "agent" ? "retire an agent" : "archive a project");
    const reason = noCredential(text(command.reason, "reason", { min: 1, max: 500, multiline: true }), "reason");
    const confirm = text(command.confirm, "confirm", { min: 1, max: 100 });
    const cid = scopedCommandId(by.id, command.commandId);
    const recordId = derivedId("rtm", cid);
    // This command already ran (its own record, or the record of a retirement it met under way and carried on): it is answered from what it did, not judged again.
    const existing = (await this.#runner.get(RETIREMENT, recordId)) ?? (await this.#runner.storage.getOperation(operationIdOf(cid)));
    let plan: Plan | undefined;
    if (existing === undefined) {
      plan = kind === "agent" ? await planAgent(this.#runner, id) : await planProject(this.#runner, id);
      if (plan === undefined) throw new DomainError("not_found", `${kind} ${id} does not exist`);
      const state = kind === "agent" ? ((await this.#runner.get("agent", id))!.body as unknown as AgentBody).state : ((await this.#runner.get("project", id))!.body as unknown as ProjectBody).state;
      if (state === "retired" || state === "archived") invalid(`${kind}Id`, `the ${kind} is already ${state}`);
      if (confirm !== plan.digest) invalid("confirm", `is not the digest of a preview of this ${kind} as it is now; ask retirement.preview again and give its digest`);
      if (plan.blockers.length > 0) throw new DomainError("invalid_transition", describePlan(plan), { field: `${kind}Id` });
    }
    const started = await this.#start(by, cid, recordId, { action, subjectKind: kind, subjectId: id, subjectName: plan?.name ?? "", requestedBy: by.id, reason, digest: confirm, startedAt: this.#runner.now(), released: plan?.release ?? empty }, { action, subjectId: id, reason, digest: confirm });
    if (started.status === "done") return { id: started.id, status: "done", replayed: true, record: started };
    // A retirement carried on (this command again, or another one meeting it under way) also releases what was taken or given since it started: a look made now.
    const now = plan ?? (kind === "agent" ? await planAgent(this.#runner, id) : await planProject(this.#runner, id));
    if (now === undefined) throw new DomainError("not_found", `${kind} ${id} does not exist`);
    const stop = now.blockers.filter(hardBlocker);
    if (stop.length > 0) throw new DomainError("invalid_transition", describePlan({ ...now, blockers: stop }), { field: `${kind}Id` });
    const released = union(started.released, now.release);
    const target = { kind, id, recordId: started.id, actor: by };
    if (kind === "agent") await this.#releaseAgent(by, target, released, started.reason);
    else await this.#releaseProject(by, target, released, started.reason);
    // Last look before the record itself changes: a task assigned, a duty given or a lease or grant taken since the preview stops the retirement here (the same command carries on once it is cleared, and releases what was taken).
    const fresh = kind === "agent" ? await planAgent(this.#runner, id) : await planProject(this.#runner, id);
    const left = fresh === undefined ? [] : stillHeld(fresh);
    const hard = [...(fresh?.blockers ?? []).filter(hardBlocker), ...left];
    if (hard.length > 0 && fresh !== undefined) throw new DomainError("invalid_transition", describePlan({ ...fresh, blockers: hard }), { field: `${kind}Id` });
    await this.#subject(by, kind, id, started.id);
    return this.#finish(by, started.id, released);
  }

  async #releaseAgent(by: Principal, t: { id: string; recordId: string }, r: ReleaseLists, reason: string): Promise<void> {
    const why = `released because agent ${t.id} was retired (${t.recordId})`;
    // Only a lease the agent itself still holds is released: one that changed hands since the plan was read belongs to someone else now.
    await this.#leases(by, t.recordId, r, why, (holder) => bareAgentId(holder) === t.id);
    await this.#grants(by, t.recordId, r, `revoked because agent ${t.id} was retired: ${reason}`.slice(0, 900));
    const agent = (await this.#runner.get("agent", t.id))?.body as unknown as AgentBody | undefined;
    if (r.credential && agent !== undefined) await this.#ports.principals.revokeCredential(by, { commandId: `rtm-${hash(t.recordId, "credential")}`, principalId: agent.principalId, reason: `agent retired (${t.recordId})` });
  }

  async #releaseProject(by: Principal, t: { id: string; recordId: string }, r: ReleaseLists, reason: string): Promise<void> {
    const why = `released because project ${t.id} was archived (${t.recordId})`;
    // A lease whose holder is (now) working on an assigned task is in use: it is not freed under that work; the archiving stops and says so.
    const live = await liveAssignments(this.#runner, () => false);
    if (!live.complete) throw new DomainError("invalid_transition", `project ${t.id}: the assignments could not all be read, so no lease is freed on a guess`, { field: "projectId" });
    await this.#leases(by, t.recordId, r, why, (holder) => {
      const busy = live.holders.get(bareAgentId(holder));
      if (busy !== undefined) throw new DomainError("invalid_transition", `project ${t.id}: a lease is held by ${holder} while it works on task ${busy}; wait for it to release the lease or release that task first`, { field: "projectId" });
      return true;
    });
    for (const id of r.responsibilities) {
      await this.#retry(async () => {
        const cur = await this.#runner.get("responsibility", id);
        if (cur === undefined || (cur.body as unknown as ResponsibilityBody).state === "retired") return;
        await this.#ports.duties.update(by, { commandId: `rtm-${hash(t.recordId, "duty", id)}`, responsibilityId: id, expectedRevision: cur.revision, state: "retired" } as never);
      });
    }
    for (const id of r.resources) {
      await this.#retry(async () => {
        const cur = await this.#runner.get("project-resource", id);
        if (cur === undefined || (cur.body as unknown as ResourceBody).state !== "bound") return;
        await this.#ports.resources.unbindResource(by, { commandId: `rtm-${hash(t.recordId, "resource", id)}`, resourceId: id, expectedRevision: cur.revision });
      });
    }
    await this.#grants(by, t.recordId, r, `revoked because project ${t.id} was archived: ${reason}`.slice(0, 900));
  }

  async #leases(by: Principal, recordId: string, r: ReleaseLists, why: string, holderOk: (holder: string) => boolean): Promise<void> {
    for (const id of r.maintenanceLeases) {
      const cur = await this.#runner.get("maintenance-lease", id);
      const b = cur?.body as unknown as LeaseBody | undefined;
      if (b === undefined || b.state !== "held" || b.holderId === undefined || !holderOk(b.holderId)) continue;
      await this.#retry(() => this.#ports.leases.release(by, { commandId: `rtm-${hash(recordId, "mlease", id, String(b.generation))}`, resourceId: b.resourceId, evidence: why }).then(() => undefined));
    }
    for (const id of r.integratorLeases) {
      await this.#retry(async () => {
        const cur = await this.#runner.get("integrator-lease", id);
        const b = cur?.body as unknown as IntegratorLeaseBody | undefined;
        if (b === undefined || b.state !== "held" || !holderOk(b.holder)) return;
        await this.#ports.integrator.release({ commandId: `rtm-${hash(recordId, "ilease", id, String(b.fence))}`, leaseId: id, fence: b.fence, note: why.slice(0, 300) });
      });
    }
  }

  async #grants(by: Principal, recordId: string, r: ReleaseLists, reason: string): Promise<void> {
    for (const id of r.grants) {
      await this.#retry(async () => {
        const cur = await this.#runner.get("grant-record", id);
        if (cur === undefined || (cur.body as unknown as GrantRecordBody).state !== "active") return;
        await this.#ports.grants.revoke(by, { commandId: `rtm-${hash(recordId, "grant", id)}`, grantId: id, expectedRevision: cur.revision, reason });
      });
    }
  }

  /** The subject's own record changes last, so a stopped retirement never leaves a retired agent that still holds something. */
  async #subject(by: Principal, kind: "agent" | "project", id: string, recordId: string): Promise<void> {
    await this.#retry(async () => {
      const cur = await this.#runner.get(kind, id);
      if (cur === undefined) throw new DomainError("not_found", `${kind} ${id} does not exist`);
      const state = (cur.body as unknown as { state: string }).state;
      if (state === "retired" || state === "archived") return;
      if (kind === "agent") await this.#ports.agents.retire(by, { commandId: `rtm-${hash(recordId, "subject")}`, agentId: id, expectedRevision: cur.revision } as never);
      else await this.#ports.projects.updateProject({ commandId: `rtm-${hash(recordId, "subject")}`, actor: by.id, projectId: id, expectedRevision: cur.revision, state: "archived" } as never);
    });
  }

  /** Creates the ledger record as `started` (or finds the same command's record) and returns it. */
  /**
   * Creates the ledger record as `started` (or finds the same command's record) and returns it. The subject's claim is taken in the same write, so two retirements of one agent or project cannot both start:
   * a second command that meets a retirement of the same kind under way carries that one on (one ledger record), and a different action (a restore while an archiving is under way) is refused.
   */
  async #start(by: Principal, cid: string, recordId: string, body: Omit<RetirementBody, "status">, payload: JsonObject): Promise<View<RetirementBody>> {
    const claimRef = { kind: RETIREMENT_CLAIM, id: claimIdOf(body.subjectKind, body.subjectId) };
    let target = recordId;
    for (let attempt = 1; ; attempt++) {
      try {
        const done = await this.#runner.command("retirement.start", { commandId: cid, actor: by.id }, async () => ({
          payload,
          build: async () => {
            const claim = await this.#runner.get(claimRef.kind, claimRef.id);
            const held = claim?.body as unknown as ClaimBody | undefined;
            const contention = async () => new DomainError("stale_revision", `another retirement of ${body.subjectKind} ${body.subjectId} started at the same moment`);
            if (held !== undefined && held.state === "open" && held.recordId !== recordId) {
              const other = (await this.#runner.get(RETIREMENT, held.recordId))?.body as unknown as RetirementBody | undefined;
              if (other !== undefined && other.status === "started") {
                if (other.action !== body.action) throw new DomainError("invalid_transition", `a ${other.action} of ${body.subjectKind} ${body.subjectId} is under way (${held.recordId}); it has to finish first`, { field: `${body.subjectKind}Id` });
                const ref = { kind: RETIREMENT, id: held.recordId };
                return { ref, creates: false, changes: [{ type: "check" as const, ref: claimRef, expectedRevision: claim!.revision }, { type: "check" as const, ref, expectedRevision: (await this.#runner.get(RETIREMENT, held.recordId))!.revision }], detail: { action: body.action, subject: body.subjectId, carriedOn: held.recordId }, contention };
              }
            }
            const ref = { kind: RETIREMENT, id: recordId };
            const open: ClaimBody = { subjectKind: body.subjectKind, subjectId: body.subjectId, recordId, state: "open" };
            const claimChange = claim === undefined ? { type: "create" as const, ref: claimRef, body: open as unknown as JsonObject } : { type: "update" as const, ref: claimRef, expectedRevision: claim.revision, body: open as unknown as JsonObject };
            return { ref, creates: true, changes: [claimChange, { type: "create" as const, ref, body: { ...body, status: "started" } as unknown as JsonObject }], detail: { action: body.action, subject: body.subjectId }, contention };
          },
        }));
        target = done.id;
        break;
      } catch (error) {
        if (attempt < 6 && error instanceof DomainError && error.code === "stale_revision") continue;
        throw error;
      }
    }
    const found = await this.#runner.get(RETIREMENT, target);
    if (found === undefined) throw new DomainError("unavailable", "the retirement record could not be read back");
    return view<RetirementBody>(found);
  }

  /** Marks the record `done` (with everything that was released, including what was taken since it started) and frees the subject's claim, in one write. The command ID comes from the record, so two commands finishing the same retirement write it once. */
  async #finish(by: Principal, recordId: string, released?: ReleaseLists): Promise<RetirementResult> {
    const before = (await this.#runner.get(RETIREMENT, recordId))!;
    if ((before.body as unknown as RetirementBody).status === "done") return { id: recordId, status: "done", replayed: true, record: view<RetirementBody>(before) };
    const result = await this.#runner.command("retirement.finish", { commandId: `rtm-fin-${hash(recordId)}`, actor: by.id }, async () => ({
      payload: { recordId },
      build: async () => {
        const cur = (await this.#runner.get(RETIREMENT, recordId))!;
        const body = cur.body as unknown as RetirementBody;
        const ref = { kind: RETIREMENT, id: recordId };
        const claimRef = { kind: RETIREMENT_CLAIM, id: claimIdOf(body.subjectKind, body.subjectId) };
        const claim = await this.#runner.get(claimRef.kind, claimRef.id);
        const closed: ClaimBody = { subjectKind: body.subjectKind, subjectId: body.subjectId, recordId, state: "closed" };
        const claimChange = claim === undefined ? [] : (claim.body as unknown as ClaimBody).recordId === recordId ? [{ type: "update" as const, ref: claimRef, expectedRevision: claim.revision, body: closed as unknown as JsonObject }] : [];
        return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: cur.revision, body: { ...body, status: "done", finishedAt: this.#runner.now(), ...(released === undefined ? {} : { released }) } as unknown as JsonObject }, ...claimChange], detail: { recordId } };
      },
    }));
    return { id: recordId, status: "done", replayed: result.replayed, record: view<RetirementBody>((await this.#runner.get(RETIREMENT, recordId))!) };
  }

  /** A change to a record that others also write (a grant's last-used time, say) may lose a race: read again and redo, a few times. */
  async #retry(step: () => Promise<void>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { await step(); return; } catch (error) {
        if (attempt < 6 && error instanceof DomainError && error.code === "stale_revision") continue;
        throw error;
      }
    }
  }
}
