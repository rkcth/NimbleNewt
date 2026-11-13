import { isIP } from "node:net";
import { DomainError } from "../domain/errors.js";
import { resolvePublic, type NameResolver } from "../dispatch/network.js";
import { redactText } from "../security/redact.js";
import type { ConnectionBody, GrantCheck, GrantView } from "./grants.js";
import { neverReachable, parseDestination } from "./destination.js";

/** What admission needs from the grant service and the connection log (the `NetworkGrantService` is what is passed). */
export interface GrantSource {
  check(taskId: string, host: string, port: number): Promise<GrantCheck>;
  logOpen(entry: Omit<ConnectionBody, "outcome" | "bytesToTarget" | "bytesFromTarget" | "startedAt"> & { outcome: "open" | "refused" | "failed" }): Promise<string>;
  logClose(taskId: string, id: string, ended: { readonly outcome: "closed" | "failed"; readonly endedBy: NonNullable<ConnectionBody["endedBy"]>; readonly bytesToTarget: number; readonly bytesFromTarget: number; readonly reason?: string }): Promise<void>;
  loggedFor(taskId: string, attemptId: string): Promise<number>;
}

/** The attempt a connection is made for. */
export interface NetworkContext { readonly taskId: string; readonly projectId: string; readonly attemptId: string }

/** A connection that was refused: the text goes back to the task as the reason (it never names another task's grants or the controller's addresses). */
export class NetworkRefused extends Error {
  constructor(message: string) { super(message); this.name = "NetworkRefused"; }
}

export interface Admitted { readonly grant: GrantView; readonly host: string; readonly port: number; /** The one address to connect to: the address that was checked. */ readonly address: string; readonly recordId: string }

export interface AdmitOptions {
  readonly resolve: NameResolver;
  /** The most connection records one attempt may write (default 1000): past it the connection is refused, because every connection is logged and the log is bounded. */
  readonly maxLogged?: number;
  readonly via: "relay" | "web-tool";
}

/**
 * Decides one connection and records it (card H12i), in this order: the destination is read as a plain host and port; the attempt's log is not full; the task holds a live grant for exactly that destination; the name is looked up once and every address it
 * gives must be allowed (never an unspecified, broadcast, multicast or link-local address; private and loopback addresses only when the grant names them); the connection is written to the log. The connection then goes to the one checked address
 * (never to the name again, so a second answer from the resolver is never used). A refusal at any step is recorded and thrown as `NetworkRefused`. A log that cannot be written refuses the connection: nothing goes ahead unrecorded.
 */
export async function admit(source: GrantSource, ctx: NetworkContext, rawHost: unknown, rawPort: unknown, options: AdmitOptions): Promise<Admitted> {
  const refuse = async (host: string, port: number, why: string, grantId?: string, address?: string): Promise<never> => {
    try {
      await source.logOpen({ taskId: ctx.taskId, projectId: ctx.projectId, attemptId: ctx.attemptId, host: host.slice(0, 253), port, ...(grantId === undefined ? {} : { grantId }), ...(address === undefined ? {} : { address }), via: options.via, outcome: "refused", reason: why });
    } catch { /* the refusal stands whether or not it could be recorded */ }
    throw new NetworkRefused(why);
  };
  let dest;
  try { dest = parseDestination(rawHost, rawPort); } catch (error) {
    const shown = typeof rawHost === "string" ? redactText(rawHost).slice(0, 80) : "?";
    return refuse(shown, typeof rawPort === "number" && Number.isInteger(rawPort) && rawPort >= 1 && rawPort <= 65535 ? rawPort : 0, error instanceof DomainError ? `the destination is not acceptable: ${error.message}` : "the destination is not acceptable");
  }
  const { host, port } = dest;
  let logged: number;
  try { logged = await source.loggedFor(ctx.taskId, ctx.attemptId); } catch { throw new NetworkRefused("the connection log could not be read, so no connection is made"); }
  if (logged >= (options.maxLogged ?? 1000)) throw new NetworkRefused("this attempt has made as many connections (and refused attempts) as its log holds; no more are made");
  let check: GrantCheck;
  try { check = await source.check(ctx.taskId, host, port); } catch { return refuse(host, port, "the grant could not be checked, so the connection is refused"); }
  if (!check.live || check.grant === undefined) return refuse(host, port, `${check.why ?? "the task holds no grant for that destination"} (${host}:${port})`, check.grant?.id);
  const grant = check.grant;
  // The name is looked up once. A name that gives no address, or any address no grant reaches, is refused; so is a private address unless the grant names it.
  let address: string;
  try {
    if (grant.allowPrivate) {
      const literal = /^[0-9.]+$/.test(host) || host.includes(":");
      const addresses = literal ? [host] : [...await options.resolve(host)];
      if (addresses.length === 0) return refuse(host, port, `${host} did not resolve to any address`, grant.id);
      if (addresses.some((a) => typeof a !== "string" || isIP(a) === 0)) return refuse(host, port, `${host} did not resolve to addresses`, grant.id);
      const never = addresses.filter((a) => neverReachable(a));
      if (never.length > 0) return refuse(host, port, `${host} resolves to an address no grant can reach`, grant.id);
      address = addresses[0]!;
    } else {
      const pinned = await resolvePublic(host, options.resolve);
      if (pinned.addresses.some((a) => typeof a !== "string" || isIP(a) === 0)) return refuse(host, port, `${host} did not resolve to addresses`, grant.id);
      const never = pinned.addresses.filter((a) => neverReachable(a));
      if (never.length > 0) return refuse(host, port, `${host} resolves to an address no grant can reach`, grant.id);
      address = pinned.address;
    }
  } catch (error) {
    if (error instanceof NetworkRefused) throw error;
    const why = error instanceof DomainError ? (error.code === "forbidden" ? `${host} resolves to a private or internal address, and the grant does not name one` : redactText(error.message).slice(0, 200)) : "the name could not be looked up";
    return refuse(host, port, why, grant.id);
  }
  let recordId: string;
  try { recordId = await source.logOpen({ taskId: ctx.taskId, projectId: ctx.projectId, attemptId: ctx.attemptId, host, port, address, grantId: grant.id, via: options.via, outcome: "open" }); } catch { throw new NetworkRefused("the connection could not be recorded, so it is not made"); }
  return { grant, host, port, address, recordId };
}
