import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { localWorkerParts, ownerPolicyOptions } from "@nimblenewt/worker";
import { LocalWorker } from "../dispatch/local-worker.js";
import type { WorkerHost } from "../dispatch/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import { PI } from "../dispatch/testing/world.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { startController } from "./index.js";
import type { DispatchStartOptions } from "./dispatch-compose.js";

/**
 * Card U11d, the last two signals through the running controller: the local worker host, built with the controller's own services (`ownerPolicyOptions(services)`), tells the owner (1) when the protected loader configuration is
 * not as it was when an attempt's sandbox opened (`protected-path-touched`) and (2) when a launch finds a place it made for the attempt turned into a link (`sandbox-escape-attempt`). Each is exactly one Urgent item however often it
 * repeats, with no path in the label or the text sent out; an ordinary refusal raises nothing. (The Urgent items' storage on all four backends is exercised by the notification suites; this test runs on SQLite as the other start tests do.)
 */
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type BuildServices = Parameters<NonNullable<DispatchStartOptions["local"]>["build"]>[0];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => Promise<boolean>, what: string): Promise<void> => { for (let i = 0; i < 200; i++) { if (await ok()) return; await sleep(30); } assert.fail(`timed out: ${what}`); };

test("U11d: a write to the loader configuration and a checkout turned into a link each raise exactly one Urgent item through the running controller; repeats add none; no path leaves", async (t) => {
  const d = realpathSync(mkdtempSync(join(tmpdir(), "nn-sload-")));
  const sent: { text: string }[] = [];
  const channels = { chat: { send: async (m: { deliveryId: string; text: string }) => { sent.push(m); } } };
  let services: BuildServices | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: { timer: new ManualTimer(), manual: true, local: { acceptUnenforcedLimits: true, window: () => undefined, close: async () => undefined, build: (s: BuildServices) => { services = s; return new LocalWorker({ hostId: "host:w1", resources: { cpus: 1, memoryMb: 1024 }, version: "u11d", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }), guards: s.guards, sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) }, runtimes: { open: async () => { throw new Error("unused"); } } }) as unknown as WorkerHost; } } },
    notifications: { channels },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = (await c.services.principals.authenticate(boot.token))!;
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const rev = async () => (await call("notifications.settings", {})).result.item.revision as number;
    assert.ok((await call("notifications.configure", { channel: "external", channelName: "chat", expectedRevision: await rev() }, "s1")).ok);
    const notifications = NotificationService.withEpoch(c.storage, c.epoch, { channels });
    const items = async () => (await notifications.inbox(rob)).items.filter((i) => i.ref.kind === "security" && i.state !== "settled" && i.state !== "answered");
    assert.ok(services !== undefined);

    // The host as an embedder builds it: the controller's services through ownerPolicyOptions, the loader configuration named.
    const extensions = join(d, "extensions"); mkdirSync(extensions);
    writeFileSync(join(extensions, "loader.json"), '{"extensions":["desk"]}');
    const node = join(d, "node"); mkdirSync(node); writeFileSync(join(node, "marker"), "x");
    const work = { checkout: join(d, "co"), gitDir: join(d, "git"), home: join(d, "home"), scratch: join(d, "scratch") };
    for (const p of Object.values(work)) mkdirSync(p);
    const host = localWorkerParts<unknown>({
      launcher: { launch: async () => { throw new Error("not launched"); } } as never, app: { node: { root: node, executable: "bin/node" }, mounts: [], entry: "/opt/app/main.js" }, protectedPaths: [], workspace: () => work,
      model: () => { throw new Error("unused"); }, namespaceId: () => "abcdef0123456789", bridge: async () => ({ ok: false, code: "x", message: "y" }), relay: async () => { throw new Error("unused"); },
      ...ownerPolicyOptions(services!), loaderConfig: { paths: [extensions] },
    });
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const order = { attemptId: "att-1", taskId: "task-1", projectId: project, agentId: "agent:ann", route: "r", credential: "c", recipe: { revision: "r1", reach: [] as string[] } };

    // (1) The loader configuration is written during an attempt, twice in different ways over two attempts: each distinct change is one item; the same state seen again is not new.
    const first = await host.sandbox.open(order.recipe, order as never);
    writeFileSync(join(extensions, "loader.json"), '{"extensions":["desk","other"]}');
    await first.close();
    await until(async () => (await items()).length === 1, "the loader write is one item");
    const [item] = await items();
    assert.equal(item!.level, "urgent");
    assert.match(item!.label, /protected path/);
    const again = await host.sandbox.open(order.recipe, order as never);
    await again.close();
    await sleep(100);
    assert.equal((await items()).length, 1, "nothing changed since: no second item");

    // (2) A checkout turned into a link: the launch is refused as before, and the owner is told once, however often it is tried.
    const elsewhere = join(d, "elsewhere"); mkdirSync(elsewhere);
    rmSync(work.scratch, { recursive: true });
    let linked = true;
    try { symlinkSync(elsewhere, work.scratch, process.platform === "win32" ? "junction" : "dir"); } catch { linked = false; }
    if (!linked) { t.diagnostic("this system refuses to make a link: the second half is skipped"); } else {
      for (let i = 0; i < 3; i++) await assert.rejects(host.sandbox.open(order.recipe, order as never), /symbolic link/);
      await until(async () => (await items()).length === 2, "the link is the second item");
      await sleep(100);
      const all = await items();
      assert.equal(all.length, 2, "three tries of the same place are one item");
      assert.ok(all.some((i) => /sandbox/i.test(i.label)), all.map((i) => i.label).join(" | "));
      assert.ok(all.every((i) => i.level === "urgent"));
    }
    // An ordinary refusal (a place that does not exist) raises nothing.
    const before = (await items()).length;
    rmSync(work.home, { recursive: true });
    await assert.rejects(host.sandbox.open(order.recipe, order as never), /does not exist|symbolic link/);
    await sleep(100);
    assert.equal((await items()).length, before);
    await until(async () => { await c.dispatch!.dispatcher.tick(); return sent.some((m) => /protected path/.test(m.text)); }, "told on the channel");
    for (const m of sent) { assert.ok(!m.text.includes(d), "no path in what is sent"); assert.ok(!m.text.includes("loader.json")); }
    for (const i of await items()) { assert.ok(!i.label.includes(d)); }
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
