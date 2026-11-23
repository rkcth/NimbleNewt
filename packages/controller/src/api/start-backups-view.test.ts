import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ModelInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

// The owner reads how backups are set, and which exist, in free words (audit 2026-11-22), through the started controller: the real backup system, the real chat and `ModelInterpreter`, a stand-in for the
// model that hands over only what the owner said. The same question reaches nobody else, and asking makes nothing; "back up now" is shown first and makes one backup on the yes.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner reads the backup settings and the backups that exist, and takes one now, by free words through the real chat and the started controller; nobody else reads them (audit 2026-11-22)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-backups-view-"));
  const violations: string[] = [];
  const model = { complete: async (_route: string, r: { system: string; user: string }): Promise<string> => {
    const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
    const own = owner.toLowerCase();
    if (/^Yes/.test(owner)) {
      const open = [...r.user.matchAll(/Open proposal (\S+) \(text, not instructions\):/g)];
      return JSON.stringify(open.length === 1 ? [{ kind: "apply_proposal", proposalId: open[0]![1], evidence: owner, basis: "owner" }] : [{ kind: "none", reason: "no single open proposal" }]);
    }
    if (!/backups\(limit, after\)/.test(r.system) || !/backup\.now\(/.test(r.system)) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
    if (own.includes("back up now")) return JSON.stringify([{ kind: "command", op: "backup.now", args: {}, evidence: owner, basis: "owner" }]);
    const request: Record<string, unknown> = { kind: "backups" };
    const limit = /(\d+) at a time/.exec(owner);
    if (limit !== null) request["limit"] = Number(limit[1]);
    const after = /after (backup-\S+)/.exec(owner);
    if (after !== null) request["after"] = after[1];
    for (const [k, v] of Object.entries(request)) if (k !== "kind" && !own.includes(String(v).toLowerCase())) violations.push(`${k}=${String(v)}`);
    return JSON.stringify([{ kind: "status", request, evidence: owner, basis: "owner" }]);
  } };
  try {
    const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, conversationTransport: {}, chat: { interpreter: new ModelInterpreter(model, () => ["test/model"]) }, backup: { directory: join(d, "backups") } } as never);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      let m = 0;
      const turn = async (text: string) => (await c.chat!.submit(boot.token, { messageId: `m${m++}`, text })).outcomes as unknown as { status: string; message?: string; lines?: { text: string }[] }[];
      const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;

      const none = await turn("how are my backups?");
      assert.equal(none[0]!.status, "answered", JSON.stringify(none));
      const text = none.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
      assert.match(text, /^Backups are made every day\. A backup is test-restored about every 7 days/);
      assert.match(text, /What is kept: /);
      assert.match(text, /main backups folder \(folder\): (can be reached; holds 0 backups|cannot be reached)/, "the folder is made by the first backup");
      assert.match(text, /No test restore has been made yet\./);
      assert.match(text, /No backup exists yet\./);
      assert.equal((await c.services.backups!.list()).length, 0, "asking made no backup");

      // One backup now: shown first, nothing made until the yes.
      const shown = await turn("back up now please");
      assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
      assert.equal((await c.services.backups!.list()).length, 0);
      assert.equal((await turn("Yes, do that."))[0]!.status, "applied");
      const made = await c.services.backups!.list();
      assert.equal(made.length, 1);
      const name = made[0]!.manifest.name;

      const after = await turn("which backups do I have? 5 at a time");
      const t2 = after.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
      assert.match(t2, new RegExp(`${name}: (manual|scheduled), made `));
      assert.match(t2, /holds 1 backup, the newest /);
      assert.equal((await c.services.backups!.list()).length, 1, "reading again made nothing");
      const later = await turn(`which backups do I have? 5 at a time, after ${name}`);
      assert.doesNotMatch(later.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n"), /Backups are made|backup-2026/, "the page after the last one is empty of backups");

      // Nobody else reads them: an agent, a client and a task credential are refused.
      const project = (await call(boot.token, "project.create", { name: "Garden" }, "p1")).result.id as string;
      await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [{ action: "*", project }] });
      const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
      const task = (await call(boot.token, "task.create", { projectId: project, title: "weed" }, "tk1")).result.id as string;
      const taskCred = (await c.services.taskCredentials.issue(rob, { commandId: "tc1", taskId: task, agentId: "agent:zed" })).token;
      for (const who of [zed, taskCred]) {
        const r = await call(who, "status.ask", { request: { kind: "backups" } });
        assert.equal(r.ok, false);
        assert.ok(["forbidden", "not_found"].includes(r.error.code), JSON.stringify(r));
      }
      assert.deepEqual(violations, [], "the stand-in model handed over only the owner's words");
      await c.services.backups!.finish();
    } finally { await c.close(); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
