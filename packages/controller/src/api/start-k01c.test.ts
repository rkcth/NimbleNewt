import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

/** Waits for a condition, not for a time. */
async function until(what: string, ok: () => boolean | Promise<boolean>): Promise<void> {
  for (let i = 0; i < 400; i++) { if (await ok()) return; await new Promise((r) => setTimeout(r, 25)); }
  assert.fail(`never became true: ${what}`);
}
const names = (dir: string): string[] => (existsSync(dir) ? readdirSync(dir).filter((n) => n.startsWith("backup-") && !n.endsWith(".partial")).sort() : []);

test("the owner configures the backup system through the state API: targets, schedule, age limit with the override said back, purge on every target, test restore; everything is owner only (card K01c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k01c-api-"));
  let clock = Date.parse("2026-11-01T10:00:00.000Z");
  try {
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], backup: { directory: join(d, "backups"), now: () => new Date(clock) } });
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
      await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "task.read", project }] });
      const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
      for (const [op, args] of [["backup.config.status", {}], ["backup.config.set", { everyHours: 6 }], ["backup.target.add", { name: "A", kind: "folder", location: join(d, "a") }], ["backup.target.test", { id: "A" }], ["backup.target.remove", { id: "A" }], ["backup.purge", { names: ["backup-20261101T100000Z-manual"] }], ["backup.verify.run", {}]] as const) {
        assert.equal((await call(zed, op, args as never, op === "backup.config.status" ? undefined : "z1")).error.code, "forbidden", `${op} is owner only`);
      }
      const status = (await call(boot.token, "backup.config.status", {})).result.item;
      assert.deepEqual([status.schedule.everyHours, status.schedule.verifyEveryDays, status.targets.length, status.rules.maxAgeDays, status.rules.overrides], [24, 7, 0, 35, "counts"], JSON.stringify(status));
      // A target on another disk (a second folder here), tested at once and copied to.
      const added = await call(boot.token, "backup.target.add", { name: "Spare disk", kind: "disk", location: join(d, "spare") }, "t1");
      assert.ok(added.ok, JSON.stringify(added));
      assert.equal((await call(boot.token, "backup.target.add", { name: "Bad", kind: "offsite", location: "http://backup.example.com/" }, "t2")).error.code, "invalid_command");
      assert.equal((await call(boot.token, "backup.target.test", { id: "Spare disk" }, "tt1")).result.ok, true);
      const first = await call(boot.token, "backup.now", {}, "b1");
      await until("the first backup reaches the spare disk", () => names(join(d, "spare")).includes(first.result.item.name));
      // The schedule: said back in plain words, and followed.
      const sched = await call(boot.token, "backup.config.set", { everyHours: 6, hourUtc: null, verifyEveryDays: 30 }, "s1");
      assert.ok(sched.ok, JSON.stringify(sched));
      assert.match(sched.result.text, /every 6 hours.*every 30 days/s);
      clock += 7 * 3_600_000;
      // The age limit: shorter than the counts keep, so it decides and the answer says so.
      const age = await call(boot.token, "retention.settings.set", { backupMaxAgeDays: 20 }, "r1");
      assert.ok(age.ok, JSON.stringify(age));
      assert.match(age.result.summary, /age limit \(20 days\) is shorter/);
      const counts = await call(boot.token, "retention.settings.set", { backupDaily: 3, backupWeekly: 2, backupMaxAgeDays: "default" }, "r2");
      assert.match(counts.result.summary, /counts let a backup go after about 20 days|counts and the age limit agree|counts decide/);
      // A deletion's confirmation says how long it stays, by target.
      await call(boot.token, "backup.target.add", { name: "Short", kind: "folder", location: join(d, "short"), keepDays: 5 }, "t3");
      clock += 86_400_000;
      const second = await call(boot.token, "backup.now", {}, "b2");
      assert.ok(second.ok);
      await until("both backups reach the short-lived target", () => names(join(d, "short")).length >= 1);
      // Purge the first backup on every target.
      const preview = await call(boot.token, "backup.purge", { names: [first.result.item.name], dryRun: true }, "pg0");
      assert.equal(preview.result?.status, "preview", JSON.stringify(preview));
      assert.ok(names(join(d, "backups")).includes(first.result.item.name));
      const purged = await call(boot.token, "backup.purge", { names: [first.result.item.name] }, "pg1");
      assert.ok(purged.ok, JSON.stringify(purged));
      assert.equal(purged.result.status, "purged");
      assert.ok(!names(join(d, "backups")).includes(first.result.item.name) && !names(join(d, "spare")).includes(first.result.item.name));
      // The test restore proves the remaining copy.
      const proof = await call(boot.token, "backup.verify.run", { target: "Spare disk" }, "v1");
      assert.ok(proof.ok, JSON.stringify(proof));
      assert.deepEqual([proof.result.ok, proof.result.method], [true, "restore"]);
      // Removing a target keeps its copies.
      const removed = await call(boot.token, "backup.target.remove", { id: "Spare disk" }, "rm1");
      assert.match(removed.result.text, /not deleted/);
      assert.ok(names(join(d, "spare")).length >= 1);
      const after = (await call(boot.token, "backup.config.status", {})).result.item;
      assert.deepEqual(after.targets.map((t: { name: string }) => t.name), ["Short"]);
      assert.equal(after.targets[0].staysUpToDays, 5);
      await c.services.backups!.finish();
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner adds a backup target by free wording through the chat interpreter: it is described to the model, shown first, applies only on agreement; a password in the address is refused before any proposal holds it (card K01c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-k01c-chat-"));
  const place = join(d, "usb-stick");
  let secretTry = false;
  // The stand-in for the model acts only if the system prompt describes the operation and its arguments the way the chat accepts them.
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    if (/^Yes/.test(owner)) {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):\n<<<\n([\s\S]*?)\n>>>/g)];
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
    }
    const described = /backup\.target\.add\(([^)]*)\) - /.exec(r.system);
    if (described === null || !/backup\.target\.add with kind folder, disk or offsite/.test(r.system) || !/backup\.purge/.test(r.system) || !/backup\.config\.status/.test(r.system)) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    const have = described[1]!.split(", ").map((x) => x.replace("?", ""));
    if (!["name", "kind", "location"].every((n) => have.includes(n))) return JSON.stringify([{ kind: "none", reason: "arguments missing" }]);
    if (/hunter2/.test(owner)) { secretTry = true; return JSON.stringify([{ kind: "command", op: "backup.target.add", args: { name: "Cloud", kind: "offsite", location: "https://rob:hunter2@backup.example.com/store" }, evidence: owner, basis: "owner" }]); }
    return JSON.stringify([{ kind: "command", op: "backup.target.add", args: { name: "USB stick", kind: "disk", location: place }, evidence: owner, basis: "owner" }]);
  } };
  try {
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) }, backup: { directory: join(d, "backups") } } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      let m = 0;
      const turn = async (text: string) => (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as any[];
      const shown = await turn(`Please also keep a copy of my backups on the usb stick at ${place}.`);
      assert.equal(shown[0].status, "proposed", JSON.stringify(shown));
      assert.deepEqual((await c.services.backups!.list()).length, 0);
      assert.equal(existsSync(place), false, "nothing was changed before the owner agreed");
      const done = await turn("Yes, do that.");
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
      assert.deepEqual((await call("backup.config.status", {})).result.item.targets.map((t: { name: string }) => t.name), ["USB stick"]);
      const made = await call("backup.now", {}, "b1");
      await until("the copy reaches the target", () => names(place).includes(made.result.item.name));
      // The owner types a password into the wording: the address is refused before any proposal holds it.
      await assert.rejects(turn("Also copy them to Cloud at https://rob:hunter2@backup.example.com/store please."), /looks like a credential or key; it was not read, sent to any model or recorded/);
      assert.equal(secretTry, false, "the model never saw it");
      await c.services.backups!.finish();
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

