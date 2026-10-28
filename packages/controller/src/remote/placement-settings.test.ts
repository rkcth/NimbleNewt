import assert from "node:assert/strict";
import { test } from "node:test";
import { dataHostsFor } from "./placement-settings.js";

const enrolled = ["host:pc", "host:laptop", "host:rented"];

test("the strict profile allows only the hosts the owner listed, minus the ones excluded (card H07c)", () => {
  assert.deepEqual(dataHostsFor("strict", undefined, enrolled), []);
  assert.deepEqual(dataHostsFor("strict", { allow: ["host:pc", "host:laptop"], exclude: [] }, enrolled), ["host:laptop", "host:pc"]);
  assert.deepEqual(dataHostsFor("strict", { allow: ["host:pc", "host:laptop"], exclude: ["host:laptop"] }, enrolled), ["host:pc"]);
  assert.deepEqual(dataHostsFor("unknown-profile", { allow: [], exclude: [] }, enrolled), [], "a profile that cannot be read is strict");
});

test("the derived and autonomous profiles allow every enrolled host except the ones excluded, and a listed host that is not enrolled still counts (card H07c)", () => {
  for (const profile of ["derived", "autonomous"]) {
    assert.deepEqual(dataHostsFor(profile, undefined, enrolled), ["host:laptop", "host:pc", "host:rented"]);
    assert.deepEqual(dataHostsFor(profile, { allow: [], exclude: ["host:rented"] }, enrolled), ["host:laptop", "host:pc"]);
    assert.deepEqual(dataHostsFor(profile, { allow: ["host:far"], exclude: ["host:pc"] }, enrolled), ["host:far", "host:laptop", "host:rented"]);
  }
});
