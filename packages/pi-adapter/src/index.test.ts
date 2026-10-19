import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { test } from "node:test";
import { Harness, createRegistry } from "@earendil-works/pi-durable";
import { PINNED_PI_DURABLE_VERSION } from "./index.js";

test("installed Pi Durable matches the adapter pin", () => {
  const require = createRequire(import.meta.url);
  const manifest = JSON.parse(readFileSync(require.resolve("@earendil-works/pi-durable/package.json"), "utf8")) as { version: string };
  assert.equal(manifest.version, PINNED_PI_DURABLE_VERSION);
});

test("Pi Durable runtime exports the entry points the adapter builds on", () => {
  assert.equal(typeof Harness.open, "function");
  assert.equal(typeof createRegistry, "function");
});
