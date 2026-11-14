import http from "node:http";
import type { AddressInfo } from "node:net";

/**
 * A loopback stand-in for an off-machine backup store (card K01c tests only): it speaks the protocol of `HttpDriver` and keeps everything in memory. `down` makes it refuse every connection (an unreachable target),
 * `token` is the bearer token it wants, `failPuts` makes uploads fail halfway (a copy that never commits must never be listed).
 */
export interface FakeTarget {
  readonly url: string;
  readonly store: Map<string, Map<string, Buffer>>;
  /** Names that began an upload and never committed. */
  readonly pending: Map<string, Map<string, Buffer>>;
  readonly requests: string[];
  down: boolean;
  failPuts: boolean;
  token: string | undefined;
  close(): Promise<void>;
}

export async function startFakeTarget(token: string | undefined = "t0ken"): Promise<FakeTarget> {
  const store = new Map<string, Map<string, Buffer>>();
  const pending = new Map<string, Map<string, Buffer>>();
  const state: { down: boolean; failPuts: boolean; token: string | undefined; requests: string[] } = { down: false, failPuts: false, token, requests: [] };
  const sockets = new Set<import("node:net").Socket>();
  const server = http.createServer((req, res) => {
    state.requests.push(`${req.method} ${req.url}`);
    if (state.down) { req.socket.destroy(); return; }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const send = (status: number, body?: unknown): void => { res.statusCode = status; if (body === undefined) res.end(); else if (Buffer.isBuffer(body)) res.end(body); else res.end(JSON.stringify(body)); };
      if (state.token !== undefined && req.headers.authorization !== `Bearer ${state.token}`) return send(401);
      const parts = new URL(req.url ?? "/", "http://x").pathname.split("/").filter((p) => p !== "").map(decodeURIComponent);
      const body = Buffer.concat(chunks);
      if (parts[0] === "status") return send(200, { ok: true, freeBytes: 1_000_000_000 });
      if (parts[0] !== "backups") return send(404);
      if (parts.length === 1 && req.method === "GET") return send(200, { backups: [...store.keys()] });
      const name = parts[1]!;
      if (parts.length === 2 && req.method === "GET") { const f = store.get(name); return f === undefined ? send(404) : send(200, { files: [...f.keys()].sort() }); }
      if (parts.length === 2 && req.method === "DELETE") { const had = store.delete(name); pending.delete(name); return send(had ? 200 : 404, had ? { removed: true } : undefined); }
      if (parts.length === 3 && parts[2] === "commit" && req.method === "POST") { const p = pending.get(name); if (p === undefined) return send(404); store.set(name, p); pending.delete(name); return send(200, { ok: true }); }
      if (req.method === "GET") { const b = store.get(name)?.get(parts.slice(2).join("/")); return b === undefined ? send(404) : send(200, b); }
      if (req.method === "PUT") {
        if (state.failPuts) { req.socket.destroy(); return; }
        const p = pending.get(name) ?? new Map<string, Buffer>(); pending.set(name, p); p.set(parts.slice(2).join("/"), body); return send(200, { ok: true });
      }
      return send(405);
    });
  });
  server.on("connection", (s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
  return {
    url, store, pending, requests: state.requests,
    get down() { return state.down; }, set down(v: boolean) { state.down = v; },
    get failPuts() { return state.failPuts; }, set failPuts(v: boolean) { state.failPuts = v; },
    get token() { return state.token; }, set token(v: string | undefined) { state.token = v; },
    close: () => new Promise<void>((done) => { for (const s of sockets) s.destroy(); server.close(() => done()); }),
  };
}
