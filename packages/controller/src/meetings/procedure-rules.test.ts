import assert from "node:assert/strict";
import { test } from "node:test";
import { PROCEDURE_SETTINGS, PROCEDURE_DEFAULTS } from "./procedure-settings.js";
import { looksLikeEcho, quotesBallot, roundSummary, seatOrder } from "./procedure-rules.js";

const families: Record<string, string> = { a: "gpt", b: "gpt", c: "gpt", d: "qwen", e: "qwen", f: "glm" };
const traits = (m: string) => ({ family: families[m]! });

test("seating interleaves model families so neighbours differ where the roster allows", () => {
  const order = seatOrder(["a", "b", "c", "d", "e", "f"], "diverse", traits);
  assert.deepEqual([...order].sort(), ["a", "b", "c", "d", "e", "f"], "everyone is seated once");
  assert.deepEqual(order, ["a", "d", "f", "b", "e", "c"]);
  // Where one family is too big to separate, nobody is dropped and the others are spread among it.
  const lopsided = seatOrder(["a", "b", "c", "d"], "diverse", traits);
  assert.deepEqual(lopsided, ["a", "d", "b", "c"]);
});

test("seating spreads information inside a family, keeps the roster's order when asked or when nothing is known", () => {
  const info = (m: string) => ({ family: "gpt", info: m === "a" || m === "b" ? "notes-1" : "notes-2" });
  assert.deepEqual(seatOrder(["a", "b", "c", "d"], "diverse", info), ["a", "c", "b", "d"]);
  assert.deepEqual(seatOrder(["a", "b", "c", "d", "e", "f"], "listed", traits), ["a", "b", "c", "d", "e", "f"]);
  assert.deepEqual(seatOrder(["c", "a", "b"], "diverse"), ["c", "a", "b"], "no traits: the roster's own order");
  assert.deepEqual(seatOrder(["a", "d"], "diverse", traits), ["a", "d"]);
});

test("a round summary is a plain attributed digest with no advice, and names those not heard", () => {
  const s = roundSummary(1, [{ speaker: "agent:a", text: "x".repeat(300) }, { speaker: "agent:b", text: "Short." }], ["agent:c"]);
  assert.match(s, /^Round 1: 2 members spoke\. Not heard \(absent or silent\): agent:c\./);
  assert.match(s, /agent:a: x{160}\.\.\./);
  assert.match(s, /agent:b: Short\./);
  assert.equal(roundSummary(2, [], []), "Round 2: 0 members spoke.");
});

test("a message quotes a ballot when it repeats a run of its reason's words; a mere mention does not", () => {
  const reason = "The warm cache halves the run time of the nightly build";
  assert.equal(quotesBallot("A says the warm cache halves the run time. Agree?", reason), true);
  assert.equal(quotesBallot("Please keep to the facts and be brief.", reason), false);
  assert.equal(quotesBallot("the cache is warm and the time halves", reason), false, "scattered words are not a quote");
  assert.equal(quotesBallot("yes", "yes"), false, "a very short reason cannot be quoted");
  assert.equal(quotesBallot("Because of the cache, yes!", "because of the cache"), true, "a short reason is quoted whole");
});

test("an echo needs three voters, every stance known and every stance and ballot the same", () => {
  assert.equal(looksLikeEcho(["for", "for", "for"], ["yes", "yes", "yes"], 3), true);
  assert.equal(looksLikeEcho(["for", "for", "against"], ["yes", "yes", "yes"], 3), false);
  assert.equal(looksLikeEcho(["for", "for", "for"], ["yes", "yes", "no"], 3), false);
  assert.equal(looksLikeEcho(["for", "for"], ["yes", "yes", "yes"], 3), false, "a missing stance is not an echo");
  assert.equal(looksLikeEcho(["for", "for"], ["yes", "yes"], 2), false, "two voters are too few");
});

test("the settings check their values and carry the proposed defaults", () => {
  const by = new Map(PROCEDURE_SETTINGS.map((d) => [d.key, d]));
  assert.deepEqual([...by.keys()].sort(), ["meeting.echoFlag", "meeting.objection.reruns", "meeting.rounds", "meeting.seating", "meeting.tabling", "meeting.vote.maxRevisions"]);
  assert.equal(by.get("meeting.rounds")!.fallback, PROCEDURE_DEFAULTS.rounds);
  assert.equal(by.get("meeting.rounds")!.check(3), 3);
  for (const bad of [0, 6, 2.5, "2", null]) assert.throws(() => by.get("meeting.rounds")!.check(bad));
  assert.throws(() => by.get("meeting.objection.reruns")!.check(-1));
  assert.equal(by.get("meeting.objection.reruns")!.check(0), 0);
  assert.throws(() => by.get("meeting.vote.maxRevisions")!.check(11));
  assert.throws(() => by.get("meeting.tabling")!.check("yes"));
  assert.throws(() => by.get("meeting.seating")!.check("random"));
  assert.equal(by.get("meeting.seating")!.check("listed"), "listed");
  assert.deepEqual(PROCEDURE_DEFAULTS, { rounds: 2, objectionReruns: 2, maxRevisions: 3, tabling: true, echoFlag: true, seating: "diverse" });
  for (const d of PROCEDURE_SETTINGS) assert.equal(d.installationOnly, true, `${d.key} is the owner's alone`);
});
