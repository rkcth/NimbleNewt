import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer as createNetServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalWorker } from "../dispatch/local-worker.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { ScriptedInterpreter } from "../chat/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { ConversationTransport } from "../transport/index.js";
import type { WebAssets } from "../web/index.js";
import { ScratchCleanupService, type ScratchReport } from "../work-end/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

/**
 * A start that fails after the dispatcher has started (here the conversation listener cannot listen: its port, chosen at run time, is already in use) stops everything it had started the way the
 * controller's own close() does: the dispatcher's loop, the scratch cleanup BEFORE the storage (a cleanup run still going is told to stop and finishes before the storage closes, so it never meets
 * "the storage is closed"), the workers, then the storage, each once. The start-up error itself is what the caller gets.
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
const within = async <T>(ms: number, run: Promise<T>, what: string): Promise<T> => { let t: ReturnType<typeof setTimeout> | undefined; try { return await Promise.race([run, new Promise<never>((_, reject) => { t = setTimeout(() => reject(new Error(`${what} did not finish within ${ms} ms`)), ms); })]); } finally { clearTimeout(t); } };
const listenAnywhere = (): Promise<Server> => new Promise((resolve, reject) => { const s = createNetServer(); s.once("error", reject); s.listen(0, "127.0.0.1", () => resolve(s)); });
const portFree = (port: number): Promise<void> => new Promise((resolve, reject) => { const s = createNetServer(); s.once("error", reject); s.listen(port, "127.0.0.1", () => s.close(() => resolve())); });
const ASSETS: WebAssets = { "/": { type: "text/html; charset=utf-8", body: "<!doctype html><title>t</title>" } };
/** A local worker host whose close is counted, under a timer only the test fires. */
const localDispatch = (timer: ManualTimer, closed: () => void): DispatchStartOptions => ({ timer, local: { acceptUnenforcedLimits: true, window: () => undefined, close: async () => { closed(); }, build: (s: BuildServices) => new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "fs1", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }), guards: s.guards, sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) }, runtimes: { open: async () => { throw new Error("unused"); } } }) as unknown as WorkerHost } }) as never;
/**
 * For the length of `body` only: the conversation listener's close does its real work (the listener goes) and then fails, and the storage the start builds its scratch cleanup on is captured
 * (so the test can see it closed). Both are put back in `finally`, whatever `body` does.
 */
async function withFailingTransportClose<T>(body: (seen: { closes: number; storage: ControllerStorage | undefined }) => Promise<T>): Promise<T> {
  const proto = ConversationTransport.prototype as unknown as { close: () => Promise<void> };
  const realClose = proto.close;
  const realWithEpoch = ScratchCleanupService.withEpoch.bind(ScratchCleanupService);
  const seen: { closes: number; storage: ControllerStorage | undefined } = { closes: 0, storage: undefined };
  proto.close = async function (this: unknown): Promise<void> { seen.closes += 1; await realClose.call(this); throw new Error("the conversation listener's close failed"); };
  (ScratchCleanupService as unknown as { withEpoch: typeof ScratchCleanupService.withEpoch }).withEpoch = (...a) => { seen.storage ??= a[0]; return realWithEpoch(...a); };
  try { return await body(seen); } finally {
    proto.close = realClose;
    (ScratchCleanupService as unknown as { withEpoch: typeof ScratchCleanupService.withEpoch }).withEpoch = realWithEpoch;
  }
}

test("a start that fails after the dispatcher started closes what it started, the scratch cleanup before the storage, once, and raises the start-up error", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-failed-start-"));
  const rejections: unknown[] = [];
  const onRejection = (reason: unknown): void => { rejections.push(reason); };
  process.on("unhandledRejection", onRejection);
  // The port the conversation listener is given is held by this test, so its listen fails for real (EADDRINUSE). It is chosen at run time.
  const holder = await listenAnywhere();
  const port = (holder.address() as { port: number }).port;
  // The controller's own scratch cleanup service, captured as start builds it, so a cleanup run is going (its order out to a host that has not answered) when the start fails.
  const realWithEpoch = ScratchCleanupService.withEpoch.bind(ScratchCleanupService);
  let service: ScratchCleanupService | undefined;
  let run: Promise<unknown> | undefined;
  let orderSignal: AbortSignal | undefined;
  (ScratchCleanupService as unknown as { withEpoch: typeof ScratchCleanupService.withEpoch }).withEpoch = (...a) => {
    const s = realWithEpoch(...a);
    if (service === undefined) { service = s; run = s.run({ attemptId: "att-1", taskId: "t-1", projectId: "p-1", agentId: "agent:ann" }, []); run.catch(() => undefined); }
    return s;
  };
  const timer = new ManualTimer();
  let workersClosed = 0;
  // The host's removal answers only when it is told to stop.
  const remove = (_o: unknown, signal: AbortSignal): Promise<ScratchReport> => { orderSignal = signal; return new Promise((_, reject) => { signal.addEventListener("abort", () => reject(new Error("stopped")), { once: true }); }); };
  let started: Error | undefined;
  try {
    try {
      const c = await startController({
        storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
        scratchHost: { remove: remove as never },
        conversationTransport: { port },
        dispatch: localDispatch(timer, () => { workersClosed++; }),
      } as never);
      await c.close();
      assert.fail("the start was expected to fail: the conversation port is in use");
    } catch (error) { started = error as Error; }
  } finally {
    (ScratchCleanupService as unknown as { withEpoch: typeof ScratchCleanupService.withEpoch }).withEpoch = realWithEpoch;
  }
  try {
    assert.equal((started as NodeJS.ErrnoException).code, "EADDRINUSE", `the start-up error is the one raised, not a later one: ${String(started)}`);
    assert.ok(service !== undefined && run !== undefined, "the controller built its scratch cleanup before the failure");
    // The dispatcher had started (its loop was armed) and was stopped; its workers were closed once.
    assert.ok(timer.delays.length >= 1, "the dispatcher's loop had started");
    assert.equal(timer.armed, false, "the dispatcher's loop is stopped");
    assert.equal(workersClosed, 1, "the workers were closed once");
    // The cleanup run had finished when the start gave up, without an error: it was stopped while the storage was still open (no "the storage is closed").
    await within(5_000, run, "the cleanup run");
    assert.ok(orderSignal !== undefined, "the cleanup's order was out to the host when the start failed");
    assert.equal(orderSignal.aborted, true, "the order out to the host was told to stop");
    // Nothing left listening: the port is free again once this test lets go of it.
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    const again = await new Promise<Server>((resolve, reject) => { const s = createNetServer(); s.once("error", reject); s.listen(port, "127.0.0.1", () => resolve(s)); });
    await new Promise<void>((resolve) => again.close(() => resolve()));
    // The storage was closed (and its lock released): another controller opens it, and the cleanup was left with nothing decided and no lease held, so the next controller can send the order at once.
    const c2 = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
    try {
      const rec = await c2.services.scratchCleanup.get("att-1");
      assert.equal(rec?.state, "ordering", "nothing was decided");
      assert.equal(rec?.lease, undefined, "the lease was given up at shutdown");
    } finally { await c2.close(); }
    // Give any late rejection a moment to surface.
    await new Promise((r) => setTimeout(r, 200));
    assert.deepEqual(rejections.map(String), [], "no rejection was left unhandled (for example 'the storage is closed')");
  } finally {
    process.off("unhandledRejection", onRejection);
    if (holder.listening) holder.close();
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

test("close() with a step that fails: every later step still runs (the web chat, the storage), the failure is raised, and the shutdown runs once however often close() is called", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-close-fail-"));
  try {
    await withFailingTransportClose(async (seen) => {
      const timer = new ManualTimer();
      let workersClosed = 0;
      const c = await startController({
        storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
        conversationTransport: { port: 0 }, chat: { interpreter: new ScriptedInterpreter(() => []) }, webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS },
        dispatch: localDispatch(timer, () => { workersClosed++; }),
      } as never);
      const webPort = c.webChat!.port;
      const conversationPort = Number(new URL(c.conversationUrl!).port);
      assert.ok(timer.armed, "the dispatcher's loop is running");
      // Two at once and one after: each is told of the failure, and the steps ran once.
      const [a, b] = [c.close(), c.close()];
      await assert.rejects(a, /conversation listener's close failed/, "close() reports the failed step");
      await assert.rejects(b, /conversation listener's close failed/);
      await assert.rejects(c.close(), /conversation listener's close failed/, "a later close() gives the same answer");
      assert.equal(seen.closes, 1, "the conversation listener was closed once");
      assert.equal(workersClosed, 1, "the workers were closed once");
      assert.equal(timer.armed, false, "the dispatcher's loop is stopped");
      // The steps after the failed one ran: the web chat's listener is gone and the storage is closed.
      await portFree(webPort);
      await portFree(conversationPort);
      assert.ok(seen.storage !== undefined);
      await assert.rejects(seen.storage.listAudit({ afterSeq: 0, limit: 1 }), /closed/, "the storage was closed after the failed step");
    });
    // A plain close() of a controller whose steps all succeed resolves, and so does a second one.
    const c2 = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], conversationTransport: { port: 0 } });
    await c2.close();
    await c2.close();
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a start whose web chat cannot listen closes the conversation listener (once) and the storage; a close that fails there never replaces the start-up error", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-web-fail-"));
  const holder = await listenAnywhere();
  const port = (holder.address() as { port: number }).port;
  try {
    await withFailingTransportClose(async (seen) => {
      const timer = new ManualTimer();
      let workersClosed = 0;
      let started: unknown;
      try {
        const c = await startController({
          storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
          conversationTransport: { port: 0 }, chat: { interpreter: new ScriptedInterpreter(() => []) }, webChat: { host: "127.0.0.1", network: "loopback", assets: ASSETS, port },
          dispatch: localDispatch(timer, () => { workersClosed++; }),
        } as never);
        await c.close();
        assert.fail("the start was expected to fail: the web chat's port is in use");
      } catch (error) { started = error; }
      assert.equal((started as NodeJS.ErrnoException).code, "EADDRINUSE", `the start-up error is the one raised, not the failed close: ${String(started)}`);
      assert.equal(seen.closes, 1, "the conversation listener was closed once");
      assert.equal(workersClosed, 1, "the workers were closed once");
      assert.equal(timer.armed, false, "the dispatcher's loop is stopped");
      assert.ok(seen.storage !== undefined);
      await assert.rejects(seen.storage.listAudit({ afterSeq: 0, limit: 1 }), /closed/, "the storage was closed after the failed step");
    });
    // The same database opens again at once.
    const c2 = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [] });
    await c2.close();
  } finally {
    await new Promise<void>((resolve) => holder.close(() => resolve()));
    rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
