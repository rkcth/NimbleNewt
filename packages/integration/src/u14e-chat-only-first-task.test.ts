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

// Card U14e (the audit's unmet clause): a first working agent and first task with the launcher and the chat only, no code. This file starts the real launcher on an EMPTY state folder with the local worker host,
// and drives nothing but free-form chat messages (read by the interpreter fixture) through the setup answers, a project, an agent, its rights, a task, the move to ready and the assignment; the attempt
// is admitted and started by the controller itself (no manual dispatch, no service calls for the work), runs on the launcher's local host in a sandbox and finishes.
// Card U14b (earlier): on a clean machine the owner turns the worker host on by chat, and after the next start a task assigned to an agent starts and finishes on this computer. The launcher builds the host
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

test("on an empty state folder, only launcher starts and chat messages take the owner from nothing to a finished first task on the local host (card U14e)", { skip: hasGit ? false : "git is not installed" }, async (t) => {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason;
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox is unusable: ${why}`);
    return t.skip("bubblewrap or a node install it can mount is unusable");
  }
  const { localHostBuilder } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn u14e walk ")));
  const dir = join(parent, "data");
  const shared = join(parent, "garden");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  // The state folder does not exist before the first start: a clean machine.
  assert.equal(existsFolder(dir), false);
  const secrets = memorySecrets({ "primary-key": "sk-primary-secret-value", "backup-key": "sk-backup-secret-value" });
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
    primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
    backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
  } } };

  // One scripted fake model route: the chat interpreter's questions (not streamed) are answered from the script; the agent's streamed calls are recorded and answered with the steps.
  const script: Record<string, unknown[]> = {};
  const interpreted: string[] = [];
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
    interpreted.push(text);
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(script[text] ?? [{ kind: "none", reason: "nothing asked" }]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  const builder = localHostBuilder({ root: repository });
  const open: Awaited<ReturnType<typeof launch>>[] = [];
  const startOnce = async (): Promise<Awaited<ReturnType<typeof launch>>> => { const l = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start: { facts, filesystem: ext4 }, fetch: fetchAll, localHost: builder }); open.push(l); return l; };
  /** The owner types one free-form message; the stand-in model reads it as `intents`; every proposal shown is confirmed by a second free-form message. Nothing but chat is used. */
  const owner = (l: Awaited<ReturnType<typeof launch>>) => {
    const say = (text: string, intents: unknown[]) => { script[text] = intents; return l.controller.chat!.submit(l.ownerToken, { messageId: `m-${Math.random().toString(36).slice(2)}`, text }); };
    const settle = async (text: string, intents: unknown[]): Promise<string[]> => {
      const turn = await say(text, intents);
      const statuses: string[] = [];
      for (const o of turn.outcomes as unknown as { status: string; proposalId?: string }[]) {
        if (o.status === "proposed") {
          const yes = `yes, go ahead with ${o.proposalId}`;
          const done = await say(yes, [{ kind: "apply_proposal", proposalId: o.proposalId, evidence: yes, basis: "owner" }]);
          statuses.push(...(done.outcomes as unknown as { status: string }[]).map((x) => x.status));
        } else statuses.push(o.status);
      }
      assert.ok(statuses.length > 0 && statuses.every((s) => s === "applied"), `${text}: ${JSON.stringify(turn.outcomes)} -> ${statuses.join(",")}`);
      return statuses;
    };
    const call = (op: string, args: Record<string, unknown> = {}) => l.controller.api.handle(l.ownerToken, { v: 1, op, args } as never) as Promise<any>;
    return { say, settle, call };
  };
  try {
    // First start, empty folder: the owner is made and the guide names the next open step.
    const first = await startOnce();
    assert.equal(first.ownerCreated, true);
    const a = owner(first);
    assert.equal((await a.call("setup.readiness")).result.item.next, "project");

    // Chat: the model servers, the project, this computer as the host.
    const servers = "Use two model servers: primary, local, at http://127.0.0.1:9201/v1 with model local-x and the secret primary-key, and backup, cloud, at https://free.example.invalid/v1 with model free-y and the secret backup-key";
    await a.settle(servers, [intent("command", { op: "routing.provider.add", args: { providers: [
      { name: "primary", location: "local", endpoint: "http://127.0.0.1:9201/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "primary-key" },
      { name: "backup", location: "cloud", endpoint: "https://free.example.invalid/v1", models: ["free-y"], contextTokens: 32000, paid: false, credentialName: "backup-key" },
    ] } }, servers)]);
    await a.settle(`Create the project Garden, its repository is ${shared}, no code host`, [intent("command", { op: "project.create", args: { name: "Garden", goal: "Garden", repositories: [{ id: "garden", location: shared }], versionControl: { host: "none" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "Create the project Garden")]);
    const project = (await a.call("project.list")).result.items[0].id as string;
    const bind = `Bind ${shared} as the repository garden of Garden, agents may write to it`;
    await a.settle(bind, [intent("command", { op: "resource.bind", args: { kind: "repository", label: "garden", locator: shared, repositoryId: "garden", access: "write" } }, bind)]);
    await a.settle("Run the agents on this computer, please", [intent("command", { op: "host.local.set", args: { enabled: true } }, "Run the agents on this computer")]);

    // Chat: the first agent and its rights (a plain role by name, then each right the work needs, in words).
    await a.settle("Add an agent called Ann as an author", [intent("command", { op: "agent.create", args: { friendlyName: "Ann", roles: ["author"] } }, "Add an agent called Ann")]);
    const ann = (await a.call("agent.list")).result.items[0];
    const grantee = (ann.principal ?? `agent:${ann.id}`) as string;
    for (const action of ["attempt.work", "effect.perform", "review.request", "task.read", "desk.write", "desk.read", "message.receive"]) {
      const words = `Give ${grantee} the right ${action} in the project Garden because Ann works in Garden`;
      await a.settle(words, [intent("command", { op: "grant.create", args: { grantee, action, projectName: "Garden", basis: "Ann works in Garden" } }, words)]);
    }
    // Chat: the first task.
    await a.settle("Add a task Say hello to Garden", [intent("command", { op: "task.create", args: { title: "Say hello", projectName: "Garden" } }, "Add a task Say hello")]);
    const task = (await a.call("task.list", { projectId: project })).result.items[0];
    assert.equal(task.title, "Say hello");
    await first.close();
    open.length = 0;

    // The owner starts the launcher again (the host counts from the next start). The host is up and the guide has nothing required left open.
    const second = await startOnce();
    assert.ok(second.controller.dispatch !== undefined, second.notes.join(" | "));
    assert.match(second.notes.join("\n"), /worker host on this computer \(host:local\) is running agents in a sandbox/);
    const b = owner(second);
    const ready = (await b.call("setup.readiness")).result.item;
    assert.equal(ready.items.find((i: { id: string }) => i.id === "host").state, "done");

    // Chat: make the task ready, then give it to Ann. Nothing else: the controller admits the attempt and the local host runs it.
    const toReady = "Say hello is ready for work";
    await b.settle(toReady, [intent("command", { op: "task.transition", args: { taskTitle: "Say hello", to: "ready" } }, toReady)]);
    const give = "Give Say hello to Ann";
    await b.settle(give, [intent("command", { op: "task.assign", args: { taskTitle: "Say hello", agentName: "Ann" } }, give)]);

    const services = second.controller.services;
    const c = second.controller;
    let attemptId: string | undefined;
    try { await until(async () => { attemptId = (await services.assignments.getAssignment(task.id))?.activeAttemptId ?? attemptId; return attemptId !== undefined; }, 60_000, "no attempt was admitted"); } catch (error) {
      const tick = await c.dispatch!.dispatcher.tick().catch((e: unknown) => String(e)); assert.fail(`${(error as Error).message}; tick ${JSON.stringify((tick as { loops?: { name: string; ok: boolean }[] }).loops?.filter((x) => x.name.startsWith("recovery")))} ${JSON.stringify((tick as { failures?: unknown }).failures)}; assignment ${JSON.stringify(await services.assignments.getAssignment(task.id))}; tasks ${JSON.stringify((await b.call("task.list", { projectId: project })).result.items)}`);
    }
    try { await until(() => agentCalls.length >= 1, 60_000, "the agent never reached its model"); } catch (error) { const tick = await c.dispatch!.dispatcher.tick().catch((e: unknown) => String(e)); assert.fail(`${(error as Error).message}; tick ${JSON.stringify(tick).replace(/"loops":\[.*?\],/, "")}`); }
    await until(async () => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId!))?.state === "finished", 60_000, "the attempt did not finish");
    assert.ok(agentCalls.every((x) => x.url.startsWith("http://127.0.0.1:9201/v1/")), agentCalls.map((x) => x.url).join(", "));
    assert.ok(agentCalls.every((x) => x.auth === "Bearer sk-primary-secret-value"), "the key came from the secret store by name");
    assert.ok(agentCalls.every((x) => !x.text.includes("sk-primary-secret-value")), "the agent never sees the key");
    await second.close();
    open.length = 0;
    for (const f of filesUnder(parent)) for (const key of ["sk-primary-secret-value", "sk-backup-secret-value"]) assert.ok(!readFileSync(f).includes(Buffer.from(key)), `${f} must not hold a provider key`);
  } finally {
    for (const l of open) await l.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
});

function existsFolder(path: string): boolean { try { return readdirSync(path).length >= 0; } catch { return false; } }
