import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// Card H12t, end to end through the product composition: the launcher builds the worker host on this computer (scripts/local-host.mjs) with the production workspace port (LocalWorkspaces). An attempt runs in a real
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

test("the launcher's product worker host runs an attempt in a checkout its workspace port made, refuses a refresh while a model call is in flight, checks the done there, and lands two projects on different branches under the owner's policy; refresh and quarantine are answered by the same port (card H12t)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder, hostBaseOf } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never; hostBaseOf: (d: string) => string };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn h12t host ")));
  const dir = join(parent, "data");
  const garden = repo(parent, "garden", "main");
  const orchard = repo(parent, "orchard", "trunk");
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value" });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {} } };

  // The agent's streamed model calls. The first call of each task writes the agent's work into the checkout (as its write tool would) and ends with work.end done; the next ends the turn. The first call of task A is held
  // open until the test lets it go, so a workspace request can be asked while it is in flight.
  const checkoutOf = (projectId: string, taskId: string): string => join(hostBaseOf(dir), "work", projectId, taskId, "checkout");
  const calls: { task: string; url: string }[] = [];
  let tasks: { A?: { project: string; task: string }; B?: { project: string; task: string } } = {};
  let letGo!: () => void; const held = new Promise<void>((ok) => { letGo = ok; });
  let inCall!: () => void; const callOpen = new Promise<void>((ok) => { inCall = ok; });
  const fetchAll: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; messages: unknown[] };
    assert.equal(body.stream, true, "only the agent calls a model here");
    const text = JSON.stringify(body.messages);
    const which = text.includes("Plant the orchard") ? "B" : "A";
    const mine = tasks[which]!;
    const first = calls.filter((c) => c.task === which).length === 0;
    calls.push({ task: which, url: String(url) });
    if (!first) return new Response(`${sse({ role: "assistant", content: "" }, null)}${sse({ content: "all done" }, null)}${sse({}, "stop", usage)}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    if (which === "A") { inCall(); await held; }
    writeFileSync(join(checkoutOf(mine.project, mine.task), "src", which === "A" ? "b.ts" : "c.ts"), `export const ${which === "A" ? "b" : "c"} = 2;\n`);
    const end = { report: "Done as the task asked.", result: "done", note: "added the module", evidence: [{ item: "the new module", path: which === "A" ? "src/b.ts" : "src/c.ts" }] };
    const chunks = sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify(end) } }] }, null) + sse({}, "tool_calls", usage);
    return new Response(`${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const start = { facts, filesystem: ext4, dispatch: { manual: true } } as const;
  const builder = localHostBuilder({ root: repository });
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    // First start: the owner turns the host on and registers a model provider (two routes on two servers, the fallback rule).
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const call1 = (op: string, args: Record<string, unknown>, id?: string) => first.controller.api.handle(first.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    assert.equal((await call1("host.local.set", { enabled: true }, "host-on")).ok, true);
    const providers = await call1("routing.provider.add", { providers: [
      { name: "primary", location: "local", endpoint: "http://127.0.0.1:9201/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "primary-key" },
      { name: "backup", location: "local", endpoint: "http://127.0.0.1:9202/v1", models: ["local-y"], contextTokens: 65536, paid: false, credentialName: "primary-key" },
    ], expectedRevision: (await first.controller.services.routing.get())?.revision ?? 0 }, "prov-1");
    assert.ok(providers.ok, JSON.stringify(providers));
    await first.close();

    // The next start builds the product host.
    second = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const l = second;
    assert.ok(l.controller.dispatch !== undefined, l.notes.join(" | "));
    const c = l.controller;
    const s = c.services;
    const owner = await s.principals.authenticate(l.ownerToken);
    const api = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(l.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    const ask = async (operation: string, taskId: string, id: string) => {
      const r = await api("workspace.request", { operation, taskId, reason: `h12t ${operation}` }, id);
      assert.equal(r.ok, true, JSON.stringify(r));
      return r.result as { state: string; reason?: string; summary?: string; detail?: Record<string, unknown> };
    };

    // Two projects, each with its own local repository; an agent that may work in both.
    const A = (await s.projects.createProject({ commandId: "pA", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: garden }] } as never)).id;
    const B = (await s.projects.createProject({ commandId: "pB", actor: owner.id, name: "Orchard", repositories: [{ id: "orchard", location: orchard }] } as never)).id;
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: (await s.principals.get(principalId))!.revision, grants: [...workGrants(A), ...workGrants(B), ...[A, B].flatMap((project) => [{ action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }])] });
    let n = 0;
    const runTask = async (project: string, title: string) => {
      n++;
      const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title })).id;
      await s.contracts.setContract(owner, { commandId: `ct${n}`, taskId, expectedVersion: 0, requiredEvidence: ["the new module"], checks: [{ name: "has the module", run: ["/bin/sh", "-c", `pwd; test -f src/${n === 1 ? "b" : "c"}.ts || { echo missing >&2; exit 3; }`], timeoutSeconds: 60 }] } as never);
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: (await s.projects.getTask(taskId))!.revision, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      return { taskId, attemptId };
    };
    const attemptOf = async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))!;

    // ---- task A: the attempt runs in the checkout the port made; a refresh asked while its model call is in flight is refused by the host's busy check ----
    const ta = await runTask(A, "Dig the garden");
    tasks = { ...tasks, A: { project: A, task: ta.taskId } };
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [ta.attemptId]);
    await Promise.race([callOpen, sleep(120_000).then(() => assert.fail("the agent never reached its model"))]);
    const checkoutA = checkoutOf(A, ta.taskId);
    assert.ok(existsSync(join(hostBaseOf(dir), "work", A, ta.taskId, "complete")), "the port made the task's checkout (its layout, beside the data directory)");
    assert.equal(readFileSync(join(checkoutA, "src", "a.ts"), "utf8"), "export const a = 1;\n", "from the project's shared repository");
    assert.ok(!existsSync(join(checkoutA, ".git")), "the agent's git directory is outside its checkout");
    const busy = await ask("refresh", ta.taskId, "busy-refresh");
    assert.notEqual(busy.state, "done", `a refresh while a model call is in flight is not carried out: ${JSON.stringify(busy)}`);
    assert.match(JSON.stringify(busy), /quiet|in flight|busy/i, JSON.stringify(busy));
    letGo();
    await until(async () => (await attemptOf(ta.attemptId)).state === "finished", 180_000, () => `attempt A never finished: ${calls.map((x) => x.task).join(",")}`);
    await c.dispatch!.dispatcher.idle();
    const doneA = await attemptOf(ta.attemptId);
    assert.equal(doneA.outcome?.status, "succeeded", JSON.stringify(doneA.outcome));
    // The done was checked by the host on the port's checkout: the contract's check ran in the sandbox (the checkout is mounted at /work) and passed.
    assert.deepEqual(doneA.verifications?.map((v) => [v.state, v.checks.map((x) => [x.name, x.state])]), [["passed", [["has the module", "passed"]]]]);
    assert.ok(calls.every((x) => x.url.startsWith("http://127.0.0.1:9201/v1/")), calls.map((x) => x.url).join(", "));

    const gitA = join(hostBaseOf(dir), "work", A, ta.taskId, "task.git");
    // The work is committed in the task's own git directory by the product host's release operation (card H12o): the platform's commit, naming the attempt, with the controller's quiesce around it.
    const releasedA = await ask("release", ta.taskId, "release-a");
    assert.equal(releasedA.state, "done", JSON.stringify(releasedA));
    assert.equal(releasedA.detail?.["committed"], true, JSON.stringify(releasedA));
    assert.equal(releasedA.detail?.["attemptId"], ta.attemptId);
    const headA = sh(checkoutA, "--git-dir", gitA, "log", "-1", "--format=%an|%ae|%B", "HEAD");
    assert.match(headA, /^NimbleNewt release\|release@nimblenewt\.invalid\|Work of task /);
    assert.match(headA, new RegExp(`^NimbleNewt-Attempt: ${ta.attemptId}$`, "m"));
    assert.equal(sh(checkoutA, "--git-dir", gitA, "--work-tree", checkoutA, "status", "--porcelain"), "", "the checkout holds nothing uncommitted");

    // ---- the owner's landing policy: nothing named, nothing landed (no hard-coded branch) ----
    const unnamed = await ask("landing", ta.taskId, "land-a-0");
    assert.notEqual(unnamed.state, "done", JSON.stringify(unnamed));
    assert.match(JSON.stringify(unnamed), /no landing branch set/, JSON.stringify(unnamed));
    assert.ok(!existsSync(join(garden, "src", "b.ts")));

    // The owner names the installation's landing branch. The commit permit is left at its default (required): the release commit above is the platform's and carries no review-gate permit, so the product host refuses the landing.
    const branchOnly = await s.configuration.stage(owner, { commandId: "st-0", layer: "installation", set: { "workspace.landing.branch": "main" } } as never);
    const applied0 = await s.configuration.apply(owner, { commandId: "ap-0", layer: "installation", expectedRevision: branchOnly.revision } as never);
    assert.equal(applied0.applied, true);
    const unpermitted = await ask("landing", ta.taskId, "land-a-permit");
    assert.notEqual(unpermitted.state, "done", JSON.stringify(unpermitted));
    assert.match(JSON.stringify(unpermitted), /do not carry the commit permit/, JSON.stringify(unpermitted));
    assert.ok(!existsSync(join(garden, "src", "b.ts")), "nothing landed without the permit");

    // For the release commit (no review-gate permit exists in this composition yet), the owner lets a landing go without the commit permit.
    const staged = await s.configuration.stage(owner, { commandId: "st-1", layer: "installation", expectedRevision: applied0.revision, set: { "workspace.landing.requirePermit": false } } as never);
    assert.equal((await s.configuration.apply(owner, { commandId: "ap-1", layer: "installation", expectedRevision: staged.revision } as never)).applied, true);

    // A refresh with nothing new on the shared branch is answered by the port.
    const refreshed = await ask("refresh", ta.taskId, "refresh-a");
    assert.equal(refreshed.state, "done", JSON.stringify(refreshed));
    const landedA = await ask("landing", ta.taskId, "land-a-1");
    assert.equal(landedA.state, "done", JSON.stringify(landedA));
    assert.equal(landedA.detail?.["landed"], true, JSON.stringify(landedA));
    assert.equal(readFileSync(join(garden, "src", "b.ts"), "utf8"), "export const b = 2;\n", "landed on main in the garden's shared tree");

    // ---- task B, in a project whose repository is on `trunk` ----
    const tb = await runTask(B, "Plant the orchard");
    tasks = { ...tasks, B: { project: B, task: tb.taskId } };
    assert.deepEqual((await c.dispatch!.dispatcher.tick()).started, [tb.attemptId]);
    await until(async () => (await attemptOf(tb.attemptId)).state === "finished", 180_000, "attempt B never finished");
    await c.dispatch!.dispatcher.idle();
    assert.equal((await attemptOf(tb.attemptId)).outcome?.status, "succeeded");
    const checkoutB = checkoutOf(B, tb.taskId);
    const gitB = join(hostBaseOf(dir), "work", B, tb.taskId, "task.git");
    void gitB;
    const releasedB = await ask("release", tb.taskId, "release-b");
    assert.equal(releasedB.state, "done", JSON.stringify(releasedB));
    assert.equal(releasedB.detail?.["attemptId"], tb.attemptId);
    // On the installation's branch alone, project B is refused: its shared tree is on trunk.
    const wrong = await ask("landing", tb.taskId, "land-b-0");
    assert.notEqual(wrong.state, "done", JSON.stringify(wrong));
    assert.match(JSON.stringify(wrong), /not on the landing branch \\"main\\"/, JSON.stringify(wrong));
    // The owner names B's own landing branch: B lands on trunk, while A's branch stays main.
    assert.equal((await api("project.branches.set", { project: B, landing: "trunk" }, "br-b")).ok, true);
    const landedB = await ask("landing", tb.taskId, "land-b-1");
    assert.equal(landedB.state, "done", JSON.stringify(landedB));
    assert.equal(landedB.detail?.["landed"], true, JSON.stringify(landedB));
    assert.equal(readFileSync(join(orchard, "src", "c.ts"), "utf8"), "export const c = 2;\n", "landed on trunk in the orchard's shared tree");
    assert.equal(sh(orchard, "branch", "--show-current"), "trunk");
    assert.ok(!existsSync(join(orchard, "src", "b.ts")) && !existsSync(join(garden, "src", "c.ts")), "each project's work landed in its own tree");

    // ---- quarantine of A's checkout: the same port moves it to the owner-only quarantine ----
    const quarantined = await ask("quarantine", ta.taskId, "quarantine-a");
    assert.equal(quarantined.state, "done", JSON.stringify(quarantined));
    assert.ok(!existsSync(join(checkoutA, "src", "b.ts")), "the checkout is no longer where the agent worked");
    await l.close();
    second = undefined;
  } finally {
    letGo();
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
