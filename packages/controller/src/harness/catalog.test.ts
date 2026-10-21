import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ContractService } from "../planning/index.js";
import { PrincipalService } from "../security/index.js";
import { HarnessCatalog, type HarnessDeclaration } from "./index.js";

after(stopServer);

const pi: HarnessDeclaration = { harness: "pi", nativeContinuation: true, portableReconstruction: false, checkpointExport: false, abort: "conversation" };
const rebuilder: HarnessDeclaration = { harness: "fake-rebuilder", nativeContinuation: false, portableReconstruction: true, checkpointExport: true, abort: "request" };
const nothing: HarnessDeclaration = { harness: "fake-nothing", nativeContinuation: false, portableReconstruction: false, checkpointExport: false, abort: "none" };

test("the catalog holds sound declarations only, once each, and a harness it does not ship is refused with the list of those it does", () => {
  const catalog = HarnessCatalog.of([pi, rebuilder, nothing]);
  assert.deepEqual(catalog.list().map((d) => d.harness), ["fake-nothing", "fake-rebuilder", "pi"]);
  assert.throws(() => HarnessCatalog.of([pi, pi]), (e) => e instanceof DomainError && /declared twice/.test(e.message));
  assert.throws(() => HarnessCatalog.of([{ ...rebuilder, checkpointExport: false }]), (e) => e instanceof DomainError && /needs checkpoint export/.test(e.message));
  assert.match(catalog.check("none", "other")!, /not one this installation ships \(fake-nothing, fake-rebuilder, pi\)/);
  assert.equal(catalog.check("native-continuation", "pi"), undefined);
  assert.match(catalog.check("portable-reconstruction", "pi")!, /no portable history export/);
  assert.match(catalog.check("native-continuation", "fake-rebuilder")!, /cannot continue a conversation/);
  assert.match(catalog.check("native-continuation", "fake-nothing")!, /unsupported for durable tasks/);
  assert.equal(catalog.check("none", "fake-nothing"), undefined, "work that may be lost needs nothing");
});

for (const backend of backends) {
  test(`${backend.name}: an attempt is admitted only on a harness that can recover the task, and a refusal says why`, async () => {
    const world = await backend.open();
    try {
      const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const contracts = ContractService.withEpoch(world.storage, projects.epoch, options);
      const catalog = HarnessCatalog.of([pi, rebuilder, nothing]);
      const gated = AssignmentService.withEpoch(world.storage, projects.epoch, projects, { ...options, attemptGate: async (taskId, harness) => catalog.checkAttempt(await contracts.recoveryOf(taskId), harness) });
      const ungated = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
      const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
      let n = 0;
      const readyTask = async (): Promise<{ id: string; revision: number }> => {
        const id = (await projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `t${n}` })).id;
        await projects.transitionTask({ commandId: `tr${n}`, actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
        const assigned = await gated.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: id, owner: { kind: "agent", id: "ann" } });
        n += 1;
        return { id, revision: assigned.revision };
      };
      const admit = (service: AssignmentService, task: { id: string; revision: number }, harness?: string, label = "a") => service.admitAttempt({ commandId: `adm-${task.id}-${label}`, actor: owner.id, taskId: task.id, expectedRevision: task.revision, generation: 1, owner: { kind: "agent", id: "ann" }, ...(harness === undefined ? {} : { harness }) });
      const refused = async (run: () => Promise<unknown>, pattern: RegExp): Promise<void> => assert.rejects(run, (e) => e instanceof DomainError && e.code === "invalid_command" && e.field === "harness" && pattern.test(e.message));

      // The default requirement is native continuation: Pi meets it, a harness that only rebuilds from exports does not, and one with neither is unsupported for durable tasks.
      const t1 = await readyTask();
      await refused(() => admit(gated, t1, "fake-rebuilder"), /cannot continue a conversation from its own storage/);
      await refused(() => admit(gated, t1, "fake-nothing"), /unsupported for durable tasks/);
      await refused(() => admit(gated, t1, "nonexistent"), /not one this installation ships/);
      assert.equal((await gated.getAssignment(t1.id))!.activeAttemptId, undefined, "a refusal admitted nothing");
      await admit(gated, t1, "pi");
      assert.ok((await gated.getAssignment(t1.id))!.activeAttemptId !== undefined);

      // A task that must be rebuildable on another machine cannot run on Pi, which has no history export; one that may be lost can run anywhere.
      const t2 = await readyTask();
      await contracts.setContract(owner, { commandId: "c2", taskId: t2.id, expectedVersion: 0, recovery: "portable-reconstruction" });
      await refused(() => admit(gated, t2, "pi"), /no portable history export/);
      await admit(gated, t2, "fake-rebuilder");
      const t3 = await readyTask();
      await contracts.setContract(owner, { commandId: "c3", taskId: t3.id, expectedVersion: 0, recovery: "none" });
      await admit(gated, t3, "fake-nothing");
      // With the gate configured, an attempt that names no harness is acceptable only for work that may be lost.
      const t5 = await readyTask();
      await refused(() => admit(gated, t5), /names no harness/);
      const t6 = await readyTask();
      await contracts.setContract(owner, { commandId: "c6", taskId: t6.id, expectedVersion: 0, recovery: "none" });
      await admit(gated, t6);

      // Naming a harness where nothing can check it is refused; not naming one is the unchecked, legacy call.
      const t4 = await readyTask();
      await refused(() => admit(ungated, t4, "pi"), /no harness is configured/);
      await admit(ungated, t4);
    } finally { await world.close(); }
  });
}
