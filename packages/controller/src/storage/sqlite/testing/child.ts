/**
 * Child process for the SQLite tests. Usage: node child.js <mode> <database> [args...]. It prints one line per event so the
 * parent can see exactly what was acknowledged before it kills or inspects the process.
 */
import { setTimeout as sleep } from "node:timers/promises";
import { commitOperation } from "../../commit.js";
import { StorageError } from "../../errors.js";
import type { OperationInput } from "../../types.js";
import { ACTIONS, type BoundaryAction } from "../../qualification/boundaries.js";
import { registry, type RegistryName } from "../../qualification/migration-registry.js";
import { SqliteStorage } from "../storage.js";

const [mode, database, a, b, c] = process.argv.slice(2) as [string, string, string?, string?, string?];
const T0 = "2026-10-19T12:00:00.000Z";
const base = (operationId: string): OperationInput => ({
  operationId, epoch: 1, actor: "child", correlationId: `corr-${operationId}`, at: T0, changes: [], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [],
  completeDeliveries: [], completeTimers: [], settleEffects: [],
});
const say = (line: string) => process.stdout.write(`${line}\n`);

// The migration mode opens (and so migrates) the database with the named synthetic migrations, killed at an exact statement.
if (mode === "migrate") {
  const [when, ordinalText, registryName] = [a!, b!, c as RegistryName];
  const target = ordinalText === "none" ? 0 : Number(ordinalText);
  let last = 0;
  const storage = await SqliteStorage.open({
    path: database, busyTimeoutMs: 20_000, migrations: registry("sqlite", registryName),
    testHooks: { statement: (phase, _sql, ordinal) => {
      last = Math.max(last, ordinal);
      if (target !== 0 && ordinal === target && phase === when) process.kill(process.pid, "SIGKILL");
    } },
  });
  say(`completed ${last}`);
  await storage.close();
  process.exit(0);
}

// The crash-boundary mode opens its own storage with a hook that kills this process at an exact statement.
if (mode === "boundary") {
  const [when, ordinalText, actionName] = [a!, b!, c as BoundaryAction["name"]];
  const target = ordinalText === "none" ? 0 : Number(ordinalText);
  let armed = false;
  let last = 0;
  const storage = await SqliteStorage.open({
    path: database, busyTimeoutMs: 20_000,
    testHooks: { statement: (phase, _sql, ordinal) => {
      if (!armed) return;
      last = Math.max(last, ordinal);
      if (target !== 0 && ordinal === target && phase === when) process.kill(process.pid, "SIGKILL");
    } },
  });
  armed = true;
  await ACTIONS[actionName].run(storage);
  say(`completed ${last}`);
  await storage.close();
  process.exit(0);
}

const storage = await SqliteStorage.open({ path: database, busyTimeoutMs: 20_000 });

if (mode === "counter") {
  // Increment a shared counter `n` times against other processes doing the same; every step is audited and announced.
  const worker = a!;
  const times = Number(b);
  let done = 0;
  while (done < times) {
    const current = await storage.getAggregate({ kind: "counter", id: "c" });
    const revision = current!.revision;
    try {
      await commitOperation(storage, {
        ...base(`${worker}-${done}`), changes: [{ type: "update", ref: { kind: "counter", id: "c" }, expectedRevision: revision, body: { by: worker, n: revision } }],
        audit: [{ type: "counter.bumped", detail: { worker, step: done } }],
        outbox: [{ deliveryId: `${worker}-${done}`, destination: "d", priority: 5, aggregate: { kind: "counter", id: "c" }, payload: {} }],
      }, { attempts: 50, pause: () => sleep(1) });
      done += 1;
      say(`ok ${worker}-${done}`);
    } catch (error) {
      if (error instanceof StorageError && error.kind === "revision_conflict") continue; // someone else won this revision; read again
      throw error;
    }
  }
} else if (mode === "claim") {
  // Claim deliveries until none are left, printing each claimed ID.
  for (;;) {
    let claims;
    try {
      claims = await storage.claimDeliveries({ epoch: 1, destination: "d", claimant: a!, now: "2030-01-01T00:00:00.000Z", leaseMs: 3_600_000, limit: 3 });
    } catch (error) {
      if (error instanceof StorageError && error.kind === "retryable") { await sleep(2); continue; }
      throw error;
    }
    if (claims.length === 0) break;
    for (const claim of claims) say(`claimed ${claim.deliveryId}`);
  }
} else if (mode === "ack-loop") {
  // Apply conforming operations forever, printing each after it was acknowledged; the parent kills this process at random.
  const start = (await storage.getAggregate({ kind: "counter", id: "c" }))!.revision;
  for (let i = start; ; i++) {
    const current = await storage.getAggregate({ kind: "counter", id: "c" });
    const revision = current!.revision;
    await storage.applyOperation({
      ...base(`loop-${i}`), changes: [{ type: "update", ref: { kind: "counter", id: "c" }, expectedRevision: revision, body: { i } }],
      audit: [{ type: "counter.bumped", detail: { i } }],
      outbox: [{ deliveryId: `loop-${i}`, destination: "d", priority: 5, aggregate: { kind: "counter", id: "c" }, payload: { i }, orderingKey: "k" }],
      effects: [{ effectId: `loop-${i}`, target: "t", inputDigest: "0".repeat(64) }],
    });
    say(`acked ${i}`);
  }
} else if (mode === "hold-lock") {
  // Hold the write lock until told to stop (stdin closes), to exercise bounded busy handling in the parent.
  const { DatabaseSync } = await import("node:sqlite");
  const raw = new DatabaseSync(database);
  raw.exec("BEGIN IMMEDIATE");
  say("locked");
  process.stdin.resume();
  await new Promise((resolve) => process.stdin.on("end", resolve));
  raw.exec("ROLLBACK");
  raw.close();
} else {
  throw new Error(`unknown mode ${mode}; ${b ?? ""}${c ?? ""}`);
}
await storage.close();
