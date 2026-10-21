import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DeskRecordBody } from "./desks.js";

/** The installation's rule for the owner looking at agents' private scratch and drafts. Default `allowed`, as built provisionally in C01; recorded here so the owner can change it and so it is audited. */
export interface InspectionPolicyBody {
  readonly scratch: "allowed" | "denied";
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** One look at a record that is not published: who looked, at what, under which policy and why. Kept for good; the agent whose record it was can see it. */
export interface InspectionBody {
  readonly inspector: string;
  readonly via: "owner" | "recovery";
  readonly recordId: string;
  readonly recordOwner: string;
  readonly projectId: string;
  readonly reason: string;
  readonly policy: "allowed" | "denied" | "not-applicable";
  readonly at: string;
}

const POLICY: AggregateRef = { kind: "inspection-policy", id: "installation" };
const RECORD_ID = /^dsk-[a-z2-7]{20}$/;
const INSPECTION_ID = /^ins-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const reasonOf = (v: unknown): string => {
  const out = text(v, "reason", { min: 1, max: 500 });
  if (redactText(out) !== out) invalid("reason", "looks like a credential or key; those are not recorded");
  return out;
};

/**
 * Looking at unpublished records (card A10). A desk record that is private scratch or a draft is not read through the ordinary read, not even by the owner; two audited paths exist:
 * - **Owner inspection** follows the installation's inspection policy and leaves an inspection record (who, which record, whose, why, when) that the record's agent can see.
 * - **The recovery service** is a `service` principal holding `recovery.read`. It reads the same records only to restore state, leaves the same record, and cannot be reached by an agent or a
 *   conversation: it is not a participant anyone can address, and the conversation API refuses its credential. An agent holding a token cannot become it.
 * Both paths return the record; neither changes it.
 */
export class InspectionService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): InspectionService {
    return new InspectionService(new CommandRunner(storage, epoch, options));
  }

  /** The owner sets the policy. Without `expectedRevision` it creates the policy; with it, it replaces it. */
  async setPolicy(owner: Principal, command: NoActor & { scratch: "allowed" | "denied"; expectedRevision?: number }): Promise<{ revision: number; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets the inspection policy`);
    onlyKnown(command, ["commandId", "scratch", "expectedRevision"]);
    const scratch = command.scratch === "allowed" || command.scratch === "denied" ? command.scratch : invalid("scratch", "must be allowed or denied");
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    const r = await this.#runner.command("inspection.policy", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scratch, expectedRevision: expected ?? null },
      build: async () => {
        const body: InspectionPolicyBody = { scratch, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const current = await this.#runner.get(POLICY.kind, POLICY.id);
        if (expected === undefined) {
          if (current !== undefined) throw new DomainError("stale_revision", "the inspection policy already exists; give expectedRevision to replace it");
          return { ref: POLICY, creates: true, changes: [{ type: "create", ref: POLICY, body: body as unknown as JsonObject }], detail: { scratch } };
        }
        if (current === undefined || current.revision !== expected) throw new DomainError("stale_revision", `the inspection policy is at revision ${current?.revision ?? 0}, not ${expected}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
        return { ref: POLICY, creates: false, changes: [{ type: "update", ref: POLICY, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { scratch } };
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** The policy in force (the default, `allowed`, when none was set). */
  async policy(): Promise<{ scratch: "allowed" | "denied"; revision: number }> {
    const found = await this.#runner.get(POLICY.kind, POLICY.id);
    return found === undefined ? { scratch: "allowed", revision: 0 } : { scratch: (found.body as unknown as InspectionPolicyBody).scratch, revision: found.revision };
  }

  /** The owner reads an unpublished record under the policy, with a reason. The look is recorded before the record is returned. */
  async inspect(owner: Principal, command: NoActor & { recordId: string; reason: string }): Promise<{ record?: View<DeskRecordBody>; inspectionId: string; replayed: boolean }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner inspects agents' private records`);
    return this.#look(owner, "owner", command);
  }

  /** The recovery service reads an unpublished record to restore state, with a reason. Needs a `service` principal holding `recovery.read`. */
  async recoveryRead(service: Principal, command: NoActor & { recordId: string; reason: string }): Promise<{ record?: View<DeskRecordBody>; inspectionId: string; replayed: boolean }> {
    if (service.kind !== "service" || !allowsExactly(service, "recovery.read", "*")) throw new DomainError("forbidden", `${service.id} is not the recovery service`);
    return this.#look(service, "recovery", command);
  }

  async #look(by: Principal, via: "owner" | "recovery", command: NoActor & { recordId: string; reason: string }): Promise<{ record?: View<DeskRecordBody>; inspectionId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "recordId", "reason"]);
    const recordId = typeof command.recordId === "string" && RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a desk record ID");
    const reason = reasonOf(command.reason);
    const id = derivedId("ins", scopedCommandId(by.id, command.commandId));
    let seen: View<DeskRecordBody> | undefined;
    const r = await this.#runner.command(via === "owner" ? "desk.inspect" : "desk.recovery-read", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { recordId, reason },
      build: async () => {
        const found = await this.#runner.get("desk-record", recordId);
        const record = found?.body as unknown as DeskRecordBody | undefined;
        if (found === undefined || record === undefined) throw new DomainError("not_found", "no such record");
        // Only what is not published is inspected this way; a published record is read in the ordinary way.
        if (record.visibility === "shared" && record.status !== "draft") throw new DomainError("invalid_command", "that record is published; read it in the ordinary way", { field: "recordId" });
        const policy = via === "owner" ? (await this.policy()).scratch : "not-applicable";
        if (policy === "denied") throw new DomainError("forbidden", "the installation's inspection policy does not allow the owner to read agents' private records");
        // The content returned is the content that was there when the look was recorded: read inside the same step as the record of the look, and guarded by the record's revision.
        seen = view<DeskRecordBody>(found);
        const ref: AggregateRef = { kind: "inspection", id };
        const body: InspectionBody = { inspector: by.id, via, recordId, recordOwner: record.owner, projectId: record.projectId, reason, policy, at: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "check", ref: { kind: "desk-record", id: recordId }, expectedRevision: found.revision }], detail: { recordId, recordOwner: record.owner, via, revision: found.revision } };
      },
    }));
    // A repeat of an earlier look returns the record of that look and no content: a second reading is a second look and needs its own command.
    return r.replayed ? { inspectionId: id, replayed: true } : { record: seen!, inspectionId: id, replayed: false };
  }

  /** The looks at an agent's own records (an agent sees them; the owner sees all, optionally of one agent). Oldest ID first, paged. */
  async inspections(by: Principal, query: { recordOwner?: string; afterId?: string; limit?: number } = {}): Promise<{ items: View<InspectionBody>[]; next?: string }> {
    const limit = query.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) invalid("limit", "must be a whole number from 1 to 200");
    if (query.afterId !== undefined && !INSPECTION_ID.test(query.afterId)) invalid("afterId", "is not an inspection ID");
    const items: View<InspectionBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("inspection", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as InspectionBody;
        if (by.kind !== "owner" && b.recordOwner !== by.id) continue;
        if (query.recordOwner !== undefined && b.recordOwner !== query.recordOwner) continue;
        items.push(view<InspectionBody>(a));
        if (items.length >= limit) return { items, next: a.id };
      }
      if (page.length < 200) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }
}
