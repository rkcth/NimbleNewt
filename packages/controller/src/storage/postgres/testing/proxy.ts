import net from "node:net";

export interface ProxyFault {
  /** The fault fires on the first client message (a Query, or the Parse of a prepared statement) whose bytes, read as latin-1, match this. */
  readonly match: RegExp;
  /**
   * `before`: close both sides without forwarding the message, so the server never sees it.
   * `after`: forward the whole statement, let the server process it, then close the client side without delivering the answer, so
   * the client cannot tell whether the statement took effect.
   */
  readonly when: "before" | "after";
}

/** Cut the connection at the Nth statement (counted from `arm`): see `ProxyFault.when` for the two modes. */
export interface OrdinalFault { readonly when: "before" | "after"; readonly ordinal: number }

/**
 * A TCP relay between a client and a PostgreSQL server that understands enough of the wire protocol to see statement
 * boundaries (simple Query messages, and the Parse ... Sync sequence of a prepared statement), so a connection can be cut
 * before or after an exact statement, by pattern or by position.
 */
export class FaultProxy {
  readonly #server: net.Server;
  readonly #faults: ProxyFault[] = [];
  readonly #sockets = new Set<net.Socket>();
  #ordinalFault: (OrdinalFault & { fired: boolean }) | undefined;
  /** Statements seen since the last `arm`/`resetCount`. */
  statements = 0;
  fired = 0;
  port = 0;

  private constructor(server: net.Server) { this.#server = server; }

  static async start(target: { host: string; port: number }): Promise<FaultProxy> {
    const proxy = new FaultProxy(net.createServer());
    proxy.#server.on("connection", (client) => proxy.#relay(client, target));
    await new Promise<void>((resolve, reject) => { proxy.#server.on("error", reject); proxy.#server.listen(0, "127.0.0.1", () => resolve()); });
    proxy.port = (proxy.#server.address() as net.AddressInfo).port;
    return proxy;
  }

  /** Queue a pattern fault; faults fire in the order queued, each once. */
  inject(fault: ProxyFault): void { this.#faults.push(fault); }
  get pending(): number { return this.#faults.length + (this.#ordinalFault !== undefined && !this.#ordinalFault.fired ? 1 : 0); }

  /** Start counting statements from zero and, if given, cut at the Nth one. */
  arm(fault?: OrdinalFault): void {
    this.statements = 0;
    this.#ordinalFault = fault === undefined ? undefined : { ...fault, fired: false };
  }

  #relay(client: net.Socket, target: { host: string; port: number }): void {
    const upstream = net.connect(target.port, target.host);
    this.#sockets.add(client).add(upstream);
    let buffer = Buffer.alloc(0);
    let startupDone = false;
    let inPrepared = false;
    let dropAnswer = false;
    let pendingAfter = false;
    const closeBoth = () => { client.destroy(); upstream.destroy(); };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());

    client.on("data", (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);
      for (;;) {
        // Startup (and SSL request) messages have no type byte; everything after has one.
        const header = startupDone ? 5 : 4;
        if (buffer.length < header) return;
        const length = startupDone ? buffer.readInt32BE(1) + 1 : buffer.readInt32BE(0);
        if (buffer.length < length) return;
        const message = buffer.subarray(0, length);
        buffer = buffer.subarray(length);
        if (!startupDone) { startupDone = true; upstream.write(message); continue; }
        const type = String.fromCharCode(message[0]!);
        const startsStatement = type === "Q" || (type === "P" && !inPrepared);
        const endsStatement = type === "Q" || type === "S";
        if (type === "P") inPrepared = true;
        if (startsStatement) {
          this.statements += 1;
          const fault = this.#ordinalFault;
          if (fault !== undefined && !fault.fired && fault.ordinal === this.statements) {
            fault.fired = true;
            this.fired += 1;
            if (fault.when === "before") return closeBoth();
            pendingAfter = true;
          }
        }
        const next = this.#faults[0];
        if (next !== undefined && (type === "Q" || type === "P") && next.match.test(message.toString("latin1"))) {
          this.#faults.shift();
          this.fired += 1;
          if (next.when === "before") return closeBoth();
          pendingAfter = true;
        }
        upstream.write(message);
        if (endsStatement) {
          inPrepared = false;
          if (pendingAfter) { pendingAfter = false; dropAnswer = true; }
        }
      }
    });
    upstream.on("data", (chunk: Buffer) => {
      if (dropAnswer) {
        // The statement ran; the client never learns the result.
        dropAnswer = false;
        client.destroy();
        return;
      }
      client.write(chunk);
    });
  }

  async stop(): Promise<void> {
    for (const socket of this.#sockets) socket.destroy();
    await new Promise<void>((resolve) => this.#server.close(() => resolve()));
  }
}
