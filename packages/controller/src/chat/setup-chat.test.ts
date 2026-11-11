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
