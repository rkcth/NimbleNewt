import { isIP } from "node:net";
import { DomainError } from "../domain/errors.js";

/** How far the web chat listener may be reached. The owner states it; nothing is guessed from the address. */
export type WebNetwork = "loopback" | "private";

const v4 = (text: string): number[] | undefined => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(text);
  if (m === null) return undefined;
  const parts = m.slice(1).map(Number);
  return parts.every((p) => p <= 255) ? parts : undefined;
};

/** An IPv6 address as eight 16-bit groups, or undefined when it is not one. An embedded IPv4 tail (`::ffff:10.0.0.1`) counts as two groups. */
const v6 = (text: string): number[] | undefined => {
  const bare = text.split("%")[0]!.toLowerCase();
  if (isIP(bare) !== 6) return undefined;
  let head = bare;
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(bare);
  if (tail !== null) {
    const q = v4(tail[1]!);
    if (q === undefined) return undefined;
    head = bare.slice(0, bare.length - tail[1]!.length) + ((q[0]! << 8) | q[1]!).toString(16) + ":" + ((q[2]! << 8) | q[3]!).toString(16);
  }
  const [left, right] = head.split("::");
  const l = left === "" || left === undefined ? [] : left.split(":");
  const r = right === undefined || right === "" ? [] : right.split(":");
  const fill = head.includes("::") ? new Array<string>(8 - l.length - r.length).fill("0") : [];
  const groups = [...l, ...fill, ...r].map((g) => parseInt(g, 16));
  return groups.length === 8 && groups.every((g) => Number.isInteger(g) && g >= 0 && g <= 0xffff) ? groups : undefined;
};

/** The IPv4 address inside an IPv4-mapped IPv6 one (`::ffff:a.b.c.d`), else undefined. */
const mapped = (g: number[]): number[] | undefined => (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff ? [g[6]! >> 8, g[6]! & 255, g[7]! >> 8, g[7]! & 255] : undefined);

/** 127/8, ::1 and the name `localhost`. */
export function isLoopbackAddress(host: string): boolean {
  if (host === "localhost") return true;
  const a = v4(host);
  if (a !== undefined) return a[0] === 127;
  const g = v6(host);
  if (g === undefined) return false;
  if (g.slice(0, 7).every((x) => x === 0) && g[7] === 1) return true;
  const m = mapped(g);
  return m !== undefined && m[0] === 127;
}

/**
 * Addresses that are only reachable inside a private network: RFC 1918 (10/8, 172.16/12, 192.168/16), the carrier-grade range 100.64/10 that Tailscale and similar overlay networks hand out,
 * link-local (169.254/16, fe80::/10) and unique-local IPv6 (fc00::/7, which includes Tailscale's fd7a:115c:a1e0::/48). The unspecified address (0.0.0.0, ::) is never private: it means every interface.
 */
export function isPrivateAddress(host: string): boolean {
  const a = v4(host) ?? (() => { const g = v6(host); return g === undefined ? undefined : mapped(g); })();
  if (a !== undefined) {
    const [x, y] = a as [number, number];
    return x === 10 || (x === 172 && y >= 16 && y <= 31) || (x === 192 && y === 168) || (x === 100 && y >= 64 && y <= 127) || (x === 169 && y === 254);
  }
  const g = v6(host);
  if (g === undefined) return false;
  return (g[0]! & 0xfe00) === 0xfc00 || (g[0]! & 0xffc0) === 0xfe80;
}

/** Whether a connection from this remote address is one the listener's stated network allows (the check made on every request, as a second line behind the bind address). */
export function remoteAllowed(network: WebNetwork, remote: string | undefined): boolean {
  if (remote === undefined) return false;
  return isLoopbackAddress(remote) || (network === "private" && isPrivateAddress(remote));
}

export interface BindingRequest {
  readonly host: string;
  readonly network: WebNetwork;
  readonly tls: boolean;
  /** TLS is ended by a proxy on this machine (`tailscale serve`, a reverse proxy) that reaches the listener over loopback. */
  readonly behindTlsProxy: boolean;
  readonly publicHosts: readonly string[];
}

const refuse = (message: string, field: string): never => { throw new DomainError("invalid_command", message, { field }); };

/**
 * The web chat's binding rules (card U07). The owner has to say where the listener may be reached (`network`), and the address has to agree with it:
 *  - `loopback`: only this machine. A phone reaches it through a TLS proxy on the same machine (Tailscale Serve, Caddy, nginx, an SSH tunnel), which has to be declared (`behindTlsProxy`) so cookies are Secure.
 *  - `private`: an address on a private network (see `isPrivateAddress`). Needs TLS of its own and the host names clients use.
 * A wildcard address, a public address and a host name (which could resolve to anything) are always refused: there is no setting that exposes the chat to the internet.
 */
export function checkBinding(b: BindingRequest): void {
  if (b.network !== "loopback" && b.network !== "private") refuse("network must be stated as \"loopback\" or \"private\"", "network");
  if (typeof b.host !== "string" || b.host.length === 0) refuse("host must be stated: the address the web chat listens on", "host");
  if (b.host === "0.0.0.0" || b.host === "::" || b.host === "[::]" || b.host === "::0") refuse(`${b.host} listens on every interface; give one loopback or private address`, "host");
  // Only a canonical IP literal (or `localhost`): the system resolver reads a leading zero as octal, so `010.0.0.1` would pass the range check as 10.0.0.1 and bind 8.0.0.1.
  if (b.host !== "localhost" && isIP(b.host) === 0) refuse(`${b.host} is not an IP address written plainly; give the listener's address as an IP literal`, "host");
  if (b.network === "loopback") {
    if (!isLoopbackAddress(b.host)) refuse(`${b.host} is not a loopback address; state network "private" for an address on a private network`, "host");
    if (!b.tls && b.publicHosts.length > 0 && !b.behindTlsProxy) refuse("host names without TLS are only accepted behind a TLS proxy on this machine (behindTlsProxy)", "behindTlsProxy");
  } else {
    if (!isPrivateAddress(b.host)) refuse(`${b.host} is not a private-network address (10/8, 172.16/12, 192.168/16, 100.64/10, fc00::/7, link-local); the web chat is never bound to a public address`, "host");
    if (!b.tls) refuse("a listener on a private network needs TLS (tls.cert and tls.key), or bind to loopback behind a TLS proxy", "tls");
    if (b.publicHosts.length === 0) refuse("a listener on a private network needs publicHosts: the host names clients use", "publicHosts");
  }
  if (b.behindTlsProxy && b.network !== "loopback") refuse("behindTlsProxy is for a loopback listener", "behindTlsProxy");
  for (const h of b.publicHosts) if (typeof h !== "string" || !/^[A-Za-z0-9.-]{1,253}$/.test(h)) refuse(`publicHosts: ${String(h)} is not a host name`, "publicHosts");
}
