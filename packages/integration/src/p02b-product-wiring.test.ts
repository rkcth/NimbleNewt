import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// (copied harness) Card H12t, end to end through the product composition: the launcher builds the worker host on this computer (scripts/local-host.mjs) with the production workspace port (LocalWorkspaces). An attempt runs in a real
// bubblewrap sandbox in the checkout the port made; while its model call is in flight a refresh is refused by the host's own busy check; its done is checked by the host against that checkout (the contract's check runs in the
// sandbox); then the owner's landing policy is what landings run under: nothing is landed until a branch is named (no hard-coded `main`), the installation's branch serves a project that names none, and a project's own
// landing branch (`project.branches.set`) lands a second project on a different branch. A refresh and a quarantine of the checkout are answered by the same port. The model is a scripted OpenAI-compatible server behind an
// injected fetch; nothing leaves the machine. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const memorySecrets = (seed: Record<string, string>): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };

function repo(parent: string, name: string, branch: string): string {
  const dir = join(parent, name);
  mkdirSync(join(dir, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", branch, dir);
  writeFileSync(join(dir, "src", "a.ts"), "export const a = 1;\n");
  sh(dir, "add", "-A"); sh(dir, "commit", "-q", "-m", "first");
  return dir;
}

// Card P02b, the product wiring end to end: the launcher builds the worker host on this computer (scripts/local-host.mjs), which now carries the work-in-progress backup over the same checkouts with the scan fed by the secret store. An
// owner turns the backup on through the API (a real standing grant appears among the standing rules), the sweep backs up the checkout an attempt worked in (a file holding the value of a secret in use is left out), revoking the
// grant in the list ends it, and after the task's folder is lost a restore through the API brings the backed-up work back as the task's own checkout. A task that works on another host is refused with the reason (that call is
// proved in the controller's own tests). Local bare repository as the remote; no network, no real credential. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1.
test("the product host backs up a task's work in progress with the secret store's values in the scan, the standing approval is a revocable grant, and a lost task folder is restored through the API", async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder, hostBaseOf } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never; hostBaseOf: (d: string) => string };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn p02b host ")));
  const dir = join(parent, "data");
  const garden = repo(parent, "garden", "main");
  // The remote is the owner's own folder; a remote address may not hold a space, so it lives in a folder of its own beside (not under) the one with spaces.
  const remoteParent = realpathSync(mkdtempSync(join(tmpdir(), "nn-p02b-remote-")));
  const remote = join(remoteParent, "wip-remote.git");
  sh(remoteParent, "init", "-q", "--bare", "-b", "main", remote);
  // The provider key is the secret in use: a passphrase with no credential shape, so only the secret store's value can tell the scan to leave a file out.
  const passphrase = `orchard-${Math.random().toString(36).slice(2, 10)}-sunrise-banana`;
  const secrets = memorySecrets({ "primary-key": passphrase });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {} } };
  const checkoutOf = (projectId: string, taskId: string): string => join(hostBaseOf(dir), "work", projectId, taskId, "checkout");
  let mine: { project: string; task: string } | undefined;
  let calls = 0;
  const fetchAll: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    assert.equal(body.stream, true, "only the agent calls a model here");
    calls++;
    if (calls > 1) return new Response(`${sse({ role: "assistant", content: "" }, null)}${sse({ content: "all done" }, null)}${sse({}, "stop", usage)}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    // The agent's work: a module, a note that carries the secret's value, and a file of its own.
    writeFileSync(join(checkoutOf(mine!.project, mine!.task), "src", "b.ts"), "export const b = 2;\n");
    writeFileSync(join(checkoutOf(mine!.project, mine!.task), "notes.txt"), `deploy with ${passphrase}\n`);
    writeFileSync(join(checkoutOf(mine!.project, mine!.task), "todo.md"), "still to do\n");
    const end = { report: "Done as the task asked.", result: "done", note: "added the module", evidence: [{ item: "the new module", path: "src/b.ts" }] };
    const chunks = sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify(end) } }] }, null) + sse({}, "tool_calls", usage);
    return new Response(`${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const start = { facts, filesystem: ext4, dispatch: { manual: true } } as const;
  const builder = localHostBuilder({ root: repository });
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const call1 = (op: string, args: Record<string, unknown>, id?: string) => first.controller.api.handle(first.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    assert.equal((await call1("host.local.set", { enabled: true }, "host-on")).ok, true);
    const providers = await call1("routing.provider.add", { providers: [{ name: "primary", location: "local", endpoint: "http://127.0.0.1:9201/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "primary-key" }, { name: "backup", location: "local", endpoint: "http://127.0.0.1:9202/v1", models: ["local-y"], contextTokens: 65536, paid: false, credentialName: "primary-key" }], expectedRevision: (await first.controller.services.routing.get())?.revision ?? 0 }, "prov-1");
    assert.ok(providers.ok, JSON.stringify(providers));
    await first.close();

    second = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const l = second;
    assert.ok(l.controller.dispatch !== undefined, l.notes.join(" | "));
    const c = l.controller;
    const s = c.services;
    const owner = await s.principals.authenticate(l.ownerToken);
    const api = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(l.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    const A = (await s.projects.createProject({ commandId: "pA", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: garden }] } as never)).id;
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: (await s.principals.get(principalId))!.revision, grants: [...workGrants(A), ...[A].flatMap((project) => [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }])] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: A, title: "Dig the garden" })).id;
    await s.contracts.setContract(owner, { commandId: "ct1", taskId, expectedVersion: 0, requiredEvidence: ["the new module"], checks: [{ name: "has the module", run: ["/bin/sh", "-c", "test -f src/b.ts"], timeoutSeconds: 60 }] } as never);
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: (await s.projects.getTask(taskId))!.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    mine = { project: A, task: taskId };
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [attemptId]);
    await until(async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!.state === "finished", 180_000, "the attempt never finished");
    await c.dispatch!.dispatcher.idle();
    assert.ok(existsSync(join(checkoutOf(A, taskId), "notes.txt")));

    // A sweep that asks a recording port (awaited, so nothing is waited for by the clock): with nothing turned on it asks no host.
    const asked: unknown[] = [];
    const recording = { port: { backup: async (call: unknown) => { asked.push(call); return { ok: false as const, reason: "recording only" }; } }, tasks: async () => [{ taskId, developer: "agent:x", executor: "host:local" }] };
    assert.deepEqual(await s.wipBackup.sweep(owner, recording), { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
    assert.equal(sh(remote, "for-each-ref", "--format=%(refname)"), "");

    // Turned on through the API: the approval is a standing grant in the owner's list of rules.
    const on = await api("wip.backup.set", { project: A, enabled: true, remote, everyMinutes: 5, basis: "keep a copy of the garden work" }, "wip-on");
    assert.equal(on.ok, true, JSON.stringify(on));
    const viewOn = (await api("wip.backup.get", { project: A })).result.item;
    const grantId = viewOn.approval.grantId as string;
    const grant = (await api("grant.get", { grantId })).result.item;
    assert.deepEqual([grant.source, grant.action, grant.state, grant.project], ["standing", "recovery.wip-backup", "active", A]);
    assert.ok((await api("grant.list", { grantee: "service:dispatcher" })).result.items.some((g: { id: string }) => g.id === grantId), "listed with the other standing rules");

    // The sweep (the dispatcher's loop, run apart from the tick) backs the task up from the checkout the host made.
    const ref = `refs/heads/nn-wip/${A}/${taskId}`;
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await api("wip.backup.get", { project: A })).result.item.tasks.some((t: { lastSuccess?: unknown }) => t.lastSuccess !== undefined); }, 120_000, "the first backup was never confirmed");
    const view = (await api("wip.backup.get", { project: A })).result.item;
    const task = view.tasks.find((x: { taskId: string }) => x.taskId === taskId);
    assert.equal(task.lastSuccess.commitId, sh(remote, "rev-parse", ref), "the commit the controller recorded is the one the remote shows");
    const files = sh(remote, "ls-tree", "-r", "--name-only", ref).split("\n").sort();
    assert.ok(files.includes("src/b.ts") && files.includes("todo.md") && files.includes("src/a.ts"), files.join(","));
    assert.ok(!files.includes("notes.txt"), "a file that holds the value of a secret in use never leaves the machine");
    assert.deepEqual(task.blocked.map((b: { path: string; reason: string }) => [b.path, b.reason]), [["notes.txt", "holds the value of the secret primary-key"]]);
    assert.ok(!JSON.stringify(view).includes(passphrase), "the secret's value is in no record");
    assert.match(sh(remote, "log", "-1", "--format=%B", ref), new RegExp(`Developer: agent:${agent}\\n.*Executor: host:local`, "s"));
    assert.equal(sh(remote, "for-each-ref", "--format=%(refname)"), ref, "nothing else is on the remote");

    // The owner's chat-free API restore needs a lost folder to be meaningful; first, restore beside the live one (never over it).
    const beside = await api("wip.backup.restore", { project: A, taskId }, "restore-beside");
    assert.equal(beside.ok, true, JSON.stringify(beside));
    assert.match(beside.result.where, /new folder/);
    assert.ok(readdirSync(join(hostBaseOf(dir), "work", "restored", A)).length === 1);
    // Revoking the grant in the list of standing rules ends the backup: no push, no complaint.
    const before = sh(remote, "rev-parse", ref);
    writeFileSync(join(checkoutOf(A, taskId), "todo.md"), "still to do, and more\n");
    const g = (await api("grant.get", { grantId })).result.item;
    assert.equal((await api("grant.revoke", { grantId, expectedRevision: g.revision, reason: "stop" }, "wip-revoke")).ok, true);
    assert.equal((await api("wip.backup.get", { project: A })).result.item.enabled, false);
    assert.deepEqual(await s.wipBackup.sweep(owner, recording), { attempted: 0, succeeded: 0, failed: 0, skipped: 0 }, "a revoked approval asks no host");
    assert.deepEqual(asked, []);
    assert.equal(sh(remote, "rev-parse", ref), before, "and pushes nothing");

    // The task's disk is lost; the owner restores it through the API: it becomes the task's own checkout with the backed-up work.
    rmSync(join(hostBaseOf(dir), "work", A, taskId), { recursive: true, force: true });
    const restored = await api("wip.backup.restore", { project: A, taskId }, "restore-lost");
    assert.equal(restored.ok, true, JSON.stringify(restored));
    assert.match(restored.result.where, /task's own checkout/);
    assert.equal(readFileSync(join(checkoutOf(A, taskId), "src", "b.ts"), "utf8"), "export const b = 2;\n");
    assert.equal(readFileSync(join(checkoutOf(A, taskId), "todo.md"), "utf8"), "still to do\n", "the restore is the last confirmed backup, not the later state of the lost folder");
    assert.ok(!existsSync(join(checkoutOf(A, taskId), "notes.txt")));
    assert.equal(restored.result.commitId, task.lastSuccess.commitId);
    assert.equal((await api("wip.backup.restore", { project: A, taskId }, "restore-lost")).result.replayed, true);
    await l.close();
    second = undefined;
  } finally {
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
    rmSync(remoteParent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
