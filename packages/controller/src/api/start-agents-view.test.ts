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

/** Card U03c: the owner asks for the agents in chat, in free words, and the answer marks the coordinator and its lifecycle, in the running controller. */
test("the owner's chat lists the agents with the coordinator and its lifecycle marked, follows the agent controls, and tells nobody else which agent it is (card U03c)", async () => {
  const d = mkdtempSync(join(tmpdir(), "nn-agents-view-"));
  let held: string | undefined;
  const say: Record<string, unknown[]> = {};
  const owner = (kind: string, rest: Record<string, unknown>, evidence: string) => ({ kind, ...rest, evidence, basis: "owner" });
  const c = await startController({
    storage: { kind: "sqlite", path: join(d, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts: supported, filesystem: ext4, features: [], harnesses: [],
    chat: { interpreter: new ScriptedInterpreter((input) => say[input.text] ?? []), coordinator: { token: async () => held, routes: () => ["llama/local"], model: { respond: async () => ({}) } } },
  });
  try {
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const rob = await c.services.principals.authenticate(boot.token);
    const call = async (token: string, op: string, args: Record<string, unknown>, commandId?: string) => (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
    const turn = async (id: string, text: string, intents: unknown[]) => { say[text] = intents; return (await c.chat!.submit(boot.token, { messageId: id, text })); };
    const agentsOf = async (id: string, text: string, request: Record<string, unknown> = {}): Promise<string> => {
      const t = await turn(id, text, [owner("status", { request: { kind: "agents", ...request } }, text)]);
      return (t.outcomes as unknown as { status: string; lines?: { text: string }[] }[]).map((o) => o.status === "answered" ? (o.lines ?? []).map((l) => l.text).join("\n") : `${o.status}: ${JSON.stringify(o)}`).join("\n");
    };
    await c.services.projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden", repositories: [{ id: "main", location: join(d, "garden") }] });
    await turn("m0", "work on Garden", [owner("switch_focus", { projectName: "Garden" }, "work on Garden")]);
    const ada = await c.services.agents.create(rob, { commandId: "ag-ada", friendlyName: "Ada" });
    await c.services.agents.create(rob, { commandId: "ag-bob", friendlyName: "Bob" });
    held = (await c.services.principals.issueCredential(rob, `agent:${ada.id}`)).token;

    const before = await agentsOf("m1", "who is on my team?");
    assert.match(before, /No coordinator is set up\./, before);
    assert.match(before, /"Ada" \(agt-/);

    const setUp = await turn("m2", "make Ada the coordinator on llama/local", [owner("coordinator", { action: "configure", agentName: "Ada", routes: ["llama/local"] }, "make Ada the coordinator")]);
    assert.equal(setUp.outcomes[0]!.status, "applied", JSON.stringify(setUp.outcomes));
    const paused = await agentsOf("m3", "is the coordinator running or paused?");
    assert.match(paused, /This agent is the coordinator: paused, held by the pause on agent /, paused);
    assert.doesNotMatch(paused, /Bob[^]*This agent is the coordinator/, "only the coordinator's own line carries the mark");

    // The agent controls and the chat's words are the same gate; the answer follows them.
    await turn("m4", "start the coordinator", [owner("coordinator", { action: "start" }, "start the coordinator")]);
    assert.match(await agentsOf("m5", "which agent answers my questions?"), /This agent is the coordinator: running\./);
    await call(boot.token, "lifecycle.pause", { scope: { kind: "installation", id: "installation" }, reason: "maintenance window" }, "pz1");
    const held2 = await agentsOf("m6", "list my agents");
    assert.match(held2, /This agent is the coordinator: paused, held by the pause on installation /, held2);
    assert.match(held2, /maintenance window/);

    // The state API answers the same kind, with the same marks, and the records are cited.
    const api = await call(boot.token, "status.ask", { request: { kind: "agents" } });
    assert.equal(api.ok, true, JSON.stringify(api));
    const marked = api.result.item.lines.filter((l: any) => /This agent is the coordinator/.test(l.text));
    assert.equal(marked.length, 1);
    assert.ok(marked[0].cites.some((x: any) => x.kind === "coordinator") && marked[0].cites.some((x: any) => x.kind === "agent" && x.id === ada.id));

    // A holder of agent.read gets the list and no mark; an agent without the right reads nothing.
    await c.services.principals.enroll(rob, { commandId: "e-reader", kind: "agent", name: "reader", grants: [{ action: "agent.read", project: "*" }] });
    const reader = (await c.services.principals.issueCredential(rob, "agent:reader")).token;
    const plain = await call(reader, "status.ask", { request: { kind: "agents" } });
    assert.equal(plain.ok, true, JSON.stringify(plain));
    assert.match(JSON.stringify(plain.result.item.lines), /Ada/);
    assert.doesNotMatch(JSON.stringify(plain.result.item.lines), /This agent is the coordinator/);
    await c.services.principals.enroll(rob, { commandId: "e-none", kind: "agent", name: "none", grants: [] });
    const none = (await c.services.principals.issueCredential(rob, "agent:none")).token;
    const nothing = await call(none, "status.ask", { request: { kind: "agents" } });
    assert.ok(!nothing.ok || (nothing.result.item?.lines ?? []).length === 0, JSON.stringify(nothing));
    // Asking changed nothing.
    assert.equal((await c.services.agents.get(rob, ada.id))!.revision, ada.revision);
  } finally { await c.close(); rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
