import assert from "node:assert/strict";
import { test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { ModelInterpreter, checkIntents } from "./index.js";

const co = (extra: Record<string, unknown>) => [{ kind: "coordinator", evidence: "e", basis: "owner", ...extra }];

test("the coordinator is set up by the agent's name in the owner's words, or by principal, never both and never neither (card U03c)", () => {
  const ok = checkIntents(co({ action: "configure", agentName: "Ada", routes: ["llama/local"] }))[0] as { agentName?: string; principalId?: string };
  assert.equal(ok.agentName, "Ada");
  assert.equal(ok.principalId, undefined);
  assert.equal((checkIntents(co({ action: "configure", principalId: "agent:coordinator", routes: ["r"] }))[0] as { principalId?: string }).principalId, "agent:coordinator");
  // Routes are optional in the words: a hosted coordinator uses its agent's profile (card U03d); the service refuses a coordinator that is not an agent record and names none.
  assert.equal((checkIntents(co({ action: "configure", agentName: "Ada" }))[0] as { routes?: unknown }).routes, undefined);
  for (const bad of [{ action: "configure", routes: ["r"] }, { action: "configure", agentName: "Ada", principalId: "agent:c", routes: ["r"] }, { action: "start", agentName: "Ada" }, { action: "answer", question: "q", agentName: "Ada" }]) {
    assert.throws(() => checkIntents(co(bad)), DomainError, JSON.stringify(bad));
  }
});

test("the model is told how the owner reaches the coordinator in free words, including setting an agent up as the coordinator (card U03c)", async () => {
  let system = "";
  const interpreter = new ModelInterpreter({ complete: async (_route, request) => { system = request.system; return "[{\"kind\":\"none\",\"reason\":\"x\"}]"; } }, () => ["r"]);
  await interpreter.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /"kind":"coordinator"/);
  assert.match(system, /agentName/);
  assert.match(system, /start, pause or stop/);
});

test("the state-API commands for the coordinator have a free-word equivalent the model is told about: set up (routes optional), start, pause, stop, and taking it off its agent (U03d c)", async () => {
  const { OPERATIONS } = await import("../api/index.js");
  const names = OPERATIONS.filter((o) => o.name.startsWith("coordinator.")).map((o) => o.name).sort();
  assert.deepEqual(names, ["coordinator.configure", "coordinator.get", "coordinator.state"]);
  assert.equal(OPERATIONS.find((o) => o.name === "coordinator.configure")!.kind, "command");
  let system = "";
  const interpreter = new ModelInterpreter({ complete: async (_route, request) => { system = request.system; return "[{\"kind\":\"none\",\"reason\":\"x\"}]"; } }, () => ["r"]);
  await interpreter.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  for (const action of ["configure", "start", "pause", "stop"]) assert.ok(system.includes(action), action);
  assert.match(system, /routes are up to four model route names[^.]*given only when the owner names them/);
  assert.match(system, /routing profile/);
  assert.match(system, /taking it off its agent/);
});

test("the owner can ask in free words which agents there are and which one is the coordinator: the model is told the status kind, its keys and the words, and the operation summary names it (card U03c)", async () => {
  const { OPERATIONS } = await import("../api/index.js");
  const { STATUS_KINDS } = await import("../status/index.js");
  assert.deepEqual(STATUS_KINDS["agents"]!.keys, ["state", "limit"]);
  const summary = OPERATIONS.find((o) => o.name === "status.ask")!.summary;
  assert.match(summary, /`agents` \(the agents with the coordinator marked and its lifecycle state/);
  let system = "";
  const interpreter = new ModelInterpreter({ complete: async (_route, request) => { system = request.system; return "[{\"kind\":\"none\",\"reason\":\"x\"}]"; } }, () => ["r"]);
  await interpreter.interpret({ text: "hello", quoted: [], focus: {}, proposals: [] });
  assert.ok(system.includes("agents(state, limit) - "), "the kind and its keys are in the list the model reads");
  assert.match(system, /read the status kind agents/);
  assert.match(system, /which one is the coordinator/);
  assert.match(system, /is the coordinator running or paused\?/);
});
