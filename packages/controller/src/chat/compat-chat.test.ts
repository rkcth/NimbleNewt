import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AdminViewService, COMPAT_LIMITS, compatibility, missingOperations } from "../admin/index.js";
import type { AgentWorkInput, HostRuntimeInput } from "../admin/index.js";
import { ConfigurationService } from "../configuration/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { MigrationGuardService } from "../migration/index.js";
import { WORKER_PROTOCOL } from "../remote/protocol.js";
import { RoutingService } from "../routing/index.js";
import { SetupProviderService } from "../setup/index.js";
import { StatusService } from "../status/index.js";
import type { Migration } from "../storage/migrations.js";
import { CHAT_LIMITS } from "./interpreter.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options } from "./testing/harness.js";

// Card U08, "compatibility and migration status shows affected agents and operations": the pure rules, then the owner's read of them through the API, the chat (free words) and the same
// records on all four storage backends. Hosts and agents are fixtures (no worker connects); the migration journal is the real guard over each backend.

after(stopServer);
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const lines = (outcomes: readonly { lines?: readonly { text: string }[] }[]): string => outcomes.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
const mig = (version: number, name: string, kind?: "additive" | "destructive"): Migration => ({ version, name, statements: ["x"], ...(kind === undefined ? {} : { kind }) });
const LIST = [mig(1, "initial"), mig(2, "add_a"), mig(3, "drop_b", "destructive"), mig(4, "add_c")];

const host = (hostId: string, extra: { [K in keyof HostRuntimeInput]?: HostRuntimeInput[K] | undefined } = {}): HostRuntimeInput => {
  const base: Record<string, unknown> = { hostId, identity: "active", freshness: "fresh", os: "linux", protocol: WORKER_PROTOCOL.max, workerVersion: "w-1.2", ...extra };
  for (const k of Object.keys(base)) if (base[k] === undefined) delete base[k];
  return base as unknown as HostRuntimeInput;
};
const agents = (n: number, hostId: string, live = 0): AgentWorkInput[] => Array.from({ length: n }, (_, i) => ({ agentId: `agent:a${String(i).padStart(2, "0")}`, name: `Ann ${i}`, hostId, ...(i < live ? { attemptId: `att-${i}` } : {}) }));

test("a host speaking an older worker protocol, one turned away, one never heard from and a revoked one are told apart, with the agents and operations each touches (pure)", () => {
  const work = [...agents(12, "host:old", 2), { agentId: "agent:z1", name: "Zed", hostId: "host:new" }];
  const view = compatibility({
    node: "22.19.0", work,
    hosts: [host("host:new"), host("host:old", { protocol: 1 }), host("host:refused", { protocol: undefined, refusal: { at: "2026-11-15T10:00:00.000Z", reason: "the worker speaks protocol 3 to 4 and the controller needs 1 to 2: the controller is too old for this worker" } }), host("host:quiet", { protocol: undefined }), host("host:gone", { identity: "revoked" })],
  });
  const by = Object.fromEntries(view.hosts.map((h) => [h.hostId, h]));
  assert.deepEqual(view.hosts.map((h) => h.state), ["current", "older", "refused", "not connected", "revoked"]);
  assert.equal(view.status, "attention");
  assert.deepEqual(by["host:new"]!.agents, [], "a current host touches nothing");
  const old = by["host:old"]!;
  assert.deepEqual([old.agents.length, old.agentsMore], [COMPAT_LIMITS.agents, 2], "ten named, the rest counted");
  assert.deepEqual(old.operations, missingOperations(1));
  assert.match(old.operations.join(), /catalogue tool/);
  assert.match(old.note, /protocol 1.*1 to 2/);
  assert.match(by["host:refused"]!.note, /turned this worker away on 2026-11-15.*controller is too old/);
  assert.match(by["host:refused"]!.operations[0]!, /every attempt that would be placed/);
  assert.deepEqual([by["host:quiet"]!.agents, by["host:quiet"]!.operations], [[], []], "a host that never connected is not a finding about agents");
  assert.equal(view.runtime.node.supported, true);
  assert.deepEqual(view.runtime.protocol, { min: WORKER_PROTOCOL.min, max: WORKER_PROTOCOL.max });
  assert.equal(view.migration, undefined, "no migration source given");
  // Nothing in use is older and nothing waits: compatible. A Node.js below the floor is a finding of its own.
  const ok = compatibility({ node: "22.19.0", work, hosts: [host("host:new")], migration: { schemaVersion: 4, latestKnown: 4, migrations: LIST.map((m) => ({ version: m.version, name: m.name, kind: m.kind ?? "additive", state: "applied" })) } });
  assert.equal(ok.status, "compatible");
  assert.match(ok.migration!.note, /No migration waits/);
  assert.equal(compatibility({ node: "20.1.0", work: [], hosts: [] }).status, "attention");
  assert.equal(compatibility({ node: "20.1.0", work: [], hosts: [] }).runtime.node.supported, false);
});

test("a waiting migration lists the attempts a restart would interrupt, and what a key-like word in a note is shown as (pure)", () => {
  const live = agents(3, "host:a", 3);
  const view = compatibility({
    node: "22.19.0", work: live, hosts: [host("host:a", { workerVersion: "sk-LEAK-0123456789abcdef" })],
    migration: { schemaVersion: 1, latestKnown: 4, migrations: [{ version: 1, name: "initial", kind: "additive", state: "applied" }, { version: 2, name: "add_a", kind: "additive", state: "pending" }, { version: 3, name: "drop_b", kind: "destructive", state: "deferred" }] },
  });
  assert.equal(view.status, "attention");
  assert.equal(view.migration!.pending.length, 2);
  assert.deepEqual(view.migration!.agents.length, 3);
  assert.match(view.migration!.operations.join(), /attempt att-0 of Ann 0/);
  assert.match(view.migration!.note, /2 migrations wait.*destructive one needs your approval/);
  assert.doesNotMatch(JSON.stringify(view), /sk-LEAK/);
  // Many attempts: ten operations named, the rest counted.
  const many = compatibility({ node: "22.19.0", work: agents(25, "host:a", 25), hosts: [], migration: { schemaVersion: 1, latestKnown: 2, migrations: [{ version: 2, name: "add_a", kind: "additive", state: "pending" }] } });
  assert.deepEqual([many.migration!.agents.length, many.migration!.agentsMore, many.migration!.operations.length, many.migration!.operationsMore], [10, 15, 10, 15]);
});

test("the interpreter is told the compatibility status kind and what it answers (card U08)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "are my workers up to date?", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /compatibility\(/, "the kind is listed");
  assert.match(system, /agents and operations each finding touches is the status kind compatibility/);
});

for (const backend of backends) {
  test(`${backend.name}: compatibility and migration status is read by the owner through the API and in free words, with the affected agents and operations, and by nobody else (card U08)`, async () => {
    const script: Record<string, unknown[]> = {};
    const schema = { v: 1 };
    let hosts: HostRuntimeInput[] = [host("host:ok"), host("host:old", { protocol: 1 }), host("host:refused", { protocol: undefined, refusal: { at: "2026-11-15T10:00:00.000Z", reason: "no common protocol" } })];
    let work: AgentWorkInput[] = [...agents(12, "host:old", 2), ...agents(1, "host:ok").map((a) => ({ ...a, agentId: "agent:ok1", name: "Olive" }))];
    let statusSvc: StatusService | undefined;
    let adminSvc: AdminViewService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      const routing = RoutingService.withEpoch(storage, epoch, options);
      const configuration = ConfigurationService.withEpoch(storage, epoch, { ...options, routing });
      const providers = SetupProviderService.withEpoch(storage, epoch, options, {});
      const guard = MigrationGuardService.withEpoch(storage, epoch, { migrations: LIST, schemaVersion: async () => schema.v, snapshots: true, now: () => "2026-11-16T10:00:00.000Z" });
      const admin = new AdminViewService({
        configuration, routing: async () => undefined, endpoints: () => providers.endpoints(), hosts: async () => [],
        compat: { nodeVersion: "22.19.0", hostRuntimes: async () => hosts, agentWork: async () => work, migration: async (by) => { const m = await guard.status(by); return { schemaVersion: m.schemaVersion, latestKnown: m.latestKnown, migrations: m.migrations }; } },
      });
      const status = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts, admin }, options);
      statusSvc = status; adminSvc = admin;
      return { admin, status, migrationGuard: guard } as never;
    });
    try {
      const as = (token: string, op: string, args: Record<string, unknown>) => w.api.handle(token, { v: 1, op, args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
      const chat = w.chat({ status: statusSvc! });
      const say = async (text: string, intents: unknown[]) => { script[text] = intents; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };

      // The API read: the record the page shows.
      const got = await as(w.ownerToken, "compatibility.status", {});
      assert.equal(got.ok, true, JSON.stringify(got));
      const item = got.result.item;
      assert.equal(item.status, "attention");
      assert.deepEqual(item.hosts.map((h: { hostId: string; state: string }) => [h.hostId, h.state]), [["host:ok", "current"], ["host:old", "older"], ["host:refused", "refused"]]);
      const old = item.hosts[1];
      assert.deepEqual([old.agents.length, old.agentsMore], [10, 2]);
      assert.match(old.operations.join(), /catalogue tool/);
      // The migration part comes from the real journal of this backend: 2 waits, 3 (destructive) and 4 are held behind it.
      assert.deepEqual(item.migration.pending.map((p: { version: number; state: string }) => [p.version, p.state]), [[2, "pending"], [3, "deferred"], [4, "deferred"]]);
      assert.equal(item.migration.schemaVersion, 1);
      assert.deepEqual([item.migration.agents.length, item.migration.agentsMore, item.migration.operations.length], [2, 0, 2], "attempts running now are what a restart interrupts");
      assert.match(item.migration.operations.join(), /attempt att-0 of Ann 0/);

      // Free words: the same answer, at most the chat's line limit, with the affected agents and the operations named.
      const q = "are all my workers up to date and what would the database upgrade touch?";
      const p = await say(q, [ask({ kind: "compatibility" }, q)]);
      assert.equal(p.outcomes[0]!.status, "answered", JSON.stringify(p.outcomes));
      const text = lines(p.outcomes as never);
      assert.ok((p.outcomes[0] as any).lines.length <= CHAT_LIMITS.statusLines, "within the chat's line limit");
      assert.match(text, /Something is not current/);
      assert.match(text, /Node\.js 22\.19\.0 is running, which this version supports/);
      assert.match(text, /Host host:ok: current, protocol 2/);
      assert.match(text, /Host host:old: older, protocol 1.*Affected: Ann 0 \(agent:a00\);.* and 7 more; running a catalogue tool on the host/);
      assert.match(text, /Host host:refused: refused, worker w-1\.2\. The controller turned this worker away.*no common protocol\./);
      assert.match(text, /Database schema 1 of 4\. 3 migrations wait/);
      assert.match(text, /Migration 2 add_a \(additive\) is pending/);
      assert.match(text, /Migration 3 drop_b \(destructive\) is deferred/);
      assert.match(text, /It would touch: .*attempt att-0 of Ann 0; attempt att-1 of Ann 1/);

      // Everything current and nothing waiting reads as compatible, in the API and in words.
      hosts = [host("host:ok")]; work = []; schema.v = 4;
      const calm = (await as(w.ownerToken, "compatibility.status", {})).result.item;
      assert.deepEqual([calm.status, calm.migration.pending], ["compatible", []]);
      const q2 = "is everything compatible now?";
      assert.match(lines((await say(q2, [ask({ kind: "compatibility" }, q2)])).outcomes as never), /Everything in use is a runtime this version supports, and no migration waits\./);

      // Owner only and bounded: an agent is refused, an unknown field is refused, the answer holds no secret.
      const ann = await w.agent("ann", [{ action: "*", project: "*" }]);
      assert.equal((await as(ann.token, "compatibility.status", {})).error?.code, "forbidden");
      await assert.rejects(adminSvc!.compatibility(ann.principal), (e: { code?: string }) => e.code === "forbidden", "the service itself refuses a principal that is not the owner");
      assert.equal((await as(w.ownerToken, "compatibility.status", { x: 1 })).error?.code, "invalid_command");
      const forAgent = await w.api.handle(ann.token, { v: 1, op: "status.ask", args: { request: { kind: "compatibility" } } } as never) as any;
      assert.doesNotMatch(JSON.stringify(forAgent), /host:old|host:refused/, "an agent is told nothing about the hosts");
    } finally { await w.close(); }
  });
}
