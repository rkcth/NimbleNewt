import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { copyPiState } from "../backup/pi-state.js";
import { BackupService, MaintenanceBarrier, StagedRestore } from "../backup/index.js";
import { retireSupersededRemoteStores } from "../backup/staged-restore.js";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import type { Principal } from "../security/principals.js";
import { SqliteStorage } from "../storage/index.js";
import { PiStateHost, PiStateTransfers, RemotePiRestore, RemotePiState, newPiId } from "./pi-state.js";
import type { WorkspaceAsk } from "./protocol.js";
import { lastingReasons } from "./service.js";
import { remoteSuite } from "./testing/suite.js";

after(stopServer);

// Card K01i, clean-context review: what the first review of the finishing slice found and fixed.
const A1 = "att-aaaaaaaaaaaaaaaaaaaa";
const OWNER = { id: "owner:rob", kind: "owner", name: "rob", grants: [] } as unknown as Principal;
const tmp = (): string => mkdtempSync(join(tmpdir(), "nn-k01ifr-"));

/** A host with one attempt's store, and a controller section holding the restored store the host is asked to fetch. */
async function deliveryRig(options: { busy?: () => string[]; final?: (id: string, def: string) => string | undefined; tamper?: (name: string, chunk: { data: Buffer; offset: number; size: number; eof: boolean; sha256?: string }) => { data: Buffer; offset: number; size: number; eof: boolean; sha256?: string } } = {}) {
  const d = tmp();
  const target = join(d, "host", "attempts", A1, "home", "pi");
  mkdirSync(target, { recursive: true }); writeFileSync(join(target, "log.jsonl"), "on the host now\n");
  const restored = join(d, "ctl", "restored"); mkdirSync(restored, { recursive: true }); writeFileSync(join(restored, "log.jsonl"), "from the backup\n");
  const section = join(d, "ctl", "out"); mkdirSync(section, { recursive: true });
  await copyPiState({ list: async () => [{ id: A1, dir: restored }] }, section, undefined);
  const transfers = new PiStateTransfers({ directory: join(d, "ctl", "in") });
  const transferId = newPiId("pst");
  transfers.serve(transferId, "host:h1", section);
  const client = {
    piStatePut: async () => undefined,
    piStateGet: async (t: string, name: string, offset: number) => {
      const c = await transfers.get("host:h1", t, name, offset);
      const chunk = { data: Buffer.from(c.data, "base64"), offset: c.offset, size: c.size, eof: c.eof, ...(c.sha256 === undefined ? {} : { sha256: c.sha256 }) };
      return options.tamper === undefined ? chunk : options.tamper(name, chunk);
    },
  };
  const host = new PiStateHost({ client, source: { list: async () => [] }, final: (id) => (id === A1 ? (options.final ?? ((_i, def) => def))(id, target) : undefined), busy: options.busy ?? (() => []), scratch: join(d, "host", "scratch") });
  const ask = { requestId: newPiId("wsr"), operation: "pi-state-restore", taskId: "pi-state", projectId: "pi-state", reason: "r", quietAttempts: [], piState: { transferId } } as unknown as WorkspaceAsk;
  return { d, target, host, ask, homeEntries: () => readdirSync(join(target, "..")).sort(), close: () => rmSync(d, { recursive: true, force: true }) };
}

test("a host asks again whether the agent runs right before it swaps: an agent that started while the store was fetched keeps its store (card K01i review)", async () => {
  let calls = 0;
  const r = await deliveryRig({ busy: () => (++calls === 1 ? [] : [A1]) });
  try {
    const answer = await r.host.answer(r.ask);
    assert.equal(answer.ok, false);
    assert.match((answer as { reason: string }).reason, /started on this host while its store was being fetched/);
    assert.equal(calls, 2);
    assert.equal(readFileSync(join(r.target, "log.jsonl"), "utf8"), "on the host now\n", "the running agent's store is untouched");
    assert.deepEqual(r.homeEntries(), ["pi"], "no aside and no staged copy is left");
  } finally { r.close(); }
  // Not running at either moment: swapped in, the old one kept aside.
  const ok = await deliveryRig();
  try {
    const answer = await ok.host.answer(ok.ask);
    assert.equal(answer.ok, true, JSON.stringify(answer));
    assert.equal(readFileSync(join(ok.target, "log.jsonl"), "utf8"), "from the backup\n");
    assert.equal(ok.homeEntries().filter((n) => n.startsWith("pi.before-restore-")).length, 1);
  } finally { ok.close(); }
});

test("a host judges the store's place again before the swap: a place that is no longer a plain folder is not moved through (card K01i review)", async () => {
  let calls = 0;
  const r = await deliveryRig({ final: (_id, def) => (++calls === 1 ? def : undefined) });
  try {
    const answer = await r.host.answer(r.ask);
    assert.equal(answer.ok, false);
    assert.match((answer as { reason: string }).reason, /place of .* changed/);
    assert.equal(readFileSync(join(r.target, "log.jsonl"), "utf8"), "on the host now\n");
    assert.deepEqual(r.homeEntries(), ["pi"]);
  } finally { r.close(); }
});

test("a controller that keeps sending a file, or an index, cannot fill the host's disk: the host stops at the size it may be (card K01i review)", async () => {
  for (const which of ["file", "index"] as const) {
    let calls = 0;
    const r = await deliveryRig({ tamper: (name, c) => {
      if ((which === "index") !== (name === "index.jsonl")) return c;
      if (++calls > 400) throw new Error("the host kept fetching without end");
      return { data: Buffer.alloc(512 * 1024, 1), offset: c.offset, size: Number.MAX_SAFE_INTEGER, eof: false };
    } });
    try {
      const answer = await r.host.answer(r.ask);
      assert.equal(answer.ok, false);
      assert.match((answer as { reason: string }).reason, /longer than it may be/, which);
      assert.equal(readFileSync(join(r.target, "log.jsonl"), "utf8"), "on the host now\n");
    } finally { r.close(); }
  }
});

test("a restore applied later retires the stores an earlier restore left for remote hosts and never delivered, unless it put one of the same name there itself (card K01i review)", async () => {
  const data = tmp();
  try {
    const folder = join(data, "restored-pi-state");
    for (const n of ["rh.h1.att-old", "rh.h1.att-new", "rh.h1.att-x.before-restore-1", "att-local", "rh.h2.att-y.nn-staged-2"]) mkdirSync(join(folder, n), { recursive: true });
    const j = { stamp: "20261112T000000000Z", moves: [{ to: join(folder, "rh.h1.att-new") }, { to: join(data, "db.sqlite") }] };
    assert.equal(await retireSupersededRemoteStores(data, j), 1);
    assert.deepEqual(readdirSync(folder).sort(), ["att-local", "rh.h1.att-new", "rh.h1.att-x.before-restore-1", "rh.h2.att-y.nn-staged-2"]);
    assert.deepEqual(readdirSync(join(data, "restored-pi-state-superseded")), ["rh.h1.att-old-20261112T000000000Z"], "moved, not deleted");
    assert.equal(await retireSupersededRemoteStores(data, j), 0, "run again after a crash: nothing more");
    // What the delivery sees afterwards: only the store this restore made.
    const deliver = new RemotePiRestore({ dataDirectory: data, transfers: new PiStateTransfers({ directory: join(data, "in") }), ask: async () => ({ ok: false, reason: "offline" }) });
    assert.deepEqual((await deliver.state()).waiting, [{ hostId: "host:h1", stores: 1 }]);
    assert.equal(await deliver.waits("host:h1", "att-new"), true);
    assert.equal(await deliver.waits("host:h1", "att-old"), false);
    assert.equal(await deliver.waits("host:h2", "att-new"), false);
    assert.equal(await deliver.waits("host:BAD", "att-new"), false);
  } finally { rmSync(data, { recursive: true, force: true }); }
});

test("a host is not offered an attempt while its restored store waits for it there; the reason passes, so the attempt starts once the store is delivered (card K01i review)", () => {
  assert.equal(lastingReasons(["host:h1 has not received the restored conversation store of att-aaaaaaaaaaaaaaaaaaaa yet"]), false);
  assert.equal(lastingReasons(["host:h1 has not received the restored conversation store of att-x yet", "the attempt's credential may not be given to host:h1"]), true);
});

for (const backend of backends.slice(0, 2)) {
  const waiting = { on: true as boolean | "throw", asked: [] as string[] };
  remoteSuite(backend)("a host's refusal names a restored store that waits for it there, as a reason that passes (the dispatcher waits, H07e); none once it is delivered; a check that fails holds it too (card K01i review)", async (c) => {
    const r1 = await c.host("r1");
    const q = { hostId: r1.id, attemptId: A1, taskId: "task-x", projectId: c.project, agentId: "agent:ann", requirements: { data: "cloud-allowed" as const } };
    const held = await c.remote.refusals(c.dispatcherPrincipal, q);
    assert.deepEqual(held, { reasons: [`${r1.id} has not received the restored conversation store of ${A1} yet`], lasting: false });
    assert.deepEqual(waiting.asked, [`${r1.id} ${A1}`]);
    waiting.on = "throw";
    assert.equal((await c.remote.refusals(c.dispatcherPrincipal, q)).reasons.length, 1, "a check that cannot be read holds the attempt back");
    waiting.on = false;
    assert.deepEqual(await c.remote.refusals(c.dispatcherPrincipal, q), { reasons: [], lasting: false }, "delivered: nothing holds it");
  }, { restoreWaits: async (hostId, attemptId) => { waiting.asked.push(`${hostId} ${attemptId}`); if (waiting.on === "throw") throw new Error("unreadable"); return waiting.on; } });
}

test("two backups listing remote stores at once: the second waits for the first to release and then runs; neither hangs (card K01i review)", async () => {
  const d = tmp();
  try {
    const order: string[] = [];
    const source = new RemotePiState({ directory: join(d, "in"), transfers: new PiStateTransfers({ directory: join(d, "in") }), hosts: async () => ({ ask: [], unreachable: [] }), ask: async () => ({ ok: false, reason: "-" }) });
    const one = source.list().then(() => order.push("first listed"));
    const two = source.list().then(() => order.push("second listed"));
    await one;
    await new Promise((res) => setTimeout(res, 20));
    assert.deepEqual(order, ["first listed"], "the second waits while the first holds the listing");
    await source.release();
    await Promise.race([two, new Promise((_, no) => setTimeout(() => no(new Error("the second listing hung")), 2000))]);
    await source.release();
    const three = source.list();
    await Promise.race([three, new Promise((_, no) => setTimeout(() => no(new Error("the third listing hung")), 2000))]);
    await source.release();
    assert.deepEqual(order, ["first listed", "second listed"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a restore that stopped the work and then fails says the work stays stopped (card K01i review)", async () => {
  const d = tmp();
  const data = join(d, "data"); mkdirSync(data);
  const sqlite = join(data, "c.sqlite");
  const storage = await SqliteStorage.open({ path: sqlite });
  try {
    const AT = "2026-10-31T10:00:00.000Z";
    const { epoch } = await storage.acquireEpoch({ holder: "c1", at: AT });
    await storage.applyOperation({ operationId: "op-1", epoch, actor: "owner:rob", correlationId: "co-1", at: AT, changes: [{ type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "x" } }], audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const backups = new BackupService(storage, { root: join(d, "b"), version: "t", now: () => new Date(AT) });
    const made = await backups.backUpNow("manual");
    const barrier = new MaintenanceBarrier();
    barrier.add({ name: "stuck", hold: async () => { throw new Error("a participant could not be held"); } });
    let stops = 0;
    const restore = new StagedRestore({ backups, root: join(d, "b"), barrier, sqlitePath: sqlite, dataDirectory: data, storage, now: () => new Date("2026-10-31T11:00:00.000Z"), stopAttempts: async () => { stops += 1; } });
    const plan = await restore.preview(made.manifest.name);
    await assert.rejects(restore.apply(plan.name, plan.token, undefined, { stopAttempts: true, by: OWNER }), (e: unknown) => e instanceof DomainError && /Agent work was stopped for this restore and stays stopped/.test(e.message));
    assert.equal(stops, 1);
    assert.equal(barrier.held, false);
    assert.equal(existsSync(join(data, "pending-restore.json")), false);
    // Without stopAttempts the same failure says nothing about stopped work.
    const plan2 = await restore.preview(made.manifest.name);
    await assert.rejects(restore.apply(plan2.name, plan2.token), (e: unknown) => e instanceof Error && !/stays stopped/.test(e.message));
  } finally { await storage.close().catch(() => undefined); rmSync(d, { recursive: true, force: true }); }
});
