import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign as edSign, verify as edVerify } from "node:crypto";
import { lstat, open } from "node:fs/promises";
import { join } from "node:path";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { canonicalJson } from "../storage/index.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { BackupManifest } from "./format.js";

/**
 * Backup signatures (card K01b3, from K01b). Every backup is signed with an Ed25519 key the server holds for unattended use: the private key lives in the host's secret store (card F09), never wrapped by a passcode and never
 * in the database or a backup. The signature file sits beside the manifest and signs the digest of the WHOLE manifest (which lists every file's digest, and for a sealed backup carries the keyed MAC), so a changed byte
 * anywhere breaks it. A restore checks the signature against public keys it already trusts (the owner's records, or a public key file the owner kept off the server), NEVER against the key the backup names for itself.
 */
export const SIGNATURE_FILE = "signature.json";
export const SIGNING_SECRET_NAME = "backup-signing-key";
const DOMAIN = "nimblenewt-backup-signature-v1\n";
const MAX_SIGNATURE_BYTES = 4096;

/** The plain statement every signature check carries: what a valid signature does and does not show. */
export const AUTHENTICITY_NOTE = "A valid signature shows the backup was made with the server's signing key. It is only as strong as the running server: a compromised server could sign a forged backup. For a stronger check, keep the manifest digest (or the signing public key) off the server.";

export interface SignatureRecord { readonly format: 1; readonly alg: "ed25519"; readonly keyId: string; readonly signature: string }

/** A public signing key the restore trusts. `keyId` is always derived from the key itself, never read from a file or a backup. */
export interface TrustedSigningKey { readonly keyId: string; readonly publicKey: string }
export interface SignatureTrust {
  readonly keys: readonly TrustedSigningKey[];
  /** From this time on every backup must be signed; an older unsigned one is allowed with a warning (it was made before signing was switched on). Absent: every backup must be signed. */
  readonly since?: string;
}

export type SignatureStatus = "valid" | "unsigned-before-signing" | "unchecked";
export interface SignatureCheck { readonly status: SignatureStatus; readonly keyId?: string; readonly text: string; readonly problems: readonly string[] }

/** The SHA-256 of a public key's DER form: the signing key's ID. */
export const signingKeyIdOf = (publicKeyDerBase64: string): string => createHash("sha256").update(Buffer.from(publicKeyDerBase64, "base64")).digest("hex");

export function trustedKeyOf(publicKeyDerBase64: string): TrustedSigningKey {
  let der: Buffer;
  try { der = Buffer.from(publicKeyDerBase64.trim(), "base64"); const key = createPublicKey({ key: der, format: "der", type: "spki" }); if (key.asymmetricKeyType !== "ed25519") throw new Error("type"); } catch { throw new DomainError("invalid_command", "that is not an Ed25519 public key (base64 of its SPKI form)"); }
  const publicKey = der.toString("base64");
  return { keyId: signingKeyIdOf(publicKey), publicKey };
}

/** The bytes that are signed: a fixed label (so a signature made for another purpose never fits) and the digest of the whole manifest. */
export const signedBytes = (manifest: BackupManifest): Buffer => Buffer.from(`${DOMAIN}${createHash("sha256").update(canonicalJson(manifest as never)).digest("hex")}`, "utf8");

export interface GeneratedSigningKey { readonly privateKey: string; readonly publicKey: string; readonly keyId: string }
/** A new signing key pair: the private key as base64 PKCS8 (for the secret store), the public key as base64 SPKI. */
export function generateSigningKey(): GeneratedSigningKey {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const pub = publicKey.export({ format: "der", type: "spki" }).toString("base64");
  return { privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"), publicKey: pub, keyId: signingKeyIdOf(pub) };
}

/** Signs a manifest with a private key (base64 PKCS8). The key is used for this call only. */
export function signManifest(manifest: BackupManifest, privateKeyBase64: string): SignatureRecord {
  const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
  const pub = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
  return { format: 1, alg: "ed25519", keyId: signingKeyIdOf(pub), signature: edSign(null, signedBytes(manifest), key).toString("base64") };
}

async function readSignatureFile(path: string): Promise<SignatureRecord | "missing" | "bad"> {
  const file = join(path, SIGNATURE_FILE);
  const info = await lstat(file).catch(() => undefined);
  if (info === undefined) return "missing";
  if (!info.isFile() || info.size > MAX_SIGNATURE_BYTES) return "bad";
  try {
    const handle = await open(file, "r");
    try {
      const text = (await handle.readFile("utf8"));
      const r = JSON.parse(text) as SignatureRecord;
      if (r === null || typeof r !== "object" || r.format !== 1 || r.alg !== "ed25519" || typeof r.keyId !== "string" || !/^[0-9a-f]{64}$/.test(r.keyId) || typeof r.signature !== "string" || r.signature.length > 200) return "bad";
      return r;
    } finally { await handle.close(); }
  } catch { return "bad"; }
}

/**
 * Checks a backup's signature against the keys the caller already trusts. With no trust given the signature is not checked and the result says so (a restore on a new machine from the backup alone still works; it says
 * plainly that authenticity was not checked). With trust given: a signature that is missing (and the backup is not older than the signing switch-on), made by a key not trusted, or that does not match is a problem.
 */
export async function checkSignature(path: string, manifest: BackupManifest, trust: SignatureTrust | undefined): Promise<SignatureCheck> {
  if (trust === undefined) return { status: "unchecked", text: `Its signature was not checked: no trusted signing public key was given. ${AUTHENTICITY_NOTE}`, problems: [] };
  const found = await readSignatureFile(path);
  if (found === "bad") return { status: "unchecked", text: "", problems: ["the signature file is not valid"] };
  if (found === "missing") {
    const made = Date.parse(manifest.createdAt);
    if (trust.since !== undefined && Number.isFinite(made) && made < Date.parse(trust.since)) return { status: "unsigned-before-signing", text: `This backup is not signed: it was made before backup signing was switched on (${trust.since}). Its time is as the backup states it${manifest.encryption === undefined ? " (a plain backup's time is not authenticated)" : ""}.`, problems: [] };
    return { status: "unchecked", text: "", problems: ["the backup is not signed, and backups on this installation are signed: it may not be one this server made"] };
  }
  const trusted = trust.keys.find((k) => k.keyId === found.keyId);
  if (trusted === undefined) return { status: "unchecked", text: "", problems: ["the backup is signed by a key you do not trust"] };
  let ok = false;
  try { ok = edVerify(null, signedBytes(manifest), createPublicKey({ key: Buffer.from(trusted.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(found.signature, "base64")); } catch { ok = false; }
  if (!ok) return { status: "unchecked", text: "", problems: ["the signature does not match the manifest: the backup was changed or forged"] };
  return { status: "valid", keyId: found.keyId, text: `Signature valid (signing key ${found.keyId.slice(0, 16)}). ${AUTHENTICITY_NOTE}`, problems: [] };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

/** The part of the host's secret store (F09) the signing key needs. */
export interface SigningSecretStore { resolve(name: string): Promise<string | undefined>; set(name: string, value: string): Promise<void> }

export interface SigningKeyEntry { readonly keyId: string; readonly publicKey: string; readonly generation: number; readonly createdAt: string; readonly retiredAt?: string }
export interface SigningRecord { readonly keys: readonly SigningKeyEntry[]; /** When signing was first switched on: backups made before it are allowed to be unsigned. */ readonly since: string }

const REF = { kind: "backup-signing", id: "main" } as const;

/** The signer a backup uses: signs a finished manifest and fails if the key cannot be read (a backup is never written unsigned on an installation that signs). */
export interface BackupSigner { sign(manifest: BackupManifest): Promise<SignatureRecord> }

/**
 * Owns the backup signing key (card K01b3): made once and kept in the secret store; its PUBLIC half is recorded in the database as the owner's record of every signing generation, so a restore on the running installation
 * trusts only those. Rotation (owner only, recorded) makes a new key and retires the old one's right to sign; the old public key stays trusted so older backups still verify. The private key is read for one signature and dropped.
 */
export class BackupSigningService implements BackupSigner {
  readonly #runner: CommandRunner;
  readonly #store: SigningSecretStore;
  readonly #name: string;
  readonly #rotationHooks: ((entry: SigningKeyEntry, by: string) => Promise<void>)[] = [];
  private constructor(runner: CommandRunner, store: SigningSecretStore, name: string) { this.#runner = runner; this.#store = store; this.#name = name; }

  static withEpoch(storage: ControllerStorage, epoch: number, store: SigningSecretStore, options: RunnerOptions & { secretName?: string } = {}): BackupSigningService {
    const { secretName, ...runnerOptions } = options;
    return new BackupSigningService(new CommandRunner(storage, epoch, runnerOptions), store, secretName ?? SIGNING_SECRET_NAME);
  }

  /** Called after a rotation is recorded (the owner is told, card U11). A failing hook never undoes the rotation. */
  onRotated(hook: (entry: SigningKeyEntry, by: string) => Promise<void>): void { this.#rotationHooks.push(hook); }

  async #record(): Promise<{ revision: number; body: SigningRecord } | undefined> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return found === undefined ? undefined : { revision: found.revision, body: found.body as unknown as SigningRecord };
  }

  /** The public half of the private key in the store (the key is parsed and dropped). */
  static publicOf(privateKeyBase64: string): { publicKey: string; keyId: string } {
    const key = createPrivateKey({ key: Buffer.from(privateKeyBase64, "base64"), format: "der", type: "pkcs8" });
    if (key.asymmetricKeyType !== "ed25519") throw new Error("type");
    const publicKey = createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
    return { publicKey, keyId: signingKeyIdOf(publicKey) };
  }

  /**
   * At start: makes the key the first time (private key into the store, public key into the record). A key in the store that the record does not list as current (the secret store was changed behind the controller's
   * back, or restored from another machine) is recorded as a new generation and said in the result, so the owner sees it; an unreadable store stops the start (backups would be unsigned).
   */
  async ensure(): Promise<{ keyId: string; first: boolean; changed: boolean }> {
    let secret: string | undefined;
    try { secret = await this.#store.resolve(this.#name); } catch { throw new Error("backups are set to be signed but the secret store cannot be read; no backup is made without its signature"); }
    const now = this.#runner.now();
    const current = await this.#record();
    let publicKey: string; let keyId: string; let fresh = false;
    if (secret === undefined) {
      const made = generateSigningKey();
      try { await this.#store.set(this.#name, made.privateKey); } catch { throw new Error("backups are set to be signed but the secret store cannot be written; no backup is made without its signature"); }
      ({ publicKey, keyId } = made); fresh = true;
    } else {
      try { ({ publicKey, keyId } = BackupSigningService.publicOf(secret)); } catch { throw new Error("the backup signing key in the secret store is not a valid Ed25519 key; no backup is made without its signature"); }
    }
    const live = current?.body.keys.find((k) => k.retiredAt === undefined);
    if (live?.keyId === keyId) return { keyId, first: false, changed: false };
    const known = current?.body.keys.find((k) => k.keyId === keyId);
    if (known !== undefined && known.retiredAt !== undefined) throw new Error("the signing key in the secret store is one that was retired by a rotation; replace it with the current key (or rotate again) before backups are made");
    const keys: SigningKeyEntry[] = [...(current?.body.keys ?? []).map((k) => (k.retiredAt === undefined ? { ...k, retiredAt: now } : k)), { keyId, publicKey, generation: (current?.body.keys.length ?? 0) + 1, createdAt: now }];
    await this.#write(current, { keys, since: current?.body.since ?? now }, "backup.signing.record", `backup-signing-ensure-${keyId.slice(0, 16)}`, "controller", { keyId });
    return { keyId, first: current === undefined, changed: current !== undefined };
  }

  async #write(current: { revision: number; body: SigningRecord } | undefined, body: SigningRecord, type: string, commandId: string, actor: string, detail: JsonObject): Promise<number> {
    const result = await this.#runner.command(type, { commandId, actor }, async () => ({
      payload: detail,
      build: async () => {
        const live = await this.#record();
        if ((live?.revision ?? 0) !== (current?.revision ?? 0)) throw new DomainError("stale_revision", "the signing record changed at the same moment", { currentRevision: live?.revision ?? 0 });
        return { ref: REF, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: REF, body: body as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail };
      },
    }));
    return result.revision;
  }

  /** Signs a manifest with the key in the secret store. Refuses when that key is not the current one in the record. */
  async sign(manifest: BackupManifest): Promise<SignatureRecord> {
    let secret: string | undefined;
    try { secret = await this.#store.resolve(this.#name); } catch { throw new Error("the backup signing key cannot be read from the secret store"); }
    if (secret === undefined) throw new Error("the backup signing key is missing from the secret store");
    const rec = await this.#record();
    const mine = BackupSigningService.publicOf(secret).keyId;
    if (rec?.body.keys.find((k) => k.retiredAt === undefined)?.keyId !== mine) throw new Error("the signing key in the secret store is not the current one in the owner's record");
    return signManifest(manifest, secret);
  }

  /** The keys a restore on this installation trusts (every generation, retired ones included), and when signing began. Controller-side: not an API read. */
  async trust(): Promise<SignatureTrust | undefined> {
    const rec = await this.#record();
    return rec === undefined ? undefined : { keys: rec.body.keys.map((k) => ({ keyId: k.keyId, publicKey: k.publicKey })), since: rec.body.since };
  }

  /** The owner reads the signing key generations and the public keys to keep off the server. Owner only. A private key is never in it. */
  async status(by: Principal): Promise<{ revision: number; since?: string; keys: readonly SigningKeyEntry[] }> {
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not read the backup signing keys`);
    const rec = await this.#record();
    return rec === undefined ? { revision: 0, keys: [] } : { revision: rec.revision, since: rec.body.since, keys: rec.body.keys };
  }

  /** Owner only: makes a new signing key (the old one stops signing and stays trusted for the backups it signed). Recorded; the owner is told by the hooks. */
  async rotate(owner: Principal, command: NoActor & { expectedRevision?: number }): Promise<{ revision: number; keyId: string; generation: number }> {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", `${owner.id} may not rotate the backup signing key`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const current = await this.#record();
    if (current === undefined) throw new DomainError("invalid_transition", "backup signing has not started yet");
    if (command.expectedRevision !== undefined && current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the signing record is at revision ${current.revision}, not ${command.expectedRevision}`, { currentRevision: current.revision });
    const made = generateSigningKey();
    const now = this.#runner.now();
    const entry: SigningKeyEntry = { keyId: made.keyId, publicKey: made.publicKey, generation: current.body.keys.length + 1, createdAt: now };
    // The new private key goes into the secret store first and the record second: until the record names it, `sign` refuses (the store's key is not the current one in the record), so nothing is ever signed with an unrecorded key.
    // If the record cannot be written, the next start's `ensure` finds the store's key and records it as the new generation.
    try { await this.#store.set(this.#name, made.privateKey); } catch { throw new DomainError("unavailable", "the new signing key could not be put in the secret store; nothing was changed"); }
    const revision = await this.#write(current, { keys: [...current.body.keys.map((k) => (k.retiredAt === undefined ? { ...k, retiredAt: now } : k)), entry], since: current.body.since }, "backup.signing.rotate", scopedCommandId(owner.id, command.commandId), owner.id, { keyId: made.keyId, generation: entry.generation });
    for (const hook of this.#rotationHooks) await hook(entry, owner.id).catch(() => undefined);
    return { revision, keyId: made.keyId, generation: entry.generation };
  }
}
