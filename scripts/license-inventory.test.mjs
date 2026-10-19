import assert from "node:assert/strict";
import { test } from "node:test";
import { inventory, licenseAllowed, render, violations } from "./license-inventory.mjs";

const lock = { packages: {
  "": { name: "root" },
  "packages/api": { name: "@nimblenewt/api" },
  "node_modules/@nimblenewt/api": { resolved: "packages/api", link: true },
  "node_modules/b": { version: "1.0.0", license: "MIT" },
  "node_modules/a/node_modules/c": { version: "2.0.0", license: "GPL-3.0", hasInstallScript: true },
  "node_modules/@scope/d": { version: "3.0.0" },
} };

test("inventory excludes workspace packages, names nested packages and sorts", () => {
  assert.deepEqual(inventory(lock).map((e) => e.name), ["@scope/d", "b", "c"]);
});

test("violations flag disallowed and unknown licenses", () => {
  assert.deepEqual(violations(inventory(lock)), [
    "@scope/d@3.0.0: license UNKNOWN is not on the allow list",
    "c@2.0.0: license GPL-3.0 is not on the allow list",
  ]);
});

test("render is deterministic and marks install scripts", () => {
  const text = render(inventory(lock));
  assert.equal(text, render(inventory(lock)));
  assert.match(text, /\| c \| 2\.0\.0 \| GPL-3\.0 \| runtime \| yes \(not run\) \|/);
});

test("sorting ignores locale and de-duplicates repeated name@version", () => {
  const dup = { packages: {
    "node_modules/z": { version: "1.0.0", license: "MIT" },
    "node_modules/aa": { version: "1.0.0", license: "MIT", dev: true },
    "node_modules/x/node_modules/aa": { version: "1.0.0", license: "MIT" },
    "node_modules/ab": { version: "1.0.0", license: "MIT" },
  } };
  const entries = inventory(dup);
  assert.deepEqual(entries.map((e) => e.name), ["aa", "ab", "z"]);
  assert.equal(entries[0].scope, "runtime");
});

test("aliased packages are listed under their real name", () => {
  assert.equal(inventory({ packages: { "node_modules/alias": { name: "real", version: "1.0.0", license: "MIT" } } })[0].name, "real");
});

test("SPDX expressions are evaluated against the allow list", () => {
  assert.equal(licenseAllowed("MIT"), true);
  assert.equal(licenseAllowed("(MIT OR GPL-3.0)"), true);
  assert.equal(licenseAllowed("(MIT AND GPL-3.0)"), false);
  assert.equal(licenseAllowed("(MIT AND Apache-2.0)"), true);
  assert.equal(licenseAllowed("GPL-3.0"), false);
  assert.equal(licenseAllowed("UNKNOWN"), false);
  assert.equal(licenseAllowed("(MIT OR"), false);
  assert.equal(licenseAllowed(""), false);
});
