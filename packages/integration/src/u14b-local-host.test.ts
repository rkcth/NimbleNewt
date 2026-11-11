import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, runTerminalChat, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// Card U14b: on a clean machine the owner turns the worker host on by chat, and after the next start a task assigned to an agent starts and finishes on this computer. The launcher builds the host
// (scripts/local-host.mjs) from the owner's records: the model addresses come from the provider records the owner edited, the key from the secret store by its NAME. The model is a scripted
// OpenAI-compatible server behind an injected fetch; nothing leaves the machine. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string | (() => string)): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(typeof why === "function" ? why() : why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
const memorySecrets = (seed: Record<string, string>): LauncherSecrets & { values: Map<string, string> } => { const values = new Map(Object.entries(seed)); return { values, resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
async function* lines(items: string[]): AsyncGenerator<string> { for (const i of items) yield i; }

test("on a clean machine the owner turns the worker host on by chat; after the next start the launcher has built it from the owner's records and a task assigned to an agent starts and finishes, with the model address from the edited provider record and its key from the secret store (card U14b)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder, hostBaseOf } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never; hostBaseOf: (d: string) => string };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn u14b host ")));
  const dir = join(parent, "data");
  const shared = join(parent, "garden");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value", "backup-key": "sk-backup-secret-value" });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
    primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
    backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
  } } };

  // One fetch for everything: the chat's questions (not streamed) are answered from the script; the agent's streamed calls through the relay are recorded and answered with the steps.
  const script: Record<string, unknown[]> = {};
  const agentCalls: { url: string; auth: string | null; text: string }[] = [];
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
  const fetchAll: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; messages: { role: string; content: string }[] };
    if (body.stream === true) {
      agentCalls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), text: JSON.stringify(body.messages) });
      const first = agentCalls.length === 1;
      const chunks = first
        ? sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify({ report: "Done as the task asked.", result: "done", note: "nothing to change" }) } }] }, null) + sse({}, "tool_calls", usage)
        : sse({ role: "assistant", content: "" }, null) + sse({ content: "all done" }, null) + sse({}, "stop", usage);
      return new Response(`${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
    }
    const user = body.messages.find((m) => m.role === "user")!.content;
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "";
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(script[text] ?? [{ kind: "none", reason: "nothing asked" }]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  const start = { facts, filesystem: ext4, dispatch: { manual: true } } as const;
  const builder = localHostBuilder({ root: repository });
  let second: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    // First start: no host. Tasks would wait. The owner edits the model server's address (the agent's model is on port 9201 now) and turns the host on, all in words.
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const call = (op: string, args: Record<string, unknown>, id?: string) => first.controller.api.handle(first.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    assert.equal(((await call("setup.readiness", {})).result.item.items as { id: string; state: string }[]).find((i) => i.id === "host")!.state, "missing", "off by default: no worker host, tasks would wait");
    assert.doesNotMatch(first.notes.join("\n"), /worker host/);
    const chatSays = async (text: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: first.controller, ownerToken: first.ownerToken, input: lines([text]), write: (x) => out.push(x) }); return out.join(""); };
    const asked = "Run the agents on this computer, please";
    script[asked] = [intent("command", { op: "host.local.set", args: { enabled: true } }, "Run the agents on this computer")];
    const turn = await first.controller.chat!.submit(first.ownerToken, { messageId: "host-1", text: asked });
    const proposal = turn.outcomes[0] as unknown as { status: string; proposalId: string };
    assert.equal(proposal.status, "proposed", "shown first");
    assert.equal(await first.controller.services.localHost.enabled(), false, "nothing is turned on by being asked");
    script["yes, do it"] = [{ kind: "apply_proposal", proposalId: proposal.proposalId, evidence: "yes, do it", basis: "owner" }];
    await chatSays("yes, do it");
    assert.equal(await first.controller.services.localHost.enabled(), true);
    const providers = await call("routing.provider.add", { providers: [
      { name: "primary", location: "local", endpoint: "http://127.0.0.1:9201/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "primary-key" },
      { name: "backup", location: "cloud", endpoint: "https://free.example.invalid/v1", models: ["free-y"], contextTokens: 32000, paid: false, credentialName: "backup-key" },
    ], expectedRevision: (await first.controller.services.routing.get())!.revision }, "prov-1");
    assert.ok(providers.ok, JSON.stringify(providers));
    await first.close();

    // The next start builds the host.
    second = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const l = second;
    assert.ok(l.controller.dispatch !== undefined, l.notes.join(" | "));
    assert.match(l.notes.join("\n"), /worker host on this computer \(host:local\) is running agents in a sandbox/);
    const s = l.controller.services;
    const owner = await s.principals.authenticate(l.ownerToken);
    const c = l.controller;
    const readiness = (await c.api.handle(l.ownerToken, { v: 1, op: "setup.readiness", args: {} } as never) as any).result.item;
    assert.equal(readiness.items.find((i: { id: string }) => i.id === "host").state, "done", "the host is enrolled and announced");
    assert.match(l.notes.join("\n"), /No difficulty profiles were set, so every task now uses the default routing profile/);
    assert.ok(existsFolder(hostBaseOf(dir)), "the host's folders are beside the data directory, not in it");

    // The work: a project in the local repository, an agent with the rights to work in it, a task assigned (the strict approval profile and no difficulty profile of the owner's: the launcher made the one it needs).
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: shared }] } as never)).id;
    const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
    const principalId = `agent:${agent}`;
    const rev = (await s.principals.get(principalId))!.revision;
    await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: rev, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }] });
    const taskId = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Say hello" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
    const a = (await s.assignments.getAssignment(taskId))!;
    const attemptId = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    const ticked = await c.dispatch!.dispatcher.tick();
    assert.deepEqual(ticked.started, [attemptId], JSON.stringify(ticked));
    await until(() => agentCalls.length >= 1, 60_000, "the agent never reached its model");
    await c.dispatch!.dispatcher.idle();
    assert.equal((await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!.state, "finished");

    // The model address is the one in the owner's edited record (port 9201, not the configuration's 8002), reached with the key from the secret store by its name; the key is in no file.
    assert.ok(agentCalls.every((x) => x.url.startsWith("http://127.0.0.1:9201/v1/")), agentCalls.map((x) => x.url).join(", "));
    assert.ok(agentCalls.every((x) => x.auth === "Bearer sk-primary-secret-value"), "the key came from the secret store by name");
    assert.ok(agentCalls.every((x) => !x.text.includes("sk-primary-secret-value")), "the agent never sees the key");
    await l.close();
    second = undefined;
    for (const f of filesUnder(parent)) for (const key of ["sk-primary-secret-value", "sk-backup-secret-value"]) assert.ok(!readFileSync(f).includes(Buffer.from(key)), `${f} must not hold a provider key`);
  } finally {
    await second?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function existsFolder(path: string): boolean { try { return readdirSync(path).length >= 0; } catch { return false; } }
