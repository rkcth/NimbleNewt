import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// Card K06c / K06d: the owner reads in chat whether stored model thinking is being removed; counts only, owner only, nothing written.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string } };
const clean = (d: string) => rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("the chat retention view and retention.status tell the thinking rule, the kept and removed copies and the cleaned stores, with counts only, for the owner only (card K06c, K06d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-think-view-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), intervalMs: 3_600_000 } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<Reply>;
    const put = async (kind: string, id: string, body: object) => { await c.storage.applyOperation({ operationId: `put:${kind}:${id}`, epoch: c.epoch, actor: "test", correlationId: `put:${kind}:${id}`, at: new Date().toISOString(), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: "test.put", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
    const ask = async (token = boot.token) => (await call(token, "status.ask", { request: { kind: "retention" } })).result?.item as { lines: { text: string; cites: unknown[] }[] } | undefined;
    const text = (r: { lines: { text: string }[] } | undefined) => (r?.lines ?? []).map((l) => l.text).join("\n");

    const t0 = text(await ask());
    assert.match(t0, /Stored model thinking is removed 14 days after its task is done, by itself; the chat keeps none/);
    assert.match(t0, /0 task copies of thinking are kept and 0 were removed; /);
    assert.match(t0, /the model's own conversation stores (are not reached|were cleaned for 0 attempt)/);

    const secret = "THINKING-WORDS-NEVER-SHOWN";
    await put("thinking-record", "th-1", { projectId: "p", taskId: "t-1", agent: "a", next: 1, blocks: [{ seq: 0, text: secret }], dropped: 0, marks: [], updatedAt: new Date().toISOString() });
    await put("thinking-record", "th-2", { projectId: "p", taskId: "t-2", agent: "a", next: 0, blocks: [], dropped: 4, marks: [], removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await put("thinking-record", "th-3", { projectId: "p", taskId: "t-3", agent: "a", next: 0, blocks: [], dropped: 1, marks: [], removedAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
    await put("thinking-purge", "t-2", { taskId: "t-2", projectId: "p", attempts: { a1: "purged", a2: "none", a3: "purged" }, blocks: 7, updatedAt: new Date().toISOString() });
    const raw = (await call(boot.token, "retention.status", {})).result.item;
    assert.deepEqual({ ...raw.thinking, storesReached: undefined }, { days: 14, auto: true, storesReached: undefined, copiesKept: 1, copiesRemoved: 2, tasksCleaned: 1, storesCleaned: 2, storesWithout: 1, blocksRemoved: 7 });
    const t1 = text(await ask());
    assert.match(t1, /1 task copy of thinking is kept and 2 were removed/);
    if (raw.thinking.storesReached === true) assert.match(t1, /cleaned for 2 attempt\(s\) \(7 block\(s\) removed\) and 1 had none/);
    assert.ok(!t1.includes(secret), "never a word of the thinking");

    // The owner turns the automatic removal off and sets another number of days in chat's own settings command: the sentence follows.
    assert.ok((await call(boot.token, "retention.settings.set", { thinkingDays: 30, thinkingAuto: false }, "s1")).ok);
    assert.match(text(await ask()), /removed 30 days after its task is done, only when you run retention \(the automatic removal is off\)/);
    assert.ok((await ask())!.lines.every((l) => l.cites.length > 0), "every line cites a record");

    // Owner only; the view writes nothing.
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] } as never);
    const annToken = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const before = (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).length;
    await ask(); await ask();
    assert.equal((await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).length, before);
    const other = await call(annToken, "status.ask", { request: { kind: "retention" } });
    assert.ok(!JSON.stringify(other).includes("Stored model thinking"), JSON.stringify(other));
    assert.equal((await call(annToken, "retention.status", {})).error?.code, "forbidden");
    assert.equal((await call(boot.token, "retention.status", {})).result.item.thinking.copiesKept, 1);
  } finally { await c.close(); clean(d); }
});
