// Tests for the bench's Radiance guard and batch loop (card W01). Offline: a fake fetch and a fake Pi config, no server.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { runBatch, spentTokens } from "./lib/batch.mjs";
import { offServerAgent } from "./run.mjs";
import { radianceConfig, radianceGate, radianceIdle, readRadiance, serverDelta, waitForIdle } from "./lib/radiance-gate.mjs";

const KEY = "test-key-not-real-0123456789";
const fakeHome = () => {
  const home = mkdtempSync(join(tmpdir(), "pi-eval-gate-"));
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { radiance: { baseUrl: "http://127.0.0.1:9/v1", apiKey: KEY } } }));
  return home;
};
const idle = { in_flight: 0, running: 0, waiting: 0, total_requests: 10, checkpoints_written: 1, secret_field: "x" };
const fakeFetch = (answers) => {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const a = answers[path];
    const body = typeof a === "function" ? a(calls.length) : a;
    if (body === undefined) return { ok: false, status: 404, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
  return { fn, calls };
};

test("idle only when in_flight, running and waiting are all stated and 0", () => {
  assert.equal(radianceIdle({ in_flight: 0, running: 0, waiting: 0 }).ok, true);
  assert.equal(radianceIdle({ in_flight: 1, running: 0, waiting: 0 }).ok, false);
  assert.equal(radianceIdle({ in_flight: 0, running: 0, waiting: 2 }).ok, false);
  const missing = radianceIdle({ in_flight: 0, running: 0 });
  assert.equal(missing.ok, false, "a missing count is busy, never idle");
  assert.match(missing.why, /waiting=missing/);
  assert.equal(radianceIdle({ in_flight: "0", running: 0, waiting: 0 }).ok, false, "a non-numeric count is busy");
  assert.equal(radianceIdle(undefined).ok, false);
});

test("the key comes from Pi's config and goes only into the Authorization header of the two GETs", async () => {
  const home = fakeHome();
  try {
    const cfg = radianceConfig(home);
    assert.equal(cfg.baseUrl, "http://127.0.0.1:9/v1");
    const f = fakeFetch({ "/stats": idle, "/v1/models": { data: [{ id: "m1" }, { id: "m2" }] } });
    const r = await readRadiance(cfg, { fetchImpl: f.fn });
    assert.deepEqual(f.calls.map((c) => `${c.init.method} ${c.url}`), ["GET http://127.0.0.1:9/stats", "GET http://127.0.0.1:9/v1/models"]);
    for (const c of f.calls) {
      assert.equal(c.init.headers.authorization, `Bearer ${KEY}`);
      assert.equal(c.init.redirect, "manual", "a redirect could carry the key elsewhere");
      assert.ok(!c.url.includes(KEY), "never in the URL");
      assert.equal(c.init.body, undefined, "a GET, nothing sent");
    }
    assert.deepEqual(r.models, ["m1", "m2"]);
    assert.equal(r.stats.secret_field, undefined, "only the named counters are kept");
    assert.ok(!JSON.stringify(r).includes(KEY), "the reading never holds the key");
    // A failed GET names the path and status only.
    const bad = fakeFetch({});
    await assert.rejects(readRadiance(cfg, { fetchImpl: bad.fn }), (e) => /GET \/stats answered 404/.test(e.message) && !e.message.includes(KEY));
    // No provider, no key: refused, and the message does not hold one.
    writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { radiance: { baseUrl: "x" } } }));
    assert.throws(() => radianceConfig(home), /no radiance provider with an apiKey/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("the gate waits for an idle server, refuses a model it does not serve at once, and gives up after the wait", async () => {
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  const now = () => clock;
  // Busy twice, then idle: waits two polls.
  let n = 0;
  const busyThenIdle = async () => ({ stats: ++n <= 2 ? { in_flight: 1, running: 1, waiting: 0 } : idle, models: ["m1"] });
  const a = await waitForIdle({ read: busyThenIdle, model: "m1", maxWaitMs: 600_000, pollMs: 60_000, sleep, now });
  assert.equal(a.ok, true);
  assert.equal(a.waitedMs, 120_000);
  // The pinned model not served: refused without waiting (the bench never loads or switches a model).
  clock = 0;
  const other = await waitForIdle({ read: async () => ({ stats: idle, models: ["other"] }), model: "m1", sleep, now });
  assert.equal(other.ok, false);
  assert.match(other.why, /does not serve m1; the bench never loads or switches a model/);
  assert.equal(other.waitedMs, 0);
  // Always busy: gives up within the wait.
  clock = 0;
  const busy = await waitForIdle({ read: async () => ({ stats: { in_flight: 0, running: 2, waiting: 1 }, models: ["m1"] }), model: "m1", maxWaitMs: 300_000, pollMs: 60_000, sleep, now });
  assert.equal(busy.ok, false);
  assert.match(busy.why, /still not idle after 5 min: .*running=2, waiting=1/);
  assert.ok(clock <= 300_000);
  // Unreadable: treated like busy (retried, then refused), never as idle.
  clock = 0;
  const down = await waitForIdle({ read: async () => { throw new Error("connect ECONNREFUSED"); }, model: "m1", maxWaitMs: 120_000, pollMs: 60_000, sleep, now });
  assert.equal(down.ok, false);
  assert.match(down.why, /could not be read \(connect ECONNREFUSED\)/);
  // A wait of 0 reads once and does not sleep.
  clock = 0;
  const once = await waitForIdle({ read: async () => ({ stats: { in_flight: 1, running: 0, waiting: 0 }, models: ["m1"] }), model: "m1", maxWaitMs: 0, sleep, now });
  assert.equal(once.ok, false);
  assert.equal(clock, 0);
});

test("radianceGate reads through Pi's config; the server delta counts requests and notices a restart", async () => {
  const home = fakeHome();
  try {
    let total = 10;
    const f = fakeFetch({ "/stats": () => ({ ...idle, total_requests: (total += 5) }), "/v1/models": { data: [{ id: "m1" }] } });
    const g = radianceGate({ model: "m1", home, fetchImpl: f.fn, maxWaitMs: 0 });
    const before = await g.before();
    assert.equal(before.ok, true);
    const after = await g.after();
    assert.deepEqual(serverDelta(before.reading, after), { requests: 5, checkpointsWritten: 0, prefixEvictions: null, restarted: false });
    assert.equal(serverDelta({ stats: { total_requests: 400 } }, { stats: { total_requests: 3 } }).restarted, true);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

const job = (id) => [{ id }, "A", 1];
const rec = (id, input, output) => ({ runId: id, tokens: { input, output, cacheRead: 9_999_999 } });

test("the batch stops starting runs once the token budget is spent, never cutting a run short", async () => {
  assert.equal(spentTokens(rec("x", 100, 20)), 120, "cache reads are not counted");
  const ran = [];
  const out = await runBatch({ jobs: [job("a"), job("b"), job("c"), job("d")], tokenBudget: 250, runJob: async (t) => { ran.push(t.id); return rec(t.id, 100, 20); } });
  assert.deepEqual(ran, ["a", "b", "c"], "a and b spend 240 < 250, so c starts; after c (360) nothing more starts");
  assert.equal(out.spent, 360);
  assert.match(out.stopped.reason, /token budget spent: 360 of 250/);
  assert.equal(out.stopped.remaining, 1);
  assert.equal(out.records[2].batchTokensSpent, 360);
  const all = await runBatch({ jobs: [job("a"), job("b")], runJob: async (t) => rec(t.id, 1, 1) });
  assert.equal(all.stopped, null);
  assert.equal(all.records.length, 2);
  await assert.rejects(runBatch({ jobs: [], tokenBudget: 0, runJob: async () => ({}) }), /token budget must be a positive number/);
});

test("with a gate, runs go one at a time, each run carries the readings, and a refusal stops the batch before its run", async () => {
  await assert.rejects(runBatch({ jobs: [job("a")], gate: { before: async () => ({ ok: true }), after: async () => null }, concurrency: 2, runJob: async () => ({}) }), /one at a time/);
  let answers = [true, true, false];
  let active = 0, maxActive = 0;
  const gate = {
    before: async () => { const ok = answers.shift(); return ok ? { ok, why: "idle", reading: { at: "t0", stats: idle, models: ["m1"] }, waitedMs: 0 } : { ok: false, why: "still not idle after 30 min: running=1" }; },
    after: async () => ({ at: "t1", stats: { ...idle, total_requests: 99 }, models: ["m1"] }),
  };
  const ran = [];
  const out = await runBatch({
    jobs: [job("a"), job("b"), job("c"), job("d")], gate,
    runJob: async (t) => { active++; maxActive = Math.max(maxActive, active); ran.push(t.id); await new Promise((r) => setTimeout(r, 5)); active--; return rec(t.id, 1, 1); },
  });
  assert.deepEqual(ran, ["a", "b"], "the third gate check refused: c is never started");
  assert.equal(maxActive, 1);
  assert.match(out.stopped.reason, /Radiance gate: still not idle/);
  assert.equal(out.stopped.remaining, 2);
  assert.deepEqual(out.records[0].server, { before: { at: "t0", stats: idle }, waitedMs: 0, after: { at: "t1", stats: { ...idle, total_requests: 99 } } }, "the model list is not stored");
  // The gate refuses the very first run: nothing runs at all.
  answers = [false];
  const none = await runBatch({ jobs: [job("a")], gate, runJob: async () => { throw new Error("must not run"); } });
  assert.equal(none.records.length, 0);
  assert.equal(none.stopped.remaining, 1);
});

test("an unread model list is never a confirmation, a gate needs a model, and a malformed Pi config does not quote the key", async () => {
  let clock = 0;
  const sleep = async (ms) => { clock += ms; };
  const now = () => clock;
  // Idle, but /v1/models unreadable: retried, then refused; never run on an unconfirmed model.
  const noList = await waitForIdle({ read: async () => ({ stats: idle, models: null }), model: "m1", maxWaitMs: 180_000, pollMs: 60_000, sleep, now });
  assert.equal(noList.ok, false);
  assert.match(noList.why, /model list \(GET \/v1\/models\) could not be read/);
  assert.equal(clock, 180_000, "polled like a busy server");
  // The list comes back on a later poll: then it runs.
  let k = 0;
  clock = 0;
  const later = await waitForIdle({ read: async () => ({ stats: idle, models: ++k < 2 ? null : ["m1"] }), model: "m1", maxWaitMs: 180_000, pollMs: 60_000, sleep, now });
  assert.equal(later.ok, true);
  assert.equal(later.waitedMs, 60_000);
  await assert.rejects(waitForIdle({ read: async () => ({ stats: idle, models: ["m1"] }), sleep, now }), /needs the pinned model/);
  const home = fakeHome();
  try {
    assert.throws(() => radianceGate({ home, fetchImpl: async () => { throw new Error("must not be called"); } }), /needs the pinned model/);
    // The key written without quotes: JSON.parse's own message would quote the text around it.
    writeFileSync(join(home, ".pi", "agent", "models.json"), `{"providers":{"radiance":{"apiKey": ${KEY}}}}`);
    assert.throws(() => radianceConfig(home), (e) => /could not be read as JSON/.test(e.message) && !e.message.includes(KEY.slice(0, 8)) && !String(e.stack).includes(KEY.slice(0, 8)));
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("with a gate the run asks again before its agent: a refusal there records nothing and stops; skipping the check is a fault", async () => {
  const reading = (tag) => ({ at: tag, stats: idle, models: ["m1"] });
  const answers = [{ ok: true, reading: reading("pre-a"), waitedMs: 1 }, { ok: true, reading: reading("agent-a"), waitedMs: 2 }, { ok: true, reading: reading("pre-b"), waitedMs: 0 }, { ok: false, why: "running=1", waitedMs: 5 }];
  const gate = { before: async () => answers.shift(), after: async () => reading("after") };
  // A runJob that calls beforeAgent the way runOne does.
  const runJob = async (t, v, r, { beforeAgent }) => {
    const g = await beforeAgent();
    if (!g.ok) return { runId: t.id, gateRefused: g.why, startedAt: null };
    return { ...rec(t.id, 1, 1), startedAt: "s" };
  };
  const written = [];
  const out = await runBatch({ jobs: [job("a"), job("b"), job("c")], gate, runJob, onRecord: async (x) => written.push(x.runId) });
  assert.deepEqual(written, ["a"], "the refused run b is no result and is not written");
  assert.equal(out.records.length, 1);
  assert.deepEqual(out.records[0].server, { before: { at: "agent-a", stats: idle }, waitedMs: 3, after: { at: "after", stats: idle } }, "the reading the agent started on");
  assert.match(out.stopped.reason, /Radiance gate: running=1/);
  assert.equal(out.stopped.remaining, 2, "b and c were not started");
  // A runJob that starts its agent without the check: the batch fails rather than run unguarded.
  const gate2 = { before: async () => ({ ok: true, reading: reading("x"), waitedMs: 0 }), after: async () => null };
  await assert.rejects(runBatch({ jobs: [job("a")], gate: gate2, runJob: async (t) => ({ ...rec(t.id, 1, 1), startedAt: "s" }) }), /without the Radiance gate's check before the agent/);
});

test("with a budget, a run whose token use is unknown stops the batch (the budget fails closed)", async () => {
  const ran = [];
  const out = await runBatch({ jobs: [job("a"), job("b"), job("c")], tokenBudget: 1_000_000, runJob: async (t) => { ran.push(t.id); return t.id === "a" ? { runId: "a", startedAt: "s", outcome: "error" } : { ...rec(t.id, 1, 1), startedAt: "s" }; } });
  assert.deepEqual(ran, ["a"]);
  assert.equal(out.records.length, 1, "the run itself is still recorded");
  assert.match(out.stopped.reason, /token use of run a is unknown/);
  assert.equal(out.stopped.remaining, 2);
  // A run that never started its agent (a bench error before it) spent nothing and does not stop the batch.
  const fine = await runBatch({ jobs: [job("a"), job("b")], tokenBudget: 1_000_000, runJob: async (t) => (t.id === "a" ? { runId: "a", startedAt: null, outcome: "error" } : { ...rec(t.id, 1, 1), startedAt: "s" }) });
  assert.equal(fine.stopped, null);
  assert.equal(fine.records.length, 2);
  // Without a budget, unknown use is no reason to stop.
  assert.equal((await runBatch({ jobs: [job("a"), job("b")], runJob: async (t) => ({ runId: t.id, startedAt: "s" }) })).stopped, null);
});

test("run.mjs gates every agent on Radiance except the bench's own off-server agents, the default Pi agent named or not", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  assert.equal(offServerAgent(join(here, "agents", "claude-agent.mjs")), true);
  assert.equal(offServerAgent(join(here, "agents", "fake-claude.mjs")), true);
  assert.equal(offServerAgent(join(here, "stub-agent.mjs")), true);
  assert.equal(offServerAgent(join(here, "pi-agent.mjs")), false, "the Pi agent named with --agent is still gated");
  assert.equal(offServerAgent(join(here, "agents", "..", "pi-agent.mjs")), false);
  assert.equal(offServerAgent("/usr/local/bin/my-pi-wrapper"), false, "an unknown agent is gated");
  const tmp = mkdtempSync(join(tmpdir(), "pi-eval-gate-cli-"));
  try {
    const dry = (...extra) => execFileSync(process.execPath, [join(here, "run.mjs"), "--dry-run", "--tasks", "quote-lines", "--variants", "A", "--repeats", "1", "--results", join(tmp, "r"), "--work-root", join(tmp, "w"), ...extra], { encoding: "utf8", stdio: "pipe" });
    assert.match(dry("--agent", join(here, "pi-agent.mjs")), /Radiance gate on/);
    assert.match(dry(), /Radiance gate on/);
    assert.match(dry("--agent", join(here, "agents", "claude-agent.mjs")), /Radiance gate off/);
    assert.match(dry("--agent", join(here, "pi-agent.mjs"), "--no-radiance-gate", "--concurrency", "2"), /Radiance gate off/);
    assert.throws(() => dry("--agent", join(here, "pi-agent.mjs"), "--concurrency", "2"), /one agent at a time/);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});
