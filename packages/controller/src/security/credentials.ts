import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

/**
 * Credentials for principals (card A01). A secret is 32 random bytes, shown once to whoever it is issued to and stored only as a scrypt hash (computed asynchronously, so it does not block the event loop) with its own
 * salt, so a copy of the database does not yield a usable credential. A token is `<principal id>.<secret>`; principal IDs never contain a dot.
 */
export interface StoredCredential {
  readonly algorithm: "scrypt-v1";
  readonly salt: string;
  readonly hash: string;
  readonly issuedAt: string;
}

const KEY_BYTES = 32;
const COST = { N: 16384, r: 8, p: 1 } as const;

const derive = (secret: string, salt: Buffer): Promise<Buffer> => new Promise((resolve, reject) => scrypt(secret, salt, KEY_BYTES, COST, (error, key) => (error === null ? resolve(key) : reject(error))));

export function newSecret(): string {
  return randomBytes(32).toString("base64url");
}

export async function hashSecret(secret: string, issuedAt: string): Promise<StoredCredential> {
  const salt = randomBytes(16);
  return { algorithm: "scrypt-v1", salt: salt.toString("base64url"), hash: (await derive(secret, salt)).toString("base64url"), issuedAt };
}

/** A public identifier of one stored credential (a digest of its salt): it changes whenever the credential does and reveals nothing usable. */
export const credentialIdOf = (stored: StoredCredential): string => createHash("sha256").update(`credential\0${stored.salt}`).digest("hex").slice(0, 24);

/** Constant-time check of a presented secret against a stored credential. Anything malformed is simply "no". */
export async function verifySecret(secret: unknown, stored: StoredCredential | undefined): Promise<boolean> {
  // Always do the same work, so a missing credential or a wrong-shaped secret takes about as long as a wrong one.
  const salt = Buffer.from(stored?.salt ?? "AAAAAAAAAAAAAAAAAAAAAA", "base64url");
  const presented = await derive(typeof secret === "string" ? secret.slice(0, 200) : "", salt);
  const expected = Buffer.from(stored?.hash ?? "", "base64url");
  return stored !== undefined && typeof secret === "string" && expected.length === presented.length && timingSafeEqual(presented, expected);
}

/**
 * A command ID as the secured services use it: tied to the principal, so two principals can use the same ID without meeting (no probing of another's IDs, no blocking
 * another's commands, no sharing of derived record IDs). The principal ID is kept readable and the caller's ID is hashed to a fixed length.
 */
export const scopedCommandId = (principalId: string, commandId: unknown): string => {
  if (typeof commandId !== "string" || commandId.length === 0 || commandId.length > 120) throw new RangeError("commandId must be 1 to 120 characters");
  return `${principalId}:${createHash("sha256").update(commandId).digest("hex").slice(0, 32)}`;
};

export const makeToken = (principalId: string, secret: string): string => `${principalId}.${secret}`;

/** Splits a token at its last dot. Returns undefined for anything that is not `<id>.<secret>`. */
export function parseToken(token: unknown): { principalId: string; secret: string } | undefined {
  if (typeof token !== "string" || token.length > 400) return undefined;
  const dot = token.lastIndexOf(".");
  if (dot <= 0 || dot === token.length - 1) return undefined;
  return { principalId: token.slice(0, dot), secret: token.slice(dot + 1) };
}
