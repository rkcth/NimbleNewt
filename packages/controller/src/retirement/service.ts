import { createHash } from "node:crypto";
import type { AgentService, AgentBody } from "../agents/agents.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
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
import { planAgent, planProject, type Blocker, type Plan, type ReleaseLists } from "./gather.js";

export const RETIREMENT = "retirement";
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

/** The one-line account of a plan, for the owner (chat and API). */
export function describePlan(p: Plan): string {
  const r = p.release;
  const what = p.kind === "agent"
    ? `${r.maintenanceLeases.length} maintenance lease(s) and ${r.integratorLeases.length} integrator lease(s) it holds are released, ${r.grants.length} grant(s) revoked${r.credential ? ", its credential taken away" : ""}, its identity disabled`
    : `${r.responsibilities.length} responsibility(ies) retired, ${r.maintenanceLeases.length} maintenance lease(s) and ${r.integratorLeases.length} integrator lease(s) released, ${r.resources.length} resource binding(s) unbound, ${r.grants.length} grant(s) of this project revoked`;
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
    const existing = await this.#runner.get(RETIREMENT, recordId);
    if (existing === undefined && project.state !== "archived") invalid("projectId", "the project is not archived");
    // The archiving this undoes, named in the record: the latest finished one for the project.
    const earlier = (await this.list(by, { subjectId: projectId, limit: 200 })).items.filter((r) => r.action === "archive-project" && r.status === "done").sort((a, b) => (a.finishedAt ?? "") < (b.finishedAt ?? "") ? 1 : -1)[0];
    const note = earlier === undefined ? "The project was archived without a ledger record (it was archived by a plain project change); nothing was released then, so nothing needs restoring." : `Archived ${earlier.finishedAt ?? ""}: its ${earlier.released.responsibilities.length} responsibility(ies) stay retired, its ${earlier.released.resources.length} resource binding(s) stay unbound and its ${earlier.released.grants.length} grant(s) stay revoked. Bind, grant and create again what the project needs.`;
    await this.#start(by, cid, recordId, { action: "restore-project", subjectKind: "project", subjectId: projectId, subjectName: project.name, requestedBy: by.id, reason, startedAt: this.#runner.now(), released: empty, note }, { action: "restore-project", subjectId: projectId, reason });
    const now = await this.#runner.get("project", projectId);
    if (now !== undefined && (now.body as unknown as ProjectBody).state === "archived") {
      await this.#retry(async () => { const cur = (await this.#runner.get("project", projectId))!; await this.#ports.projects.updateProject({ commandId: `rtm-${hash(recordId, "project")}`, actor: by.id, projectId, expectedRevision: cur.revision, state: "active" } as never); });
    }
    return this.#finish(by, recordId, cid);
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
    const existing = await this.#runner.get(RETIREMENT, recordId);
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
    if (started.status === "done") return { id: recordId, status: "done", replayed: true, record: started };
    const released = started.released;
    const target = { kind, id, recordId, actor: by };
    if (kind === "agent") await this.#releaseAgent(by, target, released, started.reason);
    else await this.#releaseProject(by, target, released, started.reason);
    // Last look before the record itself changes: a task assigned since the preview stops the retirement here (the same command carries on once it is cleared).
    const fresh = kind === "agent" ? await planAgent(this.#runner, id) : await planProject(this.#runner, id);
    const hard = (fresh?.blockers ?? []).filter((b: Blocker) => b.kind === "assignment" || b.kind === "responsibility" || b.kind === "report" || b.kind === "unreadable");
    if (hard.length > 0 && fresh !== undefined) throw new DomainError("invalid_transition", describePlan({ ...fresh, blockers: hard }), { field: `${kind}Id` });
    await this.#subject(by, kind, id, recordId);
    return this.#finish(by, recordId, cid);
  }

  async #releaseAgent(by: Principal, t: { id: string; recordId: string }, r: ReleaseLists, reason: string): Promise<void> {
    const why = `released because agent ${t.id} was retired (${t.recordId})`;
    await this.#leases(by, t.recordId, r, why);
    await this.#grants(by, t.recordId, r, `revoked because agent ${t.id} was retired: ${reason}`.slice(0, 900));
    const agent = (await this.#runner.get("agent", t.id))?.body as unknown as AgentBody | undefined;
    if (r.credential && agent !== undefined) await this.#ports.principals.revokeCredential(by, { commandId: `rtm-${hash(t.recordId, "credential")}`, principalId: agent.principalId, reason: `agent retired (${t.recordId})` });
  }

  async #releaseProject(by: Principal, t: { id: string; recordId: string }, r: ReleaseLists, reason: string): Promise<void> {
    const why = `released because project ${t.id} was archived (${t.recordId})`;
    await this.#leases(by, t.recordId, r, why);
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

  async #leases(by: Principal, recordId: string, r: ReleaseLists, why: string): Promise<void> {
    for (const id of r.maintenanceLeases) {
      const cur = await this.#runner.get("maintenance-lease", id);
      const b = cur?.body as unknown as LeaseBody | undefined;
      if (b === undefined || b.state !== "held") continue;
      await this.#retry(() => this.#ports.leases.release(by, { commandId: `rtm-${hash(recordId, "mlease", id, String(b.generation))}`, resourceId: b.resourceId, evidence: why }).then(() => undefined));
    }
    for (const id of r.integratorLeases) {
      await this.#retry(async () => {
        const cur = await this.#runner.get("integrator-lease", id);
        const b = cur?.body as unknown as IntegratorLeaseBody | undefined;
        if (b === undefined || b.state !== "held") return;
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
  async #start(by: Principal, cid: string, recordId: string, body: Omit<RetirementBody, "status">, payload: JsonObject): Promise<View<RetirementBody>> {
    await this.#runner.command("retirement.start", { commandId: cid, actor: by.id }, async () => ({
      payload,
      build: async () => {
        const ref = { kind: RETIREMENT, id: recordId };
        return { ref, creates: true, changes: [{ type: "create" as const, ref, body: { ...body, status: "started" } as unknown as JsonObject }], detail: { action: body.action, subject: body.subjectId } };
      },
    }));
    const found = await this.#runner.get(RETIREMENT, recordId);
    if (found === undefined) throw new DomainError("unavailable", "the retirement record could not be read back");
    return view<RetirementBody>(found);
  }

  async #finish(by: Principal, recordId: string, cid: string): Promise<RetirementResult> {
    const before = (await this.#runner.get(RETIREMENT, recordId))!;
    if ((before.body as unknown as RetirementBody).status === "done") return { id: recordId, status: "done", replayed: true, record: view<RetirementBody>(before) };
    await this.#runner.command("retirement.finish", { commandId: `rtm-fin-${hash(cid)}`, actor: by.id }, async () => ({
      payload: { recordId },
      build: async () => {
        const cur = await this.#runner.existing(RETIREMENT, recordId, (await this.#runner.get(RETIREMENT, recordId))!.revision);
        const ref = { kind: RETIREMENT, id: recordId };
        return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: cur.revision, body: { ...(cur.body as unknown as RetirementBody), status: "done", finishedAt: this.#runner.now() } as unknown as JsonObject }], detail: { recordId } };
      },
    }));
    return { id: recordId, status: "done", replayed: false, record: view<RetirementBody>((await this.#runner.get(RETIREMENT, recordId))!) };
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
