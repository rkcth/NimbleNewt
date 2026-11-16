import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { RoutingService } from "../routing/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SetupProviderService } from "../setup/index.js";
import { AdminViewService } from "./index.js";

// Card U08: the owner's reads for the settings and administration pages, on every storage backend: the value of a setting with its source and lock, the providers with the state of their secret (never the secret), the secret
// names, and the sandbox of each host. Read only and owner only.

after(stopServer);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const options = { clock: () => "2026-11-15T10:00:00.000Z", pause: async () => undefined };
const LEAK = "sk-LEAK-0123456789abcdef";

async function open(backend: Backend, body: (c: { admin: AdminViewService; owner: Principal; agent: Principal; config: ConfigurationService; agentId: string; teamId: string; projectId: string; secrets: Map<string, string>; setHosts: (h: { hostId: string; os?: string }[]) => void; providers: SetupProviderService }) => Promise<void>, local?: string): Promise<void> {
  const world = await backend.open();
  try {
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
    const routing = RoutingService.withEpoch(world.storage, projects.epoch, options);
    const config = ConfigurationService.withEpoch(world.storage, projects.epoch, { ...options, routing });
    const providers = SetupProviderService.withEpoch(world.storage, projects.epoch, options, {});
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const projectId = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
    const teamId = (await agents.createTeam(owner, { commandId: cid("tm"), name: "builders" })).id;
    const agentId = (await agents.create(owner, { commandId: cid("a"), friendlyName: "A", teamId })).id;
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
    const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
    const secrets = new Map<string, string>();
    let hosts: { hostId: string; os?: string }[] = [];
    const admin = new AdminViewService({
      configuration: config, routing: async () => { const t = await routing.get(); return t === undefined ? undefined : { providers: t.providers, routes: t.routes, revision: t.revision }; }, endpoints: () => providers.endpoints(),
      secrets: { kind: "test-store", has: async (name) => secrets.has(name) }, hosts: async () => hosts.map((h) => ({ ...h, freshness: "fresh", identity: "active" })), ...(local === undefined ? {} : { localOs: local }),
    });
    await body({ admin, owner, agent, config, agentId, teamId, projectId, secrets, setHosts: (h) => { hosts = h; }, providers });
  } finally { await world.close(); }
}

const refuses = async (code: string, run: () => Promise<unknown>): Promise<void> => { await assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, (e as Error).message); return true; }); };

for (const backend of backends) {
  test(`${backend.name}: settings are read with their value, their state (default, set, inherited, locked) and the layer they come from, for the owner only (card U08)`, async () => {
    await open(backend, async (c) => {
      // Nothing set: the defaults, each with its description and when it counts.
      const first = await c.admin.settings(c.owner);
      assert.equal(first.scope.layer, "installation");
      const maxDays = first.items.find((i) => i.key === "grants.maxDays")!;
      assert.equal(maxDays.state, "default"); assert.equal(maxDays.value, undefined); assert.equal(maxDays.editable, true); assert.match(maxDays.description, /standing grant/);
      const paid = first.items.find((i) => i.key === "budget.paidAllowed")!;
      assert.deepEqual([paid.state, paid.value, paid.kind], ["default", true, "restriction"]);
      assert.ok(first.items.some((i) => i.key === "workClass.pcFloor"));
      // The owner sets one: it is "set by you", from the installation layer.
      const staged = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", set: { "grants.maxDays": 9, "time.maxMinutes": 120 } });
      assert.ok((await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: staged.revision })).applied);
      const second = await c.admin.settings(c.owner, { prefix: "grants" });
      assert.deepEqual(second.items.map((i) => i.key).sort(), ["grants.defaultDays", "grants.maxDays"]);
      const set = second.items.find((i) => i.key === "grants.maxDays")!;
      assert.deepEqual([set.state, set.value, set.source.layer], ["set", 9, "installation"]);
      // Read as an agent sees it: the installation's value is inherited, and the team's lock shows on a narrower reading.
      const as = await c.admin.settings(c.owner, { agentId: c.agentId.replace(/^agent:/, ""), prefix: "time.maxMinutes" });
      assert.equal(as.scope.layer, "agent");
      const inherited = as.items.find((i) => i.key === "time.maxMinutes")!;
      assert.deepEqual([inherited.state, inherited.value, inherited.source.layer, inherited.editable], ["inherited", 120, "installation", false]);
      const lockStage = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: (await c.config.layer(c.owner, "installation"))!.revision, set: { "time.checkpointMinutes": 30 }, lock: ["time.checkpointMinutes"] });
      assert.ok((await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: lockStage.revision })).applied);
      const locked = (await c.admin.settings(c.owner, { prefix: "time.checkpoint" })).items[0]!;
      assert.deepEqual([locked.state, locked.value, locked.lockedBy?.layer], ["locked", 30, "installation"]);
      assert.match(locked.note ?? "", /Locked by the installation layer/);
      // A wildcard setting appears under its real name once something sets it.
      const stage2 = await c.config.stage(c.owner, { commandId: cid("st"), layer: "installation", expectedRevision: (await c.config.layer(c.owner, "installation"))!.revision, set: { "provider.acme.enabled": false } });
      assert.ok((await c.config.apply(c.owner, { commandId: cid("ap"), layer: "installation", expectedRevision: stage2.revision })).applied);
      const wild = (await c.admin.settings(c.owner, { prefix: "provider." })).items;
      assert.deepEqual(wild.map((i) => [i.key, i.value, i.state]), [["provider.acme.enabled", false, "set"]]);
      // Bounded and checked: an unknown argument, a bad prefix, an unknown agent are refused; nobody but the owner reads.
      await refuses("invalid_command", () => c.admin.settings(c.owner, { extra: 1 } as never));
      await refuses("invalid_command", () => c.admin.settings(c.owner, { prefix: "a b" }));
      await refuses("invalid_command", () => c.admin.settings(c.owner, { agentId: "not-an-agent" }));
      await refuses("forbidden", () => c.admin.settings(c.agent));
      await refuses("forbidden", () => c.admin.providers(c.agent));
      await refuses("forbidden", () => c.admin.secrets(c.agent));
      await refuses("forbidden", () => c.admin.sandbox(c.agent));
    });
  });

  test(`${backend.name}: providers show where they run, their address, the NAME of their secret and whether it is set, and never a key; the secret names are listed the same way (card U08)`, async () => {
    await open(backend, async (c) => {
      assert.deepEqual((await c.admin.providers(c.owner)).items, []);
      assert.match(JSON.stringify(await c.admin.secrets(c.owner)), /"items":\[\]/);
      await c.providers.add(c.owner, { commandId: cid("pr"), providers: [
        { name: "local-a", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["m1"], contextTokens: 32768, kind: "vllm" },
        { name: "cloud-b", location: "cloud", paid: true, endpoint: "https://api.example.test/v1", models: ["big", "small"], contextTokens: 65536, credentialName: "cloud-b-key" },
      ] });
      const got = await c.admin.providers(c.owner);
      assert.deepEqual(got.items.map((p) => p.name), ["cloud-b", "local-a"]);
      const cloud = got.items[0]!, local = got.items[1]!;
      assert.deepEqual([cloud.location, cloud.paid, cloud.enabled, cloud.endpoint, cloud.credentialName, cloud.secret], ["cloud", true, true, "https://api.example.test/v1", "cloud-b-key", "not set"]);
      assert.deepEqual(cloud.models.map((m) => [m.route, m.contextTokens]), [["cloud-b/big", 65536], ["cloud-b/small", 65536]]);
      assert.deepEqual([local.secret, local.kind, local.credentialName], ["none needed", "vllm", undefined]);
      assert.equal(got.secretsWritable, true);
      // Setting the secret changes only the state; the value is nowhere in anything read.
      c.secrets.set("cloud-b-key", LEAK);
      const after = await c.admin.providers(c.owner);
      assert.equal(after.items[0]!.secret, "set");
      const names = await c.admin.secrets(c.owner);
      assert.deepEqual(names.items, [{ name: "cloud-b-key", state: "set", usedBy: ["provider cloud-b"] }]);
      assert.deepEqual([names.writable, names.store], [true, "test-store"]);
      for (const text of [JSON.stringify(after), JSON.stringify(names), JSON.stringify(await c.admin.settings(c.owner))]) assert.doesNotMatch(text, /sk-LEAK/);
    });
  });

  test(`${backend.name}: the sandbox of each host and of this computer is named, a weaker boundary is flagged, and an unknown system is never assumed strong (card U08)`, async () => {
    await open(backend, async (c) => {
      assert.deepEqual(await c.admin.sandbox(c.owner), { hosts: [], warn: false, truncated: false });
      c.setHosts([{ hostId: "host:lin", os: "linux" }, { hostId: "host:mac", os: "darwin" }, { hostId: "host:win", os: "win32" }, { hostId: "host:odd" }]);
      const got = await c.admin.sandbox(c.owner);
      assert.deepEqual(got.hosts.map((h) => [h.hostId, h.mechanism, h.boundary, h.warn]), [["host:lin", "bubblewrap", "strong", false], ["host:mac", "Seatbelt", "weaker", true], ["host:win", "Windows Sandbox", "strong", false], ["host:odd", "unknown", "unproven", true]]);
      assert.equal(got.warn, true);
      assert.match(got.hosts[1]!.limits.join(" "), /process-level and has weaker limits than Linux/);
      c.setHosts([{ hostId: "host:lin", os: "linux" }]);
      assert.equal((await c.admin.sandbox(c.owner)).warn, false);
    });
    await open(backend, async (c) => {
      const got = await c.admin.sandbox(c.owner);
      assert.deepEqual([got.local?.mechanism, got.local?.boundary, got.warn], ["Seatbelt", "weaker", true]);
    }, "darwin");
  });
}
