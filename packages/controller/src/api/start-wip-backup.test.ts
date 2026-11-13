import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acceptedArgs, CHAT_OPS, ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import type { WipBackupCall } from "../wip-backup/index.js";
import { OPERATION_BY_NAME } from "./operations.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
type Reply = { ok: boolean; result?: any; error?: { code: string; message?: string } };

test("the work-in-progress backup is off by default, owner-only through the API, turned on in chat in free words (shown first, applied only when accepted, the remote copied from the owner's words), turned off at once, shown in the status view, and swept by the dispatcher only for a project that turned it on (card P02b)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-wipb-"));
  const say: Record<string, unknown[]> = {};
  const timer = new ManualTimer();
  const asked: WipBackupCall[] = [];
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer, intervalMs: 1000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    wipBackup: { port: { backup: async (call: WipBackupCall) => { asked.push(call); return { ok: true as const, summary: "Backed up", detail: { commitId: "c".repeat(40), tree: "d".repeat(40), files: 2, unchanged: false, blocked: [] } }; } }, tasks: async () => [{ taskId: "task-garden", developer: "agent:ann", executor: "host:one" }] },
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
    const remote = "/backups/garden.git";

    // The chat sees the two operations, with the project named `project` and no command ID for the model to pick.
    assert.equal(CHAT_OPS["wip.backup.set"]?.mode, "propose");
    assert.ok(OPERATION_BY_NAME.get("wip.backup.set") !== undefined && OPERATION_BY_NAME.get("wip.backup.get") !== undefined);
    for (const k of ["project", "enabled", "remote", "everyMinutes", "basis", "expectedRevision"]) assert.ok(acceptedArgs("wip.backup.set")!.includes(k), k);
    assert.ok(!acceptedArgs("wip.backup.set")!.includes("commandId"), "the model never picks the command ID");

    // Off by default; owner only.
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.enabled, false);
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.revision, 0);
    assert.equal((await call(ann, "wip.backup.get", { project })).error?.code, "forbidden");
    assert.equal((await call(ann, "wip.backup.set", { project, enabled: true, remote }, "a1")).error?.code, "forbidden");
    // A remote with a password in it never reaches a record.
    assert.equal((await call(O, "wip.backup.set", { project, enabled: true, remote: "https://rob:hunter2@git.example.com/wip.git" }, "bad1")).error?.code, "invalid_command");
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.revision, 0);
    // The loop is there, and with nothing turned on it asks no host.
    await c.dispatch.dispatcher.tick();
    assert.equal(asked.length, 0, "a project that never turned it on is never backed up");

    // Chat: free words, no magic phrase. Shown first; nothing is recorded until the owner accepts.
    await c.chat!.setFocus(O, { commandId: "f1", projectId: project });
    let m = 0;
    const turn = async (text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(O, { messageId: `m${m++}`, text })).outcomes; };
    const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
    const accept = async (proposed: any) => { const out = await turn("yes, go ahead and do that", [{ kind: "apply_proposal", proposalId: proposed.proposalId, evidence: "yes, go ahead and do that", basis: "owner" }]); assert.equal(out[0]!.status, "applied", JSON.stringify(out)); };
    let text = `Keep a copy of my agents' unfinished garden work on ${remote} please, every 20 minutes.`;
    let out = await turn(text, [cmd("wip.backup.set", { enabled: true, remote, everyMinutes: 20 }, text)]);
    assert.equal(out[0]!.status, "proposed", JSON.stringify(out));
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.enabled, false, "nothing is on until accepted");
    await accept(out[0]);
    const on = (await call(O, "wip.backup.get", { project })).result.item;
    assert.deepEqual([on.enabled, on.remote, on.everyMinutes, on.approval.scope.namespace], [true, remote, 20, `refs/heads/nn-wip/${project}/`]);
    // A remote the owner did not say is not taken from the model.
    text = "Back up the unfinished work somewhere safe.";
    out = await turn(text, [cmd("wip.backup.set", { enabled: true, remote: "/somewhere/else.git" }, text)]);
    assert.notEqual(out[0]!.status, "applied", JSON.stringify(out));
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.remote, remote);

    // The status view says what it rests on and has done nothing yet.
    say["Is my work in progress backed up?"] = [{ kind: "status", request: { kind: "wip_backup" }, evidence: "Is my work in progress backed up?", basis: "owner" }];
    const shown = JSON.stringify((await c.chat!.submit(O, { messageId: `m${m++}`, text: "Is my work in progress backed up?" })).outcomes[0]);
    assert.match(shown, /work-in-progress backup is on: every 20 minutes/, shown.slice(0, 500));
    assert.match(shown, new RegExp(remote.replace(/\//g, "\\/")));

    // The dispatcher's loop now backs the task up (it runs apart from the tick: wait for the condition, not a pause).
    await c.dispatch.dispatcher.tick();
    for (let i = 0; i < 400 && asked.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal(asked.length, 1);
    assert.deepEqual([asked[0]!.taskId, asked[0]!.remote, asked[0]!.ref], ["task-garden", remote, `refs/heads/nn-wip/${project}/task-garden`]);
    for (let i = 0; i < 400 && (await call(O, "wip.backup.get", { project })).result.item.tasks.length === 0; i++) await new Promise((r) => setTimeout(r, 25));
    assert.equal((await call(O, "wip.backup.get", { project })).result.item.tasks[0].lastSuccess.commitId, "c".repeat(40));

    // Turning it off applies at once (the safe direction) and revokes the approval; nothing more is asked of a host.
    text = "Stop backing up the unfinished work.";
    out = await turn(text, [cmd("wip.backup.set", { enabled: false }, text)]);
    assert.equal(out[0]!.status, "applied", JSON.stringify(out));
    const off = (await call(O, "wip.backup.get", { project })).result.item;
    assert.equal(off.enabled, false);
    assert.ok(off.approval.revokedAt !== undefined);
    const before = asked.length;
    await c.dispatch.dispatcher.tick();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(asked.length, before);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true }); }
});
