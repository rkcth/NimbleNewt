// Card L04g: a resume check reads a task's recorded external and MCP resources again, only where the owner allowed it, with one bounded request per resource, so each reads changed or unchanged (or
// deleted) instead of unknown; what is not read is unknown with the reason. Offline: the resources are stand-in servers on loopback, reached through the real guarded readers (the web tool's
// admission and the MCP connector), and the records are kept on each storage backend.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createServer as createHttpsServer } from "node:https";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as netConnect, createServer as createNetServer, type Socket } from "node:net";
import { gzipSync } from "node:zlib";
import { after, test } from "node:test";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { McpService, RemoteMcpClient, RemoteMcpConnector } from "../mcp/index.js";
import { NetworkGrantService, WebFetch } from "../network/index.js";
import { PrincipalService } from "../security/index.js";
import { selfSigned } from "../transport/testing/selfsigned.js";
import { DependencyService, mcpContentsHash, resourceReader, type ManifestBody } from "./index.js";

after(stopServer);
const options = { clock: () => "2026-11-17T10:00:00.000Z", pause: async () => undefined };
const PUBLIC = "93.184.216.34";
const SDK = { name: "@modelcontextprotocol/sdk", version: "1.12.0" };
const SECRET = ["t", "o", "k", "-"].join("") + "zzzz9999".repeat(4);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

interface Page { text: string; etag?: string; status?: number; hang?: boolean }
async function web(pages: Record<string, Page>) {
  const seen: IncomingMessage[] = [];
  const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
    seen.push(req);
    const p = pages[req.url ?? ""];
    if (p === undefined) { res.writeHead(404); res.end(); return; }
    if (p.hang === true) return;
    if (p.status !== undefined) { res.writeHead(p.status, p.status >= 300 && p.status < 400 ? { location: "http://169.254.169.254/" } : {}); res.end(); return; }
    if (p.etag !== undefined && req.headers["if-none-match"] === p.etag) { res.writeHead(304, { etag: p.etag }); res.end(); return; }
    res.writeHead(200, { ...(p.etag === undefined ? {} : { etag: p.etag }), "content-type": "text/plain" });
    res.end(p.text);
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { port: (srv.address() as { port: number }).port, seen, close: () => new Promise<void>((ok) => { srv.closeAllConnections(); srv.close(() => ok()); }) };
}

/** A stand-in MCP server over TLS for `mcp.example.com`: `resources/read` answers the text the test sets. */
async function mcpServer(resources: Record<string, string>) {
  const cert = selfSigned(new Date(), { dns: "mcp.example.com", ip: false });
  const reads: string[] = [];
  const reply = (res: ServerResponse, body: object): void => { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
  const srv = createHttpsServer({ cert: cert.cert, key: cert.key }, (req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const m = chunks.length === 0 ? undefined : JSON.parse(Buffer.concat(chunks).toString("utf8")) as { id?: number; method?: string; params?: { uri?: string } };
      if (m?.method === "initialize") { reply(res, { jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2025-06-18", capabilities: { resources: {} }, serverInfo: { name: "docs", version: "1" } } }); return; }
      if (m?.method === "notifications/initialized") { res.writeHead(202); res.end(); return; }
      if (m?.method === "resources/read") {
        const uri = String(m.params?.uri);
        reads.push(uri);
        const text = resources[uri];
        if (text === undefined) { reply(res, { jsonrpc: "2.0", id: m.id, error: { code: -32002, message: "Resource not found" } }); return; }
        reply(res, { jsonrpc: "2.0", id: m.id, result: { contents: [{ uri, mimeType: "text/plain", text }] } });
        return;
      }
      res.writeHead(400); res.end();
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  return { port: (srv.address() as { port: number }).port, ca: cert.cert, reads, close: () => new Promise<void>((ok) => srv.close(() => ok())) };
}

for (const backend of backends) {
  test(`${backend.name}: external resources are read again only with the owner's switch and the task's grant, once each, conditionally; changed, unchanged, deleted, or unknown with the reason`, async () => {
    const world = await backend.open();
    const pages: Record<string, Page> = { "/a": { text: "alpha", etag: "\"a1\"" }, "/b": { text: "bravo" }, "/gone": { text: "", status: 410 }, "/moved": { text: "", status: 302 }, "/big": { text: "x".repeat(5000) }, "/bad": { text: "", status: 500 }, "/hang": { text: "", hang: true } };
    const site = await web(pages);
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const projectId = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: "T" })).id;
      const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch, options);
      const deps = DependencyService.withEpoch(world.storage, projects.epoch, options);
      const dialed: string[] = [];
      const reader = new WebFetch({ grants, resolve: async (h) => (h === "docs.example.com" ? [PUBLIC] : h === "near.example.com" ? ["10.1.2.3"] : []), dial: (address) => { dialed.push(address); return netConnect({ host: "127.0.0.1", port: site.port }); }, secret: (name) => (name === "docs-token" ? SECRET : undefined) });
      let allowed = false;
      const faults: string[] = [];
      const read = resourceReader({ allowed: async () => allowed, external: reader, limits: { bytes: 1000, ms: 1500 }, onFault: (d) => faults.push(d) });
      const at = (path: string, host = "docs.example.com"): string => `http://${host}${path}`;
      const sha = (t: string): string => (createHashHex(t));
      await deps.record(owner, { commandId: cid("d"), taskId, dependencies: [
        { kind: "external", key: at("/a"), etag: "\"a1\"", freshness: "conditional-read" },
        { kind: "external", key: at("/b"), hash: sha("bravo"), freshness: "authoritative-query" },
        { kind: "external", key: at("/gone"), hash: sha("x"), freshness: "conditional-read" },
        { kind: "external", key: at("/moved"), hash: sha("x"), freshness: "conditional-read" },
        { kind: "external", key: at("/big"), hash: sha("x"), freshness: "conditional-read" },
        { kind: "external", key: at("/bad"), hash: sha("x"), freshness: "conditional-read" },
        { kind: "external", key: at("/x", "near.example.com"), hash: sha("x"), freshness: "conditional-read" },
        { kind: "external", key: at("/none"), hash: sha("x"), freshness: "none" },
      ] });
      const manifest = (await deps.get(owner, taskId))!;
      const check = async (): Promise<Record<string, [string, string]>> => {
        const got = await read(manifest, "resume-check");
        return Object.fromEntries((await deps.check(owner, taskId, got.observations)).map((c) => [c.key.replace(/^http:\/\/[^/]+/, ""), [c.status, c.detail]]));
      };
      // The switch is off: nothing is fetched.
      let r = await check();
      assert.equal(r["/a"]![0], "unknown");
      assert.match(r["/a"]![1], /owner has not allowed/);
      assert.equal(r["/none"]![0], "freshness-uncertain", "a resource recorded without a way to check it is not read");
      assert.equal(site.seen.length, 0);
      // On, but no grant: nothing is fetched either.
      allowed = true;
      r = await check();
      assert.match(r["/a"]![1], /holds no grant/);
      assert.equal(site.seen.length, 0);
      // The owner grants the host (with a credential header) and a private one (without naming private addresses).
      await grants.grant(owner, { commandId: cid("g"), taskId, host: "docs.example.com", port: 80, credential: { header: "x-docs-key", ref: "docs-token" } } as never);
      await grants.grant(owner, { commandId: cid("g"), taskId, host: "near.example.com", port: 80 } as never);
      const before = site.seen.length;
      r = await check();
      assert.deepEqual(r["/a"], ["unchanged", "the same hash or ETag"], "a 304 to the conditional read");
      assert.deepEqual(r["/b"], ["unchanged", "the same hash or ETag"], "the body's hash");
      assert.deepEqual(r["/gone"], ["deleted", "the resource is gone"]);
      assert.match(r["/moved"]![1], /redirect is not followed/);
      assert.match(r["/big"]![1], /larger than the 1000 bytes/);
      assert.match(r["/bad"]![1], /HTTP 500/);
      assert.match(r["/x"]![1], /private or internal address/);
      // One request per resource read (six reachable), the conditional one with its ETag, the grant's header sent, only the checked public address dialled; the redirect target was never asked.
      const asked = site.seen.slice(before);
      assert.deepEqual(asked.map((q) => q.url).sort(), ["/a", "/b", "/bad", "/big", "/gone", "/moved"]);
      assert.equal(asked.find((q) => q.url === "/a")!.headers["if-none-match"], "\"a1\"");
      assert.ok(asked.every((q) => q.headers["x-docs-key"] === SECRET));
      assert.deepEqual([...new Set(dialed)], [PUBLIC]);
      // The connection log has every read as the resume check's, and no secret anywhere it or the check could show.
      const log = await grants.connections(owner, taskId);
      assert.ok(log.some((c) => c.via === "resume-check" && c.host === "docs.example.com"));
      assert.equal(JSON.stringify(log).includes(SECRET), false);
      assert.equal(JSON.stringify(r).includes(SECRET), false);
      assert.equal(faults.join("\n").includes(SECRET), false);
      // The content moves: changed.
      pages["/a"] = { text: "alpha 2", etag: "\"a2\"" }; pages["/b"] = { text: "bravo 2" };
      r = await check();
      assert.deepEqual([r["/a"]![0], r["/b"]![0]], ["changed", "changed"]);
      // A server that does not answer in time leaves the resource unknown, and the check does not wait past the bound.
      await deps.record(owner, { commandId: cid("d"), taskId, dependencies: [{ kind: "external", key: at("/hang"), hash: sha("x"), freshness: "conditional-read" }] });
      const slow = (await deps.get(owner, taskId))!;
      const t0 = Date.now();
      const got = await read(slow, "resume-check");
      assert.ok(Date.now() - t0 < 5000);
      const hung = (await deps.check(owner, taskId, got.observations)).find((c) => c.key.endsWith("/hang"))!;
      assert.deepEqual([hung.status, hung.detail], ["unknown", "it was not read again: the resource did not answer in time"]);
      // At most `reads` resources per observation: the rest are unknown, said so.
      const few = resourceReader({ allowed: async () => true, external: reader, limits: { reads: 2 } });
      const capped = Object.values((await few(manifest, "resume-check")).observations).filter((o) => /more than 2 external/.test(o.unread ?? ""));
      assert.equal(capped.length, 5, "7 readable resources, 2 read");
    } finally { await site.close(); await world.close(); }
  });

  test(`${backend.name}: an MCP resource is read again from an approved remote server only when the owner allowed the resource, over the checked connection; changed or unchanged, else unknown with the reason`, async () => {
    const world = await backend.open();
    const resources: Record<string, string> = { "docs://guide": "Water daily." };
    const s = await mcpServer(resources);
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const projectId = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      const other = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "B" })).id;
      const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: "T" })).id;
      const mcp = McpService.withEpoch(world.storage, projects.epoch, options);
      const deps = DependencyService.withEpoch(world.storage, projects.epoch, options);
      const reg = async (name: string, audience: string, resources: string[]): Promise<string> => (await mcp.register(owner, { commandId: cid("rg"), name, mode: "remote", transport: "streamable-http", protocolRevision: "2025-06-18", sdk: SDK, remote: { url: "https://mcp.example.com/v1", credentialRef: "docs.token", scopes: ["docs:read"] }, audience: [audience], allowed: { resources } } as never)).id;
      const docs = await reg("docs", projectId, ["docs://guide", "docs://gone"]);
      await reg("elsewhere", other, ["docs://guide"]);
      await reg("narrow", projectId, []);
      const service = { id: "service:resume-check", kind: "service", name: "resume-check", grants: [] } as never;
      const dialed: string[] = [];
      const connector = new RemoteMcpConnector({ mcp, resolve: async (h) => (h === "mcp.example.com" ? [PUBLIC] : []), principal: owner });
      const client = new RemoteMcpClient(connector, { ca: s.ca, dial: (to) => { dialed.push(to.address); return netConnect({ host: "127.0.0.1", port: s.port }) as Socket; }, maxBytes: 64_000, timeoutMs: 5_000 });
      const read = resourceReader({ allowed: async () => true, mcp: { readable: (q) => mcp.resumeReadable(service, q), read: (id, uri) => client.readResource(id, uri) } });
      const hashOf = (uri: string, text: string): string => mcpContentsHash([{ uri, mimeType: "text/plain", text }]);
      const dep = (server: string, uri: string, text: string, protocol = "2025-06-18") => ({ kind: "mcp-resource" as const, key: uri, server, protocol, hash: hashOf(uri, text), freshness: "authoritative-query" as const });
      await deps.record(owner, { commandId: cid("d"), taskId, dependencies: [dep("docs", "docs://guide", "Water daily.")] });
      await deps.record(owner, { commandId: cid("d"), taskId, dependencies: [{ ...dep("elsewhere", "docs://other", "x"), key: "docs://other" }, dep("narrow", "docs://n", "x"), dep("ghost", "docs://g", "x"), { ...dep("docs", "docs://gone", "x"), protocol: "2025-03-26" }] });
      const check = async (): Promise<Record<string, [string, string]>> => {
        const manifest = (await deps.get(owner, taskId)) as ManifestBody;
        return Object.fromEntries((await deps.check(owner, taskId, (await read(manifest, "resume-check")).observations)).map((c) => [c.key, [c.status, c.detail]]));
      };
      let r = await check();
      assert.deepEqual(r["docs://guide"], ["unchanged", "the same hash or ETag"]);
      assert.match(r["docs://other"]![1], /not in the audience/);
      assert.match(r["docs://n"]![1], /owner has not allowed reading that resource/);
      assert.match(r["docs://g"]![1], /no MCP server named ghost/);
      assert.match(r["docs://gone"]![1], /pinned to protocol 2025-06-18 now/);
      assert.deepEqual(s.reads, ["docs://guide"], "only the allowed resource was read, once");
      assert.deepEqual([...new Set(dialed)], [PUBLIC]);
      resources["docs://guide"] = "Water twice a day.";
      r = await check();
      assert.equal(r["docs://guide"]![0], "changed");
      // The owner revokes the server: nothing more is read from it.
      const before = s.reads.length;
      await mcp.revoke(owner, { commandId: cid("rv"), serverId: docs, expectedRevision: 1 });
      r = await check();
      assert.match(r["docs://guide"]![1], /MCP server docs is revoked/);
      assert.equal(s.reads.length, before);
    } finally { await s.close(); await world.close(); }
  });
}

function createHashHex(t: string): string { return createHash("sha256").update(t).digest("hex"); }

test("a read that never answers is given up at the observation's bound, whatever the port does about time; a port that throws is a reason, never a throw", async () => {
  const manifest: ManifestBody = { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: "proj-aaaaaaaaaaaaaaaaaaaa", entries: [
    { id: "dpm-a", kind: "mcp-resource", key: "docs://slow", server: "docs", protocol: "2025-06-18", hash: "a".repeat(64), freshness: "authoritative-query", observedAt: "" },
    { id: "dpm-b", kind: "mcp-resource", key: "docs://broken", server: "docs", protocol: "2025-06-18", hash: "a".repeat(64), freshness: "authoritative-query", observedAt: "" },
  ] };
  const read = resourceReader({ allowed: async () => true, limits: { ms: 200 }, mcp: { readable: async () => ({ serverId: "mcs-x", protocol: "2025-06-18" }), read: async (_id, uri) => (uri === "docs://slow" ? await new Promise<never>(() => undefined) : (() => { throw new Error("the server fell over"); })()) } });
  const t0 = Date.now();
  const got = await read(manifest, "resume-check");
  assert.ok(Date.now() - t0 < 2000);
  assert.deepEqual(got.observations["dpm-a"], { unread: "the resource did not answer in time" });
  assert.deepEqual(got.observations["dpm-b"], { unread: "the server fell over" });
  assert.deepEqual(got.texts, {});
});

// A server that answers badly on purpose: the read stays within its bounds and says why, and nothing of a credential (the grant's header, a secret in the address's query) reaches a reason, the log or the faults.
test("a hostile answer is bounded: an endless stream, a drip, a header flood, a compressed or binary body, an oversized ETag; no credential or query secret in any reason, log or fault", async () => {
  const world = await backends[0]!.open();
  const QUERY = ["a", "p", "i", "_", "k", "e", "y", "="].join("") + "QQ77".repeat(8);
  const asked: string[] = [];
  const srv = createNetServer((sock) => {
    let head = "";
    sock.on("error", () => undefined);
    sock.on("data", (d: Buffer) => {
      head += d.toString("latin1");
      if (!head.includes("\r\n\r\n")) return;
      const path = head.split(" ")[1] ?? "";
      asked.push(path);
      if (path === "/endless") {
        sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ntransfer-encoding: chunked\r\n\r\n");
        const t = setInterval(() => { if (sock.destroyed) { clearInterval(t); return; } sock.write(`400\r\n${"y".repeat(1024)}\r\n`); }, 1);
        sock.on("close", () => clearInterval(t));
      } else if (path === "/drip") {
        sock.write("HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-length: 100\r\n\r\n");
        const t = setInterval(() => { if (sock.destroyed) { clearInterval(t); return; } sock.write("z"); }, 300);
        sock.on("close", () => clearInterval(t));
      } else if (path === "/headers") {
        let h = "HTTP/1.1 200 OK\r\n";
        for (let i = 0; i < 4000; i++) h += `x-h${i}: ${"v".repeat(20)}\r\n`;
        sock.end(`${h}content-length: 2\r\n\r\nok`);
      } else if (path === "/gzip") {
        const body = gzipSync(Buffer.from("plain words"));
        sock.end(Buffer.concat([Buffer.from(`HTTP/1.1 200 OK\r\ncontent-type: text/plain\r\ncontent-encoding: gzip\r\netag: "${"e".repeat(300)}"\r\ncontent-length: ${body.length}\r\n\r\n`, "latin1"), body]));
      } else if (path.startsWith("/secret")) {
        sock.end("HTTP/1.1 503 Service Unavailable\r\ncontent-length: 0\r\n\r\n");
      } else sock.end("HTTP/1.1 404 Not Found\r\ncontent-length: 0\r\n\r\n");
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", ok));
  const port = (srv.address() as { port: number }).port;
  try {
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const projectId = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
    const taskId = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId, title: "T" })).id;
    const grants = NetworkGrantService.withEpoch(world.storage, projects.epoch, options);
    const deps = DependencyService.withEpoch(world.storage, projects.epoch, options);
    await grants.grant(owner, { commandId: cid("g"), taskId, host: "docs.example.com", port: 80, credential: { header: "x-docs-key", ref: "docs-token" } } as never);
    const reader = new WebFetch({ grants, resolve: async () => [PUBLIC], dial: () => netConnect({ host: "127.0.0.1", port }), secret: () => SECRET });
    const faults: string[] = [];
    const read = resourceReader({ allowed: async () => true, external: reader, limits: { bytes: 4096, ms: 1500 }, onFault: (d) => faults.push(d) });
    const at = (path: string): string => `http://docs.example.com${path}`;
    const x = createHashHex("x");
    await deps.record(owner, { commandId: cid("d"), taskId, dependencies: ["/endless", "/drip", "/headers", "/gzip", `/secret?${QUERY}`].map((p) => ({ kind: "external" as const, key: at(p), hash: x, freshness: "conditional-read" as const })) });
    const manifest = (await deps.get(owner, taskId))!;
    const t0 = Date.now();
    const got = await read(manifest, "resume-check");
    assert.ok(Date.now() - t0 < 4000, `the reads end within the bound (${Date.now() - t0} ms)`);
    const checks = Object.fromEntries((await deps.check(owner, taskId, got.observations)).map((c) => [c.key.replace(/^http:\/\/[^/]+/, "").replace(/\?.*/, ""), [c.status, c.detail] as [string, string]]));
    assert.match(checks["/endless"]![1], /larger than the 4096 bytes/, "an endless stream is cut at the bound");
    assert.match(checks["/drip"]![1], /did not answer in time/, "a drip-fed answer is given up at the observation's bound");
    assert.equal(checks["/headers"]![0], "unknown", "a flood of headers is not an answer");
    assert.equal(checks["/gzip"]![0], "changed", "a compressed body is compared as the bytes it came as");
    const gz = manifest.entries.find((e) => e.key.endsWith("/gzip"))!;
    assert.equal(got.texts[gz.id], undefined, "bytes that are not text are not kept for the reviewer");
    assert.equal(got.observations[gz.id]!.etag, undefined, "an ETag longer than 200 characters is not taken");
    assert.match(checks["/secret"]![1], /HTTP 503/);
    const log = JSON.stringify(await grants.connections(owner, taskId));
    for (const [where, text] of [["checks", JSON.stringify(checks)], ["observations", JSON.stringify(got.observations)], ["log", log], ["faults", faults.join("\n")]] as const) {
      assert.equal(text.includes(SECRET), false, `no grant credential in the ${where}`);
      assert.equal(text.includes(QUERY), false, `no query secret in the ${where}`);
    }
    assert.ok(asked.length <= 5, "one request per resource");
  } finally { srv.close(); await world.close(); }
});
