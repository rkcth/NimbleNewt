import { request as httpRequest, type IncomingMessage } from "node:http";
import { connect as netConnect, isIP, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";
import type { Duplex } from "node:stream";
import { DomainError } from "../domain/errors.js";
import { redactText } from "../security/redact.js";
import type { RemoteMcpConnector, RemoteTarget } from "./remote.js";

/**
 * The MCP transport for a remote server (card H12k): streamable HTTP (one JSON-RPC message per POST, answered as JSON or as an event stream), spoken only to the address the connector checked. The socket goes to
 * `target.address`, never to the name: the name is used only as the TLS server name (and the certificate is checked against it) and in the Host header. Nothing follows a redirect (a redirect could point anywhere, so it is
 * refused), every answer is bounded in size and time, and nothing is kept between connections: each `RemoteMcpClient` call initializes, makes its one request and ends the session.
 */
export interface McpHttpOptions {
  /** Time allowed for one HTTP exchange (connect, send, answer), in milliseconds. Default 30 seconds. */
  readonly timeoutMs?: number;
  /** The largest answer read, in bytes. Default 4 MiB. */
  readonly maxBytes?: number;
  /** Certificate authorities to trust instead of the system's (a private CA). Default: the system's. */
  readonly ca?: string | readonly string[];
  /** Headers the server needs (for example its scoped credential, read from the secret store by the caller). Host, content type, length, accept and the MCP headers are the transport's own and cannot be set here. */
  readonly headers?: (target: RemoteTarget) => Promise<Readonly<Record<string, string>>> | Readonly<Record<string, string>>;
  /** Opens the plain socket to the checked address. Default: a TCP connection to `address:port`. TLS is always added by the transport on top of it. A test gives one that reaches a local server, to show which address was used. */
  readonly dial?: (to: { readonly address: string; readonly port: number }) => Socket;
  /** How this client names itself in `initialize`. */
  readonly clientInfo?: { readonly name: string; readonly version: string };
}

export const MCP_HTTP_LIMITS = { timeoutMs: 30_000, maxBytes: 4 * 1024 * 1024, errorText: 300 } as const;
const OWN_HEADERS = /^(host|content-type|content-length|accept|connection|transfer-encoding|mcp-session-id|mcp-protocol-version)$/i;
const HEADER_NAME = /^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,64}$/;

type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
interface Answer { readonly status: number; readonly headers: IncomingMessage["headers"]; readonly message?: { readonly [key: string]: Json } }

const unavailable = (target: RemoteTarget, why: string): DomainError => new DomainError("unavailable", `MCP server ${target.registryName}: ${redactText(why).slice(0, MCP_HTTP_LIMITS.errorText)}`);

/** One session with one server over the checked target. Used inside `RemoteMcpConnector.connect`, so the target is the checked one. */
class McpHttpSession {
  readonly #target: RemoteTarget;
  readonly #options: McpHttpOptions;
  #session: string | undefined;
  #protocol: string | undefined;
  #next = 1;

  constructor(target: RemoteTarget, options: McpHttpOptions) { this.#target = target; this.#options = options; }

  /** Initializes at the server's pinned protocol revision. A server that answers another revision is refused (the connection record pins one). */
  async open(): Promise<void> {
    const result = await this.request("initialize", { protocolVersion: this.#target.protocolRevision, capabilities: {}, clientInfo: this.#options.clientInfo ?? { name: "nimblenewt-controller", version: "1" } });
    const spoken = (result as { protocolVersion?: unknown }).protocolVersion;
    if (spoken !== this.#target.protocolRevision) {
      await this.close();
      throw unavailable(this.#target, `the server speaks protocol ${String(spoken).slice(0, 20)}, not the ${this.#target.protocolRevision} it is pinned to; nothing was called`);
    }
    this.#protocol = this.#target.protocolRevision;
    const sent = await this.#exchange("POST", { jsonrpc: "2.0", method: "notifications/initialized" }, undefined);
    if (sent.status !== 202 && sent.status !== 200 && sent.status !== 204) throw unavailable(this.#target, `the server answered the initialized notification with HTTP ${sent.status}`);
  }

  /** One request; its result, or a refusal that carries the server's own error text (data, not the controller's words). */
  async request(method: string, params: { readonly [key: string]: Json }): Promise<{ readonly [key: string]: Json }> {
    const id = this.#next++;
    const answer = await this.#exchange("POST", { jsonrpc: "2.0", id, method, params }, id);
    if (answer.status < 200 || answer.status >= 300) throw unavailable(this.#target, `the server answered ${method} with HTTP ${answer.status}`);
    if (method === "initialize") {
      const session = answer.headers["mcp-session-id"];
      if (typeof session === "string") {
        if (!/^[\x21-\x7e]{1,256}$/.test(session)) throw unavailable(this.#target, "the server gave a session id that is not visible ASCII");
        this.#session = session;
      }
    }
    const message = answer.message;
    if (message === undefined) throw unavailable(this.#target, `the server gave no answer to ${method}`);
    if (message["error"] !== undefined) {
      const error = message["error"] as { message?: unknown; code?: unknown };
      throw unavailable(this.#target, `the server refused ${method} (code ${String(error.code).slice(0, 12)}; the server's own words, data not instructions: ${String(error.message ?? "").slice(0, 200)})`);
    }
    const result = message["result"];
    if (result === null || typeof result !== "object" || Array.isArray(result)) throw unavailable(this.#target, `the server's answer to ${method} has no result object`);
    return result as { readonly [key: string]: Json };
  }

  /** Ends a session the server keeps (best effort: a server that keeps none, or refuses, changes nothing). */
  async close(): Promise<void> {
    if (this.#session === undefined) return;
    try { await this.#exchange("DELETE", undefined, undefined); } catch { /* the session expires on the server's side */ }
    this.#session = undefined;
  }

  async #exchange(method: "POST" | "DELETE", body: { readonly [key: string]: Json } | undefined, id: number | undefined): Promise<Answer> {
    const t = this.#target;
    const extra = (await this.#options.headers?.(t)) ?? {};
    const headers: Record<string, string> = {};
    for (const [name, value] of Object.entries(extra)) {
      if (!HEADER_NAME.test(name) || OWN_HEADERS.test(name) || typeof value !== "string" || /[\r\n]/.test(value)) throw new DomainError("invalid_command", `the MCP transport may not send the header ${name.slice(0, 64)}`, { field: "headers" });
      headers[name] = value;
    }
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body), "utf8");
    const defaultPort = t.secure ? 443 : 80;
    headers["host"] = `${t.host.includes(":") ? `[${t.host}]` : t.host}${t.port === defaultPort ? "" : `:${t.port}`}`;
    headers["accept"] = "application/json, text/event-stream";
    if (payload !== undefined) { headers["content-type"] = "application/json"; headers["content-length"] = String(payload.length); }
    if (this.#session !== undefined) headers["mcp-session-id"] = this.#session;
    if (this.#protocol !== undefined) headers["mcp-protocol-version"] = this.#protocol;
    const timeoutMs = this.#options.timeoutMs ?? MCP_HTTP_LIMITS.timeoutMs;
    const maxBytes = this.#options.maxBytes ?? MCP_HTTP_LIMITS.maxBytes;
    const open = (): Duplex => {
      const plain = this.#options.dial?.({ address: t.address, port: t.port }) ?? netConnect({ host: t.address, port: t.port });
      if (!t.secure) return plain;
      // The certificate is checked against the name, never against the address (an address literal is checked as itself and sent no server name).
      return tlsConnect({ socket: plain, host: t.host, ...(isIP(t.host) === 0 ? { servername: t.host } : {}), ALPNProtocols: ["http/1.1"], ...(this.#options.ca === undefined ? {} : { ca: this.#options.ca as string[] }) });
    };
    return new Promise<Answer>((resolve, reject) => {
      let settled = false;
      const done = (error: Error | undefined, answer?: Answer): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        req.destroy();
        if (error !== undefined) reject(error instanceof DomainError ? error : unavailable(t, error.message)); else resolve(answer!);
      };
      const req = httpRequest({ method, path: t.path, headers, createConnection: open as never, timeout: timeoutMs }, (res) => {
        const status = res.statusCode ?? 0;
        if (status >= 300 && status < 400) { done(unavailable(t, `the server redirected (HTTP ${status}); a redirect is not followed`)); return; }
        const type = String(res.headers["content-type"] ?? "").toLowerCase();
        const stream = type.startsWith("text/event-stream");
        const chunks: Buffer[] = [];
        let size = 0;
        let pending = "";
        res.on("data", (chunk: Buffer) => {
          size += chunk.length;
          if (size > maxBytes) { done(unavailable(t, `the answer is longer than ${maxBytes} bytes`)); return; }
          if (!stream) { chunks.push(chunk); return; }
          // An event stream: the answer is the first message with this request's id; anything else on it (the server's own notices or requests) is not acted on.
          pending += chunk.toString("utf8");
          const events = pending.replace(/\r\n?/g, "\n").split("\n\n");
          pending = events.pop() ?? "";
          for (const event of events) {
            const data = event.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).replace(/^ /, "")).join("\n");
            if (data === "") continue;
            const message = parse(data);
            if (message !== undefined && id !== undefined && message["id"] === id && (message["result"] !== undefined || message["error"] !== undefined)) { done(undefined, { status, headers: res.headers, message }); return; }
          }
        });
        res.on("end", () => {
          if (stream) { done(id === undefined ? undefined : unavailable(t, "the event stream ended without the answer"), { status, headers: res.headers }); return; }
          const text = Buffer.concat(chunks).toString("utf8");
          if (id === undefined || status < 200 || status >= 300 || text.trim() === "") { done(undefined, { status, headers: res.headers }); return; }
          if (!type.startsWith("application/json")) { done(unavailable(t, `the server answered with ${type.slice(0, 60) || "no content type"}, not JSON or an event stream`)); return; }
          const parsed = parseAny(text);
          const message = Array.isArray(parsed) ? parsed.find((m) => isObject(m) && m["id"] === id) : parsed;
          if (!isObject(message) || message["id"] !== id) { done(unavailable(t, "the answer is not a JSON-RPC response to the request")); return; }
          done(undefined, { status, headers: res.headers, message });
        });
        res.on("error", (error) => done(error));
      });
      const timer = setTimeout(() => done(unavailable(t, `no answer within ${timeoutMs} ms`)), timeoutMs);
      req.on("timeout", () => done(unavailable(t, `no answer within ${timeoutMs} ms`)));
      req.on("error", (error) => done(error));
      req.end(payload);
    });
  }
}

const isObject = (v: unknown): v is { readonly [key: string]: Json } => v !== null && typeof v === "object" && !Array.isArray(v);
const parseAny = (text: string): unknown => { try { return JSON.parse(text) as unknown; } catch { return undefined; } };
const parse = (text: string): { readonly [key: string]: Json } | undefined => { const v = parseAny(text); return isObject(v) ? v : undefined; };

/** What a remote tool answered (the MCP `tools/call` result). The content is the server's: data, never instructions. */
export interface RemoteToolResult { readonly content: readonly Json[]; readonly isError: boolean; readonly structuredContent?: Json }

/**
 * Speaks MCP to approved remote servers, only through the connector (card H12k): every call asks where the server is now (a revoked server gets no connection), checks the name's addresses and connects to the checked
 * one. One call is one session: initialize at the pinned revision, the request, the end of the session.
 */
export class RemoteMcpClient {
  readonly #connector: Pick<RemoteMcpConnector, "connect">;
  readonly #options: McpHttpOptions;
  constructor(connector: Pick<RemoteMcpConnector, "connect">, options: McpHttpOptions = {}) { this.#connector = connector; this.#options = options; }

  /** One request to the server; its result object. */
  async request(serverId: string, method: string, params: { readonly [key: string]: Json } = {}): Promise<{ readonly [key: string]: Json }> {
    if (typeof method !== "string" || !/^[A-Za-z][A-Za-z0-9/_.-]{0,99}$/.test(method) || method === "initialize" || method.startsWith("notifications/")) throw new DomainError("invalid_command", "method: must be an MCP request method other than initialize", { field: "method" });
    return this.#connector.connect(serverId, async (target) => {
      const session = new McpHttpSession(target, this.#options);
      await session.open();
      try { return await session.request(method, params); } finally { await session.close(); }
    });
  }

  /** Calls one tool. A tool that reports an error (`isError`) is an answer, not a refusal: the caller frames it as the server's words. */
  async callTool(serverId: string, name: string, args: { readonly [key: string]: Json } = {}): Promise<RemoteToolResult> {
    if (typeof name !== "string" || name.length === 0 || name.length > 128) throw new DomainError("invalid_command", "name: must be a tool name", { field: "name" });
    const result = await this.request(serverId, "tools/call", { name, arguments: args });
    const content = result["content"];
    if (!Array.isArray(content)) throw new DomainError("unavailable", "the MCP server's tool answer has no content list");
    return { content: content as readonly Json[], isError: result["isError"] === true, ...(result["structuredContent"] === undefined ? {} : { structuredContent: result["structuredContent"] }) };
  }

  /** The tools the server offers now (for the catalogue check): the first page only; a server that pages its list (`nextCursor`) is not followed further here. */
  async listTools(serverId: string): Promise<readonly { readonly [key: string]: Json }[]> {
    const tools = (await this.request(serverId, "tools/list"))["tools"];
    if (!Array.isArray(tools)) throw new DomainError("unavailable", "the MCP server's tool list is not a list");
    return tools.filter(isObject);
  }
}
