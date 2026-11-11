import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProtectedBranchService } from "../policy/protected-branches.js";
import type { Principal } from "../security/principals.js";
import { landingPolicyFrom } from "./landing-policy.js";

after(stopServer);

// Card H12t: configuration has no project layer, so the branch a project's finished work lands on is the owner's own project record (`project.branches.set` with `landing`). It wins over the installation's
// `workspace.landing.branch`, so two projects can land on different branches; a project with none named lands on the installation's branch; nothing is guessed, and a failure to read refuses the landing.
const A = "proj-aaaaaaaaaaaaaaaaaaaa";
const B = "proj-bbbbbbbbbbbbbbbbbbbb";
const C = "proj-cccccccccccccccccccc";
const TASK = "task-abcdefghijklmnopqrst";
const owner = { id: "owner:rob", kind: "owner" } as unknown as Principal;

test("the project's own landing branch wins over the installation's; a project with none uses the installation's; a failure to read it refuses (card H12t)", async () => {
  const values: Record<string, unknown> = { "workspace.landing.branch": "main" };
  const pick = (keys: readonly string[]) => Object.fromEntries(keys.map((k) => [k, values[k]]));
  const named = new Map<string, string>([[B, "trunk"]]);
  const p = landingPolicyFrom({ installationValues: async (ks) => pick(ks), taskValues: async (ks) => pick(ks) }, async (projectId) => named.get(projectId));
  assert.equal((await p({ taskId: TASK, projectId: A })).branch, "main");
  assert.equal((await p({ taskId: TASK, projectId: B })).branch, "trunk");
  assert.equal((await p({ taskId: TASK, projectId: B })).requirePermit, true, "the permit is still the settings' (required unless the owner said false)");
  delete values["workspace.landing.branch"];
  assert.equal((await p({ taskId: TASK, projectId: A })).branch, undefined, "no branch anywhere: none is invented (the host refuses)");
  assert.equal((await p({ taskId: TASK, projectId: B })).branch, "trunk");
  const failing = landingPolicyFrom({ installationValues: async (ks) => pick(ks), taskValues: async (ks) => pick(ks) }, async () => { throw new Error("unreadable"); });
  await assert.rejects(() => failing({ taskId: TASK, projectId: A }), /unreadable/);
});

for (const backend of backends) {
  test(`${backend.name}: a project's landing branch is read from the owner's branch settings, cleared with null, and a malformed project ID is refused (card H12t)`, async () => {
    const world = await backend.open();
    try {
      const { epoch } = await world.storage.acquireEpoch({ holder: "h12t-test", at: new Date().toISOString() });
      const svc = ProtectedBranchService.withEpoch(world.storage, epoch);
      assert.equal(await svc.landingOf(A), undefined, "nothing set");
      await svc.set(owner, { commandId: "b1", projectId: A, landing: "main" });
      await svc.set(owner, { commandId: "b2", projectId: B, protected: ["main"], landing: "release/2" });
      assert.equal(await svc.landingOf(A), "main");
      assert.equal(await svc.landingOf(B), "release/2");
      assert.equal(await svc.landingOf(C), undefined);
      await svc.change(owner, { commandId: "b3", projectId: B, add: ["dev"] });
      assert.equal(await svc.landingOf(B), "release/2", "a change that does not name the landing keeps it");
      await svc.change(owner, { commandId: "b4", projectId: B, landing: null });
      assert.equal(await svc.landingOf(B), undefined, "cleared");
      await assert.rejects(() => svc.landingOf("../x"), /not a project ID/);
      // Only the owner names it.
      await assert.rejects(() => svc.set({ id: "agent:agt-aaaaaaaaaaaaaaaaaaaa", kind: "agent" } as unknown as Principal, { commandId: "b5", projectId: C, landing: "evil" }), /forbidden|owner|may not/);
      assert.equal(await svc.landingOf(C), undefined);
      // Through the policy: the two projects land on different branches over one installation branch.
      const p = landingPolicyFrom({ installationValues: async () => ({ "workspace.landing.branch": "main" }), taskValues: async () => undefined }, (projectId) => svc.landingOf(projectId));
      await svc.set(owner, { commandId: "b6", projectId: B, landing: "trunk" });
      assert.deepEqual([(await p({ taskId: TASK, projectId: A })).branch, (await p({ taskId: TASK, projectId: B })).branch, (await p({ taskId: TASK, projectId: C })).branch], ["main", "trunk", "main"]);
    } finally { await world.close(); }
  });
}
