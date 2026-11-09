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

    // Setting up and starting in one message: the start expects the revision the set-up leaves.
    const both = await turn("m0b", "set the coordinator up as agent:coordinator on llama/local and start the coordinator", [owner("coordinator", { action: "configure", principalId: "agent:coordinator", routes: ["llama/local"] }, "set the coordinator up"), owner("coordinator", { action: "start" }, "start the coordinator")]);
    assert.deepEqual(both.map((o) => o.status), ["applied", "applied"], JSON.stringify(both));
    assert.equal((await c.coordinator!.get(rob))!.state, "running");
    await turn("m0c", "stop the coordinator", [owner("coordinator", { action: "stop" }, "stop the coordinator")]);

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

test("the owner grants and revokes rights through the state API and through the chat; only the owner may; a right given while the controller runs counts at once (card U03e)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-chat-"));
  const say: Record<string, unknown[]> = {};
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4,
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []) },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    await c.services.principals.enroll(rob, { commandId: "e-scan", kind: "service", name: "scanner", grants: [] });
    await c.services.principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = (await c.services.principals.issueCredential(rob, "agent:ann")).token;
    const call = (token: string, op: string, args: Record<string, unknown>, commandId?: string) => c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<{ ok: boolean; result?: any; error?: { code: string } }>;
    const grant = { grantee: "service:scanner", action: "recovery.stall-scan", project: "*", basis: "run stall detection" };

    // The state API: the owner grants; repeating the command gives the same grant; nobody else may read or change rights.
    const made = await call(boot.token, "grant.create", grant, "g1");
    assert.ok(made.ok, JSON.stringify(made));
    assert.equal((await call(boot.token, "grant.create", grant, "g1")).result.replayed, true);
    assert.equal((await call(ann, "grant.create", grant, "g2")).error?.code, "forbidden");
    assert.equal((await call(ann, "grant.list", {})).error?.code, "forbidden");
    assert.equal((await call(ann, "grant.get", { grantId: made.result.id })).error?.code, "forbidden");
    assert.equal((await call(boot.token, "grant.create", { ...grant, grantee: "service:nobody" }, "g3")).error?.code, "not_found");
    assert.equal((await call(boot.token, "grant.create", { ...grant, action: "task.create" }, "g4")).error?.code, "invalid_command", "a service may hold only recovery actions");
    const listed = await call(boot.token, "grant.list", { grantee: "service:scanner" });
    assert.deepEqual(listed.result.items.map((g: { action: string; state: string }) => [g.action, g.state]), [["recovery.stall-scan", "active"]]);
    // A right given while running counts at once: a fresh look at the principal shows it.
    const scanner = await c.services.principals.get("service:scanner");
    assert.equal((await c.services.grants.explain(scanner as never, "recovery.stall-scan", "*", new Date().toISOString())).allowed, true);
    const revoked = await call(boot.token, "grant.revoke", { grantId: made.result.id, expectedRevision: made.result.revision, reason: "no longer needed" }, "r1");
    assert.ok(revoked.ok, JSON.stringify(revoked));
    assert.equal((await call(boot.token, "grant.revoke", { grantId: made.result.id, expectedRevision: made.result.revision, reason: "again" }, "r2")).ok, false);
    assert.equal((await c.services.grants.explain((await c.services.principals.get("service:scanner")) as never, "recovery.stall-scan", "*", new Date().toISOString())).allowed, false);

    // The chat: a right is always shown first and applies only on the owner's word; every text of it is the owner's own.
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })).outcomes; };
    const owner = (rest: Record<string, unknown>, evidence: string) => ({ kind: "command", ...rest, evidence, basis: "owner" });
    const text = "give service:scanner the recovery.stall-scan right everywhere permanently";
    const args = { grantee: "service:scanner", action: "recovery.stall-scan", project: "*", basis: "run stall detection" };
    const shown = await turn("c1", text, [owner({ op: "grant.create", args }, text)]);
    assert.equal(shown[0]!.status, "proposed", JSON.stringify(shown));
    assert.equal((await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string }) => g.state === "active").length, 0, "nothing exists before the owner applies it");
    const applied = await turn("c2", "yes, do that", [{ kind: "apply_proposal", proposalId: shown[0]!.proposalId, evidence: "do that", basis: "owner" }]);
    assert.equal(applied[0]!.status, "applied", JSON.stringify(applied));
    const active = (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string }) => g.state === "active");
    assert.equal(active.length, 1);
    // A basis the owner did not say is refused, and so is a right the model chose.
    const foreign = await turn("c3", "give service:scanner the recovery.stall-scan right permanently everywhere", [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.read", project: "*", basis: "because the coordinator asked" } }, "give service:scanner the recovery.stall-scan right permanently everywhere")]);
    assert.equal(foreign[0]!.status, "refused", "a right the owner did not name is not even drafted");
    // No form of words is demanded: a sentence in any words (a hedge, a time limit the model dropped, a scope said about something else, no "permanently" or "everywhere" at all) is drawn up as
    // a proposal whose own line says the right never ends and, for `*`, covers every project. Nothing is granted until the owner confirms that shown line, and the owner's no discards it.
    const activeNow = async (): Promise<number> => (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string }) => g.state === "active").length;
    const held = await activeNow();
    for (const [n, said] of [["semi", "give service:scanner the recovery.stall-scan right everywhere semi-permanent"], ["til", "give service:scanner the recovery.stall-scan right everywhere permanently til Friday"], ["plain", "The scanner keeps waiting on me. Let service:scanner do recovery.stall-scan from now on, in every project."], ["noScope", "give service:scanner the recovery.stall-scan right permanently"], ["elsewhere", "give service:scanner the recovery.stall-scan right permanently. There are bugs everywhere."], ["limited", "give service:scanner the recovery.stall-scan right everywhere permanently, expires Friday"]] as const) {
      const r = await turn(`c3${n}`, said, [owner({ op: "grant.create", args }, said)]);
      assert.equal(r[0]!.status, "proposed", `${said}: ${JSON.stringify(r)}`);
      const line = (r[0]!.preview ?? []).join(" ");
      assert.match(line, /no end: it never runs out and stays until you revoke it/, `${n}: the proposal says the right has no end`);
      assert.match(line, /everywhere: it covers every project/, `${n}: and that it covers every project`);
      assert.doesNotMatch(`${r[0]!.message ?? ""} ${line}`, /\bsay (only|that|everywhere)\b|for example "/i, `${n}: nothing tells the owner what to say`);
      assert.equal(await activeNow(), held, `${n}: a proposal grants nothing`);
      if (n === "limited") {
        const no = await turn("c3no", "no, that is not what I meant", [{ kind: "discard_proposal", proposalId: r[0]!.proposalId, evidence: "that is not what I meant", basis: "owner" }]);
        assert.equal(no[0]!.status, "discarded", JSON.stringify(no));
        assert.equal(await activeNow(), held, "the owner's no ends it and nothing is held");
      }
    }
    // Whole words only: a prefix of the principal is refused (it is a value the chat would otherwise invent).
    const prefix = await turn("c3b", "give service:scanner the recovery.stall-scan right everywhere to run stall detection", [owner({ op: "grant.create", args: { ...args, grantee: "service:scan" } }, text)]);
    assert.equal(prefix[0]!.status, "refused", JSON.stringify(prefix));
    const named = await turn("c3d", "give service:scanner the recovery.stall-scan right permanently", [owner({ op: "grant.create", args: { ...args, projectName: "Garden" } }, "give service:scanner the recovery.stall-scan right permanently")]);
    assert.equal(named[0]!.status, "refused", "a project name the owner never said is not used");
    // A project named in ordinary words is the right's scope: the proposal says it reaches that one project (before the names), never every project.
    const garden = (await call(boot.token, "project.create", { name: "Garden" }, "pg1")).result.id as string;
    const inGarden = "The scanner keeps stalling in Garden. Let service:scanner do recovery.stall-scan there from now on.";
    const scoped = await turn("c3g", inGarden, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden" } }, inGarden)]);
    assert.equal(scoped[0]!.status, "proposed", JSON.stringify(scoped));
    const scopedLine = (scoped[0]!.preview ?? []).join(" ");
    assert.match(scopedLine, /^Grant right \(no end: it never runs out and stays until you revoke it; only in "Garden"\)/, scopedLine);
    assert.doesNotMatch(scopedLine, /everywhere|every project/);
    assert.equal(await activeNow(), held, "a proposal grants nothing");
    const gardenDone = await turn("c3g-ok", "yes, go ahead", [{ kind: "apply_proposal", proposalId: scoped[0]!.proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(gardenDone[0]!.status, "applied", JSON.stringify(gardenDone));
    const gardenGrant = (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string; project: string }) => g.state === "active" && g.project === garden);
    assert.equal(gardenGrant.length, 1, "the right reaches that one project");
    await call(boot.token, "grant.revoke", { grantId: gardenGrant[0].id, expectedRevision: gardenGrant[0].revision, reason: "test done" }, "rg1");
    // A name that is only part of a longer word the owner said is not their project.
    const longer = "Let service:scanner do recovery.stall-scan in Gardening from now on.";
    const part = await turn("c3k", longer, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden" } }, longer)]);
    assert.equal(part[0]!.status, "refused", JSON.stringify(part));
    // A name and a different scope together are two scopes: which one is asked, nothing is drawn up.
    const both = await turn("c3j", inGarden, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", projectName: "Garden", project: "*" } }, inGarden)]);
    assert.equal(both[0]!.status, "asked", JSON.stringify(both));
    assert.match(both[0]!.question ?? "", /only "Garden", or every project\?/);
    // No scope at all is asked as a plain question, not a sentence to say.
    const noProject = "let service:scanner do recovery.stall-scan";
    const asked = await turn("c3h", noProject, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan" } }, noProject)]);
    assert.equal(asked[0]!.status, "refused", JSON.stringify(asked));
    assert.match(asked[0]!.message ?? "", /\?$/, "it asks which project");
    assert.doesNotMatch(asked[0]!.message ?? "", /\bsay\b/i);
    // A right for a day the owner wrote is drawn up as a proposal that says the day it ends on, and nothing is granted until that line is confirmed; the record then holds the moment that was shown.
    const until = "give service:scanner the recovery.stall-scan right everywhere until 2030-01-01";
    const dated = await turn("c3i", until, [owner({ op: "grant.create", args: { ...args, expiresAt: "2030-01-01T00:00:00.000Z" } }, until)]);
    assert.equal(dated[0]!.status, "proposed", JSON.stringify(dated));
    const datedLine = (dated[0]!.preview ?? []).join(" ");
    assert.match(datedLine, /\(ends 2030-01-01T00:00:00\.000Z; everywhere: it covers every project/, datedLine);
    assert.doesNotMatch(datedLine, /no end/, "a right that runs out is not said to last forever");
    assert.equal(await activeNow(), held, "a proposal grants nothing, whatever its wording");
    const datedDone = await turn("c3i-ok", "yes, go ahead", [{ kind: "apply_proposal", proposalId: dated[0]!.proposalId, evidence: "go ahead", basis: "owner" }]);
    assert.equal(datedDone[0]!.status, "applied", JSON.stringify(datedDone));
    const withEnd = (await call(boot.token, "grant.list", { grantee: "service:scanner" })).result.items.filter((g: { state: string; expiresAt?: string }) => g.state === "active" && g.expiresAt !== undefined);
    assert.equal(withEnd.length, 1, "the confirmed right is the one the line showed");
    assert.equal(withEnd[0].expiresAt, "2030-01-01T00:00:00.000Z", "the moment the owner confirmed is the moment recorded");
    await call(boot.token, "grant.revoke", { grantId: withEnd[0].id, expectedRevision: withEnd[0].revision, reason: "test done" }, "rg2");

    // Both days in one ordinary sentence, the second spelled out: the line says when it ends and when it starts, before any name.
    const window = "from 2030-12-01 until 20 December 2030 let service:scanner do recovery.stall-scan in every project";
    const windowed = await turn("c3l", window, [owner({ op: "grant.create", args: { grantee: "service:scanner", action: "recovery.stall-scan", project: "*", notBefore: "2030-12-01T00:00:00.000Z", expiresAt: "2030-12-20T00:00:00.000Z" } }, window)]);
    assert.equal(windowed[0]!.status, "proposed", JSON.stringify(windowed));
    const windowLine = (windowed[0]!.preview ?? []).join(" ");
    assert.match(windowLine, /ends 2030-12-20T00:00:00\.000Z; starts 2030-12-01T00:00:00\.000Z/, windowLine);
    assert.equal(await activeNow(), held, "a shown window grants nothing");

    // A day the message does not give is not the chat's to choose: nothing is drawn up, and what is missing is asked for in a plain question.
    const monthEnd = "give service:scanner the recovery.stall-scan right everywhere until the end of the month";
    const noday = await turn("c3m", monthEnd, [owner({ op: "grant.create", args: { ...args, expiresAt: "2026-11-30T23:59:59.000Z" } }, monthEnd)]);
    assert.equal(noday[0]!.status, "refused", JSON.stringify(noday));
    assert.equal(noday[0]!.code, "unsupported_value");
    assert.match(noday[0]!.message ?? "", /\?$/, `it asks which day: ${noday[0]!.message}`);
    assert.doesNotMatch(noday[0]!.message ?? "", /\bsay\b|for example|until the end of the month/i, "it asks for the day, not for a sentence to copy");
    assert.equal(await activeNow(), held, "nothing is granted");

    // A right that would be over before it began is refused where it is drawn up, not proposed and refused later.
    const backwards = "give service:scanner the recovery.stall-scan right everywhere from 2030-02-01 until 2030-01-01";
    const reversed = await turn("c3n", backwards, [owner({ op: "grant.create", args: { ...args, notBefore: "2030-02-01T00:00:00.000Z", expiresAt: "2030-01-01T00:00:00.000Z" } }, backwards)]);
    assert.equal(reversed[0]!.status, "refused", JSON.stringify(reversed));
    assert.match(reversed[0]!.message ?? "", /end before it starts/, "a window the wrong way round is not called the same moment");
    assert.equal(await activeNow(), held);
    // An end that has already passed is a right nobody could use: it is refused where it is drawn up, not proposed for the owner to confirm into a dead record.
    const gone = "give service:scanner the recovery.stall-scan right everywhere until 2020-01-01";
    const past = await turn("c3o", gone, [owner({ op: "grant.create", args: { ...args, expiresAt: "2020-01-01T00:00:00.000Z" } }, gone)]);
    assert.equal(past[0]!.status, "refused", JSON.stringify(past));
    assert.equal(past[0]!.proposalId, undefined, "nothing is proposed");
    assert.match(past[0]!.message ?? "", /already passed.*\?$/, String(past[0]!.message));
    assert.equal(await activeNow(), held);
    // The owner's day in the owner's own time: late on Nov 30 at a western offset is Dec 1 in UTC, and is still the day they named. It is drawn up, recorded in UTC and shown that way.
    const western = "give service:scanner the recovery.stall-scan right everywhere until Nov 30 2030";
    const local = await turn("c3p", western, [owner({ op: "grant.create", args: { ...args, expiresAt: "2030-11-30T23:59:00-08:00" } }, western)]);
    assert.equal(local[0]!.status, "proposed", JSON.stringify(local));
    assert.match((local[0]!.preview ?? []).join(" "), /ends 2030-12-01T07:59:00\.000Z/);
    assert.equal(await activeNow(), held);
    // A sentence-ending full stop is not part of the word.
    const stop = "give service:scanner the recovery.stall-scan right everywhere permanently.";
    const dotted = await turn("c3e", stop, [owner({ op: "grant.create", args }, stop)]);
    assert.equal(dotted[0]!.status, "proposed", JSON.stringify(dotted));
    // The list is paged without skipping a grant.
    for (const n of [1, 2, 3]) await call(boot.token, "grant.create", { ...grant, basis: `extra ${n}` }, `gp${n}`);
    const first = await call(boot.token, "grant.list", { grantee: "service:scanner", limit: 2 });
    assert.equal(first.result.items.length, 2);
    assert.ok(first.result.next !== undefined);
    const seen = new Set<string>(first.result.items.map((g: { id: string }) => g.id));
    for (let after = first.result.next as string | undefined; after !== undefined;) { const pg = await call(boot.token, "grant.list", { grantee: "service:scanner", limit: 2, after }); for (const g of pg.result.items) seen.add(g.id); after = pg.result.next; }
    assert.equal(seen.size, (await call(boot.token, "grant.list", { grantee: "service:scanner", limit: 100 })).result.items.length);
    // Revoking by chat: shown first, then applied with the revision read at that time.
    const rtext = `take back grant ${active[0].id} because it is no longer needed`;
    const rshown = await turn("c4", rtext, [owner({ op: "grant.revoke", args: { grantId: active[0].id, reason: "it is no longer needed" } }, rtext)]);
    assert.equal(rshown[0]!.status, "proposed", JSON.stringify(rshown));
    const rdone = await turn("c5", "yes revoke it", [{ kind: "apply_proposal", proposalId: rshown[0]!.proposalId, evidence: "revoke it", basis: "owner" }]);
    assert.equal(rdone[0]!.status, "applied", JSON.stringify(rdone));
    assert.equal((await call(boot.token, "grant.get", { grantId: active[0].id })).result.item.state, "revoked");
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
