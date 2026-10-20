import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import {
  OVERRIDE_ENV, OVERRIDE_FLAG, SUPPORTED_ENVIRONMENT, UnsupportedEnvironmentError, checkEnvironment, compareVersions, detectEnvironment, overrideRequested, recordOverride, refusalMessage, startupCheck,
  type EnvironmentFacts,
} from "./index.js";

after(stopServer);

const linux: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.17.0-1022-azure", nodeVersion: "22.19.0", postgresVersion: "17.10" };
const mac: EnvironmentFacts = { platform: "darwin", arch: "arm64", osRelease: "25.6.0", nodeVersion: "24.21.0", postgresVersion: "18.4" };
const windows: EnvironmentFacts = { platform: "win32", arch: "x64", osRelease: "10.0.26100", nodeVersion: "22.23.0" };
const T = "2026-10-20T10:00:00.000Z";

test("the environments the project tests are covered, with and without PostgreSQL", () => {
  for (const facts of [linux, mac, windows, { ...linux, nodeVersion: "24.21.0", postgresVersion: "18.4" }, { ...linux, osRelease: "7.0.0-38-generic" }]) assert.deepEqual(checkEnvironment(facts), [], JSON.stringify(facts));
  assert.deepEqual(startupCheck(linux, { allowUnsupported: false }), { problems: [], overridden: false, output: [] });
});

test("anything the list does not cover is a problem that names what was found, what is supported and how to test it", () => {
  const cases: [EnvironmentFacts, string, RegExp][] = [
    [{ ...linux, nodeVersion: "22.18.9" }, "Node.js", /22\.19\.0 or newer/],
    [{ ...linux, nodeVersion: "20.11.0" }, "Node.js", /20\.11\.0/],
    [{ ...linux, arch: "arm64" }, "operating system", /arm64/],
    [{ ...mac, arch: "x64" }, "operating system", /macOS on Apple silicon/],
    [{ ...mac, osRelease: "24.6.0" }, "operating system", /Darwin 25, macOS 26 or newer/],
    [{ ...windows, osRelease: "10.0.22631" }, "operating system", /build 26100/],
    [{ ...windows, platform: "freebsd" }, "operating system", /freebsd/],
    [{ ...linux, postgresVersion: "16.14" }, "PostgreSQL", /17 or newer/],
    [{ ...linux, postgresVersion: "14.23" }, "PostgreSQL", /postgres-versions\.mjs 14/],
  ];
  for (const [facts, item, found] of cases) {
    const problems = checkEnvironment(facts);
    assert.ok(problems.some((p) => p.item === item && found.test(`${p.found} ${p.supported} ${p.howToTest}`)), `${JSON.stringify(facts)} -> ${JSON.stringify(problems)}`);
  }
  assert.equal(checkEnvironment({ ...linux, nodeVersion: "18.0.0", arch: "ia32", postgresVersion: "15.1" }).length, 3, "every problem is reported, not only the first");
});

test("the refusal is a hard stop with the exact override and how to verify", () => {
  assert.throws(() => startupCheck({ ...linux, nodeVersion: "20.0.0" }, { allowUnsupported: false }), (error: unknown) => {
    assert.ok(error instanceof UnsupportedEnvironmentError);
    assert.equal(error.problems.length, 1);
    assert.match(error.message, /will not start/);
    assert.match(error.message, /Node\.js: found 20\.0\.0; supported: 22\.19\.0 or newer/);
    assert.ok(error.message.includes("node scripts/qa.mjs --runs=5"));
    assert.ok(error.message.includes(OVERRIDE_FLAG));
    assert.ok(error.message.includes(OVERRIDE_ENV));
    assert.ok(error.message.includes("audit log"));
    return true;
  });
  const message = refusalMessage(checkEnvironment({ ...linux, postgresVersion: "15.1", nodeVersion: "20.0.0" }));
  assert.equal(message.match(/node scripts\/qa\.mjs/g)?.length, 1, "a test instruction is not repeated");
  assert.ok(message.includes("node scripts/postgres-versions.mjs 15"));
});

test("the override is requested by the flag or the environment variable and by nothing else", () => {
  assert.equal(overrideRequested([OVERRIDE_FLAG], {}), true);
  assert.equal(overrideRequested([], { [OVERRIDE_ENV]: "1" }), true);
  assert.equal(overrideRequested([], { [OVERRIDE_ENV]: "true" }), true);
  for (const value of [undefined, "", "0", "false", "yes"]) assert.equal(overrideRequested(["--other"], { [OVERRIDE_ENV]: value }), false, String(value));
  assert.equal(overrideRequested(["--allow-unsupported"], {}), false, "a near-miss is not the switch");
});

test("an overridden start passes with a loud notice and changes nothing else", () => {
  const check = startupCheck({ ...linux, nodeVersion: "20.0.0" }, { allowUnsupported: true });
  assert.equal(check.overridden, true);
  assert.equal(check.problems.length, 1);
  assert.ok(check.output[0]!.startsWith("WARNING"));
  assert.ok(check.output.some((l) => l.includes("Node.js: found 20.0.0")));
  assert.deepEqual(startupCheck(linux, { allowUnsupported: true }), { problems: [], overridden: false, output: [] }, "the switch on a supported environment does nothing");
});

test("version comparison", () => {
  assert.ok(compareVersions("22.19.0", "22.19.0") === 0);
  assert.ok(compareVersions("22.20.0", "22.19.9") > 0);
  assert.ok(compareVersions("22.9.0", "22.19.0") < 0);
  assert.ok(compareVersions("24", "22.19.0") > 0);
});

test("the list is the single source and detection reads this machine", () => {
  assert.equal(SUPPORTED_ENVIRONMENT.node.minimum, "22.19.0");
  assert.equal(SUPPORTED_ENVIRONMENT.postgres.minimumMajor, 17);
  const here = detectEnvironment();
  assert.equal(here.platform, process.platform);
  assert.deepEqual(checkEnvironment(here).filter((p) => p.item === "Node.js"), [], "the node running these tests is supported (CI enforces it)");
});

for (const backend of backends) {
  test(`${backend.name}: an unsupported start is refused and records nothing; an overridden one is recorded in the audit log once per epoch`, async () => {
    const world = await backend.open();
    try {
      const { epoch } = await world.storage.acquireEpoch({ holder: "c1", at: T });
      const unsupported = { ...linux, nodeVersion: "20.0.0" };
      assert.throws(() => startupCheck(unsupported, { allowUnsupported: false }), UnsupportedEnvironmentError);
      assert.equal(await recordOverride(world.storage, epoch, startupCheck(linux, { allowUnsupported: false }), T), false);
      assert.deepEqual(await world.storage.listAudit({ afterSeq: 0, limit: 10 }), [], "a supported start writes nothing");
      const overridden = startupCheck(unsupported, { allowUnsupported: true });
      assert.equal(await recordOverride(world.storage, epoch, overridden, T), true);
      assert.equal(await recordOverride(world.storage, epoch, overridden, T), true, "repeating it is the same record");
      const audit = await world.storage.listAudit({ afterSeq: 0, limit: 10 });
      assert.equal(audit.length, 1);
      assert.deepEqual([audit[0]!.type, audit[0]!.actor], ["environment.override", "startup"]);
      assert.deepEqual((audit[0]!.detail["problems"] as { item: string; found: string }[]).map((p) => [p.item, p.found]), [["Node.js", "20.0.0"]]);
      await world.storage.acquireEpoch({ holder: "c2", at: T });
      assert.equal(await recordOverride(world.storage, epoch + 1, overridden, T), true);
      assert.equal((await world.storage.listAudit({ afterSeq: 0, limit: 10 })).length, 2, "a new epoch records its own override");
    } finally { await world.close(); }
  });
}

test("the supported Node minimum in the list is the one package.json and the CI matrix declare", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const engines = (JSON.parse(readFileSync(`${root}package.json`, "utf8")) as { engines: { node: string } }).engines.node;
  assert.equal(engines, `>=${SUPPORTED_ENVIRONMENT.node.minimum}`);
  assert.ok(readFileSync(`${root}.github/workflows/ci.yml`, "utf8").includes(SUPPORTED_ENVIRONMENT.node.minimum), "CI tests the minimum Node");
  // The Pi adapter cannot import the controller across the package boundary, so it keeps its own constant; it must agree.
  assert.ok(readFileSync(`${root}packages/pi-adapter/src/runtime.ts`, "utf8").includes(`MINIMUM_NODE_VERSION = "${SUPPORTED_ENVIRONMENT.node.minimum}"`), "the Pi adapter's Node minimum agrees");
});
