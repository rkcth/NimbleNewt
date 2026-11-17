import { createHash } from "node:crypto";
import { redactText } from "../security/redact.js";
import { keptSecretRefusal } from "./reserved-secrets.js";

/**
 * Records made before the kept-secret rule (task T4b): a network grant, a backup target or a work-in-progress backup that names, as the credential it sends to another party, a secret the installation keeps for something else
 * (the owner's credential, the database address, a transfer target's address, the backup signing key). Each is already refused where it is used; this finds them so the owner is told, by name and never by value, what to change.
 */
export type KeptSecretUseKind = "network grant" | "backup target" | "work-in-progress backup";

export interface KeptSecretUse {
  /** A short code that is the same for the same record and secret (the notification's record id). */
  readonly key: string;
  readonly kind: KeptSecretUseKind;
  /** Where the record is, in the owner's words (host and port, the target's name, the project). */
  readonly where: string;
  /** The NAME of the secret; never a value. */
  readonly secret: string;
  /** What to do. */
  readonly remedy: string;
}

export const KEPT_SECRET_USE_LIMIT = 200;
/** The kind of record the notification points at. */
export const KEPT_SECRET_USE_REF = "kept-secret-use";

export interface KeptSecretUseSources {
  readonly kept: () => readonly string[];
  readonly grants?: () => { credentialUses(limit?: number, match?: (ref: string) => boolean): Promise<readonly { readonly id: string; readonly taskId: string; readonly host: string; readonly port: number; readonly ref: string }[]> } | undefined;
  readonly backupConfig?: { effective(): Promise<{ readonly targets: readonly { readonly id: string; readonly name: string; readonly credential?: string }[] }> };
  readonly wip?: { credentialUses(limit?: number, match?: (credential: string) => boolean): Promise<readonly { readonly projectId: string; readonly credential: string }[]> };
}

/** Text of at most `n` UTF-16 units that never ends inside a surrogate pair. */
export function cutText(text: string, n: number): string {
  if (text.length <= n) return text;
  let end = n;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return text.slice(0, end);
}

const code = (...parts: string[]): string => `ks-${createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 20)}`;

export class KeptSecretUseCheck {
  readonly #s: KeptSecretUseSources;
  constructor(sources: KeptSecretUseSources) { this.#s = sources; }

  /** Every record, of the three kinds, that names a kept secret, in a fixed order, at most `KEPT_SECRET_USE_LIMIT` of each kind (the listings look at every record and keep only the matching ones). */
  async find(): Promise<KeptSecretUse[]> {
    const kept = this.#s.kept();
    const out: KeptSecretUse[] = [];
    const bad = (name: string, sentTo: string): boolean => keptSecretRefusal(name, kept, sentTo) !== undefined;
    for (const g of (await this.#s.grants?.()?.credentialUses(KEPT_SECRET_USE_LIMIT, (ref) => bad(ref, "a network destination"))) ?? []) {
      if (bad(g.ref, "a network destination")) out.push({ key: code("grant", g.id, g.ref.toLowerCase()), kind: "network grant", where: `${cutText(g.host, 60)}:${g.port}`, secret: cutText(g.ref, 64), remedy: "Revoke the grant and ask again with another secret." });
    }
    for (const t of (await this.#s.backupConfig?.effective())?.targets ?? []) {
      if (t.credential !== undefined && bad(t.credential, "a backup target")) out.push({ key: code("target", t.id, t.credential.toLowerCase()), kind: "backup target", where: cutText(t.name, 40), secret: cutText(t.credential, 64), remedy: "Remove the target and add it again with the store's own credential." });
    }
    for (const w of (await this.#s.wip?.credentialUses(KEPT_SECRET_USE_LIMIT, (c) => bad(c, "a backup remote"))) ?? []) {
      if (bad(w.credential, "a backup remote")) out.push({ key: code("wip", w.projectId, w.credential.toLowerCase()), kind: "work-in-progress backup", where: `project ${cutText(w.projectId, 40)}`, secret: cutText(w.credential, 64), remedy: "Set the backup again with another secret." });
    }
    return out;
  }
}

/** The owner's sentence for one record (cut to `n` UTF-16 units; a notification's detail holds 200). A long place is shortened before the advice is, so the advice survives. */
export function keptSecretUseText(u: KeptSecretUse, n = 200): string {
  const make = (where: string): string => `A ${u.kind} (${where}) names the secret "${u.secret}", which the installation keeps for something else, so nothing is sent. ${u.remedy}`;
  let where = u.where;
  while (where.length > 8 && make(where).length > n) where = cutText(where, where.length - 4);
  return cutText(make(where), n);
}

/**
 * Tells the owner about each record found, once (the notification's id is fixed by the record and the secret's name), and closes the notices of records that no longer name a kept secret. Never throws: a failure is passed to `onError`.
 */
export async function reportKeptSecretUses(check: KeptSecretUseCheck, notifications: {
  emitFromController(c: { commandId: string; kind: "maintenance"; level: "needs-you"; ref: { kind: string; id: string }; detail: string }): Promise<unknown>;
  settleFromController(c: { commandId: string; kind: "maintenance"; ref: { kind: string; id: string } }): Promise<unknown>;
  openRefIds(kind: string): Promise<string[]>;
}, onError?: (message: string) => void): Promise<{ readonly found: number; readonly closed: number }> {
  try {
    const uses = await check.find();
    for (const u of uses) await notifications.emitFromController({ commandId: `kept-secret-${u.key}`, kind: "maintenance", level: "needs-you", ref: { kind: KEPT_SECRET_USE_REF, id: u.key }, detail: keptSecretUseText(u, 200) });
    const live = new Set(uses.map((u) => u.key));
    let closed = 0;
    for (const id of await notifications.openRefIds(KEPT_SECRET_USE_REF)) {
      if (live.has(id)) continue;
      await notifications.settleFromController({ commandId: `kept-secret-over-${id}`, kind: "maintenance", ref: { kind: KEPT_SECRET_USE_REF, id } });
      closed++;
    }
    return { found: uses.length, closed };
  } catch (error) {
    try { onError?.(`checking records that name a kept secret failed: ${error instanceof Error ? redactText(error.message).slice(0, 160) : "error"}`); } catch { /* ignored */ }
    return { found: 0, closed: 0 };
  }
}
