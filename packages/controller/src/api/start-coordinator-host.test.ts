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

/** The coordinator as a hosted agent (card U03c), in the running controller: set up through the chat by the agent's name, paused and stopped through the state API's own agent controls. */
test("the coordinator runs as an agent record: it is set up by name and starts paused, the agent controls (pause, stop, resume, a team's or the installation's pause) decide whether it answers, its grants are the agent's and revocable, and the controller carries on (card U03c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-host-"));
  let held: string | undefined;
  const say: Record<string, unknown[]> = {};
  const owner = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  let failing = false;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: {
      interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []),
      coordinator: {
        token: async () => held,
        routes: () => ["llama/local"],
        model: { respond: async (_route, request) => {
          if (failing) throw new Error("every route failed");
          if (request.kind === "answer") return { kind: "answer", text: "We water on Mondays because the soil dries out.", cites: [request.records[0]!.source] };
          if (request.kind === "decompose") return { tasks: [{ key: "dig", title: "Dig the bed", assignTo: { kind: "agent", id: "ann" } }] };
          return { assignments: [] };
        } },
      },
    },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [{ id: "main", location: join(d, "garden") }] })).id;
    await c.services.principals.enroll(rob, { commandId: "e-writer", kind: "agent", name: "writer", grants: [{ action: "desk.write", project }, { action: "desk.read", project }] });
    const writer = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:writer")).token);
    await c.services.desks.write(writer, { commandId: "w1", projectId: project, kind: "note", title: "Watering", body: "We water on Mondays because the soil dries out.", visibility: "shared", status: "accepted" } as never);
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const ask = async (n: string) => (await c.coordinator!.answer(rob, { commandId: `q-${n}`, projectId: project, question: "why we water on Mondays" })) as { kind: string; reason?: string };

    // An agent record, with its identity and a credential the controller holds for the coordinator. Creating an agent grants nothing.
    const made = await c.services.agents.create(rob, { commandId: "ag-ada", friendlyName: "Ada" });
    const principalId = `agent:${made.id}`;
    await c.services.agents.create(rob, { commandId: "ag-ada2", friendlyName: "Adam" });
    held = (await c.services.principals.issueCredential(rob, principalId)).token;
    assert.equal((await c.services.principals.get(principalId))!.grants.length, 0, "an agent record holds no rights");
    await turn("m0", "work on Garden", [owner("switch_focus", { projectName: "Garden" }, "work on Garden")]);

    // The owner names the agent in words; a name that fits two agents is asked about, one that fits none is refused; nothing is set up by guessing.
    const several = await turn("m1", "make Ada the coordinator on llama/local", [owner("coordinator", { action: "configure", agentName: "Ada", routes: ["llama/local"] }, "make Ada the coordinator")]);
    assert.equal(several[0]!.status, "applied", JSON.stringify(several));
    const none = await turn("m1b", "make Zed the coordinator on llama/local", [owner("coordinator", { action: "configure", agentName: "Zed", routes: ["llama/local"] }, "make Zed the coordinator")]);
    assert.equal(none[0]!.status, "refused");
    const view = (await c.coordinator!.get(rob))!;
    assert.deepEqual(view.hosted, { agentId: made.id, host: "controller" });
    assert.equal(view.principalId, principalId);
    assert.equal(view.state, "paused", "set up paused: the gate of the agent is the pause");
    assert.deepEqual(view.lifecycle!.heldBy.map((h) => h.scope), [{ kind: "agent", id: made.id }]);
    const gate = await call(boot.token, "lifecycle.status", { scope: { kind: "agent", id: made.id } });
    assert.equal(gate.result.item.intent, "pause", "the very gate every agent has");
    assert.match((await ask("0")).reason!, /paused/);

    // The coordinator is readable through the state API (owner only), with its lifecycle.
    const read = await call(boot.token, "coordinator.get", {});
    assert.equal(read.ok, true, JSON.stringify(read));
    assert.equal(read.result.item.state, "paused");
    assert.equal(read.result.item.hosted.agentId, made.id);
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    assert.notEqual((await call(ann, "coordinator.get", {})).ok, true, "an agent does not read the coordinator");

    // Start: the owner's words lift the agent's own gate.
    const started = await turn("m2", "start the coordinator", [owner("coordinator", { action: "start" }, "start the coordinator")]);
    assert.equal(started[0]!.status, "applied", JSON.stringify(started));
    assert.equal((await c.coordinator!.get(rob))!.state, "running");
    assert.equal((await call(boot.token, "lifecycle.status", { scope: { kind: "agent", id: made.id } })).result.item.intent, "active");
    assert.equal((await ask("1")).kind, "answer", "it answers from the records the owner may read, with no right of its own");

    // It never gained a right by being the coordinator: a plan it drafts is assigned by the owner's apply, not by the coordinator.
    const draft = async (n: string) => (await c.coordinator!.decompose(rob, { commandId: `d-${n}`, projectId: project, outcome: "plant beans" })) as { assignments: string };
    assert.equal((await draft("1")).assignments, "by-owner");
    // Its grants are the agent's: the owner gives and revokes them like any agent's, they are listed with the agent, and what the coordinator may do follows at once.
    const given = await call(boot.token, "grant.create", { grantee: principalId, action: "assignment.manage", project, basis: "the coordinator hands out the garden's tasks" }, "g-1");
    assert.equal(given.ok, true, JSON.stringify(given));
    assert.equal((await draft("2")).assignments, "by-coordinator", "the right the owner gave counts");
    const listed = await call(boot.token, "grant.list", { grantee: principalId });
    assert.equal(listed.result.items.length, 1, "visible like any agent's");
    const revoked = await call(boot.token, "grant.revoke", { grantId: listed.result.items[0].id, expectedRevision: listed.result.items[0].revision, reason: "enough" }, "r-1");
    assert.equal(revoked.ok, true, JSON.stringify(revoked));
    assert.equal((await draft("3")).assignments, "by-owner", "a revoked right stops counting at once");

    // The agent controls, the same as for any agent: a pause of the agent holds the coordinator at once, a resume lets it go.
    assert.equal((await call(boot.token, "lifecycle.pause", { scope: { kind: "agent", id: made.id }, reason: "quiet hours" }, "pa1")).ok, true);
    assert.equal((await ask("4")).kind, "unavailable");
    assert.equal((await c.coordinator!.get(rob))!.state, "paused");
    assert.equal((await call(boot.token, "coordinator.get", {})).result.item.lifecycle.heldBy[0].reason, "quiet hours");
    assert.equal((await call(boot.token, "lifecycle.resume", { scope: { kind: "agent", id: made.id }, reason: "back" }, "re1")).ok, true);
    assert.equal((await ask("5")).kind, "answer");
    // The coordinator itself cannot lift a pause: it has no right to control its own scope.
    await call(boot.token, "lifecycle.pause", { scope: { kind: "agent", id: made.id }, reason: "again" }, "pa2");
    const own = await c.api.handle(held!, { v: 1, op: "lifecycle.resume", commandId: "self", args: { scope: { kind: "agent", id: made.id }, reason: "let me" } } as never) as any;
    assert.equal(own.ok, false, "it cannot resume itself");
    assert.equal((await ask("6")).kind, "unavailable");

    // The whole company paused holds it too, and starting it lifts only its own gate: the owner is told what still holds it.
    await call(boot.token, "lifecycle.pause", { scope: { kind: "installation", id: "installation" }, reason: "holiday" }, "pa3");
    const rev = (await c.coordinator!.get(rob))!.revision;
    const still = await c.coordinator!.setState(rob, { commandId: "run2", expectedRevision: rev, to: "running" });
    assert.deepEqual(still.stillHeldBy, ["installation installation"]);
    const outer = await ask("7");
    assert.equal(outer.kind, "unavailable");
    assert.match(outer.reason!, /held by installation/);
    await call(boot.token, "lifecycle.resume", { scope: { kind: "installation", id: "installation" }, reason: "back" }, "re3");
    assert.equal((await ask("8")).kind, "answer");

    // Stopped through the agent's own Stop: the pause, the stop request and the stopped report are the agent's. A stopped coordinator can only be started.
    const stopped = await turn("m3", "stop the coordinator", [owner("coordinator", { action: "stop" }, "stop the coordinator")]);
    assert.equal(stopped[0]!.status, "applied", JSON.stringify(stopped));
    const after = (await c.coordinator!.get(rob))!;
    assert.equal(after.state, "stopped");
    assert.equal(after.lifecycle!.heldBy[0]!.observed, "stopped");
    assert.match((await ask("9")).reason!, /stopped/);
    const refused = await turn("m4", "pause the coordinator", [owner("coordinator", { action: "pause" }, "pause the coordinator")]);
    assert.equal(refused[0]!.status, "refused", "a stopped coordinator can only be started");
    const restarted = await turn("m5", "start the coordinator", [owner("coordinator", { action: "start" }, "start the coordinator")]);
    assert.equal(restarted[0]!.status, "applied", JSON.stringify(restarted));
    assert.equal((await ask("10")).kind, "answer");

    // The same words reach the coordinator when paused through the chat; the agent shows it.
    await turn("m6", "pause the coordinator", [owner("coordinator", { action: "pause" }, "pause the coordinator")]);
    assert.equal((await call(boot.token, "lifecycle.status", { scope: { kind: "agent", id: made.id } })).result.item.observed.state, "paused", "the coordinator reports it holds no work in flight");
    await turn("m7", "start the coordinator", [owner("coordinator", { action: "start" }, "start the coordinator")]);

    // A model whose every route fails: unavailable, not an error, and the chat and the controller carry on.
    failing = true;
    assert.equal((await ask("11")).kind, "unavailable");
    assert.ok(Array.isArray((await c.chat!.submit(boot.token, { messageId: "m8", text: "hello there" })).reply));
    assert.equal((await c.services.projects.getProject(project))?.name, "Garden");
    failing = false;

    // A retired agent cannot be the coordinator.
    const retired = await call(boot.token, "agent.retire", { agentId: made.id, expectedRevision: (await call(boot.token, "agent.get", { agentId: made.id })).result.item.revision }, "ret");
    assert.equal(retired.ok, true, JSON.stringify(retired));
    assert.match((await ask("12")).reason!, /retired/);
    assert.equal((await c.coordinator!.get(rob))!.state, "stopped");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("hosting the coordinator is checked and safe to repeat: no such or retired agent is refused, a repeated set-up does not pause a started coordinator again, a stale order touches nothing, a pause is reported reached only when no model call is in flight, and the coordinator can be taken back off its agent (card U03c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-host-"));
  let held: string | undefined;
  let release: (() => void) | undefined;
  let entered: (() => void) | undefined;
  let blockNext = false;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: {
      interpreter: new ScriptedInterpreter({}),
      coordinator: {
        token: async () => held, routes: () => ["llama/local"],
        model: { respond: async (_route, request) => {
          if (blockNext) { blockNext = false; await new Promise<void>((resolve) => { release = resolve; entered?.(); }); }
          return request.kind === "answer" ? { kind: "answer", text: "On Mondays.", cites: [request.records[0]!.source] } : {};
        } },
      },
    },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(boot.token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [{ id: "main", location: join(d, "garden") }] })).id;
    await c.services.principals.enroll(rob, { commandId: "e-writer", kind: "agent", name: "writer", grants: [{ action: "desk.write", project }, { action: "desk.read", project }] });
    const writer = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:writer")).token);
    await c.services.desks.write(writer, { commandId: "w1", projectId: project, kind: "note", title: "Watering", body: "We water on Mondays.", visibility: "shared", status: "accepted" } as never);
    const ask = async (n: string) => (await c.coordinator!.answer(rob, { commandId: `q-${n}`, projectId: project, question: "water on Mondays" })) as { kind: string; reason?: string };
    const gateOf = async (id: string) => (await call("lifecycle.status", { scope: { kind: "agent", id } })).result.item;

    // No such agent, and a retired one, cannot be hosted; the record is not made.
    await assert.rejects(c.coordinator!.configure(rob, { commandId: "c0", principalId: "agent:agt-aaaaaaaaaaaaaaaaaaaa", routes: ["r"] }), (e: unknown) => (e as { code?: string }).code === "invalid_command");
    assert.equal(await c.coordinator!.get(rob), undefined);
    const gone = await c.services.agents.create(rob, { commandId: "ag-gone", friendlyName: "Gone" });
    await c.services.agents.retire(rob, { commandId: "ag-gone-r", agentId: gone.id, expectedRevision: gone.revision } as never);
    await assert.rejects(c.coordinator!.configure(rob, { commandId: "c0b", principalId: `agent:${gone.id}`, routes: ["r"] }), (e: unknown) => (e as { code?: string }).code === "invalid_command");

    const made = await c.services.agents.create(rob, { commandId: "ag-ada", friendlyName: "Ada" });
    const principalId = `agent:${made.id}`;
    held = (await c.services.principals.issueCredential(rob, principalId)).token;
    const cfg = await c.coordinator!.configure(rob, { commandId: "c1", principalId, routes: ["llama/local"] });
    assert.equal((await gateOf(made.id)).intent, "pause");
    const started = await c.coordinator!.setState(rob, { commandId: "s1", expectedRevision: cfg.revision, to: "running" });
    assert.equal((await gateOf(made.id)).intent, "active");
    // A repeated set-up (the same command) is a replay: it does not pause the started coordinator again.
    assert.equal((await c.coordinator!.configure(rob, { commandId: "c1", principalId, routes: ["llama/local"] })).replayed, true);
    assert.equal((await gateOf(made.id)).intent, "active");
    // A stale order is refused before it touches the agent's gate.
    await assert.rejects(c.coordinator!.setState(rob, { commandId: "s2", expectedRevision: cfg.revision, to: "paused" }), (e: unknown) => (e as { code?: string }).code === "stale_revision");
    assert.equal((await gateOf(made.id)).intent, "active");
    // Changing only the routes of a hosted, running coordinator pauses nothing.
    const changed = await c.coordinator!.configure(rob, { commandId: "c2", principalId, routes: ["a", "b"], expectedRevision: started.revision });
    assert.equal((await gateOf(made.id)).intent, "active");
    assert.deepEqual((await c.coordinator!.get(rob))!.routes, ["a", "b"]);

    // A pause while a model call is in flight: held at once, reported reached only once the call has ended.
    blockNext = true;
    const inFlight = new Promise<void>((resolve) => { entered = resolve; });
    const running = ask("a");
    await inFlight;
    const paused = await c.coordinator!.setState(rob, { commandId: "s3", expectedRevision: changed.revision, to: "paused" });
    assert.equal((await ask("b")).kind, "unavailable", "a new question is not taken");
    assert.equal((await gateOf(made.id)).observed.state, "pausing");
    release!();
    assert.equal((await running).kind, "answer", "the call that had begun ends and is answered");
    assert.equal((await gateOf(made.id)).observed.state, "paused");

    // Taken back off its agent: it comes back paused, as the controller's own coordinator, and the agent's gates no longer decide.
    await c.coordinator!.setState(rob, { commandId: "s4", expectedRevision: paused.revision, to: "running" });
    const back = await c.coordinator!.configure(rob, { commandId: "c3", principalId: "agent:other", routes: ["r"], expectedRevision: (await c.coordinator!.get(rob))!.revision });
    const plain = (await c.coordinator!.get(rob))!;
    assert.equal(plain.hosted, undefined);
    assert.equal(plain.state, "paused");
    assert.ok(back.revision > paused.revision);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
