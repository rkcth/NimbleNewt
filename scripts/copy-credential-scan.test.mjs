import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { COPIES, build } from "./copy-credential-scan.mjs";

test("the copies of the credential scanner in contracts and config are current", () => {
  const text = build();
  for (const c of COPIES) assert.equal(readFileSync(fileURLToPath(new URL(`../packages/${c}`, import.meta.url)), "utf8"), text, `${c} is stale: run node scripts/copy-credential-scan.mjs`);
});
