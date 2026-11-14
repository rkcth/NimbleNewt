import { createHash, randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { SIGNING_SECRET_NAME } from "./signing.js";
import { TARGET_KINDS, offsiteLocationProblem, type TargetKind } from "./targets.js";

const CONFIG = { kind: "backup-config", id: "main" } as const;
const STATE = { kind: "backup-state", id: "main" } as const;

/** One extra place the backups are copied to (card K01c). A secret is never in it: an off-machine target names a stored credential. */
export interface TargetRecord {
  readonly id: string;
  readonly name: string;
  readonly kind: TargetKind;
  /** An absolute folder (folder, disk) or an https address (offsite). */
  readonly location: string;
  /** The name of the stored credential (the secret store), for an off-machine target. */
  readonly credential?: string;
  /** This target keeps a backup for at most this many days (otherwise the installation's age limit). */
  readonly keepDays?: number | null;
  /** This target's own counts (otherwise the installation's). */
  readonly daily?: number | null;
  readonly weekly?: number | null;
  readonly addedAt: string;
  readonly addedBy: string;
}

export interface ConfigBody {
  /** How often the scheduled run makes a backup (hours). Default 24. */
  readonly everyHours: number;
  /** For a schedule of a day or more: the hour (UTC, 0 to 23) the run is made in; null: whenever one is due. */
  readonly hourUtc: number | null;
  /** How often a backup is test-restored (days); null: never. Default 7. */
  readonly verifyEveryDays: number | null;
  readonly targets: readonly TargetRecord[];
  readonly changedAt: string;
  readonly changedBy: string;
}

export const CONFIG_DEFAULTS = { everyHours: 24, hourUtc: null, verifyEveryDays: 7 } as const;
export const MAX_TARGETS = 8;

export interface ConfigChange { readonly what: "schedule" | "verify" | "target-added" | "target-removed"; readonly by: string; readonly text: string }

/** The purge of named backups: what was asked, and per target and name what is done. `pending` stays on the list and is retried until it is removed or the target is taken away. */
export type PurgeResult = "removed" | "absent" | "pending";
export interface PurgeRecord {
  readonly id: string;
  readonly by: string;
  readonly at: string;
  readonly names: readonly string[];
  /** Target id (or `primary`) to name to result. */
  readonly results: Readonly<Record<string, Readonly<Record<string, PurgeResult>>>>;
  readonly errors?: Readonly<Record<string, string>>;
  readonly lastTried?: string;
  readonly done: boolean;
}
export interface VerifiedMark { readonly target: string; readonly name: string; readonly at: string; readonly method: "checksums" | "restore"; readonly ok: boolean; readonly detail?: string }
export interface TargetState { readonly lastOkAt?: string; readonly lastError?: { readonly at: string; readonly message: string }; readonly lastTest?: { readonly at: string; readonly ok: boolean; readonly detail: string } }
export interface StateBody {
  readonly verified: readonly VerifiedMark[];
  readonly targets: Readonly<Record<string, TargetState>>;
  readonly purges: readonly PurgeRecord[];
  readonly lastTestRestore?: { readonly at: string; readonly ok: boolean; readonly name: string; readonly target: string; readonly method: string; readonly detail: string };
}
export const EMPTY_STATE: StateBody = { verified: [], targets: {}, purges: [] };
const MAX_MARKS = 60;
const MAX_PURGES = 40;

const NAME = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/;
const CREDENTIAL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const invalid = (field: string, why: string): never => { throw new DomainError("invalid_command", `${field}: ${why}`, { field }); };
const whole = (v: unknown, field: string, min: number, max: number): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid(field, `must be a whole number from ${min} to ${max}`));

/**
 * The owner's configuration of the backup system (card K01c): the schedule, how often a backup is test-restored and the targets, and the controller's own record of what happened to them (the state). Every change is
 * owner only, validated, revision-checked and recorded in the audit log; the controller's own updates to the state are recorded the same way. Nothing here touches a backup.
 */
export class BackupConfigService {
  readonly #runner: CommandRunner;
  readonly #hooks: ((change: ConfigChange) => Promise<void>)[] = [];
  #chain: Promise<unknown> = Promise.resolve();
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): BackupConfigService { return new BackupConfigService(new CommandRunner(storage, epoch, options)); }

  now(): string { return this.#runner.now(); }
  onChanged(hook: (change: ConfigChange) => Promise<void>): void { this.#hooks.push(hook); }

  async #config(): Promise<{ revision: number; body: ConfigBody } | undefined> {
    const f = await this.#runner.get(CONFIG.kind, CONFIG.id);
    return f === undefined ? undefined : { revision: f.revision, body: f.body as unknown as ConfigBody };
  }

  /** The configuration in force: the stored record over the defaults (no target, a daily schedule, a weekly test restore). */
  async effective(): Promise<ConfigBody> {
    const c = (await this.#config())?.body;
    return {
      everyHours: typeof c?.everyHours === "number" ? c.everyHours : CONFIG_DEFAULTS.everyHours,
      hourUtc: typeof c?.hourUtc === "number" ? c.hourUtc : null,
      verifyEveryDays: c === undefined ? CONFIG_DEFAULTS.verifyEveryDays : c.verifyEveryDays === null ? null : typeof c.verifyEveryDays === "number" ? c.verifyEveryDays : CONFIG_DEFAULTS.verifyEveryDays,
      targets: Array.isArray(c?.targets) ? c.targets : [],
      changedAt: c?.changedAt ?? "", changedBy: c?.changedBy ?? "",
    };
  }

  async get(by: Principal): Promise<{ revision: number } & ConfigBody> {
    this.#owner(by, "read the backup configuration");
    return { revision: (await this.#config())?.revision ?? 0, ...(await this.effective()) };
  }

  #owner(by: Principal, what: string): void { if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not ${what}`); }

  /** The controller's record of what happened (copies made, target problems, test restores, purges). */
  async state(): Promise<StateBody> {
    const f = await this.#runner.get(STATE.kind, STATE.id);
    const b = f?.body as Partial<StateBody> | undefined;
    return { verified: b?.verified ?? [], targets: b?.targets ?? {}, purges: b?.purges ?? [], ...(b?.lastTestRestore === undefined ? {} : { lastTestRestore: b.lastTestRestore }) };
  }

  /** The controller's update of its own record, one at a time. `change` gets the state and returns the new one (undefined: nothing to write). Recorded in the audit log as a controller command. */
  updateState(what: string, change: (s: StateBody) => StateBody | undefined): Promise<StateBody> {
    const run = this.#chain.then(async () => {
      // Another controller sharing the database may write the record between the read and the write: the change is made again on what is there then (a few times), never written over it.
      for (let attempt = 1; ; attempt++) {
        const found = await this.#runner.get(STATE.kind, STATE.id);
        const before = await this.state();
        const after = change(before);
        if (after === undefined) return before;
        const trimmed: StateBody = { ...after, verified: after.verified.slice(-MAX_MARKS), purges: trimPurges(after.purges) };
        try {
          await this.#runner.command(`backup.state.${what}`, { commandId: `bs:${what}:${Date.now().toString(36)}:${randomBytes(6).toString("hex")}`, actor: "controller" }, async () => ({
            payload: { what },
            build: async () => ({ ref: STATE, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: STATE, body: trimmed as unknown as JsonObject } : { type: "update" as const, ref: STATE, expectedRevision: found.revision, body: trimmed as unknown as JsonObject }], detail: { what } }),
          }));
          return trimmed;
        } catch (error) {
          if (attempt >= 5 || !(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict")) throw error;
        }
      }
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  /** Records the owner's purge of named backups (owner only, audit-logged) with what each target is to do. A repeat of the same command returns the record it made and changes nothing. */
  beginPurge(owner: Principal, command: NoActor & { names: readonly string[] }, plan: Readonly<Record<string, Readonly<Record<string, PurgeResult>>>>): Promise<{ record: PurgeRecord; replayed: boolean }> {
    this.#owner(owner, "purge backups");
    const id = `purge-${createHash("sha256").update(scopedCommandId(owner.id, command.commandId)).digest("hex").slice(0, 12)}`;
    const run = this.#chain.then(async () => {
      const record: PurgeRecord = { id, by: owner.id, at: this.#runner.now(), names: [...command.names], results: plan, done: false };
      const result = await this.#runner.command("backup.purge", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
        payload: { names: [...command.names] },
        build: async () => {
          const found = await this.#runner.get(STATE.kind, STATE.id);
          const before = await this.state();
          const body: StateBody = { ...before, purges: trimPurges([...before.purges, record]) };
          return { ref: STATE, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: STATE, body: body as unknown as JsonObject } : { type: "update" as const, ref: STATE, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { id, names: [...command.names], targets: Object.keys(plan) } };
        },
      }));
      const now = (await this.state()).purges.find((p) => p.id === id);
      return { record: now ?? record, replayed: result.replayed };
    });
    this.#chain = run.catch(() => undefined);
    return run;
  }

  async #write(owner: Principal, name: string, command: NoActor & { expectedRevision?: number }, payload: JsonObject, make: (current: ConfigBody) => { body: ConfigBody; detail: JsonObject }): Promise<{ revision: number; changed: boolean }> {
    if (command.expectedRevision !== undefined) whole(command.expectedRevision, "expectedRevision", 0, Number.MAX_SAFE_INTEGER);
    let changed = false;
    const result = await this.#runner.command(name, { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { ...payload, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#config();
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the backup configuration is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const { body, detail } = make(await this.effective());
        changed = true;
        return { ref: CONFIG, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: CONFIG, body: body as unknown as JsonObject } : { type: "update" as const, ref: CONFIG, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail };
      },
    }));
    return { revision: result.revision, changed };
  }

  async #announce(change: ConfigChange): Promise<void> { for (const h of this.#hooks) await h(change).catch(() => undefined); }

  /** The schedule and the test restore. Give any of `everyHours`, `hourUtc` (null: any hour), `verifyEveryDays` (null: no test restore). */
  async setSchedule(owner: Principal, command: NoActor & { everyHours?: unknown; hourUtc?: unknown; verifyEveryDays?: unknown; expectedRevision?: number }): Promise<{ revision: number; changed: boolean; text: string }> {
    this.#owner(owner, "change the backup schedule");
    const unknown = Object.keys(command).filter((k) => !["commandId", "everyHours", "hourUtc", "verifyEveryDays", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    if (command.everyHours === undefined && command.hourUtc === undefined && command.verifyEveryDays === undefined) invalid("everyHours", "give everyHours, hourUtc or verifyEveryDays");
    const every = command.everyHours === undefined ? undefined : whole(command.everyHours, "everyHours", 1, 720);
    const hour = command.hourUtc === undefined ? undefined : command.hourUtc === null ? null : whole(command.hourUtc, "hourUtc", 0, 23);
    const verify = command.verifyEveryDays === undefined ? undefined : command.verifyEveryDays === null ? null : whole(command.verifyEveryDays, "verifyEveryDays", 1, 365);
    let before: ConfigBody | undefined; let after: ConfigBody | undefined;
    const r = await this.#write(owner, "backup.config.schedule", command, { every: every ?? null, hour: hour === undefined ? "keep" : hour, verify: verify === undefined ? "keep" : verify }, (cur) => {
      const next: ConfigBody = { ...cur, everyHours: every ?? cur.everyHours, hourUtc: hour === undefined ? cur.hourUtc : hour, verifyEveryDays: verify === undefined ? cur.verifyEveryDays : verify, changedAt: this.#runner.now(), changedBy: owner.id };
      if (next.hourUtc !== null && next.everyHours < 24) invalid("hourUtc", "a fixed hour needs a schedule of a day or more (everyHours 24 or more)");
      if (next.everyHours === cur.everyHours && next.hourUtc === cur.hourUtc && next.verifyEveryDays === cur.verifyEveryDays) throw new DomainError("invalid_command", "that is how the backup schedule is set already");
      before = cur; after = next;
      return { body: next, detail: { everyHoursBefore: cur.everyHours, everyHoursAfter: next.everyHours, hourBefore: cur.hourUtc, hourAfter: next.hourUtc, verifyBefore: cur.verifyEveryDays, verifyAfter: next.verifyEveryDays } };
    });
    const now = await this.effective();
    const text = describeSchedule(now);
    if (r.changed && before !== undefined && after !== undefined) await this.#announce({ what: before.verifyEveryDays !== after.verifyEveryDays && before.everyHours === after.everyHours && before.hourUtc === after.hourUtc ? "verify" : "schedule", by: owner.id, text });
    return { revision: r.revision, changed: r.changed, text };
  }

  /** Adds a target. The caller has tested it already (the system does) and passes the result's text in `tested`, which is only said back. */
  async addTarget(owner: Principal, command: NoActor & { name?: unknown; kind?: unknown; location?: unknown; credential?: unknown; keepDays?: unknown; daily?: unknown; weekly?: unknown; expectedRevision?: number }): Promise<{ revision: number; target: TargetRecord; text: string }> {
    this.#owner(owner, "add a backup target");
    const unknown = Object.keys(command).filter((k) => !["commandId", "name", "kind", "location", "credential", "keepDays", "daily", "weekly", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const target = buildTarget(command, this.#runner.now(), owner.id, scopedCommandId(owner.id, command.commandId));
    let existing: readonly TargetRecord[] = [];
    const r = await this.#write(owner, "backup.target.add", command, { id: target.id, name: target.name, kind: target.kind, location: target.location, credential: target.credential ?? null, keepDays: target.keepDays ?? null, daily: target.daily ?? null, weekly: target.weekly ?? null }, (cur) => {
      existing = cur.targets;
      if (cur.targets.length >= MAX_TARGETS) throw new DomainError("invalid_transition", `at most ${MAX_TARGETS} backup targets: remove one first`);
      if (cur.targets.some((t) => t.name.toLowerCase() === target.name.toLowerCase())) throw new DomainError("invalid_transition", `a target named ${target.name} exists already`);
      if (cur.targets.some((t) => t.kind !== "offsite" && target.kind !== "offsite" && t.location === target.location)) throw new DomainError("invalid_transition", "a target at that location exists already");
      return { body: { ...cur, targets: [...cur.targets, target], changedAt: this.#runner.now(), changedBy: owner.id }, detail: { id: target.id, name: target.name, kind: target.kind } };
    });
    void existing;
    const text = `Backup target ${target.name} (${target.kind}) was added: every new backup is also copied to it${target.keepDays === undefined || target.keepDays === null ? "" : `, and kept there for at most ${target.keepDays} days`}.`;
    if (r.changed) await this.#announce({ what: "target-added", by: owner.id, text });
    return { revision: r.revision, target, text };
  }

  async removeTarget(owner: Principal, command: NoActor & { id?: unknown; expectedRevision?: number }): Promise<{ revision: number; text: string }> {
    this.#owner(owner, "remove a backup target");
    const unknown = Object.keys(command).filter((k) => !["commandId", "id", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    if (typeof command.id !== "string" || command.id === "") invalid("id", "give the target's ID or name");
    const key = String(command.id).toLowerCase();
    let gone: TargetRecord | undefined;
    const r = await this.#write(owner, "backup.target.remove", command, { id: String(command.id) }, (cur) => {
      gone = cur.targets.find((t) => t.id === command.id || t.name.toLowerCase() === key);
      if (gone === undefined) throw new DomainError("not_found", "no such backup target");
      return { body: { ...cur, targets: cur.targets.filter((t) => t !== gone), changedAt: this.#runner.now(), changedBy: owner.id }, detail: { id: gone.id, name: gone.name } };
    });
    const target = gone as TargetRecord | undefined;
    const text = `Backup target ${target?.name ?? String(command.id)} was removed: new backups are no longer copied to it. The copies already there were not deleted (delete them where they are, or purge them by name before removing the target).`;
    if (r.changed && target !== undefined) {
      await this.updateState("target-removed", (s) => { const { [target.id]: _dropped, ...rest } = s.targets; void _dropped; return { ...s, targets: rest, verified: s.verified.filter((v) => v.target !== target.id) }; }).catch(() => undefined);
      await this.#announce({ what: "target-removed", by: owner.id, text });
    }
    return { revision: r.revision, text };
  }
}

function trimPurges(all: readonly PurgeRecord[]): readonly PurgeRecord[] {
  if (all.length <= MAX_PURGES) return all;
  // Finished purges are the first to go: one that is still pending is never dropped.
  const out = [...all];
  for (let i = 0; out.length > MAX_PURGES && i < out.length;) { if (out[i]!.done) out.splice(i, 1); else i++; }
  return out;
}

export function buildTarget(c: { name?: unknown; kind?: unknown; location?: unknown; credential?: unknown; keepDays?: unknown; daily?: unknown; weekly?: unknown }, at: string, by: string, seed: string): TargetRecord {
  if (typeof c.name !== "string" || !NAME.test(c.name.trim())) invalid("name", "1 to 60 letters, digits, spaces, dots, dashes or underscores");
  const name = (c.name as string).trim();
  if (typeof c.kind !== "string" || !TARGET_KINDS.includes(c.kind as TargetKind)) invalid("kind", "must be folder, disk or offsite");
  const kind = c.kind as TargetKind;
  if (typeof c.location !== "string" || c.location.trim() === "" || c.location.length > 500 || /[\0\r\n]/.test(c.location)) invalid("location", "give the folder or address, at most 500 characters");
  const location = (c.location as string).trim();
  if (kind === "offsite") {
    const why = offsiteLocationProblem(location);
    if (why !== undefined) invalid("location", why);
  } else if (!isAbsolute(location)) invalid("location", "a folder target needs an absolute path");
  if (c.credential !== undefined && c.credential !== null) {
    if (kind !== "offsite") invalid("credential", "only an off-machine target uses a credential");
    if (typeof c.credential !== "string" || !CREDENTIAL.test(c.credential)) invalid("credential", "the name of a stored credential (letters, digits, dots, dashes, underscores): never the secret itself");
    // The backup-signing key stays on this machine (card K01b): it is never sent to a target as its credential.
    if (c.credential === SIGNING_SECRET_NAME) invalid("credential", "that is the backup-signing key, which never leaves this machine: name the credential of the off-machine store");
  }
  const days = (v: unknown, f: string, lo: number, hi: number): number | null | undefined => (v === undefined ? undefined : v === null ? null : whole(v, f, lo, hi));
  const keepDays = days(c.keepDays, "keepDays", 1, 3650); const daily = days(c.daily, "daily", 1, 365); const weekly = days(c.weekly, "weekly", 0, 520);
  const id = `t-${createHash("sha256").update(seed).digest("hex").slice(0, 8)}`;
  return { id, name, kind, location, ...(typeof c.credential === "string" ? { credential: c.credential } : {}), ...(keepDays === undefined ? {} : { keepDays }), ...(daily === undefined ? {} : { daily }), ...(weekly === undefined ? {} : { weekly }), addedAt: at, addedBy: by };
}

/** The schedule in plain words. */
export function describeSchedule(c: Pick<ConfigBody, "everyHours" | "hourUtc" | "verifyEveryDays">): string {
  const every = c.everyHours % 24 === 0 ? (c.everyHours === 24 ? "every day" : `every ${c.everyHours / 24} days`) : `every ${c.everyHours} hours`;
  return `Backups are made ${every}${c.hourUtc === null ? "" : ` at ${String(c.hourUtc).padStart(2, "0")}:00 UTC`}. ${c.verifyEveryDays === null ? "No backup is test-restored automatically (ask for a test restore when you want one)." : `A backup is test-restored about every ${c.verifyEveryDays} days to prove it can be used.`}`;
}
