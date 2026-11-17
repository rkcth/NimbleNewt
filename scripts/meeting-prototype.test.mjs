// Offline tests of the throwaway meeting prototype (card M00): the rules are checked against a scripted provider, no model, no network.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer, request as httpRequest } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, test } from "node:test";
import { pathToFileURL, fileURLToPath } from "node:url";

const proto = (p) => pathToFileURL(fileURLToPath(new URL(`../prototypes/meeting/${p}`, import.meta.url))).href;
const { runMeeting, chairQuestionRefused } = await import(proto("lib/meeting.mjs"));
const { Ledger } = await import(proto("lib/ledger.mjs"));
const { makeProvider } = await import(proto("lib/provider.mjs"));
const { checkSlots, slotsFree } = await import(proto("lib/local-slots.mjs"));
const readJson = (p) => JSON.parse(readFileSync(fileURLToPath(new URL(`../prototypes/meeting/${p}`, import.meta.url)), "utf8"));
const scenario = (n) => readJson(`scenarios/${n}.json`);
const variant = (n) => readJson(`variants/${n}.json`);

const dirs = [];
const tmp = () => { const d = mkdtempSync(join(tmpdir(), "nn-m00-")); dirs.push(d); return join(d, "run"); };
after(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });
// The offline guard replaces global fetch, so the slot check is given a plain loopback HTTP client. It sends the method the
// caller asked for (so the server below sees exactly what the slot check would send) and, like fetch with redirect "manual",
// does not follow redirects.
const loopbackFetch = (url, { method = "GET", signal } = {}) => new Promise((resolve, reject) => {
  const req = httpRequest(url, { method, signal }, (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) }); }); });
  req.on("error", reject);
  req.end();
});

// A scripted provider: every statement carries the speaker's name, every ballot reason carries a mark, and every prompt is kept.
function scripted(over = {}) {
  const fake = makeProvider({ kind: "fake" });
  const prompts = [];
  return {
    name: "scripted",
    prompts,
    async chat(req) {
      const task = req.hint?.task;
      const who = /You are (\w+),/.exec(`${req.user}\n${req.system}`)?.[1] ?? "chair";
      prompts.push({ task, who, system: req.system, user: req.user });
      const mine = over[task]?.(who, req);
      if (mine !== undefined) return { text: mine, finish: "stop", usage: { input: Math.ceil((req.system.length + req.user.length) / 4), cached: 0, output: 20 }, ms: 1 };
      if (task === "statement") return { text: `STANCE: ${req.hint.lean === "against" ? "against" : "for"}\nSTATEMENT: STMT_${who}${/You have now heard the others/.test(req.user) ? "_R2" : ""} says something concrete.\nTLDR: none`, finish: "stop", usage: { input: 100, cached: 0, output: 30 }, ms: 1 };
      if (task === "ballot") return { text: `VOTE: ${req.hint.lean === "against" ? "no" : "yes"}\nREASON: BREASON_${who}`, finish: "stop", usage: { input: 100, cached: 0, output: 20 }, ms: 1 };
      if (task === "objection") return { text: "OBJECT: no\nREASON: none", finish: "stop", usage: { input: 50, cached: 0, output: 10 }, ms: 1 };
      return fake.chat(req);
    },
  };
}
async function meet(sc, v, over, extra = {}) {
  const provider = scripted(over);
  const outDir = tmp();
  const summary = await runMeeting({ scenario: sc, variant: v, provider, ledger: new Ledger({ capTokens: 1e9 }), outDir, log: () => {}, ...extra });
  return { provider, summary, outDir };
}
const ownerAnswer = (who, req) => (/owner asks you directly/.test(req.user) ? `STANCE: for\nSTATEMENT: UNIQUEANSWER_${who} is a long distinctive answer for the owner only` : undefined);
const names = (sc) => sc.agents.map((a) => a.name);

test("a blind first round shows no member anything another member said", async () => {
  const sc = scenario("tool-adoption");
  const { provider } = await meet(sc, variant("m00-full"));
  const round1 = provider.prompts.filter((p) => p.task === "statement").slice(0, sc.agents.length);
  assert.equal(round1.length, sc.agents.length);
  for (const p of round1) {
    assert.match(p.user, /independent first round/);
    assert.ok(!/STMT_/.test(`${p.system}${p.user}`), "no statement is visible in the blind round");
  }
});

test("an open first round makes each speaker hear the earlier ones and only those", async () => {
  const sc = scenario("tool-adoption");
  const { provider } = await meet(sc, variant("open-two-rounds"));
  const round1 = provider.prompts.filter((p) => p.task === "statement").slice(0, sc.agents.length);
  round1.forEach((p, i) => {
    const seen = names(sc).filter((n) => p.user.includes(`STMT_${n} `));
    assert.deepEqual(seen, names(sc).slice(0, i), `speaker ${i} hears exactly the speakers before`);
  });
});

test("ballots reach no other voter, and are all revealed together at the close", async () => {
  const sc = scenario("tool-adoption");
  const { provider, summary, outDir } = await meet(sc, variant("m00-full"));
  assert.ok(!provider.prompts.some((p) => /BREASON_/.test(`${p.system}${p.user}`)), "no prompt ever carries a ballot reason");
  const file = JSON.parse(readFileSync(join(outDir, "ballots.json"), "utf8"));
  assert.equal(file.ballots.length, sc.agents.length);
  assert.equal(file.result.yes + file.result.no + file.result.abstain, sc.agents.length);
  assert.deepEqual(summary.result, file.result);
});

test("one comment round makes fewer calls than two, and a second round only exists in the two-round variant", async () => {
  const sc = scenario("tool-adoption");
  const one = await meet(sc, variant("m00-one-round"));
  const two = await meet(sc, variant("m00-full"));
  assert.ok(!one.summary.metrics.byPhase.round2);
  assert.equal(two.summary.metrics.byPhase.round2.calls, sc.agents.length);
  assert.ok(one.summary.metrics.calls < two.summary.metrics.calls);
});

test("the digest replaces earlier text for later speakers, while the full text is kept and retrievable", async () => {
  const sc = scenario("tool-adoption");
  const { provider, summary, outDir } = await meet(sc, variant("digest"), { digest: () => "DIGESTTEXT the chair's short account" });
  assert.deepEqual(summary.stats.digests.map((d) => d.step), ["after-round-1", "after-round-2"]);
  const round2 = provider.prompts.filter((p) => p.task === "statement" && /You have now heard the others/.test(p.user));
  assert.equal(round2.length, sc.agents.length);
  for (const p of round2) {
    assert.match(p.user, /DIGEST of #1 to #/);
    assert.match(p.user, /DIGESTTEXT/);
    assert.ok(!/STMT_\w+ says/.test(p.user.replace(/STMT_\w+_R2 says/g, "")), "round 1 statements are not repeated under the digest");
  }
  assert.ok(!/STMT_/.test(round2[0].user), "the first round-2 speaker sees only the digest");
  const full = JSON.parse(readFileSync(join(outDir, "transcript.json"), "utf8"));
  assert.ok(sc.agents.every((a) => full.some((e) => e.who === a.name && e.text.includes(`STMT_${a.name}`))), "the full statements are kept");
  assert.match(readFileSync(join(outDir, "transcript.md"), "utf8"), new RegExp(`STMT_${sc.agents[0].name}`));
  const chairDigest2 = provider.prompts.filter((p) => p.task === "digest")[1];
  assert.match(chairDigest2.user, /EARLIER DIGEST/, "the second digest builds on the first");
  assert.match(chairDigest2.user, new RegExp(`STMT_${sc.agents[0].name}`), "and the chair reads the full text");
});

test("a digest that is empty or far too long is refused and speakers keep the full text", async () => {
  const sc = scenario("tool-adoption");
  const { provider, summary } = await meet(sc, variant("digest"), { digest: () => Array(2000).fill("blah").join(" ") });
  assert.equal(summary.stats.digests, undefined);
  assert.equal(summary.stats.rejectedDigests.length, 2);
  const round2 = provider.prompts.filter((p) => p.task === "statement" && /You have now heard the others/.test(p.user));
  assert.equal(round2.length, sc.agents.length);
  assert.ok(round2.every((p) => !/DIGEST of/.test(p.user) && /STMT_/.test(p.user)));
});

test("shared-first order keeps one long identical prefix across members, agent-first does not", async () => {
  const sc = scenario("tool-adoption");
  const lcp = (a, b) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  const prefixes = async (name) => {
    const { provider } = await meet(sc, variant(name));
    const r2 = provider.prompts.filter((p) => p.task === "statement" && /You have now heard the others/.test(p.user)).slice(0, 2);
    // two different speakers in round 2 see different transcripts only by what has been said so far; compare the shared part
    return lcp(`${r2[0].system}${r2[0].user}`, `${r2[1].system}${r2[1].user}`);
  };
  const shared = await prefixes("m00-full");
  const first = await prefixes("agent-first-order");
  assert.ok(shared > first * 3, `shared-first prefix ${shared} against agent-first ${first}`);
});

test("the chair question check: keyword filter refuses on 'support', the structural one only on position fields and vote questions", () => {
  const ok = { to: "a1", topic: "what records support the figures", experience_sought: "the build times you measured" };
  assert.equal(chairQuestionRefused(ok, "words"), true, "the old filter refuses a legitimate question");
  assert.equal(chairQuestionRefused(ok, "structural"), false);
  assert.equal(chairQuestionRefused({ ...ok, position: "yes" }, "structural"), true, "an extra position field");
  assert.equal(chairQuestionRefused({ ...ok, stance: "for" }, "structural"), true);
  assert.equal(chairQuestionRefused({ to: "a1", topic: "your position", experience_sought: "how you will vote" }, "structural"), true);
  assert.equal(chairQuestionRefused({ to: "a1", topic: "tool", experience_sought: "are you for or against it" }, "structural"), true);
  assert.equal(chairQuestionRefused({ to: "a1", topic: "tool", experience_sought: "do you support it" }, "structural"), true);
  assert.equal(chairQuestionRefused({ to: "a1", topic: "tool", experience_sought: "how long it took" }, "structural"), false);
});

test("a chair question that survives the structural check is asked and answered in the meeting", async () => {
  const sc = scenario("tool-adoption");
  const q = { to: "a1", topic: "what records support the build figures", experience_sought: "measured minutes" };
  const asked = async (check) => (await meet(sc, { ...variant("m00-full"), chairQuestionCheck: check }, { "chair-questions": () => JSON.stringify({ questions: [q] }) })).summary.stats;
  assert.equal((await asked("words")).chairQuestions.length, 0);
  assert.equal((await asked("structural")).chairQuestions.length, 1);
});

test("an absent member is skipped, the chair read is of absent desks only and logged per file, and a present desk is refused", async () => {
  const sc = scenario("ship-absent");
  const { summary, provider } = await meet(sc, variant("m00-full"));
  const absent = sc.absent;
  assert.ok(absent.length > 0);
  assert.deepEqual(summary.stats.skippedAbsent.filter((x) => absent.includes(x)), absent);
  assert.ok(summary.stats.deskRead.refused.length >= 1, "the scripted attempt on a present member's desk is refused");
  assert.ok(summary.stats.deskRead.inspections.every((i) => absent.includes(i.member) && i.writes === 0));
  const ballotPrompts = provider.prompts.filter((p) => p.task === "ballot");
  assert.equal(ballotPrompts.length, summary.roster.length, "absent members cast no ballot");
});

test("tabling: a research request can postpone the motion with no ballots", async () => {
  const sc = scenario("tabling-benchmark");
  const { summary, provider } = await meet(sc, variant("m00-full"), {
    objection: (who) => (who === sc.agents[0].name ? "OBJECT: research\nREASON: the benchmark is pending" : "OBJECT: no\nREASON: none"),
    "chair-ruling": () => "RULING: table\nRESEARCH: Noor: run the heavy-job benchmark",
  });
  assert.equal(summary.result.outcome, "tabled");
  assert.deepEqual(summary.result.research, ["Noor: run the heavy-job benchmark"]);
  assert.equal(provider.prompts.filter((p) => p.task === "ballot").length, 0);
});

test("a tie is decided by one casting vote, not a double vote, and a fake tie fails with no answer", async () => {
  const sc = { ...scenario("tool-adoption"), agents: scenario("tool-adoption").agents.slice(0, 4) };
  sc.agents.forEach((a, i) => { a.lean = i % 2 ? "against" : "for"; });
  const yes = await meet(sc, { ...variant("one-round"), firstRound: "blind", chairQuestions: 0 }, { casting: () => "CASTING: yes\nREASON: tie" });
  assert.equal(yes.summary.result.yes, 2);
  assert.equal(yes.summary.result.no, 2);
  assert.equal(yes.summary.result.outcome, "passed (casting vote)");
  const none = await meet(sc, { ...variant("one-round"), firstRound: "blind", chairQuestions: 0 }, { casting: () => "no idea" });
  assert.equal(none.summary.result.outcome, "failed (tie, no casting vote)");
});

test("owner inquiry: the vote is held, answers are kept from other voters until the close, each earlier voter gets one revision turn, the clock pauses", async () => {
  const sc = scenario("ship-owner");
  const { summary, provider } = await meet(sc, variant("m00-full"), { statement: ownerAnswer });
  const inq = summary.stats.inquiries.find((i) => i.voteOpen);
  assert.ok(inq && inq.heldAnswers.length > 0, "an inquiry during the vote held its answers");
  assert.equal(summary.stats.inquiryChecks.leaks.length, 0);
  assert.equal(summary.stats.inquiryChecks.voterRevisionTurnsOk, true);
  assert.ok(summary.stats.inquiryChecks.clockMs.paused >= 0 && summary.stats.inquiryChecks.clockMs.meeting <= summary.stats.inquiryChecks.clockMs.total);
  assert.ok(provider.prompts.length > 0);
});

// The meeting clock is read once and clamped (total >= 0, 0 <= paused <= total, meeting = total - paused). These tests swap Date.now
// for a fake clock (no real time passes, no sleeps) and always put the real one back.
async function withClock(next, fn) { const real = Date.now; Date.now = next; try { return await fn(); } finally { Date.now = real; } }
const clockOf = (summary) => summary.stats.inquiryChecks.clockMs;
const ownerScenario = () => scenario("ship-owner");
const noInquiryScenario = () => ({ ...scenario("tool-adoption"), agents: scenario("tool-adoption").agents.slice(0, 4) });
const noInquiryVariant = () => ({ ...variant("one-round"), firstRound: "blind", chairQuestions: 0 });

test("clock: a clock that moves 1 ms on every read, with an owner inquiry, never gives meeting above total or a negative pause", async () => {
  let t = 1_000_000;
  const { summary } = await withClock(() => (t += 1), () => meet(ownerScenario(), variant("m00-full"), { statement: ownerAnswer }));
  assert.ok(summary.stats.inquiries.length > 0, "the owner inquiry ran");
  const c = clockOf(summary);
  assert.ok(c.paused >= 0 && c.paused <= c.total && c.meeting >= 0 && c.meeting <= c.total, JSON.stringify(c));
  assert.equal(c.meeting, c.total - c.paused);
  assert.ok(c.paused > 0 && c.total > 0, "the fake clock was read and the pause was counted");
});

test("clock: a clock that only moves backwards gives total 0, paused 0 and meeting 0", async () => {
  let t = 1_000_000;
  const { summary } = await withClock(() => (t -= 1000), () => meet(ownerScenario(), variant("m00-full"), { statement: ownerAnswer }));
  assert.ok(summary.stats.inquiries.length > 0, "the owner inquiry ran");
  assert.deepEqual(clockOf(summary), { total: 0, paused: 0, meeting: 0 });
});

test("clock: a pause longer than the whole meeting is cut to the total and the meeting time is 0", async () => {
  // First count the reads with a steady clock, then repeat with the same steps, except that the last read (the closing one) says the
  // meeting has lasted 1 ms, while the pauses already counted add up to far more than that.
  let reads = 0;
  await withClock(() => { reads += 1; return 1_000_000 + reads * 1000; }, () => meet(ownerScenario(), variant("m00-full"), { statement: ownerAnswer }));
  assert.ok(reads > 3, "the inquiry read the clock");
  let n = 0;
  const { summary } = await withClock(() => { n += 1; return n === reads ? 1_000_000 + 1000 + 1 : 1_000_000 + n * 1000; }, () => meet(ownerScenario(), variant("m00-full"), { statement: ownerAnswer }));
  assert.equal(n, reads, "the same number of reads in both runs");
  assert.deepEqual(clockOf(summary), { total: 1, paused: 1, meeting: 0 }, "this test assumes the closing clockMs read is the run's last Date.now() read; if a read was added after it, change which read is moved");
});

test("clock: with no owner inquiry nothing is paused, and total and meeting agree even while the clock moves", async () => {
  let t = 1_000_000;
  const { summary } = await withClock(() => (t += 1), () => meet(noInquiryScenario(), noInquiryVariant()));
  assert.equal(summary.stats.inquiries.length, 0);
  const c = clockOf(summary);
  assert.equal(c.paused, 0);
  assert.equal(c.meeting, c.total);
  assert.ok(c.total >= 0);
});

test("mutation drill: releasing held answers early is caught by the leak check", async () => {
  const sc = scenario("ship-owner");
  process.env.M00_MUTATE_LEAK = "1";
  try {
    const { summary } = await meet(sc, variant("m00-full"), { statement: ownerAnswer });
    assert.ok(summary.stats.inquiryChecks.leaks.length > 0, "the leak check sees the released answer");
  } finally { delete process.env.M00_MUTATE_LEAK; }
});

test("every transcript, ballot record and chair question is kept in the run directory", async () => {
  const { outDir } = await meet(scenario("tool-adoption"), variant("m00-full"));
  for (const f of ["transcript.md", "transcript.json", "ballots.json", "calls.jsonl", "summary.json"]) assert.ok(existsSync(join(outDir, f)), f);
  const summary = JSON.parse(readFileSync(join(outDir, "summary.json"), "utf8"));
  assert.ok(Array.isArray(summary.stats.chairQuestions) && Array.isArray(summary.stats.rejectedChairQuestions));
  assert.equal(readFileSync(join(outDir, "calls.jsonl"), "utf8").trim().split("\n").length, summary.metrics.calls);
});

test("the spend ledger adds up tokens and dollars and stops a run at the cap", async () => {
  const l = new Ledger({ capTokens: 1000, capUsd: 0.01, prices: { in: 2, cachedIn: 0.5, out: 8 } });
  const row = l.record({ usage: { input: 1000, cached: 400, output: 100 } });
  assert.ok(Math.abs(row.costUsd - (600 * 2 + 400 * 0.5 + 100 * 8) / 1e6) < 1e-12);
  assert.equal(l.tokens, 1100);
  assert.throws(() => l.assertRoom(0, 1), /token cap reached/);
  const d = new Ledger({ capUsd: 0.001 });
  d.spent = 0.0009;
  assert.throws(() => d.assertRoom(0.0002), /spend cap reached/);
  await assert.rejects(runMeeting({ scenario: scenario("tool-adoption"), variant: variant("m00-full"), provider: scripted(), ledger: new Ledger({ capTokens: 300 }), outDir: tmp(), log: () => {} }), /token cap reached/);
});

test("the cache hit rate is cached input over input, per phase and overall", async () => {
  const provider = { name: "c", async chat() { return { text: "STANCE: for\nSTATEMENT: x\nTLDR: none", finish: "stop", usage: { input: 200, cached: 50, output: 10 }, ms: 1 }; } };
  const sc = { ...scenario("tool-adoption"), agents: scenario("tool-adoption").agents.slice(0, 2) };
  const { summary } = await meetWith(sc, provider);
  assert.ok(Math.abs(summary.metrics.cacheHitRatio - 0.25) < 1e-9);
  assert.ok(Math.abs(summary.metrics.byPhase.round1.cached / summary.metrics.byPhase.round1.input - 0.25) < 1e-9);
});
async function meetWith(sc, provider) {
  const summary = await runMeeting({ scenario: sc, variant: { ...variant("one-round"), objectionCheck: false }, provider, ledger: new Ledger({ capTokens: 1e9 }), outDir: tmp(), log: () => {} });
  return { summary };
}

test("slot state: free only when enough slots are idle and empty; anything unreadable counts as busy", () => {
  const idle = { id: 0, is_processing: false, n_past: 0 };
  assert.equal(slotsFree([idle, idle], 2).ok, true);
  assert.equal(slotsFree([idle, { id: 1, is_processing: true }], 2).ok, false, "a processing slot");
  assert.equal(slotsFree([idle, { id: 1, is_processing: false, n_past: 812 }], 2).ok, false, "someone's cached conversation would be evicted");
  assert.equal(slotsFree([idle, { id: 1, is_processing: false, prompt: "hello" }], 2).ok, false);
  assert.equal(slotsFree([idle, { id: 1 }], 2).ok, false, "a slot with no state is unknown, so busy");
  assert.equal(slotsFree([], 1).ok, false);
  assert.equal(slotsFree("nope", 1).ok, false);
  assert.equal(slotsFree([null], 1).ok, false);
  assert.equal(slotsFree([idle], 2).ok, false, "fewer free slots than the run needs");
  assert.equal(slotsFree([{ id: 0, is_processing: false }], 1).ok, false, "idle but no cache count: whether it holds a conversation is unknown, so busy");
  assert.equal(slotsFree([{ id: 0, is_processing: false, n_past: "many" }], 1).ok, false, "a malformed cache count is busy, not zero");
  assert.equal(slotsFree([{ id: 0, is_processing: false, n_past: Number.NaN }], 1).ok, false);
  assert.equal(slotsFree([{ id: 0, is_processing: false, n_past: 0, next_token: { n_past: 40 } }], 1).ok, false, "any cache count above zero");
  assert.equal(slotsFree([{ id: 0, is_processing: "false", n_past: 0 }], 1).ok, false, "a processing flag that is not a plain false is busy");
  assert.equal(slotsFree([{ id: 0, state: 0, n_past: 0 }], 1).ok, true, "an older server's idle state with an empty cache");
  assert.equal(slotsFree([{ id: 0, state: 1, n_past: 0 }], 1).ok, false);
  assert.equal(slotsFree([{ id: 0, is_processing: false, prompt: "" }], 1).ok, true, "an empty prompt is a stated empty cache");
  for (const n of [0, -1, 1.5, Number.NaN]) assert.equal(slotsFree([idle, idle], n).ok, false, `needing ${n} slots is not a valid request`);
});

test("the slot check reads a loopback server's /slots, refuses a busy or broken one, and sends nothing but a GET of /slots", async () => {
  const seen = [];
  let reply = { status: 200, body: [{ id: 0, is_processing: false, n_past: 0 }, { id: 1, is_processing: false, n_past: 0 }] };
  const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.statusCode = reply.status; res.setHeader("content-type", "application/json"); res.end(typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body)); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    assert.equal((await checkSlots(base, 2, { fetchImpl: loopbackFetch })).ok, true);
    assert.equal((await checkSlots(`${base}/`, 2, { fetchImpl: loopbackFetch })).ok, true, "a trailing slash is fine");
    reply = { status: 200, body: [{ id: 0, is_processing: true }, { id: 1, is_processing: false, n_past: 0 }] };
    assert.equal((await checkSlots(base, 2, { fetchImpl: loopbackFetch })).ok, false);
    reply = { status: 500, body: { error: "x" } };
    assert.match((await checkSlots(base, 1, { fetchImpl: loopbackFetch })).why, /500/);
    reply = { status: 200, body: "not json" };
    assert.equal((await checkSlots(base, 1, { fetchImpl: loopbackFetch })).ok, false);
    reply = { status: 302, body: [{ id: 0, is_processing: false, n_past: 0 }] };
    assert.equal((await checkSlots(base, 1, { fetchImpl: loopbackFetch })).ok, false, "a redirect is a refusal, not followed");
    assert.deepEqual([...new Set(seen)], ["GET /slots"]);
  } finally { await new Promise((r) => server.close(r)); }
  const gone = await checkSlots(base, 1, { fetchImpl: loopbackFetch, timeoutMs: 2000 });
  assert.equal(gone.ok, false, "a server that is not there is a refusal, not a free pass");
});

test("a clear majority needs no casting vote, and a chair question to an absent member is skipped and recorded, not asked", async () => {
  const sc = { ...scenario("tool-adoption"), agents: scenario("tool-adoption").agents.slice(0, 4) };
  sc.agents.forEach((a, i) => { a.lean = i === 0 ? "against" : "for"; });
  const { summary } = await meet(sc, { ...variant("one-round"), chairQuestions: 0 }, { casting: () => "CASTING: no\nREASON: should not be asked" });
  assert.equal(summary.result.outcome, "passed");
  assert.equal(summary.result.castingVote, undefined);
  const ab = scenario("ship-absent");
  const q = { to: ab.absent[0], topic: "the payments figures", experience_sought: "what you measured" };
  const r = await meet(ab, variant("m00-full"), { "chair-questions": () => JSON.stringify({ questions: [q] }) });
  assert.equal(r.summary.stats.chairQuestions.length, 0);
  assert.ok(r.summary.stats.skippedAbsent.includes(`chair question to ${ab.absent[0]}`));
});

test("the runner's slot check refuses a busy server before anything else: exit code 3, no provider, the budget file untouched", async () => {
  const seen = [];
  const server = createServer((req, res) => { seen.push(`${req.method} ${req.url}`); res.setHeader("content-type", "application/json"); res.end(JSON.stringify([{ id: 0, is_processing: true, n_past: 900 }])); });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const dir = mkdtempSync(join(tmpdir(), "nn-m00-")); dirs.push(dir);
  const budget = join(dir, "budget.json");
  const before = JSON.stringify({ tokens: 123, usd: 0.5, runs: 7 });
  writeFileSync(budget, before);
  const runner = fileURLToPath(new URL("../prototypes/meeting/run.mjs", import.meta.url));
  try {
    // The provider points at a closed loopback port and sends nothing when built; the refusal must come before any call and before the budget is written.
    const { code, stdout } = await new Promise((resolve) => execFile(process.execPath, [runner, "--variant", "m00-full", "--provider", "openai", "--model", "m", "--base-url", "http://127.0.0.1:9", "--no-auth", "--check-slots", `http://127.0.0.1:${server.address().port}`, "--budget", budget], { timeout: 120000 }, (err, stdout) => resolve({ code: err ? err.code : 0, stdout })));
    assert.equal(code, 3, stdout);
    assert.match(stdout, /Slot check: REFUSED/);
    assert.equal(readFileSync(budget, "utf8"), before, "a refused run leaves the owner's budget record as it was");
    assert.ok(seen.every((s) => s === "GET /slots"), seen.join(", "));
  } finally { await new Promise((r) => server.close(r)); }
});

test("in digest mode the chair still reads the full text for its later calls, while members read the digest", async () => {
  const sc = { ...scenario("tool-adoption"), agents: scenario("tool-adoption").agents.slice(0, 4) };
  sc.agents.forEach((a, i) => { a.lean = i % 2 ? "against" : "for"; });
  const { provider, summary } = await meet(sc, { ...variant("digest"), chairQuestions: 0 }, { digest: () => "DIGESTTEXT short", casting: () => "CASTING: yes\nREASON: tie" });
  assert.equal(summary.result.outcome, "passed (casting vote)");
  const casting = provider.prompts.find((p) => p.task === "casting");
  assert.ok(!/DIGEST of/.test(casting.user), "the chair's casting call is not given the digest in place of the text");
  assert.match(casting.user, new RegExp(`STMT_${sc.agents[0].name} says`), "the chair reads the round 1 statements in full");
  const ballot = provider.prompts.find((p) => p.task === "ballot");
  assert.match(ballot.user, /DIGEST of #1 to #/, "members vote with the digest");
});

// Third local batch (Radiance): the idle check reads /stats, the key comes from Pi's config and goes only into the Authorization header.
const radianceLib = await import(proto("lib/radiance.mjs"));
test("Radiance idle check: idle only when in_flight, running and waiting are all stated as 0; the server delta and sessions add up", () => {
  const { radianceIdle, sessionsOf, serverDelta, serverRoot } = radianceLib;
  assert.equal(radianceIdle({ in_flight: 0, running: 0, waiting: 0 }).ok, true);
  for (const s of [{ in_flight: 1, running: 0, waiting: 0 }, { in_flight: 0, running: 0, waiting: 2 }, { in_flight: 0, running: 0 }, { in_flight: "0", running: 0, waiting: 0 }, {}, null, undefined]) assert.equal(radianceIdle(s).ok, false, JSON.stringify(s));
  assert.deepEqual(sessionsOf({ sessions: [{ snapshots: 2, tokens: 4000 }, { snapshots: 5, tokens: 12000 }, {}] }), { count: 3, snapshots: 7, tokens: 16000 });
  assert.deepEqual(sessionsOf({}), { count: 0, snapshots: 0, tokens: 0 });
  const d = serverDelta({ stats: { total_requests: 10, checkpoints_written: 5, ckpt_evictions: { retention: 1, store_full: 0 } }, sessions: { count: 4, snapshots: 9 } }, { stats: { total_requests: 30, checkpoints_written: 12, ckpt_evictions: { retention: 4, store_full: 0 } }, sessions: { count: 6, snapshots: 11 } });
  assert.deepEqual(d, { requests: 20, checkpointsWritten: 7, evictionsRetention: 3, evictionsStoreFull: 0, sessionsBefore: 4, sessionsAfter: 6, snapshotsBefore: 9, snapshotsAfter: 11 });
  assert.equal(serverRoot("http://127.0.0.1:8002/v1/"), "http://127.0.0.1:8002");
});

async function radianceStandIn(statsBody, { delayMs = 0 } = {}) {
  const seen = [];
  const chat = { inFlight: 0, maxInFlight: 0 };
  const KEY = "test-key-7f3a9c1e5b2d";
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ method: req.method, url: req.url, auth: req.headers.authorization, body: Buffer.concat(chunks).toString() });
      res.setHeader("content-type", "application/json");
      if (req.url === "/stats") return res.end(JSON.stringify({ ...statsBody, total_requests: seen.length, checkpoints_written: 3, ckpt_evictions: { retention: 0, store_full: 0 } }));
      if (req.url === "/sessions") return res.end(JSON.stringify({ sessions: [{ snapshots: 1, tokens: 2048 }] }));
      if (req.url === "/v1/chat/completions") { chat.inFlight += 1; chat.maxInFlight = Math.max(chat.maxInFlight, chat.inFlight); }
      const answer = (body) => setTimeout(() => { if (req.url === "/v1/chat/completions") chat.inFlight -= 1; res.end(body); }, req.url === "/v1/chat/completions" ? delayMs : 0);
      if (req.url === "/v1/chat/completions") return answer(JSON.stringify({ choices: [{ finish_reason: "stop", message: { content: 'STANCE: for\nSTATEMENT: fine as written\nTLDR: none\nVOTE: yes\nOBJECT: no\nRULING: proceed\nREASON: fine\n{"questions":[],"excerpts":[]}' } }], usage: { prompt_tokens: 3000, completion_tokens: 400, prompt_tokens_details: { cached_tokens: 2048 }, completion_tokens_details: { reasoning_tokens: 360 } } }));
      res.statusCode = 404; res.end("{}");
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const home = mkdtempSync(join(tmpdir(), "nn-m00-home-")); dirs.push(home);
  const { mkdirSync } = await import("node:fs");
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });
  writeFileSync(join(home, ".pi", "agent", "models.json"), JSON.stringify({ providers: { radiance: { baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: KEY } } }));
  // The offline guard (when loaded) blocks fetch in the child runner, loopback included; this preload gives the child a fetch that
  // reaches loopback addresses only, through node:http, so the tripwire still holds for anything else.
  writeFileSync(join(home, "loopback-fetch.mjs"), `import { request } from "node:http";
globalThis.fetch = (url, { method = "GET", headers = {}, body } = {}) => new Promise((resolve, reject) => {
  const u = new URL(url);
  if (u.hostname !== "127.0.0.1" && u.hostname !== "localhost") return reject(new Error("loopback only in this test"));
  const req = request(u, { method, headers }, (res) => { const c = []; res.on("data", (d) => c.push(d)); res.on("end", () => { const t = Buffer.concat(c).toString(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(t), text: async () => t }); }); });
  req.on("error", reject);
  if (body) req.write(body);
  req.end();
});
`);
  return { server, seen, home, KEY, chat };
}
// The children find Pi's config through os.homedir(), which reads HOME on Linux and macOS but USERPROFILE on Windows, so both point
// at the fake home (Windows CI run 44041210187 read the runner's real, absent home when only HOME was set).
const fakeHomeEnv = (home) => ({ ...process.env, HOME: home, USERPROFILE: home });
const runRadiance = (home, budget, extra = []) => new Promise((resolve) => execFile(process.execPath, ["--import", pathToFileURL(join(home, "loopback-fetch.mjs")).href, fileURLToPath(new URL("../prototypes/meeting/run.mjs", import.meta.url)), "--scenario", "ship-or-delay", "--variant", "m00-one-round-p1", "--provider", "radiance", "--model", "m", "--budget", budget, "--runs-dir", join(home, "runs"), "--quiet", ...extra], { timeout: 120000, env: fakeHomeEnv(home) }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test("Radiance runner: a busy server is refused before any chat request, with exit code 3 and the budget file untouched", async () => {
  const { server, seen, home } = await radianceStandIn({ in_flight: 0, running: 1, waiting: 0 });
  try {
    const budget = join(home, "budget.json");
    const { code, stdout } = await runRadiance(home, budget);
    assert.equal(code, 3);
    assert.match(stdout, /Radiance check: REFUSED .*running=1/);
    assert.equal(existsSync(budget), false);
    assert.ok(seen.every((r) => r.method === "GET" && (r.url === "/stats" || r.url === "/sessions")), JSON.stringify(seen.map((r) => r.url)));
  } finally { server.close(); }
});

test("Radiance runner: on an idle server the meeting runs, reasoning tokens are recorded, server.json is written, and the key is only ever in the Authorization header", async () => {
  const { server, seen, home, KEY } = await radianceStandIn({ in_flight: 0, running: 0, waiting: 0 });
  let outDir;
  try {
    const budget = join(home, "budget.json");
    const { code, stdout, stderr } = await runRadiance(home, budget, ["--fixed-max", "777", "--effort", "low"]);
    assert.equal(code, 0, stderr);
    outDir = /Output: (.*)$/m.exec(stdout)[1].trim();
    const chats = seen.filter((r) => r.url === "/v1/chat/completions");
    assert.ok(chats.length > 0);
    for (const r of seen) assert.equal(r.auth, `Bearer ${KEY}`);
    for (const r of chats) { const b = JSON.parse(r.body); assert.equal(b.max_tokens, 777); assert.equal(b.reasoning_effort, "low"); assert.equal(r.body.includes(KEY), false); }
    const calls = readFileSync(join(outDir, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.ok(calls.every((c) => c.usage.reasoning === 360 && c.usage.cached === 2048));
    const srv = JSON.parse(readFileSync(join(outDir, "server.json"), "utf8"));
    assert.equal(srv.delta.requests, chats.length + 2, "the after reading counts every request since the before reading");
    const { readdirSync } = await import("node:fs");
    for (const f of readdirSync(outDir)) assert.equal(readFileSync(join(outDir, f), "utf8").includes(KEY), false, f);
    assert.equal(readFileSync(budget, "utf8").includes(KEY), false);
    assert.equal(stdout.includes(KEY), false);
    const { reportRun } = await import(proto("radiance-report.mjs"));
    const row = reportRun(outDir);
    assert.equal(row.reuseAllMultiplesOf2048, true);
    assert.equal(row.visibleMedian, 40);
    assert.equal(row.reasoningPctOfOutput, 90);
  } finally { server.close(); if (outDir) rmSync(outDir, { recursive: true, force: true }); }
});

// Review of the third local batch: the idle check is on every route to Radiance, and calls to it go one at a time.
const runProto = (home, script, argv) => new Promise((resolve) => execFile(process.execPath, ["--import", pathToFileURL(join(home, "loopback-fetch.mjs")).href, fileURLToPath(new URL(`../prototypes/meeting/${script}`, import.meta.url)), ...argv], { timeout: 120000, env: fakeHomeEnv(home) }, (err, stdout, stderr) => resolve({ code: err ? err.code : 0, stdout, stderr })));

test("Radiance idle check on the other routes: checkpoint.mjs --spec radiance: and a mixed roster with a radiance: chair or member are refused on a busy server before any chat request", async () => {
  const { server, seen, home } = await radianceStandIn({ in_flight: 1, running: 0, waiting: 0 });
  try {
    const budget = join(home, "budget.json");
    const runs = [
      ["checkpoint.mjs", ["--spec", "radiance:m", "--budget", budget]],
      ["run.mjs", ["--scenario", "ship-or-delay", "--variant", "m00-one-round-p1", "--chair", "radiance:m", "--budget", budget, "--runs-dir", join(home, "runs"), "--quiet"]],
      ["run.mjs", ["--scenario", "ship-or-delay", "--variant", "m00-one-round-p1", "--chair", "pi:none", "--members", "a1=radiance:m", "--budget", budget, "--runs-dir", join(home, "runs"), "--quiet"]],
      // the generic OpenAI-compatible route pointed at the same server, with another spelling of the loopback host
      ["run.mjs", ["--scenario", "ship-or-delay", "--variant", "m00-one-round-p1", "--provider", "openai", "--model", "m", "--base-url", `http://localhost:${server.address().port}/v1`, "--no-auth", "--budget", budget, "--runs-dir", join(home, "runs"), "--quiet"]],
    ];
    for (const [script, argv] of runs) {
      const { code, stdout, stderr } = await runProto(home, script, argv);
      assert.equal(code, 3, `${script} ${argv.join(" ")}: ${stderr}`);
      assert.match(stdout, /Radiance check: REFUSED .*in_flight=1/);
    }
    assert.equal(existsSync(budget), false);
    assert.ok(seen.length >= 3 && seen.every((r) => r.method === "GET" && (r.url === "/stats" || r.url === "/sessions")), JSON.stringify(seen.map((r) => r.url)));
  } finally { server.close(); }
});

test("Radiance calls go one at a time even when the variant asks for parallel calls (blind-first, parallel 4)", async () => {
  const { server, seen, home, chat } = await radianceStandIn({ in_flight: 0, running: 0, waiting: 0 }, { delayMs: 40 });
  let outDir;
  try {
    const { code, stdout, stderr } = await runProto(home, "run.mjs", ["--scenario", "ship-or-delay", "--variant", "blind-first", "--provider", "radiance", "--model", "m", "--budget", join(home, "budget.json"), "--runs-dir", join(home, "runs"), "--quiet"]);
    assert.equal(code, 0, stderr);
    outDir = /Output: (.*)$/m.exec(stdout)[1].trim();
    assert.ok(seen.filter((r) => r.url === "/v1/chat/completions").length > 3);
    assert.equal(chat.maxInFlight, 1);
  } finally { server.close(); if (outDir) rmSync(outDir, { recursive: true, force: true }); }
});

test("Radiance runs are written under --runs-dir, never among the real runs; the OpenAI route to the Radiance address is idle-checked and serialized; isRadianceAddress matches only that server", async () => {
  const { isRadianceAddress } = radianceLib;
  const { server, seen, home, chat } = await radianceStandIn({ in_flight: 0, running: 0, waiting: 0 }, { delayMs: 40 });
  const realRuns = fileURLToPath(new URL("../prototypes/meeting/runs/", import.meta.url));
  const { readdirSync } = await import("node:fs");
  const before = existsSync(realRuns) ? readdirSync(realRuns).length : 0;
  try {
    const port = server.address().port;
    assert.equal(isRadianceAddress(`http://localhost:${port}/v1`, home), true);
    assert.equal(isRadianceAddress(`http://127.0.0.1:${port}`, home), true);
    assert.equal(isRadianceAddress(`http://127.0.0.1:${port + 1}/v1`, home), false);
    // other spellings of this machine reach the same server (it listens on every interface); look-alike hosts do not
    for (const h of ["127.0.0.2", "0.0.0.0", "[::1]", "[::]", "[::ffff:127.0.0.1]", "localhost.", "a.localhost", hostname()]) assert.equal(isRadianceAddress(`http://${h}:${port}/v1`, home), true, h);
    for (const u of [`http://localhost.evil:${port}/v1`, `http://127.0.0.1.example.com:${port}/v1`, `http://127.0.0.1:${port}@example.com/v1`, `http://[::ffff:8.8.8.8]:${port}/v1`, `http://128.0.0.1:${port}/v1`, `http://localhostx:${port}/v1`]) assert.equal(isRadianceAddress(u, home), false, u);
    assert.equal(isRadianceAddress("https://openrouter.ai/api/v1", home), false);
    assert.equal(isRadianceAddress(undefined, home), false);
    assert.equal(isRadianceAddress(`http://127.0.0.1:${port}/v1`, join(home, "no-such-home")), false);
    const runsDir = join(home, "runs");
    const { code, stdout, stderr } = await runProto(home, "run.mjs", ["--scenario", "ship-or-delay", "--variant", "blind-first", "--provider", "openai", "--model", "m", "--base-url", `http://localhost:${port}/v1`, "--no-auth", "--runs-dir", runsDir, "--budget", join(home, "budget.json"), "--quiet"]);
    assert.equal(code, 0, stderr);
    assert.match(stdout, /Radiance check: idle/);
    const outDir = /Output: (.*)$/m.exec(stdout)[1].trim();
    assert.equal(dirname(outDir), runsDir);
    assert.ok(existsSync(join(outDir, "server.json")));
    assert.equal(seen[0].url, "/stats", "the idle check comes before any chat request");
    assert.ok(seen.filter((r) => r.url === "/v1/chat/completions").length > 3);
    assert.equal(chat.maxInFlight, 1);
    assert.equal(existsSync(realRuns) ? readdirSync(realRuns).length : 0, before, "nothing written among the real runs");
  } finally { server.close(); }
});

test("oneAtATime: a second call starts only after the first has ended, and a failed call does not stop the next one", async () => {
  const { oneAtATime } = radianceLib;
  let inFlight = 0, max = 0;
  const order = [];
  const inner = { name: "x", async chat({ id, fail }) { inFlight += 1; max = Math.max(max, inFlight); order.push(`start ${id}`); await new Promise((r) => setImmediate(r)); inFlight -= 1; order.push(`end ${id}`); if (fail) throw new Error("boom"); return { id }; } };
  const p = oneAtATime(inner);
  assert.equal(p.name, "x");
  const results = await Promise.allSettled([p.chat({ id: 1 }), p.chat({ id: 2, fail: true }), p.chat({ id: 3 })]);
  assert.deepEqual(results.map((r) => r.status), ["fulfilled", "rejected", "fulfilled"]);
  assert.equal(max, 1);
  assert.deepEqual(order, ["start 1", "end 1", "start 2", "end 2", "start 3", "end 3"]);
});
