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
