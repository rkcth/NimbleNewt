import { BlockList, isIP } from "node:net";
import { DomainError } from "../domain/errors.js";
import { internalHost, ipv6Bytes } from "../mcp/mcp.js";

/**
 * Where a task may connect to (card H12i). A destination is a host (a name or an address literal) and a port, written exactly: no wildcard, no address range, no scheme, path or credentials. The checks here are about the *form* of a destination
 * and about the addresses no grant can ever reach; whether a task holds a grant for it, and whether a name resolves to something the grant allows, is decided by the grant service and the relay.
 */
export interface Destination { readonly host: string; readonly port: number }

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const NAME = new RegExp(`^${LABEL}(?:\\.${LABEL})*$`);

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/**
 * A host written the one way the controller compares: lower case, no brackets, no trailing dot, an IPv6 address in the parser's own form. A name is letters, digits and hyphens in dot-separated labels (an international name is given in its ASCII form).
 * Refused: anything that is not a plain host (a scheme, a path, a port, credentials, a wildcard, a space or control character), an address in a form only some systems read as an address (a number, `0x7f.1`, `127.1`, an octal), and a name whose last
 * label is a number (some resolvers read `10.0.0.1.` and `1.2.3.4.5` as addresses).
 */
export function canonicalHost(value: unknown, field = "host"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 253) return invalid(field, "must be a host name or address of at most 253 characters");
  let h = value.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (isIP(h) === 6) {
    try { return new URL(`http://[${h}]/`).hostname.replace(/^\[|\]$/g, ""); } catch { return invalid(field, "is not a valid address"); }
  }
  if (isIP(h) === 4) return h;
  h = h.replace(/\.$/, "");
  if (h.includes(":") || /[^a-z0-9.-]/.test(h)) return invalid(field, "must be a plain host name or address: no scheme, path, port, credentials, wildcard or spaces");
  if (!NAME.test(h)) return invalid(field, "is not a valid host name");
  const last = h.slice(h.lastIndexOf(".") + 1);
  if (/^[0-9]+$/.test(last) || /^0x/.test(last)) return invalid(field, "a name whose last part is a number reads as an address on some systems; write the address in dotted form");
  return h;
}

export function canonicalPort(value: unknown, field = "port"): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 65535) return invalid(field, "must be a port from 1 to 65535");
  return value;
}

export function parseDestination(host: unknown, port: unknown): Destination { return { host: canonicalHost(host), port: canonicalPort(port) }; }

/** Addresses no grant reaches, whoever approved it: an unspecified or broadcast address, multicast, and the link-local range where cloud instances keep their credentials service (169.254.169.254 and its IPv6 form). */
const NEVER = (() => {
  const list = new BlockList();
  list.addSubnet("0.0.0.0", 8, "ipv4");
  list.addSubnet("169.254.0.0", 16, "ipv4");
  list.addSubnet("224.0.0.0", 4, "ipv4");
  list.addSubnet("240.0.0.0", 4, "ipv4");
  list.addAddress("100.100.100.200", "ipv4");
  list.addAddress("::", "ipv6");
  list.addSubnet("fe80::", 10, "ipv6");
  list.addSubnet("ff00::", 8, "ipv6");
  list.addAddress("fd00:ec2::254", "ipv6");
  return list;
})();

/** Whether an address (not a name) is one no grant may reach (see `NEVER`). A name is judged by the addresses it resolves to. IPv6 forms that carry an IPv4 address (mapped, in either spelling) are judged as that IPv4 address. */
export function neverReachable(address: string): boolean {
  const a = address.toLowerCase().replace(/^\[|\]$/g, "");
  const kind = isIP(a);
  if (kind === 0) return false;
  if (kind === 4) return NEVER.check(a, "ipv4");
  let text = a;
  try { text = new URL(`http://[${a}]/`).hostname.replace(/^\[|\]$/g, ""); } catch { return true; }
  // An IPv6 address that carries an IPv4 address is judged as that address too: mapped (::ffff:a.b.c.d), SIIT (::ffff:0:a.b.c.d), compatible (::a.b.c.d), NAT64 (64:ff9b::/96 and the local 64:ff9b:1::/48)
  // and 6to4 (2002:aabb:ccdd::). A gateway that translates them would otherwise carry a connection to the credentials service of a cloud instance.
  const b = ipv6Bytes(text);
  if (b !== undefined) {
    const v4 = (i: number): boolean => NEVER.check(`${b[i]}.${b[i + 1]}.${b[i + 2]}.${b[i + 3]}`, "ipv4");
    const zeros = (from: number, to: number): boolean => b.slice(from, to).every((x) => x === 0);
    if (zeros(0, 10) && b[10] === 0xff && b[11] === 0xff && v4(12)) return true;
    if (zeros(0, 8) && b[8] === 0xff && b[9] === 0xff && zeros(10, 12) && v4(12)) return true;
    if (zeros(0, 12) && b[12] !== 0 && v4(12)) return true; // not ::1 or ::, which carry no address
    if (b[0] === 0x00 && b[1] === 0x64 && b[2] === 0xff && b[3] === 0x9b && (zeros(4, 12) || (b[4] === 0 && b[5] === 1)) && v4(12)) return true;
    if (b[0] === 0x20 && b[1] === 0x02 && v4(2)) return true;
  }
  return NEVER.check(text, "ipv6");
}

/** Whether a host or address is private, loopback or otherwise internal: a grant reaches it only when it says so itself (`allowPrivate`). */
export const isPrivate = (host: string): boolean => internalHost(host);
