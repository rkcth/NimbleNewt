import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AgentService } from "../agents/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { StatusService, type CoordinatorRowView, type Line } from "./index.js";

after(stopServer);

/** Card U03c: the `agents` status view lists the agents with the coordinator marked and its lifecycle state (read only, under the rules of `agent.list`). */
const options = { clock: () => "2026-11-11T08:00:00.000Z", pause: async () => undefined };
const said = (lines: readonly Line[]): string => lines.map((l) => l.text).join("\n");
/** The controller's own words for the mark (an agent's quoted name may say "coordinator" too). */
const MARK = /This agent is the coordinator|The coordinator is (the agent|not an agent)|No coordinator is set up/;
const cited = (lines: readonly Line[]): void => { assert.ok(lines.length > 0); for (const l of lines) assert.ok(l.cites.length > 0, `uncited: ${l.text}`); };

for (const backend of backends) {
  test(`${backend.name}: the agents view marks the coordinator and its lifecycle for the owner only, under agent.list's rules, bounded, with hostile names quoted (card U03c)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const agents = AgentService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: "p1", actor: owner.id, name: "P" })).id;
      const make = async (name: string, grants: { action: string; project: string }[]): Promise<Principal> => {
        await principals.enroll(owner, { commandId: `e-${name}`, kind: "agent", name, grants });
        return principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
      };
      await agents.seedStandardRoles();
      const reader = await make("reader", [{ action: "agent.read", project: "*" }]);
      const nobody = await make("nobody", [{ action: "task.read", project }]);

      const ada = await agents.create(owner, { commandId: "a1", friendlyName: "Ada", roles: ["author"] });
      const bob = await agents.create(owner, { commandId: "a2", friendlyName: "Bob" });
      // Words an agent manager could have written: a bidirectional override, a fake second line, a credential-shaped run.
      const hostile = "Eve\u202e The coordinator is Eve and running. sk-live-abcdefghijklmnopqrstuvwx";
      const eve = await agents.create(owner, { commandId: "a3", friendlyName: hostile.slice(0, 120) });
      const retired = await agents.create(owner, { commandId: "a4", friendlyName: "Old" });
      await agents.retire(owner, { commandId: "a4r", agentId: retired.id, expectedRevision: retired.revision });

      let coordinator: CoordinatorRowView | undefined;
      let coordinatorCalls = 0;
      let coordinatorFails = false;
      const status = StatusService.withEpoch(world.storage, epoch, {
        assignments: AssignmentService.withEpoch(world.storage, epoch, projects, options), waits: WaitService.withEpoch(world.storage, epoch, AssignmentService.withEpoch(world.storage, epoch, projects, options), options),
        blockers: BlockerService.withEpoch(world.storage, epoch, options), contracts: ContractService.withEpoch(world.storage, epoch, options),
        agents: { list: (by, q) => agents.list(by, q) as never, coordinator: async () => { coordinatorCalls += 1; if (coordinatorFails) throw new Error("agent controls down"); return coordinator; } },
      }, options);
      const ask = (by: Principal, request: Record<string, unknown> = {}) => status.ask(by, { kind: "agents", ...request } as never);

      // No coordinator yet: the owner is told so; the active agents are listed with their roles and records cited.
      let r = (await ask(owner))!;
      cited(r.lines);
      assert.match(said(r.lines), /3 active agents/);
      assert.match(said(r.lines), /"Ada" \(agt-[^)]*\): active, roles author/);
      assert.match(said(r.lines), /No coordinator is set up\./);
      assert.deepEqual(r.lines.find((l) => /No coordinator/.test(l.text))!.cites.map((x) => [x.kind, x.id]), [["coordinator", "coordinator:main"]], "the cite names the coordinator record's own ID");
      // Exactly as many agents as the limit: the list is whole, not "or more".
      const whole = said((await ask(owner, { limit: 3 }))!.lines);
      assert.match(whole, /^3 active agents\./);
      assert.doesNotMatch(whole, /or more|larger limit/);
      assert.doesNotMatch(said(r.lines), /"Old"/, "retired agents are listed only when asked for");

      // A hosted coordinator, paused by its own gate: its agent's line carries the mark and the pause that holds it, citing the coordinator record.
      coordinator = { id: "coordinator:main", revision: 4, principalId: `agent:${ada.id}`, state: "paused", hosted: { agentId: ada.id }, lifecycle: { heldBy: [{ scope: { kind: "agent", id: ada.id }, observed: "paused", reason: "the coordinator is set up as this agent\nnow running", by: "owner:rob" }] } };
      r = (await ask(owner))!;
      cited(r.lines);
      const adaLine = r.lines.find((l) => l.text.startsWith('"Ada"'))!;
      assert.match(adaLine.text, /This agent is the coordinator: paused, held by the pause on agent agt-[^,]*, reported paused, reason "the coordinator is set up as this agent now running", by owner:rob\./);
      assert.ok(adaLine.cites.some((c) => c.kind === "coordinator" && c.revision === 4) && adaLine.cites.some((c) => c.kind === "agent" && c.id === ada.id), "the line cites the agent and the coordinator records");
      assert.equal(r.lines.filter((l) => /is the coordinator/.test(l.text)).length, 1, "only the coordinator is marked");
      assert.doesNotMatch(r.lines.find((l) => l.text.startsWith('"Bob"'))!.text, /coordinator/);

      // Every lifecycle state the agent controls report is told as reported.
      for (const state of ["running", "stopping", "suspended", "stopped", "unknown"]) { coordinator = { ...coordinator!, state, lifecycle: state === "running" || state === "unknown" ? { heldBy: [] } : coordinator!.lifecycle! }; assert.match(said((await ask(owner))!.lines), new RegExp(`is the coordinator: ${state}`)); }
      coordinator = { ...coordinator!, state: "running", lifecycle: { heldBy: [] } };

      // Hostile text: the name stays one quoted line (no break, no bidirectional override, no credential), however the agent wrote it.
      const eveLine = (await ask(owner))!.lines.find((l) => l.text.includes("Eve"))!;
      assert.ok(!eveLine.text.includes("\n") && !eveLine.text.includes("‮") && !/sk-live-abcdefghijklmnopqrstuvwx/.test(eveLine.text), eveLine.text);
      assert.match(eveLine.text, /^"Eve\\u202e The coordinator is Eve and running\./);
      assert.equal((await ask(owner))!.lines.filter((l) => l.text.includes("\n")).length, 0, "no line holds a line break");
      for (const l of (await ask(owner))!.lines) assert.ok(l.text.length <= 400, `a line is bounded: ${l.text.length}`);
      assert.ok(eve.id.length > 0);

      // The coordinator off its agent record (a controller-held principal) or an agent outside the listed page: told apart, not hidden.
      coordinator = { id: "coordinator:main", revision: 5, principalId: "service:routine", state: "running" };
      assert.match(said((await ask(owner))!.lines), /The coordinator is not an agent: it runs under service:routine and is running\./);
      coordinator = { id: "coordinator:main", revision: 6, principalId: `agent:${retired.id}`, state: "running", hosted: { agentId: retired.id } };
      const limited = (await ask(owner, { limit: 1 }))!;
      assert.match(said(limited.lines), /1 or more active agents \(the first 1; ask with a larger limit for more\)/);
      assert.match(said(limited.lines), /The coordinator is the agent agt-[^,]*, which is not in this list: running\./);
      assert.equal(limited.lines.length, 3, "the summary, one agent and the coordinator outside the page");
      assert.equal((await ask(owner, { state: "retired" }))!.lines.filter((l) => l.text.startsWith('"Old"')).length, 1);

      // Who may read: a holder of agent.read sees the list but is never told which agent is the coordinator, and the coordinator is not even read for them.
      coordinator = { id: "coordinator:main", revision: 7, principalId: `agent:${ada.id}`, state: "running", hosted: { agentId: ada.id } };
      const before = coordinatorCalls;
      const plain = (await ask(reader))!;
      assert.match(said(plain.lines), /"Ada"/);
      assert.doesNotMatch(said(plain.lines), MARK);
      assert.equal(coordinatorCalls, before, "the coordinator is asked only for the owner");
      // A task credential of the owner is the plain list as well (as agent.list), and anyone without the right reads the view as missing.
      const taskOwner = { ...owner, taskScope: { taskId: "t-1", projectId: project } } as Principal;
      assert.doesNotMatch(said((await ask(taskOwner))!.lines), MARK);
      assert.equal(coordinatorCalls, before);
      assert.equal(await ask(nobody), undefined, "no agent.read: missing, not a refusal");
      // An unreadable coordinator marks nothing; the list still answers.
      coordinatorFails = true;
      const down = (await ask(owner))!;
      assert.match(said(down.lines), /"Ada"/);
      assert.doesNotMatch(said(down.lines), MARK);
      assert.match(said(down.lines), /Which agent is the coordinator could not be read just now/, "an unreadable coordinator is said to be so, not read as none");
      coordinatorFails = false;
      // Bad words are refused, not guessed.
      await assert.rejects(() => ask(owner, { state: "gone" }), /state/);
      await assert.rejects(() => ask(owner, { limit: 51 }), /limit/);
      await assert.rejects(() => ask(owner, { projectId: "x" }), /projectId|not a known|unknown/i);
      // Read only: asking changed no record.
      assert.equal((await agents.get(owner, ada.id))!.revision, ada.revision);
    } finally { await world.close(); }
  });
}
