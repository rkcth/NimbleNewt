import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, text, type View } from "../domain/model.js";
import { CommandRunner, view, type Built, type CommandResult, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { PROJECT_WORK_LIMITS as L, hidden, invalid, may, noCredential, scanAll } from "./common.js";
import type { ResponsibilityBody, ResponsibilityService } from "./responsibilities.js";

/** Repeated alerts about one thing, grouped (kind `responsibility-incident`). */
export interface IncidentBody {
  readonly responsibilityId: string;
  readonly projectId: string;
  /** What the alerts are about, in the reporter's words (for example `disk-full:web-1`). Alerts with the same signature on one responsibility are one incident. */
  readonly signature: string;
  readonly state: "open" | "resolved";
  readonly count: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly lastSummary: string;
  readonly worst: "attention" | "failed";
  /** Set once, when the responsibility's escalation time has passed with the incident still open. */
  readonly escalatedAt?: string;
  readonly escalatedTo?: string;
  /** When the escalation was passed on as a notice (the loop retries until it is). */
  readonly notifiedAt?: string;
  readonly resolvedAt?: string;
  readonly resolvedBy?: string;
  readonly evidence?: string;
}
interface SlotBody { readonly generation: number; readonly openId?: string }

const INCIDENT = "responsibility-incident";
const SLOT = "responsibility-incident-slot";
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);

/** How an observed state is told apart from the intended one (card P04): never "healthy" without a recent check. */
export interface ResponsibilityObservedState {
  readonly responsibilityId: string;
  readonly intended: string;
  /** `unknown`: no check yet, or the last one is older than twice the check period. Otherwise what the last check found. */
  readonly observed: "unknown" | "ok" | "attention" | "failed";
  readonly lastCheckAt?: string;
  readonly openIncidents: number;
}

/**
 * Incidents for responsibilities (card P04): repeated alerts group into one open incident, an incident not resolved by the responsibility's escalation time is escalated once, and the
 * observed state is kept apart from the desired one. Nothing here acts on a resource or starts a model; escalation is a record the caller turns into a notice.
 */
export class IncidentService {
  readonly #runner: CommandRunner;
  readonly #duties: Pick<ResponsibilityService, "get" | "list" | "status">;

  private constructor(runner: CommandRunner, duties: Pick<ResponsibilityService, "get" | "list" | "status">) { this.#runner = runner; this.#duties = duties; }

  static withEpoch(storage: ControllerStorage, epoch: number, duties: Pick<ResponsibilityService, "get" | "list" | "status">, options: RunnerOptions = {}): IncidentService {
    return new IncidentService(new CommandRunner(storage, epoch, options), duties);
  }

  /** Reports an alert (`attention` or `failed`). The first of a signature opens an incident; later ones add to the open one. Whoever may add history to the responsibility may report. */
  async report(by: Principal, command: NoActor & { responsibilityId: string; signature: string; summary: string; outcome: "attention" | "failed" }): Promise<CommandResult> {
    return this.#runner.command("responsibility.incident.report", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "responsibilityId", "signature", "summary", "outcome"]);
      const signature = text(command.signature, "signature", { min: 1, max: 120 });
      const summary = noCredential(text(command.summary, "summary", { min: 1, max: L.summary, multiline: true }), "summary");
      const outcome = command.outcome === "attention" || command.outcome === "failed" ? command.outcome : invalid("outcome", "must be attention or failed");
      return {
        payload: { responsibilityId: command.responsibilityId, signature, summary, outcome },
        build: async (): Promise<Built> => {
          const duty = await this.#duties.get(by, command.responsibilityId);
          if (duty === undefined || !this.#mayReport(by, duty)) throw hidden(by, "report on that responsibility");
          if (duty.state === "retired") invalid("responsibilityId", `responsibility ${duty.id} is retired`);
          const now = this.#runner.now();
          const slotRef: AggregateRef = { kind: SLOT, id: `rslot-${hash(duty.id, signature)}` };
          const slot = await this.#runner.get(SLOT, slotRef.id);
          const before = slot?.body as unknown as SlotBody | undefined;
          const open = before?.openId === undefined ? undefined : await this.#runner.get(INCIDENT, before.openId);
          const changes: Change[] = [];
          let ref: AggregateRef;
          if (open !== undefined && (open.body as unknown as IncidentBody).state === "open") {
            const b = open.body as unknown as IncidentBody;
            ref = { kind: INCIDENT, id: open.id };
            const next: IncidentBody = { ...b, count: b.count + 1, lastAt: now, lastSummary: summary, worst: b.worst === "failed" || outcome === "failed" ? "failed" : "attention" };
            changes.push({ type: "update", ref, expectedRevision: open.revision, body: next as unknown as JsonObject });
            if (slot !== undefined) changes.push({ type: "check", ref: slotRef, expectedRevision: slot.revision });
          } else {
            const generation = (before?.generation ?? 0) + 1;
            ref = { kind: INCIDENT, id: `rinc-${hash(duty.id, signature, String(generation))}` };
            const body: IncidentBody = { responsibilityId: duty.id, projectId: duty.projectId, signature, state: "open", count: 1, firstAt: now, lastAt: now, lastSummary: summary, worst: outcome };
            changes.push({ type: "create", ref, body: body as unknown as JsonObject });
            const slotBody: SlotBody = { generation, openId: ref.id };
            changes.push(slot === undefined ? { type: "create", ref: slotRef, body: slotBody as unknown as JsonObject } : { type: "update", ref: slotRef, expectedRevision: slot.revision, body: slotBody as unknown as JsonObject });
          }
          return { ref, creates: true, changes, detail: { responsibilityId: duty.id, signature }, contention: async () => new DomainError("stale_revision", "the incident changed meanwhile; try again") };
        },
      };
    });
  }

  /** Marks an open incident resolved, with the evidence for it. Whoever may report may resolve. A resolved signature that alerts again opens a new incident. */
  async resolve(by: Principal, command: NoActor & { incidentId: string; evidence: string }): Promise<CommandResult> {
    return this.#runner.command("responsibility.incident.resolve", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "incidentId", "evidence"]);
      const evidence = noCredential(text(command.evidence, "evidence", { min: 1, max: L.summary, multiline: true }), "evidence");
      return {
        payload: { incidentId: command.incidentId, evidence },
        build: async (): Promise<Built> => {
          const found = await this.#runner.get(INCIDENT, String(command.incidentId));
          const b = found?.body as unknown as IncidentBody | undefined;
          const duty = b === undefined ? undefined : await this.#duties.get(by, b.responsibilityId);
          if (found === undefined || b === undefined || duty === undefined || !this.#mayReport(by, duty)) throw hidden(by, "resolve that incident");
          if (b.state === "resolved") invalid("incidentId", "that incident is already resolved");
          const next: IncidentBody = { ...b, state: "resolved", resolvedAt: this.#runner.now(), resolvedBy: by.id, evidence };
          const slotRef: AggregateRef = { kind: SLOT, id: `rslot-${hash(b.responsibilityId, b.signature)}` };
          const slot = await this.#runner.get(SLOT, slotRef.id);
          const changes: Change[] = [{ type: "update", ref: { kind: INCIDENT, id: found.id }, expectedRevision: found.revision, body: next as unknown as JsonObject }];
          if (slot !== undefined) changes.push({ type: "update", ref: slotRef, expectedRevision: slot.revision, body: { generation: (slot.body as unknown as SlotBody).generation } as unknown as JsonObject });
          return { ref: { kind: INCIDENT, id: found.id }, creates: false, changes, detail: { responsibilityId: b.responsibilityId }, contention: async () => new DomainError("stale_revision", "the incident changed meanwhile; try again") };
        },
      };
    });
  }

  /**
   * Escalates the open incidents of a project whose responsibility names an escalation time that has passed since the incident first opened, once each (a repeat or another instance
   * records nothing new). Returns the incidents newly escalated. Owner, service, or `responsibility.write`.
   */
  async escalate(by: Principal, projectId: string): Promise<View<IncidentBody>[]> {
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "escalate incidents in that project");
    const out: View<IncidentBody>[] = [];
    const now = Date.parse(this.#runner.now());
    for (const a of await scanAll(this.#runner, INCIDENT, 50_000, (x) => { const b = x.body as unknown as IncidentBody; return b.projectId === projectId && b.state === "open" && b.escalatedAt === undefined; })) {
      const b = a.body as unknown as IncidentBody;
      const duty = await this.#duties.get(by, b.responsibilityId);
      const esc = duty?.escalation;
      if (esc?.afterMinutes === undefined || now - Date.parse(b.firstAt) < esc.afterMinutes * 60_000) continue;
      const result = await this.#runner.command("responsibility.incident.escalate", { commandId: `resc-${a.id}`, actor: by.id }, async () => ({
        payload: { incidentId: a.id },
        build: async (): Promise<Built> => {
          const fresh = await this.#runner.get(INCIDENT, a.id);
          const cur = fresh?.body as unknown as IncidentBody | undefined;
          if (fresh === undefined || cur === undefined || cur.state !== "open" || cur.escalatedAt !== undefined) throw new DomainError("stale_revision", "already handled");
          const next: IncidentBody = { ...cur, escalatedAt: this.#runner.now(), escalatedTo: esc.to };
          return { ref: { kind: INCIDENT, id: a.id }, creates: false, changes: [{ type: "update", ref: { kind: INCIDENT, id: a.id }, expectedRevision: fresh.revision, body: next as unknown as JsonObject }], detail: { to: esc.to } };
        },
      })).catch((error: unknown) => { if (error instanceof DomainError && error.code === "stale_revision") return undefined; throw error; });
      if (result !== undefined && !result.replayed) { const again = await this.#runner.get(INCIDENT, a.id); if (again !== undefined) out.push(view<IncidentBody>(again)); }
    }
    return out;
  }

  /** Escalated incidents of a project whose notice has not been recorded as sent, oldest escalation first. Owner, service, or `responsibility.write`. */
  async untold(by: Principal, projectId: string): Promise<View<IncidentBody>[]> {
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "read incidents of that project");
    return (await scanAll(this.#runner, INCIDENT, 50_000, (x) => { const b = x.body as unknown as IncidentBody; return b.projectId === projectId && b.state === "open" && b.escalatedAt !== undefined && b.notifiedAt === undefined; }))
      .map((a) => view<IncidentBody>(a)).sort((a, b) => ((a.escalatedAt ?? "") < (b.escalatedAt ?? "") ? -1 : 1));
  }

  /** Records that an escalation's notice was sent (once; repeating changes nothing). */
  async markNotified(by: Principal, incidentId: string): Promise<void> {
    if (!(by.kind === "owner" || by.kind === "service")) throw hidden(by, "record notices");
    await this.#runner.command("responsibility.incident.notified", { commandId: `rinn-${incidentId}`, actor: by.id }, async () => ({
      payload: { incidentId },
      build: async (): Promise<Built> => {
        const found = await this.#runner.get(INCIDENT, incidentId);
        const b = found?.body as unknown as IncidentBody | undefined;
        if (found === undefined || b === undefined) throw new DomainError("not_found", "no such incident");
        const next: IncidentBody = { ...b, notifiedAt: this.#runner.now() };
        return { ref: { kind: INCIDENT, id: incidentId }, creates: false, changes: [{ type: "update", ref: { kind: INCIDENT, id: incidentId }, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: {} };
      },
    }));
  }

  /** The incidents of a project, open first then newest, optionally only the open ones. `undefined` for a project the caller may not read. */
  async list(by: Principal, projectId: string, filter: { open?: boolean } = {}): Promise<View<IncidentBody>[] | undefined> {
    if ((await this.#duties.list(by, projectId)) === undefined) return undefined;
    const found = await scanAll(this.#runner, INCIDENT, 50_000, (x) => { const b = x.body as unknown as IncidentBody; return b.projectId === projectId && (filter.open !== true || b.state === "open"); });
    return found.map((a) => view<IncidentBody>(a)).sort((a, b) => (a.state === b.state ? (a.lastAt < b.lastAt ? 1 : a.lastAt > b.lastAt ? -1 : 0) : a.state === "open" ? -1 : 1));
  }

  /** What the checks found, kept apart from what is wanted: `unknown` when there is no check or the last is older than twice the check period, never healthy by default. */
  async observed(by: Principal, responsibilityId: string): Promise<ResponsibilityObservedState | undefined> {
    const duty = await this.#duties.get(by, responsibilityId);
    const status = await this.#duties.status(by, responsibilityId);
    if (duty === undefined || status === undefined) return undefined;
    const open = (await this.list(by, duty.projectId, { open: true }))?.filter((i) => i.responsibilityId === duty.id) ?? [];
    const fresh = status.lastCheckAt !== undefined && (duty.everyMinutes === undefined || Date.parse(status.asOf) - Date.parse(status.lastCheckAt) <= 2 * duty.everyMinutes * 60_000);
    const last = status.lastCheckOutcome;
    const observed: ResponsibilityObservedState["observed"] = !fresh ? "unknown" : open.some((i) => i.worst === "failed") || last === "failed" ? "failed" : open.length > 0 || last === "attention" ? "attention" : last === "ok" ? "ok" : "unknown";
    return { responsibilityId: duty.id, intended: duty.desiredCondition, observed, ...(status.lastCheckAt === undefined ? {} : { lastCheckAt: status.lastCheckAt }), openIncidents: open.length };
  }

  #mayReport(by: Principal, body: ResponsibilityBody): boolean {
    return by.kind === "owner" || (body.ownerId !== undefined && by.id === body.ownerId && may(by, "responsibility.read", body.projectId)) || may(by, "responsibility.write", body.projectId);
  }
}
