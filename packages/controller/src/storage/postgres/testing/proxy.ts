import net from "node:net";

export interface ProxyFault {
  /** The fault fires on the first client message whose bytes (read as latin-1) match this. */
  readonly match: RegExp;
  /**
   * `before`: close both sides without forwarding the message, so the server never sees it.
   * `after`: forward the message, let the server process it, then close the client side without delivering the answer, so
   * the client cannot tell whether the statement took effect.
   */
  readonly when: "before" | "after";
}

/** A TCP relay between a client and a PostgreSQL server that can cut a connection at an exact statement. */
export class FaultProxy {
  readonly #server: net.Server;
  readonly #faults: ProxyFault[] = [];
  readonly #sockets = new Set<net.Socket>();
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

  /** Queue a fault; faults fire in the order queued, each once. */
  inject(fault: ProxyFault): void { this.#faults.push(fault); }
  get pending(): number { return this.#faults.length; }

  #relay(client: net.Socket, target: { host: string; port: number }): void {
    const upstream = net.connect(target.port, target.host);
    this.#sockets.add(client).add(upstream);
    let dropNextAnswer = false;
    const closeBoth = () => { client.destroy(); upstream.destroy(); };
    client.on("error", closeBoth);
    upstream.on("error", closeBoth);
    client.on("close", () => upstream.destroy());
    upstream.on("close", () => client.destroy());
    client.on("data", (chunk: Buffer) => {
      const next = this.#faults[0];
      if (next !== undefined && next.match.test(chunk.toString("latin1"))) {
        this.#faults.shift();
        this.fired += 1;
        if (next.when === "before") return closeBoth();
        dropNextAnswer = true;
      }
      upstream.write(chunk);
    });
    upstream.on("data", (chunk: Buffer) => {
      if (dropNextAnswer) {
        // The statement ran; the client never learns the result. Let the server finish, then cut the client.
        dropNextAnswer = false;
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
