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
async function* lines(items: string[]): AsyncGenerator<string> { for (const i of items) yield i; }
const intent = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });

// Card U14c: the whole first-run walk-through, driven through the real chat interpreter on a stand-in model server, in the strict profile. Every step the owner answers is drawn up and shown
// first; nothing is written until the owner says yes; and a key typed into the chat is never sent to the model, with the supported secret path named in the refusal.
test("every first-run step is shown first and needs the owner's yes, in the strict profile (card U14c)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-u14c-"));
  const script: Record<string, unknown[]> = {};
  const server = scriptedServer(script);
  try {
    const l = await launch({ config: configFor(dir), secrets: memorySecrets({ "backup-key": "backup-secret-value" }), argv: [], env: {}, print: () => undefined, start, fetch: server.fetch });
    const call = (op: string, args: Record<string, unknown> = {}) => l.controller.api.handle(l.ownerToken, { v: 1, op, args } as never) as Promise<any>;
    const say = async (text: string) => l.controller.chat!.submit(l.ownerToken, { messageId: `m-${Math.random().toString(36).slice(2)}`, text });
    const shownFirst = async (text: string, intents: unknown[], untouched: () => Promise<boolean>): Promise<string> => {
      script[text] = intents;
      const turn = await say(text);
      const statuses = turn.outcomes.map((o) => (o as unknown as { status: string }).status);
      assert.deepEqual(statuses.filter((s) => s !== "proposed"), [], `${text}: ${JSON.stringify(turn.outcomes)}`);
      assert.ok(await untouched(), `${text}: nothing may be written before the yes`);
      return (turn.outcomes[0] as unknown as { proposalId: string }).proposalId;
    };
    const yes = async (proposalId: string): Promise<void> => {
      const text = `yes ${proposalId}`;
      script[text] = [{ kind: "apply_proposal", proposalId, evidence: text, basis: "owner" }];
      const turn = await say(text);
      assert.deepEqual(turn.outcomes.map((o) => (o as unknown as { status: string }).status), ["applied"], JSON.stringify(turn.outcomes));
    };

    // The project and where it lives.
    const p1 = await shownFirst("Create the project Garden at /srv/garden on our Gitea", [intent("command", { op: "project.create", args: { name: "Garden", goal: "Garden", repositories: [{ id: "garden", location: "/srv/garden" }], versionControl: { host: "self-hosted", hostName: "Gitea" }, integration: { landing: "default", integrator: "default", requiredChecks: "default", refreshRounds: "default" } } }, "Create the project Garden")], async () => (await call("project.list")).result.items.length === 0);
    await yes(p1);
    const project = (await call("project.list")).result.items[0];

    // This computer runs the agents.
    const p2 = await shownFirst("Run the agents on this computer", [intent("command", { op: "host.local.set", args: { enabled: true } }, "Run the agents on this computer")], async () => (await call("host.local.get")).result.item.enabled === false);
    await yes(p2);
    assert.equal((await call("host.local.get")).result.item.enabled, true);

    // Notifications: digest time and quiet hours.
    const notifRev = (await call("notifications.settings")).result.item.revision;
    const p3 = await shownFirst("Send me a digest at 08:00 and keep quiet from 22:00 to 07:00", [intent("command", { op: "notifications.configure", args: { digestTimes: ["08:00"], quietHours: { start: "22:00", end: "07:00" } } }, "Send me a digest at 08:00")], async () => (await call("notifications.settings")).result.item.revision === notifRev);
    await yes(p3);

    // The first agent, its right, and its credential.
    const p4 = await shownFirst("Add an agent called Ann as an author", [intent("command", { op: "agent.create", args: { friendlyName: "Ann", roles: ["author"] } }, "Add an agent called Ann")], async () => (await call("agent.list")).result.items.length === 0);
    await yes(p4);
    const ann = (await call("agent.list")).result.items[0];
    const grantee = ann.principal ?? `agent:${ann.id}`;
    const w5 = `Give ${grantee} the right approve.class.commit in project ${project.id} because Ann works in Garden`;
    const p5 = await shownFirst(w5, [intent("command", { op: "grant.create", args: { grantee, action: "approve.class.commit", project: project.id, basis: "Ann works in Garden" } }, w5)], async () => true);
    await yes(p5);

    // The first task.
    const p6 = await shownFirst("Add a task Say hello to Garden", [intent("command", { op: "task.create", args: { title: "Say hello", projectName: "Garden" } }, "Add a task Say hello")], async () => (await call("task.list", { projectId: project.id })).result.items.length === 0);
    await yes(p6);
    assert.equal((await call("task.list", { projectId: project.id })).result.items.length, 1);

    // Budgets are declined (nothing is written), then the approval profile: the owner chooses derived last, so it is the walk-through's own steps that were all in the strict profile.
    script["No budgets for now"] = [{ kind: "none", reason: "the owner declined", evidence: "No budgets for now", basis: "owner" }];
    await say("No budgets for now");
    assert.equal((await call("setup.readiness")).result.item.items.find((i: { id: string }) => i.id === "budgets").state, "default");

    const profileBefore = (await call("setup.readiness")).result.item.items.find((i: { id: string }) => i.id === "profile").state;
    assert.equal(profileBefore, "default");
    const p0 = await shownFirst("Let me approve less often: use the derived profile", [{ kind: "policy_edit", change: { type: "profile", to: "derived" }, evidence: "use the derived profile", basis: "owner" }], async () => (await call("setup.readiness")).result.item.items.find((i: { id: string }) => i.id === "profile").state === "default");
    await yes(p0);
    assert.equal((await call("setup.readiness")).result.item.items.find((i: { id: string }) => i.id === "profile").state, "done");

    // Only the host (it has not announced itself until the next start) is still open, and the readiness view holds no secret.
    const ready = (await call("setup.readiness")).result.item;
    assert.deepEqual(ready.items.filter((i: { required: boolean; state: string }) => i.required && i.state !== "done").map((i: { id: string }) => i.id), ["host"]);
    assert.ok(!JSON.stringify(ready).includes("backup-secret-value"));

    // A key typed into the chat is not sent to the model, and the refusal names the supported path.
    const before = server.seen.length;
    const typed = "my key is sk-abcdefghijklmnopqrstuvwxyz123456 please use it";
    await assert.rejects(say(typed), (e: Error) => /secret set/.test(e.message) && !e.message.includes("sk-abcdef"));
    const out: string[] = [];
    await runTerminalChat({ controller: l.controller, ownerToken: l.ownerToken, input: lines([typed]), write: (t) => out.push(t) });
    assert.match(out.join(""), /secret set/);
    assert.ok(!out.join("").includes("sk-abcdef"), "the key is not echoed");
    assert.equal(server.seen.length, before, "the model never saw it");
    await l.close();
  } finally { rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
