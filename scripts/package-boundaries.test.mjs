import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkBoundaries, DATABASE_FOLDERS } from "./package-boundaries.mjs";

const realPackages = fileURLToPath(new URL("../packages/", import.meta.url));

function fixture(mutate) {
  const dir = mkdtempSync(join(tmpdir(), "nn boundaries-"));
  cpSync(realPackages, dir, { recursive: true, filter: (src) => !src.includes("node_modules") && !src.endsWith("dist") });
  try { mutate(dir); return checkBoundaries(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}
const editManifest = (dir, pkg, fn) => {
  const path = join(dir, pkg, "package.json");
  const manifest = JSON.parse(readFileSync(path, "utf8"));
  fn(manifest);
  writeFileSync(path, JSON.stringify(manifest));
};

test("the real repository satisfies the boundaries", () => {
  assert.deepEqual(checkBoundaries(realPackages), []);
});

test("rejects an undeclared import of another workspace package", () => {
  const errors = fixture((d) => appendFileSync(join(d, "pi-adapter/src/index.ts"), 'export * as c from "@nimblenewt/controller";\n'));
  assert.ok(errors.some((e) => e.includes("imports @nimblenewt/controller")), errors.join("\n"));
});

test("rejects forbidden and unpinned devDependencies", () => {
  const errors = fixture((d) => editManifest(d, "pi-adapter", (m) => { m.devDependencies = { "@nimblenewt/controller": "0.0.0", "left-pad": "^1.0.0" }; }));
  assert.ok(errors.some((e) => e.includes("devDependencies entry @nimblenewt/controller")));
  assert.ok(errors.some((e) => e.includes("devDependencies entry left-pad")));
});

test("rejects a forbidden dependency and a range pin", () => {
  const errors = fixture((d) => editManifest(d, "contracts", (m) => { m.dependencies = { "@earendil-works/pi-durable": "^1.3.0" }; }));
  assert.ok(errors.some((e) => e.includes("not allowed")));
  assert.ok(errors.some((e) => e.includes("exact version")));
});

test("rejects tsconfig references that disagree with dependencies", () => {
  const errors = fixture((d) => writeFileSync(join(d, "pi-adapter/tsconfig.json"), JSON.stringify({ references: [] })));
  assert.ok(errors.some((e) => e.includes("tsconfig references do not include")));
});

test("ignores stray files and reports directories without a manifest", () => {
  const errors = fixture((d) => { writeFileSync(join(d, ".DS_Store"), ""); cpSync(join(d, "ui"), join(d, "empty"), { recursive: true }); rmSync(join(d, "empty/package.json")); });
  assert.deepEqual(errors, ["empty: missing package.json"]);
});

test("reports a tsconfig that is not plain JSON instead of crashing", () => {
  const errors = fixture((d) => writeFileSync(join(d, "ui/tsconfig.json"), '// comment\n{ "references": [] }'));
  assert.deepEqual(errors, ["ui: tsconfig.json must be plain JSON (no comments or trailing commas)"]);
});

test("error messages name the file relative to packages/", () => {
  const errors = fixture((d) => appendFileSync(join(d, "pi-adapter/src/index.ts"), 'export * as c from "@nimblenewt/controller";\n'));
  assert.ok(errors.some((e) => e.startsWith("pi-adapter: pi-adapter") && e.includes("index.ts imports")), errors.join("\n"));
});

// ---- F04a: SQL and database drivers stay inside the two adapter folders ----------------------------------------

const addSource = (d, path, text) => { mkdirSync(join(d, path, ".."), { recursive: true }); writeFileSync(join(d, path), text); };

test("rejects SQL text and database drivers in domain code", () => {
  const cases = [
    ["controller/src/domain/tasks.ts", 'export const q = "SELECT id, body FROM tasks WHERE id = ?";\n'],
    ["controller/src/domain/tasks.ts", 'export const q = `INSERT INTO tasks (id) VALUES (1)`;\n'],
    ["controller/src/domain/tasks.ts", 'db.exec("CREATE TABLE t (id TEXT)");\n'],
    ["api/src/x.ts", 'import { DatabaseSync } from "node:sqlite";\n'],
    ["api/src/x.ts", 'import pg from "pg";\n'],
    ["worker/src/x.ts", 'import Database from "better-sqlite3";\n'],
    ["controller/src/storage/memory.ts", 'import { Client } from "pg/lib/client";\n'],
    ["controller/src/storage/sqlite-notes.ts", 'export const q = "DELETE FROM x";\n'],
    ["controller/src/domain/a.ts", 'const q = "UPDATE tasks SET state = 1";\n'],
    ["controller/src/domain/a.ts", "const q = 'insert into tasks values (1)';\n"],
    ["controller/src/domain/a.ts", 'const q = `INSERT INTO t VALUES (1) ON CONFLICT DO NOTHING`;\n'],
    ["controller/src/domain/a.ts", 'const q = `\n  select id\n  from tasks`;\nconst r = "select id from tasks";\n'],
    ["controller/src/domain/a.ts", 'const q = "merge into t using s";\n'],
  ];
  for (const [path, text] of cases) {
    const errors = fixture((d) => addSource(d, path, text));
    assert.ok(errors.some((e) => e.includes(path.split("/").slice(1).join("/")) && /contains SQL|database driver/.test(e)), `${path}: ${text}\n${errors.join("\n")}`);
  }
});

test("allows SQL and drivers inside the adapter folders, and ordinary words elsewhere", () => {
  for (const folder of DATABASE_FOLDERS) {
    const errors = fixture((d) => addSource(d, `${folder}x.ts`, 'import { DatabaseSync } from "node:sqlite";\nexport const q = "SELECT a FROM t";\n'));
    assert.deepEqual(errors.filter((e) => /contains SQL|database driver/.test(e)), [], folder);
  }
  const errors = fixture((d) => addSource(d, "controller/src/domain/words.ts", "// select the rows from the list; insert into the queue; delete from memory; update the doc and set it\n/* it's fine to say update x set y */\nexport const x = \"choose the best from the menu\";\n"));
  assert.deepEqual(errors.filter((e) => /contains SQL/.test(e)), []);
});
