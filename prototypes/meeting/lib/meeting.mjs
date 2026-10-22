// The meeting protocol (owner decisions 2026-10-22), as a throwaway prototype. One speaker at a time
// holds the baton; every turn is a separate tool-less model call; ballots are individual and are
// revealed together at the close. This file is not shipped; it exists to find where the rules fail.
import { mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const words = (tokens) => Math.max(20, Math.round(tokens * 0.7));

const PREAMBLE = [
  "You are a participant in a short, orderly team meeting. Only one person speaks at a time.",
  "Be concise and concrete. Use only what you actually know from your own background and notes;",
  "do not invent facts, numbers or experiences. Follow the requested output format exactly.",
].join(" ");

export async function runMeeting({ scenario, variant, provider, providers = {}, ledger, outDir, headroom = 0, log = () => {} }) {
  mkdirSync(outDir, { recursive: true });
  const callsPath = join(outDir, "calls.jsonl");
  const agents = scenario.agents;
  const byId = new Map(agents.map((a) => [a.id, a]));
  const tokenLimit = variant.tokenLimit ?? 220;
  let motion = { text: scenario.motion, version: 1 };
  const transcript = []; // visible to later speakers under the baton rule
  const ballots = []; // the ballot record: never delivered to another participant while the vote is open
  const stats = { objections: [], chairQuestions: [], rejectedChairQuestions: [] };

  const common = () => `${PREAMBLE}\n\nMOTION (version ${motion.version}): ${motion.text}\n\n${scenario.context ?? ""}`.trim();
  const personaOf = (a) => `You are ${a.name}, ${a.role}. ${a.persona}${variant.richPersonas && a.temperament ? ` Your temperament: ${a.temperament}. Your habits: ${a.habits}.` : ""}`;

  function view(mode = variant.transcriptMode ?? "full") {
    if (transcript.length === 0) return "(Nothing has been said yet.)";
    const tail = variant.fullTail ?? 0;
    return transcript.map((e, i) => {
      const recent = i >= transcript.length - tail;
      const short = e.text.split(/\s+/).length <= (variant.summarizeAbove ?? 0);
      const body = mode === "tldr" && !recent && e.tldr && !short ? `(summary) ${e.tldr}` : e.text;
      return `[#${e.seq} ${e.who}${e.label ? ` — ${e.label}` : ""}] ${body}`;
    }).join("\n");
  }

  function prompt(agent, instruction, { transcriptText, extra = "" } = {}) {
    const tx = `MEETING SO FAR:\n${transcriptText ?? view()}`;
    if ((variant.promptOrder ?? "shared-first") === "agent-first") {
      return { system: `${personaOf(agent)}\n\n${common()}`, user: `${tx}\n\n${extra}${instruction}` };
    }
    // shared-first: everything identical across agents comes first, the agent-specific part last
    return { system: common(), user: `${tx}\n\n${personaOf(agent)}\n${extra}${instruction}` };
  }

  async function call({ phase, agent, task, system, user, maxTokens, hint }) {
    ledger.assertRoom(0.002);
    // A roster may mix models: each member answers through its own provider, the chair through the chair's.
    const p = agent?.id === "chair" ? (providers.chair ?? provider) : (providers.byAgent?.[agent?.id] ?? provider);
    const r = await p.chat({ system, user, maxTokens: maxTokens + headroom, hint: { ...hint, task } });
    const row = ledger.record({ phase, agent: agent?.id, task, model: p.name, usage: r.usage, ms: r.ms, finish: r.finish });
    appendFileSync(callsPath, JSON.stringify(row) + "\n");
    log(`${phase} ${agent?.id ?? "chair"} in=${r.usage.input} cached=${r.usage.cached} out=${r.usage.output} $${ledger.spent.toFixed(4)}`);
    return r;
  }

  const pick = (re, text) => re.exec(text)?.[1]?.trim();
  function parseStatement(text) {
    const stance = (pick(/STANCE:\s*(for|against|undecided)/i, text) ?? "unknown").toLowerCase();
    const body = pick(/STATEMENT:\s*([\s\S]*?)(?:\nTLDR:|$)/i, text) ?? text.trim();
    const tldr = pick(/TLDR:\s*([\s\S]*)$/i, text) ?? (variant.tldrStyle === "facts" ? "none" : body.split(/\s+/).slice(0, 25).join(" "));
    const clean = tldr.replace(/\s+/g, " ").trim();
    return { stance, text: body, tldr: /^none\.?$/i.test(clean) ? undefined : clean };
  }
  const push = (who, kind, text, extra = {}) => {
    const e = { seq: transcript.length + 1, who, kind, text, ...extra };
    transcript.push(e);
    return e;
  };

  const summarizeAbove = variant.summarizeAbove ?? 70;
  const summaryWords = variant.summaryWords ?? 60;
  const FORMAT = variant.tldrStyle === "facts"
    ? `Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: <if your statement is brief, write none; otherwise summarize your thoughts into one brief paragraph, remembering to include important points or details that you want the group to know>`
    : `Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: <one sentence, at most 25 words>`;
  const deskText = (a) => (variant.deskCheck && a.desk?.length ? `Notes you looked up on your own desk:\n${a.desk.map((d) => `- ${d}`).join("\n")}\n\n` : "");

  async function turn(agent, phase, instruction, { blind = false, desk = false } = {}) {
    const { system, user } = prompt(agent, instruction, {
      transcriptText: blind ? "(This is the independent first round: you have not heard anyone else.)" : undefined,
      extra: desk ? deskText(agent) : "",
    });
    const r = await call({ phase, agent, task: "statement", system, user, maxTokens: tokenLimit, hint: { lean: agent.lean } });
    const p = parseStatement(r.text);
    return { agent, ...p };
  }

  async function parallel(items, limit, fn) {
    const out = new Array(items.length);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) { const i = next++; out[i] = await fn(items[i]); }
    }));
    return out;
  }

  // Rolling chair notes: after each statement the chair updates short notes, so no single call holds the whole pile.
  let chairNotes = "";
  const chairPersona = { id: "chair", name: "Chair", role: "the meeting chair", persona: "You run the meeting and keep it brief. You ask only factual questions that help the group decide." };
  async function updateNotes(entry) {
    if (variant.chairNotes !== "rolling") return;
    const { system, user } = prompt(chairPersona, `YOUR PRIVATE NOTES SO FAR:\n${chairNotes || "(none yet)"}\n\nNEW STATEMENT, full text, from ${entry.who} (${entry.label ?? ""}):\n${entry.text}\n\nUpdate your notes. One short entry per speaker: key claims and evidence, anything they could not answer or left unclear, and follow-up factual questions you may want to ask (never how anyone will vote). Keep the notes under 400 words and output the complete updated notes.`, { transcriptText: "(Not needed for this step: you have the notes and the new statement.)" });
    const r = await call({ phase: "chair-notes", agent: chairPersona, task: "chair-notes", system, user, maxTokens: 600, hint: {} });
    chairNotes = r.text.trim();
  }

  push("Chair", "motion", `Motion (version ${motion.version}): ${motion.text}`, { label: "opening" });

  // Round 1: open (sequential, each hears the earlier speakers) or blind (independent, in parallel).
  const r1 = `Give your position on the motion in at most ${words(tokenLimit)} words. ${FORMAT}`;
  if (variant.firstRound === "blind") {
    const results = await parallel(agents, variant.parallel ?? 4, (a) => turn(a, "round1-blind", r1, { blind: true, desk: variant.deskFromStart === true }));
    for (const r of results) await updateNotes(push(r.agent.name, "statement", r.text, { tldr: r.tldr, stance: r.stance, label: "round 1 (blind)", agent: r.agent.id }));
  } else {
    for (const a of agents) {
      const r = await turn(a, "round1", r1, { desk: variant.deskFromStart === true });
      await updateNotes(push(a.name, "statement", r.text, { tldr: r.tldr, stance: r.stance, label: "round 1", agent: a.id }));
    }
  }

  // The chair reads the full statements (never only summaries) and keeps private notes for its follow-up questions.
  if (variant.chairNotes === true) {
    const chair = { id: "chair", name: "Chair", role: "the meeting chair", persona: "You run the meeting and keep it brief. You ask only factual questions that help the group decide." };
    const { system, user } = prompt(chair, `Read the full statements above. Keep private notes for yourself, briefly: for each speaker, their key claims and evidence, anything they could not answer or left unclear, and the follow-up factual questions you may want to ask (facts and experience only, never how anyone will vote).`, { transcriptText: view("full") });
    const r = await call({ phase: "chair-notes", agent: chair, task: "chair-notes", system, user, maxTokens: 450, hint: {} });
    chairNotes = r.text.trim();
    writeFileSync(join(outDir, "chair-notes.md"), `# Chair's private notes after round 1\n\n${chairNotes}\n`);
  }

  // Chair fact-finding questions, between the rounds (structured; never asks how anyone will vote).
  const maxQ = variant.chairQuestions ?? 0;
  if (maxQ > 0) {
    const chair = { id: "chair", name: "Chair", role: "the meeting chair", persona: "You run the meeting and keep it brief. You ask only factual questions that help the group decide." };
    const ids = agents.map((a) => a.id);
    const { system, user } = prompt(chair, `${chairNotes ? `Your private notes:\n${chairNotes}\n\n` : ""}Ask up to ${maxQ} factual questions of named members to inform the group, for example asking those who have used a tool what they found. Each question needs: "to" (one of: ${ids.join(", ")}), "topic" (a factual topic) and "experience_sought". Never ask how anyone will vote or whether they support the motion. Reply with JSON only: {"questions":[{"to":"...","topic":"...","experience_sought":"..."}]}`, variant.chairNotes ? { transcriptText: variant.chairNotes === "rolling" ? "(You have your notes; the full statements are available if needed.)" : view("full") } : undefined);
    const r = await call({ phase: "chair-questions", agent: chair, task: "chair-questions", system, user, maxTokens: 300, hint: { agents: ids } });
    let qs = [];
    try { qs = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? "{}").questions ?? []; } catch { qs = []; }
    for (const q of qs.slice(0, maxQ)) {
      const bad = !byId.has(q.to) || !q.topic || !q.experience_sought || /\b(vote|support|oppose|in favou?r|for or against)\b/i.test(`${q.topic} ${q.experience_sought}`);
      if (bad) { stats.rejectedChairQuestions.push(q); continue; }
      stats.chairQuestions.push(q);
      push("Chair", "chair-question", `To ${byId.get(q.to).name}: ${q.topic} (${q.experience_sought})`, { label: "fact-finding question" });
      const a = byId.get(q.to);
      const ans = await turn(a, "chair-answer", `The chair asked you: "${q.topic}" — ${q.experience_sought}. Answer in at most ${words(tokenLimit / 2)} words, from your own experience and your notes only. ${FORMAT}`, { desk: true });
      await updateNotes(push(a.name, "answer", ans.text, { tldr: ans.tldr, stance: ans.stance, label: "answer to chair", agent: a.id }));
    }
  }

  // Chair reminders: the chair holds the full statements and knows what the summaries left out. It may restate up to a
  // few important omitted points, each with a verbatim quote that must really occur in that speaker's full statement.
  async function chairReminderStep(stepName) {
    const maxR = variant.chairReminders ?? 0;
    if (!maxR || (variant.transcriptMode ?? "full") !== "tldr") return;
    const summarized = view("tldr");
    const fullText = view("full");
    const { system, user } = prompt(chairPersona, `Above are the statements as the other members saw them (summaries where long). Below are the full statements, which only you have read.\n\nFULL STATEMENTS:\n${fullText}\n\nYour private notes:\n${chairNotes || "(none)"}\n\nFind up to ${maxR} important points that a member's summary left out and that the others should know before the discussion goes on (facts, evidence or conditions only; never anything about how to vote). Reply with JSON only: {"reminders":[{"from":"<speaker name>","quote":"<verbatim sentence or phrase from that speaker's full statement>","why":"<why the others should know it>"}]} or {"reminders":[]}.`, { transcriptText: summarized });
    const r = await call({ phase: "chair-reminders", agent: chairPersona, task: "chair-reminders", system, user, maxTokens: 450, hint: {} });
    let rs = [];
    try { rs = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? "{}").reminders ?? []; } catch { rs = []; }
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();
    for (const m of rs.slice(0, maxR)) {
      const src = transcript.find((e) => e.who === m.from && e.text && norm(e.text).includes(norm(m.quote ?? "")) && norm(m.quote ?? "").length > 8);
      if (!src) { (stats.rejectedReminders ??= []).push({ step: stepName, ...m }); continue; }
      (stats.reminders ??= []).push({ step: stepName, from: m.from, quote: m.quote });
      push("Chair", "chair-reminder", `Reminder from ${m.from}'s full statement: "${m.quote}"`, { label: "chair reminder" });
    }
  }
  // Chair's summary of round 1: the most important points (repeated by several speakers, left out of the summaries, or in
  // dispute), attributed, balanced and without any recommendation; omitted points must carry a verbatim quote.
  async function chairSummaryStep() {
    const { system, user } = prompt(chairPersona, `You have read the full statements of round 1.\n\nFULL STATEMENTS:\n${view("full")}\n\nYour private notes:\n${chairNotes || "(none)"}\n\nGive the group a neutral summary of the most important points before round 2: at most 6 points, covering points several speakers made, points a speaker made that the summaries left out, and points the speakers disagree on. Give both sides fairly. Never recommend a position and never say anything about how to vote. Reply with JSON only: {"points":[{"point":"<one or two sentences>","kind":"repeated|omitted|disputed","speakers":["<name>"],"quote":"<verbatim phrase from a full statement; required when kind is omitted>"}]}`, { transcriptText: view("tldr") });
    const r = await call({ phase: "chair-summary", agent: chairPersona, task: "chair-summary", system, user, maxTokens: 700, hint: {} });
    let pts = [];
    try { pts = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? "{}").points ?? []; } catch { pts = []; }
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();
    const names = new Set(agents.map((a) => a.name));
    const lines = [];
    for (const pt of pts.slice(0, 6)) {
      const who = (pt.speakers ?? []).filter((n) => names.has(n));
      let ok = !!pt.point && who.length > 0;
      if (ok && pt.kind === "omitted") ok = !!pt.quote && norm(pt.quote).length > 8 && transcript.some((e) => who.includes(e.who) && norm(e.text).includes(norm(pt.quote)));
      if (!ok) { (stats.rejectedSummaryPoints ??= []).push(pt); continue; }
      (stats.summaryPoints ??= []).push({ kind: pt.kind, speakers: who });
      lines.push(`- (${pt.kind}; ${who.join(", ")}) ${pt.point}${pt.kind === "omitted" ? ` — from the full statement: "${pt.quote}"` : ""}`);
    }
    if (lines.length) push("Chair", "chair-summary", `Chair's summary of round 1:\n${lines.join("\n")}`, { label: "chair summary" });
  }
  if (variant.chairSummary) await chairSummaryStep(); else await chairReminderStep("before-round-2");

  // Round 2: open, everyone has heard round 1; a member may bring in notes from its own desk.
  if ((variant.rounds ?? 2) >= 2) {
    const r2 = `You have now heard the others. Respond to what was said; you may confirm, correct or reverse your earlier view, and you may cite your notes if you have any. At most ${words(tokenLimit)} words. ${FORMAT}`;
    for (const a of agents) {
      const r = await turn(a, "round2", r2, { desk: true });
      await updateNotes(push(a.name, "statement", r.text, { tldr: r.tldr, stance: r.stance, label: "round 2", agent: a.id }));
    }
  }

  // Objection check: a bounded call, not a floor turn. Only the motion and a summary are sent.
  if (variant.objectionCheck !== false) {
    const maxReruns = variant.maxObjectionReruns ?? 2;
    for (let attempt = 0; attempt <= maxReruns; attempt++) {
      const summary = transcript.filter((e) => e.tldr).map((e) => `- ${e.who}: ${e.tldr}`).join("\n");
      const results = await parallel(agents, variant.parallel ?? 4, async (a) => {
        const system = common();
        const user = `${personaOf(a)}\nSummary of the discussion:\n${summary}\n\nDo you object to opening the vote now (for example the motion is unclear or something essential is missing)? Reply exactly:\nOBJECT: yes|no${variant.allowTabling ? "|research" : ""}\nREASON: <one sentence, only if yes${variant.allowTabling ? "; if research, say what you would look into and why it matters before voting" : ""}>`;
        const r = await call({ phase: "objection-check", agent: a, task: "objection", system, user, maxTokens: 80, hint: { lean: a.lean } });
        return { agent: a, object: /OBJECT:\s*yes/i.test(r.text), research: variant.allowTabling === true && /OBJECT:\s*research/i.test(r.text), reason: pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "" };
      });
      const researchers = results.filter((r) => r.research);
      if (researchers.length > 0) {
        for (const o of researchers) push(o.agent.name, "objection", o.reason || "(no detail)", { label: "needs time to research" });
        const chair = { id: "chair", name: "Chair", role: "the meeting chair", persona: "You run the meeting and keep it brief." };
        const { system, user } = prompt(chair, `Members asked for time to research before voting (see the transcript). Rule: reply "RULING: table" to postpone the decision to the next meeting, listing "RESEARCH: <member>: <what they will look into>" per line, or "RULING: proceed" to vote now. Table only if the research could change the outcome.`);
        const r = await call({ phase: "chair-ruling", agent: chair, task: "chair-ruling", system, user, maxTokens: 250, hint: {} });
        if (/RULING:\s*table/i.test(r.text)) {
          const research = [...r.text.matchAll(/RESEARCH:\s*([^\n]+)/gi)].map((m) => m[1].trim());
          push("Chair", "ruling", `Motion tabled to the next meeting. Research: ${research.join(" | ") || "(unspecified)"}`, { label: "tabled" });
          stats.tabled = { research };
          break;
        }
        push("Chair", "ruling", "Proceeding to the vote despite requests for research.", { label: "ruling" });
      }
      const objectors = results.filter((r) => r.object);
      stats.objections.push({ attempt, objectors: objectors.map((o) => ({ id: o.agent.id, reason: o.reason })) });
      if (objectors.length === 0) break;
      for (const o of objectors) push(o.agent.name, "objection", o.reason || "(no reason given)", { label: "objection" });
      if (attempt === maxReruns) { push("Chair", "ruling", "Rerun limit reached; proceeding to the vote. Remaining objections are recorded as dissent.", { label: "ruling" }); break; }
      const chair = { id: "chair", name: "Chair", role: "the meeting chair", persona: "You run the meeting and keep it brief." };
      const { system, user } = prompt(chair, `Members objected to opening the vote (see the transcript). Rule: reply "RULING: proceed" or "RULING: amend" followed by "AMENDED_MOTION: <the clarified motion text>" and "REASON: <one sentence>".`);
      const r = await call({ phase: "chair-ruling", agent: chair, task: "chair-ruling", system, user, maxTokens: 200, hint: {} });
      const amended = /RULING:\s*amend/i.test(r.text) ? pick(/AMENDED_MOTION:\s*([\s\S]*?)(?:\nREASON:|$)/i, r.text) : undefined;
      push("Chair", "ruling", amended ? `Amended. New wording: ${amended}` : "Proceed.", { label: "ruling" });
      if (!amended) break;
      motion = { text: amended, version: motion.version + 1 };
    }
  }

  // Chair's private decision (test of whether the vote adds anything): before any ballot, the chair says what it would decide
  // alone on the motion as it now stands and predicts the tally. The ballots are then compared with it. Not shown to members.
  if (variant.chairDecides && !stats.tabled) {
    const { system, user } = prompt(chairPersona, `The discussion is over and the ballots have not been cast. Privately, as chair: (1) if you alone had to decide this motion as it now stands, what would you decide, and (2) how many of the ${agents.length} members do you expect to vote yes? Reply exactly:\nDECIDE: yes|no\nPREDICT_YES: <number>\nREASON: <one sentence>`);
    const r = await call({ phase: "chair-decision", agent: chairPersona, task: "chair-decision", system, user, maxTokens: 120, hint: {} });
    stats.chairDecision = { decide: (pick(/DECIDE:\s*(yes|no)/i, r.text) ?? "unknown").toLowerCase(), predictYes: Number(pick(/PREDICT_YES:\s*(\d+)/i, r.text)), reason: pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "" };
  }

  // Ballots: asked individually; nobody sees another ballot; revealed together below. A tabled motion has none.
  if (!stats.tabled) await chairReminderStep("before-ballots");
  const viewForBallots = view();
  for (const a of stats.tabled ? [] : agents) {
    const { system, user } = prompt(a, `Cast your ballot on the motion as it now stands. Reply exactly:\nVOTE: yes|no|abstain\nREASON: <one sentence>`, { transcriptText: viewForBallots });
    const r = await call({ phase: "ballot", agent: a, task: "ballot", system, user, maxTokens: 100, hint: { lean: a.lean } });
    const vote = (pick(/VOTE:\s*(yes|no|abstain)/i, r.text) ?? "abstain").toLowerCase();
    ballots.push({ agent: a.id, name: a.name, vote, reason: pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "" });
  }
  const yes = ballots.filter((b) => b.vote === "yes").length;
  const no = ballots.filter((b) => b.vote === "no").length;
  if (stats.chairDecision) {
    const d = stats.chairDecision;
    stats.chairDecision = { ...d, actualYes: yes, passed: yes > no, matchesOutcome: (d.decide === "yes") === (yes > no), predictionError: Number.isFinite(d.predictYes) ? d.predictYes - yes : null };
  }
  const result = stats.tabled ? { outcome: "tabled", research: stats.tabled.research } : { yes, no, abstain: ballots.length - yes - no, quorum: ballots.length > agents.length / 2, outcome: yes > no ? "passed" : yes === no ? "tied (the plan now has the chair break it; not simulated here)" : "failed" };

  // Metrics
  const r1s = transcript.filter((e) => e.label?.startsWith("round 1") && e.stance);
  let agree = 0, pairs = 0;
  for (let i = 1; i < r1s.length; i++) { pairs++; if (r1s[i].stance === r1s[i - 1].stance) agree++; }
  const changed = agents.filter((a) => {
    const first = transcript.find((e) => e.agent === a.id && e.label?.startsWith("round 1"))?.stance;
    const second = transcript.filter((e) => e.agent === a.id && e.label === "round 2").at(-1)?.stance;
    return first && second && first !== second;
  }).length;
  const byPhase = {};
  for (const c of ledger.calls) {
    const b = (byPhase[c.phase] ??= { calls: 0, input: 0, cached: 0, output: 0, ms: 0, costUsd: 0 });
    b.calls++; b.input += c.usage.input; b.cached += c.usage.cached; b.output += c.usage.output; b.ms += c.ms ?? 0; b.costUsd += c.costUsd;
  }
  const summary = {
    scenario: scenario.title, variant, model: provider.name, roster: agents.map((a) => ({ id: a.id, name: a.name, model: (providers.byAgent?.[a.id] ?? provider).name })), chairModel: (providers.chair ?? provider).name, motion, result, stats,
    metrics: {
      round1StanceAgreementWithPrevious: pairs ? agree / pairs : null,
      membersWhoChangedStanceInRound2: changed,
      cacheHitRatio: ledger.calls.reduce((s, c) => s + c.usage.cached, 0) / Math.max(1, ledger.calls.reduce((s, c) => s + c.usage.input, 0)),
      calls: ledger.calls.length, estimatedCostUsd: ledger.spent, byPhase,
    },
  };
  if (variant.chairNotes === "rolling") writeFileSync(join(outDir, "chair-notes.md"), `# Chair's private notes (rolling)\n\n${chairNotes}\n`);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "ballots.json"), JSON.stringify({ ballots, result }, null, 2));
  writeFileSync(join(outDir, "transcript.md"), [
    `# ${scenario.title}`, `Variant: ${JSON.stringify(variant)}`, `Model: ${provider.name}`, "",
    ...transcript.map((e) => `**#${e.seq} ${e.who}** ${e.label ? `_(${e.label})_` : ""}${e.stance ? ` [${e.stance}]` : ""}\n${e.text}\n${e.tldr ? `> tl;dr (what later speakers saw in summary mode): ${e.tldr}\n` : ""}`),
    "## Ballots (revealed together at the close)", ...ballots.map((b) => `- ${b.name}: **${b.vote}** — ${b.reason}`), "", `Result: ${JSON.stringify(result)}`,
  ].join("\n"));
  return summary;
}
