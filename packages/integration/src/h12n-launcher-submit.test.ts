import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BlockerService, launch, PolicyService, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// Card H12n through the PRODUCT composition (the H12n and H12t flip audits found the gap): the launcher's worker host on this computer (scripts/local-host.mjs) now answers a submit's view and staging from the checkouts its
// workspace port made, so an agent's `work.end { submit: true }` opens a code submission without the owner's release and landing. Four attempts of one project, each in a real bubblewrap sandbox, with a scripted model:
// (1) a stale base with no shared file submits the checkout's real base, staged tree and git's stable patch ID; (2) a stale base where the landing branch changed the agent's file is refused at once with the head and the file,
// and the agent's plain end is taken; (3) a write call in flight when the ending settles (begun on the host and never reported, as when the host's worker dies mid-call) is cut and the submit becomes a plain end with a typed
// `release_failed` blocker; (4) once the owner narrows the repository's binding to read only, neither the view nor the staging answers (card P02), so the submit is refused and nothing is staged. The model is a scripted
// OpenAI-compatible server behind an injected fetch; nothing leaves the machine. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const memorySecrets = (seed: Record<string, string>): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const REPORT = "did the work; found nothing; left nothing; could not do nothing";
const reply = (body: string): Response => new Response(`${body}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const say = (text: string): Response => reply(`${sse({ role: "assistant", content: "" }, null)}${sse({ content: text }, null)}${sse({}, "stop", usage)}`);
const workEnd = (args: Record<string, unknown>, id: string): Response => reply(sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id, type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify(args) } }] }, null) + sse({}, "tool_calls", usage));

test("the launcher's product worker host answers a submit: work.end { submit: true } opens a code submission with the checkout's base, tree and patch ID; an overlapping stale base is refused with the head and the files; a killed write call ends it release_failed; a repository no longer bound for writing refuses it (card H12n, product launcher)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder, hostBaseOf } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never; hostBaseOf: (d: string) => string };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn h12n launcher ")));
  const dir = join(parent, "data");
  const garden = join(parent, "garden");
  mkdirSync(join(garden, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", garden);
  writeFileSync(join(garden, "README.md"), "hello\n"); writeFileSync(join(garden, "src", "a.ts"), "export const a = 1;\n");
  sh(garden, "add", "-A"); sh(garden, "commit", "-q", "-m", "first");
  const advance = (files: Record<string, string>): string => { for (const [p, text] of Object.entries(files)) writeFileSync(join(garden, p), text); sh(garden, "add", "-A"); sh(garden, "commit", "-q", "-m", "moved"); return sh(garden, "rev-parse", "HEAD"); };
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value" });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {} } };
  const taskDir = (projectId: string, taskId: string): string => join(hostBaseOf(dir), "work", projectId, taskId);

  // The agent's streamed model calls, by task (its title is in the conversation). Each step is what the test does during that call, then the model's answer.
  type Step = (text: string) => Response | Promise<Response>;
  const scripts = new Map<string, Step[]>();
  const seen = new Map<string, string[]>();
  const fetchAll: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; messages: unknown[] };
    assert.equal(body.stream, true, "only the agent calls a model here");
    const text = JSON.stringify(body.messages);
    const title = [...scripts.keys()].find((k) => text.includes(k));
    assert.ok(title !== undefined, "a call of a task this test made");
    const steps = scripts.get(title)!;
    const done = seen.get(title) ?? [];
    seen.set(title, [...done, text]);
    const step = steps[Math.min(done.length, steps.length - 1)]!;
    return step(text);
  };
  const start = { facts, filesystem: ext4, dispatch: { manual: true } } as const;
  const builder = localHostBuilder({ root: repository });
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const call1 = (op: string, args: Record<string, unknown>, id?: string) => first.controller.api.handle(first.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    assert.equal((await call1("host.local.set", { enabled: true }, "host-on")).ok, true);
    const providers = await call1("routing.provider.add", { providers: [
      { name: "primary", location: "local", endpoint: "http://127.0.0.1:9201/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "primary-key" },
      { name: "backup", location: "local", endpoint: "http://127.0.0.1:9202/v1", models: ["local-y"], contextTokens: 65536, paid: false, credentialName: "primary-key" },
    ], expectedRevision: (await first.controller.services.routing.get())?.revision ?? 0 }, "prov-1");
    assert.ok(providers.ok, JSON.stringify(providers));
    await first.close();

    // The next start builds the product host (scripts/local-host.mjs).
    second = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const l = second;
    assert.ok(l.controller.dispatch !== undefined, l.notes.join(" | "));
    const c = l.controller;
    const d = c.dispatch!;
    const s = c.services;
    const owner = await s.principals.authenticate(l.ownerToken);
    const api = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(l.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    // A tool call begins at once (no owner approval asked), so one can be left in flight.
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "pA", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: garden }] } as never)).id;
    // Card P02: the workspace opens only on a repository the project has bound with write access to all of it.
    const binding = await s.resources.bindResource(owner, { commandId: "bind-garden", projectId: project, kind: "repository", label: "garden", locator: garden, repositoryId: "garden", access: "write" });
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: (await s.principals.get(principalId))!.revision, grants: [...workGrants(project, ["write-file"]), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }] });
    let n = 0;
    const attempts = new Map<string, { taskId: string; attemptId: string }>();
    const runTask = async (title: string, steps: Step[]) => {
      n++;
      scripts.set(title, steps);
      const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: (await s.projects.getTask(taskId))!.revision, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      attempts.set(title, { taskId, attemptId });
      assert.deepEqual((await d.dispatcher.tick()).started, [attemptId]);
      await until(async () => (await d.dispatcher.get(d.principal, attemptId))?.state === "finished", 180_000, () => `the attempt of "${title}" never finished (${seen.get(title)?.length ?? 0} model calls)`);
      await d.dispatcher.idle();
      await until(async () => (await s.workEnd.get(attemptId))?.state === "done", 60_000, `the ending of "${title}" was not completed`);
      return { taskId, attemptId, ending: (await s.workEnd.get(attemptId))!, attempt: (await d.dispatcher.get(d.principal, attemptId))! };
    };
    const submissionsOf = async (taskId: string) => ((await api("submission.list", { taskId })).result.items as { kind: string }[]);
    const checkoutOf = (title: string): string => join(taskDir(project, attempts.get(title)!.taskId), "checkout");

    // ---- (1) a stale base with no shared file: one code submission with the checkout's real base, staged tree and patch ID ----
    const base1 = sh(garden, "rev-parse", "HEAD");
    const one = await runTask("Sow the beans", [
      () => {
        writeFileSync(join(checkoutOf("Sow the beans"), "src", "b.ts"), "export const b = 1;\n");
        advance({ "README.md": "hello again\n" });
        return workEnd({ report: REPORT, result: "done", submit: true }, "call_1");
      },
      () => say("all done"),
    ]);
    assert.deepEqual([one.ending.outcome, typeof one.ending.submissionId], ["submitted", "string"], JSON.stringify(one.ending));
    assert.equal(one.attempt.outcome?.status, "succeeded", JSON.stringify(one.attempt.outcome));
    const sub = await api("submission.get", { submissionId: one.ending.submissionId });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const t1 = taskDir(project, one.taskId);
    const g = (...args: string[]): string => execFileSync("git", ["--git-dir", join(t1, "task.git"), "--work-tree", join(t1, "checkout"), ...args], { encoding: "utf8" }).trim();
    const patch = execFileSync("git", ["patch-id", "--verbatim"], { input: execFileSync("git", ["--git-dir", join(t1, "task.git"), "diff", "--cached", "--binary", "--full-index", base1], { encoding: "utf8" }), encoding: "utf8" }).trim().split(/\s+/)[0];
    assert.deepEqual([sub.result.item.kind, sub.result.item.role, sub.result.item.taskId, sub.result.item.base, sub.result.item.tree, sub.result.item.patchId], ["code", "author", one.taskId, base1, g("write-tree"), patch], "the submission carries what the product host staged in the task's checkout");
    assert.equal(g("diff", "--cached", "--name-only", base1), "src/b.ts", "only the agent's file is staged (the landing branch's README is not the agent's)");
    // The submission is frozen: a change of the checkout after the ending does not change what was submitted.
    writeFileSync(join(t1, "checkout", "src", "b.ts"), "export const b = 99;\n");
    assert.equal((await api("submission.get", { submissionId: one.ending.submissionId })).result.item.tree, sub.result.item.tree);

    // ---- (2) the landing branch changed the agent's file: refused at once with the head and the file; the plain end is taken ----
    let head2 = "";
    const two = await runTask("Prune the hedge", [
      () => {
        writeFileSync(join(checkoutOf("Prune the hedge"), "src", "a.ts"), "export const a = 2;\n");
        head2 = advance({ "src/a.ts": "export const a = 10;\n" });
        return workEnd({ report: REPORT, result: "done", submit: true }, "call_1");
      },
      () => workEnd({ report: REPORT, result: "done" }, "call_2"),
      () => say("all done"),
    ]);
    const refusal2 = seen.get("Prune the hedge")![1]!;
    assert.match(refusal2, new RegExp(`submit refused: the landing branch moved to ${head2} and changed 1 of your files \\(src/a\\.ts\\)`), "the agent is told the head and the file");
    assert.notEqual(two.ending.outcome, "submitted", JSON.stringify(two.ending));
    assert.equal(two.ending.submissionId, undefined);
    assert.deepEqual(await submissionsOf(two.taskId), [], "nothing was recorded for the refused submit");

    // ---- (3) a write call in flight when the ending settles: cut as uncertain; the submit becomes a plain end with a typed release_failed blocker ----
    const three = await runTask("Water the roses", [
      async () => {
        writeFileSync(join(checkoutOf("Water the roses"), "src", "c.ts"), "export const c = 1;\n");
        // The host begins a write and its worker dies before it can report: the call stays in flight on the controller.
        const began = await d.dispatcher.gateway(attempts.get("Water the roses")!.attemptId).begin({ callId: "w1", tool: { name: "write-file", version: "1.0.0" }, args: { path: "src/c.ts" } } as never);
        assert.equal(began.run, true, JSON.stringify(began));
        return workEnd({ report: REPORT, result: "done", submit: true }, "call_1");
      },
      () => say("all done"),
    ]);
    assert.deepEqual([three.ending.outcome, three.ending.typed, three.ending.submissionId], ["ended", "release_failed", undefined], JSON.stringify(three.ending));
    assert.match(three.ending.summary ?? "", /^release_failed: 1 write call\(s\) had to be killed \(w1: its outcome is not known\); the work was not submitted/);
    const op = ((await d.dispatcher.operations(d.principal, three.attemptId)) ?? []).find((o) => o.callId === "w1");
    assert.deepEqual([op?.state, op?.readOnly], ["uncertain", false]);
    assert.deepEqual(await submissionsOf(three.taskId), []);
    const t3 = taskDir(project, three.taskId);
    assert.equal(execFileSync("git", ["--git-dir", join(t3, "task.git"), "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "", "nothing was staged");
    const blocker = await BlockerService.withEpoch(c.storage, c.epoch).openFor("runtime_hold", { kind: "task", id: three.taskId });
    assert.ok(blocker !== undefined, "the owner has an open blocker on the task");
    assert.equal(blocker.id, three.ending.blocker);
    assert.match(blocker.summary, /^release_failed: 1 write call\(s\) had to be killed/);

    // ---- (4) the owner narrows the repository's binding to read only while the agent works: neither the view nor the staging answers (P02), the submit is refused, nothing is staged ----
    let staging: unknown;
    const four = await runTask("Rake the leaves", [
      async () => {
        writeFileSync(join(checkoutOf("Rake the leaves"), "src", "d.ts"), "export const d = 1;\n");
        const current = (await s.resources.get(owner, binding.id))!;
        await s.resources.setScope(owner, { commandId: "narrow", resourceId: binding.id, expectedRevision: current.revision, access: "read" });
        // The staging itself refuses too (asked as the ending would, through the dispatcher): the attempt is live and its checkout holds a change.
        staging = await d.dispatcher.stageWork(d.principal, attempts.get("Rake the leaves")!.attemptId).then((x) => x, (e: Error) => e);
        return workEnd({ report: REPORT, result: "done", submit: true }, "call_1");
      },
      () => workEnd({ report: REPORT, result: "done" }, "call_2"),
      () => say("all done"),
    ]);
    assert.ok(staging instanceof Error, `the staging is refused: ${JSON.stringify(staging)}`);
    assert.match((staging as Error).message, /the work cannot be submitted: the project has read access only to repository "garden"/);
    const refusal4 = seen.get("Rake the leaves")![1]!;
    assert.match(refusal4, /the checkout's base is not known, so a submit cannot be checked/, "the submit is refused as unavailable");
    assert.notEqual(four.ending.outcome, "submitted", JSON.stringify(four.ending));
    assert.deepEqual(await submissionsOf(four.taskId), []);
    const t4 = taskDir(project, four.taskId);
    assert.equal(execFileSync("git", ["--git-dir", join(t4, "task.git"), "diff", "--cached", "--name-only"], { encoding: "utf8" }).trim(), "", "nothing was staged");
    await l.close();
    second = undefined;
  } finally {
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
