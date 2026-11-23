import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { StatusService } from "../status/index.js";
import { StandupService } from "../standups/index.js";
import { clockTimeInWords, oneOffDayInWords, weekdaysInWords } from "./commands.js";
import { ModelInterpreter, type ModelCall } from "./model-interpreter.js";
import type { Outcome } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// The owner schedules, changes and calls meetings in free words (card "chat meetings"). Everything below goes through the real chat and the real ModelInterpreter: the stand-in model sees only the prompt and the owner's
// words (it answers only for an operation whose line, with the argument it needs, is in the prompt) and hands over only what the owner said, except where a case invents a value on purpose and says so.

after(stopServer);

type Rule = { op?: string; args?: Record<string, unknown>; status?: Record<string, unknown>; invents?: boolean };
/** What an interpreter would make of each message: the operation and its arguments, each a value from the owner's words or (time, zone, recurrence) worked out from them. */
const RULES: Record<string, Rule> = {
  "Set up a weekly planning meeting with Ann Lee and Bob every Monday at 9:30am Eastern time": { op: "meeting.schedule", args: { title: "weekly planning meeting", agentNames: ["Ann Lee", "Bob"], time: "09:30", recurrence: { kind: "weekly", days: [1] }, timeZone: "America/New_York" } },
  "Set up a planning meeting with Bob every day Eastern time": { op: "meeting.schedule", invents: true, args: { title: "planning meeting", agentNames: ["Bob"], time: "09:00", recurrence: { kind: "daily" }, timeZone: "America/New_York" } },
  "Set up a planning meeting with Bob every day Eastern time, no hour yet": { op: "meeting.schedule", args: { title: "planning meeting", agentNames: ["Bob"], recurrence: { kind: "daily" }, timeZone: "America/New_York" } },
  "Set up a daily review with Bob at 4pm": { op: "meeting.schedule", args: { title: "daily review", agentNames: ["Bob"], time: "16:00", recurrence: { kind: "daily" } } },
  "Set up a review with Bob at 4pm Eastern time": { op: "meeting.schedule", args: { title: "review", agentNames: ["Bob"], time: "16:00", timeZone: "America/New_York" } },
  "Set up a daily check-in with Ann at 2pm Eastern time": { op: "meeting.schedule", args: { title: "daily check-in", agentNames: ["Ann"], time: "14:00", recurrence: { kind: "daily" }, timeZone: "America/New_York" } },
  "Set up a daily check-in with Zed at 2pm Eastern time": { op: "meeting.schedule", args: { title: "daily check-in", agentNames: ["Zed"], time: "14:00", recurrence: { kind: "daily" }, timeZone: "America/New_York" } },
  "Set up a daily review at 2pm Eastern time": { op: "meeting.schedule", args: { title: "daily review", time: "14:00", recurrence: { kind: "daily" }, timeZone: "America/New_York" } },
  "Set up a one-off retro with Bob on 2026-11-24 at 3pm Eastern time": { op: "meeting.schedule", args: { title: "retro", agentNames: ["Bob"], time: "15:00", recurrence: { kind: "once", date: "2026-11-24" }, timeZone: "America/New_York" } },
  "Move the planning meeting to 10am": { op: "meeting.update-schedule", args: { meetingTopic: "planning", time: "10:00" } },
  "Pause the planning meeting": { op: "meeting.update-schedule", args: { meetingTopic: "planning", state: "paused" } },
  "End the weekly planning meeting": { op: "meeting.update-schedule", args: { meetingTopic: "weekly planning", state: "ended" } },
  "Change the planning meeting": { op: "meeting.update-schedule", args: { meetingTopic: "planning" } },
  "Move the budget meeting to 10am": { op: "meeting.update-schedule", args: { meetingTopic: "budget", time: "10:00" } },
  "Add Bob to the weekly planning meeting": { op: "meeting.update-schedule", args: { meetingTopic: "weekly planning", agentNames: ["Bob"] } },
  "Call Ann Lee and Bob into a meeting now: the build is red": { op: "meeting.call-urgent", args: { title: "the build is red", reason: "the build is red", agentNames: ["Ann Lee", "Bob"] } },
  "Call Bob into a meeting now": { op: "meeting.call-urgent", args: { title: "meeting", agentNames: ["Bob"] } },
  "Call Bob into a meeting now, the build is red": { op: "meeting.call-urgent", invents: true, args: { title: "the build is red", reason: "the build is red", agentNames: ["Bob"], durationMinutes: 45 } },
  "Call Bob into a meeting now for 45 minutes, the build is red": { op: "meeting.call-urgent", args: { title: "the build is red", reason: "the build is red", agentNames: ["Bob"], durationMinutes: 45 } },
  "Call a meeting now, the build is red": { op: "meeting.call-urgent", args: { title: "the build is red", reason: "the build is red" } },
  "Pull everyone on this project into a meeting now, the release is blocked": { op: "meeting.attend.call-now", args: { title: "the release is blocked", reason: "the release is blocked" } },
  "What meetings are scheduled?": { status: { kind: "meetings" } },
  "Show me 1 meeting": { status: { kind: "meetings", limit: 1 } },
  "Show me 1 meeting after 1": { status: { kind: "meetings", limit: 1, after: 1 } },
  "Show me the meetings after 3": { status: { kind: "meetings", after: 3 } },
  // One-off days, against the fixed clock of the test world (Thursday 2026-10-22, 06:00 in New York).
  "Set up a retro with Bob tomorrow at 3pm Eastern time": { op: "meeting.schedule", args: { title: "retro", agentNames: ["Bob"], time: "15:00", recurrence: { kind: "once", date: "2026-10-23" }, timeZone: "America/New_York" } },
  "Set up a retro with Bob on Friday at 3pm Eastern time": { op: "meeting.schedule", args: { title: "retro", agentNames: ["Bob"], time: "15:00", recurrence: { kind: "once", date: "2026-10-23" }, timeZone: "America/New_York" } },
  "Set up a one-off retro with Bob at 3pm Eastern time": { op: "meeting.schedule", invents: true, args: { title: "retro", agentNames: ["Bob"], time: "15:00", recurrence: { kind: "once", date: "2026-10-23" }, timeZone: "America/New_York" } },
  "Set up a retro with Bob tomorrow at 4pm Eastern time": { op: "meeting.schedule", invents: true, args: { title: "retro", agentNames: ["Bob"], time: "16:00", recurrence: { kind: "once", date: "2026-10-24" }, timeZone: "America/New_York" } },
  "Set up a retro with Bob on 2026-10-01 at 3pm Eastern time": { op: "meeting.schedule", args: { title: "retro", agentNames: ["Bob"], time: "15:00", recurrence: { kind: "once", date: "2026-10-01" }, timeZone: "America/New_York" } },
  "Set up a retro with Bob today at 5am Eastern time": { op: "meeting.schedule", args: { title: "retro", agentNames: ["Bob"], time: "05:00", recurrence: { kind: "once", date: "2026-10-22" }, timeZone: "America/New_York" } },
  "Set up a night check with Bob on 2027-03-14 at 2:30am Eastern time": { op: "meeting.schedule", args: { title: "night check", agentNames: ["Bob"], time: "02:30", recurrence: { kind: "once", date: "2027-03-14" }, timeZone: "America/New_York" } },
  "Set up a night check with Bob on 2026-11-01 at 1:30am Eastern time": { op: "meeting.schedule", args: { title: "night check", agentNames: ["Bob"], time: "01:30", recurrence: { kind: "once", date: "2026-11-01" }, timeZone: "America/New_York" } },
  // Weekdays: each must be named.
  "Set up a sync with Bob every Monday at 9am Eastern time": { op: "meeting.schedule", invents: true, args: { title: "sync", agentNames: ["Bob"], time: "09:00", recurrence: { kind: "weekly", days: [1, 3] }, timeZone: "America/New_York" } },
  "Set up a sync with Bob every weekday at 9am Eastern time": { op: "meeting.schedule", args: { title: "sync", agentNames: ["Bob"], time: "09:00", recurrence: { kind: "weekly", days: [1, 2, 3, 4, 5] }, timeZone: "America/New_York" } },
  "Set up a sync with Bob every Mon and Thursdays at 9am Eastern time": { op: "meeting.schedule", args: { title: "sync", agentNames: ["Bob"], time: "09:00", recurrence: { kind: "weekly", days: [1, 4] }, timeZone: "America/New_York" } },
};
const DERIVED = new Set(["time", "timeZone", "date", "kind", "state", "days"]);

for (const backend of backends) {
  const open = async () => {
    const invented: string[] = [];
    const violations: string[] = [];
    const seen: string[] = [];
    const holder: { status?: StatusService } = {};
    const lazy = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => (holder.status as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!(...a) }) as StatusService;
    const model: ModelCall = {
      complete: async (_route, r) => {
        const owner = /OWNER:\n<<<\n([\s\S]*?)\n>>>/.exec(r.user)![1]!;
        seen.push(r.user);
        const rule = RULES[owner];
        if (rule === undefined) return JSON.stringify([{ kind: "none", reason: "no rule" }]);
        if (rule.status !== undefined) return JSON.stringify([{ kind: "status", request: rule.status, evidence: owner, basis: "owner" }]);
        // Only an operation whose line is in the prompt with every argument it is given (the prompt is all the stand-in knows).
        const line = new RegExp(`(?:^|; )${rule.op!.replace(/\./g, "\\.")}\\(([^)]*)\\) - `).exec(r.system);
        if (line === null || !Object.keys(rule.args!).every((k) => line[1]!.split(", ").includes(k))) return JSON.stringify([{ kind: "none", reason: "the prompt describes no way to do this" }]);
        const walk = (v: unknown, key: string): void => {
          if (typeof v === "string" && !DERIVED.has(key) && !owner.toLowerCase().includes(v.toLowerCase())) violations.push(`${key}=${v}`);
          if (Array.isArray(v)) v.forEach((x) => walk(x, key));
          else if (v !== null && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
        };
        for (const [k, v] of Object.entries(rule.args!)) walk(v, k);
        if (rule.invents === true) invented.push(owner);
        return JSON.stringify([{ kind: "command", op: rule.op, args: rule.args, evidence: owner, basis: "owner" }]);
      },
    };
    const w = await openWorld(backend);
    holder.status = StatusService.withEpoch(w.world.storage, w.projects.epoch, { assignments: w.assignments, waits: WaitService.withEpoch(w.world.storage, w.projects.epoch, w.assignments, options), blockers: BlockerService.withEpoch(w.world.storage, w.projects.epoch, options), contracts: w.contracts, meetings: w.meetings }, options);
    const chat = w.chat({ interpreter: new ModelInterpreter(model, () => ["test/model"]), status: lazy });
    const project = await w.project("Garden");
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: project });
    w.profile.value = "autonomous";
    const mk = async (name: string): Promise<string> => { const a = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: name }); return (await w.agents.get(w.owner, a.id))!.principalId as string; };
    const say = async (text: string): Promise<Outcome> => { const r = await chat.submit(w.ownerToken, { messageId: cid("m"), text }); assert.equal(r.outcomes.length, 1, JSON.stringify(r.outcomes)); return r.outcomes[0]!; };
    const schedules = async (p = project) => (await w.meetings.schedules(w.owner, p))!;
    const apply = async (o: Outcome) => chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! });
    return { w, chat, project, mk, say, schedules, apply, invented, violations, seen };
  };

  test(`${backend.name}: a meeting is scheduled by words: names resolved to agents, the time and zone shown, nothing made until the owner agrees, and what is made is what was shown`, async () => {
    const { w, project, mk, say, schedules, apply, violations, seen } = await open();
    try {
      const ann = await mk("Ann Lee");
      const bob = await mk("Bob");
      const text = "Set up a weekly planning meeting with Ann Lee and Bob every Monday at 9:30am Eastern time";
      const o = await say(text);
      assert.equal(o.status, "proposed", JSON.stringify(o));
      assert.equal((await schedules()).items.length, 0, "nothing is made before the owner agrees");
      const shown = JSON.stringify(o);
      for (const part of ["Ann Lee", "Bob", "every Monday", "09:30", "America/New_York", "weekly planning meeting", "invited to every meeting"]) assert.ok(shown.includes(part), `${part} is on the proposal: ${shown}`);
      assert.ok(!shown.includes(ann) && !shown.includes(bob), "the proposal shows names, not principal IDs");
      assert.deepEqual(violations, [], "the stand-in handed over only the owner's words");
      assert.ok(!seen.join("\n").includes("earlier answer"), "the interpreter sees no earlier answer");
      const applied = await apply(o);
      assert.equal(applied.applied, true, JSON.stringify(applied));
      const made = (await schedules()).items;
      assert.equal(made.length, 1);
      assert.deepEqual([made[0]!.title, made[0]!.time, made[0]!.timeZone, made[0]!.recurrence, [...made[0]!.roster].sort(), made[0]!.durationMinutes], ["weekly planning meeting", "09:30", "America/New_York", { kind: "weekly", days: [1] }, [ann, bob].sort(), 30]);
      // A one-off meeting says when it is in UTC as well, so a wrong date or zone is seen.
      const once = await say("Set up a one-off retro with Bob on 2026-11-24 at 3pm Eastern time");
      assert.equal(once.status, "proposed", JSON.stringify(once));
      assert.match(JSON.stringify(once), /once on 2026-11-24/);
      assert.match(JSON.stringify(once), /2026-11-24 20:00 UTC/);
      assert.deepEqual(violations, []);
    } finally { await w.close(); }
  });

  test(`${backend.name}: a value the owner did not say is refused or asked for: an invented hour, no hour, no zone, no repeat, no names, an unknown or an unclear name`, async () => {
    const { w, mk, say, schedules, invented } = await open();
    try {
      await mk("Ann Lee"); await mk("Ann Ray"); await mk("Bob");
      const refused = async (text: string, message: RegExp, status = "refused") => { const o = await say(text); assert.equal(o.status, status, `${text}: ${JSON.stringify(o)}`); assert.match(JSON.stringify(o), message, text); };
      await refused("Set up a planning meeting with Bob every day Eastern time", /not in your message as a time of day/);
      assert.deepEqual(invented, ["Set up a planning meeting with Bob every day Eastern time"], "the stand-in's invented hour was seen by this test");
      await refused("Set up a planning meeting with Bob every day Eastern time, no hour yet", /What time of day/);
      await refused("Set up a daily review with Bob at 4pm", /Which time zone/);
      await refused("Set up a review with Bob at 4pm Eastern time", /How often/);
      await refused("Set up a daily review at 2pm Eastern time", /Which agents should attend/);
      await refused("Set up a daily check-in with Zed at 2pm Eastern time", /no active agent is called/);
      const asked = await say("Set up a daily check-in with Ann at 2pm Eastern time");
      assert.equal(asked.status, "asked", JSON.stringify(asked));
      assert.ok(JSON.stringify(asked).includes("Ann Lee") && JSON.stringify(asked).includes("Ann Ray"), "both agents are offered");
      assert.equal((await schedules()).items.length, 0, "nothing was made");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a schedule is found by its words and changed, paused or ended as a proposal that carries the revision; unclear or unknown names ask or refuse`, async () => {
    const { w, project, mk, say, schedules, apply } = await open();
    try {
      const bob = await mk("Bob");
      const ann = await mk("Ann Lee");
      const made = await w.meetings.createSchedule(w.owner, { commandId: cid("sc"), projectId: project, title: "Weekly planning meeting", roster: [bob, ann], time: "09:30", timeZone: "America/New_York", recurrence: { kind: "weekly", days: [1] } });
      const before = (await schedules()).items[0]!;
      const moved = await say("Move the planning meeting to 10am");
      assert.equal(moved.status, "proposed", JSON.stringify(moved));
      assert.match(JSON.stringify(moved), /meetings it makes later change/);
      // What is shown is the schedule as it would be: its own zone, days and length, not a placeholder.
      assert.match(JSON.stringify(moved), /every Monday as now at \\"10:00\\" in \\"America\/New_York\\".*for 30 minutes/);
      assert.equal((await schedules()).items[0]!.time, "09:30", "nothing changes before the owner agrees");
      assert.equal((await apply(moved)).applied, true);
      const after = (await schedules()).items[0]!;
      assert.deepEqual([after.id, after.time, after.timeZone, after.revision > before.revision], [made.id, "10:00", "America/New_York", true]);
      const paused = await say("Pause the planning meeting");
      assert.equal(paused.status, "proposed", "even a pause is shown first");
      assert.equal((await apply(paused)).applied, true);
      assert.equal((await schedules()).items[0]!.state, "paused");
      const ending = await say("End the weekly planning meeting");
      assert.equal(ending.status, "proposed");
      assert.match(JSON.stringify(ending), /ends for good/);
      assert.equal((await schedules()).items[0]!.state, "paused", "ending is only shown");
      assert.equal((await say("Change the planning meeting")).status, "refused", "nothing to change is asked about, not guessed");
      assert.equal((await say("Move the budget meeting to 10am")).status, "refused");
      const roster = await say("Add Bob to the weekly planning meeting");
      assert.equal(roster.status, "proposed", JSON.stringify(roster));
      // A roster named for a schedule replaces the one it has: the proposal says Ann Lee would be taken off, so "add" cannot quietly drop her.
      assert.match(JSON.stringify(roster), /roster is replaced, not added to\); taken off: \\"Ann Lee\\"/);
      // Two schedules fit "planning": the owner is asked which, with both titles.
      await w.meetings.createSchedule(w.owner, { commandId: cid("sc"), projectId: project, title: "Planning offsite", roster: [bob], time: "11:00", timeZone: "UTC", recurrence: { kind: "daily" } });
      const asked = await say("Pause the planning meeting");
      assert.equal(asked.status, "asked", JSON.stringify(asked));
      assert.ok(JSON.stringify(asked).includes("Weekly planning meeting") && JSON.stringify(asked).includes("Planning offsite"));
    } finally { await w.close(); }
  });

  test(`${backend.name}: an urgent meeting is always shown first (never applied at once), needs the owner's reason and names, and a length not in the words is refused`, async () => {
    const { w, project, mk, say, apply } = await open();
    try {
      await mk("Ann Lee"); await mk("Bob");
      const planned = async () => (await w.meetings.planned(w.owner, project))!.items;
      const o = await say("Call Ann Lee and Bob into a meeting now: the build is red");
      assert.equal(o.status, "proposed", `an autonomous profile still shows a call first: ${JSON.stringify(o)}`);
      assert.match(JSON.stringify(o), /stop at a safe point and join a meeting that starts now/);
      assert.match(JSON.stringify(o), /It lasts 30 minutes \(the default/, "how long agents are taken away is shown");
      assert.equal((await planned()).length, 0, "nobody is called before the owner agrees");
      assert.equal((await apply(o)).applied, true);
      const items = await planned();
      assert.equal(items.length, 1);
      assert.deepEqual([items[0]!.title, items[0]!.kind, items[0]!.participants.length], ["the build is red", "urgent", 2]);
      assert.equal((await say("Call Bob into a meeting now")).status, "refused", "no reason: refused");
      assert.equal((await say("Call a meeting now, the build is red")).status, "refused", "no names: refused");
      const long = await say("Call Bob into a meeting now, the build is red");
      assert.equal(long.status, "refused", JSON.stringify(long));
      assert.match(JSON.stringify(long), /How long the meeting lasts is not in your message/);
      const said = await say("Call Bob into a meeting now for 45 minutes, the build is red");
      assert.equal(said.status, "proposed", JSON.stringify(said));
      assert.equal((await planned()).length, 1);
    } finally { await w.close(); }
  });

  test(`${backend.name}: calling the whole project is shown first with who it reaches, and a project with no active agents is refused`, async () => {
    const { w, project, mk, say } = await open();
    try {
      // Agents exist but none is a participant of the project: nobody to call in, so it is refused rather than proposed for no one.
      const ann = await mk("Ann Lee"); const bob = await mk("Bob");
      const refusedOut = await say("Pull everyone on this project into a meeting now, the release is blocked");
      assert.equal(refusedOut.status, "refused", JSON.stringify(refusedOut));
      assert.match(JSON.stringify(refusedOut), /no active agents to call in/);
      const proj = await w.world.storage.getAggregate({ kind: "project", id: project });
      await w.plans.setPlan(w.owner, { commandId: cid("pl"), projectId: project, expectedRevision: proj!.revision, participants: [{ principalId: ann }, { principalId: bob }] } as never);
      const o = await say("Pull everyone on this project into a meeting now, the release is blocked");
      assert.equal(o.status, "proposed", JSON.stringify(o));
      assert.match(JSON.stringify(o), /calls 2 agents away from what they are doing: .*Ann Lee.*Bob|calls 2 agents away from what they are doing: .*Bob.*Ann Lee/i);
      assert.match(JSON.stringify(o), /It lasts 30 minutes/);
      assert.match(JSON.stringify(o), /scope=\{?.*project/);
    } finally { await w.close(); }
  });

  test(`${backend.name}: the meetings status lists schedules with their time, zone and roster, the schedule list is bounded and paged, stand-ups are left to their own list, and a caller without the right sees nothing`, async () => {
    const { w, project, mk, say, schedules } = await open();
    try {
      const bob = await mk("Bob");
      const other = await w.project("Other");
      const mkSchedule = (p: string, title: string) => w.meetings.createSchedule(w.owner, { commandId: cid("sc"), projectId: p, title, roster: [bob], time: "09:30", timeZone: "America/New_York", recurrence: { kind: "weekly", days: [1, 3] } });
      await mkSchedule(project, "One"); await mkSchedule(project, "Two"); await mkSchedule(project, "Three"); await mkSchedule(other, "Elsewhere");
      const standups = StandupService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, assignments: w.assignments }, { ...options, availability: async () => "available" });
      await standups.configure(w.owner, { commandId: cid("su"), projectId: project, title: "Daily stand-up", roster: [bob], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "UTC", recurrence: { kind: "daily" } });
      const gone = await mkSchedule(project, "Gone");
      const goneItem = (await schedules()).items.find((s) => s.id === gone.id)!;
      await w.meetings.updateSchedule(w.owner, { commandId: cid("end"), scheduleId: gone.id, expectedRevision: goneItem.revision, state: "ended" });
      const all = (await schedules()).items.filter((s) => s.state !== "ended");
      assert.deepEqual(all.map((s) => s.title).sort(), ["One", "Three", "Two"], "only this project's, and no stand-up");
      assert.equal((await schedules()).items.length, 4, "an ended schedule is still listed, with its state");
      const everything = (await schedules()).items;
      const first = (await w.meetings.schedules(w.owner, project, { limit: 2 }))!;
      assert.equal(first.items.length, 2);
      assert.ok(first.next !== undefined, "a full page says where the next starts");
      const second = (await w.meetings.schedules(w.owner, project, { limit: 2, afterId: first.next! }))!;
      const third = (await w.meetings.schedules(w.owner, project, { limit: 2, afterId: second.next ?? first.items[1]!.id }))!;
      assert.deepEqual([...first.items, ...second.items, ...(second.next === undefined ? [] : third.items)].map((s) => s.id).sort(), everything.map((s) => s.id).sort(), "the pages together are the list");
      await assert.rejects(() => w.meetings.schedules(w.owner, project, { limit: 0 }));
      await assert.rejects(() => w.meetings.schedules(w.owner, project, { afterId: "nope" }));
      // The status answer names each schedule and cites it.
      const out = await say("What meetings are scheduled?");
      assert.equal(out.status, "answered", JSON.stringify(out));
      const text = JSON.stringify(out);
      assert.match(text, /One: schedule, every Monday, Wednesday at 09:30 America\/New_York, 30 minutes, active/);
      assert.ok(!text.includes("Elsewhere"), "another project's schedule is not told");
      assert.ok(!text.includes("Gone"), "an ended schedule is not told");
      // A caller who may not read the project's meetings sees nothing, through the operation and through the service.
      const nobody = await w.agent("nobody", []);
      const listed = (await w.api.handle(nobody.token, { v: 1, op: "meeting.schedule-list", args: { projectId: project } } as never)) as unknown as { ok: boolean; result?: { items: unknown[] } };
      assert.deepEqual([listed.ok, listed.result?.items.length], [true, 0]);
      assert.equal(await w.meetings.schedules(nobody.principal, project), undefined);
      const made = (await w.api.handle(nobody.token, { v: 1, op: "meeting.schedule", commandId: cid("x"), args: { projectId: project, title: "T", roster: [bob], time: "09:00", timeZone: "UTC" } } as never)) as { ok: boolean };
      assert.equal(made.ok, false, "a caller without meeting.manage cannot schedule");
      const called = (await w.api.handle(nobody.token, { v: 1, op: "meeting.call-urgent", commandId: cid("y"), args: { projectId: project, title: "T", reason: "R", roster: [bob] } } as never)) as { ok: boolean };
      assert.equal(called.ok, false, "nor call a meeting");
    } finally { await w.close(); }
  });

  test(`${backend.name}: a one-off day must be one the owner named (a date, tomorrow, a weekday) and still to come; a daylight-saving gap or repeat is said; weekly days must each be named`, async () => {
    const { w, mk, say, schedules, invented } = await open();
    try {
      await mk("Bob");
      const status = async (text: string) => { const o = await say(text); return [o.status, JSON.stringify(o)] as const; };
      const [tomorrow, tomorrowText] = await status("Set up a retro with Bob tomorrow at 3pm Eastern time");
      assert.equal(tomorrow, "proposed", tomorrowText);
      assert.match(tomorrowText, /once on 2026-10-23.*2026-10-23 19:00 UTC/);
      assert.equal((await status("Set up a retro with Bob on Friday at 3pm Eastern time"))[0], "proposed", "a weekday within two weeks names the day");
      const [noDay, noDayText] = await status("Set up a one-off retro with Bob at 3pm Eastern time");
      assert.equal(noDay, "refused", noDayText);
      assert.match(noDayText, /The day .*2026-10-23.* is not in your message/);
      const [wrong, wrongText] = await status("Set up a retro with Bob tomorrow at 4pm Eastern time");
      assert.equal(wrong, "refused", `tomorrow is the 23rd, not the 24th: ${wrongText}`);
      const [past, pastText] = await status("Set up a retro with Bob on 2026-10-01 at 3pm Eastern time");
      assert.equal(past, "refused", pastText);
      assert.match(pastText, /has already passed/);
      const [early, earlyText] = await status("Set up a retro with Bob today at 5am Eastern time");
      assert.equal(early, "refused", `5am today in New York was before 06:00 there: ${earlyText}`);
      assert.match(earlyText, /has already passed/);
      const [gap, gapText] = await status("Set up a night check with Bob on 2027-03-14 at 2:30am Eastern time");
      assert.equal(gap, "proposed", gapText);
      assert.match(gapText, /2027-03-14 07:30 UTC; that time does not exist that day, because the clocks go forward, so it starts at 03:30 local time/);
      const [twice, twiceText] = await status("Set up a night check with Bob on 2026-11-01 at 1:30am Eastern time");
      assert.equal(twice, "proposed", twiceText);
      assert.match(twiceText, /2026-11-01 05:30 UTC; that time happens twice that night/);
      const [days, daysText] = await status("Set up a sync with Bob every Monday at 9am Eastern time");
      assert.equal(days, "refused", daysText);
      assert.match(daysText, /are not all named in your message/);
      assert.equal((await status("Set up a sync with Bob every weekday at 9am Eastern time"))[0], "proposed", "\"weekday\" names Monday to Friday");
      const [some, someText] = await status("Set up a sync with Bob every Mon and Thursdays at 9am Eastern time");
      assert.equal(some, "proposed", someText);
      assert.match(someText, /every Monday, Thursday/);
      assert.deepEqual(invented.sort(), ["Set up a one-off retro with Bob at 3pm Eastern time", "Set up a retro with Bob tomorrow at 4pm Eastern time", "Set up a sync with Bob every Monday at 9am Eastern time"].sort(), "each invented value was seen by this test");
      assert.equal((await schedules()).items.length, 0, "nothing was made");
    } finally { await w.close(); }
  });

  test(`${backend.name}: the meetings status pages its schedules by how many were shown, and ended schedules never take the place of one still on`, async () => {
    const { w, project, mk, say, schedules } = await open();
    try {
      const bob = await mk("Bob");
      const mkSchedule = (title: string) => w.meetings.createSchedule(w.owner, { commandId: cid("sc"), projectId: project, title, roster: [bob], time: "09:30", timeZone: "UTC", recurrence: { kind: "daily" } });
      // Ten ended schedules, then two that are on: with the default limit of 10 the ended ones once filled the page and hid them.
      for (let i = 0; i < 10; i++) {
        const made = await mkSchedule(`Old ${i}`);
        const item = (await schedules()).items.find((s) => s.id === made.id)!;
        await w.meetings.updateSchedule(w.owner, { commandId: cid("end"), scheduleId: made.id, expectedRevision: item.revision, state: "ended" });
      }
      await mkSchedule("Alpha"); await mkSchedule("Beta");
      const all = JSON.stringify(await say("What meetings are scheduled?"));
      assert.ok(all.includes("Alpha: schedule") && all.includes("Beta: schedule"), all);
      assert.ok(!all.includes("Old "), all);
      assert.ok(!all.includes("more meeting schedules"), "nothing more to see");
      // One at a time: the answer says the number to ask for next, and that answer shows only the next schedule.
      const first = JSON.stringify(await say("Show me 1 meeting"));
      assert.match(first, /There are more meeting schedules than shown: ask for the meetings after 1 to see the next ones/);
      const firstTitle = first.includes("Alpha: schedule") ? "Alpha" : "Beta";
      const second = JSON.stringify(await say("Show me 1 meeting after 1"));
      assert.ok(second.includes(`${firstTitle === "Alpha" ? "Beta" : "Alpha"}: schedule`) && !second.includes(`${firstTitle}: schedule`), second);
      assert.ok(!second.includes("more meeting schedules"), second);
      const beyond = JSON.stringify(await say("Show me the meetings after 3"));
      assert.match(beyond, /no more meeting schedules after the first 2/);
    } finally { await w.close(); }
  });

  test(`${backend.name}: only the owner reaches these controls through the chat: an agent's own session is refused before any model is asked`, async () => {
    const { w, project, mk, seen } = await open();
    try {
      await mk("Bob");
      const nobody = await w.agent("nobody", [{ action: "meeting.manage", project }]);
      const chat = w.chat({ interpreter: new ModelInterpreter({ complete: async () => { seen.push("asked"); return "[]"; } }, () => ["test/model"]) });
      const out = await chat.submit(nobody.token, { messageId: cid("m"), text: "Call Bob into a meeting now: the build is red" }).then((r) => JSON.stringify(r), (e: unknown) => String(e));
      assert.ok(!/"applied"/.test(out) && !/proposed/.test(out), out);
      assert.ok(!seen.includes("asked"), "no model was asked for a non-owner");
    } finally { await w.close(); }
  });
}

test("a one-off day and weekly days count only when the owner's words give them", () => {
  // Today is Thursday 2026-10-22 on the meeting zone's calendar.
  const today = "2026-10-22";
  const yes: [string, string][] = [["2026-11-24", "on 2026-11-24"], ["2026-11-24", "on November 24th"], ["2026-11-24", "on 24/11/2026"], ["2026-10-22", "tonight at 9"], ["2026-10-23", "tomorrow at 3"], ["2026-10-24", "the day after tomorrow"], ["2026-10-25", "in 3 days"], ["2026-10-25", "in three days"], ["2026-10-23", "on Friday"], ["2026-10-30", "next Friday"], ["2026-10-26", "on Mon"]];
  for (const [date, words] of yes) assert.ok(oneOffDayInWords(date, words, today), `${date} in "${words}"`);
  const no: [string, string][] = [["2026-10-23", "once at 3"], ["2026-10-24", "tomorrow at 3"], ["2026-10-23", "the day after tomorrow"], ["2026-10-22", "tomorrow"], ["2026-11-06", "on Friday"], ["2026-10-21", "on Wednesday"], ["2026-10-26", "in 3 days"], ["2026-11-25", "on 2026-11-24"], ["nope", "today"]];
  for (const [date, words] of no) assert.ok(!oneOffDayInWords(date, words, today), `${date} not in "${words}"`);
  assert.ok(weekdaysInWords([1, 3], "every Monday and Wednesday"));
  assert.ok(weekdaysInWords([1, 2, 3, 4, 5], "on weekdays"));
  assert.ok(weekdaysInWords([0, 6], "at weekends"));
  assert.ok(weekdaysInWords([2, 4], "Tues and Thurs"));
  assert.ok(!weekdaysInWords([1, 3], "every Monday"));
  assert.ok(!weekdaysInWords([6], "on weekdays"));
  assert.ok(!weekdaysInWords([5], "every day"));
});

test("a time of day counts only when the owner's words give it", () => {
  const yes: [string, string][] = [["09:30", "every Monday at 9:30am"], ["15:00", "at 3pm"], ["15:00", "at 15:00"], ["14:00", "at 2 pm tomorrow"], ["12:00", "at noon"], ["09:00", "at nine"], ["10:00", "at 10"], ["00:00", "at midnight"], ["14:30", "half past two pm"]];
  for (const [time, words] of yes) assert.ok(clockTimeInWords(time, words), `${time} in "${words}"`);
  const no: [string, string][] = [["09:00", "with 3 agents every day"], ["03:00", "with 3 agents"], ["09:30", "at 9"], ["16:00", "for 45 minutes"], ["10:00", "Nov 10"], ["09:00", "agent-7 daily"], ["25:00", "at 5"]];
  for (const [time, words] of no) assert.ok(!clockTimeInWords(time, words), `${time} not in "${words}"`);
});

void (null as unknown as World);
