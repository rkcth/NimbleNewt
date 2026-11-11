import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launch, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";
import { workGrants } from "@nimblenewt/controller/testing";
import { SandboxLauncher } from "@nimblenewt/worker";
import { sse } from "./h12-worker-support.js";

// Card G09 (continuity across a provider change) through the composed controller: the launcher and the worker host it builds from the owner's records (scripts/local-host.mjs: bubblewrap, the worker process
// running Pi Durable, the controller's model relay, each route's address read from the provider records and its key from the secret store by NAME, both at each call). The model servers are scripted
// OpenAI-compatible answers behind an injected fetch, told apart by address; nothing leaves the machine. Skipped without bubblewrap unless NIMBLENEWT_REQUIRE_SANDBOX=1 (set in CI), where it fails instead.
const required = process.env["NIMBLENEWT_REQUIRE_SANDBOX"] === "1";
const nodeRoot = dirname(dirname(realpathSync(process.execPath)));
const repository = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const until = async (ok: () => boolean | Promise<boolean>, ms: number, why: string): Promise<void> => { const end = Date.now() + ms; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await sleep(50); } };
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
const memorySecrets = (seed: Record<string, string>): LauncherSecrets => { const values = new Map(Object.entries(seed)); return { resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };

/** The model servers by address, each with the key it is given (in the secret store under `secret`). */
const SERVERS = {
  primary: { url: "http://127.0.0.1:9201/v1", secret: "primary-key", key: "sk-primary-secret-value" },
  backup: { url: "https://free.example.invalid/v1", secret: "backup-key", key: "sk-backup-secret-value" },
  fresh: { url: "http://127.0.0.1:9401/v1", secret: "fresh-key", key: "sk-fresh-secret-value" },
  moved: { url: "http://127.0.0.1:9501/v1", secret: "moved-key", key: "sk-moved-secret-value" },
} as const;
const KEYS = Object.values(SERVERS).map((s) => s.key);
type Server = keyof typeof SERVERS;
interface Call { readonly url: string; readonly auth: string | null; readonly model: string; readonly text: string }
const serverOf = (c: Call): Server | undefined => (Object.keys(SERVERS) as Server[]).find((k) => c.url.startsWith(`${SERVERS[k].url}/`));

/** A started installation (two launches: the first turns the worker host on, the second runs it) with one agent that may work in one project. */
async function installation(t: { skip(why: string): void }) {
  const probe = await SandboxLauncher.create({ protectedPaths: [], audit: () => undefined });
  const usable = hasGit && probe.capacity.available && probe.capacity.backend === "bubblewrap" && !["/usr", "/bin", "/lib"].includes(nodeRoot);
  const why = probe.capacity.reason ?? "git is missing";
  await probe.stop();
  if (!usable) {
    if (required && process.platform === "linux") assert.fail(`NIMBLENEWT_REQUIRE_SANDBOX=1 but the sandbox or git is unusable: ${why}`);
    t.skip("bubblewrap, git or a node install it can mount is unusable");
    return undefined;
  }
  const { localHostBuilder } = await import(pathToFileURL(join(repository, "scripts", "local-host.mjs")).href) as { localHostBuilder: (s: { root: string }) => never };
  const parent = realpathSync(mkdtempSync(join(tmpdir(), "nn g09c ")));
  const dir = join(parent, "data");
  const shared = join(parent, "garden");
  mkdirSync(join(shared, "src"), { recursive: true });
  sh(parent, "init", "-q", "-b", "main", shared);
  writeFileSync(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const secrets = memorySecrets(Object.fromEntries(Object.values(SERVERS).map((s) => [s.secret, s.key])));
  const config: LauncherConfig = { installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
    primary: { adapter: "openai-compatible", endpoint: SERVERS.primary.url, credential: { secret: SERVERS.primary.secret }, enabled: true, paid: false, models: ["local-x"] },
    backup: { adapter: "openai-compatible", endpoint: SERVERS.backup.url, credential: { secret: SERVERS.backup.secret }, enabled: true, paid: false, models: ["free-y"] },
  } } };

  // Every streamed agent call as the server received it. A held call waits before it is answered (the owner acts while the model is still writing). The first call of a turn ends the work, the call after the
  // tool result answers in words.
  const calls: Call[] = [];
  let hold: Promise<void> | undefined;
  const usage = { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 };
  const fetchAll: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { stream?: boolean; model: string; messages: { role: string; content: unknown }[] };
    if (body.stream !== true) return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify([{ kind: "none", reason: "nothing asked" }]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), model: body.model, text: JSON.stringify(body.messages) });
    const waited = hold; hold = undefined;
    if (waited !== undefined) await waited;
    const chunks = !body.messages.some((m) => m.role === "tool")
      ? sse({ role: "assistant", content: "" }, null) + sse({ tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "nimblenewt__work-end", arguments: JSON.stringify({ report: "Done as the task asked.", result: "done", note: "nothing to change" }) } }] }, null) + sse({}, "tool_calls", usage)
      : sse({ role: "assistant", content: "" }, null) + sse({ content: "all done" }, null) + sse({}, "stop", usage);
    return new Response(`${chunks}data: [DONE]\n\n`, { status: 200, headers: { "content-type": "text/event-stream" } });
  };
  const start = { facts, filesystem: ext4, dispatch: { manual: true } } as const;
  const builder = localHostBuilder({ root: repository });
  const close = async (l?: { close(): Promise<void> }): Promise<void> => {
    await l?.close().catch(() => undefined);
    try { execFileSync("chmod", ["-R", "u+rwX", parent]); } catch { /* nothing to open */ }
    rmSync(parent, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  };
  let l: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    const first = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
    const on = await first.controller.api.handle(first.ownerToken, { v: 1, op: "host.local.set", commandId: "host-on", args: { enabled: true } } as never) as { ok: boolean };
    assert.ok(on.ok, JSON.stringify(on));
    await first.close();
    l = await launch({ config, secrets, argv: [], env: {}, print: () => undefined, start, fetch: fetchAll, localHost: builder });
  } catch (error) { await close(l); throw error; }
  const live = l;
  const c = live.controller;
  assert.ok(c.dispatch !== undefined, live.notes.join(" | "));
  const s = c.services;
  const owner = await s.principals.authenticate(live.ownerToken);
  const call = (op: string, args: Record<string, unknown>, id?: string) => c.api.handle(live.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string; message: string } }>;
  const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden", repositories: [{ id: "garden", location: shared }] } as never)).id;
  const agent = (await s.agents.create(owner, { commandId: "ag1", friendlyName: "Ann", roles: ["author"] } as never)).id;
  const principalId = `agent:${agent}`;
  await s.principals.setGrants(owner, { commandId: "gr1", principalId, expectedRevision: (await s.principals.get(principalId))!.revision, grants: [...workGrants(project), { action: "desk.write", project }, { action: "desk.read", project }, { action: "message.receive", project }] });
  let n = 0;
  const record = async (attemptId: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, attemptId))!;
  return {
    c, s, owner, call, calls, record,
    /** The next agent call is held until the returned function is called. */
    holdNext: (): (() => void) => { let release!: () => void; hold = new Promise<void>((r) => { release = r; }); return release; },
    /** A new task assigned to the agent, its attempt admitted and started; with `reached`, waits until the attempt's first call is at its model server. */
    startTask: async (title: string, reached = false): Promise<{ taskId: string; attemptId: string; from: number }> => {
      n++;
      const from = calls.length;
      const taskId = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(taskId))!;
      const attemptId = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      const ticked = await c.dispatch!.dispatcher.tick();
      assert.deepEqual(ticked.started, [attemptId], JSON.stringify(ticked));
      if (reached) await until(() => calls.length > from, 60_000, `${title} never reached its model`);
      return { taskId, attemptId, from };
    },
    /** Waits until the attempt has finished and returns its record. */
    finished: async (attemptId: string) => { await c.dispatch!.dispatcher.idle(); await until(async () => (await record(attemptId)).state === "finished", 60_000, `${attemptId} did not finish`); return record(attemptId); },
    steps: async (taskId: string): Promise<string[]> => (await s.activity.steps(owner, taskId)).steps.map((x) => ("summary" in x ? String(x.summary) : "")),
    view: async (request: Record<string, unknown>): Promise<string> => { const r = await call("status.ask", { request }); assert.ok(r.ok, JSON.stringify(r)); return (r.result.item.lines as { text: string }[]).map((x) => x.text).join("\n"); },
    /** Closes the installation, then checks that no file it left holds a provider key, and removes it. */
    close: async (): Promise<void> => {
      await live.close();
      try { for (const f of filesUnder(parent)) for (const key of KEYS) assert.ok(!readFileSync(f).includes(Buffer.from(key)), `${f} must not hold a provider key`); } finally { await close(); }
    },
  };
}

/** Every call carried exactly the key of the server it went to, and no key was ever in what the model was sent. */
function keysStayed(calls: readonly Call[]): void {
  for (const x of calls) {
    const server = serverOf(x);
    assert.ok(server !== undefined, `a call went to an unknown address: ${x.url}`);
    assert.equal(x.auth, `Bearer ${SERVERS[server].key}`, `the call to ${x.url} carried another server's key`);
    for (const key of KEYS) assert.ok(!x.text.includes(key), "a provider key reached the model's context");
  }
}

test("a route change while an attempt runs: the running attempt stays on its route and key to the end, the next attempt takes the new route with only the new key, and the task's views say which route each ran on and why (card G09)", async (t) => {
  const x = await installation(t);
  if (x === undefined) return;
  try {
    // A starts on the first route of the default profile; its first call is held while the owner adds a new server and takes the old provider out of new work.
    const release = x.holdNext();
    const a = await x.startTask("Task A", true);
    const revision = (await x.s.routing.get())!.revision;
    const added = await x.call("routing.provider.add", { providers: [{ name: "fresh", location: "local", endpoint: SERVERS.fresh.url, models: ["fresh-z"], contextTokens: 65536, paid: false, credentialName: SERVERS.fresh.secret }], expectedRevision: revision }, "prov-fresh");
    assert.ok(added.ok, JSON.stringify(added));
    const off = await x.call("routing.disable", { level: "provider", name: "primary", reason: "moving to the new server" }, "off-primary");
    assert.ok(off.ok, JSON.stringify(off));
    release();
    const ra = await x.finished(a.attemptId);
    assert.equal(ra.outcome?.status, "succeeded", ra.outcome?.summary);
    const aCalls = x.calls.slice(a.from);
    assert.equal(aCalls.length, 2, "A's turn: the held call that ended the work, and the call after it");
    assert.deepEqual(aCalls.map(serverOf), ["primary", "primary"], "the running attempt was not moved: its call after the change still went to its own server");
    assert.deepEqual(aCalls.map((c) => c.model), ["local-x", "local-x"]);
    assert.equal(ra.modelCall?.route, "primary/local-x");

    // B, admitted after the change, runs on the new route: its address, its model and its key.
    const b = await x.startTask("Task B");
    const rb = await x.finished(b.attemptId);
    assert.equal(rb.outcome?.status, "succeeded", rb.outcome?.summary);
    const bCalls = x.calls.slice(b.from);
    assert.ok(bCalls.length >= 1);
    assert.deepEqual([...new Set(bCalls.map(serverOf))], ["fresh"], "every call of the new attempt went to the new server");
    assert.deepEqual([...new Set(bCalls.map((c) => c.model))], ["fresh-z"]);
    assert.equal(rb.modelCall?.route, "fresh/fresh-z");
    keysStayed(x.calls);

    // The views follow: the attempt record view names each attempt's real route, the routing view shows the owner's control, and B's activity says why it is not on the configured route.
    assert.match(await x.view({ kind: "attempt_endings", taskId: a.taskId }), /on route primary\/local-x as worker[^\n]*ended as succeeded/);
    assert.match(await x.view({ kind: "attempt_endings", taskId: b.taskId }), /on route fresh\/fresh-z as worker[^\n]*ended as succeeded/);
    assert.match(await x.view({ kind: "model_routes" }), /provider primary is disabled since [^\n]*moving to the new server/);
    const stepsA = await x.steps(a.taskId), stepsB = await x.steps(b.taskId);
    assert.ok(stepsA.includes(`Attempt ${a.attemptId} runs on route primary/local-x.`), JSON.stringify(stepsA));
    assert.ok(!stepsA.some((s) => /closed to new work|address was changed/.test(s)), "nothing about the change is told on A: it was not moved");
    assert.ok(stepsB.includes(`Attempt ${b.attemptId} runs on route fresh/fresh-z.`), JSON.stringify(stepsB));
    const moved = stepsB.filter((s) => /closed to new work/.test(s));
    assert.equal(moved.length, 1, JSON.stringify(stepsB));
    assert.match(moved[0]!, new RegExp(`configured route primary/local-x is closed to new work, so attempt ${b.attemptId} goes to the next open route fresh/fresh-z \\(primary/local-x: [^)]*disabled`));
    // The routing decision itself is the configuration's choice (the controls are applied after it); the step above is what says the attempt went elsewhere.
    assert.equal((await x.call("routing.decisions", { taskId: b.taskId })).result.items[0].route, "primary/local-x");
    for (const text of [...stepsA, ...stepsB, await x.view({ kind: "attempt_endings", taskId: b.taskId })]) for (const key of KEYS) assert.ok(!text.includes(key));
  } finally { await x.close(); }
});

test("a refused provider change leaves the route in force working: the running attempt finishes on it and the next one starts on it, with the same key (card G09)", async (t) => {
  const x = await installation(t);
  if (x === undefined) return;
  try {
    const release = x.holdNext();
    const a = await x.startTask("Task A", true);
    const table = await x.s.routing.get();
    const endpoints = await x.s.setupProviders.endpoints();
    const spec = { name: "primary", location: "local", endpoint: SERVERS.moved.url, models: ["local-x"], contextTokens: 65536, paid: false, credentialName: SERVERS.moved.secret };
    // Refused: the routing table moved on since it was read; the key itself where its name goes; credentials in the address; a server that is not an address.
    const stale = await x.call("routing.provider.add", { providers: [spec], expectedRevision: table!.revision - 1 }, "bad-1");
    assert.deepEqual([stale.ok, stale.error?.code], [false, "stale_revision"], JSON.stringify(stale));
    const keyGiven = await x.call("routing.provider.add", { providers: [{ ...spec, credentialName: SERVERS.moved.key }], expectedRevision: table!.revision }, "bad-2");
    assert.deepEqual([keyGiven.ok, keyGiven.error?.code], [false, "invalid_command"], JSON.stringify(keyGiven));
    assert.ok(!JSON.stringify(keyGiven).includes(SERVERS.moved.key), "the refusal does not repeat the key");
    const inAddress = await x.call("routing.provider.add", { providers: [{ ...spec, endpoint: "http://user:pass@127.0.0.1:9501/v1" }], expectedRevision: table!.revision }, "bad-3");
    assert.deepEqual([inAddress.ok, inAddress.error?.code], [false, "invalid_command"], JSON.stringify(inAddress));
    const notAddress = await x.call("routing.provider.add", { providers: [{ ...spec, endpoint: "ftp://127.0.0.1/v1" }], expectedRevision: table!.revision }, "bad-4");
    assert.deepEqual([notAddress.ok, notAddress.error?.code], [false, "invalid_command"], JSON.stringify(notAddress));
    // Nothing of it was applied.
    assert.deepEqual(await x.s.routing.get(), table);
    assert.deepEqual(await x.s.setupProviders.endpoints(), endpoints);
    release();
    const ra = await x.finished(a.attemptId);
    assert.equal(ra.outcome?.status, "succeeded", ra.outcome?.summary);
    const b = await x.startTask("Task B");
    const rb = await x.finished(b.attemptId);
    assert.equal(rb.outcome?.status, "succeeded", rb.outcome?.summary);
    assert.deepEqual([...new Set(x.calls.map(serverOf))], ["primary"], "both attempts, before and after the refused changes, ran on the route in force");
    keysStayed(x.calls);
    for (const taskId of [a.taskId, b.taskId]) assert.ok(!(await x.steps(taskId)).some((s) => /closed to new work|address was changed/.test(s)));
  } finally { await x.close(); }
});

test("the address of a running attempt's provider is changed: the change applies from its next call, with the new record's key and never the old one, and it is told on the task, not done silently (card G09)", async (t) => {
  const x = await installation(t);
  if (x === undefined) return;
  try {
    const release = x.holdNext();
    const a = await x.startTask("Task A", true);
    const changed = await x.call("routing.provider.add", { providers: [{ name: "primary", location: "local", endpoint: SERVERS.moved.url, models: ["local-x"], contextTokens: 65536, paid: false, credentialName: SERVERS.moved.secret }], expectedRevision: (await x.s.routing.get())!.revision }, "prov-moved");
    assert.ok(changed.ok, JSON.stringify(changed));
    release();
    const ra = await x.finished(a.attemptId);
    assert.equal(ra.outcome?.status, "succeeded", ra.outcome?.summary);
    const aCalls = x.calls.slice(a.from);
    assert.deepEqual(aCalls.map(serverOf), ["primary", "moved"], "the held call was on the old address; the next one went to the changed record's address");
    assert.deepEqual(aCalls.map((c) => c.model), ["local-x", "local-x"], "the route and its model stay the attempt's");
    assert.equal(ra.modelCall?.route, "primary/local-x");
    // The second call's context is the first call's plus the tool result and nothing else lost: the conversation went on at the new address.
    const [first, second] = aCalls.map((c) => JSON.parse(c.text) as unknown[]);
    assert.deepEqual(second!.slice(0, first!.length), first, "the call at the new address carried the whole conversation so far");
    keysStayed(x.calls);
    const told = (await x.steps(a.taskId)).filter((s) => /address was changed/.test(s));
    assert.deepEqual(told, [`Route primary/local-x: its provider's address was changed while attempt ${a.attemptId} ran; its model calls go to 127.0.0.1:9501/v1 from now on (before: 127.0.0.1:9201/v1), with the key the changed record names.`]);
    // The next attempt starts at the new address, and nothing is told about it: it never ran anywhere else.
    const b = await x.startTask("Task B");
    assert.equal((await x.finished(b.attemptId)).outcome?.status, "succeeded");
    assert.deepEqual([...new Set(x.calls.slice(b.from).map(serverOf))], ["moved"]);
    assert.ok(!(await x.steps(b.taskId)).some((s) => /address was changed/.test(s)));
    keysStayed(x.calls);
  } finally { await x.close(); }
});
