import assert from "node:assert/strict";
import { test } from "node:test";
import { sandboxFor } from "./sandbox.js";

test("each operating system names its mechanism, a weaker boundary is flagged, and an unknown one is not assumed strong (card U08, decision G01)", () => {
  assert.deepEqual([sandboxFor("linux").mechanism, sandboxFor("linux").boundary, sandboxFor("linux").warn], ["bubblewrap", "strong", false]);
  for (const mac of ["darwin", "Darwin", "macos", " MacOS "]) assert.deepEqual([sandboxFor(mac).mechanism, sandboxFor(mac).boundary, sandboxFor(mac).warn], ["Seatbelt", "weaker", true], mac);
  assert.match(sandboxFor("darwin").limits.join(" "), /weaker limits than Linux/);
  // Windows (card A03b): the native AppContainer launcher, whose own report says process-level and weaker than Linux; not Windows Sandbox, and never shown as strong while unmeasured
  for (const win of ["win32", "Windows"]) assert.deepEqual([sandboxFor(win).mechanism, sandboxFor(win).boundary, sandboxFor(win).warn], ["AppContainer and Job Object", "weaker", true], win);
  assert.match(sandboxFor("win32").limits.join(" "), /weaker limits than Linux/);
  assert.match(sandboxFor("win32").limits.join(" "), /not yet been measured/);
  assert.doesNotMatch(sandboxFor("win32").limits.join(" "), /Windows Sandbox|guest/);
  assert.ok(sandboxFor("win32").limits.length <= 4);
  for (const odd of [undefined, "", "plan9", "freebsd"]) { const f = sandboxFor(odd); assert.deepEqual([f.mechanism, f.boundary, f.warn], ["unknown", "unproven", true], String(odd)); }
  assert.doesNotMatch(sandboxFor("<script>alert(1)</script>").os, /[<>(]/, "a reported name is cleaned, and clipped");
  assert.ok(sandboxFor("x".repeat(500)).os.length <= 40);
});
