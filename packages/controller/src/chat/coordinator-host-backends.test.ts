import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PauseService, StopService, type StopPorts } from "../lifecycle/index.js";
import { GrantService } from "../security/index.js";
import { agentLifecycle } from "./coordinator-host.js";
import { CoordinatorService, type CoordinatorModel, type CoordinatorRequest } from "./coordinator.js";
import { cid, openWorld, options } from "./testing/harness.js";

after(stopServer);

const ports = { unsupported: () => undefined, release: async () => undefined, inventory: async () => [], cleanup: async () => ({ remaining: [] }), checkpoint: async () => ({ checkpointId: "cp", durable: true, artifactsDurable: true }), terminate: async () => ({ ended: true, unresolved: [] }) } as unknown as StopPorts;

/**
 * Card U03c, on every storage backend: the coordinator as an agent record is held by the agent's own controls (pause gate of its agent, its team and the installation; a Stop of its scope) and by nothing else, its
 * grants are the agent's and a revoked one stops counting, and the controller carries on whatever state it is in. The composed controller test (`api/start-coordinator-host.test.ts`) shows the same through the running
 * controller on SQLite; this one drives the real services on each backend, where the gate, stop and coordinator records are stored.
 */
for (const backend of backends) {
  test(`${backend.name}: a coordinator that is an agent record is paused, stopped, resumed and started again through the agent's own controls; its grants are the agent's; the controller carries on (card U03c)`, async () => {
    const w = await openWorld(backend);
    try {
      const pauses = PauseService.withEpoch(w.world.storage, w.projects.epoch, {}, options);
      const stops = StopService.withEpoch(w.world.storage, w.projects.epoch, pauses, ports, options);
      const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      let failing = false;
      const model: CoordinatorModel & { calls: number } = { calls: 0, respond: async (_route: string, r: CoordinatorRequest) => {
        model.calls += 1;
        if (failing) throw new Error("every route failed");
        if (r.kind === "answer") return { kind: "answer", text: "We water on Mondays.", cites: [r.records[0]!.source] };
        if (r.kind === "decompose") return { tasks: [{ key: "dig", title: "Dig the bed", assignTo: { kind: "agent", id: "ann" } }] };
        return { assignments: [] };
      } };

      // An agent record: its own identity, no right and no credential until the owner issues one for the controller to hold.
      const made = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ada" });
      const principalId = `agent:${made.id}`;
      const token = (await w.principals.issueCredential(w.owner, principalId)).token;
      assert.equal((await w.principals.get(principalId))!.grants.length, 0, "an agent record holds no right by being made");
      const service = CoordinatorService.withEpoch(w.world.storage, w.projects.epoch, {
        chat: w.chat(), retrieval: w.retrieval, inquiries: w.inquiries, projects: w.projects, assignments: w.assignments, api: w.api, token: async () => token, model,
        routes: () => ["local/route"], principal: () => w.principals.authenticate(token), lifecycle: agentLifecycle({ agents: w.agents, pauses, stops }),
      }, options);

      const p = await w.project("Garden");
      const writer = await w.agent(`writer-${cid("n")}`, [{ action: "desk.write", project: p }, { action: "desk.read", project: p }]);
      await w.desks.write(writer.principal, { commandId: cid("w"), projectId: p, kind: "note", title: "Watering", body: "We water on Mondays because the soil dries out.", visibility: "shared", status: "accepted" } as never);
      const ask = async () => (await service.answer(w.owner, { commandId: cid("q"), projectId: p, question: "why we water on Mondays" })) as { kind: string; reason?: string };
      const draft = async () => (await service.decompose(w.owner, { commandId: cid("d"), projectId: p, outcome: "plant beans" })) as { assignments: string };
      const gateOf = async () => pauses.gate(w.owner, { kind: "agent", id: made.id });

      // Set up: it is hosted by the agent and starts paused through the agent's own gate (the very gate every agent has).
      const set = await service.configure(w.owner, { commandId: cid("cfg"), principalId, routes: ["local/route"] });
      let view = (await service.get(w.owner))!;
      assert.deepEqual(view.hosted, { agentId: made.id, host: "controller" });
      assert.equal(view.state, "paused");
      assert.equal((await gateOf())?.intent, "pause");
      assert.deepEqual((await ask()).kind, "unavailable");
      const calls0 = model.calls;
      assert.equal(calls0, 0, "a paused coordinator calls no model");

      // Started: the agent's gate is lifted, and it answers from the records.
      await service.setState(w.owner, { commandId: cid("st"), expectedRevision: set.revision, to: "running" });
      assert.equal((await gateOf())?.intent, "active");
      assert.equal((await service.get(w.owner))!.state, "running");
      assert.equal((await ask()).kind, "answer");

      // Its grants are the agent's: the owner gives one and takes it back like any agent's; it counts at once and stops counting at once.
      assert.equal((await draft()).assignments, "by-owner");
      const given = await grants.grant(w.owner, { commandId: cid("g"), grantee: principalId, action: "assignment.manage", project: p, source: "direct", basis: "the coordinator hands out the garden's tasks" });
      assert.equal((await draft()).assignments, "by-coordinator");
      const listed = await grants.list(w.owner, { grantee: principalId });
      assert.deepEqual(listed.items.map((g) => g.id), [given.id], "visible like any agent's");
      await grants.revoke(w.owner, { commandId: cid("r"), grantId: given.id, expectedRevision: listed.items[0]!.revision, reason: "enough" });
      assert.equal((await draft()).assignments, "by-owner");

      // The agent controls, used directly and not through the coordinator: a pause of the agent holds it, a resume lets it go.
      await pauses.pause(w.owner, { commandId: cid("pa"), scope: { kind: "agent", id: made.id }, reason: "quiet hours" });
      const before = model.calls;
      const held = await ask();
      assert.equal(held.kind, "unavailable");
      assert.equal(model.calls, before, "no model call while the agent is paused");
      assert.equal((await service.get(w.owner))!.state, "paused");
      await pauses.resume(w.owner, { commandId: cid("re"), scope: { kind: "agent", id: made.id }, reason: "back" });
      assert.equal((await ask()).kind, "answer");

      // Its agent's team holds it too, and so does the whole installation (a gate above the agent); resuming the agent's own gate does not lift those.
      const team = await w.agents.createTeam(w.owner, { commandId: cid("tm"), name: "planners" });
      const rec = (await w.agents.get(w.owner, made.id))!;
      await w.agents.update(w.owner, { commandId: cid("up"), agentId: made.id, expectedRevision: rec.revision, teamId: team.id });
      await pauses.pause(w.owner, { commandId: cid("pt"), scope: { kind: "team", id: team.id }, reason: "team break" });
      assert.equal((await ask()).kind, "unavailable");
      await pauses.resume(w.owner, { commandId: cid("rt"), scope: { kind: "team", id: team.id }, reason: "team back" });
      await pauses.pause(w.owner, { commandId: cid("pi"), scope: { kind: "installation", id: "installation" }, reason: "holiday" });
      assert.equal((await ask()).kind, "unavailable");
      assert.match((await ask()).reason!, /installation/);
      await pauses.resume(w.owner, { commandId: cid("ri"), scope: { kind: "installation", id: "installation" }, reason: "back" });
      assert.equal((await ask()).kind, "answer");

      // A Stop of the agent's scope through the agent controls: the coordinator is stopped, and only a start (the agent resumed) brings it back.
      const asked = await stops.request(w.owner, { commandId: cid("sr"), scope: { kind: "agent", id: made.id }, mode: "stop", reason: "retire the planner for now" });
      await stops.advance(w.owner, { intentId: asked.intentId });
      assert.equal((await service.get(w.owner))!.state, "stopped");
      assert.match((await ask()).reason!, /stopped/);
      await assert.rejects(service.setState(w.owner, { commandId: cid("sp"), expectedRevision: (await service.get(w.owner))!.revision, to: "paused" }), (e: unknown) => (e as { code?: string }).code === "invalid_command");
      await service.setState(w.owner, { commandId: cid("sa"), expectedRevision: (await service.get(w.owner))!.revision, to: "running" });
      assert.equal((await ask()).kind, "answer");

      // The coordinator's own state words (pause, then stop) use the same gates.
      await service.setState(w.owner, { commandId: cid("pz"), expectedRevision: (await service.get(w.owner))!.revision, to: "paused" });
      assert.equal((await gateOf())?.intent, "pause");
      assert.equal((await ask()).kind, "unavailable");
      await service.setState(w.owner, { commandId: cid("sz"), expectedRevision: (await service.get(w.owner))!.revision, to: "running" });

      // A model whose every route fails: unavailable, not an error, and the rest of the controller carries on.
      failing = true;
      assert.equal((await ask()).kind, "unavailable");
      const created = await w.projects.createTask({ commandId: cid("t"), actor: w.owner.id, projectId: p, title: "direct" });
      assert.ok(created.id, "the controller creates tasks without the coordinator");
      failing = false;

      // A retired agent cannot hold the coordinator any more: it reads as stopped and answers nothing.
      const now = (await w.agents.get(w.owner, made.id))!;
      await w.agents.retire(w.owner, { commandId: cid("rt"), agentId: made.id, expectedRevision: now.revision });
      assert.match((await ask()).reason!, /retired/);
      assert.equal((await service.get(w.owner))!.state, "stopped");
      view = (await service.get(w.owner))!;
      assert.equal(view.hosted?.agentId, made.id);
    } finally { await w.close(); }
  });
}
