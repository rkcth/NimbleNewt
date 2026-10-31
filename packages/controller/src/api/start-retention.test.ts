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

test("retention settings: owner only, everything off by default, race-safe, replay-safe, and the answer says old and new (card K06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ret-"));
  const { c, boot, call, agent } = await world(d);
  try {
    const ann = await agent("ann");
    const g0 = (await call(boot.token, "retention.settings.get", {})).result.item;
    assert.equal(g0.revision, 0);
    assert.equal(g0.effective.derivedDays, null); assert.equal(g0.effective.autoRun, false); assert.equal(g0.effective.quotaProjectBytes, null); assert.equal(g0.effective.quotaAgentBytes, null);
    assert.equal(g0.effective.thinkingDays, 14); assert.equal(g0.effective.backupDaily, 7); assert.equal(g0.effective.backupWeekly, 4);
    for (const op of ["retention.settings.get", "retention.status"]) assert.equal((await call(ann.token, op, {})).error?.code, "forbidden", op);
    assert.equal((await call(ann.token, "retention.settings.set", { derivedDays: 30 }, "x1")).error?.code, "forbidden");
    // No operation of the family is open to an agent, a task credential-less caller or a wildcard grant.
    const wild = await (async () => { await c.services.principals.enroll(await c.services.principals.authenticate(boot.token), { commandId: "e-wild", kind: "agent", name: "wild", grants: [{ action: "*", project: "*" }] } as never); return (await c.services.principals.issueCredential(await c.services.principals.authenticate(boot.token), "agent:wild")).token; })();
    const calls: [string, Record<string, unknown>][] = [["retention.check", { kind: "desk-record", id: "dsk-aaaaaaaaaaaaaaaaaaaa" }], ["retention.run", {}], ["retention.delete", { recordId: "dsk-aaaaaaaaaaaaaaaaaaaa", reason: "x" }], ["retention.archive", { taskId: "task-aaaaaaaaaaaaaaaaaaaa" }], ["retention.restore", { taskId: "task-aaaaaaaaaaaaaaaaaaaa" }], ["retention.export", { projectId: "proj-aaaaaaaaaaaaaaaaaaaa" }], ["retention.settings.set", { reserveBytes: 0 }], ["retention.status", {}], ["retention.settings.get", {}]];
    for (const [op, args] of calls) for (const [who, token] of [["agent", ann.token], ["wildcard agent", wild]] as const) assert.equal((await call(token, op, args, /\.(check|export|status|get)$/.test(op) ? undefined : `f-${op}-${who}`)).error?.code, "forbidden", `${op} by ${who}`);
    for (const bad of [{ derivedDays: 3 }, { derivedDays: 1.5 }, { quotaWarnPercent: 100 }, { autoRun: "yes" }, { thinkingDays: null }, { backupDaily: 0 }, { surprise: 1 }, {}]) assert.equal((await call(boot.token, "retention.settings.set", bad, `bad-${JSON.stringify(bad)}`)).error?.code, "invalid_command", JSON.stringify(bad));
    const set = await call(boot.token, "retention.settings.set", { derivedDays: 30, backupDaily: 3, expectedRevision: 0 }, "s1");
    assert.ok(set.ok, JSON.stringify(set));
    assert.deepEqual(set.result.changed, [{ field: "derivedDays", old: null, new: 30 }, { field: "backupDaily", old: 7, new: 3 }]);
    assert.match(set.result.summary, /derivedDays none -> 30/);
    assert.equal((await call(boot.token, "retention.settings.set", { derivedDays: 60, expectedRevision: 0 }, "s2")).error?.code, "stale_revision");
    // A replay answers with the same change and writes nothing.
    const again = await call(boot.token, "retention.settings.set", { derivedDays: 30, backupDaily: 3, expectedRevision: 0 }, "s1");
    assert.deepEqual(again.result.changed, set.result.changed);
    assert.equal((await call(boot.token, "retention.settings.get", {})).result.item.revision, 1);
    // "default" returns a field to the installation default; null clears an optional one.
    const back = await call(boot.token, "retention.settings.set", { backupDaily: "default", derivedDays: null }, "s3");
    assert.deepEqual(back.result.changed, [{ field: "derivedDays", old: 30, new: null }, { field: "backupDaily", old: 3, new: 7 }]);
    // Changes are in the audit trail.
    const audit = await audits(c);
    assert.ok(audit.some((a) => a.type === "retention.settings.set" && JSON.stringify(a.detail).includes("derivedDays")));
  } finally { await c.close(); clean(d); }
});

test("user-requested deletion: material a resumable task needs is retained and shown; when free, derived copies, summaries and compactions follow, backups are recorded, and nothing can resurrect the text (card K06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-del-"));
  let clock = Date.now() + 5_000;
  const { c, boot, call, project, agent, task, finish, put } = await world(d, { backup: { directory: join(d, "backups"), now: () => new Date(clock) } });
  try {
    const ann = await agent("ann"); const ben = await agent("ben");
    const t1 = await task("Weed", "t1");
    await call(boot.token, "task.transition", { taskId: t1, expectedRevision: 1, to: "ready" }, "t1a");
    const rec = await c.services.desks.write(ann.p, { commandId: "w1", projectId: project, taskId: t1, kind: "progress", title: "Beds", body: "North bed done", visibility: "shared", status: "accepted" });
    const copy = await c.services.desks.copy(ben.p, { commandId: "cp1", recordId: rec.id, visibility: "private" });
    const sum = await c.services.retrieval.summarize(ann.p, { commandId: "sm1", projectId: project, title: "Summary", text: "Beds are done.", sources: [{ kind: "desk-record", id: rec.id }] });
    await put("ctx-compaction", "cmp-1", { taskId: t1, projectId: project, key: "k", compressorId: "c", state: "done", generation: 1, lineage: [], sources: [{ kind: "desk-record", id: rec.id }], pinned: [], title: "t", summary: "Beds are done.", digest: "dg", summaryId: sum.id, startedBy: "x" });
    await c.services.backups!.backUpNow("manual");

    // The task can still resume: the record is retained, and says why; the owner sees the request recorded as retained.
    const chk = (await call(boot.token, "retention.check", { kind: "desk-record", id: rec.id })).result;
    assert.equal(chk.retained, true); assert.match(chk.reasons[0], /can still resume/);
    const refused = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "d1");
    assert.ok(refused.ok, JSON.stringify(refused));
    assert.equal(refused.result.status, "retained");
    assert.ok(refused.result.retained.length >= 2);
    assert.equal((await c.storage.getAggregate({ kind: "desk-record", id: rec.id }))!.body["body"], "North bed done", "nothing changed");
    assert.equal((await call(ann.token, "retention.delete", { recordId: rec.id, reason: "x" }, "d1b")).error?.code, "forbidden");
    const status = (await call(boot.token, "retention.status", {})).result.item;
    assert.equal(status.deletions[0].status, "retained");

    // The task is done: now it can go, and so does everything made from it.
    await finish(t1, "f");
    assert.equal((await call(boot.token, "retention.check", { kind: "desk-record", id: rec.id })).result.retained, false);
    const preview = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked", dryRun: true }, "d2p");
    assert.equal(preview.result.status, "preview");
    assert.deepEqual([preview.result.derived.copies, preview.result.derived.summaries, preview.result.derived.compactions], [[copy.id], [sum.id], ["cmp-1"]]);
    assert.equal((await c.storage.getAggregate({ kind: "desk-record", id: rec.id }))!.body["body"], "North bed done", "a preview changes nothing");
    const done = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "d2");
    assert.ok(done.ok, JSON.stringify(done));
    assert.equal(done.result.status, "deleted");
    assert.equal(done.result.backups.handling, "left to expire");
    assert.equal(done.result.backups.holding, 1);
    assert.match(done.result.backups.note, /not altered/);
    assert.match(done.result.derived.indexes, /none exist/); assert.match(done.result.derived.cachedReplies, /none are stored/);
    for (const id of [rec.id, copy.id]) { const b = (await c.storage.getAggregate({ kind: "desk-record", id }))!.body as any; assert.equal(b.body, ""); assert.equal(b.title, ""); assert.equal(b.visibility, "private"); assert.ok(b.deleted.by); assert.ok(b.deleted.contentDigest.length === 64); }
    assert.equal(await c.storage.getAggregate({ kind: "summary-record", id: sum.id }), undefined, "the summary is removed");
    assert.ok(await c.storage.getAggregate({ kind: "tombstone", id: (await import("../storage/tombstone.js")).tombstoneId({ kind: "summary-record", id: sum.id }) }), "and leaves a tombstone");
    const cmp = (await c.storage.getAggregate({ kind: "ctx-compaction", id: "cmp-1" }))!.body as any;
    assert.deepEqual([cmp.summary, cmp.sourceDeleted], ["", true]);
    // The text cannot be revived by the agent, copied or read back.
    assert.equal((await c.services.desks.revise(ann.p, { commandId: "rv", recordId: rec.id, expectedRevision: 2, body: "back" }).catch((e) => e.code)), "invalid_command");
    assert.ok(["invalid_command", "forbidden"].includes(await c.services.desks.copy(ben.p, { commandId: "cp2", recordId: rec.id }).catch((e) => e.code)));
    // A replay is the same deletion, and a second request leaves things as they are.
    assert.equal((await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "d2")).result.deletionId, done.result.deletionId);
    const dels = (await call(boot.token, "retention.status", {})).result.item.deletions;
    assert.deepEqual(dels.map((x: any) => x.status).sort(), ["deleted", "retained"]);
    // The audit trail names each removal.
    const audit = await audits(c);
    assert.ok(audit.some((a) => a.type === "retention.delete.summary" && a.subject?.id === sum.id));
    // Invalid targets are refused.
    assert.equal((await call(boot.token, "retention.delete", { recordId: "task-aaaaaaaaaaaaaaaaaaaa", reason: "x" }, "d3")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "retention.delete", { recordId: rec.id, reason: "token ghp_abcdefghijklmnopqrstuvwxyz0123456789" }, "d4")).error?.code, "invalid_command");
    clock += 1;
  } finally { await c.close(); clean(d); }
});

test("the runner: off until derivedDays is set, preview then confirm by digest, retained material skipped, backups follow the owner's counts, and the dispatcher runs it only when asked to (card K06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-run-"));
  let clock = Date.parse("2026-10-01T10:00:00.000Z");
  const { c, boot, call, project, agent, task, finish, put } = await world(d, { backup: { directory: join(d, "backups"), now: () => new Date(clock) } });
  try {
    const ann = await agent("ann");
    const t1 = await task("Live", "t1"); const t2 = await task("Old", "t2");
    await call(boot.token, "task.transition", { taskId: t1, expectedRevision: 1, to: "ready" }, "t1a");
    await finish(t2, "g");
    const r1 = await c.services.desks.write(ann.p, { commandId: "w1", projectId: project, kind: "note", title: "a", body: "a", visibility: "shared" });
    const mk = async (id: string, sources: string[]) => (await c.services.retrieval.summarize(ann.p, { commandId: id, projectId: project, title: id, text: id, sources: sources.map((s) => ({ kind: "desk-record" as const, id: s })) })).id;
    const freeSum = await mk("free", [r1.id]); const heldSum = await mk("held", [r1.id]);
    await put("ctx-compaction", "cmp-9", { taskId: t1, projectId: project, key: "k", compressorId: "c", state: "done", generation: 1, lineage: [], sources: [], pinned: [], title: "t", summary: "x", digest: "d", summaryId: heldSum, startedBy: "x" });
    // Everything is older than 40 days (the stored time is moved back, as the clock cannot be).
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const realGet = c.storage.getAggregate.bind(c.storage); const realList = c.storage.listAggregates.bind(c.storage);
    const back = (a: any) => (a?.kind === "summary-record" ? { ...a, updatedAt: old } : a);
    c.storage.getAggregate = async (ref) => back(await realGet(ref));
    c.storage.listAggregates = (async (k: string, o: any) => (await realList(k, o)).map(back)) as never;

    // Off by default: nothing is a candidate, and a run does nothing.
    const off0 = await call(boot.token, "retention.run", {}, "r0"); assert.ok(off0.ok, JSON.stringify(off0)); const off = off0.result;
    assert.deepEqual([off.dryRun, off.enabled, off.candidates.length], [true, false, 0]);
    const off2 = await call(boot.token, "retention.run", { dryRun: false, confirm: off.digest }, "r0b"); assert.ok(off2.ok, JSON.stringify(off2)); assert.equal(off2.result.removed, 0);
    assert.ok(await realGet({ kind: "summary-record", id: freeSum }));

    assert.ok((await call(boot.token, "retention.settings.set", { derivedDays: 30 }, "s1")).ok);
    const prev = (await call(boot.token, "retention.run", {}, "r1")).result;
    assert.deepEqual(prev.candidates.map((x: any) => x.id), [freeSum]);
    assert.deepEqual(prev.retained.map((x: any) => x.id), [heldSum]);
    assert.match(prev.retained[0].reasons[0], /can still resume/);
    assert.ok(await realGet({ kind: "summary-record", id: freeSum }), "a preview removes nothing");
    // Running needs the digest of what was shown.
    assert.equal((await call(boot.token, "retention.run", { dryRun: false }, "r2")).error?.code, "invalid_command");
    assert.equal((await call(boot.token, "retention.run", { dryRun: false, confirm: "0".repeat(64) }, "r3")).error?.code, "invalid_command");
    assert.equal((await call(ann.token, "retention.run", { dryRun: false, confirm: prev.digest }, "r4")).error?.code, "forbidden");
    const ran = (await call(boot.token, "retention.run", { dryRun: false, confirm: prev.digest }, "r5")).result;
    assert.equal(ran.removed, 1);
    assert.equal(await realGet({ kind: "summary-record", id: freeSum }), undefined);
    assert.ok(await realGet({ kind: "summary-record", id: heldSum }), "held by a resumable task: kept");
    assert.ok(await realGet({ kind: "retention-run", id: ran.runId }), "the run is recorded");
    // The same digest again is stale (what it showed is gone): refused, nothing more is removed.
    assert.equal((await call(boot.token, "retention.run", { dryRun: false, confirm: prev.digest }, "r5b")).error?.code, "invalid_command");

    // Backups follow the owner's counts: three days of backups, keep one.
    for (let i = 0; i < 3; i++) { clock += 86_400_000; await c.services.backups!.backUpNow("manual"); }
    assert.equal((await c.services.backups!.list()).length, 3);
    assert.ok((await call(boot.token, "retention.settings.set", { backupDaily: 1, backupWeekly: 0 }, "s2")).ok);
    const p2 = (await call(boot.token, "retention.run", {}, "r6")).result;
    assert.equal(p2.backups.wouldDelete.length, 2);
    const newest = (await c.services.backups!.list())[0]!.manifest.name;
    const r7 = (await call(boot.token, "retention.run", { dryRun: false, confirm: p2.digest }, "r7")).result;
    assert.equal(r7.backups.deleted.length, 2);
    assert.deepEqual((await c.services.backups!.list()).map((b) => b.manifest.name), [newest], "the newest backup is never deleted");

    // The incident rules (K06's soft archive and the purge) run with the runner once their ages are set; with nothing old they remove nothing.
    assert.ok((await call(boot.token, "retention.settings.set", { incidentArchiveDays: 30, incidentPurgeDays: 60 }, "s2b")).ok);
    const p3 = (await call(boot.token, "retention.run", {}, "r8")).result;
    assert.deepEqual([p3.incidents.archiveDays, p3.incidents.purgeDays], [30, 60]);
    const r9 = (await call(boot.token, "retention.run", { dryRun: false, confirm: p3.digest }, "r9")).result;
    assert.deepEqual([r9.incidents.archived, r9.incidents.purged], [0, 0]);

    // The dispatcher does nothing by itself until autoRun is on.
    await put("summary-record", "sum-old-1", { projectId: project, title: "t", text: "t", sources: [], createdBy: "x" });
    for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
    assert.ok(await realGet({ kind: "summary-record", id: "sum-old-1" }));
    assert.ok((await call(boot.token, "retention.settings.set", { autoRun: true }, "s3")).ok);
    for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
    assert.equal(await realGet({ kind: "summary-record", id: "sum-old-1" }), undefined, "removed by the dispatcher's pass");
    assert.ok(await realGet({ kind: "summary-record", id: heldSum }), "still held");
  } finally { await c.close(); clean(d); }
});

test("archive then restore returns the original exactly; a record changed since, or one a resumable task needs, is left alone; export leaves secrets out (card K06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-arc-"));
  const { c, boot, call, project, agent, task, finish, put } = await world(d);
  try {
    const ann = await agent("ann");
    const t1 = await task("Live", "t1"); const t2 = await task("Done", "t2");
    await call(boot.token, "task.transition", { taskId: t1, expectedRevision: 1, to: "ready" }, "t1a");
    const a = await c.services.desks.write(ann.p, { commandId: "wa", projectId: project, taskId: t2, kind: "progress", title: "Plan", body: "Dig the bed", visibility: "shared", status: "accepted" });
    const b = await c.services.desks.write(ann.p, { commandId: "wb", projectId: project, taskId: t2, kind: "note", title: "Cited", body: "Shared with a live task", visibility: "shared" });
    const before = await c.storage.getAggregate({ kind: "desk-record", id: a.id });
    const sum = await c.services.retrieval.summarize(ann.p, { commandId: "sm", projectId: project, title: "About the plan", text: "Dig the bed first.", sources: [{ kind: "desk-record", id: a.id }] });
    const sumBefore = await c.storage.getAggregate({ kind: "summary-record", id: sum.id });
    assert.equal((await call(boot.token, "retention.archive", { taskId: t2 }, "ar0")).error?.code, "invalid_command", "only a finished task");
    await finish(t2, "f");
    await put("ctx-compaction", "cmp-1", { taskId: t1, projectId: project, key: "k", compressorId: "c", state: "done", generation: 1, lineage: [], sources: [{ kind: "desk-record", id: b.id }], pinned: [], title: "t", summary: "x", digest: "d", startedBy: "x" });
    assert.equal((await call(ann.token, "retention.archive", { taskId: t2 }, "ar1")).error?.code, "forbidden");
    const arc = (await call(boot.token, "retention.archive", { taskId: t2, reason: "tidy" }, "ar1")).result;
    assert.deepEqual(arc.archived.sort(), [a.id, sum.id].sort(), "what was made from the source goes with it");
    const sumStub = (await c.storage.getAggregate({ kind: "summary-record", id: sum.id }))!.body as any;
    assert.deepEqual([sumStub.text, sumStub.projectId, sumStub.sources.length], ["", project, 1], "it keeps its project and its sources");
    assert.deepEqual(arc.retained.map((x: any) => x.id), [b.id], "cited by a resumable task: retained, not archived");
    const stub = (await c.storage.getAggregate({ kind: "desk-record", id: a.id }))!.body as any;
    assert.deepEqual([stub.title, stub.body, stub.archived.by !== undefined], ["(archived)", "", true]);
    assert.equal(await c.services.desks.revise(ann.p, { commandId: "rv", recordId: a.id, expectedRevision: 2, body: "x" }).catch((e) => e.code), "invalid_command");
    assert.equal((await c.storage.getAggregate({ kind: "desk-record", id: b.id }))!.body["body"], "Shared with a live task");
    // An archive of an archive does nothing more.
    assert.deepEqual((await call(boot.token, "retention.archive", { taskId: t2 }, "ar2")).result.archived, []);
    // Restore: exactly the original body.
    const rest0 = await call(boot.token, "retention.restore", { taskId: t2 }, "rs1"); assert.ok(rest0.ok, JSON.stringify(rest0)); const rest = rest0.result;
    assert.deepEqual([rest.restored.sort(), rest.conflicts], [[a.id, sum.id].sort(), []]);
    const restored = await c.storage.getAggregate({ kind: "desk-record", id: a.id });
    assert.deepEqual(restored!.body, before!.body);
    assert.deepEqual((await c.storage.getAggregate({ kind: "summary-record", id: sum.id }))!.body, sumBefore!.body, "and so does the summary");
    assert.equal(await c.storage.getAggregate({ kind: "retention-archive", id: `arc-${a.id}` }), undefined);
    // Archived again, then the stub is changed: the restore leaves it and says so.
    await call(boot.token, "retention.archive", { taskId: t2 }, "ar3");
    const cur = (await c.storage.getAggregate({ kind: "desk-record", id: a.id }))!;
    await c.storage.applyOperation({ operationId: "touch", epoch: c.epoch, actor: "test", correlationId: "touch", at: new Date().toISOString(), changes: [{ type: "update", ref: { kind: "desk-record", id: a.id }, expectedRevision: cur.revision, body: { ...cur.body, status: "superseded" } as never }], audit: [{ type: "test.touch", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
    const rest2 = (await call(boot.token, "retention.restore", { taskId: t2 }, "rs2")).result;
    assert.deepEqual([rest2.restored, rest2.conflicts], [[sum.id], [a.id]]);
    // Deleting an archived record removes its archive too: no copy of the text is left behind.
    const del = (await call(boot.token, "retention.delete", { recordId: a.id, reason: "gone" }, "dl1")).result;
    assert.equal(del.status, "deleted"); assert.deepEqual(del.derived.archives, [`arc-${a.id}`]);
    assert.equal(await c.storage.getAggregate({ kind: "summary-record", id: sum.id }), undefined, "the summary is gone too");
    assert.equal(await c.storage.getAggregate({ kind: "retention-archive", id: `arc-${sum.id}` }), undefined);
    assert.equal(await c.storage.getAggregate({ kind: "retention-archive", id: `arc-${a.id}` }), undefined);

    // Export: secrets are masked or left out; credential kinds are not in it.
    await put("desk-record", "dsk-zzzzzzzzzzzzzzzzzzzz", { owner: "agent:ann", projectId: project, kind: "note", title: "keys", body: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789 here", apiKey: "sk-live-verysecretvalue", status: "draft", visibility: "shared" });
    const out = (await call(boot.token, "retention.export", { projectId: project })).result;
    const text = JSON.stringify(out);
    assert.ok(!text.includes("ghp_abcdef") && !text.includes("verysecretvalue"), "no secret leaves");
    assert.ok(out.redactions >= 1);
    assert.ok(out.items.some((i: any) => i.kind === "project") && out.items.some((i: any) => i.kind === "task") && out.items.some((i: any) => i.id === "dsk-zzzzzzzzzzzzzzzzzzzz"));
    assert.ok(!out.items.some((i: any) => ["principal", "task-credential", "grant-record", "retention-settings"].includes(i.kind)));
    assert.equal((await call(ann.token, "retention.export", { projectId: project })).error?.code, "forbidden");
    // Paging: a page of two continues to the rest, with no repeats and none missed.
    const all: string[] = []; let after: string | undefined;
    for (let i = 0; i < 20; i++) { const page = (await call(boot.token, "retention.export", { projectId: project, limit: 2, ...(after === undefined ? {} : { after }) })).result; all.push(...page.items.map((x: any) => `${x.kind}/${x.id}`)); after = page.next; if (after === undefined) break; }
    assert.deepEqual(all, out.items.map((x: any) => `${x.kind}/${x.id}`));
  } finally { await c.close(); clean(d); }
});

test("quotas are optional and warn; the reserve is a real file, and with the disk full a critical write still succeeds while an ordinary one fails and a failed critical one is never reported done (card K06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-quota-"));
  const { c, boot, call, project, agent } = await world(d, { retention: { defaults: { reserveBytes: 0 } } });
  try {
    const ann = await agent("ann");
    const write = (id: string, body: string) => c.services.desks.write(ann.p, { commandId: id, projectId: project, kind: "note", title: id, body, visibility: "shared" });
    const big = "x".repeat(900);
    // No quota set: nothing is limited.
    for (let i = 0; i < 4; i++) await write(`free${i}`, big);
    assert.ok((await call(boot.token, "retention.settings.set", { quotaProjectBytes: 4500, quotaWarnPercent: 50 }, "q1")).ok);
    const st0 = await call(boot.token, "retention.status", {}); assert.ok(st0.ok, JSON.stringify(st0)); const used = st0.result.item.quotas as any[]; assert.ok(used.length > 0, JSON.stringify(st0.result.item));
    assert.equal(used[0].level, "warn"); assert.equal(used[0].scope, "project");
    assert.match((await call(boot.token, "retention.status", {})).result.item.warnings[0], /storage quota/);
    // Over the quota the write is refused, says why, and writes nothing; raising the quota lets it through.
    const refused = await write("over", big).catch((e) => e);
    assert.equal(refused.code, "unavailable"); assert.match(refused.message, /over its storage quota/);
    assert.ok((await call(boot.token, "retention.settings.set", { quotaProjectBytes: 100000 }, "q2")).ok);
    await write("over", big);
    // The warning reaches the owner once.
    assert.ok((await call(boot.token, "retention.settings.set", { quotaProjectBytes: 4500 }, "q3")).ok);
    for (let i = 0; i < 3; i++) await c.dispatch!.dispatcher.tick();
    const notes = (await c.storage.listAggregates("notification-item", { limit: 100 })).filter((n) => JSON.stringify(n.body).includes("Storage quota"));
    assert.equal(notes.length, 1, "told once");
    // The per-agent quota is separate and also optional.
    assert.ok((await call(boot.token, "retention.settings.set", { quotaProjectBytes: null, quotaAgentBytes: 2000 }, "q4")).ok);
    assert.match(((await write("agentover", big).catch((e) => e)) as Error).message, /storage quota/);
    assert.ok((await call(boot.token, "retention.settings.set", { quotaAgentBytes: null }, "q5")).ok, "settings can always be changed: a retention command is never refused for room");
    await write("agentok", big);

    // The reserve: a real file the owner sets by chat.
    const file = join(d, ".nn-reserve");
    assert.equal(existsSync(file), false);
    assert.ok((await call(boot.token, "retention.settings.set", { reserveBytes: 1_048_576 }, "r1")).ok);
    assert.equal(statSync(file).size, 1_048_576);
    // The disk fills: every write fails while the reserve file stands.
    const raw = unguarded(c.storage); const real = raw.applyOperation.bind(raw);
    let calls = 0; let broken = false;
    raw.applyOperation = (async (input: any) => { calls++; if (broken || existsSync(file)) throw Object.assign(new Error("storage failed"), { cause: Object.assign(new Error("database or disk is full"), { code: "SQLITE_FULL" }) }); return real(input); }) as never;
    const ordinary = await write("full1", "hello").catch((e) => e);
    assert.equal(ordinary.code, "unavailable"); assert.ok(existsSync(file), "an ordinary write never takes the reserve");
    // A critical write (a retention command, a checkpoint, a stop, a recovery record) takes the reserve and goes through.
    const crit = await call(boot.token, "retention.settings.set", { thinkingDays: 20 }, "r2");
    assert.ok(crit.ok, JSON.stringify(crit));
    assert.equal(existsSync(file), false, "the reserve was given back");
    assert.equal((await call(boot.token, "retention.settings.get", {})).result.item.effective.thinkingDays, 20);
    // From then on ordinary writes are refused up front (protected) and the status says so; critical ones still work while room is left.
    calls = 0;
    const prot = await write("full2", "hello").catch((e) => e);
    assert.match(prot.message, /reserve for shutdown and recovery records is in use/); assert.equal(calls, 0, "refused before touching the store");
    const st = (await call(boot.token, "retention.status", {})).result.item;
    assert.equal(st.disk.reserve.inUse, true); assert.ok(st.warnings.some((w: string) => /reserve/.test(w)));
    // A critical write that still fails (no room even after the reserve) is an error, never success.
    broken = true;
    const failed = await call(boot.token, "retention.settings.set", { thinkingDays: 21 }, "r3");
    assert.equal(failed.ok, false);
    broken = false;
    // Room is made: the dispatcher's pass sets the reserve again and ordinary writes resume.
    raw.applyOperation = real as never;
    for (let i = 0; i < 2; i++) await c.dispatch!.dispatcher.tick();
    assert.equal(existsSync(file), true, "the reserve was set aside again");
    await write("resumed", "ok");
  } finally { await c.close(); clean(d); }
});

test("a restart keeps the settings, the quota and the reserve; a missing reserve is set aside again; a damaged setting is an error, not a silent default (card K06)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-restart-"));
  const open = () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 1000 }, retention: { defaults: { reserveBytes: 0 } } } as never);
  let c = await open();
  const file = join(d, ".nn-reserve");
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const project = (await call("project.create", { name: "Garden" }, "p1")).result.id as string;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "desk.write", project }, { action: "desk.read", project }] } as never);
    const ann = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:ann")).token);
    assert.ok((await call("retention.settings.set", { reserveBytes: 262_144, quotaAgentBytes: 1500, derivedDays: 45 }, "s1")).ok);
    assert.equal(statSync(file).size, 262_144);
    await c.close();
    rmSync(file);
    c = await open();
    assert.equal(statSync(file).size, 262_144, "set aside again at start, from the stored value");
    const read = (await c.api.handle(boot.token, { v: 1, op: "retention.settings.get", args: {} } as never) as Reply).result.item;
    assert.deepEqual([read.effective.derivedDays, read.effective.quotaAgentBytes, read.effective.reserveBytes, read.revision], [45, 1500, 262_144, 1]);
    const annAgain = await c.services.principals.authenticate((await c.services.principals.issueCredential(await c.services.principals.authenticate(boot.token), "agent:ann")).token);
    await assert.rejects(c.services.desks.write(annAgain, { commandId: "w1", projectId: project, kind: "note", title: "t", body: "x".repeat(2000), visibility: "shared" }), /storage quota/);
    void ann;
    // A damaged record is an error on the setting; the owner repairs it by setting it again.
    const raw = unguarded(c.storage); const realGet = raw.getAggregate.bind(raw);
    let damaged = true;
    raw.getAggregate = async (ref) => { const a = await realGet(ref); return damaged && ref.kind === "retention-settings" && a !== undefined ? { ...a, body: { values: { derivedDays: "soon" } } } as never : a; };
    const bad = (await c.api.handle(boot.token, { v: 1, op: "retention.settings.get", args: {} } as never) as Reply);
    assert.equal(bad.error?.code, "unavailable");
    assert.equal((await c.api.handle(boot.token, { v: 1, op: "retention.run", args: {}, commandId: "r1" } as never) as Reply).error?.code, "unavailable", "the runner does not guess");
    assert.ok(((await c.api.handle(boot.token, { v: 1, op: "retention.settings.set", args: { derivedDays: 60 }, commandId: "s2" } as never)) as Reply).ok, "and the owner can repair it");
    damaged = false;
    assert.equal((await c.api.handle(boot.token, { v: 1, op: "retention.settings.get", args: {} } as never) as Reply).result.item.effective.derivedDays, 60);
  } finally { await c.close(); clean(d); }
});
