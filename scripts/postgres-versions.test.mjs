import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { MAJORS, SUPPORTED_FROM, failingNames, majorOf, probeProblem, verdict } from "./postgres-versions.mjs";

const totals = (over = {}) => ({ tests: 236, pass: 236, fail: 0, cancelled: 0, skipped: 0, todo: 0, blocks: 1, ...over });
const here = (path) => fileURLToPath(new URL(path, import.meta.url));

test("a major version passes only with exit 0, some tests, and no failure or cancellation; 17 and above are the supported ones", () => {
  assert.equal(SUPPORTED_FROM, 17);
  assert.deepEqual(verdict(17, totals(), 0), { passed: true, supported: true, label: "passed" });
  assert.deepEqual(verdict(16, totals(), 0), { passed: true, supported: false, label: "passed" });
  assert.equal(verdict(18, totals(), 1).passed, false);
  assert.equal(verdict(18, totals({ tests: 0, pass: 0 }), 0).passed, false, "no tests found is not a pass");
  assert.equal(verdict(18, totals({ fail: 1, pass: 235 }), 0).passed, false);
  assert.equal(verdict(18, totals({ cancelled: 1 }), 0).passed, false);
});

test("every major has one exact, locked install pinned to its own PostgreSQL major, and the supported major matches the repository's own", () => {
  for (const major of MAJORS) {
    const dir = `./postgres-versions/${major}`;
    const manifest = JSON.parse(readFileSync(here(`${dir}/package.json`), "utf8"));
    assert.match(manifest.dependencies["embedded-postgres"], new RegExp(`^${major}\\.\\d+\\.\\d+-[a-z]+\\.\\d+$`), `PostgreSQL ${major} is pinned exactly`);
    assert.deepEqual(Object.keys(manifest.dependencies), ["embedded-postgres"]);
    assert.ok(existsSync(here(`${dir}/package-lock.json`)), `PostgreSQL ${major} has a lockfile`);
    const lock = JSON.parse(readFileSync(here(`${dir}/package-lock.json`), "utf8"));
    const locked = lock.packages["node_modules/embedded-postgres"];
    assert.equal(locked.version, manifest.dependencies["embedded-postgres"]);
    assert.match(locked.integrity, /^sha\d+-/, "the lockfile records an integrity hash");
  }
  const own = JSON.parse(readFileSync(here("../packages/controller/package.json"), "utf8")).devDependencies["embedded-postgres"];
  const seventeen = JSON.parse(readFileSync(here("./postgres-versions/17/package.json"), "utf8")).dependencies["embedded-postgres"];
  assert.equal(seventeen, own, "the verification of 17 uses the same server as the normal suites");
});

test("a run is trusted only when the server that actually answered is the requested major", () => {
  assert.equal(majorOf("17.10"), 17);
  assert.equal(majorOf(" 14.23 (Debian)"), 14);
  for (const bad of ["", "unknown (boom)", "PostgreSQL 17.1", undefined, null]) assert.equal(majorOf(bad), undefined, String(bad));
  assert.equal(probeProblem(16, "16.14"), undefined);
  assert.match(probeProblem(14, "17.10") ?? "", /PostgreSQL 17, not the requested 14/);
  assert.match(probeProblem(15, "unknown (the server did not start)") ?? "", /could not read the version/);
  assert.match(probeProblem(18, "") ?? "", /could not read the version/);
});

test("failing test names are found in spec and TAP output, once each", () => {
  const spec = "✔ fine (1.2ms)\n✖ a server was killed (9392.2976ms)\n  AssertionError\n✖ failing tests:\n✖ a server was killed (9392.2976ms)\n";
  assert.deepEqual(failingNames(spec), ["a server was killed"]);
  assert.deepEqual(failingNames("ok 1 - fine\nnot ok 2 - the second one\n  ---\nnot ok 3 - the third\n"), ["the second one", "the third"]);
  assert.deepEqual(failingNames("all good"), []);
});
