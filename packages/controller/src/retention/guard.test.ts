import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MemoryStorage } from "../storage/memory.js";
import type { ControllerStorage, OperationInput } from "../storage/types.js";
import { QuotaMeter, ReserveFile, addedBy, guardStorage, isCriticalOperation, isDiskFull, unguarded } from "./guard.js";
import { RETENTION_DEFAULTS, type RetentionValues } from "./settings.js";
import { RetainedMaterial } from "./references.js";

let n = 0;
const op = (type: string, changes: OperationInput["changes"] = []): OperationInput => ({ operationId: `op-${++n}`, epoch: 1, actor: "a", correlationId: `c-${n}`, at: "2026-10-30T10:00:00.000Z", changes, audit: [{ type, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
const create = (kind: string, id: string, body: object) => ({ type: "create" as const, ref: { kind, id }, body: body as never });
const full = (): Error => Object.assign(new Error("storage could not complete the request"), { cause: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }) });

test("a full disk is recognised from the driver's error however it is wrapped", () => {
  assert.equal(isDiskFull(full()), true);
  assert.equal(isDiskFull(Object.assign(new Error("x"), { code: "ENOSPC" })), true);
  assert.equal(isDiskFull(new Error("write failed: No space left on device")), true);
  assert.equal(isDiskFull(Object.assign(new Error("x"), { cause: { code: "53100" } })), true);
  assert.equal(isDiskFull(new Error("syntax error")), false);
  assert.equal(isDiskFull(undefined), false);
});

test("checkpoints, stops, recovery records and retention commands are critical; ordinary writes are not", () => {
  for (const t of ["continuation.capture", "continuation.resume", "stop.request", "stop.advance", "recovery-point.record", "stall.recover.begin", "resume.start", "pause.observe", "retention.delete", "retention.settings.set"]) assert.equal(isCriticalOperation(op(t)), true, t);
  for (const t of ["desk.write", "task.create", "note.write", "agent.message"]) assert.equal(isCriticalOperation(op(t)), false, t);
  assert.equal(isCriticalOperation({ audit: [] }), false);
});

test("the reserve is a real file; it is given back once, made again only when asked, and never made on a disk that cannot spare it", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-res-"));
  try {
    const r = new ReserveFile(join(d, "sub", ".reserve"));
    await r.apply(300_000);
    assert.equal(statSync(join(d, "sub", ".reserve")).size, 300_000);
    assert.equal(await r.release("t1"), true);
    assert.equal(existsSync(join(d, "sub", ".reserve")), false);
    assert.deepEqual([r.released, r.releasedAt], [true, "t1"]);
    assert.equal(await r.release("t2"), false, "there is nothing more to give back");
    await r.apply(400_000);
    assert.equal(existsSync(join(d, "sub", ".reserve")), false, "a size change does not make it again while it is in use");
    assert.equal(await r.restore(), true);
    assert.equal(statSync(join(d, "sub", ".reserve")).size, 400_000);
    assert.equal(r.released, false);
    await r.apply(0);
    assert.equal(existsSync(join(d, "sub", ".reserve")), false);
    assert.equal(await r.release("t3"), false, "no reserve, nothing to give");
    // More than the disk can spare: not made, said so, nothing left behind.
    const big = new ReserveFile(join(d, ".big"));
    await big.apply(1024 ** 4 * 8);
    assert.equal(big.short, true); assert.equal(existsSync(join(d, ".big")), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

async function guarded(values: Partial<RetentionValues>, dir: string) {
  const raw = new MemoryStorage();
  const { epoch } = await raw.acquireEpoch({ holder: "t", at: "2026-10-30T10:00:00.000Z" });
  const reserve = new ReserveFile(join(dir, ".r"));
  await reserve.apply(100_000);
  const meter = new QuotaMeter(raw, { ttlMs: 0 });
  const g = guardStorage(raw, { reserve, meter, values: async () => ({ ...RETENTION_DEFAULTS, ...values }) });
  // The disk is full until room is made; the reserve file's room is all that is left, enough for one record.
  let diskFull = true; let attempts = 0; let room = 0; let sawReserve = true;
  const real = raw.applyOperation.bind(raw);
  raw.applyOperation = (async (input: OperationInput) => {
    attempts++;
    if (diskFull) {
      if (existsSync(join(dir, ".r"))) throw full();
      if (sawReserve) { sawReserve = false; room = 1; }
      if (room-- <= 0) throw full();
    }
    return real({ ...input, epoch });
  }) as never;
  return { raw, g, reserve, attempts: () => attempts, setFull: (v: boolean) => { diskFull = v; sawReserve = existsSync(join(dir, ".r")); }, epoch, real };
}

test("with the disk full a critical write takes the reserve and succeeds, an ordinary one fails and keeps the reserve, and after that ordinary writes are refused up front", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-gd-"));
  try {
    const w = await guarded({}, d);
    await assert.rejects(() => w.g.applyOperation(op("desk.write", [create("note", "n1", { x: 1 })])), (e) => isDiskFull(e));
    assert.ok(existsSync(join(d, ".r")), "an ordinary write never takes the reserve");
    for (const [i, t] of ["continuation.capture", "stop.request", "recovery-point.record"].entries()) {
      if (i > 0) { w.setFull(false); assert.equal(await w.reserve.restore(), true); w.setFull(true); }
      const r = await w.g.applyOperation(op(t, [create("note", `c${i}`, { x: 1 })]));
      assert.equal(r.replayed, false, t);
      assert.ok(await w.raw.getAggregate({ kind: "note", id: `c${i}` }), `${t} is written`);
      assert.equal(existsSync(join(d, ".r")), false);
    }
    // The reserve is spent: an ordinary write is refused before it reaches the store.
    const before = w.attempts();
    await assert.rejects(() => w.g.applyOperation(op("desk.write", [create("note", "n2", { x: 1 })])), /reserve for shutdown and recovery records is in use/);
    assert.equal(w.attempts(), before);
    // A second critical write while still full and with nothing left to give fails: never reported as done.
    await assert.rejects(() => w.g.applyOperation(op("stop.advance", [create("note", "c9", { x: 1 })])), (e) => isDiskFull(e));
    assert.equal(await w.raw.getAggregate({ kind: "note", id: "c9" }), undefined);
    // Room made: the reserve returns and ordinary writes resume.
    w.setFull(false);
    assert.equal(await w.reserve.restore(), true);
    await w.g.applyOperation(op("desk.write", [create("note", "n3", { x: 1 })]));
    assert.ok(await w.raw.getAggregate({ kind: "note", id: "n3" }));
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a repeat of an operation that already committed is answered even in the protected state or over a quota", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-gd2-"));
  try {
    const w = await guarded({}, d);
    w.setFull(false);
    const first = op("desk.write", [create("desk-record", "dsk-a", { projectId: "proj-a", owner: "agent:a", title: "t", body: "b" })]);
    await w.g.applyOperation(first);
    w.setFull(true);
    await w.reserve.release("t");
    const again = await w.g.applyOperation(first);
    assert.equal(again.replayed, true);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("quotas: off by default, per project and per agent when set, counted from the records and from what is admitted; history entries count to their scope's project", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-q-"));
  try {
    const rec = (id: string, project: string, owner: string, size: number) => create("desk-record", id, { projectId: project, owner, title: "t", body: "x".repeat(size) });
    const w = await guarded({}, d); w.setFull(false); await w.reserve.apply(0);
    await w.g.applyOperation(op("desk.write", [rec("d1", "proj-a", "agent:a", 3000)]));
    const q = await guarded({ quotaProjectBytes: 4000, quotaAgentBytes: 5000 }, d); q.setFull(false); await q.reserve.apply(0);
    await q.g.applyOperation(op("desk.write", [rec("d1", "proj-a", "agent:a", 3000)]));
    await assert.rejects(() => q.g.applyOperation(op("desk.write", [rec("d2", "proj-a", "agent:b", 1500)])), /project proj-a is over its storage quota/);
    await q.g.applyOperation(op("desk.write", [rec("d3", "proj-b", "agent:b", 1500)]));
    await assert.rejects(() => q.g.applyOperation(op("desk.write", [rec("d4", "proj-c", "agent:a", 3000)])), /agent:a is over its storage quota/);
    // A critical record is never refused for a quota.
    await q.g.applyOperation(op("stop.request", [rec("d5", "proj-a", "agent:a", 3000)]));
    // A history entry counts toward the project of its scope.
    const scope = (n: number) => ({ type: "update" as const, ref: { kind: "history-scope", id: "hst-1" }, expectedRevision: n, body: { projectId: "proj-d", count: n } as never });
    await q.g.applyOperation(op("history.open", [create("history-scope", "hst-1", { projectId: "proj-d", count: 0 })]));
    await assert.rejects(() => q.g.applyOperation(op("history.append", [scope(1), create("history-entry", "hst-1.1", { scope: "hst-1", seq: 1, role: "user", author: "agent:z", text: "y".repeat(4500) })])), /project proj-d is over its storage quota/);
    assert.deepEqual([...addedBy(op("x", [create("history-scope", "hst-1", { projectId: "proj-d" }), create("history-entry", "hst-1.1", { scope: "hst-1", text: "hi" })])).project.keys()], ["proj-d"]);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("what a resumable task or a replay needs is retained; a finished task's material is free; a scan that did not finish retains everything", async () => {
  const raw = new MemoryStorage(); await raw.acquireEpoch({ holder: "t", at: "2026-10-30T10:00:00.000Z" });
  await raw.applyOperation(op("seed", [
    create("task", "task-live", { projectId: "proj-a", state: "in_progress" }), create("task", "task-done", { projectId: "proj-a", state: "done" }),
    create("desk-record", "dsk-live", { projectId: "proj-a", taskId: "task-live" }), create("desk-record", "dsk-done", { projectId: "proj-a", taskId: "task-done" }),
    create("desk-record", "dsk-cited", { projectId: "proj-a" }), create("desk-record", "dsk-scratch", { projectId: "proj-a" }), create("desk-record", "dsk-free", { projectId: "proj-a" }),
    create("artifact", "art-live", { projectId: "proj-a", taskId: "task-live" }), create("artifact", "art-listed", { projectId: "proj-a" }),
    create("history-scope", "hst-live", { projectId: "proj-a", taskId: "task-live" }), create("history-scope", "hst-cited", { projectId: "proj-a" }),
    create("ctx-compaction", "cmp-1", { taskId: "task-live", sources: [{ kind: "desk-record", id: "dsk-cited" }, { kind: "history-entry", scopeId: "hst-cited", seq: 1 }], pinned: [], summaryId: "sum-1" }),
    create("ctx-compaction", "cmp-done", { taskId: "task-done", sources: [{ kind: "desk-record", id: "dsk-free" }], pinned: [] }),
    create("continuation", "cnt-1", { taskId: "task-live", continuation: { artifacts: ["art-listed"] }, scratchRecords: ["dsk-scratch"], manifest: { summaryLineage: ["cmp-0"], sourceRanges: [{ source: "hst-cited", from: 1, to: 2 }] } }),
  ] as never));
  const m = await RetainedMaterial.build(raw);
  assert.equal(m.complete, true);
  for (const [k, id] of [["desk-record", "dsk-live"], ["desk-record", "dsk-cited"], ["desk-record", "dsk-scratch"], ["artifact", "art-live"], ["artifact", "art-listed"], ["history-scope", "hst-live"], ["history-scope", "hst-cited"], ["summary-record", "sum-1"], ["ctx-compaction", "cmp-1"], ["ctx-compaction", "cmp-0"], ["continuation", "cnt-1"]] as const) assert.ok(m.why(k, id), `${k}/${id} is retained`);
  for (const [k, id] of [["desk-record", "dsk-done"], ["desk-record", "dsk-free"], ["ctx-compaction", "cmp-done"], ["summary-record", "sum-none"]] as const) assert.equal(m.why(k, id), undefined, `${k}/${id} is free`);
  assert.deepEqual([...m.tasks.keys()], ["task-live"]);
  void unguarded;
});
