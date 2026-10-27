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
    for (const [n, said] of [["semi", "give service:scanner the recovery.stall-scan right everywhere semi-permanent"], ["til", "give service:scanner the recovery.stall-scan right everywhere permanently til Friday"], ["for", "give service:scanner the recovery.stall-scan right everywhere permanently for now"], ["why", "give service:scanner the recovery.stall-scan right everywhere permanently to run stall detection"]] as const) {
      const r = await turn(`c3${n}`, said, [owner({ op: "grant.create", args }, said)]);
      assert.equal(r[0]!.status, "refused", `${said}: ${JSON.stringify(r)}`);
    }
    // Whole words only: a prefix of the principal, and a scope the owner did not say, are refused.
    const prefix = await turn("c3b", "give service:scanner the recovery.stall-scan right everywhere to run stall detection", [owner({ op: "grant.create", args: { ...args, grantee: "service:scan" } }, text)]);
    assert.equal(prefix[0]!.status, "refused", JSON.stringify(prefix));
    const noScope = await turn("c3c", "give service:scanner the recovery.stall-scan right permanently", [owner({ op: "grant.create", args }, "give service:scanner the recovery.stall-scan right permanently")]);
    assert.equal(noScope[0]!.status, "refused", "everywhere is not what the owner said");
    const named = await turn("c3d", "give service:scanner the recovery.stall-scan right permanently", [owner({ op: "grant.create", args: { ...args, projectName: "Garden" } }, "give service:scanner the recovery.stall-scan right permanently")]);
    assert.equal(named[0]!.status, "refused", "the scope is `project`, not a name the chat would drop");
    // A sentence-ending full stop is not part of the word; a scope said about something else, and a dropped time limit, are refused.
    const stop = "give service:scanner the recovery.stall-scan right everywhere permanently.";
    const dotted = await turn("c3e", stop, [owner({ op: "grant.create", args }, stop)]);
    assert.equal(dotted[0]!.status, "proposed", JSON.stringify(dotted));
    const elsewhere = "give service:scanner the recovery.stall-scan right permanently. There are bugs everywhere.";
    assert.equal((await turn("c3f", elsewhere, [owner({ op: "grant.create", args }, elsewhere)]))[0]!.status, "refused");
    const limited = "give service:scanner the recovery.stall-scan right everywhere permanently, expires Friday";
    assert.equal((await turn("c3g", limited, [owner({ op: "grant.create", args }, limited)]))[0]!.status, "refused", "a time limit is not understood by the chat");
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
