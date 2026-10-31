import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { unguarded, RetentionService, DeletionLedger, LEDGER_FILE } from "../retention/index.js";
import { restoreBackup } from "../backup/index.js";
import { MemoryStorage } from "../storage/index.js";
import { redact } from "../security/redact.js";
import { readFileSync } from "node:fs";
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


const B32 = "abcdefghijklmnopqrstuvwxyz234567";
const age = (c: any, kinds: string[], days = 40) => {
  const old = new Date(Date.now() - days * 86_400_000).toISOString();
  const realGet = c.storage.getAggregate.bind(c.storage); const realList = c.storage.listAggregates.bind(c.storage);
  const back = (a: any) => (a !== undefined && kinds.includes(a.kind) ? { ...a, updatedAt: old } : a);
  c.storage.getAggregate = async (ref: any) => back(await realGet(ref));
  c.storage.listAggregates = (async (k: string, o: any) => (await realList(k, o)).map(back)) as never;
};

test("deletion follows compaction lineage, meeting summaries and the summaries they published; a live task's summaries are retained (card K06 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-lin-"));
  const { c, boot, call, project, agent, task, finish, put } = await world(d);
  try {
    const ann = await agent("ann");
    const t1 = await task("Old", "t1"); const t2 = await task("Live", "t2");
    await call(boot.token, "task.transition", { taskId: t2, expectedRevision: 1, to: "ready" }, "t2a");
    const rec = await c.services.desks.write(ann.p, { commandId: "w1", projectId: project, taskId: t1, kind: "progress", title: "Beds", body: "North bed done and the compost turned twice", visibility: "shared", status: "accepted" });
    const other = await c.services.desks.write(ann.p, { commandId: "w2", projectId: project, taskId: t1, kind: "progress", title: "Other", body: "Something else entirely", visibility: "shared", status: "accepted" });
    const mk = async (id: string, sources: string[]) => (await c.services.retrieval.summarize(ann.p, { commandId: id, projectId: project, title: id, text: id, sources: sources.map((s) => ({ kind: "desk-record" as const, id: s })) })).id;
    const sum1 = await mk("s1", [rec.id]); const sum2 = await mk("s2", [other.id]); const sum3 = await mk("s3", [other.id]);
    const base = { taskId: t1, projectId: project, key: "k", compressorId: "c", state: "done", pinned: [], title: "t", digest: "dg", startedBy: "x" };
    await put("ctx-compaction", "cmp-1", { ...base, generation: 1, lineage: [], sources: [{ kind: "desk-record", id: rec.id }], summary: "Beds done.", summaryId: sum1 });
    // Generation 2 is built on generation 1 and cites only another record; generation 3 on generation 2.
    await put("ctx-compaction", "cmp-2", { ...base, generation: 2, parent: "cmp-1", lineage: ["cmp-1"], sources: [{ kind: "desk-record", id: other.id }], summary: "Beds done, and more.", summaryId: sum2 });
    await put("ctx-compaction", "cmp-3", { ...base, generation: 3, parent: "cmp-2", lineage: ["cmp-1", "cmp-2"], sources: [{ kind: "desk-record", id: other.id }], summary: "Everything.", summaryId: sum3 });
    await put("meeting-summary", "msu-quote", { projectId: project, text: "Decided: North bed done and the compost turned twice." });
    await put("meeting-summary", "msu-other", { projectId: project, text: "Unrelated" });
    await finish(t1, "f");

    const pre = (await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked", dryRun: true }, "p")).result;
    assert.deepEqual(pre.derived.compactions.sort(), ["cmp-1", "cmp-2", "cmp-3"]);
    assert.ok(pre.derived.summaries.includes(sum1) && pre.derived.summaries.includes(sum2) && pre.derived.summaries.includes(sum3));
    assert.deepEqual(pre.derived.others, ["meeting-summary/msu-quote"]);
    const done = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "d1");
    assert.equal(done.result.status, "deleted", JSON.stringify(done));
    for (const id of ["cmp-1", "cmp-2", "cmp-3"]) assert.deepEqual([(await c.storage.getAggregate({ kind: "ctx-compaction", id }))!.body["summary"], (await c.storage.getAggregate({ kind: "ctx-compaction", id }))!.body["sourceDeleted"]], ["", true], id);
    for (const id of [sum1, sum2, sum3]) assert.equal(await c.storage.getAggregate({ kind: "summary-record", id }), undefined, id);
    assert.equal(await c.storage.getAggregate({ kind: "meeting-summary", id: "msu-quote" }), undefined);
    assert.ok(await c.storage.getAggregate({ kind: "meeting-summary", id: "msu-other" }), "an unrelated meeting summary stays");

    // A live (resumable) task's summaries are retained: by the task they name, and by the live task's desk records they were built from.
    const live = await c.services.desks.write(ann.p, { commandId: "w3", projectId: project, taskId: t2, kind: "note", title: "Live", body: "live text", visibility: "shared" });
    const built = await mk("s4", [live.id]);
    await put("summary-record", "sum-aaaaaaaaaaaaaaaaaaaa", { projectId: project, title: "w", text: "x", sources: [{ source: { kind: "desk-record", id: other.id }, digest: "d" }], createdBy: ann.p.id, taskId: t2 });
    const c1 = (await call(boot.token, "retention.check", { kind: "summary-record", id: built })).result;
    assert.equal(c1.retained, true); assert.match(c1.reasons[0], /built from records of task/);
    const c2 = (await call(boot.token, "retention.check", { kind: "summary-record", id: "sum-aaaaaaaaaaaaaaaaaaaa" })).result;
    assert.equal(c2.retained, true); assert.match(c2.reasons[0], /written by task/);
    // And a deletion of the live record is retained because of it.
    assert.equal((await call(boot.token, "retention.delete", { recordId: live.id, reason: "x" }, "d9")).result.status, "retained");
  } finally { await c.close(); clean(d); }
});

test("the same command ID after a retained answer or a crash in the middle finishes the deletion with its proper record; a big one is done in bounded requests (card K06 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-res-"));
  const { c, boot, call, project, agent, task, finish, put } = await world(d, { backup: { directory: join(d, "backups") } });
  try {
    const ann = await agent("ann");
    const t1 = await task("T", "t1");
    await call(boot.token, "task.transition", { taskId: t1, expectedRevision: 1, to: "ready" }, "t1a");
    const rec = await c.services.desks.write(ann.p, { commandId: "w1", projectId: project, taskId: t1, kind: "progress", title: "Beds", body: "North bed done", visibility: "shared", status: "accepted" });
    const mk = async (id: string) => (await c.services.retrieval.summarize(ann.p, { commandId: id, projectId: project, title: id, text: id, sources: [{ kind: "desk-record" as const, id: rec.id }] })).id;
    const sums = [await mk("a"), await mk("b"), await mk("c")];
    // Retained first, then (the task is done) the SAME command continues instead of colliding with the retained answer.
    assert.equal((await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "same")).result.status, "retained");
    await finish(t1, "f");
    // A crash in the middle: the third write of the deletion fails.
    const raw = unguarded(c.storage); const real = raw.applyOperation.bind(raw);
    let n = 0;
    raw.applyOperation = (async (input: any) => { if (String(input.audit?.[0]?.type ?? "").startsWith("retention.delete.") && ++n === 2) throw new Error("power cut"); return real(input); }) as never;
    const crashed = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "same");
    assert.equal(crashed.ok, false);
    const mid = (await c.storage.listAggregates("retention-deletion", { limit: 10 }));
    assert.deepEqual(mid.map((x) => x.body["status"]), ["in-progress"], "the first record is written before the content changes");
    raw.applyOperation = real as never;
    const resumed = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "same");
    assert.equal(resumed.result.status, "deleted", JSON.stringify(resumed));
    const after = await c.storage.listAggregates("retention-deletion", { limit: 10 });
    assert.deepEqual(after.map((x) => x.body["status"]), ["deleted"], "one record per deletion, with the final status");
    assert.equal((await c.storage.getAggregate({ kind: "desk-record", id: rec.id }))!.body["body"], "");
    for (const id of sums) assert.equal(await c.storage.getAggregate({ kind: "summary-record", id }), undefined);
    assert.equal((await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "same")).result.status, "deleted", "asking again after the end answers deleted");
    // The ledger outside the database names the deletion and holds no text.
    const ledger = readFileSync(join(d, "backups", LEDGER_FILE), "utf8");
    assert.ok(ledger.includes(rec.id) && !ledger.includes("North bed"));

    // More than one request handles: partial with remaining, then the same command finishes.
    const big = await c.services.desks.write(ann.p, { commandId: "w2", projectId: project, taskId: t1, kind: "progress", title: "Big", body: "Seed bed text of the big one", visibility: "shared", status: "accepted" });
    for (let i = 0; i < 430; i++) await put("desk-record", `dsk-${B32[i >> 5]}${B32[i & 31]}aaaaaaaaaaaaaaaaaa`, { projectId: project, taskId: t1, kind: "note", title: "copy", body: `copy ${i}`, visibility: "shared", copiedFrom: big.id, owner: ann.p.id });
    const first = await call(boot.token, "retention.delete", { recordId: big.id, reason: "owner asked" }, "big");
    assert.equal(first.result.status, "partial", JSON.stringify(first.result).slice(0, 300)); assert.ok(first.result.remaining > 0);
    const second = await call(boot.token, "retention.delete", { recordId: big.id, reason: "owner asked" }, "big");
    assert.equal(second.result.status, "deleted", JSON.stringify(second.result).slice(0, 300));
    assert.equal((await c.storage.getAggregate({ kind: "desk-record", id: big.id }))!.body["body"], "");
  } finally { await c.close(); clean(d); }
});

test("a hold that appears while the runner works is respected; an archived stub takes its archive with it (card K06 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-hold-"));
  const { c, rob, project, put } = await world(d);
  try {
    age(c, ["summary-record"]);
    const ids: string[] = [];
    for (let i = 0; i < 60; i++) { const id = `sum-${B32[i >> 5]}${B32[i & 31]}aaaaaaaaaaaaaaaaaa`; ids.push(id); await put("summary-record", id, { projectId: project, title: "s", text: "t", sources: [], createdBy: "x" }); }
    // A stub with its archive.
    await put("summary-record", "sum-zzarchivedaaaaaaaaaa", { projectId: project, title: "(archived)", text: "", sources: [], createdBy: "x", archived: { at: "t", by: "o", archiveId: "arc-sum-zzarchivedaaaaaaaaaa" } });
    await put("retention-archive", "arc-sum-zzarchivedaaaaaaaaaa", { recordId: "sum-zzarchivedaaaaaaaaaa", recordKind: "summary-record", taskId: "task-aaaaaaaaaaaaaaaaaaaa", projectId: project, original: { text: "the original text" }, originalRevision: 1, stubRevision: 2, at: "t", by: "o" });
    const settings = c.services.retentionSettings;
    await settings.set(rob, { commandId: "s1", derivedDays: 7 } as never);
    let injected = false; let target = "";
    const svc = RetentionService.withEpoch(c.storage, c.epoch, {
      settings, beforeBatch: async (n) => {
        if (n !== 1 || injected) return; injected = true;
        // A task resumes and its checkpoint cites a summary of the second batch.
        await put("task", "task-hold0aaaaaaaaaaaaaaa", { state: "ready", projectId: project, title: "resumed" });
        await put("ctx-compaction", "cmp-hold", { taskId: "task-hold0aaaaaaaaaaaaaaa", projectId: project, key: "k", compressorId: "c", state: "done", generation: 1, lineage: [], sources: [], pinned: [], title: "t", summary: "x", digest: "d", summaryId: target, startedBy: "x" });
      },
    });
    const preview = await svc.run(rob, {});
    target = preview.candidates[30]!.id;
    const done = await svc.run(rob, { dryRun: false, confirm: preview.digest! });
    assert.equal(injected, true);
    assert.ok(await c.storage.getAggregate({ kind: "summary-record", id: target }), "the summary a task started to need was not removed");
    assert.ok(done.retained.some((r) => r.id === target), JSON.stringify(done.retained));
    assert.equal(await c.storage.getAggregate({ kind: "summary-record", id: "sum-zzarchivedaaaaaaaaaa" }), undefined, "the stub is expired");
    assert.equal(await c.storage.getAggregate({ kind: "retention-archive", id: "arc-sum-zzarchivedaaaaaaaaaa" }), undefined, "and so is its archive");
  } finally { await c.close(); clean(d); }
});

test("a restore re-applies the deletion ledger; export finds artifacts by their task; passcode and pin fields are masked (card K06 review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-led-"));
  let clock = Date.now() + 5_000;
  const { c, boot, call, project, agent, task, finish, put } = await world(d, { backup: { directory: join(d, "backups"), now: () => new Date(clock) } });
  try {
    const ann = await agent("ann");
    const t1 = await task("T", "t1"); await finish(t1, "f");
    const rec = await c.services.desks.write(ann.p, { commandId: "w1", projectId: project, taskId: t1, kind: "progress", title: "Beds", body: "North bed done", visibility: "shared", status: "accepted" });
    const sum = (await c.services.retrieval.summarize(ann.p, { commandId: "sm", projectId: project, title: "S", text: "Beds.", sources: [{ kind: "desk-record", id: rec.id }] })).id;
    const made = await c.services.backups!.backUpNow("manual");
    const backupPath = join(d, "backups", (await c.services.backups!.status()).newest!.name);
    clock += 10_000;
    assert.equal((await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked" }, "d1")).result.status, "deleted");
    void made;
    // The old backup still holds the text; restoring it WITH the ledger blanks the record and drops the summary again.
    const ledger = await new DeletionLedger(join(d, "backups", LEDGER_FILE)).read();
    const plain = new MemoryStorage();
    await restoreBackup(backupPath, plain, {});
    assert.equal((await plain.getAggregate({ kind: "desk-record", id: rec.id }))!.body["body"], "North bed done", "without the ledger the old text is back");
    const store = new MemoryStorage();
    const res = await restoreBackup(backupPath, store, { deletions: ledger });
    assert.ok(res.deletionsReapplied >= 2);
    const back = (await store.getAggregate({ kind: "desk-record", id: rec.id }))!.body as any;
    assert.deepEqual([back.body, back.title, back.visibility], ["", "", "private"]);
    assert.ok(back.deleted.by);
    assert.equal(await store.getAggregate({ kind: "summary-record", id: sum }), undefined);

    // Export: an artifact that names its task and no project is found through the task.
    await put("artifact", "art-aaaaaaaaaaaaaaaaaaaa", { name: "a", taskId: t1, entries: [], manifestDigest: "m", totalBytes: 0, createdBy: "x" });
    const exp = await call(boot.token, "retention.export", { projectId: project, limit: 200 });
    assert.ok(exp.ok, JSON.stringify(exp));
    assert.ok(exp.result.items.some((i: any) => i.kind === "artifact" && i.id === "art-aaaaaaaaaaaaaaaaaaaa"));
    assert.equal((redact({ passcode: "hunter2", pin: "1234", note: "ok" }) as any).passcode === "hunter2", false);
    assert.equal((redact({ pin: "1234" }) as any).pin === "1234", false);
  } finally { await c.close(); clean(d); }
});
