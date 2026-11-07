import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { CommandRunner } from "../domain/runner.js";
import { ProjectService } from "../domain/service.js";
import { MemoryStorage } from "../storage/memory.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { StatusService } from "../status/status.js";
import { PauseService, StopService, type InventoryItem, type StopPorts } from "./index.js";

let now = Date.parse("2026-10-28T10:00:00.000Z");
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

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
  async cleanup(scope: Scope) {
    this.totals["att-a"]! += 100;
    const id = await this.activeOf(scope);
    if (id !== undefined) { const s = this.costsReported.get(id) ?? new Set(); s.add("att-a"); this.costsReported.set(id, s); }
    return { remaining: this.blocking ? [{ kind: "process", ref: "pid-7", state: "uncooperative" } as InventoryItem] : [], costs: [{ attemptId: "att-a", costMicros: this.totals["att-a"]!, computeMs: 0 }] };
  }
  async checkpoint() { return { checkpointId: "cp-1", durable: true, artifactsDurable: true }; }
  async charge(c: { commandId: string; attemptId: string; costMicros: number; computeMs: number }): Promise<void> {
    if (this.failCharges) throw new Error("budget unreachable");
    if (!this.charges.some((x) => x.commandId === c.commandId)) this.charges.push(c);
  }
  async terminate(scope: Scope) {
    this.terminateCalls++;
    if (this.hangTerminate) await new Promise(() => undefined);
    if (this.throwOnTerminate) throw new Error("cannot reach the host");
    this.totals["att-a"]! += 50; this.totals["att-b"]! += 30;
    const id = await this.activeOf(scope);
    if (id !== undefined) { this.terminated.add(id); const s = this.costsReported.get(id) ?? new Set(); s.add("att-a"); s.add("att-b"); this.costsReported.set(id, s); }
    return { ended: true, unresolved: [], costs: [{ attemptId: "att-a", costMicros: this.totals["att-a"]!, computeMs: 0 }, { attemptId: "att-b", costMicros: this.totals["att-b"]!, computeMs: 0 }] };
  }
}

const OPS = ["suspend", "stop", "force", "advance", "wait", "restart", "resume", "sweep", "failOn", "failOff", "throwTermOn", "throwTermOff", "blockOn", "blockOff", "agentStop", "agentForce", "agentResume", "hang", "noAttemptsPort"] as const;
const USE = process.env["NOPORT"] === "1" ? OPS.filter((o) => o !== "noAttemptsPort") : OPS;
type Op = (typeof OPS)[number];

// mulberry32
// A small seeded walk through many histories (the larger one is run with BRUTE_N=6500 BRUTE_LEN=8). The view is read after every step and each sentence is checked against the stored request and what the runtime did.
const rng = (seed: number) => () => { seed |= 0; seed = (seed + 0x6d2b79f5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };

const COUNT = Number(process.env["BRUTE_N"] ?? 120);
const MAXLEN = Number(process.env["BRUTE_LEN"] ?? 6);
const ONLY = process.env["BRUTE_SEQ"];

test("seeded random sequences of suspend, stop, force, wait, restart, resume, sweep, failing charges and hung endings: every sentence of the cleanup view stays true (card L02d)", { timeout: 600_000 }, async () => {
  const violations = new Map<string, string[]>();
  const random = rng(20261107);
  const seqs: Op[][] = [];
  if (ONLY !== undefined) seqs.push(ONLY.split(",") as Op[]);
  else for (let i = 0; i < COUNT; i++) { const len = 1 + Math.floor(random() * MAXLEN); seqs.push(Array.from({ length: len }, () => USE[Math.floor(random() * USE.length)]!)); }
  for (const seq of seqs) {
    now = Date.parse("2026-10-28T10:00:00.000Z");
    const storage = new MemoryStorage();
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
          case "wait": { const id = await active(T); if (id) await stops.choose(owner, { commandId: cid("c"), intentId: id, choice: "wait", extendMs: 1 }).catch(() => undefined); break; }
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
        const ownPendingAny = charges.some((c) => (c.body as any).pending?.intentId === v.intentId);
        const marked = (stored["outcome"]?.unresolved ?? []).includes("cleanup spend not charged");
        const saysUnpaid = lines.some((l) => /not charged yet|A charge failed when the request ended/.test(l));
        if (saysUnpaid !== (marked || ownPendingAny)) record("unpaid-mismatch", `${where} marked=${marked} ownPending=${ownPendingAny} says=${saysUnpaid}`);
        // attempts totals equal the charges made
        for (const a of v.attempts) {
          const sum = rt.charges.filter((c) => c.attemptId === a.attemptId).reduce((s, c) => s + c.costMicros, 0);
          if (sum !== a.costMicros) record("attempt-total", `${where} ${a.attemptId} view ${a.costMicros} charged ${sum}`);
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
  }
  const out = [...violations.entries()].map(([k, v]) => `${k} (${v.length}+):\n  ${v.join("\n  ")}`).join("\n");
  assert.equal(out, "", `${seqs.length} sequences`);
});
