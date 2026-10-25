import { connectPublic, resolvePublic, type NameResolver } from "../dispatch/network.js";
import type { Principal } from "../security/principals.js";
import type { McpService } from "./mcp.js";

/**
 * The only way the controller's host reaches a remote MCP server (card H12g). Each connection asks the MCP service where the server is *now* (a revoked server gives nothing, so a revocation blocks every new connection and call), and connects
 * through `connectPublic`: the name is looked up, every address must be public, and the transport receives the checked address, never the name. A name is looked up a second time and must still give only public addresses (one that turns internal within a connection is the DNS-rebinding pattern and is refused); `use` always gets the first, checked address. (A longer-lived change is met by the next connection being checked again.)
 */
/** `host` is the DNS name (the TLS server name and Host header); `registryName` is the owner's name for the server and is not a network name. A pinned IPv6 `address` has no brackets. A connection should live for one call: revocation is checked when it is made. */
export interface RemoteTarget { readonly serverId: string; readonly registryName: string; readonly host: string; readonly address: string; readonly port: number; readonly secure: boolean }

export interface RemoteMcpOptions {
  readonly mcp: Pick<McpService, "remoteEndpoint">;
  readonly resolve: NameResolver;
  readonly principal: Principal;
}

export class RemoteMcpConnector {
  readonly #options: RemoteMcpOptions;
  constructor(options: RemoteMcpOptions) { this.#options = options; }

  /** Runs `use` with the checked target of the server. Whatever `use` returns is returned; nothing is cached. */
  async connect<T>(serverId: string, use: (target: RemoteTarget) => Promise<T>): Promise<T> {
    const { url, name } = await this.#options.mcp.remoteEndpoint(this.#options.principal, serverId);
    let seen: readonly string[] | undefined;
    // The first lookup is the one `connectPublic` pins; the second is the rebinding probe.
    const resolve: NameResolver = async (host) => { const answer = await this.#options.resolve(host); seen = answer; return answer; };
    return connectPublic(url, resolve, async (target) => {
      if (seen !== undefined) {
        // A name that turns internal between the check and the connection is the rebinding pattern: refused (resolvePublic throws). A different but public answer (rotating or CDN names) is fine: the connection uses the first, checked address.
        await resolvePublic(target.host, this.#options.resolve);
      }
      return use({ serverId, registryName: name, host: target.host, address: target.address, port: target.port, secure: target.secure });
    });
  }
}
