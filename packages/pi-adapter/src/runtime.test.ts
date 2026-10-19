import assert from "node:assert/strict";
import { test } from "node:test";
import { MINIMUM_NODE_VERSION, PINNED_PI_DURABLE_VERSION, UnsupportedRuntimeError, assertSupportedRuntime, detectRuntime } from "./index.js";

const supported = { piDurableVersion: PINNED_PI_DURABLE_VERSION, nodeVersion: MINIMUM_NODE_VERSION };

test("the installed runtime is supported", () => {
  assert.doesNotThrow(() => assertSupportedRuntime());
  assert.equal(detectRuntime().piDurableVersion, PINNED_PI_DURABLE_VERSION);
});

test("accepts the minimum Node and newer", () => {
  for (const nodeVersion of ["22.19.0", "22.23.1", "24.21.0", "26.7.0"]) assert.doesNotThrow(() => assertSupportedRuntime({ ...supported, nodeVersion }));
});

test("rejects older Node, naming the requirement", () => {
  for (const nodeVersion of ["22.18.9", "20.19.0", "18.0.0"]) {
    assert.throws(() => assertSupportedRuntime({ ...supported, nodeVersion }), (e) => e instanceof UnsupportedRuntimeError && e.message.includes(MINIMUM_NODE_VERSION));
  }
});

test("rejects any Pi Durable release other than the pin", () => {
  for (const piDurableVersion of ["1.2.0", "1.3.1", "1.4.0", "2.0.0", "1.0.1"]) {
    assert.throws(() => assertSupportedRuntime({ ...supported, piDurableVersion }), (e) => e instanceof UnsupportedRuntimeError && e.message.includes(PINNED_PI_DURABLE_VERSION));
  }
});

test("rejects an unparseable Node version", () => {
  assert.throws(() => assertSupportedRuntime({ ...supported, nodeVersion: "not-a-version" }), UnsupportedRuntimeError);
});
