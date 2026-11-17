import { randomBytes } from "node:crypto";
import type { Observation } from "../dependencies/dependencies.js";
import type { Principal } from "../security/principals.js";
import type { RemoteWorkspaceAnswer } from "./protocol.js";
import { OBSERVE_ASK } from "./service.js";

/** What the controller says to a host and reads back when it asks it to look at a task's recorded files (card L04e). */
export interface ObserveAsker {
  askObserve(by: Principal, hostId: string, requestId: string, scope: { readonly taskId: string; readonly projectId: string }, entries: readonly { readonly id: string; readonly kind: "file" | "directory"; readonly key: string }[], paths: readonly string[] | undefined, options: { readonly waitMs: number }): Promise<RemoteWorkspaceAnswer>;
}

const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const requestId = (): string => { let out = "wsr-"; const bytes = randomBytes(20); for (const b of bytes) out += B32[b % 32]; return out; };
const HASH = /^[0-9a-f]{64}$/;

/**
 * One observation as a host sent it, or nothing when it is not one: only `exists`, a lowercase sha-256 `hash` of a file or the sorted `members` of a directory are taken; anything else the host put there is dropped, so a confused or
 * hostile host can say what a file is but never smuggle text into the controller's check.
 */
export function observationOf(value: unknown, kind: "file" | "directory"): Observation | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const o = value as Record<string, unknown>;
  if (typeof o["exists"] !== "boolean") return undefined;
  if (!o["exists"]) return { exists: false };
  if (kind === "file") return typeof o["hash"] === "string" && HASH.test(o["hash"]) ? { exists: true, hash: o["hash"] } : undefined;
  const m = o["members"];
  if (!Array.isArray(m) || m.length > 200 || m.some((n) => typeof n !== "string" || n.length < 1 || n.length > 200)) return undefined;
  return { exists: true, members: [...(m as string[])].sort() };
}

/** The most requests one resume check makes of a host, and how long each may take. Whatever is not answered by then stays unknown. */
export const OBSERVE_ON_HOST = { asks: 12, waitMs: 8_000 } as const;

/**
 * Asks the host that holds a task's checkout to look at the task's recorded files and directories on its own disk (card L04e): the remote form of the resume check's dependency probe. The entries go in requests of at most
 * `OBSERVE_ASK.entries`; a host that cannot fit an answer for all of them in one answer is asked again for the rest, and one it cannot answer for at all (or never answers) leaves them unknown. It never throws: a host that is not
 * connected, a refusal, a timeout or a malformed answer leaves what it covered unobserved, which the check reads as unknown (never as unchanged). Returns what was observed, by entry ID, and why the rest was not, for the log.
 */
export async function observeOnHost(deps: { readonly remote: ObserveAsker; readonly by: Principal }, hostId: string, scope: { readonly taskId: string; readonly projectId: string }, entries: readonly { readonly id: string; readonly kind: "file" | "directory"; readonly key: string }[], paths: readonly string[] | undefined, options: { readonly waitMs?: number; readonly asks?: number; readonly onFault?: (detail: string) => void } = {}): Promise<Record<string, Observation>> {
  const out: Record<string, Observation> = {};
  const fault = (detail: string): void => { try { options.onFault?.(detail.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)); } catch { /* a failing log tells nothing */ } };
  let pending = [...entries].sort((a, b) => (a.id < b.id ? -1 : 1));
  for (let asks = 0; asks < (options.asks ?? OBSERVE_ON_HOST.asks) && pending.length > 0; asks++) {
    const chunk = pending.slice(0, OBSERVE_ASK.entries);
    let answer: RemoteWorkspaceAnswer;
    try { answer = await deps.remote.askObserve(deps.by, hostId, requestId(), scope, chunk, paths, { waitMs: options.waitMs ?? OBSERVE_ON_HOST.waitMs }); } catch (error) { fault(`${hostId} did not answer the look at the files of ${scope.taskId}: ${error instanceof Error ? error.message : String(error)}`); return out; }
    if (!answer.ok) { fault(`${hostId} did not look at the files of ${scope.taskId}: ${answer.reason}`); return out; }
    const seen = (answer.detail as { observed?: unknown } | undefined)?.observed;
    const got = seen !== null && typeof seen === "object" && !Array.isArray(seen) ? seen as Record<string, unknown> : {};
    const asked = new Set(chunk.map((e) => e.id));
    for (const e of chunk) {
      if (!Object.hasOwn(got, e.id)) continue;
      const o = observationOf(got[e.id], e.kind);
      if (o !== undefined) out[e.id] = o;
    }
    // The host names the ones it read but could not fit in this answer (`later`); only those are asked for again. One it could not read at all is not named, and stays unknown. An answer that names an entry it also answered, one not
    // asked, or all of the chunk with none answered makes no progress and is not asked again.
    const later = (answer.detail as { later?: unknown } | undefined)?.later;
    const again = new Set(Array.isArray(later) ? later.filter((id): id is string => typeof id === "string" && asked.has(id) && !Object.hasOwn(out, id)) : []);
    if (again.size >= chunk.length && chunk.every((e) => again.has(e.id))) again.delete(chunk[0]!.id);
    pending = pending.filter((e) => !asked.has(e.id) || again.has(e.id));
  }
  return out;
}
