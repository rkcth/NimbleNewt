import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { LocalWorker, QuiesceCoordinator, SqliteStorage } from "@nimblenewt/controller";
import { buildWorld, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, WorkspaceBridge } from "@nimblenewt/worker";

// Card H12d with the real Git bridge (A04): integrating the agent's checkout into the shared workspace waits until the agent's call in flight (which is still writing a file) has settled, and the attempt goes on afterwards.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });

test("integration of the agent's checkout runs after its in-flight write has settled, with the attempt frozen, and the attempt continues", { skip: hasGit ? false : "git is not installed" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "nn-h12d-"));
  const storage = await SqliteStorage.open({ path: join(dir, "db.sqlite") });
  try {
    const shared = join(dir, "shared");
    await mkdir(shared, { recursive: true });
    sh(dir, "init", "-q", "-b", "main", shared);
    await writeFile(join(shared, "README.md"), "hello\n");
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
    const git = await GitBridge.create({ scratch: join(dir, "scratch") });
    const bridge = new WorkspaceBridge({ shared, state: join(dir, "state"), clock: () => "2026-10-22T14:00:00.000Z" });
    const gitDir = join(dir, "task.git"); const checkout = join(dir, "checkout");
    await git.createCheckout({ shared, commit: await git.head(shared), gitDir, checkout });

    const w = await buildWorld(storage);
    await w.principals.enroll(w.owner, { commandId: "eh", kind: "host", name: "local", grants: [] });
    const self = await w.principals.authenticate((await w.principals.issueCredential(w.owner, "host:local")).token);
    await w.admission.setCapacity({ commandId: "cap2", actor: w.owner.id, host: "host:local", capacity: { cpus: 4, memoryMb: 8192 } });
    let started!: () => void;
    const inCall = new Promise<void>((ok) => { started = ok; });
    let continued = false;
    let ended = false;
    let afterOperation!: () => void;
    const operationDone = new Promise<void>((ok) => { afterOperation = ok; });
    const local = new LocalWorker({
      hostId: "host:local", resources: { cpus: 1, memoryMb: 1024 }, version: "v", capabilities: () => ({ os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] }),
      sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
      runtimes: { open: async (_o, call) => ({
        run: async () => {
          // A call still in flight when the integration is asked for: it has written its file and waits for the stop signal.
          await call({ callId: "w1", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async (signal) => { await writeFile(join(checkout, "late.txt"), "written by the call in flight\n"); started(); await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })); ended = true; return { text: "stopped" }; } });
          await operationDone;
          const later = await call({ callId: "w2", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async () => ({ text: "x" }) });
          continued = later.state === "confirmed";
          return { status: "completed", text: "done" };
        },
        checkpoint: async () => ({ saved: true }), close: async () => undefined,
      }) },
    });
    await local.register(w.hosts, self);
    const d = w.restart({ workers: [local] });
    const ann = await w.agent("ann", workGrants(w.project, ["read-file"]));
    const { taskId } = await w.task("t", ann);
    const coordinator = new QuiesceCoordinator({ dispatcher: d, blockers: w.blockers, principal: w.owner });
    await d.tick();
    await inCall;
    // The coordinator hands the second call a closed door until the integration is done: the runtime's second call waits for it here.
    const results = await coordinator.around({ taskId }, "integration", async () => { assert.equal(ended, true, "the call in flight had ended before the integration started"); return git.integrate({ gitDir, checkout, bridge, author: "agent:ann", reason: "task work" }); });
    afterOperation();
    assert.deepEqual(results.map((r) => [r.path, r.result.status]), [["late.txt", "written"]], "the file the call in flight was writing is part of the integration");
    assert.equal(await readFile(join(shared, "late.txt"), "utf8"), "written by the call in flight\n");
    await d.idle();
    assert.equal(continued, true, "the attempt went on after the integration");
  } finally {
    await storage.close();
    await rm(dir, { recursive: true, force: true });
  }
});
