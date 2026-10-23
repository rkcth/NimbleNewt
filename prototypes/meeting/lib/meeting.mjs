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
  const roster = scenario.agents;
  const absentIds = new Set(scenario.absent ?? []); // decided by the controller (here: the scenario), never by the chair
  const agents = roster.filter((a) => !absentIds.has(a.id)); // the present members
  const byId = new Map(roster.map((a) => [a.id, a]));
  const clock = { startedMs: Date.now(), pausedMs: 0 };
  const promptLog = []; // every delivery, for the held-answer leak check
  const tokenLimit = variant.tokenLimit ?? 220;
  let motion = { text: scenario.motion, version: 1 };
  const transcript = []; // visible to later speakers under the baton rule
  const stats = { objections: [], chairQuestions: [], rejectedChairQuestions: [], skippedAbsent: [], inquiries: [], ownerReports: [] };

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
    promptLog.push({ phase, agent: agent?.id, text: `${system}\n${user}` });
    const r = await p.chat({ system, user, maxTokens: maxTokens + headroom, hint: { ...hint, task } });
    const row = ledger.record({ phase, agent: agent?.id, task, model: p.name, usage: r.usage, ms: r.ms, finish: r.finish });
    appendFileSync(callsPath, JSON.stringify({ ...row, text: r.text }) + "\n");
    log(`${phase} ${agent?.id ?? "chair"} in=${r.usage.input} cached=${r.usage.cached} out=${r.usage.output} $${ledger.spent.toFixed(4)}`);
    return r;
  }

  const pick = (re, text) => re.exec(text)?.[1]?.trim();
  function parseStatement(text) {
    const stance = (pick(/STANCE:\s*(for|against|undecided)/i, text) ?? "unknown").toLowerCase();
    const body = pick(/STATEMENT:\s*([\s\S]*?)(?:\nTLDR:|\nASK:|$)/i, text) ?? text.trim();
    const ask = pick(/^ASK:\s*(.*)$/im, text);
    const tldr = pick(/TLDR:\s*([\s\S]*?)(?:\nASK:|$)/i, text) ?? (variant.tldrStyle === "facts" ? "none" : body.split(/\s+/).slice(0, 25).join(" "));
    const clean = tldr.replace(/\s+/g, " ").trim();
    return { stance, text: body, tldr: /^none\.?$/i.test(clean) ? undefined : clean, ask: ask && !/^none/i.test(ask) ? ask : undefined };
  }
  const push = (who, kind, text, extra = {}) => {
    const e = { seq: transcript.length + 1, who, kind, text, ...extra };
    transcript.push(e);
    return e;
  };

  const summarizeAbove = variant.summarizeAbove ?? 70;
  const summaryWords = variant.summaryWords ?? 60;
  const ASKLINE = variant.directQuestions ? `\nASK: none | <member id>: <one short factual question to one present member, only if you really need an answer from them>${variant.askNudge ? " (asking is encouraged whenever a fact that could change your view is missing from what you have heard and is likely known to a specific present member; use the other members' ids)" : ""}` : "";
  const FORMAT0 = variant.tldrStyle === "facts"
    ? `Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: <if your statement is brief, write none; otherwise summarize your thoughts into one brief paragraph, remembering to include important points or details that you want the group to know>`
    : `Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: <one sentence, at most 25 words>`;
  const FORMAT = FORMAT0 + ASKLINE;
  const FORMAT_NOASK = FORMAT0;
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
  for (const id of absentIds) {
    stats.skippedAbsent.push(id);
    push("Chair", "absent", `${byId.get(id).name} is absent and is skipped in the comment rounds and the vote (recorded).`, { label: "absent member" });
  }

  // Owner inquiry period (owner decision 2026-10-22), played by a scripted owner. The meeting clock is paused while it runs.
  // During a held vote, the answers voters give the owner are kept out of everyone else's deliveries until the vote closes.
  const answeredDuringVote = []; // for the leak check, whether or not the answer was held
  const held = []; // answers given to the owner while a vote is open: { agent, text }
  const ownerPrivate = new Map(); // agent id -> the agent's own exchange with the owner (it held the floor for it)
  const castBallots = new Map(); // agent id -> its current ballot
  const ballotHistory = [];
  const revisionCounts = {};
  let voteOpen = false;
  const ballotPrompt = (a, extra = "") => prompt(a, `${extra}Cast your ballot on the motion as it now stands. Reply exactly:\nVOTE: yes|no|abstain\nREASON: <one sentence>`, { extra: ownerPrivate.has(a.id) ? `Your own earlier exchange with the owner:\n${ownerPrivate.get(a.id)}\n\n` : "" });
  async function inquiry(spec, name) {
    const t0 = Date.now();
    const rec = { name, voteOpen, castBefore: [...castBallots.keys()], questions: [], revisions: [], heldAnswers: [] };
    stats.inquiries.push(rec);
    log(`-- owner inquiry "${name}" opens: meeting clock paused${voteOpen ? ", vote held" : ""}`);
    if (spec.message) push("Owner", "owner-message", spec.message, { label: "owner message" });
    for (const q of spec.questions ?? []) {
      const a = byId.get(q.to);
      if (!a || absentIds.has(q.to)) { rec.questions.push({ to: q.to, skipped: "not present" }); continue; }
      push("Owner", "owner-question", `To ${a.name}: ${q.text}`, { label: "owner question" });
      const own = castBallots.get(a.id);
      const r = await turn(a, "owner-answer", `The owner asks you directly: "${q.text}". Answer the owner in at most ${words(tokenLimit / 2)} words, from your own background and notes only. ${FORMAT_NOASK}${own ? `\n(Your recorded ballot is ${own.vote}: ${own.reason}.)` : ""}`, { desk: true });
      rec.questions.push({ to: a.id, question: q.text, answer: r.text });
      ownerPrivate.set(a.id, `${ownerPrivate.get(a.id) ? `${ownerPrivate.get(a.id)}\n` : ""}Owner: ${q.text}\nYou: ${r.text}`);
      if (voteOpen) answeredDuringVote.push({ agent: a, text: r.text });
      if (voteOpen && process.env.M00_MUTATE_LEAK !== "1") { held.push({ agent: a, text: r.text }); rec.heldAnswers.push(a.id); log(`   (answer from ${a.name} held until the vote closes; the owner reads it now)`); }
      else push(a.name, "answer", r.text, { label: "answer to owner", agent: a.id });
    }
    push("Owner", "owner-command", spec.command ?? "That is all my questions; carry on.", { label: "owner command: end inquiry" });
    clock.pausedMs += Date.now() - t0;
    log(`-- inquiry "${name}" ended by the owner command`);
    if (voteOpen) await revisionTurns(rec);
  }
  async function revisionTurns(rec) {
    // Each voter who cast before the message gets exactly one revision turn: keep or revise, with a reason.
    for (const id of rec.castBefore) {
      const a = byId.get(id);
      const old = castBallots.get(id);
      revisionCounts[id] = (revisionCounts[id] ?? 0) + 1;
      const { system, user } = prompt(a, `You have the floor for one revision turn because of the owner's message and questions above. Your recorded ballot is ${old.vote}: ${old.reason}. Keep it or revise it. Reply exactly:\nVOTE: yes|no|abstain\nCHANGED: yes|no\nREASON: <one sentence>`, { extra: ownerPrivate.has(id) ? `Your own earlier exchange with the owner:\n${ownerPrivate.get(id)}\n\n` : "" });
      const r = await call({ phase: "ballot-revision", agent: a, task: "ballot", system, user, maxTokens: 100, hint: { lean: a.lean } });
      const vote = (pick(/VOTE:\s*(yes|no|abstain)/i, r.text) ?? old.vote).toLowerCase();
      const reason = pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "";
      ballotHistory.push({ agent: id, name: a.name, vote, reason, trigger: `owner inquiry "${rec.name}"`, revisionOf: old.vote });
      castBallots.set(id, { agent: id, name: a.name, vote, reason });
      rec.revisions.push({ agent: id, from: old.vote, to: vote });
    }
  }

  // Round 1: open (sequential, each hears the earlier speakers) or blind (independent, in parallel).
  const r1 = `Give your position on the motion in at most ${words(tokenLimit)} words. ${FORMAT_NOASK}`;
  if (variant.firstRound === "blind") {
    const results = await parallel(agents, variant.parallel ?? 4, (a) => turn(a, "round1-blind", r1, { blind: true, desk: variant.deskFromStart === true }));
    for (const r of results) await updateNotes(push(r.agent.name, "statement", r.text, { tldr: r.tldr, stance: r.stance, label: "round 1 (blind)", agent: r.agent.id }));
  } else {
    for (const a of agents) {
      const r = await turn(a, "round1", r1, { desk: variant.deskFromStart === true });
      await updateNotes(push(a.name, "statement", r.text, { tldr: r.tldr, stance: r.stance, label: "round 1", agent: a.id }));
    }
  }

  if (scenario.owner?.afterRound1) await inquiry(scenario.owner.afterRound1, "after round 1");

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
    const ids = roster.map((a) => a.id);
    const { system, user } = prompt(chair, `${chairNotes ? `Your private notes:\n${chairNotes}\n\n` : ""}Ask up to ${maxQ} factual questions of named members to inform the group, for example asking those who have used a tool what they found. Each question needs: "to" (one of: ${ids.join(", ")}), "topic" (a factual topic) and "experience_sought". Never ask how anyone will vote or whether they support the motion. Reply with JSON only: {"questions":[{"to":"...","topic":"...","experience_sought":"..."}]}`, variant.chairNotes ? { transcriptText: variant.chairNotes === "rolling" ? "(You have your notes; the full statements are available if needed.)" : view("full") } : undefined);
    const r = await call({ phase: "chair-questions", agent: chair, task: "chair-questions", system, user, maxTokens: 300, hint: { agents: ids } });
    let qs = [];
    try { qs = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? "{}").questions ?? []; } catch { qs = []; }
    for (const q of qs.slice(0, maxQ)) {
      const bad = !byId.has(q.to) || !q.topic || !q.experience_sought || /\b(vote|support|oppose|in favou?r|for or against)\b/i.test(`${q.topic} ${q.experience_sought}`);
      if (bad) { stats.rejectedChairQuestions.push(q); continue; }
      if (absentIds.has(q.to)) { stats.skippedAbsent.push(`chair question to ${q.to}`); push("Chair", "chair-question", `Question to ${byId.get(q.to).name} skipped: absent (recorded).`, { label: "skipped" }); continue; }
      stats.chairQuestions.push(q);
      push("Chair", "chair-question", `To ${byId.get(q.to).name}: ${q.topic} (${q.experience_sought})`, { label: "fact-finding question" });
      const a = byId.get(q.to);
      const ans = await turn(a, "chair-answer", `The chair asked you: "${q.topic}" — ${q.experience_sought}. Answer in at most ${words(tokenLimit / 2)} words, from your own experience and your notes only. ${FORMAT_NOASK}`, { desk: true });
      await updateNotes(push(a.name, "answer", ans.text, { tldr: ans.tldr, stance: ans.stance, label: "answer to chair", agent: a.id }));
    }
  }

  // Chair desk read (owner decision 2026-10-22): only an absent roster member, read-only, redacted, one inspection record per
  // file, excerpts with verbatim quotes, marked unverified; reading a present member's desk is refused. The returning member
  // sees what was read and may add a correction.
  const inspections = [];
  stats.deskRead = { refused: [], excerpts: [], rejectedExcerpts: [], corrections: [] };
  const redact = (t) => t.replace(/\b(sk|pk|ghp|xox[bp])[-_][A-Za-z0-9_-]{8,}/g, "[redacted]").replace(/((?:password|passwd|secret|token|api[_ -]?key)\s*[:=]\s*)\S+/gi, "$1[redacted]");
  function meetingRead(memberId, why) {
    const m = byId.get(memberId);
    if (!m || !absentIds.has(memberId)) { stats.deskRead.refused.push({ memberId, why, reason: m ? "member is present (controller state)" : "not on the roster" }); return undefined; }
    const files = (m.deskFiles ?? []).map((f) => ({ path: f.path, text: redact(f.text) }));
    for (const f of files) inspections.push({ member: memberId, path: f.path, revision: 1, by: "meeting-chair", meeting: scenario.title, writes: 0 });
    return files;
  }
  async function chairDeskRead() {
    if (!variant.deskRead || absentIds.size === 0) return;
    stats.deskRead.refused = []; // the scripted adversarial attempt below is recorded here
    const probe = agents[0]?.id; // a scripted attempt to read a present member's desk, which must be refused
    if (probe) meetingRead(probe, "scripted adversarial attempt");
    const files = [];
    for (const id of absentIds) for (const f of meetingRead(id, "chair read") ?? []) files.push({ member: id, ...f });
    if (files.length === 0) return;
    const listing = files.map((f) => `FILE ${f.path} (desk of ${byId.get(f.member).name}, absent):\n${f.text}`).join("\n\n");
    const { system, user } = prompt(chairPersona, `Some members are absent. Under the meeting rules you may read an absent member's desk, read-only, to inform the group. The files you have read are below. Choose at most 3 short excerpts that bear on the motion. Each needs a verbatim quote copied exactly from the file. Facts and evidence only; never anything about how to vote.\n\n${listing}\n\nReply with JSON only: {"excerpts":[{"member":"<id>","file":"<path>","quote":"<verbatim>","bears_on":"<one sentence>"}]}`);
    const r = await call({ phase: "chair-desk-read", agent: chairPersona, task: "chair-desk-read", system, user, maxTokens: 450, hint: {} });
    let ex = [];
    try { ex = JSON.parse(/\{[\s\S]*\}/.exec(r.text)?.[0] ?? "{}").excerpts ?? []; } catch { ex = []; }
    const norm = (t) => t.toLowerCase().replace(/[^a-z0-9% ]+/g, " ").replace(/\s+/g, " ").trim();
    for (const e of ex.slice(0, 3)) {
      const memberId = [...byId.values()].find((m) => m.id === e.member || m.name.toLowerCase() === String(e.member).toLowerCase())?.id; // the chair may give the name instead of the id
      const f = files.find((x) => x.member === memberId && x.path === e.file);
      e.member = memberId ?? e.member;
      if (!f) { stats.deskRead.rejectedExcerpts.push({ ...e, why: "no such read file" }); continue; }
      if (!e.quote || norm(e.quote).length < 8 || !norm(f.text).includes(norm(e.quote))) { stats.deskRead.rejectedExcerpts.push({ ...e, why: "quote not verbatim" }); continue; }
      stats.deskRead.excerpts.push(e);
      push("Chair", "desk-read", `[From ${byId.get(e.member).name}'s desk, read-only by the chair, file ${f.path}, UNVERIFIED by ${byId.get(e.member).name}] "${e.quote}" (${e.bears_on})`, { label: "desk read (unverified)" });
    }
    stats.deskRead.inspections = inspections;
  }
  async function returningMember() {
    if (!variant.deskRead || stats.deskRead.excerpts.length === 0) return;
    for (const id of absentIds) {
      const a = byId.get(id);
      const mine = stats.deskRead.excerpts.filter((e) => e.member === id);
      if (!mine.length) continue;
      const { system, user } = prompt(a, `You were absent. While you were away the chair read your desk, read-only, and told the meeting this (marked unverified):\n${mine.map((e) => `- file ${e.file}: "${e.quote}" (${e.bears_on})`).join("\n")}\n\nIf the meeting was given a wrong or misleading picture of your view, add a short correction. Reply exactly:\nCORRECTION: none | <at most 40 words>\nCONTRADICTS: yes|no (does your correction contradict what the chair relayed?)`);
      const r = await call({ phase: "member-correction", agent: a, task: "correction", system, user, maxTokens: 120, hint: {} });
      const corr = pick(/CORRECTION:\s*([\s\S]*?)(?:\nCONTRADICTS:|$)/i, r.text) ?? "none";
      const contradicts = /CONTRADICTS:\s*yes/i.test(r.text);
      if (/^none/i.test(corr)) { stats.deskRead.corrections.push({ member: id, correction: null }); continue; }
      stats.deskRead.corrections.push({ member: id, correction: corr, contradicts, whileVoteOpen: voteOpen });
      push(a.name, "correction", corr, { label: "correction by the returning member", agent: a.id });
      if (contradicts && voteOpen) stats.ownerReports.push(`${a.name}'s correction contradicts what the chair relayed while the vote is open`);
    }
  }
  await chairDeskRead();

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
      // Direct question during the speaker's turn: the addressed member gets the floor for a short answer (depth one: the answer may
      // not open a further question), then the floor returns to the asker. At most one per member per round.
      const scripted = (scenario.scriptedAsks ?? []).find((x) => x.from === a.id); // a scripted ask exercises the floor mechanics when no model volunteers a question
      if (scripted && !r.ask) r.ask = `${scripted.to}: ${scripted.text}`;
      const dq = variant.directQuestions && r.ask ? /^\s*(?:\|\s*)?(\w+)\s*:\s*([\s\S]+)$/.exec(r.ask) : null;
      if (dq) {
        const target = byId.get(dq[1]);
        stats.directQuestions ??= [];
        if (!target || target.id === a.id) { stats.directQuestions.push({ from: a.id, to: dq[1], refused: "unknown or self" }); }
        else if (absentIds.has(target.id)) { stats.directQuestions.push({ from: a.id, to: target.id, skipped: "absent" }); push("Chair", "direct-question", `${a.name}'s question to ${target.name} skipped: absent (recorded).`, { label: "skipped" }); }
        else {
          push(a.name, "direct-question", `To ${target.name}: ${dq[2]}`, { label: "direct question" });
          const ans = await turn(target, "direct-answer", `${a.name} asked you directly: "${dq[2]}". Answer in at most ${words(tokenLimit / 2)} words, from your own background and notes. Do not ask anything back. ${FORMAT_NOASK}`, { desk: true });
          push(target.name, "answer", ans.text, { tldr: ans.tldr, stance: ans.stance, label: "answer to direct question", agent: target.id });
          const cont = await turn(a, "direct-continue", `You asked ${target.name} and the answer is above. If it changes anything for you, say so in at most ${words(tokenLimit / 2)} words; otherwise say briefly that it does not. ${FORMAT_NOASK}`, { desk: true });
          push(a.name, "statement", cont.text, { tldr: cont.tldr, stance: cont.stance, label: "round 2 (after answer)", agent: a.id });
          stats.directQuestions.push({ from: a.id, to: target.id, question: dq[2] });
        }
      }
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
  if (!stats.tabled && !scenario.returnDuringVote) await returningMember(); // before the vote opens, unless the scenario has the member return during the vote
  const finals = () => [...castBallots.values()]; // each member's last recorded ballot counts
  const ownerDuring = scenario.owner?.duringVote;
  const order = stats.tabled ? [] : agents;
  if (order.length) voteOpen = true;
  for (let i = 0; i < order.length; i++) {
    const a = order[i];
    const { system, user } = ballotPrompt(a);
    const r = await call({ phase: "ballot", agent: a, task: "ballot", system, user, maxTokens: 100, hint: { lean: a.lean } });
    const vote = (pick(/VOTE:\s*(yes|no|abstain)/i, r.text) ?? "abstain").toLowerCase();
    const b = { agent: a.id, name: a.name, vote, reason: pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "" };
    castBallots.set(a.id, b);
    ballotHistory.push({ ...b, trigger: "original ballot" });
    if (ownerDuring && i + 1 === ownerDuring.afterBallots) await inquiry(ownerDuring, "during the vote");
    if (variant.deskRead && scenario.returnDuringVote && i + 1 === 1) { await returningMember(); }
  }
  voteOpen = false;
  // The vote has closed: held answers are released into the transcript for everyone.
  for (const h of held) push(h.agent.name, "answer", h.text, { label: "answer to owner (released at close)", agent: h.agent.id });
  const norm2 = (t) => t.toLowerCase().replace(/\s+/g, " ").trim();
  stats.inquiryChecks = {
    heldAnswers: held.length,
    leaks: answeredDuringVote.flatMap((h) => promptLog.filter((p) => p.agent !== h.agent.id && p.agent !== undefined && ["ballot", "ballot-revision", "owner-answer", "objection-check"].includes(p.phase) && norm2(p.text).includes(norm2(h.text).slice(0, 50))).map((p) => ({ answerBy: h.agent.id, seenBy: p.agent, phase: p.phase }))),
    revisionsPerVoter: revisionCounts,
    voterRevisionTurnsOk: stats.inquiries.filter((i) => i.voteOpen).every((i) => i.revisions.length === i.castBefore.length && i.castBefore.every((id) => i.revisions.filter((rv) => rv.agent === id).length === 1)),
    clockMs: { total: Date.now() - clock.startedMs, paused: clock.pausedMs, meeting: Date.now() - clock.startedMs - clock.pausedMs },
  };
  const ballots = finals();
  const yes = ballots.filter((b) => b.vote === "yes").length;
  const no = ballots.filter((b) => b.vote === "no").length;
  // Tie: the chair is not on the roster here, so it casts a single casting vote only on a tie, recorded as such; no answer means the tie fails.
  if (!stats.tabled && yes !== no && variant.tieProbe) {
    // Drill: real models rarely split, so the casting-vote call is also exercised on a hypothetical 1-1 tie. Not part of the result.
    const { system, user } = prompt(chairPersona, `DRILL, not a real tie: suppose the ballots were tied 1-1. You are not on the roster. Under the rules the chair casts a single casting vote on a tie, with no double vote. Reply exactly:\nCASTING: yes|no\nREASON: <one sentence>`, { transcriptText: view() });
    const r = await call({ phase: "casting-probe", agent: chairPersona, task: "casting", system, user, maxTokens: 100, hint: {} });
    stats.castingProbe = { vote: pick(/CASTING:\s*(yes|no)/i, r.text)?.toLowerCase() ?? "no answer", reason: pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "" };
  }
  let casting;
  if (!stats.tabled && yes === no && ballots.length > 0) {
    const { system, user } = prompt(chairPersona, `The ballots are tied ${yes}-${no}${ballots.length - yes - no ? ` with ${ballots.length - yes - no} abstention(s)` : ""}. You are not on the roster. Under the rules the chair casts a single casting vote on a tie, with no double vote. Reply exactly:\nCASTING: yes|no\nREASON: <one sentence>`, { transcriptText: view() });
    const r = await call({ phase: "casting-vote", agent: chairPersona, task: "casting", system, user, maxTokens: 100, hint: {} });
    const v = pick(/CASTING:\s*(yes|no)/i, r.text)?.toLowerCase();
    casting = { vote: v ?? "no answer", reason: pick(/REASON:\s*([\s\S]*)$/i, r.text) ?? "" };
  }
  if (stats.chairDecision) {
    const d = stats.chairDecision;
    stats.chairDecision = { ...d, actualYes: yes, passed: yes > no, matchesOutcome: (d.decide === "yes") === (yes > no), predictionError: Number.isFinite(d.predictYes) ? d.predictYes - yes : null };
  }
  const result = stats.tabled ? { outcome: "tabled", research: stats.tabled.research } : { yes, no, abstain: ballots.length - yes - no, quorum: ballots.length > agents.length / 2, outcome: casting ? (casting.vote === "yes" ? "passed (casting vote)" : casting.vote === "no" ? "failed (casting vote)" : "failed (tie, no casting vote)") : yes > no ? "passed" : "failed", ...(casting ? { castingVote: casting } : {}) };

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
      calls: ledger.calls.length, estimatedCostUsd: ledger.calls.reduce((s, c) => s + c.costUsd, 0), byPhase,
    },
  };
  if (variant.chairNotes === "rolling") writeFileSync(join(outDir, "chair-notes.md"), `# Chair's private notes (rolling)\n\n${chairNotes}\n`);
  writeFileSync(join(outDir, "summary.json"), JSON.stringify(summary, null, 2));
  writeFileSync(join(outDir, "ballots.json"), JSON.stringify({ ballots, ballotHistory, result }, null, 2));
  writeFileSync(join(outDir, "transcript.md"), [
    `# ${scenario.title}`, `Variant: ${JSON.stringify(variant)}`, `Model: ${provider.name}`, "",
    ...transcript.map((e) => `**#${e.seq} ${e.who}** ${e.label ? `_(${e.label})_` : ""}${e.stance ? ` [${e.stance}]` : ""}\n${e.text}\n${e.tldr ? `> tl;dr (what later speakers saw in summary mode): ${e.tldr}\n` : ""}`),
    "## Ballots (revealed together at the close)", ...ballotHistory.map((b) => `- ${b.name}: **${b.vote}** — ${b.reason} _(${b.trigger}${b.revisionOf ? `; was ${b.revisionOf}` : ""})_`), "", `Result: ${JSON.stringify(result)}`,
  ].join("\n"));
  return summary;
}
