import { createServer, request as httpRequest, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { Duplex } from "node:stream";
import { safeText, type FromChild, type ToChild } from "@nimblenewt/contracts";

/**
 * The proxy forwarder of the worker process (card H12i). The sandbox has no network interface, only its own loopback; this serves an HTTP proxy there (`CONNECT host:port` for https and anything else, and plain `http://` requests), and carries every
 * connection over the worker channel to the host, whose network relay connects only for a destination the task holds a grant for. A client in the sandbox (a command-line tool, a browser, a package manager) reaches a granted destination by
 * using the proxy (the environment's `HTTP_PROXY` and `HTTPS_PROXY` name it) and fails against any other: the proxy answers 403 with the host's reason. The forwarder holds no credential, no list of allowed destinations and no way out of its own; the
 * host decides every connection, at the moment it is made and while it is open.
 *
 * Flow control is one piece at a time in each direction: a piece goes out only after the other side said it wrote the last one (`net.ack`), so a fast sender cannot fill the channel or the process's memory.
 */

export const PROXY_LIMITS = { chunkBytes: 32 * 1024, open: 16, openWaitMs: 60_000 } as const;
const HOP = new Set(["connection", "proxy-connection", "proxy-authorization", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "host"]);

export interface Proxy {
  /** Feeds a message from the host that belongs to a connection of the proxy. Returns false for any other message. */
  accept(message: ToChild): boolean;
  /** The proxy is listening (resolves with the port). */
  readonly listening: Promise<number>;
  /** Stops accepting connections and ends every open one. */
  close(why: string): void;
}

/** A connection to the host's relay, as a stream. Writes wait for the host's `net.ack` of the piece before the next goes; reads give what the host sends and ack each piece once it is read. */
class Tunnel extends Duplex {
  readonly #send: (m: FromChild) => void;
  readonly #id: number;
  readonly #forget: () => void;
  #open: { resolve: () => void; reject: (e: Error) => void } | undefined;
  readonly opened: Promise<void>;
  #ack: (() => void) | undefined;
  #owedAck = false;
  #remoteClosed = false;

  constructor(id: number, send: (m: FromChild) => void, forget: () => void) {
    super({ allowHalfOpen: true });
    this.#id = id; this.#send = send; this.#forget = forget;
    this.opened = new Promise<void>((resolve, reject) => { this.#open = { resolve, reject }; });
    this.opened.catch(() => undefined);
  }

  /** The host's answers. */
  onOpened(): void { this.#open?.resolve(); this.#open = undefined; }
  onRefused(message: string): void { this.#open?.reject(new Error(message)); this.#open = undefined; this.#remoteClosed = true; this.destroy(new Error(message)); }
  onData(bytes: Buffer): void {
    // The host sends the next piece only when told this one was read: it is acked at once if the buffer has room, else when it is read.
    if (this.push(bytes)) this.#send({ t: "net.ack", id: this.#id });
    else this.#owedAck = true;
  }
  onAck(): void { const a = this.#ack; this.#ack = undefined; a?.(); }
  onClose(message?: string): void { this.#remoteClosed = true; this.#open?.reject(new Error(message ?? "closed")); this.#open = undefined; this.#ack?.(); this.#ack = undefined; this.push(null); }

  override _read(): void { if (this.#owedAck) { this.#owedAck = false; this.#send({ t: "net.ack", id: this.#id }); } }

  override _write(chunk: Buffer, _encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    void (async () => {
      try {
        await this.opened;
        for (let at = 0; at < chunk.length; at += PROXY_LIMITS.chunkBytes) {
          if (this.#remoteClosed) throw new Error("the connection is closed");
          const waiting = new Promise<void>((resolve) => { this.#ack = resolve; });
          this.#send({ t: "net.data", id: this.#id, data: chunk.subarray(at, at + PROXY_LIMITS.chunkBytes).toString("base64") });
          await waiting;
        }
        callback();
      } catch (error) { callback(error instanceof Error ? error : new Error("write failed")); }
    })();
  }

  override _final(callback: (error?: Error | null) => void): void {
    if (!this.#remoteClosed) this.#send({ t: "net.end", id: this.#id });
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    if (!this.#remoteClosed) { this.#remoteClosed = true; this.#send({ t: "net.close", id: this.#id }); }
    this.#ack?.(); this.#ack = undefined;
    this.#forget();
    callback(error);
  }
}

/** `host:port` of a CONNECT target (an IPv6 address is in brackets), or undefined. */
function connectTarget(text: string | undefined): { host: string; port: number } | undefined {
  if (text === undefined || text.length > 300) return undefined;
  const m = /^(?:\[([0-9a-fA-F:.]+)\]|([^:\[\]\s/]+)):(\d{1,5})$/.exec(text);
  if (m === null) return undefined;
  const port = Number(m[3]);
  return port >= 1 && port <= 65535 ? { host: (m[1] ?? m[2])!, port } : undefined;
}

const reply = (socket: Socket, status: string, text: string): void => {
  const body = safeText(text, 500);
  socket.end(`HTTP/1.1 ${status}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
};

export function startProxy(options: { readonly port: number; readonly send: (message: FromChild) => void; readonly host?: string }): Proxy {
  const tunnels = new Map<number, Tunnel>();
  let next = 0;
  let closed: string | undefined;
  const open = (host: string, port: number): Tunnel | string => {
    if (closed !== undefined) return closed;
    if (tunnels.size >= PROXY_LIMITS.open) return "too many connections are open";
    const id = ++next;
    const tunnel = new Tunnel(id, options.send, () => { tunnels.delete(id); });
    // A refusal destroys the tunnel with the reason as its error; whoever uses the tunnel hears it through `opened` or its own listener, and one that is not listening yet must not crash the process.
    tunnel.on("error", () => undefined);
    tunnels.set(id, tunnel);
    const timer = setTimeout(() => tunnel.destroy(new Error("the host did not answer")), PROXY_LIMITS.openWaitMs);
    timer.unref?.();
    void tunnel.opened.then(() => clearTimeout(timer), () => clearTimeout(timer));
    options.send({ t: "net.open", id, host, port });
    return tunnel;
  };

  const server: Server = createServer();
  server.on("connect", (req: IncomingMessage, client: Socket, head: Buffer) => {
    client.on("error", () => undefined);
    const target = connectTarget(req.url);
    if (target === undefined) return reply(client, "400 Bad Request", "CONNECT needs host:port");
    const t = open(target.host, target.port);
    if (typeof t === "string") return reply(client, "503 Service Unavailable", t);
    t.opened.then(() => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (head.length > 0) t.write(head);
      client.pipe(t); t.pipe(client);
      client.on("close", () => t.destroy());
      t.on("close", () => client.destroy());
      t.on("error", () => client.destroy());
    }, (error: unknown) => reply(client, "403 Forbidden", error instanceof Error ? error.message : "refused"));
  });
  server.on("request", (req: IncomingMessage, res: ServerResponse) => {
    const fail = (status: number, text: string): void => { if (!res.headersSent) { res.writeHead(status, { "content-type": "text/plain; charset=utf-8", connection: "close" }); } res.end(safeText(text, 500)); };
    let url: URL;
    try { url = new URL(req.url ?? ""); } catch { return fail(400, "this is a proxy: send an absolute http:// address"); }
    if (url.protocol !== "http:") return fail(400, "this proxy takes plain http:// requests and CONNECT; https goes through CONNECT");
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const port = url.port === "" ? 80 : Number(url.port);
    const t = open(host, port);
    if (typeof t === "string") return fail(503, t);
    const headers: Record<string, string | string[]> = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k) && v !== undefined) headers[k] = v;
    headers["host"] = url.host;
    headers["connection"] = "close";
    const out = httpRequest({ method: req.method ?? "GET", path: `${url.pathname}${url.search}`, headers, createConnection: () => t as unknown as Socket });
    out.on("response", (upstream) => {
      const kept: Record<string, string | string[]> = {};
      for (const [k, v] of Object.entries(upstream.headers)) if (!HOP.has(k) && v !== undefined) kept[k] = v;
      res.writeHead(upstream.statusCode ?? 502, kept);
      upstream.pipe(res);
    });
    out.on("error", (error: Error) => fail(/grant|refus|no grant|task|destination|resolve/i.test(error.message) ? 403 : 502, error.message));
    res.on("close", () => { if (!out.destroyed) out.destroy(); });
    req.pipe(out);
  });
  server.on("clientError", (_e, socket) => { try { socket.destroy(); } catch { /* gone */ } });
  const listening = new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host ?? "127.0.0.1", () => resolve((server.address() as { port: number }).port));
  });
  listening.catch(() => undefined);

  return {
    listening,
    accept(m) {
      switch (m.t) {
        case "net.opened": tunnels.get(m.id)?.onOpened(); return true;
        case "net.refused": tunnels.get(m.id)?.onRefused(m.message); return true;
        case "net.data": tunnels.get(m.id)?.onData(Buffer.from(m.data, "base64")); return true;
        case "net.ack": tunnels.get(m.id)?.onAck(); return true;
        case "net.close": tunnels.get(m.id)?.onClose(m.message); return true;
        default: return false;
      }
    },
    close(why) {
      closed ??= why;
      server.close();
      server.closeAllConnections?.();
      for (const t of [...tunnels.values()]) t.destroy(new Error(why));
    },
  };
}
