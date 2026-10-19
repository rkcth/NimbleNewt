import assert from "node:assert/strict";
import { cpSync, mkdtempSync, rmSync, writeFileSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { checkBoundaries } from "./package-boundaries.mjs";

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
