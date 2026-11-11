import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { NotificationService } from "../notifications/index.js";
import { incidentSlotId } from "../projects/index.js";
import { RETENTION_DEFAULTS, RetentionService } from "../retention/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
const DAY = 86_400_000;

async function world(d: string) {
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, retention: { defaults: { reserveBytes: 0 }, autoEveryMs: 0 } } as never);
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
  const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
  const task = async (title: string, id: string) => (await call("task.create", { projectId: project, title }, id)).result.id as string;
  let seq = 0;
  const put = async (kind: string, id: string, body: object) => { const op = `put:${kind}:${id}:${++seq}`; await c.storage.applyOperation({ operationId: op, epoch: c.epoch, actor: "test", correlationId: op, at: new Date().toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
  const drop = async (kind: string, id: string) => { const a = await c.storage.getAggregate({ kind, id }); await c.storage.applyOperation({ operationId: `drop:${kind}:${id}:${a!.revision}`, epoch: c.epoch, actor: "test", correlationId: `drop:${kind}:${id}:${a!.revision}`, at: new Date().toISOString(), changes: [{ type: "delete", ref: { kind, id }, expectedRevision: a!.revision }], audit: [{ type: "test.drop", subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
  return { c, boot, rob, call, project, task, put, drop };
}
const clean = (d: string) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("stall evidence and speeds, and the history and incident counters of retired responsibilities, are kept by default; with the owner-set days the runner previews, then removes exactly the ones that can never be needed or written again, audited (card K06e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ret-hist-"));
  const { c, boot, rob, call, project, task, put } = await world(d);
  try {
    const has = async (kind: string, id: string) => (await c.storage.getAggregate({ kind, id })) !== undefined;
    // The records are made now, so a service whose clock runs ahead sees them as old; `F` is its "now" and the body times are set relative to it.
    const F = Date.now() + 60 * DAY; const ago = (days: number): string => new Date(F - days * DAY).toISOString();
    const values = { ...RETENTION_DEFAULTS, reserveBytes: 0, stallEvidenceDays: 30 as number | null, stallSpeedDays: 30 as number | null, responsibilityHistoryDays: 30 as number | null };
    const later = (ahead: number, v = values) => RetentionService.withEpoch(c.storage, c.epoch, { settings: { effective: async () => v }, now: () => Date.now() + ahead * DAY }, { clock: () => new Date(Date.now() + ahead * DAY).toISOString() });
    const doneTask = await task("finished", "t-done"); const liveTask = await task("running", "t-live"); const suspTask = await task("watched", "t-susp");
    for (const t of [doneTask, suspTask]) { for (const [i, to] of ["ready", "in_progress", "done"].entries()) { const cur = (await call("task.get", { taskId: t })).result.item; const r = await call("task.transition", { taskId: t, expectedRevision: cur.revision, to }, `mv-${t}-${i}`); assert.ok(r.ok, JSON.stringify(r)); } }
    const ev = (taskId: string, lastReportAt: string, extra: object = {}) => put("stall-evidence", taskId, { taskId, projectId: project, generation: 1, since: lastReportAt, reportedBy: "agent:ann", lastReportAt, lastProgressAt: lastReportAt, reports: 3, steps: 2, window: [], counts: {}, evidence: [], evidenceTotal: 0, ...extra });
    await ev(doneTask, ago(40));                                                       // done, quiet for 40 days: removed
    await ev(liveTask, ago(40), { request: { id: "rq1", startedAt: ago(40), route: "route-busy" } }); // the task can still run: kept
    await ev(suspTask, ago(40));                                                       // done, but a suspected concern names it: kept
    await ev("task-gone0000000000000000", ago(40));                                    // the task is gone: removed
    await put("stall-concern", "cncr-susp0000000000000000", { taskId: suspTask, projectId: project, generation: 1, kind: "silent", state: "suspected", detail: "secret words", firstSeenAt: ago(41), lastChangedAt: ago(40), reopened: 0 });
    const doneNew = await task("finished lately", "t-done2"); for (const [i, to] of ["ready", "in_progress", "done"].entries()) { const cur = (await call("task.get", { taskId: doneNew })).result.item; await call("task.transition", { taskId: doneNew, expectedRevision: cur.revision, to }, `mv2-${i}`); }
    await ev(doneNew, ago(2));                                                         // reported two days ago: kept
    const spd = (id: string, route: string, days: number) => put("stall-speed", id, { route, hostId: "-", readTps: 90, readSamples: 4, writeSamples: 0, updatedAt: ago(days) });
    await spd("sps-old", "route-old", 40); await spd("sps-new", "route-new", 2); await spd("sps-busy", "route-busy", 40);

    const respBody = (state: string) => ({ projectId: project, title: "t", objective: "o", desiredCondition: "c", managed: [], eventSources: [], permittedActions: [], maintenanceWindows: [], state, createdBy: "owner" });
    const RET = "resp-retired0000000000000"; const ACT = "resp-active00000000000000"; const OLD = "resp-retiredopen0000000000";
    await put("responsibility", RET, respBody("retired")); await put("responsibility", ACT, respBody("active")); await put("responsibility", OLD, respBody("retired"));
    for (const id of [RET, ACT, OLD]) { await put("responsibility-log", id, { n: 2, lastCheckAt: ago(50) }); for (const s of [1, 2]) await put("responsibility-event", `${id}.${s}`, { responsibilityId: id, projectId: project, seq: s, kind: "note", summary: "secret words of the note", at: ago(50), by: "agent:ann" }); }
    const slotOf = (rid: string, sig: string) => incidentSlotId(rid, sig);
    await put("responsibility-incident-slot", slotOf(RET, "own"), { generation: 3, responsibilityId: RET });            // names its responsibility
    await put("responsibility-incident", "rinc-resolvedold00000000000", { responsibilityId: RET, projectId: project, signature: "viaincident", state: "resolved", count: 1, firstAt: ago(50), lastAt: ago(50), lastSummary: "x", worst: "failed" });
    await put("responsibility-incident-slot", slotOf(RET, "viaincident"), { generation: 1 });                          // an older slot, tied by its incident
    await put("responsibility-incident-slot", slotOf(ACT, "live"), { generation: 1, responsibilityId: ACT });         // active responsibility: can still be reported on
    await put("responsibility-incident", "rinc-open000000000000000000", { responsibilityId: OLD, projectId: project, signature: "stillopen", state: "open", count: 2, firstAt: ago(50), lastAt: ago(50), lastSummary: "x", worst: "failed" });
    await put("responsibility-incident-slot", slotOf(OLD, "stillopen"), { generation: 1, openId: "rinc-open000000000000000000", responsibilityId: OLD }); // its incident is open: kept
    await put("responsibility-incident-slot", "rslot-untied000000000000000000", { generation: 5 });                    // tied to nobody: kept

    const off = await later(60, { ...RETENTION_DEFAULTS, reserveBytes: 0 }).run(rob, {});
    assert.equal(off.candidates.length, 0, "off by default: nothing is a candidate");
    const status = (await call("retention.status", {})).result.item;
    assert.ok(status.growth["stall-evidence"] >= 5 && status.growth["stall-speed"] === 3 && status.growth["responsibility-event"] === 6 && status.growth["responsibility-incident-slot"] === 5);
    for (const [field, value] of [["stallEvidenceDays", 6], ["stallSpeedDays", 3651], ["responsibilityHistoryDays", 6], ["responsibilityHistoryDays", "30"]] as const) assert.equal((await call("retention.settings.set", { [field]: value }, `bad-${field}-${value}`)).ok, false, `${field} ${value} is refused`);
    const set = await call("retention.settings.set", { stallEvidenceDays: 30, stallSpeedDays: 30, responsibilityHistoryDays: 30 }, "set1");
    assert.ok(set.ok); assert.match(JSON.stringify(set.result), /responsibilityHistoryDays none -> 30/);
    assert.equal((await call("retention.settings.set", { stallEvidenceDays: null, stallSpeedDays: null, responsibilityHistoryDays: null }, "set2")).ok, true, "and off again");

    // Five days on, nothing retired or finished is old enough by its own last change: the retired responsibilities and finished tasks were changed "just now".
    const soon = await later(5).run(rob, {});
    assert.deepEqual(soon.candidates.filter((x) => x.kind !== "stall-speed").map((x) => x.id), [], "a task finished or a responsibility retired 5 days ago is not old");

    const svc = later(60);
    const preview = await svc.run(rob, {});
    const want = [["responsibility-event", `${RET}.1`], ["responsibility-event", `${RET}.2`], ["responsibility-event", `${OLD}.1`], ["responsibility-event", `${OLD}.2`], ["responsibility-incident-slot", slotOf(RET, "own")], ["responsibility-incident-slot", slotOf(RET, "viaincident")], ["stall-evidence", doneTask], ["stall-evidence", "task-gone0000000000000000"], ["stall-speed", "sps-old"]].map(([k, i]) => `${k}/${i}`).sort();
    assert.deepEqual(preview.candidates.map((x) => `${x.kind}/${x.id}`).sort(), want);
    for (const x of preview.candidates) assert.equal(await has(x.kind, x.id), true, "a preview removes nothing");
    await assert.rejects(svc.run(rob, { dryRun: false, confirm: "wrong" }), /confirm|preview|digest/i);
    const real = await svc.run(rob, { dryRun: false, confirm: preview.digest! });
    assert.equal(real.removed, want.length);
    for (const x of preview.candidates) assert.equal(await has(x.kind, x.id), false, `${x.kind}/${x.id} removed`);
    for (const [k, i] of [["stall-evidence", liveTask], ["stall-evidence", suspTask], ["stall-evidence", doneNew], ["stall-speed", "sps-new"], ["stall-speed", "sps-busy"], ["responsibility-event", `${ACT}.1`], ["responsibility-event", `${ACT}.2`], ["responsibility-incident-slot", slotOf(ACT, "live")], ["responsibility-incident-slot", slotOf(OLD, "stillopen")], ["responsibility-incident-slot", "rslot-untied000000000000000000"], ["responsibility-log", RET], ["responsibility", RET], ["responsibility-incident", "rinc-resolvedold00000000000"]]) assert.equal(await has(k!, i!), true, `${k}/${i} is kept`);

    // A measured speed is created again under the same ID by the next request: its second removal must not be mistaken for the first (the storage continues the removed revision).
    await spd("sps-old", "route-old", 40);
    const again = svc; const p2 = await again.run(rob, {});
    assert.deepEqual(p2.candidates.map((x) => x.id), ["sps-old"]);
    assert.equal((await again.run(rob, { dryRun: false, confirm: p2.digest! })).removed, 1);
    assert.equal(await has("stall-speed", "sps-old"), false, "removed again");

    const rules = new Set<string>(); let after = 0;
    for (;;) { const page = await c.storage.listAudit({ afterSeq: after, limit: 500 }); for (const e of page) { after = e.seq; if (e.type === "retention.expire") { rules.add((e.detail as { rule: string }).rule); assert.doesNotMatch(JSON.stringify(e), /secret words/, "the audit names IDs, never content"); } } if (page.length < 500) break; }
    assert.deepEqual([...rules].sort(), ["responsibility-history-days", "stall-evidence-days", "stall-speed-days"]);
    assert.equal((await svc.run(rob, {})).candidates.length, 0, "a second pass finds nothing");
    void boot;
  } finally { await c.close(); clean(d); }
});

test("a notice that names an incident, concern or check that retention removed says so and is closed; export covers checks, concerns and incidents with secrets masked (cards K06f, K06g)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ret-dangle-"));
  const { c, rob, call, project, put, drop } = await world(d);
  try {
    const n = NotificationService.withEpoch(c.storage, c.epoch, {});
    await put("responsibility-incident", "rinc-gone0000000000000000", { responsibilityId: "resp-x", projectId: project, signature: "s", state: "resolved", count: 1, firstAt: new Date().toISOString(), lastAt: new Date().toISOString(), lastSummary: "x", worst: "failed", token: "sk-live-abcdefghijklmnopqrstuvwxyz0123456789", archivedAt: new Date().toISOString() });
    await put("stall-concern", "cncr-kept00000000000000000", { taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: project, generation: 1, kind: "silent", state: "cleared", detail: "d", firstSeenAt: new Date().toISOString(), lastChangedAt: new Date().toISOString(), reopened: 0, password: "hunter2" });
    await put("responsibility-check", "rck-kept000000000000000000", { responsibilityId: "resp-x", projectId: project, slotStart: new Date().toISOString(), scheduledAt: new Date().toISOString(), inMaintenanceWindow: false });
    await n.emitFromController({ commandId: "inc-1", kind: "maintenance", level: "needs-you", ref: { kind: "responsibility-incident", id: "rinc-gone0000000000000000" }, projectId: project, detail: "an incident escalated" });
    await n.emitFromController({ commandId: "chk-1", kind: "maintenance", level: "needs-you", ref: { kind: "responsibility-check", id: "rck-kept000000000000000000" }, projectId: project, detail: "a check is owed" });
    let inbox = await n.inbox(rob); assert.equal(inbox.items.length, 2); assert.ok(inbox.items.every((i) => i.refGone === undefined), "both records exist: nothing is said");

    const exported = (await call("retention.export", { projectId: project })).result;
    const kinds = exported.items.map((i: { kind: string }) => i.kind);
    for (const k of ["responsibility-incident", "stall-concern", "responsibility-check"]) assert.ok(kinds.includes(k), `${k} is in the export`);
    assert.doesNotMatch(JSON.stringify(exported), /hunter2|sk-live-abcdefghijklmnopqrstuvwxyz/, "secrets are masked");
    assert.ok(exported.redactions >= 2);

    await drop("responsibility-incident", "rinc-gone0000000000000000");
    inbox = await n.inbox(rob);
    const gone = inbox.items.find((i) => i.ref.id === "rinc-gone0000000000000000")!;
    assert.equal(gone.refGone, true); assert.match(gone.refNote ?? "", /no longer available/);
    assert.equal(inbox.items.find((i) => i.ref.id === "rck-kept000000000000000000")!.refGone, undefined, "a record that is still there is not marked");
    await n.runDue();
    inbox = await n.inbox(rob);
    assert.deepEqual(inbox.items.map((i) => i.ref.id), ["rck-kept000000000000000000"], "the notice about the removed incident is closed, the other stays");
  } finally { await c.close(); clean(d); }
});
