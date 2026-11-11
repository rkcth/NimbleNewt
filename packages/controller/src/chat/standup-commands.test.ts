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

  suite("a stand-up is paused, resumed and renamed by its title: the revision is filled in, a change of time is shown first, and an unclear title asks (card M03g)", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const morning = await ctl.sched(a, "Morning sync");
    const evening = await ctl.sched(a, "Evening wrap");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });

    script["Pause the morning stand-up."] = [cmd("standup.update", { standupTitle: "morning", state: "paused" }, "Pause the morning stand-up")];
    const paused = only((await say(w, chat, "Pause the morning stand-up.")).outcomes);
    assert.deepEqual([paused.status, paused.op], ["applied", "standup.update"], JSON.stringify(paused));
    assert.equal((await ctl.schedule(morning)).state, "paused");
    assert.equal((await ctl.schedule(evening)).state, "active", "the other stand-up is untouched");

    // Resuming wakes agents again: shown first even in the autonomous profile; applying the proposal resumes it.
    script["Resume the morning stand-up."] = [cmd("standup.update", { standupTitle: "morning", state: "active" }, "Resume the morning stand-up")];
    const resume = only((await say(w, chat, "Resume the morning stand-up.")).outcomes);
    assert.equal(resume.status, "proposed", JSON.stringify(resume));
    assert.equal((await ctl.schedule(morning)).state, "paused", "nothing changed before the owner applies it");
    await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: resume.proposalId! });
    assert.equal((await ctl.schedule(morning)).state, "active");

    // Ending cannot be undone: a proposal in every profile, and once applied the stand-up cannot be changed again.
    script["End the evening wrap stand-up."] = [cmd("standup.update", { standupTitle: "evening", state: "ended" }, "End the evening wrap stand-up")];
    const end = only((await say(w, chat, "End the evening wrap stand-up.")).outcomes);
    assert.equal(end.status, "proposed", JSON.stringify(end));
    assert.equal((await ctl.schedule(evening)).state, "active");
    await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: end.proposalId! });
    assert.equal((await ctl.schedule(evening)).state, "ended");
    script["Pause the evening wrap stand-up."] = [cmd("standup.update", { standupTitle: "evening", state: "paused" }, "Pause the evening wrap stand-up")];
    const gone = only((await say(w, chat, "Pause the evening wrap stand-up.")).outcomes);
    assert.equal(gone.status, "refused");
    assert.match(String(gone.message), /has ended/);

    // A new time changes when agents are woken: shown first, nothing changes until the owner applies it.
    script["Move the morning sync stand-up to 09:30."] = [cmd("standup.update", { standupTitle: "morning", time: "09:30" }, "Move the morning sync stand-up to 09:30")];
    const moved = only((await say(w, chat, "Move the morning sync stand-up to 09:30.")).outcomes);
    assert.equal(moved.status, "proposed", JSON.stringify(moved));
    assert.equal((await ctl.schedule(morning)).time, "09:00");

    // Two active stand-ups match: the owner is asked which, with both as options, and nothing changes.
    const second = await ctl.sched(a, "Afternoon check");
    script["Pause the stand-up."] = [cmd("standup.update", { state: "paused" }, "Pause the stand-up")];
    const asked = only((await say(w, chat, "Pause the stand-up.")).outcomes);
    assert.equal(asked.status, "asked", JSON.stringify(asked));
    assert.ok(JSON.stringify(asked).includes(morning) && JSON.stringify(asked).includes(second), "both stand-ups are offered");
    assert.ok(!JSON.stringify(asked).includes(evening), "an ended stand-up is not offered");
    assert.equal((await ctl.schedule(morning)).state, "active");
    assert.equal((await ctl.schedule(second)).state, "active");

    // Someone who may not read the project's meetings finds no stand-ups through the list either.
    const nobody = await w.agent("nobody", []);
    const denied = await w.api.handle(nobody.token, { v: 1, op: "standup.list", args: { projectId: a } } as never) as { ok: boolean };
    assert.equal(denied.ok, false);
    const listed = await w.api.handle(w.ownerToken, { v: 1, op: "standup.list", args: { projectId: a } } as never) as unknown as { ok: boolean; result: { item: { items: { title: string }[] } } };
    assert.deepEqual(listed.result.item.items.map((i) => i.title).sort(), ["Afternoon check", "Morning sync"], "the ended one is left out");

    // A readable project with no stand-ups answers an empty list, not "not found".
    const empty = await w.api.handle(w.ownerToken, { v: 1, op: "standup.list", args: { projectId: await w.project("Empty") } } as never) as unknown as { ok: boolean; result: { item: { items: unknown[]; more: boolean } } };
    assert.deepEqual([empty.ok, empty.result?.item.items.length, empty.result?.item.more], [true, 0, false]);
    // Ended stand-ups never hide an active one, by title or by ID: the active list is asked first, and an ID is read directly.
    const crowd = await w.project("Crowd");
    const dead: string[] = [];
    for (let i = 0; i < 3; i++) { const d = await ctl.sched(crowd, `Old ${i}`); await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("end"), args: { scheduleId: d, expectedRevision: (await ctl.schedule(d)).revision, state: "ended" } } as never); dead.push(d); }
    const live = await ctl.sched(crowd, "Live one");
    const chat2 = w.chat();
    await chat2.setFocus(w.ownerToken, { commandId: cid("f"), projectId: crowd });
    script["Pause the live one."] = [cmd("standup.update", { standupTitle: "live", state: "paused" }, "Pause the live one")];
    assert.equal(only((await say(w, chat2, "Pause the live one.")).outcomes).status, "applied");
    assert.equal((await ctl.schedule(live)).state, "paused");
    script[`Pause ${dead[0]}.`] = [cmd("standup.update", { scheduleId: dead[0], state: "paused" }, `Pause ${dead[0]}`)];
    const deadOut = only((await say(w, chat2, `Pause ${dead[0]}.`)).outcomes);
    assert.equal(deadOut.status, "refused");
    assert.match(String(deadOut.message), /has ended/);
    const act = await w.api.handle(w.ownerToken, { v: 1, op: "standup.list", args: { projectId: crowd } } as never) as unknown as { result: { item: { items: { title: string }[] } } };
    assert.deepEqual(act.result.item.items.map((i) => i.title), ["Live one"]);

    // A stand-up of another project cannot be reached by its ID from this one.
    const other = await ctl.sched(await w.project("B"), "Other team");
    script[`Pause ${other}.`] = [cmd("standup.update", { scheduleId: other, state: "paused" }, `Pause ${other}`)];
    const crossed = only((await say(w, chat, `Pause ${other}.`)).outcomes);
    assert.equal(crossed.status, "refused");
    assert.match(String(crossed.message), /not in this project/);
    assert.equal((await ctl.schedule(other)).state, "active");

    // A title that matches none is refused.
    script["Pause the night stand-up."] = [cmd("standup.update", { standupTitle: "night", state: "paused" }, "Pause the night stand-up")];
    assert.equal(only((await say(w, chat, "Pause the night stand-up.")).outcomes).status, "refused");
  });

  suite("setting up a stand-up by chat is always a proposal, and delivering outcomes applies at once (card M03g)", async (w, script) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["Set up a daily stand-up at 09:00, held between 08:00 and 10:00 Europe/London."] = [cmd("standup.configure", { title: "Daily", roster: [], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/London", recurrence: "daily" }, "Set up a daily stand-up at 09:00, held between 08:00 and 10:00 Europe/London")];
    const setUp = only((await say(w, chat, "Set up a daily stand-up at 09:00, held between 08:00 and 10:00 Europe/London.")).outcomes);
    assert.equal(setUp.status, "proposed", JSON.stringify(setUp));
    // A topic raised in chat is resolved; delivering puts the outcome on that turn once, and a second delivery adds nothing.
    script["Bring up the flaky tests at the stand-up."] = [cmd("agenda.capture", { topic: "the flaky tests" }, "Bring up the flaky tests")];
    const raised = await say(w, chat, "Bring up the flaky tests at the stand-up.");
    const item = (await w.meetings.agendaItem(w.owner, only(raised.outcomes).id!))!;
    await w.meetings.setAgendaState(w.owner, { commandId: cid("st"), itemId: item.id, expectedRevision: item.revision, to: "resolved", outcomeNote: "Quarantine them." });
    const followUps = async () => ((await chat.getTurn(w.ownerToken, raised.turnId))!.followUps ?? []).length;
    assert.equal(await followUps(), 0);
    script["Deliver the stand-up outcomes."] = [cmd("standup.deliver", {}, "Deliver the stand-up outcomes")];
    const delivered = only((await say(w, chat, "Deliver the stand-up outcomes.")).outcomes);
    assert.equal(delivered.status, "applied", JSON.stringify(delivered));
    assert.equal(await followUps(), 1, "the outcome reached the turn it came from");
    script["Deliver them again."] = [cmd("standup.deliver", {}, "Deliver them again")];
    assert.equal(only((await say(w, chat, "Deliver them again.")).outcomes).status, "applied");
    assert.equal(await followUps(), 1, "a second delivery tells nothing again");
  });

  suite("in the strict profile even a pause is shown first (card M03g)", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "strict";
    const id = await ctl.sched(a, "Morning sync");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["Pause the morning stand-up."] = [cmd("standup.update", { standupTitle: "morning", state: "paused" }, "Pause the morning stand-up")];
    assert.equal(only((await say(w, chat, "Pause the morning stand-up.")).outcomes).status, "proposed");
    assert.equal((await ctl.schedule(id)).state, "active");
  });

  suite("the chat's listing of turns shows what the stand-up put back on a turn, only the latest few, and the stored summary is unchanged (card M03g)", async (w, script) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    script["Bring up the flaky tests at the stand-up."] = [cmd("agenda.capture", { topic: "the flaky tests" }, "Bring up the flaky tests")];
    const r = await say(w, chat, "Bring up the flaky tests at the stand-up.");
    const listed = async () => (await chat.context(w.ownerToken)).projects[a]!.turns.find((t) => t.turnId === r.turnId)!;
    assert.equal((await listed()).followUps, undefined, "nothing happened later yet");
    const follow = chatTurnFollowUps(w.world.storage, w.projects.epoch);
    for (let i = 1; i <= 5; i++) await follow.add(r.turnId, { key: `k${i}`, text: `Decided ${i}.` });
    const shown = (await listed()).followUps!;
    assert.equal(shown.kept, 5);
    assert.deepEqual(shown.latest.map((f) => f.text), ["Decided 3.", "Decided 4.", "Decided 5."]);
    const stored = (await w.world.storage.getAggregate({ kind: "chat-context", id: `ctx:${w.owner.id}` }))!.body as unknown as { projects: Record<string, { turns: Record<string, unknown>[] }> };
    assert.ok(stored.projects[a]!.turns.every((t) => t["followUps"] === undefined), "the listing adds it on reading; the stored context is not changed");
  });
  suite("the owner prepares a stand-up now, leaves a note on an agent's brief and reads the briefs, naming them in loose words; the first two are shown first and an unclear name asks (card M03h)", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    // A stand-up at 11:30 London time (10:30 UTC) on a day when the world's clock reads 10:00 UTC: its preparation window is open, so a planned occurrence exists.
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    await ctl.sched(a, "Morning sync", when);
    await ctl.sched(a, "Evening wrap", when);
    const made = (await w.meetings.tick(w.owner)).created;
    assert.equal(made.length, 2, "both stand-ups have a planned occurrence");
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const briefsOf = async (text: string) => JSON.stringify((await say(w, chat, text)).outcomes);

    // Nothing is prepared yet, so there is no brief to read or write on.
    script["Add a note for the morning agent: look at the cache."] = [cmd("standup.add-statement", { meetingTopic: "morning", agentName: "morning", section: "note", text: "look at the cache" }, "Add a note for the morning agent: look at the cache")];
    const early = only((await say(w, chat, "Add a note for the morning agent: look at the cache.")).outcomes);
    assert.equal(early.status, "refused", JSON.stringify(early));
    assert.match(String(early.message), /no briefs yet/);

    // Preparing one named in loose words: shown first even in the autonomous profile, with the stand-up's own title; nothing happens until applied.
    script["Get the morning one ready now."] = [cmd("standup.prepare", { meetingTopic: "morning" }, "Get the morning one ready now")];
    const prep = only((await say(w, chat, "Get the morning one ready now.")).outcomes);
    assert.equal(prep.status, "proposed", JSON.stringify(prep));
    assert.match(JSON.stringify(prep), /Morning sync/);
    assert.equal(JSON.stringify(prep).includes("Evening wrap"), false, "only the named stand-up");
    const prepared = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: prep.proposalId! });
    assert.equal(prepared.applied, true, JSON.stringify(prepared));

    // Words that fit no title ask, listing what exists; words that fit two ask too.
    script["Prepare the lunch one."] = [cmd("standup.prepare", { meetingTopic: "lunch" }, "Prepare the lunch one")];
    const none = only((await say(w, chat, "Prepare the lunch one.")).outcomes);
    assert.equal(none.status, "asked", JSON.stringify(none));
    assert.ok(JSON.stringify(none).includes("Morning sync") && JSON.stringify(none).includes("Evening wrap"));
    script["Prepare the stand-up."] = [cmd("standup.prepare", {}, "Prepare the stand-up")];
    const both = only((await say(w, chat, "Prepare the stand-up.")).outcomes);
    assert.equal(both.status, "asked", JSON.stringify(both));

    // A note for an agent named by part of its name: shown first, kept as the owner's, and the revision it was proposed against is the brief's.
    script["Tell the morning agent: look at the cache."] = [cmd("standup.add-statement", { meetingTopic: "morning", agentName: "morning", section: "note", text: "look at the cache" }, "Tell the morning agent: look at the cache")];
    const note = only((await say(w, chat, "Tell the morning agent: look at the cache.")).outcomes);
    assert.equal(note.status, "proposed", JSON.stringify(note));
    assert.match(JSON.stringify(note), /A-Morning sync/);
    const done = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: note.proposalId! });
    assert.equal(done.applied, true, JSON.stringify(done));

    // The briefs are read by asking in words; the owner's note shows as the owner's, and an agent that is not on the stand-up finds nothing.
    script["What did the morning stand-up brief say?"] = [{ kind: "status", request: { kind: "standup_briefs", meetingTopic: "morning" }, evidence: "What did the morning stand-up brief say", basis: "owner" }];
    const read = await briefsOf("What did the morning stand-up brief say?");
    assert.match(read, /A note from the owner \(note\): \\"look at the cache\\"/);
    assert.match(read, /brief:/);
    script["Show the evening agent's brief."] = [{ kind: "status", request: { kind: "standup_briefs", meetingTopic: "evening", agentName: "morning" }, evidence: "Show the evening agent's brief", basis: "owner" }];
    const wrong = await briefsOf("Show the evening agent's brief.");
    assert.match(wrong, /No brief has been prepared|no brief/i);
  });

  suite("what stand-ups the project has is answered from the schedules and their meetings, asked in ordinary words; the project comes from the focus and ended ones are counted, not listed (card M03h)", async (w, script, ctl) => {
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
    assert.match(lines[0]!, /^"Evening wrap": active, daily at 11:30 Europe\/London, 30 minutes, held between 08:00 and 13:00\. On the roster: agent:/);
    assert.match(lines[1]!, /^next one 2026-10-22T10:30:00\.000Z; it has not met yet; 1 meeting of it so far\.$/);
    assert.match(lines[2]!, /^"Morning sync": active, daily at 11:30 Europe\/London/);
    assert.ok(first.lines!.every((l) => l.cites.some((x) => x.kind === "project" && x.id === a)), "every line cites the project");
    assert.ok(first.lines![0]!.cites.some((x) => x.kind === "meeting-schedule"), "the schedule line cites the schedule it reads");
    assert.ok(first.lines![1]!.cites.some((x) => x.kind === "meeting"), "the meeting line cites the occurrence it names");

    // A narrower ask is a page, and the answer says it cut the rest.
    script["Just the first stand-up, please."] = [{ kind: "status", request: { kind: "standups", limit: 1 }, evidence: "Just the first stand-up, please", basis: "owner" }];
    assert.match(await asked("Just the first stand-up, please."), /There are more stand-ups than shown\./);

    // A stand-up that has ended is not one the project is running, but it is counted; a paused one is shown as paused.
    await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("end"), args: { scheduleId: morning, expectedRevision: (await ctl.schedule(morning)).revision, state: "ended" } } as never);
    assert.match(await asked("What stand-ups do we have?"), /1 ended stand-up of this project is left out\./);
    assert.ok(!(await asked("What stand-ups do we have?")).includes("Morning sync"), "the ended stand-up is not listed");

    // Another project the owner has, with no stand-up of its own, says so plainly (the focus moves, and the answer follows it).
    const quiet = await w.project("Quiet");
    const other = w.chat({ status: ctl.status() });
    await other.setFocus(w.ownerToken, { commandId: cid("f"), projectId: quiet });
    assert.match(JSON.stringify((await say(w, other, "What stand-ups do we have?", cid("m"))).outcomes), /No stand-up is set up in this project\./);
  });

  suite("an order to get a stand-up ready or to write on its briefs says what the project actually has: a stand-up set up but not yet met is named, never invented away (card M03h)", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    // Both stand-ups are at 11:30 London (10:30 UTC), past the world's clock of 10:00 UTC, and nothing has been ticked, so neither has a meeting of its own yet.
    const when = { time: "11:30", windowFrom: "08:00", windowTo: "13:00" };
    await ctl.sched(a, "Morning sync", when);
    await ctl.sched(a, "Evening wrap", when);
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const said = async (text: string, intent: unknown): Promise<Outcome> => { script[text] = [intent]; return only((await say(w, chat, text)).outcomes); };

    // One word of the owner's words reaches the stand-up they meant, and the answer is about that one.
    const early = await said("Can you get the morning one ready?", cmd("standup.prepare", { meetingTopic: "morning" }, "Can you get the morning one ready"));
    assert.equal(early.status, "refused", JSON.stringify(early));
    assert.match(String(early.message), /"Morning sync" is set up in this project but has no meeting to prepare right now/, "the owner is told the stand-up by the title it has");
    assert.equal(early.proposalId, undefined, "nothing is proposed for a stand-up that has no meeting");
    assert.equal(JSON.stringify(early).includes("Evening wrap"), false, "only the stand-up the owner named is spoken of");

    // Nothing named: every stand-up of the project is told, because none can be worked on.
    const wide = await said("Get the stand-up ready.", cmd("standup.prepare", {}, "Get the stand-up ready"));
    assert.equal(wide.status, "refused", JSON.stringify(wide));
    assert.match(String(wide.message), /"Morning sync"/);
    assert.match(String(wide.message), /"Evening wrap"/);
    assert.match(String(wide.message), /"Evening wrap" and "Morning sync" have no meeting to prepare yet/);

    // A note for an agent meets the same answer on the briefs side.
    const note = await said("Tell the morning agent to look at the cache.", cmd("standup.add-statement", { meetingTopic: "morning", agentName: "morning", section: "note", text: "look at the cache" }, "Tell the morning agent to look at the cache"));
    assert.equal(note.status, "refused", JSON.stringify(note));
    assert.match(String(note.message), /"Morning sync" is set up in this project but has no meeting to write into right now/);

    // Once the meeting is planned, the same words are a proposal, and applying it prepares that stand-up.
    assert.equal((await w.meetings.tick(w.owner)).created.length, 2, "both stand-ups have a planned meeting now");
    const ready = await said("Can you get the morning one ready?", cmd("standup.prepare", { meetingTopic: "morning" }, "Can you get the morning one ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    assert.match(JSON.stringify(ready), /Morning sync/);
    assert.equal(JSON.stringify(ready).includes("Evening wrap"), false, "only the named stand-up is offered");
    assert.equal((await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ready.proposalId! })).applied, true, "applying prepares the stand-up the owner named");

    // A project with no stand-up, and one whose only stand-up has ended, say so plainly rather than offering anything.
    const empty = await w.project("Empty");
    const bare = w.chat({ status: ctl.status() });
    await bare.setFocus(w.ownerToken, { commandId: cid("f"), projectId: empty });
    script["Get the stand-up ready."] = [cmd("standup.prepare", {}, "Get the stand-up ready")];
    assert.match(JSON.stringify(only((await say(w, bare, "Get the stand-up ready.")).outcomes)), /no stand-up is set up in this project/);
    const one = await w.project("One");
    const ended = await ctl.sched(one, "Closed stand-up");
    await w.api.handle(w.ownerToken, { v: 1, op: "standup.update", commandId: cid("end"), args: { scheduleId: ended, expectedRevision: (await ctl.schedule(ended)).revision, state: "ended" } } as never);
    const past = w.chat({ status: ctl.status() });
    await past.setFocus(w.ownerToken, { commandId: cid("f"), projectId: one });
    script["Get the closed stand-up ready."] = [cmd("standup.prepare", { meetingTopic: "closed stand-up" }, "Get the closed stand-up ready")];
    const over = only((await say(w, past, "Get the closed stand-up ready.").then((r) => r.outcomes)));
    assert.equal(over.status, "refused", JSON.stringify(over));
    assert.match(String(over.message), /no stand-up is set up in this project/, "an ended stand-up is not one the project has");
    assert.equal(JSON.stringify(over).includes("Closed stand-up"), false, "the ended stand-up's title is not repeated as if it were running");
  });

  suite("a stand-up's brief is read by asking in ordinary words, and a stand-up that has not met is answered about itself; an agent who is not on it is never answered with someone else's brief (card M03h)", async (w, script, ctl) => {
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

    // Nothing has been ticked: a question about the stand-up that has not met is answered about that stand-up, and one about a name that fits nothing says what the project has.
    const notYet = await asked("What did the Friday review brief say?", read("friday review", "What did the Friday review brief say?"));
    assert.equal(notYet.status, "refused", JSON.stringify(notYet));
    assert.match(String(notYet.message), /"Friday review" has no stand-up meeting yet, so nothing has been briefed for it/);
    const invented = await asked("What did the lunch stand-up brief say?", read("lunch stand-up", "What did the lunch stand-up brief say?"));
    assert.equal(invented.status, "refused", JSON.stringify(invented));
    assert.match(String(invented.message), /no stand-up in that project is called "lunch stand-up"/);
    assert.match(String(invented.message), /It has "Friday review" and "Morning sync"\./, "the owner is told the stand-ups the project has, by their titles, in one order");

    // Once the morning stand-up has its meeting, the same kind of question reads it: prepared, noted on and quoted back as the owner's words.
    assert.equal((await w.meetings.tick(w.owner)).created.length, 1, "only the stand-up whose window is open has a meeting");
    const ready = await asked("Get the morning one ready.", cmd("standup.prepare", { meetingTopic: "morning" }, "Get the morning one ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    const didReady = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ready.proposalId! });
    assert.equal(didReady.applied, true, JSON.stringify(didReady));
    const note = await asked("Tell the morning agent: the demo is at four.", cmd("standup.add-statement", { meetingTopic: "morning", agentName: "morning", section: "note", text: "the demo is at four" }, "Tell the morning agent: the demo is at four"));
    assert.equal(note.status, "proposed", JSON.stringify(note));
    assert.match(JSON.stringify(note), /A-Morning sync/, "the proposal says whose brief the note goes on");
    const didNote = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: note.proposalId! });
    assert.equal(didNote.applied, true, JSON.stringify(didNote));
    const seen = JSON.stringify(await asked("What does the morning agent's brief say?", read("morning", "What does the morning agent's brief say?", { agentName: "morning" })));
    assert.match(seen, /A note from the owner \(note\): \\"the demo is at four\\"/, "the note is told as the owner's own words, quoted");
    assert.match(seen, /brief:/, "the line cites the brief it reads");

    // An agent who is not on that stand-up gets nothing of another's brief, and a note for them is refused rather than put somewhere else.
    await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Nobody here" });
    const outsider = JSON.stringify(await asked("What does Nobody here's brief for the morning stand-up say?", read("morning", "What does Nobody here's brief for the morning stand-up say?", { agentName: "nobody here" })));
    assert.equal(outsider.includes("the demo is at four"), false, "another agent's note is not shown to stand in for one who has no brief");
    const misplaced = await asked("Tell Nobody here, for the morning stand-up: the demo is at four.", cmd("standup.add-statement", { meetingTopic: "morning", agentName: "nobody here", section: "note", text: "the demo is at four" }, "Tell Nobody here, for the morning stand-up: the demo is at four"));
    assert.equal(misplaced.status, "refused", JSON.stringify(misplaced));
    assert.match(String(misplaced.message), /no brief in that stand-up is for an agent called/);
  });

  suite("a stand-up renamed after its meeting was made is still reached by the title it has now, and is never told it has no meeting (review of card M03h)", async (w, script, ctl) => {
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
    assert.doesNotMatch(JSON.stringify(brief), /has no stand-up meeting yet/);
  });

  suite("the stand-ups answer tells the meeting ahead of every stand-up, however many meetings the project has planned (review of card M03h)", async (w, script, ctl) => {
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
    const lines = only((await say(w, chat, "What stand-ups do we have?")).outcomes).lines!.map((l) => l.text);
    assert.equal(lines.filter((l) => l.startsWith("next one ")).length, 2, JSON.stringify(lines));
  });

  suite("a stand-up renamed to a title another stand-up's meeting still carries is never picked in that one's place (second review of card M03h)", async (w, script, ctl) => {
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
    const ofOld = items.find((i) => i.scheduleId === old)!;
    const ofFresh = items.find((i) => i.scheduleId === fresh)!;
    assert.notEqual(ofOld.startsAt, ofFresh.startsAt);
    assert.equal(items.filter((i) => i.title === "Morning sync").length, 2, "both meetings carry the title Morning sync");
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const said = async (text: string, intent: unknown): Promise<Outcome> => { script[text] = [intent]; return only((await say(w, chat, text)).outcomes); };

    const ready = await said("Get the morning sync ready.", cmd("standup.prepare", { meetingTopic: "morning sync" }, "Get the morning sync ready"));
    assert.equal(ready.status, "proposed", JSON.stringify(ready));
    // The proposal names the meeting it prepares by its stand-up's title and start.
    assert.deepEqual(ready.preview, [`Prepare a stand-up now: occurrenceId="Morning sync (${ofFresh.startsAt})"`], "the stand-up called Morning sync now is the one prepared");
    const brief = await said("What did the morning sync brief say?", { kind: "status", request: { kind: "standup_briefs", meetingTopic: "morning sync" }, evidence: "What did the morning sync brief say", basis: "owner" });
    assert.equal(brief.status, "answered", JSON.stringify(brief));
    assert.deepEqual(brief.lines!.flatMap((l) => (l.cites ?? []).map((c) => c.id)), [ofFresh.occurrenceId], "the meeting of the stand-up called Morning sync now is read, not the renamed one's");
    // The renamed one is still reached by its new title.
    const day = await said("Get the daybreak check ready.", cmd("standup.prepare", { meetingTopic: "daybreak check" }, "Get the daybreak check ready"));
    assert.equal(day.status, "proposed", JSON.stringify(day));
    // ... and its proposal shows the title it has now, not the one its meeting was made with.
    assert.deepEqual(day.preview, [`Prepare a stand-up now: occurrenceId="Daybreak check (${ofOld.startsAt})"`]);
  });

  suite("the owner reads what the stand-ups asked and answers in their own words: the question is found by part of its topic, an unclear name asks, a lone question is shown first (card M03h)", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const settle = async (topic: string, question: string): Promise<void> => {
      const made = await w.meetings.addAgendaItem(w.owner, { commandId: cid("cap"), projectId: a, topic, urgency: "normal", intent: "discussion" } as never);
      const item = (await w.meetings.agendaItem(w.owner, made.id))!;
      await w.meetings.setAgendaState(w.owner, { commandId: cid("st"), itemId: item.id, expectedRevision: item.revision, to: "resolved", outcomeNote: "Talked it over.", ownerQuestion: question });
    };
    await settle("Nightly backups", "Keep seven nightly backups or thirty?");
    await settle("Old API", "Which release is the last to carry the old API?");
    type Q = { topic: string; answer?: string };
    const read = async () => ((await w.api.handle(w.ownerToken, { v: 1, op: "standup.owner-questions", args: { projectId: a } } as never)) as unknown as { result: { item: { open: Q[]; answered: Q[] } } }).result.item;
    const open = async () => (await read()).open;
    const answered = async () => (await read()).answered;

    // Asking what the stand-ups want lists both, with the words they asked.
    script["What is the stand-up asking me?"] = [{ kind: "status", request: { kind: "standup_questions" }, evidence: "What is the stand-up asking me", basis: "owner" }];
    const listed = only((await say(w, chat, "What is the stand-up asking me?")).outcomes);
    assert.equal(listed.status, "answered", JSON.stringify(listed));
    assert.match(JSON.stringify(listed), /seven nightly backups or thirty/);
    assert.match(JSON.stringify(listed), /last to carry the old API/);

    // An answer that names a question by part of its topic is applied at once to that one, with the owner's own words; the other stays open.
    script["About the backups question: keep thirty."] = [cmd("standup.answer-question", { questionTopic: "backups", answer: "keep thirty" }, "About the backups question: keep thirty")];
    const first = only((await say(w, chat, "About the backups question: keep thirty.")).outcomes);
    assert.equal(first.status, "applied", JSON.stringify(first));
    assert.deepEqual((await answered()).map((q) => [q.topic, q.answer]), [["Nightly backups", "keep thirty"]]);
    assert.deepEqual((await open()).map((q) => q.topic), ["Old API"]);

    // Words that fit nothing refuse and say what was looked for.
    script["About the printer question: yes."] = [cmd("standup.answer-question", { questionTopic: "printer", answer: "yes" }, "About the printer question: yes")];
    const none = only((await say(w, chat, "About the printer question: yes.")).outcomes);
    assert.equal(none.status, "refused", JSON.stringify(none));
    assert.match(String(none.message), /printer/);

    // An answer the owner did not say is refused; nothing is invented for them.
    script["About the old API question: whatever you think."] = [cmd("standup.answer-question", { questionTopic: "old API", answer: "release 9.1" }, "About the old API question: whatever you think")];
    const invented = only((await say(w, chat, "About the old API question: whatever you think.")).outcomes);
    assert.equal(invented.status, "refused", JSON.stringify(invented));
    assert.equal((await open()).length, 1);

    // An answer that names no question while one waits is shown first, with the question it would answer.
    script["Tell the stand-up: version 2.0."] = [cmd("standup.answer-question", { answer: "version 2.0" }, "Tell the stand-up: version 2.0")];
    const lone = only((await say(w, chat, "Tell the stand-up: version 2.0.")).outcomes);
    assert.equal(lone.status, "proposed", JSON.stringify(lone));
    assert.match(JSON.stringify(lone), /last to carry the old API/);
    assert.equal((await open()).length, 1, "nothing is answered before the owner agrees");
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: lone.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal((await open()).length, 0);
    assert.deepEqual((await answered()).map((q) => q.answer).sort(), ["keep thirty", "version 2.0"]);

    // Nothing waits any more.
    script["Is there anything else the stand-up wants?"] = [cmd("standup.answer-question", { answer: "no" }, "Is there anything else the stand-up wants")];
    const empty = only((await say(w, chat, "Is there anything else the stand-up wants?")).outcomes);
    assert.equal(empty.status, "refused", JSON.stringify(empty));
  });

  suite("words that fit two stand-up questions ask which, and the owner's pick answers the one picked, shown first; an ID the model supplies is not taken (card M03h review)", async (w, script, ctl) => {
    const a = await w.project("A");
    w.profile.value = "autonomous";
    const chat = w.chat({ status: ctl.status() });
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: a });
    const settle = async (topic: string, question: string): Promise<void> => {
      const made = await w.meetings.addAgendaItem(w.owner, { commandId: cid("cap"), projectId: a, topic, urgency: "normal", intent: "discussion" } as never);
      const item = (await w.meetings.agendaItem(w.owner, made.id))!;
      await w.meetings.setAgendaState(w.owner, { commandId: cid("st"), itemId: item.id, expectedRevision: item.revision, to: "resolved", outcomeNote: "Talked it over.", ownerQuestion: question });
    };
    await settle("Release train", "Should the release wait for the audit?");
    await settle("Release notes", "Who writes the release notes?");
    type Q = { id: string; topic: string; answer?: string };
    const read = async () => ((await w.api.handle(w.ownerToken, { v: 1, op: "standup.owner-questions", args: { projectId: a } } as never)) as unknown as { result: { item: { open: Q[]; answered: Q[] } } }).result.item;
    const [train, notes] = (await read()).open;

    // A question ID the owner never said is the model's own: it is not taken.
    script["About the release: Maya does."] = [cmd("standup.answer-question", { questionId: notes!.id, answer: "Maya does" }, "About the release: Maya does")];
    const forged = only((await say(w, chat, "About the release: Maya does.")).outcomes);
    assert.equal(forged.status, "refused", JSON.stringify(forged));
    assert.equal((await read()).open.length, 2);

    // Words that fit both ask which; nothing is answered meanwhile.
    script["About the release question: Maya does."] = [cmd("standup.answer-question", { questionTopic: "release", answer: "Maya does" }, "About the release question: Maya does")];
    const asked = await say(w, chat, "About the release question: Maya does.", "m-ask");
    assert.deepEqual(asked.outcomes.map((o) => o.status), ["asked"], JSON.stringify(asked));
    assert.deepEqual([...(await chat.context(w.ownerToken)).awaiting!.choices].sort(), [train!.id, notes!.id].sort());
    assert.equal((await read()).open.length, 2);

    // The owner picks the notes question: it is shown first with the question it answers, and applied when the owner agrees.
    script["the notes one"] = [{ kind: "answer", turnId: asked.turnId, choice: notes!.id, evidence: "the notes one", basis: "owner" }];
    const picked = only((await say(w, chat, "the notes one", "m-pick")).outcomes);
    assert.equal(picked.status, "proposed", JSON.stringify(picked));
    assert.match(JSON.stringify(picked), /Who writes the release notes/);
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: picked.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    const after = await read();
    assert.deepEqual(after.open.map((q) => q.topic), ["Release train"]);
    assert.deepEqual(after.answered.map((q) => [q.topic, q.answer]), [["Release notes", "Maya does"]]);
  });
}
