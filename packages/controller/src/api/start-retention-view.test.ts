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

test("the owner's chat view of retention, from a running controller: the disk and the reserve, the quotas and their use, the backups and the latest one, what retention deleted lately; owner only, counts and IDs only, and the same answer as retention.status (card K06d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-ret-view-"));
  let clock = Date.now() + 5_000;
  const { c, boot, call, project, agent, task, finish } = await world(d, { backup: { directory: join(d, "backups"), now: () => new Date(clock) }, retention: { defaults: { reserveBytes: 1_048_576 } } });
  try {
    const ann = await agent("ann");
    const ask = async (token = boot.token): Promise<{ lines: { text: string; cites: { kind: string; id: string }[] }[] } | undefined> => (await call(token, "status.ask", { request: { kind: "retention" } })).result?.item;
    const told = (await ask())!.lines;
    assert.ok(told.every((l) => l.cites.length > 0), "every line cites a record");
    const text0 = told.map((l) => l.text).join("\n");
    assert.match(text0, /^Retention values in force/);
    assert.match(text0, /The data disk has .* free of /);
    assert.match(text0, /1\.0 MiB is set aside as the reserve/);
    assert.match(text0, /No storage quota is set for projects or agents\./);
    assert.match(text0, /No backups are set up|0 backups are kept|No backup has been made yet/);
    assert.match(text0, /No record has been deleted by request yet\./);
    assert.match(text0, /Retention has not run yet\./);

    // A quota, some stored text, a backup, a deletion request and a run.
    const t1 = await task("Weed", "t1");
    await call(boot.token, "task.transition", { taskId: t1, expectedRevision: 1, to: "ready" }, "t1a");
    const rec = await c.services.desks.write(ann.p, { commandId: "w1", projectId: project, taskId: t1, kind: "progress", title: "Beds", body: "North bed done, password hunter2-secret-text", visibility: "shared", status: "accepted" });
    assert.ok((await call(boot.token, "retention.settings.set", { quotaProjectBytes: 10_240, quotaAgentBytes: 1_024, quotaWarnPercent: 50 }, "q1")).ok);
    clock = Math.max(clock, Date.now() + 1_000);
    await c.services.backups!.backUpNow("manual");
    const firstBackup = (await call(boot.token, "retention.status", {})).result.item.backups.latest;
    await finish(t1, "f");
    const del = await call(boot.token, "retention.delete", { recordId: rec.id, reason: "owner asked: the reason words" }, "d1");
    assert.equal(del.result.status, "deleted");
    const preview = await call(boot.token, "retention.run", { dryRun: true }, "r0");
    assert.ok((await call(boot.token, "retention.run", { dryRun: false, confirm: preview.result.digest }, "r1")).ok);

    // A second, later backup: the view names the newest one, not the first it finds.
    clock += 2 * 86_400_000;
    await c.services.backups!.backUpNow("manual");
    const rawStatus = (await call(boot.token, "retention.status", {})).result.item;
    assert.notEqual(rawStatus.backups.latest.name, firstBackup.name);
    assert.ok(rawStatus.backups.latest.at > firstBackup.at, "the latest is the later one");
    const lines = (await ask())!.lines;
    const text = lines.map((l) => l.text).join("\n");
    assert.match(text, /Project quota: 10\.0 KiB each \(warning at 50%\); 1 project holds /);
    assert.match(text, /Agent quota: 1\.0 KiB each \(warning at 50%\); /);
    assert.match(text, /2 backups are kept; the rules keep 7 daily and \d+ weekly\./);
    assert.ok(text.includes(`The latest backup is ${rawStatus.backups.latest.name}, made ${rawStatus.backups.latest.at}.`), text);
    assert.ok(text.includes(`Deletion ${rawStatus.deletions[0].id} of record ${rec.id}: deleted`), text);
    assert.ok(text.includes(`Retention run ${rawStatus.runs[0].id} (by you)`), text);
    assert.equal(rawStatus.runs.length, 1);
    assert.ok(lines.some((l) => l.cites.some((x) => x.kind === "retention-deletion" && x.id === rawStatus.deletions[0].id)));
    assert.ok(lines.some((l) => l.cites.some((x) => x.kind === "retention-run" && x.id === rawStatus.runs[0].id)));
    assert.ok(lines.some((l) => l.cites.some((x) => x.kind === "backup" && x.id === rawStatus.backups.latest.name)));
    // Counts and IDs only: neither the text that was deleted nor the reason typed for it is in the answer.
    assert.ok(!/hunter2|the reason words|North bed/.test(text), "no stored text and no typed reason");
    // The quota lines match what retention.status counts.
    for (const q of rawStatus.quotas) assert.ok(text.includes(`${q.percent}% of its storage quota`), JSON.stringify(q));
    // The view writes nothing.
    const before = (await audits(c)).length;
    await ask(); await ask();
    assert.equal((await audits(c)).length, before);
    // Only the owner: an agent is not told, and gets none of the figures.
    const other = await call(ann.token, "status.ask", { request: { kind: "retention" } });
    assert.ok(!JSON.stringify(other).includes("The data disk"), JSON.stringify(other));
    assert.equal((await call(ann.token, "retention.status", {})).error?.code, "forbidden");
  } finally { await c.close(); clean(d); }
});
