import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { PolicyService, launch, runTerminalChat, type EnvironmentFacts, type FilesystemDetector, type LauncherConfig, type LauncherSecrets, type LocalHostBuilder, type LocalHostContext } from "@nimblenewt/controller";

// Card U14b, the launcher's side: the approval profile of the configuration, the worker host that is built only when the owner turned it on (and what is said when it cannot be), and the model addresses
// the host's relay reads from the owner's provider records, with the keys from the secret store by NAME. No sandbox is needed here; the end to end run is u14b-local-host.test.ts.
const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const facts: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };
const start = { facts, filesystem: ext4 } as const;
const memorySecrets = (seed: Record<string, string> = {}): LauncherSecrets & { values: Map<string, string> } => { const values = new Map(Object.entries(seed)); return { values, resolve: async (n) => values.get(n), set: async (n, v) => { values.set(n, v); }, remove: async (n) => values.delete(n) }; };
const configFor = (dir: string, extra: Partial<LauncherConfig> = {}): LauncherConfig => ({ installation: { name: "test", dataDir: dir }, controller: { storage: { kind: "sqlite", path: join(dir, "controller.sqlite") } }, models: { providers: {
  primary: { adapter: "openai-compatible", endpoint: "http://127.0.0.1:8002/v1", enabled: true, paid: false, models: ["local-x"] },
  backup: { adapter: "openai-compatible", endpoint: "https://free.example.invalid/v1", credential: { secret: "backup-key" }, enabled: true, paid: false, models: ["free-y"] },
} }, ...extra });
const dirOf = (): string => mkdtempSync(join(tmpdir(), "nn-u14b-launch-"));
const clean = (dir: string): void => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });

test("the approval profile in the configuration is set once for an installation with no policy, never replaces what the owner set, and strict needs no record (card U14b)", async () => {
  const dir = dirOf();
  const secrets = memorySecrets();
  try {
    const a = await launch({ config: configFor(dir, { approvals: { preset: "derived" } }), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.match(a.notes.join("\n"), /approval profile from the configuration \(derived\) was set/);
    const owner = await a.controller.services.principals.authenticate(a.ownerToken);
    const policy = PolicyService.withEpoch(a.controller.storage, a.controller.epoch, a.controller.services.grants);
    const record = (await policy.get(owner, "installation"))!;
    assert.equal(record.profile, "derived");
    // The owner changes it by chat or the API; a restart with the same file leaves the owner's choice.
    await policy.set(owner, { scope: "installation", commandId: "owner-pick", expectedRevision: record.revision, profile: "autonomous" } as never);
    await a.close();
    const b = await launch({ config: configFor(dir, { approvals: { preset: "derived" } }), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.doesNotMatch(b.notes.join("\n"), /approval profile/);
    const after = await PolicyService.withEpoch(b.controller.storage, b.controller.epoch, b.controller.services.grants).get(await b.controller.services.principals.authenticate(b.ownerToken), "installation");
    assert.equal(after!.profile, "autonomous");
    await b.close();
  } finally { clean(dir); }
  const dir2 = dirOf();
  try {
    const s = await launch({ config: configFor(dir2, { approvals: { preset: "strict" } }), secrets: memorySecrets(), argv: [], env: {}, print: () => undefined, start });
    assert.equal(await PolicyService.withEpoch(s.controller.storage, s.controller.epoch, s.controller.services.grants).get(await s.controller.services.principals.authenticate(s.ownerToken), "installation"), undefined, "strict is what no record means");
    await s.close();
  } finally { clean(dir2); }
});

test("a worker host is built only when the owner turned it on; a machine that cannot build one, a start that fails with it and a start with no builder all say so in plain words and leave a working controller (card U14b)", async () => {
  const dir = dirOf();
  const secrets = memorySecrets();
  const built: string[] = [];
  const closed: string[] = [];
  try {
    const builder: LocalHostBuilder = async () => { built.push("built"); return { problem: "the sandbox is not usable here (test)" }; };
    // Off by default: the builder is not even asked.
    const off = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
    assert.deepEqual(built, []);
    assert.doesNotMatch(off.notes.join("\n"), /worker host/);
    const owner = await off.controller.services.principals.authenticate(off.ownerToken);
    assert.equal((await off.controller.api.handle(off.ownerToken, { v: 1, op: "host.local.set", commandId: "on-1", args: { enabled: true } } as never) as { ok: boolean }).ok, true);
    void owner;
    await off.close();

    // On, but this machine cannot: told why, and the controller works.
    const noSandbox = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
    assert.deepEqual(built, ["built"]);
    assert.match(noSandbox.notes.join("\n"), /turned on the worker host for this computer, but it was not started: the sandbox is not usable here \(test\)/);
    assert.equal((await noSandbox.controller.api.handle(noSandbox.ownerToken, { v: 1, op: "project.list", args: {} } as never) as { ok: boolean }).ok, true);
    await noSandbox.close();

    // On, no builder given by whoever started the launcher.
    const none = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.match(none.notes.join("\n"), /no way to build one/);
    await none.close();

    // On, built, but the controller refuses to start with it: what the builder made is freed, the owner is told, and the controller starts without a host.
    const failing: LocalHostBuilder = async () => ({
      start: { dispatch: { local: { window: () => undefined, build: () => { throw new Error("this machine has no sandbox (test)"); }, close: async () => { closed.push("local.close"); } } } },
      attach: async () => { throw new Error("must not be attached"); },
      close: async () => { closed.push("plan.close"); },
    });
    const fallen = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: failing });
    assert.match(fallen.notes.join("\n"), /the controller could not run agents with it, so it runs without one: this machine has no sandbox \(test\)/);
    assert.ok(closed.includes("plan.close"), "what the builder made was freed");
    assert.equal((await fallen.controller.api.handle(fallen.ownerToken, { v: 1, op: "project.list", args: {} } as never) as { ok: boolean }).ok, true);
    await fallen.close();

    // A start that throws with the host built in: freed, told, and started again without it.
    const throwing: LocalHostBuilder = async () => ({
      start: { dispatch: { get local(): never { throw new Error("the start itself broke (test)"); } } as never },
      attach: async () => { throw new Error("must not be attached"); },
      close: async () => { closed.push("plan.close.throwing"); },
    });
    const broke = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: throwing });
    assert.match(broke.notes.join("\n"), /the controller would not start with it, so it runs without one: the start itself broke \(test\)/);
    assert.ok(closed.includes("plan.close.throwing"));
    assert.equal((await broke.controller.api.handle(broke.ownerToken, { v: 1, op: "project.list", args: {} } as never) as { ok: boolean }).ok, true);
    await broke.close();
  } finally { clean(dir); }
});

test("the relay's model address is read from the owner's provider record at each call and its key from the secret store by NAME at each call; a record the owner edited is used at once, a missing secret names the secret and never a value (card U14b)", async () => {
  const dir = dirOf();
  const secrets = memorySecrets({ "backup-key": "sk-backup-one", "edited-key": "sk-edited-one" });
  let context: LocalHostContext | undefined;
  try {
    const builder: LocalHostBuilder = async (ctx) => { context = ctx; return { problem: "only looking at the context" }; };
    const l = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
    await l.controller.api.handle(l.ownerToken, { v: 1, op: "host.local.set", commandId: "on", args: { enabled: true } } as never);
    await l.close();
    const l2 = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: builder });
    const ctx = context!;
    assert.equal(ctx.dataDir.length > 0, true);

    // From the configuration's providers first.
    const local = (await ctx.endpoint("primary/local-x"))!;
    assert.equal(local.url, "http://127.0.0.1:8002/v1");
    assert.equal(local.headers, undefined, "a provider with no credential name sends no key");
    const cloud = (await ctx.endpoint("backup/free-y"))!;
    assert.equal(cloud.url, "https://free.example.invalid/v1");
    assert.deepEqual(await cloud.headers!(), { authorization: "Bearer sk-backup-one" });
    secrets.values.set("backup-key", "sk-backup-rotated");
    assert.deepEqual(await cloud.headers!(), { authorization: "Bearer sk-backup-rotated" }, "the key is read at each call");
    assert.equal(await ctx.endpoint("nobody/model"), undefined);
    assert.equal(await ctx.endpoint("noslash"), undefined);

    // The owner edits the providers (by chat or the operation): the next call goes to the new address with the named key.
    const table = (await l2.controller.services.routing.get())!;
    const edited = await l2.controller.api.handle(l2.ownerToken, { v: 1, op: "routing.provider.add", commandId: "edit", args: { expectedRevision: table.revision, providers: [
      { name: "primary", location: "local", endpoint: "http://127.0.0.1:9301/v1", models: ["local-x"], contextTokens: 65536, paid: false, credentialName: "edited-key" },
      { name: "backup", location: "cloud", endpoint: "https://free.example.invalid/v1", models: ["free-y"], contextTokens: 32000, paid: false, credentialName: "backup-key" },
    ] } } as never) as { ok: boolean };
    assert.equal(edited.ok, true, JSON.stringify(edited));
    const moved = (await ctx.endpoint("primary/local-x"))!;
    assert.equal(moved.url, "http://127.0.0.1:9301/v1");
    assert.deepEqual(await moved.headers!(), { authorization: "Bearer sk-edited-one" });

    // A key missing from the store: the error names the secret, not any value.
    secrets.values.delete("edited-key");
    await assert.rejects(Promise.resolve().then(() => moved.headers!()), (error: Error) => /"edited-key" is not in the secret store/.test(error.message) && !/sk-/.test(error.message));
    await l2.close();
  } finally { clean(dir); }
});

const filesUnder = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name)) : [join(dir, e.name)]));
async function* lines(items: string[]): AsyncGenerator<string> { for (const i of items) yield i; }

test("in the terminal chat a host's credential is asked for in words, shown first, then written once to the terminal and to nothing else: not the data directory, the secret store, a note or the print output (card U14b)", async () => {
  const dir = dirOf();
  const secrets = memorySecrets({ "backup-key": "sk-backup-one" });
  const script: Record<string, unknown[]> = {};
  const fetch: typeof globalThis.fetch = async (_url, init) => {
    const body = JSON.parse(String(init?.body)) as { messages: { role: string; content: string }[] };
    const text = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(body.messages.find((m) => m.role === "user")!.content)?.[1] ?? "";
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(script[text] ?? [{ kind: "none", reason: "nothing asked" }]) } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }), { status: 200, headers: { "content-type": "application/json" } });
  };
  const printed: string[] = [];
  try {
    const l = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: (x) => { printed.push(x); }, start, fetch });
    const said = async (text: string): Promise<string> => { const out: string[] = []; await runTerminalChat({ controller: l.controller, ownerToken: l.ownerToken, input: lines([text]), write: (x) => out.push(x) }); return out.join(""); };
    const asked = "My second computer is called workbench, give it a credential so it can join";
    script[asked] = [{ kind: "command", op: "credential.issue", args: { kind: "host", name: "workbench" }, evidence: "give it a credential", basis: "owner" }];
    // "workbench" must be in the owner's words, and it is.
    const first = await said(asked);
    assert.match(first, /credential/i);
    assert.doesNotMatch(first, /host:workbench\./, "asking shows no credential");
    const turn = await l.controller.chat!.submit(l.ownerToken, { messageId: "probe", text: asked });
    const proposalId = (turn.outcomes[0] as unknown as { proposalId: string }).proposalId;
    script["yes please"] = [{ kind: "apply_proposal", proposalId, evidence: "yes please", basis: "owner" }];
    const shown = await said("yes please");
    const match = /^(host:workbench\.[A-Za-z0-9_-]+)$/m.exec(shown);
    assert.ok(match, shown);
    assert.match(shown, /shown once, kept nowhere/);
    const token = match![1]!;
    assert.equal((await l.controller.services.principals.authenticate(token)).id, "host:workbench");
    assert.equal([...shown.matchAll(new RegExp(token.replace(/[.]/g, "\\."), "g"))].length, 1, "written once");
    // Asking again in the same words does not show it again.
    assert.doesNotMatch(await said("yes please"), /host:workbench\.[A-Za-z0-9_-]{20}/);
    const key = token.split(".")[1]!;
    for (const v of secrets.values.values()) assert.ok(!v.includes(key), "the secret store does not hold it");
    for (const line of [...printed, ...l.notes]) assert.ok(!line.includes(key));
    await l.close();
    for (const f of filesUnder(dir)) assert.ok(!readFileSync(f).includes(Buffer.from(key)), `${f} must not hold the credential`);
  } finally { clean(dir); }
});

// Review of card U14b: a builder that throws, or a host that cannot join once the controller is up (the owner disabled host:local), is told and never leaves the owner without a controller.
test("a host builder that throws, and a built host whose attach throws, are told in plain words and the controller still starts and answers (U14b review)", async () => {
  const dir = dirOf();
  const secrets = memorySecrets();
  const closed: string[] = [];
  try {
    const first = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start });
    assert.equal((await first.controller.api.handle(first.ownerToken, { v: 1, op: "host.local.set", commandId: "on", args: { enabled: true } } as never) as { ok: boolean }).ok, true);
    await first.close();

    const throwing: LocalHostBuilder = async () => { throw new Error("the worker package could not be loaded (test)"); };
    const a = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: throwing });
    assert.match(a.notes.join("\n"), /was not started: building it failed: the worker package could not be loaded \(test\)/);
    assert.equal((await a.controller.api.handle(a.ownerToken, { v: 1, op: "project.list", args: {} } as never) as { ok: boolean }).ok, true);
    await a.close();

    let attached = 0;
    const refusing: LocalHostBuilder = async () => ({
      start: { dispatch: { manual: true, local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined, build: () => ({ hostId: "host:local" }) as never } } as never },
      attach: async () => { attached++; throw new Error("host:local is not an active host (test)"); },
      close: async () => { closed.push("plan.close"); },
    });
    const b = await launch({ config: configFor(dir), secrets, argv: [], env: {}, print: () => undefined, start, localHost: refusing });
    const said = b.notes.join("\n");
    assert.equal(b.controller.dispatch !== undefined, true, said);
    assert.equal(attached, 1);
    assert.match(said, /could not join, so tasks wait for a host: host:local is not an active host \(test\)/);
    assert.equal((await b.controller.api.handle(b.ownerToken, { v: 1, op: "project.list", args: {} } as never) as { ok: boolean }).ok, true);
    await b.close();
    assert.ok(closed.includes("plan.close"), "what the builder made is freed");
  } finally { clean(dir); }
});
