import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { connect as netConnect, createServer as netServer, type Server as NetServer, type Socket } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { MemoryStorage, NetworkGrantService, NetworkRelay, PrincipalService, ProjectService } from "@nimblenewt/controller";
import { SandboxLauncher, WorkerProcess, appFromRepository, type LaunchRecord } from "@nimblenewt/worker";

// Card H12i: a real sandbox (bubblewrap: no network interface at all) reaches a destination only through the controller-side relay, under an owner's grant, and every attempt is logged. The program in the sandbox is the real proxy forwarder of the
// worker process; the host side is the real worker-process host with the real relay. The "internet" is a loopback server, reached only because the test remaps the one checked address to it. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const PUBLIC = "93.184.216.34";

/** The program that runs inside the sandbox: the proxy forwarder, wired to the channel on stdin and stdout, then a set of requests through it, whose results it prints on stderr as one line. */
const PROBE = `
import http from "node:http";
import net from "node:net";
import { createInterface } from "node:readline";
const app = "/opt/app/packages";
const { startProxy } = await import(app + "/pi-adapter/dist/worker/proxy.js");
const { encodeMessage, parseToChild } = await import(app + "/contracts/dist/index.js");
const proxy = startProxy({ port: 3128, send: (m) => process.stdout.write(encodeMessage(m)) });
createInterface({ input: process.stdin }).on("line", (line) => { try { proxy.accept(parseToChild(JSON.parse(line))); } catch { /* not for the proxy */ } });
await proxy.listening;
const out = {};
const get = (url) => new Promise((resolve) => { const r = http.get({ host: "127.0.0.1", port: 3128, path: url, headers: { host: new URL(url).host } }, (res) => { let t = ""; res.on("data", (d) => { t += d; }); res.on("end", () => resolve({ status: res.statusCode, text: t.slice(0, 200) })); }); r.on("error", (e) => resolve({ error: e.message })); r.setTimeout(15000, () => { r.destroy(); resolve({ error: "timeout" }); }); });
const connectVia = (target) => new Promise((resolve) => { const r = http.request({ host: "127.0.0.1", port: 3128, method: "CONNECT", path: target }); r.on("connect", (res, socket, head) => resolve({ status: res.statusCode, socket, head: head.toString() })); r.on("error", (e) => resolve({ error: e.message })); r.end(); });
// 1. No interface: a direct connection to an outside address cannot be made.
out.direct = await new Promise((resolve) => { const s = net.connect({ host: "192.0.2.1", port: 80 }); s.on("connect", () => { s.destroy(); resolve("CONNECTED"); }); s.on("error", (e) => resolve(e.code ?? e.message)); setTimeout(() => { s.destroy(); resolve("timeout"); }, 5000); });
// 2. The proxy environment is set for clients that honour it.
out.env = process.env.HTTP_PROXY;
// 3. A granted destination through the proxy (plain http) and a denied one.
out.granted = await get("http://docs.example.com:8081/page");
out.otherHost = await get("http://other.example.com:8081/page");
out.otherPort = await get("http://docs.example.com:8082/page");
out.privateAddress = await get("http://127.0.0.1:8081/page");
out.metadata = await connectVia("169.254.169.254:80");
// 4. A tunnel that stays open until the host revokes the grant.
const tunnel = await connectVia("live.example.com:8083");
out.tunnelStatus = tunnel.status;
if (tunnel.socket) {
  tunnel.socket.on("error", () => undefined);
  tunnel.socket.write("ping");
  // The echo came back: tell the host (a channel message it can wait for), then wait for the tunnel to be ended by the host's revoke.
  await new Promise((resolve) => { tunnel.socket.once("data", resolve); tunnel.socket.once("close", resolve); });
  process.stdout.write(encodeMessage({ t: "bridge", id: 1, token: "probe", request: { op: "tunnel.up", callId: "c1", args: {} } }));
  out.tunnelEnded = await new Promise((resolve) => { tunnel.socket.on("close", () => resolve("closed")); tunnel.socket.on("end", () => resolve("ended")); setTimeout(() => resolve("still-open"), 30000); });
  out.afterRevoke = await connectVia("live.example.com:8083");
  delete out.afterRevoke.socket;
}
process.stderr.write("RESULT " + JSON.stringify(out) + "\\n");
process.exit(0);
`;

/**
 * The second program: the same forwarder, then a real command-line client (curl) that is told nothing about the proxy except through the environment the route sets (`http_proxy` and the rest). Each result is curl's exit code, the
 * HTTP status (or, for a tunnel, the proxy's answer to CONNECT) and the start of its output, printed on stderr as one line.
 */
const CURL_PROBE = `
import { execFile } from "node:child_process";
import { createInterface } from "node:readline";
const app = "/opt/app/packages";
const { startProxy } = await import(app + "/pi-adapter/dist/worker/proxy.js");
const { encodeMessage, parseToChild } = await import(app + "/contracts/dist/index.js");
const proxy = startProxy({ port: 3128, send: (m) => process.stdout.write(encodeMessage(m)) });
createInterface({ input: process.stdin }).on("line", (line) => { try { proxy.accept(parseToChild(JSON.parse(line))); } catch { /* not for the proxy */ } });
await proxy.listening;
const curl = (args) => new Promise((resolve) => execFile(process.env.NN_CURL, ["-q", "-sS", "--max-time", "15", "-o", "-", "-w", "\\\\n%{http_code} %{http_connect}", ...args], { env: process.env, timeout: 30000 }, (error, stdout, stderr) => {
  const lines = String(stdout).split("\\n"); const [code, connect] = (lines.pop() ?? "").split(" ");
  resolve({ exit: error ? (typeof error.code === "number" ? error.code : String(error.code)) : 0, status: Number(code), connect: Number(connect), body: lines.join("\\n").slice(0, 200), stderr: String(stderr).slice(0, 300) });
}));
const out = { env: { http: process.env.http_proxy, https: process.env.HTTPS_PROXY } };
// Plain http through the proxy, granted and not.
out.granted = await curl(["http://docs.example.com:8081/curl-page"]);
out.ungranted = await curl(["http://other.example.com:8081/curl-page"]);
// The same through a CONNECT tunnel (what an https URL uses; plain http inside, because no TLS server is available offline).
out.tunnelGranted = await curl(["--proxytunnel", "http://docs.example.com:8081/curl-tunnel"]);
out.tunnelUngranted = await curl(["--proxytunnel", "http://other.example.com:8081/curl-tunnel"]);
// Told to ignore the proxy, the client has no way out at all (no network interface, no name lookup).
out.noProxy = await curl(["--noproxy", "*", "http://docs.example.com:8081/curl-direct"]);
process.stderr.write("RESULT " + JSON.stringify(out) + "\\n");
process.exit(0);
`;

/** curl on this host, at a path the sandbox sees as it is (the backend binds the system directories read-only), or why there is none. */
function findCurl(): { path: string } | { skip: string } {
  let path: string;
  try { path = execFileSync("/bin/sh", ["-c", "command -v curl"], { encoding: "utf8" }).trim(); } catch { return { skip: "curl is not installed on this host (`command -v curl` found nothing); the Node client test covers the proxy" }; }
  if (!/^\/(usr|bin)\//.test(path)) return { skip: `curl is at ${path}, outside the system directories the sandbox binds; the Node client test covers the proxy` };
  return { path };
}

async function until(label: string, check: () => boolean | Promise<boolean>, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!(await check())) { if (Date.now() > end) assert.fail(`timed out waiting for ${label}`); await new Promise((r) => setTimeout(r, 20)); }
}

describe("a sandbox with a route reaches only what the owner granted, through the relay, and every connection is logged", () => {
  test("granted, ungranted, private and metadata destinations; a revoke ends an open tunnel without a restart", async (t) => {
    const records: LaunchRecord[] = [];
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: (r) => { records.push(r); } });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable) { if (required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }

    // The "internet": one web server and one echo server on the loopback; every public address the resolver returns is remapped to the one that the test names.
    const hits: Array<{ host: string | undefined; url: string | undefined }> = [];
    const web: Server = createServer((req, res) => { hits.push({ host: req.headers.host, url: req.url }); res.end(`served ${req.url}`); });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    const sockets = new Set<Socket>();
    const echo: NetServer = netServer((s) => { sockets.add(s); s.on("close", () => sockets.delete(s)); s.on("error", () => undefined); s.on("data", (d) => s.write(d)); });
    await new Promise<void>((r) => echo.listen(0, "127.0.0.1", r));
    const webPort = (web.address() as { port: number }).port; const echoPort = (echo.address() as { port: number }).port;

    const world = new MemoryStorage();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12i ")));
    let relay: NetworkRelay | undefined;
    try {
      const projects = await ProjectService.open(world, { holder: "c1" });
      const principals = PrincipalService.withEpoch(world, projects.epoch, {});
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const projectId = (await projects.createProject({ commandId: "p1", actor: "owner:rob", name: "A" })).id;
      const taskId = (await projects.createTask({ commandId: "t1", actor: "owner:rob", projectId, title: "T" })).id;
      const grants = NetworkGrantService.withEpoch(world, projects.epoch);
      const dials: Array<{ address: string; port: number }> = [];
      relay = new NetworkRelay({
        grants, recheckMs: 50,
        resolve: async (host: string) => (host.endsWith(".example.com") ? [PUBLIC] : []),
        dial: (address: string, port: number) => { dials.push({ address, port }); return netConnect({ host: "127.0.0.1", port: port === 8083 ? echoPort : webPort }); },
      });
      // The grants: one page server and one echo; the second one is the one revoked while a tunnel is open.
      await grants.grant(owner, { commandId: "g1", taskId, host: "docs.example.com", port: 8081, reason: "read the vendor docs" });
      const live = await grants.grant(owner, { commandId: "g2", taskId, host: "live.example.com", port: 8083 });
      void live;

      const dirs = { work: join(directory, "work"), home: join(directory, "home"), scratch: join(directory, "scratch"), probe: join(directory, "probe") };
      for (const d of Object.values(dirs)) mkdirSync(d);
      writeFileSync(join(dirs.probe, "probe.mjs"), PROBE);
      const app = appFromRepository(repository, { root: nodeRoot, executable: "bin/node" });
      let tunnelUp = false;
      const ctx = { taskId, projectId, attemptId: "att-1" };
      const process = await WorkerProcess.launch(launcher, {
        recipe: { mode: "sandboxed", workdir: dirs.work, home: dirs.home, scratch: dirs.scratch, readOnly: [{ host: nodeRoot, guest: "/opt/node" }, ...app.mounts, { host: dirs.probe, guest: "/opt/probe" }], network: "none", env: {}, protectedSubpaths: [".git"], route: { proxyPort: 3128 } },
        command: ["/opt/node/bin/node", "/opt/probe/probe.mjs"], timeoutMs: 90_000, maxOutputBytes: 1_000_000,
      }, { bridge: async (_token: string, request: { op: string }) => { if (request.op === "tunnel.up") tunnelUp = true; return { ok: true, result: {} }; }, relay: async () => { throw new Error("no model here"); }, network: relay.forAttempt(ctx) as never });

      // The tunnel is up: the connection is on the log as open. The owner revokes; the tunnel ends and the next attempt is refused.
      // The probe says when its tunnel has carried bytes both ways; if it ends first, the error says what it printed.
      let ended = false; void process.exited.then(() => { ended = true; });
      await until("the tunnel is up, or the probe has ended", () => ended || tunnelUp, 60_000);
      if (ended) { const r = await process.exited; assert.fail(`the probe ended before the tunnel was up: exit ${String(r.exitCode)}, stderr ${r.stderr.slice(-1500)}`); }
      await grants.revoke(owner, { commandId: "r1", taskId, host: "live.example.com", port: 8083 });
      const done = await process.exited;
      const line = done.stderr.split("\n").find((l) => l.startsWith("RESULT "));
      assert.ok(line !== undefined, `the probe printed no result: exit ${String(done.exitCode)}, stderr ${done.stderr.slice(-600)}`);
      const out = JSON.parse(line.slice("RESULT ".length)) as Record<string, any>;

      assert.match(String(out["direct"]), /ENETUNREACH|EHOSTUNREACH|ECONNREFUSED|EADDRNOTAVAIL|timeout/, "the sandbox itself has no way out");
      assert.notEqual(out["direct"], "CONNECTED");
      assert.equal(out["env"], "http://127.0.0.1:3128");
      assert.equal(out["granted"].status, 200); assert.equal(out["granted"].text, "served /page");
      assert.deepEqual(hits[0], { host: "docs.example.com:8081", url: "/page" });
      assert.equal(out["otherHost"].status, 403); assert.match(out["otherHost"].text, /no grant/i);
      assert.equal(out["otherPort"].status, 403);
      assert.equal(out["privateAddress"].status, 403, "a loopback address is not reachable without a grant that names it");
      assert.equal(out["metadata"].status, 403);
      assert.equal(out["tunnelStatus"], 200);
      assert.match(String(out["tunnelEnded"]), /closed|ended/, "the open tunnel ended when the grant was revoked");
      assert.equal(out["afterRevoke"].status, 403, "a new connection after the revoke is refused");
      // Only the granted ones were ever dialled, each to the address that was checked.
      assert.deepEqual(dials.map((d) => `${d.address}:${d.port}`), [`${PUBLIC}:8081`, `${PUBLIC}:8083`]);
      // The log has every attempt, allowed and refused, with the destination and the outcome.
      const log = await grants.connections(owner, taskId);
      const outcomes = (host: string, port: number) => log.filter((c) => c.host === host && c.port === port).map((c) => c.outcome).sort();
      assert.deepEqual(outcomes("docs.example.com", 8081), ["closed"]);
      assert.deepEqual(outcomes("docs.example.com", 8082), ["refused"]);
      assert.deepEqual(outcomes("other.example.com", 8081), ["refused"]);
      assert.deepEqual(outcomes("127.0.0.1", 8081), ["refused"]);
      assert.deepEqual(outcomes("169.254.169.254", 80), ["refused"]);
      assert.deepEqual(outcomes("live.example.com", 8083), ["closed", "refused"]);
      const tunnel = log.find((c) => c.host === "live.example.com" && c.outcome === "closed")!;
      assert.equal(tunnel.endedBy, "revoked"); assert.equal(tunnel.bytesToTarget, 4); assert.equal(tunnel.bytesFromTarget, 4);
      assert.ok(log.every((c) => c.attemptId === "att-1" && c.via === "relay"));
      // The launch record names the route.
      assert.deepEqual(records.at(-1)?.route, { proxyPort: 3128 });
      assert.equal(relay.open, 0);
    } finally {
      relay?.close(); for (const s of sockets) s.destroy();
      web.closeAllConnections(); await new Promise<void>((r) => web.close(() => r())); await new Promise<void>((r) => echo.close(() => r()));
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("a command-line client (curl) that honours the proxy variables reaches a granted destination and is refused (403) at any other, and the log records task, attempt, destination and bytes", async (t) => {
    const launcher = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
    const usable = launcher.capacity.available && launcher.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
    if (!usable) { if (required && process.platform === "linux") assert.fail(`the sandbox is required but unusable: ${launcher.capacity.reason}`); return t.skip("bubblewrap or a node install it can mount is unusable"); }
    const found = findCurl();
    if ("skip" in found) return t.skip(found.skip);

    const hits: Array<{ host: string | undefined; url: string | undefined }> = [];
    const web: Server = createServer((req, res) => { hits.push({ host: req.headers.host, url: req.url }); res.end(`served ${req.url}`); });
    await new Promise<void>((r) => web.listen(0, "127.0.0.1", r));
    const webPort = (web.address() as { port: number }).port;
    const world = new MemoryStorage();
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h12i curl ")));
    let relay: NetworkRelay | undefined;
    try {
      const projects = await ProjectService.open(world, { holder: "c1" });
      const principals = PrincipalService.withEpoch(world, projects.epoch, {});
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const projectId = (await projects.createProject({ commandId: "p1", actor: "owner:rob", name: "A" })).id;
      const taskId = (await projects.createTask({ commandId: "t1", actor: "owner:rob", projectId, title: "T" })).id;
      const grants = NetworkGrantService.withEpoch(world, projects.epoch);
      const dials: Array<{ address: string; port: number }> = [];
      relay = new NetworkRelay({
        grants, recheckMs: 50,
        resolve: async (host: string) => (host.endsWith(".example.com") ? [PUBLIC] : []),
        dial: (address: string, port: number) => { dials.push({ address, port }); return netConnect({ host: "127.0.0.1", port: webPort }); },
      });
      const grant = await grants.grant(owner, { commandId: "g1", taskId, host: "docs.example.com", port: 8081, reason: "read the vendor docs" });

      const dirs = { work: join(directory, "work"), home: join(directory, "home"), scratch: join(directory, "scratch"), probe: join(directory, "probe") };
      for (const d of Object.values(dirs)) mkdirSync(d);
      writeFileSync(join(dirs.probe, "probe.mjs"), CURL_PROBE);
      const app = appFromRepository(repository, { root: nodeRoot, executable: "bin/node" });
      const ctx = { taskId, projectId, attemptId: "att-curl" };
      const worker = await WorkerProcess.launch(launcher, {
        recipe: { mode: "sandboxed", workdir: dirs.work, home: dirs.home, scratch: dirs.scratch, readOnly: [{ host: nodeRoot, guest: "/opt/node" }, ...app.mounts, { host: dirs.probe, guest: "/opt/probe" }], network: "none", env: { NN_CURL: found.path }, protectedSubpaths: [".git"], route: { proxyPort: 3128 } },
        command: ["/opt/node/bin/node", "/opt/probe/probe.mjs"], timeoutMs: 120_000, maxOutputBytes: 1_000_000,
      }, { bridge: async () => ({ ok: true, result: {} }), relay: async () => { throw new Error("no model here"); }, network: relay.forAttempt(ctx) as never });
      const done = await worker.exited;
      const line = done.stderr.split("\n").find((l) => l.startsWith("RESULT "));
      assert.ok(line !== undefined, `the probe printed no result: exit ${String(done.exitCode)}, stderr ${done.stderr.slice(-600)}`);
      const out = JSON.parse(line.slice("RESULT ".length)) as Record<string, any>;

      // The client was given the proxy only through the environment the route sets.
      assert.deepEqual(out["env"], { http: "http://127.0.0.1:3128", https: "http://127.0.0.1:3128" });
      // Granted: served, through the proxy, with the destination's own name.
      assert.equal(out["granted"].exit, 0, JSON.stringify(out["granted"])); assert.equal(out["granted"].status, 200); assert.equal(out["granted"].body, "served /curl-page");
      assert.equal(out["tunnelGranted"].exit, 0, JSON.stringify(out["tunnelGranted"])); assert.equal(out["tunnelGranted"].connect, 200); assert.equal(out["tunnelGranted"].status, 200); assert.equal(out["tunnelGranted"].body, "served /curl-tunnel");
      // Not granted: the relay refuses with 403 and says why; for a tunnel curl reports the refused CONNECT (a non-zero exit: 56 or 7 depending on the curl version) and never sends the request.
      assert.equal(out["ungranted"].status, 403, JSON.stringify(out["ungranted"])); assert.match(out["ungranted"].body, /no grant/i);
      assert.equal(out["tunnelUngranted"].connect, 403, JSON.stringify(out["tunnelUngranted"])); assert.notEqual(out["tunnelUngranted"].exit, 0); assert.match(out["tunnelUngranted"].stderr, /403/);
      // Without the proxy the client cannot even look the name up.
      assert.notEqual(out["noProxy"].exit, 0, JSON.stringify(out["noProxy"])); assert.equal(out["noProxy"].status, 0);
      // The destination saw only the two granted requests, and only the granted destination was dialled, at the checked address.
      assert.deepEqual(hits, [{ host: "docs.example.com:8081", url: "/curl-page" }, { host: "docs.example.com:8081", url: "/curl-tunnel" }]);
      assert.deepEqual(dials.map((d) => `${d.address}:${d.port}`), [`${PUBLIC}:8081`, `${PUBLIC}:8081`]);

      // The log: every connection, allowed and refused, with task, attempt, destination and bytes (the allowed ones once they have closed).
      await until("the allowed connections are closed on the log", async () => (await grants.connections(owner, taskId)).filter((c) => c.outcome === "open").length === 0);
      const log = await grants.connections(owner, taskId);
      assert.equal(log.length, 4, JSON.stringify(log));
      for (const c of log) { assert.equal(c.taskId, taskId); assert.equal(c.projectId, projectId); assert.equal(c.attemptId, "att-curl"); assert.equal(c.via, "relay"); }
      const allowed = log.filter((c) => c.host === "docs.example.com" && c.port === 8081);
      assert.deepEqual(allowed.map((c) => c.outcome), ["closed", "closed"]);
      for (const c of allowed) { assert.equal(c.grantId, grant.id); assert.equal(c.address, PUBLIC); assert.ok(c.bytesToTarget > 0 && c.bytesFromTarget > 0, JSON.stringify(c)); }
      const refused = log.filter((c) => c.host === "other.example.com" && c.port === 8081);
      assert.deepEqual(refused.map((c) => c.outcome), ["refused", "refused"]);
      for (const c of refused) { assert.equal(c.bytesToTarget, 0); assert.equal(c.bytesFromTarget, 0); assert.equal(c.address, undefined); }
      assert.equal(relay.open, 0);
    } finally {
      relay?.close();
      web.closeAllConnections(); await new Promise<void>((r) => web.close(() => r()));
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
