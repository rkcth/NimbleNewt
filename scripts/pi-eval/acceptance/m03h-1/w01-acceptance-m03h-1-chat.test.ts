import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { chatTurnFollowUps } from "./follow-ups.js";
import { StandupService, agendaOutcomeSink } from "../standups/index.js";
import type { ChatService, Outcome } from "./index.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { StatusService } from "../status/index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string, extra: Record<string, unknown> = {}) => ({ kind: "command", op, args, evidence, basis: "owner", ...extra });

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, ctl: { status(): StatusService; sched(projectId: string, title: string, when?: { time: string; windowFrom: string; windowTo: string }): Promise<string>; schedule(id: string): Promise<{ state: string; title: string; time: string; revision: number }> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      // The stand-up service needs the world's meeting service, which exists only once the world is open: the API reaches it through this holder.
      const holder: { s?: StandupService } = {};
      const lazy = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => (holder.s as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!(...a) }) as StandupService;
      const w = await openWorld(backend, script, undefined, { standups: lazy });
      holder.s = StandupService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, assignments: w.assignments }, { ...options, availability: async () => "available", outcomes: agendaOutcomeSink({ followUp: (turnId, f) => chatTurnFollowUps(w.world.storage, w.projects.epoch).add(turnId, f), inquiry: async () => undefined, messages: { noticeFromController: async () => undefined } }) });
      const ctl = {
        status: (): StatusService => StatusService.withEpoch(w.world.storage, w.projects.epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, w.projects.epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, w.projects.epoch, options), contracts: w.contracts, meetings: w.meetings, standups: holder.s as never }, options),
        sched: async (projectId: string, title: string, when = { time: "09:00", windowFrom: "08:00", windowTo: "10:00" }) => {
          const agent = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: `A-${title}` });
          const made = await holder.s!.configure(w.owner, { commandId: cid("su"), projectId, title, roster: [`agent:${agent.id}`], ...when, timeZone: "Europe/London", recurrence: { kind: "daily" } });
          return made.scheduleId;
        },
        schedule: async (id: string) => { const got = (await holder.s!.standup(w.owner, id))!.schedule; return { state: got.state, title: got.title, time: got.time, revision: got.revision }; },
      };
      try { await body(w, script, ctl); } finally { await w.close(); }
    });
  const say = (w: World, chat: ChatService, text: string, messageId = cid("m")) => chat.submit(w.ownerToken, { messageId, text });
  const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };

  // ---- W01 acceptance, card M03h part 1: chat reach for stand-ups ----------------------------------------------------------

  suite("acceptance M03h: what stand-ups the project has is asked in ordinary words and answered from the schedules; the project comes from the focus and ended ones are counted, not listed", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    // Both stand-ups are at 11:30 London (10:30 UTC) and the world's clock reads 10:00 UTC, so each has a planned occurrence.
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    const morning = await ctl.sched(a, "Morning sync", when);
    await ctl.sched(a, "Evening wrap", when);
    assert.equal((await w.meetings.tick(w.owner)).created.length, 2, "both have a meeting planned");
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const asked = async (text: string): Promise<string> => JSON.stringify(only((await say(w, chat, text)).outcomes));

    script["What stand-ups do we have?"] = [{ kind: "status", request: { kind: "standups" }, evidence: "What stand-ups do we have?", basis: "owner" }];
    const first = only((await say(w, chat, "What stand-ups do we have?")).outcomes);
    assert.equal(first.status, "answered", JSON.stringify(first));
    const lines = first.lines!.map((l) => l.text);
    assert.equal(lines.length, 4, `two lines per stand-up: ${JSON.stringify(lines)}`);
    assert.ok(lines[0]!.startsWith('"Evening wrap"'), lines[0]);
    for (const part of ["active", "daily", "11:30", "Europe/London", "30 minutes", "08:00", "13:00", "agent:"]) assert.ok(lines[0]!.includes(part), `${part} in ${lines[0]}`);
    assert.ok(lines[1]!.includes("2026-10-22T10:30:00.000Z"), lines[1]);
    assert.match(lines[1]!, /not met yet/);
    assert.match(lines[1]!, /\b1 meeting\b/);
    assert.ok(lines[2]!.startsWith('"Morning sync"'), lines[2]);
    assert.ok(first.lines!.every((l) => l.cites.some((x) => x.kind === "project" && x.id === a)), "every line cites the project");
    assert.ok(first.lines![0]!.cites.some((x) => x.kind === "meeting-schedule"), "the schedule line cites the schedule it reads");
    assert.ok(first.lines![1]!.cites.some((x) => x.kind === "meeting"), "the meeting line cites the occurrence it names");

    // A narrower ask is a page, and the answer says it cut the rest.
    script["Just the first stand-up, please."] = [{ kind: "status", request: { kind: "standups", limit: 1 }, evidence: "Just the first stand-up, please", basis: "owner" }];
    assert.match(await asked("Just the first stand-up, please."), /more stand-ups/);

    // A stand-up that has ended is not one the project is running, but it is counted.
    await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("end"), args: { scheduleId: morning, expectedRevision: (await ctl.schedule(morning)).revision, state: "ended" } } as never);
    const afterEnd = await asked("What stand-ups do we have?");
    assert.match(afterEnd, /\b1 ended\b/);
    assert.ok(!afterEnd.includes("Morning sync"), "the ended stand-up is not listed");

    // Another project with no stand-up of its own says so (the focus moves, and the answer follows it).
    const quiet = await w.project("Quiet");
    const other = w.chat({ status: ctl.status() });
    await other.setFocus(w.ownerToken, { commandId: cid("f"), projectId: quiet });
    const empty = only((await say(w, other, "What stand-ups do we have?", cid("m"))).outcomes);
    assert.equal(empty.status, "answered", JSON.stringify(empty));
    assert.match(JSON.stringify(empty.lines), /no stand-up/i);
  });

  suite("acceptance M03h: getting a stand-up ready or writing on its briefs answers about the stand-up the owner named even before its first meeting; ended ones are never named", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    // Both stand-ups are at 11:30 London (10:30 UTC), past the world's clock of 10:00 UTC, and nothing has been ticked, so neither has a meeting of its own yet.
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    await ctl.sched(a, "Morning sync", when);
    await ctl.sched(a, "Evening wrap", when);
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const said = async (text: string, intent: unknown): Promise<Outcome> => { script[text] = [intent]; return only((await say(w, chat, text)).outcomes); };

    const early = await said("Can you get the morning one ready?", cmd("standup.prepare", { meetingTopic: "morning" }, "Can you get the morning one ready"));
    assert.equal(early.status, "refused", JSON.stringify(early));
    assert.ok(String(early.message).includes('"Morning sync"'), `the stand-up is named by its quoted title: ${early.message}`);
    assert.equal(early.proposalId, undefined, "nothing is proposed for a stand-up that has no meeting");
    assert.equal(JSON.stringify(early).includes("Evening wrap"), false, "only the stand-up the owner named is spoken of");

    // Nothing named: every stand-up of the project is told, because none can be worked on.
    const wide = await said("Get the stand-up ready.", cmd("standup.prepare", {}, "Get the stand-up ready"));
    assert.equal(wide.status, "refused", JSON.stringify(wide));
    assert.ok(String(wide.message).includes('"Morning sync"') && String(wide.message).includes('"Evening wrap"'), String(wide.message));

    // A note for an agent meets the same answer on the briefs side.
    const note = await said("Tell the morning agent to look at the cache.", cmd("standup.add-statement", { meetingTopic: "morning", agentName: "morning", section: "note", text: "look at the cache" }, "Tell the morning agent to look at the cache"));
    assert.equal(note.status, "refused", JSON.stringify(note));
    assert.ok(String(note.message).includes('"Morning sync"'), String(note.message));
    assert.equal(note.proposalId, undefined);

    // Once the meeting is planned, the same words are a proposal, and applying it prepares that stand-up.
    assert.equal((await w.meetings.tick(w.owner)).created.length, 2, "both stand-ups have a planned meeting now");
    const ready = await said("Can you get the morning one ready?", cmd("standup.prepare", { meetingTopic: "morning" }, "Can you get the morning one ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    assert.match(JSON.stringify(ready), /Morning sync/);
    assert.equal(JSON.stringify(ready).includes("Evening wrap"), false, "only the named stand-up is offered");
    assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ready.proposalId! })).applied, true, "applying prepares the stand-up the owner named");

    // A project with no stand-up, and one whose only stand-up has ended, are refused plainly rather than offering anything.
    const empty = await w.project("Empty");
    const bare = w.chat({ status: ctl.status() });
    await bare.setFocus(w.ownerToken, { commandId: cid("f"), projectId: empty });
    script["Get the stand-up ready."] = [cmd("standup.prepare", {}, "Get the stand-up ready")];
    const nothing = only((await say(w, bare, "Get the stand-up ready.")).outcomes);
    assert.equal(nothing.status, "refused", JSON.stringify(nothing));
    assert.match(String(nothing.message), /no stand-up/i);
    const one = await w.project("One");
    const ended = await ctl.sched(one, "Closed stand-up");
    await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("end"), args: { scheduleId: ended, expectedRevision: (await ctl.schedule(ended)).revision, state: "ended" } } as never);
    const past = w.chat({ status: ctl.status() });
    await past.setFocus(w.ownerToken, { commandId: cid("f"), projectId: one });
    script["Get the closed stand-up ready."] = [cmd("standup.prepare", { meetingTopic: "closed stand-up" }, "Get the closed stand-up ready")];
    const over = only((await say(w, past, "Get the closed stand-up ready.")).outcomes);
    assert.equal(over.status, "refused", JSON.stringify(over));
    assert.match(String(over.message), /no stand-up/i, "an ended stand-up is not one the project has");
    assert.equal(JSON.stringify(over).includes("Closed stand-up"), false, "the ended stand-up's title is not repeated as if it were running");
  });

  suite("acceptance M03h: a stand-up's brief is asked for in ordinary words; one that has not met is answered about itself, a name that fits none lists the project's stand-ups, and no agent is answered with another's brief", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    await ctl.sched(a, "Morning sync", when);
    // 12:30 London with a window from 12:00, past the world's clock of 11:00 London: nothing has been arranged for this one yet.
    await ctl.sched(a, "Friday review", { time: "12:30", windowFrom: "12:00", windowTo: "13:00" });
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const asked = async (text: string, intent: unknown): Promise<Outcome> => { script[text] = [intent]; return only((await say(w, chat, text)).outcomes); };
    const read = (meetingTopic: string, said: string, extra: Record<string, unknown> = {}): unknown => ({ kind: "status", request: { kind: "standup_briefs", meetingTopic, ...extra }, evidence: said.replace("?", ""), basis: "owner" });

    const notYet = await asked("What did the Friday review brief say?", read("friday review", "What did the Friday review brief say?"));
    assert.equal(notYet.status, "refused", JSON.stringify(notYet));
    assert.ok(String(notYet.message).includes('"Friday review"'), String(notYet.message));
    assert.match(String(notYet.message), /\bno\b.*\bmeeting\b/i, "it says the stand-up has no meeting yet");
    assert.equal(String(notYet.message).includes("Morning sync"), false, "only the stand-up named");
    const invented = await asked("What did the lunch stand-up brief say?", read("lunch stand-up", "What did the lunch stand-up brief say?"));
    assert.equal(invented.status, "refused", JSON.stringify(invented));
    assert.ok(String(invented.message).includes("lunch stand-up"), "the owner's words are repeated");
    assert.ok(String(invented.message).includes('"Friday review"') && String(invented.message).includes('"Morning sync"'), `the project's stand-ups are listed by their quoted titles: ${invented.message}`);

    // Once the morning stand-up has its meeting, it is prepared, noted on and read back.
    assert.equal((await w.meetings.tick(w.owner)).created.length, 1, "only the stand-up whose window is open has a meeting");
    const ready = await asked("Get the morning one ready.", cmd("standup.prepare", { meetingTopic: "morning" }, "Get the morning one ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ready.proposalId! })).applied, true);
    const note = await asked("Tell the morning agent: the demo is at four.", cmd("standup.add-statement", { meetingTopic: "morning", agentName: "morning", section: "note", text: "the demo is at four" }, "Tell the morning agent: the demo is at four"));
    assert.equal(note.status, "proposed", JSON.stringify(note));
    assert.match(JSON.stringify(note), /A-Morning sync/, "the proposal says whose brief the note goes on");
    assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: note.proposalId! })).applied, true);
    const seen = await asked("What does the morning agent's brief say?", read("morning", "What does the morning agent's brief say?", { agentName: "morning" }));
    assert.equal(seen.status, "answered", JSON.stringify(seen));
    assert.match(JSON.stringify(seen), /the demo is at four/);

    // An agent who is not on that stand-up gets nothing of another's brief, and a note for them is refused rather than put somewhere else.
    await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Nobody here" });
    const outsider = JSON.stringify(await asked("What does Nobody here's brief for the morning stand-up say?", read("morning", "What does Nobody here's brief for the morning stand-up say?", { agentName: "nobody here" })));
    assert.equal(outsider.includes("the demo is at four"), false, "another agent's note is not shown to stand in for one who has no brief");
    const misplaced = await asked("Tell Nobody here, for the morning stand-up: the demo is at four.", cmd("standup.add-statement", { meetingTopic: "morning", agentName: "nobody here", section: "note", text: "the demo is at four" }, "Tell Nobody here, for the morning stand-up: the demo is at four"));
    assert.equal(misplaced.status, "refused", JSON.stringify(misplaced));
    assert.match(String(misplaced.message), /no brief/i);
  });

  suite("acceptance M03h: a stand-up renamed after its meeting was made is reached by the title it has now", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    const morning = await ctl.sched(a, "Morning sync", when);
    assert.equal((await w.meetings.tick(w.owner)).created.length, 1, "the stand-up has its meeting planned");
    // The meeting keeps the title it was made with; the stand-up is renamed afterwards.
    const renamed = await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("rn"), args: { scheduleId: morning, expectedRevision: (await ctl.schedule(morning)).revision, title: "Daybreak check" } } as never) as { ok: boolean };
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const said = async (text: string, intent: unknown): Promise<Outcome> => { script[text] = [intent]; return only((await say(w, chat, text)).outcomes); };

    const ready = await said("Get the daybreak check ready.", cmd("standup.prepare", { meetingTopic: "daybreak check" }, "Get the daybreak check ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ready.proposalId! })).applied, true);
    const note = await said("Tell the morning agent at the daybreak check: the demo is at four.", cmd("standup.add-statement", { meetingTopic: "daybreak", agentName: "morning", section: "note", text: "the demo is at four" }, "Tell the morning agent at the daybreak check: the demo is at four"));
    assert.equal(note.status, "proposed", JSON.stringify(note));
    const brief = await said("What did the daybreak check brief say?", { kind: "status", request: { kind: "standup_briefs", meetingTopic: "daybreak check" }, evidence: "What did the daybreak check brief say", basis: "owner" });
    assert.equal(brief.status, "answered", JSON.stringify(brief));
  });

  suite("acceptance M03h: the stand-ups answer tells the meeting ahead of every stand-up, however many planned meetings the project has", async (w, script, ctl) => {
    const a = await w.project("A");
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    await ctl.sched(a, "Morning sync", when);
    await ctl.sched(a, "Evening wrap", when);
    assert.equal((await w.meetings.tick(w.owner)).created.length, 2);
    // The planned meetings are read a page at a time; with a page of one, the second stand-up's meeting is on the second page.
    const meetings = w.meetings as unknown as { planned: (v: unknown, p: string, page?: { afterId?: string; limit?: number }) => Promise<unknown> };
    const original = meetings.planned.bind(meetings);
    meetings.planned = (v, p, page = {}) => original(v, p, { ...page, limit: 1 });
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["What stand-ups do we have?"] = [{ kind: "status", request: { kind: "standups" }, evidence: "What stand-ups do we have?", basis: "owner" }];
    const answer = only((await say(w, chat, "What stand-ups do we have?")).outcomes);
    assert.equal(answer.status, "answered", JSON.stringify(answer));
    const lines = answer.lines!.map((l) => l.text);
    assert.equal(lines.filter((l) => l.includes("2026-10-22T10:30:00.000Z")).length, 2, JSON.stringify(lines));
  });

  suite("acceptance M03h: stand-ups are told apart by schedule, not title: one renamed to a title another's meeting still carries is never picked in that one's place", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    const old = await ctl.sched(a, "Morning sync", when);
    assert.equal((await w.meetings.tick(w.owner)).created.length, 1);
    // The first stand-up is renamed; its meeting keeps the old title. A new stand-up then takes the old title and gets its own meeting.
    const renamed = await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("rn"), args: { scheduleId: old, expectedRevision: (await ctl.schedule(old)).revision, title: "Daybreak check" } } as never) as { ok: boolean };
    assert.equal(renamed.ok, true, JSON.stringify(renamed));
    const fresh = await ctl.sched(a, "Morning sync", { time: "12:00", windowFrom: "08:00", windowTo: "13:00" });
    assert.equal((await w.meetings.tick(w.owner)).created.length, 1);
    const recent = await w.api.handle(w.ownerToken, { v: 1, op: "standup.recent", args: { projectId: a } } as never) as unknown as { ok: boolean; result: { item: { items: { occurrenceId: string; scheduleId: string; title: string; startsAt: string }[] } } };
    const items = recent.result.item.items;
    const ofOld = items.find((i) => i.scheduleId === old);
    const ofFresh = items.find((i) => i.scheduleId === fresh);
    assert.ok(ofOld !== undefined && ofFresh !== undefined, `standup.recent items carry their scheduleId: ${JSON.stringify(items)}`);
    assert.notEqual(ofOld.startsAt, ofFresh.startsAt);
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const said = async (text: string, intent: unknown): Promise<Outcome> => { script[text] = [intent]; return only((await say(w, chat, text)).outcomes); };

    const ready = await said("Get the morning sync ready.", cmd("standup.prepare", { meetingTopic: "morning sync" }, "Get the morning sync ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    const shown = JSON.stringify(ready.preview);
    assert.ok(shown.includes("Morning sync") && shown.includes(ofFresh.startsAt) && !shown.includes(ofOld.startsAt), `the stand-up called Morning sync now is the one prepared: ${shown}`);
    const brief = await said("What did the morning sync brief say?", { kind: "status", request: { kind: "standup_briefs", meetingTopic: "morning sync" }, evidence: "What did the morning sync brief say", basis: "owner" });
    assert.equal(brief.status, "answered", JSON.stringify(brief));
    const read = brief.lines!.flatMap((l) => (l.cites ?? []).map((c) => c.id));
    assert.ok(read.includes(ofFresh.occurrenceId) && !read.includes(ofOld.occurrenceId), "the meeting of the stand-up called Morning sync now is read, not the renamed one's");
    // The renamed one is still reached by its new title, and its proposal shows the title it has now.
    const day = await said("Get the daybreak check ready.", cmd("standup.prepare", { meetingTopic: "daybreak check" }, "Get the daybreak check ready"));
    assert.equal(day.status, "proposed", JSON.stringify(day));
    const dayShown = JSON.stringify(day.preview);
    assert.ok(dayShown.includes("Daybreak check") && dayShown.includes(ofOld.startsAt), dayShown);
  });

  suite("acceptance M03h: when words fit several stand-ups the chat asks, and the titles in its choices are quoted", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    await ctl.sched(a, "Morning sync", when);
    await ctl.sched(a, "Evening wrap", when);
    assert.equal((await w.meetings.tick(w.owner)).created.length, 2);
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["Prepare the stand-up."] = [cmd("standup.prepare", {}, "Prepare the stand-up")];
    const both = only((await say(w, chat, "Prepare the stand-up.")).outcomes);
    assert.equal(both.status, "asked", JSON.stringify(both));
    const offered = both.options ?? [];
    assert.ok(offered.some((o) => o.includes('"Morning sync"')) && offered.some((o) => o.includes('"Evening wrap"')), `both offered, titles quoted: ${JSON.stringify(offered)}`);
  });
}
