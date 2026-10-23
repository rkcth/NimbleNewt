import assert from "node:assert/strict";
import { join } from "node:path";
import { after, test } from "node:test";
import { FaultInjectingStorage, type ControllerStorage, type ScriptedFault } from "@nimblenewt/controller";
import { ANSWER, Chaos, Clock as ClockImpl, adapterProbe, check, cleanRun, engines, openAdapter, pickIndexes, openStore, piConversation, runPath, startProcess, stopServer, verifyFinished, withEngine, type Clean, type Clock, type Slice, type SliceWorld } from "./g04-fixture.js";

/** The production fault injector (F04c), armed to fire at the Nth `applyOperation` call of the whole path and then on the retries that follow. */
export function faultAt(inner: ControllerStorage, ordinal: number, faults: readonly ScriptedFault[]): { storage: ControllerStorage; fired(): number } {
  const scripted = new FaultInjectingStorage(inner, faults);
  let calls = 0, remaining = faults.length, fired = 0;
  const storage = new Proxy(inner, {
    get: (target, name, receiver) => {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function") return value;
      if (name !== "applyOperation") return (value as (...a: unknown[]) => unknown).bind(target);
      return (input: Parameters<ControllerStorage["applyOperation"]>[0]) => {
        const mine = calls++ >= ordinal && remaining > 0;
        if (!mine) return target.applyOperation(input);
        remaining -= 1; fired += 1;
        return scripted.applyOperation(input);
      };
    },
  });
  return { storage, fired: () => fired };
}

export type Outcome = "absorbed" | "next tick" | "restart";

/**
 * Runs the path against `storage`, which misbehaves. What the services do not absorb is finished the way production would: by the same process's next
 * reconciler pass once the leases the failed pass left have ended, and failing that by a new process. Returns how far recovery had to go; the caller verifies the
 * final state. (A reconciler pass that meets a storage error counts it and ends; it does not throw, so "finished" is judged by the state, not by the absence of an error.)
 */
export async function runWithRecovery(world: SliceWorld, clock: Clock): Promise<{ outcome: Outcome; slice: Slice }> {
  const finished = async (slice: Slice): Promise<boolean> => (await check(slice, world)).length === 0;
  let slice: Slice | undefined = await startProcess(world, "p1").catch(() => undefined);
  if (slice !== undefined) {
    await runPath(slice).catch(() => undefined);
    if (await finished(slice).catch(() => false)) return { outcome: "absorbed", slice };
    clock.advance(10 * 60_000);
    await runPath(slice).catch(() => undefined);
    if (await finished(slice).catch(() => false)) return { outcome: "next tick", slice };
  }
  clock.advance(10 * 60_000);
  slice = await startProcess(world, "p2");
  await runPath(slice);
  return { outcome: "restart", slice };
}

/** The scripted storage misbehaviours: a rolled-back transaction, an ambiguous commit that did commit, one that did not, and a burst longer than the retry budget. */
export const KINDS: { name: string; faults: ScriptedFault[]; mustAbsorb: boolean }[] = [
  { name: "a transaction rolled back (retryable)", faults: [{ when: "before", kind: "retryable" }], mustAbsorb: true },
  { name: "an ambiguous commit that did commit", faults: [{ when: "after", kind: "uncertain_commit" }], mustAbsorb: true },
  { name: "an ambiguous commit that did not commit", faults: [{ when: "before", kind: "uncertain_commit" }], mustAbsorb: true },
  { name: "six rollbacks in a row (more than the retry budget)", faults: Array.from({ length: 6 }, () => ({ when: "before", kind: "retryable" }) as const), mustAbsorb: false },
];

/** Card G04, ambiguous commits and rollbacks at every operation of the whole path, on one real database, with the real Pi adapter. */
export function defineFaultTests(engineName: string): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);

  for (const kind of KINDS) {
    test(`${engine.name}: ${kind.name} at each sampled operation of the path (each of them when exhaustive): ${kind.mustAbsorb ? "absorbed by the commit protocol, the operation applied once" : "surfaced, then finished by the next pass or a restart, nothing applied twice"}`, async () => {
      const clean: Clean = await withEngine(engine, (spec, dir) => cleanRun(spec, dir));
      const failures: string[] = [];
      const outcomes: Record<Outcome, number> = { absorbed: 0, "next tick": 0, restart: 0 };
      const keyOps = clean.operations.flatMap((o, i) => (o.type !== "scan.cursor" && o.type !== "delivery.receipt" ? [i] : []));
      for (const k of pickIndexes(clean.operations.length, keyOps.filter((_, j) => j % 2 === 0), 4)) {
        await withEngine(engine, async (spec, dir) => {
          const storage = await openStore(spec);
          const { adapter } = await openAdapter(join(dir, "pi"), ANSWER);
          const injected = faultAt(storage, k, kind.faults);
          const clock = new ClockImpl();
          const world: SliceWorld = { storage: injected.storage, directory: dir, chaos: new Chaos(), clock: clock.now, conversation: () => piConversation(adapter) };
          const label = `operation ${k} (${clean.operations[k]!.type})`;
          try {
            const { outcome, slice } = await runWithRecovery(world, clock);
            outcomes[outcome] += 1;
            // The last operations have fewer calls left than a long burst needs.
            if (injected.fired() < (kind.mustAbsorb ? kind.faults.length : 1)) failures.push(`${label}: only ${injected.fired()} of ${kind.faults.length} faults fired`);
            if (kind.mustAbsorb && outcome !== "absorbed") failures.push(`${label}: not absorbed (${outcome})`);
            failures.push(...(await verifyFinished(slice, world, adapterProbe(adapter), clean, undefined, kind.mustAbsorb ? undefined : /^delivery-failures /)).map((p) => `${label}: ${p}`));
          } finally { await adapter.close(); await storage.close(); }
        });
      }
      assert.deepEqual(failures, []);
      if (!kind.mustAbsorb) assert.ok(outcomes["next tick"] + outcomes.restart > 0, "a burst beyond the retry budget must surface somewhere");
      console.log(`# g04 faults[${engine.name}] ${kind.name}: ${Object.values(outcomes).reduce((a, b) => a + b, 0)} of ${clean.operations.length} operations; ${JSON.stringify(outcomes)}`);
    });
  }
}
