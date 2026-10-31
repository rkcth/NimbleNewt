import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { readSecretFile, SecretFileRefused } from "./secret-file.js";
import { MAX_JSON_BYTES, UnlockFailed, keyringFingerprint, parseKeyring, unlockWithPasscode, unlockWithRecovery, type Keyring } from "./crypto.js";

export interface EncryptionOptions {
  /** The keyring (public key and wrapped copies of the private key) read from the host's keyring file. */
  readonly keyring: Keyring;
  /** Host files the proof reads. The secret is supplied out of band, by the owner on the host: it never goes through the chat or an API argument. */
  readonly passcodeFile?: string;
  readonly recoveryFile?: string;
  /** Where the keyring file is, so the status can warn about a recovery file kept beside it (best effort). */
  readonly keyringFile?: string;
  readonly now?: () => Date;
  /** Shortest time between two proofs (each passcode proof costs 128 MiB and a fraction of a second). Default 10 seconds. */
  readonly minIntervalMs?: number;
}

export type UnlockMethod = "passcode" | "recovery";
export interface EncryptionStatus {
  readonly enabled: true;
  readonly scope: "everything";
  readonly keyId: string;
  readonly createdAt: string;
  /** The SHA-256 of the backup public key: what the installation pins, and what the owner compares when the key is replaced (`backup.encryption.rekey`). */
  readonly fingerprint: string;
  /** Things the owner should fix, in plain words (a recovery file left beside the keyring). Never a secret. */
  readonly warnings: readonly string[];
  /** How many unlock methods the key has, by kind: counts only. */
  readonly unlockMethods: { readonly passcode: number; readonly recovery: number };
  readonly lastProof?: { readonly at: string; readonly method: UnlockMethod; readonly ok: boolean };
}

export class ProofRefused extends Error { constructor(readonly code: "rate_limited" | "not_supplied" | "unreadable" | "failed", message: string) { super(message); this.name = "ProofRefused"; } }

/** Reads the keyring file the host keeps: a regular file of at most 1 MiB holding the public keyring (no secret). Every failure is the same fixed message: no parser text, no path content. */
export async function readKeyringFile(path: string): Promise<Keyring> {
  try {
    const st = await stat(path);
    if (!st.isFile() || st.size > MAX_JSON_BYTES) throw new Error("size");
    return parseKeyring(JSON.parse(await readFile(path, "utf8")));
  } catch { throw new Error("the keyring file cannot be read or is not valid"); }
}

/**
 * Proof that an unlock method still works (card K01b), for the owner interface. The secret is read from a host file only for the moment of the proof, the unwrapped key is dropped as soon as it has been matched against the
 * keyring's public key, and nothing secret is returned, recorded or put in an error. Proofs are rate limited and one at a time, so a caller cannot use them to burn memory or guess a passcode quickly.
 */
export class BackupEncryption {
  readonly #o: EncryptionOptions;
  #last: { at: string; method: UnlockMethod; ok: boolean } | undefined;
  #lastAttemptMs = -Infinity;
  #running = false;
  constructor(options: EncryptionOptions) { this.#o = { ...options, keyring: parseKeyring(options.keyring) }; }

  get keyring(): Keyring { return this.#o.keyring; }
  #now(): Date { return (this.#o.now ?? (() => new Date()))(); }

  status(): EncryptionStatus {
    const k = this.#o.keyring;
    return { enabled: true, scope: "everything", keyId: k.keyId, createdAt: k.createdAt, fingerprint: keyringFingerprint(k), warnings: this.warnings(), unlockMethods: { passcode: k.wrappers.filter((w) => w.kind === "passcode").length, recovery: k.wrappers.filter((w) => w.kind === "recovery").length }, ...(this.#last === undefined ? {} : { lastProof: this.#last }) };
  }

  /**
   * The passcode and recovery files are meant to exist only for the moment of a proof: the owner puts one there, proves, and removes it. A recovery file kept in the folder of the keyring (the same host, the same backup
   * folder, the same disk) is no recovery at all: whoever can read the backups can read it. This is a best-effort check on the folder only; a recovery file elsewhere on the same machine is not detected.
   */
  warnings(): string[] {
    const out: string[] = [];
    const rec = this.#o.recoveryFile; const ring = this.#o.keyringFile;
    if (rec !== undefined && ring !== undefined && dirname(resolve(rec)) === dirname(resolve(ring))) out.push("the recovery file is in the same folder as the keyring: keep it off this machine and give the controller a copy only for the moment of a proof");
    else if (rec !== undefined && existsSync(rec)) out.push("a recovery file is on this host right now: it should exist only while a proof runs, and be kept off this machine otherwise");
    return out;
  }

  async verify(method: UnlockMethod): Promise<{ ok: true; method: UnlockMethod; at: string }> {
    if (method !== "passcode" && method !== "recovery") throw new ProofRefused("failed", "the method is passcode or recovery");
    const file = method === "passcode" ? this.#o.passcodeFile : this.#o.recoveryFile;
    if (file === undefined) throw new ProofRefused("not_supplied", `no ${method} file is set on the host`);
    const now = this.#now();
    if (this.#running || now.getTime() - this.#lastAttemptMs < (this.#o.minIntervalMs ?? 10_000)) throw new ProofRefused("rate_limited", "a proof was just tried: wait a few seconds");
    this.#running = true;
    try {
      this.#lastAttemptMs = now.getTime();
      let secret: string;
      try { secret = await readSecretFile(file); } catch (error) { throw new ProofRefused("unreadable", error instanceof SecretFileRefused ? error.message : "the file cannot be read"); }
      try {
        if (method === "passcode") await unlockWithPasscode(this.#o.keyring, secret);
        else unlockWithRecovery(this.#o.keyring, JSON.parse(secret));
      } catch (error) {
        this.#last = { at: now.toISOString(), method, ok: false };
        throw new ProofRefused("failed", error instanceof UnlockFailed ? error.message : "could not unlock with that file");
      }
      this.#last = { at: now.toISOString(), method, ok: true };
      return { ok: true, method, at: now.toISOString() };
    } finally { this.#running = false; }
  }
}
