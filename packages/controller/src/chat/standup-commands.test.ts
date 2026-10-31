import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { chatTurnFollowUps } from "./follow-ups.js";
import { StandupService } from "../standups/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string, extra: Record<string, unknown> = {}) => ({ kind: "command", op, args, evidence, basis: "owner", ...extra });

for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, ctl: { sched(projectId: string, title: string): Promise<string>; schedule(id: string): Promise<{ state: string; title: string; time: string; revision: number }> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      // The stand-up service needs the world's meeting service, which exists only once the world is open: the API reaches it through this holder.
      const holder: { s?: StandupService } = {};
      const lazy = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => (holder.s as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!(...a) }) as StandupService;
      const w = await openWorld(backend, script, undefined, { standups: lazy });
      holder.s = StandupService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, assignments: w.assignments }, { availability: async () => "available" });
      const ctl = {
        sched: async (projectId: string, title: string) => {
          const agent = await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: `A-${title}` });
          const made = await holder.s!.configure(w.owner, { commandId: cid("su"), projectId, title, roster: [`agent:${agent.id}`], time: "09:00", windowFrom: "08:00", windowTo: "10:00", timeZone: "Europe/London", recurrence: { kind: "daily" } });
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

    script["Resume the morning stand-up."] = [cmd("standup.update", { standupTitle: "morning", state: "active" }, "Resume the morning stand-up")];
    assert.equal(only((await say(w, chat, "Resume the morning stand-up.")).outcomes).status, "applied");
    assert.equal((await ctl.schedule(morning)).state, "active");

    // A new time changes when agents are woken: shown first, nothing changes until the owner applies it.
    script["Move the evening wrap stand-up to 09:30."] = [cmd("standup.update", { standupTitle: "evening", time: "09:30" }, "Move the evening wrap stand-up to 09:30")];
    const moved = only((await say(w, chat, "Move the evening wrap stand-up to 09:30.")).outcomes);
    assert.equal(moved.status, "proposed", JSON.stringify(moved));
    assert.equal((await ctl.schedule(evening)).time, "09:00");

    // Two stand-ups match: the owner is asked and nothing changes.
    script["Pause the stand-up."] = [cmd("standup.update", { state: "paused" }, "Pause the stand-up")];
    const asked = only((await say(w, chat, "Pause the stand-up.")).outcomes);
    assert.notEqual(asked.status, "applied");
    assert.equal((await ctl.schedule(evening)).state, "active");

    // Someone who may not read the project's meetings finds no stand-ups through the list either.
    const nobody = await w.agent("nobody", []);
    const denied = await w.api.handle(nobody.token, { v: 1, op: "standup.list", args: { projectId: a } } as never) as { ok: boolean };
    assert.equal(denied.ok, false);
    const listed = await w.api.handle(w.ownerToken, { v: 1, op: "standup.list", args: { projectId: a } } as never) as unknown as { ok: boolean; result: { item: { items: { title: string }[] } } };
    assert.deepEqual(listed.result.item.items.map((i) => i.title).sort(), ["Evening wrap", "Morning sync"]);

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
    script["Deliver the stand-up outcomes."] = [cmd("standup.deliver", {}, "Deliver the stand-up outcomes")];
    const delivered = only((await say(w, chat, "Deliver the stand-up outcomes.")).outcomes);
    assert.equal(delivered.status, "applied", JSON.stringify(delivered));
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
    assert.equal(shown.count, 5);
    assert.deepEqual(shown.latest.map((f) => f.text), ["Decided 3.", "Decided 4.", "Decided 5."]);
    const stored = (await w.world.storage.getAggregate({ kind: "chat-context", id: `ctx:${w.owner.id}` }))!.body as unknown as { projects: Record<string, { turns: Record<string, unknown>[] }> };
    assert.ok(stored.projects[a]!.turns.every((t) => t["followUps"] === undefined), "the listing adds it on reading; the stored context is not changed");
  });
}
