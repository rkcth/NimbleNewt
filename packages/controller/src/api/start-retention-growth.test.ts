import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { unguarded } from "../retention/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

async function world(d: string, extra: Record<string, unknown> = {}) {
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, retention: { defaults: { reserveBytes: 0 }, autoEveryMs: 0 }, ...extra } as never);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
  const agent = async (name: string) => { await c.services.principals.enroll(rob, { commandId: `e-${name}`, kind: "agent", name, grants: [{ action: "desk.write", project }, { action: "desk.read", project }] } as never); const token = (await c.services.principals.issueCredential(rob, `agent:${name}`)).token; return { token, p: await c.services.principals.authenticate(token) }; };
  const task = async (title: string, id: string) => (await call(boot.token, "task.create", { projectId: project, title }, id)).result.id as string;
  const move = async (taskId: string, to: string, id: string) => { const t = (await call(boot.token, "task.get", { taskId })).result.item; const r = await call(boot.token, "task.transition", { taskId, expectedRevision: t.revision, to }, id); assert.ok(r.ok, JSON.stringify(r)); };
  const finish = async (taskId: string, tag: string) => { const state = (await call(boot.token, "task.get", { taskId })).result.item.state; if (state === "proposed") await move(taskId, "ready", `${tag}1`); await move(taskId, "in_progress", `${tag}2`); await move(taskId, "done", `${tag}3`); };
  const put = async (kind: string, id: string, body: object) => { await c.storage.applyOperation({ operationId: `put:${kind}:${id}`, epoch: c.epoch, actor: "test", correlationId: `put:${kind}:${id}`, at: new Date().toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
  return { c, boot, rob, call, project, agent, task, move, finish, put };
}
async function audits(c: { storage: { listAudit(i: { afterSeq: number; limit: number }): Promise<any[]> } }): Promise<any[]> { const out: any[] = []; let after = 0; for (;;) { const page = await c.storage.listAudit({ afterSeq: after, limit: 1000 }); out.push(...page); if (page.length < 1000) return out; after = page[page.length - 1].seq; } }
const clean = (d: string) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

test("finished checks and over stall concerns are kept by default; with checkRecordDays / concernDays set the runner previews, then removes exactly those, audited; a check still owed, a suspected concern and a live task's confirmed concern are never touched; the owner sets both by chat-reachable settings (card K06d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ret-growth-"));
  const { c, boot, call, project, put, task, finish } = await world(d);
  try {
    const has = async (kind: string, id: string) => (await c.storage.getAggregate({ kind, id })) !== undefined;
    await put("responsibility", "resp-aaaaaaaaaaaaaaaaaaaa", { projectId: project, state: "active" });
    await put("responsibility", "resp-bbbbbbbbbbbbbbbbbbbb", { projectId: project, state: "retired" });
    const lastCheck = ago(50);
    await put("responsibility-log", "resp-aaaaaaaaaaaaaaaaaaaa", { n: 1, lastCheckAt: lastCheck });
    const chk = (id: string, responsibilityId: string, days: number, slot = ago(days)) => put("responsibility-check", id, { responsibilityId, projectId: project, slotStart: slot, scheduledAt: slot, inMaintenanceWindow: false });
    await chk("rck-done0000000000000000", "resp-aaaaaaaaaaaaaaaaaaaa", 60);      // before the last check: finished
    await chk("rck-equal000000000000000", "resp-aaaaaaaaaaaaaaaaaaaa", 50, lastCheck); // its slot is the last check's time: finished (owed only while the slot is after it, as P04 pending reads it)
    await chk("rck-owed0000000000000000", "resp-aaaaaaaaaaaaaaaaaaaa", 40);      // after the last check, old, still owed
    await chk("rck-new00000000000000000", "resp-aaaaaaaaaaaaaaaaaaaa", 5);       // too new
    await chk("rck-retired0000000000000", "resp-bbbbbbbbbbbbbbbbbbbb", 70);      // retired responsibility: history
    const liveTask = await task("still going", "t-live");
    const movedTask = await task("handed on", "t-moved");
    const doneTask = await task("finished", "t-done"); await finish(doneTask, "f");
    const assigned = (taskId: string, generation: number) => put("assignment", `asg-${taskId.slice(5)}`, { taskId, generation, state: "assigned", owner: { kind: "agent", id: "ann" }, attempts: 0 });
    await assigned(liveTask, 1); await assigned(movedTask, 2);
    const con = (id: string, state: string, days: number, taskId: string, extra: object = {}) => put("stall-concern", id, { taskId, projectId: project, generation: 1, kind: "silent", state, detail: "secret words of the concern", firstSeenAt: ago(days + 1), lastChangedAt: ago(days), reopened: 0, ...extra });
    // The stall scan names a concern by (task, generation, kind) and opens it with a command ID made from that name: one removed while its task can still stall under that generation could never be opened again.
    await con("cncr-clearedlive00000000", "cleared", 40, liveTask);                       // live task, same generation: can come back, kept
    await con("cncr-clearedmoved0000000", "cleared", 40, movedTask);                      // the task was assigned again (generation 2): over
    await con("cncr-suspected0000000000", "suspected", 400, liveTask);
    await con("cncr-confirmedlive000000", "confirmed", 40, liveTask);
    await con("cncr-confirmeddone000000", "confirmed", 40, doneTask);
    await con("cncr-pendingdone00000000", "confirmed", 40, doneTask, { recoveryPending: { action: "nudge", key: "rec-x", by: "owner", at: ago(40) } }); // a recovery step half made: kept
    await con("cncr-dismissedrun0000000", "dismissed", 40, liveTask, { dismissedUntil: ago(30) });   // run out, but the scan may still reopen it: kept
    await con("cncr-dismisseddone000000", "dismissed", 40, doneTask, { dismissedUntil: ago(30) });   // run out on a finished task: over
    await con("cncr-dismissednoend00000", "dismissed", 40, doneTask);                                 // no end: in force for good, kept
    await con("cncr-dismissedwait000000", "dismissed", 40, liveTask, { dismissedUntil: new Date(Date.now() + 86_400_000).toISOString() });
    await con("cncr-newcleared000000000", "cleared", 2, doneTask);

    const eff = (await call(boot.token, "retention.settings.get", {})).result.item.effective;
    assert.equal(eff.checkRecordDays, null); assert.equal(eff.concernDays, null);
    assert.equal((await call(boot.token, "retention.run", {}, "g0")).result.candidates.length, 0, "off by default: nothing is a candidate");
    const status = (await call(boot.token, "retention.status", {})).result.item;
    assert.equal(status.growth["responsibility-check"], 5); assert.equal(status.growth["stall-concern"], 11);

    for (const [field, value] of [["checkRecordDays", 6], ["concernDays", 6], ["checkRecordDays", 3651], ["concernDays", 3651], ["concernDays", 30.5], ["checkRecordDays", "30"]] as const) {
      const bad = await call(boot.token, "retention.settings.set", { [field]: value }, `g-bad-${field}-${value}`); assert.equal(bad.ok, false, `${field} ${value} is refused`);
    }
    const set = await call(boot.token, "retention.settings.set", { checkRecordDays: 30, concernDays: 30 }, "g1");
    assert.ok(set.ok); assert.match(JSON.stringify(set.result), /checkRecordDays none -> 30/); assert.match(JSON.stringify(set.result), /concernDays none -> 30/);

    const preview = (await call(boot.token, "retention.run", {}, "g2")).result;
    assert.equal(preview.dryRun, true);
    const removable = ["cncr-clearedmoved0000000", "cncr-confirmeddone000000", "cncr-dismisseddone000000", "rck-done0000000000000000", "rck-equal000000000000000", "rck-retired0000000000000"];
    assert.deepEqual(preview.candidates.map((x: { id: string }) => x.id).sort(), removable);
    for (const id of removable) assert.equal(await has(id.startsWith("rck") ? "responsibility-check" : "stall-concern", id), true, "a preview removes nothing");
    assert.match((await call(boot.token, "retention.run", { dryRun: false, confirm: "wrong" }, "g3")).error?.code ?? "", /invalid_command/, "the digest of the preview is required");
    const real = (await call(boot.token, "retention.run", { dryRun: false, confirm: preview.digest }, "g4")).result;
    assert.equal(real.removed, 6);
    for (const id of removable) assert.equal(await has(id.startsWith("rck") ? "responsibility-check" : "stall-concern", id), false, id);
    for (const id of ["rck-owed0000000000000000", "rck-new00000000000000000"]) assert.equal(await has("responsibility-check", id), true, `${id} is kept`);
    for (const id of ["cncr-clearedlive00000000", "cncr-suspected0000000000", "cncr-confirmedlive000000", "cncr-pendingdone00000000", "cncr-dismissedrun0000000", "cncr-dismissednoend00000", "cncr-dismissedwait000000", "cncr-newcleared000000000"]) assert.equal(await has("stall-concern", id), true, `${id} is kept`);
    let n = 0; let after = 0; const rules: string[] = [];
    for (;;) { const page = await c.storage.listAudit({ afterSeq: after, limit: 500 }); for (const e of page) { after = e.seq; if (e.type === "retention.expire") { n += 1; rules.push((e.detail as { rule: string }).rule); assert.doesNotMatch(JSON.stringify(e), /secret words/, "the audit names IDs, never content"); } } if (page.length < 500) break; }
    assert.equal(n, 6, "every removal is audited"); assert.deepEqual([...new Set(rules)].sort(), ["check-record-days", "concern-days"]);
    assert.equal((await call(boot.token, "retention.run", {}, "g5")).result.candidates.length, 0, "a second pass finds nothing");
  } finally { await c.close(); clean(d); }
});
