import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SqliteStorage } from "../storage/index.js";
import { readAuthority, sqliteTarget } from "../transfer/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

test("the owner moves the controller database from the running controller: preview, approve, barrier, a start on the old database is refused, a start on the new one works (card F04e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfs-"));
  const oldPath = join(d, "c.sqlite"), newPath = join(d, "moved.sqlite");
  const open = async (path: string, withTarget: boolean) => startController({ storage: { kind: "sqlite", path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() },
    ...(withTarget ? { transfer: { targets: [await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })] } } : {}) } as never);
  let c = await open(oldPath, true);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await call(boot.token, "project.create", { name: "Garden" }, "p1");
    await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
    const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
    assert.equal((await call(zed, "database.transfer.status", {})).error.code, "forbidden");
    assert.equal((await call(zed, "database.transfer.preview", { target: "moved" })).error.code, "forbidden");
    assert.equal((await call(zed, "database.transfer.apply", { target: "moved", confirm: "x" }, "t0")).error.code, "forbidden");
    assert.equal((await call(zed, "database.transfer.rollback", {}, "t00")).error.code, "forbidden");

    const status = await call(boot.token, "database.transfer.status", {});
    assert.deepEqual(status.result.item.targets, [{ name: "moved", kind: "sqlite", direction: "sqlite to sqlite" }]);
    const preview = await call(boot.token, "database.transfer.preview", { target: "moved" });
    assert.ok(preview.ok, JSON.stringify(preview));
    assert.equal(preview.result.item.ok, true, JSON.stringify(preview.result.item.findings));
    assert.equal((await call(boot.token, "database.transfer.apply", { target: "moved", confirm: "wrong" }, "t1")).error.code, "invalid_command");
    const applied = await call(boot.token, "database.transfer.apply", { target: "moved", confirm: preview.result.item.token }, "t2");
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.result.item.restartRequired, true);
    // Commands are refused while the barrier is up; the owner can still read the status and roll back.
    const refused = await call(boot.token, "project.create", { name: "Blocked" }, "p2");
    assert.equal(refused.error.code, "unavailable"); assert.match(refused.error.message, /maintenance/);
    assert.equal((await call(boot.token, "database.transfer.status", {})).result.item.authority.active.name, "moved");
    await c.close();
    // The old configuration is refused, loudly and before anything is opened; the new one starts with the data.
    await assert.rejects(open(oldPath, false), /moved to moved .* Point controller\.storage at moved/);
    c = await open(newPath, false);
    const listed = JSON.stringify(await call(boot.token, "project.list", {}));
    assert.ok(listed.includes("Garden"));
    assert.equal((await call(boot.token, "project.create", { name: "After" }, "p3")).ok, true);
    // Now that the new database has recorded work, the transfer cannot be rolled back (the controller there has no target to check against, and says so).
    assert.equal((await call(boot.token, "database.transfer.rollback", {}, "t3")).error.code, "unavailable");
    assert.equal((await readAuthority(d))?.generation, 1);
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("without a configured target the transfer commands say so, and the start-time guard does nothing (card F04e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfn-"));
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const r = (await c.api.handle(boot.token, { v: 1, op: "database.transfer.status", args: {} } as never)) as any;
    assert.equal(r.error.code, "unavailable"); assert.match(r.error.message, /not configured/);
    assert.equal(existsSync(join(d, "storage-authority.json")), false);
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the chat proposes a database move with the plan the controller works out; the token comes from the record, never the interpreter; nothing is moved by the proposal; a plan that cannot go ahead is refused (card F04e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfc-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite");
  let free = 1e12;
  const open = async () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    transfer: { targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => free }] } } as never);
  const c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    // A move that does not fit is refused when it is proposed.
    free = 10;
    const tight = "move the database to moved now";
    say[tight] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved" }, evidence: tight, basis: "owner" }];
    const refusedNow = (await c.chat!.submit(boot.token, { messageId: "m0", text: tight })).outcomes;
    assert.equal(refusedNow[0]!.status, "refused", JSON.stringify(refusedNow));
    assert.match(JSON.stringify(refusedNow[0]), /not enough room/);
    free = 1e12;
    const text = "move the database to moved";
    say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved", confirm: "invented-by-the-interpreter" }, evidence: text, basis: "owner" }];
    const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes;
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    const preview = JSON.stringify(shown[0]!.preview);
    assert.ok(preview.includes("Transfer plan"), "the proposal shows the plan");
    assert.ok(!preview.includes("invented-by-the-interpreter"));
    assert.equal((await call("database.transfer.status", {})).result.item.authority, undefined, "a proposal moves nothing");
    // Applying the proposal does the move with the controller's own token.
    const proposalId = (shown[0] as { proposalId?: string }).proposalId;
    assert.ok(proposalId !== undefined, JSON.stringify(shown[0]));
    const done = await c.chat!.applyProposal(boot.token, { commandId: "ap-1", proposalId: proposalId! });
    assert.equal(done.applied, true, JSON.stringify(done));
    assert.equal((await readAuthority(d))?.active.name, "moved");
  } finally { await c.close().catch(() => undefined); }
  rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});
