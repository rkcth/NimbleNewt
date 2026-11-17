import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PolicyService } from "../policy/index.js";
import { RoutingService } from "../routing/index.js";
import { GrantService, PrincipalService } from "../security/index.js";
import { SetupProviderService, SetupReadinessService } from "../setup/index.js";
import { MemoryStorage } from "../storage/memory.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import { startTestServer, withClient, type TestServer } from "../storage/postgres/testing/server.js";
import { SqliteStorage, SqliteWorkerStorage } from "../storage/sqlite/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { AdminViewService } from "./index.js";

// Card U08: "settings persist across restart". What the owner set on the Administration pages (a setting, the approval profile, the model providers, an agent) is read back after the controller is stopped and
// started again on the same database, with its source, its history and its actor. A restart here is a new set of services over the same database, reopened (the reference store keeps its one in-memory
// store, as it is all it has). The full controller restart is in web/admin-acceptance.test.ts. All four storage backends.

let serverPromise: Promise<TestServer> | undefined;
const server = (): Promise<TestServer> => (serverPromise ??= startTestServer());
after(async () => { await stopServer(); if (serverPromise !== undefined) await (await serverPromise).stop(); });

interface Rig { readonly name: string; setup(): Promise<{ open(): Promise<ControllerStorage>; /** Stops the process using this storage (the stop before a restart); the reference store has only its one in-memory store, which stays. */ stop(s: ControllerStorage): Promise<void>; done(): Promise<void> }> }
const rigs: Rig[] = [
  { name: "reference store", async setup() { const m = new MemoryStorage(); return { open: async () => m, stop: async () => undefined, done: () => m.close() }; } },
  { name: "SQLite", async setup() { const dir = mkdtempSync(join(tmpdir(), "nn-u08p-")); const path = join(dir, "c.sqlite"); return { open: () => SqliteStorage.open({ path }), stop: (x) => x.close(), done: async () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  { name: "SQLite on a worker thread", async setup() { const dir = mkdtempSync(join(tmpdir(), "nn-u08p-")); const path = join(dir, "c.sqlite"); return { open: () => SqliteWorkerStorage.open({ path }), stop: (x) => x.close(), done: async () => rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }) }; } },
  { name: "PostgreSQL", async setup() {
    const s = await server(); const schema = `u08p_${process.pid}_${Math.random().toString(36).slice(2, 8)}`;
    return { open: () => PostgresStorage.open({ connectionString: s.url(), schema, maxConnections: 2 }), stop: (x) => x.close(), done: async () => { await withClient(s.url(), async (c) => { await c.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }); } };
  } },
];
const names = new Set(backends.map((b) => b.name));
let n = 0;
const cid = (l: string): string => `${l}-${n++}`;
const options = { clock: () => "2026-11-16T10:00:00.000Z", pause: async () => undefined };

for (const rig of rigs.filter((r) => names.has(r.name))) {
  test(`${rig.name}: a setting, the approval profile, the providers and an agent set on the Administration pages are read back unchanged after a restart, with their source and who set them (card U08)`, async () => {
    const r = await rig.setup();
    try {
      // ---- first run: configure --------------------------------------------------------------------------------------------------------------------
      let storage = await r.open();
      let token: string;
      {
        const projects = await ProjectService.open(storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(storage, projects.epoch, options);
        token = (await principals.bootstrapOwner({ name: "rob" })).token;
        const owner = await principals.authenticate(token);
        const routing = RoutingService.withEpoch(storage, projects.epoch, options);
        const config = ConfigurationService.withEpoch(storage, projects.epoch, { ...options, routing });
        const grants = GrantService.withEpoch(storage, projects.epoch, options);
        const policy = PolicyService.withEpoch(storage, projects.epoch, grants, options);
        await config.change(owner, { commandId: cid("c"), layer: "installation", set: { "grants.maxDays": 12, "time.maxMinutes": 90 } });
        await policy.set(owner, { commandId: cid("pol"), scope: "installation", profile: "derived" });
        await SetupProviderService.withEpoch(storage, projects.epoch, options, {}).add(owner, { commandId: cid("pr"), providers: [
          { name: "local-a", location: "local", endpoint: "http://127.0.0.1:8002/v1", models: ["m1"], contextTokens: 32768 },
          { name: "cloud-b", location: "cloud", paid: true, endpoint: "https://api.example.test/v1", models: ["big"], contextTokens: 65536, credentialName: "cloud-b-key" },
        ] });
        const agentSvc = AgentService.withEpoch(storage, projects.epoch, options);
        await agentSvc.seedStandardRoles();
        await agentSvc.create(owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["author"] });
        await r.stop(storage);
      }
      // ---- the restart: the same database, new services -----------------------------------------------------------------------------------------
      storage = await r.open();
      try {
        const projects = await ProjectService.open(storage, { holder: "c2", ...options });
        const principals = PrincipalService.withEpoch(storage, projects.epoch, options);
        const owner = await principals.authenticate(token);
        const routing = RoutingService.withEpoch(storage, projects.epoch, options);
        const config = ConfigurationService.withEpoch(storage, projects.epoch, { ...options, routing });
        const providers = SetupProviderService.withEpoch(storage, projects.epoch, options, {});
        const admin = new AdminViewService({ configuration: config, routing: async () => { const t = await routing.get(); return t === undefined ? undefined : { providers: t.providers, routes: t.routes, revision: t.revision }; }, endpoints: () => providers.endpoints(), hosts: async () => [], secrets: { has: async () => false } });
        const seen = await admin.settings(owner, { prefix: "" });
        const by = Object.fromEntries(seen.items.map((i) => [i.key, i]));
        assert.deepEqual([by["grants.maxDays"]!.value, by["grants.maxDays"]!.state, by["grants.maxDays"]!.source.layer], [12, "set", "installation"]);
        assert.deepEqual([by["time.maxMinutes"]!.value, by["time.maxMinutes"]!.state], [90, "set"]);
        assert.equal(by["grants.defaultDays"]!.state, "default", "what was not set is still the default");
        const history = (await config.layer(owner, "installation"))!.history;
        assert.deepEqual([history.length, history[0]!.by, Object.keys(history[0]!.effects).sort()], [1, "owner:rob", ["grants.maxDays", "time.maxMinutes"]]);
        const grants = GrantService.withEpoch(storage, projects.epoch, options);
        const policy = PolicyService.withEpoch(storage, projects.epoch, grants, options);
        assert.deepEqual([(await policy.effective(owner))!.profile, (await policy.get(owner, "installation"))!.history.map((h) => h.summary)], ["derived", ["profile derived"]]);
        const prov = await admin.providers(owner);
        assert.deepEqual(prov.items.map((p) => [p.name, p.location, p.enabled, p.paid, p.endpoint, p.credentialName, p.secret]), [
          ["cloud-b", "cloud", true, true, "https://api.example.test/v1", "cloud-b-key", "not set"],
          ["local-a", "local", true, false, "http://127.0.0.1:8002/v1", undefined, "none needed"]]);
        assert.deepEqual(prov.items.find((p) => p.name === "cloud-b")!.models, [{ route: "cloud-b/big", contextTokens: 65536 }]);
        assert.deepEqual((await AgentService.withEpoch(storage, projects.epoch, options).list(owner, { state: "active" })).items.map((a) => [a.friendlyName, a.roles]), [["Ann", ["author"]]]);
        const ready = (await SetupReadinessService.withEpoch(storage, projects.epoch).check(owner)).items;
        assert.deepEqual([ready.find((i) => i.id === "profile")!.state, ready.find((i) => i.id === "model-route")!.state, ready.find((i) => i.id === "agent")!.state], ["done", "done", "done"]);
      } finally { await r.stop(storage).catch(() => undefined); }
    } finally { await r.done(); }
  });
}
