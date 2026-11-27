import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, PolicyService, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// Card bridge-submissions, through the PRODUCT composition (the rig of h12n-launcher-submit: the launcher's worker host on this computer, scripts/local-host.mjs, a real bubblewrap sandbox, a real git checkout and a
// scripted model behind an injected fetch; nothing leaves the machine). What the hand-off brief adds to P02's end-to-end test (p02-deliverable.test.ts, which drafts through the state API and covers review and acceptance):
// an agent that works ONLY through its tool bridge learns the code submission its earlier work.end opened from the first call of its next attempt, and drafts and submits the code deliverable for it with
// nimblenewt__deliverable-draft and nimblenewt__deliverable-submit. Nobody but the agent names the submission. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
// Every git call of the test reads no system or user configuration (first review): a machine's core.autocrlf, color.ui=always or diff.external would otherwise change the files committed, or the diff the expected patch ID is taken from.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const G = ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (args: string[], options: { cwd?: string; input?: string } = {}): string => execFileSync("git", [...G, ...args], { ...options, env: gitEnv, encoding: "utf8" }).trim();
const sh = (cwd: string, ...args: string[]): string => git(args, { cwd });
const memorySecrets = (seed: Record<string, string>): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const REPORT = "did the work; found nothing; left nothing; could not do nothing";
const reply = (body: string): Response => new Response(`${body}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const say = (text: string): Response => reply(`${sse({ role: "assistant", content: "" }, null)}${sse({ content: text }, null)}${sse({}, "stop", usage)}`);
const toolCall = (name: string, args: Record<string, unknown>, id: string): Response => reply(sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null) + sse({}, "tool_calls", usage));
const workEnd = (args: Record<string, unknown>, id: string): Response => reply(sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id, type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify(args) } }] }, null) + sse({}, "tool_calls", usage));

test("the next attempt is told the code submission its work.end opened, and an agent working only through its tool bridge drafts and submits the code deliverable for it (card bridge-submissions, product launcher)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder, hostBaseOf } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never; hostBaseOf: (d: string) => string };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn bsub ")));
  const dir = join(parent, "data");
  const garden = join(parent, "garden");
  mkdirSync(join(garden, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", garden);
  writeFileSync(join(garden, "README.md"), "hello\n"); writeFileSync(join(garden, "src", "a.ts"), "export const a = 1;\n");
  sh(garden, "add", "-A"); sh(garden, "commit", "-q", "-m", "first");
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value" });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {} } };
  const taskDir = (projectId: string, taskId: string): string => join(hostBaseOf(dir), "work", projectId, taskId);

  // The agent's streamed model calls, in order; each step is the model's answer to that call (it reads what the call carries, as a model would).
  type Step = (text: string) => Response | Promise<Response>;
  let steps: Step[] = [];
  const seen: string[] = [];
  const fetchAll: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; messages: unknown[] };
    assert.equal(body.stream, true, "only the agent calls a model here");
    const text = JSON.stringify(body.messages);
    seen.push(text);
    return steps[Math.min(seen.length - 1, steps.length - 1)]!(text);
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

    second = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const l = second;
    assert.ok(l.controller.dispatch !== undefined, l.notes.join(" | "));
    const c = l.controller;
    const d = c.dispatch!;
    const s = c.services;
    const owner = await s.principals.authenticate(l.ownerToken);
    const api = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(l.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "pA", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: garden }] } as never)).id;
    await s.resources.bindResource(owner, { commandId: "bind-garden", projectId: project, kind: "repository", label: "garden", locator: garden, repositoryId: "garden", access: "write" });
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: (await s.principals.get(principalId))!.revision, grants: [...workGrants(project, ["write-file"]), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }] });
    const title = "Sow the beans";
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: (await s.projects.getTask(taskId))!.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
    const runAttempt = async (n: number) => {
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      assert.deepEqual((await d.dispatcher.tick()).started, [attemptId]);
      await until(async () => (await d.dispatcher.get(d.principal, attemptId))?.state === "finished", 180_000, () => `attempt ${n} never finished (${seen.length} model calls)`);
      await d.dispatcher.idle();
      await until(async () => (await s.workEnd.get(attemptId))?.state === "done", 60_000, `the ending of attempt ${n} was not completed`);
      return { attemptId, ending: (await s.workEnd.get(attemptId))!, attempt: (await d.dispatcher.get(d.principal, attemptId))! };
    };

    // ---- (1) the agent edits its checkout and ends with work.end { submit: true }: a code submission is opened ----
    steps = [
      () => { writeFileSync(join(taskDir(project, taskId), "checkout", "src", "b.ts"), "export const b = 1;\n"); return workEnd({ report: REPORT, result: "done", submit: true }, "call_1"); },
      () => say("all done"),
    ];
    const one = await runAttempt(1);
    assert.deepEqual([one.ending.outcome, typeof one.ending.submissionId], ["submitted", "string"], JSON.stringify(one.ending));
    const sid = one.ending.submissionId!;
    const tree = (await api("submission.get", { submissionId: sid })).result.item.tree as string;
    assert.deepEqual((await api("deliverable.record.list", { taskId })).result.items, [], "work.end drafts no deliverable");

    // ---- (2) the next attempt is told the submission in its first call and drafts and submits the deliverable naming it, through the bridge only ----
    const firstOfTwo = seen.length;
    steps = [
      ...Array.from({ length: firstOfTwo }, () => () => say("unused")),
      (text) => {
        const named = /Your newest code submission of this task is (sbm-[a-z2-7]{20});/.exec(text)?.[1];
        assert.ok(named !== undefined, `the first call names the submission: ${text.slice(-1200)}`);
        return toolCall("nimblenewt__deliverable-draft", { type: "code", title: "Bean patch", submissionIds: [named] }, "call_d");
      },
      (text) => {
        const m = [...text.matchAll(/\\"id\\":\\"(dlv-[a-z2-7]{20})\\",\\"revision\\":(\d+)/g)].pop();
        assert.ok(m !== undefined, `the draft answered its id and revision: ${text.slice(-600)}`);
        return toolCall("nimblenewt__deliverable-submit", { id: m[1], expectedRevision: Number(m[2]) }, "call_s");
      },
      () => workEnd({ report: REPORT, result: "done" }, "call_e"),
      () => say("all done"),
    ];
    const two = await runAttempt(2);
    assert.equal(two.attempt.outcome?.status, "succeeded", JSON.stringify(two.attempt.outcome));
    const opening = seen[firstOfTwo]!;
    assert.ok(opening.includes(`Your newest code submission of this task is ${sid}; draft its code deliverable with nimblenewt__deliverable-draft naming it`), `the next attempt is told its submission in its first call: ${opening.slice(-1200)}`);
    assert.doesNotMatch(opening, /submission-list/);
    const items = (await api("deliverable.record.list", { taskId })).result.items as { id: string }[];
    assert.equal(items.length, 1, JSON.stringify(items));
    const v1 = (await api("deliverable.record.get", { id: items[0]!.id })).result.item;
    assert.deepEqual([v1.type, v1.responsibleAgent, v1.state, v1.version.submittedBy], ["code", principalId, "submitted", principalId], JSON.stringify(v1));
    assert.deepEqual(v1.version.content.submissions, [{ id: sid, kind: "code", submittedBy: principalId, tree }], "the deliverable binds the submission the brief named");
    await l.close();
    second = undefined;
  } finally {
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
