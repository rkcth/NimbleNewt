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

test("the owner moves the controller database from the running controller: preview, approve, barrier, the old database never starts again (separate folders), the new one does, and the owner rolls back from there (card F04e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfs-"));
  const oldPath = join(d, "a", "c.sqlite"), newPath = join(d, "b", "moved.sqlite"), state = join(d, "state");
  const open = async (path: string, other: { name: string; path: string }) => startController({ storage: { kind: "sqlite", path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() },
    transfer: { stateDirectory: state, targets: [await sqliteTarget({ name: other.name, path: other.path, open: () => SqliteStorage.open({ path: other.path }) })] } } as never);
  let c = await open(oldPath, { name: "moved", path: newPath });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    let call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
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
    assert.equal(preview.result.item.ok, true, JSON.stringify(preview));
    assert.equal((await call(boot.token, "database.transfer.apply", { target: "moved", confirm: "wrong" }, "t1")).error.code, "invalid_command");
    const applied = await call(boot.token, "database.transfer.apply", { target: "moved", confirm: preview.result.item.token }, "t2");
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal(applied.result.item.restartRequired, true);
    const refused = await call(boot.token, "project.create", { name: "Blocked" }, "p2");
    assert.equal(refused.error.code, "unavailable"); assert.match(refused.error.message, /maintenance/);
    assert.equal((await call(boot.token, "database.transfer.status", {})).result.item.authority.active.name, "moved");
    await c.close();
    // The old database does not start again: not with the transfer state, and not with NO transfer configuration either (the fence is inside the database).
    await assert.rejects(open(oldPath, { name: "moved", path: newPath }), /moved to moved .* Point controller\.storage at moved/);
    await assert.rejects(startController({ storage: { kind: "sqlite", path: oldPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() } } as never), /left by database transfer/);
    // The new one starts, with the data, and the owner can roll back from it while it has recorded no work.
    c = await open(newPath, { name: "previous", path: oldPath });
    call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    assert.ok(JSON.stringify(await call(boot.token, "project.list", {})).includes("Garden"));
    const back = await call(boot.token, "database.transfer.rollback", {}, "t3");
    assert.ok(back.ok, JSON.stringify(back));
    assert.equal((await readAuthority(state))?.active.kind, "sqlite"); assert.equal((await readAuthority(state))?.generation, 2);
    await c.close();
    await assert.rejects(open(newPath, { name: "previous", path: oldPath }), /moved to the SQLite database|moved to previous|moved to/);
    c = await open(oldPath, { name: "moved", path: newPath });
    call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    assert.equal((await call(boot.token, "project.create", { name: "Back home" }, "p3")).ok, true);
    assert.ok(JSON.stringify(await call(boot.token, "project.list", {})).includes("Garden"));
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("once the new database has recorded work the transfer cannot be rolled back from it, and the owner's switch turns transfers off (card F04e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfw-"));
  const oldPath = join(d, "a", "c.sqlite"), newPath = join(d, "b", "moved.sqlite"), state = join(d, "state");
  const open = async (path: string, other: { name: string; path: string }) => startController({ storage: { kind: "sqlite", path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() },
    transfer: { stateDirectory: state, targets: [await sqliteTarget({ name: other.name, path: other.path, open: () => SqliteStorage.open({ path: other.path }) })] } } as never);
  let c = await open(oldPath, { name: "moved", path: newPath });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    let call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const preview = await call("database.transfer.preview", { target: "moved" });
    // The owner's switch (installation setting, on by default): off refuses, on again allows.
    const owner = await c.services.principals.authenticate(boot.token);
    const set = async (value: boolean, id: string): Promise<void> => { const layer = await c.services.configuration.layer(owner, "installation", undefined); const staged = await c.services.configuration.stage(owner, { commandId: `st-${id}`, layer: "installation", ...(layer === undefined ? {} : { expectedRevision: layer.revision }), set: { "database.transfer.enabled": value } } as never); await c.services.configuration.apply(owner, { commandId: `ap-${id}`, layer: "installation", expectedRevision: staged.revision } as never); };
    await set(false, "a");
    const switchedOff = await call("database.transfer.preview", { target: "moved" });
    assert.equal(switchedOff.error.code, "unavailable"); assert.match(switchedOff.error.message, /switched off/);
    await set(true, "b");
    const plan = preview.result.item;
    assert.ok((await call("database.transfer.apply", { target: "moved", confirm: plan.token }, "t1")).ok);
    await c.close();
    c = await open(newPath, { name: "previous", path: oldPath });
    call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    assert.equal((await call("project.create", { name: "New work" }, "p1")).ok, true);
    const refused = await call("database.transfer.rollback", {}, "t2");
    assert.equal(refused.error.code, "invalid_transition"); assert.match(refused.error.message, /recorded work since it started/);
    assert.equal((await readAuthority(state))?.active.name, "moved");
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the transfer state folder must be an absolute path (card F04e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfa-"));
  try {
    await assert.rejects(startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() }, transfer: { stateDirectory: "state", targets: [] } } as never), /must be an absolute path/);
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
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
    transfer: { stateDirectory: d, targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => free }] } } as never);
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
