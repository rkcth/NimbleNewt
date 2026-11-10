// W01 acceptance for card L02e (l02e-2): the stop_cleanup status view of a scope answered through a wider scope.
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { StatusService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-28T11:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-w01-${n++}`;

for (const backend of backends.filter((b) => b.name === "reference store")) {
  test(`${backend.name}: a task answered through a wider scope's Stop names that scope in the stop_cleanup view, escaped and cited`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const assignments = AssignmentService.withEpoch(world.storage, epoch, projects, options);
      const waits = WaitService.withEpoch(world.storage, epoch, assignments, options);
      const blockers = BlockerService.withEpoch(world.storage, epoch, options);
      const contracts = ContractService.withEpoch(world.storage, epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
      const t = await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "Build" });
      let answer: Record<string, unknown> | undefined;
      const stops = { cleanupSpend: async (by: Principal, _scope: unknown) => { if (by.kind !== "owner") throw new Error("only the owner here"); return answer as never; } };
      const status = StatusService.withEpoch(world.storage, epoch, { assignments, waits, blockers, contracts, stops }, options);

      // The request is the task's own: no wider scope is named.
      answer = { intentId: "stp-1", mode: "stop", phase: "done", endingRan: true, spent: 2_500_000, unpaid: false, attempts: [], requestedAt: "2026-10-28T10:00:00.000Z" };
      const plain = (await status.ask(owner, { kind: "stop_cleanup", taskId: t.id }))!;
      assert.ok(plain.lines.length > 0);
      assert.ok(!plain.lines.some((l) => l.text.includes("agt-b")));

      // Answered through the Stop of agent agt-b.
      answer = { ...answer, intentId: "stp-9", through: { kind: "agent", id: "agt-b" } };
      const wider = (await status.ask(owner, { kind: "stop_cleanup", taskId: t.id }))!;
      for (const l of wider.lines) assert.ok(l.cites.length > 0, `every line cites a record: ${l.text}`);
      const text = wider.lines.map((l) => l.text).join("\n");
      assert.ok(text.includes("agent agt-b"), `the view names the scope the figures come from: ${text}`);
      assert.ok(text.includes(t.id), `and the task asked about: ${text}`);
      assert.ok(wider.lines.some((l) => l.cites.some((x) => x.kind === "agent" && x.id === "agt-b")), "a line cites the wider scope");
      assert.ok(wider.lines.some((l) => l.cites.some((x) => x.kind === "stop" && x.id === "stp-9")), "and the request");

      // The wider scope's ID is record text: control characters never reach a line raw.
      answer = { ...answer, through: { kind: "task", id: "task-x\u001b[31mparent" } };
      const odd = (await status.ask(owner, { kind: "stop_cleanup", scopeKind: "agent", scopeId: "agt-b" }))!.lines.map((l) => l.text).join("\n");
      assert.ok(odd.includes("task-x"), odd);
      assert.ok(!odd.includes("\u001b"), `escaped: ${JSON.stringify(odd)}`);
    } finally { await world.close(); }
  });
}
