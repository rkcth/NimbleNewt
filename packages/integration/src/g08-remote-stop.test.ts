import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect as tcpConnect, createServer as createTcpServer, type Server as TcpServer, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AdmissionService, startController, type Controller } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { sse } from "./h12-worker-support.js";
import { sandbox } from "./w03-rig-support.js";

// Card G08, the remote-stop part, with the product's remote worker code: a controller (SQLite) and a remote worker host in a process of its own (`g08-host-child.ts`: the host poller, the offer runner, a `LocalWorker` and the Pi process in
// its bubblewrap sandbox). The worker reaches the controller only through a loopback relay this test controls, so its traffic can be cut off (bytes dropped, nothing answered, no connection closed) or held and delivered late. The host process,
// which is the supervisor of the agent's process, can be killed with SIGKILL. The measurements come from an observer outside both: the process table (the sandbox's processes, found by the attempt's home path in bubblewrap's arguments, and
// their descendants), the model endpoint (when the agent's open model call is closed, and whether a new one is made) and the controller's own dispatch record (the lease it granted, the renewals it took, what became of the attempt).
// Nothing here stands in for the worker's own decision: the process stops by its own lease watchdog (H08b), counted from when each renewal was sent.
// Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI). Linux only: on macOS the sandbox does not end with its parent (recorded as a limit in the notes).

const AGENT = "agt-abcdefghijklmnopqrst";
const LEASE_MS = 3000;
const GRACE_MS = 2000;
/** The worker process looks at its clocks once a second (its default), so an open call is cut at most this long after the lease ended. */
const TICK_MS = 1000;
/** What the stop may take beyond the watchdog's look to be seen at the model endpoint (the abort goes from the process to the host, which closes its call): measured in tens of ms, allowed more for a loaded CI machine. */
const SEEN_MS = 750;
/**
 * The controller's first lease counts from the dispatch; the process's first lease counts from when it reads its start, after the offer was taken, the contract confirmed and the sandbox launched. Until a renewal is answered the process's
 * deadline is later by that time (measured about half a second here; a recorded limit of G08, see the notes). The bound allowed for it.
 */
const START_UP_MS = 3000;
const guard = pathToFileURL(fileURLToPath(new URL("../../../scripts/offline-guard.mjs", import.meta.url))).href;
const child = fileURLToPath(new URL("./g08-host-child.js", import.meta.url));
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, why: string, ms = 90_000): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await sleep(10); } };

type Mode = "pass" | "drop" | "hold";

/** The network between the worker and the controller: passes bytes, drops them (a blackhole: nothing answered, nothing closed), or holds them and delivers them when healed (a delayed network). */
class Cut {
  mode: Mode = "pass";
  /** Bytes the worker sent while the line was cut. */
  sentIntoCut = 0;
  /** What the controller answered after the line was healed (the start of each piece, bounded). */
  answersAfterHeal = "";
  #healed = false;
  readonly #held: { readonly to: Socket; readonly data: Buffer }[] = [];
  readonly #sockets = new Set<Socket>();
  private constructor(readonly server: TcpServer, readonly url: string) {}

  static async open(target: string): Promise<Cut> {
    const t = new URL(target);
    let cut: Cut | undefined;
    const server = createTcpServer({ allowHalfOpen: true }, (worker) => cut!.#pair(worker, Number(t.port), t.hostname));
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    cut = new Cut(server, `http://127.0.0.1:${(server.address() as { port: number }).port}`);
    return cut;
  }

  #pair(worker: Socket, port: number, host: string): void {
    this.#sockets.add(worker);
    // A connection opened into a blackhole reaches nothing at all.
    const controller = this.mode === "drop" ? undefined : tcpConnect({ port, host, allowHalfOpen: true });
    if (controller !== undefined) this.#sockets.add(controller);
    const carry = (data: Buffer, to: Socket | undefined, fromWorker: boolean): void => {
      if (this.mode === "pass") {
        if (!fromWorker && this.#healed && this.answersAfterHeal.length < 200_000) this.answersAfterHeal += data.toString("latin1").slice(0, 4000);
        if (to !== undefined && !to.destroyed) to.write(data);
        return;
      }
      if (fromWorker) this.sentIntoCut += data.length;
      if (this.mode === "hold" && to !== undefined) this.#held.push({ to, data });
    };
    worker.on("data", (d: Buffer) => carry(d, controller, true));
    controller?.on("data", (d: Buffer) => carry(d, worker, false));
    // While cut, an end or reset on one side is not passed on: the worker learns nothing, and what it sent before giving up still reaches the controller when a held line is healed (a late packet).
    const close = (other: Socket | undefined) => () => { if (this.mode === "pass") other?.destroy(); };
    worker.on("close", close(controller)); controller?.on("close", close(worker));
    worker.on("error", () => undefined); controller?.on("error", () => undefined);
  }

  heal(): void {
    this.mode = "pass";
    this.#healed = true;
    for (const h of this.#held.splice(0)) if (!h.to.destroyed) h.to.write(h.data);
  }

  close(): void { for (const s of this.#sockets) s.destroy(); this.server.close(); }
}

/** One process as the process table shows it: its ID and its start time (an ID used again by another process is not the same process). */
const key = (pid: number, start: string): string => `${pid}:${start}`;
function processTable(): Map<number, { readonly ppid: number; readonly start: string; readonly cmd: string }> {
  const table = new Map<number, { ppid: number; start: string; cmd: string }>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      table.set(Number(name), { ppid: Number(rest[1]), start: rest[19]!, cmd: readFileSync(`/proc/${name}/cmdline`, "utf8").replace(/\0/g, " ") });
    } catch { /* it ended while being read */ }
  }
  return table;
}
/** The sandbox of the attempt: the processes whose arguments name its home, and all their descendants. */
function sandboxOf(marker: string): Set<string> {
  const table = processTable();
  const out = new Set<string>();
  const queue = [...table].filter(([, p]) => p.cmd.includes(marker)).map(([pid]) => pid);
  while (queue.length > 0) {
    const pid = queue.pop()!;
    const p = table.get(pid);
    if (p === undefined || out.has(key(pid, p.start))) continue;
    out.add(key(pid, p.start));
    for (const [q, v] of table) if (v.ppid === pid) queue.push(q);
  }
  return out;
}
const alive = (k: string): boolean => {
  const [pid, start] = k.split(":");
  try { const stat = readFileSync(`/proc/${pid}/stat`, "utf8"); return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === start; } catch { return false; }
};

/** The model endpoint: the first call's reply starts and never ends, so the agent is busy in an open model call. It records when each call opened and closed. */
async function heldModel(): Promise<{ server: Server; url: string; calls: { openedAt: number; closedAt?: number }[] }> {
  const calls: { openedAt: number; closedAt?: number }[] = [];
  const server = createServer((req, res) => {
    const call: { openedAt: number; closedAt?: number } = { openedAt: Date.now() };
    calls.push(call);
    res.on("close", () => { call.closedAt ??= Date.now(); });
    req.resume();
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(sse({ role: "assistant", content: "" }, null));
      res.write(sse({ content: "Looking at the seed list" }, null));
    });
  });
  await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
  return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, calls };
}

interface Rig {
  readonly c: Controller; readonly cut: Cut; readonly host: ChildProcess; readonly attemptId: string; readonly marker: string; readonly model: Awaited<ReturnType<typeof heldModel>>; readonly said: Record<string, unknown>[];
  record(): Promise<{ state: string; heartbeats: number; until?: string; outcome?: { status: string } }>;
  close(): Promise<void>;
}

/** A controller, the remote host process connected to it through the relay, and one attempt running on it: the agent is in its model call and its lease has been renewed past the lease's own length. */
async function rig(client: { timeoutMs: number; retries: number }, renewFirst = true): Promise<Rig> {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn-g08-")));
  const model = await heldModel();
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    tools: { runner: { run: async () => { throw new Error("no script call runs in this test"); } } as never, isLocalHost: () => false },
    dispatch: {
      manual: true, dispatcher: { leaseMs: LEASE_MS },
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        workspaceAdmission: async () => [], blobDirectory: join(directory, "blobs"), relocationPolicy: async () => ({}), placementPolicy: async () => ({ dataHosts: ["host:r1"] }),
        hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 2_000, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) }],
      },
    },
  } as never);
  assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
  const s = c.services;
  const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
  await s.principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: AGENT, grants: workGrants(project) as never });
  await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
  const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
  await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap", actor: owner.id, host: "host:r1", capacity: { cpus: 8, memoryMb: 16_384 } });
  const cut = await Cut.open(c.dispatch.workerUrl!);
  const host = spawn(process.execPath, ["--import", guard, child], { stdio: ["pipe", "pipe", "inherit"] });
  const said: Record<string, unknown>[] = [];
  let buffer = "";
  host.stdout!.setEncoding("utf8").on("data", (d: string) => { buffer += d; let at: number; while ((at = buffer.indexOf("\n")) >= 0) { try { said.push(JSON.parse(buffer.slice(0, at)) as Record<string, unknown>); } catch { /* not a line of ours */ } buffer = buffer.slice(at + 1); } });
  host.stdin!.end(`${JSON.stringify({ url: cut.url, token: hostToken, directory, modelUrl: model.url, leaseGraceMs: GRACE_MS, hostHeader: new URL(c.dispatch.workerUrl!).host, ...client })}\n`);
  const close = async (): Promise<void> => {
    if (host.exitCode === null && host.signalCode === null) { host.kill("SIGKILL"); await new Promise((r) => host.once("exit", r)); }
    cut.close(); model.server.closeAllConnections(); model.server.close(); await c.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  try {
    await until(() => said.some((e) => e["ev"] === "ready" || e["ev"] === "unusable" || e["ev"] === "failed"), "the host process never started", 60_000);
    assert.ok(said.some((e) => e["ev"] === "ready"), JSON.stringify(said));
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Order seeds" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: AGENT } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: AGENT }, harness: "pi" })).id;
    // The host's session must be open before the dispatcher can place the attempt on it.
    let last: unknown;
    try {
      await until(async () => { const r = await c.dispatch!.dispatcher.tick(); last = { skipped: r.skipped, failures: r.failures, waiting: r.waiting, blocked: r.blocked }; return r.started.includes(attemptId); }, "the attempt was never started on the remote host", 60_000);
    } catch (error) { throw new Error(`${(error as Error).message}: ${JSON.stringify(last)} ${JSON.stringify(said).slice(0, 3000)}`); }
    const record = async () => {
      const d = (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId)) as unknown as { state: string; heartbeats: number; lease?: { until: string }; outcome?: { status: string } };
      return { state: d.state, heartbeats: d.heartbeats, ...(d.lease === undefined ? {} : { until: d.lease.until }), ...(d.outcome === undefined ? {} : { outcome: d.outcome }) };
    };
    await until(() => model.calls.length > 0, `the agent never made its model call: ${JSON.stringify(said)}`, 90_000);
    // The rig's own directory is part of the marker: attempt IDs repeat across stores, and other tests running beside this one lay their attempts out the same way.
    const marker = `${directory}/attempts/${attemptId}/home`;
    assert.ok(sandboxOf(marker).size >= 2, "the observer finds the sandbox and the agent's process in the process table");
    if (renewFirst) {
      // Twice the lease's length with the call open: the renewals the process asks for (through the host, over HTTP) keep it.
      const before = (await record()).heartbeats;
      await sleep(2 * LEASE_MS);
      const kept = await record();
      assert.equal(kept.state, "running");
      assert.ok(kept.heartbeats >= before + 3, `renewals kept the lease: ${before} then ${kept.heartbeats}`);
      assert.equal(model.calls[0]!.closedAt, undefined, "the model call is still open");
    }
    return { c, cut, host, attemptId, marker, model, said, record, close };
  } catch (error) { await close(); throw error; }
}

/** Watches the sandbox from outside until every process of it has ended (and no new one has appeared); returns when that was seen. */
async function sandboxGone(marker: string, seen: ReadonlySet<string>, ms: number): Promise<number> {
  const known = new Set(seen);
  assert.ok(known.size > 0, "the sandbox was running when the watch began");
  const end = Date.now() + ms;
  let last = Date.now();
  for (;;) {
    for (const k of [...known]) if (!alive(k)) known.delete(k);
    if (known.size === 0) {
      const now = Date.now();
      // Seen gone at most this long after it went: the look before found one still alive.
      const fresh = sandboxOf(marker);
      if (fresh.size === 0) return now - Math.floor((now - last) / 2);
      for (const k of fresh) known.add(k);
    }
    if (Date.now() > end) assert.fail(`the sandbox still runs ${ms} ms on: ${[...known].join(", ")}`);
    last = Date.now();
    await sleep(5);
  }
}

/** What the outside observer saw after `from` (the cut or the kill): when the open model call was closed, when the last process of the sandbox ended, against the end of the lease the controller last granted. */
async function measure(x: Rig, from: number, seen: ReadonlySet<string>): Promise<{ readonly stoppedAt: number; readonly goneAt: number; readonly leaseEnd: number; readonly heartbeats: number; readonly figures: Record<string, number> }> {
  const timeline = (): string => JSON.stringify(x.said.map((e) => ({ ...e, at: Number(e["at"]) - from }))).slice(0, 3000);
  const gone = sandboxGone(x.marker, seen, 60_000);
  gone.catch(() => undefined);
  try { await until(() => x.model.calls[0]!.closedAt !== undefined, "the agent's model call was never closed", 60_000); } catch (error) { throw new Error(`${(error as Error).message}; sandbox ${sandboxOf(x.marker).size}; ${timeline()}`); }
  const stoppedAt = x.model.calls[0]!.closedAt!;
  const goneAt = await gone;
  const r = await x.record();
  const leaseEnd = Date.parse(r.until!);
  return { stoppedAt, goneAt, leaseEnd, heartbeats: r.heartbeats, figures: { toStopMs: stoppedAt - from, stopBeforeLeaseEndMs: leaseEnd - stoppedAt, toGoneMs: goneAt - from, goneAfterLeaseEndMs: goneAt - leaseEnd, heartbeats: r.heartbeats, bytesIntoCut: x.cut.sentIntoCut } };
}

/** The controller ends the attempt once its lease is over (the dispatcher's tick) and admits a replacement. */
async function controllerEnds(x: Rig, leaseEnd: number): Promise<void> {
  while (Date.now() <= leaseEnd + 50) await sleep(20);
  const tick = await x.c.dispatch!.dispatcher.tick();
  assert.ok(tick.lost.includes(x.attemptId), JSON.stringify(tick));
  assert.equal(tick.readmitted.length, 1);
  assert.notEqual((await x.record()).state, "running");
}

/** Nothing of the old attempt was revived: it was offered once, its sandbox stays gone, and every model call after its first was made by a replacement the controller offered afterwards. */
function notRevived(x: Rig): void {
  const offers = x.said.filter((e) => e["ev"] === "offer");
  assert.equal(offers.filter((e) => e["attemptId"] === x.attemptId).length, 1, JSON.stringify(offers));
  assert.equal(sandboxOf(x.marker).size, 0, "the old attempt's sandbox stays gone");
  const replacementAt = Math.min(...offers.filter((e) => e["attemptId"] !== x.attemptId).map((e) => Number(e["at"])), Number.POSITIVE_INFINITY);
  for (const call of x.model.calls.slice(1)) assert.ok(call.openedAt >= replacementAt, `a model call at ${call.openedAt} before any replacement was offered (${replacementAt})`);
}

const linuxSandbox = async (t: { skip(why?: string): void }): Promise<boolean> => {
  if (process.platform !== "linux") { t.skip("the process-table observer is Linux-only"); return false; }
  return (await sandbox(t)) !== undefined;
};

test("traffic cut off mid-call: the remote agent stops by its own lease no later than one watchdog look after the controller's lease ends, its sandbox ends within the grace, and the controller takes nothing from it once traffic returns (card G08)", { timeout: 300_000 }, async (t) => {
  if (!(await linuxSandbox(t))) return;
  const x = await rig({ timeoutMs: 4000, retries: 2 });
  try {
    const seen = sandboxOf(x.marker);
    const cutAt = Date.now();
    const beatsAtCut = (await x.record()).heartbeats;
    x.cut.mode = "drop";
    const m = await measure(x, cutAt, seen);
    t.diagnostic(`G08 blackhole ${JSON.stringify(m.figures)}`);
    assert.ok(m.stoppedAt - cutAt <= LEASE_MS + TICK_MS + 1000, JSON.stringify(m.figures));
    assert.ok(m.stoppedAt <= m.leaseEnd + TICK_MS + SEEN_MS, `the open call is cut within one look of the watchdog after the controller's lease: ${JSON.stringify(m.figures)}`);
    assert.ok(m.goneAt <= m.leaseEnd + TICK_MS + GRACE_MS + 1500, `the sandbox ends within the grace: ${JSON.stringify(m.figures)}`);
    assert.equal(x.model.calls.length, 1, "no model call was made after the cut");
    assert.ok(x.cut.sentIntoCut > 0, "the worker kept asking into the cut");
    assert.ok(m.heartbeats <= beatsAtCut + 1, "no renewal sent after the cut reached the controller");
    await controllerEnds(x, m.leaseEnd);
    // Traffic returns: the host's runner sends what it still has (the turn's result); the controller has ended the attempt and takes none of it.
    x.cut.heal();
    await until(() => x.said.some((e) => e["ev"] === "outcome" && e["attemptId"] === x.attemptId), `the host never gave the attempt up: ${JSON.stringify(x.said).slice(0, 2000)}`, 60_000);
    const outcome = x.said.find((e) => e["ev"] === "outcome" && e["attemptId"] === x.attemptId)!["outcome"];
    assert.ok(outcome === "fenced" || outcome === "failed", String(outcome));
    const after = await x.record();
    assert.equal(after.heartbeats, m.heartbeats, "no renewal was taken after the controller ended the attempt");
    assert.notEqual(after.outcome?.status, "succeeded");
    notRevived(x);
  } finally { await x.close(); }
});

test("traffic cut off as soon as the agent's first model call opens, before any renewal was answered: the process's first lease counts from its own start, so its stop may follow the controller's lease end by the start-up time and one look (a recorded limit); the controller takes nothing from it (card G08)", { timeout: 300_000 }, async (t) => {
  if (!(await linuxSandbox(t))) return;
  const x = await rig({ timeoutMs: 4000, retries: 2 }, false);
  try {
    const seen = sandboxOf(x.marker);
    const cutAt = Date.now();
    x.cut.mode = "drop";
    const m = await measure(x, cutAt, seen);
    t.diagnostic(`G08 first lease ${JSON.stringify(m.figures)}`);
    assert.ok(m.stoppedAt - cutAt <= LEASE_MS + TICK_MS + 1000, JSON.stringify(m.figures));
    assert.ok(m.stoppedAt <= m.leaseEnd + START_UP_MS + TICK_MS, `the first lease outlasts the controller's by at most the start-up time and one look: ${JSON.stringify(m.figures)}`);
    assert.ok(m.goneAt <= m.leaseEnd + START_UP_MS + TICK_MS + GRACE_MS + 1500, JSON.stringify(m.figures));
    await controllerEnds(x, m.leaseEnd);
    x.cut.heal();
    await until(() => x.said.some((e) => e["ev"] === "outcome" && e["attemptId"] === x.attemptId), `the host never gave the attempt up: ${JSON.stringify(x.said).slice(0, 2000)}`, 60_000);
    assert.notEqual((await x.record()).outcome?.status, "succeeded");
    notRevived(x);
  } finally { await x.close(); }
});

test("the supervisor killed: the remote host process dies by SIGKILL and its sandbox ends with it at once; the controller ends the attempt when its lease is over (card G08)", { timeout: 300_000 }, async (t) => {
  if (!(await linuxSandbox(t))) return;
  const x = await rig({ timeoutMs: 4000, retries: 2 });
  try {
    const seen = sandboxOf(x.marker);
    const killedAt = Date.now();
    x.host.kill("SIGKILL");
    const m = await measure(x, killedAt, seen);
    t.diagnostic(`G08 supervisor killed ${JSON.stringify(m.figures)}`);
    assert.ok(m.goneAt - killedAt <= 2000, `the sandbox ended with its supervisor: ${JSON.stringify(m.figures)}`);
    assert.ok(m.stoppedAt - killedAt <= 2000, JSON.stringify(m.figures));
    assert.ok(m.stoppedAt <= m.leaseEnd, JSON.stringify(m.figures));
    await controllerEnds(x, m.leaseEnd);
    assert.equal((await x.record()).heartbeats, m.heartbeats);
    notRevived(x);
  } finally { await x.close(); }
});

test("a delayed renewal: renewals the network held are delivered after the controller ended the attempt; they are refused, extend nothing and revive nothing (card G08)", { timeout: 300_000 }, async (t) => {
  if (!(await linuxSandbox(t))) return;
  // The host's requests wait long enough for the late answers to reach it.
  const x = await rig({ timeoutMs: 60_000, retries: 0 });
  try {
    const seen = sandboxOf(x.marker);
    const heldAt = Date.now();
    x.cut.mode = "hold";
    const m = await measure(x, heldAt, seen);
    t.diagnostic(`G08 held ${JSON.stringify(m.figures)}`);
    assert.ok(m.stoppedAt <= m.leaseEnd + TICK_MS + SEEN_MS, JSON.stringify(m.figures));
    assert.ok(x.cut.sentIntoCut > 0, "renewals were sent into the held line");
    await controllerEnds(x, m.leaseEnd);
    const ended = await x.record();
    x.cut.heal();
    await until(() => x.said.some((e) => e["ev"] === "outcome" && e["attemptId"] === x.attemptId), `the host never gave the attempt up: ${JSON.stringify(x.said).slice(0, 2000)}`, 90_000);
    const after = await x.record();
    assert.deepEqual([after.heartbeats, after.until], [ended.heartbeats, ended.until], "the late renewals extended nothing");
    assert.match(x.cut.answersAfterHeal, /"code":"fenced"/, "the controller answered the late requests: fenced");
    assert.notEqual(after.outcome?.status, "succeeded");
    await sleep(LEASE_MS);
    notRevived(x);
  } finally { await x.close(); }
});
