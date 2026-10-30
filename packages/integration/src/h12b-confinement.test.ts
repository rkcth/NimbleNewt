import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { confined, descendantsOf, processesMentioning, silentModel } from "./h12b-confinement-support.js";

// Card H12b: the live worker is confined as A03 and A08 say, and it does not outlive the controller. Over the real launcher and the real child. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI).
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const until = async (ok: () => boolean, ms = 20_000, why = "timed out waiting"): Promise<void> => { const end = Date.now() + ms; while (!ok()) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 50)); } };
const read = (pid: string, file: string): string => { try { return readFileSync(`/proc/${pid}/${file}`, "utf8"); } catch { return ""; } };

test("the running worker has no network but loopback, no git directory, a read-only .git, and the limits the recipe asked for", async (t) => {
  if (process.platform !== "linux") { t.skip("Linux only"); return; }
  const model = await silentModel();
  const c = await confined(model, { processes: 64, memoryMb: 768 }, false);
  if ("unusable" in c) { model.server.close(); if (required) assert.fail(`the sandbox is required but unusable: ${c.unusable}`); t.skip(c.unusable); return; }
  try {
    const attempt = await c.begin();
    try {
      const inside = () => descendantsOf(processesMentioning(c.directory).map((p) => p.pid)).filter((p) => p.comm !== "bwrap");
      await until(() => inside().length > 0, 20_000, `the worker process never appeared`);
      await new Promise((r) => setTimeout(r, 1500));
      const inner = inside();
      assert.ok(inner.length > 0, "the worker (positive control for the checks below)");
      // The worker runs inside its own namespaces: it sees only the loopback device, never the git directory, and the protected .git is read-only.
      const lookedAt: string[] = [];
      for (const { pid } of inner) {
        const dev = read(pid, "net/dev");
        if (dev === "") continue;
        lookedAt.push(pid);
        const names = dev.split("\n").slice(2).map((l) => l.split(":")[0]!.trim()).filter((n) => n !== "");
        assert.deepEqual(names, ["lo"], `process ${pid} sees network devices other than loopback: ${names.join(", ")}`);
        const mounts = read(pid, "mountinfo");
        assert.ok(!mounts.includes(c.dirs.gitDir), `process ${pid} has the git directory mounted`);
        const dotGit = mounts.split("\n").filter((l) => l.split(" ")[4]?.endsWith("/.git"));
        for (const line of dotGit) assert.ok(line.split(" ")[5]?.split(",").includes("ro"), `process ${pid}: ${line.split(" ")[4]} is not read-only`);
      }
      assert.ok(lookedAt.length > 0, "at least one worker process was inspected");
      assert.ok(inner.some((p) => read(p.pid, "mountinfo").split("\n").some((l) => l.split(" ")[4]?.endsWith("/.git"))), "the protected .git is mounted in the worker (positive control)");
      // The limits were enforced for the worker itself, and the launch record says how.
      const limits = c.records.at(-1)?.limits ?? [];
      const by = (name: string) => limits.find((l) => l.limit === name);
      assert.ok(by("memoryMb") !== undefined && by("processes") !== undefined, `the launch record names both limits: ${JSON.stringify(limits)}`);
      // A machine with no user-level systemd falls back to weaker means and says so in the record; that is reported, and only a machine that is expected to enforce (NIMBLENEWT_REQUIRE_LIMITS=1) fails on it.
      const full = ["memoryMb", "processes"].every((name) => by(name)?.enforced === "full");
      if (!full) { if (process.env["NIMBLENEWT_REQUIRE_LIMITS"] === "1") assert.fail(`the limits were not enforced in full: ${JSON.stringify(limits)}`); t.diagnostic(`limits not enforced in full on this machine: ${JSON.stringify(limits)}`); }
      const pid = inner[0]!.pid;
      if (!full) return;
      const cg = read(pid, "cgroup").trim().split("\n").at(-1)?.split("::")[1];
      if (cg !== undefined && cg.includes(".scope")) {
        const max = (f: string): string => { try { return readFileSync(`/sys/fs/cgroup${cg}/${f}`, "utf8").trim(); } catch { return ""; } };
        if (max("pids.max") !== "") assert.equal(max("pids.max"), "64");
        if (max("memory.max") !== "") assert.equal(Number(max("memory.max")), 768 * 1024 * 1024);
      }
    } finally { await attempt.stop(); }
  } finally { model.server.closeAllConnections(); model.server.close(); c.done(); }
});

test("the worker and everything it started die when the controller process is killed", async (t) => {
  if (process.platform !== "linux") { t.skip("Linux only"); return; }
  const here = dirname(fileURLToPath(import.meta.url));
  const child = fork(join(here, "h12b-confinement-child.js"), [], { stdio: ["ignore", "pipe", "inherit", "ipc"] });
  let line = "";
  child.stdout!.on("data", (d: Buffer) => { line += d.toString("utf8"); });
  try {
    await until(() => /\n/.test(line) || child.exitCode !== null, 30_000, "the controller fixture never said where the worker is");
    if (line.startsWith("UNUSABLE")) { if (required) assert.fail(line); t.skip(line.trim()); return; }
    const directory = line.replace(/^READY /, "").trim();
    await until(() => processesMentioning(directory).length > 0, 20_000, "the worker never appeared (positive control)");
    child.kill("SIGKILL");
    await until(() => child.exitCode !== null || child.signalCode !== null, 5000, "the fixture did not die");
    await until(() => processesMentioning(directory).length === 0, 10_000, `the worker outlived its controller: ${JSON.stringify(processesMentioning(directory))}`);
  } finally { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }
});
