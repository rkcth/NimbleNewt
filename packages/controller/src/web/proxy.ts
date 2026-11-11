import { isIP } from "node:net";
import { DomainError } from "../domain/errors.js";
import { isLoopbackAddress, isPrivateAddress, type WebNetwork } from "./binding.js";

/** The one forwarded header the owner trusts. A proxy sets exactly one of these; the door never reads the others. */
export type ForwardedHeader = "x-forwarded-for" | "x-real-ip";
export const FORWARDED_HEADERS: readonly ForwardedHeader[] = ["x-forwarded-for", "x-real-ip"];

/**
 * The owner-set trusted proxy (card U07b). OFF by default. Without it the client address is the connection's own peer address and no forwarded header is ever read. With it, when (and only when) the
 * immediate peer is one of `addresses` (IP literals on this machine or a private network: the proxy), the client address is taken from the one named header.
 */
export interface TrustedProxy {
  /** The proxy's own addresses as the listener sees them, e.g. `["127.0.0.1", "::1"]` for `tailscale serve` or a local Caddy. IP literals only, loopback or private only. */
  readonly addresses: readonly string[];
  /** Which header carries the client address. Default `x-forwarded-for`. */
  readonly header?: ForwardedHeader;
}

export interface ResolvedProxy { readonly addresses: ReadonlySet<string>; readonly header: ForwardedHeader }

const refuse = (message: string, field: string): never => { throw new DomainError("invalid_command", message, { field }); };

/**
 * An IP address in one canonical spelling (IPv4 dotted, IPv6 compressed and lower case, an IPv4-mapped IPv6 address as its IPv4), or undefined when the text is not a plain IP literal. A port, a zone,
 * brackets around an IPv4 address, a leading zero in an IPv4 octet and anything else are not accepted: an address that cannot be read exactly is never used to name a client.
 */
export function canonicalAddress(text: string | undefined): string | undefined {
  if (typeof text !== "string") return undefined;
  let t = text.trim();
  if (t.length === 0 || t.length > 64) return undefined;
  if (t.startsWith("[") && t.endsWith("]")) t = t.slice(1, -1);
  if (t.includes("%")) {
    // A zone id names an interface on the proxy's own link; it says nothing of the client.
    return undefined;
  }
  const kind = isIP(t);
  if (kind === 4) return t;
  if (kind !== 6) return undefined;
  let host: string;
  try { host = new URL(`http://[${t}]/`).hostname.slice(1, -1); } catch { return undefined; }
  const m = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (m !== null) { const hi = parseInt(m[1]!, 16), lo = parseInt(m[2]!, 16); return `${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`; }
  return host;
}

/** The rate-limit bucket of an address: an IPv6 client owns a whole /64, so it is one bucket; an IPv4 client is its own. */
export function bucketOfAddress(address: string): string {
  if (isIP(address) !== 6) return address;
  const host = address.split("::")[0] ?? "";
  if (!address.includes("::")) return `${address.split(":").slice(0, 4).join(":")}::/64`;
  const head = host === "" ? [] : host.split(":");
  return `${[...head, "0", "0", "0", "0"].slice(0, 4).join(":")}::/64`;
}

/** Validates the owner's trusted-proxy setting against the listener's network and returns it in the form `clientAddress` uses. Refuses anything that is not plainly a proxy on this machine or a private network. */
export function checkTrustedProxy(p: TrustedProxy | undefined, network: WebNetwork): ResolvedProxy | undefined {
  if (p === undefined) return undefined;
  if (p === null || typeof p !== "object" || !Array.isArray(p.addresses)) return refuse("trustedProxy must be { addresses: [...], header? }", "trustedProxy");
  if (p.addresses.length === 0 || p.addresses.length > 8) return refuse("trustedProxy.addresses: give 1 to 8 proxy addresses", "trustedProxy");
  const header = p.header ?? "x-forwarded-for";
  if (!FORWARDED_HEADERS.includes(header)) return refuse(`trustedProxy.header must be one of ${FORWARDED_HEADERS.join(", ")}: exactly one forwarded header is trusted`, "trustedProxy");
  const set = new Set<string>();
  for (const raw of p.addresses) {
    const a = typeof raw === "string" && raw.includes("/") ? undefined : canonicalAddress(raw);
    if (a === undefined) return refuse(`trustedProxy.addresses: ${String(raw)} is not an IP address written plainly (no names, no ranges, no ports)`, "trustedProxy");
    if (a === "0.0.0.0" || a === "::") return refuse("trustedProxy.addresses: the unspecified address is not a proxy", "trustedProxy");
    // A proxy is on this machine or inside the private network; a public address can never be trusted to say who a client is.
    if (!isLoopbackAddress(a) && !isPrivateAddress(a)) return refuse(`trustedProxy.addresses: ${a} is not a loopback or private-network address`, "trustedProxy");
    if (network === "loopback" && !isLoopbackAddress(a)) return refuse(`trustedProxy.addresses: ${a} cannot connect to a loopback listener; a proxy for it is on this machine`, "trustedProxy");
    set.add(a);
  }
  return { addresses: set, header };
}

/**
 * The client address of a request (card U07b).
 *
 * - No trusted proxy: the connection's peer address. Forwarded headers are not looked at.
 * - A trusted proxy, but the immediate peer is not one of its addresses: the peer address again, and the header is ignored (anyone else can write any header).
 * - The immediate peer is the proxy: the rightmost entry of `x-forwarded-for` that is not itself a trusted proxy address (the rule that ignores whatever a client wrote to the left, which the proxy only
 *   appended to), or the single `x-real-ip` value. Several header lines count as one list. An entry that is not a plain IP, a list too long, a repeated `x-real-ip` and an empty header all fall back to the peer
 *   address, so a spoofed or garbled header can only put a client in the proxy's shared bucket, never choose an address.
 */
export function clientAddress(peer: string | undefined, headers: Readonly<Record<string, string | string[] | undefined>>, proxy: ResolvedProxy | undefined): { readonly address: string; readonly viaProxy: boolean } {
  const direct = canonicalAddress(peer) ?? "?";
  if (proxy === undefined || direct === "?" || !proxy.addresses.has(direct)) return { address: direct, viaProxy: false };
  const raw = headers[proxy.header];
  const text = Array.isArray(raw) ? raw.join(",") : raw;
  if (typeof text !== "string" || text.trim().length === 0 || text.length > 1024) return { address: direct, viaProxy: false };
  if (proxy.header === "x-real-ip") {
    const one = canonicalAddress(text);
    return one === undefined || text.includes(",") ? { address: direct, viaProxy: false } : { address: one, viaProxy: !proxy.addresses.has(one) };
  }
  const entries = text.split(",").map((e) => e.trim());
  if (entries.length > 20) return { address: direct, viaProxy: false };
  for (let i = entries.length - 1; i >= 0; i--) {
    const a = canonicalAddress(entries[i]);
    if (a === undefined) return { address: direct, viaProxy: false };
    if (proxy.addresses.has(a)) continue;
    return { address: a, viaProxy: true };
  }
  return { address: direct, viaProxy: false };
}
