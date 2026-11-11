import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import { ManualTimer } from "../dispatch/testing/timer.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { SqliteStorage } from "../storage/index.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { postgresFingerprint, readAuthority, sqliteTarget } from "../transfer/index.js";
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

test("a rollback stopped after the fence with work that slipped in before it: the real start on the new database finds the work, keeps the move and starts with it; the previous database is refused (card F04n review)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfk-"));
  const oldPath = join(d, "a", "c.sqlite"), newPath = join(d, "b", "moved.sqlite"), state = join(d, "state");
  let point: ((p: string) => Promise<void>) | undefined;
  const lines: string[] = [];
  const open = async (path: string, other: { name: string; path: string }) => startController({ storage: { kind: "sqlite", path }, argv: [], env: {}, print: (l: string) => { lines.push(l); }, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer() },
    transfer: { stateDirectory: state, inject: async (p: string) => { await point?.(p); }, targets: [await sqliteTarget({ name: other.name, path: other.path, open: () => SqliteStorage.open({ path: other.path }) })] } } as never);
  let c = await open(oldPath, { name: "moved", path: newPath });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    let call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    await call("project.create", { name: "Garden" }, "p1");
    const preview = await call("database.transfer.preview", { target: "moved" });
    assert.ok((await call("database.transfer.apply", { target: "moved", confirm: preview.result.item.token }, "t1")).ok);
    await c.close();
    c = await open(newPath, { name: "previous", path: oldPath });
    call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    // A write that got past the barrier between the rollback's check and its fence (a second connection, under the epoch the controller holds), then the process stops right after the fence.
    point = async (p) => {
      if (p === "rollback:journal") {
        const side = await SqliteStorage.open({ path: newPath });
        try {
          const snap = await side.snapshot(); let epoch = 0;
          try { epoch = Number((await snap.read("state", { limit: 1 }))[0]!["epoch"]); } finally { await snap.close(); }
          await side.applyOperation({ operationId: "slipped", epoch, actor: "owner:rob", correlationId: "c-slipped", at: new Date().toISOString(), changes: [], audit: [{ type: "late.record", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] });
        } finally { await side.close(); }
      }
      if (p === "rollback:fenced") throw new Error("crash");
    };
    assert.equal((await call("database.transfer.rollback", {}, "t2")).ok, false);
    point = undefined;
    await c.close();
    lines.length = 0;
    c = await open(newPath, { name: "previous", path: oldPath });
    assert.ok(lines.some((l) => /not finished.*recorded work.*move stands/.test(l)), lines.join("\n"));
    assert.equal((await readAuthority(state))?.active.name, "moved");
    call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    assert.ok(JSON.stringify(await call("project.list", {})).includes("Garden"));
    assert.equal((await call("project.create", { name: "After" }, "p2")).ok, true, "the controller works on the new database");
    await c.close();
    await assert.rejects(open(oldPath, { name: "moved", path: newPath }), /moved to/);
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

test("applying the move from a chat message, not only by applyProposal, reports it applied: the turn cannot be written to the database that was just retired (card F04m)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfm-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite");
  const open = async () => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    transfer: { stateDirectory: d, targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => 1e12 }] } } as never);
  const c = await open();
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const text = "move the database to moved";
    say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved" }, evidence: text, basis: "owner" }];
    const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes;
    const proposalId = (shown[0] as { proposalId?: string }).proposalId;
    assert.ok(proposalId !== undefined, JSON.stringify(shown[0]));
    const yes = "yes, move it";
    say[yes] = [{ kind: "apply_proposal", proposalId, evidence: yes, basis: "owner" }];
    const answer = await c.chat!.submit(boot.token, { messageId: "m2", text: yes });
    assert.equal(answer.outcomes[0]!.status, "applied", JSON.stringify(answer.outcomes));
    assert.equal((await readAuthority(d))?.active.name, "moved");
  } finally { await c.close().catch(() => undefined); }
  rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

test("destinations written as configuration entries are built at start, and a move to one goes through; a bad entry or a repeated name stops the start with its index (card F04l)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfe-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite");
  const open = async (entries: unknown[]) => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    transfer: { stateDirectory: d, targets: [], targetEntries: entries } } as never);
  try {
    await assert.rejects(open([{ name: "Moved", kind: "sqlite", path: newPath }]), /transfer targets\[0\]: name: must be 1 to 64 characters/);
    await assert.rejects(open([{ name: "moved", kind: "sqlite", path: "relative.sqlite" }]), /transfer targets\[0\]: path: must be an absolute path/);
    await assert.rejects(open([{ name: "moved", kind: "sqlite", path: newPath }, { name: "moved", kind: "sqlite", path: join(d, "other.sqlite") }]), /transfer targets\[1\]: name: moved is used by another entry/);
    const c = await open([{ name: "moved", kind: "sqlite", path: newPath }]);
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const text = "move the database to moved";
      say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved" }, evidence: text, basis: "owner" }];
      const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes;
      const proposalId = (shown[0] as { proposalId?: string }).proposalId;
      assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
      assert.ok(proposalId !== undefined);
      assert.match(JSON.stringify(shown[0]), /moved/);
      const done = await c.chat!.applyProposal(boot.token, { commandId: "ap-e1", proposalId: proposalId! });
      assert.equal(done.applied, true, JSON.stringify(done));
      assert.equal((await readAuthority(d))?.active.name, "moved");
    } finally { await c.close().catch(() => undefined); }
  } finally { rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a recovery point whose conversation checkpoint the host cannot find refuses the move, and nothing is moved (card F04l)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfk-"));
  const say: Record<string, unknown[]> = {};
  const dbPath = join(d, "c.sqlite");
  // A database that already holds one recovery point, as a running installation would.
  const seed = await SqliteStorage.open({ path: dbPath });
  const { epoch } = await seed.acquireEpoch({ holder: "seed", at: "2026-10-31T10:00:00.000Z" });
  await seed.applyOperation({ operationId: "seed-1", epoch, actor: "owner:rob", correlationId: "c-seed", at: "2026-10-31T10:00:00.000Z", audit: [{ type: "task.created", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [], changes: [
    { type: "create", ref: { kind: "task", id: "task-a" }, body: { title: "t" } }, { type: "create", ref: { kind: "attempt", id: "att-1" }, body: { taskId: "task-a" } },
    { type: "create", ref: { kind: "artifact", id: "art-aaaaaaaaaaaaaaaaaaaa" }, body: { entries: [{ digest: "sha256:" + "d".repeat(64) }] } },
    { type: "create", ref: { kind: "recovery-point", id: "rp-1" }, body: { attemptId: "att-1", taskId: "task-a", artifactId: "art-aaaaaaaaaaaaaaaaaaaa", checkpoint: "ck-1" } },
  ] } as never);
  await seed.close();
  let asked: { id: string; attemptId: string; checkpoint: string }[] = [];
  const c = await startController({ storage: { kind: "sqlite", path: dbPath }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    transfer: { stateDirectory: d, targets: [], targetEntries: [{ name: "moved", kind: "sqlite", path: join(d, "moved.sqlite") }], references: { checkpoints: async (points: { id: string; attemptId: string; checkpoint: string }[]) => { asked = points; return points.map((p) => p.id); } } } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const text = "move the database to moved";
    say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "moved" }, evidence: text, basis: "owner" }];
    const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes;
    assert.equal(shown[0]!.status, "refused", JSON.stringify(shown));
    assert.match(JSON.stringify(shown[0]), /checkpoint of recovery point rp-1 is not in the conversation store, or does not match it/);
    assert.deepEqual(asked, [{ id: "rp-1", attemptId: "att-1", checkpoint: '"ck-1"' }], "the host gets each checkpoint as the JSON text the record holds");
    assert.equal(await readAuthority(d), undefined, "nothing was moved");
  } finally { await c.close().catch(() => undefined); }
  rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
});

// ------------------------------------------------------------------------------- PostgreSQL destinations from configuration, through a real start (card F04l)

let pgServer: Promise<TestServer> | undefined;
const pg = (): Promise<TestServer> => (pgServer ??= startTestServer());
after(async () => { if (pgServer !== undefined) await (await pgServer).stop(); });
const PG_USER_PASSWORD = "nn-test-password";

test("a real start with a PostgreSQL destination in the configuration (address only as a secret reference) moves the database from chat; the address and its password appear in no chat answer, print line, journal or authority file, and a start without the secret is refused naming it (card F04l)", async () => {
  const s = await pg();
  const url = s.url();
  const schema = `xs_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
  const d = mkdtempSync(join(tmpdir(), "nn-xfp-"));
  const say: Record<string, unknown[]> = {};
  const printed: string[] = [];
  const entries = [{ name: "big-pg", kind: "postgres", url: { secret: "transfer.pg-url" }, schema, maxBytes: 900_000_000 }];
  const open = (secrets?: (name: string) => Promise<string | undefined>) => startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: (line: string) => { printed.push(line); }, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    transfer: { stateDirectory: d, targets: [], targetEntries: entries, ...(secrets === undefined ? {} : { secrets }) } } as never);
  try {
    await assert.rejects(open(), (e: Error) => /transfer targets\[0\]: kind: "postgres" targets cannot be built here/.test(e.message) && !e.message.includes(PG_USER_PASSWORD));
    await assert.rejects(open(async () => undefined), (e: Error) => e.message === "transfer targets[0]: url: the secret transfer.pg-url is not available");
    const c = await open(async (name) => (name === "transfer.pg-url" ? url : undefined));
    let seen = "";
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      await c.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Garden" } } as never);
      const status = JSON.stringify(await c.api.handle(boot.token, { v: 1, op: "database.transfer.status", args: {} } as never));
      assert.match(status, /"name":"big-pg","kind":"postgres","direction":"sqlite to postgres"/);
      const text = "move the database to big-pg";
      say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "big-pg" }, evidence: text, basis: "owner" }];
      const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes;
      const proposalId = (shown[0] as { proposalId?: string }).proposalId;
      assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
      // The room the owner is shown is the entry's cap less what the server reports for the database (card F04l), read just before and after the proposal.
      const size = async (): Promise<number> => withClient(url, async (client) => Number((await client.query("SELECT pg_database_size(current_database())::text AS n")).rows[0].n));
      const room = /room: about (\d+) bytes needed, (\d+) free at the destination/.exec(JSON.stringify(shown));
      assert.ok(room !== null, JSON.stringify(shown));
      const after = await size();
      assert.ok(Number(room[2]) >= 900_000_000 - after - 1_048_576 && Number(room[2]) <= 900_000_000 - after + 1_048_576 && Number(room[2]) < 900_000_000, `free ${room[2]}, server size ${after}`);
      seen += JSON.stringify(shown) + status;
      const done = await c.chat!.applyProposal(boot.token, { commandId: "ap-p1", proposalId: proposalId! });
      assert.equal(done.applied, true, JSON.stringify(done));
      seen += JSON.stringify(done);
      const authority = await readAuthority(d);
      assert.equal(authority?.active.name, "big-pg"); assert.equal(authority?.active.kind, "postgres");
      assert.equal(authority?.active.fingerprint, postgresFingerprint(url, schema));
    } finally { await c.close().catch(() => undefined); }
    const files = ["database-transfer-journal.json", "storage-authority.json"].map((n) => readFileSync(join(d, n), "utf8")).join("\n");
    for (const [where, text] of [["chat", seen], ["print", printed.join("\n")], ["state files", files]] as const) {
      for (const leak of [PG_USER_PASSWORD, url, "postgres://"]) assert.ok(!text.includes(leak), `${where} holds ${leak.slice(0, 10)}`);
    }
    // The data is in the PostgreSQL schema the entry named.
    const moved = await PostgresStorage.open({ connectionString: url, schema });
    try { assert.ok((await moved.listAggregates("project", { limit: 10 })).some((p) => JSON.stringify(p).includes("Garden"))); } finally { await moved.close(); }
  } finally {
    await withClient(url, async (client) => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }).catch(() => undefined);
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

test("a PostgreSQL controller moves to a SQLite file named in the configuration, the other way round (card F04l)", async () => {
  const s = await pg();
  const url = s.url();
  const schema = `xr_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
  const d = mkdtempSync(join(tmpdir(), "nn-xfq-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({ storage: { kind: "postgres", url, schema }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
    transfer: { stateDirectory: d, targets: [], targetEntries: [{ name: "to-file", kind: "sqlite", path: join(d, "back.sqlite") }] } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    await c.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Orchard" } } as never);
    const text = "move the database to to-file";
    say[text] = [{ kind: "command", op: "database.transfer.apply", args: { target: "to-file" }, evidence: text, basis: "owner" }];
    const shown = (await c.chat!.submit(boot.token, { messageId: "m1", text })).outcomes;
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    const done = await c.chat!.applyProposal(boot.token, { commandId: "ap-q1", proposalId: (shown[0] as { proposalId: string }).proposalId });
    assert.equal(done.applied, true, JSON.stringify(done));
    assert.equal((await readAuthority(d))?.active.kind, "sqlite");
  } finally {
    await c.close().catch(() => undefined);
    await withClient(url, async (client) => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }).catch(() => undefined);
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

const chatOf = (say: Record<string, unknown[]>) => ({ interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) });
const rolePlay = async (c: Awaited<ReturnType<typeof startController>>, token: string, say: Record<string, unknown[]>, id: string, text: string, intent: Record<string, unknown>) => {
  say[text] = [{ ...intent, evidence: text, basis: "owner" }];
  return (await c.chat!.submit(token, { messageId: id, text })).outcomes as any[];
};

test("the host restarts the controller onto the new database by itself once the move is answered, and the very message that did the move can be sent again to the restarted controller (card F04m)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfh-"));
  const say: Record<string, unknown[]> = {};
  const oldPath = join(d, "c.sqlite"), newPath = join(d, "moved.sqlite"), state = join(d, "state");
  const events: Array<{ reason: string; to: string }> = [];
  let current: Awaited<ReturnType<typeof startController>> | undefined;
  let restarted!: () => void;
  const done = new Promise<void>((r) => { restarted = r; });
  const open = async (path: string, other: { name: string; path: string }, restart: boolean) => startController({ storage: { kind: "sqlite", path }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: chatOf(say),
    transfer: { stateDirectory: state, targets: [{ ...(await sqliteTarget({ name: other.name, path: other.path, open: () => SqliteStorage.open({ path: other.path }) })), freeBytes: async () => 1e12 }],
      ...(restart ? { restart: { delayMs: 30, run: async (e: { reason: string; to: string }) => { events.push(e); await current!.close(); current = await open(newPath, { name: "previous", path: oldPath }, true); restarted(); } } } : {}) } } as never);
  current = await open(oldPath, { name: "moved", path: newPath }, true);
  try {
    const boot = await current.services.principals.bootstrapOwner({ name: "rob" });
    await current.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Garden" } } as never);
    const ask = "move the database to moved";
    const shown = await rolePlay(current, boot.token, say, "m1", ask, { kind: "command", op: "database.transfer.apply", args: { target: "moved" } });
    const proposalId = shown[0].proposalId as string;
    const yes = "yes, move it";
    const answer = await rolePlay(current, boot.token, say, "m2", yes, { kind: "apply_proposal", proposalId });
    assert.equal(answer[0].status, "applied", JSON.stringify(answer));
    assert.match(answer[0].results[0].shown.join(" "), /moved to moved\. The host restarts the controller onto it in a moment/, "the owner is told the host restarts it");
    assert.equal(events.length, 0, "not before the answer is out");
    await done;
    assert.deepEqual(events.map((e) => e.reason), ["switched"]);
    // The restarted controller runs on the new database with the data, and the barrier is down: the owner can work at once.
    assert.ok(JSON.stringify(await current.api.handle(boot.token, { v: 1, op: "project.list", args: {} } as never)).includes("Garden"));
    assert.equal(((await current.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p2", args: { name: "After" } } as never)) as any).ok, true);
    // The message was resent (the client never saw an answer that the old database could keep): the move is not run again and the owner is told it was made.
    const resent = (await current.chat!.submit(boot.token, { messageId: "m2", text: yes })).outcomes as any[];
    assert.equal(resent[0].status, "applied", JSON.stringify(resent));
    assert.match(resent[0].results[0].shown.join(" "), /This was already done: the database was moved to moved/);
    assert.equal((await readAuthority(state))?.active.name, "moved");
    // The owner asks where the database lives, in free words.
    const where = await rolePlay(current, boot.token, say, "m3", "where does my data live now?", { kind: "status", request: { kind: "database_transfer" } });
    const lines = JSON.stringify(where[0].lines);
    assert.match(lines, /The controller database is/); assert.match(lines, /restarts the controller onto the new database by itself/); assert.match(lines, /last move .* to moved: switched/);
  } finally { await current?.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("the owner turns the automatic restart off and on by chat in their own words; off, the move leaves the controller waiting for a restart (card F04m)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfo-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite");
  const events: unknown[] = [];
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: chatOf(say), transfer: { stateDirectory: d, targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => 1e12 }], restart: { delayMs: 20, run: (e: unknown) => { events.push(e); } } } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const stop = "please don't restart yourself after you move the database, I'll do it";
    const proposed = await rolePlay(c, boot.token, say, "s1", stop, { kind: "command", op: "database.transfer.set", args: { restart: false } });
    assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
    const applied = await rolePlay(c, boot.token, say, "s2", "yes, please do that", { kind: "apply_proposal", proposalId: proposed[0].proposalId });
    assert.equal(applied[0].status, "applied", JSON.stringify(applied));
    const lines = JSON.stringify((await rolePlay(c, boot.token, say, "s3", "how are database moves set up?", { kind: "status", request: { kind: "database_transfer" } }))[0].lines);
    assert.match(lines, /automatic restart is off/);
    // A value that is not true or false is refused, and a non-owner may not change it.
    const bad = await c.api.handle(boot.token, { v: 1, op: "database.transfer.set", commandId: "bad", args: { restart: "maybe" } } as never) as any;
    assert.equal(bad.error.code, "invalid_command");
    const moved = await rolePlay(c, boot.token, say, "s4", "move the database to moved", { kind: "command", op: "database.transfer.apply", args: { target: "moved" } });
    const done = await rolePlay(c, boot.token, say, "s5", "go ahead and move it", { kind: "apply_proposal", proposalId: moved[0].proposalId });
    assert.match(done[0].results[0].shown.join(" "), /automatic restart is off: restart the controller yourself/);
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(events.length, 0, "the host was not asked to restart");
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

test("a copy a failed move left at the destination is removed by chat, in the owner's words, after a plan that shows what is there; the next move then goes through (card F04m)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfw-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite");
  let fail = true, canEmpty = false;
  const base = await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) });
  const target = { ...base, freeBytes: async () => 1e12, discard: async () => { if (!canEmpty) throw new Error("not allowed yet"); rmSync(newPath, { force: true }); rmSync(`${newPath}-wal`, { force: true }); rmSync(`${newPath}-shm`, { force: true }); } };
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: chatOf(say), transfer: { stateDirectory: d, targets: [target], inject: async (p: string) => { if (fail && p === "copy:audit") throw new Error("the disk went away"); } } } as never);
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const first = await rolePlay(c, boot.token, say, "w1", "move the database to moved", { kind: "command", op: "database.transfer.apply", args: { target: "moved" } });
    const failed = await rolePlay(c, boot.token, say, "w2", "yes do it", { kind: "apply_proposal", proposalId: first[0].proposalId });
    assert.notEqual(failed[0].status, "applied", JSON.stringify(failed));
    assert.equal(existsSync(newPath), true, "a partial copy was left (it could not be emptied)");
    fail = false;
    const lines = JSON.stringify((await rolePlay(c, boot.token, say, "w3", "what happened with my database move?", { kind: "status", request: { kind: "database_transfer" } }))[0].lines);
    assert.match(lines, /failed/); assert.match(lines, /ask to remove it/);
    // Nothing to remove at a place that holds no copy: refused with the reason.
    const wipe = "throw away the half-finished copy at moved";
    const plan = await rolePlay(c, boot.token, say, "w4", wipe, { kind: "command", op: "database.transfer.wipe", args: { target: "moved" } });
    assert.equal(plan[0].status, "proposed", JSON.stringify(plan));
    assert.match(JSON.stringify(plan[0]), /left by a transfer that did not finish/);
    // The destination refuses at first; the owner is told and the copy stays.
    const refused = await rolePlay(c, boot.token, say, "w5", "yes, remove it", { kind: "apply_proposal", proposalId: plan[0].proposalId });
    assert.notEqual(refused[0].status, "applied", JSON.stringify(refused)); assert.equal(existsSync(newPath), true);
    canEmpty = true;
    const removed = await rolePlay(c, boot.token, say, "w6", "try removing it again", { kind: "apply_proposal", proposalId: plan[0].proposalId });
    assert.equal(removed[0].status, "applied", JSON.stringify(removed)); assert.equal(existsSync(newPath), false);
    const again = await rolePlay(c, boot.token, say, "w7", "remove the copy at moved", { kind: "command", op: "database.transfer.wipe", args: { target: "moved" } });
    assert.notEqual(again[0].status, "proposed", "an empty destination has nothing to remove"); assert.match(JSON.stringify(again), /nothing can be removed|is empty|nothing to remove/);
    const move = await rolePlay(c, boot.token, say, "w8", "now move the database to moved", { kind: "command", op: "database.transfer.apply", args: { target: "moved" } });
    const ok = await rolePlay(c, boot.token, say, "w9", "yes, please do that", { kind: "apply_proposal", proposalId: move[0].proposalId });
    assert.equal(ok[0].status, "applied", JSON.stringify(ok));
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});

// Card F04m, third slice: the owner's automatic-restart switch is revision-checked end to end on the started controller, on SQLite and on an embedded PostgreSQL controller database.
for (const backend of ["sqlite", "postgres"] as const) {
  test(`the automatic restart switch is owner only and revision checked: a chat proposal pins the revision it was planned at and is refused once the settings moved; staged changes of others are not applied with it; off, a move does not ask the host to restart (${backend}, card F04m)`, async () => {
    const d = mkdtempSync(join(tmpdir(), "nn-xfr-"));
    const say: Record<string, unknown[]> = {};
    const newPath = join(d, "moved.sqlite");
    const events: unknown[] = [];
    const url = backend === "postgres" ? (await pg()).url() : undefined;
    const schema = `xs_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
    const storage = backend === "postgres" ? { kind: "postgres", url, schema } : { kind: "sqlite", path: join(d, "c.sqlite") };
    const c = await startController({ storage, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
      chat: chatOf(say), transfer: { stateDirectory: d, targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => 1e12 }], restart: { delayMs: 20, run: (e: unknown) => { events.push(e); } } } } as never);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
    try {
      const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
      const rob = await c.services.principals.authenticate(boot.token);
      // Only the owner reads or changes it.
      await c.services.principals.enroll(rob, { commandId: "e-zed", kind: "agent", name: "zed", grants: [] });
      const zed = (await c.services.principals.issueCredential(rob, "agent:zed")).token;
      assert.equal((await call(zed, "database.transfer.settings", {})).error.code, "forbidden");
      assert.equal((await call(zed, "database.transfer.set", { restart: false }, "z1")).error.code, "forbidden");
      const before = (await call(boot.token, "database.transfer.settings", {})).result.item;
      assert.deepEqual({ restart: before.restart, restartOffered: before.restartOffered, typed: typeof before.revision }, { restart: true, restartOffered: true, typed: "number" });

      // The owner asks in their own words; the proposal is planned at today's revision.
      const stop = "don't restart yourself after you move the database, I'll do it by hand";
      const proposed = await rolePlay(c, boot.token, say, "m1", stop, { kind: "command", op: "database.transfer.set", args: { restart: false } });
      assert.equal(proposed[0].status, "proposed", JSON.stringify(proposed));
      // Something else changes the installation settings before the owner says yes.
      const between = await call(boot.token, "database.transfer.set", { enabled: true, expectedRevision: before.revision }, "other-1");
      assert.equal(between.ok, true, JSON.stringify(between));
      const moved = between.result.item.revision as number;
      assert.ok(moved > before.revision, "the change moved the revision");
      // The stale proposal is refused and changes nothing; a stale API call likewise.
      const stale = await c.chat!.applyProposal(boot.token, { commandId: "ap-stale", proposalId: proposed[0].proposalId }).catch((e: { code?: string }) => ({ refused: e.code }));
      assert.ok(JSON.stringify(stale).includes("stale_revision"), JSON.stringify(stale));
      assert.equal((await call(boot.token, "database.transfer.settings", {})).result.item.restart, true, "the stale proposal changed nothing");
      assert.equal((await call(boot.token, "database.transfer.set", { restart: false, expectedRevision: before.revision }, "stale-api")).error.code, "stale_revision");
      for (const [i, bad] of ([-1, "3", 1.5, 2 ** 60, null] as unknown[]).entries()) {
        const refused = await call(boot.token, "database.transfer.set", { restart: false, expectedRevision: bad }, `neg-${i}`);
        assert.equal(refused.error.code, "invalid_command", JSON.stringify(refused));
        assert.match(refused.error.message, /0 before anything was set/, `the owner is told what to give (${String(bad)})`);
      }

      // An installation change someone staged and did not apply neither blocks the switch nor goes into force with it (the switch is one write that never applies a draft).
      await c.services.configuration.stage(rob, { commandId: "cfg-draft", layer: "installation", expectedRevision: moved, set: { "conversation.mcp.enabled": false } } as never);
      const alongside = await call(boot.token, "database.transfer.set", { enabled: true }, "alongside");
      assert.equal(alongside.ok, true, JSON.stringify(alongside));
      assert.notEqual(await c.services.configuration.installationValue("conversation.mcp.enabled"), false, "the staged change did not go into force with the switch");
      assert.deepEqual(Object.keys((await c.services.configuration.layer(rob, "installation"))!.draft!.set), ["conversation.mcp.enabled"], "it stays staged, untouched");
      await c.services.configuration.discard(rob, { commandId: "cfg-discard", layer: "installation", expectedRevision: alongside.result.item.revision } as never);
      assert.notEqual(await c.services.configuration.installationValue("conversation.mcp.enabled"), false, "the staged change never went into force");

      // Asked again, it goes through, and a resend of the same confirmation is not applied twice.
      const again = await rolePlay(c, boot.token, say, "m2", "please stop restarting yourself after a database move", { kind: "command", op: "database.transfer.set", args: { restart: false } });
      assert.equal(again[0].status, "proposed", JSON.stringify(again));
      const yes = await rolePlay(c, boot.token, say, "m3", "yes, do that", { kind: "apply_proposal", proposalId: again[0].proposalId });
      assert.equal(yes[0].status, "applied", JSON.stringify(yes));
      const off = (await call(boot.token, "database.transfer.settings", {})).result.item;
      assert.equal(off.restart, false);
      const resent = (await c.chat!.submit(boot.token, { messageId: "m3", text: "yes, do that" })).outcomes as any[];
      assert.equal(resent[0].status, "applied", JSON.stringify(resent));
      assert.equal((await call(boot.token, "database.transfer.settings", {})).result.item.revision, off.revision, "the resend changed nothing");

      // Off: the move is made and the host is not asked to restart.
      const plan = await rolePlay(c, boot.token, say, "m4", "move the database to moved", { kind: "command", op: "database.transfer.apply", args: { target: "moved" } });
      const done = await rolePlay(c, boot.token, say, "m5", "go ahead and move it", { kind: "apply_proposal", proposalId: plan[0].proposalId });
      assert.equal(done[0].status, "applied", JSON.stringify(done));
      assert.match(done[0].results[0].shown.join(" "), /automatic restart is off: restart the controller yourself/);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(events.length, 0, "the host was not asked to restart");
    } finally {
      await c.close().catch(() => undefined);
      if (url !== undefined) await withClient(url, async (client) => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }).catch(() => undefined);
      rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    }
  });
}

test("a PostgreSQL controller with the host's restart opt-in is restarted by the host onto the SQLite file it moved to, with the data, and the owner can turn the restart back on from the restarted controller in their own words (card F04m)", async () => {
  const url = (await pg()).url();
  const schema = `xt_${process.pid}_${Math.random().toString(36).slice(2, 7)}`;
  const d = mkdtempSync(join(tmpdir(), "nn-xfp-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite"), state = join(d, "state");
  const events: Array<{ reason: string; to: string }> = [];
  let current: Awaited<ReturnType<typeof startController>> | undefined;
  let restarted!: () => void;
  const done = new Promise<void>((r) => { restarted = r; });
  const base = { argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 }, chat: chatOf(say) };
  const restart = { delayMs: 30, run: async (e: { reason: string; to: string }) => { events.push(e); await current!.close(); current = await startController({ ...base, storage: { kind: "sqlite", path: newPath }, transfer: { stateDirectory: state, targets: [], targetEntries: [{ name: "spare", kind: "sqlite", path: join(d, "spare.sqlite") }], restart: { run: () => undefined } } } as never).catch(() => undefined) as never; restarted(); } };
  current = await startController({ ...base, storage: { kind: "postgres", url, schema }, transfer: { stateDirectory: state, targets: [], targetEntries: [{ name: "to-file", kind: "sqlite", path: newPath }], restart } } as never);
  try {
    const boot = await current.services.principals.bootstrapOwner({ name: "rob" });
    await current.api.handle(boot.token, { v: 1, op: "project.create", commandId: "p1", args: { name: "Orchard" } } as never);
    const plan = await rolePlay(current, boot.token, say, "m1", "move my data to the file to-file", { kind: "command", op: "database.transfer.apply", args: { target: "to-file" } });
    assert.equal(plan[0].status, "proposed", JSON.stringify(plan));
    const answer = await rolePlay(current, boot.token, say, "m2", "yes, move it", { kind: "apply_proposal", proposalId: plan[0].proposalId });
    assert.equal(answer[0].status, "applied", JSON.stringify(answer));
    assert.match(answer[0].results[0].shown.join(" "), /The host restarts the controller onto it in a moment/);
    await done;
    assert.deepEqual(events.map((e) => [e.reason, e.to]), [["switched", "to-file"]]);
    assert.ok(current !== undefined, "the restarted controller started on the new database");
    assert.equal((await readAuthority(state))?.active.kind, "sqlite");
    assert.ok(JSON.stringify(await current.api.handle(boot.token, { v: 1, op: "project.list", args: {} } as never)).includes("Orchard"), "the data moved with it");
    // On the restarted controller the owner turns the restart off and back on, in free words, each a proposal confirmed by the owner.
    for (const [i, [words, value]] of ([["don't restart yourself after a database move any more", false], ["go back to restarting on your own after a move", true]] as const).entries()) {
      const asked = await rolePlay(current, boot.token, say, `r${i}a`, words, { kind: "command", op: "database.transfer.set", args: { restart: value } });
      assert.equal(asked[0].status, "proposed", JSON.stringify(asked));
      const ok = await rolePlay(current, boot.token, say, `r${i}b`, `yes (${i})`, { kind: "apply_proposal", proposalId: asked[0].proposalId });
      assert.equal(ok[0].status, "applied", JSON.stringify(ok));
      assert.equal(((await current.api.handle(boot.token, { v: 1, op: "database.transfer.settings", args: {} } as never)) as any).result.item.restart, value);
    }
  } finally {
    await current?.close().catch(() => undefined);
    await withClient(url, async (client) => { await client.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }).catch(() => undefined);
    rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
});

// Review of card F04m, third slice (updated: the switch is now one write that never applies a draft): what follows covers a draft an OLDER controller left. The switch's stage and apply were two writes, so a stop between them left the switch staged. No operation discards a staged draft, so refusing it as "someone
// else's" blocked the other switch for good; merging it would put the old, unconfirmed value into force. It is discarded first, and the chat's proposal planned while it waited still applies.
test("a switch left staged by a change stopped between its stage and its apply blocks neither switch, is never put into force, and a chat proposal planned meanwhile applies (review of card F04m)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-xfl-"));
  const say: Record<string, unknown[]> = {};
  const newPath = join(d, "moved.sqlite");
  const c = await startController({ storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [], dispatch: { timer: new ManualTimer(), tickMs: 3_600_000 },
    chat: chatOf(say), transfer: { stateDirectory: d, targets: [{ ...(await sqliteTarget({ name: "moved", path: newPath, open: () => SqliteStorage.open({ path: newPath }) })), freeBytes: async () => 1e12 }], restart: { delayMs: 20, run: () => undefined } } } as never);
  const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const first = await call(boot.token, "database.transfer.set", { enabled: true, expectedRevision: 0 }, "s0");
    assert.equal(first.ok, true, JSON.stringify(first));
    // An earlier "stop restarting" was staged and the controller stopped before applying it.
    const r0 = first.result.item.revision as number;
    await c.services.configuration.stage(rob, { commandId: "half-st", layer: "installation", expectedRevision: r0, set: { "database.transfer.restart": false } } as never);
    const r1 = (await call(boot.token, "database.transfer.settings", {})).result.item;
    assert.deepEqual([r1.restart, r1.revision > r0], [true, true]);
    // The owner turns moves off: not blocked, and the left-over restart value does not go into force with it (it stays staged, out of force; the switch never applies a draft).
    const off = await call(boot.token, "database.transfer.set", { enabled: false }, "s1");
    assert.equal(off.ok, true, JSON.stringify(off));
    assert.deepEqual([off.result.item.enabled, off.result.item.restart], [false, true]);
    // A resend of the same call without a revision is answered from the record (it used to get a stale stage) and changes nothing.
    const resent = await call(boot.token, "database.transfer.set", { enabled: false }, "s1");
    assert.deepEqual([resent.ok, resent.result?.item.revision], [true, off.result.item.revision], JSON.stringify(resent));
    // Left over again; a chat proposal is planned while it waits, and the owner's yes applies it.
    const r2 = (await call(boot.token, "database.transfer.settings", {})).result.item.revision as number;
    await c.services.configuration.stage(rob, { commandId: "half2-st", layer: "installation", expectedRevision: r2, set: { "database.transfer.restart": false, "database.transfer.enabled": true } } as never);
    const asked = await rolePlay(c, boot.token, say, "m1", "let the database be moved again", { kind: "command", op: "database.transfer.set", args: { enabled: true } });
    assert.equal(asked[0].status, "proposed", JSON.stringify(asked));
    const yes = await rolePlay(c, boot.token, say, "m2", "yes, go ahead and do that", { kind: "apply_proposal", proposalId: asked[0].proposalId });
    assert.equal(yes[0].status, "applied", JSON.stringify(yes));
    const now = (await call(boot.token, "database.transfer.settings", {})).result.item;
    assert.deepEqual([now.enabled, now.restart], [true, true], "only what the owner confirmed is in force");
    // A caller whose revision is older is still refused as stale, and nothing changes.
    assert.equal((await call(boot.token, "database.transfer.set", { enabled: false, expectedRevision: now.revision - 1 }, "s2")).error.code, "stale_revision");
    assert.equal((await call(boot.token, "database.transfer.settings", {})).result.item.revision, now.revision);
    // Someone else's staged installation change neither blocks the switch nor is applied with it.
    const r3 = (await c.services.configuration.layer(rob, "installation"))!.revision;
    await c.services.configuration.stage(rob, { commandId: "other-st", layer: "installation", expectedRevision: r3, set: { "conversation.mcp.enabled": false } } as never);
    const through = await call(boot.token, "database.transfer.set", { enabled: false }, "s3");
    assert.equal(through.ok, true, JSON.stringify(through));
    assert.notEqual(await c.services.configuration.installationValue("conversation.mcp.enabled"), false);
    assert.notEqual(await c.services.configuration.installationValue("database.transfer.restart"), false, "the left-over restart value never went into force");
  } finally { await c.close().catch(() => undefined); rmSync(d, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }
});
