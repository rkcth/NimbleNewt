import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BudgetService } from "../budgets/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { FallbackService, RoutingService } from "../routing/index.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { LocalHostSettingService } from "./local-host.js";
import { SetupReadinessService } from "./readiness.js";

after(stopServer);

const table = {
  providers: { alpha: { enabled: true, paid: false, location: "local" }, beta: { enabled: true, paid: false, location: "cloud" } },
  routes: { "alpha/one": { contextTokens: 65_536, capabilities: ["tools"] }, "beta/two": { contextTokens: 65_536, capabilities: ["tools"] } },
  profiles: { main: ["alpha/one", "beta/two"] },
  roles: { coder: "main" },
};
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

// Card U14d: the readiness view on all four storage backends. The host step says an answered "run agents on this computer" waits for the next start (it is not lost), and the budgets
// step shows as answered once a ceiling really exists (a budget record with every limit removed is not one).
for (const backend of backends) {
  test(`${backend.name}: readiness says a chosen local host joins at the next start, and shows budgets as answered only while a ceiling exists`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1" });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
      const agent: Principal = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const readiness = SetupReadinessService.withEpoch(world.storage, projects.epoch);
      const hostSetting = LocalHostSettingService.withEpoch(world.storage, projects.epoch);
      const routing = RoutingService.withEpoch(world.storage, projects.epoch);
      await routing.setTable(owner, { commandId: cid("t"), expectedRevision: 0, table });
      const fb = FallbackService.withEpoch(world.storage, projects.epoch, routing);
      const p = (await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "A" })).id;
      const task = (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "t" })).id;
      const item = async (id: string) => (await readiness.check(owner)).items.find((i) => i.id === id)!;

      // Only the owner reads it.
      await assert.rejects(() => readiness.check(agent), (e: unknown) => e instanceof DomainError && e.code === "forbidden");

      // The host step.
      assert.match((await item("host")).detail, /no host enrolled/);
      await hostSetting.set(owner, { commandId: cid("h"), enabled: true });
      const waiting = await item("host");
      assert.equal(waiting.state, "missing", "no agent can run until the host has joined");
      assert.match(waiting.detail, /joins when the controller is started again/);
      assert.equal((await readiness.check(owner)).next, "host", "the walk-through still points at the host");
      await hostSetting.set(owner, { commandId: cid("h"), enabled: false });
      assert.match((await item("host")).detail, /no host enrolled/, "turning it off again takes the note away");

      // The budgets step.
      assert.equal((await item("budgets")).state, "default");
      await fb.setBudget(owner, { commandId: cid("b"), taskId: task, maxTokens: 50_000 });
      const set = await item("budgets");
      assert.equal(set.state, "done");
      assert.equal(set.required, false);
      assert.match(set.detail, /ceiling has been set/);
      await fb.setBudget(owner, { commandId: cid("b"), taskId: task, maxTokens: null });
      assert.equal((await item("budgets")).state, "default", "a budget with every limit removed is no ceiling");
      // Review: the overall money cap is a ceiling too (the likeliest answer to the budgets question), and turning it off again is the default once more.
      const budgets = BudgetService.withEpoch(world.storage, projects.epoch);
      await budgets.setAggregate(owner, { commandId: cid("a"), enabled: true, scope: "installation", period: "month", amountMicros: 50_000_000 });
      assert.equal((await item("budgets")).state, "done", "an overall money cap answers the budgets step");
      await budgets.setAggregate(owner, { commandId: cid("a"), enabled: false });
      assert.equal((await item("budgets")).state, "default", "a cap that is off is no ceiling");

      // Review: once the controller has started with "run agents on this computer" in effect and no host joined, "start it again" would be a loop; the view points at the start-up messages.
      await hostSetting.set(owner, { commandId: cid("h"), enabled: true });
      const later = SetupReadinessService.withEpoch(world.storage, projects.epoch, { startedAt: new Date(Date.now() + 60_000).toISOString() });
      const afterStart = (await later.check(owner)).items.find((i) => i.id === "host")!;
      assert.equal(afterStart.state, "missing");
      assert.doesNotMatch(afterStart.detail, /started again/, "a start has already happened with the choice in effect");
      assert.match(afterStart.detail, /no host has joined since this start; the messages printed when the controller started say why/);
      const earlier = SetupReadinessService.withEpoch(world.storage, projects.epoch, { startedAt: new Date(Date.now() - 60_000).toISOString() });
      assert.match((await earlier.check(owner)).items.find((i) => i.id === "host")!.detail, /joins when the controller is started again/, "chosen during this run: it joins at the next start");
      assert.doesNotMatch(JSON.stringify(await readiness.check(owner)), /sk-[A-Za-z0-9]{8}|Bearer |password/);
    } finally { await world.close(); }
  });
}
