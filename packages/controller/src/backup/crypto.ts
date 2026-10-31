import { createCipheriv, createDecipheriv, createHash, createHmac, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes, scrypt, timingSafeEqual, type KeyObject } from "node:crypto";
import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";

/**
 * Encrypted backups (card K01b, first slice). A backup key pair (X25519) is made once. The server keeps the public key and the private key wrapped (AES-256-GCM) once per unlock method: a passcode (scrypt) and a recovery key
 * (256 random bits, handed to the owner as a file). The private key is never stored unwrapped. Each backup makes an ephemeral key pair, so a scheduled backup needs only the public key; the shared secret is the backup's file key
 * root. Files are sealed in 64 KiB AES-256-GCM chunks under a key derived per file (random salt), each chunk bound to its file label, its position and whether it is the last, so a swap, reorder, cut or tamper is detected.
 */
export const KEYRING_VERSION = 1;
export const CHUNK_BYTES = 64 * 1024;
const MAGIC = Buffer.from("NNEB1\0");
const TAG = 16;
const HEADER = MAGIC.length + 16;

/** scrypt parameters: stored with each wrapper so they can be raised later; a wrapper below the floor or above the ceiling is refused (a cheap wrapper is a downgrade, an enormous one is a way to exhaust memory). */
export interface ScryptParams { readonly N: number; readonly r: number; readonly p: number }
export const DEFAULT_SCRYPT: ScryptParams = { N: 2 ** 17, r: 8, p: 1 }; // 128 MiB
const FLOOR_N = 2 ** 16; // 64 MiB at r=8
const CEIL_N = 2 ** 20;
export const MIN_PASSCODE_CHARS = 12;
const MAX_PASSCODE_BYTES = 1024;

export class UnlockFailed extends Error { constructor(message = "could not unlock: the passcode or recovery file does not open this backup key") { super(message); this.name = "UnlockFailed"; } }
export class PasscodeRefused extends Error { constructor(message: string) { super(message); this.name = "PasscodeRefused"; } }
export class SealedFileBad extends Error { constructor(message: string) { super(message); this.name = "SealedFileBad"; } }

interface WrapperBase { readonly id: string; readonly nonce: string; readonly wrapped: string }
export interface PasscodeWrapper extends WrapperBase { readonly kind: "passcode"; readonly salt: string; readonly kdf: { readonly name: "scrypt" } & ScryptParams }
export interface RecoveryWrapper extends WrapperBase { readonly kind: "recovery" }
export type Wrapper = PasscodeWrapper | RecoveryWrapper;
/** The public part: nothing in it opens a backup without a passcode or the recovery key. */
export interface Keyring { readonly version: typeof KEYRING_VERSION; readonly keyId: string; readonly createdAt: string; readonly publicKey: string; readonly wrappers: readonly Wrapper[] }
/** The recovery file's content: the owner keeps it off the server. */
export interface RecoveryFile { readonly format: "nimblenewt-recovery"; readonly version: 1; readonly keyId: string; readonly recoveryKey: string }

const b64 = (b: Buffer | Uint8Array): string => Buffer.from(b).toString("base64url");
const unb64 = (s: unknown, what: string, size?: number): Buffer => {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]*$/.test(s) || s.length > 4096) throw new SealedFileBad(`${what} is not valid`);
  const b = Buffer.from(s, "base64url");
  if (size !== undefined && b.length !== size) throw new SealedFileBad(`${what} has the wrong size`);
  return b;
};
const hkdf = (key: Buffer, salt: Buffer, info: string, size = 32): Buffer => Buffer.from(hkdfSync("sha256", key, salt, info, size));
const kdf = (passcode: string, salt: Buffer, p: ScryptParams): Promise<Buffer> => new Promise((resolve, reject) => scrypt(Buffer.from(passcode, "utf8"), salt, 32, { N: p.N, r: p.r, p: p.p, maxmem: 256 * p.N * p.r + 64 * 1024 * 1024 }, (e, k) => e ? reject(e) : resolve(k)));
const checkParams = (p: ScryptParams): void => {
  if (!Number.isInteger(p.N) || p.N < FLOOR_N || p.N > CEIL_N || (p.N & (p.N - 1)) !== 0 || p.r !== 8 || p.p !== 1) throw new SealedFileBad("the key derivation settings are outside what this version accepts");
};

/** Minimum strength: at least 12 characters, not one repeated character, within a bound (no hints are kept). */
export function checkPasscode(passcode: string): void {
  if (typeof passcode !== "string" || [...passcode].length < MIN_PASSCODE_CHARS) throw new PasscodeRefused(`a passcode needs at least ${MIN_PASSCODE_CHARS} characters`);
  if (Buffer.byteLength(passcode, "utf8") > MAX_PASSCODE_BYTES) throw new PasscodeRefused("the passcode is too long");
  if (new Set([...passcode]).size < 5) throw new PasscodeRefused("the passcode uses too few different characters");
}

const aad = (keyId: string, wrapper: { id: string; kind: string }): Buffer => Buffer.from(`nn-backup-wrap:${keyId}:${wrapper.id}:${wrapper.kind}`);
function wrap(secret: Buffer, kek: Buffer, keyId: string, w: { id: string; kind: string }): { nonce: string; wrapped: string } {
  const nonce = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", kek, nonce); c.setAAD(aad(keyId, w));
  const ct = Buffer.concat([c.update(secret), c.final(), c.getAuthTag()]);
  return { nonce: b64(nonce), wrapped: b64(ct) };
}
function unwrap(w: Wrapper, kek: Buffer, keyId: string): Buffer {
  try {
    const ct = unb64(w.wrapped, "wrapped key"); const nonce = unb64(w.nonce, "nonce", 12);
    const d = createDecipheriv("aes-256-gcm", kek, nonce); d.setAAD(aad(keyId, w)); d.setAuthTag(ct.subarray(ct.length - TAG));
    return Buffer.concat([d.update(ct.subarray(0, ct.length - TAG)), d.final()]);
  } catch { throw new UnlockFailed(); }
}

async function passcodeWrapper(secret: Buffer, passcode: string, keyId: string, params: ScryptParams): Promise<PasscodeWrapper> {
  checkPasscode(passcode); checkParams(params);
  const salt = randomBytes(16); const id = b64(randomBytes(6));
  const kek = await kdf(passcode, salt, params);
  return { id, kind: "passcode", salt: b64(salt), kdf: { name: "scrypt", ...params }, ...wrap(secret, kek, keyId, { id, kind: "passcode" }) };
}
const recoveryKek = (recoveryKey: Buffer, keyId: string): Buffer => hkdf(recoveryKey, Buffer.from(keyId), "nn-backup-recovery-kek");

/** Makes a new backup key: the keyring (kept by the server) and the recovery file (given to the owner once, never logged). */
export async function createKeyring(options: { passcode: string; now?: () => Date; scrypt?: ScryptParams }): Promise<{ keyring: Keyring; recoveryFile: RecoveryFile }> {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  const secret = Buffer.from(privateKey.export({ type: "pkcs8", format: "der" }));
  const keyId = b64(randomBytes(12));
  const pass = await passcodeWrapper(secret, options.passcode, keyId, options.scrypt ?? DEFAULT_SCRYPT);
  const recoveryKey = randomBytes(32); const rid = b64(randomBytes(6));
  const rec: RecoveryWrapper = { id: rid, kind: "recovery", ...wrap(secret, recoveryKek(recoveryKey, keyId), keyId, { id: rid, kind: "recovery" }) };
  secret.fill(0);
  const keyring: Keyring = { version: KEYRING_VERSION, keyId, createdAt: (options.now ?? (() => new Date()))().toISOString(), publicKey: b64(publicKey.export({ type: "spki", format: "der" })), wrappers: [pass, rec] };
  return { keyring, recoveryFile: { format: "nimblenewt-recovery", version: 1, keyId, recoveryKey: b64(recoveryKey) } };
}

/** Reads a keyring from untrusted JSON (a manifest or the keyring file): the shape, sizes and settings are checked before anything is derived. */
export function parseKeyring(value: unknown): Keyring {
  const k = value as Keyring;
  if (k === null || typeof k !== "object" || k.version !== KEYRING_VERSION || typeof k.keyId !== "string" || k.keyId.length > 64 || typeof k.publicKey !== "string" || !Array.isArray(k.wrappers) || k.wrappers.length < 1 || k.wrappers.length > 16) throw new SealedFileBad("the key record is not valid");
  for (const w of k.wrappers) {
    if (w === null || typeof w !== "object" || typeof w.id !== "string" || (w.kind !== "passcode" && w.kind !== "recovery")) throw new SealedFileBad("a key wrapper is not valid");
    if (w.kind === "passcode") { if (w.kdf?.name !== "scrypt") throw new SealedFileBad("a key wrapper is not valid"); checkParams(w.kdf); unb64(w.salt, "salt", 16); }
    unb64(w.nonce, "nonce", 12); unb64(w.wrapped, "wrapped key");
  }
  createPublicKey({ key: unb64(k.publicKey, "public key"), format: "der", type: "spki" });
  return k;
}

function privateFrom(secret: Buffer, keyring: Keyring): KeyObject {
  try {
    const priv = createPrivateKey({ key: secret, format: "der", type: "pkcs8" });
    // The unwrapped key must be the one the keyring names: a wrapper made for another key (or swapped in) is not accepted.
    const pub = Buffer.from(createPublicKey(priv).export({ type: "spki", format: "der" }));
    const expect = unb64(keyring.publicKey, "public key");
    if (pub.length !== expect.length || !timingSafeEqual(pub, expect)) throw new UnlockFailed();
    return priv;
  } catch (e) { throw e instanceof UnlockFailed ? e : new UnlockFailed(); } finally { secret.fill(0); }
}

/** Opens the private key with a passcode (tries each passcode wrapper). Every failure is the same error: it does not say which part was wrong. */
export async function unlockWithPasscode(keyring: Keyring, passcode: string): Promise<BackupKey> {
  if (typeof passcode !== "string" || Buffer.byteLength(passcode, "utf8") > MAX_PASSCODE_BYTES) throw new UnlockFailed();
  for (const w of parseKeyring(keyring).wrappers) {
    if (w.kind !== "passcode") continue;
    const kek = await kdf(passcode, unb64(w.salt, "salt", 16), w.kdf);
    try { return new BackupKey(keyring, privateFrom(unwrap(w, kek, keyring.keyId), keyring)); } catch (e) { if (!(e instanceof UnlockFailed)) throw e; }
  }
  throw new UnlockFailed();
}
export function unlockWithRecovery(keyring: Keyring, file: unknown): BackupKey {
  const r = file as RecoveryFile;
  const k = parseKeyring(keyring);
  if (r === null || typeof r !== "object" || r.format !== "nimblenewt-recovery" || r.keyId !== k.keyId) throw new UnlockFailed("could not unlock: this recovery file is not for this backup key");
  const kek = recoveryKek(unb64(r.recoveryKey, "recovery key", 32), k.keyId);
  for (const w of k.wrappers) {
    if (w.kind !== "recovery") continue;
    try { return new BackupKey(k, privateFrom(unwrap(w, kek, k.keyId), k)); } catch (e) { if (!(e instanceof UnlockFailed)) throw e; }
  }
  throw new UnlockFailed();
}

/** What a backup records about its encryption, in the manifest: the key it was made for and the public ephemeral half. */
export interface BackupSeal { readonly scope: "everything"; readonly keyId: string; readonly ephemeral: string; readonly keyring: Keyring }

const rootFrom = (shared: Buffer, keyId: string, ephemeral: Buffer): Buffer => hkdf(shared, Buffer.concat([Buffer.from(keyId), ephemeral]), "nn-backup-root");

/** The key material for one backup: derives file keys and the keyed digest that replaces plain SHA-256 in an encrypted backup's manifest (a plain hash of low-entropy content could be guessed). */
export class BackupCipher {
  readonly #root: Buffer;
  constructor(root: Buffer) { this.#root = root; }
  fileKey(salt: Buffer, label: string): Buffer { return hkdf(this.#root, salt, `nn-backup-file:${label}`); }
  hasher() { return createHmac("sha256", hkdf(this.#root, Buffer.alloc(0), "nn-backup-mac")); }
}

/** Starts an encrypted backup from the public keyring only (no secret is needed, so a scheduled backup runs unattended). */
export function beginSeal(keyring: Keyring): { cipher: BackupCipher; seal: BackupSeal } {
  const k = parseKeyring(keyring);
  const eph = generateKeyPairSync("x25519");
  const shared = diffieHellman({ privateKey: eph.privateKey, publicKey: createPublicKey({ key: unb64(k.publicKey, "public key"), format: "der", type: "spki" }) });
  const ephemeral = Buffer.from(eph.publicKey.export({ type: "spki", format: "der" }));
  return { cipher: new BackupCipher(rootFrom(shared, k.keyId, ephemeral)), seal: { scope: "everything", keyId: k.keyId, ephemeral: b64(ephemeral), keyring: k } };
}

/** An unlocked private key: held in memory only for the operation that needed it. */
export class BackupKey {
  readonly keyring: Keyring;
  readonly #priv: KeyObject;
  constructor(keyring: Keyring, priv: KeyObject) { this.keyring = keyring; this.#priv = priv; }
  /** The cipher for a backup, or a refusal when the backup was made for another key. */
  cipherFor(seal: BackupSeal): BackupCipher {
    if (seal.keyId !== this.keyring.keyId) throw new UnlockFailed("could not unlock: this backup was made for a different backup key");
    const eph = unb64(seal.ephemeral, "ephemeral key");
    const shared = diffieHellman({ privateKey: this.#priv, publicKey: createPublicKey({ key: eph, format: "der", type: "spki" }) });
    return new BackupCipher(rootFrom(shared, seal.keyId, eph));
  }
}

const chunkAad = (header: Buffer, label: string, index: number, last: boolean): Buffer => { const t = Buffer.alloc(9); t.writeBigUInt64BE(BigInt(index)); t[8] = last ? 1 : 0; return Buffer.concat([header, Buffer.from(label), Buffer.from([0]), t]); };
const chunkNonce = (index: number): Buffer => { const n = Buffer.alloc(12); n.writeBigUInt64BE(BigInt(index), 4); return n; };

export interface FileSink { write(buffer: Buffer): Promise<void>; /** Flushes, syncs and closes. */ finish(): Promise<void>; /** Closes without finishing (after a failure). */ abort(): Promise<void> }

/** Opens `path` (new file, owner-only) for writing; sealed under `cipher` with `label` when one is given, else plain. */
export async function openSink(path: string, cipher: BackupCipher | undefined, label: string): Promise<FileSink> {
  const handle = await open(path, "wx", 0o600);
  if (cipher === undefined) return { write: async (b) => { await handle.write(b); }, finish: async () => { await handle.sync(); await handle.close(); }, abort: () => handle.close() };
  const salt = randomBytes(16); const header = Buffer.concat([MAGIC, salt]); const key = cipher.fileKey(salt, label);
  let pending = Buffer.alloc(0); let index = 0; let wroteHeader = false;
  const seal = (data: Buffer, last: boolean): Buffer => { const c = createCipheriv("aes-256-gcm", key, chunkNonce(index)); c.setAAD(chunkAad(header, label, index, last)); index += 1; return Buffer.concat([c.update(data), c.final(), c.getAuthTag()]); };
  const out = async (b: Buffer): Promise<void> => { if (!wroteHeader) { wroteHeader = true; await handle.write(header); } await handle.write(b); };
  return {
    write: async (b) => { pending = Buffer.concat([pending, b]); while (pending.length > CHUNK_BYTES) { await out(seal(pending.subarray(0, CHUNK_BYTES), false)); pending = pending.subarray(CHUNK_BYTES); } },
    finish: async () => { await out(seal(pending, true)); await handle.sync(); await handle.close(); },
    abort: () => handle.close(),
  };
}

/** Reads a file's plaintext, one chunk at a time. A sealed file is checked chunk by chunk, including that it was not cut short; any failure throws SealedFileBad and no unchecked byte is yielded. */
export async function* readPlain(path: string, cipher: BackupCipher | undefined, label: string): AsyncGenerator<Buffer> {
  if (cipher === undefined) { for await (const c of createReadStream(path)) yield c as Buffer; return; }
  let buf = Buffer.alloc(0); let header: Buffer | undefined; let key: Buffer | undefined; let index = 0;
  const open1 = (data: Buffer, last: boolean): Buffer => {
    try { const d = createDecipheriv("aes-256-gcm", key!, chunkNonce(index)); d.setAAD(chunkAad(header!, label, index, last)); d.setAuthTag(data.subarray(data.length - TAG)); const out = Buffer.concat([d.update(data.subarray(0, data.length - TAG)), d.final()]); index += 1; return out; } catch { throw new SealedFileBad(`${label} was changed or is not complete`); }
  };
  for await (const part of createReadStream(path)) {
    buf = Buffer.concat([buf, part as Buffer]);
    if (header === undefined) {
      if (buf.length < HEADER) continue;
      header = buf.subarray(0, HEADER);
      if (!header.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealedFileBad(`${label} is not a sealed backup file`);
      key = cipher.fileKey(header.subarray(MAGIC.length), label); buf = buf.subarray(HEADER);
    }
    while (buf.length > CHUNK_BYTES + TAG) { yield open1(buf.subarray(0, CHUNK_BYTES + TAG), false); buf = buf.subarray(CHUNK_BYTES + TAG); }
  }
  if (header === undefined || buf.length < TAG) throw new SealedFileBad(`${label} is cut short`);
  yield open1(buf, true);
}

/** The digest an encrypted backup's manifest records (keyed) or the plain SHA-256. */
export const hasherFor = (cipher: BackupCipher | undefined) => cipher === undefined ? createHash("sha256") : cipher.hasher();
