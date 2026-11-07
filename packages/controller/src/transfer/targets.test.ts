import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canon } from "../backup/canon.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { sqliteTargetsFromConfig, type SqliteTargetDeps } from "./index.js";

const deps: SqliteTargetDeps = { openStorage: (path) => SqliteStorage.open({ path }), statfs };
const enoent = (p: string): never => { const e: NodeJS.ErrnoException = new Error(`enoent: ${p}`); e.code = "ENOENT"; throw e; };
const temp = (): string => mkdtempSync(join(tmpdir(), "nn-tgts-"));
const done = (dir: string): void => { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); };

test("configuration entries become working SQLite targets: names, fingerprints, an openable store, no discard (card F04l)", async () => {
  const dir = temp();
  try {
    const one = join(dir, "one.sqlite");
    const two = join(dir, "two.sqlite");
    const targets = await sqliteTargetsFromConfig([
      { name: "one", kind: "sqlite", path: one },
      { name: "two-2", kind: "sqlite", path: two },
    ], deps);
    assert.deepEqual(targets.map((t) => [t.name, t.kind]), [["one", "sqlite"], ["two-2", "sqlite"]]);
    assert.equal(targets[0]!.fingerprint, `sqlite:${await canon(one)}`);
    assert.equal(targets[1]!.fingerprint, `sqlite:${await canon(two)}`);
    assert.equal(targets[0]!.discard, undefined, "no discard: the host empties a failed destination");
    const store = await targets[0]!.open();
    await store.close();
    assert.ok(existsSync(one), "open() made a SQLite database at the entry's path");
  } finally { done(dir); }
});

test("an entry that is not a SQLite target is refused, and the message names the entry and the problem (card F04l)", async () => {
  const bad = async (entry: unknown, ...parts: string[]): Promise<void> => {
    await assert.rejects(sqliteTargetsFromConfig([entry], deps), (error: Error) => parts.every((p) => error.message.includes(p)));
  };
  await bad(null, "targets[0]", "object");
  await bad("db.sqlite", "targets[0]", "object");
  await bad({ name: "one", kind: "postgres", path: "/srv/db.sqlite" }, "targets[0]", "kind");
  await bad({ kind: "sqlite", path: "/srv/db.sqlite" }, "targets[0]", "name");
  await bad({ name: "", kind: "sqlite", path: "/srv/db.sqlite" }, "targets[0]", "name");
  await bad({ name: "One", kind: "sqlite", path: "/srv/db.sqlite" }, "targets[0]", "name");
  await bad({ name: "a_b", kind: "sqlite", path: "/srv/db.sqlite" }, "targets[0]", "name");
  await bad({ name: "a".repeat(65), kind: "sqlite", path: "/srv/db.sqlite" }, "targets[0]", "name");
  await bad({ name: "one", kind: "sqlite", path: "srv/db.sqlite" }, "targets[0]", "path");
  await bad({ name: "one", kind: "sqlite", path: 7 }, "targets[0]", "path");
  await bad({ name: "one", kind: "sqlite", path: "/srv/db.sqlite", url: "postgres://x" }, "targets[0]", "url");
  await assert.rejects(sqliteTargetsFromConfig("not a list" as unknown as readonly unknown[], deps), /targets:.*list/);
});

test("two entries with the same name are refused at the second one (card F04l)", async () => {
  await assert.rejects(
    sqliteTargetsFromConfig([
      { name: "one", kind: "sqlite", path: join(tmpdir(), "nn-tgts-a.sqlite") },
      { name: "one", kind: "sqlite", path: join(tmpdir(), "nn-tgts-b.sqlite") },
    ], deps),
    (error: Error) => error.message.includes("targets[1]") && error.message.includes("one"),
  );
});

test("two entries whose paths spell the same file differently are refused at the second one (card F04l)", async () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "sub"));
    const spelled = `${join(dir, "sub")}/../db.sqlite`;
    assert.notEqual(spelled, join(dir, "db.sqlite"), "the two entries really do spell the path differently");
    await assert.rejects(
      sqliteTargetsFromConfig([
        { name: "one", kind: "sqlite", path: spelled },
        { name: "two", kind: "sqlite", path: join(dir, "db.sqlite") },
      ], deps),
      (error: Error) => error.message === "transfer targets[1]: path: is the same place as entry 0",
    );
  } finally { done(dir); }
});

test("two entries naming two different files are both accepted, however their paths are spelled (card F04l)", async () => {
  const dir = temp();
  try {
    mkdirSync(join(dir, "sub"));
    const targets = await sqliteTargetsFromConfig([
      { name: "one", kind: "sqlite", path: `${join(dir, "sub")}/../one.sqlite` },
      { name: "two", kind: "sqlite", path: join(dir, "two.sqlite") },
    ], deps);
    assert.deepEqual(targets.map((t) => t.name), ["one", "two"]);
    assert.notEqual(targets[0]!.fingerprint, targets[1]!.fingerprint);
  } finally { done(dir); }
});

test("more than 16 entries are refused; exactly 16 are accepted (card F04l)", async () => {
  const entry = (i: number) => ({ name: `t${i}`, kind: "sqlite", path: join(tmpdir(), `nn-tgts-t${i}.sqlite`) });
  await assert.rejects(sqliteTargetsFromConfig(Array.from({ length: 17 }, (_, i) => entry(i)), deps), /at most 16/);
  const ok = await sqliteTargetsFromConfig(Array.from({ length: 16 }, (_, i) => entry(i)), deps);
  assert.equal(ok.length, 16);
});

test("freeBytes reads the file system the database will be on (card F04l)", async () => {
  const dir = temp();
  try {
    const targets = await sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path: join(dir, "db.sqlite") }], deps);
    const free = await targets[0]!.freeBytes!();
    assert.ok(typeof free === "number" && free > 0, "a real file system answers in bytes");
  } finally { done(dir); }
});

test("freeBytes of a path whose folder does not exist yet probes the nearest existing parent, and answers nothing when the file system cannot be read (card F04l)", async () => {
  const dir = temp();
  try {
    const probed: string[] = [];
    const probeDeps: SqliteTargetDeps = { openStorage: deps.openStorage, statfs: async (p) => { probed.push(p); return existsSync(p) ? statfs(p) : enoent(p); } };
    const targets = await sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path: join(dir, "not", "yet", "db.sqlite") }], probeDeps);
    const free = await targets[0]!.freeBytes!();
    assert.ok(typeof free === "number" && free > 0, "the parent's file system answers");
    const real = await canon(dir);
    assert.deepEqual(probed, [join(real, "not", "yet"), join(real, "not"), real], "the missing folders first, then their nearest existing parent");
    const failDeps: SqliteTargetDeps = { openStorage: deps.openStorage, statfs: async () => { throw new Error("permission denied"); } };
    const unreadable = await sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path: join(dir, "db.sqlite") }], failDeps);
    assert.equal(await unreadable[0]!.freeBytes!(), undefined, "a file system that cannot be read answers nothing, not a guess");
  } finally { done(dir); }
});

test("a path that cannot be resolved, or is too long or holds a NUL, is refused with the entry named and without echoing the path (card F04l)", async () => {
  for (const path of [join(tmpdir(), "x".repeat(5000)), join(tmpdir(), "a\0b")]) {
    await assert.rejects(
      sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path }], deps),
      (error: Error) => error.message.includes("targets[0]") && error.message.includes("path") && !error.message.includes("xxxx") && !error.message.includes("a\0b"),
    );
  }
});

test("a field name with control characters is shown without them, and a non-string name is refused (card F04l)", async () => {
  await assert.rejects(
    sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path: join(tmpdir(), "nn-tgts-k.sqlite"), "bad\nkey\u001b[31m": 1 }], deps),
    (error: Error) => !/[\u0000-\u001f]/.test(error.message),
  );
  await assert.rejects(sqliteTargetsFromConfig([{ name: 7, kind: "sqlite", path: join(tmpdir(), "nn-tgts-n.sqlite") }], deps), /targets\[0\].*name/);
});

test("free space survives a statfs that fails with no error object (card F04l)", async () => {
  const dir = temp();
  try {
    const [t] = await sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path: join(dir, "db.sqlite") }], { ...deps, statfs: () => Promise.reject(null) });
    assert.equal(await t!.freeBytes!(), undefined);
  } finally { done(dir); }
});

test("a path the file system cannot resolve is refused as such, naming the entry and not echoing the path (card F04l)", { skip: process.platform === "win32" ? "Windows does not fail a 300-character name the way POSIX does" : false }, async () => {
  const path = join(tmpdir(), "y".repeat(300), "db.sqlite");
  await assert.rejects(
    sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path }], deps),
    (error: Error) => error.message.includes("targets[0]") && error.message.includes("cannot be resolved") && !error.message.includes("yyyy"),
  );
});

// ------------------------------------------------------------------------------- PostgreSQL entries (card F04l)

const ADDRESS = "postgres://nnuser:hunter2%2Fx@db.example.com:5433/nimble?sslmode=require";
const pgDeps = (over: Partial<NonNullable<SqliteTargetDeps["postgres"]>> = {}): SqliteTargetDeps => ({
  ...deps,
  postgres: {
    resolveSecret: async (name) => (name === "transfer.pg-url" ? ADDRESS : undefined),
    openStorage: async () => { throw new Error(`could not connect to ${ADDRESS}: password hunter2/x was refused for nnuser`); },
    databaseBytes: async () => 1_000,
    dropSchema: async () => undefined,
    schemaExists: async () => false,
    ...over,
  },
});
const pgEntry = (over: Record<string, unknown> = {}) => ({ name: "main-pg", kind: "postgres", url: { secret: "transfer.pg-url" }, ...over });

test("a PostgreSQL entry builds a target from a secret reference: the place is host, port, database and schema, never the user or password (card F04l)", async () => {
  const [t] = await sqliteTargetsFromConfig([pgEntry({ schema: "nn_b" })], pgDeps());
  assert.equal(t!.kind, "postgres");
  assert.equal(t!.name, "main-pg");
  assert.equal(t!.fingerprint, "postgres:db.example.com:5433/nimble#nn_b");
  assert.ok(!t!.fingerprint.includes("hunter2") && !t!.fingerprint.includes("nnuser"));
  const [d] = await sqliteTargetsFromConfig([pgEntry()], pgDeps());
  assert.equal(d!.fingerprint, "postgres:db.example.com:5433/nimble#nimblenewt", "the schema defaults to nimblenewt");
});

test("a PostgreSQL entry that is not a secret reference is refused and the address is not echoed; so is everything else malformed (card F04l)", async () => {
  const bad = async (entry: unknown, ...parts: string[]): Promise<Error> => {
    let caught: Error | undefined;
    await assert.rejects(sqliteTargetsFromConfig([entry], pgDeps()), (error: Error) => { caught = error; return parts.every((p) => error.message.includes(p)); });
    for (const leak of ["hunter2", "nnuser", "db.example.com", "postgres://"]) assert.ok(!caught!.message.includes(leak), `${leak} is not in "${caught!.message}"`);
    return caught!;
  };
  await bad(pgEntry({ url: ADDRESS }), "targets[0]", "url", "secret reference");
  await bad(pgEntry({ url: undefined }), "targets[0]", "url");
  await bad(pgEntry({ url: { secret: "a", extra: ADDRESS } }), "targets[0]", "url");
  await bad(pgEntry({ url: { secret: "bad name" } }), "targets[0]", "url");
  await bad(pgEntry({ url: { secret: "a__b" } }), "targets[0]", "url");
  await bad(pgEntry({ schema: "Bad-Schema" }), "targets[0]", "schema");
  await bad(pgEntry({ schema: 7 }), "targets[0]", "schema");
  await bad(pgEntry({ maxBytes: 0 }), "targets[0]", "maxBytes");
  await bad(pgEntry({ maxBytes: 1.5 }), "targets[0]", "maxBytes");
  await bad(pgEntry({ maxBytes: "1000" }), "targets[0]", "maxBytes");
  await bad(pgEntry({ path: "/srv/x.sqlite" }), "targets[0]", "path", "postgres");
  await bad({ name: "one", kind: "sqlite", path: join(tmpdir(), "nn-pg-s.sqlite"), schema: "x" }, "targets[0]", "schema");
  await bad(pgEntry({ name: "Main" }), "targets[0]", "name");
});

test("an unavailable secret stops the build and names the secret, not its value; so does a value that is not a PostgreSQL address (card F04l)", async () => {
  await assert.rejects(sqliteTargetsFromConfig([pgEntry({ url: { secret: "other.secret" } })], pgDeps()), (error: Error) => error.message === "transfer targets[0]: url: the secret other.secret is not available");
  await assert.rejects(sqliteTargetsFromConfig([pgEntry()], pgDeps({ resolveSecret: async () => "" })), /is not available/);
  await assert.rejects(sqliteTargetsFromConfig([pgEntry()], pgDeps({ resolveSecret: async () => { throw new Error(`store said ${ADDRESS}`); } })), (error: Error) => error.message === "transfer targets[0]: url: the secret transfer.pg-url could not be read");
  await assert.rejects(sqliteTargetsFromConfig([pgEntry()], pgDeps({ resolveSecret: async () => "mysql://u:p@h/db" })), (error: Error) => /does not hold a postgres:\/\/ address/.test(error.message) && !error.message.includes("mysql"));
  await assert.rejects(sqliteTargetsFromConfig([pgEntry()], pgDeps({ resolveSecret: async () => "postgres:///nodatabase-or-server" })), (error: Error) => /readable PostgreSQL address/.test(error.message) && !error.message.includes("nodatabase"));
  await assert.rejects(sqliteTargetsFromConfig([pgEntry()], deps), /targets\[0\]: kind: "postgres" targets cannot be built here/);
});

test("two entries for one PostgreSQL place (same server, database and schema) or one name are refused at the second, also across kinds (card F04l)", async () => {
  await assert.rejects(sqliteTargetsFromConfig([pgEntry(), pgEntry({ name: "again" })], pgDeps()), (error: Error) => error.message === "transfer targets[1]: url: is the same place as entry 0");
  const ok = await sqliteTargetsFromConfig([pgEntry(), pgEntry({ name: "other-schema", schema: "nn_b" })], pgDeps());
  assert.equal(ok.length, 2);
  await assert.rejects(sqliteTargetsFromConfig([{ name: "main-pg", kind: "sqlite", path: join(tmpdir(), "nn-pg-n.sqlite") }, pgEntry()], pgDeps()), /targets\[1\]: name: main-pg is used by another entry/);
});

test("whatever the open, the size read or the drop fails with, the address, its password and its user are hidden from the text (card F04l)", async () => {
  const boom = (): never => { throw new Error(`failed for ${ADDRESS} pass hunter2/x also hunter2%2Fx and postgresql://other:pw@h/d`); };
  const [t] = await sqliteTargetsFromConfig([pgEntry({ maxBytes: 5_000 })], pgDeps({ databaseBytes: boom, dropSchema: boom }));
  for (const [what, run] of [["open", () => t!.open()], ["freeBytes", () => t!.freeBytes!()], ["discard", () => t!.discard!()]] as const) {
    await assert.rejects(run(), (error: Error) => {
      for (const leak of ["hunter2", "db.example.com", "postgres://", "postgresql://", "pw@h"]) assert.ok(!error.message.includes(leak), `${what}: ${leak} is not in "${error.message}"`);
      assert.match(error.message, /failed for|could not connect/);
      assert.equal(error.stack?.includes("hunter2"), false, `${what}: the stack does not carry it either`);
      return true;
    });
  }
  assert.equal(t!.redact!(`x ${ADDRESS} y hunter2/x`), "x [address hidden] y [address hidden]");
});

test("freeBytes of a PostgreSQL entry is the cap less the server's size, never below zero, and nothing without a cap (card F04l)", async () => {
  const sized = (bytes: number) => pgDeps({ databaseBytes: async () => bytes });
  const [a] = await sqliteTargetsFromConfig([pgEntry({ maxBytes: 10_000 })], sized(2_500));
  assert.equal(await a!.freeBytes!(), 7_500);
  const [b] = await sqliteTargetsFromConfig([pgEntry({ maxBytes: 10_000 })], sized(12_000));
  assert.equal(await b!.freeBytes!(), 0);
  let asked = 0;
  const [c] = await sqliteTargetsFromConfig([pgEntry()], pgDeps({ databaseBytes: async () => { asked++; return 1; } }));
  assert.equal(await c!.freeBytes!(), undefined);
  assert.equal(asked, 0, "without a cap the server is not asked");
});

test("a failed copy drops a PostgreSQL schema only when this target's open created it; a schema that was there before is never dropped (card F04l)", async () => {
  const dropped: string[] = [];
  const asked: string[] = [];
  const build = async (exists: boolean) => (await sqliteTargetsFromConfig([pgEntry({ schema: "nn_x" })], pgDeps({
    openStorage: async () => ({}) as never, dropSchema: async (_u, schema) => { dropped.push(schema); }, schemaExists: async (_u, schema) => { asked.push(schema); return exists; },
  })))[0]!;
  const before = await build(true);
  await assert.rejects(before.discard!(), /nn_x existed before this controller opened it, so it is not dropped/);
  await before.open();
  await before.open();
  await assert.rejects(before.discard!(), (e: Error) => /not dropped/.test(e.message) && !e.message.includes("hunter2") && !e.message.includes("db.example.com"));
  assert.deepEqual(dropped, [], "an existing schema (public, one prepared by the owner, another installation's) is left alone");
  assert.deepEqual(asked, ["nn_x", "nn_x"], "every open asks until one finds the schema absent");
  const fresh = await build(false);
  await assert.rejects(fresh.discard!(), /not dropped/, "nothing was opened yet, so nothing was created");
  await fresh.open();
  await fresh.discard!();
  await fresh.discard!();
  assert.deepEqual(dropped, ["nn_x", "nn_x"], "the schema its own open created is dropped (and again after a later failed copy)");
});
