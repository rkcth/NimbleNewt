import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { startController } from "@nimblenewt/controller";
import { PI } from "@nimblenewt/controller/testing";
import { sandbox } from "./w03-rig-support.js";

// Card H07b, the worker-process half of the acceptance: "a worker process polls with one held request and exits cleanly on stop". A REAL worker process (`scripts/remote-worker.mjs`, which runs the host poller) is started against a composed
// controller with nothing to do. It connects, the controller counts exactly one held poll from it, and a stop signal cancels that request (the controller sees the client go, not a timeout) and the program exits with status 0 well before
// the 20 s hold would have ended. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (the host runs agents only in bubblewrap, so there is no worker process on other systems).
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, why: () => string, ms = 120_000): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why()); await sleep(50); } };

test("an idle worker process holds exactly one poll, and a stop signal cancels it and ends the program cleanly (card H07b)", async (t) => {
  const launcher = await sandbox(t);
  if (launcher === undefined) return;
  await launcher.stop();
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "nn h07b ")));
  const c = await startController({
    storage: { kind: "sqlite", path: join(directory, "c.sqlite") }, argv: [], env: {}, print: () => undefined,
    facts: { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" }, filesystem: async () => ({ type: "ext4", network: false }), features: [], harnesses: [PI],
    tools: { runner: { run: async () => { throw new Error("no script call runs in this test"); } } as never, isLocalHost: () => false },
    dispatch: {
      manual: true,
      route: async () => ({ route: "localp/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "local-only", paidAuthorized: false } }),
      remote: {
        blobDirectory: join(directory, "blobs"), relocationPolicy: async () => ({}), placementPolicy: async () => ({ dataHosts: ["host:r1"] }),
        hosts: [{ hostId: "host:r1", window: () => 131_072, checkpointWaitMs: 5_000, pollMs: 20, resources: { cpus: 1, memoryMb: 1024 }, requirements: () => ({ data: "local-only" as const, harness: "pi" }) }],
      },
    },
  });
  let child: ReturnType<typeof spawn> | undefined;
  const out: string[] = [];
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const s = c.services;
    const owner = await s.principals.authenticate((await s.principals.bootstrapOwner({ name: "rob" })).token);
    await s.principals.enroll(owner, { commandId: "e-r1", kind: "host", name: "r1", grants: [] });
    const hostToken = (await s.principals.issueCredential(owner, "host:r1")).token;
    const configFile = join(directory, "worker.json");
    // The default hold (20 s) is kept: the heartbeat gap is the longest the poller allows, so the held request lasts far longer than this test.
    writeFileSync(configFile, JSON.stringify({ url: c.dispatch.workerUrl, hostId: "r1", workerVersion: "h07b-test", base: join(directory, "host"), routes: { "localp/small": { url: "http://127.0.0.1:9/v1" } }, poller: { spreadMs: 0, waitMs: 20_000, heartbeatMs: 30_000, minGapMs: 0 } }));
    child = spawn(process.execPath, [join(repository, "scripts", "remote-worker.mjs"), "--config", configFile], { env: { ...process.env, NODE_OPTIONS: "", NIMBLENEWT_WORKER_TOKEN: hostToken }, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout!.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    child.stderr!.on("data", (d: Buffer) => out.push(d.toString("utf8")));
    const exited = new Promise<number | null>((r) => child!.once("exit", (code) => r(code)));

    const remote = c.dispatch.remote!;
    await until(() => remote.pollStats(c.dispatch!.principal).open === 1, () => `the worker never held a poll: ${out.join("")}`);
    // One held request and nothing else: no second poll took over, none ended, nothing timed out.
    const idle = remote.pollStats(c.dispatch.principal);
    assert.deepEqual([idle.open, idle.polls, idle.superseded, idle.timedOut, idle.disconnected], [1, 1, 0, 0, 0], JSON.stringify(idle));
    assert.ok(out.join("").includes("the remote worker host is running"), out.join(""));

    const stopped = Date.now();
    child.kill("SIGTERM");
    assert.equal(await exited, 0, `a stop signal ends the program cleanly: ${out.join("")}`);
    assert.ok(Date.now() - stopped < 15_000, "the program did not wait out the 20 s hold");
    await until(() => remote.pollStats(c.dispatch!.principal).open === 0, () => "the controller still holds the poll of a worker that has gone");
    const after = remote.pollStats(c.dispatch.principal);
    assert.equal(after.disconnected, 1, "the controller saw the client go");
    assert.equal(after.timedOut, 0, "the hold was cancelled, not waited out");
    assert.equal(out.join("").includes(hostToken), false, "nothing the program printed holds the host credential");
  } finally {
    if (child !== undefined && child.exitCode === null) child.kill("SIGKILL");
    await c.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
