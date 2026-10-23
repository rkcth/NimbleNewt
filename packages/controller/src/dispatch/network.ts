import { DomainError } from "../domain/errors.js";
import { internalHost } from "../mcp/mcp.js";

/** Looks a name up. It returns the addresses as text (IPv4 dotted, IPv6 with colons). Supplied by the worker host (`dns.lookup` with `all: true` in production). */
export type NameResolver = (host: string) => Promise<readonly string[]>;

export interface Pinned {
  /** The host name the caller asked for (kept for the Host header and the TLS server name). */
  readonly host: string;
  /** The one address to connect to: the address that was checked. */
  readonly address: string;
  /** Every address the name resolved to; all of them were checked. */
  readonly addresses: readonly string[];
}

/**
 * Resolves a name for an outside connection and refuses an internal result (card H12). A public name can point at a private address (DNS rebinding), so the name's form is not enough: the name is
 * looked up once, **every** address it gives must be public (a client may pick any of them), and the caller connects to the checked address itself, not to the name again, so a second lookup that
 * answers differently is never used. An address given directly is checked without a lookup. A name that resolves to nothing is `unavailable`, never connected to.
 */
export async function resolvePublic(host: string, resolve: NameResolver): Promise<Pinned> {
  if (typeof host !== "string" || host.length === 0 || host.length > 253) throw new DomainError("invalid_command", "host: must be a host name or address", { field: "host" });
  if (internalHost(host)) throw new DomainError("forbidden", `${host} is an internal name or address; a worker does not connect to it`);
  const literal = /^[0-9.]+$/.test(host) || host.includes(":") || /^\[.*\]$/.test(host);
  const addresses = literal ? [host.replace(/^\[|\]$/g, "")] : [...await resolve(host)];
  if (addresses.length === 0) throw new DomainError("unavailable", `${host} did not resolve to any address`);
  const internal = addresses.filter((a) => typeof a !== "string" || internalHost(a));
  if (internal.length > 0) throw new DomainError("forbidden", `${host} resolves to an internal address (${internal.map(String).slice(0, 3).join(", ")}); a worker does not connect to it`);
  return { host, address: addresses[0]!, addresses };
}

/**
 * Connects to a remote server or any other outside address through `resolvePublic`: the checked address is what `connect` receives, together with the name for the TLS server name and the Host
 * header. The result of `connect` is returned as it is.
 */
export async function connectPublic<T>(url: string, resolve: NameResolver, connect: (target: { readonly host: string; readonly address: string; readonly port: number; readonly secure: boolean }) => Promise<T>): Promise<T> {
  let parsed: URL;
  try { parsed = new URL(url); } catch { throw new DomainError("invalid_command", "url: must be an address", { field: "url" }); }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new DomainError("invalid_command", "url: must be an http or https address", { field: "url" });
  const pinned = await resolvePublic(parsed.hostname, resolve);
  return connect({ host: pinned.host, address: pinned.address, port: parsed.port === "" ? (parsed.protocol === "https:" ? 443 : 80) : Number(parsed.port), secure: parsed.protocol === "https:" });
}
