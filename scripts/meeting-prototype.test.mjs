// Offline tests of the throwaway meeting prototype (card M00): the rules are checked against a scripted provider, no model, no network.
import assert from "node:assert/strict";
import { createServer, get as httpGet } from "node:http";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
// The offline guard replaces global fetch, so the slot check is given a plain loopback HTTP client.
const loopbackFetch = (url, { signal } = {}) => new Promise((resolve, reject) => {
  const req = httpGet(url, { signal }, (res) => { const chunks = []; res.on("data", (c) => chunks.push(c)); res.on("end", () => { const text = Buffer.concat(chunks).toString(); resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, json: async () => JSON.parse(text) }); }); });
  req.on("error", reject);
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
