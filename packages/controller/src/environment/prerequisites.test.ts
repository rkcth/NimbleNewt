import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import {
  OVERRIDE_ENV, OVERRIDE_FLAG, BUBBLEWRAP_FLAGS, REQUIRED_PREREQUISITES, SUPPORTED_ENVIRONMENT, UnsupportedEnvironmentError, checkEnvironment, checkPrerequisites, decideStartup, detectDistribution, hostLine, prerequisiteProblems, realProbes, recordOverride,
  type PrerequisiteNeed, type PrerequisiteReport, type Probes,
} from "./index.js";
import { probePostgresLibrary } from "../storage/postgres/index.js";
import { probeSqliteLibrary } from "../storage/sqlite/index.js";

after(stopServer);
const T = "2026-10-22T10:00:00.000Z";
const present = (version?: string) => async () => ({ status: "present" as const, ...(version === undefined ? {} : { version }) });
const missing = (detail: string) => async () => ({ status: "missing" as const, detail });
const allPresent: Probes = {
  git: present("2.53.0"), bubblewrap: present("0.11.1"), "user-namespaces": present(), "sandbox-exec": present(), "systemd-user-session": present(), "sqlite-library": present("3.50.0"), "postgres-library": present(),
};
const ALL: PrerequisiteNeed[] = ["start", "sqlite", "postgres", "sandbox", "limits"];
const check = (platform: NodeJS.Platform, probes: Probes, needs: PrerequisiteNeed[] = ALL) => checkPrerequisites({ platform, needs, probes });
const problems = (rows: PrerequisiteReport[]) => prerequisiteProblems(rows);

test("with everything present, nothing is a problem on each operating system, and each system is asked only about its own tools", async () => {
  const seen: Record<string, string[]> = {};
  for (const platform of ["linux", "darwin", "win32"] as const) {
    const rows = await check(platform, allPresent);
    assert.deepEqual(problems(rows), [], platform);
    seen[platform] = rows.map((r) => r.id);
  }
  assert.deepEqual(seen["linux"], ["git", "bubblewrap", "user-namespaces", "systemd-user-session", "sqlite-library", "postgres-library"]);
  assert.deepEqual(seen["darwin"], ["git", "sandbox-exec", "sqlite-library", "postgres-library"]);
  assert.deepEqual(seen["win32"], ["git", "sqlite-library", "postgres-library"], "no sandbox backend on Windows yet (A03b)");
});

test("a missing hard prerequisite says what was found, what is required and how to install it, and cannot be overridden", async () => {
  const cases: [NodeJS.Platform, string, RegExp][] = [
    ["linux", "git", /Git from https:\/\/git-scm\.com/], ["darwin", "git", /git/], ["win32", "git", /PATH/],
    ["linux", "bubblewrap", /`bubblewrap` package/], ["linux", "user-namespaces", /user namespaces/], ["darwin", "sandbox-exec", /\/usr\/bin\/sandbox-exec/],
    ["linux", "sqlite-library", /node:sqlite/], ["win32", "postgres-library", /npm ci/],
  ];
  for (const [platform, id, how] of cases) {
    const rows = await check(platform, { ...allPresent, [id]: missing(`${id} is gone`) });
    const [problem] = problems(rows);
    assert.ok(problem !== undefined, `${platform} ${id}`);
    assert.equal(problem.overridable, false);
    assert.ok(problem.found.includes(`${id} is gone`) && how.test(problem.howToFix ?? ""), JSON.stringify(problem));
    for (const allow of [false, true]) {
      assert.throws(() => decideStartup(problems(rows), { allowUnsupported: allow }), (e: unknown) => {
        assert.ok(e instanceof UnsupportedEnvironmentError);
        assert.match(e.message, /will not start: something it needs is missing/);
        assert.match(e.message, /This cannot be overridden/);
        if (!allow) assert.ok(!e.message.includes(OVERRIDE_FLAG), "no switch is offered for what cannot be overridden");
        else assert.match(e.message, /was given, but it does not cover the items marked "cannot be overridden": fix those/);
        return true;
      }, `${id} with the switch ${allow}`);
    }
  }
});

test("a too-old version is refused with the version found, the one required and the exact switch, and the switch lets it start", async () => {
  const rows = await check("linux", { ...allPresent, git: present("2.30.2") });
  const [problem] = problems(rows);
  assert.ok(problem !== undefined);
  assert.deepEqual([problem.item, problem.found, problem.supported, problem.overridable], ["git", "2.30.2", "2.38.1 or newer", undefined]);
  assert.throws(() => decideStartup([problem], { allowUnsupported: false }), (e: unknown) => {
    assert.ok(e instanceof UnsupportedEnvironmentError);
    assert.ok(e.message.includes("git: found 2.30.2; supported: 2.38.1 or newer"));
    assert.ok(e.message.includes("Install Git") || e.message.includes("install Git"), "says how to install");
    assert.ok(e.message.includes(OVERRIDE_FLAG) && e.message.includes(OVERRIDE_ENV));
    assert.ok(e.message.includes("Overriding git means"));
    return true;
  });
  const started = decideStartup([problem], { allowUnsupported: true, host: hostLine("Example OS 1", "linux", "x64") });
  assert.equal(started.overridden, true);
  assert.ok(started.output[0]!.startsWith("WARNING") && started.output.some((l) => l.includes("git: found 2.30.2")));
  for (const ok of ["2.38.1", "2.38.2", "2.39.0", "2.53.0", "3.0.0", "2.47.0.1"]) assert.deepEqual(problems(await check("linux", { ...allPresent, git: present(ok) })), [], ok);
  for (const old of ["2.38.0", "2.9.5", "1.99.0"]) assert.equal(problems(await check("linux", { ...allPresent, git: present(old) })).length, 1, old);
  assert.deepEqual(problems(await check("linux", { ...allPresent, git: present() })), [], "a tool that reports no version is not called too old");
});

test("a systemd user session is needed only for limits, and its absence can be overridden because weaker limits exist", async () => {
  const probes = { ...allPresent, "systemd-user-session": missing("no session bus") };
  assert.deepEqual(problems(await check("linux", probes, ["start", "sqlite", "sandbox"])), [], "not asked for when limits are not run here");
  const [problem] = problems(await check("linux", probes));
  assert.ok(problem!.found.includes("no session bus") && problem!.howToFix!.includes("loginctl enable-linger") && problem!.overridable === undefined);
  assert.throws(() => decideStartup([problem!], { allowUnsupported: false }), (e: unknown) => (e as Error).message.includes(OVERRIDE_FLAG) && (e as Error).message.includes("weaker fallbacks"));
  assert.equal(decideStartup([problem!], { allowUnsupported: true }).overridden, true);
});

test("the sandbox tools are required only when the controller runs a sandbox here, and a failed namespace probe is not asked when bubblewrap itself is missing", async () => {
  const noTools = { ...allPresent, bubblewrap: missing("bwrap was not found"), "user-namespaces": missing("should not be asked") };
  assert.deepEqual(problems(await check("linux", noTools, ["start", "sqlite"])), []);
  const rows = await check("linux", noTools, ["start", "sandbox"]);
  assert.deepEqual(problems(rows).map((p) => p.item), ["bubblewrap (bwrap)"], "one problem, not two for the same cause");
  assert.equal(rows.find((r) => r.id === "user-namespaces")!.result.status, "skipped");
  const userns = await check("linux", { ...allPresent, "user-namespaces": missing("operation not permitted") }, ["sandbox"]);
  assert.ok(problems(userns)[0]!.found.includes("operation not permitted") && problems(userns)[0]!.overridable === false);
});

test("a probe that throws or is absent is a missing prerequisite, never a pass", async () => {
  const { git: _git, ...rest } = allPresent;
  assert.equal(problems(await check("linux", rest, ["start"])).length, 1);
  const throwing = problems(await check("linux", { ...allPresent, git: async () => { throw new Error("boom"); } }, ["start"]));
  assert.ok(throwing[0]!.found.includes("boom") && throwing[0]!.overridable === false);
});

test("nothing depends on a distribution name: the checks take probes only, and the distribution is read for the record", async () => {
  assert.equal(detectDistribution(() => 'NAME="Ubuntu"\nPRETTY_NAME="Ubuntu 26.04 LTS"\nID=ubuntu\n'), "Ubuntu 26.04 LTS");
  assert.equal(detectDistribution((p) => { if (p === "/etc/os-release") throw new Error("none"); return "NAME=Fedora\n"; }), "Fedora", "falls back to the second file and to NAME");
  assert.equal(detectDistribution(() => { throw new Error("none"); }), undefined);
  assert.equal(detectDistribution(() => "PRETTY_NAME=\"Odd\u0007\u001b[31m name\"\n"), "Odd[31m name", "control characters never reach the output");
  assert.equal(hostLine(undefined, "darwin", "arm64"), "Host: darwin arm64 (recorded for information; no check depends on it).");
  assert.ok(hostLine("Ubuntu 26.04 LTS", "linux", "x64").includes("distribution Ubuntu 26.04 LTS"));
  // The same problems give the same decision whatever the host line says.
  const found = problems(await check("linux", { ...allPresent, git: present("2.30.2") }));
  const decide = (host: string, allowUnsupported: boolean): string => { try { const c = decideStartup(found, { allowUnsupported, host }); return `${c.overridden}:${c.output.length}`; } catch (e) { return `refused:${(e as Error).message.split("\n").length}`; } };
  for (const allow of [false, true]) assert.equal(decide(hostLine("Ubuntu 26.04", "linux", "x64"), allow), decide(hostLine("Some Other OS 9", "linux", "x64"), allow));
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const here = fileURLToPath(new URL(".", import.meta.url).href.replace("/dist/", "/src/"));
  for (const file of ["prerequisites.ts", "supported.ts", "check.ts", "filesystem.ts"]) {
    const code = readFileSync(`${here}${file}`, "utf8").split("\n").filter((l) => !/^\s*(\/\/|\/?\*)/.test(l) && !l.includes("evidence:")).join("\n");
    assert.ok(!/ubuntu|debian|fedora|centos|rhel|alpine|arch linux|suse|apt-get|dnf |yum |pacman/i.test(code.replace(/readFileSync\("\/etc\/os-release"[^)]*\)/g, "")), `${file} names a distribution or its package manager in code`);
  }
});

test("the real probes find this machine's tools by trying them, and the database libraries are found where the adapters live", async () => {
  const probes = realProbes({ sqlite: probeSqliteLibrary, postgres: probePostgresLibrary });
  const git = await probes["git"]!();
  assert.equal(git.status, "present", "CI and the development machine have git");
  assert.ok(git.status === "present" && /^\d+\.\d+/.test(git.version ?? ""));
  assert.equal((await probes["sqlite-library"]!()).status, "present");
  assert.equal((await probes["postgres-library"]!()).status, "present");
  const rows = await checkPrerequisites({ needs: ["start", "sqlite", "postgres"], probes });
  assert.deepEqual(problems(rows), [], "a machine that runs the tests has git at the minimum, node:sqlite and pg");
  const ghost = realProbes();
  assert.equal(ghost["sqlite-library"], undefined, "no probe is invented for a library nobody supplied");
});

test("the bubblewrap flags the probe uses are the launcher's own, so a change to one is caught", async () => {
  const { readFileSync } = await import("node:fs");
  const { fileURLToPath } = await import("node:url");
  const root = fileURLToPath(new URL("../../../../", import.meta.url));
  const launcher = readFileSync(`${root}packages/worker/src/sandbox/linux.ts`, "utf8");
  const sequence = BUBBLEWRAP_FLAGS.map((f) => JSON.stringify(f)).join(", ");
  assert.ok(launcher.includes(sequence), "the launcher starts with the same flags in the same order as the controller's probe");
  const probes = readFileSync(`${root}packages/controller/src/environment/prerequisites.ts`, "utf8");
  assert.ok(probes.includes("[...BUBBLEWRAP_FLAGS,"), "the probe uses the shared list");
});

test("the list of prerequisites is one list, Node's version is the F04h list's and not a second one, and every id has a probe", async () => {
  assert.ok(!REQUIRED_PREREQUISITES.some((p) => /node/i.test(p.id) && p.id !== "sqlite-library"), "no second Node version in the prerequisite list");
  assert.equal(new Set(REQUIRED_PREREQUISITES.map((p) => p.id)).size, REQUIRED_PREREQUISITES.length);
  const probes = realProbes({ sqlite: probeSqliteLibrary, postgres: probePostgresLibrary });
  for (const spec of REQUIRED_PREREQUISITES) assert.equal(typeof probes[spec.id], "function", spec.id);
  // Node too old is still found, from F04h's list.
  const node = checkEnvironment({ platform: "linux", arch: "x64", osRelease: "6.8.0", nodeVersion: "20.0.0" });
  assert.deepEqual(node.map((p) => [p.item, p.supported]), [["Node.js", `${SUPPORTED_ENVIRONMENT.node.minimum} or newer`]]);
  // Every hard prerequisite says how to install it.
  for (const spec of REQUIRED_PREREQUISITES) assert.ok(spec.install.length > 20, spec.id);
});

test("hard and overridable problems together: the message names the switch for the overridable ones only, and the hard ones still stop a start with the switch", async () => {
  const rows = await check("linux", { ...allPresent, git: present("2.30.2"), bubblewrap: missing("bwrap was not found"), "user-namespaces": present() }, ["start", "sandbox"]);
  const found = problems(rows);
  assert.equal(found.length, 2);
  assert.throws(() => decideStartup(found, { allowUnsupported: true }), (e: unknown) => {
    assert.ok(e instanceof UnsupportedEnvironmentError);
    assert.match(e.message, /not one it has been tested on, and something it needs is missing/);
    assert.ok(e.message.includes(OVERRIDE_FLAG) && e.message.includes("cannot be overridden"));
    return true;
  });
});

for (const backend of backends) {
  test(`${backend.name}: an overridden too-old prerequisite is recorded in the audit log with the distribution, once per epoch; a refusal records nothing`, async () => {
    const world = await backend.open();
    try {
      const { epoch } = await world.storage.acquireEpoch({ holder: "c1", at: T });
      const found = problems(await check("linux", { ...allPresent, git: present("2.30.2") }));
      assert.throws(() => decideStartup(found, { allowUnsupported: false }), UnsupportedEnvironmentError);
      assert.deepEqual(await world.storage.listAudit({ afterSeq: 0, limit: 10 }), []);
      const overridden = decideStartup(found, { allowUnsupported: true, host: hostLine("Example OS 1", "linux", "x64") });
      assert.equal(await recordOverride(world.storage, epoch, overridden, T), true);
      assert.equal(await recordOverride(world.storage, epoch, overridden, T), true);
      const audit = await world.storage.listAudit({ afterSeq: 0, limit: 10 });
      assert.equal(audit.length, 1);
      assert.deepEqual((audit[0]!.detail["problems"] as { item: string; found: string }[]).map((p) => [p.item, p.found]), [["git", "2.30.2"]]);
      assert.ok(String(audit[0]!.detail["host"]).includes("distribution Example OS 1"));
    } finally { await world.close(); }
  });
}
