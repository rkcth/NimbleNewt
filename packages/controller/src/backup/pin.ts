import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { keyringFingerprint, type Keyring } from "./crypto.js";

const REF = { kind: "backup-key-pin", id: "main" } as const;

export interface BackupKeyPinBody {
  /** The SHA-256 of the backup public key the installation first used (or last had approved). */
  readonly fingerprint: string;
  readonly keyId: string;
  readonly pinnedAt: string;
  /** A key the owner approved for the next start: it replaces the pin when a keyring with that fingerprint is loaded. */
  readonly approved?: { readonly fingerprint: string; readonly by: string; readonly at: string };
}

/** The keyring file names a different backup key than the one this installation pinned, and the owner has not approved the change. */
export class KeyPinMismatch extends Error {
  constructor(readonly pinned: string, readonly found: string) {
    super(`the backup key in the keyring file (fingerprint ${found}) is not the one this installation uses (fingerprint ${pinned}); backups are not made with an unapproved key. If you replaced the key on purpose, approve its fingerprint with backup.encryption.rekey while the controller runs with the old keyring, then restart with the new one.`);
    this.name = "KeyPinMismatch";
  }
}

/**
 * The backup public key is pinned (card K01b): the first time a keyring is loaded its fingerprint is recorded in the database, and a later start with a different public key (someone replaced the keyring file, so new backups would
 * be sealed for a key that is not the owner's) is refused until the owner has approved that fingerprint with `rekey`. The approval is made while the controller runs with the old keyring and is used once, at the next start.
 */
export class BackupKeyPinService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): BackupKeyPinService {
    return new BackupKeyPinService(new CommandRunner(storage, epoch, options));
  }

  /** At start: records the key the first time, accepts the key the owner approved, and refuses any other. */
  async check(keyring: Keyring): Promise<{ fingerprint: string; first: boolean; approved: boolean }> {
    const fingerprint = keyringFingerprint(keyring);
    const found = await this.#runner.get(REF.kind, REF.id);
    const now = this.#runner.now();
    if (found === undefined) {
      const body: BackupKeyPinBody = { fingerprint, keyId: keyring.keyId, pinnedAt: now };
      await this.#runner.command("backup.key.pin", { commandId: "backup-key-pin-first", actor: "controller" }, async () => ({
        payload: { fingerprint },
        build: async () => ({ ref: REF, creates: true, changes: [{ type: "create", ref: REF, body: body as unknown as JsonObject }], detail: { fingerprint } }),
      }));
      return { fingerprint, first: true, approved: false };
    }
    const pin = found.body as unknown as BackupKeyPinBody;
    if (pin.fingerprint === fingerprint) return { fingerprint, first: false, approved: false };
    if (pin.approved?.fingerprint !== fingerprint) throw new KeyPinMismatch(pin.fingerprint, fingerprint);
    const body: BackupKeyPinBody = { fingerprint, keyId: keyring.keyId, pinnedAt: now };
    await this.#runner.command("backup.key.repin", { commandId: `backup-key-repin-${fingerprint.slice(0, 16)}-${found.revision}`, actor: pin.approved.by }, async () => ({
      payload: { fingerprint, from: pin.fingerprint },
      build: async () => ({ ref: REF, creates: false, changes: [{ type: "update", ref: REF, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { fingerprint, from: pin.fingerprint, approvedBy: pin.approved!.by } }),
    }));
    return { fingerprint, first: false, approved: true };
  }

  /** What is pinned and what the owner approved for the next start (owner only, as the rest of the encryption status). */
  async get(by: Principal): Promise<{ readonly revision: number; readonly pinned?: { fingerprint: string; keyId: string; pinnedAt: string }; readonly approved?: { fingerprint: string; at: string } }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the backup key pin`);
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return { revision: 0 };
    const b = found.body as unknown as BackupKeyPinBody;
    return { revision: found.revision, pinned: { fingerprint: b.fingerprint, keyId: b.keyId, pinnedAt: b.pinnedAt }, ...(b.approved === undefined ? {} : { approved: { fingerprint: b.approved.fingerprint, at: b.approved.at } }) };
  }

  /** The owner approves a new backup key by its fingerprint (as `backup encryption-setup` printed it), or withdraws the approval with `null`. Owner only; takes effect at the next start. It never changes the pin itself. */
  async rekey(owner: Principal, command: NoActor & { fingerprint?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not approve a new backup key`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "fingerprint", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const fp = command.fingerprint;
    if (fp !== null && !(typeof fp === "string" && /^[0-9a-f]{64}$/.test(fp))) throw new DomainError("invalid_command", "fingerprint: must be the 64 hexadecimal characters `backup encryption-setup` printed, or null to withdraw an approval", { field: "fingerprint" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("backup.encryption.rekey", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { fingerprint: fp as string | null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (current === undefined) throw new DomainError("invalid_transition", "no backup key is pinned yet: start the controller with its keyring first");
        if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the backup key pin is at revision ${current.revision}, not ${command.expectedRevision}`, { currentRevision: current.revision });
        const pin = current.body as unknown as BackupKeyPinBody;
        if (fp === pin.fingerprint) throw new DomainError("invalid_command", "that is the key already in use", { field: "fingerprint" });
        const { approved: _old, ...rest } = pin; void _old;
        const body: BackupKeyPinBody = fp === null ? rest : { ...rest, approved: { fingerprint: fp as string, by: owner.id, at: this.#runner.now() } };
        return { ref: REF, creates: false, changes: [{ type: "update" as const, ref: REF, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { approved: fp as string | null } };
      },
    }));
    return { revision: result.revision };
  }
}
