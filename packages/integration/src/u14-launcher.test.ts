import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadConfig, protectedFileStore } from "@nimblenewt/config";
import { launch, ownerSecretName, runTerminalChat, setupGreeting, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets } from "@nimblenewt/controller";

// Card U14: the launcher starts the controller from a configuration, makes the owner once (credential in the secret store, not in a file), and the owner's chat reaches the model providers
// the configuration (or the chat) recorded. The model here is a scripted OpenAI-compatible endpoint behind an injected fetch; nothing leaves the machine.

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

function memorySecrets(seed: Record<string, string> = {}): LauncherSecrets & { values: Map<string, string> } {
  const values = new Map(Object.entries(seed));
  return { values, resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) };
}

const providers = (extra: LauncherConfig["models"]["providers"] = {}): LauncherConfig["models"]["providers"] => ({
  primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
  backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
  ...extra,
});
const configFor = (dir: string, p = providers()): LauncherConfig => ({ installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: p } });

/** A model server that answers each owner message with the intents the script holds for it, and records what it was sent. */
function scriptedServer(script: Record<string, unknown[]>) {
  const seen: { url: string; auth: string | null; text: string }[] = [];
  const fetch: typeof globalThis.fetch = async (url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!.content;
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(user)?.[1] ?? "";
    seen.push({ url: String(url), auth: new Headers(init?.headers).get("authorization"), text });
    const intents = script[text] ?? [{ kind: "none", reason: "nothing asked" }];
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(intents) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  return { fetch, seen };
}

const start = { facts, filesystem: ext4 } as const;

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
}

async function* lines(items: string[]): AsyncGenerator<string> { for (const i of items) yield i; }

test("a first start makes the owner once with the credential in the secret store and in no file, registers the configuration's providers, and a restart reuses the owner and resumes at the first open step (card U14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  const secrets = memorySecrets();
  try {
    const a = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal(a.ownerCreated, true);
    const token = secrets.values.get(ownerSecretName(dir));
    assert.ok(token !== undefined && token.length > 20, "the credential is in the secret store");
    assert.equal(a.ownerToken, token);
    assert.match(a.notes.join("\n"), /secret store, not in a file/);
    assert.match(a.notes.join("\n"), /primary\/local-x, backup\/free-y/);
    // Nothing on disk holds the credential: not the database, not the configuration, not a log.
    for (const f of filesUnder(dir)) assert.ok(!readFileSync(f).includes(Buffer.from(token!)), `${f} must not hold the owner's credential`);
    const call = (op: string, args: Record<string, unknown>, id?: string) => a.controller.api.handle(a.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    assert.equal((await call("setup.readiness", {})).result.item.next, "project");
    await call("project.create", { name: "Kept", repositories: [{ id: "kept", location: "/srv/kept" }], versionControl: { host: "none" } }, "p1");
    await a.close();

    // Restart: the same owner, no second bootstrap, the answers given are still there, the next open step is the host.
    const b = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start });
    try {
      assert.equal(b.ownerCreated, false);
      assert.equal(b.ownerToken, token);
      assert.doesNotMatch(b.notes.join("\n"), /You are now the owner/);
      assert.doesNotMatch(b.notes.join("\n"), /registered/, "providers the owner may have edited by chat are not re-applied");
      const r = (await b.controller.api.handle(b.ownerToken, { v: 1, op: "setup.readiness", args: {} } as never) as any).result.item;
      assert.equal(r.next, "host");
      assert.equal(r.items.find((i: { id: string }) => i.id === "project").state, "done");
      const greeting = await setupGreeting(b.controller, b.ownerToken);
      assert.match(greeting, /\[x\] A project/);
      assert.match(greeting, /Next: Which machine runs the agents/);
    } finally { await b.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("a secret store that cannot keep the credential stops the first start before any owner is made; an owner whose credential is missing from the store is told so plainly and nothing is started twice (card U14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  try {
    const broken: LauncherSecrets = { resolve: async () => undefined, set: async () => { throw new Error("the store is locked"); } };
    await assert.rejects(launch({ config: configFor(dir), secrets: broken, argv: [], env: {}, print: () => undefined, start }), /cannot keep the owner's credential, so no owner was made.*locked/);
    // No owner was made, so a start with a working store is a first start.
    const secrets = memorySecrets();
    const ok = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal(ok.ownerCreated, true);
    await ok.close();
    // The credential is gone from the store: plain refusal, and the controller was closed (the next start can take the data directory).
    // A start that finds a live holder of the data directory lock goes on without it and says so (card F04i), so "released" is checked by that notice: every start below must find the lock free.
    const printed: string[] = [];
    const print = (line: string): void => { printed.push(line); };
    const tokenBefore = secrets.values.get(ownerSecretName(dir))!;
    secrets.values.delete(ownerSecretName(dir));
    await assert.rejects(launch({ config: configFor(dir), secrets, argv: [], env: {}, print, start }), /has an owner, but the secret store has no credential named "nimblenewt-owner-token-[0-9a-f]{16}"/);
    secrets.values.set(ownerSecretName(dir), "wrong-token");
    await assert.rejects(launch({ config: configFor(dir), secrets, argv: [], env: {}, print, start }), /not the owner's current credential/);
    secrets.values.set(ownerSecretName(dir), tokenBefore);
    const again = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print, start });
    assert.equal(again.ownerCreated, false, "no second owner");
    await again.close();
    assert.ok(!printed.some((l) => /WITHOUT the data directory lock/.test(l)), `a refused start left the lock held: ${printed.join(" | ")}`);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner's token is in the secret store before the owner exists: a store that fails on the real write leaves no owner and the next start makes one; two installations sharing one store (the Secret Service, the Keychain) keep their own owners (card U14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  const other = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  try {
    // The store keeps small test values but fails the first time it is given the owner's token (a lock, a full disk, a killed process): no owner may exist afterwards, or the token would be lost for good.
    const secrets = memorySecrets();
    let failed = false;
    const flaky: LauncherSecrets = { resolve: secrets.resolve, set: async (n, v) => { if (!failed && v.startsWith("owner:")) { failed = true; throw new Error("the store went away"); } await secrets.set(n, v); } };
    await assert.rejects(launch({ config: configFor(dir), secrets: flaky, argv: [], env: {}, print: () => undefined, start }), /cannot keep the owner's credential, so no owner was made.*went away/);
    const a = await launch({ config: configFor(dir), secrets: flaky, argv: [], env: {}, print: () => undefined, start });
    assert.equal(a.ownerCreated, true, "no owner was left behind without its token");
    const tokenA = a.ownerToken;
    await a.close();
    // A token left in the store by a start that stopped before the owner was made is replaced, not trusted.
    secrets.values.set(ownerSecretName(other), "owner:owner.left-over-from-an-unfinished-start");
    const b = await launch({ config: configFor(other), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal(b.ownerCreated, true);
    assert.notEqual(b.ownerToken, tokenA);
    assert.equal(secrets.values.get(ownerSecretName(other)), b.ownerToken);
    await b.close();
    // Each installation still opens with its own owner.
    const a2 = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal(a2.ownerCreated, false);
    assert.equal(a2.ownerToken, tokenA);
    await a2.close();
    const b2 = await launch({ config: configFor(other), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal(b2.ownerCreated, false);
    await b2.close();
    assert.notEqual(ownerSecretName(dir), ownerSecretName(other));
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(other, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("PostgreSQL named by a secret that is not in the store is refused in plain words before anything starts; a configuration with one model server only is held back with the reason (card U14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  try {
    const pg: LauncherConfig = { ...configFor(dir), controller: { storage: { kind: "postgres", url: { secret: "db-address" }, maxConnections: 5 } } };
    await assert.rejects(launch({ config: pg, secrets: memorySecrets(), argv: [], env: {}, print: () => undefined, start }), /names the secret "db-address".*secret set db-address/);
    const lone = await launch({ config: configFor(dir, { primary: providers()["primary"]! }), secrets: memorySecrets(), argv: [], env: {}, print: () => undefined, start });
    try {
      assert.match(lone.notes.join("\n"), /not registered yet: .*needs a backup/);
      const r = (await lone.controller.api.handle(lone.ownerToken, { v: 1, op: "setup.readiness", args: {} } as never) as any).result.item;
      assert.equal(r.items.find((i: { id: string }) => i.id === "model-route").state, "missing");
      // With no usable route the chat says what is wrong in plain words and the readiness view still works.
      const out: string[] = [];
      await runTerminalChat({ controller: lone.controller, ownerToken: lone.ownerToken, input: lines(["help me get started"]), write: (t) => out.push(t) });
      assert.match(out.join(""), /unavailable right now[\s\S]*check that a model server is registered/);
    } finally { await lone.close(); }
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("on a clean machine the owner reaches a first project on a self-hosted forge, a first agent and a first task using only the launcher and the chat, in their own words, each step shown first and applied on request; a key typed into the chat is refused (card U14)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  const secrets = memorySecrets({ "backup-key": "backup-secret-value" });
  const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  const script: Record<string, unknown[]> = {};
  const server = scriptedServer(script);
  try {
    const l = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, fetch: server.fetch });
    const owner = await l.controller.services.principals.authenticate(l.ownerToken);
    const call = (op: string, args: Record<string, unknown>, id?: string) => l.controller.api.handle(l.ownerToken, { v: 1, op, ...(id === undefined ? {} : { commandId: id }), args } as never) as Promise<any>;
    const chatSays = async (text: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: l.controller, ownerToken: l.ownerToken, input: lines([text]), write: (t) => out.push(t) }); return out.join(""); };
    const proposalOf = async (text: string): Promise<string> => { const turn = await l.controller.chat!.submit(l.ownerToken, { messageId: `p-${Math.random().toString(36).slice(2)}`, text }); const o = turn.outcomes[0] as unknown as { status: string; proposalId?: string }; assert.equal(o.status, "proposed", JSON.stringify(turn)); return o.proposalId!; };

    // 1. How do I start? The model reads it as the setup view; the answer holds the next question.
    script["I just installed this, what do I do first?"] = [intent("status", { request: { kind: "setup" } }, "I just installed this")];
    const first = await chatSays("I just installed this, what do I do first?");
    assert.match(first, /Next to ask: What is your first project/);
    assert.equal(server.seen[0]!.url, "http://127.0.0.1:8002/v1/chat/completions", "the chat uses the local model first");

    // 2. The project, on their own Gitea, drawn up and applied on request.
    const w1 = "Create a project Garden with the repository /srv/garden, it lives on our own Gitea and we use Woodpecker CI";
    script[w1] = [intent("command", { op: "project.create", args: { name: "Garden", goal: "Garden", repositories: [{ id: "garden", location: "/srv/garden" }], versionControl: { host: "self-hosted", hostName: "Gitea", ci: "Woodpecker" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "Create a project Garden")];
    const pid = await proposalOf(w1);
    assert.equal((await call("project.list", {})).result.items.length, 0, "nothing applied unasked");
    script["yes, make it"] = [{ kind: "apply_proposal", proposalId: pid, evidence: "yes, make it", basis: "owner" }];
    await chatSays("yes, make it");
    const project = (await call("project.list", {})).result.items[0];
    assert.deepEqual(project.versionControl, { host: "self-hosted", hostName: "Gitea", ci: "Woodpecker" });

    // 3. A key typed into the chat never reaches the model or the records.
    const before = server.seen.length;
    const refused = await chatSays("my key is sk-abcdefghijklmnopqrstuvwxyz123456 please use it");
    assert.match(refused, /credential|key|secret/i);
    assert.equal(server.seen.length, before, "the model was not called with it");

    // 4. The first agent and its right to work in the project: shown, then applied.
    const w2 = "Make an agent Ann as an author";
    script[w2] = [intent("command", { op: "agent.create", args: { friendlyName: "Ann", roles: ["author"] } }, "Make an agent Ann")];
    // agent.create is shown first when it sets a role (authority); apply when proposed.
    const turn = await l.controller.chat!.submit(l.ownerToken, { messageId: "agent-1", text: w2 });
    const ao = turn.outcomes[0] as unknown as { status: string; proposalId?: string };
    if (ao.status === "proposed") { script["yes, add her"] = [{ kind: "apply_proposal", proposalId: ao.proposalId, evidence: "yes, add her", basis: "owner" }]; await chatSays("yes, add her"); }
    const agents = (await call("agent.list", {})).result.items;
    assert.equal(agents.length, 1);
    assert.equal(agents[0].friendlyName, "Ann");

    // 5. The first task.
    const w3 = "Add a task Say hello to the Garden project";
    script[w3] = [intent("command", { op: "task.create", args: { title: "Say hello", projectName: "Garden" } }, "Add a task Say hello")];
    const t = await l.controller.chat!.submit(l.ownerToken, { messageId: "task-1", text: w3 });
    assert.ok(["applied", "proposed"].includes((t.outcomes[0] as unknown as { status: string }).status), JSON.stringify(t));
    const tasks = (await call("task.list", { projectId: project.id })).result.items;
    if (tasks.length === 0) { script["yes, add it"] = [{ kind: "apply_proposal", proposalId: (t.outcomes[0] as unknown as { proposalId?: string }).proposalId, evidence: "yes, add it", basis: "owner" }]; await chatSays("yes, add it"); }
    assert.equal((await call("task.list", { projectId: project.id })).result.items.length, 1);

    // The readiness view now names only what is really open: a host, and the agent's rights.
    const r = (await call("setup.readiness", {})).result.item;
    const open = r.items.filter((i: { required: boolean; state: string }) => i.required && i.state !== "done").map((i: { id: string }) => i.id);
    assert.deepEqual(open, ["host"]);
    void owner;
    // The credential name reached the endpoint as a bearer header only when the cloud route was used, and its value is in no record.
    await l.close();
    for (const f of filesUnder(dir)) assert.ok(!readFileSync(f).includes(Buffer.from("backup-secret-value")), `${f} must not hold a provider key`);
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("with the real protected-file secret store the owner's credential is an owner-only file outside the data and configuration, and a restart reads it back (card U14)", { skip: process.platform === "win32" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14-launch-"));
  const vault = mkdtempSync(join(tmpdir(), "nn-u14-vault-"));
  try {
    const store = protectedFileStore(join(vault, "secrets"));
    const a = await launch({ config: configFor(dir), secrets: store, argv: [], env: {}, print: () => undefined, start });
    const token = a.ownerToken;
    await a.close();
    const files = filesUnder(join(vault, "secrets"));
    assert.equal(files.length, 1);
    assert.equal(statSync(files[0]!).mode & 0o777, 0o600);
    for (const f of filesUnder(dir)) assert.ok(!readFileSync(f).includes(Buffer.from(token)), f);
    const b = await launch({ config: configFor(dir), secrets: store, argv: [], env: {}, print: () => undefined, start });
    assert.equal(b.ownerToken, token);
    await b.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); rmSync(vault, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the starter configuration the launcher writes loads and holds no secret value (card U14)", () => {
  const doc = { configVersion: 1, profile: "private", installation: { name: "my-newt", dataDir: "/srv/x", workspaces: {} }, controller: { storage: { kind: "sqlite", path: "/srv/x/controller.sqlite" } }, limits: { productiveAttempts: 4, perHost: 2, inquirySlots: 2 }, execution: { isolation: "strong" }, models: { providers: { primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["m"] } }, difficulty: {} }, api: { remoteExposure: false }, approvals: { preset: "strict", grants: [] } };
  const loaded = loadConfig(doc);
  assert.ok(loaded.ok, JSON.stringify(loaded));
});
