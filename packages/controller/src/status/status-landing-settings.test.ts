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

      // The first read makes the project's record (as integration.get does); three at once on a project with none make one record, and all three say the same.
      const firsts = await Promise.all([1, 2, 3].map(async () => (await status.landingSettingsLines(w.owner, w.project))!));
      const first = firsts[0]!;
      const text = first.lines.map((l) => l.text).join("\n");
      for (const f of firsts) assert.equal(f.lines.map((l) => l.text).join("\n"), text);
      assert.match(text, /\(revision 1\); the installation allows landing on main by itself\./, text);
      assert.match(text, /How finished work lands in project Garden: /, text);
      assert.match(text, /Who integrates: /, text);
      assert.match(text, /Checks required before work lands: tests/, text);
      assert.match(text, /These settings are copied from the approval profile when the project's settings were first made \(a later change of the profile does not change them\) \(revision 1\)/, `the source of the default is said: ${text}`);
      assert.match(text, /Checks required before work lands: tests \(the task's test commands pass on the work as it would land\)/, text);
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
      // The installation's lock: a project set to main-automatic is held at the integration branch, and the view says both what the setting says and what holds it.
      await integration.set(w.owner, { commandId: "is-1b", projectId: w.project, landing: "main-automatic" } as never);
      assert.match((await status.landingSettingsLines(w.owner, w.project))!.lines[0]!.text, /: main-automatic: it goes to main by itself once its required checks pass/);
      await integration.setDefault(w.owner, { commandId: "id-1", forbidMainAutomatic: true } as never);
      const held = (await status.landingSettingsLines(w.owner, w.project))!.lines.map((l) => l.text).join("\n");
      assert.match(held, /: integration-branch: it is merged onto a separate integration branch[^\n]*\(the setting says main-automatic, but the installation's lock holds main-automatic back\)\./, held);
      assert.match(held, /the installation forbids landing on main by itself\./, held);
      await integration.set(w.owner, { commandId: "is-2", projectId: w.project, landing: "integration-branch", requiredChecks: [] } as never);
      assert.match((await status.landingSettingsLines(w.owner, w.project))!.lines.map((l) => l.text).join("\n"), /Checks required before work lands: none\./);

      // A project made after the owner set an installation default takes its values from that default, and the view says so; the earlier project keeps its own.
      await integration.setDefault(w.owner, { commandId: "id-2", refreshRounds: 4 } as never);
      const later = (await w.projects.createProject({ commandId: "p-later", actor: w.owner.id, name: "Orchard" } as never)).id;
      const fresh = (await status.landingSettingsLines(w.owner, later))!.lines.map((l) => l.text).join("\n");
      assert.match(fresh, /How finished work lands in project Orchard: /, fresh);
      assert.match(fresh, /up to 4 time\(s\)/, fresh);
      assert.match(fresh, /These settings are copied from the installation default for new projects when the project's settings were first made \(a later change of that default does not change them\)/, fresh);
      assert.match((await status.landingSettingsLines(w.owner, w.project))!.lines.map((l) => l.text).join("\n"), /set for this project by you/);

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
