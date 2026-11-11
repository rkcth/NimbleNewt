import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import type { SandboxBackend } from "./backend.js";
import { CONTAINMENT_SCHEMA, MAX_REPORT_BYTES, REQUIRED_CASE_IDS, assessRelease, parseReport, runContainmentSuite, type ContainmentReport, type PlatformName, type WindowsEvidence } from "./containment.js";
import { SandboxLauncher } from "./launcher.js";
import { bubblewrapBackend } from "./linux.js";

// The suite starts real confined processes. Where bubblewrap cannot run these are skipped, unless NIMBLENEWT_REQUIRE_SANDBOX=1 (CI), where unusable is a failure.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const onLinux = process.platform === "linux";
const COMMIT = "a".repeat(40);
const NOW = new Date("2026-11-11T12:00:00Z");

/** Mutations of the production backend: each removes exactly one guard, to show the case that depends on it fails (and no other does). */
function mutated(name: string, change: (args: string[]) => string[]): SandboxBackend {
  const real = bubblewrapBackend();
  return { ...real, name, plan: (recipe, command, runId) => { const p = real.plan(recipe, command, runId); return { ...p, args: change([...p.args]) }; } };
}
const without = (args: string[], flag: string, count: number): string[] => { const i = args.indexOf(flag); return i < 0 ? args : [...args.slice(0, i), ...args.slice(i + 1 + count)]; };

async function suiteWith(backend: SandboxBackend | undefined): Promise<Record<string, string>> {
  const launcher = backend === undefined ? undefined : await SandboxLauncher.create({ backend, protectedPaths: [], audit: () => undefined });
  if (launcher !== undefined && !launcher.capacity.available) assert.fail(`mutated backend unusable: ${launcher.capacity.reason}`);
  const suite = await runContainmentSuite(launcher === undefined ? {} : { launcher });
  return Object.fromEntries(suite.cases.map((c) => [c.id, `${c.verdict}:${c.detail}`]));
}
const verdicts = (v: Record<string, string>): Record<string, string> => Object.fromEntries(Object.entries(v).map(([k, s]) => [k, s.split(":")[0]!]));

describe("G05 containment suite on the production launcher (Linux, bubblewrap)", () => {
  test("every case holds through the real launcher, the controls work and the trusted-host exception is recorded", async (t) => {
    if (!onLinux) return t.skip("Linux only");
    const suite = await runContainmentSuite();
    if (!suite.capacity.available) { if (required) assert.fail(`sandbox required but unusable: ${suite.capacity.reason}`); return t.skip(`unusable: ${suite.capacity.reason}`); }
    assert.equal(suite.capacity.backend, "bubblewrap");
    assert.deepEqual(suite.cases.map((c) => c.id).sort(), [...REQUIRED_CASE_IDS].sort());
    for (const c of suite.cases) assert.equal(c.verdict, "pass", `${c.id}: ${c.detail}`);
    assert.ok(suite.trustedHost !== undefined && suite.trustedHost.refusedWithoutAuthority && suite.trustedHost.reachesHostFiles, "the exception is shown, not assumed");
  });

  // Mutation tests: with one guard removed, exactly the matching case fails (fail before, pass after).
  const mutations: readonly { name: string; backend: () => SandboxBackend; fails: string[] }[] = [
    { name: "an unconfined process (no sandbox at all)", fails: ["deny-write-host-path", "deny-symlink-read", "deny-symlink-write", "deny-credential-read", "deny-controller-data-read", "deny-network-loopback", "deny-write-protected-name"], backend: () => ({
      name: "passthrough", health: async () => ({ healthy: true, backend: "passthrough" }),
      plan: (recipe, command) => ({ file: command[0]!, args: command.slice(1), env: { PATH: "/usr/bin:/bin", HOME: recipe.home, TMPDIR: recipe.scratch }, cwd: recipe.workdir }),
      guestView: (recipe) => ({ workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: recipe.scratch, inputs: [] }),
    }) },
    { name: "network namespace shared with the host", fails: ["deny-network-loopback"], backend: () => mutated("share-net", (a) => { const i = a.indexOf("--unshare-all"); a.splice(i + 1, 0, "--share-net"); return a; }) },
    { name: "the protected .git not bound read-only", fails: ["deny-write-protected-name"], backend: () => mutated("no-git-guard", (a) => { let out = a; for (let i = out.indexOf("--ro-bind"); i >= 0; i = out.indexOf("--ro-bind", i + 1)) { if (out[i + 2] === "/work/.git") { out = [...out.slice(0, i), ...out.slice(i + 3)]; break; } } return out; }) },
    { name: "the service user's home bound into the sandbox", fails: ["deny-credential-read", "deny-write-host-path", "deny-symlink-read"], backend: () => mutated("bind-home", (a) => { const h = process.env["HOME"]!; const i = a.indexOf("--chdir"); a.splice(i, 0, "--bind", h, h); return a; }) },
  ];
  for (const m of mutations) {
    test(`mutation: ${m.name} makes exactly ${m.fails.join(", ")} fail`, async (t) => {
      if (!onLinux) return t.skip("Linux only");
      const got = verdicts(await suiteWith(m.backend()));
      for (const id of REQUIRED_CASE_IDS) {
        if (m.fails.includes(id)) assert.equal(got[id], "fail", `${id} must fail: ${JSON.stringify(got)}`);
        else if (m.name.startsWith("an unconfined")) continue; // the other cases (system directories as a non-root user) cannot be made to fail by an unprivileged process
        else assert.equal(got[id], "pass", `${id} must be unaffected: ${JSON.stringify(got)}`);
      }
      assert.equal(got["control-write-own-directories"], "pass");
      assert.equal(got["control-read-own-decoy"], "pass");
    });
  }

  test("a launcher with no capacity yields not_run for every case, never a pass", async () => {
    const dead: SandboxBackend = { name: "dead", health: async () => ({ healthy: false, backend: "dead", reason: "broken on purpose" }), plan: () => { throw new Error("never"); }, guestView: () => { throw new Error("never"); } };
    const suite = await runContainmentSuite({ launcher: await SandboxLauncher.create({ backend: dead, protectedPaths: [], audit: () => undefined }) });
    assert.equal(suite.cases.length, REQUIRED_CASE_IDS.length);
    assert.ok(suite.cases.every((c) => c.verdict === "not_run"));
  });

  test("a probe that cannot be made is inconclusive, which the gate does not accept", async (t) => {
    if (!onLinux) return t.skip("Linux only");
    // A backend whose program prints nothing: every attempt misses its end marker.
    const silent: SandboxBackend = { name: "silent", health: async () => ({ healthy: true, backend: "silent" }), plan: () => ({ file: "/bin/true", args: [], env: {} }), guestView: (r) => ({ workdir: r.workdir, home: r.home, scratch: r.scratch, tmp: r.scratch, inputs: [] }) };
    const got = verdicts(await suiteWith(silent));
    assert.ok(REQUIRED_CASE_IDS.every((id) => got[id] === "inconclusive"), JSON.stringify(got));
  });
});

const goodWindows = (): WindowsEvidence => ({
  serviceIdentity: { account: "NT SERVICE\\NimbleNewt", session: "service" },
  afterLogout: { launch: true, exec: true, results: true, teardown: true }, afterReboot: { launch: true, exec: true, results: true, teardown: true },
  mappedOutputAcl: { positive: true, negative: true }, packagedControllerWorkingDirectory: { packaged: true, passed: true }, supervisorAclCheck: "strict",
});
function report(platform: PlatformName, extra: Partial<Record<keyof ContainmentReport, unknown>> = {}): ContainmentReport {
  const base: ContainmentReport = {
    schema: CONTAINMENT_SCHEMA, generatedAt: "2026-11-10T12:00:00Z", implementationCommit: COMMIT, dirty: false, platform, arch: "x64", osVersion: "1.0", backend: "b", capacityAvailable: true,
    weakerThanLinux: platform === "darwin", ...(platform === "darwin" ? { macosVersion: "15.1" } : {}),
    cases: REQUIRED_CASE_IDS.map((id) => ({ id, category: "control" as const, verdict: "pass" as const, detail: "held" })),
    trustedHost: { mode: "trusted-host", authority: "owner", reachesHostFiles: true, refusedWithoutAuthority: true },
    ...(platform === "win32" ? { windows: goodWindows() } : {}),
  };
  return { ...base, ...extra } as ContainmentReport;
}
const all = (over: Partial<Record<PlatformName, ContainmentReport>> = {}): ContainmentReport[] => (["linux", "darwin", "win32"] as const).map((p) => over[p] ?? report(p));
const gate = (reports: ContainmentReport[]) => assessRelease(reports, { commit: COMMIT, now: NOW });
const blocked = (reports: ContainmentReport[], pattern: RegExp): void => { const r = gate(reports); assert.equal(r.ok, false); assert.ok(r.blockers.some((b) => pattern.test(b)), `${pattern}: ${r.blockers.join(" | ")}`); };

describe("G05 release gate", () => {
  test("complete evidence for all three platforms passes", () => { const r = gate(all()); assert.deepEqual(r.blockers, []); assert.equal(r.ok, true); });
  test("a missing platform blocks, Windows above all", () => { blocked(all().filter((r) => r.platform !== "win32"), /win32: no report/); blocked(all().filter((r) => r.platform !== "darwin"), /darwin: no report/); });
  test("two reports for one platform block", () => blocked([...all(), report("linux")], /linux: 2 reports/));
  test("evidence for another commit blocks (replay of an earlier build)", () => blocked(all({ linux: report("linux", { implementationCommit: "b".repeat(40) }) }), /linux: the evidence is for commit b+/));
  test("a dirty tree, a stale report and a future-dated one block", () => {
    blocked(all({ linux: report("linux", { dirty: true }) }), /uncommitted/);
    blocked(all({ linux: report("linux", { generatedAt: "2026-09-01T00:00:00Z" }) }), /more than 30 days/);
    blocked(all({ linux: report("linux", { generatedAt: "2026-12-01T00:00:00Z" }) }), /future/);
  });
  test("no capacity blocks", () => blocked(all({ linux: report("linux", { capacityAvailable: false, capacityReason: "no bwrap" }) }), /no capacity \(no bwrap\)/));
  test("every required case is required: one missing, failed, inconclusive or not_run case blocks, and a duplicate", () => {
    for (const id of REQUIRED_CASE_IDS) {
      const full = report("linux").cases;
      blocked(all({ linux: report("linux", { cases: full.filter((c) => c.id !== id) }) }), new RegExp(`case ${id} is missing`));
      for (const verdict of ["fail", "inconclusive", "not_run"] as const) blocked(all({ linux: report("linux", { cases: full.map((c) => (c.id === id ? { ...c, verdict } : c)) }) }), new RegExp(`case ${id}: ${verdict}`));
    }
    blocked(all({ linux: report("linux", { cases: [...report("linux").cases, report("linux").cases[0]!] }) }), /appears twice/);
  });
  test("the trusted-host exception must be recorded, refused without authority and shown as unconfined", () => {
    blocked(all({ linux: report("linux", { trustedHost: undefined }) }), /exception is not recorded/);
    blocked(all({ linux: report("linux", { trustedHost: { mode: "trusted-host", authority: "o", reachesHostFiles: true, refusedWithoutAuthority: false } }) }), /not refused without/);
    blocked(all({ linux: report("linux", { trustedHost: { mode: "trusted-host", authority: "o", reachesHostFiles: false, refusedWithoutAuthority: true } }) }), /was not shown/);
  });
  test("macOS must record its version and state that it is weaker than Linux; Linux and Windows may not claim the weaker boundary", () => {
    blocked(all({ darwin: report("darwin", { macosVersion: undefined }) }), /macOS version/);
    blocked(all({ darwin: report("darwin", { macosVersion: "  " }) }), /macOS version/);
    blocked(all({ darwin: report("darwin", { weakerThanLinux: false }) }), /weaker than Linux/);
    blocked(all({ linux: report("linux", { weakerThanLinux: true }) }), /only a macOS report/);
  });
  test("Windows: each piece of host evidence is separately required", () => {
    const w = goodWindows();
    const win = (windows: unknown): ContainmentReport[] => all({ win32: report("win32", { windows }) });
    blocked(all({ win32: report("win32", { windows: undefined }) }), /Windows host evidence is missing/);
    blocked(win({ ...w, serviceIdentity: { account: "rob", session: "interactive" } }), /interactive session/);
    blocked(win({ ...w, featureEnabledOnly: true }), /feature being enabled only/);
    for (const k of ["launch", "exec", "results", "teardown"] as const) {
      blocked(win({ ...w, afterLogout: { ...w.afterLogout, [k]: false } }), new RegExp(`${k} not proven after logout`));
      blocked(win({ ...w, afterReboot: { ...w.afterReboot, [k]: false } }), new RegExp(`${k} not proven after reboot`));
    }
    blocked(win({ ...w, mappedOutputAcl: { positive: false, negative: true } }), /positive control/);
    blocked(win({ ...w, mappedOutputAcl: { positive: true, negative: false } }), /negative control/);
    blocked(win({ ...w, packagedControllerWorkingDirectory: { packaged: false, passed: true } }), /not run on the packaged controller/);
    blocked(win({ ...w, packagedControllerWorkingDirectory: { packaged: true, passed: false } }), /packaged controller working-directory check failed/);
    blocked(win({ ...w, supervisorAclCheck: "report-only" }), /report-only/);
    blocked(all({ linux: report("linux", { windows: w }) }), /Windows evidence in a non-Windows report/);
  });
  test("a malformed release commit blocks everything", () => assert.equal(assessRelease(all(), { commit: "HEAD", now: NOW }).ok, false));
  test("a platform list narrows what is required, never what a report must contain", () => {
    const r = assessRelease(all().filter((x) => x.platform === "linux"), { commit: COMMIT, now: NOW, platforms: ["linux"] });
    assert.equal(r.ok, true);
    assert.equal(assessRelease([report("linux", { dirty: true })], { commit: COMMIT, now: NOW, platforms: ["linux"] }).ok, false);
  });
});

describe("G05 report parsing (reports are data from a file)", () => {
  const text = (r: unknown): string => JSON.stringify(r);
  const bad = (r: unknown, pattern: RegExp): void => { const p = parseReport(typeof r === "string" ? r : text(r)); assert.ok("error" in p, "must be refused"); assert.match(p.error, pattern); };
  test("a complete report round-trips", () => { const p = parseReport(text(report("win32"))); assert.ok("report" in p); assert.deepEqual(p.report, report("win32")); });
  test("refusals", () => {
    bad("not json{", /not JSON/);
    bad("[]", /schema/);
    bad({ ...report("linux"), schema: "other" }, /schema/);
    bad({ ...report("linux"), implementationCommit: "abc" }, /40 hex/);
    bad({ ...report("linux"), implementationCommit: "A".repeat(40) }, /40 hex/);
    bad({ ...report("linux"), generatedAt: "yesterday" }, /ISO time/);
    bad({ ...report("linux"), dirty: "no" }, /dirty/);
    bad({ ...report("linux"), platform: "freebsd" }, /platform/);
    bad({ ...report("linux"), osVersion: "x".repeat(101) }, /short text/);
    bad({ ...report("linux"), capacityAvailable: 1 }, /true or false/);
    bad({ ...report("linux"), cases: Array.from({ length: 65 }, () => report("linux").cases[0]) }, /at most 64/);
    bad({ ...report("linux"), cases: [{ id: "x", category: "c", verdict: "maybe", detail: "" }] }, /case needs/);
    bad({ ...report("linux"), trustedHost: { mode: "trusted-host" } }, /trustedHost/);
    bad({ ...report("win32"), windows: { ...goodWindows(), afterReboot: { launch: true } } }, /windows/);
    bad({ ...report("win32"), windows: { ...goodWindows(), supervisorAclCheck: "maybe" } }, /windows/);
    bad(`{"schema":"${CONTAINMENT_SCHEMA}","pad":"${"x".repeat(MAX_REPORT_BYTES)}"}`, /at most/);
  });
});

describe("G05 evidence script", () => {
  const script = fileURLToPath(new URL("../../../../scripts/containment-evidence.mjs", import.meta.url));
  const gateRun = (dir: string, commit: string) => spawnSync(process.execPath, [script, "gate", "--dir", dir, "--commit", commit], { encoding: "utf8" });
  test("gate exits 0 only for complete evidence for the named commit, and names what blocks otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "nn-g05-gate-"));
    try {
      const now = new Date().toISOString();
      for (const p of ["linux", "darwin", "win32"] as const) writeFileSync(join(dir, `containment-${p}.json`), JSON.stringify(report(p, { generatedAt: now })));
      const ok = gateRun(dir, COMMIT);
      assert.equal(ok.status, 0, ok.stdout + ok.stderr);
      const wrong = gateRun(dir, "c".repeat(40));
      assert.equal(wrong.status, 1);
      assert.match(wrong.stdout, /blocked: win32: the evidence is for commit/);
      writeFileSync(join(dir, "containment-win32.json"), "{broken");
      const broken = gateRun(dir, COMMIT);
      assert.equal(broken.status, 1);
      assert.match(broken.stdout, /unreadable report: containment-win32.json/);
      assert.match(broken.stdout, /win32: no report/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
  test("usage errors exit 2", () => assert.equal(spawnSync(process.execPath, [script], { encoding: "utf8" }).status, 2));
});
