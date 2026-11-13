import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { GitBridge, WipBackupHost, type CheckoutLocation } from "@nimblenewt/worker";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PrincipalService } from "../security/index.js";
import { WipBackupService, createWipScanner, wipRefOf, type WipReport } from "./index.js";

after(stopServer);

// Card P02b, from the owner's turning it on to a restore: the service, the controller's scan and the worker's host against real git and a disposable bare repository on the local disk (never a real remote), on every storage backend.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const run = (n: number, seed: number): string => Array.from({ length: n }, (_, i) => ALNUM[(i * 7 + seed * 13 + (i % 5) * 11) % ALNUM.length]).join("");
let n = 0;

for (const backend of backends) {
  test(`${backend.name}: the owner turns the backup on, a sweep pushes the work in progress without the secrets, a failed push is not counted, a restore matches the last push, and turning it off stops it`, { skip }, async () => {
    const world = await backend.open();
    const dir = await mkdtemp(join(tmpdir(), "nn-wip-e2e-"));
    try {
      const clock = { ms: Date.parse("2026-11-13T10:00:00.000Z") };
      const options = { clock: () => new Date(clock.ms).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: `p-${n++}`, actor: "owner:rob", name: "Garden" })).id;
      const svc = WipBackupService.withEpoch(world.storage, projects.epoch, options);

      const shared = join(dir, "shared"); await mkdir(join(shared, "src"), { recursive: true });
      sh(dir, "init", "-q", "-b", "main", shared);
      await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
      sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
      const remote = join(dir, "remote.git"); sh(dir, "init", "-q", "--bare", "-b", "main", remote);
      const git = await GitBridge.create({ scratch: join(dir, "scratch") });
      const where: CheckoutLocation = { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: join(dir, "state"), quarantineRoot: join(dir, "quarantine") };
      await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where.gitDir, checkout: where.checkout });
      const taskId = "task-garden";
      const deployValue = "orchard-sunrise-banana-42"; // a passphrase: no credential shape, so only the secret store knows it
      const host = new WipBackupHost({ git, locate: (c) => (c.taskId === taskId ? where : undefined), scan: createWipScanner({ secrets: () => [{ name: "deploy-token", value: deployValue }] }) });
      const reports: WipReport[] = [];
      const sweep = async () => { clock.ms += 16 * 60_000; return svc.sweep(owner, { port: host, tasks: async () => [{ taskId, developer: "agent:ann", executor: "host:one" }], report: (r) => { reports.push(r); } }); };
      const ref = wipRefOf(project, taskId);
      const remoteRefs = (): string => sh(remote, "for-each-ref", "--format=%(refname)");

      const agentRefs = (): string => sh(where.gitDir, "for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/nn/base");
      const agentBefore = agentRefs();
      // Off: nothing is pushed, whatever the checkout holds.
      await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 2;\n");
      assert.deepEqual(await sweep(), { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
      assert.equal(remoteRefs(), "");

      // On: the secrets stay home, the rest goes.
      await svc.set(owner, { commandId: `on-${n++}`, projectId: project, enabled: true, remote, basis: "back up the garden work" });
      await writeFile(join(where.checkout, "settings.env"), `TOKEN=${["gh", "p_", run(36, 4)].join("")}\n`);
      await writeFile(join(where.checkout, "notes.txt"), `deploy with ${deployValue}\n`);
      await writeFile(join(where.checkout, "src", "new.ts"), "export const n = 1;\n");
      assert.deepEqual(await sweep(), { attempted: 1, succeeded: 1, failed: 0, skipped: 0 });
      assert.equal(remoteRefs(), ref, "only the project's own work-in-progress branch is on the remote");
      assert.equal(sh(remote, "ls-tree", "-r", "--name-only", ref).split("\n").sort().join(","), "README.md,src/a.ts,src/new.ts");
      let view = await svc.get(owner, project);
      const first = view.tasks[0]!;
      assert.equal(first.lastSuccess?.commitId, sh(remote, "rev-parse", ref), "the recorded commit is the one the remote shows");
      assert.deepEqual(first.blocked.map((b) => b.path).sort(), ["notes.txt", "settings.env"]);
      assert.ok(first.blocked.some((b) => b.reason === "holds the value of the secret deploy-token"));
      assert.equal(reports.filter((r) => r.kind === "blocked").length, 1);
      assert.ok(!JSON.stringify(view).includes(deployValue), "the secret value is in no record");
      const message = sh(remote, "log", "-1", "--format=%B", ref);
      assert.match(message, /NimbleNewt-WIP: unreviewed/); assert.match(message, /Developer: agent:ann/); assert.match(message, /Executor: host:one/); assert.doesNotMatch(message, /Reviewed-(by|via)/);
      assert.equal(agentRefs(), agentBefore, "the agent's own branches and base were not touched");

      // A failed push (the remote's branch moved on by itself) is reported, not counted, and not forced.
      const theirs = sh(remote, "commit-tree", "-m", "someone else", sh(remote, "rev-parse", `${ref}^{tree}`));
      sh(remote, "update-ref", ref, theirs);
      await writeFile(join(where.checkout, "src", "later.ts"), "export const l = 1;\n");
      assert.deepEqual(await sweep(), { attempted: 1, succeeded: 0, failed: 1, skipped: 0 });
      assert.equal(sh(remote, "rev-parse", ref), theirs, "the remote's branch was not forced");
      view = await svc.get(owner, project);
      assert.equal(view.tasks[0]!.lastSuccess?.commitId, first.lastSuccess?.commitId, "a failed push is not a backup");
      assert.equal(view.tasks[0]!.consecutiveFailures, 1);
      assert.equal(reports.filter((r) => r.kind === "failed").length, 1);

      // The remote is put right; the next backup carries on and a restore of the branch matches that last successful push.
      sh(remote, "update-ref", ref, first.lastSuccess!.commitId);
      assert.equal((await sweep()).succeeded, 1);
      view = await svc.get(owner, project);
      const last = view.tasks[0]!.lastSuccess!;
      assert.equal(last.commitId, sh(remote, "rev-parse", ref));
      await writeFile(join(where.checkout, "after.txt"), "work after the last push\n");
      const restored = join(dir, "restored");
      const r = await git.restoreWip({ remote, ref, gitDir: join(dir, "restored.git"), checkout: restored });
      assert.equal(r.commitId, last.commitId);
      assert.equal(await readFile(join(restored, "src", "later.ts"), "utf8"), "export const l = 1;\n");
      assert.equal(await readFile(join(restored, "src", "a.ts"), "utf8"), "export const a = 2;\n");
      await assert.rejects(readFile(join(restored, "notes.txt")), /ENOENT/);
      await assert.rejects(readFile(join(restored, "after.txt")), /ENOENT/, "work done after the last push is not in the restore");

      // Outside the approval: another branch on the same remote is not covered, and the controller pushes nothing there.
      assert.equal((await svc.authorize(project, remote, "refs/heads/main")).allowed, false);
      assert.equal(sh(remote, "for-each-ref", "--format=%(refname)", "refs/heads/main"), "");

      // Off again: revoked, nothing more is pushed.
      await svc.set(owner, { commandId: `off-${n++}`, projectId: project, enabled: false });
      const tip = sh(remote, "rev-parse", ref);
      await writeFile(join(where.checkout, "src", "last.ts"), "export const z = 1;\n");
      assert.deepEqual(await sweep(), { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
      assert.equal(sh(remote, "rev-parse", ref), tip);
    } finally { await world.close(); await rm(dir, { recursive: true, force: true }); }
  });
}
