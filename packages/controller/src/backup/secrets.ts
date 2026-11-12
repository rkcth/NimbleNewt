import { join } from "node:path";
import { hasherFor, openSink, readPlain, type BackupCipher } from "./crypto.js";
import { SECRETS_FILE, type BackupSecrets } from "./format.js";
import { SIGNING_SECRET_NAME } from "./signing.js";

/**
 * Secret values in a backup (card K01b). The secret store (F09) keeps the values; a backup carries only references UNLESS encrypted backup is on, and then the values go into one sealed file, `secrets.jsonl.enc`, under
 * the backup's own key: whoever has only the folder (or the keyring) sees nothing of them, and the file is opened only with the passcode or the recovery file. This is what the "secrets only" scope seals (the rest of that
 * backup stays plain) and "everything" includes it too.
 */
export const SECRET_NAME = /^(?!.*__)[A-Za-z][A-Za-z0-9._-]{0,63}$/;
export const MAX_SECRET_BYTES = 16 * 1024;
export const MAX_SECRETS = 10_000;

/** Where the values to put into a backup are read. A locked or unreadable store throws: a backup that was meant to carry the secrets is never written without them in silence. */
export interface SecretsSource { read(): Promise<readonly { readonly name: string; readonly value: string }[] | { readonly entries: readonly { readonly name: string; readonly value: string }[]; readonly missing: number }> }
/** Where restored values go (the new machine's secret store). */
export interface SecretsSink {
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  /** Names this store never takes from a backup (the installation's backup-signing key under its configured name). `backup-signing-key` is always refused. */
  readonly refuses?: (name: string) => boolean;
}

/** A source made from a secret store and the list of names the installation uses. Names in `exclude` (the backup-signing key: it must never leave the server, not even sealed) are never read. */
export function secretsSourceOf(store: { resolve(name: string): Promise<string | undefined> }, names: () => Promise<readonly string[]> | readonly string[], exclude: readonly string[] = []): SecretsSource {
  return {
    read: async () => {
      const entries: { name: string; value: string }[] = [];
      let missing = 0;
      const skip = new Set(exclude);
      for (const name of [...new Set(await names())].sort()) {
        if (skip.has(name) || !SECRET_NAME.test(name)) continue;
        const value = await store.resolve(name); // a locked store throws here, and the backup fails
        if (value === undefined || value === "") { missing += 1; continue; }
        entries.push({ name, value });
      }
      return { entries, missing };
    },
  };
}

/** Writes the sealed secrets file into `staging` and returns its manifest entry. Always sealed: the file is never written without a cipher. */
export async function writeSecrets(staging: string, cipher: BackupCipher, source: SecretsSource): Promise<BackupSecrets> {
  const got = await source.read();
  const entries = Array.isArray(got) ? got : (got as { entries: readonly { name: string; value: string }[] }).entries;
  const missing = Array.isArray(got) ? 0 : (got as { missing: number }).missing;
  if (entries.length > MAX_SECRETS) throw new Error("too many secrets for one backup");
  const lines = entries.map((e) => `${JSON.stringify({ name: e.name, value: e.value })}\n`);
  const text = Buffer.from(lines.join(""), "utf8");
  const sink = await openSink(join(staging, SECRETS_FILE), cipher, SECRETS_FILE);
  try { await sink.write(text); await sink.finish(); } catch (error) { await sink.abort().catch(() => undefined); throw error; }
  return { index: { file: SECRETS_FILE, rows: lines.length, bytes: text.length, sha256: hasherFor(cipher).update(text).digest("hex") }, count: lines.length, missing };
}

/** Reads and checks the sealed secrets file against the manifest (size, keyed digest, row count) and returns the entries; any problem throws a plain message with no value in it. */
export async function readSecrets(path: string, entry: BackupSecrets, cipher: BackupCipher): Promise<{ name: string; value: string }[]> {
  if (entry === null || typeof entry !== "object" || entry.index?.file !== SECRETS_FILE) throw new Error("secrets: the file name is not the expected one");
  let text: Buffer;
  try { const parts: Buffer[] = []; for await (const c of readPlain(join(path, SECRETS_FILE), cipher, SECRETS_FILE)) parts.push(c); text = Buffer.concat(parts); } catch { throw new Error("secrets: the sealed file is missing or was changed"); }
  if (text.length !== entry.index.bytes || hasherFor(cipher).update(text).digest("hex") !== entry.index.sha256) throw new Error("secrets: the sealed file does not match the manifest");
  const out: { name: string; value: string }[] = [];
  const seen = new Set<string>();
  for (const line of text.toString("utf8").split("\n")) {
    if (line === "") continue;
    let e: unknown;
    try { e = JSON.parse(line); } catch { throw new Error("secrets: a line is not valid"); }
    const { name, value } = (e ?? {}) as { name?: unknown; value?: unknown };
    if (typeof name !== "string" || !SECRET_NAME.test(name) || typeof value !== "string" || value === "" || Buffer.byteLength(value, "utf8") > MAX_SECRET_BYTES || seen.has(name)) throw new Error("secrets: an entry is not valid");
    seen.add(name); out.push({ name, value });
  }
  if (out.length !== entry.index.rows || out.length !== entry.count) throw new Error(`secrets: ${out.length} secrets, the manifest says ${entry.count}`);
  return out;
}

/** What a restore did with the secrets: values put into the store, values already there that are the same, and values already there that differ (kept unless the owner asked to overwrite: a secret rotated since the backup is not rolled back by a restore). Counts only. */
export interface SecretsRestored { readonly restored: number; readonly same: number; readonly keptDifferent: number; readonly overwritten: number; /** Entries refused because they name the backup-signing key: a backup never carries it, so one that does was not made by this product, and taking it would let whoever made it sign backups this installation trusts. Present only when not zero. */ readonly refused?: number }

export async function restoreSecrets(entries: readonly { name: string; value: string }[], sink: SecretsSink, options: { overwrite?: boolean } = {}): Promise<SecretsRestored> {
  let restored = 0, same = 0, keptDifferent = 0, overwritten = 0, refused = 0;
  for (const e of entries) {
    if (e.name === SIGNING_SECRET_NAME || sink.refuses?.(e.name) === true) { refused += 1; continue; }
    const current = await sink.get(e.name);
    if (current === undefined || current === "") { await sink.set(e.name, e.value); restored += 1; }
    else if (current === e.value) same += 1;
    else if (options.overwrite === true) { await sink.set(e.name, e.value); overwritten += 1; }
    else keptDifferent += 1;
  }
  return { restored, same, keptDifferent, overwritten, ...(refused === 0 ? {} : { refused }) };
}

export const secretsText = (r: SecretsRestored): string => `secrets: ${r.restored} put into the secret store${r.same > 0 ? `, ${r.same} already there and the same` : ""}${r.keptDifferent > 0 ? `, ${r.keptDifferent} already there and different (kept as they are: a secret changed since the backup is not rolled back; ask for an overwrite to take the backup's value)` : ""}${r.overwritten > 0 ? `, ${r.overwritten} overwritten with the backup's value` : ""}${(r.refused ?? 0) > 0 ? `, ${r.refused} refused (named the backup-signing key, which a backup never carries: check where this backup came from)` : ""}`;

