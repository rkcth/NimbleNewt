import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, personalNamespace, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// Card T02d, the last open proof: "the shipped controller runs catalogue tools through the sandbox launcher". The product's local host is built by the real `localHostBuilder` (scripts/local-host.mjs) inside the real `launch`;
// an agent's `tool.invoke` of a catalogue tool arrives through the scripted model and the real worker process and tool bridge; the script itself reports what it can reach. A script that really ran in the sandbox cannot read the
// controller's data directory or a file beside it, nor write beside it; a fake runner, a runner without confinement, a wrong `facts`, a wrong `isLocalHost` or no `tools` at all each make this test fail (see the notes: five mutations).
// Skipped where no sandbox is usable (the product's local host is bubblewrap, so Linux only; the other platforms build no host and say so). With NIMBLENEWT_REQUIRE_SANDBOX=1 on Linux an unusable sandbox fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const memorySecrets = (seed: Record<string, string>): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };

// The tool: reads the probe files it is given and tries to write beside the first; reports everything it could reach. Confined, it reaches nothing outside its own private directory.
const executable = [
  "const fs = require('node:fs'); let raw = '';",
  "process.stdin.on('data', (d) => { raw += d; }).on('end', () => {",
  "  const { probes } = JSON.parse(raw); const reached = [];",
  "  for (const p of probes) { try { fs.readFileSync(p); reached.push('read ' + p); } catch { /* refused or absent */ } }",
  "  try { fs.writeFileSync(probes[0] + '.written', 'x'); reached.push('write'); } catch { /* refused */ }",
  "  console.log(JSON.stringify({ confined: reached.length === 0, reached }));",
  "});",
].join("\n");
const manifest = {
  purpose: "report what a script of this host can reach", input: { type: "object", properties: { probes: { type: "array", items: { type: "string", maxLength: 500 }, maxItems: 5 } }, required: ["probes"], additionalProperties: false },
  output: { type: "object", properties: { confined: { type: "boolean" }, reached: { type: "array", items: { type: "string" } } }, required: ["confined", "reached"] },
  entryPoint: "bin/probe.js", interpreter: { name: "node", version: process.versions.node }, os: ["linux", "darwin", "win32"], arch: ["x64", "arm64"], dependencies: [], requestedAccess: [], limits: { cpus: 1, memoryMb: 256, seconds: 60 }, cancellation: "cooperative", recovery: "none",
};

test("an agent's catalogue tool, called in the product's own local host, runs through the sandbox launcher: the script cannot reach the data directory or a file beside it (card T02d)", async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot) && process.platform === "linux";
  const why = process.platform !== "linux" ? `the product's local host runs agents in bubblewrap, which is Linux only (${process.platform} has no launcher of its own yet, so no local host is built)` : probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip(`no usable sandbox: ${why ?? "bubblewrap or a node install it can mount is unusable"}`);
  }
  const { localHostBuilder } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn t02d wiring ")));
  const dir = join(parent, "data");
  // Beside the data directory (not inside any mount the host gives a script) and inside it: two things a script run outside the sandbox could read.
  const beside = join(parent, "beside.txt");
  writeFileSync(beside, "not for scripts");
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
    primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
    backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
  } } };
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value", "backup-key": "sk-backup-secret-value" });
  const start = { facts, filesystem: ext4, dispatch: { manual: true } } as const;
  const real = localHostBuilder({ root: repository }) as unknown as (context: unknown) => Promise<{ start?: { tools?: { isLocalHost: (hostId: string) => boolean } } }>;
  // The shipped builder is the one used; what it hands the controller is also looked at, because a host that answers "local" for every host would send a remote worker's tool call to this machine's sandbox.
  let handed: { isLocalHost: (hostId: string) => boolean } | undefined;
  const builder = (async (context: unknown) => { const built = await real(context); handed = built.start?.tools; return built; }) as never;
  const calls: string[] = [];
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
  const tool = { name: "", callId: "call_probe" };
  let decide: (() => Promise<void>) | undefined;
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  const fetchAll: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean };
    assert.equal(body.stream, true, "only the agent's model calls are made here");
    calls.push(JSON.stringify(body));
    const step = calls.length;
    const call = (name: string, args: unknown): string => sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id: name === "nimblenewt__work-end" ? "call_end" : tool.callId, type: "function", function: { name, arguments: JSON.stringify(args) } }] }, null) + sse({}, "tool_calls", usage);
    const invoke = { tool: tool.name, version: "1.0.0", input: { probes: [join(dir, "controller.sqlite"), beside] } };
    let chunks: string;
    if (step === 1) chunks = call("nimblenewt__tool-invoke", invoke);
    else if (step === 2) { await decide?.(); chunks = call("nimblenewt__tool-invoke", invoke); }
    else if (step === 3) chunks = call("nimblenewt__work-end", { report: "Ran the probe.", result: "done", note: "nothing to change" });
    else chunks = sse({ role: "assistant", content: "" }, null) + sse({ content: "all done" }, null) + sse({}, "stop", usage);
    return new Response(`${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  try {
    // The host is turned on and the model's address recorded, then the controller is started again (the setting counts from the next start).
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const firstOwner = await first.controller.services.principals.authenticate(first.ownerToken);
    await first.controller.services.localHost.set(firstOwner, { commandId: "host-on", enabled: true });
    const added = await first.controller.api.handle(first.ownerToken, { v: 1, op: "routing.provider.add", commandId: "prov-1", args: { providers: [{ name: "primary", location: "local", endpoint: "http://127.0.0.1:9201/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "primary-key" }, { name: "backup", location: "cloud", endpoint: "https://free.example.invalid/v1", models: ["free-y"], contextTokens: 32000, paid: false, credentialName: "backup-key" }], expectedRevision: ((await first.controller.services.routing.get())?.revision ?? 0) } } as never) as { ok: boolean };
    assert.ok(added.ok, JSON.stringify(added));
    await first.close();

    second = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const l = second;
    assert.ok(l.controller.dispatch !== undefined, l.notes.join(" | "));
    assert.match(l.notes.join("\n"), /worker host on this computer \(host:local\) is running agents in a sandbox/);
    const s = l.controller.services;
    const c = l.controller;
    const owner = await s.principals.authenticate(l.ownerToken);

    assert.ok(handed !== undefined, "the builder hands the controller its tools");
    assert.equal(handed.isLocalHost("host:local"), true);
    assert.equal(handed.isLocalHost("host:elsewhere"), false, "only this computer's host runs a tool here");

    // A project with a shared repository, an agent with the rights to register and run its own tool, and the tool itself, registered from the agent's own accepted desk records.
    const shared = join(parent, "garden");
    mkdirSync(shared, { recursive: true });
    const git = (...args: string[]): void => { execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: shared, stdio: "ignore" }); };
    git("init", "-q", "-b", "main"); writeFileSync(join(shared, "a.txt"), "a\n"); git("add", "-A"); git("commit", "-q", "-m", "first");
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: shared }] } as never)).id;
    // Card P02: the workspace opens only on a repository the project has bound with write access to all of it.
    await s.resources.bindResource(owner, { commandId: "bind-garden", projectId: project, kind: "repository", label: "garden", locator: shared, repositoryId: "garden", access: "write" });
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    const ns = personalNamespace(principalId).replace(/^a_/, "a-");
    const rev = (await s.principals.get(principalId))!.revision;
    await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: rev, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }, { action: "catalog.register", project: "*" }, { action: "catalog.read", project: "*" }, { action: `tool.${ns}.*`, project }] });
    const stored = (await s.principals.get(principalId))!;
    const principal = (await s.grants.effective({ id: stored.id, kind: stored.kind, name: stored.name, grants: stored.grants } as never, new Date().toISOString())) as never;
    const note = await s.desks.write(principal, { commandId: "d1", projectId: project, kind: "note", title: "probe notes", body: "reports what a script can reach", visibility: "shared", status: "accepted" } as never);
    const code = await s.desks.write(principal, { commandId: "d2", projectId: project, kind: "note", title: "probe code", body: executable, visibility: "shared", status: "accepted" } as never);
    const made = await s.catalog.register(principal, { commandId: "reg", name: "probe", kind: "tool", version: "1.0.0", manifest, instructionsRecordId: note.id, executableRecordId: code.id } as never);
    tool.name = made.name;
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Run the probe" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    // A tool an agent wrote itself waits for the owner's approval on its first call: the owner allows it when the agent's model is next asked (the same call id then runs it).
    decide = async () => {
      const ids = await s.reviews.reviewIdsForTask(taskId);
      assert.equal(ids.length, 1, "one approval is waiting for the owner");
      const review = (await s.reviews.get(owner, ids[0]!))!;
      await s.reviews.decide(owner, { commandId: "dec", requestId: review.id, expectedRevision: review.revision, verdict: "allow", reason: "the probe only looks" });
    };
    const ticked = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(ticked.started, [attemptId], JSON.stringify(ticked));
    await until(() => calls.length >= 4, 90_000, () => `the agent made ${calls.length} model calls`);
    await c.dispatch!.dispatcher.idle();
    // The call the owner approved was parked as an operation of the attempt; a tick lets the dispatcher settle it once the attempt has ended.
    const stateOf = async (): Promise<string> => String((await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!.state);
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await stateOf()) === "finished"; }, 10_000, "the attempt never finished");

    // The script really ran (its own report came back to the agent) and it reached nothing: the run went through the sandbox launcher.
    const answer = calls[2]!;
    assert.match(answer, /confined\\*":\s*true/, "the script's report is the answer the agent got");
    assert.match(answer, /reached\\*":\s*\[\]/, "and it reached nothing outside its private directory");
    assert.ok(!existsSync(`${beside}.written`) && !existsSync(join(dir, "controller.sqlite.written")), "nothing was written beside the probes");
    // Its private run directory is gone and nothing of it is left behind.
    const runs = join(parent, "data.script-runs");
    assert.deepEqual(existsSync(runs) ? readdirSync(runs) : [], []);
    await l.close();
    second = undefined;
  } finally {
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});
