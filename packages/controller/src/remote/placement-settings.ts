import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { PlacementPolicy } from "./service.js";

const REF = { kind: "placement-settings", id: "main" } as const;
const HOST = /^host:[A-Za-z0-9._-]{1,64}$/;
const MAX_HOSTS = 200;

export interface PlacementSettingsBody {
  /** Hosts that may hold local-only data although the profile would not allow them (the strict profile allows none but these). */
  readonly allow: readonly string[];
  /** Hosts that may not hold local-only data although the profile would allow them. */
  readonly exclude: readonly string[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** The hosts that may hold local-only data (card H07c). Strict: only the hosts the owner listed. The derived and autonomous profiles: every enrolled, active host of the owner except the ones the owner excluded. Pure. */
export function dataHostsFor(profile: string, settings: Pick<PlacementSettingsBody, "allow" | "exclude"> | undefined, enrolled: readonly string[]): string[] {
  const allow = settings?.allow ?? [];
  const exclude = new Set(settings?.exclude ?? []);
  if (profile === "derived" || profile === "autonomous") return [...new Set([...enrolled, ...allow])].filter((h) => !exclude.has(h)).sort();
  return [...new Set(allow)].filter((h) => !exclude.has(h)).sort();
}

/**
 * Where local-only data may go, as the owner has set it (card H07c, owner decision 2026-10-27): the approval profile gives the default and the owner changes it for particular hosts. The setting is the owner's
 * (through the state API or, as a proposal first, the chat); nothing else writes it. `policy` makes the placement policy the remote service consults at every placement, so a change counts from the next one.
 */
export class PlacementSettingsService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  /** The approval profile is read from the installation's policy record; if it cannot be read, strict is used. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): PlacementSettingsService {
    return new PlacementSettingsService(new CommandRunner(storage, epoch, options));
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly allow: readonly string[]; readonly exclude: readonly string[]; readonly profile: string; readonly dataHosts: readonly string[] }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read where local-only data may go`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as PlacementSettingsBody | undefined;
    const profile = await this.#profile();
    return { revision: found?.revision ?? 0, allow: body?.allow ?? [], exclude: body?.exclude ?? [], profile, dataHosts: dataHostsFor(profile, body, await this.#enrolled()) };
  }

  /** The owner names the hosts to allow and to exclude (each list replaces the earlier one; omit one to keep it). */
  async set(owner: Principal, command: NoActor & { allow?: readonly string[]; exclude?: readonly string[]; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change where local-only data may go`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "allow", "exclude", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const list = (value: unknown, field: string): string[] | undefined => {
      if (value === undefined) return undefined;
      if (!Array.isArray(value) || value.length > MAX_HOSTS) throw new DomainError("invalid_command", `${field}: must be a list of at most ${MAX_HOSTS} hosts`, { field });
      for (const h of value) if (typeof h !== "string" || !HOST.test(h)) throw new DomainError("invalid_command", `${field}: ${String(h)} is not a host (host:name)`, { field });
      return [...new Set(value as string[])].sort();
    };
    const allow = list(command.allow, "allow"), exclude = list(command.exclude, "exclude");
    if (allow === undefined && exclude === undefined) throw new DomainError("invalid_command", "allow: name the hosts to allow or to exclude", { field: "allow" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("placement.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { allow: allow ?? null, exclude: exclude ?? null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        const before = current?.body as unknown as PlacementSettingsBody | undefined;
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the placement setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next: PlacementSettingsBody = { allow: allow ?? before?.allow ?? [], exclude: exclude ?? before?.exclude ?? [], updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { allow: next.allow.length, exclude: next.exclude.length } };
      },
    }));
    return { revision: result.revision };
  }

  /**
   * The owner adds hosts to or removes them from the lists, leaving the rest as it is (card H07c). This is what the chat proposes, so a proposal that waits while the setting changes still does only what it says.
   * Allowing a host takes it out of the excluded list and excluding it takes it out of the allowed list.
   */
  async change(owner: Principal, command: NoActor & { allowAdd?: readonly string[]; allowRemove?: readonly string[]; excludeAdd?: readonly string[]; excludeRemove?: readonly string[] }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change where local-only data may go`);
    const fields = ["allowAdd", "allowRemove", "excludeAdd", "excludeRemove"] as const;
    const unknown = Object.keys(command).filter((k) => k !== "commandId" && !(fields as readonly string[]).includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const lists: Record<string, string[]> = {};
    for (const f of fields) {
      const value = command[f];
      if (value === undefined) { lists[f] = []; continue; }
      if (!Array.isArray(value) || value.length > MAX_HOSTS) throw new DomainError("invalid_command", `${f}: must be a list of at most ${MAX_HOSTS} hosts`, { field: f });
      for (const h of value) if (typeof h !== "string" || !HOST.test(h)) throw new DomainError("invalid_command", `${f}: ${String(h)} is not a host (host:name)`, { field: f });
      lists[f] = [...new Set(value as string[])];
    }
    if (fields.every((f) => lists[f]!.length === 0)) throw new DomainError("invalid_command", "allowAdd: name at least one host to allow, exclude or take off a list", { field: "allowAdd" });
    const result = await this.#runner.command("placement.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { lists: lists as unknown as JsonObject },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        const before = current?.body as unknown as PlacementSettingsBody | undefined;
        const allow = new Set(before?.allow ?? []), exclude = new Set(before?.exclude ?? []);
        for (const h of lists["allowRemove"]!) allow.delete(h);
        for (const h of lists["excludeRemove"]!) exclude.delete(h);
        for (const h of lists["allowAdd"]!) { allow.add(h); exclude.delete(h); }
        for (const h of lists["excludeAdd"]!) { exclude.add(h); allow.delete(h); }
        if (allow.size > MAX_HOSTS || exclude.size > MAX_HOSTS) throw new DomainError("invalid_command", `at most ${MAX_HOSTS} hosts may be on each list`, { field: "allowAdd" });
        const next: PlacementSettingsBody = { allow: [...allow].sort(), exclude: [...exclude].sort(), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { allow: next.allow.length, exclude: next.exclude.length } };
      },
    }));
    return { revision: result.revision };
  }

  /** The placement policy for the remote service: who may hold local-only data now. Credentials and repositories are not restricted by this setting. */
  policy(): () => Promise<PlacementPolicy> {
    return async () => {
      const body = (await this.#runner.get(REF.kind, REF.id))?.body as unknown as PlacementSettingsBody | undefined;
      return { dataHosts: dataHostsFor(await this.#profile(), body, await this.#enrolled()) };
    };
  }

  async #profile(): Promise<string> {
    try { return ((await this.#runner.get("approval-policy", "installation"))?.body as unknown as { profile?: string } | undefined)?.profile ?? "strict"; } catch { return "strict"; }
  }

  async #enrolled(): Promise<string[]> {
    const out: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("principal", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const p of page) { after = p.id; const b = p.body as unknown as PrincipalBody; if (b.kind === "host" && b.state === "active") out.push(p.id); }
      if (page.length < 200) return out;
    }
  }
}
