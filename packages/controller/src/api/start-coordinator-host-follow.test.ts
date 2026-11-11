import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ScriptedInterpreter } from "../chat/index.js";
import type { EnvironmentFacts, FilesystemDetector } from "../environment/index.js";
import { startController } from "./index.js";

const ext4: FilesystemDetector = async () => ({ type: "ext4", network: false });
const supported: EnvironmentFacts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" };

/** U03d: the follow-ups of the coordinator as a hosted agent, in the running controller. */
async function world(options: { profileRoutes?: (profile: string) => readonly string[]; roleRoutes?: () => readonly string[]; used?: string[] } = {}) {
  const d = mkdtempSync(join(tmpdir(), "nn-hostd-"));
  let held: string | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: {
      interpreter: new ScriptedInterpreter({}),
      coordinator: {
        token: async () => held,
        routes: () => (options.roleRoutes ?? (() => ["role/route"]))(),
        ...(options.profileRoutes === undefined ? {} : { profileRoutes: options.profileRoutes }),
        model: { respond: async (route, request, meter) => {
          options.used?.push(route);
          meter?.({ inputTokens: 40, outputTokens: 10 });
          return request.kind === "answer" ? { kind: "answer", text: "On Mondays.", cites: [request.records[0]!.source] } : {};
        } },
      },
    },
  });
  const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
  const rob = await c.services.principals.authenticate(boot.token);
  const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [{ id: "main", location: join(d, "garden") }] })).id;
  await c.services.principals.enroll(rob, { commandId: "e-writer", kind: "agent", name: "writer", grants: [{ action: "desk.write", project }, { action: "desk.read", project }] });
  const writer = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:writer")).token);
  await c.services.desks.write(writer, { commandId: "w1", projectId: project, kind: "note", title: "Watering", body: "We water on Mondays.", visibility: "shared", status: "accepted" } as never);
  const ask = async (n: string) => (await c.coordinator!.answer(rob, { commandId: `q-${n}`, projectId: project, question: "water on Mondays" })) as { kind: string; reason?: string };
  const agent = async (name: string, profile?: string) => {
    const made = await c.services.agents.create(rob, { commandId: `ag-${name}`, friendlyName: name, ...(profile === undefined ? {} : { defaultProfile: profile }) });
    held = (await c.services.principals.issueCredential(rob, `agent:${made.id}`)).token;
    return { id: made.id, principalId: `agent:${made.id}`, token: held! };
  };
  const close = async () => { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); };
  return { c, rob, boot, call, project, ask, agent, close, held: () => held };
}

test("the owner's agent views mark the coordinator and show its lifecycle; nobody else sees it, and an unreadable lifecycle says unknown, not stopped (U03d a, d)", async () => {
  const w = await world();
  try {
    const ada = await w.agent("Ada");
    const bob = await w.c.services.agents.create(w.rob, { commandId: "ag-bob", friendlyName: "Bob" });
    await w.c.services.principals.enroll(w.rob, { commandId: "e-reader", kind: "agent", name: "reader", grants: [{ action: "agent.read", project: "*" }] });
    const reader = (await w.c.services.principals.issueCredential(w.rob, "agent:reader")).token;
    await w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId, routes: ["role/route"] });

    const list = await w.call(w.boot.token, "agent.list", {});
    assert.equal(list.ok, true, JSON.stringify(list));
    const marked = list.result.items.find((i: any) => i.id === ada.id);
    assert.equal(marked.coordinator.state, "paused", "set up paused");
    assert.deepEqual(marked.coordinator.heldBy.map((h: any) => h.scope), [{ kind: "agent", id: ada.id }]);
    assert.equal(list.result.items.find((i: any) => i.id === bob.id).coordinator, undefined, "only the coordinator is marked");
    assert.equal((await w.call(w.boot.token, "agent.get", { agentId: ada.id })).result.item.coordinator.state, "paused");

    // A holder of agent.read, and the agent itself, read the plain record: the lifecycle is the owner's.
    assert.equal((await w.call(reader, "agent.list", {})).result.items.find((i: any) => i.id === ada.id).coordinator, undefined);
    assert.equal((await w.call(reader, "agent.get", { agentId: ada.id })).result.item.coordinator, undefined);
    assert.equal((await w.call(ada.token, "agent.get", { agentId: ada.id })).result.item.coordinator, undefined);

    // Started: the view follows the gate.
    const rev = (await w.c.coordinator!.get(w.rob))!.revision;
    await w.c.coordinator!.setState(w.rob, { commandId: "s1", expectedRevision: rev, to: "running" });
    assert.equal((await w.call(w.boot.token, "agent.get", { agentId: ada.id })).result.item.coordinator.state, "running");

    // The agent controls cannot be read: unknown, with no lifecycle, and the agent list still works.
    const real = w.c.services.pauses.agentHolds.bind(w.c.services.pauses);
    w.c.services.pauses.agentHolds = async () => { throw new Error("the gates cannot be read"); };
    try {
      const view = (await w.c.coordinator!.get(w.rob))!;
      assert.equal(view.state, "unknown");
      assert.equal(view.lifecycle, undefined);
      const through = await w.call(w.boot.token, "coordinator.get", {});
      assert.equal(through.result.item.state, "unknown");
      assert.equal((await w.call(w.boot.token, "agent.get", { agentId: ada.id })).result.item.coordinator.state, "unknown");
      assert.match((await w.ask("u")).reason!, /could not be read/);
    } finally { w.c.services.pauses.agentHolds = real; }
  } finally { await w.close(); }
});

test("a pause made directly through the agent controls is reported reached by the coordinator when it holds no work (U03d d)", async () => {
  const w = await world();
  try {
    const ada = await w.agent("Ada");
    const cfg = await w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId, routes: ["role/route"] });
    await w.c.coordinator!.setState(w.rob, { commandId: "s1", expectedRevision: cfg.revision, to: "running" });
    const gate = async () => (await w.call(w.boot.token, "lifecycle.status", { scope: { kind: "agent", id: ada.id } })).result.item;
    assert.equal((await w.call(w.boot.token, "lifecycle.pause", { scope: { kind: "agent", id: ada.id }, reason: "quiet hours" }, "direct-pause")).ok, true);
    assert.notEqual((await gate()).observed?.state, "paused", "nobody has reported it yet");
    const view = (await w.c.coordinator!.get(w.rob))!;
    assert.equal(view.state, "paused");
    assert.equal((await gate()).observed.state, "paused", "the coordinator holds no work and says so");
    assert.equal(view.lifecycle!.heldBy[0]!.reason, "quiet hours");
    // A question that finds it paused reports a pause made the same way, too.
    await w.call(w.boot.token, "lifecycle.resume", { scope: { kind: "agent", id: ada.id }, reason: "back" }, "direct-resume");
    await w.call(w.boot.token, "lifecycle.pause", { scope: { kind: "agent", id: ada.id }, reason: "again" }, "direct-pause-2");
    assert.equal((await w.ask("1")).kind, "unavailable");
    assert.equal((await gate()).observed.state, "paused");
  } finally { await w.close(); }
});

test("a set-up refused after its pause (a concurrent change took the record) lifts the pause it made, and only its own; the owner's repeat pauses again (U03d d)", async () => {
  const w = await world();
  try {
    const ada = await w.agent("Ada");
    const gate = async () => (await w.call(w.boot.token, "lifecycle.status", { scope: { kind: "agent", id: ada.id } })).result.item;
    const real = w.c.services.pauses.pause.bind(w.c.services.pauses);
    let race = true;
    // Somebody else sets the coordinator up in the instant between the set-up's pause and its write.
    w.c.services.pauses.pause = async (...a: Parameters<typeof real>) => { const made = await real(...a); if (race) { race = false; await w.c.coordinator!.configure(w.rob, { commandId: "rival", principalId: "agent:rival", routes: ["r"] }); } return made; };
    await assert.rejects(w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId, routes: ["role/route"] }), (e: unknown) => (e as { code?: string }).code === "stale_revision");
    assert.equal((await gate()).intent, "active", "the agent is not left paused for a coordinator that was not made");
    assert.equal((await w.c.coordinator!.get(w.rob))!.principalId, "agent:rival");
    // The owner reads again and repeats: the agent is paused once more (the earlier pause command is not replayed into nothing).
    await w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId, routes: ["role/route"], expectedRevision: (await w.c.coordinator!.get(w.rob))!.revision });
    assert.equal((await gate()).intent, "pause");

    // A pause the owner made on the agent before is not the set-up's and stays.
    const bob = await w.agent("Bob");
    await w.call(w.boot.token, "lifecycle.pause", { scope: { kind: "agent", id: bob.id }, reason: "mine" }, "own-pause");
    await assert.rejects(w.c.coordinator!.configure(w.rob, { commandId: "c2", principalId: bob.principalId, routes: ["r"], expectedRevision: 99 }), (e: unknown) => (e as { code?: string }).code === "stale_revision");
    assert.equal((await w.call(w.boot.token, "lifecycle.status", { scope: { kind: "agent", id: bob.id } })).result.item.intent, "pause");
  } finally { await w.close(); }
});

test("review: a set-up refused after its pause keeps that pause when a concurrent set-up of the same agent took the record; that coordinator is not left running unstarted (U03d d)", async () => {
  const w = await world();
  try {
    const ada = await w.agent("Ada");
    const gate = async () => (await w.call(w.boot.token, "lifecycle.status", { scope: { kind: "agent", id: ada.id } })).result.item;
    const real = w.c.services.pauses.pause.bind(w.c.services.pauses);
    let race = true;
    // The owner's second set-up of the same agent (another command, say from the chat) lands between the first one's pause and its write; it finds the agent already paused and makes no pause of its own.
    w.c.services.pauses.pause = async (...a: Parameters<typeof real>) => { const made = await real(...a); if (race) { race = false; await w.c.coordinator!.configure(w.rob, { commandId: "other", principalId: ada.principalId, routes: ["role/route"] }); } return made; };
    await assert.rejects(w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId, routes: ["role/route"] }), (e: unknown) => (e as { code?: string }).code === "stale_revision");
    const view = (await w.c.coordinator!.get(w.rob))!;
    assert.equal(view.hosted?.agentId, ada.id);
    assert.equal((await gate()).intent, "pause", "the coordinator that was set up waits for the owner to start it");
    assert.equal(view.state, "paused");
    assert.equal((await w.ask("1")).kind, "unavailable", "nobody started it");
  } finally { await w.close(); }
});

test("review: the owner's stated routes are used only where the routing table lets the coordinator use them (no paid, cloud or unknown route); otherwise the profile or role decides (U03d b)", async () => {
  const used: string[] = [];
  const w = await world({ used, roleRoutes: () => ["mine/big-local"] });
  try {
    const added = await w.call(w.boot.token, "routing.provider.add", { providers: [
      { name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["big-local", "small-local"], contextTokens: 65536 },
      { name: "pricey", location: "local", paid: true, endpoint: "http://127.0.0.1:8003/v1", models: ["top"], contextTokens: 200000 },
      { name: "far", location: "cloud", paid: false, endpoint: "https://free.example.invalid/v1", credentialName: "far-key", models: ["free"], contextTokens: 32000 },
    ] }, "rt-1");
    assert.equal(added.ok, true, JSON.stringify(added));
    const ada = await w.agent("Ada");
    const cfg = await w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId, routes: ["pricey/top", "far/free", "ghost/none"] });
    await w.c.coordinator!.setState(w.rob, { commandId: "s1", expectedRevision: cfg.revision, to: "running" });
    assert.equal((await w.c.coordinator!.get(w.rob))!.routeSource, "role", "none of the stated routes may be used");
    assert.equal((await w.ask("1")).kind, "answer");
    assert.deepEqual(used, ["mine/big-local"], "the paid, the cloud and the unknown route are never called");

    // An eligible route among them is used, in the owner's order.
    const rev = (await w.c.coordinator!.get(w.rob))!.revision;
    await w.c.coordinator!.configure(w.rob, { commandId: "c2", principalId: ada.principalId, routes: ["pricey/top", "mine/small-local"], expectedRevision: rev });
    assert.equal((await w.c.coordinator!.get(w.rob))!.routeSource, "owner");
    used.length = 0;
    await w.ask("2");
    assert.deepEqual(used, ["mine/small-local"]);
  } finally { await w.close(); }
});

test("a hosted coordinator's routes: the owner's stated routes, else its agent's profile, else the coordinator role's; and its calls are the agent's usage without ever blocking (U03d b)", async () => {
  const used: string[] = [];
  const w = await world({ used, profileRoutes: (p) => (p === "fast" ? ["fast/one", "fast/two"] : []) });
  try {
    // The owner's stated route is one the routing table knows (a local, unpaid route).
    assert.equal((await w.call(w.boot.token, "routing.provider.add", { providers: [
      { name: "mine", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["route"], contextTokens: 65536 },
      { name: "spare", location: "local", endpoint: "http://127.0.0.1:8003/v1", models: ["other"], contextTokens: 65536 },
    ] }, "rt-1")).ok, true);
    const ada = await w.agent("Ada", "fast");
    const cfg = await w.c.coordinator!.configure(w.rob, { commandId: "c1", principalId: ada.principalId });
    const run = await w.c.coordinator!.setState(w.rob, { commandId: "s1", expectedRevision: cfg.revision, to: "running" });
    let view = (await w.c.coordinator!.get(w.rob))!;
    assert.equal(view.routeSource, "profile");
    assert.equal(view.profile, "fast");
    assert.deepEqual(view.routes, [], "nothing stated");
    assert.equal((await w.ask("1")).kind, "answer");
    assert.deepEqual(used, ["fast/one"], "the agent's profile decides");

    // Its call is the agent's usage, as shared overhead under a named rule and in the project; no limit stood in its way.
    const usage = (await w.call(w.boot.token, "budget.usage", { agentId: ada.principalId })).result.item;
    assert.equal(usage.entries, 1, JSON.stringify(usage));
    assert.ok(usage.byAgent[ada.principalId] !== undefined);
    assert.equal(usage.byActivity["model-call"] !== undefined, true);
    assert.equal(usage.byProject[w.project] !== undefined, true);
    assert.match(usage.overheadRules[0], /coordinator/);
    await w.ask("2");
    assert.equal((await w.call(w.boot.token, "budget.usage", { agentId: ada.principalId })).result.item.entries, 2);

    // Routes the owner states override the profile.
    const stated = await w.c.coordinator!.configure(w.rob, { commandId: "c2", principalId: ada.principalId, routes: ["mine/route"], expectedRevision: run.revision });
    view = (await w.c.coordinator!.get(w.rob))!;
    assert.equal(view.routeSource, "owner");
    used.length = 0;
    await w.ask("3");
    assert.deepEqual(used, ["mine/route"]);

    // Stated routes cleared again: back to the profile. A profile that gives nothing falls to the coordinator role's routes.
    await w.c.coordinator!.configure(w.rob, { commandId: "c3", principalId: ada.principalId, expectedRevision: stated.revision });
    assert.equal((await w.c.coordinator!.get(w.rob))!.routeSource, "profile");
    await w.c.services.agents.update(w.rob, { commandId: "up", agentId: ada.id, expectedRevision: (await w.call(w.boot.token, "agent.get", { agentId: ada.id })).result.item.revision, defaultProfile: "unknown-profile" });
    assert.equal((await w.c.coordinator!.get(w.rob))!.routeSource, "role");
    used.length = 0;
    await w.ask("4");
    assert.deepEqual(used, ["role/route"]);

    // A coordinator that is not hosted needs its routes stated, as before.
    await assert.rejects(w.c.coordinator!.configure(w.rob, { commandId: "c4", principalId: "agent:plain", expectedRevision: (await w.c.coordinator!.get(w.rob))!.revision }), (e: unknown) => (e as { code?: string }).code === "invalid_command");
  } finally { await w.close(); }
});

test("the state API sets the coordinator up and takes it off its agent, owner only, and the coordinator cannot start itself (U03d c)", async () => {
  const w = await world();
  try {
    const ada = await w.agent("Ada");
    // Not the owner: refused, whatever the agent holds.
    await w.c.services.principals.enroll(w.rob, { commandId: "e-boss", kind: "agent", name: "boss", grants: [{ action: "agent.manage", project: "*" }] });
    const boss = (await w.c.services.principals.issueCredential(w.rob, "agent:boss")).token;
    for (const token of [boss, ada.token]) assert.equal((await w.call(token, "coordinator.configure", { principalId: ada.principalId }, "x1")).ok, false);
    // The service refuses them too, on its own (not only the operation's check).
    for (const token of [boss, ada.token]) {
      const who = await w.c.services.principals.authenticate(token);
      await assert.rejects(w.c.coordinator!.configure(who, { commandId: "x1s", principalId: ada.principalId }), (e: unknown) => (e as { code?: string }).code === "forbidden");
      await assert.rejects(w.c.coordinator!.setState(who, { commandId: "x2s", expectedRevision: 1, to: "running" }), (e: unknown) => (e as { code?: string }).code === "forbidden");
      await assert.rejects(w.c.coordinator!.get(who), (e: unknown) => (e as { code?: string }).code === "forbidden");
    }

    const set = await w.call(w.boot.token, "coordinator.configure", { principalId: ada.principalId }, "api-1");
    assert.equal(set.ok, true, JSON.stringify(set));
    assert.equal((await w.call(w.boot.token, "coordinator.configure", { principalId: ada.principalId }, "api-1")).result.replayed, true);
    const got = (await w.call(w.boot.token, "coordinator.get", {})).result.item;
    assert.equal(got.state, "paused");
    assert.equal(got.hosted.agentId, ada.id);
    assert.equal((await w.call(w.boot.token, "lifecycle.status", { scope: { kind: "agent", id: ada.id } })).result.item.intent, "pause");

    // The coordinator and others cannot start or stop it; a stale revision is refused; the owner starts it.
    for (const token of [boss, ada.token]) assert.equal((await w.call(token, "coordinator.state", { to: "running", expectedRevision: got.revision }, "x2")).ok, false);
    assert.equal((await w.call(w.boot.token, "coordinator.state", { to: "running", expectedRevision: got.revision + 5 }, "api-bad")).ok, false);
    const started = await w.call(w.boot.token, "coordinator.state", { to: "running", expectedRevision: got.revision }, "api-2");
    assert.equal(started.ok, true, JSON.stringify(started));
    assert.equal((await w.ask("1")).kind, "answer");
    const paused = await w.call(w.boot.token, "coordinator.state", { to: "paused", expectedRevision: started.result.revision }, "api-3");
    assert.equal(paused.ok, true);
    assert.equal((await w.call(w.boot.token, "coordinator.get", {})).result.item.state, "paused");

    // Taken off its agent: a principal that is not an agent record, with routes.
    assert.equal((await w.call(w.boot.token, "coordinator.configure", { principalId: "agent:plain", expectedRevision: paused.result.revision }, "api-4")).ok, false, "routes are needed once it is not an agent record");
    const off = await w.call(w.boot.token, "coordinator.configure", { principalId: "agent:plain", routes: ["role/route"], expectedRevision: paused.result.revision }, "api-5");
    assert.equal(off.ok, true, JSON.stringify(off));
    const plain = (await w.call(w.boot.token, "coordinator.get", {})).result.item;
    assert.equal(plain.hosted, undefined);
    assert.equal(plain.state, "paused");
  } finally { await w.close(); }
});
