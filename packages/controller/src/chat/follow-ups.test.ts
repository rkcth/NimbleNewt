import assert from "node:assert/strict";
import { DomainError } from "../domain/errors.js";
import { after, test } from "node:test";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { agendaOutcomeSink } from "../standups/outcome-sink.js";
import { FOLLOW_UP_LIMITS, chatTurnFollowUps } from "./follow-ups.js";
import { ProjectService } from "../domain/service.js";

after(stopServer);

for (const backend of backends) {
  test(`${backend.name}: a follow-up is put on the chat turn once per key, the latest few are kept, and a missing turn is reported as not delivered (card M03f)`, async () => {
    const world = await backend.open();
    try {
      const projects = await ProjectService.open(world.storage, { holder: "c1" });
      const epoch = projects.epoch;
      const runner = new CommandRunner(world.storage, epoch, {});
      const ref = { kind: "chat-turn", id: "turn-1" };
      await runner.command("test.turn", { commandId: "mk", actor: "system" }, async () => ({ payload: {}, build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: { ownerId: "owner:rob", messageId: "m1", text: "hi", quotedCount: 0, status: "done", plan: [], createdAt: "2026-10-29T00:00:00.000Z" } }], detail: {} }) }));
      const follow = chatTurnFollowUps(world.storage, epoch);
      assert.equal(await follow.add("turn-1", { key: "k1", text: "The stand-up decided X." }), true);
      assert.equal(await follow.add("turn-1", { key: "k1", text: "The stand-up decided X." }), true, "the same key again changes nothing");
      const read = async () => ((await world.storage.getAggregate(ref))!.body as unknown as { followUps: { key: string; text: string }[] }).followUps;
      assert.deepEqual((await read()).map((f) => f.key), ["k1"]);
      for (let i = 2; i <= FOLLOW_UP_LIMITS.kept + 5; i++) await follow.add("turn-1", { key: `k${i}`, text: `n${i}` });
      const kept = await read();
      assert.equal(kept.length, FOLLOW_UP_LIMITS.kept);
      assert.equal(kept[kept.length - 1]!.key, `k${FOLLOW_UP_LIMITS.kept + 5}`);
      assert.equal(await follow.add("turn-gone", { key: "kx", text: "t" }), false);
      await assert.rejects(follow.add("turn-1", { key: "", text: "t" }));
    } finally { await world.close(); }
  });
}

test("the agenda outcome goes to the chat turn or, for an inquiry, to the agent that asked, and anything that cannot be put back stays waiting (card M03f)", async () => {
  const turns: string[] = [];
  const notices: { taskId: string; to: string; commandId: string }[] = [];
  let fail = false;
  const sink = agendaOutcomeSink({
    followUp: async (turnId, f) => { if (fail) throw new Error("down"); turns.push(`${turnId}|${f.key}`); return turnId !== "turn-gone"; },
    inquiry: async (id) => (id === "inq-1" ? { asker: "agent:ann", taskId: "task-1" } : undefined),
    messages: { noticeFromController: async (c) => { notices.push({ taskId: c.taskId, to: c.to, commandId: c.commandId }); } },
  });
  const base = { key: "item:2", kind: "agenda-outcome" as const, projectId: "prj-1", text: "decided", refs: [] };
  assert.equal(await sink.deliver({ ...base, to: { kind: "chat-turn", id: "turn-1" } }), true);
  assert.equal(await sink.deliver({ ...base, to: { kind: "chat-turn", id: "turn-gone" } }), false);
  assert.equal(await sink.deliver({ ...base, to: { kind: "inquiry", id: "inq-1" } }), true);
  assert.equal(await sink.deliver({ ...base, to: { kind: "inquiry", id: "inq-gone" } }), false);
  assert.equal(await sink.deliver({ ...base, kind: "improvement-outcome", to: { kind: "chat-turn", id: "turn-1" } }), false, "other kinds are not this sink's");
  fail = true;
  assert.equal(await sink.deliver({ ...base, to: { kind: "chat-turn", id: "turn-1" } }), false, "a failure leaves it waiting");
  assert.deepEqual(turns, ["turn-1|ago:item:2", "turn-gone|ago:item:2"]);
  assert.deepEqual(notices, [{ taskId: "task-1", to: "agent:ann", commandId: "ago:item:2" }]);
});

test("an outcome for an inquiry whose asker can never be told is closed, not retried for ever; a passing failure stays waiting (card M03f)", async () => {
  let error: Error = new DomainError("forbidden", "not an agent");
  const sink = agendaOutcomeSink({ followUp: async () => true, inquiry: async () => ({ asker: "owner:rob", taskId: "task-1" }), messages: { noticeFromController: async () => { throw error; } } });
  const n = { key: "item:2", kind: "agenda-outcome" as const, projectId: "prj-1", text: "decided", refs: [], to: { kind: "inquiry" as const, id: "inq-1" } };
  assert.equal(await sink.deliver(n), true);
  error = new Error("storage down");
  assert.equal(await sink.deliver(n), false);
});
