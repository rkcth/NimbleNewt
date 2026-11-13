import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DatabaseSync } from "node:sqlite";
import { classify } from "./errors.js";
import { isDiskFull } from "../../retention/index.js";

// Card K06c: a REAL "database or disk is full" error from SQLite (a database limited to a few pages, so the engine itself refuses the write) goes through the adapter's own error conversion and is recognised as a full disk, so the guard keeps only records the recovery needs.
// A real full file system cannot be made portably in a test (it needs a small dedicated volume); the engine's own error is the same code the full disk raises (SQLITE_FULL), reached through the same conversion.
test("a real SQLite 'database or disk is full' error is classified by the adapter and recognised as a full disk; other failures are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-k06c-full-"));
  const db = new DatabaseSync(join(dir, "full.sqlite"));
  try {
    db.exec("CREATE TABLE t (v TEXT)");
    db.exec(`PRAGMA max_page_count = ${(db.prepare("PRAGMA page_count").get() as { page_count: number }).page_count + 4}`);
    let caught: unknown;
    try { for (let i = 0; i < 1000; i++) db.prepare("INSERT INTO t VALUES (?)").run("x".repeat(4000)); } catch (error) { caught = error; }
    assert.ok(caught instanceof Error, "the engine refused a write");
    assert.match(String((caught as Error).message), /full/i);
    const converted = classify(caught);
    assert.equal(converted.kind, "unavailable");
    assert.equal(isDiskFull(converted), true, "recognised through the adapter's conversion");
    assert.equal(isDiskFull(caught), true);
    assert.equal(isDiskFull(classify(new Error("something else"))), false);
    assert.equal(isDiskFull(Object.assign(new Error("x"), { code: "ENOSPC" })), true);
  } finally { db.close(); rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
