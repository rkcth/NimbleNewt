import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { statfs } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { canon } from "../backup/canon.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { databaseSizeFrom, discardPostgresTransferCopy, dropPostgresSchema } from "../storage/postgres/index.js";
import { hideAddress, postgresFingerprint, sqliteFingerprint, sqliteTargetsFromConfig, storageFollowingAuthority, writeAuthority, type SqliteTargetDeps } from "./index.js";
import { writeFile } from "node:fs/promises";

const deps: SqliteTargetDeps = { openStorage: (path) => SqliteStorage.open({ path }), statfs };
const enoent = (p: string): never => { const e: NodeJS.ErrnoException = new Error(`enoent: ${p}`); e.code = "ENOENT"; throw e; };
const temp = (): string => mkdtempSync(join(tmpdir(), "nn-tgts-"));
const done = (dir: string): void => { rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); };

test("configuration entries become working SQLite targets: names, fingerprints, an openable store, a discard that removes only a left-over copy (cards F04l, F04m)", async () => {
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
    const store = await targets[0]!.open();
    await store.close();
    assert.ok(existsSync(one), "open() made a SQLite database at the entry's path");
    // An empty file no controller owned (or the pending copy of the named transfer) is removed with its journal files; a database a controller used never is.
    await targets[0]!.discard!("xfer-1", { leftover: true });
    assert.equal(existsSync(one), false, "an empty destination file is removed");
    const used = await targets[0]!.open();
    await used.acquireEpoch({ holder: "controller", at: "2026-11-10T10:00:00.000Z" });
    await used.close();
    await assert.rejects(targets[0]!.discard!("xfer-1", { leftover: true }), /another copy or a database in use/);
    assert.ok(existsSync(one), "a database a controller owned stays");
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
    discardCopy: async () => undefined,
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
  // The secret here resolves: only the extra field makes this a refusal.
  const extra = await bad(pgEntry({ url: { secret: "transfer.pg-url", extra: "extra-value-x" } }), "targets[0]", "url", "secret reference");
  assert.ok(!extra.message.includes("extra-value-x"), "the extra value is not echoed");
  await bad(pgEntry({ url: { secret: "bad name" } }), "targets[0]", "url", "secret reference");
  await bad(pgEntry({ url: { secret: "a__b" } }), "targets[0]", "url", "secret reference");
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
  await assert.rejects(sqliteTargetsFromConfig([pgEntry(), { name: "main-pg", kind: "sqlite", path: join(tmpdir(), "nn-pg-n.sqlite") }], pgDeps()), /targets\[1\]: name: main-pg is used by another entry/, "a PostgreSQL entry's name is taken too");
});

test("whatever the open, the size read or the drop fails with, the address, its password and its user are hidden from the text (card F04l)", async () => {
  const boom = (): never => { throw new Error(`failed for ${ADDRESS} pass hunter2/x also hunter2%2Fx and postgresql://other:pw@h/d`); };
  const [t] = await sqliteTargetsFromConfig([pgEntry({ maxBytes: 5_000 })], pgDeps({ databaseBytes: boom, discardCopy: boom }));
  // A second target whose open created the schema, so its discard reaches the drop.
  const [d] = await sqliteTargetsFromConfig([pgEntry()], pgDeps({ openStorage: async () => ({ createdSchema: true }) as never, discardCopy: boom }));
  await d!.open();
  for (const [what, run] of [["open", () => t!.open()], ["freeBytes", () => t!.freeBytes!()], ["discard", () => d!.discard!("xfer-t")]] as const) {
    await assert.rejects(run(), (error: Error) => {
      for (const leak of ["hunter2", "db.example.com", "postgres://", "postgresql://", "pw@h"]) assert.ok(!error.message.includes(leak), `${what}: ${leak} is not in "${error.message}"`);
      assert.match(error.message, /failed for|could not connect/);
      assert.equal(error.stack?.includes("hunter2"), false, `${what}: the stack does not carry it either`);
      return true;
    });
  }
  assert.equal(t!.redact!(`x ${ADDRESS} y hunter2/x`), "x [address hidden] y [address hidden]");
  // The user name goes with the password it stands beside ("user:password@" is hidden together, not just the password).
  assert.equal(hideAddress("x nnuser:hunter2%2Fx@db y", ADDRESS), "x [address hidden]db y");
  // A password the URL keeps as written ("&" is not encoded in the user:password part) is hidden in its encoded spelling too.
  assert.equal(hideAddress("a&b a%26b", "postgres://u:a&b@h/d"), "[address hidden] [address hidden]");
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

/** A fake PostgreSQL server for the drop rule: one schema, which this target's open, the owner, or nobody may have created. */
function fakeServer() {
  const server = { exists: false, dropped: [] as string[], holders: [] as string[], failNextOpen: undefined as string | undefined };
  const deps = pgDeps({
    openStorage: async () => {
      if (server.failNextOpen !== undefined) { const reason = server.failNextOpen; server.failNextOpen = undefined; throw new Error(reason); }
      const createdSchema = !server.exists;
      server.exists = true;
      return { createdSchema } as never;
    },
    discardCopy: async (_u, schema, holder) => { server.dropped.push(schema); server.holders.push(holder); server.exists = false; },
  });
  return { server, build: async () => (await sqliteTargetsFromConfig([pgEntry({ schema: "nn_x" })], deps))[0]! };
}

test("a failed copy drops a PostgreSQL schema only when this target's own open created it; a schema that was there before is never dropped (card F04l)", async () => {
  const before = fakeServer();
  before.server.exists = true;
  const t = await before.build();
  await assert.rejects(t.discard!("xfer-t"), /nn_x was not created by this controller's own open, so it is not dropped/);
  await t.open();
  await t.open();
  await assert.rejects(t.discard!("xfer-t"), (e: Error) => /not dropped/.test(e.message) && !e.message.includes("hunter2") && !e.message.includes("db.example.com"));
  assert.deepEqual(before.server.dropped, [], "an existing schema (public, one prepared by the owner, another installation's) is left alone");
  const fresh = fakeServer();
  const f = await fresh.build();
  await assert.rejects(f.discard!("xfer-t"), /not dropped/, "nothing was opened yet, so nothing was created");
  await f.open();
  await f.open(); // the apply opens the schema the preview created: still this target's
  await f.discard!("xfer-t");
  assert.deepEqual(fresh.server.dropped, ["nn_x"], "the schema its own open created is dropped");
  await assert.rejects(f.discard!("xfer-t"), /not dropped/, "after the drop nothing is claimed until an open creates the schema again");
  await f.open();
  await f.discard!("xfer-t");
  assert.deepEqual(fresh.server.dropped, ["nn_x", "nn_x"], "an open that created it again makes it droppable again");
  assert.deepEqual(fresh.server.holders, ["transfer-pending:xfer-t", "transfer-pending:xfer-t"], "the drop is told which transfer's copy it may remove");
});

test("an open that fails claims nothing: a schema someone else makes afterwards is not dropped (card F04l)", async () => {
  const { server, build } = fakeServer();
  const t = await build();
  server.failNextOpen = "connection reset";
  await assert.rejects(t.open(), /connection reset/);
  server.exists = true; // the owner creates the schema, with grants or objects of their own
  await t.open();
  await assert.rejects(t.discard!("xfer-t"), /not dropped/);
  assert.deepEqual(server.dropped, []);
});

test("after a drop, a schema of the same name made by someone else is not dropped by the next failed copy (card F04l)", async () => {
  const { server, build } = fakeServer();
  const t = await build();
  await t.open();
  await t.discard!("xfer-t");
  server.exists = true; // someone else creates it
  await t.open();
  await assert.rejects(t.discard!("xfer-t"), /not dropped/);
  assert.deepEqual(server.dropped, ["nn_x"], "only the schema this target created");
});

test("an address with a password as a query parameter is refused without echoing it, and hideAddress hides such a password anyway (card F04l)", async () => {
  for (const address of ["postgres://nnuser@db.example.com/nimble?password=qp-secret", "postgres://nnuser:pw@db.example.com/nimble?sslmode=require&sslpassword=qp-secret", "postgres://nnuser@db.example.com/nimble?PASSWORD=qp-secret"]) {
    await assert.rejects(sqliteTargetsFromConfig([pgEntry()], pgDeps({ resolveSecret: async () => address })), (error: Error) =>
      error.message === "transfer targets[0]: url: the secret transfer.pg-url holds a password as a query parameter (password= or sslpassword=); put the password in the user:password@ part of the address");
  }
  for (const [address, secret] of [["postgres://u@h/db?password=qp-secret", "qp-secret"], ["postgres://u@h/db?sslpassword=a%20b%2Fc", "a b/c"], ["postgres://u@h/db?password=a+b", "a b"]] as const) {
    const out = hideAddress(`said ${secret} and ${encodeURIComponent(secret)} and ${new URLSearchParams([["p", secret]]).toString().slice(2)}`, address);
    assert.equal(out, "said [address hidden] and [address hidden] and [address hidden]", address);
  }
});

test("a failure whose message holds no address is rethrown without its stack or other properties, which may hold it (card F04l)", async () => {
  const sneaky = (): never => {
    const e = new Error("the server said no") as Error & { detail?: string; extra?: string };
    e.detail = `while connecting to ${ADDRESS}`; e.extra = "hunter2/x"; e.stack = `Error: the server said no\n    at ${ADDRESS} hunter2/x`;
    throw e;
  };
  const [t] = await sqliteTargetsFromConfig([pgEntry({ maxBytes: 5_000 })], pgDeps({ openStorage: sneaky, databaseBytes: sneaky }));
  for (const run of [() => t!.open(), () => t!.freeBytes!()]) {
    await assert.rejects(run(), (error: Error) => {
      assert.equal(error.message, "the server said no");
      assert.deepEqual(Object.keys(error), [], "no extra property is carried over");
      assert.ok(!(error.stack ?? "").includes("hunter2") && !(error.stack ?? "").includes("db.example.com"), "the original stack is not carried over");
      return true;
    });
  }
});

test("the server's size answer must be a whole number of bytes: anything else is an error, never a NaN that passes every room check (card F04l)", () => {
  assert.equal(databaseSizeFrom("12345"), 12_345);
  assert.equal(databaseSizeFrom("0"), 0);
  for (const answer of [undefined, null, "", "abc", "NaN", "-5", "1e3", "9".repeat(400), 12]) assert.throws(() => databaseSizeFrom(answer), /did not report a database size/, String(answer).slice(0, 20));
});

test("the schema drop refuses a name it could not place in its statement safely, before it connects anywhere (card F04l)", async () => {
  for (const schema of ["x; drop database nimble", "Public", "a-b", "", `a${"b".repeat(41)}`]) {
    await assert.rejects(dropPostgresSchema("postgres://u:p@127.0.0.1:1/none", schema), /invalid PostgreSQL schema name/);
    await assert.rejects(discardPostgresTransferCopy("postgres://u:p@127.0.0.1:1/none", schema, "transfer-pending:x"), /invalid PostgreSQL schema name/);
  }
});

test("the restart hand-over: the configured destination the authority file names is where the start goes; anything else is left to the start guard (card F04m)", async () => {
  const dir = temp();
  try {
    const state = join(dir, "state");
    const home = join(dir, "home.sqlite");
    const moved = join(dir, "moved.sqlite");
    const PASSWORD = "nn-secret-pw-91";
    const address = `postgres://svc:${PASSWORD}@db.internal:5432/nn`;
    const asked: string[] = [];
    const secret = async (name: string): Promise<string | undefined> => { asked.push(name); return name === "pg-url" ? address : undefined; };
    const entries = [
      "junk", null, { name: "bad", kind: "sqlite", path: "relative.sqlite" }, { name: "pg", kind: "postgres", url: { secret: "pg-url" }, schema: "other" }, { name: "pg-missing", kind: "postgres", url: { secret: "none" } },
      { name: "moved", kind: "sqlite", path: moved },
    ];
    const home0 = { kind: "sqlite", path: home } as const;
    // No authority file: the configured database.
    assert.deepEqual(await storageFollowingAuthority(home0, entries, state, secret), { storage: home0 });
    const at = "2026-11-13T00:00:00.000Z";
    const place = async (path: string, name: string) => ({ kind: "sqlite" as const, fingerprint: await sqliteFingerprint(path), name });
    // It names the configured database (after a rollback): nothing to follow.
    await writeAuthority(state, { format: 1, generation: 1, active: await place(home, "the SQLite database"), since: at });
    assert.deepEqual(await storageFollowingAuthority(home0, entries, state, secret), { storage: home0 });
    // It names a configured SQLite destination.
    await writeAuthority(state, { format: 1, generation: 2, active: await place(moved, "moved"), transferId: "x1", since: at });
    assert.deepEqual(await storageFollowingAuthority(home0, entries, state, secret), { storage: { kind: "sqlite", path: moved }, movedTo: { name: "moved", kind: "sqlite" } });
    // It names a place no entry has: left alone for the guard to refuse. No entries at all: the same.
    await writeAuthority(state, { format: 1, generation: 3, active: await place(join(dir, "stranger.sqlite"), "stranger"), transferId: "x2", since: at });
    assert.deepEqual(await storageFollowingAuthority(home0, entries, state, secret), { storage: home0 });
    assert.deepEqual(await storageFollowingAuthority(home0, undefined, state, secret), { storage: home0 });
    // It names a configured PostgreSQL destination: the address is resolved to compare and used for the start, and shown nowhere else; the schema is part of the place.
    await writeAuthority(state, { format: 1, generation: 4, active: { kind: "postgres", fingerprint: postgresFingerprint(address, "other"), name: "pg" }, transferId: "x3", since: at });
    const pg = await storageFollowingAuthority({ kind: "postgres", url: "postgres://u:p@elsewhere:5432/d", maxConnections: 7 }, entries, state, secret);
    assert.deepEqual(pg, { storage: { kind: "postgres", url: address, schema: "other", maxConnections: 7 }, movedTo: { name: "pg", kind: "postgres" } });
    assert.ok(!JSON.stringify(pg.movedTo).includes(PASSWORD));
    await writeAuthority(state, { format: 1, generation: 5, active: { kind: "postgres", fingerprint: postgresFingerprint(address, "nimblenewt"), name: "pg" }, transferId: "x4", since: at });
    assert.deepEqual(await storageFollowingAuthority(home0, entries, state, secret), { storage: home0 }, "another schema is another place");
    // A file that was changed by anything else is refused, not followed.
    await writeAuthority(state, { format: 1, generation: 6, active: await place(moved, "moved"), transferId: "x5", since: at });
    const file = join(state, "storage-authority.json");
    const text = (await import("node:fs")).readFileSync(file, "utf8").replace(/"generation": 6/, '"generation": 60');
    await writeFile(file, text);
    await assert.rejects(storageFollowingAuthority(home0, entries, state, secret), /integrity mark/);
  } finally { done(dir); }
});
