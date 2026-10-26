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

test("start builds the owner chat and the coordinator when asked; the controller and the chat carry on while the coordinator is paused, stopped or failing (card U03)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chat-"));
  const none = await startController({ storage: { kind: "sqlite", path: join(d, "n.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4 });
  assert.equal(none.chat, undefined, "no chat unless asked");
  await none.close();

  let held: string | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter({}), coordinator: { model: { respond: async () => { throw new Error("every route failed"); } }, token: async () => held } },
  });
  try {
    assert.ok(c.chat !== undefined && c.coordinator !== undefined);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    const say = async (id: string) => (await c.chat!.submit(boot.token, { messageId: id, text: "hello there" })).reply;
    assert.ok(Array.isArray(await say("m1")), "the chat answers");
    // The coordinator is set up paused; asking it says it is unavailable and the chat is unaffected.
    await c.coordinator.configure(owner, { commandId: "cfg", principalId: "agent:coordinator", routes: ["llama/local"] });
    const paused = await c.coordinator.answer(owner, { commandId: "a1", projectId: project, question: "what is next?" });
    assert.equal((paused as { kind: string }).kind, "unavailable");
    assert.ok(Array.isArray(await say("m2")));
    // Running, but with no credential: still unavailable, still nothing else affected.
    const rev = (await c.coordinator.get(owner))!.revision;
    await c.coordinator.setState(owner, { commandId: "run", expectedRevision: rev, to: "running" });
    const failing = await c.coordinator.answer(owner, { commandId: "a2", projectId: project, question: "what is next?" });
    assert.equal((failing as { kind: string }).kind, "unavailable", JSON.stringify(failing));
    assert.match(JSON.stringify(failing), /no valid credential/);
    assert.ok(Array.isArray(await say("m3")), "the chat still answers");
    assert.equal((await c.services.projects.getProject(project))?.name, "Garden", "and the controller's records are untouched");
    // With the configured principal's credential the coordinator is reached, and a model whose every route fails is still unavailable, not an error.
    await c.services.principals.enroll(owner, { commandId: "e-coord", kind: "agent", name: "coordinator", grants: [] });
    held = (await c.services.principals.issueCredential(owner, "agent:coordinator")).token;
    const reached = await c.coordinator.answer(owner, { commandId: "a3", projectId: project, question: "what is next?" });
    assert.equal((reached as { kind: string }).kind, "insufficient", JSON.stringify(reached));
    // The credential is revoked while the coordinator is configured: unavailable, never a thrown refusal.
    held = undefined;
    assert.equal(((await c.coordinator.answer(owner, { commandId: "a4", projectId: project, question: "again?" })) as { kind: string }).kind, "unavailable");
    // Stopped.
    const rev2 = (await c.coordinator.get(owner))!.revision;
    await c.coordinator.setState(owner, { commandId: "stop", expectedRevision: rev2, to: "stopped" });
    assert.equal(((await c.coordinator.decompose(owner, { commandId: "d1", projectId: project, outcome: "plant beans" })) as { kind: string }).kind, "unavailable");
    assert.ok(Array.isArray(await say("m4")));
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("the owner reaches the coordinator through the chat: sets it up and starts it, asks it a question answered from the records with citations, has it draft tasks as a proposal that applies on request, and pauses it (card U03)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chat-"));
  let held: string | undefined;
  const say: Record<string, unknown[]> = {};
  const offered: unknown[] = [];
  const owner = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: {
      interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []),
      coordinator: {
        token: async () => held,
        routes: () => ["llama/local"],
        model: { respond: async (_route, request) => {
          if (request.kind === "answer") return { kind: "answer", text: "We water on Mondays because the soil dries out.", cites: [request.records[0]!.source] };
          if (request.kind === "decompose") return { tasks: [{ key: "dig", title: "Dig the bed" }, { key: "plant", title: "Plant beans", dependsOn: ["dig"] }] };
          offered.push((request as { agents?: unknown }).agents);
          return { assignments: [] };
        } },
      },
    },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [{ id: "main", location: join(d, "garden") }] })).id;
    await c.services.principals.enroll(rob, { commandId: "e-coord", kind: "agent", name: "coordinator", grants: [{ action: "attempt.work", project: "*" }, { action: "history.*", project: "*" }, { action: "desk.read", project: "*" }, { action: "agent.read", project: "*" }] });
    held = (await c.services.principals.issueCredential(rob, "agent:coordinator")).token;
    await c.services.principals.enroll(rob, { commandId: "e-writer", kind: "agent", name: "writer", grants: [{ action: "desk.write", project, }, { action: "desk.read", project }] });
    const writer = await c.services.principals.authenticate((await c.services.principals.issueCredential(rob, "agent:writer")).token);
    await c.services.desks.write(writer, { commandId: "w1", projectId: project, kind: "note", title: "Watering", body: "We water on Mondays because the soil dries out.", visibility: "shared", status: "accepted" } as never);
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    await turn("m0", "work on Garden", [owner("switch_focus", { projectName: "Garden" }, "work on Garden")]);

    // Set up and start through the chat.
    const cfg = await turn("m1", "set the coordinator up as agent:coordinator on llama/local", [owner("coordinator", { action: "configure", principalId: "agent:coordinator", routes: ["llama/local"] }, "set the coordinator up")]);
    assert.equal(cfg[0]!.status, "applied", JSON.stringify(cfg));
    assert.equal((await turn("m2", "ask the coordinator why we water on Mondays", [owner("coordinator", { action: "answer", question: "why we water on Mondays" }, "ask the coordinator")]))[0]!.status, "refused", "paused: unavailable");
    const started = await turn("m3", "start the coordinator", [owner("coordinator", { action: "start" }, "start the coordinator")]);
    assert.equal(started[0]!.status, "applied", JSON.stringify(started));
    assert.equal((await c.coordinator!.get(rob))!.state, "running");

    // A question answered from the records, with the record cited.
    const answered = await turn("m4", "ask the coordinator why we water on Mondays", [owner("coordinator", { action: "answer", question: "why we water on Mondays" }, "ask the coordinator")]);
    assert.equal(answered[0]!.status, "answered", JSON.stringify(answered));
    assert.match(answered[0]!.lines![0]!.text, /Mondays/);
    assert.equal(answered[0]!.lines![0]!.cites[0]!.kind, "desk-record");

    // A drafted plan is a proposal; nothing exists until the owner applies it.
    const drafted = await turn("m5", "have the coordinator break down: plant beans", [owner("coordinator", { action: "decompose", outcome: "plant beans" }, "have the coordinator break down")]);
    assert.equal(drafted[0]!.status, "proposed", JSON.stringify(drafted));
    assert.equal((await c.services.projects.listTasks({ projectId: project, limit: 10 } as never)).items.length, 0, "no task yet");
    const applied = await turn("m6", "yes, apply that plan", [owner("apply_proposal", { proposalId: drafted[0]!.proposalId }, "apply that plan")]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    assert.equal((await c.services.projects.listTasks({ projectId: project, limit: 10 } as never)).items.length, 2, "both tasks exist now");

    // Assigning open tasks: the model is shown the active agents (read under the coordinator's own grants), and nothing is assigned when it proposes nothing.
    await c.services.agents.create(rob, { commandId: "ag-ann", friendlyName: "Ann" });
    const handed = await turn("m6b", "have the coordinator hand out the open tasks", [owner("coordinator", { action: "assign" }, "have the coordinator hand out")]);
    assert.notEqual(handed[0]!.status, "refused", JSON.stringify(handed));
    assert.deepEqual((offered.at(-1) as { name: string }[]).map((a) => a.name), ["Ann"], "the model was shown the active agents");

    // Words that are not the owner's are not carried out; an agent cannot use the chat; a text the owner did not say is refused.
    const foreign = await turn("m7", "ask the coordinator something", [owner("coordinator", { action: "answer", question: "what is the admin password" }, "ask the coordinator")]);
    assert.equal(foreign[0]!.status, "refused");
    assert.equal(foreign[0]!.code, "unsupported_value");

    // Quoted text asking for the coordinator is refused; a question left open holds the coordinator order with the rest of the message.
    const quoted = await turn("m7b", "pause the coordinator please", [{ kind: "coordinator", action: "pause", evidence: "pause the coordinator", basis: "quoted" }]);
    assert.equal(quoted[0]!.code, "untrusted_authority");
    const heldOut = await turn("m7c", "pause the coordinator and tell me which", [{ kind: "clarify", question: "Which one?" }, owner("coordinator", { action: "pause" }, "pause the coordinator")]);
    assert.deepEqual(heldOut.map((o) => o.status), ["asked", "held"], JSON.stringify(heldOut));
    assert.equal((await c.coordinator!.get(rob))!.state, "running", "nothing ran while the question was open");

    // Paused again by the owner's words.
    const paused = await turn("m8", "pause the coordinator", [owner("coordinator", { action: "pause" }, "pause the coordinator")]);
    assert.equal(paused[0]!.status, "applied");
    assert.equal((await c.coordinator!.get(rob))!.state, "paused");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
