// Card W04, bench variant C: the continuation extension apart from Pi (a fake runner calls its two handlers the way Pi does)
// and the config the runner reads from the built pi-adapter.
import assert from "node:assert/strict";
import { closeSync, existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, test } from "node:test";
import continuationExtension, { CHANNEL_KIND, CONTINUATION_CUSTOM_TYPE, commandLineConfig, commandLineText, createContinuation, readChannel, readConfig } from "./continuation-extension.mjs";
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
  assert.deepEqual({ ...c.counts }, { configured: true, max: 3, nudges: 3, lengthNudges: 1, endedByReport: false, errors: 0 });
});

test("a report that states done, partial or blocked ends the work: no nudge, and it is counted", () => {
  for (const t of ["Done. I changed lib.mjs and ran the tests.", "Done: changed lib.mjs; the tests pass.", "Partial. Steps 1 and 2 are done; step 3 needs a database.", "Blocked by a missing fixture.", "Not done: the fixture needs a database I cannot start here.", "**Result: partial**\n\nStep 3 is left."]) {
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
  // Pi's own outcome of the run counts too: an error or abort after a reply that would otherwise be continued.
  for (const outcome of ["error", "aborted"]) {
    const c = createContinuation({ config: CFG, file: null });
    c.onMessageEnd(reply(text("Next I'll try.")));
    assert.equal(c.onBeforeSettle({ type: "agent_before_settle", entries: [], continue: false, outcome }), undefined, outcome);
    assert.equal(c.counts.nudges, 0);
  }
  const ok = createContinuation({ config: CFG, file: null });
  ok.onMessageEnd(reply(text("Next I'll try.")));
  assert.equal(ok.onBeforeSettle({ type: "agent_before_settle", entries: [], continue: false, outcome: "completed" }).continue, true);
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
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")), { configured: true, max: 3, nudges: 0, lengthNudges: 0, endedByReport: false, errors: 0 });
  c.onMessageEnd(reply(text("SECRET-TEXT-OF-THE-AGENT. Next I'll go on.")));
  settle(c);
  const raw = readFileSync(file, "utf8");
  assert.deepEqual(JSON.parse(raw), { configured: true, max: 3, nudges: 1, lengthNudges: 0, endedByReport: false, errors: 0 });
  assert.doesNotMatch(raw, /SECRET|NUDGE|MARK/);
  assert.deepEqual(readContinuation(file), { configured: true, max: 3, nudges: 1, lengthNudges: 0, endedByReport: false, errors: 0 });
  writeFileSync(file, JSON.stringify({ configured: "yes", max: 3.5, nudges: -1, lengthNudges: "2", endedByReport: 1, errors: null, text: "x" }));
  assert.deepEqual(readContinuation(file), { configured: false, max: 0, nudges: 0, lengthNudges: 0, endedByReport: false, errors: 0 }, "only whole numbers and true flags are taken");
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
    assert.equal(c.counts.configured, false);
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
  const set = loadTaskset(fileURLToPath(new URL("./taskset.json", import.meta.url)));
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

// Card W04, nudge fix: the command-line agent has no work.end tool, so its nudge asks for the final report instead.
const WORKER = "Remaining: steps. When every step is done, end with nimblenewt__work-end as your last call. If you cannot go on, end with nimblenewt__work-end with result blocked or partial and say why in the report; do not report done for work that is not done. A reply without a tool call does not end the work.";

test("the command-line wording asks for a final report whose first line states the result, never names the work.end tool, and keeps the rest", () => {
  const t = commandLineText(WORKER);
  assert.doesNotMatch(t, /work[-._]end/i);
  assert.match(t, /end with a final report whose first line states the result \(done, partial or blocked\)\./);
  assert.match(t, /end with a final report whose first line states the result blocked or partial and says why;/);
  assert.match(t, /^Remaining: steps\. When every step is done, /);
  assert.match(t, /do not report done for work that is not done\. A reply that is not a final report does not end the work\.$/);
  const c = commandLineConfig({ max: 3, mark: "[M]", nudge: WORKER, lengthNudge: `Cut off. ${WORKER}` });
  assert.equal(c.wording, "command-line");
  assert.equal(c.max, 3);
  assert.equal(c.mark, "[M]");
  assert.equal(c.lengthNudge, `Cut off. ${t}`, "the cut-off lead is the worker's, unchanged");
});

test("a worker nudge that no longer has the replaced phrases is an error, not a silent pass-through", () => {
  assert.throws(() => commandLineText("Make the next tool call now."), /no longer has the phrase/);
  assert.throws(() => commandLineText(WORKER.replace("A reply without a tool call does not end the work.", "")), /no longer has the phrase/);
  assert.throws(() => commandLineConfig({ max: 3, mark: "[M]", nudge: "x", lengthNudge: "y" }), /no longer has/);
  // A worker text that names the tool somewhere the wording does not replace is refused: the agent is never told of it.
  assert.throws(() => commandLineText(`${WORKER} Call nimblenewt__work-end first.`), /still names the work.end tool/);
});

test("the shipped worker's real nudge turns into the command-line wording (the worker's own text stays as it is)", async (t) => {
  if (!existsSync(new URL("../../packages/pi-adapter/dist/continuation.js", import.meta.url))) return t.skip("the repository is not built (npx tsc --build)");
  const cfg = await loadContinuationConfig();
  assert.match(cfg.nudge, /nimblenewt__work-end as your last call/, "the worker's text still names its tool");
  const used = commandLineConfig(cfg);
  assert.doesNotMatch(`${used.nudge} ${used.lengthNudge}`, /work[-._]end/i);
  assert.equal(used.lengthNudge, commandLineText(cfg.lengthNudge));
  assert.ok(used.lengthNudge.startsWith("Your last reply was cut off"));
  assert.equal(used.max, 3);
});

test("the settings arrive on a descriptor: a regular file with the bench's kind is read and closed; anything else is left alone", (t) => {
  const f = join(dir, "channel.json");
  writeFileSync(f, JSON.stringify({ kind: CHANNEL_KIND, config: CFG, file: join(dir, "counts.json") }));
  const fd = openSync(f, "r");
  assert.deepEqual(readChannel(fd), { kind: CHANNEL_KIND, config: CFG, file: join(dir, "counts.json") });
  assert.throws(() => closeSync(fd), /EBADF/, "the descriptor was closed after reading");
  // Not the bench's file: left open and not used.
  writeFileSync(f, JSON.stringify({ kind: "other", config: CFG }));
  const other = openSync(f, "r");
  assert.equal(readChannel(other), null);
  closeSync(other);
  writeFileSync(f, "not json");
  const bad = openSync(f, "r");
  assert.equal(readChannel(bad), null);
  closeSync(bad);
  assert.equal(readChannel(987654), null, "a descriptor that is not open");
  assert.equal(readChannel(dir === "" ? 0 : 1), null, "a descriptor that is not a regular file of ours");
});

// Review of the nudge fix: what pi-agent.mjs hands the real Pi, seen by a fake Pi (no model, no sandbox). On Linux and macOS the
// settings arrive on descriptor 3 (read here as the extension does) and Pi's environment names no continuation file; on
// Windows they come through the environment. The runner's copy of the worker's words (it names the tool) is gone from the
// agent's output folder once read; a worker text the command-line wording cannot replace starts nothing (exit 2).
test("pi-agent.mjs: the settings reach Pi on descriptor 3 (environment on Windows), the worker-worded copy is removed, drift starts nothing", async () => {
  const { spawnSync } = await import("node:child_process");
  const out = join(dir, "pa-out");
  rmSync(out, { recursive: true, force: true });
  (await import("node:fs")).mkdirSync(out, { recursive: true });
  const seenFile = join(dir, "pa-seen.json");
  const fakePi = join(dir, "pa-fake-pi.mjs");
  const ext = new URL("./continuation-extension.mjs", import.meta.url).href;
  writeFileSync(fakePi, `import { writeFileSync } from "node:fs";\nimport { readChannel } from ${JSON.stringify(ext)};\nconst c = process.platform === "win32" ? null : readChannel(3);\nwriteFileSync(${JSON.stringify(seenFile)}, JSON.stringify({ channel: c, env: Object.keys(process.env).filter((k) => k.startsWith("PI_EVAL_CONTINUATION")), cfgEnv: process.env.PI_EVAL_CONTINUATION_CONFIG ?? null }));\n`);
  const worker = "Go on. When every step is done, end with nimblenewt__work-end as your last call. If you cannot go on, end with nimblenewt__work-end with result blocked or partial and say why in the report. A reply without a tool call does not end the work.";
  const cfgFile = join(out, "continuation-config.json");
  const start = (cfg) => {
    writeFileSync(cfgFile, JSON.stringify(cfg));
    rmSync(seenFile, { force: true });
    writeFileSync(join(out, "prompt.md"), "hello\n");
    return spawnSync(process.execPath, [fileURLToPath(new URL("./pi-agent.mjs", import.meta.url)), dir, join(out, "prompt.md"), join(out, "agent.jsonl")], {
      env: { PATH: process.env.PATH, PI_EVAL_PI_BIN: fakePi, PI_EVAL_CONTINUATION_CONFIG: cfgFile, PI_EVAL_CONTINUATION_FILE: join(out, "continuation.json") }, encoding: "utf8",
    });
  };
  const r = start({ max: 3, mark: "[M]", nudge: worker, lengthNudge: `Cut off. ${worker}` });
  assert.equal(r.status, 0, r.stderr);
  const seen = JSON.parse(readFileSync(seenFile, "utf8"));
  assert.equal(existsSync(cfgFile), false, "the worker-worded copy is not left where the agent can list it");
  const used = JSON.parse(readFileSync(join(out, "continuation-used.json"), "utf8"));
  assert.equal(used.wording, "command-line");
  assert.doesNotMatch(JSON.stringify(used), /work[-._]end/i);
  if (process.platform === "win32") {
    assert.equal(seen.cfgEnv, join(out, "continuation-used.json"));
  } else {
    assert.deepEqual(seen.env, [], "no continuation variable reaches Pi");
    assert.equal(seen.channel?.kind, CHANNEL_KIND);
    assert.equal(seen.channel.file, join(out, "continuation.json"));
    assert.equal(seen.channel.config.nudge, used.nudge);
    assert.doesNotMatch(JSON.stringify(seen.channel), /work[-._]end/i);
    assert.deepEqual((await import("node:fs")).readdirSync(out).filter((n) => n.startsWith(".channel")), [], "the hand-over file is unlinked");
  }
  // Drift: the worker's text lost a phrase the wording replaces. Nothing starts.
  const d = start({ max: 3, mark: "[M]", nudge: "Make the next tool call now.", lengthNudge: "Cut off." });
  assert.equal(d.status, 2, d.stderr);
  assert.match(d.stderr, /nothing was started/);
  assert.equal(existsSync(seenFile), false, "Pi was not started");
});
