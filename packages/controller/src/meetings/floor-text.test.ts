import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfigurationService } from "../configuration/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PrincipalService } from "../security/index.js";
import { FLOOR_DEFAULTS, FLOOR_SETTINGS, applyFloorChange, checkFloorValue, floorSettingsFrom } from "./floor-settings.js";
import { MEETING_SETTINGS } from "./meetings.js";
import { accountTurn, chairQuestionRefusal, estimateTokens, parseObjection, parseStatement, parseVote, quoteOccurs, recordText, transcriptView, usesFacts, wrapCheckpointAnswer } from "./floor-text.js";
import { after } from "node:test";

after(stopServer);

test("the turn limit counts visible tokens: hidden reasoning is separate, over-long text is cut at a word, a hidden overspend is only recorded", () => {
  const long = `${"word ".repeat(400)}end`;
  const a = accountTurn(long, { visibleTokens: 500, hiddenTokens: 0 }, { visible: 220, hidden: 800 });
  assert.equal(a.truncated, true);
  assert.equal(a.visibleTokens, 220);
  assert.ok(!a.text.endsWith("wor") && a.text.length < long.length);
  const b = accountTurn("short", { visibleTokens: 100, hiddenTokens: 700 }, { visible: 220, hidden: 800 });
  assert.equal(b.truncated, false);
  assert.equal(b.hiddenTokens, 700);
  const c = accountTurn("short", { visibleTokens: 100, hiddenTokens: 900 }, { visible: 220, hidden: 800 });
  assert.equal(c.hiddenOver, true);
  assert.equal(estimateTokens(""), 0);
});

test("a chair question is checked by its structure, not by its words", () => {
  assert.equal(chairQuestionRefusal({ to: "agent:a", topic: "the cache layout; we support the idea", experience_sought: "what you measured" }), undefined);
  assert.notEqual(chairQuestionRefusal({ to: "agent:a", topic: "t", experience_sought: "e", position: "for" }), undefined);
  assert.notEqual(chairQuestionRefusal({ to: "agent:a", topic: "how will you vote", experience_sought: "your stance" }), undefined);
  assert.notEqual(chairQuestionRefusal({ to: "agent:a", topic: "", experience_sought: "e" }), undefined);
  assert.notEqual(chairQuestionRefusal("not an object"), undefined);
});

test("quotes must occur verbatim; replies parse strictly; a checkpoint answer is wrapped by the controller", () => {
  assert.equal(quoteOccurs("hit rate is 91 percent", "The cache hit rate is 91 percent at night."), true);
  assert.equal(quoteOccurs("hit rate is 99 percent", "The cache hit rate is 91 percent at night."), false);
  assert.equal(quoteOccurs("", "anything"), false);
  assert.deepEqual(parseVote("VOTE: yes\nREASON: because"), { value: "yes", reason: "because" });
  assert.equal(parseVote("I think maybe").value, undefined);
  assert.equal(parseObjection("OBJECT: research\nREASON: numbers", true).answer, "research");
  assert.equal(parseObjection("OBJECT: research\nREASON: numbers", false).answer, "yes");
  assert.equal(parseObjection("garbage", true).answer, undefined);
  assert.equal(parseStatement("STANCE: against\nSTATEMENT: no way\nTLDR: no").stance, "against");
  const wrapped = wrapCheckpointAnswer("agent:x", "2026-11-13T09:00:00.000Z", "It was fine.");
  assert.ok(wrapped.includes("not live") && wrapped.includes("2026-11-13") && wrapped.includes("It was fine."));
  assert.equal(recordText("a".repeat(5000), 100).length <= 100, true);
});

test("facts-style summaries are used above the threshold and the whole text at or below it; short statements are kept verbatim", () => {
  assert.equal(usesFacts("auto", 8, 8), false);
  assert.equal(usesFacts("auto", 9, 8), true);
  assert.equal(usesFacts("full", 50, 8), false);
  assert.equal(usesFacts("facts", 2, 8), true);
  const entries = [{ seq: 1, who: "agent:a", text: "Short and sweet.", summary: "short" }, { seq: 2, who: "agent:b", text: `${"long words here ".repeat(60)}`, summary: "the key point" }];
  const facts = transcriptView(entries, "facts");
  assert.ok(facts.includes("Short and sweet."), "a short statement stays verbatim");
  assert.ok(facts.includes("the key point") && !facts.includes("long words here long words here long words here long words here long words here"));
  assert.ok(transcriptView(entries, "full").includes("long words here long words here"));
});

test("every default is a setting the owner can change; values are checked; unusable values fall back", () => {
  assert.deepEqual(Object.keys(FLOOR_DEFAULTS).sort(), FLOOR_SETTINGS.map((s) => s.key.replace("meeting.floor.", "")).sort());
  assert.equal(FLOOR_DEFAULTS.firstRound, "blind");
  assert.equal(FLOOR_DEFAULTS.chairNotes, "once");
  assert.equal(FLOOR_DEFAULTS.turnTokens, 220);
  assert.equal(checkFloorValue("chairQuestionCap", 3), 3);
  assert.throws(() => checkFloorValue("chairQuestionCap", 99));
  assert.throws(() => checkFloorValue("firstRound", "sideways"));
  assert.throws(() => checkFloorValue("spendCapUsd", "five"));
  assert.equal(floorSettingsFrom({ "meeting.floor.chairQuestionCap": { value: 4 }, "meeting.floor.firstRound": "open", "meeting.floor.directQuestions": "nope" }).chairQuestionCap, 4);
  assert.equal(floorSettingsFrom({ "meeting.floor.directQuestions": "nope" }).directQuestions, 1);
  assert.equal(floorSettingsFrom(undefined).firstRound, "blind");
  assert.equal(applyFloorChange(FLOOR_DEFAULTS, { turnTokens: 300 }).turnTokens, 300);
  assert.throws(() => applyFloorChange(FLOOR_DEFAULTS, { nonsense: 1 }));
  for (const s of FLOOR_SETTINGS) assert.ok(MEETING_SETTINGS.some((m) => m.key === s.key), `${s.key} is registered`);
});

for (const backend of backends) {
  test(`${backend.name}: the owner changes a floor default through the configuration service and the next meeting uses it`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1", clock: () => "2026-11-14T08:00:00.000Z", pause: async () => undefined });
      const epoch = projects.epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, { clock: () => "2026-11-14T08:00:00.000Z" });
      const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const config = ConfigurationService.withEpoch(world.storage, epoch, { clock: () => "2026-11-14T08:00:00.000Z", settings: MEETING_SETTINGS });
      const read = async () => floorSettingsFrom(await config.installationValues(FLOOR_SETTINGS.map((d) => d.key)));
      assert.equal((await read()).firstRound, "blind");
      await assert.rejects(() => config.stage(owner, { commandId: "c-bad", layer: "installation", set: { "meeting.floor.chairQuestionCap": 99 } }));
      const staged = await config.stage(owner, { commandId: "c-st", layer: "installation", set: { "meeting.floor.firstRound": "open", "meeting.floor.chairQuestionCap": 3, "meeting.floor.spendCapUsd": 10 } });
      await config.apply(owner, { commandId: "c-ap", layer: "installation", expectedRevision: staged.revision });
      const now = await read();
      assert.equal(now.firstRound, "open");
      assert.equal(now.chairQuestionCap, 3);
      assert.equal(now.spendCapUsd, 10);
      assert.equal(now.directQuestions, 1, "the rest keep their defaults");
    } finally { await world.close(); }
  });
}
