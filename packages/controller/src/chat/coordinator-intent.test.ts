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
  for (const bad of [{ action: "configure", routes: ["r"] }, { action: "configure", agentName: "Ada", principalId: "agent:c", routes: ["r"] }, { action: "configure", agentName: "Ada" }, { action: "start", agentName: "Ada" }, { action: "answer", question: "q", agentName: "Ada" }]) {
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
