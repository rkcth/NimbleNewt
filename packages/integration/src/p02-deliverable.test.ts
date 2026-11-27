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

// Card P02, the clause moved from Q01 on 2026-11-27: work made in the task workspace reaches Q01 as a versioned code deliverable linked to its code submission and is accepted or rejected there, and tool completion
// alone still cannot accept it. Through the PRODUCT composition, with the rig of h12n-launcher-submit: the launcher's worker host on this computer (scripts/local-host.mjs), a real bubblewrap sandbox, a real git
// checkout and a scripted model behind an injected fetch (nothing leaves the machine). (1) The agent edits its task checkout and ends with `work.end { submit: true }`, which opens a code submission with the checkout's
// real base, staged tree and patch ID. (2) In the task's next attempt the responsible agent reads the submission ID back with task.recall, drafts a code deliverable naming it and submits it, all through its own tool
// bridge (the bridge names the task and the contract version the attempt began with). (3) A different agent holding the reviewer role starts the review and accepts version 1; the agent that made the submission cannot. (4) A second version is
// rejected with its reason and the rejection stays on the record when a third version starts. (5) Finishing the task accepts nothing: the third version stays submitted. Skipped without bubblewrap unless
// NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
// No system or user git configuration is read, so the committed files and the expected tree do not depend on the machine.
const gitEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
const G = ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false"];
const git = (args: string[], options: { cwd?: string; input?: string } = {}): string => execFileSync("git", [...G, ...args], { ...options, env: gitEnv, encoding: "utf8" }).trim();
const sh = (cwd: string, ...args: string[]): string => git(args, { cwd });
const memorySecrets = (seed: Record<string, string>): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
const REPORT = "did the work; found nothing; left nothing; could not do nothing";
const reply = (body: string): Response => new Response(`${body}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
const say = (text: string): Response => reply(`${sse({ role: "assistant", content: "" }, null)}${sse({ content: text }, null)}${sse({}, "stop", usage)}`);
const tool = (name: string, args: Record<string, unknown>, id: string): Response => reply(sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null) + sse({}, "tool_calls", usage));
const workEnd = (args: Record<string, unknown>, id: string): Response => tool("nimblenewt__work-end", args, id);
// What the bridge answered to one tool call of this attempt, read back from the messages the worker sent the model next (undefined until it has answered).
const answerTo = (text: string, callId: string): any => { const m = (JSON.parse(text) as { role?: string; tool_call_id?: string; content?: string }[]).find((x) => x.role === "tool" && x.tool_call_id === callId); return m?.content === undefined ? undefined : JSON.parse(m.content); };

test("work made in the task workspace reaches acceptance as a versioned code deliverable linked to its real code submission: a different reviewer accepts one version and rejects the next, the rejection is kept, and finishing the task accepts nothing (card P02, clause moved from Q01)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder, hostBaseOf } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never; hostBaseOf: (d: string) => string };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn p02 deliverable ")));
  const dir = join(parent, "data");
  const garden = join(parent, "garden");
  mkdirSync(join(garden, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", garden);
  writeFileSync(join(garden, "README.md"), "hello\n"); writeFileSync(join(garden, "src", "a.ts"), "export const a = 1;\n");
  sh(garden, "add", "-A"); sh(garden, "commit", "-q", "-m", "first");
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value" });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {} } };
  const taskDir = (projectId: string, taskId: string): string => join(hostBaseOf(dir), "work", projectId, taskId);

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
    return steps[Math.min(done.length, steps.length - 1)]!(text);
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
    const call = (token: string, op: string, args: Record<string, unknown>, id?: string) => c.api.handle(token, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    const api = (op: string, args: Record<string, unknown>, id?: string) => call(l.ownerToken, op, args, id);
    await PolicyService.withEpoch(c.storage, c.epoch, s.grants).set(owner, { scope: "installation", commandId: "pol", profile: "autonomous" } as never);
    const project = (await s.projects.createProject({ commandId: "pA", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: garden }] } as never)).id;
    await s.resources.bindResource(owner, { commandId: "bind-garden", projectId: project, kind: "repository", label: "garden", locator: garden, repositoryId: "garden", access: "write" });
    // Ann does the work and is the deliverable's responsible agent; she also holds the reviewer role and the review right, so only the contributor rule (Q01b, Q04) keeps her from reviewing her own code. Rev and Rae
    // review; Bob is another author of the project.
    const hire = async (name: string, roles: string[]): Promise<string> => `agent:${(await s.agents.create(owner, { commandId: `ag-${name}`, friendlyName: name, roles } as never)).id}`;
    const ann = await hire("Ann", ["author", "reviewer"]);
    await s.principals.setGrants(owner, { commandId: "gr1", principalId: ann, expectedRevision: (await s.principals.get(ann))!.revision, grants: [...workGrants(project, ["write-file"]), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }] });
    const rev = await hire("Rev", ["reviewer"]);
    const rae = await hire("Rae", ["reviewer"]);
    const bob = await hire("Bob", ["author"]);
    for (const [who, action] of [[ann, "review.decide"], [rev, "task.read"], [rev, "review.decide"], [rae, "task.read"], [rae, "review.decide"], [bob, "task.read"]] as const) await s.grants.grant(owner, { commandId: `g-${who}-${action}`, grantee: who, action, project, source: "direct", basis: "test" } as never);
    const revToken = (await s.principals.issueCredential(owner, rev)).token;
    const raeToken = (await s.principals.issueCredential(owner, rae)).token;
    const bobToken = (await s.principals.issueCredential(owner, bob)).token;

    // ---- (1) Ann edits the checkout of her task and ends with work.end { submit: true }: a real code submission ----
    const title = "Sow the beans";
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title })).id;
    const otherTask = (await s.projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "Weed the path" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: (await s.projects.getTask(taskId))!.revision, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: ann.slice("agent:".length) } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: ann.slice("agent:".length) }, harness: "pi" })).id;
    const base = sh(garden, "rev-parse", "HEAD");
    const checkout = join(taskDir(project, taskId), "checkout");
    scripts.set(title, [
      () => { writeFileSync(join(checkout, "src", "b.ts"), "export const b = 1;\n"); return workEnd({ report: REPORT, result: "done", submit: true }, "call_1"); },
      () => say("all done"),
    ]);
    assert.deepEqual((await d.dispatcher.tick()).started, [attemptId]);
    await until(async () => (await d.dispatcher.get(d.principal, attemptId))?.state === "finished", 180_000, () => `the attempt never finished (${seen.get(title)?.length ?? 0} model calls)`);
    await d.dispatcher.idle();
    await until(async () => (await s.workEnd.get(attemptId))?.state === "done", 60_000, "the ending was not completed");
    const ending = (await s.workEnd.get(attemptId))!;
    assert.deepEqual([ending.outcome, typeof ending.submissionId], ["submitted", "string"], JSON.stringify(ending));
    const sid = ending.submissionId!;
    const sub = (await api("submission.get", { submissionId: sid })).result.item;
    const t1 = taskDir(project, taskId);
    const tree = git(["--git-dir", join(t1, "task.git"), "--work-tree", checkout, "write-tree"]);
    assert.deepEqual([sub.kind, sub.role, sub.taskId, sub.submittedBy, sub.base, sub.tree], ["code", "author", taskId, ann, base, tree], "a real submission: the checkout's base and staged tree, made by Ann");
    assert.match(String(sub.patchId), /^[0-9a-f]{40}$/);
    // The ending itself made no deliverable and accepted nothing.
    assert.deepEqual((await api("deliverable.record.list", { taskId })).result.items, [], "work.end drafts no deliverable");

    // ---- (2) the responsible agent drafts a code deliverable naming that submission and submits it, through its own tool bridge in the task's next attempt ----
    // Only Ann's own submission of this task can be linked: another task's deliverable, another agent and an unknown ID are refused in plain words. Ann's task credential is the one her tool bridge forwards with.
    let annToken = (await s.taskCredentials.issue(owner, { commandId: "tc-ann", taskId, agentId: ann })).token;
    const notOurs = /is not a submission of this task by the responsible agent/;
    const elsewhere = await api("deliverable.draft", { taskId: otherTask, type: "code", title: "Wrong task", responsibleAgent: ann, submissionIds: [sid] }, "x1");
    assert.equal(elsewhere.error?.code, "invalid_command", JSON.stringify(elsewhere));
    assert.match(elsewhere.error.message, new RegExp(`${sid} is not a submission of this task by the responsible agent`));
    assert.ok(elsewhere.error.message.length < 300);
    const claimed = await call(bobToken, "deliverable.draft", { taskId, type: "code", title: "Not mine", submissionIds: [sid] }, "x2");
    assert.deepEqual([claimed.error?.code, notOurs.test(claimed.error?.message ?? "")], ["invalid_command", true], `another author cannot claim Ann's code: ${JSON.stringify(claimed)}`);
    const unknown = await call(annToken, "deliverable.draft", { taskId, type: "code", title: "Unknown", submissionIds: ["sbm-aaaaaaaaaaaaaaaaaaaa"] }, "x3");
    assert.deepEqual([unknown.error?.code, notOurs.test(unknown.error?.message ?? "")], ["invalid_command", true], JSON.stringify(unknown));
    // The next attempt of the task is not handed the submission ID; the agent reads it back with task.recall (the earlier attempt's outcome names it), then drafts the deliverable and submits it with the bridge's own tools. The bridge
    // names the task (the attempt's) and the contract version (the one this attempt began with); the agent names neither.
    const a2 = (await s.assignments.getAssignment(taskId))!;
    const attempt2Id = (await s.assignments.admitAttempt({ commandId: "ad2", actor: "inbox", taskId, expectedRevision: a2.revision, generation: a2.generation, owner: { kind: "agent", id: ann.slice("agent:".length) }, harness: "pi" })).id;
    let learned: string | undefined; let draftAnswer: any; let submitAnswer: any;
    seen.set(title, []);
    scripts.set(title, [
      () => tool("nimblenewt__task-recall", { part: "activity" }, "call_r"),
      (text) => { learned = /sbm-[a-z0-9]{20}/.exec(String(answerTo(text, "call_r")?.text ?? ""))?.[0]; return tool("nimblenewt__deliverable-draft", { type: "code", title: "Bean patch", submissionIds: [learned ?? "none"] }, "call_d"); },
      (text) => { draftAnswer = answerTo(text, "call_d"); return tool("nimblenewt__deliverable-submit", { id: draftAnswer?.id ?? "none", expectedRevision: draftAnswer?.revision ?? 0 }, "call_s"); },
      (text) => { submitAnswer = answerTo(text, "call_s"); return workEnd({ report: REPORT, result: "done" }, "call_e"); },
      () => say("all done"),
    ]);
    assert.deepEqual((await d.dispatcher.tick()).started, [attempt2Id]);
    await until(async () => (await d.dispatcher.get(d.principal, attempt2Id))?.state === "finished", 180_000, () => `the second attempt never finished (${seen.get(title)?.length ?? 0} model calls)`);
    await d.dispatcher.idle();
    // The second attempt's own task credential replaced the one issued above (issuing again for the same agent and task replaces the earlier one); Ann's later steps (her refused review, the new versions) use a new one.
    assert.equal((await call(annToken, "deliverable.record.list", { taskId })).error?.code, "unauthenticated");
    annToken = (await s.taskCredentials.issue(owner, { commandId: "tc-ann2", taskId, agentId: ann })).token;
    assert.equal(learned, sid, "task.recall names the earlier attempt's submission");
    assert.match(String(draftAnswer?.id), /^dlv-/, JSON.stringify(draftAnswer));
    assert.equal(submitAnswer?.id, draftAnswer.id, JSON.stringify(submitAnswer));
    const id = draftAnswer.id as string;
    const contractVersion = (await d.dispatcher.get(d.principal, attempt2Id))!.revisions?.contract ?? 0;
    const v1 = (await api("deliverable.record.get", { id })).result.item;
    assert.deepEqual([v1.type, v1.taskId, v1.responsibleAgent, v1.state, v1.version.version, v1.version.contractVersion, v1.version.submittedBy, v1.version.review.required], ["code", taskId, ann, "submitted", 1, contractVersion, ann, true]);
    assert.deepEqual(v1.version.content.submissions, [{ id: sid, kind: "code", submittedBy: ann, tree }], "the version binds the submission and the tree it was made with");

    // ---- (3) a different reviewer starts the review and accepts it; the agent that made the code cannot ----
    const self = await call(annToken, "deliverable.review.start", { id, version: 1 }, "rs0");
    assert.deepEqual([self.error?.code, /no self-review/.test(self.error?.message ?? "")], ["forbidden", true], `the submitter of the linked code is a contributor and cannot review it, though she holds the reviewer role: ${JSON.stringify(self)}`);
    const noRole = await call(bobToken, "deliverable.review.start", { id, version: 1 }, "rs0b");
    assert.deepEqual([noRole.error?.code, /only the owner, a director of this project or a reviewer/.test(noRole.error?.message ?? "")], ["forbidden", true], `an author without the reviewer role cannot review it: ${JSON.stringify(noRole)}`);
    assert.equal((await call(revToken, "deliverable.review.start", { id, version: 1 }, "rs1")).ok, true);
    assert.equal((await call(annToken, "deliverable.accept", { id, version: 1 }, "ac0")).error?.code, "forbidden", "the responsible agent cannot accept its own work");
    const other = await call(raeToken, "deliverable.accept", { id, version: 1 }, "ac0b");
    assert.deepEqual([other.error?.code, /decides only on a review it started/.test(other.error?.message ?? "")], ["forbidden", true], `a reviewer decides only on a review it started: ${JSON.stringify(other)}`);
    const accepted = await call(revToken, "deliverable.accept", { id, version: 1, reason: "the beans are sown" }, "ac1");
    assert.equal(accepted.ok, true, JSON.stringify(accepted));
    const got1 = (await api("deliverable.record.get", { id, version: 1 })).result.item;
    assert.deepEqual([got1.state, got1.version.state, got1.version.reviewer, got1.version.decidedBy], ["accepted", "accepted", rev, rev]);

    // ---- (4) a second version of the same code is rejected, and the rejection stays on the record when a third version starts ----
    const nv2 = await call(annToken, "deliverable.version.new", { id, expectedRevision: (await api("deliverable.record.get", { id })).result.item.revision, submissionIds: [sid], note: "second look" }, "v2");
    assert.equal(nv2.ok, true, JSON.stringify(nv2));
    const stale = await call(annToken, "deliverable.submit", { id, expectedRevision: nv2.result.revision, contractVersion: contractVersion + 1 }, "v2s0");
    assert.deepEqual([stale.error?.code, /^the task contract is at version/.test(stale.error?.message ?? "")], ["stale_revision", true], `a version is submitted only against the task's current contract version: ${JSON.stringify(stale)}`);
    assert.equal((await call(annToken, "deliverable.submit", { id, expectedRevision: nv2.result.revision, contractVersion }, "v2s")).ok, true);
    assert.equal((await call(revToken, "deliverable.review.start", { id, version: 2 }, "v2r")).ok, true);
    assert.equal((await call(revToken, "deliverable.reject", { id, version: 2 }, "v2x0")).error?.code, "invalid_command", "a rejection says why");
    const rejected = await call(revToken, "deliverable.reject", { id, version: 2, reason: "the rows are crooked" }, "v2x");
    assert.equal(rejected.ok, true, JSON.stringify(rejected));
    const nv3 = await call(annToken, "deliverable.version.new", { id, expectedRevision: rejected.result.revision, submissionIds: [sid] }, "v3");
    assert.equal(nv3.ok, true, JSON.stringify(nv3));
    const got2 = (await api("deliverable.record.get", { id, version: 2 })).result.item.version;
    assert.deepEqual([got2.state, got2.decidedBy, got2.reason], ["rejected", rev, "the rows are crooked"], "the rejected version keeps its verdict, decider and reason");
    assert.equal((await api("deliverable.record.get", { id, version: 1 })).result.item.version.state, "superseded", "the accepted version was superseded by the newer one");

    // ---- (5) finishing the task accepts nothing: version 3 is submitted, the task is finished, and the version is still only submitted ----
    assert.equal((await call(annToken, "deliverable.submit", { id, expectedRevision: nv3.result.revision, contractVersion }, "v3s")).ok, true);
    const before = (await api("deliverable.record.events", { id })).result.items.map((e: any) => `${e.version}:${e.kind}`);
    let task = (await s.projects.getTask(taskId))!;
    if (task.state === "ready") task = await s.projects.transitionTask({ commandId: "fin0", actor: owner.id, taskId, expectedRevision: task.revision, to: "in_progress" }).then(async () => (await s.projects.getTask(taskId))!);
    if (task.state !== "done") await s.projects.transitionTask({ commandId: "fin1", actor: owner.id, taskId, expectedRevision: task.revision, to: "done" });
    assert.equal((await s.projects.getTask(taskId))!.state, "done");
    const after = (await api("deliverable.record.get", { id })).result.item;
    assert.deepEqual([after.state, after.version.version, after.version.state, after.version.decidedBy], ["submitted", 3, "submitted", undefined], "the finished task did not accept the version");
    const events = (await api("deliverable.record.events", { id })).result.items.map((e: any) => `${e.version}:${e.kind}`);
    assert.deepEqual(events, before, "finishing the task wrote no deliverable event");
    assert.deepEqual(events, ["1:draft", "1:submitted", "1:under-review", "1:accepted", "1:superseded", "2:draft", "2:submitted", "2:under-review", "2:rejected", "3:draft", "3:submitted"], "every move is its own event; the history keeps the acceptance and the rejection");
    await l.close();
    second = undefined;
  } finally {
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
