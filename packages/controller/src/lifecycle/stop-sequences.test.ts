import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { MemoryStorage } from "../storage/memory.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { StatusService } from "../status/status.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-28T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

/** The storage the services use: it can hide one request from listings and run a hook just before the ending of a request is written (a sweep "between the ending's charge and its mark"). */
class Tap {
  hide: string | undefined;
  midEnd: (() => Promise<void>) | undefined;
  constructor(private readonly inner: any) { return new Proxy(this, { get: (t, p) => (p in t ? (t as any)[p] : typeof inner[p] === "function" ? inner[p].bind(inner) : inner[p]) }); }
  async listAggregates(kind: string, page: unknown): Promise<Array<{ id: string }>> { return (await this.inner.listAggregates(kind, page)).filter((x: { id: string }) => !(kind === "stop-intent" && this.hide !== undefined && x.id === this.hide)); }
  async applyOperation(input: { changes: Array<{ ref: { kind: string; id: string }; body?: Record<string, any> }> }): Promise<unknown> {
    if (this.midEnd !== undefined) {
      const ch = input.changes.find((c) => c.ref.kind === "stop-intent" && c.body?.["ended"] === true && c.body?.["outcome"] === undefined);
      if (ch !== undefined) { const h = this.midEnd; this.midEnd = undefined; this.hide = ch.ref.id; try { await h(); } finally { this.hide = undefined; } }
    }
    return this.inner.applyOperation(input);
  }
}

type Scope = { kind: "task" | "agent"; id: string };
class Runtime implements StopPorts {
  blocking = false;
  throwOnTerminate = false;
  hangTerminate = false;
  failCharges = false;
  noAttemptsPort = false;
  totals: Record<string, number> = { "att-a": 0, "att-b": 0 };
  charges: Array<{ commandId: string; attemptId: string; costMicros: number }> = [];
  terminated = new Set<string>();
  costsReported = new Map<string, Set<string>>();
  terminateCalls = 0;
  activeOf: (scope: Scope) => Promise<string | undefined> = async () => undefined;
  attempts(): string[] { return this.noAttemptsPort ? [] : ["att-a"]; }
  remember(): void { }
  async begin(): Promise<void> { }
  async release(): Promise<void> { }
  async inventory(): Promise<InventoryItem[]> { return this.blocking ? [{ kind: "process", ref: "pid-7", state: "uncooperative" }] : []; }
  /** The highest total reported for each attempt (every call that returned its costs to the service): all of it must be charged by the fixed point. */
  /** Command IDs the budget saw twice with a different amount (it would answer the second as a replay of the first: money lost). */
  reused: string[] = [];
  reportedMax: Record<string, number> = {};
  noteReported(costs: Array<{ attemptId: string; costMicros: number }>): void { for (const c of costs) this.reportedMax[c.attemptId] = Math.max(this.reportedMax[c.attemptId] ?? 0, c.costMicros); }
  async cleanup(scope: Scope) {
    // att-b is never listed by attempts(): only the costs the runtime reports tell the service about it.
    this.totals["att-a"]! += 100; this.totals["att-b"]! += 20;
    const id = await this.activeOf(scope);
    if (id !== undefined) { const s = this.costsReported.get(id) ?? new Set(); s.add("att-a"); s.add("att-b"); this.costsReported.set(id, s); }
    const costs = [{ attemptId: "att-a", costMicros: this.totals["att-a"]!, computeMs: 0 }, { attemptId: "att-b", costMicros: this.totals["att-b"]!, computeMs: 0 }];
    this.noteReported(costs);
    return { remaining: this.blocking ? [{ kind: "process", ref: "pid-7", state: "uncooperative" } as InventoryItem] : [], costs };
  }
  async checkpoint() { return { checkpointId: "cp-1", durable: true, artifactsDurable: true }; }
  async charge(c: { commandId: string; attemptId: string; costMicros: number; computeMs: number }): Promise<void> {
    if (this.failCharges) throw new Error("budget unreachable");
    const same = this.charges.find((x) => x.commandId === c.commandId);
    if (same !== undefined && (same.costMicros !== c.costMicros || same.attemptId !== c.attemptId)) this.reused.push(c.commandId);
    if (same === undefined) this.charges.push(c);
  }
  async terminate(scope: Scope) {
    this.terminateCalls++;
    if (this.hangTerminate) await new Promise(() => undefined);
    if (this.throwOnTerminate) throw new Error("cannot reach the host");
    this.totals["att-a"]! += 50; this.totals["att-b"]! += 30;
    const id = await this.activeOf(scope);
    if (id !== undefined) { this.terminated.add(id); const s = this.costsReported.get(id) ?? new Set(); s.add("att-a"); s.add("att-b"); this.costsReported.set(id, s); }
    const costs = [{ attemptId: "att-a", costMicros: this.totals["att-a"]!, computeMs: 0 }, { attemptId: "att-b", costMicros: this.totals["att-b"]!, computeMs: 0 }];
    this.noteReported(costs);
    return { ended: true, unresolved: [], costs };
  }
}

const OPS = ["suspend", "stop", "force", "advance", "wait", "restart", "resume", "sweep", "failOn", "failOff", "throwTermOn", "throwTermOff", "blockOn", "blockOff", "agentStop", "agentForce", "agentResume", "hang", "noAttemptsPort", "raceSweep", "raceAll", "raceForce", "sweepMidEnd", "failMidEnd"] as const;
const USE = process.env["NOPORT"] === "1" ? OPS.filter((o) => o !== "noAttemptsPort") : OPS;
type Op = (typeof OPS)[number];

// mulberry32
// A small seeded walk through many histories (the larger one is run with BRUTE_N=6500 BRUTE_LEN=8). The view is read after every step and each sentence is checked against the stored request and what the runtime did.
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const SCRIPTED = ["failOn,agentSuspend,raceAll,failOff,sweep", "failOn,agentSuspend,failMidEnd,stop,advance,sweep", "sweepMidEnd,stop,advance,sweep", "failOn,force,raceSweep,raceSweep,failOff,sweep", "throwTermOn,stop,advance,throwTermOff,wait", "throwTermOn,suspend,stop,advance,advance,throwTermOff,wait", "suspend,advance,stop", "blockOn,stop,advance,sweep,wait", "failOn,force,agentStop", "failOn,agentStop,failOff,sweep", "failOn,force,stop,force,failOff,sweep", "failOn,agentStop,agentForce,failOff,sweep"];
const COUNT = Number(process.env["BRUTE_N"] ?? 60);
const MAXLEN = Number(process.env["BRUTE_LEN"] ?? 6);
const ONLY = process.env["BRUTE_SEQ"];

test("seeded random sequences of suspend, stop, force, wait, restart, resume, sweep, failing charges and hung endings: every sentence of the cleanup view stays true (card L02d)", { timeout: 600_000 }, async () => {
  const violations = new Map<string, string[]>();
  const random = rng(20261107);
  const seqs: Op[][] = [];
  const backendOf = new Map<Op[], Backend>();
  if (ONLY !== undefined) seqs.push(ONLY.split(",") as Op[]);
  else {
    // Scripted prefixes first (each found a real fault once), then the walk, which leans toward making requests.
    for (const s of SCRIPTED) { seqs.push(s.split(",") as Op[]); for (const b of backends) if (b.name !== "reference store") { const again = s.split(",") as Op[]; seqs.push(again); backendOf.set(again, b); } }
    const pool: Op[] = [...USE, "suspend", "stop", "force", "agentStop", "advance", "sweep", "failOn", "failOff"];
    for (let i = 0; i < COUNT; i++) { const len = 1 + Math.floor(random() * MAXLEN); seqs.push(Array.from({ length: len }, () => pool[Math.floor(random() * pool.length)]!)); }
  }
  for (const seq of seqs) {
    now = Date.parse("2026-10-28T10:00:00.000Z");
    const world = backendOf.get(seq) === undefined ? undefined : await backendOf.get(seq)!.open();
    const storage = new Tap(world?.storage ?? new MemoryStorage()) as unknown as MemoryStorage & Tap;
    const projects = await ProjectService.open(storage, { holder: "c1", ...options });
    const epoch = projects.epoch;
    const principals = PrincipalService.withEpoch(storage, epoch, options);
    GrantService.withEpoch(storage, epoch, options);
    const agents = AgentService.withEpoch(storage, epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
    const agentA = (await agents.create(owner, { commandId: cid("ag"), friendlyName: "A" })).id;
    const assignments = AssignmentService.withEpoch(storage, epoch, projects, options);
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "one" })).id;
    await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId: task, owner: { kind: "agent", id: agentA } });
    const pauses = PauseService.withEpoch(storage, epoch, {}, options);
    const rt = new Runtime();
    let stops = StopService.withEpoch(storage, epoch, PauseService.withEpoch(storage, epoch, {}, options), rt, options);
    const runner = new CommandRunner(storage, epoch, options);
    const active = async (scope: Scope): Promise<string | undefined> => (await stops.cleanupSpend(owner, scope).catch(() => undefined))?.intentId;
    rt.activeOf = active;
    const status = StatusService.withEpoch(storage, epoch, { stops: { cleanupSpend: (by: Principal, s: never) => stops.cleanupSpend(by, s) } } as never, options);
    const T: Scope = { kind: "task", id: task }, A: Scope = { kind: "agent", id: agentA };
    // facts
    const requested = new Map<string, { mode: string; reusedAtCreation: boolean; suspendId?: string }>();
    const forcedPure = new Set<string>();
    const log: string[] = [];
    const record = (key: string, detail: string) => { const k = key; const arr = violations.get(k) ?? []; if (arr.length < 3) arr.push(`${seq.join(",")} :: ${detail}`); violations.set(k, arr); };
    const doRequest = async (scope: Scope, mode: "suspend" | "stop") => {
      const before = await active(scope);
      const beforeBody = before === undefined ? undefined : (await runner.get("stop-intent", before))?.body as Record<string, unknown> | undefined;
      try {
        const r = await stops.request(owner, { commandId: cid("s"), scope, mode, reason: "x", spendBudget: 150 });
        const body = (await runner.get("stop-intent", r.intentId))!.body as Record<string, unknown>;
        if (!requested.has(r.intentId)) requested.set(r.intentId, { mode, reusedAtCreation: r.intentId !== before && body["phase"] === "prepared", ...(r.intentId !== before && body["phase"] === "prepared" ? { suspendId: before! } : {}) });
        void beforeBody;
      } catch { /* refused */ }
    };
    const advanceOf = async (scope: Scope): Promise<void> => { const id = await active(scope); if (id) await stops.advance(owner, { intentId: id }); };
    const doForce = async (scope: Scope) => {
      const before = await active(scope);
      const beforeBody = before === undefined ? undefined : (await runner.get("stop-intent", before))?.body as Record<string, unknown> | undefined;
      const takesOver = beforeBody !== undefined && !["done", "recovery-required", "cancelled"].includes(String(beforeBody["phase"]));
      try { const r = await stops.force(owner, { commandId: cid("f"), scope, reason: "now" }); if (!takesOver) forcedPure.add(r.intentId); } catch { /* */ }
    };
    for (const op of seq) {
      now += 1000;
      try {
        switch (op) {
          case "suspend": await doRequest(T, "suspend"); break;
          case "stop": await doRequest(T, "stop"); break;
          case "force": await doForce(T); break;
          case "advance": { const id = await active(T); if (id) await stops.advance(owner, { intentId: id }).catch(() => undefined); break; }
          case "wait": {
            const id = await active(T);
            if (!id) break;
            const was = (await runner.get("stop-intent", id))!.body as Record<string, any>;
            await stops.choose(owner, { commandId: cid("c"), intentId: id, choice: "wait", extendMs: 1 }).catch(() => undefined);
            const is = (await runner.get("stop-intent", id))!.body as Record<string, any>;
            // A wait on a blocked preparation starts a new budget window; a wait after a failed ending keeps the figure of the preparation.
            if (was["phase"] === "blocked" && is["phase"] !== "blocked") {
              const expected = (was["blocked"]?.resume ?? "preparing") === "preparing" ? 0 : was["spent"];
              if (is["spent"] !== expected) record("wait-spent", `resume ${was["blocked"]?.resume} spent ${was["spent"]} -> ${is["spent"]}`);
            }
            break;
          }
          case "restart": { const id = await active(T); if (id) await stops.choose(owner, { commandId: cid("c"), intentId: id, choice: "restart-earlier-boundary" }).catch(() => undefined); break; }
          case "resume": await pauses.resume(owner, { commandId: cid("rs"), scope: T, reason: "again" }).catch(() => undefined); break;
          case "agentResume": await pauses.resume(owner, { commandId: cid("rs"), scope: A, reason: "again" }).catch(() => undefined); break;
          case "sweep": await stops.sweep(owner); break;
          case "failOn": rt.failCharges = true; break;
          case "failOff": rt.failCharges = false; break;
          case "throwTermOn": rt.throwOnTerminate = true; break;
          case "throwTermOff": rt.throwOnTerminate = false; break;
          case "blockOn": rt.blocking = true; break;
          case "blockOff": rt.blocking = false; break;
          case "noAttemptsPort": rt.noAttemptsPort = true; break;
          case "agentStop": { await doRequest(A, "stop"); const id = await active(A); if (id) await stops.advance(owner, { intentId: id }).catch(() => undefined); break; }
          case "agentForce": await doForce(A); break;
          case "raceSweep": await Promise.allSettled([advanceOf(T), stops.sweep(owner)]); break;
          case "raceAll": await Promise.allSettled([advanceOf(T), advanceOf(A), stops.sweep(owner)]); break;
          case "raceForce": await Promise.allSettled([advanceOf(T), doForce(A), stops.sweep(owner)]); break;
          case "sweepMidEnd": storage.midEnd = async () => { await stops.sweep(owner).catch(() => undefined); }; break;
          case "failMidEnd": rt.failCharges = true; storage.midEnd = async () => { rt.failCharges = false; await stops.sweep(owner).catch(() => undefined); }; break;
          case "hang": {
            const id = await active(T); if (!id) break;
            const before = rt.terminateCalls; rt.hangTerminate = true;
            void stops.advance(owner, { intentId: id }).catch(() => undefined);
            for (let i = 0; i < 40 && rt.terminateCalls === before; i++) await new Promise((r) => setTimeout(r, 5));
            rt.hangTerminate = false;
            // a restart: a fresh service (the hung call never returns)
            stops = StopService.withEpoch(storage, epoch, PauseService.withEpoch(storage, epoch, {}, options), rt, options);
            break;
          }
        }
      } catch (e) { log.push(`${op}: ${(e as Error).message}`); }
      // check views for both scopes
      for (const scope of [T, A]) {
        const v = await stops.cleanupSpend(owner, scope).catch(() => undefined);
        if (v === undefined) continue;
        const lines = (await status.stopCleanupLines(owner, { scope }))!.lines.map((l) => l.text);
        const head = lines[0]!;
        const stored = (await runner.get("stop-intent", v.intentId))!.body as Record<string, any>;
        const fact = requested.get(v.intentId);
        const pure = forcedPure.has(v.intentId);
        const where = `${scope.kind} after ${op}: ${head}`;
        // mode / phase
        if (!head.includes(` is ${stored["phase"]}.`)) record("phase", where);
        // no preparation
        if (/has no preparation/.test(head) && fact !== undefined) record("no-preparation-but-requested", where);
        if (/Its last cleanup budget window before the Force Stop/.test(head) && fact === undefined) record("window-but-pure-force", where);
        if (/reused the checkpoint|checkpoint of an earlier Suspend/.test(head) && fact?.reusedAtCreation !== true) record("reuse-claim-false", where);
        if (fact?.reusedAtCreation === true && !/reused the checkpoint|checkpoint of an earlier Suspend/.test(head)) record("reuse-not-told", where);
        // ending claims
        const saysRan = /the cost of ending the work is charged on top|what ending the work cost is charged|the cost of ending the work is in them too/.test(head);
        const saysLater = /when it runs/.test(head);
        if (saysRan && !rt.terminated.has(v.intentId)) record("says-ending-ran-but-not", where);
        if (saysLater && rt.terminated.has(v.intentId)) record("says-ending-later-but-ran", where);
        if (stored["mode"] === "suspend" && /ending/.test(head)) record("suspend-mentions-ending", where);
        if (/no ending of the work is recorded/.test(head) && rt.terminated.has(v.intentId)) record("says-no-ending-but-ran", where);
        if ((stored["mode"] === "stop" || stored["mode"] === "force-stop") && rt.terminated.has(v.intentId) && !saysRan) record("ending-ran-not-told", where);
        // figure
        if (/ used [0-9]/.test(head)) {
          const m = /used ([0-9.]+) \(budget currency\)/.exec(head);
          if (m === null || Math.round(Number(m[1]) * 1_000_000) !== stored["spent"]) record("figure", `${where} stored ${stored["spent"]}`);
        }
        // unpaid
        const charges = await runner.list("stop-charge", { limit: 100 });
        // owed: its own pending note, or a figure above what was charged that the sweep still has to charge (kept on the open entry of an attempt that lists the request)
        const openEntries = await runner.list("stop-charge-open", { limit: 100 });
        const owedWant = openEntries.some((o) => {
          const b = o.body as any;
          const rec = charges.find((c) => c.id === o.id)?.body as any;
          return b.intents.includes(v.intentId) && b.want !== undefined && (rec === undefined || rec.costMicros < b.want.costMicros || rec.computeMs < b.want.computeMs);
        });
        const ownPendingAny = owedWant || charges.some((c) => (c.body as any).pending?.intentId === v.intentId);
        const marked = (stored["outcome"]?.unresolved ?? []).includes("cleanup spend not charged");
        const saysUnpaid = lines.some((l) => /not charged yet|A charge failed when the request ended/.test(l));
        if (saysUnpaid !== (marked || ownPendingAny)) record("unpaid-mismatch", `${where} marked=${marked} ownPending=${ownPendingAny} says=${saysUnpaid}`);
        // attempts totals equal the charges made
        // an own pending note reads as "retried until it is" whatever the mark says
        if (ownPendingAny && !lines.some((l) => /retried until it is/.test(l))) record("own-pending-not-told", where);
        for (const a of v.attempts) {
          const sum = rt.charges.filter((c) => c.attemptId === a.attemptId).reduce((s, c) => s + c.costMicros, 0);
          const rec = charges.find((c) => c.id === a.attemptId)?.body as { costMicros: number; pending?: { costMicros: number } } | undefined;
          // charged so far = the ledger, or the ledger plus the part of a pending note that was made before the note was cleared
          if (sum !== a.costMicros && !(rec?.pending !== undefined && sum === rec.pending.costMicros)) record("attempt-total", `${where} ${a.attemptId} view ${a.costMicros} charged ${sum}`);
          // the amount the owner reads is the amount in the view
          const shown = lines.find((l) => l.startsWith(`Attempt ${a.attemptId}:`));
          const m = shown === undefined ? null : /^Attempt \S+: ([0-9.]+) and/.exec(shown);
          if (m === null || Math.round(Number(m[1]) * 1_000_000) !== a.costMicros) record("attempt-line-amount", `${where} ${shown ?? "(no line)"} view ${a.costMicros}`);
        }
        // every attempt with a charge record that this request reported costs for is listed
        const reported = new Set(rt.costsReported.get(v.intentId) ?? []);
        if (fact?.suspendId !== undefined) for (const x of rt.costsReported.get(fact.suspendId) ?? []) reported.add(x);
        for (const a of reported) {
          const exists = charges.some((c) => c.id === a && (c.body as any).costMicros > 0);
          if (exists && !v.attempts.some((x) => x.attemptId === a)) record("attempt-not-listed", `${where} ${a} (${lines.slice(1).join(" | ")})`);
        }
        // markOnly promises the next sweep clears it
        if (lines.some((l) => /next sweep checks it again and clears this/.test(l))) {
          const fail = rt.failCharges; rt.failCharges = false;
          // run the sweep on a throwaway? we run it for real but only at the end of a check, then restore nothing else.
          await stops.sweep(owner);
          const after = (await runner.get("stop-intent", v.intentId))!.body as Record<string, any>;
          if ((after["outcome"]?.unresolved ?? []).includes("cleanup spend not charged")) record("sweep-does-not-clear-markOnly", `${where} (${lines.slice(1).join(" | ")})`);
          rt.failCharges = fail;
        }
      }
    }
    // Fixed point: the budget reachable again, the host answering, sweeps run. Every figure the runtime ever reported is charged (the highest one per attempt), nothing is pending, no request keeps the mark, and the index is empty.
    storage.midEnd = undefined; rt.failCharges = false; rt.throwOnTerminate = false; rt.blocking = false;
    stops = StopService.withEpoch(storage, epoch, PauseService.withEpoch(storage, epoch, {}, options), rt, options);
    for (let i = 0; i < 3; i++) await stops.sweep(owner);
    for (const [a, max] of Object.entries(rt.reportedMax)) {
      const sum = rt.charges.filter((c) => c.attemptId === a).reduce((s, c) => s + c.costMicros, 0);
      if (sum < max) record("final-charged-differs-from-reported", `${a} reported ${max} charged ${sum}`);
      if (sum > max) record("final-overcharged", `${a} reported ${max} charged ${sum}`);
    }
    if (rt.reused.length > 0) record("command-id-reused-with-another-figure", rt.reused.join(","));
    for (const c of await runner.list("stop-charge", { limit: 100 })) if ((c.body as any).pending !== undefined) record("final-pending", c.id);
    for (const r of await runner.list("stop-intent", { limit: 100 })) if (((r.body as any).outcome?.unresolved ?? []).includes("cleanup spend not charged")) record("final-marked", r.id);
    // What is left on the index belongs to requests that have not finished (a blocked one is waiting for the owner's choice).
    for (const o of await runner.list("stop-charge-open", { limit: 100 })) {
      const phases: string[] = [];
      for (const i of (o.body as any).intents as string[]) phases.push(((await runner.get("stop-intent", i))?.body as any)?.phase);
      // an entry stays while any request it lists is going (the finished ones on it are cleared with it)
      if (phases.every((p) => ["done", "recovery-required", "cancelled"].includes(p))) record("final-index-keeps-an-entry-of-finished-requests", `${o.id} ${phases.join(",")}`);
    }
    // One more sweep changes nothing.
    const snap = async () => JSON.stringify([await runner.list("stop-charge", { limit: 100 }), await runner.list("stop-charge-open", { limit: 100 }), (await runner.list("stop-intent", { limit: 100 })).map((r) => (r.body as any).outcome), rt.charges.length]);
    const before = await snap();
    await stops.sweep(owner);
    if ((await snap()) !== before) record("sweep-not-idempotent", "");
    if (world !== undefined) await world.close();
  }
  const out =[...violations.entries()].map(([k, v]) => `${k} (${v.length}+):\n  ${v.join("\n  ")}`).join("\n");
  assert.equal(out, "", `${seqs.length} sequences`);
});
