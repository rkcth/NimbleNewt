import assert from "node:assert/strict";
import { after, test } from "node:test";
import { ConfigurationService } from "../configuration/index.js";
import type { SettingDefinition } from "../configuration/settings.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PrincipalService } from "../security/index.js";
import { FLOOR_RETIRED_SETTINGS, FLOOR_SETTINGS } from "./floor-settings.js";
import { MEETING_SETTINGS } from "./meetings.js";

// The facilitated run and the meeting procedure are one service, so the four settings both had (and one only the floor had) are retired. What an owner stored under the old names must move, not vanish.

after(stopServer);

const stamp = "2026-11-14T08:00:00.000Z";
/** The settings as the installation had them before the merge: the floor's retired keys were real settings. */
const legacy = (key: string, fallback: unknown, check: (v: unknown) => unknown): SettingDefinition => ({ key, kind: "default", installationOnly: true, check, fallback, effect: "next-request", description: "a retired floor setting" } as SettingDefinition);
const whole = (lo: number, hi: number) => (v: unknown): unknown => (typeof v === "number" && Number.isSafeInteger(v) && v >= lo && v <= hi ? v : (() => { throw `must be ${lo} to ${hi}`; })());
const flag = (v: unknown): unknown => (typeof v === "boolean" ? v : (() => { throw "must be true or false"; })());
const OLD: readonly SettingDefinition[] = [
  legacy("meeting.floor.commentRounds", 2, whole(0, 5)), legacy("meeting.floor.objectionReruns", 2, whole(0, 5)), legacy("meeting.floor.tabling", true, flag),
  legacy("meeting.floor.maxRevisionsPerVoter", 3, whole(0, 10)), legacy("meeting.floor.freshRoundAfterAmendment", true, flag),
];
const KEYS = ["meeting.rounds", "meeting.objection.reruns", "meeting.tabling", "meeting.vote.maxRevisions", ...OLD.map((d) => d.key)];

for (const backend of backends) {
  test(`${backend.name}: a floor setting retired into the procedure's keeps the owner's choice, never overrides one the owner set there, and is moved once`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", clock: () => stamp, pause: async () => undefined });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, { clock: () => stamp });
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const before = ConfigurationService.withEpoch(world.storage, epoch, { clock: () => stamp, settings: [...MEETING_SETTINGS, ...OLD] });
      const staged = await before.stage(owner, { commandId: "m-st", layer: "installation", set: {
        "meeting.floor.commentRounds": 0, "meeting.floor.objectionReruns": 4, "meeting.floor.tabling": false, "meeting.floor.maxRevisionsPerVoter": 1, "meeting.floor.freshRoundAfterAmendment": false,
        "meeting.vote.maxRevisions": 7, "meeting.floor.firstRound": "open",
      } });
      await before.apply(owner, { commandId: "m-ap", layer: "installation", expectedRevision: staged.revision });

      // today's installation no longer defines the old keys
      const config = ConfigurationService.withEpoch(world.storage, epoch, { clock: () => stamp, settings: MEETING_SETTINGS });
      const first = await config.migrateSettings(FLOOR_RETIRED_SETTINGS);
      assert.deepEqual([...first.moved].sort(), ["meeting.floor.commentRounds", "meeting.floor.objectionReruns", "meeting.floor.tabling"], "three moved");
      assert.deepEqual([...first.dropped].sort(), ["meeting.floor.freshRoundAfterAmendment", "meeting.floor.maxRevisionsPerVoter"], "one has no equivalent, one the owner chose again under the new name");
      const now = await config.installationValues(KEYS.filter((k) => !k.startsWith("meeting.floor.")));
      assert.equal(now["meeting.rounds"], 1, "0 rounds of comment (the old floor's way to skip them) becomes the procedure's smallest, 1");
      assert.equal(now["meeting.objection.reruns"], 4);
      assert.equal(now["meeting.tabling"], false);
      assert.equal(now["meeting.vote.maxRevisions"], 7, "the owner's choice under the new name stays");
      assert.equal((await config.installationValues(["meeting.floor.firstRound"]))["meeting.floor.firstRound"], "open", "the floor's own settings are untouched");
      // the old keys are gone from the layer
      const left = await config.installationSettings(["meeting.floor.commentRounds", "meeting.floor.objectionReruns"]).catch(() => ({}));
      assert.deepEqual(Object.values(left).filter((v) => (v as { set?: boolean }).set === true), []);
      // a second start moves nothing and writes nothing
      const again = await config.migrateSettings(FLOOR_RETIRED_SETTINGS);
      assert.deepEqual([again.moved, again.dropped], [[], []]);
      assert.ok(FLOOR_SETTINGS.every((d) => !OLD.some((o) => o.key === d.key)), "no retired key is a floor setting any more");
    } finally { await world.close(); }
  });
}
