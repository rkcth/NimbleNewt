import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { StatusService, STATUS_KINDS } from "./index.js";

after(stopServer);
// A project's landing settings are readable in chat and through the state API (the `landing_settings` view): the settings reader's own answer, owner only, in plain words.

for (const backend of backends) {
  test(`${backend.name}: the landing_settings view says where work lands, who integrates, the required checks and the refresh cap, to the owner only`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const options = { clock: w.clock.now, pause: async () => undefined };
      const integration = IntegrationPolicyService.withEpoch(w.storage, w.epoch, options);
      const view = (kept: boolean) => StatusService.withEpoch(w.storage, w.epoch, { ...(kept ? { integration } : {}) } as never, options);
      const status = view(true);
      assert.deepEqual(STATUS_KINDS["landing_settings"]?.keys, ["projectId"]);

      const first = (await status.landingSettingsLines(w.owner, w.project))!;
      const text = first.lines.map((l) => l.text).join("\n");
      assert.match(text, /How finished work lands in project Garden: /, text);
      assert.match(text, /Who integrates: /, text);
      assert.match(text, /Checks required before work lands: tests/, text);
      assert.match(text, /taken from the approval profile|installation default/, `the source of the default is said: ${text}`);
      assert.ok(first.lines.every((l) => l.cites.some((c) => c.kind === "project" && c.id === w.project)), "every line cites the project");

      // A change by the owner is what the view says next, in plain words (the list replaces the old one).
      const was = await integration.get(w.owner, w.project);
      await integration.set(w.owner, { commandId: "is-1", projectId: w.project, requiredChecks: ["review", "director"], integrator: "human", refreshRounds: 5, expectedRevision: was.revision } as never);
      const now = (await status.landingSettingsLines(w.owner, w.project))!.lines.map((l) => l.text).join("\n");
      assert.match(now, /Checks required before work lands: review \(an independent reviewer approved the change\); director \(/, now);
      assert.doesNotMatch(now, /tests \(/, now);
      assert.match(now, /Who integrates: a person\./, now);
      assert.match(now, /up to 5 time\(s\)/, now);
      assert.match(now, /set for this project by you/, now);
      await integration.set(w.owner, { commandId: "is-2", projectId: w.project, requiredChecks: [] } as never);
      assert.match((await status.landingSettingsLines(w.owner, w.project))!.lines.map((l) => l.text).join("\n"), /Checks required before work lands: none\./);

      // Only the owner reads it (as the settings reader itself): an agent with project rights is told nothing, and so is a project that does not exist.
      const agent = await w.agent("ivy", [{ action: "integration.lease", project: w.project }, { action: "task.read", project: w.project }]);
      const ivy = await w.principals.authenticate((await w.principals.issueCredential(w.owner, agent.id)).token);
      assert.equal(await status.landingSettingsLines(ivy, w.project), undefined);
      assert.equal(await status.landingSettingsLines(w.owner, "proj-aaaaaaaaaaaaaaaaaaaa"), undefined);
      // Without the settings service the view says so, and never guesses.
      assert.match((await view(false).landingSettingsLines(w.owner, w.project))!.lines[0]!.text, /not kept on this controller/);
      // The same lines come through the request door.
      const asked = await status.ask(w.owner, { kind: "landing_settings", projectId: w.project } as never);
      assert.match(JSON.stringify(asked), /Checks required before work lands/);
    } finally { await store.close(); }
  });
}
