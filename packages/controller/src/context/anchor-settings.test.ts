import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, ProjectService } from "../domain/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { ANCHOR_CHARS_BOUNDS, ContextRouteSettingsService, DEFAULT_ROUTE_FLOOR_CHARS } from "./index.js";

after(stopServer);

// Card W12: the owner's switch and size cap for the goal anchor, kept with the route-change settings (one record, one chat command). On by default; owner only; the figure has bounds; nothing set before this card changes.

const options = { clock: () => "2026-11-11T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (run: () => Promise<unknown>, text: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.match(error.message, text); return true; });
};

for (const backend of backends) {
  test(`${backend.name}: the anchor is on by default with a cap of 2,400 characters; the owner turns it off and on, sets and unsets the cap in bounds; the route-change settings keep working; others read nothing and change nothing (W12)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const settings = ContextRouteSettingsService.withEpoch(world.storage, projects.epoch, options);

      assert.deepEqual(await settings.effective(), { check: true, floorChars: DEFAULT_ROUTE_FLOOR_CHARS, anchor: true, anchorChars: 2400, recall: true, recallCalls: 20 });
      const first = await settings.get(owner);
      assert.deepEqual(first.defaults, { check: true, floorChars: DEFAULT_ROUTE_FLOOR_CHARS, anchor: true, anchorChars: 2400, recall: true, recallCalls: 20 });

      await settings.change(owner, { commandId: cid("a"), disable: ["anchor"] });
      assert.equal((await settings.effective()).anchor, false);
      await settings.change(owner, { commandId: cid("a"), enable: ["anchor"], set: { anchorChars: 1500 } });
      assert.deepEqual(await settings.effective(), { check: true, floorChars: DEFAULT_ROUTE_FLOOR_CHARS, anchor: true, anchorChars: 1500, recall: true, recallCalls: 20 });
      assert.deepEqual((await settings.get(owner)).settings.anchorChars, 1500);
      // One command changes the anchor and the older settings together, each as it was asked.
      await settings.change(owner, { commandId: cid("a"), disable: ["check"], set: { floorChars: 9000, anchorChars: ANCHOR_CHARS_BOUNDS.max } });
      assert.deepEqual(await settings.effective(), { check: false, floorChars: 9000, anchor: true, anchorChars: 6000, recall: true, recallCalls: 20 });
      await settings.change(owner, { commandId: cid("a"), unset: ["anchorChars", "anchor"] });
      assert.deepEqual(await settings.effective(), { check: false, floorChars: 9000, anchor: true, anchorChars: 2400, recall: true, recallCalls: 20 });

      // Bounds and kinds.
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { anchorChars: ANCHOR_CHARS_BOUNDS.min - 1 } }), /anchorChars must be a whole number from 900 to 6000/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { anchorChars: 6001 } }), /anchorChars must be a whole number/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { anchorChars: 1500.5 } }), /anchorChars must be a whole number/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { colour: 3 } }), /only floorChars, anchorChars and recallCalls/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), enable: ["anchorChars"] }), /not a setting you can enable/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), disable: ["anchorChars"] }), /not a setting you can disable/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), enable: ["anchor"], disable: ["anchor"] }), /named once/);
      assert.deepEqual(await settings.effective(), { check: false, floorChars: 9000, anchor: true, anchorChars: 2400, recall: true, recallCalls: 20 }, "a refused change stores nothing");

      // Owner only.
      await assert.rejects(() => settings.get(ann), /may not read/);
      await assert.rejects(() => settings.change(ann, { commandId: cid("c"), disable: ["anchor"] }), /may not change/);
      assert.equal((await settings.effective()).anchor, true);
    } finally { await world.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: the memory tool task.recall is on by default with 20 calls an attempt; the owner turns it off and on and sets and unsets the cap in bounds; the anchor's settings are untouched; others change nothing (W13)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
      const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
      const settings = ContextRouteSettingsService.withEpoch(world.storage, projects.epoch, options);
      const e = await settings.effective();
      assert.deepEqual([e.recall, e.recallCalls], [true, 20]);
      assert.deepEqual([(await settings.get(owner)).defaults.recall, (await settings.get(owner)).defaults.recallCalls], [true, 20]);
      await settings.change(owner, { commandId: cid("r"), disable: ["recall"] });
      assert.equal((await settings.effective()).recall, false);
      await settings.change(owner, { commandId: cid("r"), enable: ["recall"], set: { recallCalls: 5, anchorChars: 1500 } });
      assert.deepEqual([(await settings.effective()).recall, (await settings.effective()).recallCalls, (await settings.effective()).anchorChars], [true, 5, 1500]);
      assert.equal((await settings.get(owner)).settings.recallCalls, 5);
      await settings.change(owner, { commandId: cid("r"), unset: ["recallCalls", "recall"] });
      assert.deepEqual([(await settings.effective()).recall, (await settings.effective()).recallCalls, (await settings.effective()).anchorChars], [true, 20, 1500]);
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { recallCalls: 0 } }), /recallCalls must be a whole number from 1 to 100/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { recallCalls: 101 } }), /recallCalls must be a whole number/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), set: { recallCalls: 2.5 } }), /recallCalls must be a whole number/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), enable: ["recallCalls"] }), /not a setting you can enable/);
      await refuses(() => settings.change(owner, { commandId: cid("b"), enable: ["recall"], disable: ["recall"] }), /named once/);
      assert.equal((await settings.effective()).recallCalls, 20, "a refused change stores nothing");
      await assert.rejects(() => settings.change(ann, { commandId: cid("c"), disable: ["recall"] }), /may not change/);
      assert.equal((await settings.effective()).recall, true);
    } finally { await world.close(); }
  });
}
