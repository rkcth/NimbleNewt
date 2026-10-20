import assert from "node:assert/strict";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { setTimeout as sleep } from "node:timers/promises";
import { commitOperation } from "../commit.js";
import { StorageError } from "../errors.js";
import type { ControllerStorage, DeliveryClaim, OperationInput } from "../types.js";

/**
 * A synthetic storage workload: many concurrent loops that behave like the controller's use of storage (transition a task with
 * audit and an outbox message, claim and complete messages, heartbeat from hosts, read for inquiries) against any
 * `ControllerStorage`. It measures what storage does under that load: latency, throughput, contention and event-loop stalls. It
 * does NOT model language-model agents, and a result here says nothing about how many real agents a deployment can run.
 */

export interface WorkloadSpec {
  readonly name: string;
  /** Concurrent task loops ("active agent equivalents"): each transitions its own task and works through outbox messages. */
  readonly agents: number;
  /** Hosts that only send a heartbeat (an update of their own record) every `hostPeriodMs`. */
  readonly idleHosts: number;
  readonly hostPeriodMs: number;
  /** Loops that read like an inquiry: one aggregate and a page of the audit log. */
  readonly inquirers: number;
  /** Every agent step also updates one shared aggregate by revision, the worst case for conflicts. */
  readonly hotRow: boolean;
  /** Mean pause between an agent's steps (uniform 0 to twice this). */
  readonly thinkMs: number;
  readonly durationMs: number;
  readonly warmupMs: number;
  /**
   * For short smoke runs on slow machines: the agents keep going past the deadline (at most 30 s) until this many transitions after the warm-up have been
   * applied, so a run cannot end having done nothing. Unset for measurements, which are timed.
   */
  readonly minTransitions?: number;
}

export interface LatencyStats { readonly count: number; readonly perSecond: number; readonly p50: number; readonly p95: number; readonly p99: number; readonly max: number }

export interface WorkloadResult {
  readonly spec: WorkloadSpec;
  readonly measuredMs: number;
  /** End-to-end latency per kind of step, in milliseconds, after warm-up. Includes retries inside the step. */
  readonly latency: Record<string, LatencyStats>;
  /** Raw storage calls by outcome (`ok`, or the error kind), over the whole run: this is where contention shows. */
  readonly calls: Record<string, Record<string, number>>;
  readonly conflictsRetriedByCaller: number;
  readonly eventLoopDelayMs: { readonly p50: number; readonly p99: number; readonly max: number };
  readonly pool?: { readonly maxTotal: number; readonly maxWaiting: number };
  readonly invariants: { readonly transitionsApplied: number; readonly auditGapFree: boolean; readonly deliveriesUnique: boolean; readonly revisionsMatch: boolean; readonly deliveriesClaimedTwice: number };
}

const ISO = (ms: number) => new Date(Date.parse("2026-10-19T12:00:00.000Z") + ms).toISOString();
const percentile = (sorted: readonly number[], p: number): number => (sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!);

function stats(samples: readonly number[], seconds: number): LatencyStats {
  const sorted = [...samples].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 100) / 100;
  return { count: sorted.length, perSecond: round(sorted.length / seconds), p50: round(percentile(sorted, 50)), p95: round(percentile(sorted, 95)), p99: round(percentile(sorted, 99)), max: round(sorted[sorted.length - 1] ?? 0) };
}

/** Wraps a storage so every raw call is counted by method and outcome. */
function metered(storage: ControllerStorage, calls: Record<string, Record<string, number>>): ControllerStorage {
  return new Proxy(storage, {
    get(target, name, receiver) {
      const value = Reflect.get(target, name, receiver) as unknown;
      if (typeof value !== "function" || typeof name !== "string" || name === "close") return value;
      return async (...args: unknown[]) => {
        const bucket = (calls[name] ??= {});
        try {
          const result = await (value as (...a: unknown[]) => Promise<unknown>).apply(target, args);
          bucket.ok = (bucket.ok ?? 0) + 1;
          return result;
        } catch (error) {
          const kind = error instanceof StorageError ? error.kind : "other";
          bucket[kind] = (bucket[kind] ?? 0) + 1;
          throw error;
        }
      };
    },
  });
}

export interface WorkloadOptions { readonly poolStats?: () => { total: number; waiting: number } }

export async function runWorkload(raw: ControllerStorage, spec: WorkloadSpec, options: WorkloadOptions = {}): Promise<WorkloadResult> {
  const calls: Record<string, Record<string, number>> = {};
  const storage = metered(raw, calls);
  const start = performance.now();
  const measureFrom = start + spec.warmupMs;
  const deadline = start + spec.warmupMs + spec.durationMs;
  const samples: Record<string, number[]> = { transition: [], claimComplete: [], heartbeat: [], inquiry: [] };
  const record = (kind: string, from: number): void => { if (from >= measureFrom) samples[kind]!.push(performance.now() - from); };
  /** Transitions that count toward the measurement: those that started after the warm-up. */
  const measuredTransitions = (): number => samples["transition"]!.length;

  // ---- setup (not measured)
  await storage.acquireEpoch({ holder: "workload", at: ISO(0) });
  const epoch = await storage.currentEpoch();
  const base = (operationId: string): OperationInput => ({
    operationId, epoch, actor: "workload", correlationId: `c-${operationId}`, at: ISO(Math.round(performance.now() - start)), changes: [], audit: [], outbox: [], effects: [], timers: [],
    cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
  });
  await commitOperation(storage, {
    ...base("setup"),
    changes: [
      { type: "create", ref: { kind: "project", id: "p" }, body: { n: 0 } },
      ...Array.from({ length: spec.agents }, (_, i) => ({ type: "create" as const, ref: { kind: "task", id: `a${i}` }, body: { step: 0 } })),
    ],
  });
  for (let offset = 0; offset < spec.idleHosts; offset += 50) {
    await commitOperation(storage, { ...base(`hosts-${offset}`), changes: Array.from({ length: Math.min(50, spec.idleHosts - offset) }, (_, i) => ({ type: "create" as const, ref: { kind: "host", id: `h${offset + i}` }, body: { beat: 0 } })) });
  }

  const delay = monitorEventLoopDelay({ resolution: 1 });
  let maxTotal = 0;
  let maxWaiting = 0;
  const sampler = options.poolStats === undefined ? undefined : setInterval(() => { const s = options.poolStats!(); maxTotal = Math.max(maxTotal, s.total); maxWaiting = Math.max(maxWaiting, s.waiting); }, 20);
  const eventLoopReset = setTimeout(() => delay.reset(), spec.warmupMs);
  delay.enable();

  let callerConflicts = 0;
  let transitions = 0;
  const applied = new Array<number>(spec.agents).fill(0);
  const claimedBy = new Map<string, number>();
  const jitter = (mean: number): number => (mean === 0 ? 0 : Math.random() * 2 * mean);

  const agent = async (i: number): Promise<void> => {
    const task = { kind: "task", id: `a${i}` };
    let revision = 1;
    let k = 0;
    const going = (): boolean => performance.now() < deadline || (spec.minTransitions !== undefined && measuredTransitions() < spec.minTransitions && performance.now() < deadline + 30_000);
    while (going()) {
      // Two transitions for each pass over the outbox, like a task that makes progress and then reports.
      for (let step = 0; step < 2 && going(); step++) {
        const from = performance.now();
        for (;;) {
          try {
            let projectRevision = 0;
            if (spec.hotRow) projectRevision = (await storage.getAggregate({ kind: "project", id: "p" }))!.revision;
            const id = `t-${i}-${k}`;
            await commitOperation(storage, {
              ...base(id),
              changes: [
                { type: "update", ref: task, expectedRevision: revision, body: { step: k } },
                ...(spec.hotRow ? [{ type: "update" as const, ref: { kind: "project", id: "p" }, expectedRevision: projectRevision, body: { n: k, by: i } }] : []),
              ],
              audit: [{ type: "task.progress", subject: task, detail: { k } }],
              outbox: [{ deliveryId: id, destination: "worker", orderingKey: task.id, priority: 5, aggregate: task, payload: { k } }],
            }, { attempts: 20, pause: () => sleep(1) });
            revision += 1; k += 1; applied[i]! += 1; transitions += 1;
            break;
          } catch (error) {
            if (error instanceof StorageError && error.kind === "revision_conflict") { callerConflicts += 1; continue; } // someone else moved the shared row: read it again
            throw error;
          }
        }
        record("transition", from);
        await sleep(jitter(spec.thinkMs));
      }
      // Work through whatever has been announced for this task.
      const from = performance.now();
      let claims: DeliveryClaim[] = [];
      for (;;) {
        try { claims = await storage.claimDeliveries({ epoch, destination: "worker", claimant: `a${i}`, now: ISO(Math.round(performance.now() - start)), leaseMs: 3_600_000, limit: 3 }); break; } catch (error) {
          if (error instanceof StorageError && error.kind === "retryable") { await sleep(1); continue; }
          throw error;
        }
      }
      for (const claim of claims) {
        claimedBy.set(claim.deliveryId, (claimedBy.get(claim.deliveryId) ?? 0) + 1);
        await commitOperation(storage, { ...base(`done-${claim.deliveryId}`), completeDeliveries: [{ deliveryId: claim.deliveryId, claimToken: claim.claimToken, receipt: { by: i } }], audit: [{ type: "delivery.done", detail: { id: claim.deliveryId } }] }, { attempts: 20, pause: () => sleep(1) });
      }
      record("claimComplete", from);
      await sleep(jitter(spec.thinkMs));
    }
  };

  const host = async (j: number): Promise<void> => {
    await sleep(Math.random() * spec.hostPeriodMs);
    let revision = 1;
    let beat = 0;
    while (performance.now() < deadline) {
      const from = performance.now();
      await commitOperation(storage, { ...base(`hb-${j}-${beat}`), changes: [{ type: "update", ref: { kind: "host", id: `h${j}` }, expectedRevision: revision, body: { beat } }] }, { attempts: 20, pause: () => sleep(1) });
      revision += 1; beat += 1;
      record("heartbeat", from);
      await sleep(spec.hostPeriodMs);
    }
  };

  const inquirer = async (n: number): Promise<void> => {
    let after = 0;
    while (performance.now() < deadline) {
      const from = performance.now();
      await storage.getAggregate({ kind: "task", id: `a${n % Math.max(1, spec.agents)}` });
      const page = await storage.listAudit({ afterSeq: after, limit: 20 });
      if (page.length > 0) after = page[page.length - 1]!.seq;
      record("inquiry", from);
      await sleep(20);
    }
  };

  await Promise.all([
    ...Array.from({ length: spec.agents }, (_, i) => agent(i)),
    ...Array.from({ length: spec.idleHosts }, (_, j) => host(j)),
    ...Array.from({ length: spec.inquirers }, (_, n) => inquirer(n)),
  ]);
  clearTimeout(eventLoopReset);
  if (sampler !== undefined) clearInterval(sampler);
  delay.disable();
  // Rates are over the sampling window: steps are counted when they start inside it. (Loops finish a little later, e.g. a host sleeping out its period.)
  const measuredMs = deadline - measureFrom;

  // ---- invariants (not measured)
  const audit: number[] = [];
  for (let after = 0; ;) {
    const page = await raw.listAudit({ afterSeq: after, limit: 1000 });
    if (page.length === 0) break;
    audit.push(...page.map((a) => a.seq));
    after = page[page.length - 1]!.seq;
  }
  const revisions = await Promise.all(Array.from({ length: spec.agents }, (_, i) => raw.getAggregate({ kind: "task", id: `a${i}` })));
  const deliverySeqs: number[] = [];
  for (let i = 0; i < spec.agents; i++) {
    const seen = await Promise.all(Array.from({ length: applied[i]! }, (_, k) => raw.getDelivery(`t-${i}-${k}`)));
    for (const d of seen) if (d !== undefined) deliverySeqs.push(d.seq);
  }
  deliverySeqs.sort((a, b) => a - b);
  const invariants = {
    transitionsApplied: transitions,
    auditGapFree: audit.every((seq, i) => seq === i + 1),
    deliveriesUnique: deliverySeqs.length === transitions && new Set(deliverySeqs).size === deliverySeqs.length && deliverySeqs.every((seq, i) => seq === i + 1),
    revisionsMatch: revisions.every((a, i) => a?.revision === 1 + applied[i]!),
    deliveriesClaimedTwice: [...claimedBy.values()].filter((n) => n > 1).length,
  };

  const seconds = measuredMs / 1000;
  const loop = (q: number): number => Math.round((delay.percentile(q) / 1e6) * 100) / 100;
  return {
    spec, measuredMs: Math.round(measuredMs), latency: Object.fromEntries(Object.entries(samples).map(([k, v]) => [k, stats(v, seconds)])), calls, conflictsRetriedByCaller: callerConflicts,
    eventLoopDelayMs: { p50: loop(50), p99: loop(99), max: Math.round((delay.max / 1e6) * 100) / 100 },
    ...(options.poolStats === undefined ? {} : { pool: { maxTotal, maxWaiting } }), invariants,
  };
}

/** The assertions every run must satisfy, whatever the speed. */
export function assertInvariants(result: WorkloadResult): void {
  const i = result.invariants;
  assert.ok(i.transitionsApplied > 0, "no work was done");
  assert.ok(i.auditGapFree, "audit numbers have a gap");
  assert.ok(i.deliveriesUnique, "delivery numbers are not unique and gap-free");
  assert.ok(i.revisionsMatch, "a task's revision does not match the transitions applied to it: an update was lost or duplicated");
  assert.equal(i.deliveriesClaimedTwice, 0, "a delivery was claimed by two claimants");
}

export const SCENARIOS: readonly WorkloadSpec[] = [
  { name: "baseline: 4 active, 100 idle hosts", agents: 4, idleHosts: 100, hostPeriodMs: 2000, inquirers: 2, hotRow: false, thinkMs: 5, durationMs: 15_000, warmupMs: 2000 },
  { name: "stress: 32 active equivalents, 100 idle hosts", agents: 32, idleHosts: 100, hostPeriodMs: 2000, inquirers: 2, hotRow: false, thinkMs: 5, durationMs: 15_000, warmupMs: 2000 },
  { name: "hot row: 32 active all updating one shared record", agents: 32, idleHosts: 100, hostPeriodMs: 2000, inquirers: 2, hotRow: true, thinkMs: 5, durationMs: 15_000, warmupMs: 2000 },
];
