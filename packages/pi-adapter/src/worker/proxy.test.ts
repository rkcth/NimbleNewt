import assert from "node:assert/strict";
import { createServer as httpServer, request, type Server as HttpServer } from "node:http";
import { connect, createServer, type Server, type Socket } from "node:net";
import { test } from "node:test";
import type { FromChild } from "@nimblenewt/contracts";
import { PROXY_LIMITS, startProxy, type Proxy } from "./proxy.js";

/** Waits for a condition, never a fixed pause. */
async function until(label: string, check: () => boolean, ms = 20_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 5)); }
}
const listen = (server: Server | HttpServer): Promise<number> => new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));

/** The host's half, played here: each `net.open` is answered by the test's rule, and a connection that is let through goes to a local server. */
function fakeHost(target: () => number, rule: (host: string, port: number) => "open" | "ignore" | string) {
  const sockets = new Map<number, Socket>(); const opened: Array<{ host: string; port: number }> = []; const closedIds: number[] = []; const endedIds: number[] = []; const acks = { pieces: 0, max: 0, inflight: 0, inflightMax: 0 };
  let proxy!: Proxy;
  const send = (m: FromChild): void => {
    queueMicrotask(() => {
      switch (m.t) {
        case "net.open": {
          opened.push({ host: m.host, port: m.port });
          const verdict = rule(m.host, m.port);
          if (verdict === "ignore") return;
          if (verdict !== "open") { proxy.accept({ t: "net.refused", id: m.id, message: verdict }); return; }
          const s = connect({ host: "127.0.0.1", port: target() });
          sockets.set(m.id, s);
          s.on("error", () => undefined);
          s.once("connect", () => proxy.accept({ t: "net.opened", id: m.id }));
          s.on("data", (d) => { s.pause(); proxy.accept({ t: "net.data", id: m.id, data: d.toString("base64") }); });
          s.on("end", () => proxy.accept({ t: "net.close", id: m.id }));
          return;
        }
        case "net.data": { acks.pieces++; acks.inflight++; acks.inflightMax = Math.max(acks.inflightMax, acks.inflight); acks.max = Math.max(acks.max, Buffer.from(m.data, "base64").length); sockets.get(m.id)?.write(Buffer.from(m.data, "base64"), () => setImmediate(() => { acks.inflight--; proxy.accept({ t: "net.ack", id: m.id }); })); return; }
        case "net.ack": sockets.get(m.id)?.resume(); return;
        case "net.end": endedIds.push(m.id); sockets.get(m.id)?.end(); return;
        case "net.close": closedIds.push(m.id); sockets.get(m.id)?.destroy(); return;
        default: return;
      }
    });
  };
  return { send, attach: (p: Proxy) => { proxy = p; }, sockets, opened, closedIds, endedIds, acks, stop: () => { for (const s of sockets.values()) s.destroy(); } };
}

async function rig(rule: (host: string, port: number) => "open" | "ignore" | string = () => "open") {
  const echo = createServer((s) => { s.on("error", () => undefined); s.pipe(s); });
  const web = httpServer((req, res) => { res.setHeader("x-seen-host", String(req.headers["host"])); res.end(`hello ${req.method} ${req.url}`); });
  const echoPort = await listen(echo); const webPort = await listen(web);
  let which = echoPort;
  const host = fakeHost(() => which, rule);
  const proxy = startProxy({ port: 0, send: host.send });
  host.attach(proxy);
  const port = await proxy.listening;
  return { port, proxy, host, useWeb: () => { which = webPort; }, stop: async () => { proxy.close("test over"); host.stop(); echo.close(); web.close(); web.closeAllConnections(); } };
}
const connectVia = (port: number, target: string): Promise<{ status: number; socket: Socket; body: string }> => new Promise((resolve, reject) => {
  const req = request({ host: "127.0.0.1", port, method: "CONNECT", path: target });
  req.on("connect", (res, socket, head) => { let body = head.toString(); if (res.statusCode !== 200) { socket.on("data", (d) => { body += d; }); socket.on("end", () => resolve({ status: res.statusCode ?? 0, socket, body })); socket.on("close", () => resolve({ status: res.statusCode ?? 0, socket, body })); } else resolve({ status: 200, socket, body }); });
  req.on("response", (res) => { let body = ""; res.on("data", (d) => { body += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, socket: res.socket, body })); });
  req.on("error", reject); req.end();
});

test("the proxy tunnels CONNECT through the host's messages, in pieces no larger than the limit, each acknowledged before the next", async () => {
  const r = await rig();
  try {
    const { status, socket } = await connectVia(r.port, "docs.example.com:443");
    assert.equal(status, 200);
    const payload = Buffer.alloc(PROXY_LIMITS.chunkBytes * 3 + 123, 7);
    const got: Buffer[] = []; socket.on("data", (d) => got.push(d));
    socket.write(payload);
    await until("the echo", () => Buffer.concat(got).length === payload.length);
    assert.ok(Buffer.concat(got).equals(payload));
    assert.deepEqual(r.host.opened, [{ host: "docs.example.com", port: 443 }]);
    assert.equal(r.host.acks.inflightMax, 1, "the next piece is sent only after the host acknowledged the last");
    assert.ok(r.host.acks.pieces >= 4 && r.host.acks.max <= PROXY_LIMITS.chunkBytes, `pieces ${r.host.acks.pieces}, largest ${r.host.acks.max}`);
    // The client's end of its half is passed on as the end of the host's half (the target decides when the connection is over: it closes, or the relay's idle limit does).
    socket.end();
    await until("the host told the client is done", () => r.host.endedIds.length === 1);
    await until("the target closing ends the client's side", () => socket.destroyed || socket.readableEnded);
  } finally { await r.stop(); }
});

test("a refusal by the host reaches the client as 403 with the host's reason; a bad target or a non-http address is refused by the proxy itself", async () => {
  const r = await rig((host) => host === "blocked.example.com" ? "the task holds no grant for that destination" : "open");
  try {
    const refused = await connectVia(r.port, "blocked.example.com:443");
    assert.equal(refused.status, 403); assert.match(refused.body, /no grant for that destination/);
    for (const bad of ["no-port", "host:0", "host:70000", ":443", "a/b:443", "x".repeat(400) + ":443"]) assert.equal((await connectVia(r.port, bad)).status, 400, bad);
    const direct = await new Promise<{ status: number; text: string }>((resolve, reject) => { const q = request({ host: "127.0.0.1", port: r.port, path: "/just-a-path" }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, text })); }); q.on("error", reject); q.end(); });
    assert.equal(direct.status, 400);
    const https = await new Promise<number>((resolve, reject) => { const q = request({ host: "127.0.0.1", port: r.port, path: "https://x.example.com/" }, (res) => { res.resume(); resolve(res.statusCode ?? 0); }); q.on("error", reject); q.end(); });
    assert.equal(https, 400);
    assert.equal(r.host.opened.length, 1, "only the well-formed CONNECT reached the host");
  } finally { await r.stop(); }
});

test("a plain http request through the proxy reaches the host as an open to the named host and port, and the answer comes back without hop headers", async () => {
  const r = await rig(); r.useWeb();
  try {
    const out = await new Promise<{ status: number; text: string; seen: string | undefined; hop: string | undefined }>((resolve, reject) => {
      const q = request({ host: "127.0.0.1", port: r.port, method: "GET", path: "http://site.example.org:8080/a/b?c=d", headers: { host: "site.example.org:8080", "proxy-connection": "keep-alive" } }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, text, seen: res.headers["x-seen-host"] as string | undefined, hop: res.headers["proxy-connection"] as string | undefined })); });
      q.on("error", reject); q.end();
    });
    assert.equal(out.status, 200); assert.equal(out.text, "hello GET /a/b?c=d"); assert.equal(out.seen, "site.example.org:8080");
    assert.deepEqual(r.host.opened, [{ host: "site.example.org", port: 8080 }]);
  } finally { await r.stop(); }
});

test("a refused plain http request is 403 with the reason; the number of open connections is bounded; close ends the open ones", async () => {
  const r = await rig((host) => host === "ignored.example.com" ? "ignore" : host === "no.example.com" ? "no grant" : "open");
  try {
    const refused = await new Promise<{ status: number; text: string }>((resolve, reject) => { const q = request({ host: "127.0.0.1", port: r.port, path: "http://no.example.com/" }, (res) => { let text = ""; res.on("data", (d) => { text += d; }); res.on("end", () => resolve({ status: res.statusCode ?? 0, text })); }); q.on("error", reject); q.end(); });
    assert.equal(refused.status, 403); assert.match(refused.text, /no grant/);
    // The host never answers: sixteen connections wait, the seventeenth is refused at once.
    const waiting: Socket[] = [];
    for (let i = 0; i < PROXY_LIMITS.open; i++) { const s = connect({ port: r.port, host: "127.0.0.1" }); s.on("error", () => undefined); s.write("CONNECT ignored.example.com:443 HTTP/1.1\r\nHost: x\r\n\r\n"); waiting.push(s); }
    await until("sixteen opens reach the host", () => r.host.opened.filter((o) => o.host === "ignored.example.com").length === PROXY_LIMITS.open);
    const over = await connectVia(r.port, "ignored.example.com:443");
    assert.equal(over.status, 503); assert.match(over.body, /too many/);
    r.proxy.close("the attempt ended");
    await until("every open one told to close", () => r.host.closedIds.length >= PROXY_LIMITS.open);
    const again = await connectVia(r.port, "x.example.com:443").catch(() => ({ status: 0 }));
    assert.notEqual(again.status, 200);
    for (const s of waiting) s.destroy();
  } finally { await r.stop(); }
});
