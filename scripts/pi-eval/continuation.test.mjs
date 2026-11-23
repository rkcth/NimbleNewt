// Card W04, bench variant C: the continuation extension apart from Pi (a fake runner calls its two handlers the way Pi does)
// and the config the runner reads from the built pi-adapter.
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import continuationExtension, { CONTINUATION_CUSTOM_TYPE, createContinuation, readConfig } from "./continuation-extension.mjs";
import { readContinuation } from "./lib/runner.mjs";
import { loadContinuationConfig, loadTaskset } from "./lib/taskset.mjs";

const dir = mkdtempSync(join(tmpdir(), "pi-eval-continuation-"));
after(() => rmSync(dir, { recursive: true, force: true }));
const CFG = { max: 3, mark: "[MARK]", nudge: "NUDGE", lengthNudge: "LENGTH NUDGE" };
const reply = (content, stopReason = "stop") => ({ type: "message_end", message: { role: "assistant", content, stopReason, usage: { input: 1, output: 1 } } });
const text = (t) => [{ type: "text", text: t }];
const settle = (c, entries = []) => c.onBeforeSettle({ type: "agent_before_settle", entries, continue: false });

test("a stop that is not a result-stating report is continued with the mark and the nudge, up to the bound, then the answer stands", () => {
  const c = createContinuation({ config: CFG, file: null });
  for (let n = 1; n <= 3; n++) {
    c.onMessageEnd(reply(text("I have read the task. Next I'll make the change.")));
    const r = settle(c, [{ type: "custom", customType: "kept" }]);
    assert.equal(r.continue, true);
    assert.deepEqual(r.entries.map((e) => e.customType), ["kept", CONTINUATION_CUSTOM_TYPE], "the proposals so far are kept, ours is added");
    assert.deepEqual(r.entries.at(-1), { type: "custom_message", customType: CONTINUATION_CUSTOM_TYPE, content: "[MARK] NUDGE", display: false });
    assert.equal(c.counts.nudges, n);
  }
  c.onMessageEnd(reply(text("Still thinking about it. Next I'll look again.")));
  assert.equal(settle(c), undefined, "the fourth stop is the answer");
  assert.equal(c.counts.nudges, 3);
});

test("a cut-off reply gets the cut-off words; thinking-only and empty replies are continued", () => {
  const c = createContinuation({ config: CFG, file: null });
  c.onMessageEnd(reply([{ type: "thinking", thinking: "hmm" }], "length"));
  assert.equal(settle(c).entries.at(-1).content, "[MARK] LENGTH NUDGE");
  c.onMessageEnd(reply([{ type: "thinking", thinking: "hmm" }]));
  assert.equal(settle(c).entries.at(-1).content, "[MARK] NUDGE");
  c.onMessageEnd(reply([]));
  assert.equal(settle(c).continue, true);
  assert.deepEqual({ ...c.counts }, { max: 3, nudges: 3, lengthNudges: 1, endedByReport: false, errors: 0 });
});

test("a report that states done, partial or blocked ends the work: no nudge, and it is counted", () => {
  for (const t of ["Done. I changed lib.mjs and ran the tests.", "Partial. Steps 1 and 2 are done; step 3 needs a database.", "Blocked by a missing fixture."]) {
    const c = createContinuation({ config: CFG, file: null });
    c.onMessageEnd(reply(text(t)));
    assert.equal(settle(c), undefined, t);
    assert.equal(c.counts.endedByReport, true);
    assert.equal(c.counts.nudges, 0);
  }
});

test("an error or an abort is a hard exit and is never continued; no reply at all is not continued either", () => {
  for (const stop of ["error", "aborted"]) {
    const c = createContinuation({ config: CFG, file: null });
    c.onMessageEnd(reply(text("Next I'll try."), stop));
    assert.equal(settle(c), undefined, stop);
  }
  assert.equal(settle(createContinuation({ config: CFG, file: null })), undefined);
});

test("a nudge after the report is over: an agent that states done only after being nudged stops being continued", () => {
  const c = createContinuation({ config: CFG, file: null });
  c.onMessageEnd(reply(text("Next I'll run the tests.")));
  assert.equal(settle(c).continue, true);
  c.onMessageEnd(reply(text("Done. All the tests pass.")));
  assert.equal(settle(c), undefined);
  assert.equal(c.counts.nudges, 1);
});

test("the counts file holds numbers only, is written at load and after each decision, and never the text", () => {
  const file = join(dir, "c1.json");
  const c = createContinuation({ config: CFG, file });
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { max: 3, nudges: 0, lengthNudges: 0, endedByReport: false, errors: 0 });
  c.onMessageEnd(reply(text("SECRET-TEXT-OF-THE-AGENT. Next I'll go on.")));
  settle(c);
  const raw = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(raw), { max: 3, nudges: 1, lengthNudges: 0, endedByReport: false, errors: 0 });
  assert.doesNotMatch(raw, /SECRET|NUDGE|MARK/);
  assert.deepEqual(readContinuation(file), { max: 3, nudges: 1, lengthNudges: 0, endedByReport: false, errors: 0 });
  assert.equal(readContinuation(join(dir, "missing.json")), null);
});

test("a bad or missing config continues nothing and says so (errors), and never throws", () => {
  const bad = join(dir, "bad.json");
  writeFileSync(bad, JSON.stringify({ ...CFG, max: 11 }));
  for (const config of [bad, join(dir, "none.json"), { ...CFG, nudge: "" }, { ...CFG, max: -1 }]) {
    const c = createContinuation({ config, file: null });
    c.onMessageEnd(reply(text("Next I'll go on.")));
    assert.equal(settle(c), undefined);
    assert.equal(c.counts.errors, 1, JSON.stringify(config));
  }
  writeFileSync(bad, JSON.stringify({ ...CFG, max: 11 }));
  assert.throws(() => readConfig(bad), /0 to 10/);
  // A malformed event does not throw.
  const c = createContinuation({ config: CFG, file: null });
  assert.doesNotThrow(() => { c.onMessageEnd(null); c.onMessageEnd({ message: { role: "assistant", content: 5 } }); settle(c); });
});

test("the extension registers on message_end and agent_before_settle only", () => {
  const seen = [];
  continuationExtension({ on: (name, fn) => { seen.push([name, typeof fn]); } });
  assert.deepEqual(seen, [["message_end", "function"], ["agent_before_settle", "function"]]);
});

test("the bench's variant C is the continuation variant of the shipped task set; D still needs a relaunch driver", () => {
  const set = loadTaskset(new URL("./taskset.json", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
  assert.equal(set.variants.C.continuation, true);
  assert.equal(set.variants.C.needs, undefined);
  assert.equal(set.variants.C.prompt, set.variants.B.prompt, "C is B plus the continuation");
  assert.match(set.variants.D.needs, /relaunch/);
});

test("the config comes from the built pi-adapter: the bound 3, the worker's mark and its fixed nudge words", async (t) => {
  if (!existsSync(new URL("../../packages/pi-adapter/dist/continuation.js", import.meta.url))) return t.skip("the repository is not built (npx tsc --build)");
  const cfg = await loadContinuationConfig();
  assert.equal(cfg.max, 3);
  assert.equal(cfg.mark, "[NimbleNewt: the turn goes on]");
  assert.match(cfg.nudge, /^Remaining: the unchecked steps of your PLAN\.md\./);
  assert.ok(cfg.lengthNudge.endsWith(cfg.nudge) && cfg.lengthNudge.startsWith("Your last reply was cut off"));
});
