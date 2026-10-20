import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test } from "node:test";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { DeliveryDispatcher, TASK_EVENTS, derivedId, taskEventId } from "./index.js";
import { ProjectService } from "./service.js";

const child = fileURLToPath(new URL("./testing/delivery-child.js", import.meta.url));
const guard = pathToFileURL(fileURLToPath(new URL("../../../../scripts/offline-guard.mjs", import.meta.url))).href;
const T = "2026-10-20T10:00:00.000Z";
const LATER = "2026-10-20T10:05:00.000Z";

function run(mode: string, directory: string): Promise<{ killed: boolean; out: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ["--import", guard, child, mode, directory], { stdio: ["ignore", "pipe", "inherit"] });
    let out = "";
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.on("error", reject);
    proc.on("exit", (code, signal) => resolve({ killed: signal !== null || code !== 0, out }));
  });
}

/** The destination, as the child writes it: one delivery ID per line, deduplicated by the handler. */
const engineLines = (dir: string): string[] => (existsSync(join(dir, "engine.log")) ? readFileSync(join(dir, "engine.log"), "utf8").split("\n").filter(Boolean) : []);
const handlerFor = (dir: string) => async (d: { deliveryId: string }) => { if (!engineLines(dir).includes(d.deliveryId)) appendFileSync(join(dir, "engine.log"), `${d.deliveryId}\n`); return {}; };

async function scenario(mode: string, seedTask: boolean, check: (dir: string, storage: SqliteStorage, projects: ProjectService, taskId: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "nn deliver-crash-"));
  try {
    const seed = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    const { epoch } = await seed.acquireEpoch({ holder: "seed", at: T });
    const seeding = ProjectService.withEpoch(seed, epoch, { clock: () => T });
    const project = await seeding.createProject({ commandId: "crash-project", actor: "seed", name: "Crash" });
    if (seedTask) await seeding.createTask({ commandId: "crash-task", actor: "seed", projectId: project.id, title: "crash test" });
    await seed.close();

    const crashed = await run(mode, dir);
    assert.equal(crashed.killed, true, `the child should have been killed at ${mode}`);
    assert.equal(crashed.out.includes("finished"), false);

    const storage = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
    try {
      await check(dir, storage, ProjectService.withEpoch(storage, await storage.currentEpoch(), { clock: () => LATER, pause: async () => undefined }), derivedId("task", "crash-task"));
    } finally { await storage.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

const dispatch = async (storage: SqliteStorage, dir: string) => new DeliveryDispatcher(storage, await storage.currentEpoch(), { destination: TASK_EVENTS, claimant: "restart", handler: handlerFor(dir), clock: () => LATER, pause: async () => undefined }).runOnce();

test("killed just before the task's transaction commits: there is no task and no message, and the same command makes both exactly once", () =>
  scenario("create-before-commit", false, async (dir, storage, projects, taskId) => {
    assert.equal(await projects.getTask(taskId), undefined);
    assert.equal(await storage.getDelivery(taskEventId(taskId, 1)), undefined, "no message for a change that did not happen");
    assert.deepEqual(await projects.reconcileTaskEvents({ limit: 10 }), { checked: 0, repaired: [], failed: [] });
    const project = (await projects.listProjects({ limit: 1 }))[0]!;
    const made = await projects.createTask({ commandId: "crash-task", actor: "child", projectId: project.id, title: "crash test" });
    assert.equal(made.replayed, false);
    assert.equal((await dispatch(storage, dir)).delivered, 1);
    assert.deepEqual(engineLines(dir), [taskEventId(taskId, 1)]);
  }));

test("killed just after the task's transaction commits: the committed change has its message, found and delivered once after restart", () =>
  scenario("create-after-commit", false, async (dir, storage, projects, taskId) => {
    assert.ok(await projects.getTask(taskId));
    assert.equal((await storage.getDelivery(taskEventId(taskId, 1)))?.state, "pending", "the message was committed with the change");
    assert.deepEqual((await projects.reconcileTaskEvents({ limit: 10 })).repaired, [], "nothing to repair: the command announced itself");
    assert.equal((await dispatch(storage, dir)).delivered, 1);
    assert.deepEqual(engineLines(dir), [taskEventId(taskId, 1)]);
    assert.equal((await projects.createTask({ commandId: "crash-task", actor: "child", projectId: (await projects.getTask(taskId))!.projectId, title: "crash test" })).replayed, true);
    assert.equal((await dispatch(storage, dir)).delivered, 0, "the repeated command announced nothing");
  }));

test("killed after the destination has the message and before the receipt: it is handed over again after the lease ends, the destination holds it once, and the receipt is then recorded", () =>
  scenario("deliver-before-receipt", true, async (dir, storage, _projects, taskId) => {
    assert.deepEqual(engineLines(dir), [taskEventId(taskId, 1)]);
    assert.equal((await storage.getDelivery(taskEventId(taskId, 1)))?.state, "claimed");
    assert.equal((await dispatch(storage, dir)).delivered, 1);
    assert.deepEqual(engineLines(dir), [taskEventId(taskId, 1)], "handed over twice, held once");
    const record = await storage.getDelivery(taskEventId(taskId, 1));
    assert.deepEqual([record?.state, record?.attempts], ["delivered", 2]);
  }));

test("killed after the receipt committed: the message is delivered and is not handed over again", () =>
  scenario("deliver-after-receipt", true, async (dir, storage, _projects, taskId) => {
    assert.equal((await storage.getDelivery(taskEventId(taskId, 1)))?.state, "delivered");
    assert.equal((await dispatch(storage, dir)).delivered, 0);
    assert.deepEqual(engineLines(dir), [taskEventId(taskId, 1)]);
  }));
