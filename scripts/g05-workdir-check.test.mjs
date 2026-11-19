// Card G05: the controller working-directory check (scripts/g05-workdir-check.mjs). Pure rules, then the real check on this host (the real launcher from the real unit's directory).
import assert from "node:assert/strict";
import { test } from "node:test";
import { WORKDIR_SCHEMA, insidePath, judgeWorkdir, runCheck, samePath, unitWorkingDirectory } from "./g05-workdir-check.mjs";

test("the working directory is read from each platform's real unit text", () => {
  assert.equal(unitWorkingDirectory("win32", "<Exec>\n      <WorkingDirectory>C:\\NN &amp; Co\\root</WorkingDirectory>\n"), "C:\\NN & Co\\root");
  assert.equal(unitWorkingDirectory("darwin", "  <key>WorkingDirectory</key>\n  <string>/Users/x/nn root</string>\n"), "/Users/x/nn root");
  assert.equal(unitWorkingDirectory("linux", "[Service]\nWorkingDirectory=/srv/nn\nExecStart=x\n"), "/srv/nn");
  assert.equal(unitWorkingDirectory("linux", 'WorkingDirectory="/srv/nn root"\n'), "/srv/nn root");
  for (const p of ["win32", "darwin", "linux"]) assert.equal(unitWorkingDirectory(p, "nothing"), undefined, p);
});

test("paths: Windows compares without case and with either separator; POSIX exactly", () => {
  assert.equal(samePath("C:\\NN\\Root\\", "c:/nn/root", "win32"), true);
  assert.equal(samePath("/srv/NN", "/srv/nn", "linux"), false);
  assert.equal(insidePath("C:\\Repo\\x", "c:\\repo", "win32"), true);
  assert.equal(insidePath("C:\\Repository", "C:\\Repo", "win32"), false, "a sibling with a longer name is not inside");
  assert.equal(insidePath("/a/b", "/a", "linux"), true);
});

test("the verdict: each wrong working directory is named; the right one passes", () => {
  const base = { platform: "win32", unitDir: "C:\\nn", root: "C:\\nn", releaseDir: "C:\\nn\\releases\\r1", seenCwd: "C:\\nn\\releases\\r1", checkout: "C:\\src\\nn", systemDir: "C:\\Windows\\System32" };
  assert.deepEqual(judgeWorkdir(base), { passed: true, problems: [] });
  // A systemd unit names none (systemd starts in "/"); only the controller's own directory matters there.
  assert.deepEqual(judgeWorkdir({ ...base, platform: "linux", unitDir: undefined, root: "/nn", releaseDir: "/nn/releases/r1", seenCwd: "/nn/releases/r1", checkout: "/src/nn", systemDir: undefined }), { passed: true, problems: [] });
  const cases = [
    [{ unitDir: undefined }, /names no working directory/],
    [{ platform: "darwin", unitDir: undefined }, /names no working directory/],
    [{ unitDir: "C:\\Windows\\System32" }, /not the release root/],
    [{ seenCwd: undefined }, /did not start/],
    [{ seenCwd: "C:\\nn" }, /not its release folder/],
    [{ seenCwd: "C:\\src\\nn\\packages", releaseDir: "C:\\src\\nn\\packages" }, /inside the checkout/],
    [{ seenCwd: "C:\\Windows\\System32", releaseDir: "C:\\Windows\\System32" }, /system folder/],
  ];
  for (const [change, why] of cases) {
    const v = judgeWorkdir({ ...base, ...change });
    assert.equal(v.passed, false, JSON.stringify(change));
    assert.ok(v.problems.some((p) => why.test(p)), `${JSON.stringify(change)}: ${v.problems.join("; ")}`);
  }
});

test("the real check on this host: the unit's directory, the real launcher, an installed release; the controller runs in its release folder; packaged is false", async () => {
  const r = await runCheck({ timeoutMs: 60_000 });
  assert.deepEqual(r, { schema: WORKDIR_SCHEMA, platform: process.platform, packaged: false, standInEntry: true, passed: true, problems: [] });
});
