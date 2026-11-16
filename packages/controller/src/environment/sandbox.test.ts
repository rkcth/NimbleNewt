import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxFor } from "./sandbox.js";

test("each operating system names its mechanism, a weaker boundary is flagged, and an unknown one is not assumed strong (card U08, decision G01)", () => {
  assert.deepEqual([sandboxFor("linux").mechanism, sandboxFor("linux").boundary, sandboxFor("linux").warn], ["bubblewrap", "strong", false]);
  for (const mac of ["darwin", "Darwin", "macos", " MacOS "]) assert.deepEqual([sandboxFor(mac).mechanism, sandboxFor(mac).boundary, sandboxFor(mac).warn], ["Seatbelt", "weaker", true], mac);
  assert.match(sandboxFor("darwin").limits.join(" "), /weaker limits than Linux/);
  for (const win of ["win32", "Windows"]) assert.deepEqual([sandboxFor(win).mechanism, sandboxFor(win).warn], ["Windows Sandbox", false], win);
  for (const odd of [undefined, "", "plan9", "freebsd"]) { const f = sandboxFor(odd); assert.deepEqual([f.mechanism, f.boundary, f.warn], ["unknown", "unproven", true], String(odd)); }
  assert.doesNotMatch(sandboxFor("<script>alert(1)</script>").os, /[<>(]/, "a reported name is cleaned, and clipped");
  assert.ok(sandboxFor("x".repeat(500)).os.length <= 40);
});
