import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const NOW = Date.parse("2026-11-15T12:00:00.000Z");
const DAY = 86_400_000;
const ago = (days: number): string => new Date(NOW - days * DAY).toISOString();

// Card K01d through the running controller: the owner sets the backup scope by free wording (the model stand-in acts only if the prompt describes the operation and its arguments), it is shown first and
// recorded, a backup made under it says what it left out in its list entry, its restore preview and in `backup.config.status`, an agent is refused, and the live records are untouched.
test("the owner sets the backup scope by free wording; backups say what they left out, the restore preview warns, an agent is refused and the live data stays (card K01d)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k01d-api-"));
  let clock = NOW;
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    if (/^Yes/.test(owner)) {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/g)];
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
    }
    const described = /backup\.scope\.set\(([^)]*)\) - /.exec(r.system);
    if (described === null || !/use backup\.scope\.set with scratchDays/.test(r.system)) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    const names = described[1]!.split(", ").map((n) => n.replace("?", ""));
    if (!["scratchDays", "transcriptDays", "logDays"].every((n) => names.includes(n))) return JSON.stringify([{ kind: "none", reason: "an argument is missing from the description" }]);
    return JSON.stringify([{ kind: "command", op: "backup.scope.set", args: { scratchDays: 60, logDays: 30 }, evidence: owner, basis: "owner" }]);
  } };
  try {
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) }, backup: { directory: join(d, "backups"), now: () => new Date(clock) } } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
      const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
      const epoch = await c.storage.currentEpoch();
      let n = 0;
      const put = async (kind: string, id: string, body: object, daysAgo: number) => { await c.storage.applyOperation({ operationId: `k01d-${++n}`, epoch, actor: "owner:rob", correlationId: `k-${n}`, at: ago(daysAgo), changes: [{ type: "create", ref: { kind, id }, body: body as never }], audit: [{ type: `${kind}.created`, subject: { kind, id }, detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never); };
      await put("task", "t-done", { state: "done", projectId: "p-1" }, 150);
      await put("desk-record", "s-old", { visibility: "private", title: "t", body: "scratch", taskId: "t-done", projectId: "p-1" }, 100);
      await put("notification-delivery", "nd-old", { state: "delivered", text: "x", subject: { kind: "item", id: "i" }, channel: "mail", attempts: 1 }, 100);

      // Off by default.
      const status0 = await call(boot.token, "backup.config.status", {});
      assert.equal(status0.result.item.scope.scratchDays, null);
      assert.match(status0.result.item.scope.text, /OFF/);
      const whole = await call(boot.token, "backup.now", {}, "b0");
      assert.equal(whole.result.item.notFullCopy, undefined, "no scope, a whole backup, no statement");
      const plain = await call(boot.token, "backup.restore.preview", { name: whole.result.item.name });
      assert.ok(plain.ok, JSON.stringify(plain));
      assert.equal(plain.result.item.leftOutByScope, undefined);
      assert.ok(!plain.result.item.warnings.some((w: string) => /NOT A FULL COPY/.test(w)));


      // An agent may neither read nor change it, with any grant.
      assert.equal((await call(zed, "backup.scope.set", { scratchDays: 30 }, "z1")).error.code, "forbidden");
      assert.equal((await call(boot.token, "backup.scope.set", { scratchDays: 2 }, "bad")).error.code, "invalid_command");

      // Free wording: shown first, nothing changes until the owner agrees.
      const asked = (await c.chat!.submit(boot.token, { messageId: "m1", text: "I would rather my backups did not carry old scratch output or the message log, drop them after a couple of months." })).outcomes as any[];
      assert.equal(asked[0].status, "proposed", JSON.stringify(asked));
      assert.equal((await call(boot.token, "backup.config.status", {})).result.item.scope.scratchDays, null, "nothing changed before the owner agreed");
      const done = (await c.chat!.submit(boot.token, { messageId: "m2", text: "Yes, do that." })).outcomes as any[];
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      const status = await call(boot.token, "backup.config.status", {});
      assert.deepEqual([status.result.item.scope.scratchDays, status.result.item.scope.transcriptDays, status.result.item.scope.logDays], [60, null, 30]);
      assert.equal(status.result.item.scope.changedBy, "owner:rob");
      // Recorded: the audit log names the change and who made it.
      const audit: { type: string; actor: string }[] = [];
      for (let afterSeq = 0; ;) { const page = await c.storage.listAudit({ afterSeq, limit: 200 }); if (page.length === 0) break; audit.push(...(page as never[])); afterSeq = page[page.length - 1]!.seq; }
      assert.deepEqual(audit.filter((a) => a.type === "backup.scope.set").map((a) => a.actor), [rob.id]);

      // A backup made under the scope says what it left out, and the live records are untouched.
      clock += 60_000;
      const scoped = await call(boot.token, "backup.now", {}, "b1");
      assert.ok(scoped.ok, JSON.stringify(scoped));
      assert.equal(scoped.result.item.recordsLeftOut, 2);
      assert.match(scoped.result.item.notFullCopy, /NOT a full copy/);
      const listed = (await call(boot.token, "backup.list", {})).result.items.find((i: any) => i.name === scoped.result.item.name);
      assert.equal(listed.recordsLeftOut, 2);
      assert.equal((await c.storage.getAggregate({ kind: "desk-record", id: "s-old" }))?.body["body"], "scratch");
      assert.ok(await c.storage.getAggregate({ kind: "notification-delivery", id: "nd-old" }));
      // The restore preview warns that it is not a full copy; the whole one does not.
      const preview = await call(boot.token, "backup.restore.preview", { name: scoped.result.item.name });
      assert.ok(preview.ok, JSON.stringify(preview));
      assert.ok(preview.result.item.warnings.some((w: string) => /NOT A FULL COPY/.test(w)), JSON.stringify(preview.result.item.warnings));
      assert.equal(preview.result.item.leftOutByScope.leftOut.length, 2);
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
