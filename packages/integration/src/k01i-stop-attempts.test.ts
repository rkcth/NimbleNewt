import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, startController, type WorkerHost } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";

// Card K01i: a restore is refused while agent work runs; with `stopAttempts` the owner's own Stop of the whole installation settles the work first. The maintenance barrier holds the retention runner, the notification sweeps, the
// hand-off and resume sweeps and the maintenance loop as participants of their own, and lets them go again when the restore is withdrawn.
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const WRITERS = ["retention.sweep", "notifications.run", "urgent.watch", "handoffs.sweep", "resumes.sweep", "workend.complete", "scratch.recover", "maintenance.tick"];
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

test("a restore is refused while an attempt runs and says how to stop the work; with stopAttempts the work is stopped and the restore prepared; every named writer is held by the barrier and let go on cancel (card K01i)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-k01i-stop-"));
  const finishes: (() => void)[] = [];
  const started: Promise<void>[] = [];
  const stopped: string[] = [];
  let local: LocalWorker | undefined;
  mkdirSync(join(dir, "data"));
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, dataDirectory: join(dir, "data"), argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    backup: { directory: join(dir, "backups") },
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async () => {
              let up!: () => void; started.push(new Promise<void>((ok) => { up = ok; }));
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
              return { run: async () => { up(); await over; return { status: "completed", text: "done" }; }, checkpoint: async () => ({ turn: 1 }), tell: async () => undefined, stop: async () => { stopped.push("stop"); finish(); }, close: async () => { finish(); } } as never;
            } },
          });
          return local as WorkerHost;
        } },
    },
  } as never);
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const self = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1024 } });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, c.services.assignments), self);
    const agent = (await c.services.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    const rev = (await c.services.principals.get(principalId))!.revision;
    await c.services.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: rev, grants: workGrants(project, ["read-file"]) });
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Dig" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
    const a = (await c.services.assignments.getAssignment(task))!;
    const attempt = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: a.owner ?? { kind: "agent", id: agent }, harness: "pi" })).id;
    const tick = await c.dispatch.dispatcher.tick();
    assert.deepEqual(tick.started, [attempt], JSON.stringify({ s: tick.skipped, f: tick.failures }));
    await started[0];

    const made = await api(c, boot.token, "backup.now", {}, "b1");
    assert.ok(made.ok, JSON.stringify(made));
    const name = made.result.item.name as string;
    const preview = (await api(c, boot.token, "backup.restore.preview", { name })).result.item;
    assert.ok(preview.warnings.some((w: string) => /1 agent attempt is running now.*stopAttempts/.test(w)), JSON.stringify(preview.warnings));

    // Refused while the attempt runs: nothing is held afterwards.
    const refused = await api(c, boot.token, "backup.restore.apply", { name, confirm: preview.token }, "r1");
    assert.equal(refused.ok, false);
    assert.match(refused.error!.message, /agent attempt\(s\) are still running/);
    for (const n of WRITERS) assert.equal(c.services.barrierWork.isHeld(n), false, `${n} is let go after a refused raise`);
    assert.equal((await api(c, boot.token, "backup.restore.status", {})).result.item.barrier.held, false);
    // A wrong type for the option is refused.
    const wrong = await api(c, boot.token, "backup.restore.apply", { name, confirm: preview.token, stopAttempts: "yes" }, "r2");
    assert.equal(wrong.ok, false); assert.equal(wrong.error!.code, "invalid_command");

    // With stopAttempts the work is suspended first and the restore is prepared.
    const preview2 = (await api(c, boot.token, "backup.restore.preview", { name })).result.item;
    const t0 = Date.now();
    const applied = await api(c, boot.token, "backup.restore.apply", { name, confirm: preview2.token, stopAttempts: true }, "r3");
    assert.ok(Date.now() - t0 < 20_000, `the suspend settled promptly (${Date.now() - t0} ms)`);
    assert.ok(applied.ok, JSON.stringify(applied));
    assert.equal((await c.dispatch.dispatcher.liveAttempts(c.dispatch.principal)).filter((x) => x.state === "running").length, 0, "no attempt is running ");
    assert.ok(stopped.length >= 1 || (await c.dispatch.dispatcher.get(c.dispatch.principal, attempt))?.state !== "running", "the attempt was stopped");
    // The barrier is up with every named writer as a participant of its own, and each is held.
    const status = (await api(c, boot.token, "backup.restore.status", {})).result.item;
    assert.equal(status.barrier.held, true);
    for (const p of ["backups", "dispatcher", "retention-runner", "notification-sweeps", "handoff-and-resume-sweeps", "maintenance-loop"]) assert.ok(status.barrier.participants.includes(p), `${p} is a participant: ${status.barrier.participants.join(", ")}`);
    for (const n of WRITERS) assert.ok(c.services.barrierWork.names.includes(n), `${n} is wrapped where it is started`);
    for (const n of WRITERS) assert.equal(c.services.barrierWork.isHeld(n), true, `${n} is held while the restore waits`);
    // Withdrawn: they go on again.
    assert.ok((await api(c, boot.token, "backup.restore.cancel", {}, "c1")).ok);
    for (const n of WRITERS) assert.equal(c.services.barrierWork.isHeld(n), false, `${n} is let go when the restore is withdrawn`);
    await sleep(10);
  } finally { for (const f of finishes) f(); await c.close().catch(() => undefined); rmSync(dir, { recursive: true, force: true }); }
});
