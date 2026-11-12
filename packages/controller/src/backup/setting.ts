import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "backup-encryption-setting", id: "main" } as const;

export type EncryptionScope = "everything" | "secrets";
export const ENCRYPTION_SCOPES: readonly EncryptionScope[] = ["everything", "secrets"];

export interface EncryptionSettingBody {
  /** Whether new backups are encrypted (the keyring is still there; switching on again needs no new key). Absent record: on. */
  readonly enabled: boolean;
  /** `everything`: every file of a backup is sealed. `secrets`: only secret values are sealed (card K01b: the rest of the backup stays plaintext). No secret values are in a backup yet, so nothing is sealed under it. */
  readonly scope: EncryptionScope;
  readonly changedAt: string;
  readonly changedBy: string;
}

export interface EncryptionChange {
  readonly before: { readonly enabled: boolean; readonly scope: EncryptionScope };
  readonly after: { readonly enabled: boolean; readonly scope: EncryptionScope };
  /** The change makes later backups less protected (switched off, or the scope narrowed). */
  readonly weaker: boolean;
}

const DEFAULT: Pick<EncryptionSettingBody, "enabled" | "scope"> = { enabled: true, scope: "everything" };

/** How much of a backup the setting protects: nothing (off), secrets only, everything. A change is weaker when this goes down. */
const protection = (s: Pick<EncryptionSettingBody, "enabled" | "scope">): number => (!s.enabled ? 0 : s.scope === "secrets" ? 1 : 2);

/** Whether later backups are sealed under this setting (the keyring being configured is a separate condition). */
/** Whether a new backup is sealed at all: any scope seals something (the secret values at least). */
export const sealsBackups = (s: Pick<EncryptionSettingBody, "enabled" | "scope">): boolean => s.enabled;

/**
 * The owner's setting for backup encryption (card K01b3): switch it off or on, and choose the scope. Owner only, revision-checked, recorded in the audit log, and announced (the hooks tell the owner through U11, so a
 * change made by someone holding the owner's token is seen). Nothing here touches the key or old backups: they stay readable with the passcode or recovery file. A pinned installation whose configuration drops the
 * keyring is refused at start unless this setting says off (see the controller's start), so removing the option is no way around it.
 */
export class BackupEncryptionSettingService {
  readonly #runner: CommandRunner;
  readonly #hooks: ((change: EncryptionChange, by: string) => Promise<void>)[] = [];
  /** Whether this installation has a backup keyring configured: without one no backup can be sealed, so switching encryption on is refused (it would say backups are sealed while they are plain, and the next start would refuse to run). */
  readonly #keyringConfigured: boolean;
  /** Whether backups carry the secret values (the host gave a secret store and the names): what "secrets only" then seals. */
  readonly #carriesSecrets: boolean;
  /** Turning encryption back on needs a fresh proof that the recovery file opens the key (card K01b: as at setup). Returns the reason it is not yet proved, or undefined. */
  readonly #enableProof: (() => string | undefined) | undefined;
  private constructor(runner: CommandRunner, keyringConfigured: boolean, carriesSecrets: boolean, enableProof: (() => string | undefined) | undefined) { this.#runner = runner; this.#keyringConfigured = keyringConfigured; this.#carriesSecrets = carriesSecrets; this.#enableProof = enableProof; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { keyringConfigured?: boolean; carriesSecrets?: boolean; enableProof?: () => string | undefined } = {}): BackupEncryptionSettingService { const { keyringConfigured, carriesSecrets, enableProof, ...runnerOptions } = options; return new BackupEncryptionSettingService(new CommandRunner(storage, epoch, runnerOptions), keyringConfigured ?? true, carriesSecrets ?? false, enableProof); }
  /** The setting in plain words, as this installation applies it. */
  text(s: Pick<EncryptionSettingBody, "enabled" | "scope">): string { return describeSetting(s, this.#keyringConfigured, this.#carriesSecrets); }

  onChanged(hook: (change: EncryptionChange, by: string) => Promise<void>): void { this.#hooks.push(hook); }

  async #current(): Promise<{ revision: number; body: EncryptionSettingBody } | undefined> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as EncryptionSettingBody };
  }

  /** Controller side: what the writer and the start check use. A record that cannot be read leaves encryption ON (never plain by accident). */
  async effective(): Promise<Pick<EncryptionSettingBody, "enabled" | "scope">> {
    const c = await this.#current();
    if (c === undefined) return DEFAULT;
    const b = c.body;
    return { enabled: b.enabled !== false, scope: ENCRYPTION_SCOPES.includes(b.scope) ? b.scope : "everything" };
  }

  async get(by: Principal): Promise<{ revision: number; enabled: boolean; scope: EncryptionScope; changedAt?: string; changedBy?: string }> {
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not read the backup encryption setting`);
    const c = await this.#current();
    const e = await this.effective();
    return { revision: c?.revision ?? 0, ...e, ...(c === undefined ? {} : { changedAt: c.body.changedAt, changedBy: c.body.changedBy }) };
  }

  async set(owner: Principal, command: NoActor & { enabled?: unknown; scope?: unknown; expectedRevision?: number }): Promise<{ revision: number; enabled: boolean; scope: EncryptionScope; weaker: boolean; changed: boolean; text: string }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not change backup encryption`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enabled", "scope", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.enabled === undefined && command.scope === undefined) throw new DomainError("invalid_command", "give enabled (true or false) or scope (everything or secrets)");
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: must be true or false", { field: "enabled" });
    if (command.scope !== undefined && !ENCRYPTION_SCOPES.includes(command.scope as EncryptionScope)) throw new DomainError("invalid_command", "scope: must be everything or secrets", { field: "scope" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    let change: EncryptionChange | undefined;
    const result = await this.#runner.command("backup.encryption.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled: (command.enabled as boolean | undefined) ?? null, scope: (command.scope as string | undefined) ?? null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#current();
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the backup encryption setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = await this.effective();
        const after = { enabled: (command.enabled as boolean | undefined) ?? before.enabled, scope: (command.scope as EncryptionScope | undefined) ?? before.scope };
        if (after.enabled === before.enabled && after.scope === before.scope) throw new DomainError("invalid_command", "that is how backup encryption is set already");
        if (!this.#keyringConfigured && after.enabled && !before.enabled) throw new DomainError("invalid_transition", "no backup keyring is configured on this installation, so no backup can be encrypted: set one up on the host first (backup encryption-setup and the keyring option), then switch encryption on");
        if (after.enabled && !before.enabled && this.#enableProof !== undefined) { const why = this.#enableProof(); if (why !== undefined) throw new DomainError("invalid_transition", why); }
        change = { before, after, weaker: protection(after) < protection(before) };
        const body: EncryptionSettingBody = { ...after, changedAt: this.#runner.now(), changedBy: owner.id };
        return { ref: REF, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: REF, body: body as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { enabledBefore: before.enabled, enabledAfter: after.enabled, scopeBefore: before.scope, scopeAfter: after.scope, weaker: change.weaker } };
      },
    }));
    const now = await this.effective();
    // A replay of an earlier command has no change of its own and announces nothing again.
    if (change !== undefined) for (const hook of this.#hooks) await hook(change, owner.id).catch(() => undefined);
    return { revision: result.revision, ...now, weaker: change?.weaker ?? false, changed: change !== undefined, text: describeSetting(now, this.#keyringConfigured, this.#carriesSecrets) };
  }
}

/** The plain-words account of a setting, said back to the owner. */
export function describeSetting(s: Pick<EncryptionSettingBody, "enabled" | "scope">, keyringConfigured = true, carriesSecrets = false): string {
  if (!keyringConfigured) return `No backup keyring is configured on this installation, so new backups are written in plain whatever this setting says (it says ${s.enabled ? `on, for ${s.scope}` : "off"}). Encryption is set up on the host with backup encryption-setup and the keyring option.`;
  if (!s.enabled) return "Backup encryption is OFF: new backups are written in plain. Backups already made stay encrypted and open with the passcode or recovery file.";
  if (s.scope === "secrets") return carriesSecrets ? "Backup encryption is on for secrets only: the secret values in a new backup are sealed under the backup key (the passcode or the recovery file opens them); the rest of the backup stays plain. If every unlock method is lost, the secrets are lost and the rest still restores." : "Backup encryption is on for secrets only, but this installation has no secret store set up for backups, so no secret values are carried: a new backup has nothing sealed and the rest is plain. Older encrypted backups open as before.";
  return carriesSecrets ? "Backup encryption is on for everything: every file of a new backup is sealed, the secret values included. If every unlock method is lost, the backups cannot be read by anyone." : "Backup encryption is on for everything: every file of a new backup is sealed. If every unlock method is lost, the backups cannot be read by anyone.";
}
