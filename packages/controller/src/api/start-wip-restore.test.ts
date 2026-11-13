import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHAT_OPS, ScriptedInterpreter, acceptedArgs } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { WipBackupCall, WipRestoreCall } from "../wip-backup/index.js";
import { OPERATION_BY_NAME } from "./operations.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };
const COMMIT = "c".repeat(40);
let taskName = "task-unset";

test("the owner restores a task's work in progress through the API and in free words (shown first, applied only when accepted), the push credential is a secret NAME set the same way, and the standing approval is a grant the owner can see and revoke", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wipr-"));
  const say: Record<string, unknown[]> = {};
  const timer = new ManualTimer();
  const restores: WipRestoreCall[] = [];
  const backups: WipBackupCall[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer, intervalMs: 1000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    wipBackup: {
      port: {
        backup: async (call: WipBackupCall) => { backups.push(call); return { ok: true as const, summary: "Backed up", detail: { commitId: COMMIT, tree: "d".repeat(40), files: 2, unchanged: false, blocked: [] } }; },
        restore: async (call: WipRestoreCall) => { restores.push(call); return { ok: true as const, summary: "Restored 2 file(s)", detail: { where: "as the task's own checkout on this host", commitId: COMMIT, files: 2, baseFound: true } }; },
      },
      tasks: async () => [{ taskId: taskName, developer: "agent:ann", executor: "host:local" }],
    },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string): Promise<Reply> => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as never;
    const O = boot.token;
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: rob.id, projectId: project, title: "Dig the garden" })).id;
    taskName = task;
    const remote = "https://git.example.com/me/garden-wip.git";

    assert.equal(CHAT_OPS["wip.backup.restore"]?.mode, "propose");
    assert.ok(OPERATION_BY_NAME.get("wip.backup.restore") !== undefined);
    for (const k of ["project", "taskId"]) assert.ok(acceptedArgs("wip.backup.restore")!.includes(k), k);
    assert.ok(acceptedArgs("wip.backup.set")!.includes("credential"));
    assert.ok(!acceptedArgs("wip.backup.restore")!.includes("commandId"));

    // Nothing to restore before a backup was confirmed; only the owner may ask.
    assert.equal((await call(O, "wip.backup.restore", { project, taskId: task }, "r0")).error?.code, "not_found");
    assert.equal((await call(ann, "wip.backup.restore", { project, taskId: task }, "r0a")).error?.code, "forbidden");

    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    let m = 0;
    const turn = async (text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(O, { messageId: `m${m++}`, text })).outcomes; };
    const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
    const accept = async (proposed: any) => { const out = await turn("yes, go ahead and do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "yes, go ahead and do that", basis: "owner" }]); assert.equal(out[0]!.status, "applied", JSON.stringify(out)); };

    // The owner names the secret in free words; only the NAME is kept, shown first, and a pasted token is refused.
    let text = `Keep a copy of the unfinished garden work on ${remote} and sign in with the secret named garden-token.`;
    let out = await turn(text, [cmd("wip.backup.set", { enabled: true, remote, credential: "garden-token" }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.enabled, false, "nothing is on until accepted");
    await accept(out[0]);
    let item = (await call(O, "wip.backup.get", { project })).result.item;
    assert.deepEqual([item.enabled, item.remote, item.credential, item.approvalHeld], [true, remote, "garden-token", true]);
    const planted = ["gh", "p_", "Zq8wEr5t".repeat(5)].join("");
    assert.equal((await call(O, "wip.backup.set", { project, credential: planted }, "bad-cred")).error?.code, "invalid_command");
    assert.ok(!JSON.stringify((await call(O, "wip.backup.get", { project })).result.item).includes(planted));

    // The approval is a standing grant among the owner's rules, and the status view says so.
    const grantId = item.approval.grantId as string;
    const listed = (await call(O, "grant.list", { grantee: "service:dispatcher" })).result.items.find((g: { id: string }) => g.id === grantId);
    assert.deepEqual([listed.source, listed.action, listed.state], ["standing", "recovery.wip-backup", "active"]);
    say["Is my work in progress backed up?"] = [{ kind: "status", request: { kind: "wip_backup" }, evidence: "Is my work in progress backed up?", basis: "owner" }];
    const shown = JSON.stringify((await c.chat!.submit(O, { messageId: `m${m++}`, text: "Is my work in progress backed up?" })).outcomes[0]);
    assert.match(shown, /the standing rule grt-/);
    assert.match(shown, /secret named garden-token/);

    // One backup is confirmed through the dispatcher's loop (waited for, not slept on); the host got the secret's NAME.
    await c.dispatch.dispatcher.tick();
    for (let i = 0; i < 2400 && (await call(O, "wip.backup.get", { project })).result.item.tasks.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(backups[0]?.credential, "garden-token");

    // A restore in free words is shown first; accepting it asks the host for exactly the confirmed commit.
    text = "My disk died; put the garden task's unfinished work back from the backup.";
    out = await turn(text, [cmd("wip.backup.restore", { taskId: task }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.equal(restores.length, 0, "nothing is restored until the owner accepts");
    await accept(out[0]);
    assert.equal(restores.length, 1);
    assert.deepEqual(restores[0], { projectId: project, taskId: task, remote, ref: `refs/heads/nn-wip/${project}/${task}`, expectCommit: COMMIT, credential: "garden-token" });
    // The same command through the API says where it went, and a second ask with the same ID restores nothing more.
    const r1 = await call(O, "wip.backup.restore", { project, taskId: task }, "restore-api");
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.deepEqual([r1.result.restored, r1.result.where, r1.result.commitId, r1.result.replayed], [true, "as the task's own checkout on this host", COMMIT, false]);
    assert.equal((await call(O, "wip.backup.restore", { project, taskId: task }, "restore-api")).result.replayed, true);
    assert.equal(restores.length, 2);
    // The wrong project for a task, or a name that is not a task, restores nothing.
    assert.equal((await call(O, "wip.backup.restore", { project, taskId: "../etc" }, "r-bad")).error?.code, "invalid_command");
    assert.equal(restores.length, 2);

    // Turning it off revokes the grant (it shows revoked in the list); the backup on the remote can still be read back.
    text = "Stop backing up the unfinished work.";
    out = await turn(text, [cmd("wip.backup.set", { enabled: false }, text)]);
    assert.equal(out[0]!.status, "applied", JSON.stringify(out));
    assert.equal((await call(O, "grant.get", { grantId })).result.item.state, "revoked");
    assert.equal((await call(O, "wip.backup.restore", { project, taskId: task }, "restore-after-off")).ok, true);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
