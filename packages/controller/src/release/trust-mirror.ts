import { randomBytes } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { renameReplacing } from "./rename-replacing.js";
import { SIGNING, parsePublicKey } from "./trust.js";

/**
 * The updater's copy of the trust root (card K02, finish).
 *
 * The updater is a separate program that never opens the database, so it cannot read the owner's trust root. Without a copy it installed (and with `--switch` pointed the launcher at) an unsigned release even
 * where the controller requires signatures. The controller therefore writes `trust-root.json` under the release root after every change of the trust root (and at every start): the base64 public keys and
 * whether a signature is needed now. The updater reads it by default and refuses a release without a valid signature from one of those keys when it says `required`. A copy that is present but damaged is
 * refused (never guessed at). No copy at all means no trust root has ever been written (an installation on digests alone). The file is a plain file written by the controller's uid, the same boundary as the rest
 * of the release root (see `activation.ts`); it holds public keys only.
 */
export const TRUST_MIRROR_FILE = "trust-root.json";
export const TRUST_MIRROR_MAX_BYTES = 16_384;
export interface TrustMirror { readonly version: 1; readonly required: boolean; readonly keys: readonly string[] }

/** Writes the copy atomically (temporary file, then rename). Throws on any failure: the caller must say the copy is stale. */
export async function writeTrustMirror(root: string, m: { readonly required: boolean; readonly keys: readonly string[] }): Promise<void> {
  const body: TrustMirror = { version: 1, required: m.required, keys: [...m.keys] };
  const file = join(root, TRUST_MIRROR_FILE);
  const tmp = `${file}.${process.pid}-${randomBytes(4).toString("hex")}.tmp`;
  const fh = await open(tmp, "wx", 0o644);
  try { await fh.writeFile(`${JSON.stringify(body)}\n`); await fh.sync(); } catch (error) { await fh.close().catch(() => undefined); await rm(tmp, { force: true }).catch(() => undefined); throw error; }
  await fh.close();
  try { await renameReplacing(tmp, file); } catch (error) { await rm(tmp, { force: true }).catch(() => undefined); throw error; }
  // The rename itself is made durable where the platform allows it, so a power cut does not bring back the previous copy (one that may still list a withdrawn key).
  let dir;
  try { dir = await open(root, "r"); await dir.sync(); } catch { /* not every platform syncs a directory */ } finally { await dir?.close().catch(() => undefined); }
}

/** Reads the copy. `undefined` when there is none; throws an Error with a plain message when it is present and not valid. */
export async function readTrustMirror(root: string): Promise<TrustMirror | undefined> {
  const file = join(root, TRUST_MIRROR_FILE);
  let l;
  try { l = await lstat(file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!l.isFile()) throw new Error(`${TRUST_MIRROR_FILE} is not a plain file`);
  const fh = await open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  let text: string;
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.size > TRUST_MIRROR_MAX_BYTES) throw new Error(`${TRUST_MIRROR_FILE} must be a plain file of at most ${TRUST_MIRROR_MAX_BYTES} bytes`);
    text = await fh.readFile("utf8");
  } finally { await fh.close(); }
  let v: unknown;
  try { v = JSON.parse(text); } catch { throw new Error(`${TRUST_MIRROR_FILE} is damaged`); }
  const o = v as { version?: unknown; required?: unknown; keys?: unknown };
  if (typeof v !== "object" || v === null || Array.isArray(v) || o.version !== 1 || typeof o.required !== "boolean" || !Array.isArray(o.keys) || o.keys.length > SIGNING.maxKeys) throw new Error(`${TRUST_MIRROR_FILE} is damaged`);
  const keys: string[] = [];
  for (const k of o.keys) { try { keys.push(parsePublicKey(k).publicKey); } catch { throw new Error(`${TRUST_MIRROR_FILE} holds a key that is not a usable Ed25519 public key`); } }
  return { version: 1, required: o.required, keys };
}
