import { open } from "node:fs/promises";
import { UnlockFailed, parseKeyring, unlockWithPasscode, unlockWithRecovery, type Keyring } from "./crypto.js";

export interface EncryptionOptions {
  /** The keyring (public key and wrapped copies of the private key) read from the host's keyring file. */
  readonly keyring: Keyring;
  /** Host files the proof reads. The secret is supplied out of band, by the owner on the host: it never goes through the chat or an API argument. */
  readonly passcodeFile?: string;
  readonly recoveryFile?: string;
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
  /** How many unlock methods the key has, by kind: counts only. */
  readonly unlockMethods: { readonly passcode: number; readonly recovery: number };
  readonly lastProof?: { readonly at: string; readonly method: UnlockMethod; readonly ok: boolean };
}

export class ProofRefused extends Error { constructor(readonly code: "rate_limited" | "not_supplied" | "unreadable" | "failed", message: string) { super(message); this.name = "ProofRefused"; } }

/** Reads a small secret file written for the owner alone: a regular file, not readable by group or others, at most 4 KiB. The content is never put in an error. */
async function readSecretFile(path: string): Promise<string> {
  let h;
  try { h = await open(path, "r"); } catch { throw new ProofRefused("unreadable", "the file cannot be read"); }
  try {
    const st = await h.stat();
    if (!st.isFile()) throw new ProofRefused("unreadable", "the file is not a regular file");
    if (process.platform !== "win32" && (st.mode & 0o077) !== 0) throw new ProofRefused("unreadable", "the file can be read by others: set its mode to 600");
    if (st.size > 4096) throw new ProofRefused("unreadable", "the file is too large");
    return (await h.readFile("utf8")).replace(/\r?\n$/, "");
  } finally { await h.close(); }
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
    return { enabled: true, scope: "everything", keyId: k.keyId, createdAt: k.createdAt, unlockMethods: { passcode: k.wrappers.filter((w) => w.kind === "passcode").length, recovery: k.wrappers.filter((w) => w.kind === "recovery").length }, ...(this.#last === undefined ? {} : { lastProof: this.#last }) };
  }

  async verify(method: UnlockMethod): Promise<{ ok: true; method: UnlockMethod; at: string }> {
    if (method !== "passcode" && method !== "recovery") throw new ProofRefused("failed", "the method is passcode or recovery");
    const file = method === "passcode" ? this.#o.passcodeFile : this.#o.recoveryFile;
    if (file === undefined) throw new ProofRefused("not_supplied", `no ${method} file is set on the host`);
    const now = this.#now();
    if (this.#running || now.getTime() - this.#lastAttemptMs < (this.#o.minIntervalMs ?? 10_000)) throw new ProofRefused("rate_limited", "a proof was just tried: wait a few seconds");
    this.#running = true; this.#lastAttemptMs = now.getTime();
    try {
      const secret = await readSecretFile(file);
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
