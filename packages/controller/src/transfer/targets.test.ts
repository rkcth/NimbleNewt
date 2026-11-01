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
      { name: "one", kind: "sqlite", path: "/srv/a.sqlite" },
      { name: "one", kind: "sqlite", path: "/srv/b.sqlite" },
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
  const entry = (i: number) => ({ name: `t${i}`, kind: "sqlite", path: `/srv/t${i}.sqlite` });
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
    assert.deepEqual(probed, [join(dir, "not", "yet"), join(dir, "not"), dir], "the missing folders first, then their nearest existing parent");
    const failDeps: SqliteTargetDeps = { openStorage: deps.openStorage, statfs: async () => { throw new Error("permission denied"); } };
    const unreadable = await sqliteTargetsFromConfig([{ name: "one", kind: "sqlite", path: join(dir, "db.sqlite") }], failDeps);
    assert.equal(await unreadable[0]!.freeBytes!(), undefined, "a file system that cannot be read answers nothing, not a guess");
  } finally { done(dir); }
});
