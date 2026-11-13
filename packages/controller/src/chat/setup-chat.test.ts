import assert from "node:assert/strict";
import { test } from "node:test";
import { OPERATIONS } from "../api/operations.js";
import { STATUS_KINDS } from "../status/index.js";
import { CHAT_OPS, acceptedArgs } from "./commands.js";
import { ModelInterpreter } from "./model-interpreter.js";

// Card U14 and the owner's rule that everything is reachable by free-form chat: the model is told about the setup walk-through, the project's host and CI, and the provider editing,
// derived from the same tables the answer is checked against.
test("the interpreter prompt tells the model about the first-run setup: the setup view, versionControl on projects, provider editing with credential NAMES, and that no key goes in a field (card U14)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "help me get started", quoted: [], focus: {}, proposals: [] });
  const kind = STATUS_KINDS["setup"]!;
  assert.ok(kind !== undefined);
  assert.ok(system.includes(`setup(${kind.keys.join(", ")}) - ${kind.about}`), "the setup view is a listed status kind");
  assert.ok(OPERATIONS.find((o) => o.name === "status.ask")!.summary.includes("`setup`"), "status.ask describes the same kind");
  assert.match(system, /First-run setup/);
  assert.match(system, /versionControl \{host: github, gitlab, self-hosted or none/);
  assert.match(system, /nothing assumes GitHub/);
  assert.match(system, /routing\.provider\.add/);
  assert.match(system, /at least two routes on two different servers/);
  assert.match(system, /NAME of a secret in the secret store, never a key/);
  assert.ok(system.includes("routing.provider.add(providers, expectedRevision"), "the operation's arguments are listed from the one table");
  assert.ok((acceptedArgs("project.create") ?? []).includes("versionControl") && (acceptedArgs("project.update") ?? []).includes("versionControl"));
  assert.equal(CHAT_OPS["routing.provider.add"]?.mode, "propose", "a provider decides where data may go: shown first in every profile");
});

// Card U14c: every step of the first-run walk-through is shown to the owner first in the strict profile, so no answer is applied unasked; the interpreter prompt says so and names the steps added here.
test("the setup steps are never applied unshown in the strict profile, and the prompt names the notification, task and budget steps and says the owner's yes comes first (card U14c)", async () => {
  for (const op of ["project.create", "routing.provider.add", "host.local.set", "grant.create", "credential.issue", "notifications.configure", "task.create"]) {
    assert.ok(Object.hasOwn(CHAT_OPS, op), `${op} is a chat operation`);
    assert.notEqual(CHAT_OPS[op]?.mode, "apply", `${op} must be shown first in the strict profile`);
  }
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "set me up", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /notifications\.configure for how they want to hear from the team/);
  assert.match(system, /budgets and time limits are offered once and left off/);
  assert.match(system, /nothing is applied until the owner says yes in their own words/);
  assert.match(system, /put it in the secret store with the launcher/);
});

// Card U14b: credentials for agents and hosts and the local worker host are reachable in free words: the model is told about them from the same tables the answer is checked against.
test("the interpreter prompt tells the model about credentials for agents and hosts (shown first, shown once, never typed into the chat) and the local worker host switch; both are always shown first (card U14b)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "I want my laptop to run agents", quoted: [], focus: {}, proposals: [] });
  for (const op of ["credential.issue", "credential.revoke", "host.local.set"]) {
    assert.ok(Object.hasOwn(CHAT_OPS, op), `${op} is a chat operation`);
    assert.equal(CHAT_OPS[op]?.mode, "propose", `${op} is shown first in every profile`);
    assert.ok(OPERATIONS.some((o) => o.name === op && o.kind === "command"), `${op} is an operation of the API`);
    assert.ok(system.includes(`${op}(${(acceptedArgs(op) ?? []).filter((k) => k !== "projectName").join(", ")})`), `${op} is listed with its arguments from the one table`);
  }
  assert.ok(system.includes("credential.issue(kind, agentId, name"));
  assert.ok(system.includes("host.local.set(enabled, expectedRevision"));
  assert.match(system, /credential\.issue for the agent's or a host's credential/);
  assert.match(system, /ONCE in the terminal chat/);
  assert.match(system, /never put one in a reply or ask the owner to type or paste one/);
  assert.match(system, /credential\.revoke takes one away/);
  assert.match(system, /host\.local\.set enabled true/);
  assert.match(system, /loads no model/);
  // The credential operations are owner-only in the API's own text, and the host switch counts from the next start.
  for (const op of ["credential.issue", "credential.revoke", "host.local.set", "host.local.get"]) assert.match(OPERATIONS.find((o) => o.name === op)!.summary, /Owner only/);
  assert.match(OPERATIONS.find((o) => o.name === "host.local.set")!.summary, /next start/);
});

// Card M05 and the owner's rule that everything is reachable by free-form chat: the model is told that a finished meeting's outcomes can be handed back and that the meeting can ask the owner about the decisions it left open.
test("the interpreter prompt tells the model how to have a meeting hand its outcomes back and ask the owner about deferred decisions, from the one operation table (card M05)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "ask me about what the sync left open", quoted: [], focus: {}, proposals: [] });
  const op = "meeting.record.outcomes";
  assert.equal(CHAT_OPS[op]?.mode, "propose", "it settles agenda topics and may fill the owner's inbox: shown first");
  assert.ok(OPERATIONS.some((o) => o.name === op && o.kind === "command"), "it is an operation of the API");
  assert.ok(system.includes(`${op}(${(acceptedArgs(op) ?? []).filter((k) => k !== "projectName").join(", ")})`), "listed with its arguments from the one table");
  assert.ok((acceptedArgs(op) ?? []).includes("askOwner") && (acceptedArgs(op) ?? []).includes("meetingTopic"));
  assert.match(system, /meeting\.record\.outcomes \(meetingTopic: words from the meeting/);
  assert.match(system, /askOwner true: each such decision then puts one question to the owner \(at most 10 wait at a time\)/);
  assert.match(system, /writes the answer back onto the meeting's record/);
  assert.match(OPERATIONS.find((o) => o.name === op)!.summary, /never an agent, an outside app or a task credential/);
  assert.ok(OPERATIONS.some((o) => o.name === "meeting.owner-outcomes" && o.kind === "query"));
});

// Card M05b and the owner's rule that everything is reachable by free-form chat: what the chair read from absent members' desks is asked for through the status view, which the interpreter prompt lists from the one table.
test("the interpreter prompt lists the status view of the chair's desk reads, and the API has the query (card M05b)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "what did the chair read from Ben's desk?", quoted: [], focus: {}, proposals: [] });
  assert.ok(STATUS_KINDS["meeting_desk_reads"] !== undefined, "a status view");
  assert.match(system, /meeting_desk_reads/);
  assert.match(system, /what a meeting's chair read from absent members' desks and shared working notes/);
  assert.ok(OPERATIONS.some((o) => o.name === "meeting.desk-reads" && o.kind === "query"));
  assert.match(OPERATIONS.find((o) => o.name === "status.ask")!.summary, /meeting_desk_reads/);
});
